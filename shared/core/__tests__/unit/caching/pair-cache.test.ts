/**
 * Tests for PairCacheService
 *
 * Validates Redis-based pair address caching with TTL, token sorting,
 * null markers, batch operations, and chain/dex invalidation.
 *
 * @see shared/core/src/caching/pair-cache.ts
 * @see ADR-002: Redis Streams
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import {
  PairCacheService,
  PairCacheServiceDeps,
  CachedPairData,
} from '../../../src/caching/pair-cache';

// =============================================================================
// Mock Setup
// =============================================================================

interface MockRedis {
  get: Mock<(...args: any[]) => Promise<any>>;
  set: Mock<(...args: any[]) => Promise<void>>;
  del: Mock<(...args: any[]) => Promise<number>>;
  scan: Mock<(...args: any[]) => Promise<[string, string[]]>>;
}

function createMockRedis(): MockRedis {
  return {
    get: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null),
    set: jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
    del: jest.fn<(...args: any[]) => Promise<number>>().mockResolvedValue(1),
    scan: jest.fn<(...args: any[]) => Promise<[string, string[]]>>().mockResolvedValue(['0', []]),
  };
}

function createSamplePairData(overrides: Partial<CachedPairData> = {}): CachedPairData {
  return {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    token0: '0xaaaa000000000000000000000000000000000001',
    token1: '0xbbbb000000000000000000000000000000000002',
    dex: 'pancakeswap',
    chain: 'bsc',
    factoryAddress: '0xfactory0000000000000000000000000000000000',
    fee: 3000,
    discoveredAt: Date.now() - 60000,
    lastVerified: Date.now(),
    discoveryMethod: 'factory_query',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PairCacheService', () => {
  let service: PairCacheService;
  let mockRedis: MockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();

    const deps: PairCacheServiceDeps = {
      getRedisClient: jest.fn<() => Promise<any>>().mockResolvedValue(mockRedis),
    };

    service = new PairCacheService(
      { keyPrefix: 'pair:', pairAddressTtlSec: 86400, nullResultTtlSec: 3600, maxBatchSize: 10 },
      deps,
    );
  });

  afterEach(() => {
    service.removeAllListeners();
  });

  // =========================================================================
  // Initialization
  // =========================================================================

  describe('initialize / isInitialized', () => {
    it('should not be initialized before calling initialize()', () => {
      expect(service.isInitialized()).toBe(false);
    });

    it('should be initialized after calling initialize()', async () => {
      await service.initialize();
      expect(service.isInitialized()).toBe(true);
    });

    it('should be idempotent -- calling initialize() twice does nothing', async () => {
      await service.initialize();
      await service.initialize(); // second call should be no-op
      expect(service.isInitialized()).toBe(true);
    });

    it('should throw when Redis connection fails', async () => {
      const failingDeps: PairCacheServiceDeps = {
        getRedisClient: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('Connection refused')),
      };
      const failService = new PairCacheService({}, failingDeps);

      await expect(failService.initialize()).rejects.toThrow('Connection refused');
      expect(failService.isInitialized()).toBe(false);
    });
  });

  // =========================================================================
  // Cache Key Generation
  // =========================================================================

  describe('generateCacheKey', () => {
    it('should sort token addresses alphabetically to produce deterministic key', () => {
      const tokenA = '0xBBBB000000000000000000000000000000000002';
      const tokenB = '0xAAAA000000000000000000000000000000000001';

      const key1 = service.generateCacheKey('bsc', 'pancakeswap', tokenA, tokenB);
      const key2 = service.generateCacheKey('bsc', 'pancakeswap', tokenB, tokenA);

      expect(key1).toBe(key2);
    });

    it('should include chain, dex, and lowercased tokens in key', () => {
      const key = service.generateCacheKey(
        'bsc',
        'pancakeswap',
        '0xAAAA000000000000000000000000000000000001',
        '0xBBBB000000000000000000000000000000000002',
      );

      expect(key).toContain('pair:');
      expect(key).toContain('bsc');
      expect(key).toContain('pancakeswap');
      expect(key).toContain('0xaaaa');
      expect(key).toContain('0xbbbb');
    });

    it('should produce different keys for different chains', () => {
      const tokenA = '0xAAAA000000000000000000000000000000000001';
      const tokenB = '0xBBBB000000000000000000000000000000000002';

      const bscKey = service.generateCacheKey('bsc', 'pancakeswap', tokenA, tokenB);
      const ethKey = service.generateCacheKey('ethereum', 'pancakeswap', tokenA, tokenB);

      expect(bscKey).not.toBe(ethKey);
    });
  });

  // =========================================================================
  // generatePatternKey
  // =========================================================================

  describe('generatePatternKey', () => {
    it('should generate chain-only pattern when dex is omitted', () => {
      const pattern = service.generatePatternKey('bsc');
      expect(pattern).toBe('pair:bsc:*');
    });

    it('should generate chain+dex pattern when dex is provided', () => {
      const pattern = service.generatePatternKey('bsc', 'pancakeswap');
      expect(pattern).toBe('pair:bsc:pancakeswap:*');
    });
  });

  // =========================================================================
  // get()
  // =========================================================================

  describe('get', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should return cache hit for stored pair data', async () => {
      const pairData = createSamplePairData();
      mockRedis.get.mockResolvedValueOnce(pairData);

      const result = await service.get('bsc', 'pancakeswap', pairData.token0, pairData.token1);

      expect(result.status).toBe('hit');
      if (result.status === 'hit') {
        expect(result.data.address).toBe(pairData.address);
      }
    });

    it('should return cache miss when key not found', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await service.get('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(result.status).toBe('miss');
    });

    it('should return null status for NULL_PAIR marker', async () => {
      mockRedis.get.mockResolvedValueOnce('NULL_PAIR');

      const result = await service.get('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(result.status).toBe('null');
      if (result.status === 'null') {
        expect(result.reason).toBe('pair_not_exists');
      }
    });

    it('should return null status for zero address marker', async () => {
      mockRedis.get.mockResolvedValueOnce('0x0000000000000000000000000000000000000000');

      const result = await service.get('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(result.status).toBe('null');
    });

    it('should return miss and increment errors when not initialized', async () => {
      const uninitService = new PairCacheService();
      const result = await uninitService.get('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');

      expect(result.status).toBe('miss');
      expect(uninitService.getStats().errors).toBe(1);
    });

    it('should return miss on Redis error', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Redis timeout'));

      const result = await service.get('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(result.status).toBe('miss');

      const stats = service.getStats();
      expect(stats.errors).toBe(1);
    });

    it('should treat unexpected string value as miss', async () => {
      mockRedis.get.mockResolvedValueOnce('unexpected_string');

      const result = await service.get('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(result.status).toBe('miss');
    });

    it('should increment totalLookups on every get', async () => {
      mockRedis.get.mockResolvedValue(null);

      await service.get('bsc', 'pancakeswap', '0xt0', '0xt1');
      await service.get('bsc', 'pancakeswap', '0xt2', '0xt3');

      expect(service.getStats().totalLookups).toBe(2);
    });
  });

  // =========================================================================
  // set()
  // =========================================================================

  describe('set', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should store pair data with default TTL', async () => {
      const pairData = createSamplePairData();

      const ok = await service.set('bsc', 'pancakeswap', pairData.token0, pairData.token1, pairData);

      expect(ok).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      // Verify TTL arg is the configured default (86400)
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        pairData,
        86400,
      );
    });

    it('should store pair data with custom TTL', async () => {
      const pairData = createSamplePairData();

      await service.set('bsc', 'pancakeswap', pairData.token0, pairData.token1, pairData, 120);

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        pairData,
        120,
      );
    });

    it('should return false when not initialized', async () => {
      const uninitService = new PairCacheService();
      const pairData = createSamplePairData();

      const ok = await uninitService.set('bsc', 'pancakeswap', pairData.token0, pairData.token1, pairData);
      expect(ok).toBe(false);
    });

    it('should return false on Redis error', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Redis write error'));
      const pairData = createSamplePairData();

      const ok = await service.set('bsc', 'pancakeswap', pairData.token0, pairData.token1, pairData);
      expect(ok).toBe(false);
      expect(service.getStats().errors).toBe(1);
    });

    it('should increment setOperations on success', async () => {
      const pairData = createSamplePairData();
      await service.set('bsc', 'pancakeswap', pairData.token0, pairData.token1, pairData);

      expect(service.getStats().setOperations).toBe(1);
    });
  });

  // =========================================================================
  // setNull()
  // =========================================================================

  describe('setNull', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should store NULL_PAIR marker with null TTL', async () => {
      const ok = await service.setNull('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');

      expect(ok).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        'NULL_PAIR',
        3600, // nullResultTtlSec
      );
    });

    it('should return false when not initialized', async () => {
      const uninitService = new PairCacheService();
      const ok = await uninitService.setNull('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(ok).toBe(false);
    });

    it('should return false on Redis error', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('Write error'));
      const ok = await service.setNull('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(ok).toBe(false);
    });
  });

  // =========================================================================
  // delete()
  // =========================================================================

  describe('delete', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should delete a cached pair', async () => {
      const ok = await service.delete('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');

      expect(ok).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledTimes(1);
    });

    it('should increment deleteOperations on success', async () => {
      await service.delete('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(service.getStats().deleteOperations).toBe(1);
    });

    it('should return false when not initialized', async () => {
      const uninitService = new PairCacheService();
      const ok = await uninitService.delete('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(ok).toBe(false);
    });

    it('should return false on Redis error', async () => {
      mockRedis.del.mockRejectedValueOnce(new Error('Delete error'));
      const ok = await service.delete('bsc', 'pancakeswap', '0xtoken0', '0xtoken1');
      expect(ok).toBe(false);
    });
  });

  // =========================================================================
  // getMany()
  // =========================================================================

  describe('getMany', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should return results for multiple pairs', async () => {
      const pairData = createSamplePairData();
      // First call returns data, second returns null
      mockRedis.get
        .mockResolvedValueOnce(pairData)
        .mockResolvedValueOnce(null);

      const results = await service.getMany([
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1' },
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt2', token1: '0xt3' },
      ]);

      expect(results.size).toBe(2);
      // One hit, one miss
      const values = Array.from(results.values());
      const hits = values.filter(v => v.status === 'hit');
      const misses = values.filter(v => v.status === 'miss');
      expect(hits.length).toBe(1);
      expect(misses.length).toBe(1);
    });

    it('should return empty map for empty request list', async () => {
      const results = await service.getMany([]);
      expect(results.size).toBe(0);
    });

    it('should return empty map when not initialized', async () => {
      const uninitService = new PairCacheService();
      const results = await uninitService.getMany([
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1' },
      ]);
      expect(results.size).toBe(0);
    });

    it('should return all misses on Redis error', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Batch get failed'));

      const results = await service.getMany([
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1' },
      ]);

      expect(results.size).toBe(1);
      const value = Array.from(results.values())[0];
      expect(value.status).toBe('miss');
    });

    it('should increment batchOperations', async () => {
      mockRedis.get.mockResolvedValue(null);
      await service.getMany([
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1' },
      ]);
      expect(service.getStats().batchOperations).toBe(1);
    });

    it('should recognize NULL_PAIR markers in batch results', async () => {
      mockRedis.get.mockResolvedValueOnce('NULL_PAIR');

      const results = await service.getMany([
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1' },
      ]);

      const value = Array.from(results.values())[0];
      expect(value.status).toBe('null');
    });
  });

  // =========================================================================
  // setMany()
  // =========================================================================

  describe('setMany', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should set multiple entries and return success count', async () => {
      const entries = [
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1', data: createSamplePairData() },
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt2', token1: '0xt3', data: createSamplePairData() },
      ];

      const count = await service.setMany(entries);
      expect(count).toBe(2);
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
    });

    it('should return 0 for empty entries', async () => {
      const count = await service.setMany([]);
      expect(count).toBe(0);
    });

    it('should return 0 when not initialized', async () => {
      const uninitService = new PairCacheService();
      const count = await uninitService.setMany([
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1', data: createSamplePairData() },
      ]);
      expect(count).toBe(0);
    });

    it('should process in batches respecting maxBatchSize', async () => {
      // maxBatchSize is 10 in our config. Create 15 entries to force 2 batches.
      const entries = Array.from({ length: 15 }, (_, i) => ({
        chain: 'bsc',
        dex: 'pancakeswap',
        token0: `0xtoken${i}a`,
        token1: `0xtoken${i}b`,
        data: createSamplePairData(),
      }));

      const count = await service.setMany(entries);
      expect(count).toBe(15);
      expect(mockRedis.set).toHaveBeenCalledTimes(15);
    });

    it('should increment batchOperations', async () => {
      await service.setMany([
        { chain: 'bsc', dex: 'pancakeswap', token0: '0xt0', token1: '0xt1', data: createSamplePairData() },
      ]);
      expect(service.getStats().batchOperations).toBe(1);
    });
  });

  // =========================================================================
  // invalidateChain()
  // =========================================================================

  describe('invalidateChain', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should delete all keys matching chain pattern via SCAN', async () => {
      // Mock SCAN returning keys then done
      mockRedis.scan
        .mockResolvedValueOnce(['42', ['pair:bsc:pancakeswap:0xt0:0xt1']])
        .mockResolvedValueOnce(['0', ['pair:bsc:uniswap:0xt2:0xt3']]);

      const count = await service.invalidateChain('bsc');

      expect(count).toBe(2);
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    it('should return 0 when no keys found', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      const count = await service.invalidateChain('bsc');
      expect(count).toBe(0);
    });

    it('should return 0 when not initialized', async () => {
      const uninitService = new PairCacheService();
      const count = await uninitService.invalidateChain('bsc');
      expect(count).toBe(0);
    });

    it('should return 0 on Redis error', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('SCAN failed'));

      const count = await service.invalidateChain('bsc');
      expect(count).toBe(0);
    });

    it('should increment deleteOperations by key count', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', ['key1', 'key2', 'key3']]);

      await service.invalidateChain('bsc');
      expect(service.getStats().deleteOperations).toBe(3);
    });
  });

  // =========================================================================
  // invalidateDex()
  // =========================================================================

  describe('invalidateDex', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should delete all keys matching chain+dex pattern via SCAN', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', ['pair:bsc:pancakeswap:0xt0:0xt1']]);

      const count = await service.invalidateDex('bsc', 'pancakeswap');

      expect(count).toBe(1);
      expect(mockRedis.del).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when not initialized', async () => {
      const uninitService = new PairCacheService();
      const count = await uninitService.invalidateDex('bsc', 'pancakeswap');
      expect(count).toBe(0);
    });

    it('should return 0 on Redis error', async () => {
      mockRedis.scan.mockRejectedValueOnce(new Error('SCAN error'));
      const count = await service.invalidateDex('bsc', 'pancakeswap');
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // Statistics
  // =========================================================================

  describe('getStats / getHitRatio / resetStats', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should return zeroed stats initially', () => {
      const stats = service.getStats();
      expect(stats.totalLookups).toBe(0);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
      expect(stats.nullHits).toBe(0);
      expect(stats.setOperations).toBe(0);
      expect(stats.deleteOperations).toBe(0);
      expect(stats.batchOperations).toBe(0);
      expect(stats.errors).toBe(0);
    });

    it('should return 0 hit ratio when no lookups', () => {
      expect(service.getHitRatio()).toBe(0);
    });

    it('should calculate hit ratio including null hits', async () => {
      const pairData = createSamplePairData();
      // 1 hit, 1 null hit, 1 miss = 3 lookups, (1+1)/3 hit ratio
      mockRedis.get
        .mockResolvedValueOnce(pairData)
        .mockResolvedValueOnce('NULL_PAIR')
        .mockResolvedValueOnce(null);

      await service.get('bsc', 'dex', '0xa', '0xb');
      await service.get('bsc', 'dex', '0xc', '0xd');
      await service.get('bsc', 'dex', '0xe', '0xf');

      const ratio = service.getHitRatio();
      expect(ratio).toBeCloseTo(2 / 3, 4);
    });

    it('should reset all stats to zero', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      await service.get('bsc', 'dex', '0xa', '0xb');

      service.resetStats();

      const stats = service.getStats();
      expect(stats.totalLookups).toBe(0);
      expect(stats.cacheMisses).toBe(0);
    });

    it('should return a copy of stats (not reference)', () => {
      const stats1 = service.getStats();
      stats1.totalLookups = 999;
      const stats2 = service.getStats();
      expect(stats2.totalLookups).toBe(0);
    });
  });

  // =========================================================================
  // Prometheus Metrics
  // =========================================================================

  describe('getPrometheusMetrics', () => {
    it('should return Prometheus-format metrics string', () => {
      const metrics = service.getPrometheusMetrics();

      expect(metrics).toContain('pair_cache_lookups_total');
      expect(metrics).toContain('pair_cache_hits_total');
      expect(metrics).toContain('pair_cache_misses_total');
      expect(metrics).toContain('pair_cache_null_hits_total');
      expect(metrics).toContain('pair_cache_set_operations_total');
      expect(metrics).toContain('pair_cache_errors_total');
      expect(metrics).toContain('pair_cache_hit_ratio');
    });

    it('should include correct TYPE annotations', () => {
      const metrics = service.getPrometheusMetrics();

      expect(metrics).toContain('# TYPE pair_cache_lookups_total counter');
      expect(metrics).toContain('# TYPE pair_cache_hit_ratio gauge');
    });
  });

  // =========================================================================
  // resetState
  // =========================================================================

  describe('resetState', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should reset stats while preserving initialization', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      await service.get('bsc', 'dex', '0xa', '0xb');

      service.resetState();

      expect(service.getStats().totalLookups).toBe(0);
      expect(service.isInitialized()).toBe(true);
    });
  });

  // =========================================================================
  // Events
  // =========================================================================

  describe('event emissions', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should emit cache:hit on hit', async () => {
      const pairData = createSamplePairData();
      mockRedis.get.mockResolvedValueOnce(pairData);

      const handler = jest.fn();
      service.on('cache:hit', handler);

      await service.get('bsc', 'pancakeswap', '0xt0', '0xt1');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit cache:miss on miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const handler = jest.fn();
      service.on('cache:miss', handler);

      await service.get('bsc', 'pancakeswap', '0xt0', '0xt1');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit cache:null_hit on null marker', async () => {
      mockRedis.get.mockResolvedValueOnce('NULL_PAIR');

      const handler = jest.fn();
      service.on('cache:null_hit', handler);

      await service.get('bsc', 'pancakeswap', '0xt0', '0xt1');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit cache:set on successful set', async () => {
      const handler = jest.fn();
      service.on('cache:set', handler);

      const pairData = createSamplePairData();
      await service.set('bsc', 'pancakeswap', pairData.token0, pairData.token1, pairData);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit cache:delete on successful delete', async () => {
      const handler = jest.fn();
      service.on('cache:delete', handler);

      await service.delete('bsc', 'pancakeswap', '0xt0', '0xt1');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should emit cache:error when get is called without initialization', async () => {
      const uninitService = new PairCacheService();
      const handler = jest.fn();
      uninitService.on('cache:error', handler);

      await uninitService.get('bsc', 'pancakeswap', '0xt0', '0xt1');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ reason: 'not_initialized' });
    });
  });
});
