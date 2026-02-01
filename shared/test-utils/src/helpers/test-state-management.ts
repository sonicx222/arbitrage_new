/**
 * Test State Management Utilities
 *
 * Provides utilities for managing test state in beforeAll/beforeEach patterns.
 * These helpers enable safe conversion from beforeEach to beforeAll for performance
 * optimization while maintaining test isolation.
 *
 * ## Use Cases
 *
 * 1. **Performance Optimization**: Convert expensive beforeEach initialization to
 *    beforeAll + resetState pattern
 * 2. **Test Isolation**: Ensure tests remain independent when sharing objects
 * 3. **Memory Efficiency**: Create objects once instead of per-test
 *
 * ## Usage
 *
 * ```typescript
 * import { Resettable, createResetHook } from '@arbitrage/test-utils';
 *
 * class MyService implements Resettable {
 *   private data: Map<string, any> = new Map();
 *
 *   resetState(): void {
 *     this.data.clear();
 *   }
 * }
 *
 * describe('MyService', () => {
 *   let service: MyService;
 *
 *   beforeAll(() => {
 *     service = new MyService(); // Created once
 *   });
 *
 *   beforeEach(createResetHook(() => service)); // Reset before each test
 *
 *   afterAll(() => {
 *     service.cleanup?.(); // Optional cleanup
 *   });
 * });
 * ```
 *
 * @see P2-1 from TEST_FRAMEWORK_P2_SPECS.md
 */

// Import and re-export Resettable from @arbitrage/types for backwards compatibility
// The canonical definition is now in @arbitrage/types since production code uses it
import type { Resettable } from '@arbitrage/types';
export type { Resettable };


/**
 * Verify an object implements resetState correctly.
 *
 * This function provides type-safe verification that an object can be used
 * with the beforeAll + resetState pattern.
 *
 * @param obj - Object to verify
 * @throws {Error} If object doesn't implement resetState()
 *
 * @example
 * ```typescript
 * const service = new MyService();
 * verifyResettable(service); // Throws if no resetState method
 *
 * beforeAll(() => {
 *   service = new MyService();
 *   verifyResettable(service); // Assert at setup time
 * });
 *
 * beforeEach(() => {
 *   service.resetState(); // Now type-safe
 * });
 * ```
 */
export function verifyResettable(obj: any): asserts obj is Resettable {
  if (!obj) {
    throw new Error(
      'Cannot verify null/undefined object. ' +
      'Ensure object is created before calling verifyResettable().'
    );
  }

  if (typeof obj.resetState !== 'function') {
    const className = obj.constructor?.name || typeof obj;
    throw new Error(
      `Object of type "${className}" does not implement resetState(). ` +
      `Add resetState() method to use with beforeAll + beforeEach pattern. ` +
      `See Resettable interface documentation for implementation guidelines.`
    );
  }
}

/**
 * Create a beforeEach hook that resets state.
 *
 * This factory function creates a hook that safely resets an object's state
 * before each test. It includes error handling and helpful error messages.
 *
 * @param getInstance - Function that returns the instance to reset
 * @returns Hook function suitable for use in beforeEach()
 *
 * @example
 * ```typescript
 * describe('ServiceTests', () => {
 *   let service: MyService;
 *
 *   beforeAll(() => {
 *     service = new MyService();
 *   });
 *
 *   // Automatically calls service.resetState() before each test
 *   beforeEach(createResetHook(() => service));
 *
 *   it('test 1', () => { /* ... *\/ });
 *   it('test 2', () => { /* ... *\/ });
 * });
 * ```
 *
 * @example Multiple instances
 * ```typescript
 * describe('MultiServiceTests', () => {
 *   let serviceA: ServiceA;
 *   let serviceB: ServiceB;
 *
 *   beforeAll(() => {
 *     serviceA = new ServiceA();
 *     serviceB = new ServiceB();
 *   });
 *
 *   beforeEach(() => {
 *     serviceA.resetState();
 *     serviceB.resetState();
 *   });
 *
 *   // Or use helper:
 *   // beforeEach(createResetHook(() => [serviceA, serviceB]));
 * });
 * ```
 */
