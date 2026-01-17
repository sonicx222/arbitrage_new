/**
 * T3.15: Liquidity Depth Analysis
 *
 * Professional-grade liquidity analysis for optimal trade execution:
 * - Order book depth tracking (simulated from AMM reserves)
 * - Slippage prediction based on trade size
 * - Multi-level price impact calculation
 * - Optimal trade size recommendation
 *
 * Note: DEX AMMs don't have traditional order books, so we simulate
 * depth levels using the constant product formula (x * y = k).
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding T3.15
 */
/**
 * Configuration for liquidity depth analysis.
 */
export interface LiquidityDepthConfig {
    /** Number of price levels to simulate (default: 10) */
    depthLevels: number;
    /** Trade size step for depth simulation in USD (default: $1000) */
    tradeSizeStepUsd: number;
    /** Maximum trade size to simulate in USD (default: $1M) */
    maxTradeSizeUsd: number;
    /** Maximum pools to track (LRU eviction, default: 1000) */
    maxTrackedPools: number;
    /** Cache TTL in ms (default: 30 seconds) */
    cacheTtlMs: number;
}
/**
 * Pool liquidity snapshot.
 */
export interface PoolLiquidity {
    poolAddress: string;
    chain: string;
    dex: string;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    /** Fee in basis points (e.g., 30 = 0.3%) */
    feeBps: number;
    /** Total liquidity in USD */
    liquidityUsd: number;
    /** Current price (token1/token0) */
    price: number;
    timestamp: number;
}
/**
 * Liquidity at a specific price level.
 */
export interface LiquidityLevel {
    /** Trade size in token units */
    tradeSize: number;
    /** Trade size in USD */
    tradeSizeUsd: number;
    /** Expected price after trade */
    expectedPrice: number;
    /** Price impact percentage */
    priceImpactPercent: number;
    /** Slippage percentage */
    slippagePercent: number;
    /** Output amount */
    outputAmount: number;
    /** Effective rate (output/input) */
    effectiveRate: number;
}
/**
 * Full depth analysis for a pool.
 */
export interface DepthAnalysis {
    poolAddress: string;
    chain: string;
    token0: string;
    token1: string;
    /** Buy-side depth (buying token1 with token0) */
    buyLevels: LiquidityLevel[];
    /** Sell-side depth (selling token1 for token0) */
    sellLevels: LiquidityLevel[];
    /** Optimal trade size for minimal slippage */
    optimalTradeSizeUsd: number;
    /** Maximum trade size before 1% slippage */
    maxTradeSizeFor1PercentSlippage: number;
    /** Maximum trade size before 5% slippage */
    maxTradeSizeFor5PercentSlippage: number;
    /** Overall liquidity score (0-1) */
    liquidityScore: number;
    timestamp: number;
}
/**
 * Slippage estimate for a specific trade.
 */
export interface SlippageEstimate {
    poolAddress: string;
    tradeDirection: 'buy' | 'sell';
    inputAmount: number;
    inputAmountUsd: number;
    outputAmount: number;
    outputAmountUsd: number;
    priceImpactPercent: number;
    slippagePercent: number;
    effectivePrice: number;
    confidence: number;
}
/**
 * Analyzer statistics.
 */
export interface LiquidityAnalyzerStats {
    poolsTracked: number;
    analysisCount: number;
    avgAnalysisTimeMs: number;
    cacheHits: number;
    cacheMisses: number;
    poolEvictions: number;
}
/**
 * T3.15: Liquidity Depth Analyzer
 *
 * Analyzes AMM pool liquidity to predict slippage and optimize trade sizes.
 */
export declare class LiquidityDepthAnalyzer {
    private config;
    private pools;
    private depthCache;
    private stats;
    constructor(config?: Partial<LiquidityDepthConfig>);
    /**
     * Update pool liquidity snapshot.
     * Validates pool data before storing.
     */
    updatePoolLiquidity(pool: PoolLiquidity): void;
    /**
     * Get full depth analysis for a pool.
     */
    analyzeDepth(poolAddress: string): DepthAnalysis | null;
    /**
     * Estimate slippage for a specific trade.
     */
    estimateSlippage(poolAddress: string, inputAmountUsd: number, direction: 'buy' | 'sell'): SlippageEstimate | null;
    /**
     * Find the best pool for a given trade size.
     */
    findBestPool(token0: string, token1: string, tradeSizeUsd: number, direction: 'buy' | 'sell'): {
        poolAddress: string;
        slippage: number;
    } | null;
    /**
     * Get pool liquidity.
     */
    getPoolLiquidity(poolAddress: string): PoolLiquidity | undefined;
    /**
     * Get all tracked pools.
     */
    getTrackedPools(): string[];
    /**
     * Get analyzer statistics.
     */
    getStats(): LiquidityAnalyzerStats;
    /**
     * Reset all data.
     */
    reset(): void;
    private calculateDepthLevels;
    private calculateSwapOutput;
    private findOptimalTradeSize;
    private findMaxTradeSizeForSlippage;
    private calculateLiquidityScore;
    private evictLRUPoolsIfNeeded;
}
/**
 * Get the singleton LiquidityDepthAnalyzer instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton LiquidityDepthAnalyzer instance
 */
export declare function getLiquidityDepthAnalyzer(config?: Partial<LiquidityDepthConfig>): LiquidityDepthAnalyzer;
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export declare function resetLiquidityDepthAnalyzer(): void;
//# sourceMappingURL=liquidity-depth-analyzer.d.ts.map