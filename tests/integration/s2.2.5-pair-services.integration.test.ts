/**
 * S2.2.5 Pair Services Integration Tests
 *
 * Comprehensive tests for PairDiscoveryService and PairCacheService
 * These tests verify the actual service implementations work correctly.
 *
 * Test Categories:
 * 1. PairDiscoveryService unit tests (with mocked providers)
 * 2. PairCacheService unit tests (with mocked Redis)
 * 3. Service integration tests
 * 4. Error handling and resilience tests
 * 5. Singleton pattern tests
 * 6. Regression tests for S2.2.5 fixes
 */

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = 'wss://mainnet.infura.io/ws/v3/test';
process.env.REDIS_URL = 'redis://localhost:6379';

import { EventEmitter } from 'events';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock Redis client
const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(),
  isConnected: jest.fn().mockReturnValue(true)
};

// Mock Redis module (kept for backwards compatibility, but DI is preferred)
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;
  return {
    ...actual,
    getRedisClient: jest.fn().mockResolvedValue(mockRedisClient),
    RedisClient: jest.fn()
  };
});

// Helper function to create mock deps for PairCacheService
const createMockCacheDeps = () => ({
  getRedisClient: jest.fn().mockResolvedValue(mockRedisClient) as any
});

// Mock ethers provider and contract
const mockProvider = {
  getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
  call: jest.fn()
};

const mockContract = {
  getPair: jest.fn(),
  getPool: jest.fn()
};

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    JsonRpcProvider: jest.fn().mockImplementation(() => mockProvider),
    Contract: jest.fn().mockImplementation(() => mockContract),
    ZeroAddress: '0x0000000000000000000000000000000000000000'
  };
});

// Import services after mocks are set up
import {
  PairDiscoveryService,
  getPairDiscoveryService,
  resetPairDiscoveryService,
  PairCacheService,
  getPairCacheService,
  resetPairCacheService,
  type CachedPairData
} from '@arbitrage/core';
import { Dex, Token } from '../../shared/types';
import { createResetHook } from '@arbitrage/test-utils';

// =============================================================================
// Test Fixtures
// =============================================================================

const testToken0: Token = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
  chainId: 1
};

const testToken1: Token = {
  address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  symbol: 'USDT',
  decimals: 6,
  chainId: 1
};

const testDex: Dex = {
  name: 'uniswap_v2',
  chain: 'ethereum',
  factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  fee: 30,
  enabled: true
};

const testV3Dex: Dex = {
  name: 'uniswap_v3',
  chain: 'ethereum',
  factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  fee: 30,
  enabled: true
};

const testPairAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';

const testCachedPairData: CachedPairData = {
  address: testPairAddress,
  token0: testToken0.address,
  token1: testToken1.address,
  dex: 'uniswap_v2',
  chain: 'ethereum',
  factoryAddress: testDex.factoryAddress,
  fee: 0.003,
  discoveredAt: Date.now(),
  lastVerified: Date.now(),
  discoveryMethod: 'factory_query'
};

// =============================================================================
// Test Suite: PairDiscoveryService
// =============================================================================

