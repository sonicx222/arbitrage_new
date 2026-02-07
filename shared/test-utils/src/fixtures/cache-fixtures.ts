/**
 * Cache Test Fixtures
 *
 * Provides realistic cache states and test data for cache integration tests.
 * Supports creating various cache scenarios: cold, warm, hot, full, high-eviction, etc.
 */

import { CacheMetrics } from '../types/cache-types';

export interface CacheStateConfig {
  l1Entries?: number;
  l2Entries?: number;
  hitRate?: number;
  evictionRate?: number;
  memoryUsageMB?: number;
}

export interface PriceUpdate {
  key: string;
  price: number;
  reserve0: string;
  reserve1: string;
  timestamp: number;
  blockNumber: number;
}

/**
 * Cache Fixtures for test scenarios
 */
export const CacheFixtures = {
  /**
   * Cold cache - no entries, starting state
   */
  coldCache: (): CacheStateConfig => ({
    l1Entries: 0,
    l2Entries: 0,
    hitRate: 0,
    evictionRate: 0,
    memoryUsageMB: 0,
  }),

  /**
   * Warm cache - partial population, typical startup state
   */
  warmCache: (): CacheStateConfig => ({
    l1Entries: 500,
    l2Entries: 2000,
    hitRate: 75,
    evictionRate: 0.5,
    memoryUsageMB: 8,
  }),

  /**
   * Hot cache - well-populated, production steady state
   */
  hotCache: (): CacheStateConfig => ({
    l1Entries: 1000,
    l2Entries: 5000,
    hitRate: 97,
    evictionRate: 0.2,
    memoryUsageMB: 16,
  }),

  /**
   * Full L1 cache - at capacity, high eviction pressure
   */
  fullL1Cache: (): CacheStateConfig => ({
    l1Entries: 1000, // maxPairs
    l2Entries: 10000,
    hitRate: 85,
    evictionRate: 5,
    memoryUsageMB: 64,
  }),

  /**
   * High eviction scenario - cache thrashing
   */
  highEvictionRate: (): CacheStateConfig => ({
    l1Entries: 900,
    l2Entries: 15000,
    hitRate: 60,
    evictionRate: 15,
    memoryUsageMB: 60,
  }),

  /**
   * Generate realistic price updates
   */
  priceUpdates: (count: number, chainId: string = 'bsc'): PriceUpdate[] => {
    const updates: PriceUpdate[] = [];
    const baseTimestamp = Date.now();

    for (let i = 0; i < count; i++) {
      const pairAddress = generatePairAddress(i);
      updates.push({
        key: `price:${chainId}:${pairAddress}`,
        price: 100 + Math.random() * 1000,
        reserve0: (BigInt(1000000) * BigInt(Math.floor(Math.random() * 1000))).toString(),
        reserve1: (BigInt(2000000) * BigInt(Math.floor(Math.random() * 1000))).toString(),
        timestamp: baseTimestamp + i * 1000, // 1 second apart
        blockNumber: 1000000 + i,
      });
    }

    return updates;
  },

  /**
   * Generate batch price updates (for batch processing tests)
   */
  batchPriceUpdates: (batches: number, batchSize: number, chainId: string = 'bsc'): PriceUpdate[][] => {
    const allBatches: PriceUpdate[][] = [];

    for (let b = 0; b < batches; b++) {
      allBatches.push(
        CacheFixtures.priceUpdates(batchSize, chainId)
      );
    }

    return allBatches;
  },

  /**
   * Generate price updates for specific pairs (deterministic)
   */
  specificPairUpdates: (pairAddresses: string[], chainId: string = 'bsc'): PriceUpdate[] => {
    const baseTimestamp = Date.now();

    return pairAddresses.map((address, i) => ({
      key: `price:${chainId}:${address.toLowerCase()}`,
      price: 100 + Math.random() * 1000,
      reserve0: (BigInt(1000000) * BigInt(Math.floor(Math.random() * 1000))).toString(),
      reserve1: (BigInt(2000000) * BigInt(Math.floor(Math.random() * 1000))).toString(),
      timestamp: baseTimestamp + i * 1000,
      blockNumber: 1000000 + i,
    }));
  },

  /**
   * Generate high-frequency price updates (same pairs, rapid updates)
   */
  highFrequencyUpdates: (pairCount: number, updatesPerPair: number, chainId: string = 'bsc'): PriceUpdate[] => {
    const updates: PriceUpdate[] = [];
    const baseTimestamp = Date.now();
    const pairAddresses = Array.from({ length: pairCount }, (_, i) => generatePairAddress(i));

    for (let u = 0; u < updatesPerPair; u++) {
      for (let p = 0; p < pairCount; p++) {
        updates.push({
          key: `price:${chainId}:${pairAddresses[p]}`,
          price: 100 + Math.random() * 1000,
          reserve0: (BigInt(1000000) * BigInt(Math.floor(Math.random() * 1000))).toString(),
          reserve1: (BigInt(2000000) * BigInt(Math.floor(Math.random() * 1000))).toString(),
          timestamp: baseTimestamp + (u * pairCount + p) * 100, // 100ms apart
          blockNumber: 1000000 + u * pairCount + p,
        });
      }
    }

    return updates;
  },

  /**
   * Generate cache metrics snapshot
   */
  metricsSnapshot: (config: CacheStateConfig): CacheMetrics => ({
    l1: {
      size: config.l1Entries || 0,
      hits: Math.floor((config.l1Entries || 0) * (config.hitRate || 0) / 100),
      misses: Math.floor((config.l1Entries || 0) * (1 - (config.hitRate || 0) / 100)),
      evictions: Math.floor((config.evictionRate || 0) * (config.l1Entries || 0) / 100),
      hitRate: (config.hitRate || 0) / 100,
    },
    l2: {
      size: config.l2Entries || 0,
      hits: 0,
      misses: 0,
    },
    memoryUsageMB: config.memoryUsageMB || 0,
  }),
};

/**
 * Helper: Generate deterministic pair address
 */
function generatePairAddress(index: number): string {
  const hex = index.toString(16).padStart(40, '0');
  return `0x${hex}`;
}

/**
 * Helper: Generate random pair address
 */
export function randomPairAddress(): string {
  const hex = Math.floor(Math.random() * 0xFFFFFFFFFFFF).toString(16).padStart(40, '0');
  return `0x${hex}`;
}
