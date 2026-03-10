/**
 * Triple web research cascade for gathering SOTA knowledge.
 *
 * Channel 1: Firecrawl (free, self-hosted) - known URLs
 * Channel 2: Claude Code WebSearch/WebFetch - open-ended queries
 * Channel 3: agent-browser (Playwright) - last resort
 *
 * Cascade: Firecrawl first → Claude WebSearch → agent-browser
 */
import path from 'path';
import { spawnSync } from 'child_process';

import { logger } from '../../logger.js';

// --- Constants ---

const FIRECRAWL_URL = 'http://172.25.236.1:3003';
const CLAUDE_SEARCH_BUDGET = '1.00';
const CLAUDE_BIN = path.join(
  process.env.HOME || '/Users/terryli',
  '.local/bin/claude',
);

// --- Types ---

export interface ResearchResult {
  content: string;
  source: 'firecrawl' | 'claude-websearch' | 'agent-browser' | 'failed';
  url?: string;
}

// --- Channel 1: Firecrawl ---

async function firecrawlScrape(url: string): Promise<string | null> {
  try {
    const { fetchWithTimeout } = await import('../minimax-client.js');
    const encodedUrl = encodeURIComponent(url);
    const name = url.replace(/[^a-z0-9]/gi, '-').slice(0, 50);
    const response = await fetchWithTimeout(
      `${FIRECRAWL_URL}/scrape?url=${encodedUrl}&name=${name}`,
      {},
      30_000,
    );

    if (!response.ok) return null;
    const text = await response.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// --- Channel 2: Claude Code WebSearch ---

function claudeWebSearch(query: string): string | null {
  try {
    const result = spawnSync(
      CLAUDE_BIN,
      [
        '-p',
        '--allowedTools',
        'WebSearch,WebFetch',
        '--max-budget-usd',
        CLAUDE_SEARCH_BUDGET,
        '--output-format',
        'text',
      ],
      {
        input: `Search the web for: ${query}\n\nReturn a concise summary of the most relevant findings.`,
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );

    if (result.error || result.status !== 0) {
      logger.debug(
        { error: String(result.error || result.stderr).slice(0, 200) },
        'Claude WebSearch failed',
      );
      return null;
    }
    const output = result.stdout.trim();
    if (!output || output.length <= 50 || output.startsWith('Error:')) {
      logger.debug(
        { outputLen: output.length, preview: output.slice(0, 100) },
        'Claude WebSearch empty/error result',
      );
      return null;
    }
    logger.info(
      { query: query.slice(0, 50), outputLen: output.length },
      'Claude WebSearch success',
    );
    return output;
  } catch {
    return null;
  }
}

// --- Cascade ---

/** Research a known URL (Firecrawl first, then Claude) */
async function researchUrl(url: string): Promise<ResearchResult> {
  // Channel 1: Firecrawl (free)
  const firecrawlResult = await firecrawlScrape(url);
  if (firecrawlResult) {
    logger.info({ url, source: 'firecrawl' }, 'Research via Firecrawl');
    return { content: firecrawlResult, source: 'firecrawl', url };
  }

  // Channel 2: Claude WebSearch (budget-capped)
  const claudeResult = claudeWebSearch(`site:${url}`);
  if (claudeResult) {
    logger.info({ url, source: 'claude-websearch' }, 'Research via Claude');
    return { content: claudeResult, source: 'claude-websearch', url };
  }

  return {
    content: '',
    source: 'failed',
    url,
  };
}

/**
 * Run a full research cycle: MiniMax picks topics → Claude researches → MiniMax synthesizes.
 * Returns actionable items that can be queued as goals.
 */
export async function runResearchCycle(
  apiKey: string,
  pastTopics: string[] = [],
): Promise<{ topics: string[]; actionItems: string[] }> {
  const { queryMiniMax } = await import('../minimax-client.js');

  // Step 1: MiniMax picks research topics, avoiding past searches
  const avoidSection =
    pastTopics.length > 0
      ? `\n\nDO NOT repeat these previously researched topics:\n${pastTopics.slice(-20).map((t) => `- ${t}`).join('\n')}\n\nPick something NEW and different.`
      : '';

  const topicPrompt = `You are NanoClaw's research advisor. NanoClaw is a TypeScript-based autonomous code validation orchestrator that uses ast-grep rules, MiniMax for triage, and Claude Code for validation.

Pick 2 research topics that would provide the highest-value improvements. Focus on:
- Static analysis techniques (ast-grep, semgrep, tree-sitter)
- Prompt engineering for code review (EvoPrompt, DSPy, GEPA)
- Autonomous agent architectures (Reflexion, LATS, self-improving agents)
- TypeScript/Bun runtime best practices${avoidSection}

Return EXACTLY 2 lines, one topic per line. No numbering, no bullets, just the search query.`;

  const topicResponse = await queryMiniMax(topicPrompt, apiKey);
  const topics = topicResponse
    .trim()
    .split('\n')
    .filter((l: string) => l.trim().length > 10)
    .slice(0, 2);

  if (topics.length === 0) return { topics: [], actionItems: [] };

  // Step 2: Claude Code researches each topic
  const results: ResearchResult[] = [];
  for (const topic of topics) {
    const result = await researchQuery(topic);
    if (result.source !== 'failed') results.push(result);
  }

  if (results.length === 0) return { topics, actionItems: [] };

  // Step 3: MiniMax synthesizes actionable items
  const researchContent = results
    .map((r: ResearchResult) => r.content.slice(0, 5000))
    .join('\n\n---\n\n');
  const synthesisPrompt = `Based on this research about code analysis and autonomous agents, identify concrete, actionable improvements for NanoClaw (TypeScript/Bun codebase).

Research:
${researchContent}

Return up to 5 specific, implementable action items. Each should be a single sentence describing what to change/add and why. One per line, no bullets or numbering.`;

  const synthesisResponse = await queryMiniMax(synthesisPrompt, apiKey);
  const rawItems = synthesisResponse
    .trim()
    .split('\n')
    .filter((l: string) => l.trim().length > 20)
    .slice(0, 5);

  // Step 4: Score each action item for relevance to NanoClaw's self-evolution
  // Only queue items with relevance >= 0.7 to prevent speculative bloat
  const actionItems: string[] = [];
  for (const item of rawItems) {
    const score = await scoreGoalRelevance(item, apiKey);
    if (score >= 0.7) {
      actionItems.push(item);
      logger.debug(
        { item: item.slice(0, 60), score },
        'Research goal accepted',
      );
    } else {
      logger.debug(
        { item: item.slice(0, 60), score },
        'Research goal rejected (low relevance)',
      );
    }
  }

  logger.info(
    { topics, rawCount: rawItems.length, acceptedCount: actionItems.length },
    'Research cycle complete',
  );
  return { topics, actionItems };
}

/** Score a research goal for relevance to NanoClaw's self-evolution (0.0-1.0). */
async function scoreGoalRelevance(
  goalText: string,
  apiKey: string,
): Promise<number> {
  try {
    const { queryMiniMax } = await import('../minimax-client.js');
    const prompt = `Score this proposed improvement for NanoClaw (a TypeScript autonomous code validation system) on a scale of 0.0 to 1.0.

PROPOSED GOAL: ${goalText}

SCORING CRITERIA:
- 1.0: Directly improves NanoClaw's existing TypeScript source code (bug fix, type safety, error handling, performance)
- 0.8: Enhances existing evolution/validation pipeline with minimal new code
- 0.5: Requires significant new infrastructure or speculative design
- 0.2: Tangentially related, mostly theoretical
- 0.0: Irrelevant or would add unused code

Respond with ONLY a number between 0.0 and 1.0, nothing else.`;

    const response = await queryMiniMax(prompt, apiKey);
    const score = parseFloat(response.trim());
    return isNaN(score) ? 0 : Math.max(0, Math.min(1, score));
  } catch {
    return 0; // Fail closed — don't queue unscored goals
  }
}

/** Research an open-ended query */
export async function researchQuery(query: string): Promise<ResearchResult> {
  // Channel 2: Claude WebSearch (best for open-ended)
  const claudeResult = claudeWebSearch(query);
  if (claudeResult) {
    logger.info(
      { query: query.slice(0, 50), source: 'claude-websearch' },
      'Research query',
    );
    return { content: claudeResult, source: 'claude-websearch' };
  }

  return {
    content: '',
    source: 'failed',
  };
}
