/**
 * Detector -> Coordinator Integration Test
 *
 * TRUE integration test wiring real production components:
 * - PublishingService (from @arbitrage/core) publishes to stream:opportunities
 * - TestCoordinatorForwarder reads from stream:opportunities and forwards
 *   to stream:execution-requests (mimics coordinator OpportunityRouter)
 * - RedisStreamsClient (from @arbitrage/core) is the streams transport
 * - Real Redis via redis-memory-server
 *
 * **Flow Tested**:
 * 1. PublishingService.publishArbitrageOpportunity() -> stream:opportunities
 * 2. TestCoordinatorForwarder reads, unwraps MessageEvent envelope, enriches
 *    with coordinator metadata, and forwards -> stream:execution-requests
 * 3. Verify data integrity + coordinator metadata on execution-requests
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 */

export {};

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { RedisStreams } from '@arbitrage/types';
import { PublishingService, RedisStreamsClient } from '@arbitrage/core';
import {
  resetRedisStreamsInstance,
  resetRedisInstance,
} from '@arbitrage/core/internal';
import {
  createTestRedisClient,
  ensureConsumerGroup,
  createTestOpportunity,
} from '@arbitrage/test-utils';
import { TestCoordinatorForwarder } from '../pipeline/helpers/coordinator-forwarder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read test Redis URL from config file written by jest.globalSetup.ts */
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
 * Poll a Redis stream via XRANGE until expectedCount messages appear
 * or timeout elapses. Returns parsed 'data' fields from each entry.
 */
async function collectFromStream(
  redis: Redis,
  stream: string,
  expectedCount: number,
  timeoutMs = 15000
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const start = Date.now();
  let pollInterval = 50;

  while (results.length < expectedCount && Date.now() - start < timeoutMs) {
    const raw = await redis.xrange(stream, '-', '+');
    results.length = 0; // xrange returns all -- reset and rebuild
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
    return 0; // Stream or group does not exist yet
  }
}

