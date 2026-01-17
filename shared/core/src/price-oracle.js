"use strict";
/**
 * Price Oracle
 *
 * Provides token price data with caching and fallback support.
 * Replaces hardcoded prices found across detector services.
 *
 * Features:
 * - Redis-cached prices with TTL
 * - Configurable fallback prices per token
 * - Batch price fetching for efficiency
 * - Price staleness detection
 * - Support for multiple price sources (extensible)
 *
 * Default Prices (fallback when cache miss):
 * - ETH: $2500 (was $2000-2500 in various detectors)
 * - BNB: $300
 * - MATIC: $0.80
 * - BTC/WBTC: $45000
 * - Stablecoins: $1.00
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceOracle = void 0;
exports.getPriceOracle = getPriceOracle;
exports.resetPriceOracle = resetPriceOracle;
exports.getDefaultPrice = getDefaultPrice;
exports.hasDefaultPrice = hasDefaultPrice;
const redis_1 = require("./redis");
const logger_1 = require("./logger");
// =============================================================================
// Symbol Normalization
// =============================================================================
/** Wrapped token aliases - maps wrapped to native */
const TOKEN_ALIASES = {
    WETH: 'ETH',
    WBNB: 'BNB',
    WMATIC: 'MATIC',
    WAVAX: 'AVAX',
    WFTM: 'FTM',
    WBTC: 'BTC'
};
/**
 * Normalize a token symbol (uppercase, trim, resolve aliases).
 * This is a module-level function for consistent behavior across
 * both PriceOracle class methods and standalone utility functions.
 */
