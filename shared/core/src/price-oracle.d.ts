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
/**
 * Logger interface for PriceOracle.
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface PriceOracleLogger {
    info: (message: string, meta?: object) => void;
    warn: (message: string, meta?: object) => void;
    error: (message: string, meta?: object) => void;
    debug: (message: string, meta?: object) => void;
}
/**
 * Redis client interface for PriceOracle.
 * Matches the subset of RedisClient methods used by PriceOracle.
 */
export interface PriceOracleRedisClient {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
}
/**
 * Dependencies for PriceOracle (DI pattern).
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface PriceOracleDeps {
    logger?: PriceOracleLogger;
    redisClient?: PriceOracleRedisClient;
}
export interface TokenPrice {
    symbol: string;
    price: number;
    /** T2.9: Added 'lastKnownGood' source for dynamic fallback prices */
    source: 'cache' | 'fallback' | 'external' | 'lastKnownGood';
    timestamp: number;
    isStale: boolean;
}
export interface PriceOracleConfig {
    /** Cache key prefix (default: 'price:') */
    cacheKeyPrefix?: string;
    /** Cache TTL in seconds (default: 60) */
    cacheTtlSeconds?: number;
    /** Price staleness threshold in ms (default: 300000 = 5 minutes) */
    stalenessThresholdMs?: number;
    /** Whether to use fallback prices when cache misses */
    useFallback?: boolean;
    /** Custom fallback prices (extends defaults) */
    customFallbackPrices?: Record<string, number>;
    /** Maximum local cache size to prevent unbounded memory growth (default: 10000) */
    maxCacheSize?: number;
}
export interface PriceBatchRequest {
    symbol: string;
    chain?: string;
}
export declare class PriceOracle {
    private redis;
    private logger;
    private config;
    private fallbackPrices;
    private localCache;
    private injectedRedisClient?;
    /**
     * T2.9: Last known good prices - tracks the most recent successful cache hit
     * for each token. Used as fallback when cache misses and static fallback is stale.
     */
    private lastKnownGoodPrices;
    /**
     * T2.9: Price metrics for monitoring and debugging.
     */
    private priceMetrics;
    constructor(config?: PriceOracleConfig, deps?: PriceOracleDeps);
    initialize(redis?: PriceOracleRedisClient): Promise<void>;
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
    getPrice(symbol: string, chain?: string): Promise<TokenPrice>;
    /**
     * T2.9: Update last known good price for a token.
     * Called when we receive a successful price from cache.
     * Prunes oldest entries when Map exceeds max size to prevent unbounded growth.
     */
    private updateLastKnownGoodPrice;
    /**
     * Get prices for multiple tokens in batch.
     *
     * @param requests - Array of price requests
     * @returns Map of symbol to TokenPrice
     */
    getPrices(requests: PriceBatchRequest[]): Promise<Map<string, TokenPrice>>;
    /**
     * Get price synchronously from local cache only.
     * Returns fallback if not in cache.
     */
    getPriceSync(symbol: string, chain?: string): number;
    /**
     * Update price in cache.
     *
     * @param symbol - Token symbol
     * @param price - New price value
     * @param chain - Optional chain identifier
     */
    updatePrice(symbol: string, price: number, chain?: string): Promise<void>;
    /**
     * Update multiple prices in batch.
     */
    updatePrices(updates: Array<{
        symbol: string;
        price: number;
        chain?: string;
    }>): Promise<void>;
    /**
     * Estimate USD value of a token amount.
     * Replaces hardcoded estimateUsdValue() in detectors.
     *
     * @param symbol - Token symbol
     * @param amount - Token amount (in token units, not wei)
     * @param chain - Optional chain identifier
     * @returns Estimated USD value
     */
    estimateUsdValue(symbol: string, amount: number, chain?: string): Promise<number>;
    /**
     * Synchronous USD value estimation (uses local cache/fallback).
     */
    estimateUsdValueSync(symbol: string, amount: number, chain?: string): number;
    /**
     * Get fallback price for a token.
     */
    getFallbackPrice(symbol: string): number;
    /**
     * Set or update a fallback price.
     */
    setFallbackPrice(symbol: string, price: number): void;
    /**
     * Get all fallback prices.
     */
    getAllFallbackPrices(): Record<string, number>;
    /**
     * T2.9: Get last known good price for a token.
     * Returns 0 if no last known good price is available.
     *
     * @param symbol - Token symbol
     * @returns Last known good price or 0
     */
    getLastKnownGoodPrice(symbol: string): number;
    /**
     * T2.9: Bulk update fallback prices.
     * Useful for hourly updates from external price APIs.
     * Invalid prices (0 or negative) are ignored.
     *
     * @param prices - Map of symbol to price
     */
    updateFallbackPrices(prices: Record<string, number>): void;
    /**
     * T2.9: Get price metrics for monitoring.
     * Provides insights into fallback usage, stale data, etc.
     */
    getPriceMetrics(): {
        fallbackUsageCount: number;
        lastKnownGoodUsageCount: number;
        cacheHitCount: number;
        staleFallbackWarnings: string[];
        lastKnownGoodAges: Record<string, number>;
    };
    /**
     * T2.9: Reset price metrics (useful for testing).
     */
    resetPriceMetrics(): void;
    /**
     * Clear local cache.
     */
    clearLocalCache(): void;
    /**
     * Get local cache statistics.
     */
    getLocalCacheStats(): {
        size: number;
        staleCount: number;
    };
    /**
     * Preload prices into local cache.
     */
    preloadPrices(symbols: string[], chain?: string): Promise<void>;
    /**
     * Normalize symbol using module-level function for consistency.
     */
    private normalizeSymbol;
    private buildCacheKey;
    private isStale;
    /**
     * Prune cache to prevent unbounded memory growth.
     * Removes oldest entries when cache exceeds max size.
     */
    private pruneCache;
    private deduplicateRequests;
}
/**
 * Get the singleton PriceOracle instance.
 * Thread-safe: concurrent calls will wait for the same initialization.
 */
export declare function getPriceOracle(config?: PriceOracleConfig): Promise<PriceOracle>;
/**
 * Reset the singleton instance (for testing).
 */
export declare function resetPriceOracle(): void;
/**
 * Quick price lookup with fallback (doesn't require initialization).
 * Uses normalizeTokenSymbol for consistent alias handling (e.g., WETH → ETH).
 */
export declare function getDefaultPrice(symbol: string): number;
/**
 * Check if a token has a known default price.
 * Uses normalizeTokenSymbol for consistent alias handling (e.g., WETH → ETH).
 */
export declare function hasDefaultPrice(symbol: string): boolean;
//# sourceMappingURL=price-oracle.d.ts.map