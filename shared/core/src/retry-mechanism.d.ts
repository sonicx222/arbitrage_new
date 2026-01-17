/**
 * Error classification for determining retry behavior.
 * P1-2 fix: Categorize errors as transient (retryable) vs permanent (not retryable).
 */
export declare enum ErrorCategory {
    TRANSIENT = "transient",// Temporary errors - retry
    PERMANENT = "permanent",// Permanent errors - don't retry
    UNKNOWN = "unknown"
}
/**
 * P1-2 fix: Classify an error to determine if it should be retried.
 */
export declare function classifyError(error: any): ErrorCategory;
/**
 * P1-2 fix: Check if an error should be retried based on classification.
 */
export declare function isRetryableError(error: any): boolean;
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
    /**
     * P0-8 FIX: Use classifyError() as single source of truth for retry decisions.
     *
     * Previous implementation was INCONSISTENT with classifyError():
     * - Didn't check RPC transient codes (-32005, -32603, etc.)
     * - Didn't handle 429 (rate limit) as retryable
     * - Didn't check transient message patterns
     *
     * Now delegates to isRetryableError() which uses classifyError() internally.
     */
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