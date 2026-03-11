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
const CLAUDE_RESEARCH_BUDGET = '0.50';
const CLAUDE_BIN = path.join(
  process.env.HOME || '/Users/terryli',
  '.local/bin/claude',
);

// --- Types ---

export interface ResearchResult {
  content: string;
  source:
    | 'firecrawl'
    | 'claude-websearch'
    | 'agent-browser'
    | 'minimax-fallback'
    | 'failed';
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
        '--max-turns',
        '3',
        '--output-format',
        'text',
      ],
      {
        input: `${systemPrompt}\n\n---\n\nResearch topic: ${query}`,
        encoding: 'utf-8',
        timeout: 300_000, // 5 min — Claude startup + WebSearch needs headroom
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    if (result.error || result.status !== 0) {
      logger.info(
        {
          query: query.slice(0, 50),
          strategy,
          error: String(result.error || result.stderr).slice(0, 200),
        },
        'Claude research agent failed (process error)',
      );
      return null;
    }
    const output = result.stdout.trim();
    if (!output || output.length <= 100 || output.startsWith('Error:')) {
      logger.info(
        { query: query.slice(0, 50), strategy, outputLen: output?.length ?? 0 },
        'Claude research agent returned empty/short output',
      );
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

// --- Scored Goal Parsing ---

interface RankedGoal {
  goal: string;
  relevance: number;
  rationale: string;
}

/** Parse MiniMax response into ranked goals array. Handles fences and malformed JSON. */
function parseRankedGoals(raw: string): RankedGoal[] {
  let jsonStr = raw.trim();

  // Strip markdown fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Extract JSON array
  const arrayMatch = jsonStr.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    jsonStr = arrayMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item: unknown): item is RankedGoal =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as RankedGoal).goal === 'string' &&
          (item as RankedGoal).goal.length > 20 &&
          typeof (item as RankedGoal).relevance === 'number',
      )
      .map((item) => ({
        goal: item.goal,
        relevance: Math.max(0, Math.min(1, item.relevance)),
        rationale: String(item.rationale || ''),
      }));
  } catch {
    logger.info(
      { rawLen: raw.length, snippet: raw.slice(0, 100) },
      'Failed to parse ranked goals JSON',
    );
    return [];
  }
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

  // Step 2: MiniMax-first research — use MiniMax's training data as the primary
  // research source, then optionally enhance with Claude WebSearch.
  //
  // Why MiniMax-first: Claude WebSearch via spawnSync blocks the event loop for
  // up to 5min per query (10min total). This stalls all networking, causing the
  // subsequent MiniMax synthesis call to fail with "fetch failed". MiniMax triage
  // calls (which run before research) work fine, proving MiniMax is reachable —
  // it's the 10min spawnSync blockage that kills connectivity.
  const results: ResearchResult[] = [];

  // Primary: MiniMax generates research content from training data
  try {
    const researchPrompt = `You are a senior software engineer with deep expertise in TypeScript, Bun runtime, static analysis, and autonomous agent systems.

NanoClaw is a TypeScript/Bun autonomous code validation orchestrator that:
- Uses ast-grep rules + MiniMax LLM for multi-expert code triage
- Has a self-evolution engine: discovers issues → generates goals → auto-implements fixes via Claude Code in isolated git worktrees
- Monitors target codebases for bugs, security issues, and code quality
- Uses 4-strategy research rotation: exploit, explore, serendipity, contrarian

Research strategy: ${strategy.toUpperCase()}
${strategy === 'exploit' ? 'Go deep on specific tools, libraries, and implementation techniques.' : ''}
${strategy === 'explore' ? 'Focus on capabilities NanoClaw does not have yet. Be creative.' : ''}
${strategy === 'serendipity' ? 'Draw from adjacent fields: game AI, biology, distributed systems, NLP. Find transferable patterns.' : ''}
${strategy === 'contrarian' ? 'Challenge assumptions. What should NanoClaw stop doing? What simpler alternatives exist?' : ''}

Research these topics in depth:
${topics.map((t: string) => `- ${t}`).join('\n')}

For each topic, provide:
1. Specific tools, npm packages, or algorithms (with names and versions)
2. How they would integrate with a TypeScript/Bun codebase
3. Concrete implementation approaches (not vague suggestions)
4. Any tradeoffs or limitations

Be technical and detailed — we need enough depth for an AI agent to implement the suggestions.`;

    const response = await queryMiniMax(researchPrompt, apiKey);
    if (response.trim().length > 100) {
      results.push({ content: response, source: 'minimax-fallback' });
      logger.info(
        { outputLen: response.length, strategy },
        'MiniMax primary research produced content',
      );
    }
  } catch (err) {
    logger.warn(
      { err: String(err).slice(0, 100), strategy },
      'MiniMax primary research failed',
    );
  }

  // Optional enhancement: try Claude WebSearch for ONE topic only (reduces
  // spawnSync blockage from 10min to 5min max). Only attempt if MiniMax
  // succeeded (so synthesis won't fail from stale connections).
  if (results.length > 0) {
    const explorationContext = buildExplorationContext(
      explorationMap,
      pastTopics,
    );
    const claudeResult = await researchQuery(
      topics[0],
      strategy,
      explorationContext,
    );
    if (claudeResult.source !== 'failed') {
      results.push(claudeResult);
      logger.info(
        { query: topics[0].slice(0, 50), strategy },
        'Claude WebSearch enhanced research',
      );
    }
  }

  // If even the fallback produced nothing, update map and return empty
  if (results.length === 0) {
    for (const domain of domains) {
      updateExplorationMap(explorationMap, domain, 0);
    }
    logger.info(
      { strategy, topics },
      'Research cycle complete (no content from any source)',
    );
    return { topics, actionItems: [], strategy, domains };
  }

  // Step 3: Combined synthesis + scoring + goal transformation (single MiniMax call)
  // Replaces separate synthesis (1 call) + per-item scoring (5 calls) = 6 → 1
  const researchContent = results
    .map((r: ResearchResult) => r.content.slice(0, 5000))
    .join('\n\n---\n\n');

  const strategyGuidance: Record<ResearchStrategy, string> = {
    exploit:
      'Focus on SPECIFIC techniques — exact tool names, config patterns, code snippets that improve existing capabilities.',
    explore:
      'Focus on NEW capabilities — things NanoClaw cannot do today but could. Score generously for novel approaches.',
    serendipity:
      'Focus on TRANSFERABLE patterns from other domains. Score generously — cross-domain insights are inherently valuable even if indirect.',
    contrarian:
      'Focus on ALTERNATIVES and CRITICISMS — what should NanoClaw change or stop doing? Score generously for well-reasoned challenges.',
  };

  const synthesisPrompt = `You are synthesizing research findings into implementation-ready goals for NanoClaw (TypeScript/Bun autonomous code validation system).

Strategy: ${strategy.toUpperCase()}
${strategyGuidance[strategy]}

Research content:
${researchContent}

Return a JSON array of 3-5 goals, ranked by relevance (most relevant first).
Each goal must be an object with these fields:
- "goal": An implementation-ready instruction that an AI coding agent can execute in a single session.
  Format: "In [file or module], [verb] [specific change] to [achieve outcome]"
  Examples:
  - "In src/orchestrator/scanning.ts, add tree-sitter query integration for detecting unused TypeScript imports using @tree-sitter/typescript"
  - "In src/orchestrator/evolution/engine.ts, implement MCTS-based goal prioritization that explores multiple fix strategies before committing"
  - "Add a new validation gate in goal-validator.ts that runs property-based tests using fast-check to catch edge cases"
- "relevance": 0.0-1.0 score. Score 0.6+ for any concrete, implementable change. Score 0.8+ for changes that directly improve code quality or add powerful capabilities. Score 0.4+ for novel approaches worth experimenting with.
- "rationale": One sentence explaining why this improves NanoClaw

Return ONLY the JSON array, no other text.`;

  let rankedGoals: RankedGoal[] = [];
  try {
    const synthesisResponse = await queryMiniMax(synthesisPrompt, apiKey);
    rankedGoals = parseRankedGoals(synthesisResponse);
    logger.info(
      { strategy, parsedCount: rankedGoals.length, rawLen: synthesisResponse.length },
      'Synthesis produced ranked goals',
    );
  } catch (err) {
    logger.warn(
      { err: String(err).slice(0, 100), strategy },
      'Synthesis MiniMax call failed',
    );
  }

  // Step 4: Filter by threshold, guarantee at least 1 goal
  const threshold =
    strategy === 'serendipity' || strategy === 'contrarian' ? 0.4 : 0.5;

  const actionItems: string[] = [];
  for (const item of rankedGoals) {
    if (item.relevance >= threshold) {
      actionItems.push(item.goal);
      logger.info(
        {
          goal: item.goal.slice(0, 80),
          relevance: item.relevance,
          rationale: item.rationale.slice(0, 60),
          strategy,
        },
        'Research goal accepted',
      );
    } else {
      logger.info(
        {
          goal: item.goal.slice(0, 80),
          relevance: item.relevance,
          strategy,
          threshold,
        },
        'Research goal below threshold',
      );
    }
  }

  // Guarantee: take the top-ranked item if nothing passed threshold
  if (actionItems.length === 0 && rankedGoals.length > 0) {
    const best = rankedGoals[0]; // Already sorted by relevance (MiniMax ranks them)
    if (best.relevance > 0.1) {
      actionItems.push(best.goal);
      logger.info(
        {
          goal: best.goal.slice(0, 80),
          relevance: best.relevance,
          strategy,
        },
        'Research fallback: accepting top-ranked goal despite low score',
      );
    }
  }

  // Step 5: Update exploration map
  for (const domain of domains) {
    updateExplorationMap(explorationMap, domain, actionItems.length);
  }

  logger.info(
    {
      strategy,
      topics,
      rankedCount: rankedGoals.length,
      acceptedCount: actionItems.length,
      domains,
      sources: results.map((r) => r.source),
    },
    'Research cycle complete',
  );
  return { topics, actionItems, strategy, domains };
}
