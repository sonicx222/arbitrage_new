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
import { createLogger } from './logger';

// =============================================================================
// Types
// =============================================================================

export enum ServiceState {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  ERROR = 'error'
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

// Valid state transitions map
const VALID_TRANSITIONS: Record<ServiceState, ServiceState[]> = {
  [ServiceState.STOPPED]: [ServiceState.STARTING],
  [ServiceState.STARTING]: [ServiceState.RUNNING, ServiceState.ERROR, ServiceState.STOPPED],
  [ServiceState.RUNNING]: [ServiceState.STOPPING, ServiceState.ERROR],
  [ServiceState.STOPPING]: [ServiceState.STOPPED, ServiceState.ERROR],
  [ServiceState.ERROR]: [ServiceState.STOPPED, ServiceState.STARTING]
};

// =============================================================================
// Service State Manager
// =============================================================================

export class ServiceStateManager extends EventEmitter {
  private state: ServiceState = ServiceState.STOPPED;
  private logger: any;
  private config: Required<ServiceStateConfig>;
  private lastTransition: number = Date.now();
  private transitionCount: number = 0;
  private transitionLock: Promise<void> | null = null;
  private errorMessage?: string;

  constructor(config: ServiceStateConfig) {
    super();

    this.config = {
      serviceName: config.serviceName,
      transitionTimeoutMs: config.transitionTimeoutMs ?? 30000,
      emitEvents: config.emitEvents ?? true
    };

    this.logger = createLogger(`state:${this.config.serviceName}`);
  }

  // ===========================================================================
  // State Queries
  // ===========================================================================

  /**
   * Get current state.
   */
  getState(): ServiceState {
    return this.state;
  }

  /**
   * Check if service is in a specific state.
   */
  isInState(state: ServiceState): boolean {
    return this.state === state;
  }

  /**
   * Check if service is running.
   */
  isRunning(): boolean {
    return this.state === ServiceState.RUNNING;
  }

  /**
   * Check if service is stopped.
   */
  isStopped(): boolean {
    return this.state === ServiceState.STOPPED;
  }

  /**
   * Check if a state transition is in progress.
   */
  isTransitioning(): boolean {
    return this.state === ServiceState.STARTING || this.state === ServiceState.STOPPING;
  }

  /**
   * Check if service is in an error state.
   */
  isError(): boolean {
    return this.state === ServiceState.ERROR;
  }

  /**
   * Get a snapshot of the current state.
   */
  getSnapshot(): ServiceStateSnapshot {
    return {
      state: this.state,
      serviceName: this.config.serviceName,
      lastTransition: this.lastTransition,
      transitionCount: this.transitionCount,
      errorMessage: this.errorMessage
    };
  }

  // ===========================================================================
  // State Transitions
  // ===========================================================================

  /**
   * Attempt to transition to a new state.
   * Returns success/failure without throwing.
   */
  async transitionTo(newState: ServiceState, errorMessage?: string): Promise<StateTransitionResult> {
    const previousState = this.state;

    // Validate transition
    if (!this.isValidTransition(newState)) {
      const result: StateTransitionResult = {
        success: false,
        previousState,
        currentState: this.state,
        error: new Error(
          `Invalid state transition: ${this.state} -> ${newState} for service ${this.config.serviceName}`
        )
      };

      this.logger.warn('Invalid state transition attempted', {
        from: previousState,
        to: newState
      });

      return result;
    }

    // Wait for any pending transition
    if (this.transitionLock) {
      try {
        await Promise.race([
          this.transitionLock,
          this.createTimeout()
        ]);
      } catch (error) {
        return {
          success: false,
          previousState,
          currentState: this.state,
          error: error as Error
        };
      }
    }

    // Perform transition
    this.state = newState;
    this.lastTransition = Date.now();
    this.transitionCount++;

    if (newState === ServiceState.ERROR && errorMessage) {
      this.errorMessage = errorMessage;
    } else if (newState !== ServiceState.ERROR) {
      this.errorMessage = undefined;
    }

    this.logger.info('State transition', {
      from: previousState,
      to: newState,
      transitionCount: this.transitionCount
    });

    // Emit event if configured
    if (this.config.emitEvents) {
      const event: StateChangeEvent = {
        previousState,
        newState,
        timestamp: this.lastTransition,
        serviceName: this.config.serviceName
      };
      this.emit('stateChange', event);
      this.emit(newState, event);
    }

    return {
      success: true,
      previousState,
      currentState: newState
    };
  }

  /**
   * Transition to a new state, throwing on failure.
   */
  async requireTransitionTo(newState: ServiceState, errorMessage?: string): Promise<void> {
    const result = await this.transitionTo(newState, errorMessage);

    if (!result.success) {
      throw result.error || new Error(`Failed to transition to ${newState}`);
    }
  }

  // ===========================================================================
  // Lifecycle Helpers
  // ===========================================================================

