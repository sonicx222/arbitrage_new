/**
 * Liquidity Validator - Domain Interface
 *
 * Interface for on-chain liquidity validation with caching.
 * Follows Single Responsibility Principle - liquidity checking only.
 *
 * Performance Target:
 * - checkLiquidity() with cache hit: <1ms
 * - checkLiquidity() with cache miss: <10ms (RPC call)
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md
 */

import type { LiquidityCheck } from './models';
import type { IProviderInfo } from './provider-ranker.interface';

/**
 * Liquidity Validation Context
 *
 * Context needed for on-chain liquidity checks.
 */
export interface ILiquidityContext {
  /** Chain identifier */
  readonly chain: string;

  /** RPC provider for on-chain calls */
  readonly rpcProvider?: unknown; // ethers.JsonRpcProvider
}

/**
 * Liquidity Validator - Domain Interface
 *
 * Responsibilities:
 * - Check on-chain liquidity for flash loan providers
 * - Cache results to minimize RPC calls (5-minute TTL)
 * - Apply safety margin (10% buffer)
 * - Graceful degradation on RPC failures
 *
 * Following SOLID Principles:
 * - **Single Responsibility**: Liquidity validation only
 * - **Interface Segregation**: Minimal interface for liquidity checks
 * - **Dependency Inversion**: Depends on abstractions (ILiquidityContext)
 *
 * @example
 * ```typescript
 * const validator: ILiquidityValidator = createValidator(config);
 * const check = await validator.checkLiquidity(
 *   provider,
 *   tokenAddress,
 *   BigInt(1000e18),
 *   context
 * );
 *
 * if (check.hasSufficientLiquidity) {
 *   console.log('Sufficient liquidity:', check.availableLiquidity);
 * } else {
 *   console.log('Insufficient:', check.requiredLiquidity, 'needed');
 * }
 * ```
 */
export interface ILiquidityValidator {
  /**
   * Check if provider has sufficient liquidity for amount
   *
   * Process:
   * 1. Check cache (5-minute TTL)
   * 2. If cache miss, query on-chain balance
   * 3. Apply safety margin (10% buffer)
   * 4. Cache result
   * 5. Return LiquidityCheck (immutable)
   *
   * Caching Strategy:
   * - Key: `${protocol}-${chain}-${asset}`
   * - TTL: 5 minutes (configurable)
   * - Request coalescing: Prevent duplicate checks
   *
   * Graceful Degradation:
   * - On RPC failure: Return LiquidityCheck.failure() with assumed-sufficient
   * - On timeout: Return LiquidityCheck.failure() with assumed-sufficient
   * - Logs warnings for debugging
   *
   * @param provider - Provider to check
   * @param asset - Token address to check liquidity for
   * @param amount - Required amount in wei
   * @param context - Liquidity context (RPC provider)
   * @returns LiquidityCheck (immutable result)
   */
  checkLiquidity(
    provider: IProviderInfo,
    asset: string,
    amount: bigint,
    context: ILiquidityContext
  ): Promise<LiquidityCheck>;

  /**
   * Estimate liquidity score for provider ranking
   *
   * Uses cached liquidity data if available.
   * Returns score in range [0, 1]:
   * - 1.0: Liquidity >= 2x required (plenty)
   * - 0.9: Liquidity >= 1.1x required (adequate with margin)
   * - 0.7: Liquidity >= 1x required (just enough)
   * - 0.3: Liquidity < 1x required (insufficient)
   *
   * @param provider - Provider to score
   * @param asset - Token address
   * @param amount - Required amount
   * @returns Liquidity score [0, 1]
   */
  estimateLiquidityScore(
    provider: IProviderInfo,
    asset: string,
    amount: bigint
  ): Promise<number>;

  /**
   * Clear liquidity cache (for testing/debugging)
   */
  clearCache(): void;
}

/**
 * Liquidity Validator Factory
 */
export type LiquidityValidatorFactory = (
  config: {
    cacheTtlMs?: number;
    safetyMargin?: number;
    rpcTimeoutMs?: number;
    maxCacheSize?: number;
  }
) => ILiquidityValidator;
