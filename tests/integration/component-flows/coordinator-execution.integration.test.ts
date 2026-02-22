export {};

/**
 * Coordinator -> Execution Engine Integration Test
 *
 * TRUE integration test wiring real production components:
 * - TestCoordinatorForwarder: reads stream:opportunities, forwards to stream:execution-requests
 * - ExecutionEngineService: consumes execution-requests, produces execution-results
 * - Real Redis via redis-memory-server (no mocks)
 *
 * Flow:
 *   [test publishes opportunity via xadd] -> stream:opportunities
 *     -> TestCoordinatorForwarder reads + enriches with coordinator metadata
 *     -> stream:execution-requests
 *     -> ExecutionEngineService (simulation mode) processes
 *     -> stream:execution-results
 *     -> [test reads + asserts]
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Leader Election and Coordination
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { RedisStreams } from '@arbitrage/types';
import {
  resetRedisInstance,
  resetRedisStreamsInstance,
  resetDistributedLockManager,
  resetNonceManager,
} from '@arbitrage/core/internal';
import { ExecutionEngineService } from '../../../services/execution-engine/src/engine';
import {
  createTestRedisClient,
  ensureConsumerGroup,
  createTestOpportunity,
} from '@arbitrage/test-utils';
import { TestCoordinatorForwarder } from '../pipeline/helpers/coordinator-forwarder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read test Redis URL from config file (written by jest.globalSetup.ts).
 */
function getTestRedisUrl(): string {
  const configFile = path.resolve(__dirname, '../../../.redis-test-config.json');
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.url) return config.url;
    } catch { /* fall through */ }
  }
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

/**
 * Wait for messages on a stream with exponential backoff polling.
 * Returns parsed 'data' fields from collected messages.
 */
async function collectResults(
  redis: Redis,
  stream: string,
  expectedCount: number,
  timeoutMs: number = 15000
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const start = Date.now();
  let pollInterval = 50;

  while (results.length < expectedCount && Date.now() - start < timeoutMs) {
    const raw = await redis.xrange(stream, '-', '+');
    results.length = 0; // Reset -- xrange returns all
    for (const [, fields] of raw) {
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }
      if (fieldObj.data) {
        try {
          results.push(JSON.parse(fieldObj.data));
        } catch {
          results.push(fieldObj as unknown as Record<string, unknown>);
        }
      }
    }
    if (results.length < expectedCount) {
      await new Promise(r => setTimeout(r, pollInterval));
      pollInterval = Math.min(pollInterval * 1.5, 500);
    }
  }
  return results;
}

/**
 * Get pending message count for a consumer group on a stream.
 */
