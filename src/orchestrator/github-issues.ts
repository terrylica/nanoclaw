/**
 * GitHub issue creation, label management, deduplication, and templates.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { extractWords, queryMiniMax } from './minimax-client.js';
import { getTargetRepo } from './pipeline.js';
import { escapeHtml, notify } from './telegram.js';
import type { Finding, ValidationResult } from './types.js';

// --- Label Cache ---

let cachedRepoLabels: string[] | null = null;
let labelsCacheTime = 0;
const LABEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// --- cc-skills Reference Content ---

export let ccSkillsLabelStrategy = '';
export let ccSkillsContentTypes = '';

export function setCcSkillsContent(
  labelStrategy: string,
  contentTypes: string,
): void {
  ccSkillsLabelStrategy = labelStrategy;
  ccSkillsContentTypes = contentTypes;
}

// --- Fuzzy Deduplication ---

export function issueExistsFuzzy(title: string): boolean {
  const targetRepo = getTargetRepo();
  try {
    const result = execSync(
      `gh issue list --repo ${targetRepo} --label nanoclaw --state all --limit 100 --json title`,
      { encoding: 'utf-8', timeout: 60_000 },
    );
    const issues = JSON.parse(result) as Array<{ title: string }>;

    const titleWords = extractWords(title);

    for (const issue of issues) {
      if (issue.title.toLowerCase() === title.toLowerCase()) return true;

      const issueWords = extractWords(issue.title);
      const intersection = titleWords.filter((w) => issueWords.includes(w));
      const union = new Set([...titleWords, ...issueWords]);
      const similarity = union.size > 0 ? intersection.length / union.size : 0;

      if (similarity >= 0.5) {
        logger.info(
          {
            existing: issue.title,
            new: title,
            similarity: similarity.toFixed(2),
          },
          'Fuzzy duplicate detected',
        );
        return true;
      }
    }
    return false;
  } catch (err) {
    logger.warn(
      { err, title },
      'Fuzzy dedup check failed — proceeding without dedup',
    );
    notify(
      `<b>⚠️ Dedup Check Failed</b>\n\nCould not query existing issues. Duplicate may be created.\n<code>${escapeHtml(String(err).slice(0, 150))}</code>`,
    ).catch((notifyErr: unknown) => { console.error('[github-issues] notify failed (dedup check):', notifyErr); });
    return false;
  }
}

// --- Label Taxonomy ---

function fetchRepoLabels(): string[] {
  const targetRepo = getTargetRepo();
  const now = Date.now();
  if (cachedRepoLabels && now - labelsCacheTime < LABEL_CACHE_TTL_MS) {
    return cachedRepoLabels;
  }
  try {
    const result = execSync(
      `gh label list --repo ${targetRepo} --json name --limit 100`,
      { encoding: 'utf-8', timeout: 60_000 },
    );
    const labels = JSON.parse(result) as Array<{ name: string }>;
    cachedRepoLabels = labels.map((l) => l.name);
    labelsCacheTime = now;
    logger.info({ count: cachedRepoLabels.length }, 'Repo labels fetched');
    return cachedRepoLabels;
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch repo labels');
    notify(
      `<b>⚠️ Label Fetch Failed</b>\n\nUsing ${cachedRepoLabels ? 'cached' : 'default'} labels.\n<code>${escapeHtml(String(err).slice(0, 150))}</code>`,
    ).catch((notifyErr: unknown) => { console.error('[github-issues] notify failed (label fetch):', notifyErr); });
    return cachedRepoLabels || [];
  }
}

export async function suggestLabels(
  finding: Finding,
  validation: ValidationResult,
  apiKey: string,
): Promise<string[]> {
  const repoLabels = fetchRepoLabels();
  const baseLabels = ['nanoclaw'];

  if (repoLabels.length === 0) {
    return [...baseLabels, finding.type];
  }

  const keywordMap: Record<string, string[]> = {
    bug: ['bug', 'error', 'crash', 'broken', 'fail', 'defect'],
    'performance-regression': [
      'performance',
      'perf',
      'regression',
      'slow',
      'benchmark',
    ],
    'test-gap': ['testing', 'test', 'coverage', 'quality'],
    'daemon-behavior': ['daemon', 'service', 'runtime', 'behavior'],
  };

  try {
    const strategyContext = ccSkillsLabelStrategy
      ? `\nLABEL STRATEGY GUIDE:\n${ccSkillsLabelStrategy.slice(0, 800)}\n`
      : '';

    const prompt = `Suggest 2-4 labels from the EXISTING taxonomy only for this code finding.
Never suggest labels that don't exist in the list below.
Return ONLY a JSON array of label names, nothing else.
${strategyContext}
AVAILABLE LABELS:
${repoLabels.map((l) => `- ${l}`).join('\n')}

FINDING TYPE: ${finding.type}
SEVERITY: ${finding.severity}
TITLE: ${finding.title}
DESCRIPTION: ${finding.description}
CONFIDENCE: ${validation.confidence}

Return format: ["label1", "label2"]`;

    const raw = await queryMiniMax(
      prompt,
      apiKey,
      'You suggest GitHub issue labels. Return only a JSON array.',
    );
    const suggested = JSON.parse(raw.trim()) as string[];

    const validLabels = suggested.filter((l) => repoLabels.includes(l));
    const result = [...new Set([...baseLabels, ...validLabels])];
    logger.info({ suggested: validLabels }, 'MiniMax label suggestion');
    return result.slice(0, 5);
  } catch (err) {
    logger.warn(
      { err, title: finding.title },
      'MiniMax label suggestion failed, using keyword fallback',
    );
    notify(
      `<b>⚠️ Label Suggestion Failed</b>\n\nFalling back to keyword matching for: <code>${escapeHtml(finding.title.slice(0, 60))}</code>`,
    ).catch((notifyErr: unknown) => { console.error('[github-issues] notify failed (label suggestion):', notifyErr); });
    const keywords = keywordMap[finding.type] || [];
    const matched = repoLabels.filter((label) =>
      keywords.some((kw) => label.toLowerCase().includes(kw)),
    );
    return [...new Set([...baseLabels, finding.type, ...matched])].slice(0, 5);
  }
}

// --- Related Issues Search ---

function searchRelatedIssues(
  title: string,
): Array<{ number: number; title: string; url: string }> {
  const targetRepo = getTargetRepo();
  try {
    const searchTerms = extractWords(title).slice(0, 3).join(' ');
    const result = execSync(
      `gh issue list --repo ${targetRepo} --search "${searchTerms.replace(/"/g, '\\"')}" --state all --limit 5 --json number,title,url`,
      { encoding: 'utf-8', timeout: 60_000 },
    );
    const issues = JSON.parse(result) as Array<{
      number: number;
      title: string;
      url: string;
    }>;
    return issues;
  } catch {
    return [];
  }
}

// --- Issue Templates ---

const FINDING_TYPE_TEMPLATES: Record<
  string,
  (f: Finding, v: ValidationResult, commit: string) => string
> = {
  bug: (f, v, commit) => `## Bug Report

### Description

${f.description}

### Evidence

${v.analysis}

### Affected Files

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Steps to Reproduce

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Suggested Fix\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,

  'performance-regression': (f, v, commit) => `## Performance Regression

### Description

${f.description}

### Evidence

${v.analysis}

### Affected Files

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Benchmark / Validation

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Suggested Fix\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,

  'test-gap': (f, v, commit) => `## Test Coverage Gap

### Summary

${f.description}

### Analysis

${v.analysis}

### Affected Files (Missing Coverage)

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Suggested Tests

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Proposed Implementation\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,

  'daemon-behavior': (f, v, commit) => `## Daemon Behavior Issue

### Description

${f.description}

### Analysis

${v.analysis}

### Affected Files

${f.files.map((file) => `- \`${file}\``).join('\n')}

### Reproduction / Validation

\`\`\`bash
${f.validation}
\`\`\`

${v.suggestedFix ? `### Suggested Fix\n\n${v.suggestedFix}\n` : ''}
### Environment

- Commit: \`${commit}\`
- Severity: **${f.severity}** | Confidence: **${v.confidence}**`,
};

// --- Title Optimization ---

const TITLE_TYPE_PREFIX: Record<string, string> = {
  bug: 'Bug',
  'performance-regression': 'Perf',
  'test-gap': 'Test Gap',
  'daemon-behavior': 'Daemon',
};

function optimizeTitle(finding: Finding): string {
  const prefix = TITLE_TYPE_PREFIX[finding.type] || finding.type;
  const severityTag =
    finding.severity === 'critical' || finding.severity === 'high'
      ? ` [${finding.severity}]`
      : '';
  const base = `${prefix}: ${finding.title}${severityTag}`;
  if (base.length <= 256) return base;
  return base.slice(0, 253) + '...';
}

// --- Issue Creation ---

export function createGitHubIssue(
  finding: Finding,
  validation: ValidationResult,
  repoPath: string,
  headCommit: string,
  labels: string[],
): string | null {
  const targetRepo = getTargetRepo();
  const commitShort = headCommit.slice(0, 7);
  const template =
    FINDING_TYPE_TEMPLATES[finding.type] || FINDING_TYPE_TEMPLATES['bug'];
  const typedBody = template(finding, validation, commitShort);

  const perspectives = finding.sourcePerspectives?.length
    ? finding.sourcePerspectives.join(', ')
    : 'consensus';
  const perspectiveCount = finding.sourcePerspectives?.length || 0;

  const related = searchRelatedIssues(finding.title);
  const relatedSection =
    related.length > 0
      ? `\n### Related Issues\n\n${related.map((r) => `- #${r.number} — ${r.title}`).join('\n')}\n`
      : '';

  const frontmatter = `---
nanoclaw-type: ${finding.type}
severity: ${finding.severity}
confidence: ${validation.confidence}
perspectives: ${perspectiveCount}
files:
${finding.files.map((f) => `  - ${f}`).join('\n')}
validation: |
  ${finding.validation}
commit: ${commitShort}
---`;

  const provenanceSection = `### Discovery Provenance

| Field | Value |
|-------|-------|
| Pipeline | MiniMax M2.5-highspeed triage → Claude Code validation |
| Perspectives | ${perspectives} (${perspectiveCount} expert${perspectiveCount !== 1 ? 's' : ''}) |
| Commit | \`${commitShort}\` |
| Created | ${new Date().toISOString()} |`;

  const body = `${frontmatter}

${typedBody}
${relatedSection}
${provenanceSection}

---
*Auto-created by [NanoClaw](https://github.com/terrylica/nanoclaw) continuous validation*`;

  const title = optimizeTitle(finding);

  try {
    const tmpFile = path.join(DATA_DIR, 'issue-body.tmp.md');
    fs.writeFileSync(tmpFile, body);

    const labelStr = labels.join(',');
    const result = execSync(
      `gh issue create --repo ${targetRepo} --title "${title.replace(/"/g, '\\"')}" --label "${labelStr}" --body-file "${tmpFile}"`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 60_000 },
    );

    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }

    const url = result.trim();
    logger.info(
      {
        url,
        type: finding.type,
        confidence: validation.confidence,
        labels: labelStr,
      },
      'GitHub issue created',
    );
    return url;
  } catch (err) {
    logger.error({ err, title }, 'Failed to create GitHub issue');
    notify(
      `<b>❌ GitHub Issue Creation Failed</b>\n\n<code>${escapeHtml(title.slice(0, 80))}</code>\n<code>${escapeHtml(String(err).slice(0, 200))}</code>`,
    ).catch((notifyErr: unknown) => { console.error('[github-issues] notify failed (issue creation):', notifyErr); });
    return null;
  }
}
