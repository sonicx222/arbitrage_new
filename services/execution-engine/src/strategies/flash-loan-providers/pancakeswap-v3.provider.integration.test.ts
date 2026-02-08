/**
 * Integration Tests for PancakeSwap V3 Flash Loan Provider
 *
 * Task 2.1 (Day 3): Integration tests for PancakeSwap V3 implementation.
 * Tests provider with mock factory and pool contracts to verify:
 * - Pool discovery from factory
 * - Fee tier selection
 * - Transaction building
 * - Validation logic
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 2.1
 */

import { ethers } from 'ethers';
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PancakeSwapV3FlashLoanProvider } from './pancakeswap-v3.provider';
import type { FlashLoanRequest } from './types';

// =============================================================================
// Mock Contracts
// =============================================================================

/**
 * Mock PancakeSwap V3 Factory contract
 */
class MockPancakeV3Factory {
  private pools: Map<string, string> = new Map();

  // Add a pool to the mock factory
  addPool(tokenA: string, tokenB: string, feeTier: number, poolAddress: string): void {
    const key = this.getPoolKey(tokenA, tokenB, feeTier);
    this.pools.set(key, poolAddress);
  }

  private getPoolKey(tokenA: string, tokenB: string, feeTier: number): string {
    // Normalize order (same as PancakeSwap V3)
    const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA.toLowerCase(), tokenB.toLowerCase()]
      : [tokenB.toLowerCase(), tokenA.toLowerCase()];
    return `${token0}-${token1}-${feeTier}`;
  }

  async getPool(tokenA: string, tokenB: string, feeTier: number): Promise<string> {
    const key = this.getPoolKey(tokenA, tokenB, feeTier);
    return this.pools.get(key) || ethers.ZeroAddress;
  }
}

/**
 * Mock PancakeSwap V3 Pool contract
 */
class MockPancakeV3Pool {
  constructor(
    public token0: string,
    public token1: string,
    public feeTier: number
  ) {}

  async fee(): Promise<number> {
    return this.feeTier;
  }
}

/**
 * Mock JSON-RPC Provider for testing
 */
class MockJsonRpcProvider {
  private contracts: Map<string, any> = new Map();

  addContract(address: string, contract: any): void {
    this.contracts.set(address.toLowerCase(), contract);
  }

  async call(tx: { to: string; data: string }): Promise<string> {
    const contract = this.contracts.get(tx.to.toLowerCase());
    if (!contract) {
      throw new Error(`No contract at address ${tx.to}`);
    }

    // Decode the function selector
    const selector = tx.data.slice(0, 10);

    // Mock factory.getPool
    if (selector === '0x1698ee82') {
      // getPool(address,address,uint24) selector
      const iface = new ethers.Interface([
        'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)',
      ]);
      const decoded = iface.decodeFunctionData('getPool', tx.data);
      const result = await contract.getPool(decoded[0], decoded[1], decoded[2]);
      return iface.encodeFunctionResult('getPool', [result]);
    }

    // Mock pool.fee
    if (selector === '0xddca3f43') {
      // fee() selector
      const iface = new ethers.Interface(['function fee() external view returns (uint24)']);
      const result = await contract.fee();
      return iface.encodeFunctionResult('fee', [result]);
    }

    throw new Error(`Unknown function selector: ${selector}`);
  }

