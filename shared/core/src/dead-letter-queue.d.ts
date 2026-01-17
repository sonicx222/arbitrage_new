export interface FailedOperation {
    id: string;
    operation: string;
    payload: any;
    error: {
        message: string;
        code?: string;
        stack?: string;
    };
    timestamp: number;
    retryCount: number;
    maxRetries: number;
    service: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    correlationId?: string;
    tags?: string[];
}
export interface DLQConfig {
    maxSize: number;
    retentionPeriod: number;
    retryEnabled: boolean;
    retryDelay: number;
    alertThreshold: number;
    batchSize: number;
}
export interface ProcessingResult {
    processed: number;
    succeeded: number;
    failed: number;
    retryScheduled: number;
}
export declare class DeadLetterQueue {
    private redis;
    private streamsClient;
    private config;
    private processingTimer?;
    private isProcessing;
    constructor(config?: Partial<DLQConfig>);
    /**
     * P1-18 FIX: Initialize Redis Streams client for dual-publish pattern.
     */
    private initializeStreamsClient;
    /**
     * P1-18 FIX: Dual-publish helper - publishes to both Redis Streams (primary)
     * and Pub/Sub (secondary/fallback) for backwards compatibility.
     */
    private dualPublish;
    enqueue(operation: Omit<FailedOperation, 'id' | 'timestamp'>): Promise<string>;
    processBatch(limit?: number): Promise<ProcessingResult>;
    getOperations(options?: {
        priority?: string;
        service?: string;
        tag?: string;
        limit?: number;
        offset?: number;
    }): Promise<FailedOperation[]>;
    getStats(): Promise<{
        totalOperations: number;
        byPriority: Record<string, number>;
        byService: Record<string, number>;
        byTag: Record<string, number>;
        oldestOperation: number;
        newestOperation: number;
        averageRetries: number;
    }>;
    retryOperation(operationId: string): Promise<boolean>;
    cleanup(): Promise<number>;
    startAutoProcessing(intervalMs?: number): void;
    stopAutoProcessing(): void;
    private generateId;
    private getQueueSize;
    private evictOldEntries;
    private getOperation;
    private processOperation;
    private simulateOperationProcessing;
    private shouldRetry;
    private scheduleRetry;
    private removeOperation;
    private findOperationInIndexes;
    private checkAlertThreshold;
}
export declare function getDeadLetterQueue(config?: Partial<DLQConfig>): DeadLetterQueue;
export declare function enqueueFailedOperation(operation: Omit<FailedOperation, 'id' | 'timestamp'>): Promise<string>;
//# sourceMappingURL=dead-letter-queue.d.ts.map