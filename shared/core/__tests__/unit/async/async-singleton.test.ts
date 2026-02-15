/**
 * AsyncSingleton Unit Tests
 *
 * Tests for createAsyncSingleton, createSingleton, and createConfigurableSingleton
 * utility functions that provide thread-safe singleton initialization patterns.
 *
 * @see shared/core/src/async/async-singleton.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  createAsyncSingleton,
  createSingleton,
  createConfigurableSingleton,
  singleton,
} from '../../../src/async/async-singleton';

// =============================================================================
// createAsyncSingleton
// =============================================================================

describe('createAsyncSingleton', () => {
  it('get() returns instance from factory', async () => {
    const instance = { value: 42 };
    const factory = jest.fn<() => Promise<{ value: number }>>().mockResolvedValue(instance);
    const singleton = createAsyncSingleton(factory);

    const result = await singleton.get();

    expect(result).toBe(instance);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('get() returns same instance on subsequent calls', async () => {
    let callCount = 0;
    const factory = jest.fn<() => Promise<{ id: number }>>().mockImplementation(async () => {
      callCount++;
      return { id: callCount };
    });
    const singleton = createAsyncSingleton(factory);

    const first = await singleton.get();
    const second = await singleton.get();

    expect(first).toBe(second);
    expect(first.id).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('concurrent get() calls share same factory promise (no duplicate initialization)', async () => {
    let resolveFactory: ((value: string) => void) | undefined;
    const factory = jest.fn<() => Promise<string>>().mockImplementation(
      () => new Promise<string>((resolve) => { resolveFactory = resolve; })
    );
    const singleton = createAsyncSingleton(factory);

    const p1 = singleton.get();
    const p2 = singleton.get();
    const p3 = singleton.get();

    resolveFactory!('shared-instance');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe('shared-instance');
    expect(r2).toBe('shared-instance');
    expect(r3).toBe('shared-instance');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('factory error clears promise, allows retry', async () => {
    let callCount = 0;
    const factory = jest.fn<() => Promise<string>>().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('init failed');
      }
      return 'success';
    });
    const singleton = createAsyncSingleton(factory);

    await expect(singleton.get()).rejects.toThrow('init failed');
    expect(singleton.isInitialized()).toBe(false);

    const result = await singleton.get();
    expect(result).toBe('success');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('reset() calls cleanup function', async () => {
    const instance = { connected: true };
    const factory = jest.fn<() => Promise<typeof instance>>().mockResolvedValue(instance);
    const cleanup = jest.fn<(inst: typeof instance) => Promise<void>>().mockResolvedValue(undefined);
    const singleton = createAsyncSingleton(factory, cleanup, 'test-singleton');

    await singleton.get();
    await singleton.reset();

    expect(cleanup).toHaveBeenCalledWith(instance);
  });

  it('reset() clears instance, next get() re-initializes', async () => {
    let callCount = 0;
    const factory = jest.fn<() => Promise<{ id: number }>>().mockImplementation(async () => {
      callCount++;
      return { id: callCount };
    });
    const cleanup = jest.fn<(inst: { id: number }) => Promise<void>>().mockResolvedValue(undefined);
    const singleton = createAsyncSingleton(factory, cleanup);

    const first = await singleton.get();
    expect(first.id).toBe(1);

    await singleton.reset();
    expect(singleton.isInitialized()).toBe(false);

    const second = await singleton.get();
    expect(second.id).toBe(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('isInitialized() returns false before get(), true after', async () => {
    const factory = jest.fn<() => Promise<string>>().mockResolvedValue('instance');
    const singleton = createAsyncSingleton(factory);

    expect(singleton.isInitialized()).toBe(false);

    await singleton.get();

    expect(singleton.isInitialized()).toBe(true);
  });

  it('works without cleanup function', async () => {
    const factory = jest.fn<() => Promise<string>>().mockResolvedValue('no-cleanup');
    const singleton = createAsyncSingleton(factory);

    await singleton.get();

    // reset should not throw even without cleanup
    await singleton.reset();
    expect(singleton.isInitialized()).toBe(false);
  });

  it('reset() before any get() does not throw', async () => {
    const factory = jest.fn<() => Promise<string>>().mockResolvedValue('x');
    const cleanup = jest.fn<(inst: string) => Promise<void>>().mockResolvedValue(undefined);
    const singleton = createAsyncSingleton(factory, cleanup);

    await singleton.reset();

    expect(cleanup).not.toHaveBeenCalled();
    expect(singleton.isInitialized()).toBe(false);
  });

  it('cleanup error does not throw from reset()', async () => {
    const factory = jest.fn<() => Promise<string>>().mockResolvedValue('instance');
    const cleanup = jest.fn<(inst: string) => Promise<void>>().mockRejectedValue(new Error('cleanup failed'));
    const singleton = createAsyncSingleton(factory, cleanup);

    await singleton.get();

    // Should not throw
    await singleton.reset();
    expect(singleton.isInitialized()).toBe(false);
  });
});

// =============================================================================
// createSingleton
// =============================================================================

describe('createSingleton', () => {
  it('get() returns instance from factory', () => {
    const instance = { value: 99 };
    const factory = jest.fn<() => typeof instance>().mockReturnValue(instance);
    const singleton = createSingleton(factory);

    const result = singleton.get();

    expect(result).toBe(instance);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('get() returns same instance on subsequent calls', () => {
    let callCount = 0;
    const factory = jest.fn<() => { id: number }>().mockImplementation(() => {
      callCount++;
      return { id: callCount };
    });
    const singleton = createSingleton(factory);

    const first = singleton.get();
    const second = singleton.get();

    expect(first).toBe(second);
    expect(first.id).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reset() calls cleanup function', () => {
    const instance = { resource: 'active' };
    const factory = jest.fn<() => typeof instance>().mockReturnValue(instance);
    const cleanup = jest.fn<(inst: typeof instance) => void>();
    const singleton = createSingleton(factory, cleanup, 'sync-singleton');

    singleton.get();
    singleton.reset();

    expect(cleanup).toHaveBeenCalledWith(instance);
  });

  it('reset() clears instance, next get() re-initializes', () => {
    let callCount = 0;
    const factory = jest.fn<() => { id: number }>().mockImplementation(() => {
      callCount++;
      return { id: callCount };
    });
    const cleanup = jest.fn<(inst: { id: number }) => void>();
    const singleton = createSingleton(factory, cleanup);

    const first = singleton.get();
    expect(first.id).toBe(1);

    singleton.reset();

    const second = singleton.get();
    expect(second.id).toBe(2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('isInitialized() returns false before get(), true after', () => {
    const factory = jest.fn<() => string>().mockReturnValue('instance');
    const singleton = createSingleton(factory);

    expect(singleton.isInitialized()).toBe(false);

    singleton.get();

    expect(singleton.isInitialized()).toBe(true);
  });

  it('cleanup error does not throw from reset()', () => {
    const factory = jest.fn<() => string>().mockReturnValue('instance');
    const cleanup = jest.fn<(inst: string) => void>().mockImplementation(() => {
      throw new Error('cleanup exploded');
    });
    const singleton = createSingleton(factory, cleanup);

    singleton.get();

    // Should not throw
    expect(() => singleton.reset()).not.toThrow();
    expect(singleton.isInitialized()).toBe(false);
  });

  it('reset() before any get() does not call cleanup', () => {
    const factory = jest.fn<() => string>().mockReturnValue('x');
    const cleanup = jest.fn<(inst: string) => void>();
    const singleton = createSingleton(factory, cleanup);

    singleton.reset();

    expect(cleanup).not.toHaveBeenCalled();
  });
});

// =============================================================================
// createConfigurableSingleton
// =============================================================================

describe('createConfigurableSingleton', () => {
  interface Config {
    windowSize: number;
  }

  interface Tracker {
    config: Config | undefined;
  }

  it('get(config) creates instance with config on first call', () => {
    const factory = jest.fn<(config?: Config) => Tracker>().mockImplementation(
      (config) => ({ config })
    );
    const singleton = createConfigurableSingleton<Tracker, Config>(factory);

    const result = singleton.get({ windowSize: 100 });

    expect(result.config).toEqual({ windowSize: 100 });
    expect(factory).toHaveBeenCalledWith({ windowSize: 100 });
  });

  it('get(differentConfig) returns same instance, ignores new config', () => {
    const factory = jest.fn<(config?: Config) => Tracker>().mockImplementation(
      (config) => ({ config })
    );
    const singleton = createConfigurableSingleton<Tracker, Config>(factory);

    const first = singleton.get({ windowSize: 100 });
    const second = singleton.get({ windowSize: 999 });

    expect(first).toBe(second);
    expect(first.config).toEqual({ windowSize: 100 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reset() then get(newConfig) creates with new config', () => {
    const factory = jest.fn<(config?: Config) => Tracker>().mockImplementation(
      (config) => ({ config })
    );
    const cleanup = jest.fn<(inst: Tracker) => void>();
    const singleton = createConfigurableSingleton<Tracker, Config>(factory, cleanup);

    const first = singleton.get({ windowSize: 100 });
    expect(first.config).toEqual({ windowSize: 100 });

    singleton.reset();

    const second = singleton.get({ windowSize: 200 });
    expect(second.config).toEqual({ windowSize: 200 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('isInitialized() returns correct state', () => {
    const factory = jest.fn<(config?: Config) => Tracker>().mockImplementation(
      (config) => ({ config })
    );
    const singleton = createConfigurableSingleton<Tracker, Config>(factory);

    expect(singleton.isInitialized()).toBe(false);

    singleton.get({ windowSize: 50 });
    expect(singleton.isInitialized()).toBe(true);

    singleton.reset();
    expect(singleton.isInitialized()).toBe(false);
  });

  it('cleanup error does not throw from reset()', () => {
    const factory = jest.fn<(config?: Config) => Tracker>().mockImplementation(
      (config) => ({ config })
    );
    const cleanup = jest.fn<(inst: Tracker) => void>().mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    const singleton = createConfigurableSingleton<Tracker, Config>(factory, cleanup);

    singleton.get({ windowSize: 10 });

    expect(() => singleton.reset()).not.toThrow();
    expect(singleton.isInitialized()).toBe(false);
  });

  it('get() without config passes undefined to factory', () => {
    const factory = jest.fn<(config?: Config) => Tracker>().mockImplementation(
      (config) => ({ config })
    );
    const singleton = createConfigurableSingleton<Tracker, Config>(factory);

    const result = singleton.get();

    expect(result.config).toBeUndefined();
    expect(factory).toHaveBeenCalledWith(undefined);
  });
});

// =============================================================================
// singleton() decorator — P1-FIX regression tests
// =============================================================================

describe('singleton() decorator', () => {
  it('returns cached promise on success', async () => {
    let callCount = 0;

    class TestService {
      @(singleton() as any)
      async init(): Promise<string> {
        callCount++;
        return 'initialized';
      }
    }

    const service = new TestService();
    const result1 = await service.init();
    const result2 = await service.init();

    expect(result1).toBe('initialized');
    expect(result2).toBe('initialized');
    expect(callCount).toBe(1);
  });

  it('clears cache on rejection, allows retry', async () => {
    let callCount = 0;

    class TestService {
      @(singleton() as any)
      async init(): Promise<string> {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient failure');
        }
        return 'success';
      }
    }

    const service = new TestService();

    // First call fails
    await expect(service.init()).rejects.toThrow('transient failure');
    expect(callCount).toBe(1);

    // Second call retries and succeeds (cache was cleared)
    const result = await service.init();
    expect(result).toBe('success');
    expect(callCount).toBe(2);
  });

  it('shares rejection with concurrent callers, then allows retry', async () => {
    let callCount = 0;

    class TestService {
      @(singleton() as any)
      async init(): Promise<string> {
        callCount++;
        if (callCount === 1) {
          throw new Error('fail');
        }
        return 'ok';
      }
    }

    const service = new TestService();

    // Three concurrent calls — all share the same rejected promise
    const p1 = service.init();
    const p2 = service.init();
    const p3 = service.init();

    await expect(p1).rejects.toThrow('fail');
    await expect(p2).rejects.toThrow('fail');
    await expect(p3).rejects.toThrow('fail');
    expect(callCount).toBe(1);

    // After rejection, cache is cleared — next call retries
    const result = await service.init();
    expect(result).toBe('ok');
    expect(callCount).toBe(2);
  });
});
