/**
 * Shared Error Handling Utilities
 *
 * REF-3/ARCH-2 FIX: Standardized error handling patterns across services.
 * Provides consistent error types, codes, and handling utilities.
 *
 * Used by:
 * - All services for consistent error reporting
 * - Coordinator for error aggregation and monitoring
 * - API endpoints for error responses
 *
 * @see ARCHITECTURE_V2.md Section 4.5 (Error Handling)
 */

// =============================================================================
// Error Codes
// =============================================================================

/**
 * Standardized error codes for the arbitrage system.
 */
export enum ErrorCode {
  // General errors (1000-1999)
  UNKNOWN_ERROR = 1000,
  INVALID_ARGUMENT = 1001,
  NOT_FOUND = 1002,
  ALREADY_EXISTS = 1003,
  PERMISSION_DENIED = 1004,
  INVALID_STATE = 1005,
  OPERATION_CANCELLED = 1006,

  // Connection errors (2000-2999)
  CONNECTION_FAILED = 2000,
  CONNECTION_TIMEOUT = 2001,
  CONNECTION_CLOSED = 2002,
  RECONNECTION_FAILED = 2003,
  WEBSOCKET_ERROR = 2004,

  // Redis errors (3000-3999)
  REDIS_CONNECTION_ERROR = 3000,
  REDIS_OPERATION_ERROR = 3001,
  REDIS_LOCK_ERROR = 3002,
  REDIS_STREAM_ERROR = 3003,

  // Blockchain errors (4000-4999)
  RPC_ERROR = 4000,
  RPC_TIMEOUT = 4001,
  RPC_RATE_LIMITED = 4002,
  INVALID_BLOCK = 4003,
  INVALID_TRANSACTION = 4004,
  CONTRACT_ERROR = 4005,
  CHAIN_REORG = 4006,

  // Arbitrage errors (5000-5999)
  NO_OPPORTUNITY = 5000,
  INSUFFICIENT_LIQUIDITY = 5001,
  PRICE_SLIPPAGE = 5002,
  GAS_TOO_HIGH = 5003,
  EXECUTION_FAILED = 5004,
  OPPORTUNITY_EXPIRED = 5005,
  UNPROFITABLE = 5006,

  // Validation errors (6000-6999)
  VALIDATION_FAILED = 6000,
  INVALID_MESSAGE = 6001,
  INVALID_CONFIG = 6002,
  SCHEMA_MISMATCH = 6003,

  // Service lifecycle errors (7000-7999)
  SERVICE_NOT_STARTED = 7000,
  SERVICE_ALREADY_RUNNING = 7001,
  SERVICE_STOPPING = 7002,
  SHUTDOWN_TIMEOUT = 7003,
  INITIALIZATION_FAILED = 7004
}

/**
 * Error severity levels.
 */
export enum ErrorSeverity {
  /** Informational - expected errors that don't require action */
  INFO = 'info',
  /** Warning - unexpected but recoverable errors */
  WARNING = 'warning',
  /** Error - failures that may impact functionality */
  ERROR = 'error',
  /** Critical - severe failures requiring immediate attention */
  CRITICAL = 'critical'
}

// =============================================================================
// Custom Error Classes
// =============================================================================

/**
 * Base error class for the arbitrage system.
 * Provides structured error information for logging and monitoring.
 */
export class ArbitrageError extends Error {
  readonly code: ErrorCode;
  readonly severity: ErrorSeverity;
  readonly timestamp: number;
  readonly context?: Record<string, unknown>;
  readonly cause?: Error;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.UNKNOWN_ERROR,
    options: {
      severity?: ErrorSeverity;
      context?: Record<string, unknown>;
      cause?: Error;
    } = {}
  ) {
    super(message);
    this.name = 'ArbitrageError';
    this.code = code;
    this.severity = options.severity ?? ErrorSeverity.ERROR;
    this.timestamp = Date.now();
    this.context = options.context;
    this.cause = options.cause;

    // Capture stack trace
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * Convert to JSON for logging/serialization.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      severity: this.severity,
      timestamp: this.timestamp,
      context: this.context,
      cause: this.cause?.message,
      stack: this.stack
    };
  }
}

/**
 * Connection error for network/WebSocket failures.
 */
