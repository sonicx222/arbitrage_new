/**
 * T3.11: Multi-Leg Path Finding (5+ tokens)
 *
 * Discovers arbitrage opportunities with 5+ token paths.
 * Uses DFS with pruning for efficient path discovery.
 *
 * Key features:
 * - Supports paths with 5-7 tokens (4-6 swaps)
 * - Cycle detection to find paths returning to start token
 * - Performance safeguards (timeout, max candidates per hop)
 * - BigInt precision for swap calculations
 * - Integration with existing DEX pool data
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding 1.2
 */

import { createLogger } from '../logger';
import {
  getGasPriceCache,
  GAS_UNITS,
  FALLBACK_GAS_COSTS_ETH,
  FALLBACK_GAS_SCALING_PER_STEP,
  GAS_FALLBACK_SAFETY_FACTOR
} from '../caching/gas-price-cache';
import type { DexPool, TriangularStep } from './cross-dex-triangular-arbitrage';
import {
  PRECISION_MULTIPLIER,
  BASIS_POINTS_DIVISOR,
  ONE_ETH_WEI,
  calculateAmmAmountOut,
  calculateDynamicSlippage as calculateDynamicSlippageUtil,
  DEFAULT_SLIPPAGE_CONFIG,
} from '../utils/amm-math';
import type { DynamicSlippageConfig } from '../utils/amm-math';
import { getErrorMessage } from '../resilience/error-handling';
import type { EventProcessingWorkerPool } from '../async/worker-pool';
const logger = createLogger('multi-leg-path-finder');
let hasLoggedWorkerFallback = false;

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for multi-leg path finding.
 */
export interface MultiLegPathConfig {
  /** Minimum profit threshold (decimal, e.g., 0.001 = 0.1%) */
  minProfitThreshold: number;
  /** Maximum path length (tokens including start) */
  maxPathLength: number;
  /** Minimum path length (tokens including start) */
  minPathLength: number;
  /** Maximum candidates to explore per hop (limits branching) */
  maxCandidatesPerHop: number;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Minimum confidence threshold (0-1) */
  minConfidence?: number;
  /** Dynamic slippage configuration */
  slippageConfig?: DynamicSlippageConfig;
  /** Per-chain timeout overrides (ms). Falls back to timeoutMs if chain not specified. */
  chainTimeoutMs?: Record<string, number>;
}

/**
 * Multi-leg arbitrage opportunity (5+ tokens).
 */
export interface MultiLegOpportunity {
  id: string;
  chain: string;
  path: string[]; // Tokens in the path (e.g., ['USDT', 'WETH', 'LINK', 'UNI', 'AAVE'])
  dexes: string[]; // DEXes for each swap
  profitPercentage: number;
  profitUSD: number;
  gasCost: number;
  netProfit: number;
  confidence: number;
  steps: TriangularStep[]; // Reuse existing step interface
  timestamp: number;
  executionTime: number;
  pathLength: number; // Number of hops
}

/**
 * Internal path state during DFS exploration.
 */
interface PathState {
  tokens: string[];
  dexes: string[];
  amountBigInt: bigint;
  steps: TriangularStep[];
  visitedTokens: Set<string>;
}

/**
 * Execution context for a single findMultiLegOpportunities call.
 * This ensures thread-safety by keeping mutable state local to each call.
 * BUG FIX: Previously startTime and tokenPairs were instance variables,
 * causing race conditions when called concurrently.
 */
interface ExecutionContext {
  startTime: number;
  tokenPairs: Map<string, DexPool[]>;
  // P2-FIX 3.1: O(1) lookup index for pool by pair+dex (replaces O(n) .find())
  poolByPairDex: Map<string, DexPool>;
  /** O(1) neighbor lookup: token -> Set of connected tokens */
  adjacencyMap: Map<string, Set<string>>;
  /** Effective timeout for this execution (chain-specific or global fallback) */
  effectiveTimeoutMs: number;
}

/**
 * Statistics for monitoring path finder performance.
 */
