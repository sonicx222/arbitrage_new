"use strict";
// Exponential Backoff and Retry Mechanism
// Intelligent retry logic with jitter and circuit breaker integration
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryPresets = exports.RetryMechanism = void 0;
exports.withRetry = withRetry;
exports.retry = retry;
exports.retryAdvanced = retryAdvanced;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('retry-mechanism');
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
        for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
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
            attempts: this.config.maxAttempts,
            totalDelay
        };
    }
    // Execute with timeout protection
    async executeWithTimeout(fn, timeoutMs) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        const executePromise = this.execute(fn);
        try {
            return await Promise.race([executePromise, timeoutPromise.then(() => {
                    throw new Error(`Operation timed out after ${timeoutMs}ms`);
                })]);
        }
        catch (error) {
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
    defaultRetryCondition(error) {
        // Default retry conditions
        if (!error)
            return false;
        // Don't retry certain types of errors
        const nonRetryableErrors = [
            'CircuitBreakerError',
            'ValidationError',
            'AuthenticationError',
            'AuthorizationError',
            'NotFoundError'
        ];
        const errorName = error.name || error.constructor?.name || '';
        if (nonRetryableErrors.some(type => errorName.includes(type))) {
            return false;
        }
        // Don't retry 4xx HTTP errors (client errors)
        if (error.status && error.status >= 400 && error.status < 500) {
            return false;
        }
        // Retry network errors, timeouts, and 5xx errors
        return true;
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