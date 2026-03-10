/**
 * Goal execution orchestrator — worktree isolation + multi-gate validation.
 *
 * Lifecycle:
 * 1. Create git worktree (isolated from main)
 * 2. Claude Code implements the fix in the worktree
 * 3. Run validation pipeline (protected files → build → test → MiniMax review)
 * 4. If all gates pass: commit in worktree → merge to main
 * 5. Cleanup worktree regardless of outcome
 *
 * Observability: every step is logged with timing and context for debugging.
 */
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { logger } from '../../logger.js';
import { notify } from '../telegram.js';
import {
  type EvolutionAction,
  type EvolutionState,
  type UserGoal,
  createAction,
  updateAction,
  recordSuccess,
} from './state.js';
import {
  createWorktree,
  getWorktreeChanges,
  getWorktreeDiff,
  commitInWorktree,
  mergeToMain,
  cleanupWorktree,
} from './goal-worktree.js';
import { runValidationPipeline } from './goal-validator.js';
import type { GateResult } from './goal-validator.js';

// --- Constants ---

const CLAUDE_BIN = path.join(
  process.env.HOME || '/Users/terryli',
  '.local/bin/claude',
);
const GOAL_BUDGET_USD = 2.0;
const GOAL_TIMEOUT_MS = 300_000; // 5 min
const SELF_REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

// --- Types ---

export interface GoalExecutionResult {
  action: EvolutionAction;
  /** Claude Code output (truncated for observability) */
  claudeOutput: string;
  /** Validation gate results */
  gates: GateResult[];
  /** Worktree path used (for debugging) */
  worktreePath: string | null;
  /** Whether the goal produced changes */
  hadChanges: boolean;
}

// --- Executor ---

/**
 * Execute a single goal in an isolated worktree.
 *
 * Returns the result regardless of success/failure for full observability.
 * The caller is responsible for removing the goal from the queue.
 */
