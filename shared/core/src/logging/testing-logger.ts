/**
 * Testing Logger Implementations
 *
 * Provides logger implementations specifically designed for testing:
 *
 * 1. RecordingLogger - Captures all logs in memory for assertions
 * 2. NullLogger - Silently discards all logs (for noise-free tests)
 *
 * These loggers eliminate the need for jest.mock() on the logger module,
 * which avoids mock hoisting issues and makes tests more maintainable.
 *
 * @example
 * ```typescript
 * // Instead of this (problematic):
 * jest.mock('../../src/logger', () => ({
 *   createLogger: jest.fn(() => ({ info: jest.fn(), ... }))
 * }));
 *
 * // Do this (clean DI pattern):
 * const mockLogger = new RecordingLogger();
 * const service = new MyService(mockLogger);
 * service.doSomething();
 * expect(mockLogger.getErrors()).toHaveLength(0);
 * ```
 *
 * @see docs/architecture/adr/ADR-015-pino-logger-migration.md
 */

import type { ILogger, IPerformanceLogger, LogLevel, LogMeta } from './types';

// =============================================================================
// Log Entry Types
// =============================================================================

/**
 * Represents a captured log entry.
 */
export interface LogEntry {
  /** Log level */
  level: LogLevel;
  /** Log message */
  msg: string;
  /** Additional metadata */
  meta?: LogMeta;
  /** Timestamp when the log was captured */
  timestamp: number;
  /** Child logger bindings (if from a child logger) */
  bindings?: LogMeta;
}

// =============================================================================
// RecordingLogger
// =============================================================================

/**
 * A logger that captures all log entries in memory for testing assertions.
 *
 * Features:
 * - Captures all log levels with timestamps
 * - Supports child logger bindings
 * - Provides filtering and assertion helpers
 * - Thread-safe for async tests
 *
 * @example
 * ```typescript
 * const logger = new RecordingLogger();
 *
 * // Use in code under test
 * myFunction(logger);
 *
 * // Assert on logs
 * expect(logger.getLogs('error')).toHaveLength(0);
 * expect(logger.hasLogMatching('info', /operation completed/i)).toBe(true);
 *
 * // Get all logs for debugging
 * console.log(logger.getAllLogs());
 *
 * // Clear between tests
 * logger.clear();
 * ```
 */
export class RecordingLogger implements ILogger {
  private logs: LogEntry[] = [];
  private readonly bindings: LogMeta;

  /**
   * Create a new RecordingLogger.
   *
   * @param bindings - Optional initial bindings (used by child())
   */
  constructor(bindings?: LogMeta) {
    this.bindings = bindings || {};
  }

  // =========================================================================
  // ILogger Implementation
  // =========================================================================

  fatal(msg: string, meta?: LogMeta): void {
    this.record('fatal', msg, meta);
  }

  error(msg: string, meta?: LogMeta): void {
    this.record('error', msg, meta);
  }

  warn(msg: string, meta?: LogMeta): void {
    this.record('warn', msg, meta);
  }

  info(msg: string, meta?: LogMeta): void {
    this.record('info', msg, meta);
  }

  debug(msg: string, meta?: LogMeta): void {
    this.record('debug', msg, meta);
  }

  trace(msg: string, meta?: LogMeta): void {
    this.record('trace', msg, meta);
  }

  child(bindings: LogMeta): ILogger {
    // Create a child logger that shares the same logs array
    // but has its own bindings
    const child = new RecordingLogger({ ...this.bindings, ...bindings });
    // Share the logs array so parent can see child's logs
    child.logs = this.logs;
    return child;
  }

  isLevelEnabled(_level: LogLevel): boolean {
    // All levels are enabled in recording mode
    return true;
  }

  // =========================================================================
  // Recording & Assertion Helpers
  // =========================================================================

  /**
   * Record a log entry.
   */
  private record(level: LogLevel, msg: string, meta?: LogMeta): void {
    this.logs.push({
      level,
      msg,
      meta: meta ? { ...meta } : undefined,
      timestamp: Date.now(),
      bindings: Object.keys(this.bindings).length > 0 ? { ...this.bindings } : undefined,
    });
  }

  /**
   * Get all captured logs.
   */
  getAllLogs(): ReadonlyArray<LogEntry> {
    return [...this.logs];
  }

  /**
   * Get logs filtered by level.
   *
   * @param level - Log level to filter by
   * @returns Array of log entries at the specified level
   */
  getLogs(level: LogLevel): ReadonlyArray<LogEntry> {
    return this.logs.filter(log => log.level === level);
  }

  /**
   * Get all error-level logs.
   * Convenience method for common assertion pattern.
   */
  getErrors(): ReadonlyArray<LogEntry> {
    return this.getLogs('error');
  }

  /**
   * Get all warning-level logs.
   * Convenience method for common assertion pattern.
   */
  getWarnings(): ReadonlyArray<LogEntry> {
    return this.getLogs('warn');
  }

  /**
   * Check if any log matches a pattern.
   *
   * @param level - Log level to check
   * @param pattern - String or RegExp to match against the message
   * @returns true if any log matches
   */
  hasLogMatching(level: LogLevel, pattern: string | RegExp): boolean {
    return this.getLogs(level).some(log => {
      if (typeof pattern === 'string') {
        return log.msg.includes(pattern);
      }
      return pattern.test(log.msg);
    });
  }

  /**
   * Check if any log contains specific metadata.
   *
   * @param level - Log level to check
   * @param meta - Partial metadata to match
   * @returns true if any log contains the metadata
   */
  hasLogWithMeta(level: LogLevel, meta: Partial<LogMeta>): boolean {
    return this.getLogs(level).some(log => {
      if (!log.meta) return false;
      return Object.entries(meta).every(([key, value]) => log.meta![key] === value);
    });
  }

