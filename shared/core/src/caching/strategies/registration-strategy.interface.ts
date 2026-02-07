/**
 * Registration Strategy Interface (Enhancement #4)
 *
 * Defines the contract for key registration strategies in SharedKeyRegistry.
 * Follows Strategy Pattern to separate main thread (fast path) from worker thread (CAS loop) implementations.
 *
 * @see ADR-022 - Hot-Path Memory Optimization
 * @see shared/core/src/caching/shared-key-registry.ts - Original implementation
 *
 * Design Principles:
 * - Interface Segregation: Single responsibility for key registration
 * - Dependency Inversion: Depend on abstractions, not concrete classes
 * - Open/Closed: Open for extension (new strategies), closed for modification
 *
 * Performance Targets:
 * - Main thread registration: <100ns
 * - Worker thread registration: <5μs (with CAS loop)
 * - Zero allocations in hot path
 *
 * @package @arbitrage/core
 * @module caching/strategies
 */

/**
 * Result of a key registration operation
 */
export interface RegistrationResult {
  /**
   * The allocated index for the key (0-based)
   */
  readonly index: number;

  /**
   * Whether this was a new registration (true) or existing key (false)
   */
  readonly isNew: boolean;

  /**
   * Number of CAS loop iterations (worker threads only, 0 for main thread)
   */
  readonly iterations: number;
}

/**
 * Strategy for registering keys in SharedKeyRegistry
 *
 * Implementations:
 * - MainThreadStrategy: Fast path, no CAS loop (99% of writes)
 * - WorkerThreadStrategy: CAS loop for thread-safe registration (1% of writes)
 *
 * Thread Safety:
 * - Main thread: No synchronization needed (exclusive access)
 * - Worker threads: Must use Atomics.compareExchange for CAS loop
 *
 * @example
 * ```typescript
 * // Main thread (fast path)
 * const strategy = new MainThreadStrategy(sharedBuffer, localMap);
 * const result = strategy.register('price:bsc:0xABC...'); // ~50ns
 *
 * // Worker thread (CAS loop)
 * const strategy = new WorkerThreadStrategy(sharedBuffer);
 * const result = strategy.register('price:bsc:0xABC...'); // ~2-4μs
 * ```
 */
export interface IRegistrationStrategy {
  /**
   * Register a key and return its allocated index
   *
   * Behavior:
   * - If key exists: return existing index, isNew=false
   * - If key new: allocate index, return it, isNew=true
   * - If registry full: throw RegistryFullError
   *
   * Thread Safety:
   * - Main thread: Direct write, no synchronization
   * - Worker threads: CAS loop with Atomics.compareExchange
   *
   * Performance:
   * - Main thread: O(1) hash map lookup + O(1) array write = ~50ns
   * - Worker thread: O(1) hash + O(n) CAS iterations where n=contention = ~2-4μs
   *
   * @param key - The cache key to register (e.g., "price:bsc:0xABC...")
   * @returns Registration result with allocated index
   * @throws {RegistryFullError} If max capacity reached
   * @throws {InvalidKeyError} If key is empty or invalid format
   */
  register(key: string): RegistrationResult;

  /**
   * Lookup an existing key's index without registering
   *
   * This is a read-only operation that never modifies the registry.
   * Useful for checking if a key exists before registration.
   *
   * Performance: O(1) for main thread, O(n) linear scan for workers
   *
   * @param key - The cache key to lookup
   * @returns Index if found, undefined if not registered
   */
  lookup(key: string): number | undefined;

  /**
   * Get current registry statistics
   *
   * Metrics:
   * - Total keys registered
   * - Capacity utilization %
   * - Average CAS iterations (worker threads only)
   * - Failed registration attempts
   *
   * @returns Registry statistics for monitoring
   */
  getStats(): RegistryStats;
}

/**
 * Registry statistics for monitoring and alerting
 */
export interface RegistryStats {
  /**
   * Total number of keys currently registered
   */
  readonly keyCount: number;

  /**
   * Maximum capacity (e.g., 10000)
   */
  readonly maxCapacity: number;

  /**
   * Capacity utilization as percentage (0-100)
   */
  readonly utilizationPercent: number;

  /**
   * Average CAS loop iterations (worker threads only, 0 for main thread)
   *
   * Alert thresholds:
   * - <5: Normal (low contention)
   * - 5-20: Warning (moderate contention)
   * - >20: Critical (high contention, consider scaling)
   */
  readonly avgCasIterations: number;

  /**
   * Number of failed registration attempts (capacity exceeded)
   */
  readonly failedRegistrations: number;

  /**
   * Thread mode: 'main' or 'worker'
   */
  readonly threadMode: 'main' | 'worker';
}

/**
 * Error thrown when registry reaches max capacity
 */
export class RegistryFullError extends Error {
  constructor(
    public readonly maxCapacity: number,
    public readonly attemptedKey: string
  ) {
    super(
      `SharedKeyRegistry full: ${maxCapacity} keys registered. Cannot register "${attemptedKey}"`
    );
    this.name = 'RegistryFullError';
  }
}

/**
 * Error thrown when key format is invalid
 */
export class InvalidKeyError extends Error {
  constructor(
    public readonly key: string,
    public readonly reason: string
  ) {
    super(`Invalid cache key "${key}": ${reason}`);
    this.name = 'InvalidKeyError';
  }
}
