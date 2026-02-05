/**
 * Cross-Partition Price Synchronization Integration Tests
 *
 * Phase 2, Task 2.1: Tests that prices published by one partition are
 * correctly shared and consumed by other partitions via Redis Streams.
 *
 * **Flow Tested (from DATA_FLOW.md)**:
 * 1. Partition P1 (asia-fast) publishes price for BSC/PancakeSwap WBNB/USDT
 * 2. Partition P3 (high-value) publishes price for ETH/Uniswap WETH/USDT
 * 3. Cross-chain detector reads both via stream:price-updates
 * 4. IndexedSnapshot groups prices by normalized token pair
 * 5. Cross-chain arbitrage opportunities detected across partitions
 *
 * **What's Real**:
 * - Redis Streams (via redis-memory-server)
 * - Price serialization/deserialization
 * - Token normalization for cross-chain matching
 * - Consumer group management
 *
 * @see docs/architecture/DATA_FLOW.md
 * @see docs/research/INTEGRATION_TEST_COVERAGE_REPORT.md Phase 2, Task 2.1
 * @see ADR-003: Partitioned Chain Detectors
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
} from '@arbitrage/test-utils';
import {
  PARTITION_IDS,
  normalizeTokenForCrossChain,
} from '@arbitrage/config';

// =============================================================================
// Constants
// =============================================================================

const STREAMS = {
  PRICE_UPDATES: 'stream:price-updates',
  OPPORTUNITIES: 'stream:opportunities',
} as const;

const GROUPS = {
  CROSS_CHAIN_DETECTOR: 'cross-chain-detector-group',
  PARTITION_P1: 'partition-p1-group',
  PARTITION_P3: 'partition-p3-group',
} as const;

// Partition configurations matching ADR-003
const PARTITIONS = {
  ASIA_FAST: {
    id: PARTITION_IDS.ASIA_FAST,
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: 'asia-southeast1',
  },
  HIGH_VALUE: {
    id: PARTITION_IDS.HIGH_VALUE,
    chains: ['ethereum', 'zksync', 'linea'],
    region: 'us-east1',
  },
  L2_TURBO: {
    id: PARTITION_IDS.L2_TURBO,
    chains: ['arbitrum', 'optimism', 'base'],
    region: 'asia-southeast1',
  },
} as const;

// =============================================================================
// Types
// =============================================================================

type StreamMessage = [string, string[]];
type StreamResult = [string, StreamMessage[]][] | null;

interface PriceUpdate {
  pairKey: string;
  pairAddress: string;
  dex: string;
  chain: string;
  token0: string;
  token1: string;
  price: number;
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  timestamp: number;
  partitionId: string;
}

interface CrossChainOpportunity {
  token: string;
  sourceChain: string;
  sourceDex: string;
  sourcePrice: number;
  targetChain: string;
  targetDex: string;
  targetPrice: number;
  priceDiff: number;
  percentageDiff: number;
  confidence: number;
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

/**
 * Create a price update from a partition.
 */
function createPartitionPriceUpdate(
  partitionId: string,
  chain: string,
  dex: string,
  token0: string,
  token1: string,
  price: number,
  overrides: Partial<PriceUpdate> = {}
): PriceUpdate {
  return {
    pairKey: `${dex}_${token0}_${token1}`,
    pairAddress: `0x${Math.random().toString(16).slice(2, 42)}`,
    dex,
    chain,
    token0,
    token1,
    price,
    reserve0: '1000000000000000000000',
    reserve1: (price * 1000).toString() + '000000',
    blockNumber: 18000000 + Math.floor(Math.random() * 100),
    timestamp: Date.now(),
    partitionId,
    ...overrides,
  };
}

/**
 * Normalize a token pair string for cross-chain matching.
 * Handles both formats:
 * - "TOKEN0_TOKEN1" (2 parts) -> "NORMALIZED_TOKEN0_NORMALIZED_TOKEN1"
 * - "DEX_TOKEN0_TOKEN1" (3+ parts) -> "NORMALIZED_TOKEN0_NORMALIZED_TOKEN1"
 *
 * This matches production behavior in partitioned-detector.ts:normalizeTokenPair()
 */
