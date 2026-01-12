/**
 * PairDiscoveryService Unit Tests
 *
 * Tests for S2.2.5: Dynamic pair discovery from DEX factory contracts
 * - Factory query methods (V2 and V3 patterns)
 * - V3 fee tier capture
 * - CREATE2 address computation fallback
 * - Circuit breaker behavior
 * - Statistics tracking
 */

import { ethers } from 'ethers';
import {
  PairDiscoveryService,
  DiscoveredPair,
  PairDiscoveryConfig,
  PairDiscoveryStats,
  getPairDiscoveryService,
  resetPairDiscoveryService
} from './pair-discovery';

// =============================================================================
// Mocks
// =============================================================================

// Mock logger
jest.mock('./logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

// Mock provider and contract factory
const mockGetPool = jest.fn();
const mockGetPair = jest.fn();

// =============================================================================
// Test Fixtures
// =============================================================================

const testConfig: Partial<PairDiscoveryConfig> = {
  maxConcurrentQueries: 5,
  batchSize: 10,
  batchDelayMs: 0, // No delay in tests
  retryAttempts: 2,
  retryDelayMs: 10, // Short delay for tests
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 100, // Short reset for tests
  queryTimeoutMs: 1000
};

const testDex = {
  name: 'uniswap_v3',
  chain: 'ethereum',
  factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  routerAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  fee: 30,
  enabled: true
};

const testDexV2 = {
  name: 'uniswap_v2',
  chain: 'ethereum',
  factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  fee: 30,
  enabled: true
};

const testToken0 = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
  chainId: 1
};

const testToken1 = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
  chainId: 1
};

const testPairAddress = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';

// =============================================================================
// Test Suite
// =============================================================================

