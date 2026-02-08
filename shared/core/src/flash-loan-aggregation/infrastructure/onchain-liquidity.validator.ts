/**
 * On-Chain Liquidity Validator
 *
 * Validates flash loan provider liquidity via RPC calls.
 * Implements ILiquidityValidator with caching and graceful degradation.
 *
 * Features:
 * - 5-minute cache TTL
 * - Request coalescing (prevent duplicate checks)
 * - Safety margin (10% buffer)
 * - Graceful degradation on RPC failures
 *
 * Performance Target:
 * - Cache hit: <1ms
 * - Cache miss: <10ms (RPC call + timeout)
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Infrastructure Layer
 */

import type {
  ILiquidityValidator,
  ILiquidityContext,
  IProviderInfo,
  LiquidityCheck,
} from '../domain';
import { LiquidityCheck as LiquidityCheckImpl } from '../domain';

/**
 * Cached liquidity entry
 */
interface CachedLiquidity {
  check: LiquidityCheck;
  timestamp: number;
}

/**
 * Validator configuration
 */
export interface OnChainLiquidityValidatorConfig {
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
 * On-Chain Liquidity Validator
 *
 * Checks pool balances on-chain to validate liquidity availability.
 */
export class OnChainLiquidityValidator implements ILiquidityValidator {
  private readonly config: Required<OnChainLiquidityValidatorConfig>;
  private readonly cache = new Map<string, CachedLiquidity>();
  private readonly pendingChecks = new Map<string, Promise<LiquidityCheck>>();

  constructor(config?: OnChainLiquidityValidatorConfig) {
    this.config = {
      cacheTtlMs: config?.cacheTtlMs ?? 300000, // 5 minutes
      safetyMargin: config?.safetyMargin ?? 1.1, // 10% buffer
      rpcTimeoutMs: config?.rpcTimeoutMs ?? 5000, // 5 seconds
      maxCacheSize: config?.maxCacheSize ?? 500,
    };
  }

  /**
   * Check liquidity for provider/asset pair
   *
   * Uses request coalescing to prevent duplicate RPC calls.
   * Race-condition safe via atomic check-and-set pattern.
   */
  async checkLiquidity(
    provider: IProviderInfo,
    asset: string,
    amount: bigint,
    context: ILiquidityContext
  ): Promise<LiquidityCheck> {
    const cacheKey = this.makeCacheKey(provider, asset);

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      // Return cached check with amount validation
      const requiredWithMargin = this.applySafetyMargin(amount);
      return LiquidityCheckImpl.success(
        cached.check.availableLiquidity,
        requiredWithMargin,
        cached.check.checkLatencyMs
      );
    }

    // Request coalescing - atomic check-and-set to prevent race condition
    let pending = this.pendingChecks.get(cacheKey);
    if (!pending) {
      // Create new promise and store atomically
      pending = this.performLiquidityCheck(provider, asset, amount, context);
      this.pendingChecks.set(cacheKey, pending);

      // Cleanup on completion (regardless of success/failure)
      // Use finally block attached to promise, not try/catch in caller
      pending.finally(() => {
        // Only delete if this is still the same promise (not replaced)
        if (this.pendingChecks.get(cacheKey) === pending) {
          this.pendingChecks.delete(cacheKey);
        }
      });
    }

    // Return the promise (either newly created or existing)
    return pending;
  }

