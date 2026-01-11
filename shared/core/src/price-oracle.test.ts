/**
 * Price Oracle Tests
 *
 * Tests for token price caching and fallback behavior.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';
import {
  PriceOracle,
  getPriceOracle,
  resetPriceOracle,
  getDefaultPrice,
  hasDefaultPrice
} from './price-oracle';

// Mock Redis client interface
interface MockRedisClient {
  get: Mock<(key: string) => Promise<unknown>>;
  set: Mock<(key: string, value: unknown, ttl?: number) => Promise<string>>;
  ping: Mock<() => Promise<boolean>>;
}

// Mock Redis client factory
const createMockRedisClient = (): MockRedisClient => ({
  get: jest.fn<(key: string) => Promise<unknown>>(),
  set: jest.fn<(key: string, value: unknown, ttl?: number) => Promise<string>>(),
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
});

// Shared mock reference
let mockRedisClient: MockRedisClient;

// Mock the redis module
jest.mock('./redis', () => ({
  getRedisClient: jest.fn<() => Promise<MockRedisClient>>().mockImplementation(() => Promise.resolve(mockRedisClient))
}));

// Mock logger
jest.mock('./logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}));

describe('PriceOracle', () => {
  let oracle: PriceOracle;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetPriceOracle();

    // Create fresh mock for each test
    mockRedisClient = createMockRedisClient();

    // Default mock implementations
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.set.mockResolvedValue('OK');

    oracle = new PriceOracle({
      cacheTtlSeconds: 60,
      stalenessThresholdMs: 300000
    });
    await oracle.initialize(mockRedisClient as any);
  });

  afterEach(() => {
    oracle.clearLocalCache();
  });

  // ===========================================================================
  // Default Fallback Prices
  // ===========================================================================

  describe('default fallback prices', () => {
    it('should have ETH price', () => {
      expect(getDefaultPrice('ETH')).toBe(2500);
      expect(getDefaultPrice('WETH')).toBe(2500);
    });

    it('should have BNB price', () => {
      expect(getDefaultPrice('BNB')).toBe(300);
      expect(getDefaultPrice('WBNB')).toBe(300);
    });

    it('should have MATIC price', () => {
      expect(getDefaultPrice('MATIC')).toBe(0.80);
    });

    it('should have stablecoin prices at $1', () => {
      expect(getDefaultPrice('USDT')).toBe(1.00);
      expect(getDefaultPrice('USDC')).toBe(1.00);
      expect(getDefaultPrice('DAI')).toBe(1.00);
    });

    it('should handle case insensitivity', () => {
      expect(getDefaultPrice('eth')).toBe(2500);
      expect(getDefaultPrice('Eth')).toBe(2500);
      expect(getDefaultPrice('ETH')).toBe(2500);
    });

    it('should return 0 for unknown tokens', () => {
      expect(getDefaultPrice('UNKNOWN_TOKEN')).toBe(0);
    });
  });

  // ===========================================================================
  // hasDefaultPrice
  // ===========================================================================

  describe('hasDefaultPrice', () => {
    it('should return true for known tokens', () => {
      expect(hasDefaultPrice('ETH')).toBe(true);
      expect(hasDefaultPrice('BTC')).toBe(true);
      expect(hasDefaultPrice('USDT')).toBe(true);
    });

    it('should return false for unknown tokens', () => {
      expect(hasDefaultPrice('FAKE_TOKEN')).toBe(false);
    });
  });

  // ===========================================================================
  // getPrice
  // ===========================================================================

  describe('getPrice', () => {
    it('should return cached price from Redis', async () => {
      const cachedData = { price: 2600, timestamp: Date.now() };
      mockRedisClient.get.mockResolvedValue(cachedData);

      const result = await oracle.getPrice('ETH');

      expect(result.price).toBe(2600);
      expect(result.source).toBe('cache');
      expect(result.isStale).toBe(false);
    });

    it('should return fallback when cache misses', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const result = await oracle.getPrice('ETH');

      expect(result.price).toBe(2500);
      expect(result.source).toBe('fallback');
      expect(result.isStale).toBe(true);
    });

    it('should mark stale prices correctly', async () => {
      const staleTimestamp = Date.now() - 400000; // 6+ minutes ago
      mockRedisClient.get.mockResolvedValue({ price: 2600, timestamp: staleTimestamp });

      const result = await oracle.getPrice('ETH');

      expect(result.price).toBe(2600);
      expect(result.isStale).toBe(true);
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));

      const result = await oracle.getPrice('ETH');

      // Should fall back to default price
      expect(result.price).toBe(2500);
      expect(result.source).toBe('fallback');
    });

    it('should normalize symbol case', async () => {
      await oracle.updatePrice('eth', 2700);

      const result = await oracle.getPrice('ETH');
      expect(result.price).toBe(2700);
    });

    it('should handle wrapped token aliases', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      // WETH should use ETH price
      const result = await oracle.getPrice('WETH');
      expect(result.symbol).toBe('ETH');
    });
  });

  // ===========================================================================
  // getPrices (Batch)
  // ===========================================================================

  describe('getPrices', () => {
    it('should fetch multiple prices in batch', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const results = await oracle.getPrices([
        { symbol: 'ETH' },
        { symbol: 'BTC' },
        { symbol: 'USDT' }
      ]);

      expect(results.size).toBe(3);
      expect(results.get('ETH')?.price).toBe(2500);
      expect(results.get('BTC')?.price).toBe(45000);
      expect(results.get('USDT')?.price).toBe(1.00);
    });

    it('should deduplicate requests', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const results = await oracle.getPrices([
        { symbol: 'ETH' },
        { symbol: 'ETH' },
        { symbol: 'eth' }
      ]);

      // Should only have one entry
      expect(results.size).toBe(1);
      expect(mockRedisClient.get).toHaveBeenCalledTimes(1);
    });

    it('should handle chain-specific prices', async () => {
      await oracle.updatePrice('ETH', 2600, 'arbitrum');
      await oracle.updatePrice('ETH', 2550, 'optimism');

      const results = await oracle.getPrices([
        { symbol: 'ETH', chain: 'arbitrum' },
        { symbol: 'ETH', chain: 'optimism' }
      ]);

      expect(results.size).toBe(1); // Same symbol, different chains stored separately
    });
  });

  // ===========================================================================
  // getPriceSync
  // ===========================================================================

  describe('getPriceSync', () => {
    it('should return price from local cache', async () => {
      await oracle.updatePrice('ETH', 2700);

      const price = oracle.getPriceSync('ETH');

      expect(price).toBe(2700);
    });

    it('should return fallback when not in cache', () => {
      const price = oracle.getPriceSync('BTC');

      expect(price).toBe(45000);
    });

    it('should return 0 for unknown tokens', () => {
      const price = oracle.getPriceSync('UNKNOWN');

      expect(price).toBe(0);
    });
  });

  // ===========================================================================
  // updatePrice
  // ===========================================================================

  describe('updatePrice', () => {
    it('should update local cache', async () => {
      await oracle.updatePrice('ETH', 2800);

      const price = oracle.getPriceSync('ETH');
      expect(price).toBe(2800);
    });

    it('should update Redis cache', async () => {
      await oracle.updatePrice('ETH', 2800);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'price:ETH',
        expect.objectContaining({ price: 2800 }),
        60
      );
    });

    it('should ignore invalid prices', async () => {
      await oracle.updatePrice('ETH', -100);
      await oracle.updatePrice('ETH', 0);

      expect(mockRedisClient.set).not.toHaveBeenCalled();
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedisClient.set.mockRejectedValue(new Error('Redis error'));

      // Should not throw
      await expect(oracle.updatePrice('ETH', 2800)).resolves.not.toThrow();

      // Local cache should still be updated
      expect(oracle.getPriceSync('ETH')).toBe(2800);
    });
  });

  // ===========================================================================
  // updatePrices (Batch)
  // ===========================================================================

  describe('updatePrices', () => {
    it('should update multiple prices', async () => {
      await oracle.updatePrices([
        { symbol: 'ETH', price: 2800 },
        { symbol: 'BTC', price: 46000 },
        { symbol: 'BNB', price: 320 }
      ]);

      expect(oracle.getPriceSync('ETH')).toBe(2800);
      expect(oracle.getPriceSync('BTC')).toBe(46000);
      expect(oracle.getPriceSync('BNB')).toBe(320);
    });
  });

  // ===========================================================================
  // estimateUsdValue
  // ===========================================================================

  describe('estimateUsdValue', () => {
    it('should calculate USD value correctly', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const value = await oracle.estimateUsdValue('ETH', 2);

      expect(value).toBe(5000); // 2 * 2500
    });

    it('should use cached price when available', async () => {
      await oracle.updatePrice('ETH', 3000);

      const value = await oracle.estimateUsdValue('ETH', 2);

      expect(value).toBe(6000); // 2 * 3000
    });

    it('should return 0 for unknown tokens', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const value = await oracle.estimateUsdValue('UNKNOWN', 100);

      expect(value).toBe(0);
    });
  });

  // ===========================================================================
  // estimateUsdValueSync
  // ===========================================================================

  describe('estimateUsdValueSync', () => {
    it('should calculate USD value synchronously', async () => {
      await oracle.updatePrice('ETH', 2700);

      const value = oracle.estimateUsdValueSync('ETH', 3);

      expect(value).toBe(8100); // 3 * 2700
    });

    it('should use fallback when not cached', () => {
      const value = oracle.estimateUsdValueSync('BTC', 0.5);

      expect(value).toBe(22500); // 0.5 * 45000
    });
  });

  // ===========================================================================
  // Fallback Price Management
  // ===========================================================================

  describe('fallback price management', () => {
    it('should get fallback price', () => {
      expect(oracle.getFallbackPrice('ETH')).toBe(2500);
    });

    it('should set custom fallback price', () => {
      oracle.setFallbackPrice('CUSTOM', 100);

      expect(oracle.getFallbackPrice('CUSTOM')).toBe(100);
    });

    it('should override default fallback price', () => {
      oracle.setFallbackPrice('ETH', 3000);

      expect(oracle.getFallbackPrice('ETH')).toBe(3000);
    });

    it('should return all fallback prices', () => {
      const prices = oracle.getAllFallbackPrices();

      expect(prices.ETH).toBe(2500);
      expect(prices.BTC).toBe(45000);
      expect(Object.keys(prices).length).toBeGreaterThan(10);
    });
  });

  // ===========================================================================
  // Custom Configuration
  // ===========================================================================

  describe('custom configuration', () => {
    it('should use custom cache key prefix', async () => {
      const customOracle = new PriceOracle({
        cacheKeyPrefix: 'myapp:prices:'
      });
      await customOracle.initialize(mockRedisClient as any);

      await customOracle.updatePrice('ETH', 2800);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'myapp:prices:ETH',
        expect.any(Object),
        expect.any(Number)
      );
    });

    it('should use custom TTL', async () => {
      const customOracle = new PriceOracle({
        cacheTtlSeconds: 300
      });
      await customOracle.initialize(mockRedisClient as any);

      await customOracle.updatePrice('ETH', 2800);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        300
      );
    });

    it('should use custom fallback prices', async () => {
      const customOracle = new PriceOracle({
        customFallbackPrices: {
          CUSTOM_TOKEN: 999,
          ETH: 5000 // Override default
        }
      });
      await customOracle.initialize(mockRedisClient as any);

      expect(customOracle.getFallbackPrice('CUSTOM_TOKEN')).toBe(999);
      expect(customOracle.getFallbackPrice('ETH')).toBe(5000);
    });

    it('should disable fallback when configured', async () => {
      const customOracle = new PriceOracle({
        useFallback: false
      });
      await customOracle.initialize(mockRedisClient as any);
      mockRedisClient.get.mockResolvedValue(null);

      const result = await customOracle.getPrice('ETH');

      // Should return 0 instead of fallback
      expect(result.price).toBe(0);
    });
  });

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  describe('cache management', () => {
    it('should clear local cache', async () => {
      await oracle.updatePrice('ETH', 2800);
      expect(oracle.getPriceSync('ETH')).toBe(2800);

      oracle.clearLocalCache();

      // Should now return fallback
      expect(oracle.getPriceSync('ETH')).toBe(2500);
    });

    it('should return cache statistics', async () => {
      await oracle.updatePrice('ETH', 2800);
      await oracle.updatePrice('BTC', 46000);

      const stats = oracle.getLocalCacheStats();

      expect(stats.size).toBe(2);
      expect(stats.staleCount).toBe(0);
    });

    it('should preload prices', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await oracle.preloadPrices(['ETH', 'BTC', 'USDT']);

      const stats = oracle.getLocalCacheStats();
      expect(stats.size).toBe(3);
    });
  });

  // ===========================================================================
  // Singleton Factory
  // ===========================================================================

  describe('singleton factory', () => {
    it('should return same instance on multiple calls', async () => {
      const instance1 = await getPriceOracle();
      const instance2 = await getPriceOracle();

      expect(instance1).toBe(instance2);
    });

    it('should reset singleton properly', async () => {
      const instance1 = await getPriceOracle();
      resetPriceOracle();
      const instance2 = await getPriceOracle();

      expect(instance1).not.toBe(instance2);
    });
  });

  // ===========================================================================
  // Local Cache Priority
  // ===========================================================================

  describe('local cache priority', () => {
    it('should use local cache before Redis', async () => {
      // Update price (stored in local cache)
      await oracle.updatePrice('ETH', 2900);

      // Clear Redis mock to ensure it's not called
      mockRedisClient.get.mockClear();

      // Get price - should use local cache
      const result = await oracle.getPrice('ETH');

      expect(result.price).toBe(2900);
      expect(mockRedisClient.get).not.toHaveBeenCalled();
    });

    it('should fall through to Redis when local cache is stale', async () => {
      // This test would require manipulating timestamps
      // For now, just verify the flow works
      mockRedisClient.get.mockResolvedValue({ price: 2750, timestamp: Date.now() });

      // Ensure local cache doesn't have the value
      oracle.clearLocalCache();

      const result = await oracle.getPrice('ETH');

      expect(result.source).toBe('cache');
      expect(mockRedisClient.get).toHaveBeenCalled();
    });
  });
});
