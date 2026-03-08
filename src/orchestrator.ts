/**
 * MiniMax Orchestrator Loop
 *
 * Continuous diff-driven validation of opendeviationbar-py:
 * 1. git pull → git diff since last check
 * 2. MiniMax M2.5-highspeed triages changed files
 * 3. For each concern → spawn Claude container to validate
 * 4. Confirmed findings → GitHub Issue + Telegram notification
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

// --- Config ---

const MINIMAX_MODEL = 'MiniMax-M2.5-highspeed';
const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const CYCLE_COOLDOWN_MS = 5_000; // 5s between cycles when no changes
const STATE_FILE = path.join(DATA_DIR, 'orchestrator-state.json');

interface OrchestratorState {
  lastCheckedCommit: string;
  cycleCount: number;
  issuesCreated: number;
  lastHeartbeat: string;
  startedAt: string;
}

interface Finding {
  type: 'bug' | 'performance-regression' | 'test-gap' | 'daemon-behavior';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  files: string[];
  validation: string;
}

interface TriageResult {
  findings: Finding[];
  summary: string;
}

// --- State ---

function loadState(): OrchestratorState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    logger.warn('Corrupted orchestrator state, resetting');
  }
  return {
    lastCheckedCommit: '',
    cycleCount: 0,
    issuesCreated: 0,
    lastHeartbeat: '',
    startedAt: new Date().toISOString(),
  };
}

function saveState(state: OrchestratorState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Git Operations ---

function gitPull(repoPath: string): boolean {
  try {
    execSync('git pull --ff-only origin main 2>&1', {
      cwd: repoPath,
      timeout: 30_000,
      encoding: 'utf-8',
    });
    return true;
  } catch (err) {
    logger.error({ err }, 'git pull failed');
    return false;
  }
}

function getHeadCommit(repoPath: string): string {
  return execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8',
  }).trim();
}

function getGitBranch(repoPath: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getDiff(repoPath: string, sinceCommit: string): string {
  try {
    const diff = execSync(
      `git diff ${sinceCommit}..HEAD --stat --unified=5 -- '*.rs' '*.py' '*.toml' '*.cfg'`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 },
    );
    return diff;
  } catch (err) {
    logger.error({ err }, 'git diff failed');
    return '';
  }
}

function getChangedFiles(repoPath: string, sinceCommit: string): string[] {
  try {
    const output = execSync(
      `git diff ${sinceCommit}..HEAD --name-only -- '*.rs' '*.py' '*.toml' '*.cfg'`,
      { cwd: repoPath, encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

function getCommitLog(repoPath: string, sinceCommit: string): string {
  try {
    return execSync(
      `git log ${sinceCommit}..HEAD --oneline --no-merges`,
      { cwd: repoPath, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    ).trim();
  } catch {
    return '';
  }
}

// --- MiniMax Triage ---

async function queryMiniMax(
  prompt: string,
  apiKey: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`MiniMax API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content?.[0]?.text || '';
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function buildTriagePrompt(
  diff: string,
  commitLog: string,
  changedFiles: string[],
): string {
  return `You are a code quality analyst for opendeviationbar-py, a Rust+Python (maturin) library for financial microstructure analysis. It has 10 Rust crates and 4 Python daemons (gap-backfill, kintsugi, sidecar, stathera).

Analyze the following git changes and identify concerns across these 4 categories:
1. **bug**: Logic errors, unsafe patterns, error handling gaps, dead code
2. **performance-regression**: Patterns that could cause OOM, slowdowns, unnecessary allocations
3. **test-gap**: Changed code paths with no test coverage
4. **daemon-behavior**: Issues specific to daemon operation (reconnect, backpressure, data gaps, heartbeat)

CHANGED FILES:
${changedFiles.join('\n')}

COMMIT LOG:
${commitLog}

DIFF:
${diff.slice(0, 50_000)}

Respond with a JSON array of findings. Each finding has: type, severity (low/medium/high/critical), title (concise), description (1-2 sentences), files (array of paths), validation (shell command to verify).

If no concerns found, respond with an empty array: []

IMPORTANT: Only report genuine concerns. False positives waste engineering time. When in doubt, skip it.

JSON:`;
}

async function triageChanges(
  diff: string,
  commitLog: string,
  changedFiles: string[],
  apiKey: string,
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(diff, commitLog, changedFiles);
  const raw = await queryMiniMax(prompt, apiKey);

  // Parse JSON from response (may have markdown fences)
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const findings: Finding[] = JSON.parse(jsonStr);
    return {
      findings: Array.isArray(findings) ? findings : [],
      summary: `${findings.length} concern(s) found`,
    };
  } catch {
    logger.warn({ raw: raw.slice(0, 500) }, 'Failed to parse MiniMax triage response');
    return { findings: [], summary: 'Parse error' };
  }
}

// --- GitHub Issue Creation ---

function createGitHubIssue(
  finding: Finding,
  repoPath: string,
  headCommit: string,
): string | null {
  const labels = ['nanoclaw', finding.type].join(',');
  const body = `---
nanoclaw-type: ${finding.type}
severity: ${finding.severity}
files:
${finding.files.map((f) => `  - ${f}`).join('\n')}
validation: |
  ${finding.validation}
commit: ${headCommit.slice(0, 7)}
---

## Finding: ${finding.title}

**What**: ${finding.description}

**Severity**: ${finding.severity}

**Files**:
${finding.files.map((f) => `- \`${f}\``).join('\n')}

**Validation**:
\`\`\`bash
${finding.validation}
\`\`\`

---
*Auto-created by NanoClaw continuous validation at ${new Date().toISOString()}*`;

  try {
    const result = execSync(
      `gh issue create --repo terrylica/opendeviationbar-py --title "${finding.title.replace(/"/g, '\\"')}" --label "${labels}" --body "$(cat <<'ISSUE_EOF'\n${body}\nISSUE_EOF\n)"`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 15_000 },
    );
    const url = result.trim();
    logger.info({ url, type: finding.type }, 'GitHub issue created');
    return url;
  } catch (err) {
    logger.error({ err, title: finding.title }, 'Failed to create GitHub issue');
    return null;
  }
}

// Deduplication: check if a similar issue already exists
function issueExists(title: string): boolean {
  try {
    const result = execSync(
      `gh issue list --repo terrylica/opendeviationbar-py --label nanoclaw --search "${title.replace(/"/g, '\\"')}" --state open --limit 5 --json title`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const issues = JSON.parse(result) as Array<{ title: string }>;
    return issues.some(
      (i) => i.title.toLowerCase() === title.toLowerCase(),
    );
  } catch {
    return false; // fail open — create the issue
  }
}

// --- Telegram Notifications ---

async function sendTelegramNotification(
  message: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
  } catch (err) {
    logger.warn({ err }, 'Telegram notification failed (non-fatal)');
  }
}

function formatHeartbeat(state: OrchestratorState, branch: string): string {
  const elapsed = (
    (Date.now() - new Date(state.startedAt).getTime()) /
    60_000
  ).toFixed(0);
  return [
    `<b>💚 NanoClaw Heartbeat</b>`,
    ``,
    `• Cycles: <code>${state.cycleCount}</code>`,
    `• Issues created: <code>${state.issuesCreated}</code>`,
    `• Uptime: <code>${elapsed} min</code>`,
    `• Branch: <code>${branch}</code>`,
    `• Last commit: <code>${state.lastCheckedCommit.slice(0, 7) || 'none'}</code>`,
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  ].join('\n');
}

function formatFindingNotification(
  finding: Finding,
  issueUrl: string | null,
): string {
  const icon =
    finding.severity === 'critical'
      ? '🔴'
      : finding.severity === 'high'
        ? '🟠'
        : finding.severity === 'medium'
          ? '🟡'
          : '🟢';
  const lines = [
    `<b>${icon} NanoClaw Finding: ${escapeHtml(finding.title)}</b>`,
    ``,
    `<b>Type</b>: <code>${finding.type}</code>`,
    `<b>Severity</b>: <code>${finding.severity}</code>`,
    `<b>Files</b>: ${finding.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ')}`,
    ``,
    `<i>${escapeHtml(finding.description)}</i>`,
  ];
  if (issueUrl) {
    lines.push(``, `📋 ${issueUrl}`);
  }
  lines.push(
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  );
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Main Loop ---

export interface OrchestratorConfig {
  repoPath: string; // Path to opendeviationbar-py clone
}

export async function startOrchestratorLoop(
  config: OrchestratorConfig,
): Promise<never> {
  const env = readEnvFile([
    'MINIMAX_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
  ]);
  const minimaxKey =
    process.env.MINIMAX_API_KEY || env.MINIMAX_API_KEY || '';
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '';

  if (!minimaxKey) {
    logger.fatal('MINIMAX_API_KEY not set — orchestrator cannot start');
    process.exit(1);
  }

  const state = loadState();
  if (!state.startedAt) state.startedAt = new Date().toISOString();

  // Initialize lastCheckedCommit to current HEAD if not set
  if (!state.lastCheckedCommit) {
    state.lastCheckedCommit = getHeadCommit(config.repoPath);
    saveState(state);
    logger.info(
      { commit: state.lastCheckedCommit },
      'Orchestrator initialized at current HEAD',
    );
  }

  logger.info(
    {
      repoPath: config.repoPath,
      lastCommit: state.lastCheckedCommit.slice(0, 7),
      cycleCount: state.cycleCount,
    },
    'Orchestrator loop starting',
  );

  // Send startup notification
  if (botToken && chatId) {
    const branch = getGitBranch(config.repoPath);
    await sendTelegramNotification(
      [
        `<b>🚀 NanoClaw Orchestrator Started</b>`,
        ``,
        `• Repo: <code>opendeviationbar-py</code>`,
        `• Branch: <code>${branch}</code>`,
        `• From commit: <code>${state.lastCheckedCommit.slice(0, 7)}</code>`,
        `• Mode: continuous diff-driven`,
        ``,
        `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
      ].join('\n'),
      botToken,
      chatId,
    );
  }

  // Main loop
  while (true) {
    try {
      // Heartbeat check
      const now = Date.now();
      const lastHb = state.lastHeartbeat
        ? new Date(state.lastHeartbeat).getTime()
        : 0;
      if (now - lastHb >= HEARTBEAT_INTERVAL_MS && botToken && chatId) {
        const branch = getGitBranch(config.repoPath);
        await sendTelegramNotification(
          formatHeartbeat(state, branch),
          botToken,
          chatId,
        );
        state.lastHeartbeat = new Date().toISOString();
        saveState(state);
      }

      // Step 1: git pull
      const pulled = gitPull(config.repoPath);
      if (!pulled) {
        await sleep(CYCLE_COOLDOWN_MS);
        continue;
      }

      // Step 2: Check for changes
      const headCommit = getHeadCommit(config.repoPath);
      if (headCommit === state.lastCheckedCommit) {
        // No changes — sleep and retry
        await sleep(CYCLE_COOLDOWN_MS);
        continue;
      }

      const changedFiles = getChangedFiles(
        config.repoPath,
        state.lastCheckedCommit,
      );
      if (changedFiles.length === 0) {
        // Only non-code changes (docs, CI, etc.) — skip
        state.lastCheckedCommit = headCommit;
        state.cycleCount++;
        saveState(state);
        continue;
      }

      const diff = getDiff(config.repoPath, state.lastCheckedCommit);
      const commitLog = getCommitLog(
        config.repoPath,
        state.lastCheckedCommit,
      );

      logger.info(
        {
          files: changedFiles.length,
          commits: commitLog.split('\n').length,
          from: state.lastCheckedCommit.slice(0, 7),
          to: headCommit.slice(0, 7),
        },
        'Changes detected, triaging with MiniMax',
      );

      // Step 3: MiniMax triage
      const triage = await triageChanges(
        diff,
        commitLog,
        changedFiles,
        minimaxKey,
      );

      logger.info(
        { findingCount: triage.findings.length, summary: triage.summary },
        'MiniMax triage complete',
      );

      // Step 4: Create issues for confirmed findings
      for (const finding of triage.findings) {
        // Dedup check
        if (issueExists(finding.title)) {
          logger.info(
            { title: finding.title },
            'Skipping duplicate finding',
          );
          continue;
        }

        const issueUrl = createGitHubIssue(
          finding,
          config.repoPath,
          headCommit,
        );

        if (issueUrl) {
          state.issuesCreated++;
        }

        // Telegram notification per finding
        if (botToken && chatId) {
          await sendTelegramNotification(
            formatFindingNotification(finding, issueUrl),
            botToken,
            chatId,
          );
        }
      }

      // Advance state
      state.lastCheckedCommit = headCommit;
      state.cycleCount++;
      saveState(state);

      logger.info(
        {
          cycle: state.cycleCount,
          findings: triage.findings.length,
          issuesTotal: state.issuesCreated,
        },
        'Cycle complete',
      );
    } catch (err) {
      logger.error({ err }, 'Orchestrator cycle error');
    }

    await sleep(CYCLE_COOLDOWN_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
