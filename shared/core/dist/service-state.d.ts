/**
 * Service State Machine
 *
 * Provides a state machine pattern for managing service lifecycle,
 * preventing race conditions in start/stop operations.
 *
 * Features:
 * - Explicit state transitions with validation
 * - Prevents invalid state transitions (e.g., stop while starting)
 * - Event emission for state change notifications
 * - Async transition support with timeout handling
 * - Thread-safe state checks
 *
 * States:
 * - STOPPED: Service is not running
 * - STARTING: Service is initializing
 * - RUNNING: Service is operational
 * - STOPPING: Service is shutting down
 * - ERROR: Service encountered a fatal error
 *
 * @see ADR-007: Failover Strategy
 */
import { EventEmitter } from 'events';
export declare enum ServiceState {
    STOPPED = "stopped",
    STARTING = "starting",
    RUNNING = "running",
    STOPPING = "stopping",
    ERROR = "error"
}
export interface StateTransitionResult {
    success: boolean;
    previousState: ServiceState;
    currentState: ServiceState;
    error?: Error;
}
export interface StateChangeEvent {
    previousState: ServiceState;
    newState: ServiceState;
    timestamp: number;
    serviceName: string;
}
export interface ServiceStateConfig {
    /** Service name for logging and events */
    serviceName: string;
    /** Timeout for state transitions in ms (default: 30000) */
    transitionTimeoutMs?: number;
    /** Whether to emit events on state changes */
    emitEvents?: boolean;
}
export interface ServiceStateSnapshot {
    state: ServiceState;
    serviceName: string;
    lastTransition: number;
    transitionCount: number;
    errorMessage?: string;
}
export declare class ServiceStateManager extends EventEmitter {
    private state;
    private logger;
    private config;
    private lastTransition;
    private transitionCount;
    private transitionLock;
    private errorMessage?;
    constructor(config: ServiceStateConfig);
    /**
     * Get current state.
     */
    getState(): ServiceState;
    /**
     * Check if service is in a specific state.
     */
    isInState(state: ServiceState): boolean;
    /**
     * Check if service is running.
     */
    isRunning(): boolean;
    /**
     * Check if service is stopped.
     */
    isStopped(): boolean;
    /**
     * Check if a state transition is in progress.
     */
    isTransitioning(): boolean;
    /**
     * Check if service is in an error state.
     */
    isError(): boolean;
    /**
     * Get a snapshot of the current state.
     */
    getSnapshot(): ServiceStateSnapshot;
    /**
     * Attempt to transition to a new state.
     * Returns success/failure without throwing.
     */
    transitionTo(newState: ServiceState, errorMessage?: string): Promise<StateTransitionResult>;
    /**
     * Transition to a new state, throwing on failure.
     */
    requireTransitionTo(newState: ServiceState, errorMessage?: string): Promise<void>;
    /**
     * Execute a start sequence with proper state transitions.
     * Transitions: STOPPED -> STARTING -> (RUNNING | ERROR)
     */
    executeStart(startFn: () => Promise<void>): Promise<StateTransitionResult>;
    /**
     * Execute a stop sequence with proper state transitions.
     * Transitions: RUNNING -> STOPPING -> (STOPPED | ERROR)
     * Special case: ERROR -> STOPPED (direct, for cleanup)
     */
    executeStop(stopFn: () => Promise<void>): Promise<StateTransitionResult>;
    /**
     * Execute a restart sequence.
     * Equivalent to stop() then start().
     */
    executeRestart(stopFn: () => Promise<void>, startFn: () => Promise<void>): Promise<StateTransitionResult>;
    /**
     * Assert that service is in RUNNING state.
     * Throws if not running.
     */
    assertRunning(): void;
    /**
     * Assert that service is in STOPPED state.
     * Throws if not stopped.
     */
    assertStopped(): void;
    /**
     * Assert that service can be started.
     * Throws if already running or transitioning.
     */
    assertCanStart(): void;
    /**
     * Assert that service can be stopped.
     * Throws if not running.
     */
    assertCanStop(): void;
    /**
     * Force reset to STOPPED state.
     * Use with caution - bypasses normal transition rules.
     */
    forceReset(): void;
    private isValidTransition;
    /**
     * Create a clearable timeout promise.
     * Returns both the promise and a clear function to prevent memory leaks.
     */
    private createTimeout;
}
/**
 * Create a new ServiceStateManager instance.
 */
export declare function createServiceState(config: ServiceStateConfig): ServiceStateManager;
export declare function isServiceState(value: unknown): value is ServiceState;
//# sourceMappingURL=service-state.d.ts.map