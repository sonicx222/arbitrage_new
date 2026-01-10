export declare class ExecutionEngineService {
    private redis;
    private logger;
    private perfLogger;
    private wallets;
    private providers;
    private isRunning;
    private executionQueue;
    private activeExecutions;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    private initializeProviders;
    private initializeWallets;
    private subscribeToOpportunities;
    private handleArbitrageOpportunity;
    private validateOpportunity;
    private startExecutionProcessing;
    private executeOpportunity;
    private executeIntraChainArbitrage;
    private executeCrossChainArbitrage;
    private prepareFlashLoanTransaction;
    private buildSwapPath;
    private getFlashLoanContract;
    private applyMEVProtection;
    private getOptimalGasPrice;
    private calculateActualProfit;
    private publishExecutionResult;
    private startHealthMonitoring;
}
//# sourceMappingURL=engine.d.ts.map