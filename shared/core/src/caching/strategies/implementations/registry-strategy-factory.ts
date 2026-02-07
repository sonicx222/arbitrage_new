/**
 * Registry Strategy Factory (Enhancement #4)
 *
 * Creates appropriate registration strategy based on thread context.
 * Follows Factory Pattern for strategy selection.
 *
 * @see caching/strategies/registration-strategy.interface.ts - IRegistrationStrategy contract
 * @see caching/strategies/implementations/main-thread-strategy.ts - Fast path
 * @see caching/strategies/implementations/worker-thread-strategy.ts - CAS loop
 *
 * @package @arbitrage/core
 * @module caching/strategies/implementations
 */

import { IRegistrationStrategy } from '../registration-strategy.interface';
import { MainThreadStrategy } from './main-thread-strategy';
import { WorkerThreadStrategy } from './worker-thread-strategy';
import { isMainThread } from 'worker_threads';

/**
 * Strategy selection configuration
 */
export interface StrategyFactoryConfig {
  /**
   * Shared array buffer for key registry
   */
  sharedBuffer: SharedArrayBuffer;

  /**
   * Maximum number of keys
   */
  maxKeys: number;

  /**
   * Force specific strategy (overrides auto-detection)
   * Useful for testing
   */
  forceStrategy?: 'main' | 'worker';
}

/**
 * Factory for creating registration strategies
 *
 * Selection Logic:
 * - If forceStrategy specified → use forced strategy
 * - Else if isMainThread === true → MainThreadStrategy (fast path)
 * - Else if isMainThread === false → WorkerThreadStrategy (CAS loop)
 *
 * Performance Impact:
 * - MainThreadStrategy: ~50ns per registration
 * - WorkerThreadStrategy: ~2-4μs per registration
 * - 99% of writes happen on main thread → ~40x speedup
 *
 * @example
 * ```typescript
 * // Auto-detect based on thread context
 * const strategy = RegistryStrategyFactory.create({
 *   sharedBuffer: myBuffer,
 *   maxKeys: 10000
 * });
 *
 * // Force main thread strategy (testing)
 * const mainStrategy = RegistryStrategyFactory.create({
 *   sharedBuffer: myBuffer,
 *   maxKeys: 10000,
 *   forceStrategy: 'main'
 * });
 * ```
 */
export class RegistryStrategyFactory {
  /**
   * Create appropriate registration strategy
   *
   * @param config - Factory configuration
   * @returns Strategy instance (MainThreadStrategy or WorkerThreadStrategy)
   */
  static create(config: StrategyFactoryConfig): IRegistrationStrategy {
    // Check for forced strategy (testing/debugging)
    if (config.forceStrategy) {
      return config.forceStrategy === 'main'
        ? new MainThreadStrategy(config.sharedBuffer, config.maxKeys)
        : new WorkerThreadStrategy(config.sharedBuffer, config.maxKeys);
    }

    // Auto-detect based on thread context
    return isMainThread
      ? new MainThreadStrategy(config.sharedBuffer, config.maxKeys)
      : new WorkerThreadStrategy(config.sharedBuffer, config.maxKeys);
  }

  /**
   * Create main thread strategy explicitly
   *
   * @param sharedBuffer - Shared array buffer
   * @param maxKeys - Maximum number of keys
   * @returns MainThreadStrategy instance
   */
  static createMainThreadStrategy(
    sharedBuffer: SharedArrayBuffer,
    maxKeys: number
  ): IRegistrationStrategy {
    return new MainThreadStrategy(sharedBuffer, maxKeys);
  }

  /**
   * Create worker thread strategy explicitly
   *
   * @param sharedBuffer - Shared array buffer
   * @param maxKeys - Maximum number of keys
   * @returns WorkerThreadStrategy instance
   */
  static createWorkerThreadStrategy(
    sharedBuffer: SharedArrayBuffer,
    maxKeys: number
  ): IRegistrationStrategy {
    return new WorkerThreadStrategy(sharedBuffer, maxKeys);
  }

  /**
   * Detect current thread mode
   *
   * @returns 'main' if main thread, 'worker' if worker thread
   */
  static detectThreadMode(): 'main' | 'worker' {
    return isMainThread ? 'main' : 'worker';
  }
}
