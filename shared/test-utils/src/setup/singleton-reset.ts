/**
 * Singleton Reset Manager
 *
 * Centralized management of singleton reset functions.
 * Automatically resets all registered singletons between tests
 * to ensure proper test isolation.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */

type ResetFunction = () => void | Promise<void>;

interface RegisteredSingleton {
  name: string;
  reset: ResetFunction;
  priority: number; // Lower = reset first
}

const registeredSingletons: RegisteredSingleton[] = [];

/**
 * Register a singleton reset function
 *
 * @param name - Unique name for the singleton (for logging)
 * @param resetFn - Function to reset the singleton
 * @param priority - Reset order (default 50, lower = earlier)
 */
export function registerSingletonReset(
  name: string,
  resetFn: ResetFunction,
  priority = 50
): void {
  // Avoid duplicates
  const existing = registeredSingletons.findIndex(s => s.name === name);
  if (existing >= 0) {
    registeredSingletons[existing] = { name, reset: resetFn, priority };
  } else {
    registeredSingletons.push({ name, reset: resetFn, priority });
  }
  // Keep sorted by priority
  registeredSingletons.sort((a, b) => a.priority - b.priority);
}

/**
 * Unregister a singleton reset function
 */
export function unregisterSingletonReset(name: string): void {
  const index = registeredSingletons.findIndex(s => s.name === name);
  if (index >= 0) {
    registeredSingletons.splice(index, 1);
  }
}

/**
 * Reset all registered singletons
 *
 * Call this in afterEach() to ensure test isolation
 */
export async function resetAllSingletons(): Promise<void> {
  const errors: Array<{ name: string; error: Error }> = [];

  for (const singleton of registeredSingletons) {
    try {
      await singleton.reset();
    } catch (error) {
      // Collect errors but continue resetting others
      errors.push({
        name: singleton.name,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  // Log errors if any (don't throw to avoid masking test failures)
  if (errors.length > 0 && process.env.DEBUG_TESTS === 'true') {
    console.warn('Singleton reset errors:', errors);
  }
}

/**
 * Get list of registered singleton names (for debugging)
 */
export function getRegisteredSingletons(): string[] {
  return registeredSingletons.map(s => s.name);
}

/**
 * Clear all registered singletons (for testing the test utils)
 */
export function clearRegisteredSingletons(): void {
  registeredSingletons.length = 0;
}

// =============================================================================
// Pre-register known singletons from @arbitrage/core
// =============================================================================

/**
 * Initialize all known singleton reset functions
 *
 * This function should be called once during test setup.
 * It dynamically imports @arbitrage/core to avoid circular dependencies.
 */
export async function initializeSingletonResets(): Promise<void> {
  try {
    // Dynamic import to avoid circular dependencies during module load
    const core = await import('@arbitrage/core');

    // Redis (priority 10 - reset early, others may depend on it)
    if (typeof core.resetRedisInstance === 'function') {
      registerSingletonReset('redis', core.resetRedisInstance, 10);
    }
    if (typeof core.resetRedisStreamsInstance === 'function') {
      registerSingletonReset('redisStreams', core.resetRedisStreamsInstance, 10);
    }

    // Core services (priority 30)
    if (typeof core.resetSwapEventFilter === 'function') {
      registerSingletonReset('swapEventFilter', core.resetSwapEventFilter, 30);
    }
    if (typeof core.resetPriceMatrix === 'function') {
      registerSingletonReset('priceMatrix', core.resetPriceMatrix, 30);
    }
    if (typeof core.resetPriceOracle === 'function') {
      registerSingletonReset('priceOracle', core.resetPriceOracle, 30);
    }
    if (typeof core.resetStreamHealthMonitor === 'function') {
      registerSingletonReset('streamHealthMonitor', core.resetStreamHealthMonitor, 30);
    }

    // Distributed systems (priority 40)
    if (typeof core.resetDistributedLockManager === 'function') {
      registerSingletonReset('distributedLock', core.resetDistributedLockManager, 40);
    }
    if (typeof core.resetCrossRegionHealthManager === 'function') {
      registerSingletonReset('crossRegionHealth', core.resetCrossRegionHealthManager, 40);
    }

    // Cache (priority 50)
    if (typeof core.resetCacheCoherencyManager === 'function') {
      registerSingletonReset('cacheCoherency', core.resetCacheCoherencyManager, 50);
    }

    // Pair services (priority 60)
    if (typeof core.resetPairDiscoveryService === 'function') {
      registerSingletonReset('pairDiscovery', core.resetPairDiscoveryService, 60);
    }
    if (typeof core.resetPairCacheService === 'function') {
      registerSingletonReset('pairCache', core.resetPairCacheService, 60);
    }

    // Transaction management (priority 70)
    if (typeof core.resetNonceManager === 'function') {
      registerSingletonReset('nonceManager', core.resetNonceManager, 70);
    }

    // Mutex (priority 80 - reset last, may be used by others)
    if (typeof core.clearAllNamedMutexes === 'function') {
      registerSingletonReset('namedMutexes', core.clearAllNamedMutexes, 80);
    }
  } catch (error) {
    // Core module may not be available in all contexts
    if (process.env.DEBUG_TESTS === 'true') {
      console.warn('Could not initialize singleton resets from @arbitrage/core:', error);
    }
  }
}

/**
 * Create a reset function for a specific singleton
 *
 * Useful when you need to reset a singleton explicitly in a test
 */
export function createSingletonResetter(name: string): () => Promise<void> {
  return async () => {
    const singleton = registeredSingletons.find(s => s.name === name);
    if (singleton) {
      await singleton.reset();
    }
  };
}
