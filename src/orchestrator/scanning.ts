/**
 * Whole-repo scanning: chunking, proactive scan functions, and scan cycle orchestration.
 */
import { logger } from '../logger.js';
import { getHeadCommit, getScannableFiles, readRepoFile } from './git-ops.js';
import { extractWords, parseMiniMaxFindings, queryMiniMax } from './minimax-client.js';
import { loadFalsePositivePatterns, runConsensusRound, runDevilsAdvocateRound, verifyFindingScript, validateWithClaude } from './pipeline.js';
import { runIterativeSelfValidation } from './self-validation.js';
import { sendTelegramNotification, formatFindingNotification } from './telegram.js';
import { suggestLabels } from './github-issues.js';
import { createGitHubIssue } from './github-issues.js';
import { saveState, checkRateLimit } from './state.js';
import { issueExistsFuzzy } from './github-issues.js';
import { CHUNK_CHAR_BUDGET, PER_FILE_TRUNCATE, traceId } from './types.js';
import type { Finding, OrchestratorConfig, OrchestratorState } from './types.js';

// --- Scanning Prompts ---

export const PROACTIVE_ENHANCEMENT_PROMPT = `You are a memory efficiency and performance optimization expert reviewing existing code in a Rust+Python (maturin) financial data processing library called opendeviationbar-py.

Your job is to find REFACTORING OPPORTUNITIES for memory efficiency. Scan the code for these specific patterns:

## AVOID COPIES
- Unnecessary .clone() / .to_owned() / .to_string() when a borrow would work
- Python: creating new lists/dicts when a view/slice suffices
- String copies where &str / Cow<str> would work
- Vec copies where slices or iterators would work
- Deep copies (copy.deepcopy) that could be shallow copies or references

## AVOID ALLOCATION
- Repeated allocation inside loops (Vec::new() or list() per iteration)
- Missing pre-allocation: Vec that grows via push when final size is known (use Vec::with_capacity)
- Missing buffer reuse: creating new buffers per request instead of reusing
- Python: string concatenation in loops instead of join()
- Temporary allocations that could use stack (SmallVec, arrayvec, tinyvec)

## CACHE EFFICIENCY
- Array-of-Structs (AoS) where Struct-of-Arrays (SoA) would be faster for column access
- Non-contiguous data access patterns (random index into large Vec)
- HashMap where a sorted Vec + binary_search would be more cache-friendly
- Python: iterating dict values when a list would be faster
- Large structs passed by value instead of reference

## LAZY EVALUATION
- Collecting iterators into Vec just to iterate again (.collect::<Vec<_>>() then .iter())
- Loading entire files/datasets when streaming/chunked reading suffices
- Python: list comprehension where generator expression would work
- Computing values eagerly that may never be used
- Missing predicate pushdown (filtering after transform instead of before)

TARGET: opendeviationbar-py processes high-frequency financial tick data. Memory efficiency directly impacts throughput and OOM risk. The codebase has 10 Rust crates and 4 Python daemons.

IMPORTANT:
- Only report findings with CONCRETE evidence: cite the exact function, line pattern, and data type involved
- Estimate the impact: "saves ~X allocations per call" or "reduces peak memory by ~X%"
- A finding without a specific code location and measurable impact is worthless
- Prefer findings in hot paths (data processing loops, streaming handlers) over cold paths (startup, config)
- Use type "enhancement" for all findings

Respond with a JSON array. Each finding:
- type: "enhancement"
- severity: "medium" for measurable improvements, "high" for OOM-risk reductions
- confidence: 1-5 (5 = exact line numbers cited, clear improvement path)
- title: specific, e.g. "Pre-allocate result Vec in batch_process_ticks()"
- description: what the code does now, what it should do, estimated impact
- files: affected file paths
- validation: command to verify (e.g. grep for the pattern, or cargo bench command)

Only report findings with confidence >= 4.
If nothing warrants attention, respond with: []

JSON:`;