  /**
   * Get the last log entry.
   */
  getLastLog(): LogEntry | undefined {
    return this.logs[this.logs.length - 1];
  }

  /**
   * Get the last log at a specific level.
   */
  getLastLogAt(level: LogLevel): LogEntry | undefined {
    const logsAtLevel = this.getLogs(level);
    return logsAtLevel[logsAtLevel.length - 1];
  }

  /**
   * Clear all captured logs.
   * Call this in beforeEach() to reset state between tests.
   */
  clear(): void {
    this.logs.length = 0;
  }

  /**
   * Get the total count of logs.
   */
  get count(): number {
    return this.logs.length;
  }

  /**
   * Get count of logs at a specific level.
   */
  countAt(level: LogLevel): number {
    return this.getLogs(level).length;
  }
}

// =============================================================================
// NullLogger
// =============================================================================

/**
 * A logger that silently discards all log entries.
 *
 * Use this when:
 * - You don't care about log output in a test
 * - You want to suppress logging noise
 * - Testing code paths where logging is expected but not asserted
 *
 * @example
 * ```typescript
 * // When you don't care about logs
 * const service = new MyService(new NullLogger());
 * ```
 */
export class NullLogger implements ILogger {
  fatal(_msg: string, _meta?: LogMeta): void { /* noop */ }
  error(_msg: string, _meta?: LogMeta): void { /* noop */ }
  warn(_msg: string, _meta?: LogMeta): void { /* noop */ }
  info(_msg: string, _meta?: LogMeta): void { /* noop */ }
  debug(_msg: string, _meta?: LogMeta): void { /* noop */ }
  trace(_msg: string, _meta?: LogMeta): void { /* noop */ }

  child(_bindings: LogMeta): ILogger {
    return this; // Return self since nothing is logged anyway
  }

  isLevelEnabled(_level: LogLevel): boolean {
    return false;
  }
}

// =============================================================================
// RecordingPerformanceLogger
// =============================================================================

/**
 * Recording implementation of IPerformanceLogger for testing.
 */
export class RecordingPerformanceLogger extends RecordingLogger implements IPerformanceLogger {
  private readonly timers: Map<string, { start: number; count: number }> = new Map();

  startTimer(operation: string): void {
    this.timers.set(operation, {
      start: Date.now(),
      count: (this.timers.get(operation)?.count ?? 0) + 1,
    });
  }

  endTimer(operation: string, meta?: LogMeta): number {
    const timer = this.timers.get(operation);
    if (!timer) {
      this.warn(`Timer not started for operation: ${operation}`);
      return 0;
    }

    const duration = Date.now() - timer.start;
    this.info(`Operation completed: ${operation}`, {
      duration,
      count: timer.count,
      ...meta,
    });

    this.timers.delete(operation);
    return duration;
  }

  logEventLatency(operation: string, latency: number, meta?: LogMeta): void {
    this.debug(`Event processed: ${operation}`, { latency, ...meta });
  }

  logArbitrageOpportunity(opportunity: {
    id: string;
    type?: string;
    expectedProfit?: number;
    confidence?: number;
    buyDex?: string;
    sellDex?: string;
  }): void {
    this.info('Arbitrage opportunity detected', {
      id: opportunity.id,
      type: opportunity.type,
      profit: opportunity.expectedProfit,
      confidence: opportunity.confidence,
      buyDex: opportunity.buyDex,
      sellDex: opportunity.sellDex,
    });
  }

  logExecutionResult(result: {
    opportunityId: string;
    success: boolean;
    actualProfit?: number;
    gasUsed?: number;
    transactionHash?: string;
    error?: string;
  }): void {
    this.info('Trade execution completed', {
      opportunityId: result.opportunityId,
      success: result.success,
      profit: result.actualProfit,
      gasUsed: result.gasUsed,
      transactionHash: result.transactionHash,
      error: result.error,
    });
  }

  logHealthCheck(service: string, status: {
    status: string;
    memoryUsage?: number;
    cpuUsage?: number;
    uptime?: number;
  }): void {
    this.info('Health check completed', {
      service,
      status: status.status,
      memoryUsage: status.memoryUsage,
      cpuUsage: status.cpuUsage,
      uptime: status.uptime,
    });
  }

  logMetrics(metrics: LogMeta): void {
    this.info('Performance metrics', metrics);
  }
}

// =============================================================================
// Factory Functions for Tests
// =============================================================================

/**
 * Create a mock logger factory for tests.
 *
 * This can be used in place of jest.mock() to provide logger instances
 * that can be inspected after tests.
 *
 * @example
 * ```typescript
 * // In test setup
 * const { createLogger, getRecordingLoggers } = createMockLoggerFactory();
 *
 * // Inject createLogger into code under test (via DI or module replacement)
 * const service = createServiceWithLogger(createLogger);
 *
 * // After test
 * const loggers = getRecordingLoggers();
 * expect(loggers['my-service'].getErrors()).toHaveLength(0);
 * ```
 */
export function createMockLoggerFactory(): {
  createLogger: (name: string) => ILogger;
  getRecordingLoggers: () => Record<string, RecordingLogger>;
  clearAll: () => void;
} {
  const loggers: Record<string, RecordingLogger> = {};

  return {
    createLogger: (name: string): ILogger => {
      if (!loggers[name]) {
        loggers[name] = new RecordingLogger();
      }
      return loggers[name];
    },
    getRecordingLoggers: () => ({ ...loggers }),
    clearAll: () => {
      Object.values(loggers).forEach(logger => logger.clear());
    },
  };
}
