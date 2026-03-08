#!/usr/bin/env node
/**
 * Standalone CLI for the NanoClaw orchestrator loop.
 * Runs independently of the Telegram bot / message loop.
 *
 * Usage: node dist/orchestrator-cli.js [--repo /path/to/opendeviationbar-py]
 */
import { startOrchestratorLoop } from './orchestrator.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const args = process.argv.slice(2);
let repoPath = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1]) {
    repoPath = args[i + 1];
    i++;
  }
}

if (!repoPath) {
  const env = readEnvFile(['ODB_REPO_PATH']);
  repoPath = process.env.ODB_REPO_PATH || env.ODB_REPO_PATH || '';
}

if (!repoPath) {
  console.error(
    'Usage: node dist/orchestrator-cli.js --repo /path/to/opendeviationbar-py',
  );
  console.error('  or set ODB_REPO_PATH in .env');
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
