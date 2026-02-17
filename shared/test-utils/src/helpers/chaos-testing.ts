/**
 * Chaos Testing Infrastructure
 *
 * Phase 4 Testing Excellence: P3-5 Chaos Testing
 *
 * Provides utilities for simulating failure scenarios:
 * - Redis connection failures
 * - RPC endpoint timeouts
 * - Network partition simulation
 * - Memory pressure conditions
 *
 * @see ADR-009: Test Architecture
 */

/**
 * Chaos injection configuration.
 */
export interface ChaosConfig {
  /** Probability of failure (0-1) */
  failureProbability?: number;
  /** Latency to inject in ms */
  latencyMs?: number;
  /** Whether to fail completely or just slow down */
  mode?: 'fail' | 'slow' | 'intermittent';
  /** Duration of chaos injection in ms */
  durationMs?: number;
}

/**
 * Chaos injection state.
 */
interface ChaosState {
  isActive: boolean;
  config: ChaosConfig;
  startTime: number;
  injectedFailures: number;
  injectedLatency: number;
}

// Global chaos state for different injection points
const chaosStates = new Map<string, ChaosState>();

/**
 * Create a chaos controller for a specific injection point.
 */
export function createChaosController(name: string) {
  const state: ChaosState = {
    isActive: false,
    config: {},
    startTime: 0,
    injectedFailures: 0,
    injectedLatency: 0,
  };
  chaosStates.set(name, state);

  return {
    /**
     * Start chaos injection.
     */
    start(config: ChaosConfig = {}) {
      state.isActive = true;
      state.config = {
        failureProbability: 1,
        latencyMs: 0,
        mode: 'fail',
        durationMs: Infinity,
        ...config,
      };
      state.startTime = Date.now();
      state.injectedFailures = 0;
      state.injectedLatency = 0;
    },

    /**
     * Stop chaos injection.
     */
    stop() {
      state.isActive = false;
    },

    /**
     * Check if chaos should be applied now.
     */
    shouldApply(): boolean {
      if (!state.isActive) return false;

      // Check duration
      if (state.config.durationMs !== undefined) {
        if (Date.now() - state.startTime > state.config.durationMs) {
          state.isActive = false;
          return false;
        }
      }

      // Check probability
      if (state.config.failureProbability !== undefined) {
        return Math.random() < state.config.failureProbability;
      }

      return true;
    },

    /**
     * Get current latency to inject.
     */
    getLatency(): number {
      if (!state.isActive || state.config.mode === 'fail') return 0;
      return state.config.latencyMs || 0;
    },

    /**
     * Record a failure injection.
     */
    recordFailure() {
      state.injectedFailures++;
    },

    /**
     * Get injection statistics.
     */
    getStats() {
      return {
        isActive: state.isActive,
        injectedFailures: state.injectedFailures,
        injectedLatency: state.injectedLatency,
        elapsedMs: state.isActive ? Date.now() - state.startTime : 0,
      };
    },
  };
}

/**
 * Wrap a function with chaos injection.
 */
export function withChaos<T extends (...args: unknown[]) => Promise<unknown>>(
  controllerName: string,
  fn: T,
  errorFactory?: () => Error
): T {
  const controller = chaosStates.get(controllerName);
  if (!controller) {
    throw new Error(`Chaos controller '${controllerName}' not found`);
  }

  return (async (...args: Parameters<T>) => {
    const state = chaosStates.get(controllerName)!;

    if (state.isActive) {
      // Apply latency
      const latency = state.config.latencyMs || 0;
      if (latency > 0 && state.config.mode !== 'fail') {
        await sleep(latency);
        state.injectedLatency += latency;
      }

      // Apply failure
      if (state.config.mode === 'fail' || state.config.mode === 'intermittent') {
        if (
          state.config.failureProbability === undefined ||
          Math.random() < state.config.failureProbability
        ) {
          state.injectedFailures++;
          const error = errorFactory?.() || new Error(`Chaos injection: ${controllerName} failed`);
          throw error;
        }
      }
    }

    return fn(...args);
  }) as T;
}

/**
 * Sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// REDIS CHAOS HELPERS
// =============================================================================

/**
 * Create a chaos-wrapped Redis client for testing.
 */
export function createChaosRedisClient<T extends object>(
  realClient: T,
  options: { controllerName?: string } = {}
): T & { chaos: ReturnType<typeof createChaosController> } {
  const controllerName = options.controllerName || 'redis';
  const chaos = createChaosController(controllerName);

  const handler: ProxyHandler<T> = {
    get(target, prop) {
      const value = Reflect.get(target, prop);

      // Wrap methods
      if (typeof value === 'function') {
        return async (...args: unknown[]) => {
          // Check chaos state
          if (chaos.shouldApply()) {
            const latency = chaos.getLatency();
            if (latency > 0) {
              await sleep(latency);
            }

            const state = chaosStates.get(controllerName);
            if (state?.config.mode === 'fail') {
              chaos.recordFailure();
              throw new Error('Redis connection failed (chaos injection)');
            }
          }

          return (value as Function).apply(realClient, args);
        };
      }

      return value;
    },
  };

  const proxy = new Proxy(realClient as T, handler) as T & {
    chaos: ReturnType<typeof createChaosController>;
  };
  Object.defineProperty(proxy, 'chaos', { value: chaos, enumerable: false });

  return proxy;
}

