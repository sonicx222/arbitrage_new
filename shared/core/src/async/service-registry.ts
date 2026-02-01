/**
 * Service Registry
 *
 * R6 Consolidation: Centralized registry for managing singleton services.
 * Provides lifecycle management, dependency tracking, and test cleanup.
 *
 * Features:
 * - Register services with async factories and cleanup functions
 * - Lazy initialization on first get()
 * - Thread-safe initialization (shares promise on concurrent access)
 * - resetAll() for test cleanup
 * - Service health checks
 * - Dependency declaration (for documentation/debugging, not enforced)
 *
 * Unlike individual singletons (createAsyncSingleton), this registry:
 * - Tracks all registered services in one place
 * - Provides global reset for testing
 * - Enables service discovery and health monitoring
 * - Documents service dependencies
 *
 * @example
 * ```typescript
 * // Register a service
 * registry.register({
 *   name: 'redis',
 *   factory: async () => createRedisClient(),
 *   cleanup: async (client) => client.disconnect(),
 *   healthCheck: async (client) => client.ping() === 'PONG'
 * });
 *
 * // Get the service (lazy init on first call)
 * const redis = await registry.get('redis');
 *
 * // Reset all services (for testing)
 * await registry.resetAll();
 * ```
 *
 * @see async-singleton.ts - Lower-level singleton utilities
 * @see ADR-002 - Redis Streams Architecture (service lifecycle)
 */

import { createLogger } from '../logger';

const logger = createLogger('service-registry');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for registering a service.
 */
export interface ServiceRegistration<T> {
  /** Unique service name (e.g., 'redis', 'streams-client', 'price-matrix') */
  name: string;

  /** Async factory function to create the service instance */
  factory: () => Promise<T>;

  /** Optional cleanup function called on reset */
  cleanup?: (instance: T) => Promise<void>;

  /** Optional health check function */
  healthCheck?: (instance: T) => Promise<boolean>;

  /** Optional list of service dependencies (for documentation/debugging) */
  dependencies?: string[];

  /** Optional description of the service */
  description?: string;
}

/**
 * Internal state for a registered service.
 */
interface ServiceEntry<T = unknown> {
  registration: ServiceRegistration<T>;
  instance: T | null;
  initPromise: Promise<T> | null;
  initError: Error | null;
  initTime: number | null;
}

/**
 * Service health status.
 */
export interface RegisteredServiceHealth {
  name: string;
  initialized: boolean;
  healthy: boolean | null;
  initTime: number | null;
  error: string | null;
  dependencies: string[];
}

/**
 * Registry health summary.
 */
export interface RegistryHealth {
  totalServices: number;
  initializedServices: number;
  healthyServices: number;
  services: RegisteredServiceHealth[];
}

// =============================================================================
// Service Registry Implementation
// =============================================================================

/**
 * Centralized service registry for managing singleton services.
 *
 * Thread-safe: Multiple concurrent get() calls share the same init promise.
 * Lazy: Services are not initialized until first get() call.
 */
export class ServiceRegistry {
  private services = new Map<string, ServiceEntry>();
  private isResetting = false;

  /**
   * Register a service with the registry.
   *
   * Does NOT initialize the service - initialization happens on first get().
   *
   * @param registration - Service configuration
   * @throws Error if service name is already registered
   */
  register<T>(registration: ServiceRegistration<T>): void {
    if (this.services.has(registration.name)) {
      throw new Error(`Service '${registration.name}' is already registered`);
    }

    this.services.set(registration.name, {
      registration: registration as ServiceRegistration<unknown>,
      instance: null,
      initPromise: null,
      initError: null,
      initTime: null,
    });

    logger.debug(`Service registered: ${registration.name}`, {
      dependencies: registration.dependencies ?? [],
      description: registration.description,
    });
  }

  /**
   * Get a service instance, initializing it if necessary.
   *
   * Thread-safe: Multiple concurrent calls share the same init promise.
   *
   * @param name - Service name
   * @returns Promise resolving to the service instance
   * @throws Error if service is not registered
   * @throws Error if service initialization fails
   */
  async get<T>(name: string): Promise<T> {
    const entry = this.services.get(name);
    if (!entry) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // Return existing instance
    if (entry.instance !== null) {
      return entry.instance as T;
    }

    // Return existing init promise (thread-safe)
    if (entry.initPromise !== null) {
      return entry.initPromise as Promise<T>;
    }

    // Re-throw previous init error (don't retry automatically)
    if (entry.initError !== null) {
      throw entry.initError;
    }

    // Initialize the service
    const startTime = Date.now();
    entry.initPromise = entry.registration.factory()
      .then((instance) => {
        entry.instance = instance;
        entry.initTime = Date.now() - startTime;
        entry.initPromise = null;
        logger.debug(`Service initialized: ${name}`, { initTimeMs: entry.initTime });
        return instance as T;
      })
      .catch((error) => {
        entry.initError = error instanceof Error ? error : new Error(String(error));
        entry.initPromise = null;
        logger.error(`Service initialization failed: ${name}`, { error: entry.initError.message });
        throw entry.initError;
      });

    return entry.initPromise as Promise<T>;
  }

