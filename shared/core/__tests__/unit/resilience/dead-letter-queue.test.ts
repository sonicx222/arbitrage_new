/**
 * Dead Letter Queue Tests
 *
 * Tests for the Redis-key-based DeadLetterQueue used for operation retry
 * and recovery. Covers enqueue, processBatch, getStats, retryOperation,
 * and edge cases.
 *
 * @see shared/core/src/resilience/dead-letter-queue.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DeadLetterQueue, FailedOperation, DLQConfig } from '../../../src/resilience/dead-letter-queue';

// jest.mock factories are hoisted before all variable declarations.
// clearMocks: true in jest.config.js wipes jest.fn() implementations between tests,
// so factories use bare jest.fn() and implementations are set in beforeEach.

jest.mock('../../../src/redis/client', () => {
  // Uses shared factory from @arbitrage/test-utils for consistent Redis mock shape
  const { createInlineRedisMock } = require('@arbitrage/test-utils');
  const _mockRedis = createInlineRedisMock();
  return {
    getRedisClient: jest.fn(),
    resetRedisInstance: jest.fn(),
    _mockRedis,
  };
});

jest.mock('../../../src/redis/streams', () => ({
  getRedisStreamsClient: jest.fn(),
  resetRedisStreamsInstance: jest.fn(),
  RedisStreamsClient: {
    STREAMS: { DLQ_ALERTS: 'stream:dlq-alerts' },
  },
}));

jest.mock('../../../src/resilience/dual-publish', () => ({
  dualPublish: jest.fn(),
}));

// Retrieve mock modules for assertions and setup in tests
const redisMod = require('../../../src/redis/client') as any;
const mockRedis = redisMod._mockRedis;
const redisStreamsMod = require('../../../src/redis/streams') as any;
const dualPublishMod = require('../../../src/resilience/dual-publish') as any;

describe('DeadLetterQueue', () => {
  let dlq: DeadLetterQueue;
  const defaultConfig: Partial<DLQConfig> = {
    maxSize: 100,
    retentionPeriod: 3600000,
    retryEnabled: true,
    retryDelay: 100,
    alertThreshold: 50,
    batchSize: 5,
  };

  const createFailedOp = (overrides: Partial<Omit<FailedOperation, 'id' | 'timestamp'>> = {}): Omit<FailedOperation, 'id' | 'timestamp'> => ({
    operation: 'price_update',
    payload: { token: 'WETH', price: 1800 },
    error: { message: 'Connection refused', code: 'ECONNREFUSED' },
    retryCount: 0,
    maxRetries: 3,
    service: 'coordinator',
    priority: 'medium',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-establish mock implementations after clearMocks wipes them.
    // getRedisClient must return a promise resolving to mockRedis.
    redisMod.getRedisClient.mockReturnValue(Promise.resolve(mockRedis));
    redisMod.resetRedisInstance.mockResolvedValue(undefined);

    // Redis streams mock
    const mockStreamsClient = {
      xadd: jest.fn(() => Promise.resolve('1234567890-0')),
      disconnect: jest.fn(() => Promise.resolve(undefined)),
    };
    redisStreamsMod.getRedisStreamsClient.mockReturnValue(Promise.resolve(mockStreamsClient));
    redisStreamsMod.resetRedisStreamsInstance.mockReturnValue(Promise.resolve(undefined));

    // Dual-publish mock
    dualPublishMod.dualPublish.mockReturnValue(Promise.resolve(undefined));

    // Default Redis behaviors
    mockRedis.zcard.mockResolvedValue(0);
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.del.mockResolvedValue(1);
    mockRedis.zadd.mockResolvedValue(1);
    mockRedis.zrange.mockResolvedValue([]);
    mockRedis.zrem.mockResolvedValue(1);
    mockRedis.zscore.mockResolvedValue(null);
    mockRedis.scan.mockResolvedValue(['0', []]);
    mockRedis.publish.mockResolvedValue(1);

    dlq = new DeadLetterQueue(defaultConfig);
  });

  afterEach(() => {
    dlq.stopAutoProcessing();
    DeadLetterQueue.unregisterOperationHandler('price_update');
    DeadLetterQueue.unregisterOperationHandler('test_op');
  });

  describe('enqueue', () => {
    it('should enqueue a failed operation and return an id', async () => {
      const op = createFailedOp();
      const id = await dlq.enqueue(op);

      expect(id).toBeDefined();
      expect(id).toMatch(/^dlq_/);

      // Should store in Redis with TTL
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^dlq:dlq_/),
        expect.objectContaining({
          operation: 'price_update',
          service: 'coordinator',
          priority: 'medium',
        }),
        expect.any(Number)
      );

      // Should add to priority sorted set
      expect(mockRedis.zadd).toHaveBeenCalledWith(
        'dlq:priority:medium',
        expect.any(Number),
        expect.stringMatching(/^dlq_/)
      );

      // Should add to service sorted set
      expect(mockRedis.zadd).toHaveBeenCalledWith(
        'dlq:service:coordinator',
        expect.any(Number),
        expect.stringMatching(/^dlq_/)
      );
    });

    it('should add tags to tag indexes when provided', async () => {
      const op = createFailedOp({ tags: ['websocket', 'retry'] });
      await dlq.enqueue(op);

      expect(mockRedis.zadd).toHaveBeenCalledWith(
        'dlq:tag:websocket',
        expect.any(Number),
        expect.any(String)
      );
      expect(mockRedis.zadd).toHaveBeenCalledWith(
        'dlq:tag:retry',
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should evict old entries when queue is at max size', async () => {
      mockRedis.zcard.mockResolvedValue(100); // At max
      mockRedis.zrange.mockResolvedValue(['old_op_1', 'old_op_2']);
      mockRedis.scan.mockResolvedValue(['0', []]);

      await dlq.enqueue(createFailedOp());

      // Should have tried to evict (zrange on low priority first)
      expect(mockRedis.zrange).toHaveBeenCalledWith('dlq:priority:low', 0, expect.any(Number));
    });

    it('should truncate oversized payloads', async () => {
      // Create a payload larger than 1MB
      const largePayload = 'x'.repeat(1024 * 1024 + 100);
      const op = createFailedOp({ payload: largePayload });
      await dlq.enqueue(op);

      // The stored operation should have truncated payload
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          payload: expect.objectContaining({ _truncated: true }),
        }),
        expect.any(Number)
      );
    });

    it('should handle enqueue errors by throwing', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Redis unavailable'));

      await expect(dlq.enqueue(createFailedOp())).rejects.toThrow('Redis unavailable');
    });
  });

  describe('processBatch', () => {
    it('should process operations by priority order (critical first)', async () => {
      const criticalOp: FailedOperation = {
        id: 'op_critical',
        operation: 'test_op',
        payload: {},
        error: { message: 'fail' },
        timestamp: Date.now(),
        retryCount: 0,
        maxRetries: 3,
        service: 'coordinator',
        priority: 'critical',
      };

      // Return critical op id when asking for critical priority ops
      mockRedis.zrange
        .mockResolvedValueOnce(['op_critical']) // critical
        .mockResolvedValueOnce([])  // high
        .mockResolvedValueOnce([])  // medium
        .mockResolvedValueOnce([]); // low

      mockRedis.get.mockResolvedValue(criticalOp);

      // Register handler for test_op
      DeadLetterQueue.registerOperationHandler('test_op', async () => {
        // successful processing
      });

      const result = await dlq.processBatch();

      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
    });

    it('should return empty result when already processing', async () => {
      // Simulate isProcessing = true by starting a slow batch
      const slowPromise = new Promise<void>(resolve => {
        mockRedis.zrange.mockImplementationOnce(async () => {
          await new Promise(r => setTimeout(r, 100));
          resolve();
          return [];
        });
      });

      const batch1 = dlq.processBatch();
      const result2 = await dlq.processBatch(); // Should return early

      expect(result2).toEqual({ processed: 0, succeeded: 0, failed: 0, retryScheduled: 0 });

      await batch1;
      await slowPromise;
    });

    it('should fail operations with no registered handler', async () => {
      const op: FailedOperation = {
        id: 'op_no_handler',
        operation: 'unknown_operation',
        payload: {},
        error: { message: 'fail' },
        timestamp: Date.now(),
        retryCount: 0,
        maxRetries: 3,
        service: 'coordinator',
        priority: 'high',
      };

      mockRedis.zrange
        .mockResolvedValueOnce([])           // critical
        .mockResolvedValueOnce(['op_no_handler']) // high
        .mockResolvedValueOnce([])           // medium
        .mockResolvedValueOnce([]);          // low

      mockRedis.get.mockResolvedValue(op);

      const result = await dlq.processBatch();

      // No handler registered, so it fails (not retried)
      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return statistics with correct structure', async () => {
      mockRedis.zcard.mockResolvedValue(0);
      mockRedis.scan.mockResolvedValue(['0', []]);

      const stats = await dlq.getStats();

      expect(stats).toHaveProperty('totalOperations');
      expect(stats).toHaveProperty('byPriority');
      expect(stats).toHaveProperty('byService');
      expect(stats).toHaveProperty('byTag');
      expect(stats).toHaveProperty('oldestOperation');
      expect(stats).toHaveProperty('newestOperation');
      expect(stats).toHaveProperty('averageRetries');
    });

    it('should count operations by priority', async () => {
      // Mock zcard for each priority
      mockRedis.zcard
        .mockResolvedValueOnce(5)  // critical - for getQueueSize (total)
        .mockResolvedValueOnce(3)  // high
        .mockResolvedValueOnce(10) // medium
        .mockResolvedValueOnce(2)  // low
        .mockResolvedValueOnce(5)  // critical - for byPriority
        .mockResolvedValueOnce(3)  // high
        .mockResolvedValueOnce(10) // medium
        .mockResolvedValueOnce(2); // low

      mockRedis.scan.mockResolvedValue(['0', []]);
      mockRedis.zrange.mockResolvedValue([]);

      const stats = await dlq.getStats();

      expect(stats.totalOperations).toBe(20); // 5+3+10+2
      expect(stats.byPriority.critical).toBe(5);
      expect(stats.byPriority.high).toBe(3);
      expect(stats.byPriority.medium).toBe(10);
      expect(stats.byPriority.low).toBe(2);
    });

    it('should handle empty queue gracefully', async () => {
      mockRedis.zcard.mockResolvedValue(0);
      mockRedis.scan.mockResolvedValue(['0', []]);
      mockRedis.zrange.mockResolvedValue([]);

      const stats = await dlq.getStats();

      expect(stats.totalOperations).toBe(0);
      expect(stats.oldestOperation).toBe(0);
      expect(stats.newestOperation).toBe(0);
    });
  });

  describe('retryOperation', () => {
    it('should return false when operation is not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await dlq.retryOperation('non_existent');

      expect(result).toBe(false);
    });

    it('should succeed when handler processes successfully', async () => {
      const op: FailedOperation = {
        id: 'op_retry',
        operation: 'test_op',
        payload: { data: 'test' },
        error: { message: 'transient error' },
        timestamp: Date.now(),
        retryCount: 1,
        maxRetries: 5,
        service: 'execution-engine',
        priority: 'high',
      };

      mockRedis.get.mockResolvedValue(op);
      mockRedis.scan.mockResolvedValue(['0', ['dlq:priority:high']]);
      mockRedis.zscore.mockResolvedValue('12345');

      DeadLetterQueue.registerOperationHandler('test_op', async () => {
        // Successful processing
      });

      const result = await dlq.retryOperation('op_retry');

      expect(result).toBe(true);
      // Should remove operation on success
      expect(mockRedis.del).toHaveBeenCalledWith('dlq:op_retry');
    });

    it('should prevent duplicate concurrent retries', async () => {
      const op: FailedOperation = {
        id: 'op_dedup',
        operation: 'test_op',
        payload: {},
        error: { message: 'error' },
        timestamp: Date.now(),
        retryCount: 0,
        maxRetries: 3,
        service: 'coordinator',
        priority: 'medium',
      };

      let resolveHandler: () => void;
      const handlerPromise = new Promise<void>(resolve => {
        resolveHandler = resolve;
      });

      DeadLetterQueue.registerOperationHandler('test_op', async () => {
        await handlerPromise;
      });

      mockRedis.get.mockResolvedValue(op);
      mockRedis.scan.mockResolvedValue(['0', ['dlq:priority:medium']]);
      mockRedis.zscore.mockResolvedValue('12345');

      // Start first retry
      const retry1 = dlq.retryOperation('op_dedup');

      // Second retry should be rejected as duplicate
      const result2 = await dlq.retryOperation('op_dedup');
      expect(result2).toBe(false);

      // Complete the first retry
      resolveHandler!();
      await retry1;
    });
  });

  describe('cleanup', () => {
    it('should remove expired operations', async () => {
      const expiredOp: FailedOperation = {
        id: 'op_expired',
        operation: 'old_op',
        payload: {},
        error: { message: 'old error' },
        timestamp: Date.now() - 7200001, // Older than 1 hour (retentionPeriod)
        retryCount: 0,
        maxRetries: 3,
        service: 'coordinator',
        priority: 'low',
      };

      mockRedis.scan.mockResolvedValue(['0', ['dlq:op_expired']]);
      mockRedis.get.mockResolvedValue(expiredOp);
      mockRedis.zscore.mockResolvedValue(null);

      // Mock findOperationInIndexes scan
      // scanKeys is called multiple times: once for cleanup, then for findOperationInIndexes
      mockRedis.scan
        .mockResolvedValueOnce(['0', ['dlq:op_expired']])  // cleanup scan
        .mockResolvedValueOnce(['0', []])  // findOperationInIndexes: priority
        .mockResolvedValueOnce(['0', []])  // findOperationInIndexes: service
        .mockResolvedValueOnce(['0', []]); // findOperationInIndexes: tag

      const cleaned = await dlq.cleanup();

      expect(cleaned).toBe(1);
      expect(mockRedis.del).toHaveBeenCalledWith('dlq:op_expired');
    });
  });

  describe('auto processing', () => {
    it('should start and stop auto processing without errors', () => {
      dlq.startAutoProcessing(100);
      dlq.stopAutoProcessing();
      // Should not throw
    });
  });

  describe('operation handler registry', () => {
    it('should register and unregister handlers', () => {
      const handler = async () => {};
      DeadLetterQueue.registerOperationHandler('test_op', handler);
      DeadLetterQueue.unregisterOperationHandler('test_op');
      // Verify by trying to process - should fail without handler
    });
  });
});