// =============================================================================
// RPC CHAOS HELPERS
// =============================================================================

/**
 * Create a chaos-wrapped RPC provider for testing.
 */
export function createChaosRpcProvider<T extends object>(
  realProvider: T,
  options: { controllerName?: string } = {}
): T & { chaos: ReturnType<typeof createChaosController> } {
  const controllerName = options.controllerName || 'rpc';
  const chaos = createChaosController(controllerName);

  const handler: ProxyHandler<T> = {
    get(target, prop) {
      const value = Reflect.get(target, prop);

      // Wrap methods that make network calls
      const networkMethods = ['send', 'call', 'getBlock', 'getTransaction', 'getBalance'];
      if (typeof value === 'function' && networkMethods.includes(String(prop))) {
        return async (...args: unknown[]) => {
          if (chaos.shouldApply()) {
            const latency = chaos.getLatency();
            if (latency > 0) {
              await sleep(latency);
            }

            const state = chaosStates.get(controllerName);
            if (state?.config.mode === 'fail') {
              chaos.recordFailure();
              throw new Error('RPC request failed (chaos injection)');
            }
          }

          return (value as Function).apply(realProvider, args);
        };
      }

      return value;
    },
  };

  const proxy = new Proxy(realProvider as T, handler) as T & {
    chaos: ReturnType<typeof createChaosController>;
  };
  Object.defineProperty(proxy, 'chaos', { value: chaos, enumerable: false });

  return proxy;
}

// =============================================================================
// NETWORK PARTITION SIMULATION
// =============================================================================

/**
 * Simulate network partition between services.
 */
export class NetworkPartitionSimulator {
  private partitions = new Map<string, Set<string>>();
  private isActive = false;

  /**
   * Create a partition between two services.
   */
  partition(service1: string, service2: string) {
    this.isActive = true;

    // Add bidirectional partition
    if (!this.partitions.has(service1)) {
      this.partitions.set(service1, new Set());
    }
    if (!this.partitions.has(service2)) {
      this.partitions.set(service2, new Set());
    }

    this.partitions.get(service1)!.add(service2);
    this.partitions.get(service2)!.add(service1);
  }

  /**
   * Heal partition between two services.
   */
  heal(service1: string, service2: string) {
    this.partitions.get(service1)?.delete(service2);
    this.partitions.get(service2)?.delete(service1);
  }

  /**
   * Heal all partitions.
   */
  healAll() {
    this.partitions.clear();
    this.isActive = false;
  }

  /**
   * Check if two services can communicate.
   */
  canCommunicate(service1: string, service2: string): boolean {
    if (!this.isActive) return true;
    return !this.partitions.get(service1)?.has(service2);
  }

  /**
   * Get partition status.
   */
  getStatus() {
    return {
      isActive: this.isActive,
      partitions: Array.from(this.partitions.entries()).map(([service, blocked]) => ({
        service,
        blockedFrom: Array.from(blocked),
      })),
    };
  }
}

// =============================================================================
// CHAOS TEST HELPERS
// =============================================================================

/**
 * Run a test with chaos injection.
 */
export async function withChaosTest<T>(
  controllerName: string,
  config: ChaosConfig,
  testFn: () => Promise<T>
): Promise<{ result?: T; error?: Error; stats: ReturnType<ReturnType<typeof createChaosController>['getStats']> }> {
  const controller = chaosStates.get(controllerName);
  if (!controller) {
    throw new Error(`Chaos controller '${controllerName}' not found`);
  }

  const state = chaosStates.get(controllerName)!;

  // Start chaos
  state.isActive = true;
  state.config = config;
  state.startTime = Date.now();
  state.injectedFailures = 0;
  state.injectedLatency = 0;

  let result: T | undefined;
  let error: Error | undefined;

  try {
    result = await testFn();
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    // Stop chaos
    state.isActive = false;
  }

  return {
    result,
    error,
    stats: {
      isActive: false,
      injectedFailures: state.injectedFailures,
      injectedLatency: state.injectedLatency,
      elapsedMs: Date.now() - state.startTime,
    },
  };
}

/**
 * Wait for a condition with timeout.
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<boolean> {
  const timeout = options.timeout || 30000;
  const interval = options.interval || 100;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return true;
    }
    await sleep(interval);
  }

  return false;
}
