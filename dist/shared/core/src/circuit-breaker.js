"use strict";
// Circuit Breaker Pattern Implementation for Resilience
//
// P0-1 FIX: Added mutex lock for thread-safe state transitions
// P0-2 FIX: Replaced console.log with structured logger
// P2-2 FIX: Added monitoring period window for failure tracking
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerRegistry = exports.CircuitBreaker = exports.CircuitBreakerError = exports.CircuitState = void 0;
exports.getCircuitBreakerRegistry = getCircuitBreakerRegistry;
exports.resetCircuitBreakerRegistry = resetCircuitBreakerRegistry;
exports.createCircuitBreaker = createCircuitBreaker;
exports.withCircuitBreaker = withCircuitBreaker;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('circuit-breaker');
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
        // P0-1 FIX: Mutex lock for thread-safe state transitions
        this.transitionLock = null;
        this.halfOpenInProgress = false;
        // P2-2 FIX: Track failure timestamps for monitoring window
        this.failureTimestamps = [];
    }
    async execute(operation) {
        this.totalRequests++;
        // P0-1 FIX: Thread-safe state check and transition
        if (this.state === CircuitState.OPEN) {
            if (Date.now() < this.nextAttemptTime) {
                throw new CircuitBreakerError(`Circuit breaker is OPEN for ${this.config.name}`, this.config.name, this.state);
            }
            // P0-1 FIX: Use atomic lock to prevent race condition
            // Only one request can transition to HALF_OPEN
            if (this.halfOpenInProgress) {
                throw new CircuitBreakerError(`Circuit breaker is testing recovery for ${this.config.name}`, this.config.name, CircuitState.HALF_OPEN);
            }
            // Atomically set flag before state change
            this.halfOpenInProgress = true;
            this.state = CircuitState.HALF_OPEN;
            this.successes = 0; // Reset success counter for HALF_OPEN
            // P0-2 FIX: Use structured logger
            logger.info('Circuit breaker transitioning to HALF_OPEN', {
                name: this.config.name,
                recoveryTimeout: this.config.recoveryTimeout
            });
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
                this.halfOpenInProgress = false; // P0-1 FIX: Reset flag
                this.failureTimestamps = []; // P2-2 FIX: Clear failure history
                // P0-2 FIX: Use structured logger
                logger.info('Circuit breaker transitioned to CLOSED', {
                    name: this.config.name,
                    successThreshold: this.config.successThreshold
                });
            }
        }
    }
    onFailure() {
        const now = Date.now();
        this.failures++;
        this.lastFailureTime = now;
        this.totalFailures++;
        // P2-2 FIX: Track failure within monitoring window
        this.failureTimestamps.push(now);
        this.pruneOldFailures();
        if (this.state === CircuitState.HALF_OPEN) {
            // Back to OPEN on any failure in HALF_OPEN
            this.state = CircuitState.OPEN;
            this.nextAttemptTime = now + this.config.recoveryTimeout;
            this.successes = 0;
            this.halfOpenInProgress = false; // P0-1 FIX: Reset flag
            // P0-2 FIX: Use structured logger
            logger.warn('Circuit breaker back to OPEN after failure in HALF_OPEN', {
                name: this.config.name,
                recoveryTimeout: this.config.recoveryTimeout
            });
        }
        else if (this.state === CircuitState.CLOSED) {
            // P2-2 FIX: Check failures within monitoring window, not total
            const windowFailures = this.getWindowFailureCount();
            if (windowFailures >= this.config.failureThreshold) {
                this.state = CircuitState.OPEN;
                this.nextAttemptTime = now + this.config.recoveryTimeout;
                // P0-2 FIX: Use structured logger
                logger.warn('Circuit breaker opened due to failures', {
                    name: this.config.name,
                    windowFailures,
                    failureThreshold: this.config.failureThreshold,
                    monitoringPeriod: this.config.monitoringPeriod
                });
            }
        }
    }
    /**
     * P2-2 FIX: Remove failures older than monitoring period
     */
    pruneOldFailures() {
        const cutoff = Date.now() - this.config.monitoringPeriod;
        this.failureTimestamps = this.failureTimestamps.filter(ts => ts > cutoff);
    }
    /**
     * P2-2 FIX: Get failure count within monitoring window
     */
    getWindowFailureCount() {
        this.pruneOldFailures();
        return this.failureTimestamps.length;
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
            totalSuccesses: this.totalSuccesses,
            windowFailures: this.getWindowFailureCount() // P2-2 FIX: Include window failures
        };
    }
    getState() {
        return this.state;
    }
    // Manual state control for testing/administration
    forceOpen() {
        this.state = CircuitState.OPEN;
        this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
        this.halfOpenInProgress = false;
        // P0-2 FIX: Use structured logger
        logger.warn('Circuit breaker manually opened', {
            name: this.config.name
        });
    }
    forceClose() {
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.halfOpenInProgress = false;
        this.failureTimestamps = [];
        // P0-2 FIX: Use structured logger
        logger.info('Circuit breaker manually closed', {
            name: this.config.name
        });
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
        this.halfOpenInProgress = false;
        this.failureTimestamps = [];
        // P0-2 FIX: Use structured logger
        logger.info('Circuit breaker reset', {
            name: this.config.name
        });
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
    /**
     * Get or create a breaker with specified config.
     * If breaker exists, returns existing instance (ignores config).
     */
    getOrCreateBreaker(name, config) {
        const existing = this.breakers.get(name);
        if (existing) {
            return existing;
        }
        return this.createBreaker(name, config);
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
    /**
     * Remove a breaker from the registry.
     */
    removeBreaker(name) {
        return this.breakers.delete(name);
    }
    /**
     * Clear all breakers from the registry.
     */
    clearAll() {
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
/**
 * Reset the global registry (for testing).
 */
function resetCircuitBreakerRegistry() {
    if (globalRegistry) {
        globalRegistry.clearAll();
    }
    globalRegistry = null;
}
// Convenience functions
function createCircuitBreaker(name, config) {
    return getCircuitBreakerRegistry().createBreaker(name, config);
}
async function withCircuitBreaker(operation, breakerName, config) {
    const registry = getCircuitBreakerRegistry();
    // Use getOrCreateBreaker to avoid "already exists" error
    const breaker = registry.getOrCreateBreaker(breakerName, {
        failureThreshold: 5,
        recoveryTimeout: 60000,
        monitoringPeriod: 60000,
        successThreshold: 3,
        ...config
    });
    return breaker.execute(operation);
}
//# sourceMappingURL=circuit-breaker.js.map