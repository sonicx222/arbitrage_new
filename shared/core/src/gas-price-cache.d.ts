/**
 * Gas Price Cache
 *
 * Provides dynamic gas price caching with periodic refresh for accurate
 * arbitrage profit calculations. Replaces static gas estimates with
 * real-time data from RPC providers.
 *
 * Features:
 * - Per-chain gas price storage with 60-second refresh
 * - Graceful fallback to static estimates on RPC failure
 * - Native token price integration for USD conversion
 * - Thread-safe singleton pattern
 *
 * @see ADR-012-worker-thread-path-finding.md - Gas optimization phase
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Phase 2 recommendations
 */
/**
 * Logger interface for GasPriceCache.
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface GasPriceCacheLogger {
    info: (message: string, meta?: object) => void;
    warn: (message: string, meta?: object) => void;
    error: (message: string, meta?: object) => void;
    debug: (message: string, meta?: object) => void;
}
/**
 * Dependencies for GasPriceCache (DI pattern).
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface GasPriceCacheDeps {
    logger?: GasPriceCacheLogger;
}
/**
 * Cached gas price data for a single chain.
 */
export interface GasPriceData {
    /** Gas price in wei */
    gasPriceWei: bigint;
    /** Gas price in gwei (for display) */
    gasPriceGwei: number;
    /** Max fee per gas (EIP-1559) in wei, if available */
    maxFeePerGasWei?: bigint;
    /** Priority fee (EIP-1559) in wei, if available */
    maxPriorityFeePerGasWei?: bigint;
    /** Last update timestamp */
    lastUpdated: number;
    /** Whether this is a fallback value */
    isFallback: boolean;
    /** Error message if fetch failed */
    error?: string;
}
/**
 * Native token price data.
 */
export interface NativeTokenPrice {
    /** Price in USD */
    priceUsd: number;
    /** Last update timestamp */
    lastUpdated: number;
    /** Whether this is a fallback value */
    isFallback: boolean;
}
/**
 * Gas cost estimate in USD.
 */
export interface GasCostEstimate {
    /** Estimated gas cost in USD */
    costUsd: number;
    /** Gas price used (gwei) */
    gasPriceGwei: number;
    /** Gas units estimated */
    gasUnits: number;
    /** Native token price used */
    nativeTokenPriceUsd: number;
    /** Whether any fallback values were used */
    usesFallback: boolean;
    /** Chain name */
    chain: string;
}
/**
 * Configuration for GasPriceCache.
 */
export interface GasPriceCacheConfig {
    /** Refresh interval in milliseconds (default: 60000 = 60s) */
    refreshIntervalMs: number;
    /** Stale threshold - consider data stale after this duration (default: 120000 = 2min) */
    staleThresholdMs: number;
    /** Enable automatic refresh (default: true) */
    autoRefresh: boolean;
    /** Chains to monitor (default: all configured chains) */
    chains?: string[];
}
/**
 * Default gas units per operation type.
 */
export declare const GAS_UNITS: {
    /** Simple swap (Uniswap V2 style) */
    simpleSwap: number;
    /** Complex swap (Uniswap V3, Curve, etc.) */
    complexSwap: number;
    /** Triangular arbitrage (3 swaps) */
    triangularArbitrage: number;
    /** Quadrilateral arbitrage (4 swaps) */
    quadrilateralArbitrage: number;
    /** Multi-leg arbitrage per additional hop */
    multiLegPerHop: number;
    /** Base gas for multi-leg (overhead) */
    multiLegBase: number;
};
/**
 * Default trade amount for gas cost ratio calculations.
 * Used to convert USD gas costs to profit ratios.
 */
export declare const DEFAULT_TRADE_AMOUNT_USD = 2000;
/**
 * Static fallback gas costs per chain (in ETH/native token).
 * Used when gas cache is unavailable.
 */
export declare const FALLBACK_GAS_COSTS_ETH: Record<string, number>;
/**
 * Consistent fallback scaling factor per step.
 * Each additional step adds 25% to base gas cost.
 */
export declare const FALLBACK_GAS_SCALING_PER_STEP = 0.25;
/**
 * Singleton cache for gas prices across all chains.
 * Provides real-time gas price data with automatic refresh.
 */
export declare class GasPriceCache {
    private config;
    private logger;
    private gasPrices;
    private nativePrices;
    private refreshTimer;
    private isRunning;
    private isRefreshing;
    private providers;
    constructor(config?: Partial<GasPriceCacheConfig>, deps?: GasPriceCacheDeps);
    /**
     * Start the gas price cache with automatic refresh.
     */
    start(): Promise<void>;
    /**
     * Stop the gas price cache and clear timers.
     */
    stop(): Promise<void>;
    /**
     * Get gas price for a specific chain.
     *
     * @param chain - Chain name (e.g., 'ethereum', 'arbitrum')
     * @returns Gas price data or fallback
     */
    getGasPrice(chain: string): GasPriceData;
    /**
     * Get native token price for a chain.
     *
     * @param chain - Chain name
     * @returns Native token price data
     */
    getNativeTokenPrice(chain: string): NativeTokenPrice;
    /**
     * Estimate gas cost in USD for an operation.
     *
     * @param chain - Chain name
     * @param gasUnits - Number of gas units (use GAS_UNITS constants)
     * @returns Gas cost estimate with metadata
     */
    estimateGasCostUsd(chain: string, gasUnits: number): GasCostEstimate;
    /**
     * Estimate gas cost for multi-leg arbitrage.
     *
     * @param chain - Chain name
     * @param numHops - Number of swaps in the path
     * @returns Gas cost in USD
     */
    estimateMultiLegGasCost(chain: string, numHops: number): number;
    /**
     * Estimate gas cost for triangular arbitrage.
     *
     * @param chain - Chain name
     * @returns Gas cost in USD
     */
    estimateTriangularGasCost(chain: string): number;
    /**
     * Estimate gas cost as a ratio of trade amount.
     * This is the recommended method for profit calculations as it keeps units consistent.
     *
     * @param chain - Chain name
     * @param operationType - Type of operation ('simple', 'triangular', 'quadrilateral', 'multiLeg')
     * @param numSteps - Number of steps (only used for 'multiLeg')
     * @param tradeAmountUsd - Trade amount in USD (default: DEFAULT_TRADE_AMOUNT_USD)
     * @returns Gas cost as a ratio (e.g., 0.005 = 0.5% of trade amount)
     */
    estimateGasCostRatio(chain: string, operationType: 'simple' | 'triangular' | 'quadrilateral' | 'multiLeg', numSteps?: number, tradeAmountUsd?: number): number;
    /**
     * Get cache statistics.
     */
    getStats(): {
        chainsMonitored: number;
        freshPrices: number;
        stalePrices: number;
        fallbackPrices: number;
        lastRefresh: number;
    };
    /**
     * Manually refresh gas prices for all chains.
     * Protected by mutex to prevent concurrent refresh operations.
     */
    refreshAll(): Promise<void>;
    /**
     * Refresh gas price for a specific chain.
     */
    refreshChain(chain: string): Promise<void>;
    /**
     * Update native token price manually.
     * In production, integrate with price oracle.
     */
    setNativeTokenPrice(chain: string, priceUsd: number): void;
    private initializeFallbacks;
    private createFallbackGasPrice;
    private startRefreshTimer;
}
/**
 * Get the singleton GasPriceCache instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton GasPriceCache instance
 */
export declare function getGasPriceCache(config?: Partial<GasPriceCacheConfig>): GasPriceCache;
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export declare function resetGasPriceCache(): Promise<void>;
//# sourceMappingURL=gas-price-cache.d.ts.map