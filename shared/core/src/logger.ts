/**
 * Logger Facade
 *
 * Provides backward-compatible exports that delegate to the Pino-based
 * logging module. This file exists solely to preserve the import paths
 * used by 66+ source files and 30+ test mocks.
 *
 * All real implementation lives in ./logging/pino-logger.ts.
 *
 * @see docs/architecture/adr/ADR-015-pino-logger-migration.md
 */

import { createPinoLogger, getPinoPerformanceLogger } from './logging/pino-logger';
import type { IPerformanceLogger, LogMeta } from './logging/types';

/**
 * Backward-compatible Logger type with permissive parameter types.
 * 19+ files import this type and rely on `any`-permissive meta parameters.
 *
 * For new code, prefer ILogger from ./logging/types for stricter type safety.
 */
export interface Logger {
  fatal(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  info(msg: string, meta?: any): void;
  debug(msg: string, meta?: any): void;
  trace?(msg: string, meta?: any): void;
  child(bindings: Record<string, unknown>): Logger;
  isLevelEnabled?(level: string): boolean;
  /** @deprecated Access via isLevelEnabled() instead */
  level?: string;
}

/**
 * Minimal logger interface for dependency injection.
 * Preserved for 2 callers (cross-region-health.ts, stream-health-monitor.ts).
 * Compatible with ILogger and simple test mocks.
 */
export interface LoggerLike {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Create a logger instance for a service.
 * Delegates to Pino-based implementation with singleton caching.
 *
 * @param serviceName - Service name for log identification
 * @returns Logger instance
 */
export function createLogger(serviceName: string): Logger {
  return createPinoLogger(serviceName);
}

/**
 * Performance logging utilities.
 *
 * Facade wrapping PinoPerformanceLogger. Preserves the class export
 * used as a type annotation in multiple service files.
 */
export class PerformanceLogger implements IPerformanceLogger {
  private readonly delegate: IPerformanceLogger;

  constructor(serviceName: string) {
    this.delegate = getPinoPerformanceLogger(serviceName);
  }

  // ILogger methods
  fatal(msg: string, meta?: LogMeta): void { this.delegate.fatal(msg, meta); }
  error(msg: string, meta?: LogMeta): void { this.delegate.error(msg, meta); }
  warn(msg: string, meta?: LogMeta): void { this.delegate.warn(msg, meta); }
  info(msg: string, meta?: LogMeta): void { this.delegate.info(msg, meta); }
  debug(msg: string, meta?: LogMeta): void { this.delegate.debug(msg, meta); }
  trace(msg: string, meta?: LogMeta): void { this.delegate.trace?.(msg, meta); }
  child(bindings: LogMeta): Logger { return this.delegate.child(bindings) as Logger; }

  // IPerformanceLogger methods
  startTimer(operation: string): void { this.delegate.startTimer(operation); }

  endTimer(operation: string, meta?: LogMeta): number {
    return this.delegate.endTimer(operation, meta);
  }

  logEventLatency(operation: string, latency: number, meta?: LogMeta): void {
    this.delegate.logEventLatency(operation, latency, meta);
  }

  // Backward-compatible methods use `any` parameter types for legacy callers.
  // New code should use IPerformanceLogger for strict typed signatures.

  logArbitrageOpportunity(opportunity: any): void {
    this.delegate.logArbitrageOpportunity(opportunity);
  }

  logExecutionResult(result: any): void {
    this.delegate.logExecutionResult(result);
  }

  /**
   * Log an error with optional context.
   * Backward-compatible method not present on IPerformanceLogger.
   * No external callers found, but preserved defensively.
   */
  logError(error: Error, context?: Record<string, unknown>): void {
    this.delegate.error('Error occurred', {
      error: error.message,
      stack: error.stack,
      ...context,
    });
  }

  logHealthCheck(service: string, status: any): void {
    this.delegate.logHealthCheck(service, status);
  }

  logMetrics(metrics: any): void {
    this.delegate.logMetrics(metrics);
  }
}

// Cache for PerformanceLogger facade instances
const performanceLoggers: Map<string, PerformanceLogger> = new Map();

/**
 * Get a cached PerformanceLogger for a service.
 *
 * @param serviceName - Service name
 * @returns Cached PerformanceLogger instance
 */
export function getPerformanceLogger(serviceName: string): PerformanceLogger {
  if (!performanceLoggers.has(serviceName)) {
    performanceLoggers.set(serviceName, new PerformanceLogger(serviceName));
  }
  return performanceLoggers.get(serviceName)!;
}
