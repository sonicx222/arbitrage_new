/**
 * Service Registry Tests
 *
 * Tests for the R6 centralized service registry.
 */

import {
  ServiceRegistry,
  getServiceRegistry,
  resetServiceRegistry,
  registerService,
  getService,
} from '../../src/async/service-registry';

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  describe('register', () => {
    it('should register a service', () => {
      registry.register({
        name: 'test-service',
        factory: async () => ({ value: 42 }),
      });

      expect(registry.has('test-service')).toBe(true);
      expect(registry.isInitialized('test-service')).toBe(false);
    });

    it('should throw when registering duplicate service name', () => {
      registry.register({
        name: 'test-service',
        factory: async () => ({}),
      });

      expect(() => {
        registry.register({
          name: 'test-service',
          factory: async () => ({}),
        });
      }).toThrow("Service 'test-service' is already registered");
    });
  });

  describe('has and isInitialized', () => {
    it('should return false for unregistered service in has()', () => {
      expect(registry.has('nonexistent-service')).toBe(false);
    });

    it('should return false for unregistered service in isInitialized()', () => {
      // Regression test: previously returned true due to undefined !== null being true
      expect(registry.isInitialized('nonexistent-service')).toBe(false);
    });

    it('should return consistent results between has() and isInitialized() for unregistered services', () => {
      const serviceName = 'never-registered';
      // Both should return false for unregistered services
      expect(registry.has(serviceName)).toBe(false);
      expect(registry.isInitialized(serviceName)).toBe(false);
    });
  });

  describe('get', () => {
    it('should lazily initialize service on first get', async () => {
      let factoryCalls = 0;
      registry.register({
        name: 'lazy-service',
        factory: async () => {
          factoryCalls++;
          return { value: 'initialized' };
        },
      });

      expect(factoryCalls).toBe(0);
      expect(registry.isInitialized('lazy-service')).toBe(false);

      const instance = await registry.get<{ value: string }>('lazy-service');

      expect(factoryCalls).toBe(1);
      expect(instance.value).toBe('initialized');
      expect(registry.isInitialized('lazy-service')).toBe(true);
    });

    it('should return same instance on subsequent get calls', async () => {
      registry.register({
        name: 'singleton-service',
        factory: async () => ({ id: Math.random() }),
      });

      const first = await registry.get<{ id: number }>('singleton-service');
      const second = await registry.get<{ id: number }>('singleton-service');

      expect(first).toBe(second);
      expect(first.id).toBe(second.id);
    });

    it('should share init promise for concurrent get calls', async () => {
      let factoryCalls = 0;
      registry.register({
        name: 'concurrent-service',
        factory: async () => {
          factoryCalls++;
          await new Promise((r) => setTimeout(r, 50));
          return { value: 'done' };
        },
      });

      // Start multiple concurrent get calls
      const promises = [
        registry.get('concurrent-service'),
        registry.get('concurrent-service'),
        registry.get('concurrent-service'),
      ];

      const results = await Promise.all(promises);

      // Factory should only be called once
      expect(factoryCalls).toBe(1);
      // All results should be the same instance
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });

    it('should throw for unregistered service', async () => {
      await expect(registry.get('nonexistent')).rejects.toThrow(
        "Service 'nonexistent' is not registered"
      );
    });

    it('should throw factory errors on get', async () => {
      registry.register({
        name: 'failing-service',
        factory: async () => {
          throw new Error('Factory failed');
        },
      });

      await expect(registry.get('failing-service')).rejects.toThrow('Factory failed');
    });

    it('should cache factory error and rethrow on subsequent calls', async () => {
      let factoryCalls = 0;
      registry.register({
        name: 'error-cached-service',
        factory: async () => {
          factoryCalls++;
          throw new Error('Cached error');
        },
      });

      await expect(registry.get('error-cached-service')).rejects.toThrow('Cached error');
      await expect(registry.get('error-cached-service')).rejects.toThrow('Cached error');

      // Factory should only be called once - error is cached
      expect(factoryCalls).toBe(1);
    });
  });

  describe('reset', () => {
    it('should call cleanup and clear instance', async () => {
      let cleanedUp = false;
      registry.register({
        name: 'cleanup-service',
        factory: async () => ({ value: 'test' }),
        cleanup: async () => {
          cleanedUp = true;
        },
      });

      await registry.get('cleanup-service');
      expect(registry.isInitialized('cleanup-service')).toBe(true);

      await registry.reset('cleanup-service');

      expect(cleanedUp).toBe(true);
      expect(registry.isInitialized('cleanup-service')).toBe(false);
    });

    it('should allow re-initialization after reset', async () => {
      let initCount = 0;
      registry.register({
        name: 'reinit-service',
        factory: async () => {
          initCount++;
          return { count: initCount };
        },
      });

      const first = await registry.get<{ count: number }>('reinit-service');
      expect(first.count).toBe(1);

      await registry.reset('reinit-service');

      const second = await registry.get<{ count: number }>('reinit-service');
      expect(second.count).toBe(2);
      expect(first).not.toBe(second);
    });

    it('should throw for unregistered service', async () => {
      await expect(registry.reset('nonexistent')).rejects.toThrow(
        "Service 'nonexistent' is not registered"
      );
    });

    it('should handle cleanup errors gracefully', async () => {
      registry.register({
        name: 'cleanup-error-service',
        factory: async () => ({ value: 'test' }),
        cleanup: async () => {
          throw new Error('Cleanup failed');
        },
      });

      await registry.get('cleanup-error-service');

      // Should not throw, but log warning
      await expect(registry.reset('cleanup-error-service')).resolves.toBeUndefined();
      expect(registry.isInitialized('cleanup-error-service')).toBe(false);
    });

    it('should clear init error on reset', async () => {
      let shouldFail = true;
      registry.register({
        name: 'retry-after-reset',
        factory: async () => {
          if (shouldFail) {
            throw new Error('Initial failure');
          }
          return { value: 'success' };
        },
      });

      await expect(registry.get('retry-after-reset')).rejects.toThrow('Initial failure');

      // Reset clears the error
      await registry.reset('retry-after-reset');
      shouldFail = false;

      // Now it should succeed
      const result = await registry.get<{ value: string }>('retry-after-reset');
      expect(result.value).toBe('success');
    });
  });

  describe('resetAll', () => {
    it('should reset all registered services', async () => {
      const cleanups: string[] = [];

      registry.register({
        name: 'service-a',
        factory: async () => ({ name: 'a' }),
        cleanup: async () => { cleanups.push('a'); },
      });

      registry.register({
        name: 'service-b',
        factory: async () => ({ name: 'b' }),
        cleanup: async () => { cleanups.push('b'); },
      });

      await registry.get('service-a');
      await registry.get('service-b');

      expect(registry.isInitialized('service-a')).toBe(true);
      expect(registry.isInitialized('service-b')).toBe(true);

      await registry.resetAll();

      expect(registry.isInitialized('service-a')).toBe(false);
      expect(registry.isInitialized('service-b')).toBe(false);
      // Should cleanup in reverse order (b, then a)
      expect(cleanups).toContain('a');
      expect(cleanups).toContain('b');
    });

    it('should continue resetting even if some cleanups fail', async () => {
      registry.register({
        name: 'good-service',
        factory: async () => ({ name: 'good' }),
        cleanup: async () => { /* success */ },
      });

      registry.register({
        name: 'bad-service',
        factory: async () => ({ name: 'bad' }),
        cleanup: async () => { throw new Error('Cleanup failed'); },
      });

      await registry.get('good-service');
      await registry.get('bad-service');

      // Should not throw
      await expect(registry.resetAll()).resolves.toBeUndefined();

      // Both should be reset
      expect(registry.isInitialized('good-service')).toBe(false);
      expect(registry.isInitialized('bad-service')).toBe(false);
    });
  });

  describe('unregister', () => {
    it('should reset and remove service', async () => {
      let cleanedUp = false;
      registry.register({
        name: 'unregister-service',
        factory: async () => ({ value: 'test' }),
        cleanup: async () => { cleanedUp = true; },
      });

      await registry.get('unregister-service');
      expect(registry.has('unregister-service')).toBe(true);

      await registry.unregister('unregister-service');

      expect(cleanedUp).toBe(true);
      expect(registry.has('unregister-service')).toBe(false);
    });

    it('should throw for unregistered service', async () => {
      await expect(registry.unregister('nonexistent')).rejects.toThrow(
        "Service 'nonexistent' is not registered"
      );
    });
  });

  describe('getHealth', () => {
    it('should return health status for all services', async () => {
      registry.register({
        name: 'healthy-service',
        factory: async () => ({ status: 'ok' }),
        healthCheck: async () => true,
      });

      registry.register({
        name: 'unhealthy-service',
        factory: async () => ({ status: 'bad' }),
        healthCheck: async () => false,
      });

      registry.register({
        name: 'uninitialized-service',
        factory: async () => ({ status: 'pending' }),
      });

      await registry.get('healthy-service');
      await registry.get('unhealthy-service');

      const health = await registry.getHealth();

      expect(health.totalServices).toBe(3);
      expect(health.initializedServices).toBe(2);
      expect(health.healthyServices).toBe(1);

      const healthyService = health.services.find((s) => s.name === 'healthy-service');
      expect(healthyService?.initialized).toBe(true);
      expect(healthyService?.healthy).toBe(true);

      const unhealthyService = health.services.find((s) => s.name === 'unhealthy-service');
      expect(unhealthyService?.initialized).toBe(true);
      expect(unhealthyService?.healthy).toBe(false);

      const uninitService = health.services.find((s) => s.name === 'uninitialized-service');
      expect(uninitService?.initialized).toBe(false);
      expect(uninitService?.healthy).toBe(null);
    });

    it('should handle health check errors', async () => {
      registry.register({
        name: 'error-health-service',
        factory: async () => ({ status: 'ok' }),
        healthCheck: async () => { throw new Error('Health check failed'); },
      });

      await registry.get('error-health-service');
      const health = await registry.getHealth();

      const service = health.services.find((s) => s.name === 'error-health-service');
      expect(service?.healthy).toBe(false);
      expect(service?.error).toBe('Health check failed');
    });

    it('should assume healthy if no health check defined', async () => {
      registry.register({
        name: 'no-health-check',
        factory: async () => ({ status: 'ok' }),
      });

      await registry.get('no-health-check');
      const health = await registry.getHealth();

      const service = health.services.find((s) => s.name === 'no-health-check');
      expect(service?.healthy).toBe(true);
    });
  });

  describe('getServiceNames', () => {
    it('should return list of registered service names', () => {
      registry.register({ name: 'service-1', factory: async () => ({}) });
      registry.register({ name: 'service-2', factory: async () => ({}) });
      registry.register({ name: 'service-3', factory: async () => ({}) });

      const names = registry.getServiceNames();

      expect(names).toHaveLength(3);
      expect(names).toContain('service-1');
      expect(names).toContain('service-2');
      expect(names).toContain('service-3');
    });
  });

  describe('getRegistration', () => {
    it('should return registration info without sensitive fields', () => {
      registry.register({
        name: 'info-service',
        factory: async () => ({}),
        cleanup: async () => {},
        healthCheck: async () => true,
        dependencies: ['dep-a', 'dep-b'],
        description: 'Test service',
      });

      const info = registry.getRegistration('info-service');

      expect(info).toBeDefined();
      expect(info?.name).toBe('info-service');
      expect(info?.dependencies).toEqual(['dep-a', 'dep-b']);
      expect(info?.description).toBe('Test service');
      // Factory and cleanup should not be exposed
      expect((info as any).factory).toBeUndefined();
      expect((info as any).cleanup).toBeUndefined();
      expect((info as any).healthCheck).toBeUndefined();
    });

    it('should return undefined for unregistered service', () => {
      expect(registry.getRegistration('nonexistent')).toBeUndefined();
    });
  });
});

describe('Global Registry', () => {
  afterEach(async () => {
    await resetServiceRegistry();
  });

  it('should provide singleton global registry', () => {
    const registry1 = getServiceRegistry();
    const registry2 = getServiceRegistry();

    expect(registry1).toBe(registry2);
  });

  it('should reset global registry', async () => {
    const registry = getServiceRegistry();
    registry.register({
      name: 'global-test',
      factory: async () => ({ value: 1 }),
    });

    await registry.get('global-test');
    expect(registry.isInitialized('global-test')).toBe(true);

    await resetServiceRegistry();

    // New registry should be created
    const newRegistry = getServiceRegistry();
    expect(newRegistry.has('global-test')).toBe(false);
  });

  it('should support convenience functions', async () => {
    registerService({
      name: 'convenience-test',
      factory: async () => ({ greeting: 'hello' }),
    });

    const instance = await getService<{ greeting: string }>('convenience-test');
    expect(instance.greeting).toBe('hello');
  });
});
