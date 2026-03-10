/**
 * CLAUDE.md maintenance and cc-skills synchronization.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { setCcSkillsContent } from './github-issues.js';
import { getTargetRepo } from './pipeline.js';
import { escapeHtml, notify, sendTelegramNotification } from './telegram.js';

// --- cc-skills Sync ---

export function syncCcSkills(ccSkillsPath: string): void {
  if (!ccSkillsPath || !fs.existsSync(ccSkillsPath)) return;
  try {
    execSync('git pull --ff-only origin main 2>&1', {
      cwd: ccSkillsPath,
      timeout: 60_000,
      encoding: 'utf-8',
    });

    const labelStrategyPath = path.join(
      ccSkillsPath,
      'plugins/gh-tools/skills/issue-create/references/label-strategy.md',
    );
    const contentTypesPath = path.join(
      ccSkillsPath,
      'plugins/gh-tools/skills/issue-create/references/content-types.md',
    );

    let labelStrategy = '';
    let contentTypes = '';

    if (fs.existsSync(labelStrategyPath)) {
      labelStrategy = fs
        .readFileSync(labelStrategyPath, 'utf-8')
        .slice(0, 2000);
    }
    if (fs.existsSync(contentTypesPath)) {
      contentTypes = fs.readFileSync(contentTypesPath, 'utf-8').slice(0, 2000);
    }

    setCcSkillsContent(labelStrategy, contentTypes);

    logger.info(
      {
        path: ccSkillsPath,
        hasLabelStrategy: !!labelStrategy,
        hasContentTypes: !!contentTypes,
      },
      'cc-skills synced and references loaded',
    );
  } catch (err) {
    logger.warn({ err }, 'cc-skills sync failed (non-fatal)');
    notify(
      `<b>⚠️ cc-skills Sync Failed</b>\n\n<code>${escapeHtml(String(err).slice(0, 200))}</code>`,
    ).catch(() => {});
  }
}

// --- CLAUDE.md Maintenance ---

const CLAUDE_MD_MAINTENANCE_TIMEOUT_MS = 10 * 60 * 1000;

const CLAUDE_MD_META_PROMPT = `You are going to autonomously migrate/rectify/prune/update/grow root Project Memory CLAUDE.md file in the project root.

The purpose is to maximize autonomous discovery by other Anthropic's Claude Code CLI AI coding sessions that are new to our project.

The prefer pattern is that CLAUDE.md file in the project root folder act as a Link Farm + Hub-and-Spoke with Progressive Disclosure (essentials only, each doc links deeper, single source of truth per topic) to nested Project Memory (CLAUDE.md files in the children of the directory of our project root directory). Claude will pull in CLAUDE.md files on demand when we work with files in child directories.

Hence, migrate/rectify/prune/update/grow those nested Project Memory CLAUDE.md files, too, so that we can take advantage of the Link Farm + Hub-and-Spoke with Progressive Disclosure starting from the root Project Memory CLAUDE.md file.

CONTEXT ON WHAT CHANGED:
The following files were modified in recent commits. Use this to understand what areas of the project need CLAUDE.md updates:

CHANGED_FILES_PLACEHOLDER

INSTRUCTIONS:
1. Read the root CLAUDE.md and all nested CLAUDE.md files
2. Read the changed files to understand what the changes do
3. Update CLAUDE.md files to reflect new patterns, APIs, configurations, or architectural changes
4. Ensure the root CLAUDE.md links to all nested CLAUDE.md files (hub-and-spoke)
5. Prune outdated information that no longer reflects the codebase
6. Add new sections for new directories/modules that lack CLAUDE.md coverage
7. Keep each CLAUDE.md focused on its directory scope — essentials only, link deeper for details
8. Do NOT add trivial or self-evident information — only document what aids autonomous discovery

OUTPUT:
Respond with a brief summary of what you changed (or "No changes needed" if the CLAUDE.md files are already up to date).`;

export async function runClaudeMdMaintenance(
  repoPath: string,
  changedFiles: string[],
  headCommit: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const targetRepo = getTargetRepo();
  const fileList = changedFiles.map((f) => `  - ${f}`).join('\n');
  const prompt = CLAUDE_MD_META_PROMPT.replace(
    'CHANGED_FILES_PLACEHOLDER',
    fileList,
  );

  logger.info(
    { changedFiles: changedFiles.length },
    'Running CLAUDE.md maintenance via Claude',
  );

  if (botToken && chatId) {
    await sendTelegramNotification(
      [
        `<b>📝 CLAUDE.md Maintenance</b>`,
        ``,
        `Updating project memory for <code>${changedFiles.length}</code> changed files...`,
      ].join('\n'),
      botToken,
      chatId,
    );
  }

  try {
    const result = spawnSync(
      'claude',
      [
        '-p',
        '--output-format',
        'text',
        '--allowedTools',
        'Edit,Write,Read,Glob,Grep',
      ],
      {
        input: prompt,
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: CLAUDE_MD_MAINTENANCE_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    if (result.error || result.status !== 0) {
      logger.error(
        {
          error: result.error?.message || result.stderr?.slice(0, 200),
          status: result.status,
        },
        'CLAUDE.md maintenance failed',
      );
      if (botToken && chatId) {
        await sendTelegramNotification(
          [
            `<b>📝 CLAUDE.md Maintenance — Failed</b>`,
            ``,
            `<code>${escapeHtml((result.error?.message || result.stderr || 'Unknown error').slice(0, 200))}</code>`,
          ].join('\n'),
          botToken,
          chatId,
        );
      }
      return;
    }

    const output = result.stdout.trim();
    const summary = output.slice(0, 500);
    const isNoChanges =
      output.toLowerCase().includes('no changes needed') ||
      output.toLowerCase().includes('already up to date');

    logger.info({ summary, isNoChanges }, 'CLAUDE.md maintenance complete');

    // Commit and push CLAUDE.md changes to remote.
    // CRITICAL: If commit/push fails, REVERT changes to keep working tree clean.
    // A dirty working tree blocks git pull --ff-only and stalls the orchestrator.
    if (!isNoChanges) {
      const commitShort = headCommit.slice(0, 7);
      let committed = false;
      try {
        // Stage only CLAUDE.md files (never stage unrelated changes)
        execSync('git add -A -- "**/CLAUDE.md" "CLAUDE.md"', {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 30_000,
        });
        const hasStagedChanges = execSync(
          'git diff --cached --quiet || echo "dirty"',
          { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 },
        ).trim();
        if (hasStagedChanges === 'dirty') {
          execSync(
            `git commit -m "docs: update CLAUDE.md project memory (${commitShort})"`,
            { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 },
          );
          committed = true;
          execSync('git push', {
            cwd: repoPath,
            encoding: 'utf-8',
            timeout: 120_000,
          });
          logger.info('CLAUDE.md changes committed and pushed');
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to commit/push CLAUDE.md changes — reverting to keep tree clean',
        );
        // Revert uncommitted CLAUDE.md changes to prevent stalling git pull
        try {
          if (committed) {
            // Committed but push failed — reset the commit
            execSync('git reset --soft HEAD~1', {
              cwd: repoPath,
              encoding: 'utf-8',
              timeout: 30_000,
            });
          }
          // Discard all CLAUDE.md changes from working tree
          execSync(
            'git checkout -- "**/CLAUDE.md" "CLAUDE.md" 2>/dev/null || true',
            {
              cwd: repoPath,
              encoding: 'utf-8',
              timeout: 30_000,
            },
          );
          logger.info('CLAUDE.md changes reverted to keep working tree clean');
        } catch (revertErr) {
          logger.error(
            { revertErr },
            'Failed to revert CLAUDE.md changes — working tree may be dirty',
          );
        }
        if (botToken && chatId) {
          await sendTelegramNotification(
            [
              `<b>⚠️ CLAUDE.md Maintenance — Reverted</b>`,
              ``,
              `Commit/push failed. Changes reverted to keep tree clean.`,
              `<code>${escapeHtml(String(err).slice(0, 200))}</code>`,
            ].join('\n'),
            botToken,
            chatId,
          );
        }
      }
    }

    let issueUrl: string | null = null;
    if (!isNoChanges && targetRepo) {
      const commitShort = headCommit.slice(0, 7);
      const issueBody = `---
nanoclaw-type: claude-md-maintenance
files:
${changedFiles.map((f) => `  - ${f}`).join('\n')}
commit: ${commitShort}
---

## CLAUDE.md Maintenance

Triggered by ${changedFiles.length} changed file${changedFiles.length !== 1 ? 's' : ''} in commit \`${commitShort}\`.

### Changes Made

${output.slice(0, 3000)}

### Changed Files That Triggered This Update

${changedFiles.map((f) => `- \`${f}\``).join('\n')}

