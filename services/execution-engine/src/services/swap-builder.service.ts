/**
 * Swap Builder Service
 *
 * Builds swap steps and prepares swap transactions.
 * Includes TTL-based caching for hot-path optimization.
 *
 * @see Finding 9.1: Extract BaseExecutionStrategy shared concerns
 * @see Finding 10.2: Swap steps caching optimization
 */

import type { ILogger } from '@arbitrage/core/logging';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { DexLookupService } from './dex-lookup.service';
import { getTokenDecimals } from '@arbitrage/config';

const BPS_DENOMINATOR = 10000n;
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.5%

/**
 * Swap step in a multi-hop swap path
 */
export interface SwapStep {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountOutMin: bigint;
}

/**
 * Parameters for building swap steps
 */
export interface SwapStepsParams {
  /** Router contract address for buy DEX (not DEX name) */
  buyRouter: string;
  /** Router contract address for sell DEX (not DEX name) */
  sellRouter: string;
  /** Intermediate token address for the swap path */
  intermediateToken: string;
  /** Slippage tolerance in basis points (e.g., 50 = 0.5%) */
  slippageBps?: number;
  /** Chain identifier (e.g., 'ethereum', 'arbitrum') */
  chain: string;
}

/**
 * Cached swap steps entry
 */
interface CachedSwapSteps {
  steps: SwapStep[];
  timestamp: number;
}

export class SwapBuilder {
  // Swap steps cache with TTL
  private readonly swapStepsCache: Map<string, CachedSwapSteps>;
  private static readonly MAX_CACHE_SIZE = 100;
  private static readonly CACHE_TTL_MS = 60000; // 60 seconds

  constructor(
    private readonly dexLookup: DexLookupService,
    private readonly logger: ILogger
  ) {
    this.swapStepsCache = new Map();
  }

  /**
   * Build swap steps for a multi-hop arbitrage
   *
   * Creates a 2-hop path: tokenIn -> intermediateToken -> tokenOut
   * Includes slippage protection and caching with TTL.
   *
   * @param opportunity - Arbitrage opportunity
   * @param params - Swap parameters (routers, intermediate token, slippage)
   * @returns Array of swap steps with routers and slippage amounts
   * @throws Error if opportunity data is invalid or routers not found
   */
  buildSwapSteps(
    opportunity: ArbitrageOpportunity,
    params: SwapStepsParams
  ): SwapStep[] {
    // Validate opportunity
    if (!opportunity.tokenIn || !opportunity.tokenOut || !opportunity.amountIn) {
      throw new Error('[SwapBuilder] Invalid opportunity: missing required fields');
    }

    if (
      typeof opportunity.buyPrice !== 'number' ||
      typeof opportunity.sellPrice !== 'number' ||
      opportunity.buyPrice <= 0 ||
      opportunity.sellPrice <= 0
    ) {
      throw new Error('[SwapBuilder] Invalid opportunity: invalid prices');
    }

    const slippageBps = params.slippageBps ?? Number(DEFAULT_SLIPPAGE_BPS);
    const cacheKey = `${opportunity.id}:${params.chain}:${slippageBps}`;

    // Check cache
    const cached = this.swapStepsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SwapBuilder.CACHE_TTL_MS) {
      return cached.steps;
    }

    // params.buyRouter and params.sellRouter are already router addresses
    // No need to look them up - use them directly

    // Build 2-hop path: tokenIn -> intermediateToken -> tokenOut
    const amountIn = BigInt(opportunity.amountIn);
    const intermediateAmount = this.estimateIntermediateAmount(
      amountIn,
      opportunity.buyPrice,
      opportunity.tokenIn,
      params.intermediateToken,
      params.chain
    );

    const slippageFactor = BPS_DENOMINATOR - BigInt(slippageBps);

    // Step 1: tokenIn -> intermediateToken (buy)
    const step1AmountOutMin = (intermediateAmount * slippageFactor) / BPS_DENOMINATOR;

    // Step 2: intermediateToken -> tokenIn (sell) - circular for flash loans
    // Flash loan arbitrage requires circular paths: tokenIn -> intermediate -> tokenIn
    // The final token must match the input token to repay the flash loan
    const finalToken = opportunity.tokenIn;
    const finalAmount = this.estimateIntermediateAmount(
      intermediateAmount,
      opportunity.sellPrice,
      params.intermediateToken,
      finalToken,
      params.chain
    );
    const step2AmountOutMin = (finalAmount * slippageFactor) / BPS_DENOMINATOR;

    const steps: SwapStep[] = [
      {
        router: params.buyRouter,
        tokenIn: opportunity.tokenIn,
        tokenOut: params.intermediateToken,
        amountOutMin: step1AmountOutMin
      },
      {
        router: params.sellRouter,
        tokenIn: params.intermediateToken,
        tokenOut: finalToken,
        amountOutMin: step2AmountOutMin
      }
    ];

    // Cache result
    this.swapStepsCache.set(cacheKey, {
      steps,
      timestamp: Date.now()
    });

    // Opportunistic cleanup
    this.cleanStaleCache();
    this.evictOldestIfNeeded();

    return steps;
  }

  /**
   * Estimate intermediate amount using price and token decimals
   *
   * @private
   */
  private estimateIntermediateAmount(
    amountIn: bigint,
    price: number,
    tokenIn: string,
    tokenOut: string,
    chain: string
  ): bigint {
    const decimalsIn = getTokenDecimals(chain, tokenIn);
    const decimalsOut = getTokenDecimals(chain, tokenOut);

    // Convert price to bigint with precision
    const priceBigInt = BigInt(Math.floor(price * 1e6));
    const precisionFactor = 1_000_000n;

    // Calculate: (amountIn * price * 10^decimalsOut) / (10^decimalsIn * precisionFactor)
    const amountOut = (amountIn * priceBigInt * BigInt(10 ** decimalsOut)) /
      (BigInt(10 ** decimalsIn) * precisionFactor);

    return amountOut;
  }

  /**
   * Clean stale cache entries (TTL expired)
   *
   * @private
   */
  private cleanStaleCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.swapStepsCache.entries()) {
      if (now - entry.timestamp >= SwapBuilder.CACHE_TTL_MS) {
        this.swapStepsCache.delete(key);
      }
    }
  }

  /**
   * Evict oldest entry if cache is full (LRU)
   *
   * @private
   */
  private evictOldestIfNeeded(): void {
    if (this.swapStepsCache.size > SwapBuilder.MAX_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTimestamp = Infinity;

      for (const [key, entry] of this.swapStepsCache.entries()) {
        if (entry.timestamp < oldestTimestamp) {
          oldestTimestamp = entry.timestamp;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.swapStepsCache.delete(oldestKey);
      }
    }
  }
}
