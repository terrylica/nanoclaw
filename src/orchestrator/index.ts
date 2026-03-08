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

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  getChangedFiles,
  getCommitLog,
  getDiff,
  getGitBranch,
  getHeadCommit,
  gitPull,
} from './git-ops.js';
import { suggestLabels, createGitHubIssue, issueExistsFuzzy } from './github-issues.js';
import { syncCcSkills, runClaudeMdMaintenance } from './maintenance.js';
import { setTargetRepo, syncFalsePositivePatterns, verifyFindingScript, validateWithClaude } from './pipeline.js';
import { runAlgoScanCycle, runProactiveScanCycle } from './scanning.js';
import { loadState, saveState, rotateLogIfNeeded, checkRateLimit } from './state.js';
import {
  getSemanticDiffs,
  runAstGrepOnFiles,
  runOpenGrepOnFiles,
} from './static-analysis.js';
import {
  sendTelegramNotification,
  escapeHtml,
  formatHeartbeat,
  formatCycleStart,
  formatTriageResult,
  formatFindingNotification,
  formatCycleSummary,
} from './telegram.js';
import { triageChanges } from './triage.js';
import {
  ALGO_SCAN_INTERVAL_MS,
  CYCLE_COOLDOWN_ERROR_MS,
  CYCLE_COOLDOWN_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_ISSUES_PER_HOUR,
  PROACTIVE_SCAN_INTERVAL_MS,
  traceId,
} from './types.js';

export type { OrchestratorConfig } from './types.js';

export async function startOrchestratorLoop(config: {
  repoPath: string;
  githubRepo?: string;
}): Promise<never> {
  const env = readEnvFile([
    'MINIMAX_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'CC_SKILLS_PATH',
    'GITHUB_REPO',
  ]);
  const minimaxKey = process.env.MINIMAX_API_KEY || env.MINIMAX_API_KEY || '';
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID || '';
  const ccSkillsPath = process.env.CC_SKILLS_PATH || env.CC_SKILLS_PATH || '';

  // Resolve target GitHub repo
  let targetRepo =
    config.githubRepo || process.env.GITHUB_REPO || env.GITHUB_REPO || '';
  if (!targetRepo) {
    try {
      const remote = execSync('git remote get-url origin', {
        cwd: config.repoPath,
        encoding: 'utf-8',
        timeout: 5_000,
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

  if (ccSkillsPath) {
    syncCcSkills(ccSkillsPath);
    logger.info({ ccSkillsPath }, 'cc-skills path configured');
  }

  syncFalsePositivePatterns();

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
        `• Repo: <code>opendeviationbar-py</code>`,
        `• Branch: <code>${branch}</code>`,
        `• From commit: <code>${state.lastCheckedCommit.slice(0, 7)}</code>`,
        `• Mode: continuous diff-driven (MiniMax + Claude)`,
        `• Rate limit: <code>${MAX_ISSUES_PER_HOUR}/hr</code>`,
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

        if (ccSkillsPath) syncCcSkills(ccSkillsPath);
        syncFalsePositivePatterns();
        rotateLogIfNeeded();
      }

      // Step 1: git pull
      const pulled = gitPull(config.repoPath);
      if (!pulled) {
        state.consecutiveErrors++;
        saveState(state);
        const backoff = Math.min(
          CYCLE_COOLDOWN_ERROR_MS * Math.pow(2, state.consecutiveErrors - 1),
          10 * 60_000,
        );
        logger.warn({ backoff }, 'Backing off after git pull failure');
        await sleep(backoff);
        continue;
      }

      // Step 2: Check for changes
      const headCommit = getHeadCommit(config.repoPath);
      if (headCommit === state.lastCheckedCommit) {
        const now = Date.now();

        const lastEnhScan = state.lastProactiveScan
          ? new Date(state.lastProactiveScan).getTime()
          : 0;
        if (now - lastEnhScan >= PROACTIVE_SCAN_INTERVAL_MS && minimaxKey) {
          await runProactiveScanCycle(
            config,
            state,
            minimaxKey,
            botToken,
            chatId,
          );
        }

        const lastAlgoScan = state.lastAlgoScan
          ? new Date(state.lastAlgoScan).getTime()
          : 0;
        if (now - lastAlgoScan >= ALGO_SCAN_INTERVAL_MS && minimaxKey) {
          await runAlgoScanCycle(config, state, minimaxKey, botToken, chatId);
        }

        await sleep(CYCLE_COOLDOWN_MS);
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
      saveState(state);

      const backoff = Math.min(
        CYCLE_COOLDOWN_ERROR_MS * Math.pow(2, state.consecutiveErrors - 1),
        10 * 60_000,
      );
      logger.error(
        { err, backoff, consecutiveErrors: state.consecutiveErrors },
        'Orchestrator cycle error',
      );

      if (state.consecutiveErrors >= 3 && botToken && chatId) {
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
      }

      await sleep(backoff);
      continue;
    }

    await sleep(CYCLE_COOLDOWN_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
