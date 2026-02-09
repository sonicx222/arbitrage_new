/**
 * Flash Loan Liquidity Validator
 *
 * Validates flash loan provider liquidity for large amounts (>$100K threshold).
 * Uses on-chain RPC calls with caching to reduce latency.
 *
 * Features:
 * - On-chain liquidity checking via RPC
 * - 5-minute cache TTL to reduce RPC calls
 * - Safety margin (10% buffer above requested amount)
 * - Graceful degradation on RPC failures
 * - Request coalescing to prevent duplicate checks
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type { IFlashLoanProvider, FlashLoanProtocol } from './flash-loan-providers/types';
import type { StrategyContext } from '../types';
import type { Logger } from '../types';
import { ethers } from 'ethers';

/**
 * Cached liquidity data for a provider/asset pair
 */
interface CachedLiquidity {
  /** Flash loan protocol */
  provider: FlashLoanProtocol;
  /** Asset token address */
  asset: string;
  /** Available liquidity in wei */
  availableLiquidity: bigint;
  /** Timestamp when cached */
  timestamp: number;
  /** Whether last check succeeded */
  lastCheckSuccessful: boolean;
}

/**
 * Configuration for liquidity validator
 */
export interface LiquidityValidatorConfig {
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs?: number;
  /** Safety margin multiplier (default: 1.1 for 10% buffer) */
  safetyMargin?: number;
  /** RPC call timeout in milliseconds (default: 5 seconds) */
  rpcTimeoutMs?: number;
  /** Maximum cache size (default: 500 entries) */
  maxCacheSize?: number;
}

/**
 * Flash Loan Liquidity Validator
 *
 * Validates that flash loan providers have sufficient liquidity for requested amounts.
 * Uses caching and request coalescing to minimize RPC overhead.
 *
 * Usage:
 * ```typescript
 * const validator = new FlashLoanLiquidityValidator(logger);
 * const hasLiquidity = await validator.checkLiquidity(
 *   provider,
 *   tokenAddress,
 *   BigInt(1000e18),
 *   ctx
 * );
 * ```
 */
export class FlashLoanLiquidityValidator {
  private readonly config: Required<LiquidityValidatorConfig>;
  private readonly cache = new Map<string, CachedLiquidity>();
  private readonly pendingChecks = new Map<string, Promise<boolean>>();

  constructor(
    private readonly logger: Logger,
    config?: LiquidityValidatorConfig
  ) {
    this.config = {
      cacheTtlMs: config?.cacheTtlMs ?? 300000, // 5 minutes
      safetyMargin: config?.safetyMargin ?? 1.1, // 10% buffer
      rpcTimeoutMs: config?.rpcTimeoutMs ?? 5000, // 5 seconds
      maxCacheSize: config?.maxCacheSize ?? 500,
    };
  }

  /**
   * Check if provider has sufficient liquidity for requested amount.
   *
   * Process:
   * 1. Check cache first (5-minute TTL)
   * 2. If cache miss, perform on-chain check
   * 3. Apply safety margin (10% buffer)
   * 4. Cache result for future use
   *
   * @param provider - Flash loan provider
   * @param asset - Token address
   * @param amount - Requested amount in wei
   * @param ctx - Strategy context with RPC provider
   * @returns True if sufficient liquidity available
   */
  async checkLiquidity(
    provider: IFlashLoanProvider,
    asset: string,
    amount: bigint,
    ctx: StrategyContext
  ): Promise<boolean> {
    const cacheKey = this.makeCacheKey(provider, asset);

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      this.logger.debug('[LiquidityValidator] Cache hit', {
        protocol: provider.protocol,
        asset,
        age: Date.now() - cached.timestamp,
      });

      // Apply safety margin to cached value
      const requiredLiquidity = this.applySafetyMargin(amount);
      return cached.availableLiquidity >= requiredLiquidity;
    }

    // Request coalescing - prevent duplicate on-chain checks
    const pending = this.pendingChecks.get(cacheKey);
    if (pending) {
      this.logger.debug('[LiquidityValidator] Request coalescing', {
        protocol: provider.protocol,
        asset,
      });
      return pending;
    }

    // Perform on-chain check
    const checkPromise = this.performLiquidityCheck(provider, asset, amount, ctx);
    this.pendingChecks.set(cacheKey, checkPromise);

