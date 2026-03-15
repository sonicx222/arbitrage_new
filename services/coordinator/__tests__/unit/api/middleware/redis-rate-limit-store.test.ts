/**
 * TQ-M-01: Unit tests for RedisRateLimitStore.
 *
 * Tests fail-closed behavior, atomic Lua INCR+PEXPIRE, lazy connection,
 * SCAN-based cleanup, shutdown, prefix isolation, and structured logging.
 *
 * @see services/coordinator/src/api/middleware/redis-rate-limit-store.ts
 * @see CLAUDE.md "Rate limiting fails CLOSED" pattern
 */

jest.mock('ioredis', () => {
  return {
    Redis: jest.fn(),
  };
});

import {
  RedisRateLimitStore,
  type RateLimitStoreLogger,
} from '../../../../src/api/middleware/redis-rate-limit-store';
import { Redis } from 'ioredis';

const MockRedisConstructor = Redis as unknown as jest.Mock;

function createMockRedisInstance() {
  return {
    get: jest.fn().mockResolvedValue(null),
    pttl: jest.fn().mockResolvedValue(-2),
    eval: jest.fn().mockResolvedValue(1),
    decr: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue(['0', []]),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    on: jest.fn(),
  };
}

function createMockLogger(): jest.Mocked<RateLimitStoreLogger> {
  return {
    warn: jest.fn(),
    debug: jest.fn(),
  };
}

