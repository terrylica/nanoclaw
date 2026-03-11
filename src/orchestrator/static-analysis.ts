/**
 * Static analysis integrations: difftastic, ast-grep, OpenGrep.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { notify } from './telegram.js';
import {
  AST_GREP_BINARY,
  AST_GREP_RULES_DIR,
  DIFFT_BINARY,
  ESLINT_BINARY,
  OPENGREP_BINARY,
  SEMGREP_BINARY,
} from './types.js';
import type { Finding } from './types.js';

/**
 * Get AST-aware semantic diff via difftastic for a single file.
 * Returns a human-readable summary of structural changes, or null on failure.
 */
function getSemanticDiffForFile(
  repoPath: string,
  sinceCommit: string,
  filePath: string,
): string | null {
  try {
    if (!fs.existsSync(DIFFT_BINARY)) return null;

    const gitShow = spawnSync('git', ['show', `${sinceCommit}:${filePath}`], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (gitShow.status !== 0) return null;
    const oldContent = gitShow.stdout;

    const newPath = path.join(repoPath, filePath);
    if (!fs.existsSync(newPath)) return null;

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
        { encoding: 'utf-8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      );
      if (result.status !== null && result.status <= 1 && result.stdout) {
        return `--- ${filePath} (semantic diff) ---\n${result.stdout.slice(0, 8_000)}`;
      }
      return null;
    } finally {
      try {
        fs.unlinkSync(tmpOld);
      } catch (err) {
        logger.debug({ err, tmpOld }, 'Failed to remove difftastic temp file');
      }
    }
  } catch (err) {
    logger.debug({ err, filePath }, 'difftastic semantic diff failed');
    return null;
  }
}

/**
 * Get semantic diffs for all changed files. Returns blended context string.
 */
export function getSemanticDiffs(
  repoPath: string,
  sinceCommit: string,
  changedFiles: string[],
): string {
  if (!fs.existsSync(DIFFT_BINARY)) return '';

  const diffs = changedFiles
    .slice(0, 5)
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
 */
export function runAstGrepOnFiles(
  repoPath: string,
  changedFiles: string[],
): string {
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
          { encoding: 'utf-8', timeout: 30_000, maxBuffer: 512 * 1024 },
        );
        if (result.stdout && result.stdout.trim()) {
          allFindings.push(result.stdout.trim());
        }
      } catch (err) {
        logger.debug({ err, file }, 'ast-grep scan failed for file');
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
 */
export function runOpenGrepOnFiles(
  repoPath: string,
  changedFiles: string[],
): string {
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

    try {
      const parsed = JSON.parse(output);
      const results = parsed.results || [];
      if (results.length === 0) return '';

      const formatted = results
        .slice(0, 20)
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
    } catch (err) {
      logger.debug({ err }, 'OpenGrep JSON parse failed, returning raw output');
      return output.slice(0, 5_000);
    }
  } catch (err) {
    logger.info('OpenGrep scan failed (non-fatal)');
    notify(
      `<b>⚠️ OpenGrep SAST Failed</b>\n\nSecurity scanning unavailable this cycle.`,
    ).catch((notifyErr: unknown) => {
      logger.warn({ err: notifyErr }, 'OpenGrep notification failed');
    });
    return '';
  }
}

/**
 * Run ESLint on changed TypeScript/JavaScript files.
 * Returns structured Finding[] for direct use in the triage pipeline.
 * Gracefully skips if ESLint is not available or no config is present.
 */
export function runEslintOnFiles(
  repoPath: string,
  changedFiles: string[],
): Finding[] {
  // Prefer project-local eslint, fall back to env var / system eslint
  const localEslint = path.join(repoPath, 'node_modules/.bin/eslint');
  const eslintBin = fs.existsSync(localEslint)
    ? localEslint
    : ESLINT_BINARY;

  // Only run if ESLint has a config in the repo (avoids noisy no-config runs)
  const hasConfig = [
    'eslint.config.js',
    'eslint.config.mjs',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    '.eslintrc',
  ].some((f) => fs.existsSync(path.join(repoPath, f)));

  if (!hasConfig) {
    logger.info({ repoPath }, 'No ESLint config found, skipping ESLint scan');
    return [];
  }

  const targetFiles = changedFiles
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
    .slice(0, 20)
    .map((f) => path.join(repoPath, f))
    .filter((f) => fs.existsSync(f));

  if (targetFiles.length === 0) return [];

  try {
    const result = spawnSync(eslintBin, ['--format', 'json', ...targetFiles], {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      cwd: repoPath,
    });

    // ESLint exits 1 when lint errors are found — still parse stdout
    const output = result.stdout?.trim();
    if (!output) return [];

    const parsed = JSON.parse(output) as Array<{
      filePath: string;
      messages: Array<{
        ruleId: string | null;
        message: string;
        severity: number; // 1=warn, 2=error
        line: number;
      }>;
    }>;

    const findings: Finding[] = [];
    for (const file of parsed) {
      const relPath = path.relative(repoPath, file.filePath);
      for (const msg of file.messages) {
        if (msg.severity < 2) continue; // skip warnings, only errors
        findings.push({
          type: 'bug',
          severity: 'medium',
          confidence: 5,
          title: `ESLint: ${msg.ruleId ?? 'lint-error'} in ${path.basename(relPath)}`,
          description: `${msg.message} (${relPath}:${msg.line})`,
          files: [relPath],
          validation: `grep -n "" "${relPath}" | head -${msg.line + 3} | tail -6`,
        });
      }
    }

    if (findings.length > 0) {
      logger.info(
        { count: findings.length, files: targetFiles.length },
        'ESLint findings detected',
      );
    }
    return findings;
  } catch (err) {
    logger.debug({ err }, 'ESLint run failed (non-fatal)');
    return [];
  }
}

/**
 * Run semgrep SAST on changed files.
 * Returns structured Finding[] for direct use in the triage pipeline.
 * Gracefully skips if semgrep is not available.
 */
export function runSemgrepOnFiles(
  repoPath: string,
  changedFiles: string[],
): Finding[] {
  // Verify semgrep is available
  const versionCheck = spawnSync(SEMGREP_BINARY, ['--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (versionCheck.error || versionCheck.status !== 0) {
    logger.info({ binary: SEMGREP_BINARY }, 'semgrep binary not available, skipping');
    return [];
  }

  const targetFiles = changedFiles
    .slice(0, 20)
    .map((f) => path.join(repoPath, f))
    .filter((f) => fs.existsSync(f));

  if (targetFiles.length === 0) return [];

  try {
    const result = spawnSync(
      SEMGREP_BINARY,
      ['scan', '--config=auto', '--json', '--quiet', ...targetFiles],
      {
        encoding: 'utf-8',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        cwd: repoPath,
      },
    );

    const output = result.stdout?.trim();
    if (!output) return [];

    const parsed = JSON.parse(output) as {
      results?: Array<{
        check_id: string;
        path: string;
        start: { line: number };
        extra: { message: string; severity: string };
      }>;
    };
    const results = parsed.results ?? [];
    if (results.length === 0) return [];

    const findings: Finding[] = results.slice(0, 20).map((r) => {
      const sev = r.extra?.severity?.toLowerCase();
      const severity: Finding['severity'] =
        sev === 'error' ? 'high' : sev === 'warning' ? 'medium' : 'low';
      const relPath = path.relative(repoPath, r.path);
      const ruleShort = r.check_id.split('.').pop() ?? r.check_id;
      return {
        type: 'bug',
        severity,
        confidence: 5,
        title: `semgrep: ${ruleShort} in ${path.basename(r.path)}`,
        description: `${r.extra?.message ?? ''} (${relPath}:${r.start?.line})`,
        files: [relPath],
        validation: `grep -n "" "${relPath}" | head -${r.start.line + 3} | tail -6`,
      };
    });

    logger.info(
      { count: findings.length, files: targetFiles.length },
      'semgrep findings detected',
    );
    return findings;
  } catch (err) {
    logger.debug({ err }, 'semgrep run failed (non-fatal)');
    return [];
  }
}
