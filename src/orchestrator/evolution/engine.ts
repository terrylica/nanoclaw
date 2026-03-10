/**
 * Core evolution engine — the heart of NanoClaw's self-evolution.
 *
 * GEP-inspired cycle: Scan -> Diagnose -> Mutate -> Validate -> Commit
 *
 * Priority-ordered evolution loop (runs during idle periods):
 * 1. Issue Landscape Check
 * 2. Prompt Refinement
 * 3. Rule Expansion
 * 4. Pattern Crystallization (5+ occurrences -> specialized skill)
 * 5. Capability Gap Analysis
 * 6. Research (web channels)
 * 7. Self-Validate -> Execute -> Git Commit -> Telegram Notify
 *
 * PROTECTED: This file is never self-modifiable by the evolution engine.
 */
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { logger } from '../../logger.js';
import { queryMiniMax } from '../minimax-client.js';
import { runAgenticSweep } from '../scanning.js';
import type { OrchestratorConfig, OrchestratorState } from '../types.js';
import { notify } from '../telegram.js';
import { commitEvolution } from './git-safety.js';
import { checkIssueLandscape } from './issue-tracker.js';
import { evolveWorstPrompt } from './prompt-evolver.js';
import { loadAllPrompts, getMetrics } from './prompt-registry.js';
import { runResearchCycle } from './research.js';
import { canCallMiniMax } from './rpm-tracker.js';
import { fetchAllCommunityRules, countCommunityRules } from './rule-fetcher.js';
import {
  type EvolutionAction,
  type EvolutionState,
  type UserGoal,
  createAction,
  updateAction,
  isEvolutionPaused,
  recordFailure,
  recordSuccess,
  saveEvolutionState,
  getPatternsByTemperature,
} from './state.js';
import { pollCallbacks } from './telegram-feedback.js';
import {
  formatEvolutionAction,
  formatStagnationAlert,
  formatPromptEvolution,
} from './telegram-presenter.js';
import { validateAction } from './validator.js';

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

// --- Evolution Steps ---

/** Step 1: Issue Landscape Check */
async function stepIssueLandscape(
  config: OrchestratorConfig,
  apiKey: string,
): Promise<EvolutionAction | null> {
  if (!config.githubRepo) return null;

  const action = createAction('issue-landscape', 'Check open issue relevance');

  try {
    updateAction(action, 'executing');
    const result = await checkIssueLandscape(config.githubRepo, apiKey);
    updateAction(action, 'committed', {
      result: `Checked ${result.checked} issues: ${result.possiblyResolved} possibly resolved, ${result.canHelp} can help`,
    });
    recordSuccess(evoState);
    return action;
  } catch (err) {
    updateAction(action, 'failed', {
      result: String(err).slice(0, 200),
    });
    return null;
  }
}

/** Step 2: Prompt Refinement */
async function stepPromptRefinement(
  config: OrchestratorConfig,
  evoState: EvolutionState,
  apiKey: string,
): Promise<EvolutionAction | null> {
  const action = createAction(
    'prompt-refine',
    'Evolve worst-performing prompt',
  );

  try {
    updateAction(action, 'validating');
    const result = await evolveWorstPrompt(apiKey);

    if (!result.evolved) {
      updateAction(action, 'failed', { result: result.reason });
      return null;
    }

    // Validate the evolved prompt
    const changedFiles = [`data/prompts/${result.promptId}.yaml`];
    const validation = await validateAction(
      action,
      changedFiles,
      config.repoPath,
      apiKey,
    );

    if (!validation.approved) {
      updateAction(action, 'failed', { result: validation.reason });
      const failResult = recordFailure(evoState);
      if (failResult.paused) {
        const duration = failResult.duration! > 3_600_000 ? '24h' : '1h';
        await notify(
          formatStagnationAlert(evoState.consecutiveFailures, duration),
        );
      }
      return null;
    }

    // Commit the change
    updateAction(action, 'executing');
    const hash = commitEvolution(action, changedFiles, config.repoPath);

    if (hash) {
      updateAction(action, 'committed', { commitHash: hash });
      recordSuccess(evoState);
      await notify(
        formatPromptEvolution(
          result.promptId!,
          0, // old version — we don't track this precisely here
          1,
          result.oldFpRate || 0,
        ),
      );
    } else {
      updateAction(action, 'failed', { result: 'Git commit failed' });
    }

    return action;
  } catch (err) {
    updateAction(action, 'failed', {
      result: String(err).slice(0, 200),
    });
    return null;
  }
}

