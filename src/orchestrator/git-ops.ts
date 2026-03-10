/**
 * Git operations and file reading for the orchestrator.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

export function gitPull(repoPath: string): boolean {
  try {
    execSync('git pull --ff-only origin main 2>&1', {
      cwd: repoPath,
      timeout: 120_000,
      encoding: 'utf-8',
    });
    return true;
  } catch (err) {
    logger.error({ err }, 'git pull failed');
    return false;
  }
}

export function getHeadCommit(repoPath: string): string {
  return execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8',
  }).trim();
}

export function getGitBranch(repoPath: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
  } catch (err) {
    logger.warn({ err }, 'git branch --show-current failed, returning unknown');
    return 'unknown';
  }
}

export function getDiff(repoPath: string, sinceCommit: string): string {
  try {
    return execSync(
      `git diff ${sinceCommit}..HEAD --stat --unified=5 -- '*.ts' '*.json' '*.yaml' '*.yml'`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 },
    );
  } catch (err) {
    logger.error({ err }, 'git diff failed');
    return '';
  }
}

export function getChangedFiles(
  repoPath: string,
  sinceCommit: string,
): string[] {
  try {
    const output = execSync(
      `git diff ${sinceCommit}..HEAD --name-only -- '*.ts' '*.json' '*.yaml' '*.yml'`,
      { cwd: repoPath, encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch (err) {
    logger.error({ err }, 'git diff --name-only failed');
    return [];
  }
}

export function getCommitLog(repoPath: string, sinceCommit: string): string {
  try {
    return execSync(`git log ${sinceCommit}..HEAD --oneline --no-merges`, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (err) {
    logger.error({ err }, 'git log failed');
    return '';
  }
}

/** Read file content from the repo for validation context */
export function readRepoFile(repoPath: string, filePath: string): string {
  try {
    const fullPath = path.join(repoPath, filePath);
    return fs.readFileSync(fullPath, 'utf-8');
  } catch (err) {
    logger.error({ err, filePath }, 'readRepoFile failed');
    return '';
  }
}

/**
 * Get all scannable source files in the repo, sorted by size (largest first).
 */
export function getScannableFiles(repoPath: string): string[] {
  try {
    const output = execSync(
      `find . -name '*.ts' -not -name '*.test.ts' -not -name '*.d.ts' | grep -v node_modules/ | grep -v dist/ | grep -v .git/`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );
    const files = output.trim().split('\n').filter(Boolean);
    return files.sort((a, b) => {
      try {
        const sA = fs.statSync(path.join(repoPath, a)).size;
        const sB = fs.statSync(path.join(repoPath, b)).size;
        return sB - sA;
      } catch (err) {
        logger.warn({ err }, 'statSync failed during file sort');
        return 0;
      }
    });
  } catch (err) {
    logger.error({ err }, 'getScannableFiles failed');
    return [];
  }
}
