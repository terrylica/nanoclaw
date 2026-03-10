/**
 * NanoClaw Orchestrator — Main Loop
 *
 * Continuous diff-driven validation of opendeviationbar-py:
 * 1. git pull → git diff since last check
 * 2. MiniMax M2.5-highspeed triages changed files (cheap, fast)
 * 3. Claude Code validates each finding via `claude -p` (deep, subscription)
 * 4. Only confirmed findings → GitHub Issue + Telegram notification
 *
 * Safety: rate limiting, fuzzy dedup, exponential backoff, severity gating.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  gitPullWithAutoResolve,
  getGitDiagnosticContext,
  diagnoseErrorWithMiniMax,
  reportAutoResolution,
  reportErrorDiagnosis,
} from './auto-resolve.js';
import {
  getChangedFiles,
  getCommitLog,
  getDiff,
  getGitBranch,
  getHeadCommit,
} from './git-ops.js';
import {
  suggestLabels,
  createGitHubIssue,
  issueExistsFuzzy,
} from './github-issues.js';
import { runClaudeMdMaintenance } from './maintenance.js';
import {
  setTargetRepo,
  syncFalsePositivePatterns,
  verifyFindingScript,
  validateWithClaude,
} from './pipeline.js';
import {
  loadState,
  saveState,
  rotateLogIfNeeded,
  checkRateLimit,
} from './state.js';
import {
  getSemanticDiffs,
  runAstGrepOnFiles,
  runOpenGrepOnFiles,
} from './static-analysis.js';
import {
  sendTelegramNotification,
  initGlobalNotifier,
  escapeHtml,
  formatHeartbeat,
  formatCycleStart,
  formatTriageResult,
  formatFindingNotification,
  formatCycleSummary,
} from './telegram.js';
import { triageChanges } from './triage.js';
import {
  CYCLE_COOLDOWN_ERROR_MS,
  CYCLE_COOLDOWN_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_ISSUES_PER_HOUR,
  traceId,
} from './types.js';
import {
  initEvolutionEngine,
  tick as evolutionTick,
  getEvolutionStatus,
} from './evolution/engine.js';
import { loadEvolutionState } from './evolution/state.js';
import { seedIfEmpty, loadAllPrompts } from './evolution/prompt-registry.js';
import { SEED_PROMPTS } from './evolution/seed-prompts.js';
import { initFeedbackHandler } from './evolution/telegram-feedback.js';
import { canCallMiniMax } from './evolution/rpm-tracker.js';

export type { OrchestratorConfig } from './types.js';

export async function startOrchestratorLoop(config: {
  repoPath: string;
  githubRepo?: string;
}): Promise<never> {
  const env = readEnvFile([
    'MINIMAX_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'GITHUB_REPO',
  ]);
  const minimaxKey = process.env.MINIMAX_API_KEY || env.MINIMAX_API_KEY || '';
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '';

  // Expose MINIMAX_API_KEY in process.env for Pi SDK (reads env vars directly)
  if (minimaxKey && !process.env.MINIMAX_API_KEY) {
    process.env.MINIMAX_API_KEY = minimaxKey;
  }

  // Resolve target GitHub repo
  let targetRepo =
    config.githubRepo || process.env.GITHUB_REPO || env.GITHUB_REPO || '';
  if (!targetRepo) {
    try {
      const remote = execSync('git remote get-url origin', {
        cwd: config.repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
      }).trim();
      const match = remote.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (match) targetRepo = `${match[1]}/${match[2]}`;
    } catch {
      /* ignore */
    }
  }
  if (!targetRepo) {
    logger.fatal(
      'GITHUB_REPO not set and could not auto-detect from git remote — orchestrator cannot start',
    );
    process.exit(1);
  }
  setTargetRepo(targetRepo);
  logger.info({ githubRepo: targetRepo }, 'Target GitHub repo resolved');

  if (!minimaxKey) {
    logger.fatal('MINIMAX_API_KEY not set — orchestrator cannot start');
    process.exit(1);
  }

  // Initialize global notifier so all modules can send Telegram messages
  initGlobalNotifier(botToken, chatId);

  const state = loadState();
  if (!state.startedAt) state.startedAt = new Date().toISOString();

  if (!state.lastCheckedCommit) {
    state.lastCheckedCommit = getHeadCommit(config.repoPath);
    saveState(state);
    logger.info(
      { commit: state.lastCheckedCommit },
      'Orchestrator initialized at current HEAD',
    );
  }

  syncFalsePositivePatterns();

  // Initialize evolution engine
  seedIfEmpty(SEED_PROMPTS);
  loadAllPrompts();
  const evoState = loadEvolutionState();
  initEvolutionEngine(evoState);
  if (botToken) {
    initFeedbackHandler(botToken);
  }

  // Startup guard: repair node_modules if corrupted (self-referential symlink from crashed goals)
  try {
    const nmPath = path.join(config.repoPath, 'node_modules');
    const nmStat = fs.lstatSync(nmPath);
    if (nmStat.isSymbolicLink()) {
      logger.warn('Startup: node_modules is a symlink — repairing');
      fs.rmSync(nmPath, { force: true });
      execSync('bun install', {
        cwd: config.repoPath,
        timeout: 120_000,
        env: { ...process.env, MISE_NO_CONFIG: '1' },
      });
    }
  } catch {
    /* node_modules doesn't exist or check failed — non-fatal */
  }

  // Startup guard: clean up stale goal worktrees from crashed sessions
  try {
    const { cleanupStaleWorktrees } = await import(
      './evolution/goal-worktree.js'
    );
    const cleaned = cleanupStaleWorktrees(config.repoPath);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Startup: cleaned stale goal worktrees');
    }
  } catch {
    /* non-fatal */
  }

  logger.info(
    {
      repoPath: config.repoPath,
      lastCommit: state.lastCheckedCommit.slice(0, 7),
      cycleCount: state.cycleCount,
    },
    'Orchestrator loop starting',
  );

  // Startup notification
  if (botToken && chatId) {
    const branch = getGitBranch(config.repoPath);
    await sendTelegramNotification(
      [
        `<b>🚀 NanoClaw Orchestrator Started</b>`,
        ``,
        `• Repo: <code>nanoclaw</code> (self-evolution)`,
        `• Branch: <code>${branch}</code>`,
        `• From commit: <code>${state.lastCheckedCommit.slice(0, 7)}</code>`,
        `• Mode: autonomous self-evolution (MiniMax + Claude)`,
        `• Rate limit: <code>${MAX_ISSUES_PER_HOUR}/hr</code>`,
        ``,
        `<i>${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false })}</i>`,
      ].join('\n'),
      botToken,
      chatId,
    );
  }

  // Graceful shutdown on SIGTERM/SIGINT (systemd sends SIGTERM)
  let shuttingDown = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal: sig }, 'Graceful shutdown requested');
      saveState(state);
      process.exit(0);
    });
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
        const evoStatus = getEvolutionStatus();
        const evoStats = {
          paused: evoStatus.paused,
          consecutiveFailures: evoStatus.consecutiveFailures,
          goalsQueued: evoStatus.goalsQueued,
          promptCount: evoStatus.promptMetrics.length,
          totalUses: evoStatus.promptMetrics.reduce(
            (sum: number, m: { uses: number }) => sum + m.uses,
            0,
          ),
        };
        await sendTelegramNotification(
          formatHeartbeat(state, branch, evoStats),
          botToken,
          chatId,
        );
        state.lastHeartbeat = new Date().toISOString();
        saveState(state);

        syncFalsePositivePatterns();
        rotateLogIfNeeded();
      }

      // Step 1: git pull with auto-resolution
      const pullResult = gitPullWithAutoResolve(config.repoPath);

      // Report auto-resolution actions to Telegram
      if (pullResult.resolved && botToken && chatId) {
        await reportAutoResolution(
          pullResult,
          state.consecutiveErrors,
          botToken,
          chatId,
        );
      }

      if (!pullResult.pulled) {
        state.consecutiveErrors++;
        state.lastErrorMessage = pullResult.diagnosis;
        saveState(state);

        const backoff = Math.min(
          CYCLE_COOLDOWN_ERROR_MS * Math.pow(2, state.consecutiveErrors - 1),
          10 * 60_000,
        );

        // LLM-generated diagnosis at escalation thresholds (3, 10, 50, then every 50)
        const shouldDiagnose =
          state.consecutiveErrors === 3 ||
          state.consecutiveErrors === 10 ||
          state.consecutiveErrors === 50 ||
          state.consecutiveErrors % 50 === 0;

        if (shouldDiagnose && minimaxKey && botToken && chatId) {
          const diagCtx = getGitDiagnosticContext(
            config.repoPath,
            pullResult.diagnosis,
          );
          const diagnosis = await diagnoseErrorWithMiniMax(
            diagCtx,
            state.consecutiveErrors,
            minimaxKey,
          );
          state.lastDiagnosisAt = new Date().toISOString();
          saveState(state);
          await reportErrorDiagnosis(
            diagnosis,
            state.consecutiveErrors,
            botToken,
            chatId,
          );
        }

        logger.warn(
          { backoff, errors: state.consecutiveErrors },
          'Backing off after git pull failure',
        );
        await sleep(backoff);
        continue;
      }

      // Pull succeeded — reset error state
      if (state.consecutiveErrors > 0) {
        logger.info(
          { previousErrors: state.consecutiveErrors },
          'Git pull recovered after errors',
        );
        if (botToken && chatId) {
          await sendTelegramNotification(
            [
              `<b>✅ NanoClaw: Recovered</b>`,
              ``,
              `Git pull succeeded after <code>${state.consecutiveErrors}</code> consecutive failures.`,
              pullResult.resolved
                ? `Auto-resolved via: <code>${pullResult.action}</code>`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
            botToken,
            chatId,
          );
        }
        state.consecutiveErrors = 0;
        state.lastErrorMessage = undefined;
        state.lastDiagnosisAt = undefined;
        saveState(state);
      }

      // Step 2: Check for changes
      const headCommit = getHeadCommit(config.repoPath);
      if (headCommit === state.lastCheckedCommit) {
        // Evolution engine — self-scan, prompt evolution, goal execution, research, repo hygiene
        if (minimaxKey && canCallMiniMax()) {
          await evolutionTick(state, minimaxKey, config);
        }

        // Minimal yield — evolution steps have their own cooldowns, no hardcoded wait needed
        await sleep(100);
        continue;
      }

      const changedFiles = getChangedFiles(
        config.repoPath,
        state.lastCheckedCommit,
      );
      if (changedFiles.length === 0) {
        state.lastCheckedCommit = headCommit;
        state.cycleCount++;
        saveState(state);
        continue;
      }

      const cycleTid = traceId();

      const diff = getDiff(config.repoPath, state.lastCheckedCommit);
      const commitLog = getCommitLog(config.repoPath, state.lastCheckedCommit);
      const semanticDiff = getSemanticDiffs(
        config.repoPath,
        state.lastCheckedCommit,
        changedFiles,
      );
      const astGrepFindings = runAstGrepOnFiles(config.repoPath, changedFiles);
      const openGrepFindings = runOpenGrepOnFiles(
        config.repoPath,
        changedFiles,
      );

      logger.info(
        {
          traceId: cycleTid,
          files: changedFiles.length,
          commits: commitLog.split('\n').length,
          from: state.lastCheckedCommit.slice(0, 7),
          to: headCommit.slice(0, 7),
          hasDifftastic: semanticDiff.length > 0,
          hasAstGrep: astGrepFindings.length > 0,
          hasOpenGrep: openGrepFindings.length > 0,
        },
        'Changes detected, triaging with MiniMax',
      );

      if (botToken && chatId) {
        await sendTelegramNotification(
          `<code>[${cycleTid}]</code> ` +
            formatCycleStart(
              state.lastCheckedCommit,
              headCommit,
              changedFiles,
              state.cycleCount + 1,
            ),
          botToken,
          chatId,
        );
      }

      // Step 3: MiniMax triage
      const triage = await triageChanges(
        diff,
        commitLog,
        changedFiles,
        minimaxKey,
        config.repoPath,
        semanticDiff || undefined,
        astGrepFindings || undefined,
        openGrepFindings || undefined,
      );

      logger.info(
        { findingCount: triage.findings.length, summary: triage.summary },
        'MiniMax triage complete',
      );

      if (botToken && chatId) {
        await sendTelegramNotification(
          `<code>[${cycleTid}]</code> ` +
            formatTriageResult(
              triage.findings.length,
              triage.summary,
              state.cycleCount + 1,
            ),
          botToken,
          chatId,
        );
      }

      // Step 4: Validate and create issues
      const cycleSkipped: string[] = [];
      let cycleValidated = 0;
      let cycleRejected = 0;
      let cycleIssues = 0;
      for (const finding of triage.findings) {
        if (!checkRateLimit(state)) {
          logger.warn(
            { limit: MAX_ISSUES_PER_HOUR },
            'Hourly issue rate limit reached, skipping remaining findings',
          );
          cycleSkipped.push('Rate limit reached');
          break;
        }

        if (issueExistsFuzzy(finding.title)) {
          logger.info({ title: finding.title }, 'Skipping duplicate finding');
          cycleSkipped.push(`Duplicate: ${finding.title.slice(0, 60)}`);
          continue;
        }

        const scriptCheck = verifyFindingScript(finding, config.repoPath);
        if (!scriptCheck.verified) {
          state.findingsRejected++;
          cycleRejected++;
          cycleSkipped.push(`Script fail: ${finding.title.slice(0, 60)}`);
          logger.info(
            { title: finding.title, reason: scriptCheck.output },
            'Finding failed verification script — likely hallucinated',
          );
          continue;
        }

        const validation = validateWithClaude(
          finding,
          config.repoPath,
          headCommit,
        );

        if (!validation) {
          logger.warn(
            { title: finding.title },
            'Skipping finding — Claude validation unavailable',
          );
          cycleSkipped.push(`Claude unavail: ${finding.title.slice(0, 60)}`);
          continue;
        }

        if (!validation.confirmed) {
          state.findingsRejected++;
          cycleRejected++;
          cycleSkipped.push(`Rejected: ${finding.title.slice(0, 60)}`);
          logger.info(
            {
              title: finding.title,
              analysis: validation.analysis.slice(0, 100),
            },
            'Finding rejected by Claude',
          );
          continue;
        }

        if (validation.confidence === 'low') {
          state.findingsRejected++;
          cycleRejected++;
          cycleSkipped.push(`Low confidence: ${finding.title.slice(0, 60)}`);
          logger.info(
            { title: finding.title },
            'Finding has low confidence, skipping',
          );
          continue;
        }

        state.findingsValidated++;
        cycleValidated++;

        const labels = await suggestLabels(finding, validation, minimaxKey);

        const issueUrl = createGitHubIssue(
          finding,
          validation,
          config.repoPath,
          headCommit,
          labels,
        );

        if (issueUrl) {
          state.issuesCreated++;
          if (!state.issueTimestamps) state.issueTimestamps = [];
          state.issueTimestamps.push(Date.now());
          cycleIssues++;
        }

        if (botToken && chatId) {
          await sendTelegramNotification(
            `<code>[${cycleTid}]</code> ` +
              formatFindingNotification(finding, validation, issueUrl),
            botToken,
            chatId,
          );
        }
      }

      if (triage.findings.length > 0 && botToken && chatId) {
        await sendTelegramNotification(
          `<code>[${cycleTid}]</code> ` +
            formatCycleSummary(
              state.cycleCount + 1,
              triage.findings.length,
              cycleValidated,
              cycleRejected,
              cycleIssues,
              cycleSkipped,
            ),
          botToken,
          chatId,
        );
      }

      // CLAUDE.md maintenance
      await runClaudeMdMaintenance(
        config.repoPath,
        changedFiles,
        headCommit,
        botToken,
        chatId,
      );

      // Advance state
      state.lastCheckedCommit = headCommit;
      state.cycleCount++;
      state.consecutiveErrors = 0;
      saveState(state);

      logger.info(
        {
          cycle: state.cycleCount,
          findings: triage.findings.length,
          validated: state.findingsValidated,
          rejected: state.findingsRejected,
          issuesTotal: state.issuesCreated,
        },
        'Cycle complete',
      );
    } catch (err) {
      state.consecutiveErrors++;
      state.lastErrorMessage = String(err).slice(0, 300);
      saveState(state);

      const backoff = Math.min(
        CYCLE_COOLDOWN_ERROR_MS * Math.pow(2, state.consecutiveErrors - 1),
        10 * 60_000,
      );
      logger.error(
        { err, backoff, consecutiveErrors: state.consecutiveErrors },
        'Orchestrator cycle error',
      );

      // Escalating alerts: 1st error, then 3, 10, 50, then every 50
      const shouldAlert =
        state.consecutiveErrors === 1 ||
        state.consecutiveErrors === 3 ||
        state.consecutiveErrors === 10 ||
        state.consecutiveErrors === 50 ||
        state.consecutiveErrors % 50 === 0;

      if (shouldAlert && botToken && chatId) {
        // Send raw error alert
        await sendTelegramNotification(
          [
            `<b>⚠️ NanoClaw Error Alert</b>`,
            ``,
            `Consecutive failures: <code>${state.consecutiveErrors}</code>`,
            `Next retry in: <code>${Math.round(backoff / 1000)}s</code>`,
            `Error: <code>${escapeHtml(String(err).slice(0, 200))}</code>`,
          ].join('\n'),
          botToken,
          chatId,
        );

        // LLM-generated diagnosis for deeper insight
        if (minimaxKey) {
          try {
            const diagCtx = getGitDiagnosticContext(
              config.repoPath,
              String(err),
            );
            const diagnosis = await diagnoseErrorWithMiniMax(
              diagCtx,
              state.consecutiveErrors,
              minimaxKey,
            );
            state.lastDiagnosisAt = new Date().toISOString();
            saveState(state);
            await reportErrorDiagnosis(
              diagnosis,
              state.consecutiveErrors,
              botToken,
              chatId,
            );
          } catch (diagErr) {
            logger.warn({ err: diagErr }, 'MiniMax diagnosis failed');
          }
        }
      }

      await sleep(backoff);
      continue;
    }

    // Minimal yield between cycles — real work has its own pacing
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
