/**
 * Shared types and constants for the NanoClaw orchestrator.
 */
import crypto from 'crypto';
import path from 'path';

import { DATA_DIR } from '../config.js';

// --- Trace ID ---

/** Generate a short trace ID for action traceability across Telegram messages */
export function traceId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// --- Config ---

export const MINIMAX_MODEL = 'MiniMax-M2.5-highspeed';
export const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export const PROACTIVE_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const ALGO_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const CYCLE_COOLDOWN_MS = 30_000; // 30s between cycles when no changes
export const CYCLE_COOLDOWN_ERROR_MS = 60_000; // 60s after errors
export const STATE_FILE = path.join(DATA_DIR, 'orchestrator-state.json');

// Difftastic (AST-aware diffs, reduces formatting false positives)
export const DIFFT_BINARY =
  process.env.DIFFT_BINARY ||
  `${process.env.HOME}/fork-tools/difftastic/target/release/difft`;

// ast-grep (deterministic structural lint)
export const AST_GREP_BINARY =
  process.env.AST_GREP_BINARY || `${process.env.HOME}/.cargo/bin/ast-grep`;
export const AST_GREP_RULES_DIR = path.join(
  path.dirname(path.dirname(new URL(import.meta.url).pathname)),
  'rules',
);

// OpenGrep (SAST with taint analysis for Python)
export const OPENGREP_BINARY =
  process.env.OPENGREP_BINARY || `${process.env.HOME}/.local/bin/opengrep`;

// Rate limiting
export const MAX_ISSUES_PER_HOUR = 6;
export const MAX_FINDINGS_PER_CYCLE = 5;
export const MIN_SEVERITY_FOR_ISSUE = 'medium';

// Claude validation timeout (5 min per finding)
export const CLAUDE_VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;

// Whole-repo scanning
export const CHUNK_CHAR_BUDGET = 400_000; // max source chars per MiniMax call
export const PER_FILE_TRUNCATE = 20_000; // truncate individual large files

// --- Types ---

export interface OrchestratorState {
  lastCheckedCommit: string;
  cycleCount: number;
  issuesCreated: number;
  issuesCreatedThisHour: number;
  hourWindow: string;
  issueTimestamps?: number[];
  lastHeartbeat: string;
  lastProactiveScan?: string;
  proactiveScanCount?: number;
  lastAlgoScan?: string;
  algoScanCount?: number;
  startedAt: string;
  consecutiveErrors: number;
  findingsValidated: number;
  findingsRejected: number;
}

export interface Finding {
  type:
    | 'bug'
    | 'performance-regression'
    | 'test-gap'
    | 'daemon-behavior'
    | 'enhancement';
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence?: number;
  title: string;
  description: string;
  files: string[];
  validation: string;
  sourcePerspectives?: string[];
}

export interface ValidationResult {
  confirmed: boolean;
  confidence: 'low' | 'medium' | 'high';
  analysis: string;
  suggestedFix?: string;
}

export interface TriageResult {
  findings: Finding[];
  summary: string;
}

export interface OrchestratorConfig {
  repoPath: string;
  githubRepo?: string;
}

export interface ExpertPerspective {
  name: string;
  systemPrompt: string;
}