function normalizeTokenPair(pairKey: string): string {
  const parts = pairKey.split('_');

  // Need at least 2 parts for a valid pair
  if (parts.length < 2) return pairKey;

  // Always use last 2 parts as token0 and token1
  // For "TOKEN0_TOKEN1" -> parts.length = 2, indices are 0 and 1
  // For "DEX_TOKEN0_TOKEN1" -> parts.length = 3, indices are 1 and 2
  const token0 = normalizeTokenForCrossChain(parts[parts.length - 2]);
  const token1 = normalizeTokenForCrossChain(parts[parts.length - 1]);
  return `${token0}_${token1}`;
}

/**
 * Group price updates by normalized token pair (simulates IndexedSnapshot.byToken).
 */
function groupByNormalizedPair(
  priceUpdates: PriceUpdate[]
): Map<string, PriceUpdate[]> {
  const groups = new Map<string, PriceUpdate[]>();

  for (const update of priceUpdates) {
    const normalizedPair = normalizeTokenPair(update.pairKey);
    if (!groups.has(normalizedPair)) {
      groups.set(normalizedPair, []);
    }
    groups.get(normalizedPair)!.push(update);
  }

  return groups;
}

/**
 * Find cross-chain arbitrage opportunities from grouped prices.
 */
function findCrossChainOpportunities(
  groupedPrices: Map<string, PriceUpdate[]>,
  minProfitPercent: number = 0.5
): CrossChainOpportunity[] {
  const opportunities: CrossChainOpportunity[] = [];

  for (const [normalizedPair, updates] of groupedPrices) {
    // Need at least 2 prices from different chains
    const uniqueChains = new Set(updates.map(u => u.chain));
    if (uniqueChains.size < 2) continue;

    // Find min and max prices across chains
    let minUpdate = updates[0];
    let maxUpdate = updates[0];

    for (const update of updates) {
      if (update.price < minUpdate.price) minUpdate = update;
      if (update.price > maxUpdate.price) maxUpdate = update;
    }

    // Only consider cross-chain (different chains)
    if (minUpdate.chain === maxUpdate.chain) continue;

    const priceDiff = maxUpdate.price - minUpdate.price;
    const percentageDiff = (priceDiff / minUpdate.price) * 100;

    if (percentageDiff >= minProfitPercent) {
      const tokens = normalizedPair.split('_');
      opportunities.push({
        token: `${tokens[0]}/${tokens[1]}`,
        sourceChain: minUpdate.chain,
        sourceDex: minUpdate.dex,
        sourcePrice: minUpdate.price,
        targetChain: maxUpdate.chain,
        targetDex: maxUpdate.dex,
        targetPrice: maxUpdate.price,
        priceDiff,
        percentageDiff,
        confidence: 0.8 + (percentageDiff / 100), // Higher spread = higher confidence
      });
    }
  }

  return opportunities;
}

// =============================================================================
// Tests
// =============================================================================

