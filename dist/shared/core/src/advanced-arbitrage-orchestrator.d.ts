import { StatisticalSignal } from './advanced-statistical-arbitrage';
import { TriangularOpportunity } from './cross-dex-triangular-arbitrage';
export interface ArbitrageExecution {
    id: string;
    strategy: 'statistical' | 'triangular' | 'cross_chain';
    opportunities: Array<StatisticalSignal | TriangularOpportunity>;
    riskAssessment: any;
    executionPlan: ExecutionStep[];
    status: 'pending' | 'executing' | 'completed' | 'failed';
    startTime?: number;
    endTime?: number;
    profit?: number;
    gasCost?: number;
    netProfit?: number;
}
export interface ExecutionStep {
    type: 'swap' | 'bridge' | 'flash_loan' | 'repay';
    dex?: string;
    tokenIn: string;
    tokenOut: string;
    amount: string;
    expectedOut: string;
    slippage: number;
    gasEstimate: number;
}
export declare class AdvancedArbitrageOrchestrator {
    private redis;
    private statisticalArb;
    private riskManager;
    private triangularArb;
    private selfHealing;
    private activeExecutions;
    private isRunning;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    analyzeMarketConditions(chain: string): Promise<{
        statisticalSignals: StatisticalSignal[];
        triangularOpportunities: TriangularOpportunity[];
        marketRegime: string;
        riskAssessment: any;
    }>;
    executeArbitrageOpportunity(opportunity: StatisticalSignal | TriangularOpportunity, strategy: 'statistical' | 'triangular'): Promise<ArbitrageExecution>;
    executeBatchArbitrage(opportunities: Array<{
        opportunity: StatisticalSignal | TriangularOpportunity;
        strategy: 'statistical' | 'triangular';
    }>): Promise<ArbitrageExecution[]>;
    getExecutionStats(timeframe?: number): {
        totalExecutions: number;
        successfulExecutions: number;
        failedExecutions: number;
        totalProfit: number;
        averageProfit: number;
        winRate: number;
        averageExecutionTime: number;
    };
    private initializeOrchestrator;
    private subscribeToMarketData;
    private subscribeToArbitrageSignals;
    private getMarketData;
    private assessArbitrageRisk;
    private determineMarketRegime;
    private createExecutionPlan;
    private validateExecution;
    private performExecution;
    private cancelExecution;
    private handlePriceUpdate;
    private handleArbitrageOpportunity;
    private handleStatisticalSignal;
    private handleTriangularOpportunity;
    private chunkArray;
}
export declare function getAdvancedArbitrageOrchestrator(): Promise<AdvancedArbitrageOrchestrator>;
//# sourceMappingURL=advanced-arbitrage-orchestrator.d.ts.map