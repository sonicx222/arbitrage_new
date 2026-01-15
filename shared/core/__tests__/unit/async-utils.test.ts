/**
 * Async Utilities Unit Tests
 *
 * Tests for the shared async utilities (REF-4/ARCH-3).
 *
 * @migrated from shared/core/src/async-utils.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import from package alias (new pattern per ADR-009)
import {
  TimeoutError,
  withTimeout,
  withTimeoutDefault,
  withTimeoutSafe,
  withRetryAsync,
  sleep,
  createDeferred,
  mapConcurrent,
  mapSequential,
  debounceAsync,
  throttleAsync,
  gracefulShutdown,
  waitWithTimeouts
} from '@arbitrage/core';

// =============================================================================
// Timeout Utilities Tests
// =============================================================================

describe('Timeout Utilities', () => {
  describe('withTimeout()', () => {
    it('should resolve when promise completes before timeout', async () => {
      const result = await withTimeout(Promise.resolve('success'), 1000);
      expect(result).toBe('success');
    });

    it('should throw TimeoutError when promise exceeds timeout', async () => {
      const slowPromise = new Promise(resolve => setTimeout(() => resolve('late'), 200));

      await expect(withTimeout(slowPromise, 50)).rejects.toThrow(TimeoutError);
    });

    it('should include operation name in error message', async () => {
      const slowPromise = new Promise(resolve => setTimeout(() => resolve('late'), 200));

      try {
        await withTimeout(slowPromise, 50, 'testOperation');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TimeoutError);
        expect((error as TimeoutError).message).toContain('testOperation');
        expect((error as TimeoutError).timeoutMs).toBe(50);
        expect((error as TimeoutError).operation).toBe('testOperation');
      }
    });

    it('should propagate promise rejection', async () => {
      const failingPromise = Promise.reject(new Error('Original error'));

      await expect(withTimeout(failingPromise, 1000)).rejects.toThrow('Original error');
    });

    it('should clear timeout on success', async () => {
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      await withTimeout(Promise.resolve('done'), 1000);

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('withTimeoutDefault()', () => {
    it('should return result when promise completes', async () => {
      const result = await withTimeoutDefault(Promise.resolve('success'), 1000, 'default');
      expect(result).toBe('success');
    });

    it('should return default value on timeout', async () => {
      const slowPromise = new Promise(resolve => setTimeout(() => resolve('late'), 200));

      const result = await withTimeoutDefault(slowPromise, 50, 'default');
      expect(result).toBe('default');
    });

    it('should call onTimeout callback', async () => {
      const onTimeout = jest.fn();
      const slowPromise = new Promise(resolve => setTimeout(() => resolve('late'), 200));

      await withTimeoutDefault(slowPromise, 50, 'default', onTimeout);

      expect(onTimeout).toHaveBeenCalled();
    });

    it('should propagate non-timeout errors', async () => {
      const failingPromise = Promise.reject(new Error('Original error'));

      await expect(withTimeoutDefault(failingPromise, 1000, 'default')).rejects.toThrow('Original error');
    });
  });

  describe('withTimeoutSafe()', () => {
    it('should complete without throwing', async () => {
      await expect(withTimeoutSafe(async () => {}, 1000)).resolves.toBeUndefined();
    });

    it('should not throw on timeout', async () => {
      await expect(withTimeoutSafe(
        async () => {
          await sleep(200);
        },
        50
      )).resolves.toBeUndefined();
    });

    it('should not throw on error', async () => {
      await expect(withTimeoutSafe(
        async () => {
          throw new Error('Test error');
        },
        1000
      )).resolves.toBeUndefined();
    });

    it('should call onError callback', async () => {
      const onError = jest.fn();

      await withTimeoutSafe(
        async () => {
          throw new Error('Test error');
        },
        1000,
        onError
      );

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});

// =============================================================================
// Retry Utilities Tests
// =============================================================================

describe('Retry Utilities', () => {
  describe('withRetryAsync()', () => {
    it('should return result on first success', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('success');

      const result = await withRetryAsync(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      const fn = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const result = await withRetryAsync(fn, {
        maxAttempts: 3,
        baseDelayMs: 10
      });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max attempts', async () => {
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('Always fails'));

      await expect(withRetryAsync(fn, {
        maxAttempts: 3,
        baseDelayMs: 10
      })).rejects.toThrow('Always fails');

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should respect isRetryable function', async () => {
      const nonRetryableError = new Error('Not retryable');
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(nonRetryableError);

      await expect(withRetryAsync(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        isRetryable: () => false
      })).rejects.toThrow('Not retryable');

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should call onRetry callback', async () => {
      const onRetry = jest.fn();
      const fn = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValue('success');

      await withRetryAsync(fn, {
        maxAttempts: 2,
        baseDelayMs: 10,
        onRetry
      });

      expect(onRetry).toHaveBeenCalledWith(
        expect.any(Error),
        1,
        expect.any(Number)
      );
    });

    it('should use exponential backoff', async () => {
      const delays: number[] = [];
      const fn = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValue('success');

      await withRetryAsync(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        exponential: true,
        jitterFactor: 0,
        onRetry: (_, __, delay) => delays.push(delay)
      });

      expect(delays[0]).toBe(100);  // 100 * 2^0
      expect(delays[1]).toBe(200);  // 100 * 2^1
    });
  });
});

// =============================================================================
// Delay Utilities Tests
// =============================================================================

describe('Delay Utilities', () => {
  describe('sleep()', () => {
    it('should delay for specified duration', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow 10ms tolerance
    });
  });

  describe('createDeferred()', () => {
    it('should create deferred promise', () => {
      const deferred = createDeferred<string>();

      expect(deferred.promise).toBeInstanceOf(Promise);
      expect(typeof deferred.resolve).toBe('function');
      expect(typeof deferred.reject).toBe('function');
    });

    it('should resolve deferred promise', async () => {
      const deferred = createDeferred<string>();

      setTimeout(() => deferred.resolve('resolved'), 10);

      await expect(deferred.promise).resolves.toBe('resolved');
    });

    it('should reject deferred promise', async () => {
      const deferred = createDeferred<string>();

      setTimeout(() => deferred.reject(new Error('rejected')), 10);

      await expect(deferred.promise).rejects.toThrow('rejected');
    });
  });
});

// =============================================================================
// Concurrency Utilities Tests
// =============================================================================

describe('Concurrency Utilities', () => {
  describe('mapConcurrent()', () => {
    it('should process all items', async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await mapConcurrent(items, async (n) => n * 2, 2);

      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should respect concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const items = [1, 2, 3, 4, 5];
      await mapConcurrent(items, async (n) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(50);
        concurrent--;
        return n;
      }, 2);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should preserve order', async () => {
      const items = [100, 50, 150, 25];
      const results = await mapConcurrent(items, async (n, i) => {
        await sleep(n);
        return i;
      }, 4);

      expect(results).toEqual([0, 1, 2, 3]);
    });
  });

  describe('mapSequential()', () => {
    it('should process items in order', async () => {
      const order: number[] = [];
      const items = [1, 2, 3];

      await mapSequential(items, async (n) => {
        order.push(n);
        await sleep(10);
        return n;
      });

      expect(order).toEqual([1, 2, 3]);
    });

    it('should add delay between items', async () => {
      const start = Date.now();
      const items = [1, 2, 3];

      await mapSequential(items, async (n) => n, 50);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90); // 2 delays of 50ms
    });
  });
});

// =============================================================================
// Debounce & Throttle Tests
// =============================================================================

describe('Debounce & Throttle', () => {
  describe('debounceAsync()', () => {
    it('should debounce rapid calls', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      const debounced = debounceAsync(fn, 50);

      debounced();
      debounced();
      debounced();

      await sleep(100);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should pass arguments to debounced function', async () => {
      const fn = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('result');
      const debounced = debounceAsync(fn, 50);

      debounced('arg1', 'arg2');

      await sleep(100);

      expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
    });
  });

  describe('throttleAsync()', () => {
    it('should throttle rapid calls', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      const throttled = throttleAsync(fn, 100);

      await throttled();
      await throttled();
      await throttled();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should allow calls after interval', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('result');
      const throttled = throttleAsync(fn, 50);

      await throttled();
      await sleep(60);
      await throttled();

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});

// =============================================================================
// Shutdown Utilities Tests
// =============================================================================

describe('Shutdown Utilities', () => {
  describe('gracefulShutdown()', () => {
    it('should cleanup all resources', async () => {
      const cleanup1 = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const cleanup2 = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

      await gracefulShutdown([
        { name: 'resource1', cleanup: cleanup1 },
        { name: 'resource2', cleanup: cleanup2 }
      ], 1000);

      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
    });

    it('should continue on timeout', async () => {
      const cleanup1 = jest.fn<() => Promise<void>>().mockImplementation(() => new Promise(r => setTimeout(r, 200)));
      const cleanup2 = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const logger = { warn: jest.fn() };

      await gracefulShutdown([
        { name: 'slow', cleanup: cleanup1 },
        { name: 'fast', cleanup: cleanup2 }
      ], 50, logger);

      expect(cleanup2).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should continue on error', async () => {
      const cleanup1 = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Cleanup failed'));
      const cleanup2 = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const logger = { warn: jest.fn() };

      await gracefulShutdown([
        { name: 'failing', cleanup: cleanup1 },
        { name: 'working', cleanup: cleanup2 }
      ], 1000, logger);

      expect(cleanup2).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('waitWithTimeouts()', () => {
    it('should collect results', async () => {
      const results = await waitWithTimeouts([
        { name: 'fast', promise: Promise.resolve('result1') },
        { name: 'also-fast', promise: Promise.resolve('result2') }
      ], 1000);

      expect(results.get('fast')).toEqual({ success: true, result: 'result1' });
      expect(results.get('also-fast')).toEqual({ success: true, result: 'result2' });
    });

    it('should handle timeout', async () => {
      const results = await waitWithTimeouts([
        { name: 'slow', promise: new Promise(r => setTimeout(r, 200)) },
        { name: 'fast', promise: Promise.resolve('result') }
      ], 50);

      expect(results.get('slow')?.success).toBe(false);
      expect(results.get('slow')?.error).toBeInstanceOf(TimeoutError);
      expect(results.get('fast')?.success).toBe(true);
    });

    it('should handle rejection', async () => {
      const results = await waitWithTimeouts([
        { name: 'failing', promise: Promise.reject(new Error('Failed')) },
        { name: 'success', promise: Promise.resolve('result') }
      ], 1000);

      expect(results.get('failing')?.success).toBe(false);
      expect(results.get('failing')?.error?.message).toBe('Failed');
      expect(results.get('success')?.success).toBe(true);
    });
  });
});
