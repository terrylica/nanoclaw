/**
 * Dynamic prompt library with metrics tracking.
 *
 * Loads prompts from data/prompts/*.yaml with hardcoded fallback.
 * Records TP/FP results per prompt for evolution feedback.
 */
import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';

// --- Types ---

export interface PromptMetrics {
  uses: number;
  tpCount: number;
  fpCount: number;
  avgConfidence: number;
  lastUsed: string;
}

export interface PromptEntry {
  id: string;
  name: string;
  version: number;
  systemPrompt: string;
  userPromptTemplate: string;
  metrics: PromptMetrics;
}

// --- Constants ---

const PROMPTS_DIR = path.join(DATA_DIR, 'prompts');
const METRICS_FILE = path.join(DATA_DIR, 'prompt-metrics.ndjson');

// --- Registry ---

const registry = new Map<string, PromptEntry>();

/** Load a single prompt from YAML file */
function loadPromptFile(filePath: string): PromptEntry | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = YAML.parse(content);
    if (!data?.id || !data?.systemPrompt) return null;
    return {
      id: data.id,
      name: data.name || data.id,
      version: data.version || 1,
      systemPrompt: data.systemPrompt,
      userPromptTemplate: data.userPromptTemplate || '',
      metrics: data.metrics || {
        uses: 0,
        tpCount: 0,
        fpCount: 0,
        avgConfidence: 0,
        lastUsed: '',
      },
    };
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to load prompt file');
    return null;
  }
}

/** Load all prompts from data/prompts/ directory */
export function loadAllPrompts(): void {
  registry.clear();
  if (!fs.existsSync(PROMPTS_DIR)) return;

  const files = fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const entry = loadPromptFile(path.join(PROMPTS_DIR, file));
    if (entry) {
      registry.set(entry.id, entry);
    }
  }
  logger.info({ count: registry.size }, 'Loaded prompts from registry');
}

/** Get a prompt by ID, returning null if not found */
export function getPrompt(id: string): PromptEntry | null {
  return registry.get(id) || null;
}

/** Get all registered prompts */
export function getAllPrompts(): PromptEntry[] {
  return [...registry.values()];
}

/** Record a TP/FP result for a prompt */
export function recordResult(
  promptId: string,
  wasTP: boolean,
  confidence?: number,
): void {
  const entry = registry.get(promptId);
  if (!entry) return;

  entry.metrics.uses++;
  if (wasTP) {
    entry.metrics.tpCount++;
  } else {
    entry.metrics.fpCount++;
  }
  if (confidence !== undefined) {
    const total = entry.metrics.tpCount + entry.metrics.fpCount;
    entry.metrics.avgConfidence =
      (entry.metrics.avgConfidence * (total - 1) + confidence) / total;
  }
  entry.metrics.lastUsed = new Date().toISOString();

  // Persist updated prompt back to YAML
  savePrompt(entry);

  // Append to NDJSON metrics log
  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
    const logEntry = JSON.stringify({
      ts: new Date().toISOString(),
      promptId,
      wasTP,
      confidence,
      fpRate: getFpRate(entry),
    });
    fs.appendFileSync(METRICS_FILE, logEntry + '\n');
  } catch {
    // Metrics logging is non-fatal
  }
}

/** Get FP rate for a prompt (0-1) */
export function getFpRate(entry: PromptEntry): number {
  const total = entry.metrics.tpCount + entry.metrics.fpCount;
  if (total === 0) return 0;
  return entry.metrics.fpCount / total;
}

/** Get prompt metrics summary */
export function getMetrics(): Array<{
  id: string;
  name: string;
  fpRate: number;
  uses: number;
}> {
  return getAllPrompts().map((p) => ({
    id: p.id,
    name: p.name,
    fpRate: getFpRate(p),
    uses: p.metrics.uses,
  }));
}

/** Save a prompt entry to its YAML file */
export function savePrompt(entry: PromptEntry): void {
  try {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    const filePath = path.join(PROMPTS_DIR, `${entry.id}.yaml`);
    fs.writeFileSync(filePath, YAML.stringify(entry));
  } catch (err) {
    logger.warn({ id: entry.id, err }, 'Failed to save prompt file');
  }
}

/** Get the worst-performing prompt by FP rate (min 5 uses) */
export function getWorstPrompt(): PromptEntry | null {
  const candidates = getAllPrompts().filter((p) => p.metrics.uses >= 5);
  if (candidates.length === 0) return null;
  return candidates.reduce((worst, p) =>
    getFpRate(p) > getFpRate(worst) ? p : worst,
  );
}

/** Seed the registry from hardcoded defaults if data/prompts/ is empty */
export function seedIfEmpty(
  defaults: Array<{ id: string; name: string; systemPrompt: string }>,
): void {
  loadAllPrompts();
  if (registry.size > 0) return;

  logger.info(
    { count: defaults.length },
    'Seeding prompt registry from hardcoded defaults',
  );
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });

  for (const def of defaults) {
    const entry: PromptEntry = {
      id: def.id,
      name: def.name,
      version: 1,
      systemPrompt: def.systemPrompt,
      userPromptTemplate: '',
      metrics: {
        uses: 0,
        tpCount: 0,
        fpCount: 0,
        avgConfidence: 0,
        lastUsed: '',
      },
    };
    registry.set(entry.id, entry);
    savePrompt(entry);
  }
}
