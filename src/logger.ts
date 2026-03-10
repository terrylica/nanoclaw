import pino from 'pino';

// Use pino-pretty transport only when stdout is a TTY (interactive shell).
// Under launchd, stdout is redirected to a file and pino-pretty's worker
// thread doesn't inherit the fd — plain JSON avoids this entirely.
const isTTY = process.stdout.isTTY;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    ...(isTTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  },
  isTTY ? undefined : pino.destination({ fd: 1, sync: true }),
);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
