/**
 * GMX Adapter Unit Tests
 *
 * Tests for vault-model DEX adapter supporting GMX spot trading.
 * GMX uses a single vault model where all tokens are swapped against the vault.
 *
 * Supported chains:
 * - Avalanche
 * - Arbitrum
 *
 * @see ADR-003: Partitioned Detector Strategy
 *
 * @migrated from shared/core/src/dex-adapters/__tests__/gmx-adapter.test.ts
 * @see ADR-009: Test Architecture
 */

import { ethers } from 'ethers';
import {
  GmxAdapter,
  AdapterConfig,
  DiscoveredPool,
  PoolReserves,
  GMX_ADDRESSES,
} from '@arbitrage/core/dex-adapters';

// =============================================================================
// Mocks
// =============================================================================

jest.mock('../../../src/logger');

// =============================================================================
// Test Fixtures
// =============================================================================

const testTokens = {
  wavax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
  usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  weth: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
  btc: '0x50b7545627a5162F82A992c33b87aDc75187B218',
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
  name: 'gmx',
  chain: 'avalanche',
  primaryAddress: GMX_ADDRESSES.avalanche.vault,
  secondaryAddress: GMX_ADDRESSES.avalanche.reader,
  provider: createMockProvider(),
  ...overrides,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('GmxAdapter', () => {
  let adapter: GmxAdapter;
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
      adapter = new GmxAdapter(config);

      expect(adapter.name).toBe('gmx');
      expect(adapter.chain).toBe('avalanche');
      expect(adapter.type).toBe('vault');
      expect(adapter.primaryAddress).toBe(GMX_ADDRESSES.avalanche.vault);
    });

    it('should support Arbitrum chain', () => {
      const config = createTestConfig({
        chain: 'arbitrum',
        primaryAddress: GMX_ADDRESSES.arbitrum.vault,
        secondaryAddress: GMX_ADDRESSES.arbitrum.reader,
      });
      adapter = new GmxAdapter(config);

      expect(adapter.chain).toBe('arbitrum');
      expect(adapter.primaryAddress).toBe(GMX_ADDRESSES.arbitrum.vault);
    });

    it('should throw if no provider supplied', () => {
      const config = createTestConfig();
      delete (config as any).provider;

      expect(() => new GmxAdapter(config)).toThrow();
    });
  });

  describe('initialize()', () => {
    it('should initialize vault and reader contracts', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new GmxAdapter(config);

      // Mock whitelistedTokenCount response
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [4]
      );
      (mockProvider.call as jest.Mock).mockResolvedValue(countResult);

      await adapter.initialize();

      expect(await adapter.isHealthy()).toBe(true);
    });

    it('should enumerate whitelisted tokens on init', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new GmxAdapter(config);

      // Mock whitelistedTokenCount
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [2]
      );

      // Mock whitelistedTokens calls
      const token0Result = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.wavax]
      );
      const token1Result = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.usdc]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(countResult) // whitelistedTokenCount
        .mockResolvedValueOnce(token0Result) // whitelistedTokens(0)
        .mockResolvedValueOnce(token1Result); // whitelistedTokens(1)

      await adapter.initialize();

      // Adapter should have cached whitelisted tokens
      const pools = await adapter.discoverPools(testTokens.wavax, testTokens.usdc);
      expect(pools).toHaveLength(1);
    });

    it('should handle initialization failure gracefully', async () => {
      const failingProvider = createMockProvider();
      (failingProvider.getBlockNumber as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      const config = createTestConfig({ provider: failingProvider });
      adapter = new GmxAdapter(config);

      await expect(adapter.initialize()).rejects.toThrow('Network error');
    });
  });

  // ===========================================================================
  // Pool Discovery
  // ===========================================================================

  describe('discoverPools()', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new GmxAdapter(config);

      // Setup mocks for initialization
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [4]
      );
      const token0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.wavax]
      );
      const token1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.usdc]
      );
      const token2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.weth]
      );
      const token3 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.btc]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(countResult)
        .mockResolvedValueOnce(token0)
        .mockResolvedValueOnce(token1)
        .mockResolvedValueOnce(token2)
        .mockResolvedValueOnce(token3);

      await adapter.initialize();
    });

    it('should return vault as pool when both tokens are whitelisted', async () => {
      const pools = await adapter.discoverPools(testTokens.wavax, testTokens.usdc);

      expect(pools).toHaveLength(1);
      expect(pools[0].address).toBe(GMX_ADDRESSES.avalanche.vault);
      expect(pools[0].dex).toBe('gmx');
      expect(pools[0].chain).toBe('avalanche');
      expect(pools[0].poolType).toBe('gmx_spot');
    });

    it('should return empty array when token not whitelisted', async () => {
      const nonWhitelistedToken = '0x0000000000000000000000000000000000000001';
      const pools = await adapter.discoverPools(testTokens.wavax, nonWhitelistedToken);

      expect(pools).toHaveLength(0);
    });

    it('should include both tokens in discovered pool', async () => {
      const pools = await adapter.discoverPools(testTokens.wavax, testTokens.usdc);

      expect(pools[0].tokens).toContain(testTokens.wavax.toLowerCase());
      expect(pools[0].tokens).toContain(testTokens.usdc.toLowerCase());
    });

    it('should normalize token addresses', async () => {
      const pools = await adapter.discoverPools(
        testTokens.wavax.toUpperCase(),
        testTokens.usdc.toLowerCase()
      );

      expect(pools[0].tokens).toContain(testTokens.wavax.toLowerCase());
      expect(pools[0].tokens).toContain(testTokens.usdc.toLowerCase());
    });
  });

  // ===========================================================================
  // Pool Reserves
  // ===========================================================================

  describe('getPoolReserves()', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new GmxAdapter(config);

      // Setup init mocks
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [2]
      );
      const token0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.wavax]
      );
      const token1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.usdc]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(countResult)
        .mockResolvedValueOnce(token0)
        .mockResolvedValueOnce(token1);

      await adapter.initialize();
    });

    it('should fetch pool amounts for whitelisted tokens', async () => {
      // Mock poolAmounts calls
      const amount0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('1000000000000000000000')] // 1000 WAVAX
      );
      const amount1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('5000000000')] // 5000 USDC (6 decimals)
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(amount0)
        .mockResolvedValueOnce(amount1);

      const reserves = await adapter.getPoolReserves(GMX_ADDRESSES.avalanche.vault);

      expect(reserves).not.toBeNull();
      expect(reserves!.tokens).toHaveLength(2);
      expect(reserves!.balances).toHaveLength(2);
      expect(reserves!.balances[0]).toBe(BigInt('1000000000000000000000'));
    });

    it('should return null for invalid pool ID', async () => {
      const reserves = await adapter.getPoolReserves('0xinvalid');

      expect(reserves).toBeNull();
    });

    it('should include block number in reserves', async () => {
      const amount0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('1000000000000000000000')]
      );
      const amount1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('5000000000')]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(amount0)
        .mockResolvedValueOnce(amount1);

      const reserves = await adapter.getPoolReserves(GMX_ADDRESSES.avalanche.vault);

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
      adapter = new GmxAdapter(config);

      // Setup init mocks
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [2]
      );
      const token0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.wavax]
      );
      const token1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.usdc]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(countResult)
        .mockResolvedValueOnce(token0)
        .mockResolvedValueOnce(token1);

      await adapter.initialize();
    });

    it('should use Reader contract for swap quotes', async () => {
      // Mock Reader.getAmountOut response
      const amountOutResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [BigInt('100000000'), BigInt('30000')] // amountOut, feeAmount
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(amountOutResult);

      const quote = await adapter.getSwapQuote!(
        GMX_ADDRESSES.avalanche.vault,
        testTokens.wavax,
        testTokens.usdc,
        BigInt('1000000000000000000') // 1 WAVAX
      );

      expect(quote).not.toBeNull();
      expect(quote!.amountOut).toBe(BigInt('100000000'));
      expect(quote!.feeAmount).toBe(BigInt('30000'));
    });

    it('should return null for non-whitelisted tokens', async () => {
      const quote = await adapter.getSwapQuote!(
        GMX_ADDRESSES.avalanche.vault,
        '0x0000000000000000000000000000000000000001',
        testTokens.usdc,
        BigInt('1000000000000000000')
      );

      expect(quote).toBeNull();
    });

    // P1-14: Edge case tests for zero amounts
    it('should handle zero amountIn gracefully', async () => {
      // Mock Reader.getAmountOut response for zero input
      const amountOutResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [0n, 0n]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(amountOutResult);

      const quote = await adapter.getSwapQuote!(
        GMX_ADDRESSES.avalanche.vault,
        testTokens.wavax,
        testTokens.usdc,
        0n
      );

      // Should return a valid quote with zero output, not throw
      expect(quote).not.toBeNull();
      expect(quote!.amountOut).toBe(0n);
    });

    // P1-3: Regression test for division by zero in estimateSwapQuote
    it('should return null when maxPriceOut is zero (fallback path)', async () => {
      // Create adapter without reader contract to force fallback path
      const noReaderConfig = createTestConfig({
        provider: mockProvider,
        secondaryAddress: undefined,
      });
      const noReaderAdapter = new GmxAdapter(noReaderConfig);

      // Setup init mocks
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [2]
      );
      const token0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.wavax]
      );
      const token1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.usdc]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(countResult)
        .mockResolvedValueOnce(token0)
        .mockResolvedValueOnce(token1);

      await noReaderAdapter.initialize();

      // Mock getMinPrice and getMaxPrice — maxPriceOut = 0 (oracle failure)
      const minPriceResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [BigInt('30000000000000000000000000000000')] // $30 in 30-decimal GMX price format
      );
      const maxPriceZero = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [0n]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(minPriceResult) // getMinPrice
        .mockResolvedValueOnce(maxPriceZero); // getMaxPrice returns 0

      const quote = await noReaderAdapter.getSwapQuote!(
        GMX_ADDRESSES.avalanche.vault,
        testTokens.wavax,
        testTokens.usdc,
        BigInt('1000000000000000000')
      );

      // Should return null, not throw division by zero
      expect(quote).toBeNull();

      await noReaderAdapter.destroy();
    });
  });

  // ===========================================================================
  // Health Check
  // ===========================================================================

  describe('isHealthy()', () => {
    it('should return true when vault is reachable', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new GmxAdapter(config);

      // Setup init mocks
      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [2]
      );
      const token0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.wavax]
      );
      const token1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.usdc]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(countResult)
        .mockResolvedValueOnce(token0)
        .mockResolvedValueOnce(token1);

      await adapter.initialize();

      const healthy = await adapter.isHealthy();
      expect(healthy).toBe(true);
    });

    it('should return false when vault is unreachable', async () => {
      const failingProvider = createMockProvider();
      (failingProvider.call as jest.Mock).mockRejectedValue(
        new Error('Connection refused')
      );
      (failingProvider.getBlockNumber as jest.Mock).mockRejectedValue(
        new Error('Connection refused')
      );

      const config = createTestConfig({ provider: failingProvider });
      adapter = new GmxAdapter(config);

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
      adapter = new GmxAdapter(config);

      const countResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256'],
        [2]
      );
      const token0 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.wavax]
      );
      const token1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [testTokens.usdc]
      );

      (mockProvider.call as jest.Mock)
        .mockResolvedValueOnce(countResult)
        .mockResolvedValueOnce(token0)
        .mockResolvedValueOnce(token1);

      await adapter.initialize();
      await adapter.destroy();

      // After destroy, discoverPools should return empty
      const pools = await adapter.discoverPools(testTokens.wavax, testTokens.usdc);
      expect(pools).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Multi-Chain Support
  // ===========================================================================

  describe('Multi-Chain Support', () => {
    it.each([
      ['avalanche', GMX_ADDRESSES.avalanche.vault, GMX_ADDRESSES.avalanche.reader],
      ['arbitrum', GMX_ADDRESSES.arbitrum.vault, GMX_ADDRESSES.arbitrum.reader],
    ])(
      'should support %s chain',
      async (chain, expectedVault, expectedReader) => {
        const config = createTestConfig({
          chain,
          primaryAddress: expectedVault,
          secondaryAddress: expectedReader,
        });
        adapter = new GmxAdapter(config);

        expect(adapter.chain).toBe(chain);
        expect(adapter.primaryAddress).toBe(expectedVault);
      }
    );
  });
});
