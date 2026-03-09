/**
 * Validation pipeline: consensus round, devil's advocate, FP learning,
 * verification scripts, and Claude Code validation.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { readRepoFile } from './git-ops.js';
import { parseMiniMaxFindings, queryMiniMax } from './minimax-client.js';
import { escapeHtml, notify } from './telegram.js';
import { CLAUDE_VALIDATION_TIMEOUT_MS } from './types.js';
import type { Finding, ValidationResult } from './types.js';

// --- Target repo (set by main loop) ---

let _targetRepo = '';

export function setTargetRepo(repo: string): void {
  _targetRepo = repo;
}

export function getTargetRepo(): string {
  return _targetRepo;
}

// --- False Positive Learning ---

const FP_PATTERNS_FILE = path.join(DATA_DIR, 'false-positive-patterns.json');

export function loadFalsePositivePatterns(): string[] {
  try {
    if (fs.existsSync(FP_PATTERNS_FILE)) {
      return JSON.parse(fs.readFileSync(FP_PATTERNS_FILE, 'utf-8'));
    }
  } catch {
    logger.warn('Failed to load false positive patterns');
    notify(
      `<b>⚠️ FP Pattern DB</b>\n\nFailed to parse false-positive patterns file. Using empty pattern list.`,
    ).catch(() => {});
  }
  return [];
}

export function syncFalsePositivePatterns(): void {
  try {
    const result = execSync(
      `gh issue list --repo ${_targetRepo} --label nanoclaw --state closed --json title,state --limit 50`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const issues = JSON.parse(result) as Array<{
      title: string;
      state: string;
    }>;

    const fpTitles = issues.map((i) => i.title);

    if (fpTitles.length > 0) {
      fs.mkdirSync(path.dirname(FP_PATTERNS_FILE), { recursive: true });
      fs.writeFileSync(FP_PATTERNS_FILE, JSON.stringify(fpTitles, null, 2));
      logger.info(
        { count: fpTitles.length },
        'False positive patterns synced from closed issues',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to sync false positive patterns');
    notify(
      `<b>⚠️ FP Pattern Sync Failed</b>\n\n<code>${escapeHtml(String(err).slice(0, 200))}</code>`,
    ).catch(() => {});
  }
}

// --- Consensus Round ---

export async function runConsensusRound(
  findings: Finding[],
  diff: string,
  changedFiles: string[],
  apiKey: string,
  repoPath: string,
): Promise<Finding[]> {
  const fileContents = changedFiles
    .slice(0, 5)
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      return `--- ${f} ---\n${content.slice(0, 8_000)}\n`;
    })
    .filter(Boolean)
    .join('\n');

  const consensusPrompt = `You are a skeptical senior engineer reviewing findings from automated code analysis.

FINDINGS TO REVIEW:
${JSON.stringify(findings, null, 2)}

CHANGED FILES:
${changedFiles.join('\n')}

RELEVANT SOURCE CODE:
${fileContents.slice(0, 30_000)}

DIFF:
${diff.slice(0, 20_000)}

For each finding, determine if it is:
1. VALID — a genuine concern that should be investigated
2. FALSE_POSITIVE — incorrect, already handled, or by design

Respond with a JSON array containing ONLY the valid findings (copy them exactly).
If ALL findings are false positives, respond with: []

Be skeptical. A finding is only valid if you can see the actual problem in the source code.

JSON:`;

  const consensusSystem = `You are a senior engineer at a financial data company reviewing automated code analysis findings. Your job is to AGGRESSIVELY eliminate false positives by cross-referencing findings against the actual source code.

COMMON FALSE POSITIVE PATTERNS TO CHECK:
1. "Silent catch/pass" in best-effort utility code — if the function is optional/fallback, silent failure is correct
2. "State not persisted" when the design is intentionally stateless (e.g., adaptive loops that re-evaluate freshness)
3. "Missing error handling" when the code has platform guards or early returns that make the error path unreachable
4. "Hardcoded value" when it's a tuned parameter with comments explaining the choice
5. "Missing test" for trivial getters, configuration, or platform-specific paths
6. "Performance concern" for code that runs infrequently (startup, shutdown, config load)
7. "Resource leak" when the resource is cleaned up by scope/RAII/context manager

When in doubt, REJECT the finding. A false positive issue wastes more time than a missed real bug.`;

  try {
    const raw = await queryMiniMax(consensusPrompt, apiKey, consensusSystem);
    const consensusFindings = parseMiniMaxFindings(raw);

    logger.info(
      { input: findings.length, output: consensusFindings.length },
      'Consensus round complete',
    );

    if (consensusFindings.length > 0 || raw.includes('[')) {
      return consensusFindings;
    }
    logger.warn(
      'Consensus round returned unparseable response, keeping originals',
    );
    await notify(
      `<b>⚠️ Consensus Round</b>\n\nUnparseable response from MiniMax. Keeping ${findings.length} original findings.`,
    );
    return findings;
  } catch (err) {
    logger.warn({ err }, 'Consensus round failed, keeping original findings');
    await notify(
      `<b>⚠️ Consensus Round Failed</b>\n\n<code>${escapeHtml(String(err).slice(0, 200))}</code>\n\nKeeping ${findings.length} original findings.`,
    );
    return findings;
  }
}

// --- Devil's Advocate ---

export async function runDevilsAdvocateRound(
  findings: Finding[],
  changedFiles: string[],
  apiKey: string,
  repoPath: string,
): Promise<Finding[]> {
  const fileContents = changedFiles
    .slice(0, 5)
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      return `--- ${f} ---\n${content.slice(0, 10_000)}\n`;
    })
    .filter(Boolean)
    .join('\n');

  const advocatePrompt = `You are a DEVIL'S ADVOCATE. Your job is to DEFEND the code and DISPROVE each finding.

For each finding below, argue why the code is CORRECT as written. Consider:
- Is this behavior intentional for the specific use case (financial data processing)?
- Is the "problem" actually handled by a guard, fallback, or platform check elsewhere?
- Is this a standard pattern in Rust/Python that looks wrong but is correct?
- Would "fixing" this actually break something or add unnecessary complexity?
- Is the "missing" feature actually unneeded for this architecture?

FINDINGS TO CHALLENGE:
${JSON.stringify(findings, null, 2)}

SOURCE CODE:
${fileContents.slice(0, 40_000)}

For each finding, respond with:
- SURVIVES — if you CANNOT find a good defense for the code (the finding is genuinely problematic)
- DISPROVED — if you CAN explain why the code is correct as-is

Respond with a JSON array containing ONLY the findings that SURVIVE your challenge.
If you can disprove ALL findings, respond with: []

JSON:`;

  const advocateSystem = `You are a code defense attorney. Your expertise is finding legitimate reasons why code that LOOKS problematic is actually correct. You know that:
- Best-effort utilities (allocator hints, cache warmup) should fail silently
- Stateless loops are often better than stateful ones (freshness re-evaluation)
- Platform guards make certain error paths unreachable
- Financial systems often have intentionally conservative/simple error handling
- "Missing" persistence is often "intentionally absent" persistence

Your bias is toward DEFENDING the code. Only let a finding survive if you genuinely cannot explain the code's behavior as correct.`;

  try {
    const t0 = Date.now();
    const raw = await queryMiniMax(advocatePrompt, apiKey, advocateSystem);
    const survivingFindings = parseMiniMaxFindings(raw);
    const durationMs = Date.now() - t0;

    logger.info(
      {
        input: findings.length,
        surviving: survivingFindings.length,
        durationMs,
      },
      "Devil's advocate round complete",
    );

    if (survivingFindings.length > 0 || raw.includes('[')) {
      return survivingFindings;
    }
    logger.warn(
      "Devil's advocate returned unparseable response, keeping originals",
    );
    await notify(
      `<b>⚠️ Devil's Advocate</b>\n\nUnparseable response from MiniMax. Keeping ${findings.length} original findings.`,
    );
    return findings;
  } catch (err) {
    logger.warn({ err }, "Devil's advocate round failed, keeping findings");
    await notify(
      `<b>⚠️ Devil's Advocate Failed</b>\n\n<code>${escapeHtml(String(err).slice(0, 200))}</code>\n\nKeeping ${findings.length} findings.`,
    );
    return findings;
  }
}

// --- Verification Script Execution ---

export function verifyFindingScript(
  finding: Finding,
  repoPath: string,
): { verified: boolean; output: string } {
  const cmd = finding.validation?.trim();
  if (!cmd || cmd.length < 3) {
    return { verified: false, output: 'No validation command provided' };
  }

  const allowedPrefixes = [
    'grep',
    'rg',
    'find',
    'cat',
    'head',
    'tail',
    'wc',
    'cargo',
    'python',
    'pytest',
    'ls',
  ];
  const firstWord = cmd.split(/\s+/)[0];
  if (!allowedPrefixes.some((p) => firstWord.startsWith(p))) {
    logger.info(
      { cmd: cmd.slice(0, 50), title: finding.title },
      'Validation command not in allowlist, skipping verification',
    );
    return {
      verified: true,
      output: 'Command not verifiable (not in allowlist)',
    };
  }

  try {
    const result = execSync(cmd, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    const output = result.trim();
    if (output.length === 0) {
      logger.info(
        { title: finding.title, cmd: cmd.slice(0, 80) },
        'Verification script returned empty — finding may be hallucinated',
      );
      return { verified: false, output: 'Command returned empty output' };
    }
    return { verified: true, output: output.slice(0, 500) };
  } catch (err) {
    logger.info(
      { title: finding.title, cmd: cmd.slice(0, 80), err },
      'Verification script failed — finding likely hallucinated',
    );
    return {
      verified: false,
      output: `Command failed: ${String(err).slice(0, 200)}`,
    };
  }
}

// --- Claude Code Validation ---

export function validateWithClaude(
  finding: Finding,
  repoPath: string,
  headCommit: string,
): ValidationResult | null {
  const fileContexts = finding.files
    .map((f) => {
      const content = readRepoFile(repoPath, f);
      if (!content) return '';
      const truncated =
        content.length > 10_000
          ? content.slice(0, 10_000) + '\n... (truncated)'
          : content;
      return `--- ${f} ---\n${truncated}\n`;
    })
    .filter(Boolean)
    .join('\n');

  const prompt = `You are the FINAL GATE before a GitHub issue is auto-created for opendeviationbar-py (Rust+Python maturin project, financial data processing). A false positive wastes the maintainer's time. Be EXTREMELY skeptical.

FINDING TO VALIDATE:
- Type: ${finding.type}
- Severity: ${finding.severity}
- Title: ${finding.title}
- Description: ${finding.description}
- Files: ${finding.files.join(', ')}
- Suggested validation: ${finding.validation}
- Commit: ${headCommit.slice(0, 7)}

FULL SOURCE CODE OF AFFECTED FILES:
${fileContexts || '(files not readable)'}

VALIDATION CHECKLIST — answer each before deciding:
1. Can you see the EXACT code that's problematic? (not just infer it from the diff)
2. Is there a guard, fallback, or early return that makes this unreachable?
3. Is this behavior intentional for the specific domain (financial data, 24/7 daemons)?
4. Would the suggested fix actually improve things, or add unnecessary complexity?
5. Could this be a best-effort utility where silent failure is correct?
6. Is the "missing" feature actually unneeded for this architecture?

Respond with EXACTLY this JSON format (no markdown fences, no extra text):
{"confirmed": true/false, "confidence": "low"/"medium"/"high", "analysis": "2-3 sentence explanation referencing specific line numbers", "suggestedFix": "optional fix suggestion"}

RULES:
- confirmed=true ONLY if you can point to specific lines where the bug/issue exists
- confirmed=false if: it's by-design, already handled, unreachable, or a false positive
- When in doubt, set confirmed=false — missing a real bug is better than filing a false positive
- confidence=high means you checked all 6 questions above and are certain
- Reference specific line numbers or code snippets in your analysis`;

  try {
    logger.info(
      { title: finding.title, files: finding.files },
      'Validating finding with Claude',
    );

    const result = spawnSync('claude', ['-p', '--output-format', 'text'], {
      input: prompt,
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: CLAUDE_VALIDATION_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    if (result.error || result.status !== 0) {
      const errMsg =
        result.error?.message || result.stderr?.slice(0, 200) || 'unknown';
      logger.error(
        {
          title: finding.title,
          error: errMsg,
          status: result.status,
        },
        'Claude validation failed',
      );
      notify(
        `<b>❌ Claude Validation Failed</b>\n\n<code>${escapeHtml(finding.title.slice(0, 80))}</code>\nExit: <code>${result.status}</code>\n<code>${escapeHtml(errMsg.slice(0, 150))}</code>`,
      ).catch(() => {});
      return null;
    }

    const output = result.stdout.trim();

    let jsonStr = output;
    const jsonMatch = output.match(/\{[\s\S]*"confirmed"[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    let validation: ValidationResult;
    try {
      validation = JSON.parse(jsonStr);
    } catch (parseErr) {
      logger.error(
        {
          title: finding.title,
          output: output.slice(0, 500),
          parseErr,
        },
        'Claude validation JSON parse failed — response logged for debugging',
      );
      notify(
        `<b>❌ Claude JSON Parse Failed</b>\n\n<code>${escapeHtml(finding.title.slice(0, 80))}</code>\nResponse: <code>${escapeHtml(output.slice(0, 150))}</code>`,
      ).catch(() => {});
      return null;
    }

    if (
      typeof validation.confirmed !== 'boolean' ||
      !validation.confidence ||
      !validation.analysis
    ) {
      logger.error(
        {
          title: finding.title,
          parsed: JSON.stringify(validation).slice(0, 200),
        },
        'Claude validation missing required fields (confirmed/confidence/analysis)',
      );
      notify(
        `<b>❌ Claude Validation Malformed</b>\n\n<code>${escapeHtml(finding.title.slice(0, 80))}</code>\nMissing required fields (confirmed/confidence/analysis).`,
      ).catch(() => {});
      return null;
    }

    logger.info(
      {
        title: finding.title,
        confirmed: validation.confirmed,
        confidence: validation.confidence,
      },
      'Claude validation result',
    );

    return validation;
  } catch (err) {
    logger.error({ err, title: finding.title }, 'Claude validation error');
    notify(
      `<b>❌ Claude Validation Error</b>\n\n<code>${escapeHtml(finding.title.slice(0, 80))}</code>\n<code>${escapeHtml(String(err).slice(0, 150))}</code>`,
    ).catch(() => {});
    return null;
  }
}
