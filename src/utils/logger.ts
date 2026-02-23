/**
 * Internal Logger
 *
 * Centralizes all console output behind configurable functions.
 * Users can silence, redirect, or replace the logger entirely.
 *
 * @example
 * ```typescript
 * import { configureLogger } from '@classytic/mongokit';
 *
 * // Silence all warnings
 * configureLogger({ warn: () => {} });
 *
 * // Send to your logging system
 * configureLogger({ warn: (msg) => myLogger.warn(msg) });
 *
 * // Silence everything
 * configureLogger(false);
 * ```
 */

type LogFn = (message: string, ...args: unknown[]) => void;

interface LoggerConfig {
  warn: LogFn;
  debug: LogFn;
}

const noop: LogFn = () => {};

let current: LoggerConfig = {
  warn: console.warn.bind(console),
  debug: noop,
};

/**
 * Configure the internal logger.
 * Pass `false` to silence all output.
 */
export function configureLogger(config: Partial<LoggerConfig> | false): void {
  if (config === false) {
    current = { warn: noop, debug: noop };
  } else {
    current = { ...current, ...config };
  }
}

/** Emit a warning — security blocks, config issues, performance hints */
export function warn(message: string, ...args: unknown[]): void {
  current.warn(message, ...args);
}

/** Emit debug info — only visible when debug is enabled */
export function debug(message: string, ...args: unknown[]): void {
  current.debug(message, ...args);
}