async function getPendingCount(
  redis: Redis,
  stream: string,
  group: string
): Promise<number> {
  try {
    const info = await redis.xpending(stream, group) as unknown[];
    return (info[0] as number) ?? 0;
  } catch {
    return 0; // Stream or group doesn't exist yet
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('[Integration] Coordinator -> Execution Engine (Real Components)', () => {
  let redis: Redis;
  let forwarder: TestCoordinatorForwarder;
  let engine: ExecutionEngineService;

  beforeAll(async () => {
    // Point singletons to test Redis
    const testUrl = getTestRedisUrl();
    process.env.REDIS_URL = testUrl;

    // Disable HMAC signing for tests
    delete process.env.STREAM_SIGNING_KEY;

    // Create direct Redis client for test assertions
    redis = await createTestRedisClient();
  }, 30000);

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    // Clean slate
    await redis.flushall();

    // Reset all @arbitrage/core singletons so each test gets fresh connections
    await resetRedisStreamsInstance();
    await resetRedisInstance();
    await resetDistributedLockManager();
    resetNonceManager();

    // Create consumer group that the forwarder subscribes to
    await ensureConsumerGroup(
      redis,
      RedisStreams.OPPORTUNITIES,
      'test-coordinator-group'
    );

    // Start coordinator forwarder (reads opportunities, writes execution-requests)
    forwarder = new TestCoordinatorForwarder(redis);
    await forwarder.start();

    // Start execution engine in simulation mode (no blockchain providers needed)
    engine = new ExecutionEngineService({
      simulationConfig: {
        enabled: true,
        successRate: 1.0,
        executionLatencyMs: 10,
        profitVariance: 0.1,
      },
    });
    await engine.start();
  }, 30000);

  afterEach(async () => {
    // Stop in reverse start order
    try {
      if (engine) await engine.stop();
    } catch { /* ignore cleanup errors */ }

    try {
      if (forwarder) await forwarder.stop();
    } catch { /* ignore */ }

    // Release singleton connections
    await resetRedisStreamsInstance();
    await resetRedisInstance();
    await resetDistributedLockManager();
    resetNonceManager();
  });

  // =========================================================================
  // Test 1: Single opportunity end-to-end
  // =========================================================================

  describe('Single Opportunity Flow', () => {
    it('coordinator forwards opportunity and execution engine produces result', async () => {
      // Arrange
      const opportunity = createTestOpportunity({
        id: `coord-exec-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyChain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 50,
        confidence: 0.9,
        amountIn: '1000000000000000000', // 1 ETH
      });

      // Act: Publish to stream:opportunities (simulating detector output)
      await redis.xadd(
        RedisStreams.OPPORTUNITIES,
        '*',
        'data', JSON.stringify(opportunity)
      );

      // Assert: Result appears on stream:execution-results
      const results = await collectResults(
        redis,
        RedisStreams.EXECUTION_RESULTS,
        1,
        15000
      );

      expect(results.length).toBeGreaterThanOrEqual(1);

      // Find our specific result
      const result = results.find(r => r.opportunityId === opportunity.id);
      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.opportunityId).toBe(opportunity.id);
    }, 30000);
  });

  // =========================================================================
  // Test 2: Execution result data shape and coordinator metadata
  // =========================================================================

  describe('Execution Result Data Shape', () => {
    it('result contains expected fields and coordinator metadata is preserved', async () => {
      const detectedAt = Date.now();
      const opportunity = createTestOpportunity({
        id: `shape-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyChain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 42.5,
        confidence: 0.95,
        amountIn: '1000000000000000000',
        pipelineTimestamps: { detectedAt },
      });

      // Publish to stream:opportunities
      await redis.xadd(
        RedisStreams.OPPORTUNITIES,
        '*',
        'data', JSON.stringify(opportunity)
      );

      // Wait for execution result
      const results = await collectResults(
        redis,
        RedisStreams.EXECUTION_RESULTS,
        1,
        15000
      );

      expect(results.length).toBeGreaterThanOrEqual(1);

      const result = results.find(r => r.opportunityId === opportunity.id);
      expect(result).toBeDefined();

      // Verify result has expected execution fields
      expect(result!.opportunityId).toBe(opportunity.id);
      expect(typeof result!.success).toBe('boolean');

      // Verify coordinator metadata was preserved on the forwarded message
      // by reading stream:execution-requests directly
      const execMessages = await redis.xrange(RedisStreams.EXECUTION_REQUESTS, '-', '+');
      const forwardedMsg = execMessages.find(([, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        try {
          const parsed = JSON.parse(obj.data);
          return parsed.id === opportunity.id;
        } catch {
          return false;
        }
      });

      expect(forwardedMsg).toBeDefined();
      if (forwardedMsg) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < forwardedMsg[1].length; i += 2) {
          obj[forwardedMsg[1][i]] = forwardedMsg[1][i + 1];
        }
        const parsed = JSON.parse(obj.data);

        // TestCoordinatorForwarder adds these metadata fields
        expect(parsed.forwardedBy).toBeDefined();
        expect(typeof parsed.forwardedBy).toBe('string');
        expect(parsed.forwardedAt).toBeGreaterThanOrEqual(detectedAt);

        // Pipeline timestamps should include coordinatorAt
        if (parsed.pipelineTimestamps) {
          expect(parsed.pipelineTimestamps.coordinatorAt).toBeGreaterThanOrEqual(detectedAt);
        }
      }
    }, 30000);
  });

  // =========================================================================
  // Test 3: Distributed lock prevents duplicate execution
  // =========================================================================

  describe('Distributed Lock Prevents Duplicate Execution', () => {
    it('publishing same opportunity ID twice to execution-requests produces at most 1 result', async () => {
      const opportunityId = `dup-lock-${Date.now()}`;
      const opportunity = createTestOpportunity({
        id: opportunityId,
        type: 'cross-dex',
        chain: 'ethereum',
        buyChain: 'ethereum',
        expectedProfit: 30,
        confidence: 0.9,
        amountIn: '1000000000000000000',
      });

      // Bypass forwarder: publish the SAME opportunity directly to execution-requests twice
      await redis.xadd(
        RedisStreams.EXECUTION_REQUESTS,
        '*',
        'data', JSON.stringify(opportunity)
      );
      await redis.xadd(
        RedisStreams.EXECUTION_REQUESTS,
        '*',
        'data', JSON.stringify(opportunity)
      );

      // Wait for processing
      await new Promise(r => setTimeout(r, 5000));

      const results = await collectResults(
        redis,
        RedisStreams.EXECUTION_RESULTS,
        1,
        10000
      );

      // Distributed lock should prevent duplicate execution for the same opportunity ID.
      // At most 1 execution result for this opportunityId.
      const matchingResults = results.filter(
        r => r.opportunityId === opportunityId
      );
      expect(matchingResults.length).toBeLessThanOrEqual(1);
    }, 20000);
  });

  // =========================================================================
  // Test 4: All streams ACKed after processing
  // =========================================================================

  describe('Stream ACK Verification', () => {
    it('all streams have zero pending messages after full processing', async () => {
      const opportunity = createTestOpportunity({
        id: `ack-test-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyChain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 25,
        confidence: 0.9,
        amountIn: '1000000000000000000',
      });

      // Publish to stream:opportunities (enters the full pipeline)
      await redis.xadd(
        RedisStreams.OPPORTUNITIES,
        '*',
        'data', JSON.stringify(opportunity)
      );

      // Wait for result to appear (proves end-to-end processing completed)
      const results = await collectResults(
        redis,
        RedisStreams.EXECUTION_RESULTS,
        1,
        15000
      );
      expect(results.length).toBeGreaterThanOrEqual(1);

      // Allow brief settle time for deferred ACK propagation
      await new Promise(r => setTimeout(r, 1000));

      // Verify stream:opportunities has 0 pending for the forwarder's group
      const oppPending = await getPendingCount(
        redis,
        RedisStreams.OPPORTUNITIES,
        'test-coordinator-group'
      );
      expect(oppPending).toBe(0);

      // Verify stream:execution-requests has 0 pending for the engine's group
      const execPending = await getPendingCount(
        redis,
        RedisStreams.EXECUTION_REQUESTS,
        'execution-engine-group'
      );
      expect(execPending).toBe(0);
    }, 30000);
  });
});
