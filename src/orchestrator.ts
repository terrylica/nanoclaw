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
const CYCLE_COOLDOWN_MS = 30_000; // 30s between cycles when no changes
const CYCLE_COOLDOWN_ERROR_MS = 60_000; // 60s after errors
const STATE_FILE = path.join(DATA_DIR, 'orchestrator-state.json');

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

// --- Types ---

interface OrchestratorState {
  lastCheckedCommit: string;
  cycleCount: number;
  issuesCreated: number;
  issuesCreatedThisHour: number;
  hourWindow: string; // ISO timestamp of current hour window
  lastHeartbeat: string;
  startedAt: string;
  consecutiveErrors: number;
  findingsValidated: number;
  findingsRejected: number;
}

interface Finding {
  type: 'bug' | 'performance-regression' | 'test-gap' | 'daemon-behavior';
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
      const newContent = keepFrom > 0
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

/** Check and update hourly rate limit window */
function checkRateLimit(state: OrchestratorState): boolean {
  const currentHour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  if (state.hourWindow !== currentHour) {
    state.hourWindow = currentHour;
    state.issuesCreatedThisHour = 0;
  }
  return state.issuesCreatedThisHour < MAX_ISSUES_PER_HOUR;
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

function buildTriagePrompt(
  diff: string,
  commitLog: string,
  changedFiles: string[],
  repoPath: string,
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
${sourceContext.slice(0, 60_000)}

DIFF (what changed):
${diff.slice(0, 30_000)}

IMPORTANT: Before reporting a finding, verify it against the FULL SOURCE CODE above.
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
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(diff, commitLog, changedFiles, repoPath);

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

    // If consensus returned findings, use those. Otherwise keep originals
    // (don't let a parse failure drop everything)
    if (raw.trim().startsWith('[')) {
      return consensusFindings;
    }
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

    if (raw.trim().startsWith('[')) {
      return survivingFindings;
    }
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
      'gh issue list --repo terrylica/opendeviationbar-py --label nanoclaw --state closed --json title,state --limit 50',
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
    return { verified: true, output: 'Command not verifiable (not in allowlist)' };
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
    return { verified: false, output: `Command failed: ${String(err).slice(0, 200)}` };
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

    const validation: ValidationResult = JSON.parse(jsonStr);

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
    // Fetch all open nanoclaw issues
    const result = execSync(
      `gh issue list --repo terrylica/opendeviationbar-py --label nanoclaw --state open --limit 50 --json title`,
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
function syncCcSkills(ccSkillsPath: string): void {
  if (!ccSkillsPath || !fs.existsSync(ccSkillsPath)) return;
  try {
    execSync('git pull --ff-only origin main 2>&1', {
      cwd: ccSkillsPath,
      timeout: 15_000,
      encoding: 'utf-8',
    });
    logger.info({ path: ccSkillsPath }, 'cc-skills synced');
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
      'gh label list --repo terrylica/opendeviationbar-py --json name --limit 100',
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
    const prompt = `Suggest 2-4 labels from the EXISTING taxonomy only for this code finding.
Never suggest labels that don't exist in the list below.
Return ONLY a JSON array of label names, nothing else.

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
      `gh issue list --repo terrylica/opendeviationbar-py --search "${searchTerms.replace(/"/g, '\\"')}" --state all --limit 5 --json number,title,url`,
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
      `gh issue create --repo terrylica/opendeviationbar-py --title "${title.replace(/"/g, '\\"')}" --label "${labelStr}" --body-file "${tmpFile}"`,
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Main Loop ---

export interface OrchestratorConfig {
  repoPath: string; // Path to opendeviationbar-py clone
}

export async function startOrchestratorLoop(
  config: OrchestratorConfig,
): Promise<never> {
  const env = readEnvFile([
    'MINIMAX_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'CC_SKILLS_PATH',
  ]);
  const minimaxKey = process.env.MINIMAX_API_KEY || env.MINIMAX_API_KEY || '';
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '';
  const ccSkillsPath = process.env.CC_SKILLS_PATH || env.CC_SKILLS_PATH || '';

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

      logger.info(
        {
          files: changedFiles.length,
          commits: commitLog.split('\n').length,
          from: state.lastCheckedCommit.slice(0, 7),
          to: headCommit.slice(0, 7),
        },
        'Changes detected, triaging with MiniMax',
      );

      // Step 3: MiniMax triage
      const triage = await triageChanges(
        diff,
        commitLog,
        changedFiles,
        minimaxKey,
        config.repoPath,
      );

      logger.info(
        { findingCount: triage.findings.length, summary: triage.summary },
        'MiniMax triage complete',
      );

      // Step 4: Validate and create issues for confirmed findings
      for (const finding of triage.findings) {
        // Rate limit check
        if (!checkRateLimit(state)) {
          logger.warn(
            { limit: MAX_ISSUES_PER_HOUR },
            'Hourly issue rate limit reached, skipping remaining findings',
          );
          break;
        }

        // Fuzzy dedup check
        if (issueExistsFuzzy(finding.title)) {
          logger.info({ title: finding.title }, 'Skipping duplicate finding');
          continue;
        }

        // Pre-validation: run the finding's verification script
        // If the script fails, the finding is likely hallucinated — skip without wasting Claude
        const scriptCheck = verifyFindingScript(finding, config.repoPath);
        if (!scriptCheck.verified) {
          state.findingsRejected++;
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
          continue;
        }

        if (!validation.confirmed) {
          state.findingsRejected++;
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
          logger.info(
            { title: finding.title },
            'Finding has low confidence, skipping',
          );
          continue;
        }

        state.findingsValidated++;

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
          state.issuesCreatedThisHour++;
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
