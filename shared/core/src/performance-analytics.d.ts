export interface PerformanceMetrics {
    timestamp: number;
    period: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnL: number;
    realizedPnL: number;
    unrealizedPnL: number;
    maxDrawdown: number;
    currentDrawdown: number;
    volatility: number;
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    valueAtRisk: number;
    winRate: number;
    profitFactor: number;
    averageWin: number;
    averageLoss: number;
    largestWin: number;
    largestLoss: number;
    averageTradeDuration: number;
    alpha: number;
    beta: number;
    informationRatio: number;
    omegaRatio: number;
    byStrategy: {
        [strategy: string]: StrategyPerformance;
    };
    byAsset: {
        [asset: string]: AssetPerformance;
    };
    byTimeOfDay: {
        [hour: number]: TimePerformance;
    };
}
export interface StrategyPerformance {
    trades: number;
    pnl: number;
    winRate: number;
    sharpeRatio: number;
    contribution: number;
}
export interface AssetPerformance {
    trades: number;
    pnl: number;
    exposure: number;
    sharpeRatio: number;
    contribution: number;
}
export interface TimePerformance {
    trades: number;
    pnl: number;
    winRate: number;
    averageReturn: number;
}
export interface BenchmarkComparison {
    benchmark: string;
    strategyReturn: number;
    benchmarkReturn: number;
    excessReturn: number;
    trackingError: number;
    informationRatio: number;
}
export interface AttributionAnalysis {
    totalReturn: number;
    marketContribution: number;
    strategyContribution: number;
    assetAllocationContribution: number;
    securitySelectionContribution: number;
    interactionContribution: number;
}
export declare class PerformanceAnalyticsEngine {
    private redis;
    private tradeHistory;
    private maxHistorySize;
    constructor();
    recordTrade(trade: {
        id: string;
        strategy: string;
        asset: string;
        side: 'buy' | 'sell' | 'long' | 'short';
        entryTime: number;
        exitTime: number;
        entryPrice: number;
        exitPrice: number;
        quantity: number;
        realizedPnL: number;
        fees: number;
        slippage: number;
        executionTime: number;
    }): Promise<void>;
    calculateMetrics(period?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly', startDate?: number, endDate?: number): Promise<PerformanceMetrics>;
    compareWithBenchmark(strategyMetrics: PerformanceMetrics, benchmark: string, period?: 'daily' | 'weekly' | 'monthly'): Promise<BenchmarkComparison>;
    generateAttributionAnalysis(metrics: PerformanceMetrics, benchmark: string): Promise<AttributionAnalysis>;
    getPerformanceAlerts(metrics: PerformanceMetrics): Array<{
        level: 'info' | 'warning' | 'critical';
        message: string;
        metric: string;
        value: number;
        threshold: number;
    }>;
    generateReport(period?: 'daily' | 'weekly' | 'monthly', includeBenchmarks?: string[]): Promise<any>;
    private initializeTradeHistory;
    private getTradesInPeriod;
    private createEmptyMetrics;
    private calculateReturns;
    private calculateCumulativeReturns;
    private calculateVolatility;
    private calculateMaxDrawdown;
    private calculateCurrentDrawdown;
    private calculateSharpeRatio;
    private calculateSortinoRatio;
    private calculateVaR;
    private calculateBeta;
    private calculateOmegaRatio;
    private calculateCovariance;
    private calculateVariance;
    private calculateStrategyPerformance;
    private calculateAssetPerformance;
    private calculateTimePerformance;
    private getPeriodStart;
    private cacheMetrics;
    private getBenchmarkReturn;
    private calculateTrackingError;
}
//# sourceMappingURL=performance-analytics.d.ts.map