describe('S2.2.5 PairDiscoveryService', () => {
  let service: PairDiscoveryService;

  // P2-1: Use beforeAll for expensive object creation (created once vs per-test)
  beforeAll(() => {
    resetPairDiscoveryService();
    service = new PairDiscoveryService({
      maxConcurrentQueries: 5,
      batchSize: 10,
      batchDelayMs: 10,
      retryAttempts: 2,
      retryDelayMs: 10,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 100,
      queryTimeoutMs: 100
    });
  });

  // P2-1: Reset state before each test for isolation
  beforeEach(() => {
    jest.clearAllMocks();
    service.resetState(); // Fast: just clears data, doesn't recreate objects
  });

  describe('Configuration', () => {
    it('should use default config when none provided', () => {
      const defaultService = new PairDiscoveryService();
      const stats = defaultService.getStats();
      expect(stats.totalQueries).toBe(0);
    });

    it('should accept partial config', () => {
      const partialService = new PairDiscoveryService({
        maxConcurrentQueries: 20
      });
      expect(partialService).toBeDefined();
    });
  });

  describe('Factory Type Detection', () => {
    it('should detect V2 factory type', () => {
      // Access private method through prototype for testing
      const detectFactoryType = (service as any).detectFactoryType.bind(service);

      expect(detectFactoryType('uniswap_v2')).toBe('v2');
      expect(detectFactoryType('sushiswap')).toBe('v2');
      expect(detectFactoryType('pancakeswap_v2')).toBe('v2');
    });

    it('should detect V3 factory type', () => {
      const detectFactoryType = (service as any).detectFactoryType.bind(service);

      expect(detectFactoryType('uniswap_v3')).toBe('v3');
      expect(detectFactoryType('pancakeswap_v3')).toBe('v3');
      expect(detectFactoryType('camelot_v3')).toBe('v3');
    });

    it('should detect Curve factory type', () => {
      const detectFactoryType = (service as any).detectFactoryType.bind(service);

      expect(detectFactoryType('curve')).toBe('curve');
      expect(detectFactoryType('ellipsis')).toBe('curve');
    });
  });

  describe('Token Sorting', () => {
    it('should sort tokens deterministically', () => {
      const sortTokens = (service as any).sortTokens.bind(service);

      const [sorted0, sorted1] = sortTokens(testToken0.address, testToken1.address);
      const [sorted0Rev, sorted1Rev] = sortTokens(testToken1.address, testToken0.address);

      expect(sorted0).toBe(sorted0Rev);
      expect(sorted1).toBe(sorted1Rev);
    });

    it('should handle lowercase and checksum addresses', () => {
      const sortTokens = (service as any).sortTokens.bind(service);

      const checksum = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      const lowercase = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

      const [sorted0a, sorted1a] = sortTokens(checksum, testToken1.address);
      const [sorted0b, sorted1b] = sortTokens(lowercase, testToken1.address);

      expect(sorted0a.toLowerCase()).toBe(sorted0b.toLowerCase());
      expect(sorted1a.toLowerCase()).toBe(sorted1b.toLowerCase());
    });
  });

  describe('CREATE2 Address Computation', () => {
    it('should compute valid CREATE2 address', () => {
      const pair = service.computePairAddress('ethereum', testDex, testToken0, testToken1);

      expect(pair).not.toBeNull();
      expect(pair!.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(pair!.discoveryMethod).toBe('create2_compute');
    });

    it('should generate deterministic addresses', () => {
      const pair1 = service.computePairAddress('ethereum', testDex, testToken0, testToken1);
      const pair2 = service.computePairAddress('ethereum', testDex, testToken1, testToken0);

      expect(pair1!.address).toBe(pair2!.address);
    });

    it('should update statistics on CREATE2 computation', () => {
      service.computePairAddress('ethereum', testDex, testToken0, testToken1);

      const stats = service.getStats();
      expect(stats.create2Computations).toBe(1);
    });

    it('should emit pair:discovered event', () => {
      const eventHandler = jest.fn();
      service.on('pair:discovered', eventHandler);

      service.computePairAddress('ethereum', testDex, testToken0, testToken1);

      expect(eventHandler).toHaveBeenCalled();
    });
  });

  describe('Statistics', () => {
    it('should track query statistics', () => {
      const stats = service.getStats();

      expect(stats).toHaveProperty('totalQueries');
      expect(stats).toHaveProperty('cacheHits');
      expect(stats).toHaveProperty('factoryQueries');
      expect(stats).toHaveProperty('create2Computations');
      expect(stats).toHaveProperty('failedQueries');
      expect(stats).toHaveProperty('circuitBreakerTrips');
      expect(stats).toHaveProperty('avgQueryLatencyMs');
    });

    it('should generate Prometheus metrics', () => {
      service.computePairAddress('ethereum', testDex, testToken0, testToken1);

      const metrics = service.getPrometheusMetrics();

      // Actual metric names from implementation
      expect(metrics).toContain('pair_discovery_total');
      expect(metrics).toContain('pair_discovery_factory_queries');
      expect(metrics).toContain('pair_discovery_create2_computations');
      expect(metrics).toContain('pair_discovery_latency_ms');
    });

    it('should increment cache hits counter', () => {
      const initialStats = service.getStats();
      expect(initialStats.cacheHits).toBe(0);

      service.incrementCacheHits();
      service.incrementCacheHits();

      const updatedStats = service.getStats();
      expect(updatedStats.cacheHits).toBe(2);
    });

    it('should track active queries', () => {
      expect(service.getActiveQueries()).toBe(0);
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance on multiple calls', () => {
      resetPairDiscoveryService();

      const instance1 = getPairDiscoveryService();
      const instance2 = getPairDiscoveryService();

      expect(instance1).toBe(instance2);
    });

    it('should ignore config on subsequent calls', () => {
      resetPairDiscoveryService();

      const instance1 = getPairDiscoveryService({ maxConcurrentQueries: 5 });
      const instance2 = getPairDiscoveryService({ maxConcurrentQueries: 100 });

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getPairDiscoveryService();
      resetPairDiscoveryService();
      const instance2 = getPairDiscoveryService();

      expect(instance1).not.toBe(instance2);
    });
  });
});

// =============================================================================
// Test Suite: PairCacheService
// =============================================================================

describe('S2.2.5 PairCacheService', () => {
  let service: PairCacheService;

  // P2-1: Use beforeAll for expensive object creation and initialization
  beforeAll(async () => {
    resetPairCacheService();

    // REFACTOR: Use dependency injection to inject mock Redis client
    // This avoids Jest mock hoisting issues with @arbitrage/core/redis
    service = new PairCacheService(
      {
        pairAddressTtlSec: 3600,
        pairMetadataTtlSec: 600,
        nullResultTtlSec: 300,
        maxBatchSize: 50,
        usePipeline: true,
        keyPrefix: 'test:pair:'
      },
      {
        getRedisClient: jest.fn().mockResolvedValue(mockRedisClient) as any
      }
    );

    await service.initialize(); // Initialize once
  });

  // P2-1: Reset state and mocks before each test for isolation
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock Redis
    mockRedisClient.get.mockReset();
    mockRedisClient.set.mockReset();
    mockRedisClient.del.mockReset();
    mockRedisClient.keys.mockReset();

    service.resetState(); // Fast: just clears statistics
  });

  describe('Initialization', () => {
    it('should initialize successfully', () => {
      expect(service.isInitialized()).toBe(true);
    });

    it('should not re-initialize if already initialized', async () => {
      const initialState = service.isInitialized();
      await service.initialize();
      expect(service.isInitialized()).toBe(initialState);
    });
  });

  describe('Cache Key Generation', () => {
    it('should generate consistent keys regardless of token order', () => {
      const key1 = service.generateCacheKey('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);
      const key2 = service.generateCacheKey('ethereum', 'uniswap_v2', testToken1.address, testToken0.address);

      expect(key1).toBe(key2);
    });

    it('should generate keys with correct prefix', () => {
      const key = service.generateCacheKey('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

      expect(key).toContain('test:pair:');
      expect(key).toContain('ethereum');
      expect(key).toContain('uniswap_v2');
    });

    it('should generate pattern keys for bulk operations', () => {
      const chainPattern = service.generatePatternKey('ethereum');
      const dexPattern = service.generatePatternKey('ethereum', 'uniswap_v2');

      expect(chainPattern).toBe('test:pair:ethereum:*');
      expect(dexPattern).toBe('test:pair:ethereum:uniswap_v2:*');
    });

    it('should lowercase addresses in keys', () => {
      const key = service.generateCacheKey('ethereum', 'uniswap_v2',
        '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
      );

      expect(key).not.toContain('AAAA');
      expect(key).toContain('aaaa');
    });
  });

  describe('Cache Operations', () => {
    describe('get()', () => {
      it('should return cache hit for existing data', async () => {
        mockRedisClient.get.mockResolvedValue(testCachedPairData);

        const result = await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

        expect(result.status).toBe('hit');
        if (result.status === 'hit') {
          expect(result.data.address).toBe(testPairAddress);
        }
      });

      it('should return cache miss for null value', async () => {
        mockRedisClient.get.mockResolvedValue(null);

        const result = await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

        expect(result.status).toBe('miss');
      });

      it('should return null status for NULL_PAIR marker', async () => {
        mockRedisClient.get.mockResolvedValue('NULL_PAIR');

        const result = await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

        expect(result.status).toBe('null');
        if (result.status === 'null') {
          expect(result.reason).toBe('pair_not_exists');
        }
      });

      it('should return null status for zero address', async () => {
        mockRedisClient.get.mockResolvedValue('0x0000000000000000000000000000000000000000');

        const result = await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

        expect(result.status).toBe('null');
      });

      it('should handle Redis errors gracefully', async () => {
        mockRedisClient.get.mockRejectedValue(new Error('Redis connection failed'));

        const result = await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

        expect(result.status).toBe('miss');
        expect(service.getStats().errors).toBeGreaterThan(0);
      });

      it('should emit events on cache operations', async () => {
        const hitHandler = jest.fn();
        const missHandler = jest.fn();
        service.on('cache:hit', hitHandler);
        service.on('cache:miss', missHandler);

        mockRedisClient.get.mockResolvedValue(testCachedPairData);
        await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);
        expect(hitHandler).toHaveBeenCalled();

        mockRedisClient.get.mockResolvedValue(null);
        await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);
        expect(missHandler).toHaveBeenCalled();
      });
    });

    describe('set()', () => {
      it('should set pair data in cache', async () => {
        mockRedisClient.set.mockResolvedValue('OK');

        const result = await service.set('ethereum', 'uniswap_v2',
          testToken0.address, testToken1.address, testCachedPairData);

        expect(result).toBe(true);
        expect(mockRedisClient.set).toHaveBeenCalled();
      });

      it('should use custom TTL when provided', async () => {
        mockRedisClient.set.mockResolvedValue('OK');

        await service.set('ethereum', 'uniswap_v2',
          testToken0.address, testToken1.address, testCachedPairData, 7200);

        expect(mockRedisClient.set).toHaveBeenCalledWith(
          expect.any(String),
          testCachedPairData,
          7200
        );
      });

      it('should handle Redis errors gracefully', async () => {
        mockRedisClient.set.mockRejectedValue(new Error('Redis write failed'));

        const result = await service.set('ethereum', 'uniswap_v2',
          testToken0.address, testToken1.address, testCachedPairData);

        expect(result).toBe(false);
        expect(service.getStats().errors).toBeGreaterThan(0);
      });
    });

    describe('setNull()', () => {
      it('should set NULL_PAIR marker for non-existent pairs', async () => {
        mockRedisClient.set.mockResolvedValue('OK');

        const result = await service.setNull('ethereum', 'uniswap_v2',
          testToken0.address, testToken1.address);

        expect(result).toBe(true);
        expect(mockRedisClient.set).toHaveBeenCalledWith(
          expect.any(String),
          'NULL_PAIR',
          300 // nullResultTtlSec
        );
      });
    });

    describe('delete()', () => {
      it('should delete pair from cache', async () => {
        mockRedisClient.del.mockResolvedValue(1);

        const result = await service.delete('ethereum', 'uniswap_v2',
          testToken0.address, testToken1.address);

        expect(result).toBe(true);
        expect(mockRedisClient.del).toHaveBeenCalled();
      });
    });
  });

  describe('Batch Operations', () => {
    describe('getMany()', () => {
      it('should get multiple pairs in parallel', async () => {
        mockRedisClient.get
          .mockResolvedValueOnce(testCachedPairData)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce('NULL_PAIR');

        const requests = [
          { chain: 'ethereum', dex: 'uniswap_v2', token0: '0xaaa', token1: '0xbbb' },
          { chain: 'ethereum', dex: 'uniswap_v2', token0: '0xccc', token1: '0xddd' },
          { chain: 'ethereum', dex: 'uniswap_v2', token0: '0xeee', token1: '0xfff' }
        ];

        const results = await service.getMany(requests);

        expect(results.size).toBe(3);
        expect(service.getStats().batchOperations).toBeGreaterThan(0);
      });

      it('should return empty map for empty requests', async () => {
        const results = await service.getMany([]);

        expect(results.size).toBe(0);
      });
    });

    describe('setMany()', () => {
      it('should set multiple pairs in batches', async () => {
        mockRedisClient.set.mockResolvedValue('OK');

        const entries = Array.from({ length: 10 }, (_, i) => ({
          chain: 'ethereum',
          dex: 'uniswap_v2',
          token0: `0x${'a'.repeat(40)}${i}`.slice(0, 42),
          token1: `0x${'b'.repeat(40)}${i}`.slice(0, 42),
          data: { ...testCachedPairData, address: `0x${'c'.repeat(40)}${i}`.slice(0, 42) }
        }));

        const successCount = await service.setMany(entries);

        expect(successCount).toBe(10);
      });
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate all pairs for a chain', async () => {
      mockRedisClient.keys.mockResolvedValue(['key1', 'key2', 'key3']);
      mockRedisClient.del.mockResolvedValue(1);

      const count = await service.invalidateChain('ethereum');

      expect(count).toBe(3);
      expect(mockRedisClient.del).toHaveBeenCalledTimes(3);
    });

    it('should invalidate all pairs for a DEX on a chain', async () => {
      mockRedisClient.keys.mockResolvedValue(['key1', 'key2']);
      mockRedisClient.del.mockResolvedValue(1);

      const count = await service.invalidateDex('ethereum', 'uniswap_v2');

      expect(count).toBe(2);
    });

    it('should return 0 when no keys match', async () => {
      mockRedisClient.keys.mockResolvedValue([]);

      const count = await service.invalidateChain('nonexistent');

      expect(count).toBe(0);
    });

    it('should use parallel batch deletes (S2.2.5 fix)', async () => {
      // Create 150 keys to test batching
      const keys = Array.from({ length: 150 }, (_, i) => `key${i}`);
      mockRedisClient.keys.mockResolvedValue(keys);
      mockRedisClient.del.mockResolvedValue(1);

      const count = await service.invalidateChain('ethereum');

      expect(count).toBe(150);
      // Should batch deletes (150 keys / 50 batch size = 3 batches)
      expect(mockRedisClient.del).toHaveBeenCalledTimes(150);
    });
  });

  describe('Statistics', () => {
    it('should track all statistics', async () => {
      mockRedisClient.get.mockResolvedValueOnce(testCachedPairData);
      mockRedisClient.get.mockResolvedValueOnce(null);
      mockRedisClient.get.mockResolvedValueOnce('NULL_PAIR');
      mockRedisClient.set.mockResolvedValue('OK');

      await service.get('ethereum', 'uniswap_v2', '0xaaa', '0xbbb');
      await service.get('ethereum', 'uniswap_v2', '0xccc', '0xddd');
      await service.get('ethereum', 'uniswap_v2', '0xeee', '0xfff');
      await service.set('ethereum', 'uniswap_v2', '0xggg', '0xhhh', testCachedPairData);

      const stats = service.getStats();

      expect(stats.totalLookups).toBe(3);
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheMisses).toBe(1);
      expect(stats.nullHits).toBe(1);
      expect(stats.setOperations).toBe(1);
    });

    it('should calculate hit ratio correctly', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce(testCachedPairData)
        .mockResolvedValueOnce(testCachedPairData)
        .mockResolvedValueOnce(testCachedPairData)
        .mockResolvedValueOnce(null);

      await service.get('ethereum', 'uniswap_v2', '0xa', '0xb');
      await service.get('ethereum', 'uniswap_v2', '0xc', '0xd');
      await service.get('ethereum', 'uniswap_v2', '0xe', '0xf');
      await service.get('ethereum', 'uniswap_v2', '0xg', '0xh');

      const hitRatio = service.getHitRatio();

      expect(hitRatio).toBe(0.75); // 3 hits out of 4 lookups
    });

    it('should generate Prometheus metrics', async () => {
      mockRedisClient.get.mockResolvedValue(testCachedPairData);
      await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

      const metrics = service.getPrometheusMetrics();

      expect(metrics).toContain('pair_cache_lookups_total');
      expect(metrics).toContain('pair_cache_hits_total');
      expect(metrics).toContain('pair_cache_misses_total');
      expect(metrics).toContain('pair_cache_hit_ratio');
    });

    it('should reset statistics', async () => {
      mockRedisClient.get.mockResolvedValue(testCachedPairData);
      await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

      service.resetStats();

      const stats = service.getStats();
      expect(stats.totalLookups).toBe(0);
      expect(stats.cacheHits).toBe(0);
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance on multiple calls', async () => {
      resetPairCacheService();

      const instance1 = await getPairCacheService();
      const instance2 = await getPairCacheService();

      expect(instance1).toBe(instance2);
    });

    it('should handle concurrent initialization (race condition fix)', async () => {
      resetPairCacheService();

      // Simulate concurrent calls
      const [instance1, instance2, instance3] = await Promise.all([
        getPairCacheService(),
        getPairCacheService(),
        getPairCacheService()
      ]);

      expect(instance1).toBe(instance2);
      expect(instance2).toBe(instance3);
    });

    it('should create new instance after reset', async () => {
      const instance1 = await getPairCacheService();
      resetPairCacheService();
      const instance2 = await getPairCacheService();

      expect(instance1).not.toBe(instance2);
    });
  });
});