  async estimateGas(tx: any): Promise<bigint> {
    return 500000n;
  }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('PancakeSwapV3FlashLoanProvider Integration Tests', () => {
  // Test addresses
  const FACTORY_ADDRESS = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
  const CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const POOL_WETH_USDC_500 = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
  const POOL_WETH_USDC_3000 = '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8';
  const ROUTER_UNISWAP = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

  let provider: PancakeSwapV3FlashLoanProvider;
  let mockRpcProvider: MockJsonRpcProvider;
  let mockFactory: MockPancakeV3Factory;

  beforeEach(() => {
    // Create mock factory
    mockFactory = new MockPancakeV3Factory();

    // Add pools to factory
    mockFactory.addPool(WETH, USDC, 500, POOL_WETH_USDC_500);
    mockFactory.addPool(WETH, USDC, 2500, POOL_WETH_USDC_3000);

    // Create mock RPC provider
    mockRpcProvider = new MockJsonRpcProvider();
    mockRpcProvider.addContract(FACTORY_ADDRESS, mockFactory);
    mockRpcProvider.addContract(POOL_WETH_USDC_500, new MockPancakeV3Pool(WETH, USDC, 500));
    mockRpcProvider.addContract(POOL_WETH_USDC_3000, new MockPancakeV3Pool(WETH, USDC, 2500));

    // Create provider
    provider = new PancakeSwapV3FlashLoanProvider({
      chain: 'ethereum',
      poolAddress: FACTORY_ADDRESS,
      contractAddress: CONTRACT_ADDRESS,
      approvedRouters: [ROUTER_UNISWAP],
    });
  });

  // ===========================================================================
  // Pool Discovery Tests
  // ===========================================================================

  describe('Pool Discovery', () => {
    it('should discover pool with 0.25% fee tier (default preference)', async () => {
      const result = await provider.findBestPool(
        WETH,
        USDC,
        mockRpcProvider as unknown as ethers.JsonRpcProvider
      );

      expect(result).toBeDefined();
      expect(result?.pool).toBe(POOL_WETH_USDC_3000);
      expect(result?.feeTier).toBe(2500); // 0.25% preferred first
    });

    it('should discover pool with 0.05% fee tier when 0.25% not available', async () => {
      // Remove 0.25% pool
      mockFactory = new MockPancakeV3Factory();
      mockFactory.addPool(WETH, USDC, 500, POOL_WETH_USDC_500);
      mockRpcProvider.addContract(FACTORY_ADDRESS, mockFactory);

      const result = await provider.findBestPool(
        WETH,
        USDC,
        mockRpcProvider as unknown as ethers.JsonRpcProvider
      );

      expect(result).toBeDefined();
      expect(result?.pool).toBe(POOL_WETH_USDC_500);
      expect(result?.feeTier).toBe(500); // 0.05%
    });

    it('should return null when no pool exists', async () => {
      const result = await provider.findBestPool(
        WETH,
        USDT, // No WETH/USDT pool in mock
        mockRpcProvider as unknown as ethers.JsonRpcProvider
      );

      expect(result).toBeNull();
    });

    it('should cache pool discovery results', async () => {
      // First call
      const result1 = await provider.findBestPool(
        WETH,
        USDC,
        mockRpcProvider as unknown as ethers.JsonRpcProvider
      );

      // Second call (should hit cache)
      const result2 = await provider.findBestPool(
        WETH,
        USDC,
        mockRpcProvider as unknown as ethers.JsonRpcProvider
      );

      expect(result1).toEqual(result2);
    });

    it('should query pool fee dynamically', async () => {
      const feeTier = await provider.getPoolFee(
        POOL_WETH_USDC_500,
        mockRpcProvider as unknown as ethers.JsonRpcProvider
      );

      expect(feeTier).toBe(500);
    });
  });

  // ===========================================================================
  // Fee Calculation Tests
  // ===========================================================================

  describe('Fee Calculation', () => {
    it('should calculate fee for 0.25% tier', () => {
      const amount = ethers.parseEther('1'); // 1 ETH
      const fee = provider.calculateFee(amount, 2500);

      expect(fee.protocol).toBe('pancakeswap_v3');
      expect(fee.feeBps).toBe(25); // 2500 / 100 = 25 bps
      expect(fee.feeAmount).toBe(ethers.parseEther('0.0025')); // 0.25% of 1 ETH
    });

    it('should calculate fee for 0.05% tier', () => {
      const amount = ethers.parseEther('1'); // 1 ETH
      const fee = provider.calculateFee(amount, 500);

      expect(fee.feeBps).toBe(5); // 500 / 100 = 5 bps
      expect(fee.feeAmount).toBe(ethers.parseEther('0.0005')); // 0.05% of 1 ETH
    });

    it('should use default fee tier when not specified', () => {
      const amount = ethers.parseEther('1');
      const fee = provider.calculateFee(amount); // No fee tier specified

      expect(fee.feeBps).toBe(25); // Default 2500 / 100 = 25 bps
    });

    it('should handle fee override', () => {
      const providerWithOverride = new PancakeSwapV3FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: FACTORY_ADDRESS,
        contractAddress: CONTRACT_ADDRESS,
        approvedRouters: [ROUTER_UNISWAP],
        feeOverride: 100, // 0.01%
      });

      const amount = ethers.parseEther('1');
      const fee = providerWithOverride.calculateFee(amount);

      expect(fee.feeBps).toBe(1); // 100 / 100 = 1 bps
      expect(fee.feeAmount).toBe(ethers.parseEther('0.0001')); // 0.01% of 1 ETH
    });
  });

  // ===========================================================================
  // Transaction Building Tests
  // ===========================================================================

  describe('Transaction Building', () => {
    it('should build calldata with pool address', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [
          {
            router: ROUTER_UNISWAP,
            tokenIn: WETH,
            tokenOut: USDC,
            amountOutMin: ethers.parseUnits('3000', 6), // 3000 USDC
          },
          {
            router: ROUTER_UNISWAP,
            tokenIn: USDC,
            tokenOut: WETH,
            amountOutMin: ethers.parseEther('1.01'), // 1.01 ETH (profit)
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
        poolAddress: POOL_WETH_USDC_500,
      };

      const calldata = provider.buildCalldata(request);

      expect(calldata).toBeDefined();
      expect(calldata.startsWith('0x')).toBe(true);
      expect(calldata.length).toBeGreaterThan(10); // Should be encoded function call
    });

    it('should throw error when poolAddress is missing', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
        // poolAddress missing
      };

      expect(() => provider.buildCalldata(request)).toThrow('[ERR_MISSING_POOL]');
    });