export const PROACTIVE_ALGO_CORRECTNESS_PROMPT = `You are an algorithm correctness and mathematical consistency expert reviewing existing code in a Rust+Python (maturin) financial data processing library called opendeviationbar-py.

Your job is to find ALGORITHMIC INCONSISTENCIES and FALLACIOUS IMPLEMENTATIONS. Scan the code for these specific patterns:

## NUMERICAL ERRORS
- Floating-point comparison with == instead of epsilon-based comparison
- Integer overflow/underflow in arithmetic (especially with u32, u64, i64 in Rust)
- Division by zero not guarded (especially in averages, ratios, percentages)
- Loss of precision: f64 → f32 or float → int truncation that drops significant data
- Accumulation of floating-point errors in running sums/averages (use Kahan summation?)
- Wrong rounding mode for financial calculations (banker's rounding vs truncation)

## ALGORITHM LOGIC BUGS
- Off-by-one errors in range bounds, slicing, indexing (fencepost errors)
- Incorrect boundary conditions: empty collections, single-element, max values
- Wrong sort order assumptions (ascending vs descending, stable vs unstable)
- Incorrect merge/join logic (missing entries, duplicates, wrong key matching)
- State machines with unreachable states or missing transitions
- Incorrect time zone handling or daylight saving edge cases
- Wrong comparison operators (< vs <=, > vs >=) in financial thresholds

## STATISTICAL FALLACIES
- Mean used where median is appropriate (skewed data, outliers)
- Sample statistics applied to population or vice versa
- Incorrect standard deviation: population vs sample (N vs N-1 divisor)
- Correlation treated as causation in trading signals
- Survivorship bias in backtesting data selection
- Look-ahead bias: using future data in calculations that should only see past
- Wrong normalization (min-max vs z-score vs percentage) for the data distribution

## CONCURRENCY & ORDERING BUGS
- Non-atomic read-modify-write on shared state
- Assumed ordering that isn't guaranteed (HashMap iteration, async results)
- Race between checking a condition and acting on it (TOCTOU)
- Missing synchronization on mutable state accessed from multiple coroutines
- Event ordering assumptions in stream processing (out-of-order ticks)

## DATA INTEGRITY
- Silently dropping error rows instead of handling them (NaN propagation)
- Inconsistent null/None/NaN handling across pipeline stages
- Checksum/hash computed on wrong fields or wrong byte order
- Timestamps compared across different resolutions (seconds vs milliseconds vs nanoseconds)
- Incorrect serialization/deserialization of financial amounts (string vs float vs decimal)

TARGET: opendeviationbar-py processes high-frequency financial tick data with deviation bar aggregation. Algorithmic correctness directly impacts trading decisions. The codebase has 10 Rust crates and 4 Python daemons processing real money.

IMPORTANT:
- Only report findings with CONCRETE evidence: cite the exact function, line pattern, and the specific logical error
- Explain WHY it's wrong: show the expected behavior vs actual behavior with an example input
- A finding without a specific code location and logical proof is worthless
- Focus on correctness bugs that produce WRONG RESULTS silently (not crashes)
- Use type "bug" for correctness issues, "performance-regression" for degraded accuracy

Respond with a JSON array. Each finding:
- type: "bug" or "performance-regression"
- severity: "high" for wrong financial calculations, "critical" for data corruption, "medium" for edge cases
- confidence: 1-5 (5 = exact proof with example input/output)
- title: specific, e.g. "Off-by-one in gap detection causes missed gaps at shard boundary"
- description: what the code does wrong, expected vs actual behavior, example triggering input
- files: affected file paths
- validation: command to verify (e.g. specific test to run, grep for the pattern)

Only report findings with confidence >= 4.
If nothing warrants attention, respond with: []

JSON:`;

// --- Chunking ---

/**
 * Chunk all scannable files into groups that fit within MiniMax's context budget.
 */
export function chunkFilesForContext(
  repoPath: string,
  allFiles: string[],
): { files: string[]; sourceContext: string }[] {
  const chunks: { files: string[]; sourceContext: string }[] = [];
  let currentFiles: string[] = [];
  let currentSource = '';
  let currentLen = 0;

  for (const f of allFiles) {
    const content = readRepoFile(repoPath, f);
    if (!content) continue;

    const truncated =
      content.length > PER_FILE_TRUNCATE
        ? content.slice(0, PER_FILE_TRUNCATE) + '\n... (truncated)'
        : content;
    const block = `--- ${f} (${content.length} bytes) ---\n${truncated}\n`;

    if (
      currentLen + block.length > CHUNK_CHAR_BUDGET &&
      currentFiles.length > 0
    ) {
      chunks.push({ files: [...currentFiles], sourceContext: currentSource });
      currentFiles = [];
      currentSource = '';
      currentLen = 0;
    }

    currentFiles.push(f);
    currentSource += block + '\n';
    currentLen += block.length;
  }

  if (currentFiles.length > 0) {
    chunks.push({ files: currentFiles, sourceContext: currentSource });
  }

  return chunks;
}

