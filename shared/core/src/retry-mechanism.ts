// Exponential Backoff and Retry Mechanism
// Intelligent retry logic with jitter and circuit breaker integration

import { createLogger } from './logger';

const logger = createLogger('retry-mechanism');

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
    this.config = {
      maxAttempts: config.maxAttempts || 3,
      initialDelay: config.initialDelay || 1000,
      maxDelay: config.maxDelay || 30000,
      backoffMultiplier: config.backoffMultiplier || 2,
      jitter: config.jitter !== false,
      retryCondition: config.retryCondition || this.defaultRetryCondition,
      onRetry: config.onRetry || (() => { })
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

  private defaultRetryCondition(error: any): boolean {
    // Default retry conditions
    if (!error) return false;

    // Don't retry certain types of errors
    const nonRetryableErrors = [
      'CircuitBreakerError',
      'ValidationError',
      'AuthenticationError',
      'AuthorizationError',
      'NotFoundError'
    ];

    const errorName = error.name || error.constructor?.name || '';
    if (nonRetryableErrors.some(type => errorName.includes(type))) {
      return false;
    }

    // Don't retry 4xx HTTP errors (client errors)
    if (error.status && error.status >= 400 && error.status < 500) {
      return false;
    }

    // Retry network errors, timeouts, and 5xx errors
    return true;
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