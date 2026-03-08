/**
 * MiniMax API client: query and response parsing.
 */
import { MINIMAX_BASE_URL, MINIMAX_MODEL } from './types.js';
import type { Finding } from './types.js';

export async function queryMiniMax(
  prompt: string,
  apiKey: string,
  systemPrompt = '',
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const body: Record<string, unknown> = {
      model: MINIMAX_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2024-10-22',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

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
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
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
    return Array.isArray(parsed) ? parsed : [];
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
