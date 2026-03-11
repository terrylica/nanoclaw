/**
 * Git safety net for evolution actions.
 *
 * Commit-per-change pattern (Aider model):
 * - Every evolution action = 1 atomic commit
 * - Full audit trail in git log + evolution-actions.ndjson
 * - Revert any commit with a single command
 */
import { execFileSync, execSync } from 'child_process';

import { logger } from '../../logger.js';
import type { EvolutionAction } from './state.js';

/** Commit evolution changes atomically */
export function commitEvolution(
  action: EvolutionAction,
  files: string[],
  repoPath: string,
): string | null {
  try {
    // Stage specific files
    for (const file of files) {
      execSync(`git add "${file}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    }

    // Check if there are actually staged changes
    const status = execSync('git diff --cached --stat', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();

    if (!status) {
      logger.info({ actionId: action.id }, 'No staged changes to commit');
      return null;
    }

    // Create commit with evolution prefix
    const message = `evolution(${action.type}): ${action.description}`;
    execFileSync('git', ['commit', '-m', message], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    });

    // Get the commit hash
    const hash = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();

    logger.info(
      { actionId: action.id, hash: hash.slice(0, 7), files },
      'Evolution commit created',
    );

    return hash;
  } catch (err) {
    logger.error(
      { err, actionId: action.id, files },
      'Failed to commit evolution changes',
    );
    // Reset staged changes on failure
    try {
      execSync('git reset HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch {
      // ignore reset failure
    }
    return null;
  }
}

/** Revert an evolution commit */
export function revertEvolution(hash: string, repoPath: string): string | null {
  try {
    execSync(`git revert --no-edit ${hash}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    });

    const revertHash = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();

    logger.info(
      { originalHash: hash.slice(0, 7), revertHash: revertHash.slice(0, 7) },
      'Evolution commit reverted',
    );

    return revertHash;
  } catch (err) {
    logger.error({ err, hash }, 'Failed to revert evolution commit');
    // Abort revert if it left us in a conflict state
    try {
      execSync('git revert --abort', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch {
      // ignore
    }
    return null;
  }
}

/** Generate a revert commit hash for safety net (dry-run check) */
export function canRevert(hash: string, repoPath: string): boolean {
  try {
    // Check if the commit exists and is revertable
    execSync(`git cat-file -t ${hash}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}