---
*Auto-created by [NanoClaw](https://github.com/terrylica/nanoclaw) CLAUDE.md maintenance*`;

      const title = `docs: CLAUDE.md maintenance for ${commitShort} — ${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} changed`;
      try {
        const tmpFile = path.join(DATA_DIR, 'claude-md-issue.tmp.md');
        fs.writeFileSync(tmpFile, issueBody);
        const ghResult = execSync(
          `gh issue create --repo ${targetRepo} --title "${title.replace(/"/g, '\\"')}" --label "nanoclaw,documentation" --body-file "${tmpFile}"`,
          { cwd: repoPath, encoding: 'utf-8', timeout: 60_000 },
        );
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
        issueUrl = ghResult.trim();
        logger.info({ issueUrl }, 'CLAUDE.md maintenance issue created');
      } catch (err) {
        logger.warn({ err }, 'Failed to create CLAUDE.md maintenance issue');
        await notify(
          `<b>⚠️ CLAUDE.md Issue Creation Failed</b>\n\n<code>${escapeHtml(String(err).slice(0, 200))}</code>`,
        );
      }
    }

    if (botToken && chatId) {
      const lines = [
        `<b>📝 CLAUDE.md Maintenance — Done</b>`,
        ``,
        `<i>${escapeHtml(summary)}</i>`,
      ];
      if (issueUrl) {
        lines.push(``, `<b>📋 Issue</b>: ${issueUrl}`);
      }
      await sendTelegramNotification(lines.join('\n'), botToken, chatId);
    }
  } catch (err) {
    logger.error({ err }, 'CLAUDE.md maintenance error');
  }
}
