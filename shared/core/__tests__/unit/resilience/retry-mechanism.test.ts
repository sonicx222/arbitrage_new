/**
 * RetryMechanism Unit Tests
 *
 * Tests for exponential backoff and retry logic with jitter,
 * error classification, and preset configurations.
 *
 * @see shared/core/src/resilience/retry-mechanism.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
  ErrorCategory,
  classifyError,
  isRetryableError,
  RetryMechanism,
  RetryPresets,
  retry,
  retryWithLogging,
} from '../../../src/resilience/retry-mechanism';
import type { RetryLogger } from '../../../src/resilience/retry-mechanism';

// =============================================================================
// Mock the logger used internally by retry-mechanism
// =============================================================================

jest.mock('../../../src/logger');

// =============================================================================
// classifyError()
// =============================================================================

describe('classifyError', () => {
  it('should classify null/undefined errors as PERMANENT', () => {
    expect(classifyError(null)).toBe(ErrorCategory.PERMANENT);
    expect(classifyError(undefined)).toBe(ErrorCategory.PERMANENT);
    expect(classifyError(false)).toBe(ErrorCategory.PERMANENT);
    expect(classifyError(0)).toBe(ErrorCategory.PERMANENT);
  });

  describe('permanent error names', () => {
    const permanentNames = [
      'ValidationError',
      'AuthenticationError',
      'AuthorizationError',
      'NotFoundError',
      'InvalidInputError',
      'CircuitBreakerError',
      'InsufficientFundsError',
      'GasEstimationFailed',
    ];

    for (const name of permanentNames) {
      it(`should classify "${name}" as PERMANENT`, () => {
        const error = new Error('test');
        error.name = name;
        expect(classifyError(error)).toBe(ErrorCategory.PERMANENT);
      });
    }

    it('should NOT match partial error names (P1-10 exact matching)', () => {
      const error = new Error('test');
      error.name = 'MyValidationErrorHandler';
      // Should NOT be PERMANENT because it's not an exact match
      expect(classifyError(error)).not.toBe(ErrorCategory.PERMANENT);
    });
  });

  describe('permanent HTTP status codes (4xx except 429)', () => {
    it('should classify 400 as PERMANENT', () => {
      expect(classifyError({ status: 400, message: '' })).toBe(ErrorCategory.PERMANENT);
    });

    it('should classify 401 as PERMANENT', () => {
      expect(classifyError({ status: 401, message: '' })).toBe(ErrorCategory.PERMANENT);
    });

    it('should classify 403 as PERMANENT', () => {
      expect(classifyError({ status: 403, message: '' })).toBe(ErrorCategory.PERMANENT);
    });

    it('should classify 404 as PERMANENT', () => {
      expect(classifyError({ status: 404, message: '' })).toBe(ErrorCategory.PERMANENT);
    });

    it('should classify 422 as PERMANENT', () => {
      expect(classifyError({ statusCode: 422, message: '' })).toBe(ErrorCategory.PERMANENT);
    });

    it('should NOT classify 429 as PERMANENT (rate limit is transient)', () => {
      expect(classifyError({ status: 429, message: '' })).not.toBe(ErrorCategory.PERMANENT);
    });
  });

  describe('transient error codes', () => {
    const transientCodes = [
      'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
      'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    ];

    for (const code of transientCodes) {
      it(`should classify code "${code}" as TRANSIENT`, () => {
        expect(classifyError({ code, message: '' })).toBe(ErrorCategory.TRANSIENT);
      });
    }
  });

  describe('transient HTTP status codes', () => {
    const transientStatuses = [429, 500, 502, 503, 504];

    for (const status of transientStatuses) {
      it(`should classify HTTP ${status} as TRANSIENT`, () => {
        expect(classifyError({ status, message: '' })).toBe(ErrorCategory.TRANSIENT);
      });
    }
  });

  describe('transient error messages', () => {
    const transientMessages = [
      'Connection timeout occurred',
      'Network unreachable',
      'Please retry later',
      'Temporary failure',
      'Rate limit exceeded',
      'Too many requests',
      'Service unavailable',
    ];

    for (const message of transientMessages) {
      it(`should classify message "${message}" as TRANSIENT`, () => {
        expect(classifyError({ message })).toBe(ErrorCategory.TRANSIENT);
      });
    }
  });

  describe('RPC transient codes', () => {
    const rpcCodes = [-32700, -32600, -32000, -32005, -32603];

    for (const code of rpcCodes) {
      it(`should classify RPC code ${code} as TRANSIENT`, () => {
        expect(classifyError({ code, message: '' })).toBe(ErrorCategory.TRANSIENT);
      });
    }
  });

  it('should classify unknown errors as UNKNOWN', () => {
    expect(classifyError({ message: 'something weird happened' })).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(new Error('generic error'))).toBe(ErrorCategory.UNKNOWN);
  });
});

// =============================================================================
// isRetryableError()
// =============================================================================

describe('isRetryableError', () => {
  it('should return true for transient errors', () => {
    expect(isRetryableError({ code: 'ECONNRESET', message: '' })).toBe(true);
  });

  it('should return true for unknown errors (retry with caution)', () => {
    expect(isRetryableError(new Error('generic error'))).toBe(true);
  });

  it('should return false for permanent errors', () => {
    const error = new Error('bad input');
    error.name = 'ValidationError';
    expect(isRetryableError(error)).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(isRetryableError(null)).toBe(false);
  });
});

// =============================================================================
// RetryMechanism class
// =============================================================================

describe('RetryMechanism', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should succeed on first try without retries', async () => {
    const mechanism = new RetryMechanism({ maxAttempts: 3, jitter: false });
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');

    const resultPromise = mechanism.execute(fn);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(result.totalDelay).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient error then succeed', async () => {
    const mechanism = new RetryMechanism({
      maxAttempts: 3,
      initialDelay: 100,
      jitter: false,
    });

    const transientError = new Error('connection lost');
    transientError.name = 'Error';
    (transientError as any).code = 'ECONNRESET';

    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('recovered');

    const resultPromise = mechanism.execute(fn);

    // Advance past the delay for first retry
    await jest.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.result).toBe('recovered');
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should stop retrying on permanent error', async () => {
    const mechanism = new RetryMechanism({
      maxAttempts: 5,
      initialDelay: 100,
      jitter: false,
    });

    const permanentError = new Error('invalid input');
    permanentError.name = 'ValidationError';

    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(permanentError);

    const result = await mechanism.execute(fn);

    expect(result.success).toBe(false);
    expect(result.error).toBe(permanentError);
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should respect maxAttempts limit', async () => {
    const mechanism = new RetryMechanism({
      maxAttempts: 3,
      initialDelay: 50,
      jitter: false,
    });

    const transientError = new Error('timeout');
    (transientError as any).code = 'ETIMEDOUT';

    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(transientError);

    const resultPromise = mechanism.execute(fn);

    // Advance timers to allow all retries
    await jest.advanceTimersByTimeAsync(50);   // retry 1
    await jest.advanceTimersByTimeAsync(100);  // retry 2 (50 * 2^1)

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should calculate exponential backoff delays', async () => {
    const delays: number[] = [];
    const mechanism = new RetryMechanism({
      maxAttempts: 4,
      initialDelay: 100,
      backoffMultiplier: 2,
      jitter: false,
      onRetry: (_attempt, _error, delay) => {
        delays.push(delay);
      },
    });

    const transientError = new Error('timeout');
    (transientError as any).code = 'ETIMEDOUT';

    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(transientError);

    const resultPromise = mechanism.execute(fn);

    // Advance enough time for all retries
    await jest.advanceTimersByTimeAsync(100);  // attempt 1 delay
    await jest.advanceTimersByTimeAsync(200);  // attempt 2 delay
    await jest.advanceTimersByTimeAsync(400);  // attempt 3 delay

    await resultPromise;

    // Delays: 100 * 2^0 = 100, 100 * 2^1 = 200, 100 * 2^2 = 400
    expect(delays).toEqual([100, 200, 400]);
  });

  it('should cap delay at maxDelay', async () => {
    const delays: number[] = [];
    const mechanism = new RetryMechanism({
      maxAttempts: 5,
      initialDelay: 1000,
      maxDelay: 2000,
      backoffMultiplier: 3,
      jitter: false,
      onRetry: (_attempt, _error, delay) => {
        delays.push(delay);
      },
    });

    const transientError = new Error('timeout');
    (transientError as any).code = 'ETIMEDOUT';

    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(transientError);

    const resultPromise = mechanism.execute(fn);

    // Advance enough time for all retries
    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(3000);
    }

    await resultPromise;

    // 1000*3^0=1000, 1000*3^1=3000->capped to 2000, 1000*3^2=9000->capped to 2000, 1000*3^3=27000->capped to 2000
    expect(delays).toEqual([1000, 2000, 2000, 2000]);
  });

  it('should add jitter to delay when enabled', async () => {
    const delays: number[] = [];
    // Mock Math.random to return a known value
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    const mechanism = new RetryMechanism({
      maxAttempts: 2,
      initialDelay: 1000,
      jitter: true,
      onRetry: (_attempt, _error, delay) => {
        delays.push(delay);
      },
    });

    const transientError = new Error('timeout');
    (transientError as any).code = 'ETIMEDOUT';

    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(transientError);

    const resultPromise = mechanism.execute(fn);
    await jest.advanceTimersByTimeAsync(2000);
    await resultPromise;

    // With jitter: delay = 1000 + 1000 * 0.25 * 0.5 = 1000 + 125 = 1125
    expect(delays[0]).toBe(1125);

    randomSpy.mockRestore();
  });

  it('should invoke onRetry callback on each retry', async () => {
    const onRetry = jest.fn();
    const mechanism = new RetryMechanism({
      maxAttempts: 3,
      initialDelay: 50,
      jitter: false,
      onRetry,
    });

    const transientError = new Error('timeout');
    (transientError as any).code = 'ETIMEDOUT';

    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(transientError);

    const resultPromise = mechanism.execute(fn);
    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(100);
    await resultPromise;

    // onRetry called for attempts 1 and 2 (not the last attempt)
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, transientError, 50);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, transientError, 100);
  });

  it('should use custom retryCondition', async () => {
    const mechanism = new RetryMechanism({
      maxAttempts: 5,
      initialDelay: 50,
      jitter: false,
      retryCondition: (error) => error.message === 'retry-me',
    });

    const retryableError = new Error('retry-me');
    const nonRetryableError = new Error('stop-here');

    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(nonRetryableError);

    const resultPromise = mechanism.execute(fn);
    await jest.advanceTimersByTimeAsync(50);
    await resultPromise;

    const result = await mechanism.execute(
      jest.fn<() => Promise<string>>().mockRejectedValueOnce(nonRetryableError)
    );

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it('should use ?? for config defaults (preserving 0 values)', async () => {
    // maxAttempts: 0 should be preserved, not replaced with default 3
    const mechanism = new RetryMechanism({ maxAttempts: 1, jitter: false });
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('fail'));

    const result = await mechanism.execute(fn);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// RetryMechanism.executeWithTimeout()
// =============================================================================

describe('RetryMechanism.executeWithTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should succeed before timeout', async () => {
    const mechanism = new RetryMechanism({ maxAttempts: 1, jitter: false });
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('fast');

    const resultPromise = mechanism.executeWithTimeout(fn, 5000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.result).toBe('fast');
  });

  it('should fail when operation times out', async () => {
    const mechanism = new RetryMechanism({
      maxAttempts: 1,
      initialDelay: 100,
      jitter: false,
    });

    // Create a function that never resolves
    const fn = jest.fn<() => Promise<string>>().mockImplementation(
      () => new Promise(() => { /* never resolves */ })
    );

    const resultPromise = mechanism.executeWithTimeout(fn, 200);

    // Advance past timeout
    await jest.advanceTimersByTimeAsync(300);

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain('timed out after 200ms');
  });
});

