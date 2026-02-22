export {};

/**
 * Price Update -> Opportunity Detection Integration Test
 *
 * TRUE integration test wiring real production components:
 * - SimpleArbitrageDetector (production detection logic)
 * - PublishingService (production Redis Streams publishing)
 * - RedisStreamsClient (production streams client)
 * - Real Redis (via createTestRedisClient)
 *
 * **Flow Tested**:
 * 1. Two PairSnapshots with different prices feed into SimpleArbitrageDetector
 * 2. Detector.calculateArbitrage() returns ArbitrageOpportunity (or null)
 * 3. PublishingService.publishArbitrageOpportunity() writes to stream:opportunities
 * 4. Consumer group reads the opportunity from the stream
 *
 * **What's Real**:
 * - SimpleArbitrageDetector with production threshold logic
 * - PublishingService with production message envelope + trace context
 * - RedisStreamsClient with production XADD/XREAD
 * - Real Redis (redis-memory-server via jest.globalSetup)
 *
 * **What's Mocked**:
 * - Logger (no-op jest.fn() object -- no business logic)
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-014: Modular Detector Components
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

// Production components -- import from source files, NOT barrel exports
import {
  SimpleArbitrageDetector,
  type PairSnapshot,
} from '../../../services/unified-detector/src/detection/simple-arbitrage-detector';
import { PublishingService } from '../../../shared/core/src/publishing/publishing-service';
import { RedisStreamsClient } from '../../../shared/core/src/redis-streams';
import type { ServiceLogger } from '../../../shared/core/src/logging/types';

// Test utilities
import { createTestRedisClient } from '@arbitrage/test-utils';

// Singleton reset for cleanup
import { resetRedisStreamsInstance, resetRedisInstance } from '@arbitrage/core/internal';

// =============================================================================
// Test Redis URL resolution (same pattern as redis-helpers.ts)
// =============================================================================

function getTestRedisUrl(): string {
  const configFile = path.resolve(__dirname, '../../../.redis-test-config.json');

  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.url) {
        return config.url;
      }
    } catch {
      // Fall through to env vars
    }
  }

  return process.env.REDIS_URL || 'redis://localhost:6379';
}

// =============================================================================
// Mock Logger (only thing mocked -- no business logic)
// =============================================================================

function createMockLogger(): ServiceLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

// =============================================================================
// Test Data: Token addresses (Ethereum mainnet)
// =============================================================================

const TOKEN_A = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH
const TOKEN_B = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI

const PAIR_ADDRESS_UNI = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const PAIR_ADDRESS_SUSHI = '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0';

// =============================================================================
// Helper: Create PairSnapshot with realistic reserves
// =============================================================================

/**
 * Create a PairSnapshot with a given price ratio.
 * Uses same-decimal tokens (18/18) for simpler arithmetic.
 *
 * Price = reserve1 / reserve0
 * For price P with reserve0 = R0:
 *   reserve1 = R0 * P
 */