describe('[Multi-Partition] Cross-Partition Price Synchronization', () => {
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
    // Generate unique test ID for each test to ensure isolation
    testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  // ===========================================================================
  // Task 2.1.1: Multi-Partition Test Setup
  // ===========================================================================

  describe('Task 2.1.1: Multi-Partition Test Harness', () => {
    it('should create isolated streams for each partition', async () => {
      const streams = {
        p1: `${STREAMS.PRICE_UPDATES}:p1:${testId}`,
        p3: `${STREAMS.PRICE_UPDATES}:p3:${testId}`,
        aggregated: `${STREAMS.PRICE_UPDATES}:all:${testId}`,
      };

      // Each partition publishes to its own stream
      const p1Update = createPartitionPriceUpdate(
        PARTITIONS.ASIA_FAST.id,
        'bsc',
        'pancakeswap',
        'WBNB',
        'USDT',
        320
      );

      const p3Update = createPartitionPriceUpdate(
        PARTITIONS.HIGH_VALUE.id,
        'ethereum',
        'uniswap_v3',
        'WETH',
        'USDT',
        2500
      );

      await redis.xadd(streams.p1, '*', 'data', JSON.stringify(p1Update));
      await redis.xadd(streams.p3, '*', 'data', JSON.stringify(p3Update));

      // Verify each stream has the correct message
      const p1Result = await redis.xread('COUNT', 10, 'STREAMS', streams.p1, '0');
      const p3Result = await redis.xread('COUNT', 10, 'STREAMS', streams.p3, '0');

      expect(p1Result).not.toBeNull();
      expect(p3Result).not.toBeNull();

      // Parse and verify partition IDs
      const p1Message = JSON.parse(parseStreamFields((p1Result as StreamResult)![0][1][0][1]).data);
      const p3Message = JSON.parse(parseStreamFields((p3Result as StreamResult)![0][1][0][1]).data);

      expect(p1Message.partitionId).toBe(PARTITIONS.ASIA_FAST.id);
      expect(p3Message.partitionId).toBe(PARTITIONS.HIGH_VALUE.id);
    });

    it('should aggregate partition streams into unified stream', async () => {
      const streams = {
        unified: `${STREAMS.PRICE_UPDATES}:unified:${testId}`,
      };

      // Simulate multiple partitions publishing to unified stream
      const partitionUpdates = [
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'WETH', 'USDT', 2490),
        createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WETH', 'USDT', 2510),
        createPartitionPriceUpdate(PARTITIONS.L2_TURBO.id, 'arbitrum', 'uniswap_v3', 'WETH', 'USDT', 2505),
      ];

      for (const update of partitionUpdates) {
        await redis.xadd(streams.unified, '*', 'data', JSON.stringify(update));
      }

      // Verify all updates are in the unified stream
      const result = await redis.xread('COUNT', 10, 'STREAMS', streams.unified, '0') as StreamResult;

      expect(result).not.toBeNull();
      expect(result![0][1].length).toBe(3);

      // Verify different partition IDs
      const partitionIds = result![0][1].map(([, fields]) => {
        const data = JSON.parse(parseStreamFields(fields).data);
        return data.partitionId;
      });

      expect(partitionIds).toContain(PARTITIONS.ASIA_FAST.id);
      expect(partitionIds).toContain(PARTITIONS.HIGH_VALUE.id);
      expect(partitionIds).toContain(PARTITIONS.L2_TURBO.id);
    });

    it('should support consumer groups for cross-chain detector', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:cg:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish prices from multiple partitions
      const updates = [
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'WETH', 'USDT', 2490),
        createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WETH', 'USDT', 2510),
      ];

      for (const update of updates) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(update));
      }

      // Cross-chain detector consumes via consumer group
      const result = await redis.xreadgroup(
        'GROUP', group, 'cross-chain-worker-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      expect(result).not.toBeNull();
      expect(result![0][1].length).toBe(2);

      // Acknowledge messages
      for (const [id] of result![0][1]) {
        await redis.xack(stream, group, id);
      }
    });
  });

  // ===========================================================================
  // Task 2.1.2: L2 Cache Propagation Tests
  // ===========================================================================

  describe('Task 2.1.2: L2 Cache Propagation', () => {
    it('should share prices across partitions via Redis cache keys', async () => {
      const cachePrefix = `price:${testId}`;

      // P1 publishes BSC price
      const bscCacheKey = `${cachePrefix}:bsc:pancakeswap:WBNB_USDT`;
      const bscPrice = { price: 320, timestamp: Date.now(), partitionId: PARTITIONS.ASIA_FAST.id };
      await redis.set(bscCacheKey, JSON.stringify(bscPrice), 'EX', 300);

      // P3 publishes ETH price
      const ethCacheKey = `${cachePrefix}:ethereum:uniswap_v3:WETH_USDT`;
      const ethPrice = { price: 2500, timestamp: Date.now(), partitionId: PARTITIONS.HIGH_VALUE.id };
      await redis.set(ethCacheKey, JSON.stringify(ethPrice), 'EX', 300);

      // Cross-chain detector can read both caches
      const bscCached = await redis.get(bscCacheKey);
      const ethCached = await redis.get(ethCacheKey);

      expect(bscCached).not.toBeNull();
      expect(ethCached).not.toBeNull();

      const parsedBsc = JSON.parse(bscCached!);
      const parsedEth = JSON.parse(ethCached!);

      expect(parsedBsc.price).toBe(320);
      expect(parsedBsc.partitionId).toBe(PARTITIONS.ASIA_FAST.id);
      expect(parsedEth.price).toBe(2500);
      expect(parsedEth.partitionId).toBe(PARTITIONS.HIGH_VALUE.id);
    });

    it('should handle cache key pattern scanning for aggregation', async () => {
      const cachePrefix = `price:scan:${testId}`;

      // Publish prices from multiple chains/DEXs
      const priceEntries = [
        { key: `${cachePrefix}:bsc:pancakeswap:WETH_USDT`, price: 2490, chain: 'bsc', partition: PARTITIONS.ASIA_FAST.id },
        { key: `${cachePrefix}:polygon:quickswap:WETH_USDT`, price: 2495, chain: 'polygon', partition: PARTITIONS.ASIA_FAST.id },
        { key: `${cachePrefix}:ethereum:uniswap_v3:WETH_USDT`, price: 2510, chain: 'ethereum', partition: PARTITIONS.HIGH_VALUE.id },
        { key: `${cachePrefix}:arbitrum:uniswap_v3:WETH_USDT`, price: 2505, chain: 'arbitrum', partition: PARTITIONS.L2_TURBO.id },
      ];

      for (const entry of priceEntries) {
        await redis.set(entry.key, JSON.stringify({
          price: entry.price,
          chain: entry.chain,
          partitionId: entry.partition,
          timestamp: Date.now(),
        }), 'EX', 300);
      }

      // Scan for all price keys matching pattern
      const keys = await redis.keys(`${cachePrefix}:*`);
      expect(keys.length).toBe(4);

      // Aggregate prices by reading all keys
      const prices: Array<{ chain: string; price: number; partition: string }> = [];
      for (const key of keys) {
        const value = await redis.get(key);
        if (value) {
          const parsed = JSON.parse(value);
          prices.push({ chain: parsed.chain, price: parsed.price, partition: parsed.partitionId });
        }
      }

      // Verify prices from all partitions
      const partitions = new Set(prices.map(p => p.partition));
      expect(partitions.size).toBe(3);
      expect(partitions.has(PARTITIONS.ASIA_FAST.id)).toBe(true);
      expect(partitions.has(PARTITIONS.HIGH_VALUE.id)).toBe(true);
      expect(partitions.has(PARTITIONS.L2_TURBO.id)).toBe(true);
    });

    it('should maintain price freshness with TTL', async () => {
      const cacheKey = `price:ttl:${testId}:bsc:pancakeswap:WETH_USDT`;

      // Set price with short TTL for testing
      await redis.set(cacheKey, JSON.stringify({
        price: 2500,
        timestamp: Date.now(),
      }), 'PX', 100); // 100ms TTL

      // Price should exist immediately
      let cached = await redis.get(cacheKey);
      expect(cached).not.toBeNull();

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Price should be expired
      cached = await redis.get(cacheKey);
      expect(cached).toBeNull();
    });
  });

  // ===========================================================================
  // Task 2.1.3: Cross-Chain Detection Tests
  // ===========================================================================

  describe('Task 2.1.3: Cross-Chain Detection via Aggregated Prices', () => {
    it('should detect cross-partition arbitrage opportunities', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:detect:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-detect-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish prices with meaningful spread across partitions
      // BSC price is lower than Ethereum price (arbitrage opportunity)
      const updates = [
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'ETH', 'USDT', 2450),
        createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WETH', 'USDT', 2510),
      ];

      for (const update of updates) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(update));
      }

      // Consume prices
      const result = await redis.xreadgroup(
        'GROUP', group, 'detector-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      // Parse price updates
      const priceUpdates: PriceUpdate[] = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data) as PriceUpdate;
      });

      // Group by normalized pair and find opportunities
      const grouped = groupByNormalizedPair(priceUpdates);
      const opportunities = findCrossChainOpportunities(grouped, 0.5);

      // Should detect the BSC->ETH arbitrage
      expect(opportunities.length).toBe(1);
      expect(opportunities[0].sourceChain).toBe('bsc');
      expect(opportunities[0].targetChain).toBe('ethereum');
      expect(opportunities[0].percentageDiff).toBeGreaterThan(2); // ~2.4%
    });

    it('should normalize token symbols for cross-chain matching', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:normalize:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-normalize-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Use chain-specific token symbols that should normalize to same token
      // Avalanche: WETH.e -> WETH
      // BSC: ETH -> WETH
      const updates = [
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'avalanche', 'traderjoe', 'WETH.e', 'USDT', 2490),
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'ETH', 'USDT', 2510),
      ];

      for (const update of updates) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(update));
      }

      // Consume and parse
      const result = await redis.xreadgroup(
        'GROUP', group, 'normalizer-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const priceUpdates: PriceUpdate[] = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data) as PriceUpdate;
      });

      // Group by normalized pair
      const grouped = groupByNormalizedPair(priceUpdates);

      // Both should be grouped under WETH_USDT
      expect(grouped.has('WETH_USDT')).toBe(true);
      expect(grouped.get('WETH_USDT')!.length).toBe(2);
    });

    it('should normalize 2-part pair keys without DEX prefix', () => {
      // Direct unit test for normalizeTokenPair edge case
      // Regression test for: 2-part keys (TOKEN0_TOKEN1) must also be normalized

      // 2-part keys: TOKEN0_TOKEN1 (no DEX prefix)
      expect(normalizeTokenPair('WETH.e_USDT')).toBe('WETH_USDT');
      expect(normalizeTokenPair('ETH_USDC')).toBe('WETH_USDC'); // ETH -> WETH

      // 3-part keys: DEX_TOKEN0_TOKEN1 (standard format)
      expect(normalizeTokenPair('uniswap_WETH.e_USDT')).toBe('WETH_USDT');
      expect(normalizeTokenPair('pancakeswap_ETH_USDC')).toBe('WETH_USDC');

      // Edge case: single part (invalid) returns unchanged
      expect(normalizeTokenPair('WETH')).toBe('WETH');
    });

    it('should handle multiple token pairs across partitions', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:multi:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-multi-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Multiple token pairs with spreads
      const updates = [
        // WETH/USDT - spread between BSC and ETH
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'ETH', 'USDT', 2450),
        createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WETH', 'USDT', 2510),
        // WBTC/USDT - spread between Polygon and Ethereum
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'polygon', 'quickswap', 'WBTC', 'USDT', 44000),
        createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WBTC', 'USDT', 44500),
        // USDC/DAI - small spread (below threshold)
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'USDC', 'DAI', 1.0001),
        createPartitionPriceUpdate(PARTITIONS.L2_TURBO.id, 'arbitrum', 'uniswap_v3', 'USDC', 'DAI', 1.0003),
      ];

      for (const update of updates) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(update));
      }

      // Consume all
      const result = await redis.xreadgroup(
        'GROUP', group, 'multi-1',
        'COUNT', 20,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const priceUpdates: PriceUpdate[] = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data) as PriceUpdate;
      });

      const grouped = groupByNormalizedPair(priceUpdates);
      const opportunities = findCrossChainOpportunities(grouped, 0.5);

      // Should detect WETH and WBTC opportunities (not USDC/DAI - too small spread)
      expect(opportunities.length).toBe(2);

      const tokens = opportunities.map(o => o.token).sort();
      expect(tokens).toContain('WBTC/USDT');
      expect(tokens).toContain('WETH/USDT');
    });

    it('should NOT detect arbitrage on same chain prices', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:samechain:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-samechain-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Both from same chain (BSC) - not cross-chain arbitrage
      const updates = [
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'WETH', 'USDT', 2450),
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'biswap', 'WETH', 'USDT', 2510),
      ];

      for (const update of updates) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(update));
      }

      const result = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const priceUpdates: PriceUpdate[] = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data) as PriceUpdate;
      });

      const grouped = groupByNormalizedPair(priceUpdates);
      const opportunities = findCrossChainOpportunities(grouped, 0.5);

      // No cross-chain opportunities (same chain)
      expect(opportunities.length).toBe(0);
    });
  });

  // ===========================================================================
  // Task 2.1.4: Partition Isolation and Failover
  // ===========================================================================

  describe('Task 2.1.4: Partition Isolation and Failover', () => {
    it('should continue aggregation when one partition fails', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:failover:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-failover-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish from P1 and P3
      const p1Update = createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'WETH', 'USDT', 2490);
      const p3Update = createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WETH', 'USDT', 2510);

      await redis.xadd(stream, '*', 'data', JSON.stringify(p1Update));
      await redis.xadd(stream, '*', 'data', JSON.stringify(p3Update));

      // Consume first batch
      const result1 = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      expect(result1![0][1].length).toBe(2);

      // Acknowledge
      for (const [id] of result1![0][1]) {
        await redis.xack(stream, group, id);
      }

      // Simulate P1 failure - only P3 continues publishing
      const p3OnlyUpdate = createPartitionPriceUpdate(
        PARTITIONS.HIGH_VALUE.id,
        'ethereum',
        'uniswap_v3',
        'WETH',
        'USDT',
        2515
      );
      await redis.xadd(stream, '*', 'data', JSON.stringify(p3OnlyUpdate));

      // Consume should still work with just P3 data
      const result2 = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      expect(result2![0][1].length).toBe(1);

      const update = JSON.parse(parseStreamFields(result2![0][1][0][1]).data);
      expect(update.partitionId).toBe(PARTITIONS.HIGH_VALUE.id);
    });

    it('should track partition health via separate health stream', async () => {
      const healthStream = `stream:health:${testId}`;
      const healthGroup = `health-monitor-${testId}`;

      await ensureConsumerGroup(redis, healthStream, healthGroup);

      // Partitions publish health updates
      const healthUpdates = [
        { partitionId: PARTITIONS.ASIA_FAST.id, status: 'healthy', chainsActive: 4, lastHeartbeat: Date.now() },
        { partitionId: PARTITIONS.HIGH_VALUE.id, status: 'healthy', chainsActive: 3, lastHeartbeat: Date.now() },
        { partitionId: PARTITIONS.L2_TURBO.id, status: 'degraded', chainsActive: 2, lastHeartbeat: Date.now() },
      ];

      for (const health of healthUpdates) {
        await redis.xadd(healthStream, '*', 'data', JSON.stringify(health));
      }

      // Monitor can read all partition health
      const result = await redis.xreadgroup(
        'GROUP', healthGroup, 'monitor-1',
        'COUNT', 10,
        'STREAMS', healthStream, '>'
      ) as StreamResult;

      expect(result![0][1].length).toBe(3);

      // Parse health statuses
      const statuses = result![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data);
      });

      expect(statuses.find((s: { partitionId: string }) => s.partitionId === PARTITIONS.L2_TURBO.id)?.status).toBe('degraded');
    });
  });

  // ===========================================================================
  // Task 2.1.5: Message Ordering and Deduplication
  // ===========================================================================

  describe('Task 2.1.5: Message Ordering and Deduplication', () => {
    it('should maintain chronological ordering across partitions', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:order:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-order-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish with explicit timestamps to test ordering
      const baseTime = Date.now();
      const updates = [
        { ...createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'WETH', 'USDT', 2500), timestamp: baseTime },
        { ...createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WETH', 'USDT', 2502), timestamp: baseTime + 10 },
        { ...createPartitionPriceUpdate(PARTITIONS.L2_TURBO.id, 'arbitrum', 'uniswap_v3', 'WETH', 'USDT', 2501), timestamp: baseTime + 5 },
      ];

      for (const update of updates) {
        await redis.xadd(stream, '*', 'data', JSON.stringify(update));
      }

      const result = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      expect(result![0][1].length).toBe(3);

      // Stream IDs should be in order of publication
      const ids = result![0][1].map(([id]) => id);
      const sortedIds = [...ids].sort();
      expect(ids).toEqual(sortedIds);
    });

    it('should handle duplicate prices gracefully', async () => {
      const stream = `${STREAMS.PRICE_UPDATES}:dedup:${testId}`;
      const oppStream = `${STREAMS.OPPORTUNITIES}:dedup:${testId}`;

      // Simulate OpportunityPublisher deduplication via cache
      const dedupCache = new Map<string, { timestamp: number; netProfit: number }>();
      const DEDUPE_WINDOW_MS = 5000;

      function shouldPublishOpportunity(
        token: string,
        netProfit: number,
        timestamp: number
      ): boolean {
        const cacheKey = token;
        const existing = dedupCache.get(cacheKey);

        if (existing) {
          // Within window
          if (timestamp - existing.timestamp < DEDUPE_WINDOW_MS) {
            // Only republish if profit improved by >10%
            if (netProfit <= existing.netProfit * 1.1) {
              return false;
            }
          }
        }

        dedupCache.set(cacheKey, { timestamp, netProfit });
        return true;
      }

      // First opportunity - should publish
      const opp1 = shouldPublishOpportunity('WETH/USDT', 50, Date.now());
      expect(opp1).toBe(true);

      // Same opportunity immediately - should NOT publish
      const opp2 = shouldPublishOpportunity('WETH/USDT', 50, Date.now() + 100);
      expect(opp2).toBe(false);

      // Same opportunity with better profit - SHOULD publish
      const opp3 = shouldPublishOpportunity('WETH/USDT', 60, Date.now() + 200);
      expect(opp3).toBe(true);

      // Different token - should publish
      const opp4 = shouldPublishOpportunity('WBTC/USDT', 100, Date.now() + 300);
      expect(opp4).toBe(true);
    });
  });

  // ===========================================================================
  // Task 2.1.6: Complete Cross-Partition Flow
  // ===========================================================================

  describe('Task 2.1.6: Complete Cross-Partition Flow', () => {
    it('should detect and publish cross-partition arbitrage opportunity', async () => {
      const priceStream = `${STREAMS.PRICE_UPDATES}:full:${testId}`;
      const oppStream = `${STREAMS.OPPORTUNITIES}:full:${testId}`;
      const priceGroup = `detector-full-${testId}`;
      const oppGroup = `coordinator-full-${testId}`;

      await ensureConsumerGroup(redis, priceStream, priceGroup);
      await ensureConsumerGroup(redis, oppStream, oppGroup);

      // STEP 1: Multiple partitions publish prices
      const priceUpdates = [
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'bsc', 'pancakeswap', 'ETH', 'USDT', 2450),
        createPartitionPriceUpdate(PARTITIONS.ASIA_FAST.id, 'polygon', 'quickswap', 'WETH', 'USDT', 2470),
        createPartitionPriceUpdate(PARTITIONS.HIGH_VALUE.id, 'ethereum', 'uniswap_v3', 'WETH', 'USDT', 2510),
        createPartitionPriceUpdate(PARTITIONS.L2_TURBO.id, 'arbitrum', 'uniswap_v3', 'WETH', 'USDT', 2500),
      ];

      for (const update of priceUpdates) {
        await redis.xadd(priceStream, '*', 'data', JSON.stringify(update));
      }

      // STEP 2: Cross-chain detector consumes prices
      const priceResult = await redis.xreadgroup(
        'GROUP', priceGroup, 'detector-1',
        'COUNT', 20,
        'STREAMS', priceStream, '>'
      ) as StreamResult;

      expect(priceResult![0][1].length).toBe(4);

      const consumedPrices: PriceUpdate[] = priceResult![0][1].map(([, fields]) => {
        return JSON.parse(parseStreamFields(fields).data) as PriceUpdate;
      });

      // STEP 3: Group and find opportunities
      const grouped = groupByNormalizedPair(consumedPrices);
      const opportunities = findCrossChainOpportunities(grouped, 0.5);

      expect(opportunities.length).toBe(1);
      expect(opportunities[0].token).toBe('WETH/USDT');
      expect(opportunities[0].sourceChain).toBe('bsc'); // Lowest price
      expect(opportunities[0].targetChain).toBe('ethereum'); // Highest price

      // STEP 4: Publish opportunity to stream
      for (const opp of opportunities) {
        await redis.xadd(oppStream, '*', 'data', JSON.stringify({
          ...opp,
          timestamp: Date.now(),
          id: `opp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }));
      }

      // STEP 5: Coordinator consumes opportunity
      const oppResult = await redis.xreadgroup(
        'GROUP', oppGroup, 'coordinator-1',
        'COUNT', 10,
        'STREAMS', oppStream, '>'
      ) as StreamResult;

      expect(oppResult![0][1].length).toBe(1);

      const receivedOpp = JSON.parse(parseStreamFields(oppResult![0][1][0][1]).data);
      expect(receivedOpp.token).toBe('WETH/USDT');
      expect(receivedOpp.sourceChain).toBe('bsc');
      expect(receivedOpp.targetChain).toBe('ethereum');
      expect(receivedOpp.percentageDiff).toBeGreaterThan(2);

      // Acknowledge all messages
      for (const [id] of priceResult![0][1]) {
        await redis.xack(priceStream, priceGroup, id);
      }
      await redis.xack(oppStream, oppGroup, oppResult![0][1][0][0]);
    });
  });
});
