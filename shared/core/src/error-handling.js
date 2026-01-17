"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorAggregator = exports.ExecutionError = exports.LifecycleError = exports.ValidationError = exports.ConnectionError = exports.ArbitrageError = exports.ErrorSeverity = exports.ErrorCode = void 0;
exports.success = success;
exports.failure = failure;
exports.tryCatch = tryCatch;
exports.tryCatchSync = tryCatchSync;
exports.isRetryableError = isRetryableError;
exports.isCriticalError = isCriticalError;
exports.getErrorSeverity = getErrorSeverity;
exports.formatErrorForLog = formatErrorForLog;
exports.formatErrorForResponse = formatErrorForResponse;
// =============================================================================
// Error Codes
// =============================================================================
/**
 * Standardized error codes for the arbitrage system.
 */
var ErrorCode;
(function (ErrorCode) {
    // General errors (1000-1999)
    ErrorCode[ErrorCode["UNKNOWN_ERROR"] = 1000] = "UNKNOWN_ERROR";
    ErrorCode[ErrorCode["INVALID_ARGUMENT"] = 1001] = "INVALID_ARGUMENT";
    ErrorCode[ErrorCode["NOT_FOUND"] = 1002] = "NOT_FOUND";
    ErrorCode[ErrorCode["ALREADY_EXISTS"] = 1003] = "ALREADY_EXISTS";
    ErrorCode[ErrorCode["PERMISSION_DENIED"] = 1004] = "PERMISSION_DENIED";
    ErrorCode[ErrorCode["INVALID_STATE"] = 1005] = "INVALID_STATE";
    ErrorCode[ErrorCode["OPERATION_CANCELLED"] = 1006] = "OPERATION_CANCELLED";
    // Connection errors (2000-2999)
    ErrorCode[ErrorCode["CONNECTION_FAILED"] = 2000] = "CONNECTION_FAILED";
    ErrorCode[ErrorCode["CONNECTION_TIMEOUT"] = 2001] = "CONNECTION_TIMEOUT";
    ErrorCode[ErrorCode["CONNECTION_CLOSED"] = 2002] = "CONNECTION_CLOSED";
    ErrorCode[ErrorCode["RECONNECTION_FAILED"] = 2003] = "RECONNECTION_FAILED";
    ErrorCode[ErrorCode["WEBSOCKET_ERROR"] = 2004] = "WEBSOCKET_ERROR";
    // Redis errors (3000-3999)
    ErrorCode[ErrorCode["REDIS_CONNECTION_ERROR"] = 3000] = "REDIS_CONNECTION_ERROR";
    ErrorCode[ErrorCode["REDIS_OPERATION_ERROR"] = 3001] = "REDIS_OPERATION_ERROR";
    ErrorCode[ErrorCode["REDIS_LOCK_ERROR"] = 3002] = "REDIS_LOCK_ERROR";
    ErrorCode[ErrorCode["REDIS_STREAM_ERROR"] = 3003] = "REDIS_STREAM_ERROR";
    // Blockchain errors (4000-4999)
    ErrorCode[ErrorCode["RPC_ERROR"] = 4000] = "RPC_ERROR";
    ErrorCode[ErrorCode["RPC_TIMEOUT"] = 4001] = "RPC_TIMEOUT";
    ErrorCode[ErrorCode["RPC_RATE_LIMITED"] = 4002] = "RPC_RATE_LIMITED";
    ErrorCode[ErrorCode["INVALID_BLOCK"] = 4003] = "INVALID_BLOCK";
    ErrorCode[ErrorCode["INVALID_TRANSACTION"] = 4004] = "INVALID_TRANSACTION";
    ErrorCode[ErrorCode["CONTRACT_ERROR"] = 4005] = "CONTRACT_ERROR";
    ErrorCode[ErrorCode["CHAIN_REORG"] = 4006] = "CHAIN_REORG";
    // Arbitrage errors (5000-5999)
    ErrorCode[ErrorCode["NO_OPPORTUNITY"] = 5000] = "NO_OPPORTUNITY";
    ErrorCode[ErrorCode["INSUFFICIENT_LIQUIDITY"] = 5001] = "INSUFFICIENT_LIQUIDITY";
    ErrorCode[ErrorCode["PRICE_SLIPPAGE"] = 5002] = "PRICE_SLIPPAGE";
    ErrorCode[ErrorCode["GAS_TOO_HIGH"] = 5003] = "GAS_TOO_HIGH";
    ErrorCode[ErrorCode["EXECUTION_FAILED"] = 5004] = "EXECUTION_FAILED";
    ErrorCode[ErrorCode["OPPORTUNITY_EXPIRED"] = 5005] = "OPPORTUNITY_EXPIRED";
    ErrorCode[ErrorCode["UNPROFITABLE"] = 5006] = "UNPROFITABLE";
    // Validation errors (6000-6999)
    ErrorCode[ErrorCode["VALIDATION_FAILED"] = 6000] = "VALIDATION_FAILED";
    ErrorCode[ErrorCode["INVALID_MESSAGE"] = 6001] = "INVALID_MESSAGE";
    ErrorCode[ErrorCode["INVALID_CONFIG"] = 6002] = "INVALID_CONFIG";
    ErrorCode[ErrorCode["SCHEMA_MISMATCH"] = 6003] = "SCHEMA_MISMATCH";
    // Service lifecycle errors (7000-7999)
    ErrorCode[ErrorCode["SERVICE_NOT_STARTED"] = 7000] = "SERVICE_NOT_STARTED";
    ErrorCode[ErrorCode["SERVICE_ALREADY_RUNNING"] = 7001] = "SERVICE_ALREADY_RUNNING";
    ErrorCode[ErrorCode["SERVICE_STOPPING"] = 7002] = "SERVICE_STOPPING";
    ErrorCode[ErrorCode["SHUTDOWN_TIMEOUT"] = 7003] = "SHUTDOWN_TIMEOUT";
    ErrorCode[ErrorCode["INITIALIZATION_FAILED"] = 7004] = "INITIALIZATION_FAILED";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
/**
 * Error severity levels.
 */
var ErrorSeverity;
(function (ErrorSeverity) {
    /** Informational - expected errors that don't require action */
    ErrorSeverity["INFO"] = "info";
    /** Warning - unexpected but recoverable errors */
    ErrorSeverity["WARNING"] = "warning";
    /** Error - failures that may impact functionality */
    ErrorSeverity["ERROR"] = "error";
    /** Critical - severe failures requiring immediate attention */
    ErrorSeverity["CRITICAL"] = "critical";
})(ErrorSeverity || (exports.ErrorSeverity = ErrorSeverity = {}));
// =============================================================================
// Custom Error Classes
// =============================================================================
/**
 * Base error class for the arbitrage system.
 * Provides structured error information for logging and monitoring.
 */
class ArbitrageError extends Error {
    constructor(message, code = ErrorCode.UNKNOWN_ERROR, options = {}) {
        super(message);
        this.name = 'ArbitrageError';
        this.code = code;
        this.severity = options.severity ?? ErrorSeverity.ERROR;
        this.timestamp = Date.now();
        this.context = options.context;
        this.cause = options.cause;
        // Capture stack trace
        Error.captureStackTrace?.(this, this.constructor);
    }
    /**
     * Convert to JSON for logging/serialization.
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            severity: this.severity,
            timestamp: this.timestamp,
            context: this.context,
            cause: this.cause?.message,
            stack: this.stack
        };
    }
}
exports.ArbitrageError = ArbitrageError;
/**
 * Connection error for network/WebSocket failures.
 */
class ConnectionError extends ArbitrageError {
    constructor(message, options = {}) {
        super(message, options.code ?? ErrorCode.CONNECTION_FAILED, {
            severity: ErrorSeverity.WARNING,
            cause: options.cause,
            context: { ...options.context, endpoint: options.endpoint }
        });
        this.name = 'ConnectionError';
        this.endpoint = options.endpoint;
        this.retryable = options.retryable ?? true;
    }
}
exports.ConnectionError = ConnectionError;
/**
 * Validation error for invalid input/messages.
 */
class ValidationError extends ArbitrageError {
    constructor(message, options = {}) {
        super(message, ErrorCode.VALIDATION_FAILED, {
            severity: ErrorSeverity.WARNING,
            context: {
                ...options.context,
                field: options.field,
                expectedType: options.expectedType,
                receivedValue: typeof options.receivedValue
            }
        });
        this.name = 'ValidationError';
        this.field = options.field;
        this.expectedType = options.expectedType;
        this.receivedValue = options.receivedValue;
    }
}
exports.ValidationError = ValidationError;
/**
 * Service lifecycle error for start/stop issues.
 */
class LifecycleError extends ArbitrageError {
    constructor(message, serviceName, options = {}) {
        super(message, options.code ?? ErrorCode.INVALID_STATE, {
            severity: ErrorSeverity.ERROR,
            cause: options.cause,
            context: { ...options.context, serviceName, currentState: options.currentState }
        });
        this.name = 'LifecycleError';
        this.serviceName = serviceName;
        this.currentState = options.currentState;
    }
}
exports.LifecycleError = LifecycleError;
/**
 * Execution error for arbitrage execution failures.
 */
class ExecutionError extends ArbitrageError {
    constructor(message, options = {}) {
        super(message, options.code ?? ErrorCode.EXECUTION_FAILED, {
            severity: ErrorSeverity.ERROR,
            cause: options.cause,
            context: {
                ...options.context,
                opportunityId: options.opportunityId,
                chain: options.chain,
                transactionHash: options.transactionHash
            }
        });
        this.name = 'ExecutionError';
        this.opportunityId = options.opportunityId;
        this.chain = options.chain;
        this.transactionHash = options.transactionHash;
    }
}
exports.ExecutionError = ExecutionError;
/**
 * Create a success result.
 */
function success(data) {
    return { success: true, data };
}
/**
 * Create a failure result.
 */
function failure(error) {
    return { success: false, error };
}
/**
 * Wrap an async function to return Result type instead of throwing.
 */
async function tryCatch(fn, errorCode = ErrorCode.UNKNOWN_ERROR) {
    try {
        const data = await fn();
        return success(data);
    }
    catch (error) {
        if (error instanceof ArbitrageError) {
            return failure(error);
        }
        return failure(new ArbitrageError(error.message || 'Unknown error', errorCode, { cause: error }));
    }
}
/**
 * Wrap a sync function to return Result type instead of throwing.
 */
function tryCatchSync(fn, errorCode = ErrorCode.UNKNOWN_ERROR) {
    try {
        const data = fn();
        return success(data);
    }
    catch (error) {
        if (error instanceof ArbitrageError) {
            return failure(error);
        }
        return failure(new ArbitrageError(error.message || 'Unknown error', errorCode, { cause: error }));
    }
}
// =============================================================================
// Error Classification
// =============================================================================
/**
 * Check if an error is retryable.
 */
function isRetryableError(error) {
    if (error instanceof ConnectionError) {
        return error.retryable;
    }
    if (error instanceof ArbitrageError) {
        // Retryable error codes
        const retryableCodes = new Set([
            ErrorCode.CONNECTION_TIMEOUT,
            ErrorCode.RPC_TIMEOUT,
            ErrorCode.RPC_RATE_LIMITED,
            ErrorCode.REDIS_CONNECTION_ERROR,
            ErrorCode.RECONNECTION_FAILED
        ]);
        return retryableCodes.has(error.code);
    }
    // Check for common retryable error patterns
    const message = error.message.toLowerCase();
    return (message.includes('timeout') ||
        message.includes('rate limit') ||
        message.includes('connection') ||
        message.includes('econnreset') ||
        message.includes('econnrefused'));
}
/**
 * Check if an error is a critical error requiring immediate attention.
 */
function isCriticalError(error) {
    if (error instanceof ArbitrageError) {
        return error.severity === ErrorSeverity.CRITICAL;
    }
    // Check for critical error patterns
    const message = error.message.toLowerCase();
    return (message.includes('out of memory') ||
        message.includes('fatal') ||
        message.includes('corrupt'));
}
/**
 * Get error severity based on error type and context.
 */
function getErrorSeverity(error) {
    if (error instanceof ArbitrageError) {
        return error.severity;
    }
    if (isCriticalError(error)) {
        return ErrorSeverity.CRITICAL;
    }
    if (isRetryableError(error)) {
        return ErrorSeverity.WARNING;
    }
    return ErrorSeverity.ERROR;
}
// =============================================================================
// Error Formatting
// =============================================================================
/**
 * Format error for logging.
 */
function formatErrorForLog(error) {
    if (error instanceof ArbitrageError) {
        return error.toJSON();
    }
    return {
        name: error.name,
        message: error.message,
        stack: error.stack
    };
}
/**
 * Format error for API response.
 */
function formatErrorForResponse(error) {
    if (error instanceof ArbitrageError) {
        return {
            code: error.code,
            message: error.message,
            details: error.context
        };
    }
    return {
        code: ErrorCode.UNKNOWN_ERROR,
        message: error.message
    };
}
// =============================================================================
// Error Aggregation
// =============================================================================
/**
 * Error aggregator for collecting multiple errors.
 */
class ErrorAggregator {
    constructor(maxErrors = 100) {
        this.errors = [];
        this.maxErrors = maxErrors;
    }
    /**
     * Add an error to the aggregator.
     */
    add(error) {
        const arbitrageError = error instanceof ArbitrageError
            ? error
            : new ArbitrageError(error.message, ErrorCode.UNKNOWN_ERROR, { cause: error });
        this.errors.push(arbitrageError);
        // Trim oldest errors if over limit
        if (this.errors.length > this.maxErrors) {
            this.errors = this.errors.slice(-this.maxErrors);
        }
    }
    /**
     * Get all errors.
     */
    getAll() {
        return [...this.errors];
    }
    /**
     * Get errors by severity.
     */
    getBySeverity(severity) {
        return this.errors.filter(e => e.severity === severity);
    }
    /**
     * Get errors by code.
     */
    getByCode(code) {
        return this.errors.filter(e => e.code === code);
    }
    /**
     * Get error count.
     */
    count() {
        return this.errors.length;
    }
    /**
     * Get error count by severity.
     */
    countBySeverity() {
        return {
            [ErrorSeverity.INFO]: this.getBySeverity(ErrorSeverity.INFO).length,
            [ErrorSeverity.WARNING]: this.getBySeverity(ErrorSeverity.WARNING).length,
            [ErrorSeverity.ERROR]: this.getBySeverity(ErrorSeverity.ERROR).length,
            [ErrorSeverity.CRITICAL]: this.getBySeverity(ErrorSeverity.CRITICAL).length
        };
    }
    /**
     * Clear all errors.
     */
    clear() {
        this.errors = [];
    }
    /**
     * Check if there are any critical errors.
     */
    hasCriticalErrors() {
        return this.errors.some(e => e.severity === ErrorSeverity.CRITICAL);
    }
}
exports.ErrorAggregator = ErrorAggregator;
//# sourceMappingURL=error-handling.js.map