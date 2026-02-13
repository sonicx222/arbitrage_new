/**
 * Cache Strategies Tests
 *
 * Tests for the registration strategy implementations:
 * - MainThreadStrategy: Fast-path registration without CAS loop
 * - WorkerThreadStrategy: Thread-safe registration with CAS loop
 * - RegistryStrategyFactory: Strategy creation based on thread context
 *
 * @see shared/core/src/caching/strategies/implementations/main-thread-strategy.ts
 * @see shared/core/src/caching/strategies/implementations/worker-thread-strategy.ts
 * @see shared/core/src/caching/strategies/implementations/registry-strategy-factory.ts
 */

import { MainThreadStrategy } from '../../../src/caching/strategies/implementations/main-thread-strategy';
import { WorkerThreadStrategy } from '../../../src/caching/strategies/implementations/worker-thread-strategy';
import { RegistryStrategyFactory } from '../../../src/caching/strategies/implementations/registry-strategy-factory';
import {
  RegistryFullError,
  InvalidKeyError,
} from '../../../src/caching/strategies/registration-strategy.interface';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a SharedArrayBuffer sized for the given number of keys.
 *
 * Memory layout:
 * - [0-3]: Entry count (Int32, 4 bytes header)
 * - [4+]: Slots (64 bytes each: 60 bytes key + 4 bytes index)
 */
function createSharedBuffer(maxKeys: number): SharedArrayBuffer {
  const headerSize = 4;
  const slotSize = 64;
  return new SharedArrayBuffer(headerSize + maxKeys * slotSize);
}

// =============================================================================
// MainThreadStrategy
// =============================================================================

describe('MainThreadStrategy', () => {
  let buffer: SharedArrayBuffer;

  beforeEach(() => {
    buffer = createSharedBuffer(10);
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance with shared buffer and max keys', () => {
      const strategy = new MainThreadStrategy(buffer, 10);
      expect(strategy).toBeDefined();
    });

    it('should start with zero keys registered', () => {
      const strategy = new MainThreadStrategy(buffer, 10);
      const stats = strategy.getStats();
      expect(stats.keyCount).toBe(0);
      expect(stats.maxCapacity).toBe(10);
      expect(stats.utilizationPercent).toBe(0);
    });
  });

  // =========================================================================
  // register
  // =========================================================================

  describe('register', () => {
    it('should register a new key and return index 0 for the first key', () => {
      const strategy = new MainThreadStrategy(buffer, 10);

      const result = strategy.register('price:bsc:0xABC');
      expect(result.index).toBe(0);
      expect(result.isNew).toBe(true);
      expect(result.iterations).toBe(0);
    });

    it('should assign incrementing indices for successive keys', () => {
      const strategy = new MainThreadStrategy(buffer, 10);

      const r1 = strategy.register('key1');
      const r2 = strategy.register('key2');
      const r3 = strategy.register('key3');

      expect(r1.index).toBe(0);
      expect(r2.index).toBe(1);
      expect(r3.index).toBe(2);
    });

    it('should return existing index for duplicate key', () => {
      const strategy = new MainThreadStrategy(buffer, 10);

      const first = strategy.register('price:eth:0xDEF');
      const second = strategy.register('price:eth:0xDEF');

      expect(second.index).toBe(first.index);
      expect(second.isNew).toBe(false);
      expect(second.iterations).toBe(0);
    });

    it('should throw RegistryFullError when capacity is reached', () => {
      const smallBuffer = createSharedBuffer(2);
      const strategy = new MainThreadStrategy(smallBuffer, 2);

      strategy.register('key1');
      strategy.register('key2');

      expect(() => strategy.register('key3')).toThrow(RegistryFullError);
    });

    it('should throw InvalidKeyError when key exceeds max size', () => {
      const strategy = new MainThreadStrategy(buffer, 10);

      // 60 bytes max key size; create a key larger than that
      const longKey = 'x'.repeat(61);
      expect(() => strategy.register(longKey)).toThrow(InvalidKeyError);
    });
  });

  // =========================================================================
  // lookup
  // =========================================================================

  describe('lookup', () => {
    it('should return index for a registered key', () => {
      const strategy = new MainThreadStrategy(buffer, 10);
      strategy.register('price:bsc:0x123');

      expect(strategy.lookup('price:bsc:0x123')).toBe(0);
    });

    it('should return undefined for an unregistered key', () => {
      const strategy = new MainThreadStrategy(buffer, 10);

      expect(strategy.lookup('nonexistent')).toBeUndefined();
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    it('should return correct stats after multiple registrations', () => {
      const strategy = new MainThreadStrategy(buffer, 10);
      strategy.register('key1');
      strategy.register('key2');
      strategy.register('key3');

      const stats = strategy.getStats();
      expect(stats.keyCount).toBe(3);
      expect(stats.maxCapacity).toBe(10);
      expect(stats.utilizationPercent).toBe(30);
      expect(stats.avgCasIterations).toBe(0);
      expect(stats.failedRegistrations).toBe(0);
      expect(stats.threadMode).toBe('main');
    });

    it('should track failed registrations', () => {
      const smallBuffer = createSharedBuffer(1);
      const strategy = new MainThreadStrategy(smallBuffer, 1);
      strategy.register('key1');

      try { strategy.register('key2'); } catch { /* expected */ }

      const stats = strategy.getStats();
      expect(stats.failedRegistrations).toBe(1);
    });
  });
});

