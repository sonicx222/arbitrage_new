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
export declare class CrossDexTriangularArbitrage {
    private cache;
    private minProfitThreshold;
    private maxSlippage;
    private maxExecutionTime;
    constructor(options?: {
        minProfitThreshold?: number;
        maxSlippage?: number;
        maxExecutionTime?: number;
    });
    findTriangularOpportunities(chain: string, pools: DexPool[], baseTokens?: string[]): Promise<TriangularOpportunity[]>;
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
    }): void;
}
//# sourceMappingURL=cross-dex-triangular-arbitrage.d.ts.map