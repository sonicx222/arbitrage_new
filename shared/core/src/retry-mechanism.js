"use strict";
// Exponential Backoff and Retry Mechanism
// Intelligent retry logic with jitter and circuit breaker integration
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryPresets = exports.RetryMechanism = exports.ErrorCategory = void 0;
exports.classifyError = classifyError;
exports.isRetryableError = isRetryableError;
exports.withRetry = withRetry;
exports.retry = retry;
exports.retryAdvanced = retryAdvanced;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('retry-mechanism');
// =============================================================================
// P1-2 fix: Error Classification Utility
// =============================================================================
/**
 * Error classification for determining retry behavior.
 * P1-2 fix: Categorize errors as transient (retryable) vs permanent (not retryable).
 */
var ErrorCategory;
(function (ErrorCategory) {
    ErrorCategory["TRANSIENT"] = "transient";
    ErrorCategory["PERMANENT"] = "permanent";
    ErrorCategory["UNKNOWN"] = "unknown"; // Unknown - retry with caution
})(ErrorCategory || (exports.ErrorCategory = ErrorCategory = {}));
/**
 * P1-2 fix: Classify an error to determine if it should be retried.
 */
function classifyError(error) {
    if (!error)
        return ErrorCategory.PERMANENT;
    const errorName = error.name || error.constructor?.name || '';
    const errorCode = error.code;
    const statusCode = error.status || error.statusCode;
    const message = (error.message || '').toLowerCase();
    // Permanent errors - never retry
    // P1-10 FIX: Use exact matching instead of .includes() to prevent false positives
    // e.g., "MyValidationErrorHandler" should NOT match "ValidationError"
    const permanentErrors = [
        'ValidationError', 'AuthenticationError', 'AuthorizationError',
        'NotFoundError', 'InvalidInputError', 'CircuitBreakerError',
        'InsufficientFundsError', 'GasEstimationFailed'
    ];
    if (permanentErrors.some(type => errorName === type)) {
        return ErrorCategory.PERMANENT;
    }
    // Permanent HTTP status codes (4xx client errors, except 429)
    if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        return ErrorCategory.PERMANENT;
    }
    // Transient errors - always retry
    const transientCodes = [
        'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
        'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'
    ];
    if (errorCode && transientCodes.includes(errorCode)) {
        return ErrorCategory.TRANSIENT;
    }
    // Transient HTTP status codes
    const transientStatuses = [429, 500, 502, 503, 504];
    if (statusCode && transientStatuses.includes(statusCode)) {
        return ErrorCategory.TRANSIENT;
    }
    // Transient error messages
    const transientMessages = [
        'timeout', 'connection', 'network', 'retry', 'temporary',
        'rate limit', 'too many requests', 'service unavailable'
    ];
    if (transientMessages.some(msg => message.includes(msg))) {
        return ErrorCategory.TRANSIENT;
    }
    // Blockchain/RPC transient errors
    // P1-11 FIX: Removed duplicate -32603, added missing codes -32700 (parse error), -32600 (invalid request)
    // JSON-RPC 2.0 Error Codes: https://www.jsonrpc.org/specification#error_object
    const rpcTransientCodes = [
        -32700, // Parse error (malformed JSON - may be transient network issue)
        -32600, // Invalid request (can occur during node sync)
        -32000, // Server error (generic - often transient)
        -32005, // Rate limit exceeded
        -32603 // Internal error (often transient node issues)
    ];
    if (errorCode && rpcTransientCodes.includes(errorCode)) {
        return ErrorCategory.TRANSIENT;
    }
    // Unknown - default to retryable for resilience
    return ErrorCategory.UNKNOWN;
}
/**
 * P1-2 fix: Check if an error should be retried based on classification.
 */
