/**
 * OnChainLiquidityValidator Tests
 *
 * Tests for on-chain liquidity validation with caching,
 * circuit breaker, request coalescing, and timer cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { OnChainLiquidityValidator } from '../../onchain-liquidity.validator';
import { LiquidityCheck } from '../../../domain/models';
import type { IProviderInfo, ILiquidityContext } from '../../../domain';
import { AAVE_PROVIDER } from '../test-providers';

describe('OnChainLiquidityValidator', () => {
  let validator: OnChainLiquidityValidator;
  let mockCall: jest.Mock<(...args: any[]) => any>;
  let mockRpcProvider: { call: jest.Mock<(...args: any[]) => any> };

  const aaveProvider: IProviderInfo = {
    protocol: 'aave_v3',
    chain: 'ethereum',
    feeBps: 9,
    isAvailable: true,
    poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Valid Aave V3 Pool address
  };

  const tokenAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH

  // Mock balanceOf return: 10 ETH
  const mockBalanceResult = '0x' + (BigInt(10e18)).toString(16).padStart(64, '0');

  beforeEach(() => {
    // Reset fake timers if used
    jest.useRealTimers();

    mockCall = jest.fn<(...args: any[]) => any>().mockResolvedValue(mockBalanceResult);
    mockRpcProvider = {
      call: mockCall,
    };

    validator = new OnChainLiquidityValidator({
      cacheTtlMs: 300000,      // 5 minutes
      safetyMargin: 1.1,       // 10%
      rpcTimeoutMs: 5000,      // 5 seconds
      maxCacheSize: 100,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 1000, // Short for tests
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('checkLiquidity', () => {
    it('should check liquidity via RPC call', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1e18), // 1 ETH
        context
      );

      expect(result.checkPerformed).toBe(true);
      expect(result.availableLiquidity).toBe(BigInt(10e18));
      expect(result.hasSufficientLiquidity).toBe(true);
      expect(result.checkLatencyMs).toBeGreaterThanOrEqual(0);
      expect(mockRpcProvider.call).toHaveBeenCalledTimes(1);
    });

    it('should apply safety margin to required amount', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1e18), // 1 ETH
        context
      );

      // Required with 10% margin: 1e18 * 1.1 = 1.1e18
      // Using ceiling division
      const expectedRequired = (BigInt(1e18) * 1100n + 999n) / 1000n;
      expect(result.requiredLiquidity).toBe(expectedRequired);
    });

    it('should return failure when no RPC provider', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: undefined,
      };

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1e18),
        context
      );

      expect(result.checkPerformed).toBe(false);
      expect(result.hasSufficientLiquidity).toBe(false);
      expect(result.error).toBe('No RPC provider available');
    });

    it('should return failure when RPC call fails', async () => {
      mockCall.mockRejectedValue(new Error('RPC connection lost'));
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1e18),
        context
      );

      expect(result.checkPerformed).toBe(false);
      expect(result.hasSufficientLiquidity).toBe(false);
      expect(result.error).toBe('RPC connection lost');
    });

    it('should return failure when RPC provider has invalid type', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: { noCallMethod: true }, // Missing call()
      };

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1e18),
        context
      );

      expect(result.checkPerformed).toBe(false);
      expect(result.error).toContain('Invalid RPC provider');
    });
  });

  describe('caching', () => {
    let context: ILiquidityContext;

    beforeEach(() => {
      context = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };
    });

    it('should return cached result on second call', async () => {
      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);
      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      // RPC should only be called once
      expect(mockRpcProvider.call).toHaveBeenCalledTimes(1);
    });

    it('should use different cache keys for different providers', async () => {
      const pancakeProvider: IProviderInfo = {
        ...aaveProvider,
        protocol: 'pancakeswap_v3',
        poolAddress: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      };

      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);
      await validator.checkLiquidity(pancakeProvider, tokenAddress, BigInt(1e18), context);

      expect(mockRpcProvider.call).toHaveBeenCalledTimes(2);
    });

    it('should use different cache keys for different assets', async () => {
      const otherToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);
      await validator.checkLiquidity(aaveProvider, otherToken, BigInt(1e18), context);

      expect(mockRpcProvider.call).toHaveBeenCalledTimes(2);
    });

    it('should normalize asset addresses to lowercase for cache key', async () => {
      const upperCase = '0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2';
      const lowerCase = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

      await validator.checkLiquidity(aaveProvider, upperCase, BigInt(1e18), context);
      await validator.checkLiquidity(aaveProvider, lowerCase, BigInt(1e18), context);

      // Same address (case-insensitive) should use cache
      expect(mockRpcProvider.call).toHaveBeenCalledTimes(1);
    });

    it('should expire cache after TTL', async () => {
      const shortTtlValidator = new OnChainLiquidityValidator({
        cacheTtlMs: 1, // 1ms TTL
        rpcTimeoutMs: 5000,
        circuitBreakerThreshold: 10,
      });

      await shortTtlValidator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      await shortTtlValidator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      expect(mockRpcProvider.call).toHaveBeenCalledTimes(2);
    });

    it('should clear cache on clearCache()', async () => {
      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);
      validator.clearCache();
      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      expect(mockRpcProvider.call).toHaveBeenCalledTimes(2);
    });

    it('should cleanup oldest entries when cache exceeds max size', async () => {
      const smallCacheValidator = new OnChainLiquidityValidator({
        cacheTtlMs: 300000,
        rpcTimeoutMs: 5000,
        maxCacheSize: 3,
        circuitBreakerThreshold: 100,
      });

      // Fill cache with 4 entries (exceeds maxCacheSize of 3)
      for (let i = 0; i < 4; i++) {
        const provider: IProviderInfo = {
          ...aaveProvider,
          protocol: `protocol_${i}` as any,
        };
        await smallCacheValidator.checkLiquidity(
          provider,
          tokenAddress,
          BigInt(1e18),
          context
        );
      }

      // Should have called RPC 4 times (no cache hits)
      expect(mockRpcProvider.call).toHaveBeenCalledTimes(4);
    });
  });

  describe('circuit breaker', () => {
    let context: ILiquidityContext;

    beforeEach(() => {
      // RPC that always fails
      mockCall.mockRejectedValue(new Error('RPC unavailable'));
      context = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };
    });

    it('should open circuit after threshold consecutive failures', async () => {
      // 3 failures to hit threshold
      for (let i = 0; i < 3; i++) {
        const provider: IProviderInfo = { ...aaveProvider, protocol: `p${i}` as any };
        await validator.checkLiquidity(provider, `0x${i}aaa`, BigInt(1e18), context);
      }

      // 4th call should be blocked by circuit breaker (no RPC call)
      mockCall.mockClear();
      const result = await validator.checkLiquidity(
        aaveProvider,
        '0xNewToken',
        BigInt(1e18),
        context
      );

      expect(result.checkPerformed).toBe(false);
      expect(result.error).toContain('Circuit breaker OPEN');
      expect(mockRpcProvider.call).not.toHaveBeenCalled();
    });

    it('should allow retry after cooldown (half-open state)', async () => {
      // Trip the circuit breaker
      for (let i = 0; i < 3; i++) {
        const provider: IProviderInfo = { ...aaveProvider, protocol: `p${i}` as any };
        await validator.checkLiquidity(provider, `0x${i}bbb`, BigInt(1e18), context);
      }

      // Wait for cooldown (1000ms configured in beforeEach)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should allow retry (half-open)
      mockCall.mockClear();
      mockCall.mockRejectedValue(new Error('still failing'));

      const result = await validator.checkLiquidity(
        aaveProvider,
        '0xRetryToken',
        BigInt(1e18),
        context
      );

      // Should have made the RPC call (half-open allows one retry)
      expect(mockRpcProvider.call).toHaveBeenCalledTimes(1);
    });

    it('should close circuit on successful RPC after half-open', async () => {
      // Trip the circuit breaker
      for (let i = 0; i < 3; i++) {
        const provider: IProviderInfo = { ...aaveProvider, protocol: `p${i}` as any };
        await validator.checkLiquidity(provider, `0x${i}ccc`, BigInt(1e18), context);
      }

      // Wait for cooldown
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Successful retry should close circuit
      mockCall.mockResolvedValue(mockBalanceResult);

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1e18),
        context
      );

      expect(result.checkPerformed).toBe(true);
      expect(result.hasSufficientLiquidity).toBe(true);

      // Subsequent calls should work normally
      mockCall.mockClear();
      await validator.checkLiquidity(
        { ...aaveProvider, protocol: 'pancakeswap_v3' },
        '0xAnotherToken',
        BigInt(1e18),
        context
      );

      expect(mockRpcProvider.call).toHaveBeenCalledTimes(1);
    });

    it('should count no-RPC-provider as failure for circuit breaker', async () => {
      const noRpcContext: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: undefined,
      };

      // 3 failures from missing RPC
      for (let i = 0; i < 3; i++) {
        const provider: IProviderInfo = { ...aaveProvider, protocol: `p${i}` as any };
        await validator.checkLiquidity(provider, `0x${i}ddd`, BigInt(1e18), noRpcContext);
      }

      // Circuit should be open
      const result = await validator.checkLiquidity(
        aaveProvider,
        '0xNewToken',
        BigInt(1e18),
        noRpcContext
      );

      expect(result.error).toContain('Circuit breaker OPEN');
    });
  });

  describe('estimateLiquidityScore', () => {
    it('should return 0.7 when no cached data', async () => {
      const score = await validator.estimateLiquidityScore(
        aaveProvider,
        tokenAddress,
        BigInt(1e18)
      );

      expect(score).toBe(0.7);
    });

    it('should return 1.0 for plenty of cached liquidity', async () => {
      // First, populate cache via checkLiquidity
      // Mock returns 10 ETH, request 1 ETH
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      // Now estimate score — 10 ETH available >> 1 ETH required with margin
      const score = await validator.estimateLiquidityScore(
        aaveProvider,
        tokenAddress,
        BigInt(1e18)
      );

      expect(score).toBe(1.0);
    });

    it('should return 0.3 for insufficient cached liquidity', async () => {
      // Mock returns 0.5 ETH
      const smallBalance = '0x' + (BigInt(5e17)).toString(16).padStart(64, '0');
      mockCall.mockResolvedValue(smallBalance);

      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      // 0.5 ETH < 1 ETH required
      const score = await validator.estimateLiquidityScore(
        aaveProvider,
        tokenAddress,
        BigInt(1e18)
      );

      expect(score).toBe(0.3);
    });

    it('should return 0.7 when last check failed', async () => {
      mockCall.mockRejectedValue(new Error('RPC failed'));
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      await validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      const score = await validator.estimateLiquidityScore(
        aaveProvider,
        tokenAddress,
        BigInt(1e18)
      );

      // Failed check -> conservative default
      expect(score).toBe(0.7);
    });
  });

  describe('request coalescing', () => {
    it('should coalesce concurrent requests for same provider/asset', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      // Slow down RPC to ensure concurrent calls overlap
      mockRpcProvider.call.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return mockBalanceResult;
      });

      // Fire 3 concurrent requests
      const results = await Promise.all([
        validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context),
        validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context),
        validator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context),
      ]);

      // All should succeed
      expect(results[0].checkPerformed).toBe(true);
      expect(results[1].checkPerformed).toBe(true);
      expect(results[2].checkPerformed).toBe(true);

      // But RPC should only be called once (coalesced)
      expect(mockRpcProvider.call).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout handling', () => {
    it('should timeout slow RPC calls', async () => {
      const fastTimeoutValidator = new OnChainLiquidityValidator({
        cacheTtlMs: 300000,
        rpcTimeoutMs: 50, // 50ms timeout
        circuitBreakerThreshold: 10,
      });

      // RPC takes 500ms (well over timeout)
      mockRpcProvider.call.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(mockBalanceResult), 500))
      );

      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      const result = await fastTimeoutValidator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1e18),
        context
      );

      expect(result.checkPerformed).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should clean up timeout timer on successful RPC (P0 fix)', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      // Track setTimeout/clearTimeout
      const originalSetTimeout = global.setTimeout;
      const originalClearTimeout = global.clearTimeout;
      const timeoutIds: ReturnType<typeof setTimeout>[] = [];
      const clearedIds: ReturnType<typeof setTimeout>[] = [];

      global.setTimeout = ((fn: any, ms: any) => {
        const id = originalSetTimeout(fn, ms);
        timeoutIds.push(id);
        return id;
      }) as any;

      global.clearTimeout = ((id: any) => {
        clearedIds.push(id);
        return originalClearTimeout(id);
      }) as any;

      try {
        await validator.checkLiquidity(
          aaveProvider,
          tokenAddress,
          BigInt(1e18),
          context
        );

        // Verify that setTimeout was called and then cleared
        expect(timeoutIds.length).toBeGreaterThan(0);
        expect(clearedIds.length).toBeGreaterThan(0);
      } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
      }
    });
  });

  describe('logger injection (F24)', () => {
    it('should log circuit_breaker_opened via injected logger', async () => {
      const mockLogger = {
        info: jest.fn<(msg: string, meta?: object) => void>(),
        warn: jest.fn<(msg: string, meta?: object) => void>(),
        error: jest.fn<(msg: string, meta?: object) => void>(),
        debug: jest.fn<(msg: string, meta?: object) => void>(),
      };

      const loggedValidator = new OnChainLiquidityValidator({
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 1000,
        rpcTimeoutMs: 5000,
        logger: mockLogger as any,
      });

      mockCall.mockRejectedValue(new Error('RPC down'));
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      // 3 failures to open circuit
      for (let i = 0; i < 3; i++) {
        const provider: IProviderInfo = { ...aaveProvider, protocol: `p${i}` as any };
        await loggedValidator.checkLiquidity(provider, `0x${i}eee`, BigInt(1e18), context);
      }

      // Should have logged circuit breaker OPENED
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker OPENED'),
        expect.objectContaining({
          component: 'OnChainLiquidityValidator',
          event: 'circuit_breaker_opened',
          state: 'OPEN',
        })
      );
    });

    it('should log circuit_breaker_closed on recovery via injected logger', async () => {
      const mockLogger = {
        info: jest.fn<(msg: string, meta?: object) => void>(),
        warn: jest.fn<(msg: string, meta?: object) => void>(),
        error: jest.fn<(msg: string, meta?: object) => void>(),
        debug: jest.fn<(msg: string, meta?: object) => void>(),
      };

      const loggedValidator = new OnChainLiquidityValidator({
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 100, // Short cooldown for test
        rpcTimeoutMs: 5000,
        logger: mockLogger as any,
      });

      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      // Trip the circuit breaker
      mockCall.mockRejectedValue(new Error('RPC down'));
      for (let i = 0; i < 3; i++) {
        const provider: IProviderInfo = { ...aaveProvider, protocol: `p${i}` as any };
        await loggedValidator.checkLiquidity(provider, `0x${i}fff`, BigInt(1e18), context);
      }

      // Wait for cooldown
      await new Promise(resolve => setTimeout(resolve, 150));

      // Successful retry should close circuit and log CLOSED
      mockCall.mockResolvedValue(mockBalanceResult);
      (mockLogger.info as jest.Mock).mockClear();

      await loggedValidator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker CLOSED'),
        expect.objectContaining({
          component: 'OnChainLiquidityValidator',
          event: 'circuit_breaker_closed',
          state: 'CLOSED',
        })
      );
    });

    it('should log circuit_breaker_half_open when retrying after cooldown', async () => {
      const mockLogger = {
        info: jest.fn<(msg: string, meta?: object) => void>(),
        warn: jest.fn<(msg: string, meta?: object) => void>(),
        error: jest.fn<(msg: string, meta?: object) => void>(),
        debug: jest.fn<(msg: string, meta?: object) => void>(),
      };

      const loggedValidator = new OnChainLiquidityValidator({
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 100,
        rpcTimeoutMs: 5000,
        logger: mockLogger as any,
      });

      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      // Trip the circuit breaker
      mockCall.mockRejectedValue(new Error('RPC down'));
      for (let i = 0; i < 3; i++) {
        const provider: IProviderInfo = { ...aaveProvider, protocol: `p${i}` as any };
        await loggedValidator.checkLiquidity(provider, `0x${i}ggg`, BigInt(1e18), context);
      }

      // Wait for cooldown
      await new Promise(resolve => setTimeout(resolve, 150));

      // Retry attempt should log HALF-OPEN
      (mockLogger.info as jest.Mock).mockClear();
      mockCall.mockResolvedValue(mockBalanceResult);

      await loggedValidator.checkLiquidity(aaveProvider, tokenAddress, BigInt(1e18), context);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker HALF-OPEN'),
        expect.objectContaining({
          component: 'OnChainLiquidityValidator',
          event: 'circuit_breaker_half_open',
          state: 'HALF-OPEN',
        })
      );
    });
  });

  describe('safety margin calculation', () => {
    it('should apply 10% safety margin correctly', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1000), // 1000 wei
        context
      );

      // With 10% margin and ceiling division:
      // (1000 * 1100 + 999) / 1000 = 1100999 / 1000 = 1100 (ceiling)
      expect(result.requiredLiquidity).toBe(1100n);
    });

    it('should use ceiling division for small amounts', async () => {
      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      const result = await validator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        1n, // 1 wei
        context
      );

      // (1 * 1100 + 999) / 1000 = 2099 / 1000 = 2 (ceiling)
      expect(result.requiredLiquidity).toBe(2n);
    });

    it('should handle configurable safety margin', async () => {
      const highMarginValidator = new OnChainLiquidityValidator({
        safetyMargin: 1.5, // 50% margin
        rpcTimeoutMs: 5000,
        circuitBreakerThreshold: 10,
      });

      const context: ILiquidityContext = {
        chain: 'ethereum',
        rpcProvider: mockRpcProvider,
      };

      const result = await highMarginValidator.checkLiquidity(
        aaveProvider,
        tokenAddress,
        BigInt(1000),
        context
      );

      // (1000 * 1500 + 999) / 1000 = 1500999 / 1000 = 1500 (ceiling)
      expect(result.requiredLiquidity).toBe(1500n);
    });
  });
});