export class ConnectionError extends ArbitrageError {
  readonly endpoint?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      code?: ErrorCode;
      endpoint?: string;
      retryable?: boolean;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, options.code ?? ErrorCode.CONNECTION_FAILED, {
      severity: ErrorSeverity.WARNING,
      cause: options.cause,
      context: { ...options.context, endpoint: options.endpoint }
    });
    this.name = 'ConnectionError';
    this.endpoint = options.endpoint;
    this.retryable = options.retryable ?? true;
  }
}

/**
 * Validation error for invalid input/messages.
 */
export class ValidationError extends ArbitrageError {
  readonly field?: string;
  readonly expectedType?: string;
  readonly receivedValue?: unknown;

  constructor(
    message: string,
    options: {
      field?: string;
      expectedType?: string;
      receivedValue?: unknown;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, ErrorCode.VALIDATION_FAILED, {
      severity: ErrorSeverity.WARNING,
      context: {
        ...options.context,
        field: options.field,
        expectedType: options.expectedType,
        receivedValue: typeof options.receivedValue
      }
    });
    this.name = 'ValidationError';
    this.field = options.field;
    this.expectedType = options.expectedType;
    this.receivedValue = options.receivedValue;
  }
}

/**
 * Service lifecycle error for start/stop issues.
 */
export class LifecycleError extends ArbitrageError {
  readonly serviceName: string;
  readonly currentState?: string;

  constructor(
    message: string,
    serviceName: string,
    options: {
      code?: ErrorCode;
      currentState?: string;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, options.code ?? ErrorCode.INVALID_STATE, {
      severity: ErrorSeverity.ERROR,
      cause: options.cause,
      context: { ...options.context, serviceName, currentState: options.currentState }
    });
    this.name = 'LifecycleError';
    this.serviceName = serviceName;
    this.currentState = options.currentState;
  }
}

/**
 * Execution error for arbitrage execution failures.
 */
export class ExecutionError extends ArbitrageError {
  readonly opportunityId?: string;
  readonly chain?: string;
  readonly transactionHash?: string;

  constructor(
    message: string,
    options: {
      code?: ErrorCode;
      opportunityId?: string;
      chain?: string;
      transactionHash?: string;
      cause?: Error;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message, options.code ?? ErrorCode.EXECUTION_FAILED, {
      severity: ErrorSeverity.ERROR,
      cause: options.cause,
      context: {
        ...options.context,
        opportunityId: options.opportunityId,
        chain: options.chain,
        transactionHash: options.transactionHash
      }
    });
    this.name = 'ExecutionError';
    this.opportunityId = options.opportunityId;
    this.chain = options.chain;
    this.transactionHash = options.transactionHash;
  }
}

// =============================================================================
// Error Handling Utilities
// =============================================================================

/**
 * Result type for operations that may fail.
 */
export type Result<T, E = ArbitrageError> =
  | { success: true; data: T }
  | { success: false; error: E };

/**
 * Create a success result.
 */
export function success<T>(data: T): Result<T> {
  return { success: true, data };
}

/**
 * Create a failure result.
 */
export function failure<E extends ArbitrageError>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Wrap an async function to return Result type instead of throwing.
 */
export async function tryCatch<T>(
  fn: () => Promise<T>,
  errorCode: ErrorCode = ErrorCode.UNKNOWN_ERROR
): Promise<Result<T>> {
  try {
    const data = await fn();
    return success(data);
  } catch (error) {
    if (error instanceof ArbitrageError) {
      return failure(error);
    }
    return failure(
      new ArbitrageError(
        (error as Error).message || 'Unknown error',
        errorCode,
        { cause: error as Error }
      )
    );
  }
}

/**
 * Wrap a sync function to return Result type instead of throwing.
 */
export function tryCatchSync<T>(
  fn: () => T,
  errorCode: ErrorCode = ErrorCode.UNKNOWN_ERROR
): Result<T> {
  try {
    const data = fn();
    return success(data);
  } catch (error) {
    if (error instanceof ArbitrageError) {
      return failure(error);
    }
    return failure(
      new ArbitrageError(
        (error as Error).message || 'Unknown error',
        errorCode,
        { cause: error as Error }
      )
    );
  }
}

// =============================================================================
// Error Classification
// =============================================================================

/**
 * Check if an error is retryable.
 */