// =============================================================================
// retry() utility function
// =============================================================================

describe('retry() utility function', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return result on success', async () => {
    const fn = jest.fn<() => Promise<number>>().mockResolvedValue(42);
    const result = await retry(fn, { maxAttempts: 3 });
    expect(result).toBe(42);
  });

  it('should throw on final failure', async () => {
    const error = new Error('persistent failure');
    error.name = 'ValidationError';
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(error);

    await expect(retry(fn, { maxAttempts: 1 })).rejects.toThrow('persistent failure');
  });

  it('should retry transient errors and succeed', async () => {
    const transientError = new Error('timeout');
    (transientError as any).code = 'ETIMEDOUT';

    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('recovered');

    const resultPromise = retry(fn, { maxAttempts: 3, initialDelay: 50, jitter: false });
    await jest.advanceTimersByTimeAsync(50);

    const result = await resultPromise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// retryWithLogging()
// =============================================================================

describe('retryWithLogging', () => {
  let mockLogger: RetryLogger;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should succeed on first try without logging', async () => {
    const fn = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await retryWithLogging(fn, 'test-op', mockLogger);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should log warn on retry then succeed', async () => {
    const fn = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);

    const promise = retryWithLogging(fn, 'whale alert', mockLogger, {
      maxRetries: 3,
      initialDelayMs: 100,
    });

    await jest.advanceTimersByTimeAsync(100);
    await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('whale alert publish failed'),
      expect.objectContaining({ attempt: 1, maxRetries: 3 })
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should log error on final failure', async () => {
    const fn = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('permanent'));

    const promise = retryWithLogging(fn, 'test-op', mockLogger, {
      maxRetries: 2,
      initialDelayMs: 50,
    });

    await jest.advanceTimersByTimeAsync(50);
    await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1); // only on intermediate retries
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('test-op publish failed after 2 attempts'),
      expect.objectContaining({ operationName: 'test-op' })
    );
  });

  it('should not throw on failure (errors are logged only)', async () => {
    const fn = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('boom'));

    const promise = retryWithLogging(fn, 'safe-op', mockLogger, {
      maxRetries: 1,
      initialDelayMs: 10,
    });

    await promise;

    // Should not throw - error is logged
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it('should apply exponential backoff', async () => {
    const fn = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('fail'));

    const promise = retryWithLogging(fn, 'backoff-test', mockLogger, {
      maxRetries: 3,
      initialDelayMs: 100,
      backoffMultiplier: 2,
    });

    // First retry: 100ms * 2^0 = 100ms
    await jest.advanceTimersByTimeAsync(100);
    // Second retry: 100ms * 2^1 = 200ms
    await jest.advanceTimersByTimeAsync(200);

    await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    // Check that warn messages include correct backoff values
    expect(mockLogger.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('retrying in 100ms'),
      expect.anything()
    );
    expect(mockLogger.warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('retrying in 200ms'),
      expect.anything()
    );
  });

  it('should convert non-Error objects to Error', async () => {
    const fn = jest.fn<() => Promise<void>>().mockRejectedValue('string error');

    const promise = retryWithLogging(fn, 'convert-test', mockLogger, {
      maxRetries: 1,
    });

    await promise;

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        error: expect.any(Error),
      })
    );
  });
});

// =============================================================================
// RetryPresets
// =============================================================================

describe('RetryPresets', () => {
  it('should have NETWORK_CALL preset', () => {
    expect(RetryPresets.NETWORK_CALL).toBeInstanceOf(RetryMechanism);
  });

  it('should have DATABASE_OPERATION preset', () => {
    expect(RetryPresets.DATABASE_OPERATION).toBeInstanceOf(RetryMechanism);
  });

  it('should have EXTERNAL_API preset', () => {
    expect(RetryPresets.EXTERNAL_API).toBeInstanceOf(RetryMechanism);
  });

  it('should have BLOCKCHAIN_RPC preset', () => {
    expect(RetryPresets.BLOCKCHAIN_RPC).toBeInstanceOf(RetryMechanism);
  });

  it('NETWORK_CALL should be usable (execute method exists)', () => {
    expect(typeof RetryPresets.NETWORK_CALL.execute).toBe('function');
    expect(typeof RetryPresets.NETWORK_CALL.executeWithTimeout).toBe('function');
  });
});
