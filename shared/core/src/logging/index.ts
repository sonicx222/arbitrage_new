/**
 * Logging Module
 *
 * Exports the ILogger interface and implementations.
 *
 * For production code, use:
 * - createLogger() - Creates/returns cached Pino logger
 * - getLogger() - Alias for createLogger with DI semantics
 *
 * For tests, use:
 * - RecordingLogger - Captures logs for assertions
 * - NullLogger - Silently discards logs
 *
 * @see docs/logger_implementation_plan.md
 */

// Types
export type {
  ILogger,
  IPerformanceLogger,
  LoggerConfig,
  LogLevel,
  LogMeta,
} from './types';

// Pino implementation (production)
export {
  createPinoLogger,
  getLogger,
  getPinoPerformanceLogger,
  PinoPerformanceLogger,
  resetLoggerCache,
  resetPerformanceLoggerCache,
} from './pino-logger';

// Testing implementations
export {
  RecordingLogger,
  RecordingPerformanceLogger,
  NullLogger,
  createMockLoggerFactory,
} from './testing-logger';
export type { LogEntry } from './testing-logger';