describe('RedisRateLimitStore', () => {
  let store: RedisRateLimitStore;
  let mockRedis: ReturnType<typeof createMockRedisInstance>;
  let mockLogger: jest.Mocked<RateLimitStoreLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = createMockRedisInstance();
    MockRedisConstructor.mockReturnValue(mockRedis);
    mockLogger = createMockLogger();
    store = new RedisRateLimitStore('redis://localhost:6379', 'test:', mockLogger);
  });

  // ---------------------------------------------------------------------------
  // Constructor & static properties
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should set prefix and localKeys=false', () => {
      expect(store.prefix).toBe('test:');
      expect(store.localKeys).toBe(false);
    });

    it('should use default prefix "rl:" when not provided', () => {
      const s = new RedisRateLimitStore('redis://localhost:6379');
      expect(s.prefix).toBe('rl:');
    });

    it('should accept a custom prefix', () => {
      const s = new RedisRateLimitStore('redis://localhost:6379', 'api-limit:');
      expect(s.prefix).toBe('api-limit:');
    });

    it('should not create Redis client at construction (lazy connect)', () => {
      MockRedisConstructor.mockClear();
      const _s = new RedisRateLimitStore('redis://localhost:6379', 'rl:', mockLogger);
      expect(MockRedisConstructor).not.toHaveBeenCalled();
    });

    it('should use console.warn fallback when no logger is provided', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const noLoggerStore = new RedisRateLimitStore('redis://localhost:6379', 'rl:');
      mockRedis.get.mockRejectedValue(new Error('no-logger test'));

      await noLoggerStore.get('key');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[RedisRateLimitStore]'),
        expect.anything()
      );
      consoleSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // init()
  // ---------------------------------------------------------------------------

  describe('init', () => {
    it('should store windowMs from options', async () => {
      store.init({ windowMs: 30_000 });
      mockRedis.pttl.mockResolvedValue(30_000);

      await store.increment('test-key');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'test:test-key', '30000'
      );
    });

    it('should use default 60000ms windowMs when init is not called', async () => {
      mockRedis.pttl.mockResolvedValue(60_000);

      await store.increment('test-key');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'test:test-key', '60000'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Lazy connection (getRedis)
  // ---------------------------------------------------------------------------

  describe('lazy connection', () => {
    it('should create Redis client on first use via get()', async () => {
      MockRedisConstructor.mockClear();

      await store.get('some-key');

      expect(MockRedisConstructor).toHaveBeenCalledTimes(1);
      expect(MockRedisConstructor).toHaveBeenCalledWith('redis://localhost:6379', {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
        connectTimeout: 3000,
      });
    });

    it('should create Redis client on first use via increment()', async () => {
      MockRedisConstructor.mockClear();

      await store.increment('some-key');

      expect(MockRedisConstructor).toHaveBeenCalledTimes(1);
    });

    it('should reuse the same Redis client on subsequent calls', async () => {
      MockRedisConstructor.mockClear();

      await store.get('key1');
      await store.get('key2');
      await store.increment('key3');
      await store.decrement('key4');

      expect(MockRedisConstructor).toHaveBeenCalledTimes(1);
    });

    it('should register error and ready listeners on the Redis client', async () => {
      await store.increment('init');

      expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockRedis.on).toHaveBeenCalledWith('ready', expect.any(Function));
    });

    it('should log Redis connection errors via the structured logger', async () => {
      await store.increment('init');

      // Find the 'error' event handler registered on the mock
      const errorHandler = mockRedis.on.mock.calls.find(
        (call: [string, unknown]) => call[0] === 'error'
      )?.[1] as (err: Error) => void;
      expect(errorHandler).toBeDefined();

      errorHandler(new Error('ECONNREFUSED'));

      expect(mockLogger.warn).toHaveBeenCalledWith('Redis connection error', {
        error: 'ECONNREFUSED',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // get()
  // ---------------------------------------------------------------------------

  describe('get()', () => {
    it('should return undefined when key does not exist in Redis', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await store.get('missing-key');

      expect(result).toBeUndefined();
      expect(mockRedis.get).toHaveBeenCalledWith('test:missing-key');
    });

    it('should return totalHits and resetTime when key exists', async () => {
      mockRedis.get.mockResolvedValue('5');
      mockRedis.pttl.mockResolvedValue(30_000);

      const before = Date.now();
      const result = await store.get('existing-key');

      expect(result).toBeDefined();
      expect(result!.totalHits).toBe(5);
      expect(result!.resetTime).toBeInstanceOf(Date);
      // resetTime should be approximately now + pttl
      expect(result!.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 30_000 - 50);
      expect(result!.resetTime!.getTime()).toBeLessThanOrEqual(Date.now() + 30_000 + 50);
    });

    it('should return undefined resetTime when pttl is negative (no expiry)', async () => {
      mockRedis.get.mockResolvedValue('3');
      mockRedis.pttl.mockResolvedValue(-1);

      const result = await store.get('no-ttl-key');

      expect(result).toBeDefined();
      expect(result!.totalHits).toBe(3);
      expect(result!.resetTime).toBeUndefined();
    });

    it('should use prefix for Redis key lookups', async () => {
      await store.get('my-key');

      expect(mockRedis.get).toHaveBeenCalledWith('test:my-key');
      expect(mockRedis.pttl).toHaveBeenCalledWith('test:my-key');
    });

    it('should return undefined and log when Redis throws', async () => {
      mockRedis.get.mockRejectedValue(new Error('READONLY'));

      const result = await store.get('error-key');

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('get failed', { error: 'READONLY' });
    });

    it('should parse hits string as base-10 integer', async () => {
      mockRedis.get.mockResolvedValue('042'); // leading zero
      mockRedis.pttl.mockResolvedValue(10_000);

      const result = await store.get('octal-trap');

      expect(result!.totalHits).toBe(42); // not 34 (octal)
    });
  });

  // ---------------------------------------------------------------------------
  // increment() — fail-closed + atomic Lua
  // ---------------------------------------------------------------------------

  describe('increment()', () => {
    it('should use atomic Lua script containing INCR and PEXPIRE', async () => {
      mockRedis.eval.mockResolvedValue(1);
      mockRedis.pttl.mockResolvedValue(60_000);

      await store.increment('test-key');

      const luaScript = mockRedis.eval.mock.calls[0][0] as string;
      expect(luaScript).toContain("redis.call('INCR'");
      expect(luaScript).toContain("redis.call('PEXPIRE'");
      // Conditional: only PEXPIRE on first hit
      expect(luaScript).toContain('if c == 1 then');
      expect(luaScript).toContain('return c');
    });

    it('should return totalHits from Lua eval result', async () => {
      mockRedis.eval.mockResolvedValue(7);
      mockRedis.pttl.mockResolvedValue(45_000);

      const result = await store.increment('counting-key');

      expect(result.totalHits).toBe(7);
      expect(result.resetTime).toBeInstanceOf(Date);
    });

    it('should use pttl-based resetTime when pttl is positive', async () => {
      mockRedis.eval.mockResolvedValue(1);
      mockRedis.pttl.mockResolvedValue(25_000);

      const before = Date.now();
      const result = await store.increment('key');

      expect(result.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 25_000 - 50);
    });

    it('should use windowMs as fallback resetTime when pttl is non-positive', async () => {
      mockRedis.eval.mockResolvedValue(1);
      mockRedis.pttl.mockResolvedValue(-1);

      const before = Date.now();
      const result = await store.increment('no-ttl');

      // Default windowMs is 60_000
      expect(result.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 50);
    });

    it('should fail CLOSED when Redis throws — totalHits = Infinity', async () => {
      mockRedis.eval.mockRejectedValue(new Error('CLUSTERDOWN'));

      const result = await store.increment('fail-key');

      expect(result.totalHits).toBe(Infinity);
      expect(result.resetTime).toBeInstanceOf(Date);
    });

    it('should fail CLOSED when Redis connection is refused', async () => {
      mockRedis.eval.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await store.increment('refused-key');

      expect(result.totalHits).toBe(Infinity);
    });

    it('should use prefix in the Lua script key argument', async () => {
      const prefixedStore = new RedisRateLimitStore('redis://localhost:6379', 'api:', mockLogger);
      mockRedis.eval.mockResolvedValue(1);
      mockRedis.pttl.mockResolvedValue(60_000);

      await prefixedStore.increment('endpoint');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'api:endpoint', '60000'
      );
    });

    it('should pass windowMs as string to Lua ARGV[1]', async () => {
      store.init({ windowMs: 120_000 });
      mockRedis.eval.mockResolvedValue(1);
      mockRedis.pttl.mockResolvedValue(120_000);

      await store.increment('key');

      // Fourth argument is the windowMs as string
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'test:key', '120000'
      );
    });

    it('should call pttl after eval to get remaining TTL', async () => {
      // Track call order via side effects
      const callOrder: string[] = [];
      mockRedis.eval.mockImplementation(async () => {
        callOrder.push('eval');
        return 3;
      });
      mockRedis.pttl.mockImplementation(async () => {
        callOrder.push('pttl');
        return 58_000;
      });

      await store.increment('order-test');

      expect(callOrder[0]).toBe('eval');
      expect(callOrder).toContain('pttl');
      expect(mockRedis.pttl).toHaveBeenCalledWith('test:order-test');
    });
  });

  // ---------------------------------------------------------------------------
  // decrement()
  // ---------------------------------------------------------------------------

  describe('decrement()', () => {
    it('should call Redis DECR with prefixed key', async () => {
      await store.decrement('my-key');

      expect(mockRedis.decr).toHaveBeenCalledWith('test:my-key');
    });

    it('should not throw when Redis throws (best effort)', async () => {
      mockRedis.decr.mockRejectedValue(new Error('READONLY'));

      await expect(store.decrement('readonly-key')).resolves.toBeUndefined();
    });

    it('should log a warning when Redis throws', async () => {
      mockRedis.decr.mockRejectedValue(new Error('Network error'));

      await store.decrement('fail-key');

      expect(mockLogger.warn).toHaveBeenCalledWith('decrement failed', {
        error: 'Network error',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // resetKey()
  // ---------------------------------------------------------------------------

  describe('resetKey()', () => {
    it('should call Redis DEL with prefixed key', async () => {
      await store.resetKey('old-key');

      expect(mockRedis.del).toHaveBeenCalledWith('test:old-key');
    });

    it('should not throw when Redis throws (best effort)', async () => {
      mockRedis.del.mockRejectedValue(new Error('NOPERM'));

      await expect(store.resetKey('perm-key')).resolves.toBeUndefined();
    });

    it('should log a warning when Redis throws', async () => {
      mockRedis.del.mockRejectedValue(new Error('Timeout'));

      await store.resetKey('fail-key');

      expect(mockLogger.warn).toHaveBeenCalledWith('resetKey failed', { error: 'Timeout' });
    });
  });

  // ---------------------------------------------------------------------------
  // resetAll() — SCAN-based
  // ---------------------------------------------------------------------------

  describe('resetAll()', () => {
    it('should use SCAN (never KEYS) to find rate limit keys', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);

      await store.resetAll();

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'test:*', 'COUNT', 100);
    });

    it('should delete found keys', async () => {
      mockRedis.scan.mockResolvedValue(['0', ['test:key1', 'test:key2', 'test:key3']]);

      await store.resetAll();

      expect(mockRedis.del).toHaveBeenCalledWith('test:key1', 'test:key2', 'test:key3');
    });

    it('should not call DEL when no keys are found', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);

      await store.resetAll();

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should handle multiple SCAN pages (cursor iteration)', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['42', ['test:page1-a', 'test:page1-b']])
        .mockResolvedValueOnce(['0', ['test:page2-a']]);

      await store.resetAll();

      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      expect(mockRedis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'test:*', 'COUNT', 100);
      expect(mockRedis.scan).toHaveBeenNthCalledWith(2, '42', 'MATCH', 'test:*', 'COUNT', 100);

      expect(mockRedis.del).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenNthCalledWith(1, 'test:page1-a', 'test:page1-b');
      expect(mockRedis.del).toHaveBeenNthCalledWith(2, 'test:page2-a');
    });

    it('should handle pages with mixed empty and non-empty results', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['10', []])                 // empty page
        .mockResolvedValueOnce(['20', ['test:found']])     // page with keys
        .mockResolvedValueOnce(['0', []]);                 // final empty page

      await store.resetAll();

      expect(mockRedis.scan).toHaveBeenCalledTimes(3);
      // DEL called only for the page that had keys
      expect(mockRedis.del).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).toHaveBeenCalledWith('test:found');
    });

    it('should use the store prefix in SCAN MATCH pattern', async () => {
      const customStore = new RedisRateLimitStore('redis://localhost:6379', 'api-limit:', mockLogger);
      mockRedis.scan.mockResolvedValue(['0', []]);

      await customStore.resetAll();

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'api-limit:*', 'COUNT', 100);
    });

    it('should log a warning and not throw when Redis throws', async () => {
      mockRedis.scan.mockRejectedValue(new Error('CLUSTERDOWN'));

      await expect(store.resetAll()).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('resetAll failed', { error: 'CLUSTERDOWN' });
    });
  });

  // ---------------------------------------------------------------------------
  // shutdown()
  // ---------------------------------------------------------------------------

  describe('shutdown()', () => {
    it('should be a no-op when Redis client was never created', async () => {
      await expect(store.shutdown()).resolves.toBeUndefined();

      expect(mockRedis.quit).not.toHaveBeenCalled();
      expect(mockRedis.disconnect).not.toHaveBeenCalled();
    });

    it('should call quit() on the Redis client', async () => {
      // Force Redis client creation
      await store.increment('init');

      await store.shutdown();

      expect(mockRedis.quit).toHaveBeenCalledTimes(1);
    });

    it('should not call disconnect() when quit() succeeds', async () => {
      mockRedis.quit.mockResolvedValue('OK');
      await store.increment('init');

      await store.shutdown();

      expect(mockRedis.disconnect).not.toHaveBeenCalled();
    });

    it('should fall back to disconnect() when quit() throws', async () => {
      await store.increment('init');
      mockRedis.quit.mockRejectedValue(new Error('ERR Client is closed'));

      await store.shutdown();

      expect(mockRedis.quit).toHaveBeenCalled();
      expect(mockRedis.disconnect).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('quit failed, forcing disconnect', {
        error: 'ERR Client is closed',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Prefix isolation
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Circuit breaker (P1-5 FIX: previously untested)
  // ---------------------------------------------------------------------------

  describe('circuit breaker', () => {
    it('should stay closed when failures are below threshold', async () => {
      // 4 failures (threshold is 5)
      for (let i = 0; i < 4; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await store.increment('key');
      }

      // 5th call should still attempt Redis (circuit not yet open)
      mockRedis.eval.mockResolvedValueOnce(1);
      mockRedis.pttl.mockResolvedValueOnce(60_000);
      const result = await store.increment('key');

      expect(result.totalHits).toBe(1);
    });

    it('should open after 5 consecutive failures', async () => {
      // Trigger 5 failures to open circuit
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await store.increment('key');
      }

      // 6th call should short-circuit without touching Redis
      mockRedis.eval.mockClear();
      const result = await store.increment('key');

      expect(result.totalHits).toBe(Infinity);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('should return Infinity from increment() when circuit is open', async () => {
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      const result = await store.increment('blocked');
      expect(result.totalHits).toBe(Infinity);
      expect(result.resetTime).toBeInstanceOf(Date);
    });

    it('should return fail-closed from get() when circuit is open', async () => {
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      mockRedis.get.mockClear();
      const result = await store.get('blocked');
      expect(result).toBeDefined();
      expect(result!.totalHits).toBe(Infinity);
      expect(result!.resetTime).toBeInstanceOf(Date);
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should skip Redis on decrement() when circuit is open', async () => {
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      mockRedis.decr.mockClear();
      await store.decrement('key');
      expect(mockRedis.decr).not.toHaveBeenCalled();
    });

    it('should skip Redis on resetKey() when circuit is open', async () => {
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      mockRedis.del.mockClear();
      await store.resetKey('key');
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should skip Redis on resetAll() when circuit is open', async () => {
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      mockRedis.scan.mockClear();
      await store.resetAll();
      expect(mockRedis.scan).not.toHaveBeenCalled();
    });

    it('should allow a half-open probe after cooldown expires', async () => {
      // Open circuit
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      // Advance time past cooldown (10s)
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);

      // Next call should attempt Redis (half-open probe)
      mockRedis.eval.mockResolvedValueOnce(1);
      mockRedis.pttl.mockResolvedValueOnce(60_000);
      const result = await store.increment('probe');

      expect(result.totalHits).toBe(1);
      expect(mockRedis.eval).toHaveBeenCalled();

      jest.restoreAllMocks();
    });

    it('should close circuit after successful probe', async () => {
      const realNow = Date.now();

      // Open circuit
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      // Advance time past cooldown
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 11_000);

      // Successful probe
      mockRedis.eval.mockResolvedValueOnce(1);
      mockRedis.pttl.mockResolvedValueOnce(60_000);
      await store.increment('probe');

      // Restore time
      nowSpy.mockReturnValue(realNow + 11_100);

      // Subsequent call should also succeed (circuit is now closed)
      mockRedis.eval.mockResolvedValueOnce(2);
      mockRedis.pttl.mockResolvedValueOnce(59_000);
      const result = await store.increment('normal');

      expect(result.totalHits).toBe(2);

      nowSpy.mockRestore();
    });

    it('should log warning when circuit opens', async () => {
      for (let i = 0; i < 5; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Circuit breaker OPEN — short-circuiting to fail-closed',
        expect.objectContaining({
          failures: 5,
          cooldownMs: 10_000,
        })
      );
    });

    it('should reset failure count on successful operation', async () => {
      // 4 failures (just below threshold)
      for (let i = 0; i < 4; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      // Successful operation resets counter
      mockRedis.eval.mockResolvedValueOnce(1);
      mockRedis.pttl.mockResolvedValueOnce(60_000);
      await store.increment('key');

      // 4 more failures should NOT open circuit (counter was reset)
      for (let i = 0; i < 4; i++) {
        mockRedis.eval.mockRejectedValueOnce(new Error('down'));
        await store.increment('key');
      }

      // Should still attempt Redis (only 4 failures since reset)
      mockRedis.eval.mockResolvedValueOnce(5);
      mockRedis.pttl.mockResolvedValueOnce(60_000);
      const result = await store.increment('key');
      expect(result.totalHits).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Prefix isolation
  // ---------------------------------------------------------------------------

  describe('prefix isolation', () => {
    it('should prepend prefix to all key operations', async () => {
      const key = '192.168.1.1';
      mockRedis.get.mockResolvedValue('2');
      mockRedis.pttl.mockResolvedValue(50_000);
      mockRedis.eval.mockResolvedValue(3);

      await store.get(key);
      await store.increment(key);
      await store.decrement(key);
      await store.resetKey(key);

      expect(mockRedis.get).toHaveBeenCalledWith('test:192.168.1.1');
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String), 1, 'test:192.168.1.1', expect.any(String)
      );
      expect(mockRedis.decr).toHaveBeenCalledWith('test:192.168.1.1');
      expect(mockRedis.del).toHaveBeenCalledWith('test:192.168.1.1');
    });

    it('should isolate keys between stores with different prefixes', async () => {
      const storeA = new RedisRateLimitStore('redis://localhost:6379', 'api:', mockLogger);
      const storeB = new RedisRateLimitStore('redis://localhost:6379', 'sse:', mockLogger);
      mockRedis.eval.mockResolvedValue(1);
      mockRedis.pttl.mockResolvedValue(60_000);

      await storeA.increment('client-1');
      await storeB.increment('client-1');

      const calls = mockRedis.eval.mock.calls;
      expect(calls[0][2]).toBe('api:client-1');
      expect(calls[1][2]).toBe('sse:client-1');
    });
  });
});
