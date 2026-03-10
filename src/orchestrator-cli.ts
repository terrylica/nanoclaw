#!/usr/bin/env node
// Early startup marker — writes directly to fd 1 before any module loads
import { writeSync } from 'fs';
writeSync(
  1,
  `[nanoclaw] PID ${process.pid} starting at ${new Date().toISOString()}\n`,
);

// Startup guard: repair node_modules BEFORE any npm package imports
// Claude Code running bun install in worktrees can create a self-referential symlink
import { lstatSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const nmPath = resolve(repoRoot, 'node_modules');

try {
  const stat = lstatSync(nmPath);
  if (stat.isSymbolicLink()) {
    writeSync(
      2,
      `[nanoclaw] WARN: node_modules is a symlink — repairing before start\n`,
    );
    rmSync(nmPath, { force: true });
    execSync('bun install', {
      cwd: repoRoot,
      timeout: 120_000,
      env: { ...process.env, MISE_NO_CONFIG: '1' },
    });
    writeSync(1, `[nanoclaw] node_modules repaired successfully\n`);
  }
} catch {
  /* node_modules doesn't exist or check failed — will fail on import below */
}

/**
 * Standalone CLI for the NanoClaw orchestrator loop.
 * Runs independently of the Telegram bot / message loop.
 *
 * Usage: node dist/orchestrator-cli.js --repo /path/to/repo
 */
const { startOrchestratorLoop } = await import('./orchestrator/index.js');
const { logger } = await import('./logger.js');

const args = process.argv.slice(2);
let repoPath = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && i + 1 < args.length && args[i + 1]) {
    repoPath = args[i + 1];
    i++;
  }
}

if (!repoPath) {
  console.error('Usage: node dist/orchestrator-cli.js --repo /path/to/repo');
  process.exit(1);
}

logger.info({ repoPath }, 'Starting NanoClaw orchestrator');

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Orchestrator shutting down (SIGTERM)');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('Orchestrator shutting down (SIGINT)');
  process.exit(0);
});

startOrchestratorLoop({ repoPath }).catch((err) => {
  logger.fatal({ err }, 'Orchestrator crashed');
  process.exit(1);
});
