#!/usr/bin/env npx tsx
/**
 * Dafny verification pipeline for NanoClaw contracts.
 *
 * Discovers .dfy files, runs `dafny verify` to check proofs, then optionally
 * compiles them to TypeScript with `dafny build --target:ts`. Replaces ad-hoc
 * LLM-based code quality heuristics with mathematically proven correctness.
 *
 * Usage:
 *   npx tsx scripts/verify-contracts.ts           # verify all .dfy files
 *   npx tsx scripts/verify-contracts.ts --compile  # verify + compile to TS
 *   npx tsx scripts/verify-contracts.ts path/to/file.dfy  # single file
 *
 * Exit code 0 if all proofs pass, 1 otherwise.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface VerifyResult {
  file: string;
  verified: boolean;
  compiled?: boolean;
  error?: string;
}

/** Append key=value to $GITHUB_OUTPUT (no-op locally). */
function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  if (value.includes('\n')) {
    const delim = `ghadelim_${Date.now()}`;
    fs.appendFileSync(outputFile, `${key}<<${delim}\n${value}\n${delim}\n`);
  } else {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

/** Recursively find all .dfy files under a directory. */
function findDafnyFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...findDafnyFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.dfy')) {
      results.push(full);
    }
  }
  return results;
}

function checkDafnyAvailable(): boolean {
  try {
    execSync('dafny --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function verifyFile(file: string): VerifyResult {
  try {
    execSync(`dafny verify "${file}"`, { stdio: 'pipe', timeout: 120_000 });
    return { file, verified: true };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const error = e.stdout?.toString() || e.stderr?.toString() || e.message || 'unknown';
    return { file, verified: false, error };
  }
}

function compileFile(file: string, outDir: string): boolean {
  try {
    execSync(`dafny build --target:ts --output "${outDir}" "${file}"`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const compileFlag = args.includes('--compile');
  const fileArgs = args.filter((a) => !a.startsWith('--'));

  const projectRoot = process.cwd();

  if (!checkDafnyAvailable()) {
    console.error(
      'dafny not found. Install via: dotnet tool install -g Dafny\n' +
        'Or: https://github.com/dafny-lang/dafny/releases',
    );
    process.exit(1);
  }

  let files: string[];
  if (fileArgs.length > 0) {
    files = fileArgs.map((f) => path.resolve(f));
    for (const f of files) {
      if (!fs.existsSync(f)) {
        console.error(`File not found: ${f}`);
        process.exit(1);
      }
    }
  } else {
    files = findDafnyFiles(projectRoot);
  }

  if (files.length === 0) {
    console.log('No .dfy files found — nothing to verify.');
    setOutput('verified', 'true');
    setOutput('results', '[]');
    process.exit(0);
  }

  console.log(`Verifying ${files.length} Dafny file(s)...\n`);

  const outDir = path.join(projectRoot, 'dist', 'contracts');
  if (compileFlag && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const results: VerifyResult[] = [];

  for (const file of files) {
    const rel = path.relative(projectRoot, file);
    process.stdout.write(`  ${rel} ... `);

    const result = verifyFile(file);

    if (!result.verified) {
      console.log('FAIL');
      console.error(`    ${result.error?.split('\n')[0] ?? 'verification failed'}`);
      results.push(result);
      continue;
    }

    if (compileFlag) {
      const compiled = compileFile(file, outDir);
      result.compiled = compiled;
      if (!compiled) {
        console.log('verified, COMPILE FAIL');
      } else {
        console.log('verified, compiled');
      }
    } else {
      console.log('OK');
    }

    results.push(result);
  }

  const failed = results.filter((r) => !r.verified || r.compiled === false);
  const passed = results.filter((r) => r.verified && r.compiled !== false);

  console.log(`\n${passed.length} passed, ${failed.length} failed`);

  setOutput('verified', failed.length === 0 ? 'true' : 'false');
  setOutput('results', JSON.stringify(results));

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