function normalizeTokenSymbol(symbol) {
    const upper = symbol.toUpperCase().trim();
    return TOKEN_ALIASES[upper] || upper;
}
// =============================================================================
// Default Fallback Prices
// =============================================================================
// Note: Wrapped token entries (WETH, WBNB, etc.) are NOT included here
// because normalizeTokenSymbol() aliases them to their native counterparts.
const DEFAULT_FALLBACK_PRICES = {
    // Major cryptocurrencies (native tokens only - wrapped aliases handled by normalizeTokenSymbol)
    ETH: 2500,
    BTC: 45000,
    BNB: 300,
    MATIC: 0.80,
    AVAX: 35,
    FTM: 0.40,
    OP: 2.50,
    ARB: 1.20,
    // Stablecoins
    USDT: 1.00,
    USDC: 1.00,
    DAI: 1.00,
    BUSD: 1.00,
    FRAX: 1.00,
    TUSD: 1.00,
    USDP: 1.00,
    // DeFi tokens
    UNI: 8.00,
    AAVE: 100,
    LINK: 15,
    CRV: 0.60,
    MKR: 1500,
    COMP: 50,
    SNX: 3.00,
    SUSHI: 1.50,
    YFI: 8000,
    // Liquid staking
    STETH: 2500,
    WSTETH: 2900,
    RETH: 2700,
    CBETH: 2600,
    // Meme coins (approximate)
    SHIB: 0.00001,
    DOGE: 0.08,
    PEPE: 0.000001
};
// Cache size limit to prevent unbounded memory growth
const DEFAULT_MAX_CACHE_SIZE = 10000;
// T2.9: Max size for lastKnownGoodPrices Map to prevent unbounded growth
const DEFAULT_MAX_LAST_KNOWN_GOOD_SIZE = 1000;
// T2.9: Max size for staleFallbackWarnings Set to prevent unbounded growth
const DEFAULT_MAX_STALE_WARNINGS_SIZE = 100;
// =============================================================================
// Price Oracle
// =============================================================================
class PriceOracle {
    constructor(config = {}, deps) {
        this.redis = null;
        this.localCache = new Map();
        // ===========================================================================
        // T2.9: Dynamic Fallback Price Tracking
        // ===========================================================================
        /**
         * T2.9: Last known good prices - tracks the most recent successful cache hit
         * for each token. Used as fallback when cache misses and static fallback is stale.
         */
        this.lastKnownGoodPrices = new Map();
        /**
         * T2.9: Price metrics for monitoring and debugging.
         */
        this.priceMetrics = {
            fallbackUsageCount: 0,
            lastKnownGoodUsageCount: 0,
            cacheHitCount: 0,
            staleFallbackWarnings: new Set()
        };
        // DI: Use provided logger or create default
        this.logger = deps?.logger ?? (0, logger_1.createLogger)('price-oracle');
        // Store injected redis client for use in initialize()
        this.injectedRedisClient = deps?.redisClient;
        this.config = {
            cacheKeyPrefix: config.cacheKeyPrefix ?? 'price:',
            cacheTtlSeconds: config.cacheTtlSeconds ?? 60,
            stalenessThresholdMs: config.stalenessThresholdMs ?? 300000,
            useFallback: config.useFallback ?? true,
            customFallbackPrices: config.customFallbackPrices ?? {},
            maxCacheSize: config.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE
        };
        // Merge custom fallback prices with defaults
        this.fallbackPrices = {
            ...DEFAULT_FALLBACK_PRICES,
            ...this.config.customFallbackPrices
        };
    }
    // ===========================================================================
    // Initialization
    // ===========================================================================
    async initialize(redis) {
        // Use injected client first, then parameter, then singleton
        this.redis = this.injectedRedisClient ?? redis ?? await (0, redis_1.getRedisClient)();
        this.logger.info('PriceOracle initialized', {
            fallbackPriceCount: Object.keys(this.fallbackPrices).length
        });
    }
    // ===========================================================================
    // Price Queries
    // ===========================================================================
    /**
     * Get price for a single token.
     *
     * T2.9: Enhanced with last known good price tracking and fallback hierarchy:
     * 1. Local cache (L1)
     * 2. Redis cache (L2)
     * 3. Last known good price (if available and more recent than static fallback)
     * 4. Static fallback price
     *
     * @param symbol - Token symbol (e.g., 'ETH', 'USDT')
     * @param chain - Optional chain identifier for chain-specific prices
     * @returns Token price data
     */
    async getPrice(symbol, chain) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const cacheKey = this.buildCacheKey(normalizedSymbol, chain);
        // Try local cache first (L1)
        const localCached = this.localCache.get(cacheKey);
        if (localCached && !this.isStale(localCached.timestamp)) {
            this.priceMetrics.cacheHitCount++;
            // T2.9: Track last known good from local cache hit
            this.updateLastKnownGoodPrice(normalizedSymbol, localCached.price);
            return localCached;
        }
        // Try Redis cache (L2)
        if (this.redis) {
            try {
                const cached = await this.redis.get(cacheKey);
                if (cached) {
                    const isStale = this.isStale(cached.timestamp);
                    const tokenPrice = {
                        symbol: normalizedSymbol,
                        price: cached.price,
                        source: 'cache',
                        timestamp: cached.timestamp,
                        isStale
                    };
                    // Update local cache and prune if needed
                    this.localCache.set(cacheKey, tokenPrice);
                    this.pruneCache();
                    this.priceMetrics.cacheHitCount++;
                    // T2.9: Track last known good from Redis cache hit
                    this.updateLastKnownGoodPrice(normalizedSymbol, cached.price);
                    return tokenPrice;
                }
            }
            catch (error) {
                this.logger.warn('Redis cache read failed', { error, symbol });
            }
        }
        // T2.9: Try last known good price before static fallback
        const lastKnownGood = this.lastKnownGoodPrices.get(normalizedSymbol);
        if (lastKnownGood && lastKnownGood.price > 0) {
            const tokenPrice = {
                symbol: normalizedSymbol,
                price: lastKnownGood.price,
                source: 'lastKnownGood',
                timestamp: lastKnownGood.timestamp,
                isStale: this.isStale(lastKnownGood.timestamp)
            };
            // Cache last known good in local cache
            this.localCache.set(cacheKey, tokenPrice);
            this.pruneCache();
            this.priceMetrics.lastKnownGoodUsageCount++;
            this.logger.debug('Using last known good price', {
                symbol,
                price: lastKnownGood.price,
                age: Date.now() - lastKnownGood.timestamp
            });
            return tokenPrice;
        }
        // Fallback to default prices
        if (this.config.useFallback) {
            const fallbackPrice = this.fallbackPrices[normalizedSymbol];
            if (fallbackPrice !== undefined) {
                const tokenPrice = {
                    symbol: normalizedSymbol,
                    price: fallbackPrice,
                    source: 'fallback',
                    timestamp: Date.now(),
                    isStale: true // Fallback is always considered stale
                };
                // Cache fallback in local cache to avoid repeated lookups
                this.localCache.set(cacheKey, tokenPrice);
                this.pruneCache();
                // T2.9: Track fallback usage and stale warnings (with size limit)
                this.priceMetrics.fallbackUsageCount++;
                if (this.priceMetrics.staleFallbackWarnings.size < DEFAULT_MAX_STALE_WARNINGS_SIZE) {
                    this.priceMetrics.staleFallbackWarnings.add(normalizedSymbol);
                }
                this.logger.debug('Using fallback price', { symbol, price: fallbackPrice });
                return tokenPrice;
            }
        }
        // No price available
        this.logger.warn('No price available for token', { symbol });
        return {
            symbol: normalizedSymbol,
            price: 0,
            source: 'fallback',
            timestamp: 0,
            isStale: true
        };
    }
    /**
     * T2.9: Update last known good price for a token.
     * Called when we receive a successful price from cache.
     * Prunes oldest entries when Map exceeds max size to prevent unbounded growth.
     */
    updateLastKnownGoodPrice(symbol, price) {
        if (price > 0) {
            this.lastKnownGoodPrices.set(symbol, {
                price,
                timestamp: Date.now()
            });
            // Prune if exceeds max size (remove oldest entries)
            if (this.lastKnownGoodPrices.size > DEFAULT_MAX_LAST_KNOWN_GOOD_SIZE) {
                const entries = [...this.lastKnownGoodPrices.entries()];
                entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
                const toRemove = entries.length - DEFAULT_MAX_LAST_KNOWN_GOOD_SIZE;
                for (let i = 0; i < toRemove; i++) {
                    this.lastKnownGoodPrices.delete(entries[i][0]);
                }
            }
        }
    }
    /**
     * Get prices for multiple tokens in batch.
     *
     * @param requests - Array of price requests
     * @returns Map of symbol to TokenPrice
     */
    async getPrices(requests) {
        const results = new Map();
        // Deduplicate requests
        const uniqueRequests = this.deduplicateRequests(requests);
        // Fetch all prices in parallel
        const pricePromises = uniqueRequests.map(async (req) => {
            const price = await this.getPrice(req.symbol, req.chain);
            return { key: this.buildCacheKey(req.symbol, req.chain), price };
        });
        const prices = await Promise.all(pricePromises);
        for (const { key, price } of prices) {
            results.set(price.symbol, price);
        }
        return results;
    }
    /**
     * Get price synchronously from local cache only.
     * Returns fallback if not in cache.
     */
    getPriceSync(symbol, chain) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const cacheKey = this.buildCacheKey(normalizedSymbol, chain);
        // Check local cache
        const cached = this.localCache.get(cacheKey);
        if (cached && !this.isStale(cached.timestamp)) {
            return cached.price;
        }
        // Return fallback
        return this.fallbackPrices[normalizedSymbol] ?? 0;
    }
    // ===========================================================================
    // Price Updates
    // ===========================================================================
    /**
     * Update price in cache.
     *
     * @param symbol - Token symbol
     * @param price - New price value
     * @param chain - Optional chain identifier
     */
    async updatePrice(symbol, price, chain) {
        if (price <= 0) {
            this.logger.warn('Invalid price update ignored', { symbol, price });
            return;
        }
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const cacheKey = this.buildCacheKey(normalizedSymbol, chain);
        const timestamp = Date.now();
        // Update local cache and prune if needed
        const tokenPrice = {
            symbol: normalizedSymbol,
            price,
            source: 'cache',
            timestamp,
            isStale: false
        };
        this.localCache.set(cacheKey, tokenPrice);
        this.pruneCache();
        // Update Redis cache
        if (this.redis) {
            try {
                await this.redis.set(cacheKey, { price, timestamp }, this.config.cacheTtlSeconds);
            }
            catch (error) {
                this.logger.error('Redis cache write failed', { error, symbol });
            }
        }
    }
    /**
     * Update multiple prices in batch.
     */
    async updatePrices(updates) {
        await Promise.all(updates.map(u => this.updatePrice(u.symbol, u.price, u.chain)));
    }
    // ===========================================================================
    // USD Value Estimation
    // ===========================================================================
    /**
     * Estimate USD value of a token amount.
     * Replaces hardcoded estimateUsdValue() in detectors.
     *
     * @param symbol - Token symbol
     * @param amount - Token amount (in token units, not wei)
     * @param chain - Optional chain identifier
     * @returns Estimated USD value
     */
    async estimateUsdValue(symbol, amount, chain) {
        const price = await this.getPrice(symbol, chain);
        return amount * price.price;
    }
    /**
     * Synchronous USD value estimation (uses local cache/fallback).
     */
    estimateUsdValueSync(symbol, amount, chain) {
        const price = this.getPriceSync(symbol, chain);
        return amount * price;
    }
    // ===========================================================================
    // Fallback Price Management
    // ===========================================================================
    /**
     * Get fallback price for a token.
     */
    getFallbackPrice(symbol) {
        return this.fallbackPrices[this.normalizeSymbol(symbol)] ?? 0;
    }
    /**
     * Set or update a fallback price.
     */
    setFallbackPrice(symbol, price) {
        this.fallbackPrices[this.normalizeSymbol(symbol)] = price;
    }
    /**
     * Get all fallback prices.
     */
    getAllFallbackPrices() {
        return { ...this.fallbackPrices };
    }
    // ===========================================================================
    // T2.9: Dynamic Fallback Price Management
    // ===========================================================================
    /**
     * T2.9: Get last known good price for a token.
     * Returns 0 if no last known good price is available.
     *
     * @param symbol - Token symbol
     * @returns Last known good price or 0
     */
    getLastKnownGoodPrice(symbol) {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const lastKnownGood = this.lastKnownGoodPrices.get(normalizedSymbol);
        return lastKnownGood?.price ?? 0;
    }
    /**
     * T2.9: Bulk update fallback prices.
     * Useful for hourly updates from external price APIs.
     * Invalid prices (0 or negative) are ignored.
     *
     * @param prices - Map of symbol to price
     */
    updateFallbackPrices(prices) {
        let updateCount = 0;
        let skipCount = 0;
        for (const [symbol, price] of Object.entries(prices)) {
            const normalizedSymbol = this.normalizeSymbol(symbol);
            // Validate price - must be positive
            if (price <= 0) {
                this.logger.warn('Invalid price in bulk update ignored', {
                    symbol: normalizedSymbol,
                    price
                });
                skipCount++;
                continue;
            }
            this.fallbackPrices[normalizedSymbol] = price;
            updateCount++;
        }
        this.logger.info('Bulk fallback price update complete', {
            updated: updateCount,
            skipped: skipCount
        });
    }
    /**
     * T2.9: Get price metrics for monitoring.
     * Provides insights into fallback usage, stale data, etc.
     */
    getPriceMetrics() {
        // Calculate ages for all last known good prices
        const now = Date.now();
        const lastKnownGoodAges = {};
        for (const [symbol, data] of this.lastKnownGoodPrices.entries()) {
            lastKnownGoodAges[symbol] = now - data.timestamp;
        }
        return {
            fallbackUsageCount: this.priceMetrics.fallbackUsageCount,
            lastKnownGoodUsageCount: this.priceMetrics.lastKnownGoodUsageCount,
            cacheHitCount: this.priceMetrics.cacheHitCount,
            staleFallbackWarnings: Array.from(this.priceMetrics.staleFallbackWarnings),
            lastKnownGoodAges
        };
    }
    /**
     * T2.9: Reset price metrics (useful for testing).
     */
    resetPriceMetrics() {
        this.priceMetrics.fallbackUsageCount = 0;
        this.priceMetrics.lastKnownGoodUsageCount = 0;
        this.priceMetrics.cacheHitCount = 0;
        this.priceMetrics.staleFallbackWarnings.clear();
    }
    // ===========================================================================
    // Cache Management
    // ===========================================================================
    /**
     * Clear local cache.
     */
    clearLocalCache() {
        this.localCache.clear();
        this.logger.debug('Local cache cleared');
    }
    /**
     * Get local cache statistics.
     */
    getLocalCacheStats() {
        let staleCount = 0;
        for (const price of this.localCache.values()) {
            if (price.isStale || this.isStale(price.timestamp)) {
                staleCount++;
            }
        }
        return {
            size: this.localCache.size,
            staleCount
        };
    }
    /**
     * Preload prices into local cache.
     */
    async preloadPrices(symbols, chain) {
        const requests = symbols.map(symbol => ({ symbol, chain }));
        await this.getPrices(requests);
        this.logger.info('Prices preloaded', { count: symbols.length });
    }
    // ===========================================================================
    // Private Helpers
    // ===========================================================================
    /**
     * Normalize symbol using module-level function for consistency.
     */
    normalizeSymbol(symbol) {
        return normalizeTokenSymbol(symbol);
    }
    buildCacheKey(symbol, chain) {
        return chain
            ? `${this.config.cacheKeyPrefix}${chain}:${symbol}`
            : `${this.config.cacheKeyPrefix}${symbol}`;
    }
    isStale(timestamp) {
        return Date.now() - timestamp > this.config.stalenessThresholdMs;
    }
    /**
     * Prune cache to prevent unbounded memory growth.
     * Removes oldest entries when cache exceeds max size.
     */
    pruneCache() {
        if (this.localCache.size <= this.config.maxCacheSize) {
            return;
        }
        // Sort entries by timestamp (oldest first)
        const entries = [...this.localCache.entries()];
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        // Remove oldest entries to get below max size (remove 20% extra for hysteresis)
        const targetSize = Math.floor(this.config.maxCacheSize * 0.8);
        const toRemove = entries.length - targetSize;
        for (let i = 0; i < toRemove; i++) {
            this.localCache.delete(entries[i][0]);
        }
        this.logger.debug('Cache pruned', {
            removed: toRemove,
            newSize: this.localCache.size
        });
    }
    deduplicateRequests(requests) {
        const seen = new Set();
        const unique = [];
        for (const req of requests) {
            // Normalize symbol before building cache key for proper deduplication
            const normalizedSymbol = this.normalizeSymbol(req.symbol);
            const key = this.buildCacheKey(normalizedSymbol, req.chain);
            if (!seen.has(key)) {
                seen.add(key);
                // Store with normalized symbol
                unique.push({ ...req, symbol: normalizedSymbol });
            }
        }
        return unique;
    }
}
exports.PriceOracle = PriceOracle;
// =============================================================================
// Singleton Factory
// =============================================================================
let oracleInstance = null;
let oraclePromise = null;
let oracleInitError = null;
/**
 * Get the singleton PriceOracle instance.
 * Thread-safe: concurrent calls will wait for the same initialization.
 */
