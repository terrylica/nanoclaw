/**
 * Evolution action state and audit trail.
 *
 * Every evolution action is logged as NDJSON for full auditability.
 * Status flow: proposed -> validating -> executing -> committed | failed | reverted
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { traceId } from '../types.js';

// --- Types ---

export type EvolutionActionType =
  | 'prompt-refine'
  | 'prompt-new'
  | 'rule-generate'
  | 'rule-import'
  | 'perspective-new'
  | 'fp-pattern-update'
  | 'research'
  | 'issue-landscape'
  | 'self-scan'
  | 'source-modify'
  | 'repo-onboard'
  | 'goal-fix';

export type EvolutionActionStatus =
  | 'proposed'
  | 'validating'
  | 'executing'
  | 'committed'
  | 'failed'
  | 'reverted';

export interface EvolutionAction {
  id: string;
  type: EvolutionActionType;
  description: string;
  status: EvolutionActionStatus;
  commitHash?: string;
  revertHash?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserGoal {
  text: string;
  addedAt: string;
}

export interface EvolutionState {
  /** Count of consecutive failed evolution actions */
  consecutiveFailures: number;
  /** Timestamp when evolution was paused (stagnation) */
  pausedUntil?: string;
  /** Last evolution tick timestamp */
  lastTick?: string;
  /** Last self-scan timestamp */
  lastSelfScan?: string;
  /** Last issue landscape check timestamp */
  lastIssueLandscape?: string;
  /** Last research timestamp */
  lastResearch?: string;
  /** Last Telegram update ID for callback polling */
  lastTelegramUpdateId?: number;
  /** Finding pattern activation scores: pattern -> { score, lastSeen } */
  patternActivation: Record<string, { score: number; lastSeen: string }>;
  /** Queued goals for autonomous execution */
  userGoals?: UserGoal[];
}

// --- Constants ---

const ACTIONS_FILE = path.join(DATA_DIR, 'evolution-actions.ndjson');
const STATE_FILE = path.join(DATA_DIR, 'evolution-state.json');

const STAGNATION_PAUSE_5 = 60 * 60 * 1000; // 1 hour
const STAGNATION_PAUSE_10 = 24 * 60 * 60 * 1000; // 24 hours
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- Action Logging ---

/** Create a new evolution action */
export function createAction(
  type: EvolutionActionType,
  description: string,
): EvolutionAction {
  return {
    id: traceId(),
    type,
    description,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Update an action's status and persist to NDJSON */
export function updateAction(
  action: EvolutionAction,
  status: EvolutionActionStatus,
  extra?: Partial<EvolutionAction>,
): void {
  action.status = status;
  action.updatedAt = new Date().toISOString();
  if (extra) Object.assign(action, extra);
  appendActionLog(action);
}

/** Append action to NDJSON audit log */
function appendActionLog(action: EvolutionAction): void {
  try {
    fs.mkdirSync(path.dirname(ACTIONS_FILE), { recursive: true });
    fs.appendFileSync(ACTIONS_FILE, JSON.stringify(action) + '\n');
  } catch (err) {
    logger.warn({ err }, 'Failed to append evolution action log');
  }
}

// --- Evolution State ---

export function loadEvolutionState(): EvolutionState {
  const defaults: EvolutionState = {
    consecutiveFailures: 0,
    patternActivation: {},
  };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return { ...defaults, ...saved };
    }
  } catch {
    logger.warn('Corrupted evolution state, resetting');
  }
  return defaults;
}

export function saveEvolutionState(state: EvolutionState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    // Atomic write: tmp file + rename to prevent corruption on crash
    const tmpFile = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    logger.warn({ err }, 'Failed to save evolution state');
  }
}

// --- Stagnation Detection ---

/** Check if evolution is currently paused due to stagnation */
export function isEvolutionPaused(state: EvolutionState): boolean {
  if (!state.pausedUntil) return false;
  return Date.now() < new Date(state.pausedUntil).getTime();
}

/** Record a failed evolution action, potentially triggering stagnation pause */
export function recordFailure(state: EvolutionState): {
  paused: boolean;
  duration?: number;
} {
  state.consecutiveFailures++;

  if (state.consecutiveFailures >= 10) {
    state.pausedUntil = new Date(
      Date.now() + STAGNATION_PAUSE_10,
    ).toISOString();
    return { paused: true, duration: STAGNATION_PAUSE_10 };
  }
  if (state.consecutiveFailures >= 5) {
    state.pausedUntil = new Date(Date.now() + STAGNATION_PAUSE_5).toISOString();
    return { paused: true, duration: STAGNATION_PAUSE_5 };
  }

  return { paused: false };
}

/** Record a successful evolution action */
export function recordSuccess(state: EvolutionState): void {
  state.consecutiveFailures = 0;
  state.pausedUntil = undefined;
}

// --- Memory Activation/Decay ---

/** Update activation score for a finding pattern */
export function activatePattern(state: EvolutionState, pattern: string): void {
  state.patternActivation[pattern] = {
    score: 1.0,
    lastSeen: new Date().toISOString(),
  };
}

/** Get current activation score with exponential decay */
export function getPatternScore(
  state: EvolutionState,
  pattern: string,
): number {
  const entry = state.patternActivation[pattern];
  if (!entry) return 0;

  const ageMs = Date.now() - new Date(entry.lastSeen).getTime();
  return entry.score * Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

/** Get patterns categorized by temperature */
export function getPatternsByTemperature(state: EvolutionState): {
  hot: string[];
  warm: string[];
  cool: string[];
} {
  const hot: string[] = [];
  const warm: string[] = [];
  const cool: string[] = [];

  for (const pattern of Object.keys(state.patternActivation)) {
    const score = getPatternScore(state, pattern);
    if (score >= 0.5) hot.push(pattern);
    else if (score >= 0.1) warm.push(pattern);
    else cool.push(pattern);
  }

  return { hot, warm, cool };
}
