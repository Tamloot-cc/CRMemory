/**
 * The server's log, filtered by `LOG_LEVEL`. Messages at or above the level
 * are written: `debug` and `info` to stdout, `warn` and `error` to stderr.
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

let threshold = LOG_LEVELS.indexOf('info');

export function setLogLevel(level: LogLevel): void {
  threshold = LOG_LEVELS.indexOf(level);
}

const at =
  (level: LogLevel, stream: 'log' | 'error') =>
  (...args: unknown[]) => {
    if (LOG_LEVELS.indexOf(level) >= threshold) console[stream](...args);
  };

export const log = {
  debug: at('debug', 'log'),
  info: at('info', 'log'),
  warn: at('warn', 'error'),
  error: at('error', 'error'),
};