    try {
      return await checkPromise;
    } finally {
      this.pendingChecks.delete(cacheKey);
    }
  }

  /**
   * Estimate liquidity score (0-1) for provider ranking.
   * Uses cached data, defaults to 1.0 if no data available.
   *
   * @param provider - Flash loan provider
   * @param asset - Token address
   * @param amount - Requested amount
   * @returns Liquidity score (0-1)
   */
  async estimateLiquidityScore(
    provider: IFlashLoanProvider,
    asset: string,
    amount: bigint
  ): Promise<number> {
    const cacheKey = this.makeCacheKey(provider, asset);
    const cached = this.cache.get(cacheKey);

    if (!cached || !cached.lastCheckSuccessful) {
      // No data or last check failed - assume adequate
      return 1.0;
    }

    // Score based on ratio of available to requested
    const requiredWithMargin = this.applySafetyMargin(amount);

    if (cached.availableLiquidity >= requiredWithMargin * 2n) {
      return 1.0; // Plenty of liquidity (2x required)
    } else if (cached.availableLiquidity >= requiredWithMargin) {
      return 0.9; // Adequate liquidity
    } else if (cached.availableLiquidity >= amount) {
      return 0.7; // Just enough (no safety margin)
    } else {
      return 0.3; // Insufficient
    }
  }

  /**
   * Get cached liquidity data for a provider/asset pair
   */
  getCachedLiquidity(
    provider: IFlashLoanProvider,
    asset: string
  ): CachedLiquidity | null {
    const cached = this.cache.get(this.makeCacheKey(provider, asset));
    return cached && this.isCacheValid(cached) ? { ...cached } : null;
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.debug('[LiquidityValidator] Cache cleared');
  }

  /**
   * Perform on-chain liquidity check
   */
  private async performLiquidityCheck(
    provider: IFlashLoanProvider,
    asset: string,
    amount: bigint,
    ctx: StrategyContext
  ): Promise<boolean> {
    const startTime = Date.now();

    try {
      // Get RPC provider from context
      const rpcProvider = ctx.providers?.get(provider.chain);
      if (!rpcProvider) {
        this.logger.warn('[LiquidityValidator] No RPC provider for chain', {
          chain: provider.chain,
        });
        return this.gracefulFallback(provider, asset, true); // Assume sufficient
      }

      // Query on-chain liquidity with timeout
      const liquidity = await Promise.race([
        this.queryOnChainLiquidity(provider, asset, rpcProvider),
        this.timeoutPromise(this.config.rpcTimeoutMs),
      ]);

      const latency = Date.now() - startTime;

      // Update cache
      this.cache.set(this.makeCacheKey(provider, asset), {
        provider: provider.protocol,
        asset,
        availableLiquidity: liquidity,
        timestamp: Date.now(),
        lastCheckSuccessful: true,
      });

      // Cleanup cache if too large
      this.cleanupCacheIfNeeded();

      const requiredWithMargin = this.applySafetyMargin(amount);
      const hasLiquidity = liquidity >= requiredWithMargin;

      this.logger.debug('[LiquidityValidator] On-chain check complete', {
        protocol: provider.protocol,
        asset,
        available: liquidity.toString(),
        required: requiredWithMargin.toString(),
        hasLiquidity,
        latencyMs: latency,
      });

      return hasLiquidity;
    } catch (error) {
      const latency = Date.now() - startTime;

      this.logger.warn('[LiquidityValidator] On-chain check failed', {
        protocol: provider.protocol,
        asset,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: latency,
      });

      // Cache failure
      this.cache.set(this.makeCacheKey(provider, asset), {
        provider: provider.protocol,
        asset,
        availableLiquidity: 0n,
        timestamp: Date.now(),
        lastCheckSuccessful: false,
      });

      // Graceful fallback - assume sufficient liquidity
      return this.gracefulFallback(provider, asset, true);
    }
  }

  /**
   * Query on-chain liquidity for a provider/asset pair
   */
  private async queryOnChainLiquidity(
    provider: IFlashLoanProvider,
    asset: string,
    rpcProvider: ethers.JsonRpcProvider
  ): Promise<bigint> {
    // ERC20 balanceOf ABI
    const erc20Interface = new ethers.Interface([
      'function balanceOf(address owner) view returns (uint256)',
    ]);

    // Query pool's balance of the asset
    const calldata = erc20Interface.encodeFunctionData('balanceOf', [
      provider.poolAddress,
    ]);

    const result = await rpcProvider.call({
      to: asset,
      data: calldata,
    });

    // Decode result
    const [balance] = erc20Interface.decodeFunctionResult('balanceOf', result);
    return BigInt(balance.toString());
  }

  /**
   * Apply safety margin to amount (10% buffer by default)
   */
  private applySafetyMargin(amount: bigint): bigint {
    const marginMultiplier = BigInt(Math.floor(this.config.safetyMargin * 1000));
    return (amount * marginMultiplier) / 1000n;
  }

  /**
   * Check if cached data is still valid
   */
  private isCacheValid(cached: CachedLiquidity): boolean {
    return Date.now() - cached.timestamp < this.config.cacheTtlMs;
  }

  /**
   * Make cache key for provider/asset pair
   */
  private makeCacheKey(provider: IFlashLoanProvider, asset: string): string {
    return `${provider.protocol}-${provider.chain}-${asset.toLowerCase()}`;
  }

  /**
   * Cleanup cache if size exceeds maximum
   */
  private cleanupCacheIfNeeded(): void {
    if (this.cache.size > this.config.maxCacheSize) {
      // Remove oldest entries (simple LRU)
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, Math.floor(this.config.maxCacheSize * 0.2));
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }

      this.logger.debug('[LiquidityValidator] Cache cleanup', {
        removed: toRemove.length,
        remaining: this.cache.size,
      });
    }
  }

  /**
   * Timeout promise for RPC calls
   */
  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Liquidity check timeout after ${ms}ms`)), ms);
    });
  }

  /**
   * Graceful fallback when check fails
   */
  private gracefulFallback(
    provider: IFlashLoanProvider,
    asset: string,
    assumeSufficient: boolean
  ): boolean {
    this.logger.debug('[LiquidityValidator] Using graceful fallback', {
      protocol: provider.protocol,
      asset,
      assumeSufficient,
    });
    return assumeSufficient;
  }
}

/**
 * Factory function to create liquidity validator
 */
export function createFlashLoanLiquidityValidator(
  logger: Logger,
  config?: LiquidityValidatorConfig
): FlashLoanLiquidityValidator {
  return new FlashLoanLiquidityValidator(logger, config);
}
