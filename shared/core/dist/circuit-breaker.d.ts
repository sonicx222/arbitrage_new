export declare enum CircuitState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN"
}
export interface CircuitBreakerConfig {
    failureThreshold: number;
    recoveryTimeout: number;
    monitoringPeriod: number;
    successThreshold: number;
    name: string;
}
export interface CircuitBreakerStats {
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailureTime: number;
    lastSuccessTime: number;
    totalRequests: number;
    totalFailures: number;
    totalSuccesses: number;
    /** P2-2 FIX: Failures within current monitoring window */
    windowFailures: number;
}
export declare class CircuitBreakerError extends Error {
    readonly circuitName: string;
    readonly state: CircuitState;
    constructor(message: string, circuitName: string, state: CircuitState);
}
export declare class CircuitBreaker {
    private config;
    private state;
    private failures;
    private successes;
    private lastFailureTime;
    private lastSuccessTime;
    private totalRequests;
    private totalFailures;
    private totalSuccesses;
    private nextAttemptTime;
    private transitionLock;
    private halfOpenInProgress;
    private failureTimestamps;
    constructor(config: CircuitBreakerConfig);
    execute<T>(operation: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    /**
     * P2-2 FIX: Remove failures older than monitoring period
     */
    private pruneOldFailures;
    /**
     * P2-2 FIX: Get failure count within monitoring window
     */
    private getWindowFailureCount;
    getStats(): CircuitBreakerStats;
    getState(): CircuitState;
    forceOpen(): void;
    forceClose(): void;
    reset(): void;
}
export declare class CircuitBreakerRegistry {
    private breakers;
    createBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker;
    getBreaker(name: string): CircuitBreaker | undefined;
    /**
     * Get or create a breaker with specified config.
     * If breaker exists, returns existing instance (ignores config).
     */
    getOrCreateBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker;
    getAllStats(): Record<string, CircuitBreakerStats>;
    resetAll(): void;
    /**
     * Remove a breaker from the registry.
     */
    removeBreaker(name: string): boolean;
    /**
     * Clear all breakers from the registry.
     */
    clearAll(): void;
}
export declare function getCircuitBreakerRegistry(): CircuitBreakerRegistry;
/**
 * Reset the global registry (for testing).
 */
export declare function resetCircuitBreakerRegistry(): void;
export declare function createCircuitBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker;
export declare function withCircuitBreaker<T>(operation: () => Promise<T>, breakerName: string, config?: Partial<CircuitBreakerConfig>): Promise<T>;
//# sourceMappingURL=circuit-breaker.d.ts.map