export function isRetryableError(error: Error): boolean {
  if (error instanceof ConnectionError) {
    return error.retryable;
  }

  if (error instanceof ArbitrageError) {
    // Retryable error codes
    const retryableCodes = new Set([
      ErrorCode.CONNECTION_TIMEOUT,
      ErrorCode.RPC_TIMEOUT,
      ErrorCode.RPC_RATE_LIMITED,
      ErrorCode.REDIS_CONNECTION_ERROR,
      ErrorCode.RECONNECTION_FAILED
    ]);
    return retryableCodes.has(error.code);
  }

  // Check for common retryable error patterns
  const message = error.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('rate limit') ||
    message.includes('connection') ||
    message.includes('econnreset') ||
    message.includes('econnrefused')
  );
}

/**
 * Check if an error is a critical error requiring immediate attention.
 */
export function isCriticalError(error: Error): boolean {
  if (error instanceof ArbitrageError) {
    return error.severity === ErrorSeverity.CRITICAL;
  }

  // Check for critical error patterns
  const message = error.message.toLowerCase();
  return (
    message.includes('out of memory') ||
    message.includes('fatal') ||
    message.includes('corrupt')
  );
}

/**
 * Get error severity based on error type and context.
 */
export function getErrorSeverity(error: Error): ErrorSeverity {
  if (error instanceof ArbitrageError) {
    return error.severity;
  }

  if (isCriticalError(error)) {
    return ErrorSeverity.CRITICAL;
  }

  if (isRetryableError(error)) {
    return ErrorSeverity.WARNING;
  }

  return ErrorSeverity.ERROR;
}

// =============================================================================
// Error Formatting
// =============================================================================

/**
 * Format error for logging.
 */
export function formatErrorForLog(error: Error): Record<string, unknown> {
  if (error instanceof ArbitrageError) {
    return error.toJSON();
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

/**
 * Format error for API response.
 */
export function formatErrorForResponse(error: Error): {
  code: number;
  message: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof ArbitrageError) {
    return {
      code: error.code,
      message: error.message,
      details: error.context
    };
  }

  return {
    code: ErrorCode.UNKNOWN_ERROR,
    message: error.message
  };
}

// =============================================================================
// Error Aggregation
// =============================================================================

/**
 * Error aggregator for collecting multiple errors.
 */
export class ErrorAggregator {
  private errors: ArbitrageError[] = [];
  private readonly maxErrors: number;

  constructor(maxErrors: number = 100) {
    this.maxErrors = maxErrors;
  }

  /**
   * Add an error to the aggregator.
   */
  add(error: Error): void {
    const arbitrageError =
      error instanceof ArbitrageError
        ? error
        : new ArbitrageError(error.message, ErrorCode.UNKNOWN_ERROR, { cause: error });

    this.errors.push(arbitrageError);

    // Trim oldest errors if over limit
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors);
    }
  }

  /**
   * Get all errors.
   */
  getAll(): ArbitrageError[] {
    return [...this.errors];
  }

  /**
   * Get errors by severity.
   */
  getBySeverity(severity: ErrorSeverity): ArbitrageError[] {
    return this.errors.filter(e => e.severity === severity);
  }

  /**
   * Get errors by code.
   */
  getByCode(code: ErrorCode): ArbitrageError[] {
    return this.errors.filter(e => e.code === code);
  }

  /**
   * Get error count.
   */
  count(): number {
    return this.errors.length;
  }

  /**
   * Get error count by severity.
   */
  countBySeverity(): Record<ErrorSeverity, number> {
    return {
      [ErrorSeverity.INFO]: this.getBySeverity(ErrorSeverity.INFO).length,
      [ErrorSeverity.WARNING]: this.getBySeverity(ErrorSeverity.WARNING).length,
      [ErrorSeverity.ERROR]: this.getBySeverity(ErrorSeverity.ERROR).length,
      [ErrorSeverity.CRITICAL]: this.getBySeverity(ErrorSeverity.CRITICAL).length
    };
  }

  /**
   * Clear all errors.
   */
  clear(): void {
    this.errors = [];
  }

  /**
   * Check if there are any critical errors.
   */
  hasCriticalErrors(): boolean {
    return this.errors.some(e => e.severity === ErrorSeverity.CRITICAL);
  }
}
