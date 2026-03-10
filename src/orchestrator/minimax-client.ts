/**
 * MiniMax API client: query and response parsing.
 */
import { logger } from '../logger.js';
import { MINIMAX_BASE_URL, MINIMAX_MODEL } from './types.js';
import type { Finding } from './types.js';

/**
 * fetch with a hard timeout via Promise.race.
 * AbortSignal.timeout() and AbortController don't reliably abort TLS reads
 * under macOS launchd, so we race against a rejection timer instead.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`fetchWithTimeout: ${timeoutMs}ms exceeded`)),
      timeoutMs,
    ),
  );

  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function queryMiniMax(
  prompt: string,
  apiKey: string,
  systemPrompt = '',
): Promise<string> {
  const body: Record<string, unknown> = {
    model: MINIMAX_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  logger.debug('MiniMax API call starting');
  const response = await fetchWithTimeout(
    `${MINIMAX_BASE_URL}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2024-10-22',
      },
      body: JSON.stringify(body),
    },
    60_000,
  );
  logger.debug('MiniMax API response received');

  if (!response.ok) {
    const respBody = await response.text().catch(() => '');
    throw new Error(
      `MiniMax API ${response.status}: ${respBody.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const textBlocks = data.content.filter((b) => b.type === 'text' && b.text);
  return textBlocks.map((b) => b.text!).join('');
}

/** Parse a MiniMax response into findings array */
export function parseMiniMaxFindings(raw: string): Finding[] {
  let jsonStr = raw.trim();

  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const arrayMatch = jsonStr.match(/(\[[\s\S]*?\])(?:\s*\n|$)/);
  if (arrayMatch) {
    jsonStr = arrayMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    // Sanitize: ensure every finding has required string fields
    return parsed
      .filter(
        (f: Record<string, unknown>) =>
          f && typeof f === 'object' && typeof f.title === 'string',
      )
      .map((f: Record<string, unknown>) => ({
        ...f,
        title: (f.title as string) || 'Untitled finding',
        description: (f.description as string) || '',
        type: (f.type as string) || 'bug',
        severity: (f.severity as string) || 'medium',
        files: Array.isArray(f.files) ? f.files : [],
        validation: (f.validation as string) || '',
      })) as Finding[];
  } catch {
    return [];
  }
}

/** Extract words from a string for similarity comparison */
export function extractWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

export function severityRank(s: string): number {
  const ranks: Record<string, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  return ranks[s] || 0;
}

/** Deduplicate findings across perspectives using title word similarity */
export function deduplicateFindings(allFindings: Finding[]): Finding[] {
  const unique: Finding[] = [];

  for (const finding of allFindings) {
    const dupeIndex = unique.findIndex((existing) => {
      const existingWords = extractWords(existing.title);
      const newWords = extractWords(finding.title);
      const intersection = newWords.filter((w) => existingWords.includes(w));
      const union = new Set([...existingWords, ...newWords]);
      return union.size > 0 && intersection.length / union.size >= 0.4;
    });

    if (dupeIndex >= 0) {
      const existing = unique[dupeIndex];
      const newPerspectives = finding.sourcePerspectives || [];
      existing.sourcePerspectives = [
        ...new Set([
          ...(existing.sourcePerspectives || []),
          ...newPerspectives,
        ]),
      ];
      if (severityRank(finding.severity) > severityRank(existing.severity)) {
        existing.severity = finding.severity;
      }
    } else {
      unique.push(finding);
    }
  }

  return unique;
}
