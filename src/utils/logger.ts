// ADBPD — structured logger (Pino)
//
// Single shared logger instance. All modules import via `getLogger(name)`
// to get a child logger with module context.
//
// Never use console.log in this project.

import pino from 'pino';

const LOG_LEVEL = process.env.ADBPD_LOG_LEVEL ?? 'info';

const rootLogger = pino({
  level: LOG_LEVEL,
  base: { service: 'adbpd' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export function getLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}

export type Logger = pino.Logger;
