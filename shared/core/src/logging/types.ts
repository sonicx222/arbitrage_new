/**
 * Logger Type Definitions
 *
 * Defines the ILogger interface that decouples the codebase from any specific
 * logging library (Winston, Pino, etc.). This enables:
 * 1. Easy library swapping without code changes
 * 2. Dependency injection for testability
 * 3. Type-safe logging across the codebase
 *
 * P0-FIX: Added ServiceLogger interface to consolidate duplicate logger interfaces
 * (BaseDetectorLogger, FactorySubscriptionLogger) into a single shared type.
 *
 * @see docs/logger_implementation_plan.md
 */

/**
 * Log level union type for type-safe level checking.
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Metadata object that can be attached to log entries.
 * Supports BigInt via serialization.
 */
export type LogMeta = Record<string, unknown>;

/**
 * Minimal logger interface for dependency injection in services.
 *
 * P0-FIX: Consolidated interface replacing duplicate definitions in:
 * - base-detector.ts (BaseDetectorLogger)
 * - factory-subscription.ts (FactorySubscriptionLogger)
 *
 * Use this type for service constructor parameters when you only need
 * basic logging methods without child loggers or performance features.
 *
 * @example
 * ```typescript
 * class MyService {
 *   constructor(private logger: ServiceLogger) {}
 * }
 *
 * // Production
 * new MyService(createLogger('my-service'));
 *
 * // Test
 * new MyService(new RecordingLogger());
 * ```
 */
export interface ServiceLogger {
  info: (message: string, meta?: LogMeta) => void;
  warn: (message: string, meta?: LogMeta) => void;
  error: (message: string, meta?: LogMeta) => void;
  debug: (message: string, meta?: LogMeta) => void;
}

/**
 * Core logger interface.
 *
 * All logging implementations (Pino, Winston, RecordingLogger, NullLogger)
 * must implement this interface. This is the ONLY type that should be used
 * for logger parameters in class constructors (DI pattern).
 *
 * @example
 * ```typescript
 * class MyService {
 *   constructor(private logger: ILogger) {}
 *
 *   doWork() {
 *     this.logger.info('Work started', { taskId: 123 });
 *   }
 * }
 *
 * // Production
 * new MyService(createLogger('my-service'));
 *
 * // Test
 * const mockLogger = new RecordingLogger();
 * new MyService(mockLogger);
 * expect(mockLogger.getLogs('info')).toContainEqual(expect.objectContaining({ msg: 'Work started' }));
 * ```
 */
export interface ILogger {
  /**
   * Log a fatal error (system is unusable).
   */
  fatal(msg: string, meta?: LogMeta): void;

  /**
   * Log an error (operation failed).
   */
  error(msg: string, meta?: LogMeta): void;

  /**
   * Log a warning (potential problem).
   */
  warn(msg: string, meta?: LogMeta): void;

  /**
   * Log informational message (normal operation).
   */
  info(msg: string, meta?: LogMeta): void;

  /**
   * Log debug message (diagnostic information).
   */
  debug(msg: string, meta?: LogMeta): void;

  /**
   * Log trace message (fine-grained debugging).
   */
  trace?(msg: string, meta?: LogMeta): void;

  /**
   * Create a child logger with additional context.
   * The context is merged into every log entry from the child.
   *
   * @param bindings - Context to add to every log entry
   * @returns A new logger with the bindings attached
   *
   * @example
   * ```typescript
   * const requestLogger = logger.child({ requestId: 'abc-123' });
   * requestLogger.info('Processing'); // { requestId: 'abc-123', msg: 'Processing' }
   * ```
   */
  child(bindings: LogMeta): ILogger;

  /**
   * Check if a given log level is enabled.
   * Useful for avoiding expensive computations for disabled levels.
   *
   * @param level - The log level to check
   * @returns true if the level is enabled
   */
  isLevelEnabled?(level: LogLevel): boolean;
}

/**
 * Extended logger interface for performance-critical operations.
 * Includes methods for timing and metrics.
 */
export interface IPerformanceLogger extends ILogger {
  /**
   * Start a timer for an operation.
   */
  startTimer(operation: string): void;

  /**
   * End a timer and log the duration.
   * @returns Duration in milliseconds
   */
  endTimer(operation: string, meta?: LogMeta): number;

  /**
   * Log event processing latency.
   */
  logEventLatency(operation: string, latency: number, meta?: LogMeta): void;

  /**
   * Log an arbitrage opportunity detection.
   */
  logArbitrageOpportunity(opportunity: {
    id: string;
    type?: string;
    expectedProfit?: number;
    confidence?: number;
    buyDex?: string;
    sellDex?: string;
  }): void;

  /**
   * Log trade execution result.
   */
  logExecutionResult(result: {
    opportunityId: string;
    success: boolean;
    actualProfit?: number;
    gasUsed?: string;
    transactionHash?: string;
    error?: string;
  }): void;

  /**
   * Log health check results.
   */
  logHealthCheck(service: string, status: {
    status: string;
    memoryUsage?: number;
    cpuUsage?: number;
    uptime?: number;
  }): void;

  /**
   * Log performance metrics.
   */
  logMetrics(metrics: LogMeta): void;
}

/**
 * Configuration for logger creation.
 */
export interface LoggerConfig {
  /**
   * Service/module name for log identification.
   */
  name: string;

  /**
   * Minimum log level to output.
   * @default 'info'
   */
  level?: LogLevel;

  /**
   * Enable pretty printing (development mode).
   * @default process.env.NODE_ENV === 'development'
   */
  pretty?: boolean;

  /**
   * Additional context to include in every log entry.
   */
  bindings?: LogMeta;
}
