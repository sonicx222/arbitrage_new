/**
 * Platypus Adapter Unit Tests
 *
 * Tests for pool-model DEX adapter supporting Platypus stablecoin swaps.
 * Platypus uses a single-sided liquidity model optimized for stablecoins.
 *
 * Supported chains:
 * - Avalanche
 *
 * @see ADR-003: Partitioned Detector Strategy
 *
 * @migrated from shared/core/src/dex-adapters/__tests__/platypus-adapter.test.ts
 * @see ADR-009: Test Architecture
 */

import { ethers } from 'ethers';
import {
  PlatypusAdapter,
  AdapterConfig,
  DiscoveredPool,
  PoolReserves,
  PLATYPUS_ADDRESSES,
} from '@arbitrage/core';

// =============================================================================
// Mocks
// =============================================================================

jest.mock('../../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// =============================================================================
// Test Fixtures
// =============================================================================

const testTokens = {
  usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  usdt: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
  dai: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
  mim: '0x130966628846BFd36ff31a822705796e8cb8C18D',
};

// Mock asset addresses (Platypus wraps tokens in Asset contracts)
const testAssets = {
  usdc: '0x1234567890123456789012345678901234567890',
  usdt: '0x2345678901234567890123456789012345678901',
  dai: '0x3456789012345678901234567890123456789012',
};

const createMockProvider = () => {
  const mockCall = jest.fn();
  const mockGetBlockNumber = jest.fn().mockResolvedValue(12345678);

  return {
    call: mockCall,
    getBlockNumber: mockGetBlockNumber,
    resolveName: jest.fn().mockResolvedValue(null),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 43114n }),
    _isProvider: true,
  } as unknown as ethers.JsonRpcProvider;
};

