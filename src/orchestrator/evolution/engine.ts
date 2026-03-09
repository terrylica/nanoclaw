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
import { logger } from '../../logger.js';
import type { OrchestratorConfig, OrchestratorState } from '../types.js';
import { notify } from '../telegram.js';
import { commitEvolution } from './git-safety.js';
import { checkIssueLandscape } from './issue-tracker.js';
import { evolveWorstPrompt } from './prompt-evolver.js';
import { loadAllPrompts, getMetrics } from './prompt-registry.js';
import { canCallMiniMax } from './rpm-tracker.js';
import { fetchAllCommunityRules, countCommunityRules } from './rule-fetcher.js';
import {
  type EvolutionAction,
  type EvolutionState,
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

// --- Evolution Steps ---

/** Step 1: Issue Landscape Check */
async function stepIssueLandscape(
  config: OrchestratorConfig,
  apiKey: string,
): Promise<EvolutionAction | null> {
  if (!config.githubRepo) return null;

  const action = createAction(
    'issue-landscape',
    'Check open issue relevance',
  );

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
        await notify(formatStagnationAlert(evoState.consecutiveFailures, duration));
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
    const changedFiles = [
      'rules/community/',
      'rules/opengrep/',
    ];
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
  _orchestratorState: OrchestratorState,
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

  // Record tick
  evoState.lastTick = new Date().toISOString();

  // Priority-ordered evolution steps
  // Each tick runs ONE step, then yields back to the main loop

  const steps = [
    // Step 1: Issue landscape (every ~4 hours)
    async () => {
      const lastTick = evoState.lastTick
        ? new Date(evoState.lastTick).getTime()
        : 0;
      const hoursSinceLastTick = (Date.now() - lastTick) / 3_600_000;
      if (hoursSinceLastTick < 4) return null;
      return stepIssueLandscape(config, apiKey);
    },

    // Step 2: Prompt refinement
    async () => stepPromptRefinement(config, evoState, apiKey),

    // Step 3: Rule expansion (one-time)
    async () => stepRuleExpansion(config, evoState),
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

        break; // One step per tick
      }
    } catch (err) {
      logger.warn({ err }, 'Evolution step failed');
      const failResult = recordFailure(evoState);
      if (failResult.paused) {
        const duration = failResult.duration! > 3_600_000 ? '24h' : '1h';
        await notify(formatStagnationAlert(evoState.consecutiveFailures, duration));
      }
      break;
    }
  }

  saveEvolutionState(evoState);
}

/** Get evolution engine status summary */
export function getEvolutionStatus(): {
  paused: boolean;
  consecutiveFailures: number;
  promptMetrics: ReturnType<typeof getMetrics>;
  patternTemperatures: ReturnType<typeof getPatternsByTemperature>;
} {
  return {
    paused: isEvolutionPaused(evoState),
    consecutiveFailures: evoState.consecutiveFailures,
    promptMetrics: getMetrics(),
    patternTemperatures: getPatternsByTemperature(evoState),
  };
}
