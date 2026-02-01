// Exponential Backoff and Retry Mechanism
// Intelligent retry logic with jitter and circuit breaker integration

import { createLogger } from '../logger';

const logger = createLogger('retry-mechanism');

// =============================================================================
// P1-2 fix: Error Classification Utility
// =============================================================================

/**
 * Error classification for determining retry behavior.
 * P1-2 fix: Categorize errors as transient (retryable) vs permanent (not retryable).
 */
export enum ErrorCategory {
  TRANSIENT = 'transient',     // Temporary errors - retry
  PERMANENT = 'permanent',     // Permanent errors - don't retry
  UNKNOWN = 'unknown'          // Unknown - retry with caution
}

/**
 * P1-2 fix: Classify an error to determine if it should be retried.
 */
export function classifyError(error: any): ErrorCategory {
  if (!error) return ErrorCategory.PERMANENT;

  const errorName = error.name || error.constructor?.name || '';
  const errorCode = error.code;
  const statusCode = error.status || error.statusCode;
  const message = (error.message || '').toLowerCase();

  // Permanent errors - never retry
  // P1-10 FIX: Use exact matching instead of .includes() to prevent false positives
  // e.g., "MyValidationErrorHandler" should NOT match "ValidationError"
  const permanentErrors = [
    'ValidationError', 'AuthenticationError', 'AuthorizationError',
    'NotFoundError', 'InvalidInputError', 'CircuitBreakerError',
    'InsufficientFundsError', 'GasEstimationFailed'
  ];
  if (permanentErrors.some(type => errorName === type)) {
    return ErrorCategory.PERMANENT;
  }

  // Permanent HTTP status codes (4xx client errors, except 429)
  if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
    return ErrorCategory.PERMANENT;
  }

  // Transient errors - always retry
  const transientCodes = [
    'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
    'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'
  ];
  if (errorCode && transientCodes.includes(errorCode)) {
    return ErrorCategory.TRANSIENT;
  }

  // Transient HTTP status codes
  const transientStatuses = [429, 500, 502, 503, 504];
  if (statusCode && transientStatuses.includes(statusCode)) {
    return ErrorCategory.TRANSIENT;
  }

  // Transient error messages
  const transientMessages = [
    'timeout', 'connection', 'network', 'retry', 'temporary',
    'rate limit', 'too many requests', 'service unavailable'
  ];
  if (transientMessages.some(msg => message.includes(msg))) {
    return ErrorCategory.TRANSIENT;
  }

  // Blockchain/RPC transient errors
  // P1-11 FIX: Removed duplicate -32603, added missing codes -32700 (parse error), -32600 (invalid request)
  // JSON-RPC 2.0 Error Codes: https://www.jsonrpc.org/specification#error_object
  const rpcTransientCodes = [
    -32700, // Parse error (malformed JSON - may be transient network issue)
    -32600, // Invalid request (can occur during node sync)
    -32000, // Server error (generic - often transient)
    -32005, // Rate limit exceeded
    -32603  // Internal error (often transient node issues)
  ];
  if (errorCode && rpcTransientCodes.includes(errorCode)) {
    return ErrorCategory.TRANSIENT;
  }

  // Unknown - default to retryable for resilience
  return ErrorCategory.UNKNOWN;
}

/**
 * P1-2 fix: Check if an error should be retried based on classification.
 */
export function isRetryableError(error: any): boolean {
  const category = classifyError(error);
  return category !== ErrorCategory.PERMANENT;
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;        // Base delay in milliseconds
  maxDelay: number;           // Maximum delay between retries
  backoffMultiplier: number;  // Exponential backoff multiplier
  jitter: boolean;           // Add random jitter to prevent thundering herd
  retryCondition?: (error: any) => boolean; // Function to determine if error is retryable
  onRetry?: (attempt: number, error: any, delay: number) => void; // Callback before retry
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: any;
  attempts: number;
  totalDelay: number;
}

export class RetryMechanism {
  private config: Required<RetryConfig>;

  constructor(config: Partial<RetryConfig> = {}) {
    // BUG FIX: Use ?? instead of || to correctly handle 0 values
    // Previously, maxAttempts: 0 would be treated as falsy and default to 3
    this.config = {
      maxAttempts: config.maxAttempts ?? 3,
      initialDelay: config.initialDelay ?? 1000,
      maxDelay: config.maxDelay ?? 30000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      jitter: config.jitter !== false,
      retryCondition: config.retryCondition ?? this.defaultRetryCondition,
      onRetry: config.onRetry ?? (() => { })
    };
  }

  // Execute a function with retry logic
  async execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    let lastError: any;
    let totalDelay = 0;