async function getPriceOracle(config) {
    // If already initialized successfully, return immediately
    if (oracleInstance) {
        return oracleInstance;
    }
    // P0-5 fix: Don't cache errors forever - allow retry on subsequent calls
    // If there's a cached error but no pending promise, clear it to allow retry
    if (oracleInitError && !oraclePromise) {
        const cachedError = oracleInitError;
        oracleInitError = null; // Clear so next call can retry
        throw cachedError;
    }
    // If initialization is already in progress, wait for it
    if (oraclePromise) {
        return oraclePromise;
    }
    // Start new initialization (thread-safe: only first caller creates the promise)
    oraclePromise = (async () => {
        try {
            const instance = new PriceOracle(config);
            await instance.initialize();
            oracleInstance = instance;
            return instance;
        }
        catch (error) {
            oracleInitError = error;
            oraclePromise = null; // P0-5 fix: clear promise to allow retry
            throw error;
        }
    })();
    return oraclePromise;
}
/**
 * Reset the singleton instance (for testing).
 */
function resetPriceOracle() {
    if (oracleInstance) {
        oracleInstance.clearLocalCache();
    }
    oracleInstance = null;
    oraclePromise = null;
    oracleInitError = null;
}
// =============================================================================
// Convenience Functions
// =============================================================================
/**
 * Quick price lookup with fallback (doesn't require initialization).
 * Uses normalizeTokenSymbol for consistent alias handling (e.g., WETH → ETH).
 */
function getDefaultPrice(symbol) {
    const normalized = normalizeTokenSymbol(symbol);
    return DEFAULT_FALLBACK_PRICES[normalized] ?? 0;
}
/**
 * Check if a token has a known default price.
 * Uses normalizeTokenSymbol for consistent alias handling (e.g., WETH → ETH).
 */
function hasDefaultPrice(symbol) {
    const normalized = normalizeTokenSymbol(symbol);
    return normalized in DEFAULT_FALLBACK_PRICES;
}
//# sourceMappingURL=price-oracle.js.map