  /**
   * Check if a service is registered.
   *
   * @param name - Service name
   * @returns true if registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Check if a service has been initialized.
   *
   * @param name - Service name
   * @returns true if initialized (instance exists)
   */
  isInitialized(name: string): boolean {
    const entry = this.services.get(name);
    // Must check entry exists AND instance is not null
    // (entry?.instance !== null is buggy: undefined !== null is true)
    return entry !== undefined && entry.instance !== null;
  }

  /**
   * Reset a specific service.
   *
   * Calls cleanup function if provided, then clears the instance.
   *
   * @param name - Service name
   * @throws Error if service is not registered
   */
  async reset(name: string): Promise<void> {
    const entry = this.services.get(name);
    if (!entry) {
      throw new Error(`Service '${name}' is not registered`);
    }

    // Wait for any pending initialization to complete
    if (entry.initPromise) {
      try {
        await entry.initPromise;
      } catch {
        // Ignore init errors during reset
      }
    }

    // Cleanup the instance
    if (entry.instance !== null && entry.registration.cleanup) {
      try {
        await entry.registration.cleanup(entry.instance);
        logger.debug(`Service cleaned up: ${name}`);
      } catch (error) {
        logger.warn(`Service cleanup failed: ${name}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Clear state
    entry.instance = null;
    entry.initPromise = null;
    entry.initError = null;
    entry.initTime = null;
  }

  /**
   * Reset all registered services.
   *
   * Useful for test cleanup. Resets in reverse registration order
   * to handle dependencies correctly (dependent services first).
   */
  async resetAll(): Promise<void> {
    // Prevent concurrent resets
    if (this.isResetting) {
      logger.warn('resetAll() already in progress, skipping');
      return;
    }

    this.isResetting = true;
    const serviceNames = Array.from(this.services.keys()).reverse();

    logger.debug('Resetting all services', { count: serviceNames.length });

    // Use Promise.allSettled to ensure all services are reset even if some fail
    const results = await Promise.allSettled(
      serviceNames.map((name) => this.reset(name))
    );

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(`Failed to reset service: ${serviceNames[index]}`, {
          error: result.reason,
        });
      }
    });

    this.isResetting = false;
    logger.debug('All services reset');
  }

  /**
   * Unregister a service.
   *
   * Resets the service first, then removes it from the registry.
   *
   * @param name - Service name
   * @throws Error if service is not registered
   */
  async unregister(name: string): Promise<void> {
    if (!this.services.has(name)) {
      throw new Error(`Service '${name}' is not registered`);
    }

    await this.reset(name);
    this.services.delete(name);
    logger.debug(`Service unregistered: ${name}`);
  }

  /**
   * Get health status of all services.
   *
   * Runs health checks on initialized services if healthCheck is defined.
   */
  async getHealth(): Promise<RegistryHealth> {
    const services: RegisteredServiceHealth[] = [];
    let initializedCount = 0;
    let healthyCount = 0;

    for (const [name, entry] of this.services) {
      const health: RegisteredServiceHealth = {
        name,
        initialized: entry.instance !== null,
        healthy: null,
        initTime: entry.initTime,
        error: entry.initError?.message ?? null,
        dependencies: entry.registration.dependencies ?? [],
      };

      if (entry.instance !== null) {
        initializedCount++;

        if (entry.registration.healthCheck) {
          try {
            health.healthy = await entry.registration.healthCheck(entry.instance);
            if (health.healthy) {
              healthyCount++;
            }
          } catch (error) {
            health.healthy = false;
            health.error = error instanceof Error ? error.message : String(error);
          }
        } else {
          // No health check defined - assume healthy if initialized
          health.healthy = true;
          healthyCount++;
        }
      }

      services.push(health);
    }

    return {
      totalServices: this.services.size,
      initializedServices: initializedCount,
      healthyServices: healthyCount,
      services,
    };
  }

  /**
   * Get list of registered service names.
   */
  getServiceNames(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get registration info for a service.
   *
   * @param name - Service name
   * @returns Registration info or undefined if not registered
   */
  getRegistration(name: string): Omit<ServiceRegistration<unknown>, 'factory' | 'cleanup' | 'healthCheck'> | undefined {
    const entry = this.services.get(name);
    if (!entry) {
      return undefined;
    }

    return {
      name: entry.registration.name,
      dependencies: entry.registration.dependencies,
      description: entry.registration.description,
    };
  }
}

// =============================================================================
// Global Registry Instance
// =============================================================================

/** Global service registry instance */
let globalRegistry: ServiceRegistry | null = null;

/**
 * Get the global service registry instance.
 *
 * Creates the registry on first call (lazy initialization).
 */
export function getServiceRegistry(): ServiceRegistry {
  if (!globalRegistry) {
    globalRegistry = new ServiceRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global service registry.
 *
 * Resets all services and clears the global instance.
 * Useful for test cleanup.
 */
export async function resetServiceRegistry(): Promise<void> {
  if (globalRegistry) {
    await globalRegistry.resetAll();
    globalRegistry = null;
    logger.debug('Global service registry reset');
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Register a service with the global registry.
 *
 * Convenience function for `getServiceRegistry().register()`.
 */
export function registerService<T>(registration: ServiceRegistration<T>): void {
  getServiceRegistry().register(registration);
}

/**
 * Get a service from the global registry.
 *
 * Convenience function for `getServiceRegistry().get()`.
 */
export async function getService<T>(name: string): Promise<T> {
  return getServiceRegistry().get<T>(name);
}