    let attempt = 1;
    for (attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const result = await fn();
        return {
          success: true,
          result,
          attempts: attempt,
          totalDelay
        };
      } catch (error: any) {
        lastError = error;

        // Check if we should retry this error
        if (!this.config.retryCondition(error)) {
          logger.debug('Error not retryable, giving up', { error: error.message, attempt });
          break;
        }

        // Don't retry on the last attempt
        if (attempt === this.config.maxAttempts) {
          break;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);

        logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
          error: error.message,
          attempt,
          maxAttempts: this.config.maxAttempts
        });

        // Execute retry callback
        this.config.onRetry(attempt, error, delay);

        // Wait before retrying
        await this.delay(delay);
        totalDelay += delay;
      }
    }

    return {
      success: false,
      error: lastError,
      attempts: Math.min(this.config.maxAttempts, attempt),
      totalDelay
    };
  }

  // Execute with timeout protection
  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<RetryResult<T>> {
    let timeoutHandle: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const result = await Promise.race([this.execute(fn), timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return result;
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return {
        success: false,
        error,
        attempts: 1,
        totalDelay: 0
      };
    }
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff: delay = initialDelay * (backoffMultiplier ^ (attempt - 1))
    let delay = this.config.initialDelay * Math.pow(this.config.backoffMultiplier, attempt - 1);

    // Cap at maximum delay
    delay = Math.min(delay, this.config.maxDelay);

    // Add jitter to prevent thundering herd
    if (this.config.jitter) {
      // Add random jitter between 0% and 25% of the delay
      const jitterAmount = delay * 0.25 * Math.random();
      delay += jitterAmount;
    }

    return Math.floor(delay);
  }

  /**
   * P0-8 FIX: Use classifyError() as single source of truth for retry decisions.
   *
   * Previous implementation was INCONSISTENT with classifyError():
   * - Didn't check RPC transient codes (-32005, -32603, etc.)
   * - Didn't handle 429 (rate limit) as retryable
   * - Didn't check transient message patterns
   *
   * Now delegates to isRetryableError() which uses classifyError() internally.
   */
  private defaultRetryCondition(error: any): boolean {
    // P0-8 FIX: Use single source of truth for error classification
    return isRetryableError(error);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Pre-configured retry mechanisms for common use cases
export class RetryPresets {
  static readonly NETWORK_CALL = new RetryMechanism({
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    jitter: true,
    retryCondition: (error) => {
      // Retry network-related errors
      return error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        (error.status && error.status >= 500);
    }
  });

  static readonly DATABASE_OPERATION = new RetryMechanism({
    maxAttempts: 5,
    initialDelay: 500,
    maxDelay: 5000,
    backoffMultiplier: 1.5,
    jitter: true,
    retryCondition: (error) => {
      // Retry database connection and temporary errors
      return error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.message?.includes('connection') ||
        error.message?.includes('timeout');
    }
  });

  static readonly EXTERNAL_API = new RetryMechanism({
    maxAttempts: 3,
    initialDelay: 2000,
    maxDelay: 15000,
    backoffMultiplier: 2,
    jitter: true,
    retryCondition: (error) => {
      // Retry API rate limits and temporary failures
      return error.status === 429 || // Rate limited
        error.status === 503 || // Service unavailable
        error.status === 502 || // Bad gateway
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT';
    }
  });

  static readonly BLOCKCHAIN_RPC = new RetryMechanism({
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    jitter: true,
    retryCondition: (error) => {
      // Retry RPC-specific errors
      return error.code === -32005 || // Request rate exceeded
        error.code === -32603 || // Internal error
        error.message?.includes('timeout') ||
        error.message?.includes('connection');
    }
  });
}

// Decorator for automatic retry
export function withRetry(config?: Partial<RetryConfig>) {
  const retryMechanism = new RetryMechanism(config);

  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const result = await retryMechanism.execute(() => method.apply(this, args));

      if (result.success) {
        return result.result;
      } else {
        throw result.error;
      }
    };

    return descriptor;
  };
}

// Utility function for simple retry operations
export async function retry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T> {
  const retryMechanism = new RetryMechanism(config);
  const result = await retryMechanism.execute(fn);

  if (result.success) {
    return result.result!;
  } else {
    throw result.error;
  }
}

// Advanced retry with custom logic
export async function retryAdvanced<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delayFn?: (attempt: number) => number;
    shouldRetry?: (error: any, attempt: number) => boolean;
    onRetry?: (error: any, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayFn = (attempt) => Math.min(1000 * Math.pow(2, attempt - 1), 30000),
    shouldRetry = () => true,
    onRetry = () => { }
  } = options;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !shouldRetry(error, attempt)) {
        throw error;
      }

      onRetry(error, attempt);
      await new Promise(resolve => setTimeout(resolve, delayFn(attempt)));
    }
  }

  throw lastError;
}

// =============================================================================
// R7 Consolidation: Retry with Logging Utility
// =============================================================================

/**
 * Logger interface for retryWithLogging.
 * Compatible with ServiceLogger and console.
 * Uses Record<string, unknown> for meta to match LogMeta type.
 */
export interface RetryLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Configuration for retryWithLogging.
 */
export interface RetryWithLoggingConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 100) */
  initialDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
}

/**
 * Retry with exponential backoff and integrated logging.
 *
 * R7 Consolidation: This utility replaces duplicate publishWithRetry implementations
 * found in base-detector.ts and publishing-service.ts.
 *
 * Features:
 * - Exponential backoff (100ms, 200ms, 400ms by default)
 * - Logs warning on each retry attempt
 * - Logs error on final failure
 * - Does NOT throw - errors are logged and execution continues
 *
 * @param fn - The async function to retry
 * @param operationName - Human-readable name for logging (e.g., "whale alert")
 * @param logger - Logger instance with warn() and error() methods
 * @param config - Optional retry configuration
 *
 * @example
 * ```typescript
 * await retryWithLogging(
 *   () => this.publishWhaleAlert(alert),
 *   'whale alert',
 *   this.logger
 * );
 * ```
 */
export async function retryWithLogging(
  fn: () => Promise<void>,
  operationName: string,
  logger: RetryLogger,
  config: RetryWithLoggingConfig = {}
): Promise<void> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    backoffMultiplier = 2,
  } = config;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return; // Success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        // Exponential backoff: initialDelayMs * backoffMultiplier^(attempt-1)
        const backoffMs = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        logger.warn(`${operationName} publish failed, retrying in ${backoffMs}ms`, {
          attempt,
          maxRetries,
          error: lastError.message,
        });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  // All retries exhausted - log error with full context
  logger.error(`${operationName} publish failed after ${maxRetries} attempts`, {
    error: lastError,
    operationName,
  });
}