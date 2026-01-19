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

import { createLogger } from './logger';

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

      // Create and cache the promise immediately to prevent race conditions
      instancePromise = factory().then((result) => {
        instance = result;
        logger.debug(`Singleton initialized: ${singletonName}`);
        return result;
      }).catch((error) => {
        // Clear the promise on failure so retry is possible
        instancePromise = null;
        instance = null;
        logger.error(`Singleton initialization failed: ${singletonName}`, { error });
        throw error;
      });

      return instancePromise;
    },

    /**
     * Reset the singleton, optionally calling cleanup on the existing instance.
     */
    async reset(): Promise<void> {
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
 * Decorator for creating singleton methods in classes.
 * The first call initializes, subsequent calls return the cached instance.
 */
export function singleton<T>(): MethodDecorator {
  let instancePromise: Promise<T> | null = null;

  return function (
    _target: any,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      if (!instancePromise) {
        instancePromise = originalMethod.apply(this, args);
      }
      return instancePromise;
    };

    return descriptor;
  };
}
