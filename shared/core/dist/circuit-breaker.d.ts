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
    constructor(config: CircuitBreakerConfig);
    execute<T>(operation: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    getStats(): CircuitBreakerStats;
    forceOpen(): void;
    forceClose(): void;
    reset(): void;
}
export declare class CircuitBreakerRegistry {
    private breakers;
    createBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker;
    getBreaker(name: string): CircuitBreaker | undefined;
    getAllStats(): Record<string, CircuitBreakerStats>;
    resetAll(): void;
}
export declare function getCircuitBreakerRegistry(): CircuitBreakerRegistry;
export declare function createCircuitBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker;
export declare function withCircuitBreaker<T>(operation: () => Promise<T>, breakerName: string, config?: Partial<CircuitBreakerConfig>): Promise<T>;
//# sourceMappingURL=circuit-breaker.d.ts.map