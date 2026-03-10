/**
 * Orchestrator state persistence, rate limiting, and log rotation.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { MAX_ISSUES_PER_HOUR, STATE_FILE } from './types.js';
import type { OrchestratorState } from './types.js';

// --- State ---

export function loadState(): OrchestratorState {
  const defaults: OrchestratorState = {
    lastCheckedCommit: '',
    cycleCount: 0,
    issuesCreated: 0,
    issuesCreatedThisHour: 0,
    hourWindow: '',
    lastHeartbeat: '',
    startedAt: new Date().toISOString(),
    consecutiveErrors: 0,
    findingsValidated: 0,
    findingsRejected: 0,
  };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return { ...defaults, ...saved };
    }
  } catch {
    logger.warn('Corrupted orchestrator state, resetting');
  }
  return defaults;
}

export function saveState(state: OrchestratorState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Atomic write: tmp file + rename to prevent corruption on crash
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}

// --- Log Rotation ---

const LOG_FILE = '/tmp/orchestrator.log';
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export function rotateLogIfNeeded(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      const keepFrom = content.length - 2 * 1024 * 1024;
      const newContent =
        keepFrom > 0
          ? '... (log rotated)\n' + content.slice(keepFrom)
          : content;
      fs.writeFileSync(LOG_FILE, newContent);
      logger.info(
        { oldSize: stats.size, newSize: newContent.length },
        'Log file rotated',
      );
    }
  } catch {
    // Non-fatal
  }
}

/** Check sliding-window rate limit (true rolling hour) */
export function checkRateLimit(state: OrchestratorState): boolean {
  const now = Date.now();
  if (!state.issueTimestamps) state.issueTimestamps = [];
  state.issueTimestamps = state.issueTimestamps.filter(
    (ts) => now - ts < 3_600_000,
  );
  return state.issueTimestamps.length < MAX_ISSUES_PER_HOUR;
}
