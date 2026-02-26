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
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type {
  ILiquidityValidator,
  ILiquidityContext,
  IProviderInfo,
  LiquidityCheck,
} from '../domain';
import { LiquidityCheck as LiquidityCheckImpl } from '../domain';
// P2 Fix: Import ethers statically (not dynamically) for hot-path performance
import { ethers } from 'ethers';
import { calculateLiquidityScore, DEFAULT_LIQUIDITY_SCORE } from './liquidity-scoring';
/**
 * Minimal Logger interface compatible with @arbitrage/core Logger.
 * Defined locally to avoid a runtime dependency on @arbitrage/core.
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}
import { withTimeout } from './with-timeout';
import { CoalescingMap } from './coalescing-map';
import { getErrorMessage } from '@arbitrage/types';

/**
 * Minimal interface for RPC providers that support eth_call.
 * Avoids `as any` cast while keeping the validator decoupled from
 * a specific ethers.js provider class.
 */
interface RpcCallable {
  call(tx: { to: string; data: string }): Promise<string>;
}

/**
 * Cached liquidity entry
 */
interface CachedLiquidity {
  check: LiquidityCheck;
  timestamp: number;
}

/**
 * P2/I4 Fix: Cached ERC20 interface for hot-path optimization
 * Creating Interface objects is expensive (~0.5ms) - cache at module level
 * I4: Frozen to prevent accidental modification (hot-path immutability per ADR-022)
 */
const ERC20_INTERFACE = Object.freeze(
  new ethers.Interface(['function balanceOf(address owner) view returns (uint256)'])
);

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
  /** M3 Fix: Circuit breaker threshold (default: 5 consecutive failures) */
  circuitBreakerThreshold?: number;
  /** M3 Fix: Circuit breaker cooldown in ms (default: 30 seconds) */
  circuitBreakerCooldownMs?: number;
  /** I3 Fix: Optional logger for structured logging (circuit breaker events, etc.) */
  logger?: Logger;
}

/**
 * On-Chain Liquidity Validator
 *
 * Checks pool balances on-chain to validate liquidity availability.
 *
 * M3 Fix: Includes circuit breaker to skip RPC calls during sustained failures.
 */
export class OnChainLiquidityValidator implements ILiquidityValidator {
  private readonly config: Required<Omit<OnChainLiquidityValidatorConfig, 'logger'>>;
  private readonly logger?: Logger; // I3 Fix: Optional logger
  private readonly cache = new Map<string, CachedLiquidity>();
  /** R2: Uses CoalescingMap to deduplicate concurrent liquidity checks for same key */
  private readonly pendingChecks = new CoalescingMap<string, LiquidityCheck>();

  /** M3 Fix: Circuit breaker state */
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0; // Timestamp when circuit can retry

  constructor(config?: OnChainLiquidityValidatorConfig) {
    this.logger = config?.logger; // I3 Fix: Store optional logger
    this.config = {
      cacheTtlMs: config?.cacheTtlMs ?? 300000, // 5 minutes
      safetyMargin: config?.safetyMargin ?? 1.1, // 10% buffer
      rpcTimeoutMs: config?.rpcTimeoutMs ?? 5000, // 5 seconds
      maxCacheSize: config?.maxCacheSize ?? 500,
      circuitBreakerThreshold: config?.circuitBreakerThreshold ?? 5,
      circuitBreakerCooldownMs: config?.circuitBreakerCooldownMs ?? 30000, // 30 seconds
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

    // R2: Request coalescing via CoalescingMap - deduplicates concurrent checks
    return this.pendingChecks.getOrCreate(cacheKey, () =>
      this.performLiquidityCheck(provider, asset, amount, context)
    );
  }

  /**
   * Estimate liquidity score from cached data.
   * Delegates to shared calculateLiquidityScore() for consistent thresholds.
   */
  async estimateLiquidityScore(
    provider: IProviderInfo,
    asset: string,
    amount: bigint
  ): Promise<number> {
    const cacheKey = this.makeCacheKey(provider, asset);
    const cached = this.cache.get(cacheKey);

    if (!cached || !cached.check.checkPerformed) {
      return DEFAULT_LIQUIDITY_SCORE;
    }

    const requiredWithMargin = this.applySafetyMargin(amount);
    return calculateLiquidityScore(
      cached.check.availableLiquidity,
      requiredWithMargin,
      amount
    );
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Perform on-chain liquidity check
   *
   * M3 Fix: Implements circuit breaker pattern.
   * Skips RPC calls when circuit is OPEN (too many failures).
   */
  private async performLiquidityCheck(
    provider: IProviderInfo,
    asset: string,
    amount: bigint,
    context: ILiquidityContext
  ): Promise<LiquidityCheck> {
    const startTime = Date.now();

    // M3 Fix: Check circuit breaker before attempting RPC
    if (this.isCircuitOpen()) {
      // Circuit is OPEN - skip RPC call, return cached failure
      return LiquidityCheckImpl.failure(
        `Circuit breaker OPEN (${this.consecutiveFailures} consecutive failures)`,
        0
      );
    }

    // M3/I3 Observability: Log HALF-OPEN state (attempting retry after cooldown)
    if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      this.logCircuitEvent(
        'info',
        'circuit_breaker_half_open',
        'Circuit breaker HALF-OPEN - attempting retry',
        {
          consecutiveFailures: this.consecutiveFailures,
          state: 'HALF-OPEN',
        }
      );
    }

    try {
      // Get RPC provider from context
      if (!context.rpcProvider) {
        // No RPC provider - assume sufficient (graceful degradation)
        this.recordFailure(); // M3 Fix: Count as failure
        return LiquidityCheckImpl.failure('No RPC provider available', 0);
      }

      // Query on-chain liquidity with timeout
      // R1: Uses shared withTimeout utility for consistent cleanup
      const liquidity = await withTimeout(
        this.queryOnChainLiquidity(provider, asset, context.rpcProvider),
        this.config.rpcTimeoutMs,
        `Liquidity check timeout after ${this.config.rpcTimeoutMs}ms`
      );

      const latency = Date.now() - startTime;
      const requiredWithMargin = this.applySafetyMargin(amount);

      // M3 Fix: Reset circuit breaker on success
      this.recordSuccess();

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
      const errorMessage = getErrorMessage(error);

      // M3 Fix: Record failure for circuit breaker
      this.recordFailure();

      // Cache failure (with assumed-insufficient, conservative)
      const check = LiquidityCheckImpl.failure(errorMessage, latency);
      this.cache.set(this.makeCacheKey(provider, asset), {
        check,
        timestamp: Date.now(),
      });

      return check;
    }
  }

  /**
   * I3 Fix: Helper method for structured circuit breaker logging
   * Uses injected logger if available, falls back to console with formatted output
   */
  private logCircuitEvent(
    level: 'info' | 'warn',
    event: string,
    message: string,
    details: Record<string, unknown>
  ): void {
    if (this.logger) {
      // Use structured logger if available
      this.logger[level](message, {
        component: 'OnChainLiquidityValidator',
        event,
        ...details,
      });
    } else {
      // Fall back to console with readable format (no JSON.stringify overhead)
      const logFn = level === 'warn' ? console.warn : console.info;
      logFn(`[${level.toUpperCase()}] OnChainLiquidityValidator: ${message}`, details);
    }
  }

  /**
   * M3 Fix: Check if circuit breaker is OPEN
   */
  private isCircuitOpen(): boolean {
    const now = Date.now();

    // Circuit is OPEN if we've hit threshold and cooldown hasn't elapsed
    if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      if (now < this.circuitOpenUntil) {
        return true; // Still in cooldown
      }
      // Cooldown elapsed - allow one retry (HALF-OPEN state)
      return false;
    }

    return false;
  }