const createTestConfig = (
  overrides: Partial<AdapterConfig> = {}
): AdapterConfig => ({
  name: 'platypus',
  chain: 'avalanche',
  primaryAddress: PLATYPUS_ADDRESSES.avalanche.pool,
  secondaryAddress: PLATYPUS_ADDRESSES.avalanche.router,
  provider: createMockProvider(),
  ...overrides,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('PlatypusAdapter', () => {
  let adapter: PlatypusAdapter;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProvider = createMockProvider();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.destroy();
    }
  });

  // ===========================================================================
  // Constructor & Initialization
  // ===========================================================================

  describe('constructor', () => {
    it('should create adapter with correct properties', () => {
      const config = createTestConfig();
      adapter = new PlatypusAdapter(config);

      expect(adapter.name).toBe('platypus');
      expect(adapter.chain).toBe('avalanche');
      expect(adapter.type).toBe('pool');
      expect(adapter.primaryAddress).toBe(PLATYPUS_ADDRESSES.avalanche.pool);
    });

    it('should throw if no provider supplied', () => {
      const config = createTestConfig();
      delete (config as any).provider;

      expect(() => new PlatypusAdapter(config)).toThrow();
    });
  });

  describe('initialize()', () => {
    it('should initialize pool contract', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      // Mock getTokenAddresses response
      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt, testTokens.dai]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();

      expect(await adapter.isHealthy()).toBe(true);
    });

    it('should load supported tokens on init', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();

      // After init, should be able to discover pools for supported tokens
      const pools = await adapter.discoverPools(testTokens.usdc, testTokens.usdt);
      expect(pools).toHaveLength(1);
    });

    it('should handle initialization failure gracefully', async () => {
      const failingProvider = createMockProvider();
      (failingProvider.getBlockNumber as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      const config = createTestConfig({ provider: failingProvider });
      adapter = new PlatypusAdapter(config);

      await expect(adapter.initialize()).rejects.toThrow('Network error');
    });
  });

  // ===========================================================================
  // Pool Discovery
  // ===========================================================================

  describe('discoverPools()', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      // Setup init mocks
      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt, testTokens.dai]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();
    });

    it('should return pool when both tokens are supported', async () => {
      const pools = await adapter.discoverPools(testTokens.usdc, testTokens.usdt);

      expect(pools).toHaveLength(1);
      expect(pools[0].address).toBe(PLATYPUS_ADDRESSES.avalanche.pool);
      expect(pools[0].dex).toBe('platypus');
      expect(pools[0].chain).toBe('avalanche');
      expect(pools[0].poolType).toBe('stable');
    });

    it('should return empty array when token not supported', async () => {
      const nonSupportedToken = '0x0000000000000000000000000000000000000001';
      const pools = await adapter.discoverPools(testTokens.usdc, nonSupportedToken);

      expect(pools).toHaveLength(0);
    });

    it('should include both tokens in discovered pool', async () => {
      const pools = await adapter.discoverPools(testTokens.usdc, testTokens.usdt);

      expect(pools[0].tokens).toContain(testTokens.usdc.toLowerCase());
      expect(pools[0].tokens).toContain(testTokens.usdt.toLowerCase());
    });

    it('should normalize token addresses', async () => {
      const pools = await adapter.discoverPools(
        testTokens.usdc.toUpperCase(),
        testTokens.usdt.toLowerCase()
      );

      expect(pools[0].tokens).toContain(testTokens.usdc.toLowerCase());
      expect(pools[0].tokens).toContain(testTokens.usdt.toLowerCase());
    });
  });

  // ===========================================================================
  // Pool Reserves
  // ===========================================================================

  describe('getPoolReserves()', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      // Setup init mocks
      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();
    });

    it('should fetch cash for each token', async () => {
      // Mock getCash calls
      const cash0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('1000000000000')] // 1M USDC (6 decimals)
      );
      const cash1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('500000000000')] // 500K USDT (6 decimals)
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(cash0)
        .mockResolvedValueOnce(cash1);

      const reserves = await adapter.getPoolReserves(
        PLATYPUS_ADDRESSES.avalanche.pool
      );

      expect(reserves).not.toBeNull();
      expect(reserves!.tokens).toHaveLength(2);
      expect(reserves!.balances).toHaveLength(2);
      expect(reserves!.balances[0]).toBe(BigInt('1000000000000'));
    });

    it('should return null for invalid pool ID', async () => {
      const reserves = await adapter.getPoolReserves('0xinvalid');

      expect(reserves).toBeNull();
    });

    it('should include block number in reserves', async () => {
      const cash0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('1000000000000')]
      );
      const cash1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('500000000000')]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(cash0)
        .mockResolvedValueOnce(cash1);

      const reserves = await adapter.getPoolReserves(
        PLATYPUS_ADDRESSES.avalanche.pool
      );

      expect(reserves!.blockNumber).toBe(12345678);
      expect(reserves!.timestamp).toBeDefined();
    });
  });

  // ===========================================================================
  // Swap Quotes
  // ===========================================================================

  describe('getSwapQuote()', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();
    });

    it('should use quotePotentialSwap for quotes', async () => {
      // Mock quotePotentialSwap response
      const quoteResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [BigInt('99900000'), BigInt('100000')] // potentialOutcome, haircut
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(quoteResult);

      const quote = await adapter.getSwapQuote!(
        PLATYPUS_ADDRESSES.avalanche.pool,
        testTokens.usdc,
        testTokens.usdt,
        BigInt('100000000') // 100 USDC
      );

      expect(quote).not.toBeNull();
      expect(quote!.amountOut).toBe(BigInt('99900000'));
      expect(quote!.feeAmount).toBe(BigInt('100000'));
    });

    it('should return null for unsupported tokens', async () => {
      const quote = await adapter.getSwapQuote!(
        PLATYPUS_ADDRESSES.avalanche.pool,
        '0x0000000000000000000000000000000000000001',
        testTokens.usdt,
        BigInt('100000000')
      );

      expect(quote).toBeNull();
    });

    it('should calculate low price impact for stable swaps', async () => {
      const quoteResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [BigInt('99900000'), BigInt('100000')]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(quoteResult);

      const quote = await adapter.getSwapQuote!(
        PLATYPUS_ADDRESSES.avalanche.pool,
        testTokens.usdc,
        testTokens.usdt,
        BigInt('100000000')
      );

      // Stablecoin swaps should have minimal price impact
      expect(quote!.priceImpact).toBeLessThan(0.01); // < 1%
    });

    // P1-14: Edge case tests for zero amounts
    it('should handle zero amountIn gracefully', async () => {
      // Mock quotePotentialSwap for zero input
      const quoteResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [0n, 0n]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(quoteResult);

      const quote = await adapter.getSwapQuote!(
        PLATYPUS_ADDRESSES.avalanche.pool,
        testTokens.usdc,
        testTokens.usdt,
        0n
      );

      // Should return valid quote with zero output, not throw
      expect(quote).not.toBeNull();
      expect(quote!.amountOut).toBe(0n);
      expect(quote!.priceImpact).toBe(0); // grossOutput is 0, so priceImpact = 0
    });

    // P1-7: Regression test for cross-decimal price impact
    it('should compute decimal-independent price impact', async () => {
      // Simulate USDC (6 dec) -> DAI (18 dec) swap
      // amountIn = 100 USDC (raw: 100_000_000)
      // amountOut = ~99.9 DAI (raw: 99_900_000_000_000_000_000)
      // feeAmount = ~0.1 DAI (raw: 100_000_000_000_000_000)
      const quoteResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [
          BigInt('99900000000000000000'), // potentialOutcome in DAI (18 dec)
          BigInt('100000000000000000'),   // haircut in DAI (18 dec)
        ]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(quoteResult);

      const quote = await adapter.getSwapQuote!(
        PLATYPUS_ADDRESSES.avalanche.pool,
        testTokens.usdc,
        testTokens.usdt, // pretend this is DAI with 18 dec for this test
        BigInt('100000000') // 100 USDC (6 dec)
      );

      expect(quote).not.toBeNull();
      // Price impact should be fee / grossOutput = 0.1/100 = 0.001 (0.1%)
      // NOT the old broken value which compared raw 100e6 vs 99.9e18
      expect(quote!.priceImpact).toBeCloseTo(0.001, 4);
      expect(quote!.priceImpact).toBeLessThan(0.01); // Must be < 1%
    });
  });

  // ===========================================================================
  // Health Check
  // ===========================================================================

  describe('isHealthy()', () => {
    it('should return true when pool is reachable', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();

      const healthy = await adapter.isHealthy();
      expect(healthy).toBe(true);
    });

    it('should return false when pool is unreachable', async () => {
      const failingProvider = createMockProvider();
      (failingProvider.call as jest.Mock).mockRejectedValue(
        new Error('Connection refused')
      );
      (failingProvider.getBlockNumber as jest.Mock).mockRejectedValue(
        new Error('Connection refused')
      );

      const config = createTestConfig({ provider: failingProvider });
      adapter = new PlatypusAdapter(config);

      try {
        await adapter.initialize();
      } catch {
        // Expected
      }

      const healthy = await adapter.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('destroy()', () => {
    it('should clean up resources', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();
      await adapter.destroy();

      // After destroy, discoverPools should return empty
      const pools = await adapter.discoverPools(testTokens.usdc, testTokens.usdt);
      expect(pools).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Fee Handling
  // ===========================================================================

  describe('Fee Handling', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new PlatypusAdapter(config);

      const tokensResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [[testTokens.usdc, testTokens.usdt]]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(tokensResult);

      await adapter.initialize();
    });

    it('should use low swap fee for stablecoin pool', async () => {
      const pools = await adapter.discoverPools(testTokens.usdc, testTokens.usdt);

      // Platypus has very low fees (typically 1-4 basis points)
      expect(pools[0].swapFee).toBeLessThanOrEqual(10);
    });
  });
});