    it('should build complete transaction', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [
          {
            router: ROUTER_UNISWAP,
            tokenIn: WETH,
            tokenOut: USDC,
            amountOutMin: ethers.parseUnits('3000', 6),
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
        poolAddress: POOL_WETH_USDC_500,
      };

      const tx = provider.buildTransaction(request, request.initiator);

      expect(tx.to).toBe(CONTRACT_ADDRESS);
      expect(tx.from).toBe(request.initiator);
      expect(tx.data).toBeDefined();
    });

    it('should estimate gas', async () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
        poolAddress: POOL_WETH_USDC_500,
      };

      const gasEstimate = await provider.estimateGas(
        request,
        mockRpcProvider as unknown as ethers.JsonRpcProvider
      );

      expect(gasEstimate).toBeGreaterThan(0n);
    });
  });

  // ===========================================================================
  // Validation Tests
  // ===========================================================================

  describe('Request Validation', () => {
    it('should validate successful request', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [
          {
            router: ROUTER_UNISWAP,
            tokenIn: WETH,
            tokenOut: USDC,
            amountOutMin: ethers.parseUnits('3000', 6),
          },
          {
            router: ROUTER_UNISWAP,
            tokenIn: USDC,
            tokenOut: WETH,
            amountOutMin: ethers.parseEther('1.01'),
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
      };

      const result = provider.validate(request);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject request with wrong chain', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'bsc', // Wrong chain
        swapPath: [
          {
            router: ROUTER_UNISWAP,
            tokenIn: WETH,
            tokenOut: WETH,
            amountOutMin: ethers.parseEther('1'),
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
      };

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_MISMATCH]');
    });

    it('should reject request with zero amount', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: 0n,
        chain: 'ethereum',
        swapPath: [
          {
            router: ROUTER_UNISWAP,
            tokenIn: WETH,
            tokenOut: WETH,
            amountOutMin: ethers.parseEther('1'),
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
      };

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ZERO_AMOUNT]');
    });

    it('should reject request with empty swap path', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [], // Empty
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
      };

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_EMPTY_PATH]');
    });

    it('should reject request with unapproved router', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [
          {
            router: '0x0000000000000000000000000000000000000099', // Not approved
            tokenIn: WETH,
            tokenOut: USDC,
            amountOutMin: ethers.parseUnits('3000', 6),
          },
          {
            router: ROUTER_UNISWAP,
            tokenIn: USDC,
            tokenOut: WETH,
            amountOutMin: ethers.parseEther('1.01'),
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
      };

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_UNAPPROVED_ROUTER]');
    });

    it('should reject request with invalid cycle', () => {
      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [
          {
            router: ROUTER_UNISWAP,
            tokenIn: WETH,
            tokenOut: USDC,
            amountOutMin: ethers.parseUnits('3000', 6),
          },
          {
            router: ROUTER_UNISWAP,
            tokenIn: USDC,
            tokenOut: USDT, // Ends with USDT, not WETH
            amountOutMin: ethers.parseUnits('3000', 6),
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
      };

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_CYCLE]');
    });

    it('should reject when no routers approved', () => {
      const providerNoRouters = new PancakeSwapV3FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: FACTORY_ADDRESS,
        contractAddress: CONTRACT_ADDRESS,
        approvedRouters: [], // Empty
      });

      const request: FlashLoanRequest = {
        asset: WETH,
        amount: ethers.parseEther('1'),
        chain: 'ethereum',
        swapPath: [
          {
            router: ROUTER_UNISWAP,
            tokenIn: WETH,
            tokenOut: WETH,
            amountOutMin: ethers.parseEther('1'),
          },
        ],
        minProfit: ethers.parseEther('0.01'),
        initiator: '0x0000000000000000000000000000000000000001',
      };

      const result = providerNoRouters.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CONFIG]');
    });
  });

  // ===========================================================================
  // Provider Configuration Tests
  // ===========================================================================

  describe('Provider Configuration', () => {
    it('should return correct capabilities', () => {
      const capabilities = provider.getCapabilities();

      expect(capabilities.supportsMultiHop).toBe(true);
      expect(capabilities.supportsMultiAsset).toBe(false);
      expect(capabilities.status).toBe('fully_supported');
    });

    it('should be available with valid configuration', () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it('should not be available with zero contract address', () => {
      const providerZeroAddress = new PancakeSwapV3FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: FACTORY_ADDRESS,
        contractAddress: '0x0000000000000000000000000000000000000000',
        approvedRouters: [ROUTER_UNISWAP],
      });

      expect(providerZeroAddress.isAvailable()).toBe(false);
    });

    it('should return contract address', () => {
      expect(provider.getContractAddress()).toBe(CONTRACT_ADDRESS);
    });

    it('should return factory address', () => {
      expect(provider.getFactoryAddress()).toBe(FACTORY_ADDRESS);
    });

    it('should return approved routers', () => {
      const routers = provider.getApprovedRouters();

      expect(routers).toHaveLength(1);
      expect(routers[0]).toBe(ROUTER_UNISWAP);
    });

    it('should clear cache', () => {
      provider.clearCache();
      // No error expected
    });
  });
});
