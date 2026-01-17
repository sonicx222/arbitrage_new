export interface DexPool {
    dex: string;
    token0: string;
    token1: string;
    reserve0: string;
    reserve1: string;
    fee: number;
    liquidity: number;
    price: number;
}
export interface TriangularOpportunity {
    id: string;
    chain: string;
    path: [string, string, string];
    dexes: [string, string, string];
    profitPercentage: number;
    profitUSD: number;
    gasCost: number;
    netProfit: number;
    confidence: number;
    steps: TriangularStep[];
    timestamp: number;
    executionTime: number;
}
export interface TriangularStep {
    fromToken: string;
    toToken: string;
    dex: string;
    amountIn: number;
    amountOut: number;
    price: number;
    fee: number;
    slippage: number;
}
export interface ArbitragePath {
    tokens: string[];
    dexes: string[];
    profit: number;
    gasEstimate: number;
    executionComplexity: number;
}
/**
 * T2.6: Quadrilateral (4-hop) arbitrage opportunity.
 * Path: A → B → C → D → A (4 tokens, 4 swaps)
 */
export interface QuadrilateralOpportunity {
    id: string;
    chain: string;
    path: [string, string, string, string];
    dexes: [string, string, string, string];
    profitPercentage: number;
    profitUSD: number;
    gasCost: number;
    netProfit: number;
    confidence: number;
    steps: TriangularStep[];
    timestamp: number;
    executionTime: number;
}
/**
 * T1.2: Dynamic slippage configuration for liquidity-aware calculations.
 * Instead of using a static maxSlippage, we calculate slippage dynamically
 * based on trade size relative to pool reserves.
 */
export interface DynamicSlippageConfig {
    /** Base slippage floor (minimum slippage regardless of liquidity) */
    baseSlippage: number;
    /** Scale factor for price impact contribution */
    priceImpactScale: number;
    /** Maximum allowed slippage (hard cap) */
    maxSlippage: number;
    /** Minimum liquidity (USD) for confident trades */
    minLiquidityUsd: number;
    /** Liquidity penalty scale (higher = more penalty for low liquidity) */
    liquidityPenaltyScale: number;
}
export declare class CrossDexTriangularArbitrage {
    private cache;
    private minProfitThreshold;
    private maxSlippage;
    private maxExecutionTime;
    /** T1.2: Dynamic slippage configuration */
    private slippageConfig;
    constructor(options?: {
        minProfitThreshold?: number;
        maxSlippage?: number;
        maxExecutionTime?: number;
        slippageConfig?: Partial<DynamicSlippageConfig>;
    });
    /**
     * T1.2: Calculate dynamic slippage based on trade size, pool reserves, and liquidity.
     *
     * Formula: slippage = baseSlippage + (priceImpact * priceImpactScale) + liquidityPenalty
     *
     * Where:
     * - priceImpact = tradeSize / (reserveIn + tradeSize) [standard AMM formula]
     * - liquidityPenalty = max(0, (minLiquidity - actualLiquidity) / minLiquidity * liquidityPenaltyScale * 0.01)
     *
     * @param tradeSize Trade size in pool units
     * @param reserveIn Reserve of input token
     * @param liquidityUsd Total pool liquidity in USD
     * @returns Dynamic slippage value (capped at maxSlippage)
     */
    calculateDynamicSlippage(tradeSize: number, reserveIn: number, liquidityUsd?: number): number;
    findTriangularOpportunities(chain: string, pools: DexPool[], baseTokens?: string[]): Promise<TriangularOpportunity[]>;
    /**
     * T2.6: Find quadrilateral (4-hop) arbitrage opportunities.
     * Detects A → B → C → D → A paths for potential profit.
     */
    findQuadrilateralOpportunities(chain: string, pools: DexPool[], baseTokens?: string[]): Promise<QuadrilateralOpportunity[]>;
    /**
     * T2.6: Find quadrilaterals starting from a specific base token.
     */
    private findQuadrilateralsFromBaseToken;
    /**
     * T2.6: Evaluate a potential quadrilateral arbitrage.
     */
    private evaluateQuadrilateral;
    /**
     * T2.6: Simulate a quadrilateral arbitrage execution.
     * Uses BigInt for precise wei calculations (same as triangular).
     */
    private simulateQuadrilateral;
    /**
     * T2.6: Filter and rank quadrilateral opportunities.
     */
    private filterAndRankQuadrilaterals;
    private findTrianglesFromBaseToken;
    private evaluateTriangle;
    private simulateTriangle;
    private simulateSwapBigInt;
    private groupPoolsByPairs;
    private findReachableTokens;
    private findBestPoolsForPair;
    private filterAndRankOpportunities;
    private estimateGasCost;
    private estimateExecutionTime;
    private calculateConfidence;
    getStatistics(): any;
    updateConfig(config: {
        minProfitThreshold?: number;
        maxSlippage?: number;
        maxExecutionTime?: number;
        slippageConfig?: Partial<DynamicSlippageConfig>;
    }): void;
    /**
     * T1.2: Get current slippage configuration.
     * Useful for debugging and monitoring.
     */
    getSlippageConfig(): DynamicSlippageConfig;
}
//# sourceMappingURL=cross-dex-triangular-arbitrage.d.ts.map