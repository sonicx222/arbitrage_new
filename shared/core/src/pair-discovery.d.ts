/**
 * Pair Discovery Service
 *
 * S2.2.5: Dynamic pair discovery from DEX factory contracts
 *
 * Features:
 * - Query factory contracts for pair addresses (V2 and V3 patterns)
 * - CREATE2 address computation for offline pair address generation
 * - Batch discovery for efficiency
 * - Circuit breaker for RPC error handling
 *
 * @see ADR-002: Redis Streams for event publishing
 */
import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { Dex, Token } from '../../types';
/**
 * Logger interface for PairDiscoveryService.
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface PairDiscoveryLogger {
    info: (message: string, meta?: object) => void;
    warn: (message: string, meta?: object) => void;
    error: (message: string, meta?: object) => void;
    debug: (message: string, meta?: object) => void;
}
/**
 * Dependencies for PairDiscoveryService (DI pattern).
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface PairDiscoveryDeps {
    logger?: PairDiscoveryLogger;
}
export interface PairDiscoveryConfig {
    /** Max concurrent factory queries */
    maxConcurrentQueries: number;
    /** Batch size for multiple getPair calls */
    batchSize: number;
    /** Delay between batches in ms */
    batchDelayMs: number;
    /** Retry attempts for failed queries */
    retryAttempts: number;
    /** Base delay for exponential backoff in ms */
    retryDelayMs: number;
    /** Circuit breaker threshold (failures before opening) */
    circuitBreakerThreshold: number;
    /** Circuit breaker reset time in ms */
    circuitBreakerResetMs: number;
    /** Query timeout in ms */
    queryTimeoutMs: number;
}
export interface DiscoveredPair {
    address: string;
    token0: string;
    token1: string;
    dex: string;
    chain: string;
    factoryAddress: string;
    discoveredAt: number;
    discoveryMethod: 'factory_query' | 'create2_compute' | 'cache';
    /**
     * V3 fee tier in basis points (e.g., 500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
     * Only populated for V3-style DEXs (Uniswap V3, PancakeSwap V3, etc.)
     */
    feeTier?: number;
}
export interface PairDiscoveryStats {
    totalQueries: number;
    cacheHits: number;
    factoryQueries: number;
    create2Computations: number;
    failedQueries: number;
    circuitBreakerTrips: number;
    avgQueryLatencyMs: number;
}
export declare class PairDiscoveryService extends EventEmitter {
    private logger;
    private config;
    private providers;
    private factoryContracts;
    private failureCount;
    private circuitOpenUntil;
    private stats;
    private queryLatencies;
    private readonly MAX_LATENCY_SAMPLES;
    private activeQueries;
    constructor(config?: Partial<PairDiscoveryConfig>, deps?: PairDiscoveryDeps);
    /**
     * Initialize provider for a chain
     */
    setProvider(chain: string, provider: ethers.JsonRpcProvider): void;
    /**
     * Get or create factory contract instance
     *
     * S3.2.1-FIX: Returns null for unsupported DEX types (vault/pool models, Curve)
     * to prevent creating contracts with wrong ABIs that would fail at runtime
     */
    private getFactoryContract;
    /**
     * Discover pair address using the best available method
     */
    discoverPair(chain: string, dex: Dex, token0: Token, token1: Token): Promise<DiscoveredPair | null>;
    /**
     * Query factory contract for pair address with retry support
     * Returns PoolQueryResult with address and optional fee tier
     */
    private queryFactory;
    /**
     * Single factory query with proper timeout handling
     * Returns PoolQueryResult with address and optional fee tier for V3 pools
     *
     * S3.2.1-FIX: Added explicit handling for Curve-style DEXs
     * Curve uses a different pool registry pattern that requires custom adapter
     */
    private queryFactoryOnce;
    /**
     * Create a timeout promise with cleanup capability
     * Returns a tuple of [timeoutPromise, cleanup function]
     */
    private createTimeoutWithCleanup;
    /**
     * Execute a promise with timeout, ensuring timer cleanup
     */
    private withTimeout;
    /**
     * Compute pair address using CREATE2 formula
     */
    computePairAddress(chain: string, dex: Dex, token0: Token, token1: Token): DiscoveredPair | null;
    /**
     * Batch discover multiple pairs with concurrency control
     */
    discoverPairsBatch(chain: string, dex: Dex, tokenPairs: Array<{
        token0: Token;
        token1: Token;
    }>): Promise<DiscoveredPair[]>;
    /**
     * Detect factory type based on DEX name
     *
     * S3.2.1-FIX: Added handling for:
     * - KyberSwap Elastic (concentrated liquidity, uses getPool like V3)
     * - GMX and Platypus are NOT supported (vault/pool models, not factory patterns)
     *   These DEXs should have enabled: false in config until adapters are implemented
     *
     * @returns 'v2' for Uniswap V2-style DEXs (getPair method)
     * @returns 'v3' for Uniswap V3-style DEXs (getPool method with fee tiers)
     * @returns 'curve' for Curve-style DEXs (multi-asset pools)
     * @returns 'unsupported' for DEXs that don't follow factory patterns
     */
    detectFactoryType(dexName: string): 'v2' | 'v3' | 'curve' | 'unsupported';
    /**
     * Get init code hash for a DEX
     */
    private getInitCodeHash;
    /**
     * Sort token addresses for deterministic ordering
     */
    sortTokens(tokenA: string, tokenB: string): [string, string];
    private isCircuitOpen;
    private incrementFailureCount;
    private resetFailureCount;
    private recordLatency;
    /**
     * Increment cache hits counter (called by external cache integration)
     */
    incrementCacheHits(): void;
    /**
     * Get current active query count
     */
    getActiveQueries(): number;
    getStats(): PairDiscoveryStats;
    /**
     * Reset statistics to initial values
     */
    resetStats(): void;
    /**
     * Cleanup resources and reset internal state
     * Call this before disposing the service
     */
    cleanup(): void;
    /**
     * Get Prometheus-format metrics
     */
    getPrometheusMetrics(): string;
}
/**
 * Get or create singleton PairDiscoveryService instance.
 * Note: Config is only applied on first call. Subsequent calls with different
 * config will log a warning and return the existing instance.
 */
export declare function getPairDiscoveryService(config?: Partial<PairDiscoveryConfig>): PairDiscoveryService;
export declare function resetPairDiscoveryService(): void;
//# sourceMappingURL=pair-discovery.d.ts.map