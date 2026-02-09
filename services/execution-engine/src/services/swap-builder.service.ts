/**
 * Swap Builder Service
 *
 * Builds swap steps and prepares swap transactions.
 * Includes TTL-based caching for hot-path optimization.
 *
 * @see Finding 9.1: Extract BaseExecutionStrategy shared concerns
 * @see Finding 10.2: Swap steps caching optimization
 */

import type { ILogger } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { DexLookupService } from './dex-lookup.service';

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
  buyRouter: string;
  sellRouter: string;
  intermediateToken: string;
  slippageBps?: number;
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
}
