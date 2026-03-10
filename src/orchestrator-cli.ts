#!/usr/bin/env node
// Early startup marker — writes directly to fd 1 before any module loads
import { writeSync } from 'fs';
writeSync(
  1,
  `[nanoclaw] PID ${process.pid} starting at ${new Date().toISOString()}\n`,
);
/**
 * Standalone CLI for the NanoClaw orchestrator loop.
 * Runs independently of the Telegram bot / message loop.
 *
 * Usage: node dist/orchestrator-cli.js --repo /path/to/repo
 */
import { startOrchestratorLoop } from './orchestrator/index.js';
import { logger } from './logger.js';

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
