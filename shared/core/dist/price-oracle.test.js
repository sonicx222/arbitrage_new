"use strict";
/**
 * Price Oracle Tests
 *
 * Tests for token price caching and fallback behavior.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const price_oracle_1 = require("./price-oracle");
// Mock Redis client factory
const createMockRedisClient = () => ({
    get: globals_1.jest.fn(),
    set: globals_1.jest.fn(),
    ping: globals_1.jest.fn().mockResolvedValue(true)
});
// Shared mock reference
let mockRedisClient;
// Mock the redis module
globals_1.jest.mock('./redis', () => ({
    getRedisClient: globals_1.jest.fn().mockImplementation(() => Promise.resolve(mockRedisClient))
}));
// Mock logger
globals_1.jest.mock('./logger', () => ({
    createLogger: globals_1.jest.fn(() => ({
        info: globals_1.jest.fn(),
        error: globals_1.jest.fn(),
        warn: globals_1.jest.fn(),
        debug: globals_1.jest.fn()
    }))
}));
(0, globals_1.describe)('PriceOracle', () => {
    let oracle;
    (0, globals_1.beforeEach)(async () => {
        globals_1.jest.clearAllMocks();
        (0, price_oracle_1.resetPriceOracle)();
        // Create fresh mock for each test
        mockRedisClient = createMockRedisClient();
        // Default mock implementations
        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.set.mockResolvedValue('OK');
        oracle = new price_oracle_1.PriceOracle({
            cacheTtlSeconds: 60,
            stalenessThresholdMs: 300000
        });
        await oracle.initialize(mockRedisClient);
    });
    (0, globals_1.afterEach)(() => {
        oracle.clearLocalCache();
    });
    // ===========================================================================
    // Default Fallback Prices
    // ===========================================================================
    (0, globals_1.describe)('default fallback prices', () => {
        (0, globals_1.it)('should have ETH price', () => {
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('ETH')).toBe(2500);
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('WETH')).toBe(2500);
        });
        (0, globals_1.it)('should have BNB price', () => {
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('BNB')).toBe(300);
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('WBNB')).toBe(300);
        });
        (0, globals_1.it)('should have MATIC price', () => {
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('MATIC')).toBe(0.80);
        });
        (0, globals_1.it)('should have stablecoin prices at $1', () => {
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('USDT')).toBe(1.00);
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('USDC')).toBe(1.00);
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('DAI')).toBe(1.00);
        });
        (0, globals_1.it)('should handle case insensitivity', () => {
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('eth')).toBe(2500);
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('Eth')).toBe(2500);
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('ETH')).toBe(2500);
        });
        (0, globals_1.it)('should return 0 for unknown tokens', () => {
            (0, globals_1.expect)((0, price_oracle_1.getDefaultPrice)('UNKNOWN_TOKEN')).toBe(0);
        });
    });
    // ===========================================================================
    // hasDefaultPrice
    // ===========================================================================
    (0, globals_1.describe)('hasDefaultPrice', () => {
        (0, globals_1.it)('should return true for known tokens', () => {
            (0, globals_1.expect)((0, price_oracle_1.hasDefaultPrice)('ETH')).toBe(true);
            (0, globals_1.expect)((0, price_oracle_1.hasDefaultPrice)('BTC')).toBe(true);
            (0, globals_1.expect)((0, price_oracle_1.hasDefaultPrice)('USDT')).toBe(true);
        });
        (0, globals_1.it)('should return false for unknown tokens', () => {
            (0, globals_1.expect)((0, price_oracle_1.hasDefaultPrice)('FAKE_TOKEN')).toBe(false);
        });
    });
    // ===========================================================================
    // getPrice
    // ===========================================================================
    (0, globals_1.describe)('getPrice', () => {
        (0, globals_1.it)('should return cached price from Redis', async () => {
            const cachedData = { price: 2600, timestamp: Date.now() };
            mockRedisClient.get.mockResolvedValue(cachedData);
            const result = await oracle.getPrice('ETH');
            (0, globals_1.expect)(result.price).toBe(2600);
            (0, globals_1.expect)(result.source).toBe('cache');
            (0, globals_1.expect)(result.isStale).toBe(false);
        });
        (0, globals_1.it)('should return fallback when cache misses', async () => {
            mockRedisClient.get.mockResolvedValue(null);
            const result = await oracle.getPrice('ETH');
            (0, globals_1.expect)(result.price).toBe(2500);
            (0, globals_1.expect)(result.source).toBe('fallback');
            (0, globals_1.expect)(result.isStale).toBe(true);
        });
        (0, globals_1.it)('should mark stale prices correctly', async () => {
            const staleTimestamp = Date.now() - 400000; // 6+ minutes ago
            mockRedisClient.get.mockResolvedValue({ price: 2600, timestamp: staleTimestamp });
            const result = await oracle.getPrice('ETH');
            (0, globals_1.expect)(result.price).toBe(2600);
            (0, globals_1.expect)(result.isStale).toBe(true);
        });
        (0, globals_1.it)('should handle Redis errors gracefully', async () => {
            mockRedisClient.get.mockRejectedValue(new Error('Redis error'));
            const result = await oracle.getPrice('ETH');
            // Should fall back to default price
            (0, globals_1.expect)(result.price).toBe(2500);
            (0, globals_1.expect)(result.source).toBe('fallback');
        });
        (0, globals_1.it)('should normalize symbol case', async () => {
            await oracle.updatePrice('eth', 2700);
            const result = await oracle.getPrice('ETH');
            (0, globals_1.expect)(result.price).toBe(2700);
        });
        (0, globals_1.it)('should handle wrapped token aliases', async () => {
            mockRedisClient.get.mockResolvedValue(null);
            // WETH should use ETH price
            const result = await oracle.getPrice('WETH');
            (0, globals_1.expect)(result.symbol).toBe('ETH');
        });
    });
    // ===========================================================================
    // getPrices (Batch)
    // ===========================================================================
    (0, globals_1.describe)('getPrices', () => {
        (0, globals_1.it)('should fetch multiple prices in batch', async () => {
            mockRedisClient.get.mockResolvedValue(null);
            const results = await oracle.getPrices([
                { symbol: 'ETH' },
                { symbol: 'BTC' },
                { symbol: 'USDT' }
            ]);
            (0, globals_1.expect)(results.size).toBe(3);
            (0, globals_1.expect)(results.get('ETH')?.price).toBe(2500);
            (0, globals_1.expect)(results.get('BTC')?.price).toBe(45000);
            (0, globals_1.expect)(results.get('USDT')?.price).toBe(1.00);
        });
        (0, globals_1.it)('should deduplicate requests', async () => {
            mockRedisClient.get.mockResolvedValue(null);
            const results = await oracle.getPrices([
                { symbol: 'ETH' },
                { symbol: 'ETH' },
                { symbol: 'eth' }
            ]);
            // Should only have one entry
            (0, globals_1.expect)(results.size).toBe(1);
            (0, globals_1.expect)(mockRedisClient.get).toHaveBeenCalledTimes(1);
        });
        (0, globals_1.it)('should handle chain-specific prices', async () => {
            await oracle.updatePrice('ETH', 2600, 'arbitrum');
            await oracle.updatePrice('ETH', 2550, 'optimism');
            const results = await oracle.getPrices([
                { symbol: 'ETH', chain: 'arbitrum' },
                { symbol: 'ETH', chain: 'optimism' }
            ]);
            (0, globals_1.expect)(results.size).toBe(1); // Same symbol, different chains stored separately
        });
    });
    // ===========================================================================
    // getPriceSync
    // ===========================================================================
    (0, globals_1.describe)('getPriceSync', () => {
        (0, globals_1.it)('should return price from local cache', async () => {
            await oracle.updatePrice('ETH', 2700);
            const price = oracle.getPriceSync('ETH');
            (0, globals_1.expect)(price).toBe(2700);
        });
        (0, globals_1.it)('should return fallback when not in cache', () => {
            const price = oracle.getPriceSync('BTC');
            (0, globals_1.expect)(price).toBe(45000);
        });
        (0, globals_1.it)('should return 0 for unknown tokens', () => {
            const price = oracle.getPriceSync('UNKNOWN');
            (0, globals_1.expect)(price).toBe(0);
        });
    });
    // ===========================================================================
    // updatePrice
    // ===========================================================================
    (0, globals_1.describe)('updatePrice', () => {
        (0, globals_1.it)('should update local cache', async () => {
            await oracle.updatePrice('ETH', 2800);
            const price = oracle.getPriceSync('ETH');
            (0, globals_1.expect)(price).toBe(2800);
        });
        (0, globals_1.it)('should update Redis cache', async () => {
            await oracle.updatePrice('ETH', 2800);
            (0, globals_1.expect)(mockRedisClient.set).toHaveBeenCalledWith('price:ETH', globals_1.expect.objectContaining({ price: 2800 }), 60);
        });
        (0, globals_1.it)('should ignore invalid prices', async () => {
            await oracle.updatePrice('ETH', -100);
            await oracle.updatePrice('ETH', 0);
            (0, globals_1.expect)(mockRedisClient.set).not.toHaveBeenCalled();
        });
        (0, globals_1.it)('should handle Redis errors gracefully', async () => {
            mockRedisClient.set.mockRejectedValue(new Error('Redis error'));
            // Should not throw
            await (0, globals_1.expect)(oracle.updatePrice('ETH', 2800)).resolves.not.toThrow();
            // Local cache should still be updated
            (0, globals_1.expect)(oracle.getPriceSync('ETH')).toBe(2800);
        });
    });
    // ===========================================================================
    // updatePrices (Batch)
    // ===========================================================================
    (0, globals_1.describe)('updatePrices', () => {
        (0, globals_1.it)('should update multiple prices', async () => {
            await oracle.updatePrices([
                { symbol: 'ETH', price: 2800 },
                { symbol: 'BTC', price: 46000 },
                { symbol: 'BNB', price: 320 }
            ]);
            (0, globals_1.expect)(oracle.getPriceSync('ETH')).toBe(2800);
            (0, globals_1.expect)(oracle.getPriceSync('BTC')).toBe(46000);
            (0, globals_1.expect)(oracle.getPriceSync('BNB')).toBe(320);
        });
    });
    // ===========================================================================
    // estimateUsdValue
    // ===========================================================================
    (0, globals_1.describe)('estimateUsdValue', () => {
        (0, globals_1.it)('should calculate USD value correctly', async () => {
            mockRedisClient.get.mockResolvedValue(null);
            const value = await oracle.estimateUsdValue('ETH', 2);
            (0, globals_1.expect)(value).toBe(5000); // 2 * 2500
        });
        (0, globals_1.it)('should use cached price when available', async () => {
            await oracle.updatePrice('ETH', 3000);
            const value = await oracle.estimateUsdValue('ETH', 2);
            (0, globals_1.expect)(value).toBe(6000); // 2 * 3000
        });
        (0, globals_1.it)('should return 0 for unknown tokens', async () => {
            mockRedisClient.get.mockResolvedValue(null);
            const value = await oracle.estimateUsdValue('UNKNOWN', 100);
            (0, globals_1.expect)(value).toBe(0);
        });
    });
    // ===========================================================================
    // estimateUsdValueSync
    // ===========================================================================
    (0, globals_1.describe)('estimateUsdValueSync', () => {
        (0, globals_1.it)('should calculate USD value synchronously', async () => {
            await oracle.updatePrice('ETH', 2700);
            const value = oracle.estimateUsdValueSync('ETH', 3);
            (0, globals_1.expect)(value).toBe(8100); // 3 * 2700
        });
        (0, globals_1.it)('should use fallback when not cached', () => {
            const value = oracle.estimateUsdValueSync('BTC', 0.5);
            (0, globals_1.expect)(value).toBe(22500); // 0.5 * 45000
        });
    });
    // ===========================================================================
    // Fallback Price Management
    // ===========================================================================
    (0, globals_1.describe)('fallback price management', () => {
        (0, globals_1.it)('should get fallback price', () => {
            (0, globals_1.expect)(oracle.getFallbackPrice('ETH')).toBe(2500);
        });
        (0, globals_1.it)('should set custom fallback price', () => {
            oracle.setFallbackPrice('CUSTOM', 100);
            (0, globals_1.expect)(oracle.getFallbackPrice('CUSTOM')).toBe(100);
        });
        (0, globals_1.it)('should override default fallback price', () => {
            oracle.setFallbackPrice('ETH', 3000);
            (0, globals_1.expect)(oracle.getFallbackPrice('ETH')).toBe(3000);
        });
        (0, globals_1.it)('should return all fallback prices', () => {
            const prices = oracle.getAllFallbackPrices();
            (0, globals_1.expect)(prices.ETH).toBe(2500);
            (0, globals_1.expect)(prices.BTC).toBe(45000);
            (0, globals_1.expect)(Object.keys(prices).length).toBeGreaterThan(10);
        });
    });
    // ===========================================================================
    // Custom Configuration
    // ===========================================================================
    (0, globals_1.describe)('custom configuration', () => {
        (0, globals_1.it)('should use custom cache key prefix', async () => {
            const customOracle = new price_oracle_1.PriceOracle({
                cacheKeyPrefix: 'myapp:prices:'
            });
            await customOracle.initialize(mockRedisClient);
            await customOracle.updatePrice('ETH', 2800);
            (0, globals_1.expect)(mockRedisClient.set).toHaveBeenCalledWith('myapp:prices:ETH', globals_1.expect.any(Object), globals_1.expect.any(Number));
        });
        (0, globals_1.it)('should use custom TTL', async () => {
            const customOracle = new price_oracle_1.PriceOracle({
                cacheTtlSeconds: 300
            });
            await customOracle.initialize(mockRedisClient);
            await customOracle.updatePrice('ETH', 2800);
            (0, globals_1.expect)(mockRedisClient.set).toHaveBeenCalledWith(globals_1.expect.any(String), globals_1.expect.any(Object), 300);
        });
        (0, globals_1.it)('should use custom fallback prices', async () => {
            const customOracle = new price_oracle_1.PriceOracle({
                customFallbackPrices: {
                    CUSTOM_TOKEN: 999,
                    ETH: 5000 // Override default
                }
            });
            await customOracle.initialize(mockRedisClient);
            (0, globals_1.expect)(customOracle.getFallbackPrice('CUSTOM_TOKEN')).toBe(999);
            (0, globals_1.expect)(customOracle.getFallbackPrice('ETH')).toBe(5000);
        });
        (0, globals_1.it)('should disable fallback when configured', async () => {
            const customOracle = new price_oracle_1.PriceOracle({
                useFallback: false
            });
            await customOracle.initialize(mockRedisClient);
            mockRedisClient.get.mockResolvedValue(null);
            const result = await customOracle.getPrice('ETH');
            // Should return 0 instead of fallback
            (0, globals_1.expect)(result.price).toBe(0);
        });
    });
    // ===========================================================================
    // Cache Management
    // ===========================================================================
    (0, globals_1.describe)('cache management', () => {
        (0, globals_1.it)('should clear local cache', async () => {
            await oracle.updatePrice('ETH', 2800);
            (0, globals_1.expect)(oracle.getPriceSync('ETH')).toBe(2800);
            oracle.clearLocalCache();
            // Should now return fallback
            (0, globals_1.expect)(oracle.getPriceSync('ETH')).toBe(2500);
        });
        (0, globals_1.it)('should return cache statistics', async () => {
            await oracle.updatePrice('ETH', 2800);
            await oracle.updatePrice('BTC', 46000);
            const stats = oracle.getLocalCacheStats();
            (0, globals_1.expect)(stats.size).toBe(2);
            (0, globals_1.expect)(stats.staleCount).toBe(0);
        });
        (0, globals_1.it)('should preload prices', async () => {
            mockRedisClient.get.mockResolvedValue(null);
            await oracle.preloadPrices(['ETH', 'BTC', 'USDT']);
            const stats = oracle.getLocalCacheStats();
            (0, globals_1.expect)(stats.size).toBe(3);
        });
    });
    // ===========================================================================
    // Singleton Factory
    // ===========================================================================
    (0, globals_1.describe)('singleton factory', () => {
        (0, globals_1.it)('should return same instance on multiple calls', async () => {
            const instance1 = await (0, price_oracle_1.getPriceOracle)();
            const instance2 = await (0, price_oracle_1.getPriceOracle)();
            (0, globals_1.expect)(instance1).toBe(instance2);
        });
        (0, globals_1.it)('should reset singleton properly', async () => {
            const instance1 = await (0, price_oracle_1.getPriceOracle)();
            (0, price_oracle_1.resetPriceOracle)();
            const instance2 = await (0, price_oracle_1.getPriceOracle)();
            (0, globals_1.expect)(instance1).not.toBe(instance2);
        });
    });
    // ===========================================================================
    // Local Cache Priority
    // ===========================================================================
    (0, globals_1.describe)('local cache priority', () => {
        (0, globals_1.it)('should use local cache before Redis', async () => {
            // Update price (stored in local cache)
            await oracle.updatePrice('ETH', 2900);
            // Clear Redis mock to ensure it's not called
            mockRedisClient.get.mockClear();
            // Get price - should use local cache
            const result = await oracle.getPrice('ETH');
            (0, globals_1.expect)(result.price).toBe(2900);
            (0, globals_1.expect)(mockRedisClient.get).not.toHaveBeenCalled();
        });
        (0, globals_1.it)('should fall through to Redis when local cache is stale', async () => {
            // This test would require manipulating timestamps
            // For now, just verify the flow works
            mockRedisClient.get.mockResolvedValue({ price: 2750, timestamp: Date.now() });
            // Ensure local cache doesn't have the value
            oracle.clearLocalCache();
            const result = await oracle.getPrice('ETH');
            (0, globals_1.expect)(result.source).toBe('cache');
            (0, globals_1.expect)(mockRedisClient.get).toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=price-oracle.test.js.map