export declare class WasmArbitrageEngine {
    private calculator;
    private performanceMonitor;
    private initialized;
    initialize(): Promise<void>;
    findArbitrageOpportunities(priceData: {
        [pairKey: string]: {
            [dex: string]: number;
        };
    }, minProfit: number): Array<{
        pairKey: string;
        profit: number;
        buyPrice: number;
        sellPrice: number;
    }>;
    calculateTriangularArbitrage(p0: number, p1: number, p2: number, fee: number): number;
    calculateCrossChainArbitrage(sourcePrice: number, targetPrice: number, bridgeFee: number, gasCost: number): number;
    batchCalculateOpportunities(prices: number[], minProfit: number): Array<{
        pairIndex: number;
        profit: number;
    }>;
    optimizeGasPrice(baseFee: number, priorityFee: number, volatility: number): number;
    getPerformanceMetrics(): {
        averageLatency: number;
        operationsPerSecond: number;
    };
    calculateProfitPercentage(buyPrice: number, sellPrice: number, fee: number): number;
    calculateOptimalTradeSize(balance: number, price: number, maxSlippage: number): number;
    calculateRiskAdjustedPositionSize(balance: number, riskPercentage: number, stopLoss: number): number;
    movingAverage(prices: number[], window: number): number[];
    exponentialMovingAverage(prices: number[], alpha: number): number[];
    bollingerBands(prices: number[], window: number, stdMultiplier: number): Array<{
        upper: number;
        middle: number;
        lower: number;
    }>;
    statisticalArbitrageSignal(currentPrice: number, mean: number, stdDev: number, zThreshold: number): number;
    calculateImpermanentLoss(priceRatio: number, poolRatio: number): number;
}
export declare function getWasmArbitrageEngine(): Promise<WasmArbitrageEngine>;
export type ArbitrageOpportunity = {
    pairKey: string;
    profit: number;
    buyPrice: number;
    sellPrice: number;
};
export type BollingerBands = {
    upper: number;
    middle: number;
    lower: number;
};
//# sourceMappingURL=index.d.ts.map