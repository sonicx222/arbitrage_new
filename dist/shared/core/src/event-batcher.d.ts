export interface BatchedEvent {
    pairKey: string;
    events: any[];
    timestamp: number;
    batchSize: number;
}
export interface BatchConfig {
    maxBatchSize: number;
    maxWaitTime: number;
    enableDeduplication: boolean;
    enablePrioritization: boolean;
}
export declare class EventBatcher {
    private batches;
    private config;
    private onBatchReady;
    private processingQueue;
    private isProcessing;
    constructor(config: Partial<BatchConfig> | undefined, onBatchReady: (batch: BatchedEvent) => void);
    addEvent(event: any, pairKey?: string): void;
    addEvents(events: any[], pairKey?: string): void;
    flushBatch(pairKey: string): void;
    flushAll(): void;
    getStats(): {
        activeBatches: number;
        queuedBatches: number;
        totalEventsProcessed: number;
        averageBatchSize: number;
    };
    private extractPairKey;
    private isDuplicateEvent;
    private getEventKey;
    private sortProcessingQueue;
    private processQueue;
    private processEventImmediately;
    destroy(): void;
}
export declare function createEventBatcher(config: Partial<BatchConfig>, onBatchReady: (batch: BatchedEvent) => void): EventBatcher;
export declare function getDefaultEventBatcher(): EventBatcher;
//# sourceMappingURL=event-batcher.d.ts.map