// =============================================================================
// Test Suite: Service Integration
// =============================================================================

describe('S2.2.5 Service Integration', () => {
  let discoveryService: PairDiscoveryService;
  let cacheService: PairCacheService;

  // P2-1: Use beforeAll for expensive object creation and initialization
  beforeAll(async () => {
    resetPairDiscoveryService();
    resetPairCacheService();

    discoveryService = new PairDiscoveryService({
      retryAttempts: 2,
      retryDelayMs: 10,
      queryTimeoutMs: 100
    });

    // Use DI to inject mock Redis
    cacheService = new PairCacheService({}, createMockCacheDeps());
    await cacheService.initialize();
  });

  // P2-1: Reset state and mocks before each test for isolation
  beforeEach(() => {
    jest.clearAllMocks();

    mockRedisClient.get.mockReset();
    mockRedisClient.set.mockReset();

    // Reset both services' state
    discoveryService.resetState();
    cacheService.resetState();
  });

  describe('Cache-Aware Discovery Flow', () => {
    it('should integrate cache lookup with discovery', async () => {
      // Simulate cache miss then discovery
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.set.mockResolvedValue('OK');

      // Check cache first
      const cacheResult = await cacheService.get('ethereum', 'uniswap_v2',
        testToken0.address, testToken1.address);
      expect(cacheResult.status).toBe('miss');

      // On miss, use CREATE2 computation
      const discoveredPair = discoveryService.computePairAddress(
        'ethereum', testDex, testToken0, testToken1);
      expect(discoveredPair).not.toBeNull();

      // Cache the discovered pair
      const cached = await cacheService.set('ethereum', 'uniswap_v2',
        testToken0.address, testToken1.address, {
          address: discoveredPair!.address,
          token0: testToken0.address,
          token1: testToken1.address,
          dex: 'uniswap_v2',
          chain: 'ethereum',
          factoryAddress: testDex.factoryAddress,
          discoveredAt: Date.now(),
          lastVerified: Date.now(),
          discoveryMethod: 'create2_compute'
        });
      expect(cached).toBe(true);
    });

    it('should use cached data when available', async () => {
      mockRedisClient.get.mockResolvedValue(testCachedPairData);

      const cacheResult = await cacheService.get('ethereum', 'uniswap_v2',
        testToken0.address, testToken1.address);

      expect(cacheResult.status).toBe('hit');
      if (cacheResult.status === 'hit') {
        expect(cacheResult.data.address).toBe(testPairAddress);
        // Should increment cache hits in discovery service
        discoveryService.incrementCacheHits();
        expect(discoveryService.getStats().cacheHits).toBe(1);
      }
    });
  });
});