export function createResetHook<T extends Resettable>(
  getInstance: () => T | T[]
): () => void {
  return () => {
    const instances = getInstance();

    // Handle null/undefined
    if (!instances) {
      throw new Error(
        'createResetHook: getInstance() returned null/undefined. ' +
        'Ensure instance is created in beforeAll() before using resetState hook.'
      );
    }

    // Support both single instance and array
    const instanceArray = Array.isArray(instances) ? instances : [instances];

    // Reset each instance
    for (const instance of instanceArray) {
      if (!instance) {
        throw new Error(
          'createResetHook: One of the instances in array is null/undefined. ' +
          'Check that all instances are properly initialized in beforeAll().'
        );
      }

      try {
        verifyResettable(instance);
        instance.resetState();
      } catch (error) {
        const className = instance.constructor?.name || 'Unknown';
        throw new Error(
          `Failed to reset state for ${className}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
}

/**
 * Utility for implementing resetState() in classes.
 *
 * This helper simplifies implementing resetState by providing common reset patterns.
 *
 * @example
 * ```typescript
 * import { resetStateHelper } from '@arbitrage/test-utils';
 *
 * class MyService implements Resettable {
 *   private cache = new Map<string, any>();
 *   private items: string[] = [];
 *   private stats = { count: 0 };
 *
 *   resetState(): void {
 *     resetStateHelper.clearCollections(this.cache, this.items);
 *     this.stats = { count: 0 };
 *   }
 * }
 * ```
 */
export const resetStateHelper = {
  /**
   * Clear multiple collections (Map, Set, Array) at once.
   */
  clearCollections(...collections: Array<Map<any, any> | Set<any> | any[]>): void {
    for (const collection of collections) {
      if (collection instanceof Map || collection instanceof Set) {
        collection.clear();
      } else if (Array.isArray(collection)) {
        collection.length = 0; // Fast array clear
      }
    }
  },

  /**
   * Reset an object's properties to default values.
   *
   * @example
   * ```typescript
   * resetState(): void {
   *   resetStateHelper.resetObject(this.stats, { hits: 0, misses: 0 });
   * }
   * ```
   */
  resetObject<T extends Record<string, any>>(target: T, defaults: T): void {
    Object.assign(target, defaults);
  },

  /**
   * Create a new instance of a default object/array.
   *
   * Useful for resetting complex nested structures.
   *
   * @example
   * ```typescript
   * resetState(): void {
   *   this.config = resetStateHelper.clone(DEFAULT_CONFIG);
   * }
   * ```
   */
  clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  },
};

/**
 * Decorator for automatically adding resetState to a class.
 *
 * This experimental decorator simplifies adding resetState support.
 *
 * NOTE: This requires TypeScript decorators to be enabled.
 * Add `"experimentalDecorators": true` to tsconfig.json.
 *
 * @example
 * ```typescript
 * @ResettableClass({
 *   clearMaps: ['cache'],
 *   clearArrays: ['items'],
 *   resetProps: { stats: { count: 0 } }
 * })
 * class MyService {
 *   private cache = new Map<string, any>();
 *   private items: string[] = [];
 *   private stats = { count: 0 };
 * }
 * ```
 */
export function ResettableClass(config: {
  clearMaps?: string[];
  clearSets?: string[];
  clearArrays?: string[];
  resetProps?: Record<string, any>;
}) {
  return function <T extends { new (...args: any[]): {} }>(constructor: T) {
    return class extends constructor implements Resettable {
      resetState(): void {
        const instance = this as any;

        // Clear maps
        config.clearMaps?.forEach((prop) => {
          if (instance[prop] instanceof Map) {
            instance[prop].clear();
          }
        });

        // Clear sets
        config.clearSets?.forEach((prop) => {
          if (instance[prop] instanceof Set) {
            instance[prop].clear();
          }
        });

        // Clear arrays
        config.clearArrays?.forEach((prop) => {
          if (Array.isArray(instance[prop])) {
            instance[prop].length = 0;
          }
        });

        // Reset properties
        if (config.resetProps) {
          Object.entries(config.resetProps).forEach(([prop, value]) => {
            instance[prop] = resetStateHelper.clone(value);
          });
        }
      }
    };
  };
}
