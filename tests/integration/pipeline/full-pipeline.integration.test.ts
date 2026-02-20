/**
 * Full Pipeline Integration Test
 *
 * Tests the complete arbitrage pipeline:
 * opportunity -> stream:opportunities -> coordinator forwarding ->
 * stream:execution-requests -> ExecutionEngine (SimulationMode) ->
 * stream:execution-results -> XACK verified
 *
 * Uses real Redis via redis-memory-server (no jest.mock for Redis).
 *
 * @see docs/plans/2026-02-20-full-pipeline-integration-test-design.md
 * @see .agent-reports/TEST_AUDIT_REPORT.md - Fix #14 (P4 Coverage Gap)
 */
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
import { TestCoordinatorForwarder } from './helpers/coordinator-forwarder';

// Read test Redis URL from config file (written by jest.globalSetup.ts)
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

describe('[Integration] Full Pipeline: Opportunity -> Execution -> Result', () => {
  let redis: Redis;
  let forwarder: TestCoordinatorForwarder;
  let engine: ExecutionEngineService;

  beforeAll(async () => {
    // Ensure REDIS_URL points to test Redis for singleton getters
    const testUrl = getTestRedisUrl();
    process.env.REDIS_URL = testUrl;

    // Ensure STREAM_SIGNING_KEY is not set (would require HMAC on all messages)
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

    // Reset all @arbitrage/core singletons so engine gets fresh connections
    await resetRedisStreamsInstance();
    await resetRedisInstance();
    await resetDistributedLockManager();
    resetNonceManager();

    // Create consumer group for the forwarder
    await ensureConsumerGroup(
      redis,
      RedisStreams.OPPORTUNITIES,
      'test-coordinator-group'
    );

    // Start coordinator forwarder
    forwarder = new TestCoordinatorForwarder(redis);
    await forwarder.start();

    // Start execution engine in simulation mode
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
    // Stop in reverse order
    try {
      if (engine) await engine.stop();
    } catch { /* ignore cleanup errors */ }

    try {
      if (forwarder) await forwarder.stop();
    } catch { /* ignore */ }

    // Reset singletons to release connections
    await resetRedisStreamsInstance();
    await resetRedisInstance();
    await resetDistributedLockManager();
    resetNonceManager();
  });

  describe('Happy Path', () => {
    it('should execute opportunity through full pipeline', async () => {
      // Arrange: Create test opportunity with all fields required by validation
      const opportunity = createTestOpportunity({
        id: `pipeline-test-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyChain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 50,
        confidence: 0.9,
        amountIn: '1000000000000000000', // 1 ETH in wei
      });

      // Act: Publish to stream:opportunities (entry point of pipeline)
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

      // Find our specific result by opportunityId
      const result = results.find(
        (r) => r.opportunityId === opportunity.id
      );
      expect(result).toBeDefined();
      expect(result!.success).toBe(true);

      // Verify: All streams fully ACKed (deferred ACK completed)
      // Allow brief settle time for ACK propagation
      await new Promise(r => setTimeout(r, 500));

      const oppPending = await getPendingCount(
        redis,
        RedisStreams.OPPORTUNITIES,
        'test-coordinator-group'
      );
      expect(oppPending).toBe(0);

      const execPending = await getPendingCount(
        redis,
        RedisStreams.EXECUTION_REQUESTS,
        'execution-engine-group'
      );
      expect(execPending).toBe(0);
    }, 30000);

    it('should handle batch of opportunities', async () => {
      const count = 5;
      const opportunities = Array.from({ length: count }, (_, i) =>
        createTestOpportunity({
          id: `batch-${i}-${Date.now()}`,
          type: 'cross-dex',
          chain: 'ethereum',
          buyChain: 'ethereum',
          expectedProfit: 10 + i * 5,
          confidence: 0.85,
          amountIn: '1000000000000000000',
        })
      );

      // Publish all opportunities
      for (const opp of opportunities) {
        await redis.xadd(
          RedisStreams.OPPORTUNITIES,
          '*',
          'data', JSON.stringify(opp)
        );
      }

      // Wait for all results
      const results = await collectResults(
        redis,
        RedisStreams.EXECUTION_RESULTS,
        count,
        20000
      );

      expect(results.length).toBeGreaterThanOrEqual(count);

      // Verify all opportunity IDs are represented
      const resultIds = new Set(
        results.map((r) => r.opportunityId)
      );
      for (const opp of opportunities) {
        expect(resultIds).toContain(opp.id);
      }

      // Verify all streams fully ACKed
      await new Promise(r => setTimeout(r, 1000));

      const oppPending = await getPendingCount(
        redis, RedisStreams.OPPORTUNITIES, 'test-coordinator-group'
      );
      expect(oppPending).toBe(0);

      const execPending = await getPendingCount(
        redis, RedisStreams.EXECUTION_REQUESTS, 'execution-engine-group'
      );
      expect(execPending).toBe(0);
    }, 30000);

    it('should preserve opportunity data through pipeline', async () => {
      const opportunity = createTestOpportunity({
        id: `preserve-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyChain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 42.5,
        confidence: 0.95,
        amountIn: '1000000000000000000',
      });

      await redis.xadd(
        RedisStreams.OPPORTUNITIES,
        '*',
        'data', JSON.stringify(opportunity)
      );

      const results = await collectResults(
        redis, RedisStreams.EXECUTION_RESULTS, 1, 15000
      );

      const result = results.find(
        (r) => r.opportunityId === opportunity.id
      );
      expect(result).toBeDefined();

      // Verify the execution result references the correct opportunity
      expect(result!.opportunityId).toBe(opportunity.id);
    }, 30000);
  });
});
