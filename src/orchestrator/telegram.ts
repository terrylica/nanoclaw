/**
 * Telegram notifications, message formatting, and telemetry.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { fetchWithTimeout } from './minimax-client.js';
import type { Finding, OrchestratorState, ValidationResult } from './types.js';

// --- Global Notifier Singleton ---
// Initialized once in index.ts, importable everywhere without threading credentials.

let _botToken = '';
let _chatId = '';

/** Initialize global Telegram credentials. Call once at startup. */
export function initGlobalNotifier(botToken: string, chatId: string): void {
  _botToken = botToken;
  _chatId = chatId;
}

/**
 * Send a notification using globally-stored credentials.
 * No-op if credentials weren't initialized (graceful degradation).
 */
export async function notify(message: string): Promise<void> {
  if (!_botToken || !_chatId) return;
  await sendTelegramNotification(message, _botToken, _chatId);
}

// Telemetry: NDJSON log of all Telegram messages
const TELEMETRY_FILE = path.join(DATA_DIR, 'telegram-telemetry.ndjson');

function logTelemetry(
  message: string,
  success: boolean,
  durationMs: number,
): void {
  try {
    const plainText = message
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      success,
      durationMs,
      charLen: message.length,
      plainText: plainText.slice(0, 2000),
      htmlPreview: message.slice(0, 500),
    });
    fs.mkdirSync(path.dirname(TELEMETRY_FILE), { recursive: true });
    fs.appendFileSync(TELEMETRY_FILE, entry + '\n');
  } catch (err) {
    // Telemetry failure must never block the pipeline
    logger.debug({ err }, 'Telegram telemetry write failed (non-fatal)');
  }
}

export async function sendTelegramNotification(
  message: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const maxRetries = 3;
  const t0 = Date.now();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            disable_notification: true,
            link_preview_options: { is_disabled: true },
          }),
        },
        30_000,
      );
      const durationMs = Date.now() - t0;

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(
          { status: response.status, body: body.slice(0, 200) },
          'Telegram API error',
        );
        logTelemetry(message, false, durationMs);
      } else {
        logTelemetry(message, true, durationMs);
      }
      return; // success or API error — don't retry API errors
    } catch (err) {
      if (attempt < maxRetries - 1) {
        // Transient network error — wait 2s/4s then retry
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      logTelemetry(message, false, Date.now() - t0);
      logger.warn(
        { err, attempts: maxRetries },
        'Telegram notification failed after retries (non-fatal)',
      );
    }
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatHeartbeat(
  state: OrchestratorState,
  branch: string,
  evoStats?: {
    paused: boolean;
    consecutiveFailures: number;
    goalsQueued: number;
    promptCount: number;
    totalUses: number;
  },
): string {
  const elapsed = (
    (Date.now() - new Date(state.startedAt).getTime()) /
    60_000
  ).toFixed(0);

  // Show error state prominently — don't mask failures with green heart
  const hasErrors = state.consecutiveErrors > 0;
  const icon = hasErrors
    ? state.consecutiveErrors >= 10
      ? '🔴'
      : state.consecutiveErrors >= 3
        ? '🟡'
        : '💚'
    : '💚';
  const title = hasErrors
    ? `NanoClaw Heartbeat — ${state.consecutiveErrors} consecutive errors`
    : 'NanoClaw Heartbeat';

  const lines = [
    `<b>${icon} ${title}</b>`,
    ``,
    `• Uptime: <code>${elapsed} min</code>`,
    `• Cycles: <code>${state.cycleCount}</code>`,
    `• Branch: <code>${branch}</code>`,
    `• Last commit: <code>${state.lastCheckedCommit.slice(0, 7) || 'none'}</code>`,
  ];

  if (evoStats) {
    lines.push(
      ``,
      `<b>Evolution</b>`,
      `• Prompts: <code>${evoStats.promptCount}</code> (${evoStats.totalUses} uses)`,
      `• Goals queued: <code>${evoStats.goalsQueued}</code>`,
      `• Evo failures: <code>${evoStats.consecutiveFailures}</code>${evoStats.paused ? ' <b>(PAUSED)</b>' : ''}`,
    );
  }

  if (hasErrors) {
    lines.push(
      ``,
      `<b>⚠️ Errors: <code>${state.consecutiveErrors}</code> consecutive failures</b>`,
    );
    if (state.lastErrorMessage) {
      lines.push(
        `<code>${escapeHtml(state.lastErrorMessage.slice(0, 150))}</code>`,
      );
    }
  }

  lines.push(
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  );
  return lines.join('\n');
}

export function formatFindingNotification(
  finding: Finding,
  validation: ValidationResult,
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
    `<b>${icon} NanoClaw: ${escapeHtml(finding.title)}</b>`,
    ``,
    `<b>Type</b>: <code>${finding.type}</code> | <b>Severity</b>: <code>${finding.severity}</code> | <b>Confidence</b>: <code>${validation.confidence}</code>`,
    `<b>Files</b>: ${finding.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ')}`,
    ``,
    `<i>${escapeHtml(finding.description)}</i>`,
    ``,
    `<b>Analysis</b>: ${escapeHtml(validation.analysis.slice(0, 300))}`,
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

export function formatCycleStart(
  from: string,
  to: string,
  changedFiles: string[],
  cycle: number,
): string {
  const fileList = changedFiles
    .map((f) => `<code>${escapeHtml(f)}</code>`)
    .join('\n');
  return [
    `<b>🔍 NanoClaw Cycle #${cycle}</b>`,
    ``,
    `<code>${from.slice(0, 7)}</code> → <code>${to.slice(0, 7)}</code>`,
    `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed:`,
    fileList,
    ``,
    `<i>Triaging with MiniMax…</i>`,
  ].join('\n');
}

export function formatTriageResult(
  findingCount: number,
  summary: string,
  _cycle: number,
): string {
  if (findingCount === 0) {
    return [
      `<b>✅ Triage: No Findings</b>`,
      ``,
      `<i>${escapeHtml(summary.slice(0, 300))}</i>`,
    ].join('\n');
  }
  return [
    `<b>🎯 Triage: ${findingCount} Finding${findingCount === 1 ? '' : 's'}</b>`,
    ``,
    `<i>${escapeHtml(summary.slice(0, 300))}</i>`,
    ``,
    `<i>Validating with Claude Code…</i>`,
  ].join('\n');
}

export function formatCycleSummary(
  cycle: number,
  findingsTotal: number,
  validated: number,
  rejected: number,
  issuesCreated: number,
  skippedReasons: string[],
): string {
  const lines = [
    `<b>📊 Cycle #${cycle} Complete</b>`,
    ``,
    `• Findings: <code>${findingsTotal}</code>`,
    `• Confirmed: <code>${validated}</code> | Rejected: <code>${rejected}</code>`,
    `• Issues created: <code>${issuesCreated}</code>`,
  ];
  if (skippedReasons.length > 0) {
    lines.push(``, `<b>Skipped</b>:`);
    for (const reason of skippedReasons.slice(0, 5)) {
      lines.push(`• <i>${escapeHtml(reason)}</i>`);
    }
  }
  lines.push(
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  );
  return lines.join('\n');
}
