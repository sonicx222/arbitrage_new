export declare enum CircuitState {
    CLOSED = "CLOSED",// Normal operation
    OPEN = "OPEN",// Circuit is open, failing fast
    HALF_OPEN = "HALF_OPEN"
}
export interface CircuitBreakerConfig {
    failureThreshold: number;
    recoveryTimeout: number;
    monitoringPeriod: number;
    successThreshold: number;
    timeout: number;
    name: string;
}
export interface CircuitBreakerStats {
    state: CircuitState;
    failures: number;
    successes: number;
    timeouts: number;
    lastFailureTime: number;
    lastSuccessTime: number;
    totalRequests: number;
    totalFailures: number;
    uptime: number;
}
export declare class CircuitBreaker {
    private config;
    private state;
    private failures;
    private successes;
    private timeouts;
    private consecutiveSuccesses;
    private lastFailureTime;
    private lastSuccessTime;
    private totalRequests;
    private totalFailures;
    private nextAttemptTime;
    private recoveryTimer?;
    constructor(config: CircuitBreakerConfig);
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private executeWithTimeout;
    private onSuccess;
    private onFailure;
    private transitionToOpen;
    private transitionToHalfOpen;
    private transitionToClosed;
    private scheduleRecoveryCheck;
    getStats(): CircuitBreakerStats;
    forceOpen(): void;
    forceClose(): void;
    reset(): void;
    destroy(): void;
}
export declare class CircuitBreakerError extends Error {
    readonly code: string;
    static readonly CIRCUIT_OPEN = "CIRCUIT_OPEN";
    static readonly TIMEOUT = "TIMEOUT";
    constructor(message: string, code: string);
}
export declare class CircuitBreakerRegistry {
    private breakers;
    createBreaker(config: CircuitBreakerConfig): CircuitBreaker;
    getBreaker(name: string): CircuitBreaker | undefined;
    getAllStats(): Record<string, CircuitBreakerStats>;
    resetAll(): void;
    destroyAll(): void;
}
export declare function getCircuitBreakerRegistry(): CircuitBreakerRegistry;
export declare function createCircuitBreaker(config: Omit<CircuitBreakerConfig, 'name'>, name: string): CircuitBreaker;
export declare function circuitBreaker(config: Omit<CircuitBreakerConfig, 'name'>): (target: any, propertyName: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
//# sourceMappingURL=circuit-breaker.d.ts.map