export interface PathFinderStats {
  totalCalls: number;
  totalOpportunitiesFound: number;
  totalPathsExplored: number;
  timeouts: number;
  avgProcessingTimeMs: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default configuration for multi-leg path finding.
 * Timeouts and thresholds can be overridden via environment variables.
 *
 * Environment variables:
 * - MULTI_LEG_TIMEOUT_MS: Path finding timeout (default: 5000ms)
 * - MULTI_LEG_MIN_PROFIT: Minimum profit threshold (default: 0.001 = 0.1%)
 * - MULTI_LEG_MAX_CANDIDATES: Max candidates per hop (default: 15)
 */
const DEFAULT_CONFIG: MultiLegPathConfig = {
  minProfitThreshold: parseFloat(process.env.MULTI_LEG_MIN_PROFIT || '0.001'),
  maxPathLength: 6,  // 6 tokens = 5 hops = matches contract MAX_SWAP_HOPS
  minPathLength: 5,
  maxCandidatesPerHop: parseInt(process.env.MULTI_LEG_MAX_CANDIDATES || '15', 10),
  timeoutMs: parseInt(process.env.MULTI_LEG_TIMEOUT_MS || '5000', 10),
  minConfidence: 0.4,
  chainTimeoutMs: {
    ethereum: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_ETHEREUM ?? '5000', 10),
    arbitrum: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_ARBITRUM ?? '1500', 10),
    optimism: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_OPTIMISM ?? '2000', 10),
    base: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_BASE ?? '2000', 10),
    polygon: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_POLYGON ?? '3000', 10),
    bsc: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_BSC ?? '3000', 10),
    avalanche: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_AVALANCHE ?? '3000', 10),
    fantom: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_FANTOM ?? '3000', 10),
    zksync: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_ZKSYNC ?? '2000', 10),
    linea: parseInt(process.env.MULTI_LEG_TIMEOUT_MS_LINEA ?? '2000', 10),
  }
};

// =============================================================================
// Multi-Leg Path Finder
// =============================================================================

/**
 * T3.11: Multi-Leg Path Finder
 *
 * Discovers arbitrage opportunities with 5+ token paths using
 * depth-first search with pruning for efficiency.
 */
export class MultiLegPathFinder {
  private config: MultiLegPathConfig;
  private slippageConfig: DynamicSlippageConfig;
  // BUG FIX: Removed instance-level tokenPairs and startTime
  // These are now passed via ExecutionContext to prevent race conditions
  // when findMultiLegOpportunities is called concurrently
  /**
   * Fix 5.1: Stats for monitoring path finder performance.
   *
   * Note: These stats are intentionally NOT protected by mutex/atomic operations.
   * Concurrent access may cause minor inaccuracies (lost updates), but:
   * 1. Stats are for monitoring only, not critical execution logic
   * 2. Approximate stats are acceptable for dashboards and alerting
   * 3. Atomic operations would add latency to the hot path
   *
   * If exact stats are required, consider aggregating from getStats() calls
   * rather than modifying this to use atomic counters.
   */
  private stats: {
    totalCalls: number;
    totalOpportunitiesFound: number;
    totalPathsExplored: number;
    timeouts: number;
    totalProcessingTimeMs: number;
  };

  constructor(config: Partial<MultiLegPathConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.slippageConfig = config.slippageConfig || DEFAULT_SLIPPAGE_CONFIG;
    this.stats = {
      totalCalls: 0,
      totalOpportunitiesFound: 0,
      totalPathsExplored: 0,
      timeouts: 0,
      totalProcessingTimeMs: 0
    };

    logger.info('MultiLegPathFinder initialized', {
      maxPathLength: this.config.maxPathLength,
      minPathLength: this.config.minPathLength,
      maxCandidatesPerHop: this.config.maxCandidatesPerHop,
      timeoutMs: this.config.timeoutMs
    });
  }

