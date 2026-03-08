/**
 * MiniMax Orchestrator Loop
 *
 * Continuous diff-driven validation of opendeviationbar-py:
 * 1. git pull → git diff since last check
 * 2. MiniMax M2.5-highspeed triages changed files (cheap, fast)
 * 3. Claude Code validates each finding via `claude -p` (deep, subscription)
 * 4. Only confirmed findings → GitHub Issue + Telegram notification
 *
 * Safety: rate limiting, fuzzy dedup, exponential backoff, severity gating.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

// --- Config ---

const MINIMAX_MODEL = 'MiniMax-M2.5-highspeed';
const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const PROACTIVE_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between proactive scans
const CYCLE_COOLDOWN_MS = 30_000; // 30s between cycles when no changes
const CYCLE_COOLDOWN_ERROR_MS = 60_000; // 60s after errors
const STATE_FILE = path.join(DATA_DIR, 'orchestrator-state.json');

// Difftastic (AST-aware diffs, reduces formatting false positives)
const DIFFT_BINARY =
  process.env.DIFFT_BINARY ||
  `${process.env.HOME}/fork-tools/difftastic/target/release/difft`;

// ast-grep (deterministic structural lint, Phase 7)
const AST_GREP_BINARY =
  process.env.AST_GREP_BINARY || `${process.env.HOME}/.cargo/bin/ast-grep`;
const AST_GREP_RULES_DIR = path.join(
  path.dirname(path.dirname(new URL(import.meta.url).pathname)),
  'rules',
);

// OpenGrep (SAST with taint analysis for Python, Phase 7)
const OPENGREP_BINARY =
  process.env.OPENGREP_BINARY || `${process.env.HOME}/.local/bin/opengrep`;

// Rate limiting
const MAX_ISSUES_PER_HOUR = 6;
const MAX_FINDINGS_PER_CYCLE = 5;
const MIN_SEVERITY_FOR_ISSUE = 'medium'; // skip low-severity findings

// Claude validation timeout (5 min per finding)
const CLAUDE_VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;

// Label cache: avoid fetching labels every cycle (cc-skills pattern: 24-hour cache)
let cachedRepoLabels: string[] | null = null;
let labelsCacheTime = 0;
const LABEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Target GitHub repo (owner/name) — set during init, used by all gh CLI calls
let targetRepo = '';

// --- Types ---

interface OrchestratorState {
  lastCheckedCommit: string;
  cycleCount: number;
  issuesCreated: number;
  issuesCreatedThisHour: number;
  hourWindow: string; // ISO timestamp of current hour window (legacy, kept for compat)
  issueTimestamps?: number[]; // Sliding window: epoch ms of each issue creation
  lastHeartbeat: string;
  lastProactiveScan?: string; // ISO timestamp of last proactive enhancement scan
  proactiveScanIndex?: number; // Index into file list for round-robin scanning
  startedAt: string;
  consecutiveErrors: number;
  findingsValidated: number;
  findingsRejected: number;
}

interface Finding {
  type:
    | 'bug'
    | 'performance-regression'
    | 'test-gap'
    | 'daemon-behavior'
    | 'enhancement';
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Expert self-assessed confidence 1-5 (5 = proven with evidence) */
  confidence?: number;
  title: string;
  description: string;
  files: string[];
  validation: string;
  /** Which expert perspectives flagged this finding (populated during triage) */
  sourcePerspectives?: string[];
}

interface ValidationResult {
  confirmed: boolean;
  confidence: 'low' | 'medium' | 'high';
  analysis: string;
  suggestedFix?: string;
}

interface TriageResult {
  findings: Finding[];
  summary: string;
}

// --- State ---

function loadState(): OrchestratorState {
  const defaults: OrchestratorState = {
    lastCheckedCommit: '',
    cycleCount: 0,
    issuesCreated: 0,
    issuesCreatedThisHour: 0,
    hourWindow: '',
    lastHeartbeat: '',
    startedAt: new Date().toISOString(),
    consecutiveErrors: 0,
    findingsValidated: 0,
    findingsRejected: 0,
  };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // Merge saved state with defaults to handle new fields
      return { ...defaults, ...saved };
    }
  } catch {
    logger.warn('Corrupted orchestrator state, resetting');
  }
  return defaults;
}

function saveState(state: OrchestratorState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Log Rotation ---

const LOG_FILE = '/tmp/orchestrator.log';
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Rotate log file if it exceeds MAX_LOG_SIZE_BYTES */
function rotateLogIfNeeded(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      // Keep last 2MB, discard the rest
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      const keepFrom = content.length - 2 * 1024 * 1024;
      const newContent =
        keepFrom > 0
          ? '... (log rotated)\n' + content.slice(keepFrom)
          : content;
      fs.writeFileSync(LOG_FILE, newContent);
      logger.info(
        { oldSize: stats.size, newSize: newContent.length },
        'Log file rotated',
      );
    }
  } catch {
    // Non-fatal — don't crash the orchestrator over log rotation
  }
}

/** Check sliding-window rate limit (true rolling hour, no calendar-boundary burst) */
function checkRateLimit(state: OrchestratorState): boolean {
  const now = Date.now();
  if (!state.issueTimestamps) state.issueTimestamps = [];
  // Evict timestamps older than 1 hour
  state.issueTimestamps = state.issueTimestamps.filter(
    (ts) => now - ts < 3_600_000,
  );
  return state.issueTimestamps.length < MAX_ISSUES_PER_HOUR;
}

// --- Git Operations ---

function gitPull(repoPath: string): boolean {
  try {
    execSync('git pull --ff-only origin main 2>&1', {
      cwd: repoPath,
      timeout: 30_000,
      encoding: 'utf-8',
    });
    return true;
  } catch (err) {
    logger.error({ err }, 'git pull failed');
    return false;
  }
}

function getHeadCommit(repoPath: string): string {
  return execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8',
  }).trim();
}

function getGitBranch(repoPath: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getDiff(repoPath: string, sinceCommit: string): string {
  try {
    return execSync(
      `git diff ${sinceCommit}..HEAD --stat --unified=5 -- '*.rs' '*.py' '*.toml' '*.cfg'`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 },
    );
  } catch (err) {
    logger.error({ err }, 'git diff failed');
    return '';
  }
}

/**
 * Get AST-aware semantic diff via difftastic for a single file.
 * Returns a human-readable summary of structural changes, or null on failure.
 * Falls back gracefully if difft binary is missing or fails.
 */
