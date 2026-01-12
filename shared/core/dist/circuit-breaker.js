"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerRegistry = exports.CircuitBreaker = exports.CircuitBreakerError = exports.CircuitState = void 0;
exports.getCircuitBreakerRegistry = getCircuitBreakerRegistry;
exports.createCircuitBreaker = createCircuitBreaker;
exports.withCircuitBreaker = withCircuitBreaker;
// Circuit Breaker Pattern Implementation for Resilience
var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
class CircuitBreakerError extends Error {
    constructor(message, circuitName, state) {
        super(message);
        this.circuitName = circuitName;
        this.state = state;
        this.name = 'CircuitBreakerError';
    }
}
exports.CircuitBreakerError = CircuitBreakerError;
class CircuitBreaker {
    constructor(config) {
        this.config = config;
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = 0;
        this.lastSuccessTime = 0;
        this.totalRequests = 0;
        this.totalFailures = 0;
        this.totalSuccesses = 0;
        this.nextAttemptTime = 0;
    }
    async execute(operation) {
        this.totalRequests++;
        if (this.state === CircuitState.OPEN) {
            if (Date.now() < this.nextAttemptTime) {
                throw new CircuitBreakerError(`Circuit breaker is OPEN for ${this.config.name}`, this.config.name, this.state);
            }
            // Transition to HALF_OPEN for testing
            this.state = CircuitState.HALF_OPEN;
            console.log(`Circuit breaker ${this.config.name} transitioning to HALF_OPEN`);
        }
        try {
            const result = await operation();
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        this.successes++;
        this.lastSuccessTime = Date.now();
        this.totalSuccesses++;
        if (this.state === CircuitState.HALF_OPEN) {
            if (this.successes >= this.config.successThreshold) {
                // Circuit is healthy again
                this.state = CircuitState.CLOSED;
                this.failures = 0;
                this.successes = 0;
                console.log(`Circuit breaker ${this.config.name} transitioned to CLOSED`);
            }
        }
    }
    onFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        this.totalFailures++;
        if (this.state === CircuitState.HALF_OPEN) {
            // Back to OPEN on any failure in HALF_OPEN
            this.state = CircuitState.OPEN;
            this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
            this.successes = 0;
            console.log(`Circuit breaker ${this.config.name} back to OPEN after failure in HALF_OPEN`);
        }
        else if (this.state === CircuitState.CLOSED) {
            // Check if we've exceeded failure threshold
            if (this.failures >= this.config.failureThreshold) {
                this.state = CircuitState.OPEN;
                this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
                console.log(`Circuit breaker ${this.config.name} opened due to ${this.failures} failures`);
            }
        }
    }
    getStats() {
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            totalRequests: this.totalRequests,
            totalFailures: this.totalFailures,
            totalSuccesses: this.totalSuccesses
        };
    }
    // Manual state control for testing/administration
    forceOpen() {
        this.state = CircuitState.OPEN;
        this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
        console.log(`Circuit breaker ${this.config.name} manually opened`);
    }
    forceClose() {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        console.log(`Circuit breaker ${this.config.name} manually closed`);
    }
    reset() {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = 0;
        this.lastSuccessTime = 0;
        this.totalRequests = 0;
        this.totalFailures = 0;
        this.totalSuccesses = 0;
        this.nextAttemptTime = 0;
        console.log(`Circuit breaker ${this.config.name} reset`);
    }
}
exports.CircuitBreaker = CircuitBreaker;
// Circuit Breaker Registry for managing multiple breakers
class CircuitBreakerRegistry {
    constructor() {
        this.breakers = new Map();
    }
    createBreaker(name, config) {
        if (this.breakers.has(name)) {
            throw new Error(`Circuit breaker ${name} already exists`);
        }
        const breaker = new CircuitBreaker({ ...config, name });
        this.breakers.set(name, breaker);
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
// Convenience functions
function createCircuitBreaker(name, config) {
    return getCircuitBreakerRegistry().createBreaker(name, config);
}
async function withCircuitBreaker(operation, breakerName, config) {
    const registry = getCircuitBreakerRegistry();
    let breaker = registry.getBreaker(breakerName);
    if (!breaker) {
        breaker = registry.createBreaker(breakerName, {
            failureThreshold: 5,
            recoveryTimeout: 60000,
            monitoringPeriod: 60000,
            successThreshold: 3,
            ...config
        });
    }
    return breaker.execute(operation);
}
//# sourceMappingURL=circuit-breaker.js.map