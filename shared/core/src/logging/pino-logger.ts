/**
 * Pino Logger Implementation
 *
 * High-performance logging using Pino with:
 * - Singleton caching to prevent resource leaks
 * - BigInt serialization support
 * - JSON output for production, pretty printing for development
 * - Child logger support for contextual logging
 *
 * Performance: ~120,000 ops/sec (6x faster than Winston)
 *
 * @see docs/architecture/adr/ADR-015-pino-logger-migration.md
 */

import pino, { Logger as PinoLoggerType, LoggerOptions } from 'pino';
import type { ILogger, IPerformanceLogger, LoggerConfig, LogLevel, LogMeta } from './types';

// =============================================================================
// Singleton Cache
// =============================================================================

/**
 * Cache for logger instances to prevent duplicate creation.
 * Key: service name, Value: logger instance
 */
const loggerCache = new Map<string, ILogger>();

/**
 * Reset all cached loggers.
 * Used for testing and service shutdown.
 */
export function resetLoggerCache(): void {
  loggerCache.clear();
}

// =============================================================================
// Serializers
// =============================================================================

/**
 * Custom serializers for Pino.
 * Handles BigInt and Error objects.
 */
const serializers: LoggerOptions['serializers'] = {
  // Serialize Error objects with stack traces
  err: pino.stdSerializers.err,
  error: pino.stdSerializers.err,

  // Custom serializer for any value (handles BigInt)
  // Note: Pino calls serializers on specific keys, so we handle BigInt in formatters
};

/**
 * Maximum recursion depth for formatLogObject to prevent stack overflow
 * on deeply nested structures.
 */
const MAX_FORMAT_DEPTH = 10;

/**
 * Check whether a value tree contains any BigInt values.
 * Used as a fast-path: if no BigInt exists, formatLogObject can return
 * the original object unchanged (zero allocation).
 *
 * Protected against circular references and excessive depth.
 */
function needsFormatting(value: unknown, seen?: WeakSet<object>, depth?: number): boolean {
  if (typeof value === 'bigint') return true;
  if (!value || typeof value !== 'object') return false;

  const currentDepth = depth ?? 0;
  // Pessimistic: if we can't scan deeper, assume formatting may be needed
  // to avoid undetected BigInt values crashing Pino's JSON serializer
  if (currentDepth >= MAX_FORMAT_DEPTH) return true;

  const currentSeen = seen ?? new WeakSet<object>();
  const obj = value as object;
  if (currentSeen.has(obj)) return false;
  currentSeen.add(obj);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (needsFormatting(obj[i], currentSeen, currentDepth + 1)) return true;
    }
    return false;
  }

  for (const key of Object.keys(obj)) {
    if (needsFormatting((obj as Record<string, unknown>)[key], currentSeen, currentDepth + 1)) return true;
  }
  return false;
}

/**
 * Format a single value, converting BigInt to string and recursing into
 * objects and arrays. Protected against circular references and depth overflow.
 */
function formatValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const obj = value as object;

  // Circular reference guard
  if (seen.has(obj)) {
    return '[Circular]';
  }

  // Depth guard
  if (depth >= MAX_FORMAT_DEPTH) {
    return '[Max Depth]';
  }

  seen.add(obj);

  // Handle arrays
  if (Array.isArray(obj)) {
    const result = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) {
      result[i] = formatValue(obj[i], seen, depth + 1);
    }
    return result;
  }

  // Skip Date and other built-in objects — pass through unchanged
  if (obj instanceof Date || obj instanceof RegExp) {
    return obj;
  }

  // Handle plain objects
  const formatted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    formatted[key] = formatValue(val, seen, depth + 1);
  }
  return formatted;
}

/**
 * Recursively format an object to handle BigInt values.
 *
 * Features:
 * - Fast-path: returns original object if no BigInt values exist (zero allocation)
 * - Array support: converts BigInt items inside arrays
 * - Circular reference protection: returns "[Circular]" marker
 * - Depth limiting: returns "[Max Depth]" beyond MAX_FORMAT_DEPTH levels
 *
 * @param obj - The log object to format
 * @param seen - WeakSet tracking visited objects (for circular reference detection)
 * @param depth - Current recursion depth
 */
export function formatLogObject(
  obj: Record<string, unknown>,
  seen?: WeakSet<object>,
  depth?: number,
): Record<string, unknown> {
  // Fast-path: if no BigInt values exist anywhere, return unchanged (Fix D)
  if (!needsFormatting(obj)) {
    return obj;
  }

  const currentSeen = seen ?? new WeakSet<object>();
  const currentDepth = depth ?? 0;

  // Depth guard for the top-level call
  if (currentDepth >= MAX_FORMAT_DEPTH) {
    return { _truncated: '[Max Depth]' };
  }

  // Mark this object as seen
  currentSeen.add(obj);

  const formatted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    formatted[key] = formatValue(value, currentSeen, currentDepth + 1);
  }
  return formatted;
}

function formatters(): LoggerOptions['formatters'] {
  return {
    // Format log objects (handles BigInt)
    log: formatLogObject,
    // Include level label
    level(label: string) {
      return { level: label };
    },
  };
}

// =============================================================================
// Pino Logger Wrapper
// =============================================================================

/**
 * Wrapper class that adapts Pino to our ILogger interface.
 * This allows seamless substitution with other implementations.
 */
class PinoLoggerWrapper implements ILogger {
  constructor(private readonly pino: PinoLoggerType) {}

  fatal(msg: string, meta?: LogMeta): void {
    if (meta) {
      this.pino.fatal(meta, msg);
    } else {
      this.pino.fatal(msg);
    }
  }

