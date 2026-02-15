/**
 * Metrics Collector Unit Tests
 *
 * Tests for the MetricsCollector class that records, buffers, and persists
 * A/B testing execution metrics to Redis.
 *
 * Uses Constructor DI pattern: MetricsCollector(redis, config).
 * Redis is mocked, timers use jest.useFakeTimers().
 *
 * @see ab-testing/metrics-collector.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock @arbitrage/core to provide clearTimeoutSafe
jest.mock('@arbitrage/core', () => ({
  clearTimeoutSafe: jest.fn((timer: unknown) => {
    if (timer) clearTimeout(timer as NodeJS.Timeout);
    return null;
  }),
}));

import { MetricsCollector } from '../../ab-testing/metrics-collector';
import type { ABTestingConfig, ABTestExecutionResult } from '../../ab-testing/types';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// =============================================================================
// Test Helpers
// =============================================================================

function createMockRedis() {
  return {
    get: jest.fn(() => Promise.resolve(null)) as jest.Mock<() => Promise<unknown>>,
    set: jest.fn(() => Promise.resolve(undefined)) as jest.Mock<() => Promise<void>>,
    del: jest.fn(() => Promise.resolve(0)) as jest.Mock<() => Promise<number>>,
  };
}

function createMockConfig(overrides?: Partial<ABTestingConfig>): ABTestingConfig {
  return {
    enabled: true,
    defaultTrafficSplit: 0.1,
    defaultMinSampleSize: 100,
    significanceThreshold: 0.05,
    redisKeyPrefix: 'ab-test:',
    metricsTtlSeconds: 2592000,
    ...overrides,
  };
}

function createResult(overrides?: Partial<ABTestExecutionResult>): ABTestExecutionResult {
  return {
    result: {
      opportunityId: 'opp-1',
      success: true,
      actualProfit: 1000,
      gasCost: 200,
      timestamp: Date.now(),
      chain: 'bsc',
      dex: 'pancakeswap',
    },
    experimentId: 'exp-1',
    variant: 'control',
    timestamp: 1000,
    latencyMs: 50,
    mevFrontrunDetected: false,
    ...overrides,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('MetricsCollector', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let mockConfig: ABTestingConfig;
  let collector: MetricsCollector;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRedis = createMockRedis();
    mockConfig = createMockConfig();
    collector = new MetricsCollector(mockRedis as any, mockConfig);
  });

  afterEach(async () => {
    await collector.stop();
    jest.useRealTimers();
  });

  // ===========================================================================
  // recordResult
  // ===========================================================================

  describe('recordResult', () => {
    it('should record a successful execution and update counts', async () => {
      const result = createResult({ variant: 'control' });

      await collector.recordResult(result);
      await collector.flush();

      // Should have written to Redis
      expect(mockRedis.set).toHaveBeenCalledTimes(1);

      const savedData = (mockRedis.set as jest.Mock).mock.calls[0];
      const key = savedData[0] as string;
      const metrics = savedData[1] as any;
      const ttl = savedData[2] as number;

      expect(key).toBe('ab-test:metrics:exp-1:control');
      expect(metrics.successCount).toBe(1);
      expect(metrics.failureCount).toBe(0);
      expect(ttl).toBe(2592000);
    });

    it('should record a failed execution and increment failureCount', async () => {
      const result = createResult({
        result: {
          opportunityId: 'opp-1',
          success: false,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
          error: 'Slippage too high',
        },
        variant: 'variant',
      });

      await collector.recordResult(result);
      await collector.flush();

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.successCount).toBe(0);
      expect(metrics.failureCount).toBe(1);
    });

    it('should track profit as bigint string', async () => {
      const result = createResult({
        result: {
          opportunityId: 'opp-1',
          success: true,
          actualProfit: 5000000,
          gasCost: 100000,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
      });

      await collector.recordResult(result);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.totalProfitWei).toBe('5000000');
    });

    it('should track gas cost as bigint string', async () => {
      const result = createResult({
        result: {
          opportunityId: 'opp-1',
          success: true,
          actualProfit: 1000,
          gasCost: 250000,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
      });

      await collector.recordResult(result);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.totalGasCostWei).toBe('250000');
    });

    it('should accumulate latency across multiple calls', async () => {
      const result1 = createResult({ latencyMs: 50, timestamp: 1000 });
      const result2 = createResult({ latencyMs: 75, timestamp: 2000 });

      await collector.recordResult(result1);
      await collector.recordResult(result2);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.totalLatencyMs).toBe(125);
    });

    it('should increment mevFrontrunCount when frontrun detected', async () => {
      const result = createResult({ mevFrontrunDetected: true });

      await collector.recordResult(result);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.mevFrontrunCount).toBe(1);
    });

    it('should not increment mevFrontrunCount when frontrun not detected', async () => {
      const result = createResult({ mevFrontrunDetected: false });

      await collector.recordResult(result);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.mevFrontrunCount).toBe(0);
    });

    it('should set firstExecutionAt on first call and update lastExecutionAt on each', async () => {
      const result1 = createResult({ timestamp: 1000 });
      const result2 = createResult({ timestamp: 2000 });
      const result3 = createResult({ timestamp: 3000 });

      await collector.recordResult(result1);
      await collector.recordResult(result2);
      await collector.recordResult(result3);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.firstExecutionAt).toBe(1000);
      expect(metrics.lastExecutionAt).toBe(3000);
    });

    it('should accumulate profit from multiple successful executions', async () => {
      const result1 = createResult({
        result: {
          opportunityId: 'opp-1',
          success: true,
          actualProfit: 1000,
          gasCost: 100,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
        timestamp: 1000,
      });
      const result2 = createResult({
        result: {
          opportunityId: 'opp-2',
          success: true,
          actualProfit: 2000,
          gasCost: 300,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
        timestamp: 2000,
      });

      await collector.recordResult(result1);
      await collector.recordResult(result2);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.totalProfitWei).toBe('3000');
      expect(metrics.totalGasCostWei).toBe('400');
      expect(metrics.successCount).toBe(2);
    });

    it('should handle result with undefined actualProfit and gasCost', async () => {
      const result = createResult({
        result: {
          opportunityId: 'opp-1',
          success: true,
          // No actualProfit or gasCost
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
      });

      await collector.recordResult(result);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      expect(metrics.totalProfitWei).toBe('0');
      expect(metrics.totalGasCostWei).toBe('0');
    });

    it('should schedule a flush timer after recording', async () => {
      const result = createResult();

      await collector.recordResult(result);

      // Timer should be scheduled but not yet fired
      expect(mockRedis.set).not.toHaveBeenCalled();

      // Advance past the flush interval (5000ms)
      jest.advanceTimersByTime(5000);

      // Allow the flush promise to resolve
      // flush is called via setTimeout callback, need to allow microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
    });

    it('should load existing metrics from Redis on first record for a key', async () => {
      // Return existing metrics from Redis
      const existingMetrics = {
        experimentId: 'exp-1',
        variant: 'control',
        successCount: 10,
        failureCount: 5,
        totalProfitWei: '50000',
        totalGasCostWei: '10000',
        totalLatencyMs: 500,
        mevFrontrunCount: 1,
        firstExecutionAt: 500,
        lastExecutionAt: 900,
      };

      mockRedis.get = jest.fn(() => Promise.resolve(existingMetrics)) as jest.Mock<() => Promise<unknown>>;

      const result = createResult({ timestamp: 1000 });
      await collector.recordResult(result);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      // Should have accumulated on top of existing
      expect(metrics.successCount).toBe(11);
      expect(metrics.totalProfitWei).toBe('51000');
      expect(metrics.totalGasCostWei).toBe('10200');
      expect(metrics.totalLatencyMs).toBe(550);
      expect(metrics.firstExecutionAt).toBe(500); // Kept original
      expect(metrics.lastExecutionAt).toBe(1000); // Updated
    });
  });

  // ===========================================================================
  // getMetrics
  // ===========================================================================

  describe('getMetrics', () => {
    it('should return null when no metrics exist', async () => {
      const metrics = await collector.getMetrics('nonexistent', 'control');

      expect(metrics).toBeNull();
    });

    it('should flush buffer before loading and return computed metrics', async () => {
      // Record some results first
      await collector.recordResult(createResult({
        variant: 'control',
        timestamp: 1000,
        latencyMs: 100,
        result: {
          opportunityId: 'opp-1',
          success: true,
          actualProfit: 5000,
          gasCost: 1000,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
      }));
      await collector.recordResult(createResult({
        variant: 'control',
        timestamp: 2000,
        latencyMs: 200,
        result: {
          opportunityId: 'opp-2',
          success: false,
          gasCost: 500,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
      }));

      const computed = await collector.getMetrics('exp-1', 'control');

      expect(computed).not.toBeNull();
      // Flush should have been called, writing to Redis
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('should compute successRate, avgProfitWei, avgGasCostWei, avgLatencyMs correctly', async () => {
      // Record 3 successes and 1 failure
      for (let i = 0; i < 3; i++) {
        await collector.recordResult(createResult({
          variant: 'control',
          timestamp: 1000 + i * 1000,
          latencyMs: 100,
          result: {
            opportunityId: `opp-${i}`,
            success: true,
            actualProfit: 3000,
            gasCost: 600,
            timestamp: Date.now(),
            chain: 'bsc',
            dex: 'pancakeswap',
          },
        }));
      }
      await collector.recordResult(createResult({
        variant: 'control',
        timestamp: 4000,
        latencyMs: 200,
        result: {
          opportunityId: 'opp-fail',
          success: false,
          gasCost: 400,
          timestamp: Date.now(),
          chain: 'bsc',
          dex: 'pancakeswap',
        },
      }));

      const computed = await collector.getMetrics('exp-1', 'control');

      expect(computed).not.toBeNull();
      expect(computed!.sampleSize).toBe(4);
      expect(computed!.successRate).toBeCloseTo(0.75, 5); // 3/4
      // Total profit: 3 * 3000 = 9000, avg = 9000/4 = 2250
      expect(computed!.avgProfitWei).toBe('2250');
      // Total gas: 3 * 600 + 400 = 2200, avg = 2200/4 = 550
      expect(computed!.avgGasCostWei).toBe('550');
      // Total latency: 3 * 100 + 200 = 500, avg = 500/4 = 125
      expect(computed!.avgLatencyMs).toBe(125);
    });

    it('should compute mevFrontrunRate correctly', async () => {
      await collector.recordResult(createResult({
        variant: 'control',
        mevFrontrunDetected: true,
        timestamp: 1000,
      }));
      await collector.recordResult(createResult({
        variant: 'control',
        mevFrontrunDetected: false,
        timestamp: 2000,
      }));
      await collector.recordResult(createResult({
        variant: 'control',
        mevFrontrunDetected: true,
        timestamp: 3000,
      }));
      await collector.recordResult(createResult({
        variant: 'control',
        mevFrontrunDetected: false,
        timestamp: 4000,
      }));

      const computed = await collector.getMetrics('exp-1', 'control');

      expect(computed).not.toBeNull();
      expect(computed!.mevFrontrunRate).toBeCloseTo(0.5, 5); // 2/4
    });
  });

  // ===========================================================================
  // getExperimentMetrics
  // ===========================================================================

  describe('getExperimentMetrics', () => {
    it('should return both control and variant as null when no data', async () => {
      const result = await collector.getExperimentMetrics('nonexistent');

      expect(result.control).toBeNull();
      expect(result.variant).toBeNull();
    });

    it('should load metrics for both control and variant', async () => {
      // Record control results
      await collector.recordResult(createResult({
        variant: 'control',
        timestamp: 1000,
      }));
      // Record variant results
      await collector.recordResult(createResult({
        variant: 'variant',
        timestamp: 2000,
      }));

      const result = await collector.getExperimentMetrics('exp-1');

      expect(result.control).not.toBeNull();
      expect(result.variant).not.toBeNull();
      expect(result.control!.variant).toBe('control');
      expect(result.variant!.variant).toBe('variant');
    });

    it('should return null for variant with no data', async () => {
      await collector.recordResult(createResult({ variant: 'control' }));

      const result = await collector.getExperimentMetrics('exp-1');

      expect(result.control).not.toBeNull();
      expect(result.variant).toBeNull();
    });
  });

  // ===========================================================================
  // resetMetrics
  // ===========================================================================

  describe('resetMetrics', () => {
    it('should clear buffer and call redis.del for both keys', async () => {
      // Record some data to populate buffer
      await collector.recordResult(createResult({ variant: 'control' }));
      await collector.recordResult(createResult({ variant: 'variant' }));

      await collector.resetMetrics('exp-1');

      // Should have deleted both control and variant keys from Redis
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenCalledWith('ab-test:metrics:exp-1:control');
      expect(mockRedis.del).toHaveBeenCalledWith('ab-test:metrics:exp-1:variant');

      // After reset, getMetrics should return null
      // (buffer was cleared, Redis returns null)
      const metrics = await collector.getMetrics('exp-1', 'control');
      expect(metrics).toBeNull();
    });

    it('should work even when no data exists for the experiment', async () => {
      await collector.resetMetrics('nonexistent');

      expect(mockRedis.del).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenCalledWith('ab-test:metrics:nonexistent:control');
      expect(mockRedis.del).toHaveBeenCalledWith('ab-test:metrics:nonexistent:variant');
    });
  });

  // ===========================================================================
  // flush
  // ===========================================================================

  describe('flush', () => {
    it('should write all buffered metrics to Redis with TTL', async () => {
      // Record data for two different keys
      await collector.recordResult(createResult({ variant: 'control', experimentId: 'exp-1' }));
      await collector.recordResult(createResult({ variant: 'variant', experimentId: 'exp-1' }));

      await collector.flush();

      expect(mockRedis.set).toHaveBeenCalledTimes(2);

      // Verify TTL was passed
      const call1 = (mockRedis.set as jest.Mock).mock.calls[0];
      const call2 = (mockRedis.set as jest.Mock).mock.calls[1];
      expect(call1[2]).toBe(2592000);
      expect(call2[2]).toBe(2592000);
    });

    it('should be a no-op when buffer is empty', async () => {
      await collector.flush();

      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should handle Redis write errors gracefully', async () => {
      mockRedis.set = jest.fn(() => Promise.reject(new Error('Redis down'))) as jest.Mock<() => Promise<void>>;

      await collector.recordResult(createResult());

      // Should not throw -- saveMetrics catches the error internally
      await expect(collector.flush()).resolves.not.toThrow();

      // Restore mock for afterEach cleanup
      mockRedis.set = jest.fn(() => Promise.resolve(undefined)) as jest.Mock<() => Promise<void>>;
    });
  });

  // ===========================================================================
  // stop
  // ===========================================================================

  describe('stop', () => {
    it('should clear timer and flush pending data', async () => {
      await collector.recordResult(createResult());

      // Timer should be scheduled
      await collector.stop();

      // Flush should have been called -- data written to Redis
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
    });

    it('should be safe to call stop multiple times', async () => {
      await collector.recordResult(createResult());

      await collector.stop();
      await collector.stop();

      // flush() does not clear the buffer, so both stop calls write.
      // The important thing is it does not throw.
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // Key generation
  // ===========================================================================

  describe('key generation', () => {
    it('should use the configured redisKeyPrefix', async () => {
      const customCollector = new MetricsCollector(
        mockRedis as any,
        createMockConfig({ redisKeyPrefix: 'custom-prefix:' }),
      );

      await customCollector.recordResult(createResult({
        experimentId: 'my-exp',
        variant: 'variant',
      }));
      await customCollector.flush();

      const key = (mockRedis.set as jest.Mock).mock.calls[0][0] as string;
      expect(key).toBe('custom-prefix:metrics:my-exp:variant');

      await customCollector.stop();
    });

    it('should separate control and variant into different keys', async () => {
      await collector.recordResult(createResult({ variant: 'control' }));
      await collector.recordResult(createResult({ variant: 'variant' }));
      await collector.flush();

      const keys = (mockRedis.set as jest.Mock).mock.calls.map(
        (call: any) => call[0] as string
      );
      expect(keys).toContain('ab-test:metrics:exp-1:control');
      expect(keys).toContain('ab-test:metrics:exp-1:variant');
    });
  });

  // ===========================================================================
  // Concurrent recording (race condition fix)
  // ===========================================================================

  describe('concurrent recording', () => {
    it('should serialize concurrent updates to the same key', async () => {
      // Fire off multiple concurrent recordResult calls
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          collector.recordResult(createResult({
            variant: 'control',
            timestamp: 1000 + i * 100,
            latencyMs: 10,
          }))
        );
      }

      await Promise.all(promises);
      await collector.flush();

      const metrics = (mockRedis.set as jest.Mock).mock.calls[0][1] as any;
      // All 5 results should be recorded
      expect(metrics.successCount).toBe(5);
      expect(metrics.totalLatencyMs).toBe(50);
    });
  });
});