export async function executeGoal(
  goal: UserGoal,
  evoState: EvolutionState,
  apiKey: string,
): Promise<GoalExecutionResult> {
  const action = createAction('goal-fix', goal.text.slice(0, 100));
  updateAction(action, 'executing');

  const result: GoalExecutionResult = {
    action,
    claudeOutput: '',
    gates: [],
    worktreePath: null,
    hadChanges: false,
  };

  let worktreePath: string | null = null;
  let branch: string | null = null;

  try {
    // Step 1: Create isolated worktree
    const startWorktree = Date.now();
    const wt = createWorktree(action.id, SELF_REPO);
    worktreePath = wt.worktreePath;
    branch = wt.branch;
    result.worktreePath = worktreePath;

    logger.info(
      {
        goalId: action.id,
        goalText: goal.text.slice(0, 80),
        worktreePath,
        worktreeMs: Date.now() - startWorktree,
      },
      'Goal execution starting in worktree',
    );

    // Step 2: Run Claude Code in the worktree
    const startClaude = Date.now();
    const prompt = [
      `You are fixing a code issue in NanoClaw, a TypeScript/Bun project.`,
      ``,
      `Issue: ${goal.text}`,
      ``,
      `Instructions:`,
      `- Make the minimal change needed to fix this issue`,
      `- Do NOT modify these protected files:`,
      `  - src/orchestrator/evolution/engine.ts`,
      `  - src/orchestrator/evolution/validator.ts`,
      `  - src/orchestrator/evolution/state.ts`,
      `- Do NOT run bun install or modify node_modules/package.json/bun.lock`,
      `- Ensure the fix compiles (TypeScript strict mode)`,
      `- If the issue is already fixed or not applicable, make no changes`,
    ].join('\n');

    const claudeResult = spawnSync(
      CLAUDE_BIN,
      [
        '-p',
        '--allowedTools',
        'Read,Edit,Write,Bash,Glob,Grep',
        '--max-budget-usd',
        String(GOAL_BUDGET_USD),
        '--output-format',
        'text',
      ],
      {
        input: prompt,
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: GOAL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const claudeOutput = (claudeResult.stdout || '').trim();
    const claudeError = claudeResult.error || claudeResult.status !== 0;
    result.claudeOutput = claudeOutput.slice(0, 2000);

    logger.info(
      {
        goalId: action.id,
        claudeMs: Date.now() - startClaude,
        outputLen: claudeOutput.length,
        hadError: claudeError,
        exitCode: claudeResult.status,
      },
      'Claude Code execution complete',
    );

    // Step 3: Check for changes
    const changedFiles = getWorktreeChanges(worktreePath);
    result.hadChanges = changedFiles.length > 0;

    if (changedFiles.length === 0) {
      updateAction(action, 'committed', {
        result: `No changes needed: ${claudeOutput.slice(0, 200)}`,
      });
      recordSuccess(evoState);
      logger.info({ goalId: action.id }, 'Goal produced no changes');
      return result;
    }

    logger.info(
      { goalId: action.id, files: changedFiles },
      'Goal produced changes, running validation pipeline',
    );

    // Step 4: Run validation pipeline (4 gates)
    const diff = getWorktreeDiff(worktreePath);
    const validation = await runValidationPipeline(
      worktreePath,
      changedFiles,
      diff,
      goal.text,
      apiKey,
    );
    result.gates = validation.gates;

    if (!validation.passed) {
      updateAction(action, 'failed', {
        result: `Validation failed at gate '${validation.failedGate}': ${
          validation.gates.find((g) => !g.passed)?.detail.slice(0, 200) ||
          'unknown'
        }`,
      });

      await notify(
        [
          `<b>❌ Goal Validation Failed</b>`,
          `<code>[${action.id}]</code>`,
          ``,
          `<i>${goal.text.slice(0, 150)}</i>`,
          ``,
          `Failed gate: <code>${validation.failedGate}</code>`,
          ``,
          ...validation.gates.map(
            (g) =>
              `${g.passed ? '✅' : '❌'} <code>${g.gate}</code> (${g.durationMs}ms) — ${g.detail.slice(0, 80)}`,
          ),
        ].join('\n'),
      );

      return result;
    }

    // Step 5: Commit in worktree
    const commitMsg = `evolution(goal-fix): ${goal.text.slice(0, 100)}`;
    const commitResult = commitInWorktree(worktreePath, commitMsg);

    if (!commitResult) {
      updateAction(action, 'failed', {
        result: 'Commit in worktree failed (no staged changes)',
      });
      return result;
    }

    // Step 6: Merge to main
    const mergeHash = mergeToMain(branch, SELF_REPO);

    if (!mergeHash) {
      updateAction(action, 'failed', {
        result: 'Fast-forward merge to main failed — main may have diverged',
      });

      await notify(
        [
          `<b>⚠️ Goal Merge Failed</b>`,
          `<code>[${action.id}]</code>`,
          ``,
          `<i>${goal.text.slice(0, 150)}</i>`,
          ``,
          `Goal changes committed in worktree but merge to main failed.`,
          `Branch: <code>${branch}</code>`,
          `Worktree commit: <code>${commitResult.hash.slice(0, 7)}</code>`,
        ].join('\n'),
      );

      return result;
    }

    // Success!
    updateAction(action, 'committed', {
      commitHash: mergeHash,
      result: `Fixed: ${claudeOutput.slice(0, 200)}`,
    });
    recordSuccess(evoState);

    const gatesSummary = validation.gates
      .map((g) => `${g.gate}:${g.durationMs}ms`)
      .join(', ');

    await notify(
      [
        `<b>🔧 Goal Fix Committed</b>`,
        `<code>[${action.id}]</code>`,
        ``,
        `<i>${goal.text.slice(0, 200)}</i>`,
        ``,
        `Commit: <code>${mergeHash.slice(0, 7)}</code>`,
        `Files: ${commitResult.files.map((f) => `<code>${f}</code>`).join(', ')}`,
        `Gates: <code>${gatesSummary}</code>`,
      ].join('\n'),
    );

    return result;
  } catch (err) {
    updateAction(action, 'failed', { result: String(err).slice(0, 200) });
    logger.error(
      { err, goalId: action.id, goalText: goal.text.slice(0, 80) },
      'Goal execution failed with exception',
    );
    return result;
  } finally {
    // Always cleanup worktree
    if (worktreePath && branch) {
      cleanupWorktree(worktreePath, branch, SELF_REPO);
    }

    // Guard: if node_modules in main repo became a symlink (Claude Code in worktree
    // can corrupt it via bun install), restore it immediately
    try {
      const nmPath = path.join(SELF_REPO, 'node_modules');
      const stat = fs.lstatSync(nmPath);
      if (stat.isSymbolicLink()) {
        logger.warn('node_modules is a symlink — removing and reinstalling');
        fs.rmSync(nmPath, { force: true });
        execSync('bun install', {
          cwd: SELF_REPO,
          timeout: 120_000,
          env: { ...process.env, MISE_NO_CONFIG: '1' },
        });
      }
    } catch {
      /* node_modules doesn't exist or check failed — non-fatal */
    }
  }
}