// --- Scan Functions ---

export async function runProactiveScan(
  repoPath: string,
  apiKey: string,
): Promise<{ findings: Finding[]; totalFiles: number; chunksScanned: number }> {
  const allFiles = getScannableFiles(repoPath);
  if (allFiles.length === 0)
    return { findings: [], totalFiles: 0, chunksScanned: 0 };

  const chunks = chunkFilesForContext(repoPath, allFiles);
  const allFindings: Finding[] = [];

  logger.info(
    { totalFiles: allFiles.length, chunks: chunks.length },
    'Running whole-repo proactive enhancement scan',
  );

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const prompt = `FILES BEING SCANNED (chunk ${ci + 1}/${chunks.length}, ${chunk.files.length} files, proactive enhancement scan):
${chunk.files.join('\n')}

FULL SOURCE CODE:
${chunk.sourceContext}

${PROACTIVE_ENHANCEMENT_PROMPT}`;

    try {
      const raw = await queryMiniMax(prompt, apiKey);
      const findings = parseMiniMaxFindings(raw);
      allFindings.push(
        ...findings.map((f) => ({
          ...f,
          type: 'enhancement' as const,
          sourcePerspectives: ['proactive-memory-efficiency'],
        })),
      );
      logger.info(
        { chunk: ci + 1, files: chunk.files.length, findings: findings.length },
        'Enhancement scan chunk complete',
      );
    } catch (err) {
      logger.warn({ err, chunk: ci + 1 }, 'Enhancement scan chunk failed');
    }
  }

  return {
    findings: allFindings,
    totalFiles: allFiles.length,
    chunksScanned: chunks.length,
  };
}

export async function runAlgoCorrectnessScan(
  repoPath: string,
  apiKey: string,
): Promise<{ findings: Finding[]; totalFiles: number; chunksScanned: number }> {
  const allFiles = getScannableFiles(repoPath);
  if (allFiles.length === 0)
    return { findings: [], totalFiles: 0, chunksScanned: 0 };

  const chunks = chunkFilesForContext(repoPath, allFiles);
  const allFindings: Finding[] = [];

  logger.info(
    { totalFiles: allFiles.length, chunks: chunks.length },
    'Running whole-repo algo correctness scan',
  );

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const prompt = `FILES BEING SCANNED (chunk ${ci + 1}/${chunks.length}, ${chunk.files.length} files, algo correctness scan):
${chunk.files.join('\n')}

FULL SOURCE CODE:
${chunk.sourceContext}

${PROACTIVE_ALGO_CORRECTNESS_PROMPT}`;

    try {
      const raw = await queryMiniMax(prompt, apiKey);
      const findings = parseMiniMaxFindings(raw);
      allFindings.push(
        ...findings.map((f) => ({
          ...f,
          sourcePerspectives: ['proactive-algo-correctness'],
        })),
      );
      logger.info(
        { chunk: ci + 1, files: chunk.files.length, findings: findings.length },
        'Algo correctness scan chunk complete',
      );
    } catch (err) {
      logger.warn({ err, chunk: ci + 1 }, 'Algo correctness scan chunk failed');
    }
  }

  return {
    findings: allFindings,
    totalFiles: allFiles.length,
    chunksScanned: chunks.length,
  };
}

// --- Scan Cycle Orchestration ---

/**
 * Run a full algo correctness scan cycle with 7-layer FP prevention.
 */
