/**
 * Shared Error Handling Utilities
 *
 * REF-3/ARCH-2 FIX: Standardized error handling patterns across services.
 * Provides consistent error types, codes, and handling utilities.
 *
 * Used by:
 * - All services for consistent error reporting
 * - Coordinator for error aggregation and monitoring
 * - API endpoints for error responses
 *
 * @see ARCHITECTURE_V2.md Section 4.5 (Error Handling)
 */
/**
 * Standardized error codes for the arbitrage system.
 */
export declare enum ErrorCode {
    UNKNOWN_ERROR = 1000,
    INVALID_ARGUMENT = 1001,
    NOT_FOUND = 1002,
    ALREADY_EXISTS = 1003,
    PERMISSION_DENIED = 1004,
    INVALID_STATE = 1005,
    OPERATION_CANCELLED = 1006,
    CONNECTION_FAILED = 2000,
    CONNECTION_TIMEOUT = 2001,
    CONNECTION_CLOSED = 2002,
    RECONNECTION_FAILED = 2003,
    WEBSOCKET_ERROR = 2004,
    REDIS_CONNECTION_ERROR = 3000,
    REDIS_OPERATION_ERROR = 3001,
    REDIS_LOCK_ERROR = 3002,
    REDIS_STREAM_ERROR = 3003,
    RPC_ERROR = 4000,
    RPC_TIMEOUT = 4001,
    RPC_RATE_LIMITED = 4002,
    INVALID_BLOCK = 4003,
    INVALID_TRANSACTION = 4004,
    CONTRACT_ERROR = 4005,
    CHAIN_REORG = 4006,
    NO_OPPORTUNITY = 5000,
    INSUFFICIENT_LIQUIDITY = 5001,
    PRICE_SLIPPAGE = 5002,
    GAS_TOO_HIGH = 5003,
    EXECUTION_FAILED = 5004,
    OPPORTUNITY_EXPIRED = 5005,
    UNPROFITABLE = 5006,
    VALIDATION_FAILED = 6000,
    INVALID_MESSAGE = 6001,
    INVALID_CONFIG = 6002,
    SCHEMA_MISMATCH = 6003,
    SERVICE_NOT_STARTED = 7000,
    SERVICE_ALREADY_RUNNING = 7001,
    SERVICE_STOPPING = 7002,
    SHUTDOWN_TIMEOUT = 7003,
    INITIALIZATION_FAILED = 7004
}
/**
 * Error severity levels.
 */
export declare enum ErrorSeverity {
    /** Informational - expected errors that don't require action */
    INFO = "info",
    /** Warning - unexpected but recoverable errors */
    WARNING = "warning",
    /** Error - failures that may impact functionality */
    ERROR = "error",
    /** Critical - severe failures requiring immediate attention */
    CRITICAL = "critical"
}
/**
 * Base error class for the arbitrage system.
 * Provides structured error information for logging and monitoring.
 */
export declare class ArbitrageError extends Error {
    readonly code: ErrorCode;
    readonly severity: ErrorSeverity;
    readonly timestamp: number;
    readonly context?: Record<string, unknown>;
    readonly cause?: Error;
    constructor(message: string, code?: ErrorCode, options?: {
        severity?: ErrorSeverity;
        context?: Record<string, unknown>;
        cause?: Error;
    });
    /**
     * Convert to JSON for logging/serialization.
     */
    toJSON(): Record<string, unknown>;
}
/**
 * Connection error for network/WebSocket failures.
 */
export declare class ConnectionError extends ArbitrageError {
    readonly endpoint?: string;
    readonly retryable: boolean;
    constructor(message: string, options?: {
        code?: ErrorCode;
        endpoint?: string;
        retryable?: boolean;
        cause?: Error;
        context?: Record<string, unknown>;
    });
}
/**
 * Validation error for invalid input/messages.
 */
export declare class ValidationError extends ArbitrageError {
    readonly field?: string;
    readonly expectedType?: string;
    readonly receivedValue?: unknown;
    constructor(message: string, options?: {
        field?: string;
        expectedType?: string;
        receivedValue?: unknown;
        context?: Record<string, unknown>;
    });
}
/**
 * Service lifecycle error for start/stop issues.
 */
export declare class LifecycleError extends ArbitrageError {
    readonly serviceName: string;
    readonly currentState?: string;
    constructor(message: string, serviceName: string, options?: {
        code?: ErrorCode;
        currentState?: string;
        cause?: Error;
        context?: Record<string, unknown>;
    });
}
/**
 * Execution error for arbitrage execution failures.
 */
export declare class ExecutionError extends ArbitrageError {
    readonly opportunityId?: string;
    readonly chain?: string;
    readonly transactionHash?: string;
    constructor(message: string, options?: {
        code?: ErrorCode;
        opportunityId?: string;
        chain?: string;
        transactionHash?: string;
        cause?: Error;
        context?: Record<string, unknown>;
    });
}
/**
 * Result type for operations that may fail.
 */
export type Result<T, E = ArbitrageError> = {
    success: true;
    data: T;
} | {
    success: false;
    error: E;
};
/**
 * Create a success result.
 */
export declare function success<T>(data: T): Result<T>;
/**
 * Create a failure result.
 */
export declare function failure<E extends ArbitrageError>(error: E): Result<never, E>;
/**
 * Wrap an async function to return Result type instead of throwing.
 */
export declare function tryCatch<T>(fn: () => Promise<T>, errorCode?: ErrorCode): Promise<Result<T>>;
/**
 * Wrap a sync function to return Result type instead of throwing.
 */
export declare function tryCatchSync<T>(fn: () => T, errorCode?: ErrorCode): Result<T>;
/**
 * Check if an error is retryable.
 */
export declare function isRetryableError(error: Error): boolean;
/**
 * Check if an error is a critical error requiring immediate attention.
 */
export declare function isCriticalError(error: Error): boolean;
/**
 * Get error severity based on error type and context.
 */
export declare function getErrorSeverity(error: Error): ErrorSeverity;
/**
 * Format error for logging.
 */
export declare function formatErrorForLog(error: Error): Record<string, unknown>;
/**
 * Format error for API response.
 */
export declare function formatErrorForResponse(error: Error): {
    code: number;
    message: string;
    details?: Record<string, unknown>;
};
/**
 * Error aggregator for collecting multiple errors.
 */
export declare class ErrorAggregator {
    private errors;
    private readonly maxErrors;
    constructor(maxErrors?: number);
    /**
     * Add an error to the aggregator.
     */
    add(error: Error): void;
    /**
     * Get all errors.
     */
    getAll(): ArbitrageError[];
    /**
     * Get errors by severity.
     */
    getBySeverity(severity: ErrorSeverity): ArbitrageError[];
    /**
     * Get errors by code.
     */
    getByCode(code: ErrorCode): ArbitrageError[];
    /**
     * Get error count.
     */
    count(): number;
    /**
     * Get error count by severity.
     */
    countBySeverity(): Record<ErrorSeverity, number>;
    /**
     * Clear all errors.
     */
    clear(): void;
    /**
     * Check if there are any critical errors.
     */
    hasCriticalErrors(): boolean;
}
//# sourceMappingURL=error-handling.d.ts.map