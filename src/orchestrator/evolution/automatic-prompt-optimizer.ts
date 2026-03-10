/**
 * AutomaticPromptOptimizer: iteratively improve a system prompt using Bun's
 * built-in HTTP client (fetch).
 *
 * Runs N rounds of refinement. Each round:
 *   1. Scores the current prompt against provided test cases via MiniMax
 *   2. Generates a refined candidate that targets the failing cases
 *   3. Adopts the candidate if it scores higher than the current prompt
 *
 * Usage:
 *   const optimizer = new AutomaticPromptOptimizer({ apiKey, rounds: 3 });
 *   const result = await optimizer.optimize(module, testCases);
 */

import { logger } from '../../logger.js';
import { fetchWithTimeout } from '../minimax-client.js';
import { MINIMAX_BASE_URL, MINIMAX_MODEL } from '../types.js';
import type { PromptModule, PromptInputs } from './prompt-module.js';

// --- Types ---

export interface TestCase {
  /** Input variables for the prompt template */
  inputs: PromptInputs;
  /** Expected keywords that should appear in the LLM response */
  expectedKeywords: string[];
  /** Keywords that must NOT appear (false positive patterns) */
  forbiddenKeywords?: string[];
}

export interface PromptTelemetry {
  /** Total LLM calls made during optimization */
  totalCalls: number;
  /** Cumulative input tokens across all calls */
  totalInputTokens: number;
  /** Cumulative output tokens across all calls */
  totalOutputTokens: number;
  /** Average latency per LLM call in ms */
  avgLatencyMs: number;
}

export interface OptimizationResult {
  /** Final (possibly improved) system prompt */
  systemPrompt: string;
  /** Rounds actually run */
  rounds: number;
  /** Score on test cases (0–1) at the end */
  finalScore: number;
  /** Whether the prompt was improved at all */
  improved: boolean;
  /** Execution time and token usage telemetry */
  telemetry: PromptTelemetry;
}

export interface AutomaticPromptOptimizerOptions {
  apiKey: string;
  /** Number of refinement rounds (default: 3) */
  rounds?: number;
  /** HTTP timeout per LLM call in ms (default: 60 000) */
  timeoutMs?: number;
}

// --- Helpers ---

/** Simple keyword-match scorer: returns fraction of test cases that pass */
function scorePromptLocally(
  responses: string[],
  testCases: TestCase[],
): number {
  if (testCases.length === 0) return 1;
  let passed = 0;
  for (let i = 0; i < testCases.length; i++) {
    const response = responses[i] ?? '';
    const tc = testCases[i];
    const lower = response.toLowerCase();
    const allExpected = tc.expectedKeywords.every((kw) =>
      lower.includes(kw.toLowerCase()),
    );
    const noForbidden = (tc.forbiddenKeywords ?? []).every(
      (kw) => !lower.includes(kw.toLowerCase()),
    );
    if (allExpected && noForbidden) passed++;
  }
  return passed / testCases.length;
}

// --- AutomaticPromptOptimizer ---

export class AutomaticPromptOptimizer {
  private readonly apiKey: string;
  private readonly rounds: number;
  private readonly timeoutMs: number;

  // Telemetry accumulators (reset on each optimize() call)
  private _telemetryCalls = 0;
  private _telemetryInputTokens = 0;
  private _telemetryOutputTokens = 0;
  private _telemetryTotalLatencyMs = 0;