function isRetryableError(error) {
    const category = classifyError(error);
    return category !== ErrorCategory.PERMANENT;
}
class RetryMechanism {
    constructor(config = {}) {
        this.config = {
            maxAttempts: config.maxAttempts || 3,
            initialDelay: config.initialDelay || 1000,
            maxDelay: config.maxDelay || 30000,
            backoffMultiplier: config.backoffMultiplier || 2,
            jitter: config.jitter !== false,
            retryCondition: config.retryCondition || this.defaultRetryCondition,
            onRetry: config.onRetry || (() => { })
        };
    }
    // Execute a function with retry logic
    async execute(fn) {
        let lastError;
        let totalDelay = 0;
        let attempt = 1;
        for (attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
            try {
                const result = await fn();
                return {
                    success: true,
                    result,
                    attempts: attempt,
                    totalDelay
                };
            }
            catch (error) {
                lastError = error;
                // Check if we should retry this error
                if (!this.config.retryCondition(error)) {
                    logger.debug('Error not retryable, giving up', { error: error.message, attempt });
                    break;
                }
                // Don't retry on the last attempt
                if (attempt === this.config.maxAttempts) {
                    break;
                }
                // Calculate delay for next attempt
                const delay = this.calculateDelay(attempt);
                logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
                    error: error.message,
                    attempt,
                    maxAttempts: this.config.maxAttempts
                });
                // Execute retry callback
                this.config.onRetry(attempt, error, delay);
                // Wait before retrying
                await this.delay(delay);
                totalDelay += delay;
            }
        }
        return {
            success: false,
            error: lastError,
            attempts: Math.min(this.config.maxAttempts, attempt),
            totalDelay
        };
    }
    // Execute with timeout protection
    async executeWithTimeout(fn, timeoutMs) {
        let timeoutHandle = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        try {
            const result = await Promise.race([this.execute(fn), timeoutPromise]);
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
            return result;
        }
        catch (error) {
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
            return {
                success: false,
                error,
                attempts: 1,
                totalDelay: 0
            };
        }
    }
    calculateDelay(attempt) {
        // Exponential backoff: delay = initialDelay * (backoffMultiplier ^ (attempt - 1))
        let delay = this.config.initialDelay * Math.pow(this.config.backoffMultiplier, attempt - 1);
        // Cap at maximum delay
        delay = Math.min(delay, this.config.maxDelay);
        // Add jitter to prevent thundering herd
        if (this.config.jitter) {
            // Add random jitter between 0% and 25% of the delay
            const jitterAmount = delay * 0.25 * Math.random();
            delay += jitterAmount;
        }
        return Math.floor(delay);
    }
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
    defaultRetryCondition(error) {
        // P0-8 FIX: Use single source of truth for error classification
        return isRetryableError(error);
    }
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.RetryMechanism = RetryMechanism;
// Pre-configured retry mechanisms for common use cases
class RetryPresets {
}
exports.RetryPresets = RetryPresets;
RetryPresets.NETWORK_CALL = new RetryMechanism({
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    jitter: true,
    retryCondition: (error) => {
        // Retry network-related errors
        return error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT' ||
            error.code === 'ENOTFOUND' ||
            (error.status && error.status >= 500);
    }
});
RetryPresets.DATABASE_OPERATION = new RetryMechanism({
    maxAttempts: 5,
    initialDelay: 500,
    maxDelay: 5000,
    backoffMultiplier: 1.5,
    jitter: true,
    retryCondition: (error) => {
        // Retry database connection and temporary errors
        return error.code === 'ECONNREFUSED' ||
            error.code === 'ETIMEDOUT' ||
            error.message?.includes('connection') ||
            error.message?.includes('timeout');
    }
});
RetryPresets.EXTERNAL_API = new RetryMechanism({
    maxAttempts: 3,
    initialDelay: 2000,
    maxDelay: 15000,
    backoffMultiplier: 2,
    jitter: true,
    retryCondition: (error) => {
        // Retry API rate limits and temporary failures
        return error.status === 429 || // Rate limited
            error.status === 503 || // Service unavailable
            error.status === 502 || // Bad gateway
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT';
    }
});
RetryPresets.BLOCKCHAIN_RPC = new RetryMechanism({
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    jitter: true,
    retryCondition: (error) => {
        // Retry RPC-specific errors
        return error.code === -32005 || // Request rate exceeded
            error.code === -32603 || // Internal error
            error.message?.includes('timeout') ||
            error.message?.includes('connection');
    }
});
// Decorator for automatic retry
function withRetry(config) {
    const retryMechanism = new RetryMechanism(config);
    return function (target, propertyName, descriptor) {
        const method = descriptor.value;
        descriptor.value = async function (...args) {
            const result = await retryMechanism.execute(() => method.apply(this, args));
            if (result.success) {
                return result.result;
            }
            else {
                throw result.error;
            }
        };
        return descriptor;
    };
}
// Utility function for simple retry operations
async function retry(fn, config) {
    const retryMechanism = new RetryMechanism(config);
    const result = await retryMechanism.execute(fn);
    if (result.success) {
        return result.result;
    }
    else {
        throw result.error;
    }
}
// Advanced retry with custom logic
async function retryAdvanced(fn, options = {}) {
    const { maxAttempts = 3, delayFn = (attempt) => Math.min(1000 * Math.pow(2, attempt - 1), 30000), shouldRetry = () => true, onRetry = () => { } } = options;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt === maxAttempts || !shouldRetry(error, attempt)) {
                throw error;
            }
            onRetry(error, attempt);
            await new Promise(resolve => setTimeout(resolve, delayFn(attempt)));
        }
    }
    throw lastError;
}
//# sourceMappingURL=retry-mechanism.js.map