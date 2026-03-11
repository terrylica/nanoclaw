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
  OPENGREP_BINARY,
} from './types.js';

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
