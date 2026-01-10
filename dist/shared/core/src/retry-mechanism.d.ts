export interface RetryConfig {
    maxAttempts: number;
    initialDelay: number;
    maxDelay: number;
    backoffMultiplier: number;
    jitter: boolean;
    retryCondition?: (error: any) => boolean;
    onRetry?: (attempt: number, error: any, delay: number) => void;
}
export interface RetryResult<T> {
    success: boolean;
    result?: T;
    error?: any;
    attempts: number;
    totalDelay: number;
}
export declare class RetryMechanism {
    private config;
    constructor(config?: Partial<RetryConfig>);
    execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>>;
    executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<RetryResult<T>>;
    private calculateDelay;
    private defaultRetryCondition;
    private delay;
}
export declare class RetryPresets {
    static readonly NETWORK_CALL: RetryMechanism;
    static readonly DATABASE_OPERATION: RetryMechanism;
    static readonly EXTERNAL_API: RetryMechanism;
    static readonly BLOCKCHAIN_RPC: RetryMechanism;
}
export declare function withRetry(config?: Partial<RetryConfig>): (target: any, propertyName: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
export declare function retry<T>(fn: () => Promise<T>, config?: Partial<RetryConfig>): Promise<T>;
export declare function retryAdvanced<T>(fn: () => Promise<T>, options?: {
    maxAttempts?: number;
    delayFn?: (attempt: number) => number;
    shouldRetry?: (error: any, attempt: number) => boolean;
    onRetry?: (error: any, attempt: number) => void;
}): Promise<T>;
//# sourceMappingURL=retry-mechanism.d.ts.map