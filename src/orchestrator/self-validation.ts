/**
 * Iterative MiniMax self-validation: 3 adversarial rounds that
 * challenge findings before they reach the main pipeline.
 */
import { logger } from '../logger.js';
import { getPrompt } from './evolution/prompt-registry.js';
import { readRepoFile } from './git-ops.js';
import { parseMiniMaxFindings, queryMiniMax } from './minimax-client.js';
import { traceId } from './types.js';
import type { Finding } from './types.js';

// Registry prompt IDs → self-validation round metadata
const ROUND_REGISTRY_MAP = [
  { registryId: 'self-val-fact-check', name: 'Fact-Check', icon: '🔬' },
  {
    registryId: 'self-val-domain-rebuttal',
    name: 'Domain Rebuttal',
    icon: '📊',
  },
  {
    registryId: 'self-val-reproducibility',
    name: 'Reproducibility Check',
    icon: '🧪',
  },
];

// Hardcoded fallbacks
const FALLBACK_ROUNDS = [
  {
    name: 'Fact-Check',
    icon: '🔬',
    systemPrompt: `You are a rigorous fact-checker for code analysis findings. Your job is to DISPROVE each finding below.

For each finding, check:
1. Does the cited function/line ACTUALLY exist in the source code shown?
2. Is the described behavior ACTUALLY what the code does? Trace the logic step by step.
3. Is the "expected vs actual" comparison LOGICALLY sound?
4. Could the finding be a misreading of the code's intent?

Respond with a JSON array of findings that SURVIVE your scrutiny — findings you could NOT disprove.
Keep the same JSON schema (type, severity, title, description, files, validation, confidence).
If a finding is clearly wrong or hallucinated, DROP IT from the array.
If ALL findings are bogus, respond with: []`,
  },
  {
    name: 'Domain Rebuttal',
    icon: '📊',
    systemPrompt: `You are a financial data systems expert reviewing code analysis findings for a FINANCIAL TICK DATA PROCESSING library (opendeviationbar-py).

For each finding, challenge it from a domain perspective:
1. Is this ACTUALLY a bug in financial data context, or is it an intentional design choice? (e.g., best-effort error handling is normal in market data)
2. Would this bug ACTUALLY produce wrong financial results, or is it theoretical?
3. Is the severity rating appropriate for a financial system? Overstated? Understated?
4. Are there upstream/downstream safeguards that would catch this before it affects real trades?

Respond with a JSON array of findings that SURVIVE your domain challenge.
Adjust severity if warranted. Drop findings that are domain-appropriate behavior.
If ALL findings are domain-appropriate, respond with: []`,
  },
  {
    name: 'Reproducibility Check',
    icon: '🧪',
    systemPrompt: `You are a testing engineer who only accepts findings with REPRODUCIBLE evidence.

For each finding, demand:
1. Can you construct a CONCRETE input that triggers this bug? If not, it's speculative.
2. Is the validation command actually runnable? Would it catch this specific issue?
3. Is the described failure mode OBSERVABLE or purely theoretical?
4. Would a unit test catch this, or is it only visible under specific production conditions?

Respond with a JSON array of findings that have REPRODUCIBLE evidence.
Drop any finding where you cannot construct a concrete triggering input.
If ALL findings are speculative, respond with: []`,
  },
];

/** Load self-validation rounds from registry, falling back to hardcoded */
function getSelfValidationRounds(): typeof FALLBACK_ROUNDS {
  return ROUND_REGISTRY_MAP.map(({ registryId, name, icon }) => {
    const entry = getPrompt(registryId);
    if (entry) {
      return { name, icon, systemPrompt: entry.systemPrompt };
    }
    return FALLBACK_ROUNDS.find((r) => r.name === name)!;
  });
}

/**
 * Run iterative MiniMax self-validation: challenge findings through multiple
 * adversarial rounds before they reach the main validation pipeline.
 */
export async function runIterativeSelfValidation(
  findings: Finding[],
  repoPath: string,
  apiKey: string,
  tg: (msg: string) => Promise<void>,
): Promise<Finding[]> {
  if (findings.length === 0) return [];

  let survivors = findings;

  const rounds = getSelfValidationRounds();
  for (const round of rounds) {
    if (survivors.length === 0) break;

    const roundTid = traceId();

    await tg(
      [
        `<b>${round.icon} Self-Validation: ${round.name}</b>`,
        `<code>[round-${roundTid}]</code>`,
        ``,
        `Challenging <code>${survivors.length}</code> finding(s)...`,
        `<i>MiniMax must disprove each finding or it survives</i>`,
      ].join('\n'),
    );

    const relevantFiles = [...new Set(survivors.flatMap((f) => f.files))];
    const sourceSnippets = relevantFiles
      .slice(0, 20)
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

    const findingsJson = JSON.stringify(
      survivors.map((f) => ({
        type: f.type,
        severity: f.severity,
        confidence: f.confidence,
        title: f.title,
        description: f.description,
        files: f.files,
        validation: f.validation,
      })),
      null,
      2,
    );

    const prompt = `FINDINGS TO CHALLENGE (${survivors.length}):
${findingsJson}

SOURCE CODE (for verification):
${sourceSnippets.slice(0, 200_000)}

Challenge each finding using your expertise. Respond with JSON array of survivors only.`;

    try {
      const raw = await queryMiniMax(prompt, apiKey, round.systemPrompt);
      const parsed = parseMiniMaxFindings(raw);

      const survivorTitles = new Set(parsed.map((f) => f.title));
      const nextSurvivors = survivors.filter((f) =>
        survivorTitles.has(f.title),
      );

      for (const p of parsed) {
        const existing = nextSurvivors.find((s) => s.title === p.title);
        if (existing && p.severity) {
          existing.severity = p.severity;
        }
        if (existing && p.confidence) {
          existing.confidence = p.confidence;
        }
      }

      const dropped = survivors.length - nextSurvivors.length;

      await tg(
        [
          `<b>${round.icon} ${round.name}: ${nextSurvivors.length}/${survivors.length} survived</b>`,
          `<code>[round-${roundTid}]</code>`,
          dropped > 0
            ? `• Disproved: <code>${dropped}</code> finding(s)`
            : `• All findings withstood challenge`,
          nextSurvivors.length > 0
            ? nextSurvivors.map((f) => `  → ${f.title.slice(0, 80)}`).join('\n')
            : `  <i>All findings disproved</i>`,
        ].join('\n'),
      );

      survivors = nextSurvivors;

      logger.info(
        {
          round: round.name,
          input: survivors.length + dropped,
          survived: nextSurvivors.length,
          dropped,
        },
        'Self-validation round complete',
      );
    } catch (err) {
      logger.warn(
        { err, round: round.name },
        'Self-validation round failed, keeping current survivors',
      );
      await tg(
        `<b>${round.icon} ${round.name}: ⚠️ Round failed</b>\n<i>Keeping ${survivors.length} finding(s) — fail-open</i>`,
      );
    }
  }

  return survivors;
}
