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
  setLogLevel,
  // OTEL transport lifecycle
  getOtelTransport,
  shutdownOtelTransport,
} from './pino-logger';

// OpenTelemetry log transport (O-3: Centralized log aggregation)
export {
  createOtelTransport,
  resolveOtelConfig,
  OtelTransportStream,
} from './otel-transport';
export type { OtelTransportConfig } from './otel-transport';

// Log sampling (Issue H: high-frequency debug event rate limiting)
export { LogSampler } from './log-sampler';
export type { LogSamplerConfig } from './log-sampler';

// ALS trace context (Task 3: automatic traceId/spanId injection via Pino mixin)
export { withLogContext, getLogContext, resetLogContext } from './log-context';
export type { LogContext } from './log-context';

// Testing implementations
export {
  RecordingLogger,
  RecordingPerformanceLogger,
  NullLogger,
  createMockLoggerFactory,
} from './testing-logger';
export type { LogEntry } from './testing-logger';