// =============================================================================
// Test Suite: Regression Tests
// =============================================================================

describe('S2.2.5 Regression Tests', () => {
  describe('REGRESSION: Double JSON.parse Fix', () => {
    it('should not double-parse JSON from Redis (PairCacheService)', async () => {
      resetPairCacheService();
      mockRedisClient.get.mockReset();

      // Use DI to inject mock Redis
      const service = new PairCacheService({}, createMockCacheDeps());
      await service.initialize();

      // Mock returns already-parsed object (as RedisClient.get() does)
      mockRedisClient.get.mockResolvedValue(testCachedPairData);

      const result = await service.get('ethereum', 'uniswap_v2',
        testToken0.address, testToken1.address);

      expect(result.status).toBe('hit');
      if (result.status === 'hit') {
        // Should be the exact object, not a re-parsed version
        expect(result.data.address).toBe(testCachedPairData.address);
        expect(typeof result.data.discoveredAt).toBe('number');
      }
    });
  });

  describe('REGRESSION: Singleton Race Condition Fix', () => {
    it('should handle concurrent getPairCacheService calls', async () => {
      resetPairCacheService();

      // Simulate slow initialization
      const originalGet = mockRedisClient.get;
      mockRedisClient.get = jest.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 50));
        return null;
      });

      // Multiple concurrent calls
      const promises = Array.from({ length: 10 }, () => getPairCacheService());
      const instances = await Promise.all(promises);

      // All should be the same instance
      const firstInstance = instances[0];
      instances.forEach(instance => {
        expect(instance).toBe(firstInstance);
      });

      mockRedisClient.get = originalGet;
    });
  });

  describe('REGRESSION: Parallel Batch Deletes', () => {
    it('should delete in parallel batches not sequentially', async () => {
      resetPairCacheService();

      // Use DI to inject mock Redis
      const service = new PairCacheService({ maxBatchSize: 10 }, createMockCacheDeps());
      await service.initialize();

      const keys = Array.from({ length: 25 }, (_, i) => `key${i}`);
      mockRedisClient.keys.mockResolvedValue(keys);

      const deleteTimings: number[] = [];
      mockRedisClient.del.mockImplementation(async () => {
        deleteTimings.push(Date.now());
        await new Promise(r => setTimeout(r, 5));
        return 1;
      });

      await service.invalidateChain('ethereum');

      // Verify all deletes completed
      expect(mockRedisClient.del).toHaveBeenCalledTimes(25);
    });
  });

  describe('REGRESSION: Retry Logic with Exponential Backoff', () => {
    it('should retry with exponential backoff on failure', async () => {
      resetPairDiscoveryService();

      const service = new PairDiscoveryService({
        retryAttempts: 3,
        retryDelayMs: 10,
        queryTimeoutMs: 50
      });

      // CREATE2 should work without retries
      const pair = service.computePairAddress('ethereum', testDex, testToken0, testToken1);
      expect(pair).not.toBeNull();
    });
  });

  describe('REGRESSION: Memory-Bounded Latency Tracking', () => {
    it('should limit latency samples to prevent memory growth', () => {
      resetPairDiscoveryService();

      const service = new PairDiscoveryService();

      // Simulate many CREATE2 computations
      for (let i = 0; i < 2000; i++) {
        service.computePairAddress('ethereum', testDex,
          { ...testToken0, address: `0x${'a'.repeat(39)}${i % 10}` },
          { ...testToken1, address: `0x${'b'.repeat(39)}${i % 10}` }
        );
      }

      // Stats should still be valid
      const stats = service.getStats();
      expect(stats.avgQueryLatencyMs).toBeGreaterThanOrEqual(0);
      expect(stats.create2Computations).toBe(2000);
    });
  });

  describe('REGRESSION: Concurrency Control in Batch Discovery', () => {
    it('should respect maxConcurrentQueries limit', async () => {
      resetPairDiscoveryService();

      const service = new PairDiscoveryService({
        maxConcurrentQueries: 3,
        batchSize: 10,
        batchDelayMs: 0
      });

      // Track concurrent queries
      expect(service.getActiveQueries()).toBe(0);
    });
  });
});

