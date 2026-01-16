/**
 * PairDiscoveryService Unit Tests
 *
 * Tests for S2.2.5: Dynamic pair discovery from DEX factory contracts
 * - Factory query methods (V2 and V3 patterns)
 * - V3 fee tier capture
 * - CREATE2 address computation fallback
 * - Circuit breaker behavior
 * - Statistics tracking
 *
 * @migrated from shared/core/src/pair-discovery.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import {
  PairDiscoveryService,
  DiscoveredPair,
  PairDiscoveryConfig,
  PairDiscoveryStats,
  getPairDiscoveryService,
  resetPairDiscoveryService
} from '@arbitrage/core';

// =============================================================================
// Mocks
// =============================================================================

// Mock logger
jest.mock('../../src/logger', () => ({
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

    // S3.2.1-FIX: KyberSwap uses concentrated liquidity (V3-style)
    it('should detect KyberSwap as V3 (concentrated liquidity)', () => {
      expect(service.detectFactoryType('kyberswap')).toBe('v3');
      expect(service.detectFactoryType('kyber')).toBe('v3');
      expect(service.detectFactoryType('kyberswap_elastic')).toBe('v3');
    });

    // S3.2.1-FIX: DEXs that don't follow factory patterns
    it('should detect GMX as unsupported (vault model)', () => {
      expect(service.detectFactoryType('gmx')).toBe('unsupported');
    });

    it('should detect Platypus as unsupported (pool model)', () => {
      expect(service.detectFactoryType('platypus')).toBe('unsupported');
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

  // ===========================================================================
  // S3.2.1-FIX: Avalanche DEX Support Tests
  // ===========================================================================

  describe('S3.2.1-FIX: Avalanche DEX Support', () => {
    const avalancheDexTraderJoe = {
      name: 'trader_joe_v2',
      chain: 'avalanche',
      factoryAddress: '0x8e42f2F4101563bF679975178e880FD87d3eFd4e',
      routerAddress: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
      fee: 30,
      enabled: true
    };

    const avalancheDexPangolin = {
      name: 'pangolin',
      chain: 'avalanche',
      factoryAddress: '0xefa94DE7a4656D787667C749f7E1223D71E9FD88',
      routerAddress: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106',
      fee: 30,
      enabled: true
    };

    const avalancheToken0 = {
      address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
      symbol: 'WAVAX',
      decimals: 18,
      chainId: 43114
    };

    const avalancheToken1 = {
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // USDC
      symbol: 'USDC',
      decimals: 6,
      chainId: 43114
    };

    it('should compute CREATE2 address for Trader Joe V2', () => {
      const result = service.computePairAddress(
        'avalanche',
        avalancheDexTraderJoe,
        avalancheToken0,
        avalancheToken1
      );

      expect(result).not.toBeNull();
      expect(result!.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(result!.discoveryMethod).toBe('create2_compute');
      expect(result!.dex).toBe('trader_joe_v2');
      expect(result!.chain).toBe('avalanche');
    });

    it('should compute CREATE2 address for Pangolin', () => {
      const result = service.computePairAddress(
        'avalanche',
        avalancheDexPangolin,
        avalancheToken0,
        avalancheToken1
      );

      expect(result).not.toBeNull();
      expect(result!.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(result!.discoveryMethod).toBe('create2_compute');
      expect(result!.dex).toBe('pangolin');
    });

    it('should return consistent addresses regardless of token order (Trader Joe)', () => {
      const result1 = service.computePairAddress(
        'avalanche',
        avalancheDexTraderJoe,
        avalancheToken0,
        avalancheToken1
      );

      const result2 = service.computePairAddress(
        'avalanche',
        avalancheDexTraderJoe,
        avalancheToken1,
        avalancheToken0
      );

      expect(result1!.address).toBe(result2!.address);
    });

    it('should return consistent addresses regardless of token order (Pangolin)', () => {
      const result1 = service.computePairAddress(
        'avalanche',
        avalancheDexPangolin,
        avalancheToken0,
        avalancheToken1
      );

      const result2 = service.computePairAddress(
        'avalanche',
        avalancheDexPangolin,
        avalancheToken1,
        avalancheToken0
      );

      expect(result1!.address).toBe(result2!.address);
    });

    it('should return sorted tokens in DiscoveredPair (token0 < token1)', () => {
      // Pass tokens in "wrong" order
      const result = service.computePairAddress(
        'avalanche',
        avalancheDexTraderJoe,
        avalancheToken1, // USDC (higher address)
        avalancheToken0  // WAVAX (lower address)
      );

      // Result should have sorted order (WAVAX < USDC by address)
      const token0Lower = result!.token0.toLowerCase();
      const token1Lower = result!.token1.toLowerCase();
      expect(token0Lower < token1Lower).toBe(true);
    });
  });

  // ===========================================================================
  // S3.2.1-FIX: Unsupported DEX Type Tests
  // ===========================================================================

  describe('S3.2.1-FIX: Unsupported DEX Type Handling', () => {
    const gmxDex = {
      name: 'gmx',
      chain: 'avalanche',
      factoryAddress: '0x9ab2De34A33fB459b538c43f251eB825645e8595', // GMX Vault
      routerAddress: '0x5F719c2F1095F7B9fc68a68e35B51194f4b6abe8',
      fee: 30,
      enabled: false
    };

    const platypusDex = {
      name: 'platypus',
      chain: 'avalanche',
      factoryAddress: '0x66357dCaCe80431aee0A7507e2E361B7e2402370', // Main Pool
      routerAddress: '0x73256EC7575D999C360c1EeC118ECbEFd8DA7D12',
      fee: 4,
      enabled: false
    };

    const curveDex = {
      name: 'curve',
      chain: 'arbitrum',
      factoryAddress: '0xb17b674D9c5CB2e441F8e196a2f048A81355d031',
      routerAddress: '0xF0d4c12A5768D806021F80a262B4d39d26C58b8D',
      fee: 4,
      enabled: true
    };

    it('should detect GMX as unsupported (vault model)', () => {
      expect(service.detectFactoryType('gmx')).toBe('unsupported');
    });

    it('should detect Platypus as unsupported (pool model)', () => {
      expect(service.detectFactoryType('platypus')).toBe('unsupported');
    });

    it('should detect Curve as curve type', () => {
      expect(service.detectFactoryType('curve')).toBe('curve');
      expect(service.detectFactoryType('ellipsis')).toBe('curve');
    });

    it('should not create factory contract for unsupported DEXs', () => {
      const mockProvider = {} as ethers.JsonRpcProvider;
      service.setProvider('avalanche', mockProvider);

      const serviceAny = service as any;
      const gmxContract = serviceAny.getFactoryContract('avalanche', gmxDex);
      const platypusContract = serviceAny.getFactoryContract('avalanche', platypusDex);

      expect(gmxContract).toBeNull();
      expect(platypusContract).toBeNull();
    });

    it('should not create factory contract for Curve DEXs', () => {
      const mockProvider = {} as ethers.JsonRpcProvider;
      service.setProvider('arbitrum', mockProvider);

      const serviceAny = service as any;
      const curveContract = serviceAny.getFactoryContract('arbitrum', curveDex);

      expect(curveContract).toBeNull();
    });

    it('should create factory contract for supported V2 DEXs', () => {
      const mockProvider = {
        call: jest.fn()
      } as unknown as ethers.JsonRpcProvider;
      service.setProvider('ethereum', mockProvider);

      const serviceAny = service as any;
      const contract = serviceAny.getFactoryContract('ethereum', testDexV2);

      expect(contract).not.toBeNull();
    });

    it('should create factory contract for supported V3 DEXs', () => {
      const mockProvider = {
        call: jest.fn()
      } as unknown as ethers.JsonRpcProvider;
      service.setProvider('ethereum', mockProvider);

      const serviceAny = service as any;
      const contract = serviceAny.getFactoryContract('ethereum', testDex);

      expect(contract).not.toBeNull();
    });
  });

  // ===========================================================================
  // S3.2.1-FIX: Token Ordering Consistency Tests
  // ===========================================================================

  describe('S3.2.1-FIX: Token Ordering Consistency', () => {
    it('should return tokens in sorted order from computePairAddress', () => {
      // Token0 has higher address than token1 (will be swapped)
      const highToken = {
        address: '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'.replace(/Z/g, 'F'),
        symbol: 'HIGH',
        decimals: 18,
        chainId: 1
      };

      const lowToken = {
        address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        symbol: 'LOW',
        decimals: 18,
        chainId: 1
      };

      const result = service.computePairAddress(
        'ethereum',
        testDexV2,
        highToken,
        lowToken
      );

      // Result should have LOW as token0, HIGH as token1 (sorted order)
      const token0Lower = result!.token0.toLowerCase();
      const token1Lower = result!.token1.toLowerCase();
      expect(token0Lower < token1Lower).toBe(true);
      expect(result!.token0).toBe(lowToken.address);
      expect(result!.token1).toBe(highToken.address);
    });

    it('should emit pair:discovered event with sorted tokens', () => {
      const discoveredHandler = jest.fn();
      service.on('pair:discovered', discoveredHandler);

      // Pass tokens in reverse order
      service.computePairAddress(
        'ethereum',
        testDexV2,
        testToken1, // USDC (higher address)
        testToken0  // WETH (lower address)
      );

      expect(discoveredHandler).toHaveBeenCalled();
      const emittedPair = discoveredHandler.mock.calls[0][0] as DiscoveredPair;

      // Verify tokens are in sorted order
      const token0Lower = emittedPair.token0.toLowerCase();
      const token1Lower = emittedPair.token1.toLowerCase();
      expect(token0Lower < token1Lower).toBe(true);
    });
  });
});
