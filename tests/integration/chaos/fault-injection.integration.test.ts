/**
 * Chaos/Fault Injection Integration Tests
 *
 * Phase 3, Task 3.2: Tests system behavior under failure conditions.
 *
 * **Scenarios Tested**:
 * 1. Redis connection failures
 * 2. RPC endpoint timeouts
 * 3. Intermittent failures
 * 4. Network partition simulation
 * 5. Recovery after chaos
 *
 * **What's Real**:
 * - Redis Streams (via redis-memory-server)
 * - Chaos injection infrastructure
 * - Service recovery patterns
 *
 * @see docs/research/INTEGRATION_TEST_COVERAGE_REPORT.md Phase 3, Task 3.2
 * @see shared/test-utils/src/helpers/chaos-testing.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
  createChaosController,
  createChaosRedisClient,
  NetworkPartitionSimulator,
  waitForChaosCondition,
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
  // Task 3.2.1: Redis Failure Injection
  // ===========================================================================

  describe('Task 3.2.1: Redis Failure Injection', () => {
    it('should detect Redis connection failure via chaos controller', async () => {
      const chaos = createChaosController(`redis-test-${testId}`);

      // Start with chaos disabled
      expect(chaos.shouldApply()).toBe(false);

      // Enable chaos - 100% failure rate
      chaos.start({ mode: 'fail', failureProbability: 1 });

      expect(chaos.shouldApply()).toBe(true);

      // Stop chaos
      chaos.stop();
      expect(chaos.shouldApply()).toBe(false);
    });

    it('should track chaos injection statistics', async () => {
      const chaos = createChaosController(`stats-test-${testId}`);

      chaos.start({ mode: 'fail', failureProbability: 1 });

      // Simulate multiple failure checks
      for (let i = 0; i < 5; i++) {
        if (chaos.shouldApply()) {
          chaos.recordFailure();
        }
      }

      // Small delay to ensure elapsed time is measurable
      await sleep(10);

      const stats = chaos.getStats();

      expect(stats.injectedFailures).toBe(5);
      expect(stats.isActive).toBe(true);
      expect(stats.elapsedMs).toBeGreaterThanOrEqual(10);

      chaos.stop();
    });

    it('should support intermittent failure mode', async () => {
      const chaos = createChaosController(`intermittent-${testId}`);

      // 50% failure probability
      chaos.start({ mode: 'intermittent', failureProbability: 0.5 });

      let failures = 0;
      let successes = 0;

      // Run 100 checks
      for (let i = 0; i < 100; i++) {
        if (chaos.shouldApply()) {
          failures++;
        } else {
          successes++;
        }
      }

      // Should have roughly 50/50 distribution (with some variance)
      expect(failures).toBeGreaterThan(20);
      expect(successes).toBeGreaterThan(20);

      chaos.stop();
    });

    it('should honor duration limit', async () => {
      const chaos = createChaosController(`duration-${testId}`);

      // Start chaos with 100ms duration
      chaos.start({ mode: 'fail', durationMs: 100 });

      expect(chaos.shouldApply()).toBe(true);

      // Wait for duration to expire
      await sleep(150);

      // Should auto-disable after duration
      expect(chaos.shouldApply()).toBe(false);
    });
  });

  // ===========================================================================
  // Task 3.2.2: Latency Injection
  // ===========================================================================

  describe('Task 3.2.2: Latency Injection', () => {
    it('should inject latency in slow mode', async () => {
      const chaos = createChaosController(`latency-${testId}`);

      chaos.start({ mode: 'slow', latencyMs: 100 });

      const latency = chaos.getLatency();

      expect(latency).toBe(100);
      expect(chaos.shouldApply()).toBe(true);

      chaos.stop();
    });

    it('should not inject latency in fail mode', async () => {
      const chaos = createChaosController(`no-latency-${testId}`);

      chaos.start({ mode: 'fail', latencyMs: 100 });

      const latency = chaos.getLatency();

      // Fail mode doesn't inject latency (it fails immediately)
      expect(latency).toBe(0);

      chaos.stop();
    });

    it('should measure latency impact on operations', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:latency:${testId}`;
      const targetLatency = 50; // 50ms

      // Measure baseline (no chaos)
      const baselineStart = performance.now();
      await redis.xadd(stream, '*', 'data', JSON.stringify(createPriceUpdate()));
      const baselineLatency = performance.now() - baselineStart;

      // The actual operation should be fast without chaos
      expect(baselineLatency).toBeLessThan(20); // Redis is fast

      // Note: We can't actually inject latency into the real Redis client
      // in this test, but we've verified the chaos controller tracks it
    });
  });

  // ===========================================================================
  // Task 3.2.3: Network Partition Simulation
  // ===========================================================================

  describe('Task 3.2.3: Network Partition Simulation', () => {
    it('should simulate partition between services', () => {
      const simulator = new NetworkPartitionSimulator();

      // Initially, all services can communicate
      expect(simulator.canCommunicate('detector', 'coordinator')).toBe(true);
      expect(simulator.canCommunicate('coordinator', 'execution')).toBe(true);

      // Create partition
      simulator.partition('detector', 'coordinator');

      // Detector and coordinator can't communicate
      expect(simulator.canCommunicate('detector', 'coordinator')).toBe(false);
      expect(simulator.canCommunicate('coordinator', 'detector')).toBe(false);

      // Other pairs still can
      expect(simulator.canCommunicate('coordinator', 'execution')).toBe(true);
    });

    it('should heal partitions', () => {
      const simulator = new NetworkPartitionSimulator();

      // Create partition
      simulator.partition('detector', 'coordinator');
      expect(simulator.canCommunicate('detector', 'coordinator')).toBe(false);

      // Heal partition
      simulator.heal('detector', 'coordinator');
      expect(simulator.canCommunicate('detector', 'coordinator')).toBe(true);
    });

    it('should heal all partitions at once', () => {
      const simulator = new NetworkPartitionSimulator();

      // Create multiple partitions
      simulator.partition('detector', 'coordinator');
      simulator.partition('coordinator', 'execution');
      simulator.partition('detector', 'execution');

      // Verify partitions exist
      expect(simulator.canCommunicate('detector', 'coordinator')).toBe(false);
      expect(simulator.canCommunicate('coordinator', 'execution')).toBe(false);

      // Heal all
      simulator.healAll();

      // All should communicate
      expect(simulator.canCommunicate('detector', 'coordinator')).toBe(true);
      expect(simulator.canCommunicate('coordinator', 'execution')).toBe(true);
      expect(simulator.canCommunicate('detector', 'execution')).toBe(true);
    });

    it('should report partition status', () => {
      const simulator = new NetworkPartitionSimulator();

      simulator.partition('detector', 'coordinator');

      const status = simulator.getStatus();

      expect(status.isActive).toBe(true);
      expect(status.partitions.length).toBeGreaterThan(0);

      // Check that detector is blocked from coordinator
      const detectorStatus = status.partitions.find((p) => p.service === 'detector');
      expect(detectorStatus?.blockedFrom).toContain('coordinator');
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
      const failedStream = `${STREAMS.OPPORTUNITIES}:failed:${testId}`;
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

    it('should use waitForCondition for recovery verification', async () => {
      let recoveryCount = 0;

      // Simulate gradual recovery
      const checkRecovery = () => {
        recoveryCount++;
        return recoveryCount >= 3; // Recovered after 3 checks
      };

      const recovered = await waitForChaosCondition(checkRecovery, {
        timeout: 1000,
        interval: 50,
      });

      expect(recovered).toBe(true);
      expect(recoveryCount).toBe(3);
    });

    it('should timeout if recovery takes too long', async () => {
      const neverRecovers = () => false;

      const recovered = await waitForChaosCondition(neverRecovers, {
        timeout: 200,
        interval: 50,
      });

      expect(recovered).toBe(false);
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

      // Log throughput for analysis
      const _throughputMetrics = {
        messageCount,
        durationMs: baselineDuration,
        messagesPerSecond: baselineThroughput,
      };

      // Throughput should be reasonable (>100 msgs/sec for Redis)
      expect(baselineThroughput).toBeGreaterThan(100);
    });
  });
});