  /**
   * Find multi-leg arbitrage opportunities.
   *
   * @param chain - Blockchain name
   * @param pools - Available DEX pools
   * @param baseTokens - Starting tokens to explore from
   * @param targetPathLength - Exact path length to find (5, 6, or 7 tokens)
   * @returns Array of profitable opportunities
   */
  async findMultiLegOpportunities(
    chain: string,
    pools: DexPool[],
    baseTokens: string[],
    targetPathLength: number
  ): Promise<MultiLegOpportunity[]> {
    // BUG FIX: Create local execution context to prevent race conditions
    // Previously startTime and tokenPairs were instance variables
    const ctx: ExecutionContext = {
      startTime: Date.now(),
      tokenPairs: new Map(),
      // P2-FIX 3.1: O(1) lookup index for pool by pair+dex
      poolByPairDex: new Map(),
      // H2-FIX: O(1) neighbor lookup for DFS getNextCandidates
      adjacencyMap: new Map(),
      // Task 1.2: Use chain-specific timeout, falling back to global timeoutMs
      effectiveTimeoutMs: this.config.chainTimeoutMs?.[chain] ?? this.config.timeoutMs,
    };

    this.stats.totalCalls++;
    const opportunities: MultiLegOpportunity[] = [];

    // Validate inputs
    if (pools.length < targetPathLength) {
      logger.debug('Not enough pools for target path length', {
        pools: pools.length,
        targetPathLength
      });
      return [];
    }

    if (targetPathLength < this.config.minPathLength || targetPathLength > this.config.maxPathLength) {
      logger.warn('Target path length out of range', {
        targetPathLength,
        min: this.config.minPathLength,
        max: this.config.maxPathLength
      });
      return [];
    }

    // Group pools by token pairs for O(1) lookup
    // P2-FIX 3.1: Pass ctx to also build poolByPairDex index
    ctx.tokenPairs = this.groupPoolsByPairs(pools, ctx);

    // H2-FIX: Build adjacency map for O(1) neighbor lookup in DFS
    for (const pool of pools) {
      if (!ctx.adjacencyMap.has(pool.token0)) ctx.adjacencyMap.set(pool.token0, new Set());
      if (!ctx.adjacencyMap.has(pool.token1)) ctx.adjacencyMap.set(pool.token1, new Set());
      ctx.adjacencyMap.get(pool.token0)!.add(pool.token1);
      ctx.adjacencyMap.get(pool.token1)!.add(pool.token0);
    }

    // Count unique tokens
    const uniqueTokens = this.getUniqueTokens(pools);
    if (uniqueTokens.size < targetPathLength) {
      logger.debug('Not enough unique tokens', {
        uniqueTokens: uniqueTokens.size,
        targetPathLength
      });
      return [];
    }

    // Explore paths from each base token
    let timedOut = false;
    for (const baseToken of baseTokens) {
      if (this.isTimeout(ctx)) {
        logger.debug('Path finding timeout reached');
        timedOut = true;
        break;
      }

      const paths = await this.findPathsFromToken(
        baseToken,
        chain,
        targetPathLength,
        pools,
        ctx
      );

      opportunities.push(...paths);
    }

    if (timedOut) {
      this.stats.timeouts++;
    }

    // Filter and rank opportunities
    const validOpportunities = this.filterAndRank(opportunities);

    // Update stats
    const processingTime = Date.now() - ctx.startTime;
    this.stats.totalOpportunitiesFound += validOpportunities.length;
    this.stats.totalProcessingTimeMs += processingTime;

    logger.info('Multi-leg path finding complete', {
      chain,
      totalPools: pools.length,
      targetPathLength,
      foundOpportunities: validOpportunities.length,
      processingTime
    });

    return validOpportunities;
  }

  /**
   * Find all profitable paths starting from a specific token.
   * Uses DFS with pruning.
   */
  private async findPathsFromToken(
    startToken: string,
    chain: string,
    targetLength: number,
    allPools: DexPool[],
    ctx: ExecutionContext
  ): Promise<MultiLegOpportunity[]> {
    const opportunities: MultiLegOpportunity[] = [];

    // Initialize DFS state
    const initialState: PathState = {
      tokens: [startToken],
      dexes: [],
      amountBigInt: ONE_ETH_WEI,
      steps: [],
      visitedTokens: new Set([startToken])
    };

    // Start DFS exploration
    await this.dfs(
      initialState,
      startToken,
      targetLength,
      chain,
      allPools,
      opportunities,
      ctx
    );

    return opportunities;
  }