  /**
   * M3 Fix: Record successful RPC call
   * M3 Enhancement: Added observability logging for circuit breaker state changes
   */
  private recordSuccess(): void {
    const wasOpen = this.consecutiveFailures >= this.config.circuitBreakerThreshold;

    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;

    // M3/I3 Observability: Log circuit closing (recovery from failure state)
    if (wasOpen) {
      this.logCircuitEvent(
        'info',
        'circuit_breaker_closed',
        'Circuit breaker CLOSED - RPC health restored',
        {
          previousFailures: this.config.circuitBreakerThreshold,
          state: 'CLOSED',
        }
      );
    }
  }

  /**
   * M3 Fix: Record failed RPC call
   * M3 Enhancement: Added observability logging for circuit breaker state changes
   */
  private recordFailure(): void {
    const wasBeforeThreshold = this.consecutiveFailures < this.config.circuitBreakerThreshold;

    this.consecutiveFailures++;

    // If hit threshold, set cooldown period and log circuit opening
    if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      this.circuitOpenUntil = Date.now() + this.config.circuitBreakerCooldownMs;

      // M3/I3 Observability: Log circuit opening (first time hitting threshold)
      if (wasBeforeThreshold) {
        this.logCircuitEvent(
          'warn',
          'circuit_breaker_opened',
          'Circuit breaker OPENED - RPC calls suspended',
          {
            consecutiveFailures: this.consecutiveFailures,
            threshold: this.config.circuitBreakerThreshold,
            cooldownMs: this.config.circuitBreakerCooldownMs,
            willRetryAt: new Date(this.circuitOpenUntil).toISOString(),
            state: 'OPEN',
          }
        );
      }
    }
  }

  /**
   * Query on-chain liquidity via ERC20 balanceOf call
   *
   * Queries the pool's token balance to determine available liquidity.
   * Uses ethers.js for RPC call with proper error handling.
   *
   * P2 Fix: Removed dynamic import for hot-path performance (~1-3ms improvement)
   * - Static import at module level (no import overhead per call)
   * - Cached Interface at module level (no Interface creation overhead per call)
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
    // Validate RPC provider type (F10: typed interface instead of `as any`)
    if (!rpcProvider || typeof (rpcProvider as RpcCallable).call !== 'function') {
      throw new Error('Invalid RPC provider - missing call() method');
    }

    const typedProvider = rpcProvider as RpcCallable;

    // Encode balanceOf call using cached interface (P2: no allocation overhead)
    const calldata = ERC20_INTERFACE.encodeFunctionData('balanceOf', [provider.poolAddress]);

    // Make RPC call
    const result = await typedProvider.call({
      to: asset,
      data: calldata,
    });

    // Decode result using cached interface
    const [balance] = ERC20_INTERFACE.decodeFunctionResult('balanceOf', result);

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
   * Cleanup cache: remove expired entries (TTL sweep) and evict oldest if over size limit
   */
  private cleanupCacheIfNeeded(): void {
    const now = Date.now();

    // Phase 1: TTL sweep — remove expired entries
    for (const [key, cached] of this.cache) {
      if (now - cached.timestamp >= this.config.cacheTtlMs) {
        this.cache.delete(key);
      }
    }

    // Phase 2: Size eviction — remove oldest 20% if still over limit
    if (this.cache.size > this.config.maxCacheSize) {
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, Math.floor(this.config.maxCacheSize * 0.2));
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }
    }
  }

}