// ---------------------------------------------------------------------------
// Mock logger satisfying ServiceLogger interface (only logger is mocked)
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn() as jest.Mock<() => void>,
  warn: jest.fn() as jest.Mock<() => void>,
  error: jest.fn() as jest.Mock<() => void>,
  debug: jest.fn() as jest.Mock<() => void>,
};

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('[Integration] Detector -> Coordinator: PublishingService -> TestCoordinatorForwarder', () => {
  let redis: Redis;
  let streamsClient: RedisStreamsClient;
  let publisher: PublishingService;
  let forwarder: TestCoordinatorForwarder;

  beforeAll(async () => {
    // Point REDIS_URL at the test Redis server
    const testUrl = getTestRedisUrl();
    process.env.REDIS_URL = testUrl;

    // Disable HMAC signing requirement
    delete process.env.STREAM_SIGNING_KEY;

    // Create raw Redis client for assertions
    redis = await createTestRedisClient();

    // Create real RedisStreamsClient pointed at test Redis
    streamsClient = new RedisStreamsClient(testUrl);
    const healthy = await streamsClient.ping();
    if (!healthy) {
      throw new Error(`RedisStreamsClient failed to connect to ${testUrl}`);
    }

    // Create real PublishingService wired to the streams client
    publisher = new PublishingService({
      streamsClient,
      logger: mockLogger,
      source: 'test-detector',
    });
  }, 30000);

  afterAll(async () => {
    try { await publisher.cleanup(); } catch { /* ignore */ }
    try { await streamsClient.disconnect(); } catch { /* ignore */ }
    try { await redis.quit(); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    // Clean slate before each test
    await redis.flushall();

    // Reset singletons so nothing leaks between tests
    await resetRedisStreamsInstance();
    await resetRedisInstance();

    // Create consumer group that forwarder uses
    await ensureConsumerGroup(
      redis,
      RedisStreams.OPPORTUNITIES,
      'test-coordinator-group'
    );

    // Start forwarder (reads opportunities, forwards to execution-requests)
    forwarder = new TestCoordinatorForwarder(redis);
    await forwarder.start();

    // Clear mock call counts
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  }, 30000);

  afterEach(async () => {
    try { await forwarder.stop(); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Test 1: Single opportunity: detector publishes -> coordinator receives
  //         and forwards
  // -------------------------------------------------------------------------
  describe('Single opportunity: detector publishes -> coordinator receives and forwards', () => {
    it('should publish via PublishingService and appear on execution-requests with coordinator metadata', async () => {
      // Arrange
      const opportunity = createTestOpportunity({
        id: `det-coord-single-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 25,
        confidence: 0.85,
        amountIn: '1000000000000000000',
      });

      // Act: publish through real PublishingService
      await publisher.publishArbitrageOpportunity(opportunity);

      // Assert: message forwarded to execution-requests
      const results = await collectFromStream(
        redis,
        RedisStreams.EXECUTION_REQUESTS,
        1,
        15000
      );

      expect(results.length).toBeGreaterThanOrEqual(1);

      // Find our specific forwarded opportunity (id promoted to top level
      // after TestCoordinatorForwarder unwraps the MessageEvent envelope)
      const forwarded = results.find(r => r.id === opportunity.id);
      expect(forwarded).toBeDefined();

      // Verify coordinator metadata added by TestCoordinatorForwarder
      expect(forwarded!.forwardedBy).toBeDefined();
      expect(typeof forwarded!.forwardedBy).toBe('string');
      expect(forwarded!.forwardedAt).toBeDefined();
      expect(typeof forwarded!.forwardedAt).toBe('number');
      expect((forwarded!.forwardedAt as number)).toBeGreaterThan(0);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // Test 2: Batch - multiple opportunities flow through
  // -------------------------------------------------------------------------
  describe('Batch: multiple opportunities flow through', () => {
    it('should forward all 5 opportunities and ACK all source messages', async () => {
      const count = 5;
      const opportunities = Array.from({ length: count }, (_, i) =>
        createTestOpportunity({
          id: `det-coord-batch-${i}-${Date.now()}`,
          type: 'cross-dex',
          chain: 'ethereum',
          buyDex: 'uniswap_v3',
          sellDex: 'sushiswap',
          expectedProfit: 10 + i * 5,
          confidence: 0.80 + i * 0.03,
          amountIn: '1000000000000000000',
        })
      );

      // Act: publish all through PublishingService
      for (const opp of opportunities) {
        await publisher.publishArbitrageOpportunity(opp);
      }

      // Assert: all 5 appear on execution-requests
      const results = await collectFromStream(
        redis,
        RedisStreams.EXECUTION_REQUESTS,
        count,
        15000
      );

      expect(results.length).toBeGreaterThanOrEqual(count);

      // Verify all opportunity IDs are present (top-level after unwrap)
      const resultIds = new Set(results.map(r => r.id));
      for (const opp of opportunities) {
        expect(resultIds).toContain(opp.id);
      }

      // Allow brief settle for ACK propagation
      await new Promise(r => setTimeout(r, 500));

      // Verify all source messages ACKed (pending count = 0)
      const pending = await getPendingCount(
        redis,
        RedisStreams.OPPORTUNITIES,
        'test-coordinator-group'
      );
      expect(pending).toBe(0);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // Test 3: Data integrity - opportunity data preserved through coordinator
  // -------------------------------------------------------------------------
  describe('Data integrity: opportunity data preserved through coordinator', () => {
    it('should preserve all original fields and add coordinator metadata', async () => {
      const opportunity = createTestOpportunity({
        id: `det-coord-integrity-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 42.5,
        confidence: 0.95,
        amountIn: '2500000000000000000',
        buyPrice: 2500,
        sellPrice: 2520,
      });

      // Act
      await publisher.publishArbitrageOpportunity(opportunity);

      // Collect forwarded message
      const results = await collectFromStream(
        redis,
        RedisStreams.EXECUTION_REQUESTS,
        1,
        15000
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      const forwarded = results.find(r => r.id === opportunity.id);
      expect(forwarded).toBeDefined();

      // PublishingService wraps opportunity in a MessageEvent envelope:
      //   { type: 'arbitrage-opportunity', data: opportunity, timestamp, source }
      // TestCoordinatorForwarder unwraps it, promoting inner data to top-level
      // and storing the envelope metadata in _envelope.
      //
      // Verify ALL original opportunity fields at top level (unwrapped):
      expect(forwarded!.id).toBe(opportunity.id);
      expect(forwarded!.chain).toBe('ethereum');
      expect(forwarded!.buyDex).toBe('uniswap_v3');
      expect(forwarded!.sellDex).toBe('sushiswap');
      expect(forwarded!.expectedProfit).toBe(42.5);
      expect(forwarded!.confidence).toBe(0.95);
      expect(forwarded!.amountIn).toBe('2500000000000000000');
      expect(forwarded!.buyPrice).toBe(2500);
      expect(forwarded!.sellPrice).toBe(2520);

      // Verify the envelope metadata is preserved in _envelope
      const envelope = forwarded!._envelope as Record<string, unknown> | undefined;
      expect(envelope).toBeDefined();
      expect(envelope!.type).toBe('arbitrage-opportunity');
      expect(envelope!.source).toBe('test-detector');
      expect(envelope!.timestamp).toBeDefined();

      // Verify coordinator metadata added by the forwarder
      expect(forwarded!.forwardedBy).toBeDefined();
      expect(forwarded!.forwardedAt).toBeDefined();
      expect(typeof forwarded!.forwardedAt).toBe('number');
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // Test 4: Consumer group semantics - messages delivered once
  // -------------------------------------------------------------------------
  describe('Consumer group semantics: messages delivered once', () => {
    it('should create consumer group on stream:opportunities and ACK all messages', async () => {
      // Verify consumer group exists on stream:opportunities
      const groups = await redis.xinfo('GROUPS', RedisStreams.OPPORTUNITIES) as unknown[];
      expect(groups.length).toBeGreaterThan(0);

      // Publish 3 opportunities
      const count = 3;
      const opportunities = Array.from({ length: count }, (_, i) =>
        createTestOpportunity({
          id: `det-coord-cg-${i}-${Date.now()}`,
          type: 'cross-dex',
          chain: 'ethereum',
          expectedProfit: 15 + i * 10,
          confidence: 0.88,
          amountIn: '1000000000000000000',
        })
      );

      for (const opp of opportunities) {
        await publisher.publishArbitrageOpportunity(opp);
      }

      // Wait for forwarding to complete
      const results = await collectFromStream(
        redis,
        RedisStreams.EXECUTION_REQUESTS,
        count,
        15000
      );

      expect(results.length).toBeGreaterThanOrEqual(count);

      // Allow ACK propagation
      await new Promise(r => setTimeout(r, 500));

      // Verify pending count is 0 -- all messages ACKed
      const pending = await getPendingCount(
        redis,
        RedisStreams.OPPORTUNITIES,
        'test-coordinator-group'
      );
      expect(pending).toBe(0);

      // Verify no duplicate IDs on execution-requests
      // (consumer group ensures each message delivered to exactly one consumer)
      const allIds = results.map(r => r.id);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    }, 30000);
  });
});
