/**
 * Async Singleton Pattern Utility
 * P1-3-FIX: Standardized singleton pattern for thread-safe lazy initialization
 *
 * This utility prevents race conditions in singleton creation by:
 * 1. Caching the factory promise (not the result) immediately
 * 2. Allowing multiple callers to await the same promise
 * 3. Preventing duplicate initialization attempts
 *
 * @example
 * const getRedisClient = createAsyncSingleton(
 *   async () => new Redis(config),
 *   async (client) => client.disconnect()
 * );
 *
 * // Usage
 * const client = await getRedisClient();
 */

import { createLogger } from '../logger';

const logger = createLogger('async-singleton');

/**
 * Creates a thread-safe async singleton factory.
 *
 * @param factory - Async function that creates the singleton instance
 * @param cleanup - Optional async function to cleanup the instance on reset
 * @param name - Optional name for logging purposes
 * @returns Object with get() and reset() methods
 */
export function createAsyncSingleton<T>(
  factory: () => Promise<T>,
  cleanup?: (instance: T) => Promise<void>,
  name?: string
): {
  get: () => Promise<T>;
  reset: () => Promise<void>;
  isInitialized: () => boolean;
} {
  // Store the promise, not the instance - this is key to preventing race conditions
  let instancePromise: Promise<T> | null = null;
  let instance: T | null = null;
  // Fix #9: Version counter to detect reset-during-init race conditions.
  // Incremented on every reset(). The factory .then() only writes to instance
  // if the version hasn't changed since get() was called.
  let version = 0;
  const singletonName = name || 'unnamed-singleton';

  return {
    /**
     * Get the singleton instance, initializing it if necessary.
     * Multiple concurrent calls will share the same initialization promise.
     */
    async get(): Promise<T> {
      // If we have a cached promise, return it (handles concurrent access)
      if (instancePromise) {
        return instancePromise;
      }

      // Capture version at start of init to detect concurrent reset()
      const initVersion = version;

      // Create and cache the promise immediately to prevent race conditions
      instancePromise = factory().then((result) => {
        // Fix #9: Only write instance if no reset() occurred during init
        if (version === initVersion) {
          instance = result;
          logger.debug(`Singleton initialized: ${singletonName}`);
        } else {
          // A reset() happened while we were initializing. The result is stale.
          // Run cleanup on the stale instance if cleanup function exists.
          logger.debug(`Singleton init completed after reset, discarding stale instance: ${singletonName}`);
          if (cleanup) {
            cleanup(result).catch((err) => {
              logger.error(`Cleanup of stale singleton failed: ${singletonName}`, { error: err });
            });
          }
        }
        return result;
      }).catch((error) => {
        // Only clear if no reset() happened (version unchanged)
        if (version === initVersion) {
          instancePromise = null;
          instance = null;
        }
        logger.error(`Singleton initialization failed: ${singletonName}`, { error });
        throw error;
      });

      return instancePromise;
    },

    /**
     * Reset the singleton, optionally calling cleanup on the existing instance.
     * If initialization is in-flight, awaits it before cleanup to prevent
     * the stale-instance-after-reset race condition.
     */
    async reset(): Promise<void> {
      // Fix #9: Increment version to invalidate any in-flight factory .then()
      version++;

      // If there's a pending init, await it so cleanup can run on the result
      const pendingPromise = instancePromise;
      if (pendingPromise && !instance) {
        try {
          await pendingPromise;
        } catch {
          // Ignore init errors during reset
        }
      }

      if (instance && cleanup) {
        try {
          await cleanup(instance);
          logger.debug(`Singleton cleaned up: ${singletonName}`);
        } catch (error) {
          logger.error(`Singleton cleanup failed: ${singletonName}`, { error });
        }
      }
      instancePromise = null;
      instance = null;
    },

    /**
     * Check if the singleton has been initialized.
     */
    isInitialized(): boolean {
      return instance !== null;
    }
  };
}

/**
 * Creates a simple (synchronous) singleton factory.
 * Use this for singletons that don't require async initialization.
 *
 * @param factory - Function that creates the singleton instance
 * @param cleanup - Optional function to cleanup the instance on reset
 * @param name - Optional name for logging purposes
 */
export function createSingleton<T>(
  factory: () => T,
  cleanup?: (instance: T) => void,
  name?: string
): {
  get: () => T;
  reset: () => void;
  isInitialized: () => boolean;
} {
  let instance: T | null = null;
  const singletonName = name || 'unnamed-singleton';

  return {
    get(): T {
      if (!instance) {
        instance = factory();
        logger.debug(`Singleton initialized: ${singletonName}`);
      }
      return instance;
    },

    reset(): void {
      if (instance && cleanup) {
        try {
          cleanup(instance);
          logger.debug(`Singleton cleaned up: ${singletonName}`);
        } catch (error) {
          logger.error(`Singleton cleanup failed: ${singletonName}`, { error });
        }
      }
      instance = null;
    },

    isInitialized(): boolean {
      return instance !== null;
    }
  };
}

/**
 * P1-FIX: Creates a configurable singleton factory.
 * Use this for singletons that need configuration on first initialization.
 *
 * Unlike createSingleton which uses a fixed factory, this pattern accepts
 * optional configuration on the first get() call. Subsequent calls ignore
 * the config parameter and return the existing instance.
 *
 * @param factory - Function that creates the instance, receives optional config
 * @param cleanup - Optional function to cleanup the instance on reset
 * @param name - Optional name for logging purposes
 *
 * @example
 * const { get: getTracker, reset: resetTracker } = createConfigurableSingleton(
 *   (config) => new PriceTracker(config),
 *   (instance) => instance.reset(),
 *   'price-tracker'
 * );
 *
 * // First call creates with config
 * const tracker = getTracker({ windowSize: 100 });
 * // Subsequent calls return same instance (config ignored)
 * const same = getTracker({ windowSize: 200 }); // same === tracker
 */
export function createConfigurableSingleton<T, C = undefined>(
  factory: (config?: C) => T,
  cleanup?: (instance: T) => void,
  name?: string
): {
  get: (config?: C) => T;
  reset: () => void;
  isInitialized: () => boolean;
} {
  let instance: T | null = null;
  const singletonName = name || 'unnamed-configurable-singleton';

  return {
    get(config?: C): T {
      if (!instance) {
        instance = factory(config);
        logger.debug(`Configurable singleton initialized: ${singletonName}`);
      }
      return instance;
    },

    reset(): void {
      if (instance && cleanup) {
        try {
          cleanup(instance);
          logger.debug(`Configurable singleton cleaned up: ${singletonName}`);
        } catch (error) {
          logger.error(`Configurable singleton cleanup failed: ${singletonName}`, { error });
        }
      }
      instance = null;
    },

    isInitialized(): boolean {
      return instance !== null;
    }
  };
}

/**
 * Decorator for creating singleton methods in classes.
 * The first call initializes, subsequent calls return the cached instance.
 */
export function singleton<T>(): MethodDecorator {
  let instancePromise: Promise<T> | null = null;

  return function (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: unknown, ...args: unknown[]) {
      if (!instancePromise) {
        const promise = originalMethod.apply(this, args);
        instancePromise = promise;
        // P1-FIX: Clear cached promise on rejection so retry is possible
        // Matches createAsyncSingleton pattern at lines 62-65
        promise.catch(() => { instancePromise = null; });
      }
      return instancePromise;
    };

    return descriptor;
  };
}
