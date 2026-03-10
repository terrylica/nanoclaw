/**
 * Curiosity-driven research engine with exploration diversification.
 *
 * Four research strategies rotate each cycle to maximize coverage:
 * 1. Exploit — go deeper on highest-yield domains
 * 2. Explore — search underexplored or untouched domains
 * 3. Serendipity — cross-pollinate from adjacent fields
 * 4. Contrarian — challenge current approach, search for alternatives
 *
 * Claude Code runs multi-turn research sessions (WebSearch + WebFetch)
 * with strategy-specific system prompts that guide exploration behavior.
 *
 * MiniMax handles topic selection, synthesis, and relevance scoring.
 * Exploration map tracks domain coverage and yield for adaptive steering.
 */
import path from 'path';
import { spawnSync } from 'child_process';

import { logger } from '../../logger.js';

// --- Constants ---

const FIRECRAWL_URL = 'http://172.25.236.1:3003';
const CLAUDE_RESEARCH_BUDGET = '1.50';
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

export type ResearchStrategy =
  | 'exploit'
  | 'explore'
  | 'serendipity'
  | 'contrarian';

export interface ExplorationDomain {
  searches: number;
  goalsQueued: number;
  goalsSucceeded: number;
  lastSearched: string;
}

export interface ExplorationMap {
  [domain: string]: ExplorationDomain;
}

const STRATEGIES: ResearchStrategy[] = [
  'exploit',
  'explore',
  'serendipity',
  'contrarian',
];

// Seed domains NanoClaw can explore (expanded beyond the original 4)
const KNOWN_DOMAINS = [
  'ast-grep rules and patterns',
  'semgrep and opengrep rule engineering',
  'tree-sitter grammar and query patterns',
  'prompt engineering for code review (EvoPrompt, DSPy, GEPA)',
  'autonomous agent architectures (Reflexion, LATS, Voyager)',
  'TypeScript compiler API and custom transforms',
  'Bun runtime optimization and native APIs',
  'git hook automation and pre-commit frameworks',
  'LLM-as-judge evaluation frameworks',
  'code smell detection and refactoring patterns',
  'fuzzing and property-based testing for TypeScript',
  'incremental computation and caching for CI pipelines',
  'program synthesis and code generation techniques',
  'multi-agent debate and verification protocols',
  'developer experience tooling (LSP, diagnostics, codemods)',
  'WASM-based sandboxing for safe code execution',
  'knowledge graph construction from codebases',
  'differential testing and mutation testing',
  'self-healing systems and auto-remediation patterns',
  'observability and structured logging best practices',
];

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

// --- Channel 2: Claude Code Multi-Turn Research Agent ---

/**
 * Run a multi-turn Claude research session with strategy-specific instructions.
 * Unlike the old one-shot search, this gives Claude a system prompt that guides
 * its exploration behavior (follow unexpected leads, compare sources, etc.).
 */
