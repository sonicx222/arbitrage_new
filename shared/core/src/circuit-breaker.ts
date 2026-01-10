// Circuit Breaker Pattern Implementation for Resilience
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening
  recoveryTimeout: number;       // Time in ms before attempting recovery
  monitoringPeriod: number;      // Time window for failure counting
  successThreshold: number;      // Number of successes needed in HALF_OPEN
  name: string;                  // Identifier for logging
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

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly circuitName: string,
    public readonly state: CircuitState
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private lastSuccessTime = 0;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private nextAttemptTime = 0;

  constructor(private config: CircuitBreakerConfig) { }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        throw new CircuitBreakerError(
          `Circuit breaker is OPEN for ${this.config.name}`,
          this.config.name,
          this.state
        );
      }

      // Transition to HALF_OPEN for testing
      this.state = CircuitState.HALF_OPEN;
      console.log(`Circuit breaker ${this.config.name} transitioning to HALF_OPEN`);
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
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

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    this.totalFailures++;

    if (this.state === CircuitState.HALF_OPEN) {
      // Back to OPEN on any failure in HALF_OPEN
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
      this.successes = 0;
      console.log(`Circuit breaker ${this.config.name} back to OPEN after failure in HALF_OPEN`);
    } else if (this.state === CircuitState.CLOSED) {
      // Check if we've exceeded failure threshold
      if (this.failures >= this.config.failureThreshold) {
        this.state = CircuitState.OPEN;
        this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
        console.log(`Circuit breaker ${this.config.name} opened due to ${this.failures} failures`);
      }
    }
  }

  getStats(): CircuitBreakerStats {
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
  forceOpen(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
    console.log(`Circuit breaker ${this.config.name} manually opened`);
  }

  forceClose(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    console.log(`Circuit breaker ${this.config.name} manually closed`);
  }

  reset(): void {
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

// Circuit Breaker Registry for managing multiple breakers
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  createBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
    if (this.breakers.has(name)) {
      throw new Error(`Circuit breaker ${name} already exists`);
    }

    const breaker = new CircuitBreaker({ ...config, name });
    this.breakers.set(name, breaker);
    return breaker;
  }

  getBreaker(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// Global registry instance
let globalRegistry: CircuitBreakerRegistry | null = null;

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  if (!globalRegistry) {
    globalRegistry = new CircuitBreakerRegistry();
  }
  return globalRegistry;
}

// Convenience functions
export function createCircuitBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
  return getCircuitBreakerRegistry().createBreaker(name, config);
}

export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  breakerName: string,
  config?: Partial<CircuitBreakerConfig>
): Promise<T> {
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