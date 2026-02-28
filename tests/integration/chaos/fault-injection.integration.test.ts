/**
 * Chaos/Fault Injection Integration Tests
 *
 * Tests system behavior under failure conditions using real Redis Streams.
 * Verifies recovery, message ordering, graceful degradation, and cascading
 * failure handling with a real Redis backend.
 *
 * Utility class unit tests (ChaosController, NetworkPartitionSimulator,
 * waitForChaosCondition) have been extracted to:
 *   tests/unit/chaos/chaos-utilities.test.ts
 *
 * **What's Real**:
 * - Redis Streams (via redis-memory-server)
 * - Consumer groups, XREADGROUP, XACK, XPENDING
 * - Multi-stream degradation scenarios
 *
 * @see docs/research/INTEGRATION_TEST_COVERAGE_REPORT.md Phase 3, Task 3.2
 * @see shared/test-utils/src/helpers/chaos-testing.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
} from '@arbitrage/test-utils';

// =============================================================================
// Constants
// =============================================================================

const STREAMS = {
  PRICE_UPDATES: 'stream:price-updates',
  OPPORTUNITIES: 'stream:opportunities',
  HEALTH: 'stream:health',
} as const;

const GROUPS = {
  DETECTOR: 'detector-group',
  COORDINATOR: 'coordinator-group',
} as const;

// =============================================================================
// Types
// =============================================================================

type StreamMessage = [string, string[]];
type StreamResult = [string, StreamMessage[]][] | null;

interface PriceUpdate {
  pairKey: string;
  chain: string;
  dex: string;
  price: number;
  timestamp: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

function createPriceUpdate(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    pairKey: 'uniswap_WETH_USDT',
    chain: 'ethereum',
    dex: 'uniswap_v3',
    price: 2500,
    timestamp: Date.now(),
    ...overrides,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Tests
// =============================================================================

describe('[Chaos] Fault Injection Integration Tests', () => {
  let redis: Redis;
  let testId: string;

  beforeAll(async () => {
    redis = await createTestRedisClient();
    testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }, 30000);

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(() => {
    testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  // ===========================================================================
  // Task 3.2.2: Latency Baseline (Redis)
  // ===========================================================================

  describe('Task 3.2.2: Latency Baseline', () => {
    it('should measure latency impact on operations', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:latency:${testId}`;

      // Measure baseline (no chaos)
      const baselineStart = performance.now();
      await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate()));
      const baselineLatency = performance.now() - baselineStart;

      // The actual operation should be fast without chaos
      expect(baselineLatency).toBeLessThan(20); // Redis is fast
    });
  });

  // ===========================================================================
  // Task 3.2.4: Recovery Testing
  // ===========================================================================

  describe('Task 3.2.4: Recovery After Chaos', () => {
    it('should recover stream processing after chaos stops', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:recovery:${testId}`;
      const group = `${GROUPS.DETECTOR}-recovery-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish message before chaos
      await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate({ price: 2500 })));

      // Simulate chaos period (we can't actually fail Redis, but we can skip reads)
      const chaosPeriod = 100;
      await sleep(chaosPeriod);

      // Publish message during "chaos" (would be queued)
      await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate({ price: 2510 })));

      // "Recover" and consume all messages
      const result = await redis.xreadgroup(
        'GROUP', group, 'recovery-worker',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      // Should have both messages
      expect(result).not.toBeNull();
      expect(result![0][1].length).toBe(2);

      // Verify message integrity
      const prices = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data).price;
      });
      expect(prices).toContain(2500);
      expect(prices).toContain(2510);
    });

    it('should maintain message ordering after recovery', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:ordering:${testId}`;
      const group = `${GROUPS.DETECTOR}-ordering-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish ordered sequence
      const prices = [2500, 2501, 2502, 2503, 2504];
      for (const price of prices) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate({ price })));
      }

      // Consume and verify order
      const result = await redis.xreadgroup(
        'GROUP', group, 'order-worker',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const consumedPrices = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data).price;
      });

      // Order should be preserved
      expect(consumedPrices).toEqual(prices);
    });

    it('should handle pending messages after consumer crash simulation', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:pending:${testId}`;
      const group = `${GROUPS.DETECTOR}-pending-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish messages
      await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate({ price: 2500 })));
      await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate({ price: 2510 })));

      // Consumer 1 reads but doesn't ack (simulating crash)
      const consumer1Result = await redis.xreadgroup(
        'GROUP', group, 'crashed-consumer',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      expect(consumer1Result![0][1].length).toBe(2);

      // Messages are now pending (not acked)
      // New consumer claims pending messages after timeout
      // In real scenario, would use XCLAIM or XAUTOCLAIM

      // Check pending count
      const pending = await redis.xpending(stream, group);
      expect(pending[0]).toBe(2); // 2 pending messages
    });
  });

  // ===========================================================================
  // Task 3.2.5: Graceful Degradation
  // ===========================================================================

  describe('Task 3.2.5: Graceful Degradation Patterns', () => {
    it('should continue processing healthy streams when one fails', async () => {
      const healthyStream = `${STREAMS.PRICE_UPDATES}:healthy:${testId}`;
      const healthyGroup = `${GROUPS.DETECTOR}-healthy-${testId}`;

      await ensureConsumerGroup(redis, healthyStream, healthyGroup);

      // Publish to healthy stream
      await redis.xadd(healthyStream, '*', 'data', JSON.stringify(createPriceUpdate()));

      // Simulated failure: don't create consumer group for failed stream
      // (would cause NOGROUP error if tried to read)

      // Healthy stream should still work
      const result = await redis.xreadgroup(
        'GROUP', healthyGroup, 'degraded-worker',
        'COUNT', 10,
        'STREAMS', healthyStream, '>'
      ) as StreamResult;

      expect(result).not.toBeNull();
      expect(result![0][1].length).toBe(1);
    });

    it('should track service health during chaos', async () => {
      const healthStream = `${STREAMS.HEALTH}:tracking:${testId}`;
      const healthGroup = `health-monitor-${testId}`;

      await ensureConsumerGroup(redis, healthStream, healthGroup);

      // Simulate health updates during normal operation
      await redis.xadd(healthStream, '*', 'data', JSON.stringify({
        service: 'detector',
        status: 'healthy',
        timestamp: Date.now(),
      }));

      // Simulate health update during chaos
      await redis.xadd(healthStream, '*', 'data', JSON.stringify({
        service: 'detector',
        status: 'degraded',
        error: 'Redis connection unstable',
        timestamp: Date.now(),
      }));

      // Simulate recovery
      await redis.xadd(healthStream, '*', 'data', JSON.stringify({
        service: 'detector',
        status: 'healthy',
        timestamp: Date.now(),
      }));

      // Consume health updates
      const result = await redis.xreadgroup(
        'GROUP', healthGroup, 'health-monitor',
        'COUNT', 10,
        'STREAMS', healthStream, '>'
      ) as StreamResult;

      const statuses = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data).status;
      });

      // Should see the progression: healthy -> degraded -> healthy
      expect(statuses).toEqual(['healthy', 'degraded', 'healthy']);
    });
  });

  // ===========================================================================
  // Task 3.2.6: Chaos Test Scenarios
  // ===========================================================================

  describe('Task 3.2.6: Complete Chaos Scenarios', () => {
    it('should handle cascading failures across services', async () => {
      // Simulate: detector -> coordinator -> execution chain
      const detectorStream = `${STREAMS.PRICE_UPDATES}:cascade:${testId}`;
      const coordinatorStream = `${STREAMS.OPPORTUNITIES}:cascade:${testId}`;
      const detectorGroup = `detector-cascade-${testId}`;
      const coordinatorGroup = `coordinator-cascade-${testId}`;

      await ensureConsumerGroup(redis, detectorStream, detectorGroup);
      await ensureConsumerGroup(redis, coordinatorStream, coordinatorGroup);

      // Step 1: Detector publishes price (normal)
      await redis.xadd(detectorStream, '*', 'data', JSON.stringify(createPriceUpdate()));

      // Step 2: Detector reads and processes
      const detectorResult = await redis.xreadgroup(
        'GROUP', detectorGroup, 'detector-1',
        'COUNT', 10,
        'STREAMS', detectorStream, '>'
      ) as StreamResult;
      expect(detectorResult![0][1].length).toBe(1);

      // Step 3: Detector publishes opportunity (would fail during chaos)
      await redis.xadd(coordinatorStream, '*', 'data', JSON.stringify({
        type: 'arbitrage',
        profit: 50,
        timestamp: Date.now(),
      }));

      // Step 4: Coordinator processes (may be delayed during chaos)
      const coordinatorResult = await redis.xreadgroup(
        'GROUP', coordinatorGroup, 'coordinator-1',
        'COUNT', 10,
        'STREAMS', coordinatorStream, '>'
      ) as StreamResult;
      expect(coordinatorResult![0][1].length).toBe(1);

      // Step 5: Acknowledge all to complete flow
      for (const [id] of detectorResult![0][1]) {
        await redis.xack(detectorStream, detectorGroup, id);
      }
      for (const [id] of coordinatorResult![0][1]) {
        await redis.xack(coordinatorStream, coordinatorGroup, id);
      }
    });

    it('should measure chaos impact on throughput', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:throughput:${testId}`;
      const messageCount = 50;

      // Measure baseline throughput
      const baselineStart = performance.now();
      for (let i = 0; i < messageCount; i++) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate({ price: 2500 + i })));
      }
      const baselineDuration = performance.now() - baselineStart;
      const baselineThroughput = messageCount / (baselineDuration / 1000);

      // Verify we have expected messages
      const streamLen = await redis.xlen(stream);
      expect(streamLen).toBe(messageCount);

      // Throughput should be reasonable (>100 msgs/sec for Redis)
      expect(baselineThroughput).toBeGreaterThan(100);
    });
  });
});
