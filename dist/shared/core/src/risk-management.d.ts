export interface Position {
    id: string;
    pair: string;
    type: 'arbitrage' | 'hedge' | 'speculation';
    size: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnL: number;
    timestamp: number;
    riskMetrics: PositionRisk;
}
export interface PositionRisk {
    volatility: number;
    liquidityRisk: number;
    counterpartyRisk: number;
    slippageRisk: number;
    gasRisk: number;
    impermanentLossRisk: number;
    totalRisk: number;
}
export interface PortfolioMetrics {
    totalValue: number;
    totalPnL: number;
    realizedPnL: number;
    unrealizedPnL: number;
    maxDrawdown: number;
    sharpeRatio: number;
    sortinoRatio: number;
    winRate: number;
    profitFactor: number;
    calmarRatio: number;
    currentDrawdown: number;
    dailyPnL: number[];
    weeklyPnL: number[];
    monthlyPnL: number[];
}
export interface RiskLimits {
    maxDrawdown: number;
    maxPositionSize: number;
    maxDailyLoss: number;
    maxConcentration: number;
    maxVolatility: number;
    minLiquidity: number;
    maxLeverage: number;
}
export interface RiskAlert {
    id: string;
    type: 'warning' | 'critical' | 'emergency';
    message: string;
    metric: string;
    value: number;
    threshold: number;
    timestamp: number;
    actions: string[];
}
export declare class RiskManagementEngine {
    private redis;
    private positions;
    private portfolioMetrics;
    private riskLimits;
    private alerts;
    private dailyPnL;
    private isRiskManagementActive;
    constructor(riskLimits?: Partial<RiskLimits>);
    calculateOptimalPositionSize(winProbability: number, winLossRatio: number, currentPortfolioValue: number): number;
    calculateVolatilityAdjustedPositionSize(volatility: number, stopLoss: number, portfolioValue: number, riskPerTrade?: number): number;
    addPosition(position: Omit<Position, 'unrealizedPnL' | 'riskMetrics'>): Promise<boolean>;
    updatePosition(positionId: string, currentPrice: number): Promise<void>;
    closePosition(positionId: string, exitPrice: number): Promise<number>;
    private canAddPosition;
    private calculatePositionRisk;
    private calculateVolatilityRisk;
    private calculateLiquidityRisk;
    private calculateSlippageRisk;
    private calculateGasRisk;
    private calculateImpermanentLossRisk;
    private calculateCounterpartyRisk;
    private checkPositionRiskLimits;
    private updatePortfolioMetrics;
    private calculateDrawdown;
    private calculateRiskAdjustedMetrics;
    private updateDailyPnL;
    private createRiskAlert;
    getPortfolioMetrics(): PortfolioMetrics;
    getActiveAlerts(): RiskAlert[];
    private calculateMaxSizeByDrawdown;
    private calculateMaxSizeByConcentration;
    private initializePortfolioMetrics;
    emergencyStop(): Promise<void>;
    resume(): void;
}
//# sourceMappingURL=risk-management.d.ts.map