  error(msg: string, meta?: LogMeta): void {
    if (meta) {
      this.pino.error(meta, msg);
    } else {
      this.pino.error(msg);
    }
  }

  warn(msg: string, meta?: LogMeta): void {
    if (meta) {
      this.pino.warn(meta, msg);
    } else {
      this.pino.warn(msg);
    }
  }

  info(msg: string, meta?: LogMeta): void {
    if (meta) {
      this.pino.info(meta, msg);
    } else {
      this.pino.info(msg);
    }
  }

  debug(msg: string, meta?: LogMeta): void {
    if (meta) {
      this.pino.debug(meta, msg);
    } else {
      this.pino.debug(msg);
    }
  }

  trace(msg: string, meta?: LogMeta): void {
    if (meta) {
      this.pino.trace(meta, msg);
    } else {
      this.pino.trace(msg);
    }
  }

  child(bindings: LogMeta): ILogger {
    return new PinoLoggerWrapper(this.pino.child(bindings));
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.pino.isLevelEnabled(level);
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a Pino logger instance.
 *
 * Uses singleton caching - calling with the same name returns the same instance.
 *
 * @param config - Logger configuration or just the service name
 * @returns ILogger instance
 *
 * @example
 * ```typescript
 * // Simple usage
 * const logger = createPinoLogger('my-service');
 *
 * // With options
 * const logger = createPinoLogger({
 *   name: 'my-service',
 *   level: 'debug',
 *   pretty: true
 * });
 * ```
 */
export function createPinoLogger(config: string | LoggerConfig): ILogger {
  const normalizedConfig: LoggerConfig = typeof config === 'string'
    ? { name: config }
    : config;

  const { name, level, pretty, bindings } = normalizedConfig;

  // Return cached instance if available
  const cacheKey = name;
  if (loggerCache.has(cacheKey)) {
    const cached = loggerCache.get(cacheKey)!;
    // If bindings requested, create a child logger
    return bindings ? cached.child(bindings) : cached;
  }

  // Determine log level from config or environment
  const logLevel = level || (process.env.LOG_LEVEL as LogLevel) || 'info';

  // Determine if pretty printing should be enabled
  // LOG_FORMAT=json forces JSON output even in development (used by startup script to parse child output)
  const usePretty = pretty ?? (process.env.LOG_FORMAT !== 'json' && process.env.NODE_ENV === 'development');

  // Build Pino options
  const options: LoggerOptions = {
    name,
    level: logLevel,
    serializers,
    formatters: formatters(),
    // Base context for all log entries
    base: {
      service: name,
      pid: process.pid,
    },
    // Redact sensitive fields from log output (API keys, secrets)
    redact: {
      paths: [
        'url', '*.url',
        'wsUrl', '*.wsUrl',
        'rpcUrl', '*.rpcUrl',
        'endpoint', '*.endpoint',
        'apiKey', '*.apiKey',
        'privateKey', '*.privateKey',
        'secret', '*.secret',
        'password', '*.password',
        'authorization', '*.authorization',
        'token', '*.token',
      ],
      censor: '[REDACTED]',
    },
  };

  // Add transport for pretty printing in development
  if (usePretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,service',
      },
    };
  }

  // Create Pino instance
  const pinoInstance = pino(options);

  // Wrap in our interface
  const logger = new PinoLoggerWrapper(pinoInstance);

  // Cache and return
  loggerCache.set(cacheKey, logger);

  // If bindings requested, create a child logger (but don't cache the child)
  return bindings ? logger.child(bindings) : logger;
}

/**
 * Get a logger by name (alias for createPinoLogger with caching).
 * Preferred for DI patterns.
 *
 * @param name - Service name
 * @returns Cached ILogger instance
 */
export function getLogger(name: string): ILogger {
  return createPinoLogger(name);
}

// =============================================================================
// Performance Logger
// =============================================================================

/**
 * Performance logger implementation using Pino.
 * Extends base logging with timing and metrics capabilities.
 */
export class PinoPerformanceLogger implements IPerformanceLogger {
  private readonly logger: ILogger;
  private readonly timers: Map<string, { start: number; count: number }> = new Map();

  constructor(serviceName: string) {
    this.logger = createPinoLogger(serviceName);
  }

  // ILogger methods delegate to base logger
  fatal(msg: string, meta?: LogMeta): void { this.logger.fatal(msg, meta); }
  error(msg: string, meta?: LogMeta): void { this.logger.error(msg, meta); }
  warn(msg: string, meta?: LogMeta): void { this.logger.warn(msg, meta); }
  info(msg: string, meta?: LogMeta): void { this.logger.info(msg, meta); }
  debug(msg: string, meta?: LogMeta): void { this.logger.debug(msg, meta); }
  trace(msg: string, meta?: LogMeta): void { this.logger.trace?.(msg, meta); }
  child(bindings: LogMeta): ILogger { return this.logger.child(bindings); }

  // Performance methods
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
    this.debug(`Event processed: ${operation}`, {
      latency,
      ...meta,
    });
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

/**
 * Cache for performance loggers.
 */
const performanceLoggerCache = new Map<string, PinoPerformanceLogger>();

/**
 * Get a performance logger by service name.
 * Uses singleton caching.
 *
 * @param serviceName - Service name
 * @returns Cached IPerformanceLogger instance
 */
export function getPinoPerformanceLogger(serviceName: string): IPerformanceLogger {
  if (!performanceLoggerCache.has(serviceName)) {
    performanceLoggerCache.set(serviceName, new PinoPerformanceLogger(serviceName));
  }
  return performanceLoggerCache.get(serviceName)!;
}

/**
 * Reset performance logger cache.
 * Used for testing.
 */
export function resetPerformanceLoggerCache(): void {
  performanceLoggerCache.clear();
}
