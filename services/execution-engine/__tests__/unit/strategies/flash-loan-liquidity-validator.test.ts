/**
 * Flash Loan Liquidity Validator Tests
 *
 * Tests for on-chain liquidity validation with caching and request coalescing.
 *
 * @see flash-loan-liquidity-validator.ts
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ethers } from 'ethers';
import {
  FlashLoanLiquidityValidator,
  type LiquidityValidatorConfig,
} from '../../../src/strategies/flash-loan-liquidity-validator';
import type { IFlashLoanProvider } from '../../../src/strategies/flash-loan-providers/types';
import type { StrategyContext, Logger } from '../../../src/types';

// =============================================================================
// Test Fixtures
// =============================================================================

const mockLogger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockProvider: IFlashLoanProvider = {
  protocol: 'aave_v3' as const,
  chain: 'ethereum',
  poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave V3 Ethereum Pool
  getFeeInfo: jest.fn() as any,
  getMaxLoan: jest.fn() as any,
  supportsAsset: jest.fn() as any,
};

const mockAsset = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC

function createMockContext(rpcProvider?: ethers.JsonRpcProvider): StrategyContext {
  const mockWallet = {} as ethers.Wallet;
  const providers = new Map<string, ethers.JsonRpcProvider>();
  if (rpcProvider) {
    providers.set('ethereum', rpcProvider);
  }

  return {
    wallets: new Map([['ethereum', mockWallet]]),
    providers,
  };
}

function createMockRpcProvider(balance: bigint): ethers.JsonRpcProvider {
  const mockProvider = {
    call: jest.fn().mockResolvedValue(
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [balance])
    ),
  } as unknown as ethers.JsonRpcProvider;
  return mockProvider;
}

// =============================================================================
// Unit Tests
// =============================================================================

describe('FlashLoanLiquidityValidator', () => {
  let validator: FlashLoanLiquidityValidator;

  beforeEach(() => {
    jest.clearAllMocks();
    validator = new FlashLoanLiquidityValidator(mockLogger);
  });

  describe('Constructor', () => {
    it('should initialize with default config', () => {
      const v = new FlashLoanLiquidityValidator(mockLogger);
      expect(v).toBeDefined();
    });

    it('should accept custom config', () => {
      const config: LiquidityValidatorConfig = {
        cacheTtlMs: 60000,
        safetyMargin: 1.2,
        rpcTimeoutMs: 3000,
        maxCacheSize: 100,
      };
      const v = new FlashLoanLiquidityValidator(mockLogger, config);
      expect(v).toBeDefined();
    });
  });

  describe('checkLiquidity', () => {
    it('should return true when sufficient liquidity available', async () => {
      const balance = BigInt(1000000e6); // 1M USDC
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6); // 100K USDC

      const result = await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      expect(result).toBe(true);
      expect(rpcProvider.call).toHaveBeenCalledOnce();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[LiquidityValidator] On-chain check complete',
        expect.objectContaining({
          protocol: 'aave_v3',
          asset: mockAsset,
          hasLiquidity: true,
        })
      );
    });

    it('should return false when insufficient liquidity', async () => {
      const balance = BigInt(50000e6); // 50K USDC
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6); // 100K USDC (with 10% margin = 110K needed)

      const result = await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      expect(result).toBe(false);
    });

    it('should apply safety margin (10% buffer by default)', async () => {
      const balance = BigInt(105000e6); // 105K USDC
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6); // 100K USDC → 110K with 10% margin

      const result = await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      // Balance is 105K, but we need 110K with safety margin
      expect(result).toBe(false);
    });

    it('should use cache on subsequent calls', async () => {
      const balance = BigInt(1000000e6);
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6);

      // First call - should hit RPC
      const result1 = await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);
      expect(result1).toBe(true);
      expect(rpcProvider.call).toHaveBeenCalledOnce();

      // Second call - should use cache
      const result2 = await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);
      expect(result2).toBe(true);
      expect(rpcProvider.call).toHaveBeenCalledOnce(); // Still only one call
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[LiquidityValidator] Cache hit',
        expect.any(Object)
      );
    });

    it('should refetch after cache expires', async () => {
      const shortTtl: LiquidityValidatorConfig = {
        cacheTtlMs: 100, // 100ms TTL
      };
      const v = new FlashLoanLiquidityValidator(mockLogger, shortTtl);

      const balance = BigInt(1000000e6);
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6);

      // First call
      await v.checkLiquidity(mockProvider, mockAsset, amount, ctx);
      expect(rpcProvider.call).toHaveBeenCalledOnce();

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Second call - cache expired, should refetch
      await v.checkLiquidity(mockProvider, mockAsset, amount, ctx);
      expect(rpcProvider.call).toHaveBeenCalledTimes(2);
    });

    it('should coalesce concurrent requests for same provider/asset', async () => {
      const balance = BigInt(1000000e6);
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6);

      // Make 3 concurrent calls
      const [result1, result2, result3] = await Promise.all([
        validator.checkLiquidity(mockProvider, mockAsset, amount, ctx),
        validator.checkLiquidity(mockProvider, mockAsset, amount, ctx),
        validator.checkLiquidity(mockProvider, mockAsset, amount, ctx),
      ]);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(result3).toBe(true);
      // Should only call RPC once due to request coalescing
      expect(rpcProvider.call).toHaveBeenCalledOnce();
    });

    it('should return true (graceful fallback) when RPC provider unavailable', async () => {
      const ctx = createMockContext(); // No RPC provider
      const amount = BigInt(100000e6);

      const result = await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      expect(result).toBe(true); // Graceful fallback
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[LiquidityValidator] No RPC provider for chain',
        expect.objectContaining({ chain: 'ethereum' })
      );
    });

    it('should return true (graceful fallback) on RPC timeout', async () => {
      const rpcProvider = {
        call: vi.fn().mockImplementation(
          () => new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout')), 10);
          })
        ),
      } as unknown as ethers.JsonRpcProvider;

      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6);

      const shortTimeout: LiquidityValidatorConfig = {
        rpcTimeoutMs: 5, // 5ms timeout
      };
      const v = new FlashLoanLiquidityValidator(mockLogger, shortTimeout);

      const result = await v.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      expect(result).toBe(true); // Graceful fallback
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[LiquidityValidator] On-chain check failed',
        expect.any(Object)
      );
    });

    it('should return true (graceful fallback) on RPC error', async () => {
      const rpcProvider = {
        call: vi.fn().mockRejectedValue(new Error('RPC error')),
      } as unknown as ethers.JsonRpcProvider;

      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6);

      const result = await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      expect(result).toBe(true); // Graceful fallback
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[LiquidityValidator] On-chain check failed',
        expect.objectContaining({
          protocol: 'aave_v3',
          asset: mockAsset,
        })
      );
    });
  });

  describe('estimateLiquidityScore', () => {
    it('should return 1.0 when no cached data available', async () => {
      const score = await validator.estimateLiquidityScore(
        mockProvider,
        mockAsset,
        BigInt(100000e6)
      );

      expect(score).toBe(1.0);
    });

    it('should return 1.0 when plenty of liquidity (2x+ required)', async () => {
      const balance = BigInt(1000000e6); // 1M USDC
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6); // 100K USDC

      // Populate cache
      await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      // Check score
      const score = await validator.estimateLiquidityScore(mockProvider, mockAsset, amount);
      expect(score).toBe(1.0);
    });

    it('should return 0.9 when adequate liquidity (1x-2x required)', async () => {
      const balance = BigInt(150000e6); // 150K USDC
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6); // 100K USDC → 110K with margin

      await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      const score = await validator.estimateLiquidityScore(mockProvider, mockAsset, amount);
      expect(score).toBe(0.9);
    });

    it('should return 0.7 when just enough (no safety margin)', async () => {
      const balance = BigInt(105000e6); // 105K USDC
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6); // 100K USDC

      await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      const score = await validator.estimateLiquidityScore(mockProvider, mockAsset, amount);
      expect(score).toBe(0.7);
    });

    it('should return 0.3 when insufficient liquidity', async () => {
      const balance = BigInt(50000e6); // 50K USDC
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);
      const amount = BigInt(100000e6);

      await validator.checkLiquidity(mockProvider, mockAsset, amount, ctx);

      const score = await validator.estimateLiquidityScore(mockProvider, mockAsset, amount);
      expect(score).toBe(0.3);
    });
  });

  describe('getCachedLiquidity', () => {
    it('should return null when no cached data', () => {
      const cached = validator.getCachedLiquidity(mockProvider, mockAsset);
      expect(cached).toBeNull();
    });

    it('should return cached data when available', async () => {
      const balance = BigInt(1000000e6);
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);

      await validator.checkLiquidity(mockProvider, mockAsset, BigInt(100000e6), ctx);

      const cached = validator.getCachedLiquidity(mockProvider, mockAsset);
      expect(cached).not.toBeNull();
      expect(cached?.availableLiquidity).toBe(balance);
      expect(cached?.provider).toBe('aave_v3');
      expect(cached?.lastCheckSuccessful).toBe(true);
    });

    it('should return null when cache expired', async () => {
      const shortTtl: LiquidityValidatorConfig = { cacheTtlMs: 100 };
      const v = new FlashLoanLiquidityValidator(mockLogger, shortTtl);

      const balance = BigInt(1000000e6);
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);

      await v.checkLiquidity(mockProvider, mockAsset, BigInt(100000e6), ctx);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const cached = v.getCachedLiquidity(mockProvider, mockAsset);
      expect(cached).toBeNull();
    });
  });

  describe('clearCache', () => {
    it('should clear all cached data', async () => {
      const balance = BigInt(1000000e6);
      const rpcProvider = createMockRpcProvider(balance);
      const ctx = createMockContext(rpcProvider);

      // Populate cache
      await validator.checkLiquidity(mockProvider, mockAsset, BigInt(100000e6), ctx);
      expect(validator.getCachedLiquidity(mockProvider, mockAsset)).not.toBeNull();

      // Clear cache
      validator.clearCache();
      expect(validator.getCachedLiquidity(mockProvider, mockAsset)).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('[LiquidityValidator] Cache cleared');
    });
  });
});
