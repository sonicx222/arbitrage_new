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
 * @see docs/architecture/adr/ADR-015-pino-logger-migration.md
 */

// Types
export type {
  ILogger,
  IPerformanceLogger,
  LoggerConfig,
  LogLevel,
  LogMeta,
  ServiceLogger,
} from './types';

// Pino implementation (production)
export {
  createPinoLogger,
  formatLogObject,
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