  /**
   * Execute a start sequence with proper state transitions.
   * Transitions: STOPPED -> STARTING -> (RUNNING | ERROR)
   */
  async executeStart(startFn: () => Promise<void>): Promise<StateTransitionResult> {
    // Transition to STARTING
    const startingResult = await this.transitionTo(ServiceState.STARTING);
    if (!startingResult.success) {
      return startingResult;
    }

    // Create transition lock
    let resolveLock: () => void;
    this.transitionLock = new Promise(resolve => {
      resolveLock = resolve;
    });

    try {
      // Execute start with timeout
      await Promise.race([
        startFn(),
        this.createTimeout()
      ]);

      // Transition to RUNNING
      const runningResult = await this.transitionTo(ServiceState.RUNNING);
      return runningResult;

    } catch (error) {
      // Transition to ERROR
      const errorResult = await this.transitionTo(
        ServiceState.ERROR,
        (error as Error).message
      );
      return {
        ...errorResult,
        error: error as Error
      };

    } finally {
      resolveLock!();
      this.transitionLock = null;
    }
  }

  /**
   * Execute a stop sequence with proper state transitions.
   * Transitions: RUNNING -> STOPPING -> (STOPPED | ERROR)
   */
  async executeStop(stopFn: () => Promise<void>): Promise<StateTransitionResult> {
    // Can also stop from ERROR state
    if (this.state !== ServiceState.RUNNING && this.state !== ServiceState.ERROR) {
      return {
        success: false,
        previousState: this.state,
        currentState: this.state,
        error: new Error(`Cannot stop service in state: ${this.state}`)
      };
    }

    // Transition to STOPPING
    const stoppingResult = await this.transitionTo(ServiceState.STOPPING);
    if (!stoppingResult.success) {
      return stoppingResult;
    }

    // Create transition lock
    let resolveLock: () => void;
    this.transitionLock = new Promise(resolve => {
      resolveLock = resolve;
    });

    try {
      // Execute stop with timeout
      await Promise.race([
        stopFn(),
        this.createTimeout()
      ]);

      // Transition to STOPPED
      const stoppedResult = await this.transitionTo(ServiceState.STOPPED);
      return stoppedResult;

    } catch (error) {
      // Transition to ERROR on failure
      const errorResult = await this.transitionTo(
        ServiceState.ERROR,
        (error as Error).message
      );
      return {
        ...errorResult,
        error: error as Error
      };

    } finally {
      resolveLock!();
      this.transitionLock = null;
    }
  }

  /**
   * Execute a restart sequence.
   * Equivalent to stop() then start().
   */
  async executeRestart(
    stopFn: () => Promise<void>,
    startFn: () => Promise<void>
  ): Promise<StateTransitionResult> {
    // Only restart if currently running
    if (this.state === ServiceState.RUNNING) {
      const stopResult = await this.executeStop(stopFn);
      if (!stopResult.success) {
        return stopResult;
      }
    }

    return await this.executeStart(startFn);
  }

  // ===========================================================================
  // Guards (for use in service methods)
  // ===========================================================================

  /**
   * Assert that service is in RUNNING state.
   * Throws if not running.
   */
  assertRunning(): void {
    if (!this.isRunning()) {
      throw new Error(`Service ${this.config.serviceName} is not running (state: ${this.state})`);
    }
  }

  /**
   * Assert that service is in STOPPED state.
   * Throws if not stopped.
   */
  assertStopped(): void {
    if (!this.isStopped()) {
      throw new Error(`Service ${this.config.serviceName} is not stopped (state: ${this.state})`);
    }
  }

  /**
   * Assert that service can be started.
   * Throws if already running or transitioning.
   */
  assertCanStart(): void {
    if (this.state !== ServiceState.STOPPED && this.state !== ServiceState.ERROR) {
      throw new Error(
        `Service ${this.config.serviceName} cannot be started (state: ${this.state})`
      );
    }
  }

  /**
   * Assert that service can be stopped.
   * Throws if not running.
   */
  assertCanStop(): void {
    if (this.state !== ServiceState.RUNNING && this.state !== ServiceState.ERROR) {
      throw new Error(
        `Service ${this.config.serviceName} cannot be stopped (state: ${this.state})`
      );
    }
  }

  // ===========================================================================
  // Reset (for testing or recovery)
  // ===========================================================================

  /**
   * Force reset to STOPPED state.
   * Use with caution - bypasses normal transition rules.
   */
  forceReset(): void {
    const previousState = this.state;
    this.state = ServiceState.STOPPED;
    this.errorMessage = undefined;
    this.transitionLock = null;

    this.logger.warn('State force reset', {
      from: previousState,
      to: ServiceState.STOPPED
    });

    if (this.config.emitEvents) {
      this.emit('forceReset', {
        previousState,
        newState: ServiceState.STOPPED,
        timestamp: Date.now(),
        serviceName: this.config.serviceName
      });
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private isValidTransition(newState: ServiceState): boolean {
    const validTargets = VALID_TRANSITIONS[this.state];
    return validTargets.includes(newState);
  }

  private createTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`State transition timeout after ${this.config.transitionTimeoutMs}ms`));
      }, this.config.transitionTimeoutMs);
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new ServiceStateManager instance.
 */
export function createServiceState(config: ServiceStateConfig): ServiceStateManager {
  return new ServiceStateManager(config);
}

// =============================================================================
// Type Guards
// =============================================================================

export function isServiceState(value: unknown): value is ServiceState {
  return Object.values(ServiceState).includes(value as ServiceState);
}