  /**
   * Depth-first search for path discovery.
   * Explores all valid paths up to target length that return to start token.
   */
  private async dfs(
    state: PathState,
    startToken: string,
    targetLength: number,
    chain: string,
    allPools: DexPool[],
    opportunities: MultiLegOpportunity[],
    ctx: ExecutionContext
  ): Promise<void> {
    // Check timeout
    if (this.isTimeout(ctx)) {
      return;
    }

    this.stats.totalPathsExplored++;
    const currentToken = state.tokens[state.tokens.length - 1];
    const currentDepth = state.tokens.length;

    // If we've reached target length - 1, we need to close the cycle
    if (currentDepth === targetLength) {
      // Try to close the cycle back to start token
      const closingPools = this.findBestPoolsForPair(currentToken, startToken, ctx);

      for (const pool of closingPools.slice(0, 3)) {
        const opportunity = this.evaluateCompletePath(
          state,
          pool,
          startToken,
          chain,
          ctx
        );

        if (opportunity && opportunity.netProfit > 0) {
          opportunities.push(opportunity);
        }
      }
      return;
    }

    // Get next tokens to explore (excluding visited and start token until we're ready to close)
    const nextTokens = this.getNextCandidates(currentToken, state.visitedTokens, startToken, currentDepth, targetLength, ctx);

    // Explore each candidate
    for (const nextToken of nextTokens.slice(0, this.config.maxCandidatesPerHop)) {
      if (this.isTimeout(ctx)) {
        return;
      }

      // Find pools for this hop
      const pools = this.findBestPoolsForPair(currentToken, nextToken, ctx);

      // Try top pools (limit to reduce branching)
      for (const pool of pools.slice(0, 2)) {
        // Simulate swap
        const swapResult = this.simulateSwapBigInt(
          currentToken,
          nextToken,
          state.amountBigInt,
          pool
        );

        if (!swapResult) continue;

        // H1-FIX: Mutable push/pop backtracking instead of spread-operator allocations.
        // Saves 4 array/set allocations per recursive call (up to 759K in deep DFS).
        const savedAmount = state.amountBigInt;
        state.tokens.push(nextToken);
        state.dexes.push(pool.dex);
        state.steps.push(swapResult.step);
        state.visitedTokens.add(nextToken);
        state.amountBigInt = swapResult.amountOutBigInt;

        // Recurse with mutated state
        await this.dfs(
          state,
          startToken,
          targetLength,
          chain,
          allPools,
          opportunities,
          ctx
        );

        // Backtrack: restore state for next iteration
        state.tokens.pop();
        state.dexes.pop();
        state.steps.pop();
        state.visitedTokens.delete(nextToken);
        state.amountBigInt = savedAmount;
      }
    }
  }

  /**
   * Get candidate tokens for next hop.
   */
  private getNextCandidates(
    currentToken: string,
    visitedTokens: Set<string>,
    startToken: string,
    currentDepth: number,
    targetLength: number,
    ctx: ExecutionContext
  ): string[] {
    // H2-FIX: Use adjacency map for O(1) neighbor lookup instead of O(P) tokenPairs scan
    const neighbors = ctx.adjacencyMap.get(currentToken);
    if (!neighbors) return [];

    const candidates: string[] = [];

    for (const nextToken of neighbors) {
      // Don't revisit tokens (except start token when closing)
      if (nextToken === startToken) {
        // Only allow returning to start if we're at target length - 1
        if (currentDepth === targetLength - 1) {
          candidates.push(nextToken);
        }
      } else if (!visitedTokens.has(nextToken)) {
        candidates.push(nextToken);
      }
    }

    // Sort by liquidity (prefer high-liquidity paths)
    return Array.from(candidates).sort((a, b) => {
      const liquidityA = this.getMaxLiquidity(currentToken, a, ctx);
      const liquidityB = this.getMaxLiquidity(currentToken, b, ctx);
      return liquidityB - liquidityA;
    });
  }

