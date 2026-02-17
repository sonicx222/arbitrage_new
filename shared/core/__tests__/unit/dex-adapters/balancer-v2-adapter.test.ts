/**
 * Balancer V2 Adapter Unit Tests
 *
 * Tests for vault-model DEX adapter supporting:
 * - Balancer V2 (Arbitrum, Ethereum, Polygon, Optimism, Base)
 * - Beethoven X (Fantom - same interface)
 *
 * @see ADR-003: Partitioned Detector Strategy
 *
 * @migrated from shared/core/src/dex-adapters/__tests__/balancer-v2-adapter.test.ts
 * @see ADR-009: Test Architecture
 */

import { ethers } from 'ethers';
import {
  BalancerV2Adapter,
  AdapterConfig,
  DiscoveredPool,
  PoolReserves,
  SwapQuote,
  BALANCER_VAULT_ADDRESSES,
  BALANCER_VAULT_ABI,
} from '@arbitrage/core';

// =============================================================================
// Mocks
// =============================================================================

jest.mock('../../../src/logger');

// Mock fetch for subgraph queries
const mockFetch = jest.fn();
global.fetch = mockFetch;

// =============================================================================
// Test Fixtures
// =============================================================================

const testPoolId =
  '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014';
const testPoolAddress = '0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56';

