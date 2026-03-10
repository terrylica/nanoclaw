/**
 * Git worktree lifecycle for isolated goal execution.
 *
 * Each goal runs in a temporary worktree so failed goals leave no trace on main.
 * Flow: create worktree → Claude Code runs → commit in worktree → merge to main → cleanup.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../../logger.js';

// --- Types ---

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Branch name (goal/<id>) */
  branch: string;
}

export interface WorktreeCommitResult {
  /** Commit hash */
  hash: string;
  /** Files included in the commit */
  files: string[];
}

// --- Constants ---

const WORKTREE_PREFIX = 'nanoclaw-goal-';

// --- Worktree Lifecycle ---

/** Create an isolated git worktree for a goal. Returns path and branch name. */
export function createWorktree(goalId: string, repoPath: string): WorktreeInfo {
  const branch = `goal/${goalId}`;
  const worktreePath = path.join(os.tmpdir(), `${WORKTREE_PREFIX}${goalId}`);

  // Clean up if leftover from a previous crash
  if (fs.existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: repoPath,
        timeout: 30_000,
      });
    } catch {
      // Force remove directory if git worktree remove fails
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Delete stale branch if it exists
  try {
    execSync(`git branch -D "${branch}" 2>/dev/null`, {
      cwd: repoPath,
      timeout: 10_000,
    });
  } catch {
    /* branch doesn't exist — fine */
  }

  // Create worktree branching from HEAD
  execSync(`git worktree add "${worktreePath}" -b "${branch}" HEAD`, {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: 60_000,
  });

  logger.info({ goalId, worktreePath, branch }, 'Created goal worktree');

  return { worktreePath, branch };
}

/** Get the list of changed files in a worktree (staged + unstaged + untracked). */
export function getWorktreeChanges(worktreePath: string): string[] {
  const modified = execSync('git diff --name-only HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();

  const untracked = execSync('git ls-files --others --exclude-standard', {
    cwd: worktreePath,
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();

  return [...modified.split('\n'), ...untracked.split('\n')]
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/** Get the full diff in a worktree (for code review). */
export function getWorktreeDiff(worktreePath: string): string {
  // Staged + unstaged diff
  const diff = execSync('git diff HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();

  // Include untracked files content
  const untracked = execSync('git ls-files --others --exclude-standard', {
    cwd: worktreePath,
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();

  if (!untracked) return diff;

  const untrackedDiffs: string[] = [];
  for (const file of untracked.split('\n').filter(Boolean)) {
    try {
      const content = fs.readFileSync(path.join(worktreePath, file), 'utf-8');
      untrackedDiffs.push(
        `--- /dev/null\n+++ b/${file}\n${content
          .split('\n')
          .map((l) => `+${l}`)
          .join('\n')}`,
      );
    } catch {
      /* skip unreadable files */
    }
  }

  return [diff, ...untrackedDiffs].filter(Boolean).join('\n');
}

/** Commit all changes in the worktree. Returns commit hash and files, or null if no changes. */
export function commitInWorktree(
  worktreePath: string,
  message: string,
): WorktreeCommitResult | null {
  const files = getWorktreeChanges(worktreePath);
  if (files.length === 0) return null;

  // Stage everything
  execSync('git add -A', {
    cwd: worktreePath,
    timeout: 30_000,
  });

  // Commit
  execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
    cwd: worktreePath,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  const hash = execSync('git rev-parse HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();

  logger.info(
    { hash: hash.slice(0, 7), files: files.length },
    'Committed in goal worktree',
  );

  return { hash, files };
}

/**
 * Merge a goal branch into main via fast-forward.
 * Returns the merge commit hash, or null if merge failed.
 */
export function mergeToMain(branch: string, repoPath: string): string | null {
  try {
    execSync(`git merge "${branch}" --ff-only`, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    });

    const hash = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();

    logger.info(
      { branch, hash: hash.slice(0, 7) },
      'Goal branch merged to main',
    );

    return hash;
  } catch (err) {
    logger.warn(
      { err, branch },
      'Fast-forward merge failed — main may have diverged',
    );
    // Abort merge if it left us in a conflict state
    try {
      execSync('git merge --abort', {
        cwd: repoPath,
        timeout: 10_000,
      });
    } catch {
      /* no merge in progress */
    }
    return null;
  }
}

/** Clean up a goal worktree and its branch. */
export function cleanupWorktree(
  worktreePath: string,
  branch: string,
  repoPath: string,
): void {
  // Remove worktree
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: repoPath,
      timeout: 30_000,
    });
  } catch {
    // Fallback: force remove directory
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      execSync('git worktree prune', { cwd: repoPath, timeout: 10_000 });
    } catch {
      /* best effort */
    }
  }

  // Delete branch
  try {
    execSync(`git branch -D "${branch}"`, {
      cwd: repoPath,
      timeout: 10_000,
    });
  } catch {
    /* branch already deleted or doesn't exist */
  }

  logger.debug({ worktreePath, branch }, 'Goal worktree cleaned up');
}

/** Clean up any stale goal worktrees (crash recovery). */
export function cleanupStaleWorktrees(repoPath: string): number {
  let cleaned = 0;
  try {
    const tmpDir = os.tmpdir();
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith(WORKTREE_PREFIX)) {
        const fullPath = path.join(tmpDir, entry);
        const goalId = entry.replace(WORKTREE_PREFIX, '');
        cleanupWorktree(fullPath, `goal/${goalId}`, repoPath);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale goal worktrees');
    }
  } catch {
    /* best effort */
  }
  return cleaned;
}