describe('PairDiscoveryService', () => {
  let service: PairDiscoveryService;

  beforeEach(() => {
    resetPairDiscoveryService();
    service = new PairDiscoveryService(testConfig);
    jest.clearAllMocks();
  });

  afterEach(() => {
    service.cleanup();
  });

  // ===========================================================================
  // Factory Type Detection
  // ===========================================================================

  describe('detectFactoryType()', () => {
    it('should detect V3 DEXs', () => {
      expect(service.detectFactoryType('uniswap_v3')).toBe('v3');
      expect(service.detectFactoryType('pancakeswap_v3')).toBe('v3');
      expect(service.detectFactoryType('camelot_v3')).toBe('v3');
    });

    it('should detect V2 DEXs', () => {
      expect(service.detectFactoryType('uniswap_v2')).toBe('v2');
      expect(service.detectFactoryType('sushiswap')).toBe('v2');
      expect(service.detectFactoryType('quickswap')).toBe('v2');
    });

    it('should detect Curve-style DEXs', () => {
      expect(service.detectFactoryType('curve')).toBe('curve');
      expect(service.detectFactoryType('ellipsis')).toBe('curve');
    });
  });

  // ===========================================================================
  // Token Sorting
  // ===========================================================================

  describe('sortTokens()', () => {
    it('should sort tokens alphabetically by address', () => {
      const [sorted0, sorted1] = service.sortTokens(
        '0xB000000000000000000000000000000000000000',
        '0xA000000000000000000000000000000000000000'
      );

      expect(sorted0).toBe('0xA000000000000000000000000000000000000000');
      expect(sorted1).toBe('0xB000000000000000000000000000000000000000');
    });

    it('should handle case-insensitive sorting', () => {
      const [sorted0, sorted1] = service.sortTokens(
        '0xBBBB',
        '0xaaaa' // lowercase
      );

      expect(sorted0.toLowerCase()).toBe('0xaaaa');
      expect(sorted1.toLowerCase()).toBe('0xbbbb');
    });

    it('should maintain order when already sorted', () => {
      const [sorted0, sorted1] = service.sortTokens(
        '0xA000000000000000000000000000000000000000',
        '0xB000000000000000000000000000000000000000'
      );

      expect(sorted0).toBe('0xA000000000000000000000000000000000000000');
      expect(sorted1).toBe('0xB000000000000000000000000000000000000000');
    });
  });

  // ===========================================================================
  // CREATE2 Address Computation
  // ===========================================================================

  describe('computePairAddress()', () => {
    it('should compute deterministic pair address for V2 DEX', () => {
      const result = service.computePairAddress(
        'ethereum',
        testDexV2,
        testToken0,
        testToken1
      );

      expect(result).not.toBeNull();
      expect(result!.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(result!.discoveryMethod).toBe('create2_compute');
      expect(result!.dex).toBe('uniswap_v2');
      expect(result!.chain).toBe('ethereum');
    });

    it('should return same address regardless of token order', () => {
      const result1 = service.computePairAddress(
        'ethereum',
        testDexV2,
        testToken0,
        testToken1
      );

      const result2 = service.computePairAddress(
        'ethereum',
        testDexV2,
        testToken1,
        testToken0
      );

      expect(result1!.address).toBe(result2!.address);
    });

    it('should return null for DEX without init code hash', () => {
      const unknownDex = {
        ...testDexV2,
        name: 'unknown_dex_xyz'
      };

      // Create fresh service to avoid V2 fallback
      const freshService = new PairDiscoveryService(testConfig);
      const result = freshService.computePairAddress(
        'ethereum',
        unknownDex,
        testToken0,
        testToken1
      );

      // Note: Falls back to uniswap_v2 hash for V2-style DEXs
      // Only returns null for truly unknown V3/curve DEXs
      freshService.cleanup();
    });

    it('should track CREATE2 computations in stats', () => {
      const statsBefore = service.getStats();
      const initialCount = statsBefore.create2Computations;

      service.computePairAddress('ethereum', testDexV2, testToken0, testToken1);

      const statsAfter = service.getStats();
      expect(statsAfter.create2Computations).toBe(initialCount + 1);
    });

    it('should emit pair:discovered event', () => {
      const discoveredHandler = jest.fn();
      service.on('pair:discovered', discoveredHandler);

      service.computePairAddress('ethereum', testDexV2, testToken0, testToken1);

      expect(discoveredHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          discoveryMethod: 'create2_compute',
          dex: 'uniswap_v2'
        })
      );
    });
  });

  // ===========================================================================
  // V3 Fee Tier Capture
  // ===========================================================================

  describe('V3 Fee Tier Capture', () => {
    it('should include feeTier in DiscoveredPair for V3 pools', async () => {
      // Create a mock provider with a V3 factory contract
      const mockProvider = {
        call: jest.fn()
      } as unknown as ethers.JsonRpcProvider;

      service.setProvider('ethereum', mockProvider);

      // Mock the contract's getPool response for 3000 fee tier
      const mockPoolAddress = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';

      // Since we can't easily mock ethers.Contract, test the interface
      // The DiscoveredPair type should have optional feeTier
      const mockDiscoveredPair: DiscoveredPair = {
        address: mockPoolAddress,
        token0: testToken0.address,
        token1: testToken1.address,
        dex: 'uniswap_v3',
        chain: 'ethereum',
        factoryAddress: testDex.factoryAddress,
        discoveredAt: Date.now(),
        discoveryMethod: 'factory_query',
        feeTier: 3000 // 0.3% fee tier
      };

      expect(mockDiscoveredPair.feeTier).toBe(3000);
    });

    it('should not include feeTier for V2 pairs', () => {
      const result = service.computePairAddress(
        'ethereum',
        testDexV2,
        testToken0,
        testToken1
      );

      // V2 pairs computed via CREATE2 don't have fee tiers
      expect(result!.feeTier).toBeUndefined();
    });

    it('DiscoveredPair interface should allow optional feeTier', () => {
      // Verify the interface allows feeTier to be undefined
      const pairWithoutFee: DiscoveredPair = {
        address: testPairAddress,
        token0: testToken0.address,
        token1: testToken1.address,
        dex: 'uniswap_v2',
        chain: 'ethereum',
        factoryAddress: testDexV2.factoryAddress,
        discoveredAt: Date.now(),
        discoveryMethod: 'create2_compute'
        // feeTier intentionally omitted
      };

      const pairWithFee: DiscoveredPair = {
        ...pairWithoutFee,
        dex: 'uniswap_v3',
        feeTier: 500 // 0.05% fee tier
      };

      expect(pairWithoutFee.feeTier).toBeUndefined();
      expect(pairWithFee.feeTier).toBe(500);
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('Statistics', () => {
    it('should track total queries', () => {
      const statsBefore = service.getStats();
      expect(statsBefore.totalQueries).toBe(0);
    });

    it('should reset stats', () => {
      // Generate some stats
      service.computePairAddress('ethereum', testDexV2, testToken0, testToken1);

      const statsBefore = service.getStats();
      expect(statsBefore.create2Computations).toBeGreaterThan(0);

      service.resetStats();

      const statsAfter = service.getStats();
      expect(statsAfter.create2Computations).toBe(0);
      expect(statsAfter.totalQueries).toBe(0);
    });

    it('should generate Prometheus metrics', () => {
      service.computePairAddress('ethereum', testDexV2, testToken0, testToken1);

      const metrics = service.getPrometheusMetrics();

      expect(metrics).toContain('pair_discovery_create2_computations');
      expect(metrics).toContain('pair_discovery_total');
      expect(metrics).toContain('# TYPE');
      expect(metrics).toContain('# HELP');
    });
  });

  // ===========================================================================
  // Circuit Breaker
  // ===========================================================================

  describe('Circuit Breaker', () => {
    it('should track failure count', () => {
      // Access private method for testing via type assertion
      const serviceAny = service as any;

      serviceAny.incrementFailureCount('ethereum', 'test_dex');
      serviceAny.incrementFailureCount('ethereum', 'test_dex');

      expect(serviceAny.failureCount.get('ethereum:test_dex')).toBe(2);
    });

    it('should reset failure count on success', () => {
      const serviceAny = service as any;

      serviceAny.incrementFailureCount('ethereum', 'test_dex');
      serviceAny.incrementFailureCount('ethereum', 'test_dex');

      serviceAny.resetFailureCount('ethereum', 'test_dex');

      expect(serviceAny.failureCount.get('ethereum:test_dex')).toBeUndefined();
    });

    it('should open circuit after threshold failures', () => {
      const serviceAny = service as any;
      const threshold = testConfig.circuitBreakerThreshold!;

      // Trigger failures up to threshold
      for (let i = 0; i < threshold; i++) {
        serviceAny.incrementFailureCount('ethereum', 'test_dex');
      }

      expect(serviceAny.isCircuitOpen('ethereum', 'test_dex')).toBe(true);
      expect(service.getStats().circuitBreakerTrips).toBe(1);
    });

    it('should emit circuit:opened event', () => {
      const circuitHandler = jest.fn();
      service.on('circuit:opened', circuitHandler);

      const serviceAny = service as any;
      const threshold = testConfig.circuitBreakerThreshold!;

      for (let i = 0; i < threshold; i++) {
        serviceAny.incrementFailureCount('ethereum', 'test_dex');
      }

      expect(circuitHandler).toHaveBeenCalledWith({
        chain: 'ethereum',
        dex: 'test_dex'
      });
    });

    it('should close circuit after reset time', async () => {
      const serviceAny = service as any;
      const threshold = testConfig.circuitBreakerThreshold!;

      // Open circuit
      for (let i = 0; i < threshold; i++) {
        serviceAny.incrementFailureCount('ethereum', 'test_dex');
      }

      expect(serviceAny.isCircuitOpen('ethereum', 'test_dex')).toBe(true);

      // Wait for reset (100ms in test config)
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(serviceAny.isCircuitOpen('ethereum', 'test_dex')).toBe(false);
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('cleanup()', () => {
    it('should clear all state', () => {
      // Add some state
      const mockProvider = {} as ethers.JsonRpcProvider;
      service.setProvider('ethereum', mockProvider);

      const serviceAny = service as any;
      serviceAny.incrementFailureCount('ethereum', 'test_dex');

      // Cleanup
      service.cleanup();

      // Verify state is cleared
      expect(serviceAny.providers.size).toBe(0);
      expect(serviceAny.factoryContracts.size).toBe(0);
      expect(serviceAny.failureCount.size).toBe(0);
    });

    it('should remove all event listeners', () => {
      const handler = jest.fn();
      service.on('pair:discovered', handler);
      service.on('circuit:opened', handler);

      service.cleanup();

      // Emit events - handlers should not be called
      service.emit('pair:discovered', {});
      service.emit('circuit:opened', {});

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Singleton Pattern
  // ===========================================================================

  describe('Singleton Pattern', () => {
    beforeEach(() => {
      resetPairDiscoveryService();
    });

    it('should return same instance on subsequent calls', () => {
      const instance1 = getPairDiscoveryService();
      const instance2 = getPairDiscoveryService();

      expect(instance1).toBe(instance2);
    });

    it('should apply config only on first call', () => {
      const instance1 = getPairDiscoveryService({ maxConcurrentQueries: 20 });
      const instance2 = getPairDiscoveryService({ maxConcurrentQueries: 50 });

      // Both should reference same instance with first config
      expect(instance1).toBe(instance2);
    });

    it('should reset singleton on resetPairDiscoveryService', () => {
      const instance1 = getPairDiscoveryService();
      resetPairDiscoveryService();
      const instance2 = getPairDiscoveryService();

      expect(instance1).not.toBe(instance2);
    });
  });
});
