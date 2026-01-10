export declare class BSCDetectorService {
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
    private eventBatcher;
    private reconnectionTimer;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    private scheduleReconnection;
    private initializePairs;
    private connectWebSocket;
    private subscribeToEvents;
    private handleWebSocketMessage;
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
    private processBatchedEvents;
    private startHealthMonitoring;
}
//# sourceMappingURL=detector.d.ts.map