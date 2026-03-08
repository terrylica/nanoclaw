/**
 * Multi-perspective MiniMax triage: expert perspectives, prompt building,
 * and aggregate triage pipeline.
 */
import { logger } from '../logger.js';
import { readRepoFile } from './git-ops.js';
import {
  deduplicateFindings,
  extractWords,
  parseMiniMaxFindings,
  queryMiniMax,
  severityRank,
} from './minimax-client.js';
import { loadFalsePositivePatterns } from './pipeline.js';
import { MAX_FINDINGS_PER_CYCLE, MIN_SEVERITY_FOR_ISSUE } from './types.js';
import type {
  ExpertPerspective,
  Finding,
  TriageResult,
} from './types.js';

// --- Expert Perspectives ---

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

export const EXPERT_PERSPECTIVES: ExpertPerspective[] = [
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

export function buildTriagePrompt(
  diff: string,
  commitLog: string,
  changedFiles: string[],
  repoPath: string,
  semanticDiff?: string,
  astGrepFindings?: string,
  openGrepFindings?: string,
): string {
  const sourceContext = changedFiles
    .slice(0, 5)
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
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

/**
 * Multi-perspective MiniMax triage.
 * Runs 5 expert perspectives in parallel, aggregates findings,
 * deduplicates, filters by severity, and returns the top findings.
 */
export async function triageChanges(
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

  const deduped = deduplicateFindings(allFindings);

  const filtered = deduped
    .filter((f) => {
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

  if (filtered.length > 0) {
    const fpPatterns = loadFalsePositivePatterns();

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

    const { runConsensusRound, runDevilsAdvocateRound } = await import(
      './pipeline.js'
    );

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
