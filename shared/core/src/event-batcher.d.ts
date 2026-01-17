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
    maxQueueSize?: number;
}
export declare class EventBatcher {
    private batches;
    private config;
    private onBatchReady;
    private processingQueue;
    private isProcessing;
    private processingLock;
    private droppedBatches;
    constructor(config: Partial<BatchConfig> | undefined, onBatchReady: (batch: BatchedEvent) => void);
    addEvent(event: any, pairKey?: string): void;
    addEvents(events: any[], pairKey?: string): void;
    flushBatch(pairKey: string): void;
    /**
     * Flush all pending batches and process remaining queue items.
     * BUG FIX: Made async to properly await processQueue() completion.
     */
    flushAll(): Promise<void>;
    getStats(): {
        activeBatches: number;
        queuedBatches: number;
        totalEventsProcessed: number;
        averageBatchSize: number;
        droppedBatches: number;
        maxQueueSize: number;
    };
    private extractPairKey;
    private isDuplicateEvent;
    private getEventKey;
    private sortProcessingQueue;
    /**
     * Process the queue with mutex lock to prevent TOCTOU race condition.
     * P2-FIX: Uses Promise-based lock to ensure only one processQueue runs at a time.
     */
    private processQueue;
    private processEventImmediately;
    /**
     * Cleanup method.
     * P2-2 fix: Made async to properly wait for pending processing to complete.
     */
    destroy(): Promise<void>;
}
export declare function createEventBatcher(config: Partial<BatchConfig>, onBatchReady: (batch: BatchedEvent) => void): EventBatcher;
export declare function getDefaultEventBatcher(): EventBatcher;
//# sourceMappingURL=event-batcher.d.ts.map