  /**
   * Evaluate a complete path and create opportunity if profitable.
   */
  private evaluateCompletePath(
    state: PathState,
    closingPool: DexPool,
    startToken: string,
    chain: string,
    ctx: ExecutionContext
  ): MultiLegOpportunity | null {
    const currentToken = state.tokens[state.tokens.length - 1];

    // Simulate closing swap
    const closingSwap = this.simulateSwapBigInt(
      currentToken,
      startToken,
      state.amountBigInt,
      closingPool
    );

    if (!closingSwap) return null;

    // Calculate profit
    const finalAmount = closingSwap.amountOutBigInt;
    const profitBigInt = finalAmount - ONE_ETH_WEI;
    const grossProfitScaled = (profitBigInt * PRECISION_MULTIPLIER) / ONE_ETH_WEI;
    const grossProfit = Number(grossProfitScaled) / Number(PRECISION_MULTIPLIER);

    // All steps including closing
    const allSteps = [...state.steps, closingSwap.step];
    const allDexes = [...state.dexes, closingPool.dex];

    // Gas cost (increases with hops)
    const gasCost = this.estimateGasCost(chain, allSteps.length);

    // Net profit after gas (fees already applied in AMM simulation via simulateSwapBigInt)
    const netProfit = grossProfit - gasCost;

    if (netProfit < this.config.minProfitThreshold) {
      return null;
    }

    // Calculate confidence
    const pools = this.getPoolsForPath(state.tokens, state.dexes, closingPool, ctx);
    const confidence = this.calculateConfidence(allSteps, pools);

    if (confidence < (this.config.minConfidence ?? 0)) {
      return null;
    }

    // Execution time estimate
    const executionTime = this.estimateExecutionTime(chain, allSteps.length);

    // Complete path including return to start
    const completePath = [...state.tokens, startToken];

    // profitPercentage uses netProfit (consistent with cross-dex-triangular-arbitrage)
    const profitPercentage = netProfit;

    return {
      id: `multi_${chain}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      chain,
      path: completePath,
      dexes: allDexes,
      profitPercentage,
      profitUSD: netProfit * this.getBaseTokenUsdPrice(chain), // Use configurable price
      gasCost,
      netProfit,
      confidence,
      steps: allSteps,
      timestamp: Date.now(),
      executionTime,
      pathLength: completePath.length - 1 // Number of swaps
    };
  }

  /**
   * Simulate a swap using BigInt for precision.
   */
  private simulateSwapBigInt(
    fromToken: string,
    toToken: string,
    amountInBigInt: bigint,
    pool: DexPool
  ): { amountOutBigInt: bigint; step: TriangularStep } | null {
    try {
      let reserveInStr: string, reserveOutStr: string;

      if (pool.token0 === fromToken && pool.token1 === toToken) {
        reserveInStr = pool.reserve0;
        reserveOutStr = pool.reserve1;
      } else if (pool.token0 === toToken && pool.token1 === fromToken) {
        reserveInStr = pool.reserve1;
        reserveOutStr = pool.reserve0;
      } else {
        return null;
      }

      const reserveInBigInt = BigInt(reserveInStr);
      const reserveOutBigInt = BigInt(reserveOutStr);
      const feeBigInt = BigInt(pool.fee);

      // AMM constant-product formula (shared)
      const amountOutBigInt = calculateAmmAmountOut(amountInBigInt, reserveInBigInt, reserveOutBigInt, feeBigInt);
      if (amountOutBigInt === null) return null;

      // Calculate dynamic slippage
      const reserveInNumber = Number(reserveInBigInt / (10n ** 12n)) / 1e6;
      const amountInNumber = Number(amountInBigInt / (10n ** 12n)) / 1e6;
      const slippage = this.calculateDynamicSlippage(amountInNumber, reserveInNumber, pool.liquidity);

      // Create step for display
      const step: TriangularStep = {
        fromToken,
        toToken,
        dex: pool.dex,
        amountIn: Number(amountInBigInt) / 1e18,
        amountOut: Number(amountOutBigInt) / 1e18,
        price: pool.price,
        fee: pool.fee / 10000,
        slippage
      };

      return { amountOutBigInt, step };
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate dynamic slippage based on trade size and liquidity.
   */
  private calculateDynamicSlippage(
    tradeSize: number,
    reserveIn: number,
    liquidityUsd: number
  ): number {
    return calculateDynamicSlippageUtil(tradeSize, reserveIn, liquidityUsd, this.slippageConfig);
  }

  /**
   * Group pools by token pairs for O(1) lookup.
   * P2-FIX 3.1: Also populates poolByPairDex for O(1) lookup by pair+dex.
   */
  private groupPoolsByPairs(pools: DexPool[], ctx: ExecutionContext): Map<string, DexPool[]> {
    const pairs = new Map<string, DexPool[]>();

    for (const pool of pools) {
      const pairKey = `${pool.token0}_${pool.token1}`;
      const reverseKey = `${pool.token1}_${pool.token0}`;

      if (!pairs.has(pairKey)) pairs.set(pairKey, []);
      if (!pairs.has(reverseKey)) pairs.set(reverseKey, []);

      pairs.get(pairKey)!.push(pool);
      pairs.get(reverseKey)!.push(pool);

      // P2-FIX 3.1: Build O(1) index for pool by pair+dex
      // Key format: "${pairKey}_${dex}" for direct lookup without iteration
      const pairDexKey = `${pairKey}_${pool.dex}`;
      const reverseDexKey = `${reverseKey}_${pool.dex}`;
      ctx.poolByPairDex.set(pairDexKey, pool);
      ctx.poolByPairDex.set(reverseDexKey, pool);
    }

    // Sort by liquidity
    for (const poolList of pairs.values()) {
      poolList.sort((a, b) => b.liquidity - a.liquidity);
    }

    return pairs;
  }

  /**
   * Find best pools for a token pair.
   */
  private findBestPoolsForPair(tokenA: string, tokenB: string, ctx: ExecutionContext): DexPool[] {
    const pairKey = `${tokenA}_${tokenB}`;
    return ctx.tokenPairs.get(pairKey) || [];
  }

  /**
   * Get maximum liquidity for a token pair.
   */
  private getMaxLiquidity(tokenA: string, tokenB: string, ctx: ExecutionContext): number {
    const pools = this.findBestPoolsForPair(tokenA, tokenB, ctx);
    return pools.length > 0 ? pools[0].liquidity : 0;
  }

  /**
   * Get unique tokens from pools.
   */
  private getUniqueTokens(pools: DexPool[]): Set<string> {
    const tokens = new Set<string>();
    for (const pool of pools) {
      tokens.add(pool.token0);
      tokens.add(pool.token1);
    }
    return tokens;
  }

  /**
   * Get pools for a complete path.
   * P2-FIX 3.1: Uses O(1) poolByPairDex index instead of O(n) .find()
   */
  private getPoolsForPath(
    tokens: string[],
    dexes: string[],
    closingPool: DexPool,
    ctx: ExecutionContext
  ): DexPool[] {
    const pools: DexPool[] = [];

    for (let i = 0; i < tokens.length - 1; i++) {
      const dex = dexes[i];
      // P2-FIX 3.1: O(1) lookup instead of O(n) .find()
      const pairKey = `${tokens[i]}_${tokens[i + 1]}`;
      const pairDexKey = `${pairKey}_${dex}`;
      const pool = ctx.poolByPairDex.get(pairDexKey);
      if (pool) pools.push(pool);
    }

    pools.push(closingPool);
    return pools;
  }

  /**
   * Calculate confidence score based on liquidity and slippage.
   */
  private calculateConfidence(steps: TriangularStep[], pools: DexPool[]): number {
    if (steps.length === 0 || pools.length === 0) return 0;

    let totalConfidence = 0;

    for (let i = 0; i < steps.length && i < pools.length; i++) {
      const step = steps[i];
      const pool = pools[i];

      // Liquidity confidence (higher liquidity = higher confidence)
      const liquidityConfidence = Math.min(1, pool.liquidity / 1000000);

      // Slippage confidence (lower slippage = higher confidence)
      const slippageConfidence = Math.max(0, 1 - step.slippage / this.slippageConfig.maxSlippage);

      // Fee confidence
      const feeConfidence = Math.max(0, 1 - pool.fee / 100);

      const stepConfidence = (liquidityConfidence + slippageConfidence + feeConfidence) / 3;
      totalConfidence += stepConfidence;
    }

    // Multi-leg paths have inherently lower confidence due to complexity
    const pathLengthPenalty = Math.max(0.7, 1 - (steps.length - 3) * 0.05);

    return (totalConfidence / steps.length) * pathLengthPenalty;
  }

  /**
   * Estimate gas cost for execution.
   * Phase 2: Uses dynamic gas pricing from GasPriceCache.
   * Returns gas cost as a ratio of trade amount (to match grossProfit units).
   */
  private estimateGasCost(chain: string, numSteps: number): number {
    try {
      const gasCache = getGasPriceCache();
      // Use consolidated method for consistent gas cost ratio calculation
      return gasCache.estimateGasCostRatio(chain, 'multiLeg', numSteps);
    } catch {
      // Fallback to static estimates if cache fails
      // Uses shared constants for consistency across detectors
      const baseCost = FALLBACK_GAS_COSTS_ETH[chain] ?? 0.001;
      return baseCost * GAS_FALLBACK_SAFETY_FACTOR * (1 + numSteps * FALLBACK_GAS_SCALING_PER_STEP);
    }
  }

  /**
   * Estimate execution time.
   */
  private estimateExecutionTime(chain: string, numSteps: number): number {
    const baseExecutionTimes: { [chain: string]: number } = {
      ethereum: 15000,
      bsc: 3000,
      arbitrum: 1000,
      base: 2000,
      polygon: 2000
    };

    const baseTime = baseExecutionTimes[chain] || 5000;
    const stepTime = 500;
    return baseTime + (numSteps * stepTime);
  }

  /**
   * Filter and rank opportunities.
   */
  private filterAndRank(opportunities: MultiLegOpportunity[]): MultiLegOpportunity[] {
    return opportunities
      .filter(opp => {
        // Require at least two distinct DEXes to avoid same-DEX loop noise.
        if (new Set(opp.dexes).size < 2) return false;

        if (opp.netProfit < this.config.minProfitThreshold) return false;

        const maxStepSlippage = Math.max(...opp.steps.map(s => s.slippage));
        if (maxStepSlippage > this.slippageConfig.maxSlippage) return false;

        if (opp.confidence < (this.config.minConfidence ?? 0)) return false;

        return true;
      })
      .sort((a, b) => {
        // Sort by net profit descending
        if (Math.abs(a.netProfit - b.netProfit) > 0.001) {
          return b.netProfit - a.netProfit;
        }
        // Then by confidence
        if (Math.abs(a.confidence - b.confidence) > 0.1) {
          return b.confidence - a.confidence;
        }
        // Then by execution time
        return a.executionTime - b.executionTime;
      })
      .slice(0, 20); // Return top 20 opportunities
  }

  /**
   * Check if timeout has been reached.
   */
  private isTimeout(ctx: ExecutionContext): boolean {
    return Date.now() - ctx.startTime > ctx.effectiveTimeoutMs;
  }

  /**
   * Get approximate USD price for base token on chain.
   * BUG FIX: Replaced hardcoded 2000 magic number with configurable values.
   */
  private getBaseTokenUsdPrice(chain: string): number {
    // Approximate prices for native tokens (in production, use price oracle)
    const chainPrices: { [chain: string]: number } = {
      ethereum: 2500,  // ETH
      bsc: 300,        // BNB
      arbitrum: 2500,  // ETH
      base: 2500,      // ETH
      polygon: 0.5     // MATIC
    };
    return chainPrices[chain] || 2000;
  }

  /**
   * Get current configuration.
   */
  getConfig(): MultiLegPathConfig {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<MultiLegPathConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.slippageConfig) {
      this.slippageConfig = { ...this.slippageConfig, ...config.slippageConfig };
    }
    logger.info('MultiLegPathFinder config updated', config);
  }

  /**
   * Get path finder statistics.
   */
  getStats(): PathFinderStats {
    const avgTime = this.stats.totalCalls > 0
      ? this.stats.totalProcessingTimeMs / this.stats.totalCalls
      : 0;

    return {
      totalCalls: this.stats.totalCalls,
      totalOpportunitiesFound: this.stats.totalOpportunitiesFound,
      totalPathsExplored: this.stats.totalPathsExplored,
      timeouts: this.stats.timeouts,
      avgProcessingTimeMs: avgTime
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalCalls: 0,
      totalOpportunitiesFound: 0,
      totalPathsExplored: 0,
      timeouts: 0,
      totalProcessingTimeMs: 0
    };
  }

  /**
   * Find multi-leg arbitrage opportunities using worker thread.
   * Offloads CPU-intensive DFS from main event loop to prevent blocking.
   *
   * @param chain - Blockchain name
   * @param pools - Available DEX pools
   * @param baseTokens - Starting tokens to explore from
   * @param targetPathLength - Exact path length to find (5, 6, or 7 tokens)
   * @param workerPool - Optional worker pool instance (lazy loaded if not provided)
   * @returns Promise of array of profitable opportunities
   */
  async findMultiLegOpportunitiesAsync(
    chain: string,
    pools: DexPool[],
    baseTokens: string[],
    targetPathLength: number,
    workerPool?: EventProcessingWorkerPool
  ): Promise<MultiLegOpportunity[]> {
    // Lazy import worker pool to avoid circular dependencies
    const pool = workerPool || (await import('../async/worker-pool')).getWorkerPool();

    // Start pool lazily when first needed by path finding.
    let health = pool.getHealthStatus?.();
    if (!health?.healthy && typeof pool.start === 'function') {
      try {
        await pool.start();
        health = pool.getHealthStatus?.();
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        logger.warn('Failed to start worker pool for multi-leg path finding', { error: errorMessage });
      }
    }

    if (!health?.healthy) {
      // Fallback to synchronous execution if worker pool not available
      if (!hasLoggedWorkerFallback) {
        logger.warn('Worker pool not healthy, falling back to synchronous execution', {
          chain,
          poolHealth: health || null
        });
        hasLoggedWorkerFallback = true;
      }
      return this.findMultiLegOpportunities(chain, pools, baseTokens, targetPathLength);
    }
    hasLoggedWorkerFallback = false;

    const taskId = `multi_leg_${chain}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
      const result = await pool.submitTask({
        id: taskId,
        type: 'multi_leg_path_finding',
        data: {
          chain,
          pools,
          baseTokens,
          targetPathLength,
          config: this.config
        },
        priority: 5, // Medium-high priority for path finding
        timeout: this.config.timeoutMs + 1000 // Allow extra buffer
      });

      if (result.success && result.result) {
        // Update local stats from worker result
        const workerResult = result.result as { stats?: { pathsExplored?: number; processingTimeMs?: number }; opportunities?: unknown[] };
        if (workerResult.stats) {
          this.stats.totalCalls++;
          this.stats.totalPathsExplored += workerResult.stats.pathsExplored ?? 0;
          this.stats.totalOpportunitiesFound += workerResult.opportunities?.length ?? 0;
          this.stats.totalProcessingTimeMs += workerResult.stats.processingTimeMs ?? 0;
        }

        return (workerResult.opportunities || []) as MultiLegOpportunity[];
      }

      logger.warn('Worker task failed, falling back to sync', { taskId, error: result.error });
      return this.findMultiLegOpportunities(chain, pools, baseTokens, targetPathLength);

    } catch (error) {
      logger.error('Worker task threw exception, falling back to sync', { taskId, error });
      return this.findMultiLegOpportunities(chain, pools, baseTokens, targetPathLength);
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

/**
 * Singleton Pattern Note:
 * This uses a configurable singleton pattern rather than `createSingleton` from async-singleton.ts
 * because it requires configuration parameters on first initialization. The standard createSingleton
 * pattern uses a fixed factory function which doesn't support runtime configuration.
 *
 * Thread safety: JavaScript is single-threaded for synchronous code, so this pattern
 * is safe. The check-and-set is atomic in the JS event loop.
 *
 * Note: The findMultiLegOpportunities method is internally thread-safe for concurrent
 * calls due to the ExecutionContext pattern - each call gets its own isolated state.
 */
let pathFinderInstance: MultiLegPathFinder | null = null;

/**
 * Get the singleton MultiLegPathFinder instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton MultiLegPathFinder instance
 */
export function getMultiLegPathFinder(config?: Partial<MultiLegPathConfig>): MultiLegPathFinder {
  if (!pathFinderInstance) {
    pathFinderInstance = new MultiLegPathFinder(config);
  }
  return pathFinderInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export function resetMultiLegPathFinder(): void {
  if (pathFinderInstance) {
    pathFinderInstance.resetStats();
  }
  pathFinderInstance = null;
}