function claudeResearchAgent(
  query: string,
  strategy: ResearchStrategy,
  explorationContext: string,
): string | null {
  const strategyInstructions: Record<ResearchStrategy, string> = {
    exploit: `You are doing DEEP DIVE research. Go beyond surface-level results.
For each finding, use WebFetch to read the actual source (GitHub repos, papers, docs).
Follow references and "see also" links. Compare multiple implementations.
We want depth and specifics — code patterns, configuration examples, benchmarks.`,

    explore: `You are doing EXPLORATORY research into unfamiliar territory.
Cast a wide net. Search for multiple angles on this topic.
Look for lesser-known tools, obscure blog posts, academic papers.
If you find something unexpected but potentially useful, follow that lead.
Prioritize novelty — we want things we haven't seen before.`,

    serendipity: `You are doing CROSS-POLLINATION research.
The topic may seem unrelated to code analysis at first — that's intentional.
Your job is to find surprising connections and transferable patterns.
Search broadly, then ask: "How could this technique apply to automated code review?"
Look at how OTHER fields solve similar problems (biology, game AI, supply chains).`,

    contrarian: `You are doing CONTRARIAN research — deliberately challenging assumptions.
Search for: criticisms, failure cases, alternatives, and "X considered harmful" posts.
If the topic is about a tool, search for its competitors and why people switched away.
If it's about a technique, search for when it fails and what works better.
We want to avoid blind spots and groupthink.`,
  };

  const systemPrompt = `${strategyInstructions[strategy]}

EXPLORATION CONTEXT (what we already know):
${explorationContext}

INSTRUCTIONS:
- Use WebSearch to find relevant pages, then WebFetch to read the most promising ones
- Synthesize findings into a structured summary
- Include specific tool names, GitHub repos, npm packages, or paper titles
- Note any surprising or counterintuitive findings
- End with 2-3 concrete "next steps" someone could implement`;

  try {
    const result = spawnSync(
      CLAUDE_BIN,
      [
        '-p',
        '--allowedTools',
        'WebSearch,WebFetch',
        '--max-budget-usd',
        CLAUDE_RESEARCH_BUDGET,
        '--output-format',
        'text',
      ],
      {
        input: `${systemPrompt}\n\n---\n\nResearch topic: ${query}`,
        encoding: 'utf-8',
        timeout: 180_000, // 3 min for multi-turn
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    if (result.error || result.status !== 0) {
      logger.debug(
        { error: String(result.error || result.stderr).slice(0, 200) },
        'Claude research agent failed',
      );
      return null;
    }
    const output = result.stdout.trim();
    if (!output || output.length <= 100 || output.startsWith('Error:')) {
      return null;
    }
    logger.info(
      {
        query: query.slice(0, 50),
        strategy,
        outputLen: output.length,
      },
      'Claude research agent success',
    );
    return output;
  } catch {
    return null;
  }
}

// --- Strategy-Driven Topic Generation ---

/**
 * Build a strategy-specific prompt for MiniMax to pick research topics.
 * Each strategy steers MiniMax toward different parts of the solution space.
 */
function buildTopicPrompt(
  strategy: ResearchStrategy,
  explorationMap: ExplorationMap,
  pastTopics: string[],
): string {
  const avoidSection =
    pastTopics.length > 0
      ? `\nDO NOT repeat these previously researched topics:\n${pastTopics
          .slice(-20)
          .map((t) => `- ${t}`)
          .join('\n')}`
      : '';

  // Compute domain stats for the prompt
  const domainEntries = Object.entries(explorationMap);
  const highYield = domainEntries
    .filter(([, d]) => d.goalsQueued > 0)
    .sort(([, a], [, b]) => b.goalsQueued / b.searches - a.goalsQueued / a.searches)
    .slice(0, 5)
    .map(([domain, d]) => `${domain} (${d.goalsQueued}/${d.searches} yield)`)
    .join(', ');

  const unexplored = KNOWN_DOMAINS.filter((d) => !explorationMap[d])
    .slice(0, 8)
    .join(', ');

  const stale = domainEntries
    .filter(
      ([, d]) =>
        Date.now() - new Date(d.lastSearched).getTime() > 7 * 24 * 60 * 60_000,
    )
    .map(([domain]) => domain)
    .slice(0, 5)
    .join(', ');

  const baseContext = `NanoClaw is a TypeScript/Bun autonomous code validation orchestrator.
It uses ast-grep rules, MiniMax M2.5 for triage, Claude Code for validation.
It has a self-evolution engine that discovers issues, generates goals, and implements fixes.`;

  const strategyPrompts: Record<ResearchStrategy, string> = {
    exploit: `${baseContext}

STRATEGY: EXPLOIT — go deeper on what's working.
${highYield ? `High-yield domains: ${highYield}` : 'No yield data yet — pick domains most likely to produce concrete code improvements.'}
Pick 2 topics that drill DEEPER into the most productive research areas.
We want specific techniques, tools, or patterns — not broad overviews.`,

    explore: `${baseContext}

STRATEGY: EXPLORE — search the unknown.
${unexplored ? `Unexplored domains: ${unexplored}` : 'Most domains have been searched — try completely new angles.'}
${stale ? `Stale domains (not searched in 7+ days): ${stale}` : ''}
Pick 2 topics from areas we have NOT explored yet. Prioritize novelty.`,

    serendipity: `${baseContext}

STRATEGY: SERENDIPITY — cross-pollinate from adjacent fields.
Think beyond code analysis. What techniques from OTHER domains could apply?
Consider: game AI (MCTS, self-play), biology (genetic algorithms, immune systems),
distributed systems (consensus, gossip protocols), human factors (cognitive load,
attention management), NLP (chain-of-thought, retrieval-augmented generation).
Pick 2 topics from adjacent fields that could transfer to code review automation.`,

    contrarian: `${baseContext}

STRATEGY: CONTRARIAN — challenge our assumptions.
NanoClaw currently uses: MiniMax for triage, Claude for validation, ast-grep for static analysis.
What if these are wrong? Search for:
- Alternatives to LLM-based code review (symbolic analysis, formal verification)
- Criticisms of autonomous agents (failure modes, when NOT to automate)
- Anti-patterns in self-modifying systems
- Cases where simpler tools outperform complex ones
Pick 2 topics that deliberately challenge NanoClaw's current architecture.`,
  };

  return `${strategyPrompts[strategy]}
${avoidSection}

Return EXACTLY 2 lines, one topic per line. No numbering, no bullets, just the search query.`;
}

// --- Exploration Map Helpers ---

export function updateExplorationMap(
  map: ExplorationMap,
  domain: string,
  goalsQueued: number,
): void {
  if (!map[domain]) {
    map[domain] = {
      searches: 0,
      goalsQueued: 0,
      goalsSucceeded: 0,
      lastSearched: new Date().toISOString(),
    };
  }
  map[domain].searches++;
  map[domain].goalsQueued += goalsQueued;
  map[domain].lastSearched = new Date().toISOString();
}

/** Classify a topic into the nearest known domain (or create a new one) */
function classifyDomain(topic: string): string {
  const lower = topic.toLowerCase();
  for (const domain of KNOWN_DOMAINS) {
    // Simple keyword overlap check
    const keywords = domain
      .toLowerCase()
      .split(/[\s,()]+/)
      .filter((w) => w.length > 3);
    const matches = keywords.filter((kw) => lower.includes(kw)).length;
    if (matches >= 2 || (keywords.length <= 3 && matches >= 1)) {
      return domain;
    }
  }
  // New domain — use the topic itself (normalized)
  return topic.slice(0, 80).toLowerCase();
}

/** Build exploration context string for the Claude research agent */
function buildExplorationContext(
  explorationMap: ExplorationMap,
  pastTopics: string[],
): string {
  const entries = Object.entries(explorationMap);
  if (entries.length === 0 && pastTopics.length === 0) {
    return 'This is our first research cycle. No prior exploration data.';
  }

  const lines: string[] = [];
  if (entries.length > 0) {
    const sorted = entries.sort(([, a], [, b]) => b.searches - a.searches);
    lines.push('Domains explored so far:');
    for (const [domain, d] of sorted.slice(0, 10)) {
      const yield_ =
        d.searches > 0
          ? `${Math.round((d.goalsQueued / d.searches) * 100)}% yield`
          : 'no data';
      lines.push(`- ${domain}: ${d.searches} searches, ${yield_}`);
    }
  }
  if (pastTopics.length > 0) {
    lines.push(`\nRecent topics (${pastTopics.length} total):`);
    for (const t of pastTopics.slice(-5)) {
      lines.push(`- ${t}`);
    }
  }
  return lines.join('\n');
}

// --- Cascade ---

/** Research a known URL (Firecrawl first, then Claude) */
async function researchUrl(url: string): Promise<ResearchResult> {
  const firecrawlResult = await firecrawlScrape(url);
  if (firecrawlResult) {
    logger.info({ url, source: 'firecrawl' }, 'Research via Firecrawl');
    return { content: firecrawlResult, source: 'firecrawl', url };
  }

  const claudeResult = claudeResearchAgent(
    `Analyze this resource: ${url}`,
    'exploit',
    '',
  );
  if (claudeResult) {
    return { content: claudeResult, source: 'claude-websearch', url };
  }

  return { content: '', source: 'failed', url };
}

/** Research an open-ended query with strategy-specific Claude agent */
export async function researchQuery(
  query: string,
  strategy: ResearchStrategy = 'explore',
  explorationContext: string = '',
): Promise<ResearchResult> {
  const claudeResult = claudeResearchAgent(query, strategy, explorationContext);
  if (claudeResult) {
    logger.info(
      { query: query.slice(0, 50), strategy, source: 'claude-websearch' },
      'Research query',
    );
    return { content: claudeResult, source: 'claude-websearch' };
  }

  return { content: '', source: 'failed' };
}

// --- Main Research Cycle ---

/**
 * Run a curiosity-driven research cycle with strategy rotation.
 *
 * Each cycle:
 * 1. Pick strategy (rotating: exploit → explore → serendipity → contrarian)
 * 2. MiniMax generates topics guided by strategy + exploration map
 * 3. Claude multi-turn research agent investigates with strategy-specific behavior
 * 4. MiniMax synthesizes actionable items
 * 5. Relevance scoring filters low-value noise
 * 6. Update exploration map with yield data
 */
export async function runResearchCycle(
  apiKey: string,
  pastTopics: string[] = [],
  explorationMap: ExplorationMap = {},
  strategyIndex: number = 0,
): Promise<{
  topics: string[];
  actionItems: string[];
  strategy: ResearchStrategy;
  domains: string[];
}> {
  const { queryMiniMax } = await import('../minimax-client.js');
  const strategy = STRATEGIES[strategyIndex % STRATEGIES.length];

  logger.info(
    {
      strategy,
      cycleIndex: strategyIndex,
      domainsExplored: Object.keys(explorationMap).length,
      pastTopicCount: pastTopics.length,
    },
    'Research cycle starting',
  );

  // Step 1: MiniMax picks topics using strategy-specific prompt
  const topicPrompt = buildTopicPrompt(strategy, explorationMap, pastTopics);
  const topicResponse = await queryMiniMax(topicPrompt, apiKey);
  const topics = topicResponse
    .trim()
    .split('\n')
    .filter((l: string) => l.trim().length > 10)
    .slice(0, 2);

  if (topics.length === 0) {
    return { topics: [], actionItems: [], strategy, domains: [] };
  }

  // Classify topics into domains
  const domains = topics.map(classifyDomain);

  // Step 2: Claude multi-turn research with strategy-specific behavior
  const explorationContext = buildExplorationContext(
    explorationMap,
    pastTopics,
  );
  const results: ResearchResult[] = [];
  for (const topic of topics) {
    const result = await researchQuery(topic, strategy, explorationContext);
    if (result.source !== 'failed') results.push(result);
  }

  if (results.length === 0) {
    // Update exploration map even on failure
    for (const domain of domains) {
      updateExplorationMap(explorationMap, domain, 0);
    }
    return { topics, actionItems: [], strategy, domains };
  }

  // Step 3: MiniMax synthesizes with strategy-aware prompt
  const researchContent = results
    .map((r: ResearchResult) => r.content.slice(0, 5000))
    .join('\n\n---\n\n');

  const synthesisPrompt = `You are synthesizing research findings into concrete improvements for NanoClaw (TypeScript/Bun autonomous code validation system).

Research strategy was: ${strategy.toUpperCase()}
${strategy === 'serendipity' ? 'Focus on TRANSFERABLE patterns — how can these ideas apply to code analysis?' : ''}
${strategy === 'contrarian' ? 'Focus on ALTERNATIVES and CRITICISMS — what should NanoClaw change or stop doing?' : ''}
${strategy === 'exploit' ? 'Focus on SPECIFIC techniques — exact tool names, config patterns, code snippets.' : ''}
${strategy === 'explore' ? 'Focus on NEW capabilities — things NanoClaw cannot do today but could.' : ''}

Research:
${researchContent}

Return up to 5 specific, implementable action items. Each should be a single sentence describing what to change/add and why. One per line, no bullets or numbering.`;

  const synthesisResponse = await queryMiniMax(synthesisPrompt, apiKey);
  const rawItems = synthesisResponse
    .trim()
    .split('\n')
    .filter((l: string) => l.trim().length > 20)
    .slice(0, 5);

  // Step 4: Score each action item for relevance
  // Lower threshold for novel strategies — serendipity/contrarian findings are
  // inherently less "obviously relevant" but that's the point of diversity.
  const threshold =
    strategy === 'serendipity' || strategy === 'contrarian' ? 0.4 : 0.5;

  const actionItems: string[] = [];
  let bestItem: { text: string; score: number } | null = null;

  for (const item of rawItems) {
    const score = await scoreGoalRelevance(item, apiKey);
    if (score >= threshold) {
      actionItems.push(item);
      logger.debug(
        { item: item.slice(0, 60), score, strategy, threshold },
        'Research goal accepted',
      );
    } else {
      logger.debug(
        { item: item.slice(0, 60), score, strategy, threshold },
        'Research goal rejected (low relevance)',
      );
    }
    // Track best item as fallback
    if (!bestItem || score > bestItem.score) {
      bestItem = { text: item, score };
    }
  }

  // Guarantee at least 1 goal per research cycle — research is expensive,
  // always produce something. Take the best-scoring item even if below threshold.
  if (actionItems.length === 0 && bestItem && bestItem.score > 0.1) {
    actionItems.push(bestItem.text);
    logger.info(
      { item: bestItem.text.slice(0, 60), score: bestItem.score, strategy },
      'Research fallback: accepting best item despite low score',
    );
  }

  // Step 5: Update exploration map
  for (const domain of domains) {
    updateExplorationMap(explorationMap, domain, actionItems.length);
  }

  logger.info(
    {
      strategy,
      topics,
      rawCount: rawItems.length,
      acceptedCount: actionItems.length,
      domains,
    },
    'Research cycle complete',
  );
  return { topics, actionItems, strategy, domains };
}

/** Score a research goal for relevance to NanoClaw's self-evolution (0.0-1.0). */
async function scoreGoalRelevance(
  goalText: string,
  apiKey: string,
): Promise<number> {
  try {
    const { queryMiniMax } = await import('../minimax-client.js');
    const prompt = `Score this proposed improvement for NanoClaw (a TypeScript/Bun autonomous self-evolving code validation system) on a scale of 0.0 to 1.0.

PROPOSED GOAL: ${goalText}

SCORING CRITERIA (score generously — we want diverse improvements, not just bug fixes):
- 1.0: Directly improves existing source code OR adds a powerful new capability
- 0.8: New technique/algorithm that could improve validation quality, evolution strategy, or research effectiveness
- 0.6: Introduces a pattern from another domain (game AI, biology, formal methods) that could be adapted
- 0.4: Adds new tooling, rules, or infrastructure that extends NanoClaw's reach
- 0.2: Purely theoretical with no clear implementation path
- 0.0: Completely irrelevant to code validation or self-evolution

IMPORTANT: Score 0.6+ for any goal that proposes a concrete, implementable change — even if it requires new code. We WANT novel capabilities, not just fixes to existing code.

Respond with ONLY a number between 0.0 and 1.0, nothing else.`;

    const response = await queryMiniMax(prompt, apiKey);
    const score = parseFloat(response.trim());
    return isNaN(score) ? 0 : Math.max(0, Math.min(1, score));
  } catch {
    return 0; // Fail closed — don't queue unscored goals
  }
}
