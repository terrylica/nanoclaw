/**
 * Single-pass static analysis triage pipeline.
 * Replaces the multi-LLM expert triage with deterministic ESLint + semgrep analysis
 * to eliminate API costs and latency while maintaining reproducible results.
 */
import { logger } from '../logger.js';
import {
  deduplicateFindings,
  extractWords,
  severityRank,
} from './minimax-client.js';
import { loadFalsePositivePatterns } from './pipeline.js';
import { runEslintOnFiles, runSemgrepOnFiles } from './static-analysis.js';
import { MAX_FINDINGS_PER_CYCLE, MIN_SEVERITY_FOR_ISSUE } from './types.js';
import type { TriageResult } from './types.js';

/**
 * Single-pass static analysis triage.
 * Runs ESLint and semgrep on changed files, deduplicates, filters by severity,
 * and applies false-positive patterns. No LLM calls — fully deterministic.
 *
 * The apiKey and context string parameters are retained for API compatibility
 * but are no longer used.
 */
export async function triageChanges(
  _diff: string,
  _commitLog: string,
  changedFiles: string[],
  _apiKey: string,
  repoPath: string,
  _semanticDiff?: string,
  _astGrepFindings?: string,
  _openGrepFindings?: string,
): Promise<TriageResult> {
  const eslintFindings = runEslintOnFiles(repoPath, changedFiles);
  const semgrepFindings = runSemgrepOnFiles(repoPath, changedFiles);

  const allFindings = [...eslintFindings, ...semgrepFindings];

  logger.info(
    { eslint: eslintFindings.length, semgrep: semgrepFindings.length },
    'Static analysis triage complete',
  );

  if (allFindings.length === 0) {
    return {
      findings: [],
      summary: `static-analysis: 0 eslint + 0 semgrep findings`,
    };
  }

  const deduped = deduplicateFindings(allFindings);
  const fpPatterns = loadFalsePositivePatterns();

  const filtered = deduped
    .filter(
      (f) => severityRank(f.severity) >= severityRank(MIN_SEVERITY_FOR_ISSUE),
    )
    .filter((f) => {
      if (fpPatterns.length === 0) return true;
      return !fpPatterns.some((pattern) => {
        const patternWords = extractWords(pattern);
        const findingWords = extractWords(f.title + ' ' + f.description);
        const intersection = findingWords.filter((w) =>
          patternWords.includes(w),
        );
        const union = new Set([...findingWords, ...patternWords]);
        return union.size > 0 && intersection.length / union.size >= 0.35;
      });
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, MAX_FINDINGS_PER_CYCLE);

  return {
    findings: filtered,
    summary: `static-analysis: ${eslintFindings.length} eslint + ${semgrepFindings.length} semgrep → ${deduped.length} deduped → ${filtered.length} after severity/fp filter`,
  };
}
