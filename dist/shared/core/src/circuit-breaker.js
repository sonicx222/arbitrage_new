"use strict";
// Circuit Breaker Pattern for Self-Healing Resilience
// Prevents cascading failures and enables automatic recovery
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerRegistry = exports.CircuitBreakerError = exports.CircuitBreaker = exports.CircuitState = void 0;
exports.getCircuitBreakerRegistry = getCircuitBreakerRegistry;
exports.createCircuitBreaker = createCircuitBreaker;
exports.circuitBreaker = circuitBreaker;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('circuit-breaker');
var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN"; // Testing if service recovered
})(CircuitState || (exports.CircuitState = CircuitState = {}));
class CircuitBreaker {
    constructor(config) {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.timeouts = 0;
        this.consecutiveSuccesses = 0;
        this.lastFailureTime = 0;
        this.lastSuccessTime = 0;
        this.totalRequests = 0;
        this.totalFailures = 0;
        this.nextAttemptTime = 0;
        this.config = config;
        this.scheduleRecoveryCheck();
    }
    // Execute a function with circuit breaker protection
    async execute(fn) {
        this.totalRequests++;
        // Check if circuit should transition to half-open
        if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttemptTime) {
            this.transitionToHalfOpen();
        }
        // Fail fast if circuit is open
        if (this.state === CircuitState.OPEN) {
            throw new CircuitBreakerError(`Circuit breaker ${this.config.name} is OPEN`, CircuitBreakerError.CIRCUIT_OPEN);
        }
        try {
            // Execute with timeout
            const result = await this.executeWithTimeout(fn);
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure(error);
            throw error;
        }
    }
    // Execute with timeout protection
    async executeWithTimeout(fn) {
        return new Promise(async (resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.timeouts++;
                reject(new CircuitBreakerError(`Request timeout after ${this.config.timeout}ms`, CircuitBreakerError.TIMEOUT));
            }, this.config.timeout);
            try {
                const result = await fn();
                clearTimeout(timeoutId);
                resolve(result);
            }
            catch (error) {
                clearTimeout(timeoutId);
                reject(error);
            }
        });
    }
    onSuccess() {
        this.lastSuccessTime = Date.now();
        this.successes++;
        this.consecutiveSuccesses++;
        // Reset failure counter on success
        if (this.state === CircuitState.CLOSED) {
            this.failures = 0;
        }
        // Transition from half-open to closed if threshold reached
        if (this.state === CircuitState.HALF_OPEN &&
            this.consecutiveSuccesses >= this.config.successThreshold) {
            this.transitionToClosed();
        }
    }
    onFailure(error) {
        this.lastFailureTime = Date.now();
        this.failures++;
        this.totalFailures++;
        this.consecutiveSuccesses = 0;
        // Log the failure
        logger.warn(`Circuit breaker ${this.config.name} failure`, {
            error: error.message,
            failures: this.failures,
            state: this.state
        });
        // Transition to open if threshold exceeded
        if (this.state === CircuitState.CLOSED &&
            this.failures >= this.config.failureThreshold) {
            this.transitionToOpen();
        }
        else if (this.state === CircuitState.HALF_OPEN) {
            // Failed during recovery test, go back to open
            this.transitionToOpen();
        }
    }
    transitionToOpen() {
        this.state = CircuitState.OPEN;
        this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
        logger.warn(`Circuit breaker ${this.config.name} opened`, {
            failures: this.failures,
            recoveryTime: this.config.recoveryTimeout
        });
        this.scheduleRecoveryCheck();
    }
    transitionToHalfOpen() {
        this.state = CircuitState.HALF_OPEN;
        this.consecutiveSuccesses = 0;
        logger.info(`Circuit breaker ${this.config.name} testing recovery`);
    }
    transitionToClosed() {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.consecutiveSuccesses = 0;
        logger.info(`Circuit breaker ${this.config.name} closed - service recovered`);
    }
    scheduleRecoveryCheck() {
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
        }
        if (this.state === CircuitState.OPEN) {
            this.recoveryTimer = setTimeout(() => {
                if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttemptTime) {
                    this.transitionToHalfOpen();
                }
            }, this.config.recoveryTimeout);
        }
    }
    // Get current statistics
    getStats() {
        const uptime = this.lastSuccessTime > 0 ?
            (Date.now() - Math.min(this.lastFailureTime || Date.now(), this.lastSuccessTime)) / 1000 : 0;
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            timeouts: this.timeouts,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            totalRequests: this.totalRequests,
            totalFailures: this.totalFailures,
            uptime
        };
    }
    // Manual state control for testing/administration
    forceOpen() {
        this.transitionToOpen();
    }
    forceClose() {
        this.transitionToClosed();
    }
    reset() {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.timeouts = 0;
        this.consecutiveSuccesses = 0;
        this.lastFailureTime = 0;
        this.lastSuccessTime = 0;
        this.totalRequests = 0;
        this.totalFailures = 0;
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
        }
        logger.info(`Circuit breaker ${this.config.name} reset`);
    }
    // Cleanup resources
    destroy() {
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
        }
        logger.info(`Circuit breaker ${this.config.name} destroyed`);
    }
}
exports.CircuitBreaker = CircuitBreaker;
// Custom error types for circuit breaker
class CircuitBreakerError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'CircuitBreakerError';
    }
}
exports.CircuitBreakerError = CircuitBreakerError;
CircuitBreakerError.CIRCUIT_OPEN = 'CIRCUIT_OPEN';
CircuitBreakerError.TIMEOUT = 'TIMEOUT';
// Circuit breaker registry for managing multiple breakers
class CircuitBreakerRegistry {
    constructor() {
        this.breakers = new Map();
    }
    createBreaker(config) {
        if (this.breakers.has(config.name)) {
            throw new Error(`Circuit breaker ${config.name} already exists`);
        }
        const breaker = new CircuitBreaker(config);
        this.breakers.set(config.name, breaker);
        return breaker;
    }
    getBreaker(name) {
        return this.breakers.get(name);
    }
    getAllStats() {
        const stats = {};
        for (const [name, breaker] of this.breakers) {
            stats[name] = breaker.getStats();
        }
        return stats;
    }
    resetAll() {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }
    destroyAll() {
        for (const breaker of this.breakers.values()) {
            breaker.destroy();
        }
        this.breakers.clear();
    }
}
exports.CircuitBreakerRegistry = CircuitBreakerRegistry;
// Global registry instance
let globalRegistry = null;
function getCircuitBreakerRegistry() {
    if (!globalRegistry) {
        globalRegistry = new CircuitBreakerRegistry();
    }
    return globalRegistry;
}
// Convenience function to create a circuit breaker
function createCircuitBreaker(config, name) {
    return getCircuitBreakerRegistry().createBreaker({ ...config, name });
}
// Decorators for circuit breaker protection
function circuitBreaker(config) {
    return function (target, propertyName, descriptor) {
        const method = descriptor.value;
        const breaker = createCircuitBreaker(config, `${target.constructor.name}.${propertyName}`);
        descriptor.value = async function (...args) {
            return breaker.execute(() => method.apply(this, args));
        };
        return descriptor;
    };
}
//# sourceMappingURL=circuit-breaker.js.map