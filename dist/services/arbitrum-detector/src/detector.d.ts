export declare class ArbitrumDetectorService {
    private provider;
    private wsProvider;
    private redis;
    private logger;
    private perfLogger;
    private dexes;
    private tokens;
    private pairs;
    private monitoredPairs;
    private isRunning;
    private eventBuffer;
    private processingInterval;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    private initializePairs;
    private connectWebSocket;
    private subscribeToEvents;
    private startUltraFastProcessing;
    private handleWebSocketMessage;
    private processEventBuffer;
    private processLogEvent;
    private processSyncEvent;
    private processSwapEvent;
    private calculatePrice;
    private checkIntraDexArbitrage;
    private checkWhaleActivity;
    private estimateUsdValue;
    private calculatePriceImpact;
    private publishPriceUpdate;
    private publishSwapEvent;
    private publishArbitrageOpportunity;
    private publishWhaleTransaction;
    private startHealthMonitoring;
}
//# sourceMappingURL=detector.d.ts.map