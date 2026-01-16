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

import { createLogger } from './logger';
import type { DexPool, TriangularStep, DynamicSlippageConfig } from './cross-dex-triangular-arbitrage';

const logger = createLogger('multi-leg-path-finder');

// BigInt constants for precise calculations
const PRECISION_MULTIPLIER = 10n ** 18n;
const BASIS_POINTS_DIVISOR = 10000n;
const ONE_ETH_WEI = 10n ** 18n;

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

const DEFAULT_CONFIG: MultiLegPathConfig = {
  minProfitThreshold: 0.001,
  maxPathLength: 7,
  minPathLength: 5,
  maxCandidatesPerHop: 15,
  timeoutMs: 5000,
  minConfidence: 0.4
};

const DEFAULT_SLIPPAGE_CONFIG: DynamicSlippageConfig = {
  baseSlippage: 0.003,
  priceImpactScale: 5.0,
  maxSlippage: 0.10,
  minLiquidityUsd: 100000,
  liquidityPenaltyScale: 2.0
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
      tokenPairs: new Map()
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
    ctx.tokenPairs = this.groupPoolsByPairs(pools);

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
        logger.warn('Path finding timeout reached');
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

        // Create new state for recursion
        const newState: PathState = {
          tokens: [...state.tokens, nextToken],
          dexes: [...state.dexes, pool.dex],
          amountBigInt: swapResult.amountOutBigInt,
          steps: [...state.steps, swapResult.step],
          visitedTokens: new Set([...state.visitedTokens, nextToken])
        };

        // Recurse
        await this.dfs(
          newState,
          startToken,
          targetLength,
          chain,
          allPools,
          opportunities,
          ctx
        );
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
    const candidates: Set<string> = new Set();

    // Find all tokens directly connected to current token
    for (const [pairKey] of ctx.tokenPairs) {
      const [tokenA, tokenB] = pairKey.split('_');

      let nextToken: string | null = null;
      if (tokenA === currentToken) {
        nextToken = tokenB;
      } else if (tokenB === currentToken) {
        nextToken = tokenA;
      }

      if (nextToken) {
        // Don't revisit tokens (except start token when closing)
        if (nextToken === startToken) {
          // Only allow returning to start if we're at target length - 1
          if (currentDepth === targetLength - 1) {
            candidates.add(nextToken);
          }
        } else if (!visitedTokens.has(nextToken)) {
          candidates.add(nextToken);
        }
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

    // Total fees
    const totalFees = allSteps.reduce((sum, step) => sum + step.fee, 0);

    // Net profit
    const netProfit = grossProfit - totalFees - gasCost;

    if (netProfit < this.config.minProfitThreshold) {
      return null;
    }

    // Calculate confidence
    const pools = this.getPoolsForPath(state.tokens, state.dexes, closingPool, ctx);
    const confidence = this.calculateConfidence(allSteps, pools);

    if (confidence < (this.config.minConfidence || 0)) {
      return null;
    }

    // Execution time estimate
    const executionTime = this.estimateExecutionTime(chain, allSteps.length);

    // Complete path including return to start
    const completePath = [...state.tokens, startToken];

    // BUG FIX: Calculate actual percentage (grossProfit is already a decimal ratio)
    // profitPercentage should be the percentage form (e.g., 0.01 = 1%)
    const profitPercentage = grossProfit; // grossProfit is profit/investment ratio

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

      // Apply fee
      const feeMultiplierNumerator = BASIS_POINTS_DIVISOR - feeBigInt;
      const amountInWithFee = (amountInBigInt * feeMultiplierNumerator) / BASIS_POINTS_DIVISOR;

      // AMM formula
      const numerator = amountInWithFee * reserveOutBigInt;
      const denominator = reserveInBigInt + amountInWithFee;

      if (denominator === 0n) return null;

      const amountOutBigInt = numerator / denominator;

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
    const config = this.slippageConfig;

    let slippage = config.baseSlippage;

    if (reserveIn > 0) {
      const priceImpact = tradeSize / (reserveIn + tradeSize);
      slippage += priceImpact * config.priceImpactScale;
    }

    if (liquidityUsd > 0 && liquidityUsd < config.minLiquidityUsd) {
      const liquidityRatio = liquidityUsd / config.minLiquidityUsd;
      const liquidityPenalty = (1 - liquidityRatio) * config.liquidityPenaltyScale * 0.01;
      slippage += liquidityPenalty;
    }

    return Math.min(slippage, config.maxSlippage);
  }

  /**
   * Group pools by token pairs for O(1) lookup.
   */
  private groupPoolsByPairs(pools: DexPool[]): Map<string, DexPool[]> {
    const pairs = new Map<string, DexPool[]>();

    for (const pool of pools) {
      const pairKey = `${pool.token0}_${pool.token1}`;
      const reverseKey = `${pool.token1}_${pool.token0}`;

      if (!pairs.has(pairKey)) pairs.set(pairKey, []);
      if (!pairs.has(reverseKey)) pairs.set(reverseKey, []);

      pairs.get(pairKey)!.push(pool);
      pairs.get(reverseKey)!.push(pool);
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
      const poolsForPair = this.findBestPoolsForPair(tokens[i], tokens[i + 1], ctx);
      const pool = poolsForPair.find(p => p.dex === dex);
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
   */
  private estimateGasCost(chain: string, numSteps: number): number {
    const baseGasCosts: { [chain: string]: number } = {
      ethereum: 0.005,
      bsc: 0.0001,
      arbitrum: 0.00005,
      base: 0.00001,
      polygon: 0.0001
    };

    const baseCost = baseGasCosts[chain] || 0.001;
    // Each step adds complexity
    return baseCost * (1 + numSteps * 0.25);
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
        if (opp.netProfit < this.config.minProfitThreshold) return false;

        const maxStepSlippage = Math.max(...opp.steps.map(s => s.slippage));
        if (maxStepSlippage > this.slippageConfig.maxSlippage) return false;

        if (opp.confidence < (this.config.minConfidence || 0)) return false;

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
    return Date.now() - ctx.startTime > this.config.timeoutMs;
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