  constructor(options: AutomaticPromptOptimizerOptions) {
    this.apiKey = options.apiKey;
    this.rounds = options.rounds ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Run optimization; returns an OptimizationResult with the best system prompt found */
  async optimize<TInput extends PromptInputs, TOutput>(
    mod: PromptModule<TInput, TOutput>,
    testCases: TestCase[],
  ): Promise<OptimizationResult> {
    this._telemetryCalls = 0;
    this._telemetryInputTokens = 0;
    this._telemetryOutputTokens = 0;
    this._telemetryTotalLatencyMs = 0;

    let currentSystemPrompt = mod.systemPrompt;
    let bestScore = 0;
    let improved = false;

    if (testCases.length > 0) {
      const initialResponses = await this._runTestCases(
        currentSystemPrompt,
        mod,
        testCases,
      );
      bestScore = scorePromptLocally(initialResponses, testCases);
      logger.info(
        { promptId: mod.id, initialScore: bestScore.toFixed(2) },
        'AutomaticPromptOptimizer: initial score',
      );
    }

    for (let round = 1; round <= this.rounds; round++) {
      const candidate = await this._refine(
        currentSystemPrompt,
        mod.id,
        round,
        testCases,
      );
      if (!candidate) {
        logger.warn(
          { promptId: mod.id, round },
          'AutomaticPromptOptimizer: no candidate generated, stopping',
        );
        break;
      }

      if (testCases.length === 0) {
        // No test cases to evaluate — accept the refinement directly
        currentSystemPrompt = candidate;
        improved = true;
        logger.info(
          { promptId: mod.id, round },
          'AutomaticPromptOptimizer: accepted refinement (no test cases)',
        );
        continue;
      }

      const candidateResponses = await this._runTestCases(
        candidate,
        mod,
        testCases,
      );
      const candidateScore = scorePromptLocally(candidateResponses, testCases);

      logger.info(
        {
          promptId: mod.id,
          round,
          candidateScore: candidateScore.toFixed(2),
          bestScore: bestScore.toFixed(2),
        },
        'AutomaticPromptOptimizer: round complete',
      );

      if (candidateScore > bestScore) {
        currentSystemPrompt = candidate;
        bestScore = candidateScore;
        improved = true;
      }
    }

    const telemetry: PromptTelemetry = {
      totalCalls: this._telemetryCalls,
      totalInputTokens: this._telemetryInputTokens,
      totalOutputTokens: this._telemetryOutputTokens,
      avgLatencyMs:
        this._telemetryCalls > 0
          ? Math.round(this._telemetryTotalLatencyMs / this._telemetryCalls)
          : 0,
    };

    logger.info(
      { promptId: mod.id, ...telemetry },
      'AutomaticPromptOptimizer: telemetry summary',
    );

    return {
      systemPrompt: currentSystemPrompt,
      rounds: this.rounds,
      finalScore: bestScore,
      improved,
      telemetry,
    };
  }

  /** Run all test-case inputs through the LLM and collect raw responses */
  private async _runTestCases<TInput extends PromptInputs, TOutput>(
    systemPrompt: string,
    mod: PromptModule<TInput, TOutput>,
    testCases: TestCase[],
  ): Promise<string[]> {
    const responses: string[] = [];
    for (const tc of testCases) {
      try {
        const rendered = mod.render(tc.inputs as TInput);
        const text = await this._query(rendered.user, systemPrompt);
        responses.push(text);
      } catch (err) {
        logger.warn({ err }, 'AutomaticPromptOptimizer: test case query failed');
        responses.push('');
      }
    }
    return responses;
  }

  /** Ask MiniMax to generate a refined system prompt */
  private async _refine(
    currentSystemPrompt: string,
    promptId: string,
    round: number,
    testCases: TestCase[],
  ): Promise<string | null> {
    const failingSummary =
      testCases.length > 0
        ? testCases
            .map(
              (tc, i) =>
                `Case ${i + 1}: expects [${tc.expectedKeywords.join(', ')}]` +
                (tc.forbiddenKeywords?.length
                  ? `, forbids [${tc.forbiddenKeywords.join(', ')}]`
                  : ''),
            )
            .join('\n')
        : 'No test cases provided — apply general best-practice improvements.';

    const refinementRequest = `You are an expert prompt engineer improving a system prompt.

CURRENT SYSTEM PROMPT (id=${promptId}, round=${round}):
---
${currentSystemPrompt.slice(0, 4000)}
---

TEST CASE REQUIREMENTS:
${failingSummary}

Rewrite the system prompt so that it:
1. Satisfies all required keywords in responses
2. Avoids generating any forbidden keywords
3. Preserves the original intent and response format
4. Is concise and unambiguous

Return ONLY the improved system prompt text, with no commentary.`;

    try {
      return await this._query(refinementRequest, '');
    } catch (err) {
      logger.warn({ err, promptId, round }, 'AutomaticPromptOptimizer: refinement failed');
      return null;
    }
  }

  /** Low-level MiniMax query using Bun's built-in fetch */
  private async _query(userMessage: string, systemPrompt: string): Promise<string> {
    const body: Record<string, unknown> = {
      model: MINIMAX_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: userMessage }],
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const t0 = Date.now();
    const response = await fetchWithTimeout(
      `${MINIMAX_BASE_URL}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2024-10-22',
        },
        body: JSON.stringify(body),
      },
      this.timeoutMs,
    );
    const latencyMs = Date.now() - t0;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MiniMax API ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    // Accumulate telemetry
    this._telemetryCalls++;
    this._telemetryTotalLatencyMs += latencyMs;
    this._telemetryInputTokens += data.usage?.input_tokens ?? 0;
    this._telemetryOutputTokens += data.usage?.output_tokens ?? 0;

    return data.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('');
  }
}