// =============================================================================
// WorkerThreadStrategy
// =============================================================================

describe('WorkerThreadStrategy', () => {
  let buffer: SharedArrayBuffer;

  beforeEach(() => {
    buffer = createSharedBuffer(10);
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance with shared buffer and max keys', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);
      expect(strategy).toBeDefined();
    });

    it('should start with zero keys registered', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);
      const stats = strategy.getStats();
      expect(stats.keyCount).toBe(0);
      expect(stats.threadMode).toBe('worker');
    });
  });

  // =========================================================================
  // register
  // =========================================================================

  describe('register', () => {
    it('should register a new key and return index 0 for the first key', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);

      const result = strategy.register('price:bsc:0xABC');
      expect(result.index).toBe(0);
      expect(result.isNew).toBe(true);
      expect(result.iterations).toBeGreaterThanOrEqual(1);
    });

    it('should return existing index for duplicate key', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);

      const first = strategy.register('key-dup');
      const second = strategy.register('key-dup');

      expect(second.index).toBe(first.index);
      expect(second.isNew).toBe(false);
    });

    it('should throw RegistryFullError when capacity is reached', () => {
      const smallBuffer = createSharedBuffer(2);
      const strategy = new WorkerThreadStrategy(smallBuffer, 2);

      strategy.register('k1');
      strategy.register('k2');

      expect(() => strategy.register('k3')).toThrow(RegistryFullError);
    });

    it('should throw InvalidKeyError when key exceeds max size', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);

      const longKey = 'y'.repeat(61);
      expect(() => strategy.register(longKey)).toThrow(InvalidKeyError);
    });
  });

  // =========================================================================
  // lookup
  // =========================================================================

  describe('lookup', () => {
    it('should return index for a registered key via linear scan', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);
      strategy.register('scanned-key');

      expect(strategy.lookup('scanned-key')).toBe(0);
    });

    it('should return undefined for an unregistered key', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);
      expect(strategy.lookup('nope')).toBeUndefined();
    });

    it('should return undefined when registry is empty', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);
      expect(strategy.lookup('anything')).toBeUndefined();
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe('getStats', () => {
    it('should return correct stats with CAS iteration tracking', () => {
      const strategy = new WorkerThreadStrategy(buffer, 10);
      strategy.register('a');
      strategy.register('b');

      const stats = strategy.getStats();
      expect(stats.keyCount).toBe(2);
      expect(stats.maxCapacity).toBe(10);
      expect(stats.utilizationPercent).toBe(20);
      expect(stats.avgCasIterations).toBeGreaterThanOrEqual(1);
      expect(stats.failedRegistrations).toBe(0);
      expect(stats.threadMode).toBe('worker');
    });
  });
});

// =============================================================================
// RegistryStrategyFactory
// =============================================================================

describe('RegistryStrategyFactory', () => {
  let buffer: SharedArrayBuffer;

  beforeEach(() => {
    buffer = createSharedBuffer(10);
  });

  describe('create', () => {
    it('should create MainThreadStrategy when forceStrategy is main', () => {
      const strategy = RegistryStrategyFactory.create({
        sharedBuffer: buffer,
        maxKeys: 10,
        forceStrategy: 'main',
      });

      const stats = strategy.getStats();
      expect(stats.threadMode).toBe('main');
    });

    it('should create WorkerThreadStrategy when forceStrategy is worker', () => {
      const strategy = RegistryStrategyFactory.create({
        sharedBuffer: buffer,
        maxKeys: 10,
        forceStrategy: 'worker',
      });

      const stats = strategy.getStats();
      expect(stats.threadMode).toBe('worker');
    });

    it('should auto-detect main thread when no forceStrategy is provided', () => {
      // Running in main thread (Jest), should create main thread strategy
      const strategy = RegistryStrategyFactory.create({
        sharedBuffer: buffer,
        maxKeys: 10,
      });

      // In test environment, isMainThread is true
      const stats = strategy.getStats();
      expect(stats.threadMode).toBe('main');
    });
  });

  describe('createMainThreadStrategy', () => {
    it('should create a MainThreadStrategy explicitly', () => {
      const strategy = RegistryStrategyFactory.createMainThreadStrategy(buffer, 10);

      const stats = strategy.getStats();
      expect(stats.threadMode).toBe('main');
    });
  });

  describe('createWorkerThreadStrategy', () => {
    it('should create a WorkerThreadStrategy explicitly', () => {
      const strategy = RegistryStrategyFactory.createWorkerThreadStrategy(buffer, 10);

      const stats = strategy.getStats();
      expect(stats.threadMode).toBe('worker');
    });
  });

  describe('detectThreadMode', () => {
    it('should return main when running in main thread', () => {
      // Jest runs in main thread
      expect(RegistryStrategyFactory.detectThreadMode()).toBe('main');
    });
  });
});
