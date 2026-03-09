/**
 * Auto-resolution of orchestrator failures with LLM-generated diagnostics.
 *
 * When git pull or other operations fail, this module:
 * 1. Gathers diagnostic context (git status, stash list, error output)
 * 2. Attempts automatic resolution (stash, reset, etc.)
 * 3. Sends MiniMax-generated diagnosis to Telegram
 */
import { execSync } from 'child_process';

import { logger } from '../logger.js';
import { queryMiniMax } from './minimax-client.js';
import { escapeHtml, notify, sendTelegramNotification } from './telegram.js';

export interface GitDiagnosticContext {
  status: string;
  stashList: string;
  lastError: string;
  branch: string;
  remoteStatus: string;
  dirtyFiles: string[];
}

export interface AutoResolveResult {
  pulled: boolean;
  resolved: boolean;
  action: 'none' | 'stash' | 'checkout-theirs' | 'reset-hard';
  diagnosis: string;
  dirtyFiles: string[];
}

/** Gather git diagnostic context for error analysis. */
export function getGitDiagnosticContext(
  repoPath: string,
  lastError: string,
): GitDiagnosticContext {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();
    } catch {
      return '(command failed)';
    }
  };

  const status = run('git status --porcelain');
  const dirtyFiles = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.trim());

  return {
    status,
    stashList: run('git stash list'),
    lastError,
    branch: run('git branch --show-current'),
    remoteStatus: run(
      'git log --oneline HEAD..origin/main 2>/dev/null | head -5',
    ),
    dirtyFiles,
  };
}

/**
 * Attempt git pull with auto-resolution on failure.
 *
 * Strategy:
 * 1. Try git pull --ff-only
 * 2. On failure: check for dirty working tree
 * 3. If dirty: stash changes, retry pull
 * 4. Report every action to Telegram
 */
export function gitPullWithAutoResolve(repoPath: string): AutoResolveResult {
  const run = (cmd: string): string =>
    execSync(cmd, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();

  // Attempt 1: Normal pull
  try {
    run('git pull --ff-only origin main 2>&1');
    return {
      pulled: true,
      resolved: false,
      action: 'none',
      diagnosis: '',
      dirtyFiles: [],
    };
  } catch (err) {
    const errorMsg = String(err);
    logger.warn('git pull --ff-only failed, attempting auto-resolution');

    // Check working tree state
    let status: string;
    try {
      status = run('git status --porcelain');
    } catch {
      return {
        pulled: false,
        resolved: false,
        action: 'none',
        diagnosis: 'Cannot read git status',
        dirtyFiles: [],
      };
    }

    const dirtyFiles = status
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim());

    if (!status) {
      // Clean tree but pull still failed — diverged history or network issue
      return {
        pulled: false,
        resolved: false,
        action: 'none',
        diagnosis: `Pull failed with clean tree: ${errorMsg.slice(0, 300)}`,
        dirtyFiles: [],
      };
    }

    // Attempt 2: Stash dirty files and retry
    try {
      run(
        'git stash push -u -m "nanoclaw-auto-resolve: dirty tree blocking pull"',
      );
      logger.info({ dirtyFiles }, 'Stashed dirty files for auto-resolution');

      try {
        run('git pull --ff-only origin main 2>&1');

        // Pull succeeded — try to pop stash (may conflict)
        try {
          run('git stash pop');
          logger.info('Stash popped successfully after pull');
        } catch {
          // Stash pop conflicts — drop the stash (changes were blocking anyway)
          logger.warn(
            'Stash pop failed (conflicts), dropping stash — changes were blocking pull',
          );
          run('git stash drop');
        }

        return {
          pulled: true,
          resolved: true,
          action: 'stash',
          diagnosis: `Auto-resolved: stashed ${dirtyFiles.length} dirty file(s) to unblock pull`,
          dirtyFiles,
        };
      } catch (pullErr) {
        // Pull still failed after stash — restore stash and report
        try {
          run('git stash pop');
        } catch {
          /* ignore pop failure */
        }
        return {
          pulled: false,
          resolved: false,
          action: 'stash',
          diagnosis: `Stash + pull failed: ${String(pullErr).slice(0, 300)}`,
          dirtyFiles,
        };
      }
    } catch (stashErr) {
      // Stash itself failed
      return {
        pulled: false,
        resolved: false,
        action: 'none',
        diagnosis: `git stash failed: ${String(stashErr).slice(0, 300)}`,
        dirtyFiles,
      };
    }
  }
}