/** Step 3: Rule Expansion */
async function stepRuleExpansion(
  config: OrchestratorConfig,
  evoState: EvolutionState,
): Promise<EvolutionAction | null> {
  // Only fetch community rules if we haven't yet
  const existingCount = countCommunityRules(config.repoPath);
  if (existingCount > 0) return null; // Already fetched

  const action = createAction(
    'rule-import',
    'Import community ast-grep and OpenGrep rules',
  );

  try {
    updateAction(action, 'executing');
    const result = fetchAllCommunityRules(config.repoPath);

    if (result.totalFetched === 0) {
      updateAction(action, 'failed', {
        result: `No rules fetched. Errors: ${result.errors.join('; ').slice(0, 200)}`,
      });
      return null;
    }

    // Commit imported rules
    const changedFiles = ['rules/community/', 'rules/opengrep/'];
    const hash = commitEvolution(action, changedFiles, config.repoPath);

    if (hash) {
      updateAction(action, 'committed', {
        commitHash: hash,
        result: `Imported ${result.totalFetched} community rules`,
      });
      recordSuccess(evoState);
      await notify(
        `<b>📏 Community Rules Imported</b>\n\n<code>${result.totalFetched}</code> rules from ast-grep-essentials and semgrep-community`,
      );
    } else {
      updateAction(action, 'failed', { result: 'Git commit failed' });
    }

    return action;
  } catch (err) {
    updateAction(action, 'failed', {
      result: String(err).slice(0, 200),
    });
    return null;
  }
}

/** Step 4: Self-Scan — Pi-powered agentic sweep of NanoClaw's own source */
async function stepSelfScan(
  evoState: EvolutionState,
): Promise<EvolutionAction | null> {
  // Self-scan every 5 minutes
  const lastSelfScan = evoState.lastSelfScan
    ? new Date(evoState.lastSelfScan).getTime()
    : 0;
  if (Date.now() - lastSelfScan < 5 * 60_000) return null; // 5 minutes

  const action = createAction(
    'self-scan',
    'Pi-powered agentic sweep of NanoClaw src/',
  );

  try {
    updateAction(action, 'executing');

    // NanoClaw's own repo root — engine.ts is at src/orchestrator/evolution/
    const selfRepoPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../..',
    );

    const selfScanPrompt = `You are scanning NanoClaw's own TypeScript source code for improvements.
NanoClaw is an autonomous code validation orchestrator. Focus on:

1. **Dead code**: unused imports, unreachable branches, exported-but-uncalled functions
2. **Error handling gaps**: unhandled promise rejections, missing catch blocks
3. **Type safety**: any casts, missing type guards, unsafe assertions
4. **Performance**: blocking operations in async loops, unnecessary allocations
5. **Logic bugs**: race conditions, stale state, off-by-one errors

Only report findings with confidence >= 4 and concrete code references.`;

    const result = await runAgenticSweep(
      selfRepoPath,
      selfScanPrompt,
      'self-improvement',
    );

    evoState.lastSelfScan = new Date().toISOString();

    if (result.findings.length === 0) {
      updateAction(action, 'committed', {
        result: `Scanned ${result.totalFiles} files in ${result.turns} turns — no issues found`,
      });
      recordSuccess(evoState);
      return action;
    }

    updateAction(action, 'committed', {
      result: `Found ${result.findings.length} issue(s) in ${result.totalFiles} files (${result.turns} turns)`,
    });
    recordSuccess(evoState);

    // Queue findings as goals for autonomous execution
    for (const f of result.findings.slice(0, 5)) {
      const goalText = [
        f.title || 'untitled',
        f.description ? `: ${f.description}` : '',
        f.files?.length ? ` (files: ${f.files.join(', ')})` : '',
      ].join('');
      addGoal(evoState, goalText.slice(0, 500));
    }

    // Notify findings via Telegram
    const findingsSummary = result.findings
      .slice(0, 5)
      .map(
        (f) =>
          `• <code>${f.title?.slice(0, 80) || 'untitled'}</code> [${f.severity}]`,
      )
      .join('\n');

    await notify(
      [
        `<b>🔬 NanoClaw Self-Scan Complete</b>`,
        ``,
        `Scanned <code>${result.totalFiles}</code> files in <code>${result.turns}</code> turns`,
        `Found <code>${result.findings.length}</code> issue(s) → queued as goals:`,
        findingsSummary,
      ].join('\n'),
    );

    return action;
  } catch (err) {
    updateAction(action, 'failed', {
      result: String(err).slice(0, 200),
    });
    return null;
  }
}

