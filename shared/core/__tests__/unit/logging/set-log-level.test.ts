/**
 * Regression tests for setLogLevel hot-reload
 *
 * Verifies that setLogLevel() updates the log level on all cached Pino
 * loggers, enabling live log-level changes without service restart.
 *
 * @see docs/reports/LOGGING_OPTIMIZATION_2026-03-04.md — Task 8
 * @see health-server.ts — PUT /log-level endpoint
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { createPinoLogger, setLogLevel, resetLoggerCache } from '../../../src/logging/pino-logger';

beforeEach(() => {
  resetLoggerCache();
});

describe('setLogLevel hot-reload', () => {
  it('should change the log level on a cached logger', () => {
    const logger = createPinoLogger({ name: 'test-set-level', level: 'info' });
    expect(logger.isLevelEnabled!('debug')).toBe(false);
    expect(logger.isLevelEnabled!('info')).toBe(true);

    setLogLevel('debug');

    expect(logger.isLevelEnabled!('debug')).toBe(true);
    expect(logger.isLevelEnabled!('trace')).toBe(false);
  });

  it('should change level on all cached loggers', () => {
    const a = createPinoLogger({ name: 'test-sll-a', level: 'info' });
    const b = createPinoLogger({ name: 'test-sll-b', level: 'warn' });

    expect(a.isLevelEnabled!('debug')).toBe(false);
    expect(b.isLevelEnabled!('info')).toBe(false);

    setLogLevel('debug');

    expect(a.isLevelEnabled!('debug')).toBe(true);
    expect(b.isLevelEnabled!('debug')).toBe(true);
  });

  it('should return same cached instance for repeated calls', () => {
    const first = createPinoLogger({ name: 'test-sll-cache', level: 'info' });
    const second = createPinoLogger({ name: 'test-sll-cache', level: 'info' });

    expect(first).toBe(second);
  });

  it('should raise log level (not just lower it)', () => {
    const logger = createPinoLogger({ name: 'test-sll-raise', level: 'debug' });
    expect(logger.isLevelEnabled!('debug')).toBe(true);

    setLogLevel('error');

    expect(logger.isLevelEnabled!('debug')).toBe(false);
    expect(logger.isLevelEnabled!('warn')).toBe(false);
    expect(logger.isLevelEnabled!('error')).toBe(true);
  });

  it('should be a no-op when no loggers are cached', () => {
    // resetLoggerCache() was called in beforeEach, so cache is empty
    // setLogLevel should not throw
    expect(() => setLogLevel('debug')).not.toThrow();
  });
});