function createPairSnapshot(overrides: Partial<PairSnapshot> & { price?: number } = {}): PairSnapshot {
  const {
    price = 2500,
    address = PAIR_ADDRESS_UNI,
    dex = 'uniswap_v3',
    token0 = TOKEN_A,
    token1 = TOKEN_B,
    fee = 0.003,
    blockNumber = 18000000,
    ...rest
  } = overrides;

  // Base reserve: 1000 tokens (18 decimals)
  const reserve0BigInt = 1000n * 10n ** 18n;
  // Reserve1 = reserve0 * price (both 18 decimals, so price is the ratio)
  const reserve1BigInt = BigInt(Math.floor(1000 * price)) * 10n ** 18n;

  return {
    address,
    dex,
    token0,
    token1,
    reserve0: reserve0BigInt.toString(),
    reserve1: reserve1BigInt.toString(),
    fee,
    blockNumber,
    reserve0BigInt,
    reserve1BigInt,
    ...rest,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('[Level 1] Price Detection -> Publishing Integration (Real Components)', () => {
  let redis: Redis;
  let streamsClient: RedisStreamsClient;
  let detector: SimpleArbitrageDetector;
  let publisher: PublishingService;
  let mockLogger: ServiceLogger;
  let redisUrl: string;

  beforeAll(async () => {
    // Resolve Redis URL and set env var BEFORE creating clients
    redisUrl = getTestRedisUrl();
    process.env.REDIS_URL = redisUrl;

    // Create raw Redis client for verification reads
    redis = await createTestRedisClient();

    // Create real RedisStreamsClient (no HMAC signing in test)
    streamsClient = new RedisStreamsClient(redisUrl);

    // Create real SimpleArbitrageDetector with ethereum config
    detector = new SimpleArbitrageDetector({
      chainId: 'ethereum',
      gasEstimate: 250000,
      confidence: 0.85,
      expiryMs: 30000,
    });

    // Create real PublishingService
    mockLogger = createMockLogger();
    publisher = new PublishingService({
      streamsClient,
      logger: mockLogger,
      source: 'test-detector',
    });
  }, 30000);

  afterAll(async () => {
    // Clean up in reverse order
    try {
      await publisher.cleanup();
    } catch {
      // Ignore cleanup errors
    }
    try {
      await streamsClient.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    try {
      await resetRedisStreamsInstance();
    } catch {
      // Ignore reset errors
    }
    try {
      await resetRedisInstance();
    } catch {
      // Ignore reset errors
    }
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    // Flush Redis between tests for isolation
    if (redis?.status === 'ready') {
      await redis.flushall();
    }
  });

  // ===========================================================================
  // Test 1: Detection -- price difference produces an opportunity
  // ===========================================================================

  describe('Detection: price difference -> opportunity found', () => {
    it('should detect arbitrage when two pools have a significant price spread', () => {
      // Pair 1: Lower price (buy side) -- price = 2500
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
        fee: 0.003,
      });

      // Pair 2: Higher price (sell side) -- price = 2700 (8% spread, well above threshold)
      const pair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2700,
        fee: 0.003,
      });

      const opportunity = detector.calculateArbitrage(pair1, pair2);

      // Should return a valid opportunity
      expect(opportunity).not.toBeNull();
      expect(opportunity!.type).toBe('simple');
      expect(opportunity!.chain).toBe('ethereum');
      expect(opportunity!.confidence).toBe(0.85);

      // Buy from the lower-priced DEX, sell on the higher-priced one
      expect(opportunity!.buyPrice).toBeDefined();
      expect(opportunity!.sellPrice).toBeDefined();
      expect(opportunity!.buyPrice!).toBeLessThan(opportunity!.sellPrice!);

      // Verify the opportunity has required fields for execution
      expect(opportunity!.id).toBeDefined();
      expect(opportunity!.tokenIn).toBeDefined();
      expect(opportunity!.tokenOut).toBeDefined();
      expect(opportunity!.amountIn).toBeDefined();
      expect(opportunity!.profitPercentage).toBeGreaterThan(0);
      expect(opportunity!.expectedProfit).toBeGreaterThan(0);
      expect(opportunity!.expiresAt).toBeGreaterThan(opportunity!.timestamp);
      expect(opportunity!.status).toBe('pending');
      expect(opportunity!.blockNumber).toBe(18000000);
    });

    it('should calculate profit percentage correctly based on net spread minus fees', () => {
      // 4% raw spread with 0.3% + 0.3% = 0.6% total fees = ~3.4% net
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
        fee: 0.003,
      });

      const pair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2600,
        fee: 0.003,
      });

      const opportunity = detector.calculateArbitrage(pair1, pair2);
      expect(opportunity).not.toBeNull();

      // profitPercentage should be (priceDiff/minPrice - totalFees) * 100
      // priceDiff = |2600-2500| / 2500 = 0.04 (4%)
      // totalFees = 0.003 + 0.003 = 0.006 (0.6%)
      // netProfitPct = 0.04 - 0.006 = 0.034 (3.4%)
      // profitPercentage = 3.4
      expect(opportunity!.profitPercentage).toBeCloseTo(3.4, 0);
    });
  });

  // ===========================================================================
  // Test 2: Detection -- insufficient spread returns null
  // ===========================================================================

  describe('Detection: insufficient spread -> no opportunity', () => {
    it('should return null when price spread is below the minimum profit threshold', () => {
      // Ethereum minProfitThreshold is 0.005 (0.5%)
      // With fees 0.003 + 0.003 = 0.006, need raw spread > 0.005 + 0.006 = 1.1%
      // Using 0.2% raw spread -- far below threshold
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
        fee: 0.003,
      });

      const pair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2505, // Only 0.2% difference
        fee: 0.003,
      });

      const opportunity = detector.calculateArbitrage(pair1, pair2);
      expect(opportunity).toBeNull();
    });

    it('should return null when spread covers fees but not profit threshold', () => {
      // Total fees = 0.6%, ethereum min profit = 0.5%
      // Need raw spread > 1.1% to pass
      // Using 0.8% raw spread -- covers fees (0.6%) but net profit (0.2%) < threshold (0.5%)
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
        fee: 0.003,
      });

      const pair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2520, // 0.8% difference
        fee: 0.003,
      });

      const opportunity = detector.calculateArbitrage(pair1, pair2);
      expect(opportunity).toBeNull();
    });

    it('should return null when reserves are zero', () => {
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
      });

      // Zero reserves -- invalid pool state
      const pair2: PairSnapshot = {
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        token0: TOKEN_A,
        token1: TOKEN_B,
        reserve0: '0',
        reserve1: '0',
        fee: 0.003,
        blockNumber: 18000000,
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      };

      const opportunity = detector.calculateArbitrage(pair1, pair2);
      expect(opportunity).toBeNull();
    });
  });

  // ===========================================================================
  // Test 3: Detection -> Publishing: opportunity flows to Redis Stream
  // ===========================================================================

  describe('Detection -> Publishing: opportunity flows to Redis Stream', () => {
    it('should detect, publish, and read an opportunity from stream:opportunities', async () => {
      // Step 1: Detect an opportunity
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
        fee: 0.003,
      });

      const pair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2700, // 8% spread
        fee: 0.003,
      });

      const opportunity = detector.calculateArbitrage(pair1, pair2);
      expect(opportunity).not.toBeNull();

      // Step 2: Publish via real PublishingService
      await publisher.publishArbitrageOpportunity(opportunity!);

      // Step 3: Read from stream:opportunities using raw Redis xrange
      const streamName = RedisStreamsClient.STREAMS.OPPORTUNITIES;
      const messages = await redis.xrange(streamName, '-', '+');

      expect(messages.length).toBeGreaterThanOrEqual(1);

      // Parse the message data field
      const [, fields] = messages[0];
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }

      // The PublishingService wraps in a MessageEvent envelope
      expect(fieldMap.data).toBeDefined();
      const envelope = JSON.parse(fieldMap.data);

      // Verify envelope structure
      expect(envelope.type).toBe('arbitrage-opportunity');
      expect(envelope.source).toBe('test-detector');
      expect(envelope.timestamp).toBeDefined();

      // Verify the opportunity data inside the envelope
      const oppData = envelope.data;
      expect(oppData.id).toBe(opportunity!.id);
      expect(oppData.chain).toBe('ethereum');
      expect(oppData.type).toBe('simple');
      expect(oppData.confidence).toBe(0.85);
      expect(oppData.buyPrice).toBeLessThan(oppData.sellPrice);
      expect(oppData.profitPercentage).toBeGreaterThan(0);
      expect(oppData.tokenIn).toBeDefined();
      expect(oppData.tokenOut).toBeDefined();
      expect(oppData.amountIn).toBeDefined();

      // Verify pipeline timestamps were injected
      expect(oppData.pipelineTimestamps).toBeDefined();
      expect(oppData.pipelineTimestamps.detectedAt).toBeDefined();
    }, 30000);

    it('should NOT publish when detection returns null (no false positives in stream)', async () => {
      // Insufficient spread -- detection returns null
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
        fee: 0.003,
      });

      const pair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2505, // Tiny spread
        fee: 0.003,
      });

      const opportunity = detector.calculateArbitrage(pair1, pair2);
      expect(opportunity).toBeNull();

      // Nothing to publish -- stream should remain empty
      const streamName = RedisStreamsClient.STREAMS.OPPORTUNITIES;
      const streamLen = await redis.xlen(streamName);
      expect(streamLen).toBe(0);
    });
  });

  // ===========================================================================
  // Test 4: Full flow -- detection + publishing + consumer group read
  // ===========================================================================

  describe('Full flow: detection + publishing + consumer group read', () => {
    it('should detect, publish, and consume via xreadgroup from a consumer group', async () => {
      const streamName = RedisStreamsClient.STREAMS.OPPORTUNITIES;
      const groupName = 'test-coordinator';
      const consumerName = 'test-worker-1';

      // Step 1: Create consumer group on the stream
      try {
        await redis.xgroup('CREATE', streamName, groupName, '0', 'MKSTREAM');
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (!errMsg.includes('BUSYGROUP')) {
          throw error;
        }
      }

      // Step 2: Detect an opportunity
      const pair1 = createPairSnapshot({
        address: PAIR_ADDRESS_UNI,
        dex: 'uniswap_v3',
        price: 2500,
        fee: 0.003,
      });

      const pair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2700, // 8% spread
        fee: 0.003,
      });

      const opportunity = detector.calculateArbitrage(pair1, pair2);
      expect(opportunity).not.toBeNull();

      // Step 3: Publish via real PublishingService
      await publisher.publishArbitrageOpportunity(opportunity!);

      // Step 4: Consume via xreadgroup (simulating coordinator)
      // Type: xreadgroup returns [streamName, [messageId, fields[]][]][]
      type StreamEntry = [id: string, fields: string[]];
      type StreamResult = [stream: string, entries: StreamEntry[]];

      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'COUNT', '10',
        'STREAMS', streamName, '>'
      ) as StreamResult[] | null;

      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);

      const [, messages] = result![0];
      expect(messages.length).toBeGreaterThanOrEqual(1);

      // Parse the consumed message
      const [messageId, fields] = messages[0];
      expect(messageId).toBeDefined();

      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }

      const envelope = JSON.parse(fieldMap.data);
      const oppData = envelope.data;

      // Verify the consumed data matches what was detected
      expect(oppData.id).toBe(opportunity!.id);
      expect(oppData.chain).toBe('ethereum');
      expect(oppData.type).toBe('simple');
      expect(oppData.buyPrice).toBeCloseTo(opportunity!.buyPrice!, 2);
      expect(oppData.sellPrice).toBeCloseTo(opportunity!.sellPrice!, 2);
      expect(oppData.profitPercentage).toBeCloseTo(opportunity!.profitPercentage!, 2);
      expect(oppData.confidence).toBe(opportunity!.confidence);
      expect(oppData.tokenIn).toBe(opportunity!.tokenIn);
      expect(oppData.tokenOut).toBe(opportunity!.tokenOut);
      expect(oppData.amountIn).toBe(opportunity!.amountIn);

      // Step 5: ACK the message
      const ackCount = await redis.xack(streamName, groupName, messageId);
      expect(ackCount).toBe(1);

      // Verify no pending messages remain
      const pending = await redis.xpending(streamName, groupName);
      expect(pending[0]).toBe(0); // Total pending count
    }, 30000);

    it('should handle multiple opportunities published in sequence', async () => {
      const streamName = RedisStreamsClient.STREAMS.OPPORTUNITIES;
      const groupName = 'test-coordinator-multi';
      const consumerName = 'test-worker-multi';

      // Create consumer group
      try {
        await redis.xgroup('CREATE', streamName, groupName, '0', 'MKSTREAM');
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (!errMsg.includes('BUSYGROUP')) {
          throw error;
        }
      }

      // Detect and publish multiple opportunities with different price spreads
      const spreads = [
        { buyPrice: 2500, sellPrice: 2700, dex: 'curve' },        // 8% spread
        { buyPrice: 2500, sellPrice: 2800, dex: 'balancer_v2' },   // 12% spread
        { buyPrice: 2500, sellPrice: 2650, dex: 'pancakeswap_v3' },// 6% spread
      ];

      const publishedIds: string[] = [];

      for (const spread of spreads) {
        const pair1 = createPairSnapshot({
          address: PAIR_ADDRESS_UNI,
          dex: 'uniswap_v3',
          price: spread.buyPrice,
          fee: 0.003,
        });

        const pair2 = createPairSnapshot({
          address: `0x${'ab'.repeat(20)}`, // Unique address per pair
          dex: spread.dex,
          price: spread.sellPrice,
          fee: 0.003,
        });

        const opp = detector.calculateArbitrage(pair1, pair2);
        expect(opp).not.toBeNull();
        publishedIds.push(opp!.id);

        await publisher.publishArbitrageOpportunity(opp!);
      }

      // Consume all messages
      type StreamEntry = [id: string, fields: string[]];
      type StreamResult = [stream: string, entries: StreamEntry[]];

      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'COUNT', '10',
        'STREAMS', streamName, '>'
      ) as StreamResult[] | null;

      expect(result).not.toBeNull();
      const [, messages] = result![0];
      expect(messages.length).toBe(3);

      // Verify all three opportunities are present with correct IDs
      const consumedIds: string[] = [];
      for (const [, fields] of messages) {
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]] = fields[i + 1];
        }
        const envelope = JSON.parse(fieldMap.data);
        consumedIds.push(envelope.data.id);
      }

      for (const id of publishedIds) {
        expect(consumedIds).toContain(id);
      }

      // ACK all messages
      const messageIds = messages.map((entry: StreamEntry) => entry[0]);
      const ackCount = await redis.xack(streamName, groupName, ...messageIds);
      expect(ackCount).toBe(3);
    }, 30000);
  });

  // ===========================================================================
  // Test 5: Detector rejection stats (observability)
  // ===========================================================================

  describe('Detector observability: rejection stats', () => {
    it('should track rejection statistics for filtered opportunities', () => {
      // Reset stats
      detector.resetStats();

      // Trigger zero-reserve rejection
      const zeroPair: PairSnapshot = {
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        token0: TOKEN_A,
        token1: TOKEN_B,
        reserve0: '0',
        reserve1: '0',
        fee: 0.003,
        blockNumber: 18000000,
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      };

      const validPair = createPairSnapshot({ price: 2500 });

      detector.calculateArbitrage(validPair, zeroPair);
      detector.calculateArbitrage(zeroPair, validPair);

      // Trigger below-profit-threshold rejection
      const closePair1 = createPairSnapshot({ price: 2500, fee: 0.003 });
      const closePair2 = createPairSnapshot({
        address: PAIR_ADDRESS_SUSHI,
        dex: 'sushiswap',
        price: 2510, // Only 0.4% raw spread, below threshold after fees
        fee: 0.003,
      });
      detector.calculateArbitrage(closePair1, closePair2);

      const stats = detector.getStats();
      expect(stats.zeroReserves).toBeGreaterThanOrEqual(2);
      expect(stats.total).toBeGreaterThanOrEqual(3);
    });
  });
});