function getSemanticDiffForFile(
  repoPath: string,
  sinceCommit: string,
  filePath: string,
): string | null {
  try {
    if (!fs.existsSync(DIFFT_BINARY)) return null;

    // Get old version from git
    const oldContent = execSync(`git show ${sinceCommit}:${filePath}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5_000,
    });

    const newPath = path.join(repoPath, filePath);
    if (!fs.existsSync(newPath)) return null;

    // Write old content to temp file (difft needs file paths)
    const tmpOld = path.join(DATA_DIR, `difft-old-${path.basename(filePath)}`);
    fs.writeFileSync(tmpOld, oldContent);

    try {
      const result = spawnSync(
        DIFFT_BINARY,
        [
          '--display=inline',
          '--color=never',
          '--byte-limit=2000000',
          '--graph-limit=5000000',
          tmpOld,
          newPath,
        ],
        { encoding: 'utf-8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
      );
      // difft exit code 1 = differences found (not an error)
      if (result.status !== null && result.status <= 1 && result.stdout) {
        return `--- ${filePath} (semantic diff) ---\n${result.stdout.slice(0, 8_000)}`;
      }
      return null;
    } finally {
      try {
        fs.unlinkSync(tmpOld);
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null; // Graceful fallback
  }
}

/**
 * Get semantic diffs for all changed files. Returns blended context string.
 * Falls back to empty string if difftastic is unavailable.
 */
function getSemanticDiffs(
  repoPath: string,
  sinceCommit: string,
  changedFiles: string[],
): string {
  if (!fs.existsSync(DIFFT_BINARY)) return '';

  const diffs = changedFiles
    .slice(0, 5) // Match source context limit
    .map((f) => getSemanticDiffForFile(repoPath, sinceCommit, f))
    .filter(Boolean);

  if (diffs.length === 0) return '';

  logger.info(
    { files: diffs.length, difftBinary: DIFFT_BINARY },
    'Semantic diffs generated via difftastic',
  );
  return diffs.join('\n\n');
}

/**
 * Run ast-grep structural rules on changed files.
 * Returns formatted findings or empty string if ast-grep is unavailable.
 * This is a deterministic pre-filter — no LLM calls needed.
 */
function runAstGrepOnFiles(repoPath: string, changedFiles: string[]): string {
  if (!fs.existsSync(AST_GREP_BINARY)) {
    logger.info(
      { binary: AST_GREP_BINARY },
      'ast-grep binary not found, skipping structural lint',
    );
    return '';
  }

  const rulesDir = fs.existsSync(AST_GREP_RULES_DIR) ? AST_GREP_RULES_DIR : '';
  if (!rulesDir) {
    logger.info(
      { rulesDir: AST_GREP_RULES_DIR },
      'ast-grep rules directory not found, skipping',
    );
    return '';
  }

  const ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.yml'));
  if (ruleFiles.length === 0) {
    logger.info({ rulesDir }, 'No ast-grep YAML rules found, skipping');
    return '';
  }

  const allFindings: string[] = [];

  for (const ruleFile of ruleFiles) {
    const rulePath = path.join(rulesDir, ruleFile);
    // Determine language from rule filename
    const isRust = ruleFile.includes('rust');
    const isPython = ruleFile.includes('python');
    const targetFiles = changedFiles.filter((f) => {
      if (isRust) return f.endsWith('.rs');
      if (isPython) return f.endsWith('.py');
      return true;
    });
    if (targetFiles.length === 0) continue;

    for (const file of targetFiles.slice(0, 5)) {
      try {
        const fullPath = path.join(repoPath, file);
        if (!fs.existsSync(fullPath)) continue;
        const result = spawnSync(
          AST_GREP_BINARY,
          ['scan', '-r', rulePath, fullPath],
          { encoding: 'utf-8', timeout: 10_000, maxBuffer: 512 * 1024 },
        );
        if (result.stdout && result.stdout.trim()) {
          allFindings.push(result.stdout.trim());
        }
      } catch {
        /* skip individual file errors */
      }
    }
  }

  if (allFindings.length === 0) return '';

  logger.info(
    { findingCount: allFindings.length, rules: ruleFiles.length },
    'ast-grep structural findings detected',
  );
  return allFindings.join('\n\n').slice(0, 10_000);
}

/**
 * Run OpenGrep SAST on changed Python files.
 * Uses taint analysis and community rules for security findings.
 * Returns formatted findings or empty string if opengrep is unavailable.
 */
function runOpenGrepOnFiles(repoPath: string, changedFiles: string[]): string {
  if (!fs.existsSync(OPENGREP_BINARY)) {
    logger.info(
      { binary: OPENGREP_BINARY },
      'OpenGrep binary not found, skipping SAST',
    );
    return '';
  }

  const pyFiles = changedFiles
    .filter((f) => f.endsWith('.py'))
    .slice(0, 10)
    .map((f) => path.join(repoPath, f))
    .filter((f) => fs.existsSync(f));

  if (pyFiles.length === 0) return '';

  try {
    const result = spawnSync(
      OPENGREP_BINARY,
      ['scan', '--config=auto', '--json', '--quiet', ...pyFiles],
      {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        cwd: repoPath,
      },
    );

    const output = result.stdout?.trim();
    if (!output) return '';

    // Parse JSON output, extract findings summary
    try {
      const parsed = JSON.parse(output);
      const results = parsed.results || [];
      if (results.length === 0) return '';

      const formatted = results
        .slice(0, 20) // Cap at 20 findings
        .map(
          (r: {
            check_id: string;
            path: string;
            start: { line: number };
            end: { line: number };
            extra: { message: string; severity: string };
          }) =>
            `[${r.extra?.severity || 'WARNING'}] ${r.check_id}\n  ${r.path}:${r.start?.line}-${r.end?.line}\n  ${r.extra?.message || ''}`,
        )
        .join('\n\n');

      logger.info(
        { findingCount: results.length, files: pyFiles.length },
        'OpenGrep SAST findings detected',
      );
      return formatted.slice(0, 10_000);
    } catch {
      // Not valid JSON — return raw output truncated
      return output.slice(0, 5_000);
    }
  } catch {
    logger.info('OpenGrep scan failed (non-fatal)');
    return '';
  }
}

function getChangedFiles(repoPath: string, sinceCommit: string): string[] {
  try {
    const output = execSync(
      `git diff ${sinceCommit}..HEAD --name-only -- '*.rs' '*.py' '*.toml' '*.cfg'`,
      { cwd: repoPath, encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

function getCommitLog(repoPath: string, sinceCommit: string): string {
  try {
    return execSync(`git log ${sinceCommit}..HEAD --oneline --no-merges`, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

/** Read file content from the repo for validation context */
function readRepoFile(repoPath: string, filePath: string): string {
  try {
    const fullPath = path.join(repoPath, filePath);
    return fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return '';
  }
}

// --- MiniMax Triage ---

async function queryMiniMax(
  prompt: string,
  apiKey: string,
  systemPrompt = '',
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const body: Record<string, unknown> = {
      model: MINIMAX_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2024-10-22',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const respBody = await response.text().catch(() => '');
      throw new Error(
        `MiniMax API ${response.status}: ${respBody.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    // Filter out thinking blocks — MiniMax returns thinking before text
    const textBlocks = data.content.filter((b) => b.type === 'text' && b.text);
    return textBlocks.map((b) => b.text!).join('');
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// --- Multi-Perspective MiniMax Triage ---
//
// MiniMax is extremely cheap (~$0.01/call), so we run multiple expert
// perspectives in parallel, aggregate findings, deduplicate, and only
// then hand off to Claude Code for expensive validation.

interface ExpertPerspective {
  name: string;
  systemPrompt: string;
}

const EXPERT_RESPONSE_FORMAT = `
Respond with a JSON array of findings. Each finding has:
- type: one of [bug, performance-regression, test-gap, daemon-behavior]
- severity: low | medium | high | critical
- confidence: integer 1-5 (1=uncertain guess, 5=confirmed with evidence from source code)
- title: concise, unique, specific (not generic)
- description: 2-3 sentences explaining the concern, referencing specific line numbers from the source code
- files: array of affected file paths
- validation: shell command that PROVES the issue exists (must be runnable, e.g. grep for the problematic pattern)

BEFORE REPORTING: Read the FULL SOURCE CODE above, not just the diff. Check:
- Is this already handled by guards, fallbacks, or platform checks elsewhere in the file?
- Is silent failure intentional for best-effort utilities (allocator hints, cache warmup)?
- Is "missing persistence" actually "intentionally stateless" (adaptive loops, freshness re-evaluation)?
- Would fixing this add unnecessary complexity for negligible benefit?

CONFIDENCE SCORING:
- 5: You can point to exact lines in the source that prove the issue
- 4: Strong evidence but relies on assumptions about runtime behavior
- 3: Plausible concern but code context is ambiguous
- 2: Speculative — the pattern looks concerning but may be intentional
- 1: Gut feeling only — no concrete evidence

Only report findings with confidence >= 4.
If nothing warrants attention or you're not confident, respond with: []
Prefer returning [] over returning a questionable finding.

JSON:`;

const EXPERT_PERSPECTIVES: ExpertPerspective[] = [
  {
    name: 'bug-hunter',
    systemPrompt: `You are a bug hunter specializing in Rust and Python code. You look for:
- Logic errors that produce incorrect results
- Off-by-one errors, boundary conditions, integer overflow
- Unsafe unwrap/expect without proper error context
- Race conditions in async/concurrent code
- Null/None handling gaps, missing match arms
- Error handling that swallows important context
- Incorrect type conversions or lossy casts

Target: opendeviationbar-py, a Rust+Python (maturin) library for financial microstructure analysis with 10 Rust crates and 4 Python daemons.

Be thorough but precise. Only report genuine bugs, not style preferences.
${EXPERT_RESPONSE_FORMAT}`,
  },
  {
    name: 'performance-analyst',
    systemPrompt: `You are a performance engineer specializing in Rust and Python systems that handle financial data at scale. You look for:
- Memory allocation patterns that could cause OOM (unbounded Vec growth, large String clones)
- O(n²) or worse algorithms where O(n) is possible
- Unnecessary heap allocations in hot paths (String where &str suffices)
- Python GIL contention patterns
- Inefficient I/O patterns (sync in async context, unbuffered writes, N+1 queries)
- Memory leaks (growing caches without eviction, accumulating state)
- Parquet/Arrow inefficiencies (unnecessary copies, column projection misses)

Target: opendeviationbar-py, a Rust+Python (maturin) library processing large volumes of financial tick data.

Focus on changes that could cause 2x+ degradation. Ignore micro-optimizations.
${EXPERT_RESPONSE_FORMAT}`,
  },
  {
    name: 'reliability-engineer',
    systemPrompt: `You are a site reliability engineer reviewing code for a 24/7 financial data processing system. You look for:
- Daemon behavior: reconnect logic, graceful shutdown, state persistence across restarts
- Backpressure handling: what happens when downstream is slow or offline
- Data integrity: silent data loss, partial writes, gap detection failures
- Error propagation: exceptions caught but not logged, errors mapped to wrong severity
- Resource exhaustion: file descriptor leaks, connection pool starvation, disk space
- Monitoring gaps: important operations without metrics/logging
- Configuration: hardcoded timeouts, missing fallbacks for external dependencies

Target: opendeviationbar-py runs 4 Python daemons (gap-backfill, kintsugi, sidecar, stathera) continuously in production.

Focus on issues that could cause production incidents or silent data corruption.
${EXPERT_RESPONSE_FORMAT}`,
  },
  {
    name: 'test-coverage-auditor',
    systemPrompt: `You are a test coverage auditor. For each code change, you evaluate:
- Are new code paths tested? (new functions, new branches, new error paths)
- Are edge cases covered? (empty inputs, boundary values, error conditions)
- Are integration points tested? (API endpoints, database queries, external calls)
- Do existing tests still cover the modified behavior? (semantic changes vs. just refactors)
- Are there regression risks? (behavior changes without test updates)

Target: opendeviationbar-py uses cargo nextest (Rust) and pytest (Python).

Only report SIGNIFICANT test gaps — missing tests for critical logic, not trivial getters.
Only report type "test-gap" findings.
${EXPERT_RESPONSE_FORMAT}`,
  },
  {
    name: 'security-reviewer',
    systemPrompt: `You are a security reviewer for financial infrastructure code. You look for:
- Input validation gaps on API endpoints (HTTP, CLI, config files)
- Injection vulnerabilities (SQL, command, path traversal)
- Authentication/authorization bypasses
- Sensitive data in logs, error messages, or stack traces
- Insecure defaults (open network listeners, permissive CORS)
- Cryptographic misuse
- Dependency confusion or supply chain risks in config changes

Target: opendeviationbar-py exposes HTTP APIs via sidecar and handles financial data.

Only report genuine security concerns, not theoretical risks.
${EXPERT_RESPONSE_FORMAT}`,
  },
];

// --- Proactive Enhancement Scanning ---
//
// Unlike diff-driven triage (reactive), proactive scanning examines the
// existing codebase for enhancement opportunities even when no commits land.
// Runs every PROACTIVE_SCAN_INTERVAL_MS, scanning a rotating batch of files.

const PROACTIVE_SCAN_BATCH_SIZE = 3; // files per scan cycle

const PROACTIVE_ENHANCEMENT_PROMPT = `You are a memory efficiency and performance optimization expert reviewing existing code in a Rust+Python (maturin) financial data processing library called opendeviationbar-py.

Your job is to find REFACTORING OPPORTUNITIES for memory efficiency. Scan the code for these specific patterns:

## AVOID COPIES
- Unnecessary .clone() / .to_owned() / .to_string() when a borrow would work
- Python: creating new lists/dicts when a view/slice suffices
- String copies where &str / Cow<str> would work
- Vec copies where slices or iterators would work
- Deep copies (copy.deepcopy) that could be shallow copies or references

## AVOID ALLOCATION
- Repeated allocation inside loops (Vec::new() or list() per iteration)
- Missing pre-allocation: Vec that grows via push when final size is known (use Vec::with_capacity)
- Missing buffer reuse: creating new buffers per request instead of reusing
- Python: string concatenation in loops instead of join()
- Temporary allocations that could use stack (SmallVec, arrayvec, tinyvec)

## CACHE EFFICIENCY
- Array-of-Structs (AoS) where Struct-of-Arrays (SoA) would be faster for column access
- Non-contiguous data access patterns (random index into large Vec)
- HashMap where a sorted Vec + binary_search would be more cache-friendly
- Python: iterating dict values when a list would be faster
- Large structs passed by value instead of reference

## LAZY EVALUATION
- Collecting iterators into Vec just to iterate again (.collect::<Vec<_>>() then .iter())
- Loading entire files/datasets when streaming/chunked reading suffices
- Python: list comprehension where generator expression would work
- Computing values eagerly that may never be used
- Missing predicate pushdown (filtering after transform instead of before)

TARGET: opendeviationbar-py processes high-frequency financial tick data. Memory efficiency directly impacts throughput and OOM risk. The codebase has 10 Rust crates and 4 Python daemons.

IMPORTANT:
- Only report findings with CONCRETE evidence: cite the exact function, line pattern, and data type involved
- Estimate the impact: "saves ~X allocations per call" or "reduces peak memory by ~X%"
- A finding without a specific code location and measurable impact is worthless
- Prefer findings in hot paths (data processing loops, streaming handlers) over cold paths (startup, config)
- Use type "enhancement" for all findings

Respond with a JSON array. Each finding:
- type: "enhancement"
- severity: "medium" for measurable improvements, "high" for OOM-risk reductions
- confidence: 1-5 (5 = exact line numbers cited, clear improvement path)
- title: specific, e.g. "Pre-allocate result Vec in batch_process_ticks()"
- description: what the code does now, what it should do, estimated impact
- files: affected file paths
- validation: command to verify (e.g. grep for the pattern, or cargo bench command)

Only report findings with confidence >= 4.
If nothing warrants attention, respond with: []

JSON:`;

/**
 * Get all scannable source files in the repo, sorted by size (largest first,
 * as they're most likely to have optimization opportunities).
 */
function getScannableFiles(repoPath: string): string[] {
  try {
    const output = execSync(
      `find . -name '*.rs' -o -name '*.py' | grep -v target/ | grep -v __pycache__ | grep -v .git/`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );
    const files = output.trim().split('\n').filter(Boolean);
    // Sort by file size descending (larger files = more opportunity)
    return files.sort((a, b) => {
      try {
        const sA = fs.statSync(path.join(repoPath, a)).size;
        const sB = fs.statSync(path.join(repoPath, b)).size;
        return sB - sA;
      } catch {
        return 0;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Run a proactive enhancement scan on a batch of files.
 * Uses MiniMax to analyze existing code for memory efficiency improvements.
 */
async function runProactiveScan(
  repoPath: string,
  apiKey: string,
  state: OrchestratorState,
): Promise<Finding[]> {
  const allFiles = getScannableFiles(repoPath);
  if (allFiles.length === 0) return [];

  // Round-robin through files
  const startIdx = (state.proactiveScanIndex || 0) % allFiles.length;
  const batch = [];
  for (let i = 0; i < PROACTIVE_SCAN_BATCH_SIZE && i < allFiles.length; i++) {
    batch.push(allFiles[(startIdx + i) % allFiles.length]);
  }

  // Advance index for next scan
  state.proactiveScanIndex =
    (startIdx + PROACTIVE_SCAN_BATCH_SIZE) % allFiles.length;

  // Read file contents
  const sourceContext = batch
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      const truncated =
        content.length > 15_000
          ? content.slice(0, 15_000) + '\n... (truncated)'
          : content;
      return `--- ${f} (${content.length} bytes) ---\n${truncated}\n`;
    })
    .filter(Boolean)
    .join('\n');

  if (!sourceContext) return [];

  const prompt = `FILES BEING SCANNED (${batch.length} files, proactive enhancement scan):
${batch.join('\n')}

FULL SOURCE CODE:
${sourceContext.slice(0, 60_000)}

${PROACTIVE_ENHANCEMENT_PROMPT}`;

  logger.info(
    { files: batch, startIdx, totalFiles: allFiles.length },
    'Running proactive memory efficiency scan',
  );

  try {
    const raw = await queryMiniMax(prompt, apiKey);
    const findings = parseMiniMaxFindings(raw);
    // Tag all findings as enhancement type and add source perspective
    return findings.map((f) => ({
      ...f,
      type: 'enhancement' as const,
      sourcePerspectives: ['proactive-memory-efficiency'],
    }));
  } catch (err) {
    logger.warn({ err }, 'Proactive scan MiniMax query failed');
    return [];
  }
}

function buildTriagePrompt(
  diff: string,
  commitLog: string,
  changedFiles: string[],
  repoPath: string,
  semanticDiff?: string,
  astGrepFindings?: string,
  openGrepFindings?: string,
): string {
  // Include source file contents — experts need full context, not just diffs.
  // Root cause of false positives #231/#234: experts saw only the diff and missed
  // platform guards, design patterns, and surrounding code that explained the behavior.
  const sourceContext = changedFiles
    .slice(0, 5)
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      // Truncate large files but include enough context
      const truncated =
        content.length > 12_000
          ? content.slice(0, 12_000) + '\n... (truncated)'
          : content;
      return `--- ${f} (full source) ---\n${truncated}\n`;
    })
    .filter(Boolean)
    .join('\n');

  return `CHANGED FILES:
${changedFiles.join('\n')}

COMMIT LOG:
${commitLog}

FULL SOURCE OF CHANGED FILES:
${sourceContext.length > 60_000 ? sourceContext.slice(0, 60_000) + `\n[NOTE: Source context truncated from ${sourceContext.length} to 60,000 chars]` : sourceContext}

${
  astGrepFindings
    ? `AST-GREP STRUCTURAL FINDINGS (deterministic, high-confidence):
${astGrepFindings}

These findings are from deterministic structural rules (not LLM-generated).
If an ast-grep finding overlaps with your analysis, cite it as corroborating evidence.
If you find issues NOT caught by ast-grep, still report them — ast-grep only covers known patterns.

`
    : ''
}${
    openGrepFindings
      ? `OPENGREP SAST FINDINGS (taint analysis, security-focused):
${openGrepFindings}

These findings are from OpenGrep static analysis with cross-function taint tracking.
Security findings (injection, path traversal, etc.) from OpenGrep are high-confidence.
Cite them as corroborating evidence if they overlap with your analysis.

`
      : ''
  }${
    semanticDiff
      ? `SEMANTIC DIFF (AST-aware, formatting noise removed):
${semanticDiff.slice(0, 20_000)}

`
      : ''
  }DIFF (what changed):
${diff.slice(0, 30_000)}

IMPORTANT: Before reporting a finding, verify it against the FULL SOURCE CODE above.
${semanticDiff ? '- Use the SEMANTIC DIFF to distinguish real code changes from formatting/whitespace changes\n- If the semantic diff shows no structural change for a file, formatting-only changes are NOT findings' : ''}
- Check if the concern is already handled elsewhere in the file
- Check if there are platform guards, fallback paths, or intentional design patterns
- Check if the behavior is by-design for this specific use case
- A finding without evidence in the source code is a false positive

JSON:`;
}

/** Parse a MiniMax response into findings array */
function parseMiniMaxFindings(raw: string): Finding[] {
  let jsonStr = raw.trim();

  // Extract from markdown fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Extract JSON array — MiniMax may append explanation after it
  const arrayMatch = jsonStr.match(/(\[[\s\S]*?\])(?:\s*\n|$)/);
  if (arrayMatch) {
    jsonStr = arrayMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Deduplicate findings across perspectives using title word similarity */
function deduplicateFindings(allFindings: Finding[]): Finding[] {
  const unique: Finding[] = [];

  for (const finding of allFindings) {
    const dupeIndex = unique.findIndex((existing) => {
      const existingWords = extractWords(existing.title);
      const newWords = extractWords(finding.title);
      const intersection = newWords.filter((w) => existingWords.includes(w));
      const union = new Set([...existingWords, ...newWords]);
      return union.size > 0 && intersection.length / union.size >= 0.4;
    });

    if (dupeIndex >= 0) {
      // Merge perspective tags from duplicate into the kept finding
      const existing = unique[dupeIndex];
      const newPerspectives = finding.sourcePerspectives || [];
      existing.sourcePerspectives = [
        ...new Set([
          ...(existing.sourcePerspectives || []),
          ...newPerspectives,
        ]),
      ];
      // Upgrade severity if duplicate has higher severity
      if (severityRank(finding.severity) > severityRank(existing.severity)) {
        existing.severity = finding.severity;
      }
    } else {
      unique.push(finding);
    }
  }

  return unique;
}

/**
 * Multi-perspective MiniMax triage.
 * Runs 5 expert perspectives in parallel, aggregates findings,
 * deduplicates, filters by severity, and returns the top findings.
 */
async function triageChanges(
  diff: string,
  commitLog: string,
  changedFiles: string[],
  apiKey: string,
  repoPath: string,
  semanticDiff?: string,
  astGrepFindings?: string,
  openGrepFindings?: string,
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(
    diff,
    commitLog,
    changedFiles,
    repoPath,
    semanticDiff,
    astGrepFindings,
    openGrepFindings,
  );

  // Run all expert perspectives in parallel (~$0.05 total, ~15s wall time)
  const perspectiveResults = await Promise.allSettled(
    EXPERT_PERSPECTIVES.map(async (expert) => {
      const t0 = Date.now();
      try {
        const raw = await queryMiniMax(prompt, apiKey, expert.systemPrompt);
        const findings = parseMiniMaxFindings(raw);
        const durationMs = Date.now() - t0;
        logger.info(
          { expert: expert.name, findings: findings.length, durationMs },
          'Expert perspective complete',
        );
        return { expert: expert.name, findings, raw };
      } catch (err) {
        logger.warn(
          { expert: expert.name, err, durationMs: Date.now() - t0 },
          'Expert perspective failed',
        );
        return { expert: expert.name, findings: [] as Finding[], raw: '' };
      }
    }),
  );

  // Collect all findings across perspectives, tagging each with its source
  const allFindings: Finding[] = [];
  const perspectiveSummaries: string[] = [];

  for (const result of perspectiveResults) {
    if (result.status === 'fulfilled') {
      const { expert, findings } = result.value;
      perspectiveSummaries.push(`${expert}:${findings.length}`);
      for (const f of findings) {
        f.sourcePerspectives = [expert];
      }
      allFindings.push(...findings);
    }
  }

  logger.info(
    {
      perspectives: perspectiveSummaries.join(', '),
      totalRaw: allFindings.length,
    },
    'All expert perspectives collected',
  );

  // Deduplicate across perspectives
  const deduped = deduplicateFindings(allFindings);

  // Filter: confidence >= 4, medium+ severity, max 5, sort by severity desc
  const filtered = deduped
    .filter((f) => {
      // Confidence gate: experts must self-score >= 4 (from FP prevention research)
      if (f.confidence !== undefined && f.confidence < 4) {
        logger.info(
          { title: f.title, confidence: f.confidence },
          'Finding below confidence threshold, skipping',
        );
        return false;
      }
      return severityRank(f.severity) >= severityRank(MIN_SEVERITY_FOR_ISSUE);
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, MAX_FINDINGS_PER_CYCLE);

  // If we have findings, run two more MiniMax rounds:
  // 1. Consensus round: skeptical reviewer cross-references against source code
  // 2. Devil's advocate round: actively tries to disprove each surviving finding
  // Both are cheap (~$0.01 each) and catch different types of false positives.
  if (filtered.length > 0) {
    // Load false positive patterns from previously closed-as-wontfix issues
    const fpPatterns = loadFalsePositivePatterns();

    // Filter out findings that match known false positive patterns
    const afterFpFilter =
      fpPatterns.length > 0
        ? filtered.filter((f) => {
            const matchesFp = fpPatterns.some((pattern) => {
              const patternWords = extractWords(pattern);
              const findingWords = extractWords(f.title + ' ' + f.description);
              const intersection = findingWords.filter((w) =>
                patternWords.includes(w),
              );
              const union = new Set([...findingWords, ...patternWords]);
              return union.size > 0 && intersection.length / union.size >= 0.35;
            });
            if (matchesFp) {
              logger.info(
                { title: f.title },
                'Finding matches known false positive pattern, skipping',
              );
            }
            return !matchesFp;
          })
        : filtered;

    if (afterFpFilter.length === 0) {
      return {
        findings: [],
        summary: `${allFindings.length} raw → ${deduped.length} deduped → ${filtered.length} filtered → 0 after false positive pattern matching`,
      };
    }

    // Round 1: Consensus (skeptical reviewer)
    const consensusFindings = await runConsensusRound(
      afterFpFilter,
      diff,
      changedFiles,
      apiKey,
      repoPath,
    );

    if (consensusFindings.length === 0) {
      return {
        findings: [],
        summary: `${allFindings.length} raw → ${deduped.length} deduped → ${afterFpFilter.length} filtered → 0 after consensus`,
      };
    }

    // Round 2: Devil's advocate — actively tries to disprove each finding
    const advocateFindings = await runDevilsAdvocateRound(
      consensusFindings,
      changedFiles,
      apiKey,
      repoPath,
    );

    return {
      findings: advocateFindings,
      summary: `${allFindings.length} raw → ${deduped.length} deduped → ${afterFpFilter.length} filtered → ${consensusFindings.length} consensus → ${advocateFindings.length} after devil's advocate`,
    };
  }

  return {
    findings: filtered,
    summary: `${allFindings.length} raw → ${deduped.length} deduped → ${filtered.length} after filtering`,
  };
}

/**
 * MiniMax consensus round: present all findings to a fresh MiniMax call
 * that acts as a skeptical reviewer. Cheap (~$0.01) second opinion
 * before we spend ~$0.05/finding on Claude validation.
 */
async function runConsensusRound(
  findings: Finding[],
  diff: string,
  changedFiles: string[],
  apiKey: string,
  repoPath: string,
): Promise<Finding[]> {
  // Read source files for context
  const fileContents = changedFiles
    .slice(0, 5) // limit to 5 files
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      return `--- ${f} ---\n${content.slice(0, 8_000)}\n`;
    })
    .filter(Boolean)
    .join('\n');

  const consensusPrompt = `You are a skeptical senior engineer reviewing findings from automated code analysis.

FINDINGS TO REVIEW:
${JSON.stringify(findings, null, 2)}

CHANGED FILES:
${changedFiles.join('\n')}

RELEVANT SOURCE CODE:
${fileContents.slice(0, 30_000)}

DIFF:
${diff.slice(0, 20_000)}

For each finding, determine if it is:
1. VALID — a genuine concern that should be investigated
2. FALSE_POSITIVE — incorrect, already handled, or by design

Respond with a JSON array containing ONLY the valid findings (copy them exactly).
If ALL findings are false positives, respond with: []

Be skeptical. A finding is only valid if you can see the actual problem in the source code.

JSON:`;

  const consensusSystem = `You are a senior engineer at a financial data company reviewing automated code analysis findings. Your job is to AGGRESSIVELY eliminate false positives by cross-referencing findings against the actual source code.

COMMON FALSE POSITIVE PATTERNS TO CHECK:
1. "Silent catch/pass" in best-effort utility code — if the function is optional/fallback, silent failure is correct
2. "State not persisted" when the design is intentionally stateless (e.g., adaptive loops that re-evaluate freshness)
3. "Missing error handling" when the code has platform guards or early returns that make the error path unreachable
4. "Hardcoded value" when it's a tuned parameter with comments explaining the choice
5. "Missing test" for trivial getters, configuration, or platform-specific paths
6. "Performance concern" for code that runs infrequently (startup, shutdown, config load)
7. "Resource leak" when the resource is cleaned up by scope/RAII/context manager

When in doubt, REJECT the finding. A false positive issue wastes more time than a missed real bug.`;

  try {
    const raw = await queryMiniMax(consensusPrompt, apiKey, consensusSystem);
    const consensusFindings = parseMiniMaxFindings(raw);

    logger.info(
      { input: findings.length, output: consensusFindings.length },
      'Consensus round complete',
    );

    // If MiniMax returned parseable JSON (even with preamble), trust the result.
    // parseMiniMaxFindings already handles markdown fences and preamble text.
    // Only fall back to originals if parsing produced nothing AND the raw
    // response didn't contain a JSON array at all (true parse failure).
    if (consensusFindings.length > 0 || raw.includes('[')) {
      return consensusFindings;
    }
    logger.warn(
      'Consensus round returned unparseable response, keeping originals',
    );
    return findings;
  } catch (err) {
    logger.warn({ err }, 'Consensus round failed, keeping original findings');
    return findings;
  }
}

/**
 * Devil's advocate round: actively tries to disprove each finding.
 * Unlike the consensus round (which asks "is this valid?"), this round
 * asks "how could this be intentional/correct?" — a fundamentally different
 * prompt that catches different false positive patterns.
 *
 * Cost: ~$0.01 per call. Worth it to avoid wasting user time on false positives.
 */
async function runDevilsAdvocateRound(
  findings: Finding[],
  changedFiles: string[],
  apiKey: string,
  repoPath: string,
): Promise<Finding[]> {
  const fileContents = changedFiles
    .slice(0, 5)
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      return `--- ${f} ---\n${content.slice(0, 10_000)}\n`;
    })
    .filter(Boolean)
    .join('\n');

  const advocatePrompt = `You are a DEVIL'S ADVOCATE. Your job is to DEFEND the code and DISPROVE each finding.

For each finding below, argue why the code is CORRECT as written. Consider:
- Is this behavior intentional for the specific use case (financial data processing)?
- Is the "problem" actually handled by a guard, fallback, or platform check elsewhere?
- Is this a standard pattern in Rust/Python that looks wrong but is correct?
- Would "fixing" this actually break something or add unnecessary complexity?
- Is the "missing" feature actually unneeded for this architecture?

FINDINGS TO CHALLENGE:
${JSON.stringify(findings, null, 2)}

SOURCE CODE:
${fileContents.slice(0, 40_000)}

For each finding, respond with:
- SURVIVES — if you CANNOT find a good defense for the code (the finding is genuinely problematic)
- DISPROVED — if you CAN explain why the code is correct as-is

Respond with a JSON array containing ONLY the findings that SURVIVE your challenge.
If you can disprove ALL findings, respond with: []

JSON:`;

  const advocateSystem = `You are a code defense attorney. Your expertise is finding legitimate reasons why code that LOOKS problematic is actually correct. You know that:
- Best-effort utilities (allocator hints, cache warmup) should fail silently
- Stateless loops are often better than stateful ones (freshness re-evaluation)
- Platform guards make certain error paths unreachable
- Financial systems often have intentionally conservative/simple error handling
- "Missing" persistence is often "intentionally absent" persistence

Your bias is toward DEFENDING the code. Only let a finding survive if you genuinely cannot explain the code's behavior as correct.`;

  try {
    const t0 = Date.now();
    const raw = await queryMiniMax(advocatePrompt, apiKey, advocateSystem);
    const survivingFindings = parseMiniMaxFindings(raw);
    const durationMs = Date.now() - t0;

    logger.info(
      {
        input: findings.length,
        surviving: survivingFindings.length,
        durationMs,
      },
      "Devil's advocate round complete",
    );

    if (survivingFindings.length > 0 || raw.includes('[')) {
      return survivingFindings;
    }
    logger.warn(
      "Devil's advocate returned unparseable response, keeping originals",
    );
    return findings;
  } catch (err) {
    logger.warn({ err }, "Devil's advocate round failed, keeping findings");
    return findings;
  }
}

// --- False Positive Learning ---

const FP_PATTERNS_FILE = path.join(DATA_DIR, 'false-positive-patterns.json');

/**
 * Load false positive patterns from previously closed-as-wontfix issues.
 * These are learned from `syncFalsePositivePatterns()` which runs on heartbeat.
 */
function loadFalsePositivePatterns(): string[] {
  try {
    if (fs.existsSync(FP_PATTERNS_FILE)) {
      return JSON.parse(fs.readFileSync(FP_PATTERNS_FILE, 'utf-8'));
    }
  } catch {
    logger.warn('Failed to load false positive patterns');
  }
  return [];
}

/**
 * Sync false positive patterns from GitHub Issues closed as "not planned".
 * These are NanoClaw issues the user explicitly rejected — we should learn
 * to avoid similar findings in the future.
 */
function syncFalsePositivePatterns(): void {
  try {
    // Note: `stateReason` field not available in older gh versions.
    // Use `state` + check for "not planned" / "false positive" in title/body patterns.
    // All NanoClaw issues closed as wontfix are false positives by definition.
    const result = execSync(
      `gh issue list --repo ${targetRepo} --label nanoclaw --state closed --json title,state --limit 50`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const issues = JSON.parse(result) as Array<{
      title: string;
      state: string;
    }>;

    // All closed nanoclaw issues are treated as false positives
    // (real findings would be fixed and closed via PR, not just closed)
    const fpTitles = issues.map((i) => i.title);

    if (fpTitles.length > 0) {
      fs.mkdirSync(path.dirname(FP_PATTERNS_FILE), { recursive: true });
      fs.writeFileSync(FP_PATTERNS_FILE, JSON.stringify(fpTitles, null, 2));
      logger.info(
        { count: fpTitles.length },
        'False positive patterns synced from closed issues',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to sync false positive patterns');
  }
}

function severityRank(s: string): number {
  const ranks: Record<string, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  return ranks[s] || 0;
}

// --- Verification Script Execution ---

/**
 * Run the finding's validation command to verify the issue actually exists.
 * If the command fails (exit code != 0 or no output), the finding is likely
 * a hallucination — the problematic pattern doesn't exist in the code.
 *
 * Inspired by CodeRabbit's "agentic verification" pattern (FP research).
 */
function verifyFindingScript(
  finding: Finding,
  repoPath: string,
): { verified: boolean; output: string } {
  const cmd = finding.validation?.trim();
  if (!cmd || cmd.length < 3) {
    return { verified: false, output: 'No validation command provided' };
  }

  // Safety: only allow grep, rg, find, cat, head, wc, cargo, python, pytest commands
  const allowedPrefixes = [
    'grep',
    'rg',
    'find',
    'cat',
    'head',
    'tail',
    'wc',
    'cargo',
    'python',
    'pytest',
    'ls',
  ];
  const firstWord = cmd.split(/\s+/)[0];
  if (!allowedPrefixes.some((p) => firstWord.startsWith(p))) {
    logger.info(
      { cmd: cmd.slice(0, 50), title: finding.title },
      'Validation command not in allowlist, skipping verification',
    );
    return {
      verified: true,
      output: 'Command not verifiable (not in allowlist)',
    };
  }

  try {
    const result = execSync(cmd, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    const output = result.trim();
    if (output.length === 0) {
      logger.info(
        { title: finding.title, cmd: cmd.slice(0, 80) },
        'Verification script returned empty — finding may be hallucinated',
      );
      return { verified: false, output: 'Command returned empty output' };
    }
    return { verified: true, output: output.slice(0, 500) };
  } catch (err) {
    logger.info(
      { title: finding.title, cmd: cmd.slice(0, 80), err },
      'Verification script failed — finding likely hallucinated',
    );
    return {
      verified: false,
      output: `Command failed: ${String(err).slice(0, 200)}`,
    };
  }
}

// --- Claude Validation (Phase 3) ---

/**
 * Validate a MiniMax finding using Claude Code (`claude -p`).
 * Claude reads the actual source files, analyzes the concern,
 * and returns a structured verdict: confirmed or rejected.
 *
 * Uses subscription OAuth token (already configured on bigblack).
 * Runs on the host — container isolation deferred to Phase 6.
 */
function validateWithClaude(
  finding: Finding,
  repoPath: string,
  headCommit: string,
): ValidationResult | null {
  // Build file context: read affected files for Claude to analyze
  const fileContexts = finding.files
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      // Truncate large files to 10KB
      const truncated =
        content.length > 10_000
          ? content.slice(0, 10_000) + '\n... (truncated)'
          : content;
      return `--- ${f} ---\n${truncated}\n`;
    })
    .filter(Boolean)
    .join('\n');

  const prompt = `You are the FINAL GATE before a GitHub issue is auto-created for opendeviationbar-py (Rust+Python maturin project, financial data processing). A false positive wastes the maintainer's time. Be EXTREMELY skeptical.

FINDING TO VALIDATE:
- Type: ${finding.type}
- Severity: ${finding.severity}
- Title: ${finding.title}
- Description: ${finding.description}
- Files: ${finding.files.join(', ')}
- Suggested validation: ${finding.validation}
- Commit: ${headCommit.slice(0, 7)}

FULL SOURCE CODE OF AFFECTED FILES:
${fileContexts || '(files not readable)'}

VALIDATION CHECKLIST — answer each before deciding:
1. Can you see the EXACT code that's problematic? (not just infer it from the diff)
2. Is there a guard, fallback, or early return that makes this unreachable?
3. Is this behavior intentional for the specific domain (financial data, 24/7 daemons)?
4. Would the suggested fix actually improve things, or add unnecessary complexity?
5. Could this be a best-effort utility where silent failure is correct?
6. Is the "missing" feature actually unneeded for this architecture?

Respond with EXACTLY this JSON format (no markdown fences, no extra text):
{"confirmed": true/false, "confidence": "low"/"medium"/"high", "analysis": "2-3 sentence explanation referencing specific line numbers", "suggestedFix": "optional fix suggestion"}

RULES:
- confirmed=true ONLY if you can point to specific lines where the bug/issue exists
- confirmed=false if: it's by-design, already handled, unreachable, or a false positive
- When in doubt, set confirmed=false — missing a real bug is better than filing a false positive
- confidence=high means you checked all 6 questions above and are certain
- Reference specific line numbers or code snippets in your analysis`;

  try {
    logger.info(
      { title: finding.title, files: finding.files },
      'Validating finding with Claude',
    );

    const result = spawnSync('claude', ['-p', '--output-format', 'text'], {
      input: prompt,
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: CLAUDE_VALIDATION_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    if (result.error || result.status !== 0) {
      logger.error(
        {
          title: finding.title,
          error: result.error?.message || result.stderr?.slice(0, 200),
          status: result.status,
        },
        'Claude validation failed',
      );
      return null;
    }

    const output = result.stdout.trim();

    // Extract JSON from Claude's response (may have markdown or prose around it)
    let jsonStr = output;
    const jsonMatch = output.match(/\{[\s\S]*"confirmed"[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    let validation: ValidationResult;
    try {
      validation = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Log full output on parse failure so we don't lose Claude's response
      logger.error(
        {
          title: finding.title,
          output: output.slice(0, 500),
          parseErr,
        },
        'Claude validation JSON parse failed — response logged for debugging',
      );
      return null;
    }

    // Schema validation: ensure required fields exist
    if (
      typeof validation.confirmed !== 'boolean' ||
      !validation.confidence ||
      !validation.analysis
    ) {
      logger.error(
        {
          title: finding.title,
          parsed: JSON.stringify(validation).slice(0, 200),
        },
        'Claude validation missing required fields (confirmed/confidence/analysis)',
      );
      return null;
    }

    logger.info(
      {
        title: finding.title,
        confirmed: validation.confirmed,
        confidence: validation.confidence,
      },
      'Claude validation result',
    );

    return validation;
  } catch (err) {
    logger.error({ err, title: finding.title }, 'Claude validation error');
    return null;
  }
}

// --- Fuzzy Deduplication ---

/**
 * Check if a similar issue already exists using fuzzy title matching.
 * Compares word overlap (Jaccard similarity) to catch near-duplicates
 * like "Silent failure in X" vs "X silently swallows errors".
 */
function issueExistsFuzzy(title: string): boolean {
  try {
    // Fetch all nanoclaw issues (open + closed) to avoid re-filing rejected findings
    const result = execSync(
      `gh issue list --repo ${targetRepo} --label nanoclaw --state all --limit 100 --json title`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const issues = JSON.parse(result) as Array<{ title: string }>;

    const titleWords = extractWords(title);

    for (const issue of issues) {
      // Exact match
      if (issue.title.toLowerCase() === title.toLowerCase()) return true;

      // Fuzzy: Jaccard similarity on words
      const issueWords = extractWords(issue.title);
      const intersection = titleWords.filter((w) => issueWords.includes(w));
      const union = new Set([...titleWords, ...issueWords]);
      const similarity = union.size > 0 ? intersection.length / union.size : 0;

      if (similarity >= 0.5) {
        logger.info(
          {
            existing: issue.title,
            new: title,
            similarity: similarity.toFixed(2),
          },
          'Fuzzy duplicate detected',
        );
        return true;
      }
    }
    return false;
  } catch {
    return false; // fail open — create the issue
  }
}

function extractWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2); // skip short words like "in", "of"
}

// --- cc-skills Sync ---

/**
 * Pull latest cc-skills for up-to-date issue templates and patterns.
 * Fire-and-forget — failure is non-fatal.
 */
/** Cached cc-skills reference content for issue creation quality */
let ccSkillsLabelStrategy = '';
let ccSkillsContentTypes = '';

function syncCcSkills(ccSkillsPath: string): void {
  if (!ccSkillsPath || !fs.existsSync(ccSkillsPath)) return;
  try {
    execSync('git pull --ff-only origin main 2>&1', {
      cwd: ccSkillsPath,
      timeout: 15_000,
      encoding: 'utf-8',
    });

    // Read label strategy and content type references for issue creation
    const labelStrategyPath = path.join(
      ccSkillsPath,
      'plugins/gh-tools/skills/issue-create/references/label-strategy.md',
    );
    const contentTypesPath = path.join(
      ccSkillsPath,
      'plugins/gh-tools/skills/issue-create/references/content-types.md',
    );

    if (fs.existsSync(labelStrategyPath)) {
      ccSkillsLabelStrategy = fs
        .readFileSync(labelStrategyPath, 'utf-8')
        .slice(0, 2000);
    }
    if (fs.existsSync(contentTypesPath)) {
      ccSkillsContentTypes = fs
        .readFileSync(contentTypesPath, 'utf-8')
        .slice(0, 2000);
    }

    logger.info(
      {
        path: ccSkillsPath,
        hasLabelStrategy: !!ccSkillsLabelStrategy,
        hasContentTypes: !!ccSkillsContentTypes,
      },
      'cc-skills synced and references loaded',
    );
  } catch (err) {
    logger.warn({ err }, 'cc-skills sync failed (non-fatal)');
  }
}

// --- Label Taxonomy (cc-skills pattern: taxonomy-aware labels) ---

/**
 * Fetch existing labels from the target repo. Cached for 24 hours.
 * cc-skills pattern: only suggest labels that actually exist in the repo.
 */
function fetchRepoLabels(): string[] {
  const now = Date.now();
  if (cachedRepoLabels && now - labelsCacheTime < LABEL_CACHE_TTL_MS) {
    return cachedRepoLabels;
  }
  try {
    const result = execSync(
      `gh label list --repo ${targetRepo} --json name --limit 100`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const labels = JSON.parse(result) as Array<{ name: string }>;
    cachedRepoLabels = labels.map((l) => l.name);
    labelsCacheTime = now;
    logger.info({ count: cachedRepoLabels.length }, 'Repo labels fetched');
    return cachedRepoLabels;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch repo labels');
    return cachedRepoLabels || [];
  }
}

/**
 * Suggest 2-4 labels for a finding using MiniMax (cheap, fast).
 * cc-skills pattern: AI-powered label suggestion constrained to existing taxonomy.
 * Falls back to keyword matching if MiniMax fails.
 */
async function suggestLabels(
  finding: Finding,
  validation: ValidationResult,
  apiKey: string,
): Promise<string[]> {
  const repoLabels = fetchRepoLabels();
  // Always include 'nanoclaw' base label
  const baseLabels = ['nanoclaw'];

  if (repoLabels.length === 0) {
    // No labels fetched — fall back to type-based label
    return [...baseLabels, finding.type];
  }

  // Keyword fallback mapping (cc-skills pattern)
  const keywordMap: Record<string, string[]> = {
    bug: ['bug', 'error', 'crash', 'broken', 'fail', 'defect'],
    'performance-regression': [
      'performance',
      'perf',
      'regression',
      'slow',
      'benchmark',
    ],
    'test-gap': ['testing', 'test', 'coverage', 'quality'],
    'daemon-behavior': ['daemon', 'service', 'runtime', 'behavior'],
  };

  try {
    // Inject cc-skills label strategy if available (read from synced repo)
    const strategyContext = ccSkillsLabelStrategy
      ? `\nLABEL STRATEGY GUIDE:\n${ccSkillsLabelStrategy.slice(0, 800)}\n`
      : '';

    const prompt = `Suggest 2-4 labels from the EXISTING taxonomy only for this code finding.
Never suggest labels that don't exist in the list below.
Return ONLY a JSON array of label names, nothing else.
${strategyContext}
AVAILABLE LABELS:
${repoLabels.map((l) => `- ${l}`).join('\n')}

FINDING TYPE: ${finding.type}
SEVERITY: ${finding.severity}
TITLE: ${finding.title}
DESCRIPTION: ${finding.description}
CONFIDENCE: ${validation.confidence}

Return format: ["label1", "label2"]`;

    const raw = await queryMiniMax(
      prompt,
      apiKey,
      'You suggest GitHub issue labels. Return only a JSON array.',
    );
    const suggested = JSON.parse(raw.trim()) as string[];

    // Validate: only keep labels that exist in the repo
    const validLabels = suggested.filter((l) => repoLabels.includes(l));
    const result = [...new Set([...baseLabels, ...validLabels])];
    logger.info({ suggested: validLabels }, 'MiniMax label suggestion');
    return result.slice(0, 5); // cap at 5 labels
  } catch {
    // Keyword fallback (cc-skills pattern)
    const keywords = keywordMap[finding.type] || [];
    const matched = repoLabels.filter((label) =>
      keywords.some((kw) => label.toLowerCase().includes(kw)),
    );
    return [...new Set([...baseLabels, finding.type, ...matched])].slice(0, 5);
  }
}

// --- Related Issues Search (cc-skills pattern) ---

/**
 * Search for related existing issues to link in the new issue body.
 * cc-skills pattern: duplicate warnings + related issue references.
 */
function searchRelatedIssues(
  title: string,
  _files: string[],
): Array<{ number: number; title: string; url: string }> {
  try {
    // Search by key words from the title
    const searchTerms = extractWords(title).slice(0, 3).join(' ');
    const result = execSync(
      `gh issue list --repo ${targetRepo} --search "${searchTerms.replace(/"/g, '\\"')}" --state all --limit 5 --json number,title,url`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const issues = JSON.parse(result) as Array<{
      number: number;
      title: string;
      url: string;
    }>;
    return issues;
  } catch {
    return [];
  }
}

// --- Type-Specific Issue Templates (cc-skills pattern) ---

const FINDING_TYPE_TEMPLATES: Record<
  string,
  (f: Finding, v: ValidationResult, commit: string) => string
> = {
  bug: (f, v, commit) => `## Bug Report

### Description

${f.description}

### Evidence

${v.analysis}

### Affected Files

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Steps to Reproduce

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Suggested Fix\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,

  'performance-regression': (f, v, commit) => `## Performance Regression

### Description

${f.description}

### Evidence

${v.analysis}

### Affected Files

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Benchmark / Validation

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Suggested Fix\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,

  'test-gap': (f, v, commit) => `## Test Coverage Gap

### Summary

${f.description}

### Analysis

${v.analysis}

### Affected Files (Missing Coverage)

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Suggested Tests

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Proposed Implementation\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,

  'daemon-behavior': (f, v, commit) => `## Daemon Behavior Issue

### Description

${f.description}

### Analysis

${v.analysis}

### Affected Files

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Reproduction / Validation

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Suggested Fix\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,
};

// --- Title Optimization (cc-skills pattern: use full 256 chars) ---

const TITLE_TYPE_PREFIX: Record<string, string> = {
  bug: 'Bug',
  'performance-regression': 'Perf',
  'test-gap': 'Test Gap',
  'daemon-behavior': 'Daemon',
};

function optimizeTitle(finding: Finding): string {
  const prefix = TITLE_TYPE_PREFIX[finding.type] || finding.type;
  const severityTag =
    finding.severity === 'critical' || finding.severity === 'high'
      ? ` [${finding.severity}]`
      : '';
  // cc-skills pattern: use full 256-char GitHub title limit for informative, searchable titles
  const base = `${prefix}: ${finding.title}${severityTag}`;
  if (base.length <= 256) return base;
  return base.slice(0, 253) + '...';
}

// --- GitHub Issue Creation (enhanced with cc-skills patterns) ---

function createGitHubIssue(
  finding: Finding,
  validation: ValidationResult,
  repoPath: string,
  headCommit: string,
  labels: string[],
): string | null {
  const commitShort = headCommit.slice(0, 7);
  const template =
    FINDING_TYPE_TEMPLATES[finding.type] || FINDING_TYPE_TEMPLATES['bug'];
  const typedBody = template(finding, validation, commitShort);

  // Discovery provenance (cc-skills gh-tools pattern)
  const perspectives = finding.sourcePerspectives?.length
    ? finding.sourcePerspectives.join(', ')
    : 'consensus';
  const perspectiveCount = finding.sourcePerspectives?.length || 0;

  // Related issues
  const related = searchRelatedIssues(finding.title, finding.files);
  const relatedSection =
    related.length > 0
      ? `\n### Related Issues\n\n${related.map((r) => `- #${r.number} — ${r.title}`).join('\n')}\n`
      : '';

  // YAML frontmatter (machine-readable metadata)
  const frontmatter = `---
nanoclaw-type: ${finding.type}
severity: ${finding.severity}
confidence: ${validation.confidence}
perspectives: ${perspectiveCount}
files:
${finding.files.map((f) => `  - ${f}`).join('\n')}
validation: |
  ${finding.validation}
commit: ${commitShort}
---`;

  // Discovery provenance section
  const provenanceSection = `### Discovery Provenance

| Field | Value |
|-------|-------|
| Pipeline | MiniMax M2.5-highspeed triage → Claude Code validation |
| Perspectives | ${perspectives} (${perspectiveCount} expert${perspectiveCount !== 1 ? 's' : ''}) |
| Commit | \`${commitShort}\` |
| Created | ${new Date().toISOString()} |`;

  const body = `${frontmatter}

${typedBody}
${relatedSection}
${provenanceSection}

---
*Auto-created by [NanoClaw](https://github.com/terrylica/nanoclaw) continuous validation*`;

  const title = optimizeTitle(finding);

  try {
    // Use a temp file for the body to avoid shell escaping issues (cc-skills GFM anti-pattern AP-04)
    const tmpFile = path.join(DATA_DIR, 'issue-body.tmp.md');
    fs.writeFileSync(tmpFile, body);

    const labelStr = labels.join(',');
    const result = execSync(
      `gh issue create --repo ${targetRepo} --title "${title.replace(/"/g, '\\"')}" --label "${labelStr}" --body-file "${tmpFile}"`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 15_000 },
    );

    // Clean up temp file
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }

    const url = result.trim();
    logger.info(
      {
        url,
        type: finding.type,
        confidence: validation.confidence,
        labels: labelStr,
      },
      'GitHub issue created',
    );
    return url;
  } catch (err) {
    logger.error({ err, title }, 'Failed to create GitHub issue');
    return null;
  }
}

// --- Telegram Notifications ---

async function sendTelegramNotification(
  message: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
          disable_notification: true,
          link_preview_options: { is_disabled: true },
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, body: body.slice(0, 200) },
        'Telegram API error',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Telegram notification failed (non-fatal)');
  }
}

function formatHeartbeat(state: OrchestratorState, branch: string): string {
  const elapsed = (
    (Date.now() - new Date(state.startedAt).getTime()) /
    60_000
  ).toFixed(0);
  return [
    `<b>💚 NanoClaw Heartbeat</b>`,
    ``,
    `• Cycles: <code>${state.cycleCount}</code>`,
    `• Issues created: <code>${state.issuesCreated}</code>`,
    `• Validated: <code>${state.findingsValidated}</code> | Rejected: <code>${state.findingsRejected}</code>`,
    `• Uptime: <code>${elapsed} min</code>`,
    `• Branch: <code>${branch}</code>`,
    `• Last commit: <code>${state.lastCheckedCommit.slice(0, 7) || 'none'}</code>`,
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  ].join('\n');
}

function formatFindingNotification(
  finding: Finding,
  validation: ValidationResult,
  issueUrl: string | null,
): string {
  const icon =
    finding.severity === 'critical'
      ? '🔴'
      : finding.severity === 'high'
        ? '🟠'
        : finding.severity === 'medium'
          ? '🟡'
          : '🟢';
  const lines = [
    `<b>${icon} NanoClaw: ${escapeHtml(finding.title)}</b>`,
    ``,
    `<b>Type</b>: <code>${finding.type}</code> | <b>Severity</b>: <code>${finding.severity}</code> | <b>Confidence</b>: <code>${validation.confidence}</code>`,
    `<b>Files</b>: ${finding.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ')}`,
    ``,
    `<i>${escapeHtml(finding.description)}</i>`,
    ``,
    `<b>Analysis</b>: ${escapeHtml(validation.analysis.slice(0, 300))}`,
  ];
  if (issueUrl) {
    lines.push(``, `📋 ${issueUrl}`);
  }
  lines.push(
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  );
  return lines.join('\n');
}

function formatCycleStart(
  from: string,
  to: string,
  changedFiles: string[],
  cycle: number,
): string {
  const fileList = changedFiles
    .slice(0, 8)
    .map((f) => `<code>${escapeHtml(f)}</code>`)
    .join('\n');
  const overflow =
    changedFiles.length > 8
      ? `\n<i>… +${changedFiles.length - 8} more</i>`
      : '';
  return [
    `<b>🔍 NanoClaw Cycle #${cycle}</b>`,
    ``,
    `<code>${from.slice(0, 7)}</code> → <code>${to.slice(0, 7)}</code>`,
    `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed:`,
    fileList + overflow,
    ``,
    `<i>Triaging with MiniMax…</i>`,
  ].join('\n');
}

function formatTriageResult(
  findingCount: number,
  summary: string,
  _cycle: number,
): string {
  if (findingCount === 0) {
    return [
      `<b>✅ Triage: No Findings</b>`,
      ``,
      `<i>${escapeHtml(summary.slice(0, 300))}</i>`,
    ].join('\n');
  }
  return [
    `<b>🎯 Triage: ${findingCount} Finding${findingCount === 1 ? '' : 's'}</b>`,
    ``,
    `<i>${escapeHtml(summary.slice(0, 300))}</i>`,
    ``,
    `<i>Validating with Claude Code…</i>`,
  ].join('\n');
}

function formatCycleSummary(
  cycle: number,
  findingsTotal: number,
  validated: number,
  rejected: number,
  issuesCreated: number,
  skippedReasons: string[],
): string {
  const lines = [
    `<b>📊 Cycle #${cycle} Complete</b>`,
    ``,
    `• Findings: <code>${findingsTotal}</code>`,
    `• Confirmed: <code>${validated}</code> | Rejected: <code>${rejected}</code>`,
    `• Issues created: <code>${issuesCreated}</code>`,
  ];
  if (skippedReasons.length > 0) {
    lines.push(``, `<b>Skipped</b>:`);
    for (const reason of skippedReasons.slice(0, 5)) {
      lines.push(`• <i>${escapeHtml(reason)}</i>`);
    }
  }
  lines.push(
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  );
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- CLAUDE.md Maintenance (Project Memory) ---

const CLAUDE_MD_MAINTENANCE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — large multi-file task

const CLAUDE_MD_META_PROMPT = `You are going to autonomously migrate/rectify/prune/update/grow root Project Memory CLAUDE.md file in the project root.

The purpose is to maximize autonomous discovery by other Anthropic's Claude Code CLI AI coding sessions that are new to our project.

The prefer pattern is that CLAUDE.md file in the project root folder act as a Link Farm + Hub-and-Spoke with Progressive Disclosure (essentials only, each doc links deeper, single source of truth per topic) to nested Project Memory (CLAUDE.md files in the children of the directory of our project root directory). Claude will pull in CLAUDE.md files on demand when we work with files in child directories.

Hence, migrate/rectify/prune/update/grow those nested Project Memory CLAUDE.md files, too, so that we can take advantage of the Link Farm + Hub-and-Spoke with Progressive Disclosure starting from the root Project Memory CLAUDE.md file.

CONTEXT ON WHAT CHANGED:
The following files were modified in recent commits. Use this to understand what areas of the project need CLAUDE.md updates:

CHANGED_FILES_PLACEHOLDER

INSTRUCTIONS:
1. Read the root CLAUDE.md and all nested CLAUDE.md files
2. Read the changed files to understand what the changes do
3. Update CLAUDE.md files to reflect new patterns, APIs, configurations, or architectural changes
4. Ensure the root CLAUDE.md links to all nested CLAUDE.md files (hub-and-spoke)
5. Prune outdated information that no longer reflects the codebase
6. Add new sections for new directories/modules that lack CLAUDE.md coverage
7. Keep each CLAUDE.md focused on its directory scope — essentials only, link deeper for details
8. Do NOT add trivial or self-evident information — only document what aids autonomous discovery

OUTPUT:
Respond with a brief summary of what you changed (or "No changes needed" if the CLAUDE.md files are already up to date).`;

async function runClaudeMdMaintenance(
  repoPath: string,
  changedFiles: string[],
  botToken: string,
  chatId: string,
): Promise<void> {
  const fileList = changedFiles.map((f) => `  - ${f}`).join('\n');
  const prompt = CLAUDE_MD_META_PROMPT.replace(
    'CHANGED_FILES_PLACEHOLDER',
    fileList,
  );

  logger.info(
    { changedFiles: changedFiles.length },
    'Running CLAUDE.md maintenance via Claude',
  );

  if (botToken && chatId) {
    await sendTelegramNotification(
      [
        `<b>📝 CLAUDE.md Maintenance</b>`,
        ``,
        `Updating project memory for <code>${changedFiles.length}</code> changed files...`,
      ].join('\n'),
      botToken,
      chatId,
    );
  }

  try {
    const result = spawnSync(
      'claude',
      [
        '-p',
        '--output-format',
        'text',
        '--allowedTools',
        'Edit,Write,Read,Glob,Grep',
      ],
      {
        input: prompt,
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: CLAUDE_MD_MAINTENANCE_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    if (result.error || result.status !== 0) {
      logger.error(
        {
          error: result.error?.message || result.stderr?.slice(0, 200),
          status: result.status,
        },
        'CLAUDE.md maintenance failed',
      );
      if (botToken && chatId) {
        await sendTelegramNotification(
          [
            `<b>📝 CLAUDE.md Maintenance — Failed</b>`,
            ``,
            `<code>${escapeHtml((result.error?.message || result.stderr || 'Unknown error').slice(0, 200))}</code>`,
          ].join('\n'),
          botToken,
          chatId,
        );
      }
      return;
    }

    const output = result.stdout.trim();
    const summary = output.slice(0, 500);

    logger.info({ summary }, 'CLAUDE.md maintenance complete');

    if (botToken && chatId) {
      await sendTelegramNotification(
        [
          `<b>📝 CLAUDE.md Maintenance — Done</b>`,
          ``,
          `<i>${escapeHtml(summary)}</i>`,
        ].join('\n'),
        botToken,
        chatId,
      );
    }
  } catch (err) {
    logger.error({ err }, 'CLAUDE.md maintenance error');
  }
}

// --- Main Loop ---

export interface OrchestratorConfig {
  repoPath: string; // Path to opendeviationbar-py clone
  githubRepo?: string; // GitHub owner/repo (e.g. 'terrylica/opendeviationbar-py'). Auto-detected from git remote if omitted.
}

/**
 * Run a proactive enhancement scan cycle.
 * Picks a batch of files, asks MiniMax for memory efficiency improvements,
 * then validates and creates issues through the standard pipeline.
 */
async function runProactiveScanCycle(
  config: OrchestratorConfig,
  state: OrchestratorState,
  minimaxKey: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const headCommit = getHeadCommit(config.repoPath);
  const scanIdx = state.proactiveScanIndex || 0;
  const batchNum = Math.floor(scanIdx / PROACTIVE_SCAN_BATCH_SIZE) + 1;

  // Helper to send Telegram with layer info
  const tg = async (msg: string) => {
    if (botToken && chatId) {
      await sendTelegramNotification(msg, botToken, chatId);
    }
  };

  // ── Layer 0: Scan Start ──
  await tg(
    [
      `<b>🔍 Proactive Enhancement Scan #${batchNum}</b>`,
      ``,
      `Scanning ${PROACTIVE_SCAN_BATCH_SIZE} files for memory efficiency...`,
      `<i>7-layer validation pipeline active</i>`,
      ``,
      `<i>Categories: avoid copies, avoid allocation, cache efficiency, lazy evaluation</i>`,
    ].join('\n'),
  );

  try {
    // ── Layer 1: MiniMax Expert Scan ──
    const rawFindings = await runProactiveScan(
      config.repoPath,
      minimaxKey,
      state,
    );

    logger.info(
      { findingCount: rawFindings.length },
      'Proactive scan Layer 1 (MiniMax) complete',
    );

    await tg(
      [
        `<b>🔍 Layer 1: MiniMax Expert Scan</b>`,
        `• Raw findings: <code>${rawFindings.length}</code>`,
        rawFindings.length > 0
          ? rawFindings.map((f) => `  → ${f.title.slice(0, 80)}`).join('\n')
          : `  <i>No enhancement opportunities found in this batch</i>`,
      ].join('\n'),
    );

    if (rawFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${batchNum} Complete</b>\n\nNo findings — all ${PROACTIVE_SCAN_BATCH_SIZE} files clean.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // ── Layer 2: Confidence Gate ──
    const confidentFindings = rawFindings.filter(
      (f) => (f.confidence ?? 0) >= 4,
    );

    await tg(
      [
        `<b>🔍 Layer 2: Confidence Gate (≥4/5)</b>`,
        `• Passed: <code>${confidentFindings.length}/${rawFindings.length}</code>`,
        confidentFindings.length < rawFindings.length
          ? `• Filtered out ${rawFindings.length - confidentFindings.length} low-confidence findings`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (confidentFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${batchNum} Complete</b>\n\nAll findings below confidence threshold.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // ── Layer 3: FP Pattern DB ──
    const fpPatterns = loadFalsePositivePatterns();
    const afterFpFilter =
      fpPatterns.length > 0
        ? confidentFindings.filter((f) => {
            const matchesFp = fpPatterns.some((pattern) => {
              const patternWords = extractWords(pattern);
              const findingWords = extractWords(f.title + ' ' + f.description);
              const intersection = findingWords.filter((w) =>
                patternWords.includes(w),
              );
              const union = new Set([...findingWords, ...patternWords]);
              return union.size > 0 && intersection.length / union.size >= 0.35;
            });
            return !matchesFp;
          })
        : confidentFindings;

    await tg(
      [
        `<b>🔍 Layer 3: FP Pattern DB</b>`,
        `• Known FP patterns: <code>${fpPatterns.length}</code>`,
        `• Passed: <code>${afterFpFilter.length}/${confidentFindings.length}</code>`,
      ].join('\n'),
    );

    if (afterFpFilter.length === 0) {
      await tg(
        `<b>🔍 Scan #${batchNum} Complete</b>\n\nAll findings matched known FP patterns.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // ── Layer 4: Consensus Round (skeptical MiniMax reviewer) ──
    // For proactive scans, the "changedFiles" are the scanned files
    const scannedFiles = getScannableFiles(config.repoPath);
    const batchFiles: string[] = [];
    for (
      let i = 0;
      i < PROACTIVE_SCAN_BATCH_SIZE && i < scannedFiles.length;
      i++
    ) {
      batchFiles.push(
        scannedFiles[
          (scanIdx - PROACTIVE_SCAN_BATCH_SIZE + i + scannedFiles.length) %
            scannedFiles.length
        ],
      );
    }

    const consensusFindings = await runConsensusRound(
      afterFpFilter,
      '', // no diff for proactive scans
      batchFiles,
      minimaxKey,
      config.repoPath,
    );

    await tg(
      [
        `<b>🔍 Layer 4: Consensus Round (skeptical reviewer)</b>`,
        `• Survived: <code>${consensusFindings.length}/${afterFpFilter.length}</code>`,
        consensusFindings.length < afterFpFilter.length
          ? `• ${afterFpFilter.length - consensusFindings.length} findings rejected by skeptical reviewer`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (consensusFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${batchNum} Complete</b>\n\nAll findings rejected at consensus.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // ── Layer 5: Devil's Advocate (tries to DISPROVE each finding) ──
    const advocateFindings = await runDevilsAdvocateRound(
      consensusFindings,
      batchFiles,
      minimaxKey,
      config.repoPath,
    );

    await tg(
      [
        `<b>🔍 Layer 5: Devil's Advocate</b>`,
        `• Survived: <code>${advocateFindings.length}/${consensusFindings.length}</code>`,
        advocateFindings.length < consensusFindings.length
          ? `• ${consensusFindings.length - advocateFindings.length} findings disproved`
          : `• All findings withstood adversarial challenge`,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (advocateFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${batchNum} Complete</b>\n\nAll findings disproved by devil's advocate.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // ── Layers 6 & 7: Per-finding validation ──
    let scanValidated = 0;
    let scanIssues = 0;
    const scanSkipped: string[] = [];

    for (const finding of advocateFindings) {
      // Rate limit
      if (!checkRateLimit(state)) {
        scanSkipped.push('Rate limit reached');
        break;
      }

      // Fuzzy dedup against existing issues
      if (issueExistsFuzzy(finding.title)) {
        scanSkipped.push(`Duplicate: ${finding.title.slice(0, 60)}`);
        continue;
      }

      // ── Layer 6: Verification Script ──
      const scriptCheck = verifyFindingScript(finding, config.repoPath);
      if (!scriptCheck.verified) {
        state.findingsRejected++;
        scanSkipped.push(`Script fail: ${finding.title.slice(0, 60)}`);
        await tg(
          `<b>🔍 Layer 6: Script Check ❌</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Verification script failed — likely hallucinated</i>`,
        );
        continue;
      }

      await tg(
        `<b>🔍 Layer 6: Script Check ✅</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Verification script passed — proceeding to Claude</i>`,
      );

      // ── Layer 7: Claude Code Validation ──
      await tg(
        `<b>🔍 Layer 7: Claude Validation 🧠</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Running claude -p for deep analysis...</i>`,
      );

      const validation = validateWithClaude(
        finding,
        config.repoPath,
        headCommit,
      );

      if (!validation) {
        scanSkipped.push(`Claude unavail: ${finding.title.slice(0, 60)}`);
        await tg(
          `<b>🔍 Layer 7: Claude ⚠️</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Claude validation unavailable — skipping</i>`,
        );
        continue;
      }

      if (!validation.confirmed || validation.confidence === 'low') {
        state.findingsRejected++;
        scanSkipped.push(`Rejected: ${finding.title.slice(0, 60)}`);
        await tg(
          [
            `<b>🔍 Layer 7: Claude ❌</b>`,
            `<code>${finding.title.slice(0, 80)}</code>`,
            `Confidence: <code>${validation.confidence}</code>`,
            `<i>${validation.analysis.slice(0, 200)}</i>`,
          ].join('\n'),
        );
        continue;
      }

      // ── ALL 7 LAYERS PASSED — Create GitHub Issue ──
      state.findingsValidated++;
      scanValidated++;

      await tg(
        [
          `<b>🔍 Layer 7: Claude ✅ CONFIRMED</b>`,
          `<code>${finding.title.slice(0, 80)}</code>`,
          `Confidence: <code>${validation.confidence}</code>`,
          `<i>${validation.analysis.slice(0, 200)}</i>`,
          ``,
          `<b>Creating GitHub Issue...</b>`,
        ].join('\n'),
      );

      const labels = await suggestLabels(finding, validation, minimaxKey);
      const issueUrl = createGitHubIssue(
        finding,
        validation,
        config.repoPath,
        headCommit,
        labels,
      );

      if (issueUrl) {
        state.issuesCreated++;
        if (!state.issueTimestamps) state.issueTimestamps = [];
        state.issueTimestamps.push(Date.now());
        scanIssues++;
      }

      await tg(formatFindingNotification(finding, validation, issueUrl));
    }

    // ── Final Summary ──
    await tg(
      [
        `<b>🔍 Proactive Scan #${batchNum} Complete</b>`,
        ``,
        `<b>Pipeline results:</b>`,
        `• Layer 1 (MiniMax Expert): <code>${rawFindings.length}</code> raw`,
        `• Layer 2 (Confidence ≥4): <code>${confidentFindings.length}</code>`,
        `• Layer 3 (FP Pattern DB): <code>${afterFpFilter.length}</code>`,
        `• Layer 4 (Consensus): <code>${consensusFindings.length}</code>`,
        `• Layer 5 (Devil's Advocate): <code>${advocateFindings.length}</code>`,
        `• Layer 6+7 (Script+Claude): <code>${scanValidated}</code> confirmed`,
        ``,
        `• <b>Issues created: <code>${scanIssues}</code></b>`,
        scanSkipped.length > 0
          ? `• Skipped: ${scanSkipped.length} (${scanSkipped.slice(0, 3).join(', ')}${scanSkipped.length > 3 ? '...' : ''})`
          : '',
        ``,
        `<i>Next proactive scan in ~4 hours</i>`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } catch (err) {
    logger.warn({ err }, 'Proactive scan cycle failed (non-fatal)');
    await tg(
      `<b>🔍 Proactive Scan Failed ⚠️</b>\n<i>${String(err).slice(0, 200)}</i>\n\n<i>Will retry in ~4 hours</i>`,
    );
  }

  state.lastProactiveScan = new Date().toISOString();
  saveState(state);
}

export async function startOrchestratorLoop(
  config: OrchestratorConfig,
): Promise<never> {
  const env = readEnvFile([
    'MINIMAX_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'CC_SKILLS_PATH',
    'GITHUB_REPO',
  ]);
  const minimaxKey = process.env.MINIMAX_API_KEY || env.MINIMAX_API_KEY || '';
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '';
  const ccSkillsPath = process.env.CC_SKILLS_PATH || env.CC_SKILLS_PATH || '';

  // Resolve target GitHub repo: explicit config > env > git remote auto-detect
  targetRepo =
    config.githubRepo || process.env.GITHUB_REPO || env.GITHUB_REPO || '';
  if (!targetRepo) {
    try {
      const remote = execSync('git remote get-url origin', {
        cwd: config.repoPath,
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim();
      // Parse owner/repo from SSH or HTTPS URL
      const match = remote.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (match) targetRepo = `${match[1]}/${match[2]}`;
    } catch {
      /* ignore — will fail below */
    }
  }
  if (!targetRepo) {
    logger.fatal(
      'GITHUB_REPO not set and could not auto-detect from git remote — orchestrator cannot start',
    );
    process.exit(1);
  }
  logger.info({ githubRepo: targetRepo }, 'Target GitHub repo resolved');

  if (!minimaxKey) {
    logger.fatal('MINIMAX_API_KEY not set — orchestrator cannot start');
    process.exit(1);
  }

  const state = loadState();
  if (!state.startedAt) state.startedAt = new Date().toISOString();

  // Initialize lastCheckedCommit to current HEAD if not set
  if (!state.lastCheckedCommit) {
    state.lastCheckedCommit = getHeadCommit(config.repoPath);
    saveState(state);
    logger.info(
      { commit: state.lastCheckedCommit },
      'Orchestrator initialized at current HEAD',
    );
  }

  // Sync cc-skills on startup for latest issue templates
  if (ccSkillsPath) {
    syncCcSkills(ccSkillsPath);
    logger.info({ ccSkillsPath }, 'cc-skills path configured');
  }

  // Load false positive patterns from previously rejected issues
  syncFalsePositivePatterns();

  logger.info(
    {
      repoPath: config.repoPath,
      lastCommit: state.lastCheckedCommit.slice(0, 7),
      cycleCount: state.cycleCount,
    },
    'Orchestrator loop starting',
  );

  // Send startup notification
  if (botToken && chatId) {
    const branch = getGitBranch(config.repoPath);
    await sendTelegramNotification(
      [
        `<b>🚀 NanoClaw Orchestrator Started</b>`,
        ``,
        `• Repo: <code>opendeviationbar-py</code>`,
        `• Branch: <code>${branch}</code>`,
        `• From commit: <code>${state.lastCheckedCommit.slice(0, 7)}</code>`,
        `• Mode: continuous diff-driven (MiniMax + Claude)`,
        `• Rate limit: <code>${MAX_ISSUES_PER_HOUR}/hr</code>`,
        ``,
        `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
      ].join('\n'),
      botToken,
      chatId,
    );
  }

  // Main loop
  while (true) {
    try {
      // Heartbeat check
      const now = Date.now();
      const lastHb = state.lastHeartbeat
        ? new Date(state.lastHeartbeat).getTime()
        : 0;
      if (now - lastHb >= HEARTBEAT_INTERVAL_MS && botToken && chatId) {
        const branch = getGitBranch(config.repoPath);
        await sendTelegramNotification(
          formatHeartbeat(state, branch),
          botToken,
          chatId,
        );
        state.lastHeartbeat = new Date().toISOString();
        saveState(state);

        // Heartbeat maintenance
        if (ccSkillsPath) syncCcSkills(ccSkillsPath);
        syncFalsePositivePatterns();
        rotateLogIfNeeded();
      }

      // Step 1: git pull
      const pulled = gitPull(config.repoPath);
      if (!pulled) {
        state.consecutiveErrors++;
        saveState(state);
        const backoff = Math.min(
          CYCLE_COOLDOWN_ERROR_MS * Math.pow(2, state.consecutiveErrors - 1),
          10 * 60_000, // max 10 min
        );
        logger.warn({ backoff }, 'Backing off after git pull failure');
        await sleep(backoff);
        continue;
      }

      // Step 2: Check for changes
      const headCommit = getHeadCommit(config.repoPath);
      if (headCommit === state.lastCheckedCommit) {
        // No new commits — check if it's time for a proactive enhancement scan
        const lastScan = state.lastProactiveScan
          ? new Date(state.lastProactiveScan).getTime()
          : 0;
        if (Date.now() - lastScan >= PROACTIVE_SCAN_INTERVAL_MS && minimaxKey) {
          await runProactiveScanCycle(
            config,
            state,
            minimaxKey,
            botToken,
            chatId,
          );
        }
        await sleep(CYCLE_COOLDOWN_MS);
        continue;
      }

      const changedFiles = getChangedFiles(
        config.repoPath,
        state.lastCheckedCommit,
      );
      if (changedFiles.length === 0) {
        // Only non-code changes (docs, CI, etc.) — skip
        state.lastCheckedCommit = headCommit;
        state.cycleCount++;
        saveState(state);
        continue;
      }

      const diff = getDiff(config.repoPath, state.lastCheckedCommit);
      const commitLog = getCommitLog(config.repoPath, state.lastCheckedCommit);
      const semanticDiff = getSemanticDiffs(
        config.repoPath,
        state.lastCheckedCommit,
        changedFiles,
      );
      const astGrepFindings = runAstGrepOnFiles(config.repoPath, changedFiles);
      const openGrepFindings = runOpenGrepOnFiles(
        config.repoPath,
        changedFiles,
      );

      logger.info(
        {
          files: changedFiles.length,
          commits: commitLog.split('\n').length,
          from: state.lastCheckedCommit.slice(0, 7),
          to: headCommit.slice(0, 7),
          hasDifftastic: semanticDiff.length > 0,
          hasAstGrep: astGrepFindings.length > 0,
          hasOpenGrep: openGrepFindings.length > 0,
        },
        'Changes detected, triaging with MiniMax',
      );

      // Telegram: cycle start notification
      if (botToken && chatId) {
        await sendTelegramNotification(
          formatCycleStart(
            state.lastCheckedCommit,
            headCommit,
            changedFiles,
            state.cycleCount + 1,
          ),
          botToken,
          chatId,
        );
      }

      // Step 3: MiniMax triage
      const triage = await triageChanges(
        diff,
        commitLog,
        changedFiles,
        minimaxKey,
        config.repoPath,
        semanticDiff || undefined,
        astGrepFindings || undefined,
        openGrepFindings || undefined,
      );

      logger.info(
        { findingCount: triage.findings.length, summary: triage.summary },
        'MiniMax triage complete',
      );

      // Telegram: triage results
      if (botToken && chatId) {
        await sendTelegramNotification(
          formatTriageResult(
            triage.findings.length,
            triage.summary,
            state.cycleCount + 1,
          ),
          botToken,
          chatId,
        );
      }

      // Step 4: Validate and create issues for confirmed findings
      const cycleSkipped: string[] = [];
      let cycleValidated = 0;
      let cycleRejected = 0;
      let cycleIssues = 0;
      for (const finding of triage.findings) {
        // Rate limit check
        if (!checkRateLimit(state)) {
          logger.warn(
            { limit: MAX_ISSUES_PER_HOUR },
            'Hourly issue rate limit reached, skipping remaining findings',
          );
          cycleSkipped.push('Rate limit reached');
          break;
        }

        // Fuzzy dedup check
        if (issueExistsFuzzy(finding.title)) {
          logger.info({ title: finding.title }, 'Skipping duplicate finding');
          cycleSkipped.push(`Duplicate: ${finding.title.slice(0, 60)}`);
          continue;
        }

        // Pre-validation: run the finding's verification script
        // If the script fails, the finding is likely hallucinated — skip without wasting Claude
        const scriptCheck = verifyFindingScript(finding, config.repoPath);
        if (!scriptCheck.verified) {
          state.findingsRejected++;
          cycleRejected++;
          cycleSkipped.push(`Script fail: ${finding.title.slice(0, 60)}`);
          logger.info(
            { title: finding.title, reason: scriptCheck.output },
            'Finding failed verification script — likely hallucinated',
          );
          continue;
        }

        // Claude validation (Phase 3)
        const validation = validateWithClaude(
          finding,
          config.repoPath,
          headCommit,
        );

        if (!validation) {
          // Claude validation failed (timeout, error) — skip, don't create unvalidated issue
          logger.warn(
            { title: finding.title },
            'Skipping finding — Claude validation unavailable',
          );
          cycleSkipped.push(`Claude unavail: ${finding.title.slice(0, 60)}`);
          continue;
        }

        if (!validation.confirmed) {
          state.findingsRejected++;
          cycleRejected++;
          cycleSkipped.push(`Rejected: ${finding.title.slice(0, 60)}`);
          logger.info(
            {
              title: finding.title,
              analysis: validation.analysis.slice(0, 100),
            },
            'Finding rejected by Claude',
          );
          continue;
        }

        // Skip low-confidence validations
        if (validation.confidence === 'low') {
          state.findingsRejected++;
          cycleRejected++;
          cycleSkipped.push(`Low confidence: ${finding.title.slice(0, 60)}`);
          logger.info(
            { title: finding.title },
            'Finding has low confidence, skipping',
          );
          continue;
        }

        state.findingsValidated++;
        cycleValidated++;

        // cc-skills pattern: taxonomy-aware label suggestion via MiniMax
        const labels = await suggestLabels(finding, validation, minimaxKey);

        const issueUrl = createGitHubIssue(
          finding,
          validation,
          config.repoPath,
          headCommit,
          labels,
        );

        if (issueUrl) {
          state.issuesCreated++;
          if (!state.issueTimestamps) state.issueTimestamps = [];
          state.issueTimestamps.push(Date.now());
          cycleIssues++;
        }

        // Telegram notification per confirmed finding
        if (botToken && chatId) {
          await sendTelegramNotification(
            formatFindingNotification(finding, validation, issueUrl),
            botToken,
            chatId,
          );
        }
      }

      // Telegram: cycle summary (only when there were findings to process)
      if (triage.findings.length > 0 && botToken && chatId) {
        await sendTelegramNotification(
          formatCycleSummary(
            state.cycleCount + 1,
            triage.findings.length,
            cycleValidated,
            cycleRejected,
            cycleIssues,
            cycleSkipped,
          ),
          botToken,
          chatId,
        );
      }

      // CLAUDE.md maintenance: update project memory based on changed files
      await runClaudeMdMaintenance(
        config.repoPath,
        changedFiles,
        botToken,
        chatId,
      );

      // Advance state
      state.lastCheckedCommit = headCommit;
      state.cycleCount++;
      state.consecutiveErrors = 0;
      saveState(state);

      logger.info(
        {
          cycle: state.cycleCount,
          findings: triage.findings.length,
          validated: state.findingsValidated,
          rejected: state.findingsRejected,
          issuesTotal: state.issuesCreated,
        },
        'Cycle complete',
      );
    } catch (err) {
      state.consecutiveErrors++;
      saveState(state);

      const backoff = Math.min(
        CYCLE_COOLDOWN_ERROR_MS * Math.pow(2, state.consecutiveErrors - 1),
        10 * 60_000,
      );
      logger.error(
        { err, backoff, consecutiveErrors: state.consecutiveErrors },
        'Orchestrator cycle error',
      );

      // Alert on repeated failures
      if (state.consecutiveErrors >= 3 && botToken && chatId) {
        await sendTelegramNotification(
          [
            `<b>⚠️ NanoClaw Error Alert</b>`,
            ``,
            `Consecutive failures: <code>${state.consecutiveErrors}</code>`,
            `Next retry in: <code>${Math.round(backoff / 1000)}s</code>`,
            `Error: <code>${escapeHtml(String(err).slice(0, 200))}</code>`,
          ].join('\n'),
          botToken,
          chatId,
        );
      }

      await sleep(backoff);
      continue;
    }

    await sleep(CYCLE_COOLDOWN_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