  /**
   * Estimate liquidity score from cached data
   */
  async estimateLiquidityScore(
    provider: IProviderInfo,
    asset: string,
    amount: bigint
  ): Promise<number> {
    const cacheKey = this.makeCacheKey(provider, asset);
    const cached = this.cache.get(cacheKey);

    if (!cached || !cached.check.checkPerformed) {
      // No data or last check failed - use conservative default (0.7 = adequate but unverified)
      // Rationale: Better to slightly under-rank than select providers with
      // insufficient liquidity that cause transaction failures
      return 0.7;
    }

    // Score based on ratio of available to requested
    const requiredWithMargin = this.applySafetyMargin(amount);
    const available = cached.check.availableLiquidity;

    if (available >= requiredWithMargin * 2n) {
      return 1.0; // Plenty (2x required)
    } else if (available >= requiredWithMargin) {
      return 0.9; // Adequate
    } else if (available >= amount) {
      return 0.7; // Just enough
    } else {
      return 0.3; // Insufficient
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Perform on-chain liquidity check
   */
  private async performLiquidityCheck(
    provider: IProviderInfo,
    asset: string,
    amount: bigint,
    context: ILiquidityContext
  ): Promise<LiquidityCheck> {
    const startTime = Date.now();

    try {
      // Get RPC provider from context
      if (!context.rpcProvider) {
        // No RPC provider - assume sufficient (graceful degradation)
        return LiquidityCheckImpl.failure('No RPC provider available', 0);
      }

      // Query on-chain liquidity with timeout
      const liquidity = await Promise.race([
        this.queryOnChainLiquidity(provider, asset, context.rpcProvider),
        this.timeoutPromise(this.config.rpcTimeoutMs),
      ]);

      const latency = Date.now() - startTime;
      const requiredWithMargin = this.applySafetyMargin(amount);

      // Create success check
      const check = LiquidityCheckImpl.success(liquidity, requiredWithMargin, latency);

      // Update cache
      this.cache.set(this.makeCacheKey(provider, asset), {
        check,
        timestamp: Date.now(),
      });

      // Cleanup cache if needed
      this.cleanupCacheIfNeeded();

      return check;
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Cache failure (with assumed-sufficient)
      const check = LiquidityCheckImpl.failure(errorMessage, latency);
      this.cache.set(this.makeCacheKey(provider, asset), {
        check,
        timestamp: Date.now(),
      });

      return check;
    }
  }

  /**
   * Query on-chain liquidity via ERC20 balanceOf call
   *
   * Queries the pool's token balance to determine available liquidity.
   * Uses ethers.js for RPC call with proper error handling.
   *
   * @param provider - Flash loan provider info (contains poolAddress)
   * @param asset - Token address to check balance for
   * @param rpcProvider - ethers.js JsonRpcProvider instance
   * @returns Available liquidity in wei
   * @throws Error if RPC call fails or returns invalid data
   */
  private async queryOnChainLiquidity(
    provider: IProviderInfo,
    asset: string,
    rpcProvider: unknown
  ): Promise<bigint> {
    // Import ethers dynamically to avoid circular dependencies
    const { ethers } = await import('ethers');

    // Validate RPC provider type
    if (!rpcProvider || typeof (rpcProvider as any).call !== 'function') {
      throw new Error('Invalid RPC provider - missing call() method');
    }

    // Create ERC20 interface for balanceOf call
    const erc20Interface = new ethers.Interface([
      'function balanceOf(address owner) view returns (uint256)',
    ]);

    // Encode balanceOf call
    const calldata = erc20Interface.encodeFunctionData('balanceOf', [provider.poolAddress]);

    // Make RPC call
    const result = await (rpcProvider as any).call({
      to: asset,
      data: calldata,
    });

    // Decode result
    const [balance] = erc20Interface.decodeFunctionResult('balanceOf', result);

    // Convert to BigInt
    return BigInt(balance.toString());
  }

  /**
   * Apply safety margin to amount
   *
   * Uses ceiling division to ensure we always round up (conservative).
   * Example: 10% margin on 99 wei = (99 * 1100 + 999) / 1000 = 109 wei (not 108)
   */
  private applySafetyMargin(amount: bigint): bigint {
    const marginMultiplier = BigInt(Math.floor(this.config.safetyMargin * 1000));
    const divisor = 1000n;
    // Ceiling division: (a * b + (divisor - 1)) / divisor
    return (amount * marginMultiplier + (divisor - 1n)) / divisor;
  }

  /**
   * Check if cached data is still valid
   */
  private isCacheValid(cached: CachedLiquidity): boolean {
    return Date.now() - cached.timestamp < this.config.cacheTtlMs;
  }

  /**
   * Make cache key
   */
  private makeCacheKey(provider: IProviderInfo, asset: string): string {
    return `${provider.protocol}-${provider.chain}-${asset.toLowerCase()}`;
  }

  /**
   * Cleanup cache if size exceeds maximum
   */
  private cleanupCacheIfNeeded(): void {
    if (this.cache.size > this.config.maxCacheSize) {
      // Remove oldest 20% of entries (simple LRU)
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, Math.floor(this.config.maxCacheSize * 0.2));
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Timeout promise
   */
  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Liquidity check timeout after ${ms}ms`)), ms);
    });
  }
}

/**
 * Factory function
 */
export function createOnChainLiquidityValidator(
  config?: OnChainLiquidityValidatorConfig
): OnChainLiquidityValidator {
  return new OnChainLiquidityValidator(config);
}
