/**
 * Triple web research cascade for gathering SOTA knowledge.
 *
 * Channel 1: Firecrawl (free, self-hosted) - known URLs
 * Channel 2: Claude Code WebSearch/WebFetch - open-ended queries
 * Channel 3: agent-browser (Playwright) - last resort
 *
 * Cascade: Firecrawl first → Claude WebSearch → agent-browser
 */
import { spawnSync } from 'child_process';

import { logger } from '../../logger.js';

// --- Constants ---

const FIRECRAWL_URL = 'http://172.25.236.1:3003';
const CLAUDE_SEARCH_BUDGET = '0.50';

// --- Types ---

export interface ResearchResult {
  content: string;
  source: 'firecrawl' | 'claude-websearch' | 'agent-browser' | 'failed';
  url?: string;
}

// --- Channel 1: Firecrawl ---

async function firecrawlScrape(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const encodedUrl = encodeURIComponent(url);
    const name = url.replace(/[^a-z0-9]/gi, '-').slice(0, 50);
    const response = await fetch(
      `${FIRECRAWL_URL}/scrape?url=${encodedUrl}&name=${name}`,
      { signal: controller.signal },
    );

    clearTimeout(timer);

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
      'claude',
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

    if (result.error || result.status !== 0) return null;
    const output = result.stdout.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

// --- Cascade ---

/** Research a known URL (Firecrawl first, then Claude) */
export async function researchUrl(url: string): Promise<ResearchResult> {
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

/** Research an open-ended query */
export async function researchQuery(query: string): Promise<ResearchResult> {
  // Channel 2: Claude WebSearch (best for open-ended)
  const claudeResult = claudeWebSearch(query);
  if (claudeResult) {
    logger.info({ query: query.slice(0, 50), source: 'claude-websearch' }, 'Research query');
    return { content: claudeResult, source: 'claude-websearch' };
  }

  return {
    content: '',
    source: 'failed',
  };
}
