/**
 * T3.11: Multi-Leg Path Finding (5+ tokens)
 *
 * Discovers arbitrage opportunities with 5+ token paths.
 * Uses DFS with pruning for efficient path discovery.
 *
 * Key features:
 * - Supports paths with 5-7 tokens (4-6 swaps)
 * - Cycle detection to find paths returning to start token
 * - Performance safeguards (timeout, max candidates per hop)
 * - BigInt precision for swap calculations
 * - Integration with existing DEX pool data
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding 1.2
 */
import type { DexPool, TriangularStep, DynamicSlippageConfig } from './cross-dex-triangular-arbitrage';
/**
 * Configuration for multi-leg path finding.
 */
export interface MultiLegPathConfig {
    /** Minimum profit threshold (decimal, e.g., 0.001 = 0.1%) */
    minProfitThreshold: number;
    /** Maximum path length (tokens including start) */
    maxPathLength: number;
    /** Minimum path length (tokens including start) */
    minPathLength: number;
    /** Maximum candidates to explore per hop (limits branching) */
    maxCandidatesPerHop: number;
    /** Timeout in milliseconds */
    timeoutMs: number;
    /** Minimum confidence threshold (0-1) */
    minConfidence?: number;
    /** Dynamic slippage configuration */
    slippageConfig?: DynamicSlippageConfig;
}
/**
 * Multi-leg arbitrage opportunity (5+ tokens).
 */
export interface MultiLegOpportunity {
    id: string;
    chain: string;
    path: string[];
    dexes: string[];
    profitPercentage: number;
    profitUSD: number;
    gasCost: number;
    netProfit: number;
    confidence: number;
    steps: TriangularStep[];
    timestamp: number;
    executionTime: number;
    pathLength: number;
}
/**
 * Statistics for monitoring path finder performance.
 */
export interface PathFinderStats {
    totalCalls: number;
    totalOpportunitiesFound: number;
    totalPathsExplored: number;
    timeouts: number;
    avgProcessingTimeMs: number;
}
/**
 * T3.11: Multi-Leg Path Finder
 *
 * Discovers arbitrage opportunities with 5+ token paths using
 * depth-first search with pruning for efficiency.
 */
export declare class MultiLegPathFinder {
    private config;
    private slippageConfig;
    private stats;
    constructor(config?: Partial<MultiLegPathConfig>);
    /**
     * Find multi-leg arbitrage opportunities.
     *
     * @param chain - Blockchain name
     * @param pools - Available DEX pools
     * @param baseTokens - Starting tokens to explore from
     * @param targetPathLength - Exact path length to find (5, 6, or 7 tokens)
     * @returns Array of profitable opportunities
     */
    findMultiLegOpportunities(chain: string, pools: DexPool[], baseTokens: string[], targetPathLength: number): Promise<MultiLegOpportunity[]>;
    /**
     * Find all profitable paths starting from a specific token.
     * Uses DFS with pruning.
     */
    private findPathsFromToken;
    /**
     * Depth-first search for path discovery.
     * Explores all valid paths up to target length that return to start token.
     */
    private dfs;
    /**
     * Get candidate tokens for next hop.
     */
    private getNextCandidates;
    /**
     * Evaluate a complete path and create opportunity if profitable.
     */
    private evaluateCompletePath;
    /**
     * Simulate a swap using BigInt for precision.
     */
    private simulateSwapBigInt;
    /**
     * Calculate dynamic slippage based on trade size and liquidity.
     */
    private calculateDynamicSlippage;
    /**
     * Group pools by token pairs for O(1) lookup.
     */
    private groupPoolsByPairs;
    /**
     * Find best pools for a token pair.
     */
    private findBestPoolsForPair;
    /**
     * Get maximum liquidity for a token pair.
     */
    private getMaxLiquidity;
    /**
     * Get unique tokens from pools.
     */
    private getUniqueTokens;
    /**
     * Get pools for a complete path.
     */
    private getPoolsForPath;
    /**
     * Calculate confidence score based on liquidity and slippage.
     */
    private calculateConfidence;
    /**
     * Estimate gas cost for execution.
     * Phase 2: Uses dynamic gas pricing from GasPriceCache.
     * Returns gas cost as a ratio of trade amount (to match grossProfit units).
     */
    private estimateGasCost;
    /**
     * Estimate execution time.
     */
    private estimateExecutionTime;
    /**
     * Filter and rank opportunities.
     */
    private filterAndRank;
    /**
     * Check if timeout has been reached.
     */
    private isTimeout;
    /**
     * Get approximate USD price for base token on chain.
     * BUG FIX: Replaced hardcoded 2000 magic number with configurable values.
     */
    private getBaseTokenUsdPrice;
    /**
     * Get current configuration.
     */
    getConfig(): MultiLegPathConfig;
    /**
     * Update configuration.
     */
    updateConfig(config: Partial<MultiLegPathConfig>): void;
    /**
     * Get path finder statistics.
     */
    getStats(): PathFinderStats;
    /**
     * Reset statistics.
     */
    resetStats(): void;
    /**
     * Find multi-leg arbitrage opportunities using worker thread.
     * Offloads CPU-intensive DFS from main event loop to prevent blocking.
     *
     * @param chain - Blockchain name
     * @param pools - Available DEX pools
     * @param baseTokens - Starting tokens to explore from
     * @param targetPathLength - Exact path length to find (5, 6, or 7 tokens)
     * @param workerPool - Optional worker pool instance (lazy loaded if not provided)
     * @returns Promise of array of profitable opportunities
     */
    findMultiLegOpportunitiesAsync(chain: string, pools: DexPool[], baseTokens: string[], targetPathLength: number, workerPool?: any): Promise<MultiLegOpportunity[]>;
}
/**
 * Get the singleton MultiLegPathFinder instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton MultiLegPathFinder instance
 */
export declare function getMultiLegPathFinder(config?: Partial<MultiLegPathConfig>): MultiLegPathFinder;
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export declare function resetMultiLegPathFinder(): void;
//# sourceMappingURL=multi-leg-path-finder.d.ts.map