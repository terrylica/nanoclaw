/**
 * Rich Telegram message presentation and A/B testing.
 *
 * Tracks engagement metrics per message format and evolves
 * templates for better user interaction.
 */
import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { escapeHtml } from '../telegram.js';
import type { EvolutionAction } from './state.js';

// --- Constants ---

const TEMPLATES_FILE = path.join(DATA_DIR, 'telegram-templates.yaml');

// --- Types ---

interface MessageTemplate {
  id: string;
  name: string;
  format: 'compact' | 'detailed';
  template: string;
  engagementRate: number;
  impressions: number;
  interactions: number;
}

// --- Template Storage ---

function loadTemplates(): MessageTemplate[] {
  try {
    if (!fs.existsSync(TEMPLATES_FILE)) return [];
    const content = fs.readFileSync(TEMPLATES_FILE, 'utf-8');
    return YAML.parse(content) || [];
  } catch {
    return [];
  }
}

function saveTemplates(templates: MessageTemplate[]): void {
  try {
    fs.mkdirSync(path.dirname(TEMPLATES_FILE), { recursive: true });
    fs.writeFileSync(TEMPLATES_FILE, YAML.stringify(templates));
  } catch (err) {
    logger.warn({ err }, 'Failed to save telegram templates');
  }
}

// --- Evolution Notification Formatters ---

/** Format a prompt evolution notification */
export function formatPromptEvolution(
  promptId: string,
  oldVersion: number,
  newVersion: number,
  oldFpRate: number,
  newFpRate?: number,
): string {
  const improvement =
    newFpRate !== undefined
      ? ` (${(oldFpRate * 100).toFixed(1)}% → ${(newFpRate * 100).toFixed(1)}% FP)`
      : ` (was ${(oldFpRate * 100).toFixed(1)}% FP)`;

  return [
    `<b>🧬 Prompt Evolved</b>`,
    ``,
    `<code>${escapeHtml(promptId)}</code> v${oldVersion} → v${newVersion}`,
    `<i>${improvement}</i>`,
  ].join('\n');
}

/** Format a rule addition notification */
export function formatRuleAdded(
  ruleName: string,
  language: string,
  source: string,
): string {
  return [
    `<b>📏 Rule Added</b>`,
    ``,
    `<code>${escapeHtml(ruleName)}</code>`,
    `Language: <code>${language}</code> | Source: <code>${source}</code>`,
  ].join('\n');
}

/** Format a stagnation alert */
export function formatStagnationAlert(
  failures: number,
  pauseDuration: string,
): string {
  return [
    `<b>⚠️ Evolution Stagnation</b>`,
    ``,
    `<code>${failures}</code> consecutive failures`,
    `Evolution paused for <code>${pauseDuration}</code>`,
    ``,
    `<i>Review recent evolution-actions.ndjson for failure patterns</i>`,
  ].join('\n');
}

/** Format an evolution action notification */
export function formatEvolutionAction(action: EvolutionAction): string {
  const icon =
    action.status === 'committed'
      ? '✅'
      : action.status === 'failed'
        ? '❌'
        : action.status === 'reverted'
          ? '↩️'
          : '🔄';

  const lines = [
    `<b>${icon} Evolution: ${escapeHtml(action.type)}</b>`,
    ``,
    `<i>${escapeHtml(action.description.slice(0, 200))}</i>`,
    `Status: <code>${action.status}</code>`,
  ];

  if (action.commitHash) {
    lines.push(`Commit: <code>${action.commitHash.slice(0, 7)}</code>`);
  }

  if (action.result) {
    lines.push(``, `<i>${escapeHtml(action.result.slice(0, 200))}</i>`);
  }

  return lines.join('\n');
}

/** Format a weekly digest */
export function formatWeeklyDigest(stats: {
  promptsEvolved: number;
  rulesAdded: number;
  tpCount: number;
  fpCount: number;
  actionsTotal: number;
  actionsSucceeded: number;
}): string {
  const fpRate =
    stats.tpCount + stats.fpCount > 0
      ? ((stats.fpCount / (stats.tpCount + stats.fpCount)) * 100).toFixed(1)
      : 'N/A';

  return [
    `<b>📊 NanoClaw Weekly Evolution Digest</b>`,
    ``,
    `• Prompts evolved: <code>${stats.promptsEvolved}</code>`,
    `• Rules added: <code>${stats.rulesAdded}</code>`,
    `• Findings: <code>${stats.tpCount}</code> TP / <code>${stats.fpCount}</code> FP (${fpRate}% FP rate)`,
    `• Evolution actions: <code>${stats.actionsSucceeded}/${stats.actionsTotal}</code> succeeded`,
  ].join('\n');
}

/** Record engagement for template metrics */
export function recordTemplateEngagement(
  templateId: string,
  interacted: boolean,
): void {
  const templates = loadTemplates();
  const tmpl = templates.find((t) => t.id === templateId);
  if (!tmpl) return;

  tmpl.impressions++;
  if (interacted) tmpl.interactions++;
  tmpl.engagementRate = tmpl.impressions > 0
    ? tmpl.interactions / tmpl.impressions
    : 0;

  saveTemplates(templates);
}
