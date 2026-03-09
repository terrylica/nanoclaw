/**
 * Self-validation gate for evolution actions.
 *
 * Auto-approved: prompts, rules, perspectives, FP patterns, research.
 * Requires user approval: source changes, repo onboarding, credential changes.
 *
 * Protected files: validator.ts and engine.ts are NEVER self-modifiable.
 * Silent quality filter: MiniMax reviews auto-approved actions before commit.
 */
import { execSync } from 'child_process';
import path from 'path';

import { logger } from '../../logger.js';
import { queryMiniMax } from '../minimax-client.js';
import type { EvolutionAction, EvolutionActionType } from './state.js';

// --- Protected Files (never self-modifiable) ---

const PROTECTED_FILES = [
  'src/orchestrator/evolution/validator.ts',
  'src/orchestrator/evolution/engine.ts',
];

// --- Auto-approved action types ---

const AUTO_APPROVED_TYPES: EvolutionActionType[] = [
  'prompt-refine',
  'prompt-new',
  'rule-generate',
  'rule-import',
  'perspective-new',
  'fp-pattern-update',
  'research',
  'issue-landscape',
];

// --- Allowed directories for auto-approved actions ---

const ALLOWED_DIRS = [
  'data/prompts/',
  'data/',
  'rules/community/',
  'rules/generated/',
  'rules/opengrep/',
];

// --- Validation ---

export interface ValidationGateResult {
  approved: boolean;
  reason: string;
  requiresUserApproval: boolean;
}

/** Check if an action type is auto-approvable */
export function isAutoApproved(type: EvolutionActionType): boolean {
  return AUTO_APPROVED_TYPES.includes(type);
}

/** Validate that changed files are within allowed scope */
export function validateFileScope(files: string[]): ValidationGateResult {
  for (const file of files) {
    // Block changes to protected files
    if (PROTECTED_FILES.some((pf) => file.endsWith(pf))) {
      return {
        approved: false,
        reason: `Protected file: ${file}`,
        requiresUserApproval: false,
      };
    }
  }

  return {
    approved: true,
    reason: 'All files within allowed scope',
    requiresUserApproval: false,
  };
}

/** Run full validation gate for an evolution action */
export async function validateAction(
  action: EvolutionAction,
  changedFiles: string[],
  repoPath: string,
  apiKey: string,
): Promise<ValidationGateResult> {
  // Check if action requires user approval
  if (!isAutoApproved(action.type)) {
    return {
      approved: false,
      reason: `Action type '${action.type}' requires user approval`,
      requiresUserApproval: true,
    };
  }

  // Check file scope
  const scopeResult = validateFileScope(changedFiles);
  if (!scopeResult.approved) return scopeResult;

  // Check files are within allowed directories
  for (const file of changedFiles) {
    const inAllowed = ALLOWED_DIRS.some((dir) => file.startsWith(dir));
    if (!inAllowed) {
      return {
        approved: false,
        reason: `File '${file}' outside allowed directories for auto-approval`,
        requiresUserApproval: true,
      };
    }
  }

  // Check changed files parse without errors (for YAML files)
  for (const file of changedFiles) {
    if (file.endsWith('.yaml') || file.endsWith('.yml')) {
      try {
        const fullPath = path.join(repoPath, file);
        const { parse } = await import('yaml');
        const content = (await import('fs')).readFileSync(fullPath, 'utf-8');
        parse(content); // Throws on invalid YAML
      } catch (err) {
        return {
          approved: false,
          reason: `YAML parse error in ${file}: ${String(err).slice(0, 100)}`,
          requiresUserApproval: false,
        };
      }
    }
  }

  // Check build passes if any TypeScript was changed
  const hasTs = changedFiles.some(
    (f) => f.endsWith('.ts') || f.endsWith('.tsx'),
  );
  if (hasTs) {
    try {
      execSync('bun run build', {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch (err) {
      return {
        approved: false,
        reason: `Build failed: ${String(err).slice(0, 200)}`,
        requiresUserApproval: false,
      };
    }
  }

  // Silent quality filter: MiniMax reviews the action
  const qualityResult = await runSilentQualityFilter(
    action,
    changedFiles,
    apiKey,
  );
  if (!qualityResult.approved) return qualityResult;

  return {
    approved: true,
    reason: 'All validation gates passed',
    requiresUserApproval: false,
  };
}

/** MiniMax-based quality review before commit (silent quality filter) */
async function runSilentQualityFilter(
  action: EvolutionAction,
  changedFiles: string[],
  apiKey: string,
): Promise<ValidationGateResult> {
  try {
    const prompt = `You are reviewing an automated evolution action for NanoClaw (a code analysis orchestrator).

ACTION:
- Type: ${action.type}
- Description: ${action.description}
- Files changed: ${changedFiles.join(', ')}

Quick review — answer YES or NO:
1. Is this change coherent (makes logical sense)?
2. Does it conflict with existing patterns?
3. Is it an improvement over the current state?

If ALL answers are satisfactory, respond with exactly: APPROVED
If any concern, respond with: REJECTED: <one-line reason>`;

    const response = await queryMiniMax(prompt, apiKey);
    const trimmed = response.trim();

    if (trimmed.startsWith('APPROVED')) {
      return {
        approved: true,
        reason: 'Silent quality filter passed',
        requiresUserApproval: false,
      };
    }

    const reason = trimmed.replace(/^REJECTED:\s*/, '').slice(0, 200);
    return {
      approved: false,
      reason: `Quality filter: ${reason}`,
      requiresUserApproval: false,
    };
  } catch (err) {
    // Quality filter failure is not blocking — fail open
    logger.warn({ err }, 'Silent quality filter failed, proceeding');
    return {
      approved: true,
      reason: 'Quality filter unavailable (fail-open)',
      requiresUserApproval: false,
    };
  }
}