const testTokens = {
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  bal: '0xba100000625a3754423978a60c9317c58a424e3D',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

const testBalances = [
  BigInt('1000000000000000000000'), // 1000 WETH
  BigInt('5000000000000000000000'), // 5000 BAL
];

const createMockProvider = () => {
  const mockCall = jest.fn();
  const mockGetBlockNumber = jest.fn().mockResolvedValue(12345678);

  return {
    call: mockCall,
    getBlockNumber: mockGetBlockNumber,
    // For ethers contract interactions
    resolveName: jest.fn().mockResolvedValue(null),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
    _isProvider: true,
  } as unknown as ethers.JsonRpcProvider;
};

const createTestConfig = (
  overrides: Partial<AdapterConfig> = {}
): AdapterConfig => ({
  name: 'balancer_v2',
  chain: 'arbitrum',
  primaryAddress: BALANCER_VAULT_ADDRESSES.arbitrum,
  provider: createMockProvider(),
  subgraphUrl:
    'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2',
  ...overrides,
});

// Mock subgraph response with decimals and weights (Fix #15)
const mockSubgraphPoolsResponse = {
  data: {
    pools: [
      {
        id: testPoolId,
        address: testPoolAddress,
        poolType: 'Weighted',
        swapFee: '0.003',
        tokens: [
          { address: testTokens.weth, balance: '1000', decimals: 18, weight: '0.8' },
          { address: testTokens.bal, balance: '5000', decimals: 18, weight: '0.2' },
        ],
      },
    ],
  },
};

// =============================================================================
// Test Suite
// =============================================================================

describe('BalancerV2Adapter', () => {
  let adapter: BalancerV2Adapter;
  let mockProvider: ethers.JsonRpcProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
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
      adapter = new BalancerV2Adapter(config);

      expect(adapter.name).toBe('balancer_v2');
      expect(adapter.chain).toBe('arbitrum');
      expect(adapter.type).toBe('vault');
      expect(adapter.primaryAddress).toBe(BALANCER_VAULT_ADDRESSES.arbitrum);
    });

    it('should support Beethoven X on Fantom', () => {
      const config = createTestConfig({
        name: 'beethoven_x',
        chain: 'fantom',
        primaryAddress: BALANCER_VAULT_ADDRESSES.fantom,
      });
      adapter = new BalancerV2Adapter(config);

      expect(adapter.name).toBe('beethoven_x');
      expect(adapter.chain).toBe('fantom');
      expect(adapter.primaryAddress).toBe(BALANCER_VAULT_ADDRESSES.fantom);
    });

    it('should throw if no provider supplied', () => {
      const config = createTestConfig();
      delete (config as any).provider;

      expect(() => new BalancerV2Adapter(config)).toThrow();
    });
  });

  describe('initialize()', () => {
    it('should initialize vault contract', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);

      await adapter.initialize();

      // Adapter should be ready to use
      expect(await adapter.isHealthy()).toBe(true);
    });

    it('should handle initialization failure gracefully', async () => {
      const failingProvider = createMockProvider();
      (failingProvider.getBlockNumber as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      const config = createTestConfig({ provider: failingProvider });
      adapter = new BalancerV2Adapter(config);

      await expect(adapter.initialize()).rejects.toThrow('Network error');
    });
  });

  // ===========================================================================
  // Pool Discovery
  // ===========================================================================

  describe('discoverPools()', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
    });

    it('should discover pools via subgraph for token pair', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSubgraphPoolsResponse),
      });

      const pools = await adapter.discoverPools(testTokens.weth, testTokens.bal);

      expect(pools).toHaveLength(1);
      expect(pools[0].poolId).toBe(testPoolId);
      expect(pools[0].address).toBe(testPoolAddress);
      expect(pools[0].tokens).toContain(testTokens.weth.toLowerCase());
      expect(pools[0].tokens).toContain(testTokens.bal.toLowerCase());
      expect(pools[0].dex).toBe('balancer_v2');
      expect(pools[0].chain).toBe('arbitrum');
    });

    it('should return empty array when no pools found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { pools: [] } }),
      });

      const pools = await adapter.discoverPools(
        testTokens.weth,
        '0x0000000000000000000000000000000000000001'
      );

      expect(pools).toHaveLength(0);
    });

    it('should handle subgraph errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Subgraph unavailable'));

      const pools = await adapter.discoverPools(testTokens.weth, testTokens.bal);

      // Should return empty array on error, not throw
      expect(pools).toHaveLength(0);
    });

    it('should normalize token addresses to lowercase', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSubgraphPoolsResponse),
      });

      const pools = await adapter.discoverPools(
        testTokens.weth.toUpperCase(),
        testTokens.bal.toLowerCase()
      );

      expect(pools).toHaveLength(1);
      // Verify tokens are normalized
      pools[0].tokens.forEach((token) => {
        expect(token).toBe(token.toLowerCase());
      });
    });

    it('should filter pools by token pair correctly', async () => {
      const multiPoolResponse = {
        data: {
          pools: [
            {
              id: testPoolId,
              address: testPoolAddress,
              poolType: 'Weighted',
              swapFee: '0.003',
              tokens: [
                { address: testTokens.weth, balance: '1000', decimals: 18, weight: '0.8' },
                { address: testTokens.bal, balance: '5000', decimals: 18, weight: '0.2' },
              ],
            },
            {
              id: '0xother_pool_id',
              address: '0xOtherPoolAddress',
              poolType: 'Stable',
              swapFee: '0.0004',
              tokens: [
                { address: testTokens.usdc, balance: '1000000', decimals: 6 },
                { address: '0xdai_address', balance: '1000000', decimals: 18 },
              ],
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(multiPoolResponse),
      });

      const pools = await adapter.discoverPools(testTokens.weth, testTokens.bal);

      expect(pools).toHaveLength(1);
      expect(pools[0].poolId).toBe(testPoolId);
    });

    it('should include pool type in discovered pools', async () => {
      // Use valid hex address (DAI on Ethereum)
      const daiAddress = '0xd586e7f844cea2f87f50152665bcbc2c279d8d70';
      const stablePoolResponse = {
        data: {
          pools: [
            {
              id: '0xstable_pool_id_00000000000000000000000000000014',
              address: '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56',
              poolType: 'ComposableStable',
              swapFee: '0.0001',
              tokens: [
                { address: testTokens.usdc, balance: '1000000', decimals: 6 },
                { address: daiAddress, balance: '1000000', decimals: 18 },
              ],
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(stablePoolResponse),
      });

      const pools = await adapter.discoverPools(
        testTokens.usdc,
        daiAddress
      );

      expect(pools[0].poolType).toBe('composable_stable');
    });
  });

  // ===========================================================================
  // Pool Reserves
  // ===========================================================================

  describe('getPoolReserves()', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
    });

    it('should fetch pool reserves from vault contract', async () => {
      // Mock the vault.getPoolTokens call result
      const mockResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]', 'uint256[]', 'uint256'],
        [
          [testTokens.weth, testTokens.bal],
          testBalances,
          12345000, // lastChangeBlock
        ]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(mockResult);

      const reserves = await adapter.getPoolReserves(testPoolId);

      expect(reserves).not.toBeNull();
      expect(reserves!.poolId).toBe(testPoolId);
      expect(reserves!.tokens).toHaveLength(2);
      expect(reserves!.balances).toHaveLength(2);
      expect(reserves!.balances[0]).toBe(testBalances[0]);
      expect(reserves!.balances[1]).toBe(testBalances[1]);
    });

    it('should return null for invalid pool ID', async () => {
      (mockProvider.call as jest.Mock).mockRejectedValueOnce(
        new Error('Invalid poolId')
      );

      const reserves = await adapter.getPoolReserves('0xinvalid');

      expect(reserves).toBeNull();
    });

    it('should include block number in reserves', async () => {
      const mockResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]', 'uint256[]', 'uint256'],
        [[testTokens.weth, testTokens.bal], testBalances, 12345000]
      );

      (mockProvider.call as jest.Mock).mockResolvedValueOnce(mockResult);
      (mockProvider.getBlockNumber as jest.Mock).mockResolvedValueOnce(12345678);

      const reserves = await adapter.getPoolReserves(testPoolId);

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
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();

      // Setup mock for getPoolTokens
      const mockResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]', 'uint256[]', 'uint256'],
        [[testTokens.weth, testTokens.bal], testBalances, 12345000]
      );
      (mockProvider.call as jest.Mock).mockResolvedValue(mockResult);
    });

    it('should calculate swap quote for weighted pool', async () => {
      // First, discover the pool
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSubgraphPoolsResponse),
      });

      await adapter.discoverPools(testTokens.weth, testTokens.bal);

      const amountIn = BigInt('1000000000000000000'); // 1 WETH
      const quote = await adapter.getSwapQuote!(
        testPoolId,
        testTokens.weth,
        testTokens.bal,
        amountIn
      );

      expect(quote).not.toBeNull();
      expect(quote!.amountOut).toBeGreaterThan(0n);
      expect(quote!.priceImpact).toBeGreaterThanOrEqual(0);
      expect(quote!.feeAmount).toBeGreaterThanOrEqual(0n);
    });

    it('should return null for unknown pool', async () => {
      const quote = await adapter.getSwapQuote!(
        '0xunknown_pool_id',
        testTokens.weth,
        testTokens.bal,
        BigInt('1000000000000000000')
      );

      expect(quote).toBeNull();
    });
  });

  // ===========================================================================
  // Health Check
  // ===========================================================================

  describe('isHealthy()', () => {
    it('should return true when vault is reachable', async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();

      // Mock successful getPoolTokens call (using any known pool)
      const mockResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]', 'uint256[]', 'uint256'],
        [[], [], 0]
      );
      (mockProvider.call as jest.Mock).mockResolvedValueOnce(mockResult);

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
      adapter = new BalancerV2Adapter(config);

      // Initialize will fail, so isHealthy should return false
      try {
        await adapter.initialize();
      } catch {
        // Expected to fail
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
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();

      // Discover some pools to populate cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSubgraphPoolsResponse),
      });
      await adapter.discoverPools(testTokens.weth, testTokens.bal);

      await adapter.destroy();

      // After destroy, operations should still be safe but return empty/null
      const pools = await adapter.discoverPools(testTokens.weth, testTokens.bal);
      expect(pools).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Pool Type Mapping
  // ===========================================================================

  describe('Pool Type Mapping', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
    });

    it.each([
      ['Weighted', 'weighted'],
      ['Stable', 'stable'],
      ['ComposableStable', 'composable_stable'],
      ['MetaStable', 'stable'],
      ['LiquidityBootstrapping', 'weighted'],
      ['Linear', 'linear'],
      ['Unknown', 'weighted'], // Default fallback
    ])('should map %s pool type to %s', async (subgraphType, expectedType) => {
      const response = {
        data: {
          pools: [
            {
              id: testPoolId,
              address: testPoolAddress,
              poolType: subgraphType,
              swapFee: '0.003',
              tokens: [
                { address: testTokens.weth, balance: '1000', decimals: 18, weight: '0.8' },
                { address: testTokens.bal, balance: '5000', decimals: 18, weight: '0.2' },
              ],
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      const pools = await adapter.discoverPools(testTokens.weth, testTokens.bal);

      expect(pools[0].poolType).toBe(expectedType);
    });
  });

  // ===========================================================================
  // Fee Handling
  // ===========================================================================

  describe('Fee Handling', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
    });

    it('should convert swap fee to basis points', async () => {
      const response = {
        data: {
          pools: [
            {
              id: testPoolId,
              address: testPoolAddress,
              poolType: 'Weighted',
              swapFee: '0.003', // 0.3%
              tokens: [
                { address: testTokens.weth, balance: '1000', decimals: 18, weight: '0.8' },
                { address: testTokens.bal, balance: '5000', decimals: 18, weight: '0.2' },
              ],
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      const pools = await adapter.discoverPools(testTokens.weth, testTokens.bal);

      expect(pools[0].swapFee).toBe(30); // 0.3% = 30 basis points
    });

    it('should handle very small fees correctly', async () => {
      // Use valid hex address (DAI on Ethereum)
      const daiAddress = '0xd586e7f844cea2f87f50152665bcbc2c279d8d70';
      const response = {
        data: {
          pools: [
            {
              id: testPoolId,
              address: testPoolAddress,
              poolType: 'Stable',
              swapFee: '0.0001', // 0.01%
              tokens: [
                { address: testTokens.usdc, balance: '1000000', decimals: 6 },
                { address: daiAddress, balance: '1000000', decimals: 18 },
              ],
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      const pools = await adapter.discoverPools(testTokens.usdc, daiAddress);

      expect(pools[0].swapFee).toBe(1); // 0.01% = 1 basis point
    });
  });

  // ===========================================================================
  // Subgraph Query Construction
  // ===========================================================================

  describe('Subgraph Query', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
    });

    it('should construct correct GraphQL query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { pools: [] } }),
      });

      await adapter.discoverPools(testTokens.weth, testTokens.bal);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('query'),
        })
      );

      // Verify query contains token addresses
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.query).toContain(testTokens.weth.toLowerCase());
      expect(body.query).toContain(testTokens.bal.toLowerCase());
    });
  });

  // ===========================================================================
  // P0-1 Regression: GraphQL Injection Prevention
  // ===========================================================================

  describe('P0-1: GraphQL injection prevention', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
    });

    it('should reject token addresses with GraphQL injection payload', async () => {
      const maliciousAddress = '", totalLiquidity_gt: "0" }) { id } query { pools(';

      // discoverPools catches the throw and returns []
      const pools = await adapter.discoverPools(maliciousAddress, testTokens.bal);
      expect(pools).toHaveLength(0);

      // fetch should NOT have been called — the injection was blocked before the request
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject non-hex token addresses', async () => {
      const pools = await adapter.discoverPools('not-a-hex-address', testTokens.bal);
      expect(pools).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject addresses with wrong length', async () => {
      const shortAddress = '0xabcd';
      const pools = await adapter.discoverPools(shortAddress, testTokens.bal);
      expect(pools).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should accept valid lowercase hex addresses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { pools: [] } }),
      });

      const pools = await adapter.discoverPools(testTokens.weth, testTokens.bal);
      // Valid addresses pass validation — fetch is called
      expect(mockFetch).toHaveBeenCalled();
      expect(pools).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Swap Quote Edge Cases
  // ===========================================================================

  describe('getSwapQuote() edge cases', () => {
    beforeEach(async () => {
      const config = createTestConfig({ provider: mockProvider });
      adapter = new BalancerV2Adapter(config);
      await adapter.initialize();
    });

    it('should return null when weighted pool calculation yields zero amountOut', async () => {
      // Discover a pool first to populate cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSubgraphPoolsResponse),
      });
      await adapter.discoverPools(testTokens.weth, testTokens.bal);

      // Mock getPoolTokens with a pool where balanceOut is very small (near-empty)
      const mockResult = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]', 'uint256[]', 'uint256'],
        [
          [testTokens.weth, testTokens.bal],
          [BigInt('1000000000000000000000'), BigInt('1')], // 1000 WETH, 1 wei BAL
          12345000,
        ]
      );
      (mockProvider.call as jest.Mock).mockResolvedValue(mockResult);

      const amountIn = BigInt('1000000000000000000'); // 1 WETH
      const quote = await adapter.getSwapQuote!(
        testPoolId,
        testTokens.weth,
        testTokens.bal,
        amountIn
      );

      // With balanceOut = 1 wei, amountOut rounds to 0 — should return null
      expect(quote).toBeNull();
    });
  });

  // ===========================================================================
  // Multi-Chain Support
  // ===========================================================================

  describe('Multi-Chain Support', () => {
    it.each([
      ['arbitrum', BALANCER_VAULT_ADDRESSES.arbitrum],
      ['ethereum', BALANCER_VAULT_ADDRESSES.ethereum],
      ['polygon', BALANCER_VAULT_ADDRESSES.polygon],
      ['optimism', BALANCER_VAULT_ADDRESSES.optimism],
      ['base', BALANCER_VAULT_ADDRESSES.base],
      ['fantom', BALANCER_VAULT_ADDRESSES.fantom],
    ])(
      'should support %s chain with correct vault address',
      async (chain, expectedVault) => {
        const config = createTestConfig({
          chain,
          primaryAddress: expectedVault,
        });
        adapter = new BalancerV2Adapter(config);

        expect(adapter.chain).toBe(chain);
        expect(adapter.primaryAddress).toBe(expectedVault);
      }
    );
  });
});