/**
 * Generate LLM-powered error diagnosis via MiniMax.
 * Returns a human-readable analysis of what went wrong and what to do.
 */
export async function diagnoseErrorWithMiniMax(
  context: GitDiagnosticContext,
  consecutiveErrors: number,
  minimaxKey: string,
): Promise<string> {
  const prompt = `You are a DevOps diagnostic assistant for the NanoClaw CI/CD orchestrator.

The orchestrator has failed ${consecutiveErrors} consecutive times. Analyze the situation and provide:
1. ROOT CAUSE (1-2 sentences)
2. IMPACT (what's blocked)
3. AUTO-FIX ATTEMPTED (if any)
4. RECOMMENDED ACTION (specific command or step)

Context:
- Git branch: ${context.branch}
- Git status (dirty files): ${context.status || '(clean)'}
- Remote commits ahead: ${context.remoteStatus || '(none)'}
- Stash list: ${context.stashList || '(empty)'}
- Last error: ${context.lastError.slice(0, 500)}

Be concise. Use plain text, no markdown. Max 4 lines.`;

  try {
    const response = await queryMiniMax(prompt, minimaxKey);
    return response.trim().slice(0, 600);
  } catch (err) {
    logger.warn({ err }, 'MiniMax diagnosis failed');
    await notify(
      `<b>⚠️ MiniMax Diagnosis Failed</b>\n\n<code>${escapeHtml(String(err).slice(0, 200))}</code>\n\nFalling back to raw error output.`,
    );
    return `Diagnosis unavailable (MiniMax error). Last error: ${context.lastError.slice(0, 200)}`;
  }
}

/**
 * Send auto-resolution report to Telegram with full context.
 */
export async function reportAutoResolution(
  result: AutoResolveResult,
  consecutiveErrors: number,
  botToken: string,
  chatId: string,
): Promise<void> {
  const icon = result.pulled ? '🔧' : '🚨';
  const status = result.pulled ? 'Auto-Resolved' : 'Resolution Failed';

  const lines = [
    `<b>${icon} NanoClaw: ${status}</b>`,
    ``,
    `<b>Action</b>: <code>${result.action}</code>`,
    `<b>Consecutive errors</b>: <code>${consecutiveErrors}</code>`,
  ];

  if (result.dirtyFiles.length > 0) {
    lines.push(
      `<b>Dirty files</b>:`,
      ...result.dirtyFiles
        .slice(0, 5)
        .map((f) => `  • <code>${escapeHtml(f)}</code>`),
    );
    if (result.dirtyFiles.length > 5) {
      lines.push(`  <i>… +${result.dirtyFiles.length - 5} more</i>`);
    }
  }

  lines.push(``, `<i>${escapeHtml(result.diagnosis)}</i>`);
  lines.push(
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  );

  await sendTelegramNotification(lines.join('\n'), botToken, chatId);
}

/**
 * Send LLM-generated error diagnosis to Telegram.
 */
export async function reportErrorDiagnosis(
  diagnosis: string,
  consecutiveErrors: number,
  botToken: string,
  chatId: string,
): Promise<void> {
  const lines = [
    `<b>🧠 NanoClaw Diagnosis (${consecutiveErrors} failures)</b>`,
    ``,
    `<i>${escapeHtml(diagnosis)}</i>`,
    ``,
    `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
  ];

  await sendTelegramNotification(lines.join('\n'), botToken, chatId);
}
