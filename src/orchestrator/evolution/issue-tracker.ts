/**
 * Issue landscape awareness.
 *
 * Periodically checks open issues for relevance, suggests closing
 * resolved ones, and identifies issues NanoClaw can help with.
 */
import { spawnSync } from 'child_process';

import { logger } from '../../logger.js';
import { queryMiniMax } from '../minimax-client.js';
import { notify } from '../telegram.js';

// --- Types ---

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  createdAt: string;
}

// --- Issue Fetching ---

/** Fetch open issues from GitHub */
export function fetchOpenIssues(githubRepo: string): GitHubIssue[] {
  try {
    const result = spawnSync(
      'gh',
      ['issue', 'list', '--repo', githubRepo, '--state', 'open', '--json', 'number,title,body,labels,createdAt', '--limit', '30'],
      { encoding: 'utf-8', timeout: 60_000 },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch open issues');
    return [];
  }
}

/** Check if an issue is still relevant given current codebase state */
export async function checkIssueRelevance(
  issue: GitHubIssue,
  apiKey: string,
): Promise<{
  stillRelevant: boolean;
  reason: string;
  canHelp: boolean;
}> {
  const prompt = `You are reviewing a GitHub issue for opendeviationbar-py.

ISSUE #${issue.number}: ${issue.title}
${issue.body?.slice(0, 1000) || '(no body)'}
Labels: ${issue.labels.map((l) => l.name).join(', ') || 'none'}
Created: ${issue.createdAt}

Questions:
1. Is this issue likely still relevant, or has it probably been addressed? (Consider: how old is it, is it a structural issue, etc.)
2. Could an automated code analysis tool help validate or fix this?

Respond with JSON: {"stillRelevant": true/false, "reason": "brief explanation", "canHelp": true/false}`;

  try {
    const raw = await queryMiniMax(prompt, apiKey);
    const jsonMatch = raw.match(/\{[\s\S]*"stillRelevant"[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logger.warn({ err, issue: issue.number }, 'Issue relevance check failed');
  }

  // Default: assume still relevant
  return {
    stillRelevant: true,
    reason: 'Check failed, assuming relevant',
    canHelp: false,
  };
}

/** Run issue landscape check */
export async function checkIssueLandscape(
  githubRepo: string,
  apiKey: string,
): Promise<{
  checked: number;
  possiblyResolved: number;
  canHelp: number;
}> {
  const issues = fetchOpenIssues(githubRepo);
  if (issues.length === 0) {
    return { checked: 0, possiblyResolved: 0, canHelp: 0 };
  }

  let possiblyResolved = 0;
  let canHelp = 0;

  // Check up to 5 issues per cycle to respect RPM
  for (const issue of issues.slice(0, 5)) {
    const result = await checkIssueRelevance(issue, apiKey);

    if (!result.stillRelevant) {
      possiblyResolved++;
      // Comment on issue suggesting closure
      try {
        spawnSync(
          'gh',
          ['issue', 'comment', String(issue.number), '--repo', githubRepo, '--body', `NanoClaw analysis suggests this issue may have been addressed: ${result.reason}`],
          { encoding: 'utf-8', timeout: 60_000 },
        );
      } catch {
        // Non-fatal
      }
    }

    if (result.canHelp) canHelp++;
  }

  if (possiblyResolved > 0) {
    await notify(
      [
        `<b>📋 Issue Landscape Check</b>`,
        ``,
        `Checked: <code>${Math.min(5, issues.length)}</code> of <code>${issues.length}</code> open issues`,
        `Possibly resolved: <code>${possiblyResolved}</code>`,
        `Can help with: <code>${canHelp}</code>`,
      ].join('\n'),
    );
  }

  return {
    checked: Math.min(5, issues.length),
    possiblyResolved,
    canHelp,
  };
}