/** Step 5: Goal Execution — Claude Code implements queued fixes */
async function stepGoalExecution(
  evoState: EvolutionState,
): Promise<EvolutionAction | null> {
  const goals = evoState.userGoals || [];
  if (goals.length === 0) return null;

  // Take the oldest goal
  const goal = goals[0];
  const action = createAction('goal-fix', goal.text.slice(0, 100));

  try {
    updateAction(action, 'executing');

    // CRITICAL: Stash any existing uncommitted changes before Claude Code runs.
    // This ensures we only see the goal's changes in git status afterward.
    let hasStash = false;
    try {
      const stashResult = execSync(
        'git stash push -m "nanoclaw-goal-execution"',
        {
          cwd: SELF_REPO,
          encoding: 'utf-8',
          timeout: 30_000,
        },
      ).trim();
      hasStash = !stashResult.includes('No local changes');
    } catch {
      // No changes to stash — that's fine
    }

    // Run Claude Code to implement the fix
    const prompt = [
      `You are fixing a code issue in NanoClaw, a TypeScript/Bun project.`,
      ``,
      `Issue: ${goal.text}`,
      ``,
      `Instructions:`,
      `- Make the minimal change needed to fix this issue`,
      `- Do NOT modify src/orchestrator/evolution/engine.ts or src/orchestrator/evolution/validator.ts (protected files)`,
      `- Ensure the fix compiles (TypeScript strict mode)`,
      `- If the issue is already fixed or not applicable, make no changes`,
    ].join('\n');

    const result = spawnSync(
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
        cwd: SELF_REPO,
        encoding: 'utf-8',
        timeout: GOAL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const output = (result.stdout || '').trim();
    const hadError = result.error || result.status !== 0;

    logger.info(
      { goalText: goal.text.slice(0, 60), outputLen: output.length, hadError },
      'Goal execution complete',
    );

    // Check what files were changed (only new changes since stash)
    let changedFiles: string[] = [];
    try {
      const gitStatus = execSync('git status --porcelain', {
        cwd: SELF_REPO,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
      changedFiles = gitStatus
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.slice(3).trim())
        .filter((f) => f.length > 0);
    } catch {
      // git status failed
    }

    if (changedFiles.length === 0) {
      // No changes — goal was already fixed or not applicable
      updateAction(action, 'committed', {
        result: `No changes needed: ${output.slice(0, 200)}`,
      });
      removeGoal(evoState, 0);
      recordSuccess(evoState);

      // Restore stashed changes
      if (hasStash) {
        try {
          execSync('git stash pop', { cwd: SELF_REPO, timeout: 30_000 });
        } catch {
          /* ignore */
        }
      }
      return action;
    }

    // Validate: build must pass
    try {
      execSync('bun run build', {
        cwd: SELF_REPO,
        encoding: 'utf-8',
        timeout: 120_000,
      });
    } catch (buildErr) {
      logger.warn(
        { err: buildErr, files: changedFiles },
        'Goal fix failed build — reverting',
      );
      // Revert only the goal's changes (not stashed changes)
      for (const file of changedFiles) {
        try {
          execSync(`git checkout -- "${file}"`, {
            cwd: SELF_REPO,
            timeout: 10_000,
          });
        } catch {
          /* ignore */
        }
      }
      updateAction(action, 'failed', { result: 'Build failed after fix' });
      removeGoal(evoState, 0);

      if (hasStash) {
        try {
          execSync('git stash pop', { cwd: SELF_REPO, timeout: 30_000 });
        } catch {
          /* ignore */
        }
      }
      return action;
    }

    // Commit the fix
    const hash = commitEvolution(action, changedFiles, SELF_REPO);

    if (hash) {
      updateAction(action, 'committed', {
        commitHash: hash,
        result: `Fixed: ${output.slice(0, 200)}`,
      });
      recordSuccess(evoState);

      await notify(
        [
          `<b>🔧 Goal Fix Committed</b>`,
          `<code>[${action.id}]</code>`,
          ``,
          `<i>${goal.text.slice(0, 200)}</i>`,
          ``,
          `Commit: <code>${hash.slice(0, 7)}</code>`,
          `Files: ${changedFiles.map((f) => `<code>${f}</code>`).join(', ')}`,
        ].join('\n'),
      );
    } else {
      updateAction(action, 'failed', { result: 'Git commit failed' });
      // Revert goal's changes
      for (const file of changedFiles) {
        try {
          execSync(`git checkout -- "${file}"`, {
            cwd: SELF_REPO,
            timeout: 10_000,
          });
        } catch {
          /* ignore */
        }
      }
    }

    removeGoal(evoState, 0);

    // Restore stashed changes
    if (hasStash) {
      try {
        execSync('git stash pop', { cwd: SELF_REPO, timeout: 30_000 });
      } catch {
        /* ignore */
      }
    }

    return action;
  } catch (err) {
    updateAction(action, 'failed', { result: String(err).slice(0, 200) });
    removeGoal(evoState, 0);
    // Try to restore stash on unexpected error
    try {
      execSync('git stash pop', { cwd: SELF_REPO, timeout: 30_000 });
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Remove a goal from the queue by index */
function removeGoal(state: EvolutionState, index: number): void {
  if (!state.userGoals) return;
  state.userGoals.splice(index, 1);
}

/** Add a goal to the queue (with dedup) */
export function addGoal(state: EvolutionState, text: string): void {
  if (!state.userGoals) state.userGoals = [];
  if (state.userGoals.some((g: UserGoal) => g.text === text)) return;
  if (state.userGoals.length >= 20) return; // cap
  state.userGoals.push({ text, addedAt: new Date().toISOString() });
}

/** Step 6: Research — MiniMax picks topics, Claude researches, MiniMax synthesizes */
async function stepResearch(
  evoState: EvolutionState,
  apiKey: string,
): Promise<EvolutionAction | null> {
  // Research every 30 minutes
  const lastResearch = evoState.lastResearch
    ? new Date(evoState.lastResearch).getTime()
    : 0;
  if (Date.now() - lastResearch < 30 * 60_000) return null;

  const action = createAction('research', 'Web research for SOTA techniques');

  try {
    updateAction(action, 'executing');
    evoState.lastResearch = new Date().toISOString();

    const result = await runResearchCycle(apiKey);

    if (result.actionItems.length === 0) {
      updateAction(action, 'committed', {
        result: `Researched ${result.topics.length} topics, no actionable items`,
      });
      return action;
    }

    // Queue action items as goals
    for (const item of result.actionItems) {
      addGoal(evoState, item);
    }

    updateAction(action, 'committed', {
      result: `${result.topics.length} topics → ${result.actionItems.length} action items queued`,
    });
    recordSuccess(evoState);

    await notify(
      [
        `<b>🔬 Research Complete</b>`,
        `<code>[${action.id}]</code>`,
        ``,
        `Topics: ${result.topics.map((t: string) => `<code>${t.slice(0, 60)}</code>`).join(', ')}`,
        `Action items: <code>${result.actionItems.length}</code> queued as goals`,
        ``,
        ...result.actionItems
          .slice(0, 3)
          .map((item: string) => `• <i>${item.slice(0, 100)}</i>`),
      ].join('\n'),
    );

    return action;
  } catch (err) {
    updateAction(action, 'failed', { result: String(err).slice(0, 200) });
    return null;
  }
}

// --- Module-level State ---

let evoState: EvolutionState;
let initialized = false;

/** Initialize evolution engine */
export function initEvolutionEngine(state: EvolutionState): void {
  evoState = state;
  loadAllPrompts();
  initialized = true;
  logger.info('Evolution engine initialized');
}

/**
 * Main evolution tick — called from the orchestrator idle loop.
 *
 * Runs one evolution step per tick, respecting RPM budget and stagnation.
 */
export async function tick(
  orchestratorState: OrchestratorState,
  apiKey: string,
  config: OrchestratorConfig,
): Promise<void> {
  if (!initialized) return;

  // Check stagnation pause
  if (isEvolutionPaused(evoState)) {
    return;
  }

  // Check RPM budget
  if (!canCallMiniMax()) {
    return;
  }

  // Poll Telegram callbacks (non-blocking)
  await pollCallbacks();

  // Priority-ordered evolution steps
  // Each tick runs ONE step, then yields back to the main loop

  const steps = [
    // Step 1: Goal execution — highest priority, implement queued fixes
    async () => stepGoalExecution(evoState),

    // Step 2: Self-scan (every 5 min) — discovers issues, queues as goals
    async () => stepSelfScan(evoState),

    // Step 3: Research (every 30 min) — finds SOTA techniques, queues as goals
    async () => stepResearch(evoState, apiKey),

    // Step 4: Prompt refinement
    async () => stepPromptRefinement(config, evoState, apiKey),

    // Step 5: Rule expansion (one-time)
    async () => stepRuleExpansion(config, evoState),

    // Step 6: Issue landscape (every ~1 hour)
    async () => {
      const lastIssueLandscape = evoState.lastIssueLandscape
        ? new Date(evoState.lastIssueLandscape).getTime()
        : 0;
      if (Date.now() - lastIssueLandscape < 60 * 60_000) return null;
      evoState.lastIssueLandscape = new Date().toISOString();
      return stepIssueLandscape(config, apiKey);
    },
  ];

  for (const step of steps) {
    if (!canCallMiniMax()) break;

    try {
      const result = await step();
      if (result) {
        logger.info(
          {
            actionId: result.id,
            type: result.type,
            status: result.status,
          },
          'Evolution step completed',
        );

        // Notify on committed actions
        if (result.status === 'committed') {
          await notify(formatEvolutionAction(result));
        }

        // Check if we should rebuild and restart
        if (result.status === 'committed') {
          await checkAutonomousRestart(apiKey, orchestratorState);
        }

        break; // One step per tick
      }
    } catch (err) {
      logger.warn({ err }, 'Evolution step failed');
      const failResult = recordFailure(evoState);
      if (failResult.paused) {
        const duration = failResult.duration! > 3_600_000 ? '24h' : '1h';
        await notify(
          formatStagnationAlert(evoState.consecutiveFailures, duration),
        );
      }
      break;
    }
  }

  evoState.lastTick = new Date().toISOString();
  saveEvolutionState(evoState);
}

/**
 * Check if NanoClaw should rebuild and restart itself.
 *
 * Called after evolution commits that modify src/ or other build-affecting files.
 * Asks MiniMax whether the timing is safe (no active scan/triage in progress).
 */
async function checkAutonomousRestart(
  apiKey: string,
  orchestratorState: OrchestratorState,
): Promise<void> {
  try {
    // Check if src/ has uncommitted changes or if dist/ is stale
    const srcHash = execSync('git log -1 --format=%H -- src/', {
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
    const distMtime = execSync(
      'stat -f %m dist/orchestrator/index.js 2>/dev/null || echo 0',
      { encoding: 'utf-8', timeout: 5_000 },
    ).trim();

    // If dist is older than latest src commit, we need a rebuild
    const srcCommitTime = execSync(`git log -1 --format=%ct ${srcHash}`, {
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();

    if (parseInt(distMtime) >= parseInt(srcCommitTime)) {
      return; // dist/ is up to date
    }

    // Ask MiniMax if timing is safe
    const prompt = `NanoClaw orchestrator needs to restart to pick up code changes.
Current state: ${orchestratorState.consecutiveErrors} errors, cycle ${orchestratorState.cycleCount}.
Last heartbeat: ${orchestratorState.lastHeartbeat}.

Is it safe to restart now? Consider:
- Are we in the middle of a scan cycle? (no, we're in idle)
- Will anything be lost? (state is persisted to disk)
- Is there a better time? (idle = best time)

Respond with exactly YES or NO followed by a brief reason.`;

    const response = await queryMiniMax(prompt, apiKey);
    const trimmed = response.trim();

    if (!trimmed.startsWith('YES')) {
      logger.info(
        { reason: trimmed.slice(0, 100) },
        'MiniMax advised against restart, deferring',
      );
      return;
    }

    // Rebuild
    logger.info('Rebuilding dist/ before autonomous restart');
    execSync('bun run build', { timeout: 120_000 });

    await notify(
      [
        `<b>🔄 NanoClaw Self-Restart</b>`,
        ``,
        `Evolution engine committed code changes.`,
        `Rebuilding and restarting to pick up new dist/.`,
        `<i>MiniMax approved: ${trimmed.slice(4, 100)}</i>`,
      ].join('\n'),
    );

    // Graceful restart: SIGTERM triggers launchd auto-restart
    logger.info('Triggering graceful restart via SIGTERM');
    process.kill(process.pid, 'SIGTERM');
  } catch (err) {
    logger.warn({ err }, 'Autonomous restart check failed (non-fatal)');
  }
}

/** Get evolution engine status summary */
export function getEvolutionStatus(): {
  paused: boolean;
  consecutiveFailures: number;
  goalsQueued: number;
  promptMetrics: ReturnType<typeof getMetrics>;
  patternTemperatures: ReturnType<typeof getPatternsByTemperature>;
} {
  return {
    paused: isEvolutionPaused(evoState),
    consecutiveFailures: evoState.consecutiveFailures,
    goalsQueued: (evoState.userGoals || []).length,
    promptMetrics: getMetrics(),
    patternTemperatures: getPatternsByTemperature(evoState),
  };
}