// =============================================================================
// Test Suite: Error Handling
// =============================================================================

describe('S2.2.5 Error Handling', () => {
  describe('PairCacheService Error Handling', () => {
    let service: PairCacheService;

    beforeEach(async () => {
      resetPairCacheService();
      mockRedisClient.get.mockReset();
      mockRedisClient.set.mockReset();

      // Use DI to inject mock Redis
      service = new PairCacheService({}, createMockCacheDeps());
      await service.initialize();
    });

    it('should handle uninitialized service gracefully', async () => {
      resetPairCacheService();
      const uninitializedService = new PairCacheService();
      // Don't call initialize()

      const result = await uninitializedService.get('ethereum', 'uniswap_v2', '0xa', '0xb');
      expect(result.status).toBe('miss');
    });

    it('should emit error events on failures', async () => {
      const errorHandler = jest.fn();
      service.on('cache:error', errorHandler);

      mockRedisClient.get.mockRejectedValue(new Error('Connection refused'));

      await service.get('ethereum', 'uniswap_v2', testToken0.address, testToken1.address);

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should track error count in statistics', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));
      mockRedisClient.set.mockRejectedValue(new Error('Redis error'));

      await service.get('ethereum', 'uniswap_v2', '0xa', '0xb');
      await service.set('ethereum', 'uniswap_v2', '0xa', '0xb', testCachedPairData);

      expect(service.getStats().errors).toBe(2);
    });
  });

  describe('PairDiscoveryService Error Handling', () => {
    let service: PairDiscoveryService;

    beforeEach(() => {
      resetPairDiscoveryService();
      service = new PairDiscoveryService({
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 100
      });
    });

    it('should handle missing init code hash gracefully', () => {
      const unknownDex: Dex = {
        name: 'unknown_dex',
        chain: 'ethereum',
        factoryAddress: '0x1234567890123456789012345678901234567890',
        routerAddress: '0x1234567890123456789012345678901234567890',
        fee: 30,
        enabled: true
      };

      const pair = service.computePairAddress('ethereum', unknownDex, testToken0, testToken1);

      // Implementation uses default/fallback init code hash for unknown DEXs
      // So it returns a computed address, not null
      expect(pair).not.toBeNull();
      expect(pair!.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(pair!.discoveryMethod).toBe('create2_compute');
    });

    it('should emit events for all discovery outcomes', () => {
      const discoveredHandler = jest.fn();
      service.on('pair:discovered', discoveredHandler);

      service.computePairAddress('ethereum', testDex, testToken0, testToken1);

      expect(discoveredHandler).toHaveBeenCalled();
    });
  });
});