export async function runAlgoScanCycle(
  config: OrchestratorConfig,
  state: OrchestratorState,
  minimaxKey: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const headCommit = getHeadCommit(config.repoPath);
  state.algoScanCount = (state.algoScanCount || 0) + 1;
  const scanNum = state.algoScanCount;
  const tid = traceId();

  const tg = async (msg: string) => {
    if (botToken && chatId) {
      await sendTelegramNotification(
        `<code>[${tid}]</code> ${msg}`,
        botToken,
        chatId,
      );
    }
  };

  const allFiles = getScannableFiles(config.repoPath);

  await tg(
    [
      `<b>🧮 Algo Correctness Scan #${scanNum}</b>`,
      ``,
      `Scanning <b>entire ODB repo</b> (${allFiles.length} files) for algorithmic inconsistencies...`,
      `<i>7-layer validation pipeline active</i>`,
      ``,
      `<i>Categories: numerical errors, logic bugs, statistical fallacies, concurrency, data integrity</i>`,
    ].join('\n'),
  );

  try {
    const scanResult = await runAlgoCorrectnessScan(config.repoPath, minimaxKey);
    const rawFindings = scanResult.findings;

    logger.info(
      {
        findingCount: rawFindings.length,
        totalFiles: scanResult.totalFiles,
        chunks: scanResult.chunksScanned,
      },
      'Algo scan Layer 1 (MiniMax) complete — whole repo',
    );

    await tg(
      [
        `<b>🧮 Layer 1: MiniMax Expert Scan</b>`,
        `• Scanned: <code>${scanResult.totalFiles}</code> files in <code>${scanResult.chunksScanned}</code> chunks`,
        `• Raw findings: <code>${rawFindings.length}</code>`,
        rawFindings.length > 0
          ? rawFindings.map((f) => `  → ${f.title.slice(0, 80)}`).join('\n')
          : `  <i>No algo issues found across entire repo</i>`,
      ].join('\n'),
    );

    if (rawFindings.length === 0) {
      await tg(
        `<b>🧮 Scan #${scanNum} Complete</b>\n\nNo findings — all ${scanResult.totalFiles} files clean.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 1.5: Iterative Self-Validation
    await tg(
      [
        `<b>🧮 Layer 1.5: Iterative Self-Validation</b>`,
        ``,
        `MiniMax will now challenge its own <code>${rawFindings.length}</code> finding(s) through 3 adversarial rounds:`,
        `  1. 🔬 Fact-Check — verify code references are real`,
        `  2. 📊 Domain Rebuttal — challenge from financial data perspective`,
        `  3. 🧪 Reproducibility — demand concrete triggering inputs`,
        ``,
        `<i>Only findings that survive all 3 rounds proceed to the pipeline</i>`,
      ].join('\n'),
    );

    const selfValidatedFindings = await runIterativeSelfValidation(
      rawFindings,
      config.repoPath,
      minimaxKey,
      tg,
    );

    await tg(
      [
        `<b>🧮 Self-Validation Complete</b>`,
        `• Input: <code>${rawFindings.length}</code> → Survived: <code>${selfValidatedFindings.length}</code>`,
        `• Eliminated: <code>${rawFindings.length - selfValidatedFindings.length}</code> finding(s) disproved by MiniMax itself`,
      ].join('\n'),
    );

    if (selfValidatedFindings.length === 0) {
      await tg(
        `<b>🧮 Scan #${scanNum} Complete</b>\n\nAll ${rawFindings.length} findings disproved during self-validation.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 2: Confidence Gate
    const confidentFindings = selfValidatedFindings.filter(
      (f) => (f.confidence ?? 0) >= 4,
    );

    await tg(
      [
        `<b>🧮 Layer 2: Confidence Gate (≥4/5)</b>`,
        `• Passed: <code>${confidentFindings.length}/${rawFindings.length}</code>`,
      ].join('\n'),
    );

    if (confidentFindings.length === 0) {
      await tg(
        `<b>🧮 Scan #${scanNum} Complete</b>\n\nAll findings below confidence threshold.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 3: FP Pattern DB
    const fpPatterns = loadFalsePositivePatterns();
    const afterFpFilter =
      fpPatterns.length > 0
        ? confidentFindings.filter((f) => {
            const matchesFp = fpPatterns.some((pattern) => {
              const patternWords = extractWords(pattern);
              const findingWords = extractWords(f.title + ' ' + f.description);
              const intersection = findingWords.filter((w) =>
                patternWords.includes(w),
              );
              const union = new Set([...findingWords, ...patternWords]);
              return union.size > 0 && intersection.length / union.size >= 0.35;
            });
            return !matchesFp;
          })
        : confidentFindings;

    await tg(
      [
        `<b>🧮 Layer 3: FP Pattern DB</b>`,
        `• Known FP patterns: <code>${fpPatterns.length}</code>`,
        `• Passed: <code>${afterFpFilter.length}/${confidentFindings.length}</code>`,
      ].join('\n'),
    );

    if (afterFpFilter.length === 0) {
      await tg(
        `<b>🧮 Scan #${scanNum} Complete</b>\n\nAll findings matched known FP patterns.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 4: Consensus
    const relevantFiles = [
      ...new Set(afterFpFilter.flatMap((f) => f.files).filter(Boolean)),
    ];
    const consensusFindings = await runConsensusRound(
      afterFpFilter,
      '',
      relevantFiles,
      minimaxKey,
      config.repoPath,
    );

    await tg(
      [
        `<b>🧮 Layer 4: Consensus Round</b>`,
        `• Survived: <code>${consensusFindings.length}/${afterFpFilter.length}</code>`,
      ].join('\n'),
    );

    if (consensusFindings.length === 0) {
      await tg(
        `<b>🧮 Scan #${scanNum} Complete</b>\n\nAll findings rejected at consensus.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 5: Devil's Advocate
    const advocateFindings = await runDevilsAdvocateRound(
      consensusFindings,
      relevantFiles,
      minimaxKey,
      config.repoPath,
    );

    await tg(
      [
        `<b>🧮 Layer 5: Devil's Advocate</b>`,
        `• Survived: <code>${advocateFindings.length}/${consensusFindings.length}</code>`,
      ].join('\n'),
    );

    if (advocateFindings.length === 0) {
      await tg(
        `<b>🧮 Scan #${scanNum} Complete</b>\n\nAll findings disproved by devil's advocate.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layers 6 & 7: Per-finding validation
    let scanValidated = 0;
    let scanIssues = 0;
    const scanSkipped: string[] = [];
    const issueUrls: string[] = [];

    for (const finding of advocateFindings) {
      if (!checkRateLimit(state)) {
        scanSkipped.push('Rate limit reached');
        break;
      }

      if (issueExistsFuzzy(finding.title)) {
        scanSkipped.push(`Duplicate: ${finding.title.slice(0, 60)}`);
        continue;
      }

      const scriptCheck = verifyFindingScript(finding, config.repoPath);
      if (!scriptCheck.verified) {
        state.findingsRejected++;
        scanSkipped.push(`Script fail: ${finding.title.slice(0, 60)}`);
        await tg(
          `<b>🧮 Layer 6: Script Check ❌</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Verification script failed</i>`,
        );
        continue;
      }

      await tg(
        `<b>🧮 Layer 6: Script Check ✅</b>\n<code>${finding.title.slice(0, 80)}</code>`,
      );

      await tg(
        `<b>🧮 Layer 7: Claude Validation 🧠</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Running claude -p...</i>`,
      );

      const validation = validateWithClaude(
        finding,
        config.repoPath,
        headCommit,
      );

      if (!validation) {
        scanSkipped.push(`Claude unavail: ${finding.title.slice(0, 60)}`);
        continue;
      }

      if (!validation.confirmed || validation.confidence === 'low') {
        state.findingsRejected++;
        scanSkipped.push(`Rejected: ${finding.title.slice(0, 60)}`);
        await tg(
          [
            `<b>🧮 Layer 7: Claude ❌</b>`,
            `<code>${finding.title.slice(0, 80)}</code>`,
            `<i>${validation.analysis.slice(0, 200)}</i>`,
          ].join('\n'),
        );
        continue;
      }

      state.findingsValidated++;
      scanValidated++;

      const labels = await suggestLabels(finding, validation, minimaxKey);
      const issueUrl = createGitHubIssue(
        finding,
        validation,
        config.repoPath,
        headCommit,
        labels,
      );

      if (issueUrl) {
        state.issuesCreated++;
        if (!state.issueTimestamps) state.issueTimestamps = [];
        state.issueTimestamps.push(Date.now());
        scanIssues++;
        issueUrls.push(issueUrl);
      }

      await tg(
        [
          `<b>🧮 Layer 7: Claude ✅ CONFIRMED</b>`,
          `<code>${finding.title.slice(0, 80)}</code>`,
          `Confidence: <code>${validation.confidence}</code>`,
          `<i>${validation.analysis.slice(0, 200)}</i>`,
          ``,
          issueUrl ? `<b>📋 Issue</b>: ${issueUrl}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    // Final Summary
    const issueLines =
      issueUrls.length > 0
        ? [``, `<b>📋 Issues Created:</b>`, ...issueUrls.map((u) => `• ${u}`)]
        : [];

    await tg(
      [
        `<b>🧮 Algo Correctness Scan #${scanNum} Complete</b>`,
        ``,
        `<b>Scanned:</b> ${scanResult.totalFiles} files in ${scanResult.chunksScanned} chunks`,
        ``,
        `<b>Pipeline results:</b>`,
        `• Layer 1 (MiniMax Expert): <code>${rawFindings.length}</code> raw`,
        `• Layer 1.5 (Self-Validation ×3): <code>${selfValidatedFindings.length}</code>`,
        `• Layer 2 (Confidence ≥4): <code>${confidentFindings.length}</code>`,
        `• Layer 3 (FP Pattern DB): <code>${afterFpFilter.length}</code>`,
        `• Layer 4 (Consensus): <code>${consensusFindings.length}</code>`,
        `• Layer 5 (Devil's Advocate): <code>${advocateFindings.length}</code>`,
        `• Layer 6+7 (Script+Claude): <code>${scanValidated}</code> confirmed`,
        ``,
        `• <b>Issues created: <code>${scanIssues}</code></b>`,
        ...issueLines,
        scanSkipped.length > 0
          ? `• Skipped: ${scanSkipped.length} (${scanSkipped.slice(0, 3).join(', ')}${scanSkipped.length > 3 ? '...' : ''})`
          : '',
        ``,
        `<i>Next algo scan in ~4 hours</i>`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } catch (err) {
    logger.warn({ err }, 'Algo correctness scan cycle failed (non-fatal)');
    await tg(
      `<b>🧮 Algo Scan Failed ⚠️</b>\n<i>${String(err).slice(0, 200)}</i>\n\n<i>Will retry in ~4 hours</i>`,
    );
  }

  state.lastAlgoScan = new Date().toISOString();
  saveState(state);
}

/**
 * Run a proactive enhancement scan cycle with 7-layer FP prevention.
 */
export async function runProactiveScanCycle(
  config: OrchestratorConfig,
  state: OrchestratorState,
  minimaxKey: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const headCommit = getHeadCommit(config.repoPath);
  state.proactiveScanCount = (state.proactiveScanCount || 0) + 1;
  const scanNum = state.proactiveScanCount;
  const tid = traceId();

  const tg = async (msg: string) => {
    if (botToken && chatId) {
      await sendTelegramNotification(
        `<code>[${tid}]</code> ${msg}`,
        botToken,
        chatId,
      );
    }
  };

  const allFiles = getScannableFiles(config.repoPath);

  await tg(
    [
      `<b>🔍 Proactive Enhancement Scan #${scanNum}</b>`,
      ``,
      `Scanning <b>entire ODB repo</b> (${allFiles.length} files) for memory efficiency...`,
      `<i>7-layer validation pipeline active</i>`,
      ``,
      `<i>Categories: avoid copies, avoid allocation, cache efficiency, lazy evaluation</i>`,
    ].join('\n'),
  );

  try {
    const scanResult = await runProactiveScan(config.repoPath, minimaxKey);
    const rawFindings = scanResult.findings;

    logger.info(
      {
        findingCount: rawFindings.length,
        totalFiles: scanResult.totalFiles,
        chunks: scanResult.chunksScanned,
      },
      'Proactive scan Layer 1 (MiniMax) complete — whole repo',
    );

    await tg(
      [
        `<b>🔍 Layer 1: MiniMax Expert Scan</b>`,
        `• Scanned: <code>${scanResult.totalFiles}</code> files in <code>${scanResult.chunksScanned}</code> chunks`,
        `• Raw findings: <code>${rawFindings.length}</code>`,
        rawFindings.length > 0
          ? rawFindings.map((f) => `  → ${f.title.slice(0, 80)}`).join('\n')
          : `  <i>No enhancement opportunities found across entire repo</i>`,
      ].join('\n'),
    );

    if (rawFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${scanNum} Complete</b>\n\nNo findings — all ${scanResult.totalFiles} files clean.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 1.5: Iterative Self-Validation
    await tg(
      [
        `<b>🔍 Layer 1.5: Iterative Self-Validation</b>`,
        ``,
        `MiniMax will now challenge its own <code>${rawFindings.length}</code> finding(s) through 3 adversarial rounds`,
        `<i>Only findings that survive all 3 rounds proceed</i>`,
      ].join('\n'),
    );

    const selfValidatedFindings = await runIterativeSelfValidation(
      rawFindings,
      config.repoPath,
      minimaxKey,
      tg,
    );

    await tg(
      [
        `<b>🔍 Self-Validation Complete</b>`,
        `• Input: <code>${rawFindings.length}</code> → Survived: <code>${selfValidatedFindings.length}</code>`,
      ].join('\n'),
    );

    if (selfValidatedFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${scanNum} Complete</b>\n\nAll findings disproved during self-validation.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 2: Confidence Gate
    const confidentFindings = selfValidatedFindings.filter(
      (f) => (f.confidence ?? 0) >= 4,
    );

    await tg(
      [
        `<b>🔍 Layer 2: Confidence Gate (≥4/5)</b>`,
        `• Passed: <code>${confidentFindings.length}/${selfValidatedFindings.length}</code>`,
        confidentFindings.length < selfValidatedFindings.length
          ? `• Filtered out ${selfValidatedFindings.length - confidentFindings.length} low-confidence findings`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (confidentFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${scanNum} Complete</b>\n\nAll findings below confidence threshold.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 3: FP Pattern DB
    const fpPatterns = loadFalsePositivePatterns();
    const afterFpFilter =
      fpPatterns.length > 0
        ? confidentFindings.filter((f) => {
            const matchesFp = fpPatterns.some((pattern) => {
              const patternWords = extractWords(pattern);
              const findingWords = extractWords(f.title + ' ' + f.description);
              const intersection = findingWords.filter((w) =>
                patternWords.includes(w),
              );
              const union = new Set([...findingWords, ...patternWords]);
              return union.size > 0 && intersection.length / union.size >= 0.35;
            });
            return !matchesFp;
          })
        : confidentFindings;

    await tg(
      [
        `<b>🔍 Layer 3: FP Pattern DB</b>`,
        `• Known FP patterns: <code>${fpPatterns.length}</code>`,
        `• Passed: <code>${afterFpFilter.length}/${confidentFindings.length}</code>`,
      ].join('\n'),
    );

    if (afterFpFilter.length === 0) {
      await tg(
        `<b>🔍 Scan #${scanNum} Complete</b>\n\nAll findings matched known FP patterns.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 4: Consensus Round
    const relevantFiles = [
      ...new Set(afterFpFilter.flatMap((f) => f.files).filter(Boolean)),
    ];
    const consensusFindings = await runConsensusRound(
      afterFpFilter,
      '',
      relevantFiles,
      minimaxKey,
      config.repoPath,
    );

    await tg(
      [
        `<b>🔍 Layer 4: Consensus Round (skeptical reviewer)</b>`,
        `• Survived: <code>${consensusFindings.length}/${afterFpFilter.length}</code>`,
        consensusFindings.length < afterFpFilter.length
          ? `• ${afterFpFilter.length - consensusFindings.length} findings rejected by skeptical reviewer`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (consensusFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${scanNum} Complete</b>\n\nAll findings rejected at consensus.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layer 5: Devil's Advocate
    const advocateFindings = await runDevilsAdvocateRound(
      consensusFindings,
      relevantFiles,
      minimaxKey,
      config.repoPath,
    );

    await tg(
      [
        `<b>🔍 Layer 5: Devil's Advocate</b>`,
        `• Survived: <code>${advocateFindings.length}/${consensusFindings.length}</code>`,
        advocateFindings.length < consensusFindings.length
          ? `• ${consensusFindings.length - advocateFindings.length} findings disproved`
          : `• All findings withstood adversarial challenge`,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (advocateFindings.length === 0) {
      await tg(
        `<b>🔍 Scan #${scanNum} Complete</b>\n\nAll findings disproved by devil's advocate.\n<i>Next scan in ~4 hours</i>`,
      );
      return;
    }

    // Layers 6 & 7: Per-finding validation
    let scanValidated = 0;
    let scanIssues = 0;
    const scanSkipped: string[] = [];

    for (const finding of advocateFindings) {
      if (!checkRateLimit(state)) {
        scanSkipped.push('Rate limit reached');
        break;
      }

      if (issueExistsFuzzy(finding.title)) {
        scanSkipped.push(`Duplicate: ${finding.title.slice(0, 60)}`);
        continue;
      }

      const scriptCheck = verifyFindingScript(finding, config.repoPath);
      if (!scriptCheck.verified) {
        state.findingsRejected++;
        scanSkipped.push(`Script fail: ${finding.title.slice(0, 60)}`);
        await tg(
          `<b>🔍 Layer 6: Script Check ❌</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Verification script failed — likely hallucinated</i>`,
        );
        continue;
      }

      await tg(
        `<b>🔍 Layer 6: Script Check ✅</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Verification script passed — proceeding to Claude</i>`,
      );

      await tg(
        `<b>🔍 Layer 7: Claude Validation 🧠</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Running claude -p for deep analysis...</i>`,
      );

      const validation = validateWithClaude(
        finding,
        config.repoPath,
        headCommit,
      );

      if (!validation) {
        scanSkipped.push(`Claude unavail: ${finding.title.slice(0, 60)}`);
        await tg(
          `<b>🔍 Layer 7: Claude ⚠️</b>\n<code>${finding.title.slice(0, 80)}</code>\n<i>Claude validation unavailable — skipping</i>`,
        );
        continue;
      }

      if (!validation.confirmed || validation.confidence === 'low') {
        state.findingsRejected++;
        scanSkipped.push(`Rejected: ${finding.title.slice(0, 60)}`);
        await tg(
          [
            `<b>🔍 Layer 7: Claude ❌</b>`,
            `<code>${finding.title.slice(0, 80)}</code>`,
            `Confidence: <code>${validation.confidence}</code>`,
            `<i>${validation.analysis.slice(0, 200)}</i>`,
          ].join('\n'),
        );
        continue;
      }

      state.findingsValidated++;
      scanValidated++;

      await tg(
        [
          `<b>🔍 Layer 7: Claude ✅ CONFIRMED</b>`,
          `<code>${finding.title.slice(0, 80)}</code>`,
          `Confidence: <code>${validation.confidence}</code>`,
          `<i>${validation.analysis.slice(0, 200)}</i>`,
          ``,
          `<b>Creating GitHub Issue...</b>`,
        ].join('\n'),
      );

      const labels = await suggestLabels(finding, validation, minimaxKey);
      const issueUrl = createGitHubIssue(
        finding,
        validation,
        config.repoPath,
        headCommit,
        labels,
      );

      if (issueUrl) {
        state.issuesCreated++;
        if (!state.issueTimestamps) state.issueTimestamps = [];
        state.issueTimestamps.push(Date.now());
        scanIssues++;
      }

      await tg(formatFindingNotification(finding, validation, issueUrl));
    }

    // Final Summary
    await tg(
      [
        `<b>🔍 Proactive Scan #${scanNum} Complete</b>`,
        ``,
        `<b>Scanned:</b> ${scanResult.totalFiles} files in ${scanResult.chunksScanned} chunks`,
        ``,
        `<b>Pipeline results:</b>`,
        `• Layer 1 (MiniMax Expert): <code>${rawFindings.length}</code> raw`,
        `• Layer 1.5 (Self-Validation ×3): <code>${selfValidatedFindings.length}</code>`,
        `• Layer 2 (Confidence ≥4): <code>${confidentFindings.length}</code>`,
        `• Layer 3 (FP Pattern DB): <code>${afterFpFilter.length}</code>`,
        `• Layer 4 (Consensus): <code>${consensusFindings.length}</code>`,
        `• Layer 5 (Devil's Advocate): <code>${advocateFindings.length}</code>`,
        `• Layer 6+7 (Script+Claude): <code>${scanValidated}</code> confirmed`,
        ``,
        `• <b>Issues created: <code>${scanIssues}</code></b>`,
        scanSkipped.length > 0
          ? `• Skipped: ${scanSkipped.length} (${scanSkipped.slice(0, 3).join(', ')}${scanSkipped.length > 3 ? '...' : ''})`
          : '',
        ``,
        `<i>Next proactive scan in ~4 hours</i>`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } catch (err) {
    logger.warn({ err }, 'Proactive scan cycle failed (non-fatal)');
    await tg(
      `<b>🔍 Proactive Scan Failed ⚠️</b>\n<i>${String(err).slice(0, 200)}</i>\n\n<i>Will retry in ~4 hours</i>`,
    );
  }

  state.lastProactiveScan = new Date().toISOString();
  saveState(state);
}
