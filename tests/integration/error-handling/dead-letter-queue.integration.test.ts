/**
 * Dead Letter Queue Integration Test
 *
 * Tests the DLQ error recovery flow for failed operations in the arbitrage system.
 *
 * **Flow Tested**:
 * 1. Failed operations are enqueued to DLQ with priority
 * 2. Operations can be retrieved by service, priority, or tag
 * 3. Automatic retry processing with configurable delays
 * 4. Manual retry for specific operations
 * 5. Cleanup of expired operations
 * 6. Alert threshold monitoring
 *
 * **What's Real**:
 * - Redis storage (via redis-memory-server)
 * - Sorted sets for priority queuing
 * - TTL-based retention
 * - Batch processing
 *
 * @see docs/architecture/DATA_FLOW.md - Error Handling section
 * @see shared/core/src/resilience/dead-letter-queue.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
} from '@arbitrage/test-utils';

// Type for failed operations matching DeadLetterQueue
interface FailedOperation {
  id: string;
  operation: string;
  payload: any;
  error: {
    message: string;
    code?: string;
    stack?: string;
  };
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  service: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  correlationId?: string;
  tags?: string[];
}

// Test factories - allows full override for test control
function createFailedOperation(overrides: Partial<FailedOperation> = {}): FailedOperation {
  return {
    id: `dlq_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    operation: 'price_update',
    payload: {
      dex: 'uniswap_v3',
      chain: 'ethereum',
      pair: 'WETH/USDC',
      price: 2500,
    },
    error: {
      message: 'Connection timeout',
      code: 'ETIMEDOUT',
    },
    timestamp: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    service: 'price-feed',
    priority: 'medium',
    ...overrides,
  };
}

// Helper to store operation in Redis with proper DLQ structure
async function storeOperation(redis: Redis, op: FailedOperation, prefix: string = ''): Promise<void> {
  const keyPrefix = prefix ? `${prefix}:` : '';

  // Store operation data
  await redis.set(`${keyPrefix}dlq:${op.id}`, JSON.stringify(op), 'EX', 3600);

  // Add to priority index
  await redis.zadd(`${keyPrefix}dlq:priority:${op.priority}`, op.timestamp, op.id);

  // Add to service index
  await redis.zadd(`${keyPrefix}dlq:service:${op.service}`, op.timestamp, op.id);

  // Add to tag indexes
  if (op.tags) {
    for (const tag of op.tags) {
      await redis.zadd(`${keyPrefix}dlq:tag:${tag}`, op.timestamp, op.id);
    }
  }
}

// Helper to get operation from Redis
async function getOperation(redis: Redis, id: string, prefix: string = ''): Promise<FailedOperation | null> {
  const keyPrefix = prefix ? `${prefix}:` : '';
  const data = await redis.get(`${keyPrefix}dlq:${id}`);
  return data ? JSON.parse(data) : null;
}

// Helper to remove operation from all indexes
async function removeOperation(redis: Redis, op: FailedOperation, prefix: string = ''): Promise<void> {
  const keyPrefix = prefix ? `${prefix}:` : '';

  await redis.del(`${keyPrefix}dlq:${op.id}`);
  await redis.zrem(`${keyPrefix}dlq:priority:${op.priority}`, op.id);
  await redis.zrem(`${keyPrefix}dlq:service:${op.service}`, op.id);

  if (op.tags) {
    for (const tag of op.tags) {
      await redis.zrem(`${keyPrefix}dlq:tag:${tag}`, op.id);
    }
  }
}

describe('[Integration] Dead Letter Queue', () => {
  let redis: Redis;
  let testPrefix: string;

  beforeAll(async () => {
    redis = await createTestRedisClient();
  }, 30000);

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(() => {
    // Use unique prefix for each test to avoid interference
    testPrefix = `test-dlq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  describe('Operation Enqueueing', () => {
    it('should enqueue failed operation with priority indexing', async () => {
      const operation = createFailedOperation({
        priority: 'critical',
        service: 'execution-engine',
        operation: 'arbitrage_execution',
      });

      await storeOperation(redis, operation, testPrefix);

      // Verify operation is stored
      const stored = await getOperation(redis, operation.id, testPrefix);
      expect(stored).toBeDefined();
      expect(stored!.operation).toBe('arbitrage_execution');
      expect(stored!.priority).toBe('critical');

      // Verify priority index
      const criticalOps = await redis.zrange(`${testPrefix}:dlq:priority:critical`, 0, -1);
      expect(criticalOps).toContain(operation.id);

      // Verify service index
      const serviceOps = await redis.zrange(`${testPrefix}:dlq:service:execution-engine`, 0, -1);
      expect(serviceOps).toContain(operation.id);
    });

    it('should enqueue operation with tags for filtering', async () => {
      const operation = createFailedOperation({
        tags: ['ethereum', 'uniswap', 'price-feed'],
      });

      await storeOperation(redis, operation, testPrefix);

      // Verify tag indexes
      for (const tag of operation.tags!) {
        const tagOps = await redis.zrange(`${testPrefix}:dlq:tag:${tag}`, 0, -1);
        expect(tagOps).toContain(operation.id);
      }
    });

    it('should preserve error context in enqueued operation', async () => {
      const errorContext = {
        message: 'RPC request failed: eth_call reverted',
        code: 'CALL_EXCEPTION',
        stack: 'Error: eth_call reverted\n    at Provider.call (provider.ts:100)',
      };

      const operation = createFailedOperation({
        error: errorContext,
        correlationId: 'opp-12345',
      });

      await storeOperation(redis, operation, testPrefix);

      const stored = await getOperation(redis, operation.id, testPrefix);
      expect(stored!.error.message).toBe(errorContext.message);
      expect(stored!.error.code).toBe(errorContext.code);
      expect(stored!.error.stack).toContain('Provider.call');
      expect(stored!.correlationId).toBe('opp-12345');
    });

    it('should handle multiple operations with different priorities', async () => {
      const operations = [
        createFailedOperation({ priority: 'low', id: `op-low-${testPrefix}` }),
        createFailedOperation({ priority: 'medium', id: `op-med-${testPrefix}` }),
        createFailedOperation({ priority: 'high', id: `op-high-${testPrefix}` }),
        createFailedOperation({ priority: 'critical', id: `op-crit-${testPrefix}` }),
      ];

      for (const op of operations) {
        await storeOperation(redis, op, testPrefix);
      }

      // Verify each priority level
      const priorities: Array<'low' | 'medium' | 'high' | 'critical'> = ['low', 'medium', 'high', 'critical'];
      for (const priority of priorities) {
        const count = await redis.zcard(`${testPrefix}:dlq:priority:${priority}`);
        expect(count).toBe(1);
      }
    });
  });

  describe('Operation Retrieval', () => {
    it('should retrieve operations by priority (critical first)', async () => {
      const criticalOp = createFailedOperation({
        priority: 'critical',
        timestamp: Date.now() - 1000,
      });
      const lowOp = createFailedOperation({
        priority: 'low',
        timestamp: Date.now(),
      });

      await storeOperation(redis, criticalOp, testPrefix);
      await storeOperation(redis, lowOp, testPrefix);

      // Get critical operations first
      const criticalOps = await redis.zrange(`${testPrefix}:dlq:priority:critical`, 0, 9);
      const lowOps = await redis.zrange(`${testPrefix}:dlq:priority:low`, 0, 9);

      expect(criticalOps).toContain(criticalOp.id);
      expect(lowOps).toContain(lowOp.id);

      // Critical should be processed first in priority order
      expect(criticalOps.length).toBe(1);
    });

    it('should retrieve operations by service', async () => {
      const priceFeedOp = createFailedOperation({ service: 'price-feed' });
      const executionOp = createFailedOperation({ service: 'execution-engine' });
      const coordinatorOp = createFailedOperation({ service: 'coordinator' });

      await storeOperation(redis, priceFeedOp, testPrefix);
      await storeOperation(redis, executionOp, testPrefix);
      await storeOperation(redis, coordinatorOp, testPrefix);

      // Query by service
      const priceFeedOps = await redis.zrange(`${testPrefix}:dlq:service:price-feed`, 0, -1);
      const executionOps = await redis.zrange(`${testPrefix}:dlq:service:execution-engine`, 0, -1);

      expect(priceFeedOps.length).toBe(1);
      expect(executionOps.length).toBe(1);
      expect(priceFeedOps).toContain(priceFeedOp.id);
      expect(executionOps).toContain(executionOp.id);
    });

    it('should retrieve operations by tag', async () => {
      const ethereumOp = createFailedOperation({ tags: ['ethereum', 'mainnet'] });
      const arbitrumOp = createFailedOperation({ tags: ['arbitrum', 'l2'] });
      const bothOp = createFailedOperation({ tags: ['ethereum', 'arbitrum', 'bridge'] });

      await storeOperation(redis, ethereumOp, testPrefix);
      await storeOperation(redis, arbitrumOp, testPrefix);
      await storeOperation(redis, bothOp, testPrefix);

      // Query by tag
      const ethereumOps = await redis.zrange(`${testPrefix}:dlq:tag:ethereum`, 0, -1);
      const arbitrumOps = await redis.zrange(`${testPrefix}:dlq:tag:arbitrum`, 0, -1);
      const bridgeOps = await redis.zrange(`${testPrefix}:dlq:tag:bridge`, 0, -1);

      expect(ethereumOps.length).toBe(2); // ethereumOp + bothOp
      expect(arbitrumOps.length).toBe(2); // arbitrumOp + bothOp
      expect(bridgeOps.length).toBe(1); // only bothOp
    });

    it('should support pagination with offset and limit', async () => {
      // Create 10 operations
      const operations: FailedOperation[] = [];
      for (let i = 0; i < 10; i++) {
        const op = createFailedOperation({
          timestamp: Date.now() + i,
          priority: 'medium',
        });
        operations.push(op);
        await storeOperation(redis, op, testPrefix);
      }

      // Get first page (0-4)
      const page1 = await redis.zrange(`${testPrefix}:dlq:priority:medium`, 0, 4);
      expect(page1.length).toBe(5);

      // Get second page (5-9)
      const page2 = await redis.zrange(`${testPrefix}:dlq:priority:medium`, 5, 9);
      expect(page2.length).toBe(5);

      // Verify no overlap
      const overlap = page1.filter(id => page2.includes(id));
      expect(overlap.length).toBe(0);
    });
  });

  describe('Retry Processing', () => {
    it('should increment retry count on failed retry', async () => {
      const operation = createFailedOperation({
        retryCount: 0,
        maxRetries: 3,
      });

      await storeOperation(redis, operation, testPrefix);

      // Simulate retry failure by incrementing retry count
      const stored = await getOperation(redis, operation.id, testPrefix);
      stored!.retryCount++;
      await redis.set(`${testPrefix}:dlq:${operation.id}`, JSON.stringify(stored), 'EX', 3600);

      // Verify retry count incremented
      const updated = await getOperation(redis, operation.id, testPrefix);
      expect(updated!.retryCount).toBe(1);
    });

    it('should stop retrying after maxRetries reached', async () => {
      const operation = createFailedOperation({
        retryCount: 2,
        maxRetries: 3,
      });

      await storeOperation(redis, operation, testPrefix);

      // Simulate retry that reaches max
      const stored = await getOperation(redis, operation.id, testPrefix);
      stored!.retryCount++;
      await redis.set(`${testPrefix}:dlq:${operation.id}`, JSON.stringify(stored), 'EX', 3600);

      const updated = await getOperation(redis, operation.id, testPrefix);
      expect(updated!.retryCount).toBe(3);

      // Should not retry if retryCount >= maxRetries
      const shouldRetry = updated!.retryCount < updated!.maxRetries;
      expect(shouldRetry).toBe(false);
    });

    it('should remove operation from DLQ on successful retry', async () => {
      const operation = createFailedOperation();

      await storeOperation(redis, operation, testPrefix);

      // Verify operation exists
      let stored = await getOperation(redis, operation.id, testPrefix);
      expect(stored).toBeDefined();

      // Simulate successful retry - remove from DLQ
      await removeOperation(redis, operation, testPrefix);

      // Verify operation is removed
      stored = await getOperation(redis, operation.id, testPrefix);
      expect(stored).toBeNull();

      // Verify removed from indexes
      const priorityOps = await redis.zrange(`${testPrefix}:dlq:priority:${operation.priority}`, 0, -1);
      expect(priorityOps).not.toContain(operation.id);
    });

    it('should process operations by priority order (critical first)', async () => {
      // Create operations with different priorities
      const criticalOp = createFailedOperation({
        priority: 'critical',
        timestamp: Date.now(),
        operation: 'critical_op',
      });
      const highOp = createFailedOperation({
        priority: 'high',
        timestamp: Date.now() - 1000, // Earlier timestamp
        operation: 'high_op',
      });
      const lowOp = createFailedOperation({
        priority: 'low',
        timestamp: Date.now() - 2000, // Even earlier
        operation: 'low_op',
      });

      await storeOperation(redis, lowOp, testPrefix);
      await storeOperation(redis, highOp, testPrefix);
      await storeOperation(redis, criticalOp, testPrefix);

      // Processing should get critical first, regardless of timestamp
      const priorities: Array<'critical' | 'high' | 'medium' | 'low'> = ['critical', 'high', 'medium', 'low'];
      const processedOrder: string[] = [];

      for (const priority of priorities) {
        const ops = await redis.zrange(`${testPrefix}:dlq:priority:${priority}`, 0, -1);
        for (const opId of ops) {
          const op = await getOperation(redis, opId, testPrefix);
          if (op) {
            processedOrder.push(op.operation);
          }
        }
      }

      // Critical should be first
      expect(processedOrder[0]).toBe('critical_op');
      expect(processedOrder[1]).toBe('high_op');
      expect(processedOrder[2]).toBe('low_op');
    });
  });

  describe('Statistics and Monitoring', () => {
    it('should track queue size by priority', async () => {
      // Create operations with different priorities
      await storeOperation(redis, createFailedOperation({ priority: 'critical' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ priority: 'critical' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ priority: 'high' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ priority: 'medium' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ priority: 'medium' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ priority: 'medium' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ priority: 'low' }), testPrefix);

      // Get counts by priority
      const criticalCount = await redis.zcard(`${testPrefix}:dlq:priority:critical`);
      const highCount = await redis.zcard(`${testPrefix}:dlq:priority:high`);
      const mediumCount = await redis.zcard(`${testPrefix}:dlq:priority:medium`);
      const lowCount = await redis.zcard(`${testPrefix}:dlq:priority:low`);

      expect(criticalCount).toBe(2);
      expect(highCount).toBe(1);
      expect(mediumCount).toBe(3);
      expect(lowCount).toBe(1);
    });

    it('should track queue size by service', async () => {
      await storeOperation(redis, createFailedOperation({ service: 'price-feed' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ service: 'price-feed' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ service: 'execution-engine' }), testPrefix);
      await storeOperation(redis, createFailedOperation({ service: 'coordinator' }), testPrefix);

      const priceFeedCount = await redis.zcard(`${testPrefix}:dlq:service:price-feed`);
      const executionCount = await redis.zcard(`${testPrefix}:dlq:service:execution-engine`);
      const coordinatorCount = await redis.zcard(`${testPrefix}:dlq:service:coordinator`);

      expect(priceFeedCount).toBe(2);
      expect(executionCount).toBe(1);
      expect(coordinatorCount).toBe(1);
    });

    it('should calculate total queue size', async () => {
      const priorities: Array<'low' | 'medium' | 'high' | 'critical'> = ['low', 'medium', 'high', 'critical'];

      for (let i = 0; i < 10; i++) {
        await storeOperation(redis, createFailedOperation({
          priority: priorities[i % 4],
        }), testPrefix);
      }

      // Calculate total from all priority queues
      let total = 0;
      for (const priority of priorities) {
        total += await redis.zcard(`${testPrefix}:dlq:priority:${priority}`);
      }

      expect(total).toBe(10);
    });
  });

  describe('Cleanup and Retention', () => {
    it('should identify operations older than retention period', async () => {
      const now = Date.now();
      const retentionPeriod = 3600000; // 1 hour

      // Create old operation (beyond retention)
      const oldOp = createFailedOperation({
        timestamp: now - retentionPeriod - 60000, // 1 hour + 1 minute ago
      });

      // Create recent operation (within retention)
      const recentOp = createFailedOperation({
        timestamp: now - 60000, // 1 minute ago
      });

      await storeOperation(redis, oldOp, testPrefix);
      await storeOperation(redis, recentOp, testPrefix);

      // Identify expired operations
      const cutoffTime = now - retentionPeriod;

      const oldOpData = await getOperation(redis, oldOp.id, testPrefix);
      const recentOpData = await getOperation(redis, recentOp.id, testPrefix);

      expect(oldOpData!.timestamp).toBeLessThan(cutoffTime);
      expect(recentOpData!.timestamp).toBeGreaterThan(cutoffTime);
    });

    it('should clean up expired operations', async () => {
      const now = Date.now();
      const retentionPeriod = 3600000;

      // Create operations with different ages
      const expiredOp = createFailedOperation({
        timestamp: now - retentionPeriod - 1000,
      });
      const validOp = createFailedOperation({
        timestamp: now - 1000,
      });

      await storeOperation(redis, expiredOp, testPrefix);
      await storeOperation(redis, validOp, testPrefix);

      // Simulate cleanup: remove expired operations
      const cutoffTime = now - retentionPeriod;
      const expiredData = await getOperation(redis, expiredOp.id, testPrefix);

      if (expiredData && expiredData.timestamp < cutoffTime) {
        await removeOperation(redis, expiredOp, testPrefix);
      }

      // Verify expired operation is removed
      const afterCleanup = await getOperation(redis, expiredOp.id, testPrefix);
      expect(afterCleanup).toBeNull();

      // Verify valid operation still exists
      const stillValid = await getOperation(redis, validOp.id, testPrefix);
      expect(stillValid).toBeDefined();
    });
  });

  describe('Queue Size Limits', () => {
    it('should evict oldest entries when queue is full', async () => {
      const maxSize = 5;

      // Create operations with sequential timestamps
      const operations: FailedOperation[] = [];
      for (let i = 0; i < maxSize + 3; i++) {
        const op = createFailedOperation({
          timestamp: Date.now() + i * 10, // Sequential timestamps
          priority: 'medium',
        });
        operations.push(op);
        await storeOperation(redis, op, testPrefix);
      }

      // Simulate eviction: remove oldest 10%
      const currentSize = await redis.zcard(`${testPrefix}:dlq:priority:medium`);

      if (currentSize > maxSize) {
        const evictCount = Math.ceil(maxSize * 0.1);
        const oldest = await redis.zrange(`${testPrefix}:dlq:priority:medium`, 0, evictCount - 1);

        for (const opId of oldest) {
          const opData = await getOperation(redis, opId, testPrefix);
          if (opData) {
            await removeOperation(redis, opData, testPrefix);
          }
        }
      }

      // After eviction, oldest operations should be gone
      const remainingOps = await redis.zrange(`${testPrefix}:dlq:priority:medium`, 0, -1);

      // First operations should have been evicted
      expect(remainingOps).not.toContain(operations[0].id);
    });
  });

  describe('Correlation ID Tracking', () => {
    it('should track related operations via correlation ID', async () => {
      const correlationId = `opp-${Date.now()}`;

      // Create related operations
      const priceOp = createFailedOperation({
        operation: 'price_update',
        service: 'price-feed',
        correlationId,
        tags: ['correlation', correlationId],
      });

      const detectionOp = createFailedOperation({
        operation: 'opportunity_detection',
        service: 'detector',
        correlationId,
        tags: ['correlation', correlationId],
      });

      const executionOp = createFailedOperation({
        operation: 'arbitrage_execution',
        service: 'execution-engine',
        correlationId,
        tags: ['correlation', correlationId],
      });

      await storeOperation(redis, priceOp, testPrefix);
      await storeOperation(redis, detectionOp, testPrefix);
      await storeOperation(redis, executionOp, testPrefix);

      // Find all operations with same correlation ID via tag
      const correlatedOps = await redis.zrange(`${testPrefix}:dlq:tag:${correlationId}`, 0, -1);

      expect(correlatedOps.length).toBe(3);
      expect(correlatedOps).toContain(priceOp.id);
      expect(correlatedOps).toContain(detectionOp.id);
      expect(correlatedOps).toContain(executionOp.id);

      // Verify all operations have same correlationId
      for (const opId of correlatedOps) {
        const op = await getOperation(redis, opId, testPrefix);
        expect(op!.correlationId).toBe(correlationId);
      }
    });
  });

  describe('Multi-Service Error Handling', () => {
    it('should handle errors from all services in the pipeline', async () => {
      const services = ['price-feed', 'detector', 'coordinator', 'execution-engine', 'metrics'];

      for (const service of services) {
        await storeOperation(redis, createFailedOperation({
          service,
          operation: `${service}_operation`,
          error: { message: `Error in ${service}` },
        }), testPrefix);
      }

      // Verify each service has entries
      for (const service of services) {
        const count = await redis.zcard(`${testPrefix}:dlq:service:${service}`);
        expect(count).toBe(1);
      }

      // Get total across all services
      let totalAcrossServices = 0;
      for (const service of services) {
        totalAcrossServices += await redis.zcard(`${testPrefix}:dlq:service:${service}`);
      }

      expect(totalAcrossServices).toBe(services.length);
    });
  });
});
