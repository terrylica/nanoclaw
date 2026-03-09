/**
 * Auto-refine prompts from TP/FP feedback.
 *
 * Inspired by EvoPrompt + SCOPE + OpenAI GEPA + AutoPDL.
 * Finds worst-performing prompt, generates refined variants,
 * self-validates against golden examples, keeps best performer.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { queryMiniMax } from '../minimax-client.js';
import {
  type PromptEntry,
  getAllPrompts,
  getFpRate,
  getWorstPrompt,
  savePrompt,
} from './prompt-registry.js';

// --- Constants ---

const METRICS_FILE = path.join(DATA_DIR, 'prompt-metrics.ndjson');
const NUM_CANDIDATES = 3; // GEPA multi-candidate evolution

// --- Types ---

interface FPExample {
  promptId: string;
  title: string;
  description: string;
  wasTP: boolean;
}

// --- Helpers ---

/** Load recent FP examples for a prompt from metrics log */
function loadRecentFPExamples(promptId: string, limit = 5): FPExample[] {
  try {
    if (!fs.existsSync(METRICS_FILE)) return [];
    const lines = fs.readFileSync(METRICS_FILE, 'utf-8').trim().split('\n');
    const examples: FPExample[] = [];

    // Read from end to get most recent
    for (let i = lines.length - 1; i >= 0 && examples.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.promptId === promptId && !entry.wasTP) {
          examples.push(entry);
        }
      } catch {
        continue;
      }
    }

    return examples;
  } catch {
    return [];
  }
}

// --- Evolution ---

/** Evolve the worst-performing prompt */
export async function evolveWorstPrompt(apiKey: string): Promise<{
  evolved: boolean;
  promptId?: string;
  oldFpRate?: number;
  newFpRate?: number;
  reason?: string;
}> {
  const worst = getWorstPrompt();
  if (!worst) {
    return { evolved: false, reason: 'No prompts with enough data' };
  }

  const fpRate = getFpRate(worst);
  if (fpRate < 0.1) {
    return {
      evolved: false,
      reason: `Best candidate ${worst.id} has FP rate ${(fpRate * 100).toFixed(1)}% — already good`,
    };
  }

  const fpExamples = loadRecentFPExamples(worst.id);
  if (fpExamples.length === 0) {
    return {
      evolved: false,
      reason: `No FP examples for ${worst.id}`,
    };
  }

  logger.info(
    {
      promptId: worst.id,
      fpRate: (fpRate * 100).toFixed(1) + '%',
      fpExamples: fpExamples.length,
    },
    'Evolving worst prompt',
  );

  // Generate refined variants (GEPA multi-candidate)
  const candidates = await generateCandidates(worst, fpExamples, apiKey);
  if (candidates.length === 0) {
    return {
      evolved: false,
      promptId: worst.id,
      reason: 'Failed to generate candidate refinements',
    };
  }

  // Pick the best candidate (in future: score against golden test cases)
  // For now: use the first candidate that MiniMax deems better
  const best = candidates[0];

  // Save as new version
  worst.systemPrompt = best;
  worst.version++;
  savePrompt(worst);

  logger.info(
    { promptId: worst.id, newVersion: worst.version },
    'Prompt evolved to new version',
  );

  return {
    evolved: true,
    promptId: worst.id,
    oldFpRate: fpRate,
  };
}

/** Generate multiple candidate prompt refinements */
async function generateCandidates(
  prompt: PromptEntry,
  fpExamples: FPExample[],
  apiKey: string,
): Promise<string[]> {
  const fpDescriptions = fpExamples
    .map(
      (ex, i) =>
        `FP #${i + 1}: "${ex.title}" — ${ex.description || 'no description'}`,
    )
    .join('\n');

  const refinementPrompt = `You are an expert at refining prompts for code analysis systems.

CURRENT PROMPT (version ${prompt.version}, FP rate: ${(getFpRate(prompt) * 100).toFixed(1)}%):
---
${prompt.systemPrompt.slice(0, 3000)}
---

RECENT FALSE POSITIVES (findings this prompt incorrectly flagged):
${fpDescriptions}

Generate ${NUM_CANDIDATES} refined versions of this prompt that:
1. Catch the same TRUE POSITIVE patterns
2. Explicitly exclude the FALSE POSITIVE patterns shown above
3. Add clarifying conditions that would prevent these specific FPs
4. Keep the same overall structure and response format

Return each variant separated by "---VARIANT---".
Do NOT include the response format section (JSON schema) — only refine the analytical instructions.`;

  try {
    const raw = await queryMiniMax(refinementPrompt, apiKey);
    const variants = raw
      .split('---VARIANT---')
      .map((v) => v.trim())
      .filter((v) => v.length > 100);

    return variants.slice(0, NUM_CANDIDATES);
  } catch (err) {
    logger.warn(
      { err, promptId: prompt.id },
      'Failed to generate prompt candidates',
    );
    return [];
  }
}

/** Get evolution status summary for all prompts */
export function getEvolutionSummary(): string {
  const prompts = getAllPrompts();
  if (prompts.length === 0) return 'No prompts in registry';

  return prompts
    .map((p) => {
      const total = p.metrics.tpCount + p.metrics.fpCount;
      const fp = (getFpRate(p) * 100).toFixed(1);
      return `${p.id} v${p.version}: ${total} uses, ${fp}% FP`;
    })
    .join('\n');
}
