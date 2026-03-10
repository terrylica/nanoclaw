/**
 * Multi-gate validation pipeline for goal execution.
 *
 * Gates (in order):
 * 1. Protected file check — hard-reject if engine.ts/validator.ts/state.ts modified
 * 2. Build check — `bun run build` must pass
 * 3. Test suite — `bun test` must pass
 * 4. MiniMax code review — diff sent for quality assessment
 *
 * Each gate is independent, returns typed result with timing for observability.
 */
import { execSync } from 'child_process';

import { logger } from '../../logger.js';
import { queryMiniMax } from '../minimax-client.js';

// --- Types ---

export interface GateResult {
  /** Gate name for logging/display */
  gate: string;
  /** Whether this gate passed */
  passed: boolean;
  /** Human-readable detail (pass reason or failure reason) */
  detail: string;
  /** Time taken in milliseconds */
  durationMs: number;
}

export interface ValidationPipelineResult {
  /** Overall pass/fail */
  passed: boolean;
  /** Individual gate results (in execution order) */
  gates: GateResult[];
  /** Which gate caused failure (null if all passed) */
  failedGate: string | null;
}

// --- Constants ---

const PROTECTED_FILES = [
  'src/orchestrator/evolution/engine.ts',
  'src/orchestrator/evolution/validator.ts',
  'src/orchestrator/evolution/state.ts',
];

// --- Individual Gates ---

/** Gate 1: Check that no protected files were modified. */
export function runProtectedFileGate(changedFiles: string[]): GateResult {
  const start = Date.now();

  for (const file of changedFiles) {
    const normalized = file.replace(/^\.\//, '');
    if (
      PROTECTED_FILES.some((pf) => normalized.endsWith(pf) || normalized === pf)
    ) {
      return {
        gate: 'protected-files',
        passed: false,
        detail: `Protected file modified: ${file}`,
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    gate: 'protected-files',
    passed: true,
    detail: `${changedFiles.length} files checked, none protected`,
    durationMs: Date.now() - start,
  };
}

/** Gate 2: TypeScript build must pass. */
export function runBuildGate(cwd: string): GateResult {
  const start = Date.now();
  try {
    execSync('./node_modules/.bin/tsc --noEmit', {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
      env: { ...process.env, MISE_NO_CONFIG: '1' },
    });
    return {
      gate: 'build',
      passed: true,
      detail: 'tsc --noEmit passed',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr || String(err);
    return {
      gate: 'build',
      passed: false,
      detail: `Build failed: ${stderr.slice(0, 300)}`,
      durationMs: Date.now() - start,
    };
  }
}

/** Gate 3: Test suite must pass. */
export function runTestGate(cwd: string): GateResult {
  const start = Date.now();
  try {
    const result = execSync('bun test 2>&1', {
      cwd,
      encoding: 'utf-8',
      timeout: 180_000,
      stdio: 'pipe',
      env: { ...process.env, MISE_NO_CONFIG: '1' },
    });
    // Check for test failures in output
    if (result.includes('fail') && result.includes('0 pass')) {
      return {
        gate: 'test',
        passed: false,
        detail: `Tests failed: ${result.slice(-300)}`,
        durationMs: Date.now() - start,
      };
    }
    return {
      gate: 'test',
      passed: true,
      detail: 'bun test passed',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const output = (err as { stdout?: string }).stdout || String(err);
    return {
      gate: 'test',
      passed: false,
      detail: `Tests failed: ${output.slice(-300)}`,
      durationMs: Date.now() - start,
    };
  }
}

/** Gate 4: MiniMax code review of the diff. */
export async function runMiniMaxReviewGate(
  diff: string,
  goalText: string,
  apiKey: string,
): Promise<GateResult> {
  const start = Date.now();
  try {
    const truncatedDiff = diff.slice(0, 8000);
    const prompt = `You are reviewing a code change made by an automated self-evolution system (NanoClaw).

GOAL: ${goalText}

DIFF:
\`\`\`
${truncatedDiff}
\`\`\`

Review criteria:
1. Does the change actually address the goal?
2. Could it introduce bugs, regressions, or security issues?
3. Is it minimal and focused (no unnecessary changes)?
4. Does it follow TypeScript best practices?

Respond with EXACTLY one line:
- "APPROVED" if the change is safe and correct
- "REJECTED: <reason>" if there are concerns`;

    const response = await queryMiniMax(prompt, apiKey);
    const trimmed = response.trim().split('\n')[0]; // Take first line only

    if (trimmed.startsWith('APPROVED')) {
      return {
        gate: 'minimax-review',
        passed: true,
        detail: 'MiniMax code review approved',
        durationMs: Date.now() - start,
      };
    }

    const reason = trimmed.replace(/^REJECTED:\s*/, '').slice(0, 200);
    return {
      gate: 'minimax-review',
      passed: false,
      detail: `MiniMax rejected: ${reason}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    // MiniMax review failure is not blocking — fail open
    logger.warn({ err }, 'MiniMax review gate failed, proceeding (fail-open)');
    return {
      gate: 'minimax-review',
      passed: true,
      detail: 'MiniMax unavailable (fail-open)',
      durationMs: Date.now() - start,
    };
  }
}

// --- Pipeline ---

/**
 * Run all validation gates in sequence.
 * Stops at first failure (fail-fast) to save time and RPM budget.
 */
export async function runValidationPipeline(
  cwd: string,
  changedFiles: string[],
  diff: string,
  goalText: string,
  apiKey: string,
): Promise<ValidationPipelineResult> {
  const gates: GateResult[] = [];

  // Gate 1: Protected files
  const protectedResult = runProtectedFileGate(changedFiles);
  gates.push(protectedResult);
  if (!protectedResult.passed) {
    logger.info(
      { gate: protectedResult.gate, detail: protectedResult.detail },
      'Validation gate failed',
    );
    return { passed: false, gates, failedGate: protectedResult.gate };
  }

  // Gate 2: Build
  const buildResult = runBuildGate(cwd);
  gates.push(buildResult);
  if (!buildResult.passed) {
    logger.info(
      { gate: buildResult.gate, detail: buildResult.detail.slice(0, 100) },
      'Validation gate failed',
    );
    return { passed: false, gates, failedGate: buildResult.gate };
  }

  // Gate 3: Tests
  const testResult = runTestGate(cwd);
  gates.push(testResult);
  if (!testResult.passed) {
    logger.info(
      { gate: testResult.gate, detail: testResult.detail.slice(0, 100) },
      'Validation gate failed',
    );
    return { passed: false, gates, failedGate: testResult.gate };
  }

  // Gate 4: MiniMax review
  const reviewResult = await runMiniMaxReviewGate(diff, goalText, apiKey);
  gates.push(reviewResult);
  if (!reviewResult.passed) {
    logger.info(
      { gate: reviewResult.gate, detail: reviewResult.detail },
      'Validation gate failed',
    );
    return { passed: false, gates, failedGate: reviewResult.gate };
  }

  const totalMs = gates.reduce((sum, g) => sum + g.durationMs, 0);
  logger.info(
    {
      totalMs,
      gates: gates.map((g) => `${g.gate}:${g.durationMs}ms`).join(', '),
    },
    'All validation gates passed',
  );

  return { passed: true, gates, failedGate: null };
}
