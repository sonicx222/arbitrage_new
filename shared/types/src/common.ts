/**
 * Common types used across all services
 *
 * Consolidated from scattered definitions to ensure consistency.
 */

/**
 * Minimal logger interface for dependency injection.
 * Compatible with Pino and test mocks.
 */
export interface ILogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Performance metrics for monitoring.
 * Used by health monitoring and dashboards.
 */
export interface PerformanceSnapshot {
  eventLatency: number;
  detectionLatency: number;
  executionLatency?: number;
  throughput: number;
  errorRate: number;
  timestamp: number;
}

/**
 * Validation result pattern.
 * Generic result type for validation operations.
 */
export interface ValidationResult<T = void> {
  valid: boolean;
  errors: ValidationFieldError[];
  warnings: ValidationWarning[];
  data?: T;
}

/**
 * Validation error details for a specific field.
 *
 * Named `ValidationFieldError` to avoid collision with the `ValidationError`
 * class (extends ArbitrageError) also exported from @arbitrage/types.
 */
export interface ValidationFieldError {
  field: string;
  message: string;
  code: string;
}

/**
 * Validation warning details.
 */
export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

/**
 * Base health interface for all services.
 * Provides consistent health status structure.
 */
export interface BaseHealth {
  /** Whether the component is healthy */
  healthy: boolean;
  /** Last health check timestamp */
  lastCheck: number;
  /** Last error message if any */
  lastError?: string;
}

/**
 * Resource usage metrics.
 * Used for monitoring and alerting.
 */
export interface ResourceUsage {
  /** Heap memory usage in bytes */
  heapUsed: number;
  /** Total heap size in bytes */
  heapTotal: number;
  /** External memory in bytes */
  external: number;
  /** RSS memory in bytes */
  rss: number;
  /** CPU usage percentage (0-100) */
  cpuUsage?: number;
}

/**
 * Service metadata for registration and discovery.
 */
export interface ServiceMetadata {
  /** Service name */
  name: string;
  /** Service version */
  version: string;
  /** Instance identifier */
  instanceId: string;
  /** Service region */
  region?: string;
  /** Start timestamp */
  startedAt: number;
}
