// Cross-DEX Triangular Arbitrage Engine
// Finds arbitrage opportunities across multiple DEXes on the same blockchain
// P0-FIX: Uses BigInt for precise wei calculations to prevent precision loss

import { createLogger } from './logger';
import { getHierarchicalCache } from './hierarchical-cache';

const logger = createLogger('cross-dex-triangular-arbitrage');

// P0-FIX: Constants for BigInt calculations
const PRECISION_MULTIPLIER = 10n ** 18n; // 18 decimal places for wei precision
const BASIS_POINTS_DIVISOR = 10000n;
const ONE_ETH_WEI = 10n ** 18n; // 1 ETH in wei

export interface DexPool {
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number; // Fee in basis points (e.g., 30 for 0.3%)
  liquidity: number; // Total liquidity in USD
  price: number; // token1/token0 price
}

export interface TriangularOpportunity {
  id: string;
  chain: string;
  path: [string, string, string]; // Three tokens in the triangle
  dexes: [string, string, string]; // DEXes for each leg
  profitPercentage: number;
  profitUSD: number;
  gasCost: number;
  netProfit: number;
  confidence: number;
  steps: TriangularStep[];
  timestamp: number;
  executionTime: number; // Estimated execution time in ms
}

export interface TriangularStep {
  fromToken: string;
  toToken: string;
  dex: string;
  amountIn: number;
  amountOut: number;
  price: number;
  fee: number;
  slippage: number;
}

export interface ArbitragePath {
  tokens: string[];
  dexes: string[];
  profit: number;
  gasEstimate: number;
  executionComplexity: number; // 1-10 scale
}

/**
 * T2.6: Quadrilateral (4-hop) arbitrage opportunity.
 * Path: A → B → C → D → A (4 tokens, 4 swaps)
 */
export interface QuadrilateralOpportunity {
  id: string;
  chain: string;
  path: [string, string, string, string]; // Four unique tokens in the quadrilateral
  dexes: [string, string, string, string]; // DEXes for each leg
  profitPercentage: number;
  profitUSD: number;
  gasCost: number;
  netProfit: number;
  confidence: number;
  steps: TriangularStep[]; // Reuse step interface (4 steps)
  timestamp: number;
  executionTime: number;
}

/**
 * T1.2: Dynamic slippage configuration for liquidity-aware calculations.
 * Instead of using a static maxSlippage, we calculate slippage dynamically
 * based on trade size relative to pool reserves.
 */
export interface DynamicSlippageConfig {
  /** Base slippage floor (minimum slippage regardless of liquidity) */
  baseSlippage: number;
  /** Scale factor for price impact contribution */
  priceImpactScale: number;
  /** Maximum allowed slippage (hard cap) */
  maxSlippage: number;
  /** Minimum liquidity (USD) for confident trades */
  minLiquidityUsd: number;
  /** Liquidity penalty scale (higher = more penalty for low liquidity) */
  liquidityPenaltyScale: number;
}

const DEFAULT_SLIPPAGE_CONFIG: DynamicSlippageConfig = {
  baseSlippage: 0.003,      // 0.3% base slippage floor
  priceImpactScale: 5.0,    // Price impact multiplied by this factor
  maxSlippage: 0.10,        // 10% hard cap (was 2%)
  minLiquidityUsd: 100000,  // $100K minimum for full confidence
  liquidityPenaltyScale: 2.0 // Penalty factor for low liquidity
};

export class CrossDexTriangularArbitrage {
  private cache = getHierarchicalCache();
  private minProfitThreshold = 0.005; // 0.5% minimum profit
  private maxSlippage = 0.10; // T1.2: Increased cap to 10% (dynamic calculation handles most cases)
  private maxExecutionTime = 5000; // 5 seconds max execution time

  /** T1.2: Dynamic slippage configuration */
  private slippageConfig: DynamicSlippageConfig;

  constructor(options?: {
    minProfitThreshold?: number;
    maxSlippage?: number;
    maxExecutionTime?: number;
    slippageConfig?: Partial<DynamicSlippageConfig>;
  }) {
    // T1.2: Initialize dynamic slippage config with defaults
    this.slippageConfig = { ...DEFAULT_SLIPPAGE_CONFIG, ...options?.slippageConfig };

    if (options) {
      // BUG FIX: Use ?? instead of || to correctly handle explicit 0 values
      this.minProfitThreshold = options.minProfitThreshold ?? this.minProfitThreshold;
      this.maxSlippage = options.maxSlippage ?? this.slippageConfig.maxSlippage;
      this.maxExecutionTime = options.maxExecutionTime ?? this.maxExecutionTime;
    }
  }

  /**
   * T1.2: Calculate dynamic slippage based on trade size, pool reserves, and liquidity.
   *
   * Formula: slippage = baseSlippage + (priceImpact * priceImpactScale) + liquidityPenalty
   *
   * Where:
   * - priceImpact = tradeSize / (reserveIn + tradeSize) [standard AMM formula]
   * - liquidityPenalty = max(0, (minLiquidity - actualLiquidity) / minLiquidity * liquidityPenaltyScale * 0.01)
   *
   * @param tradeSize Trade size in pool units
   * @param reserveIn Reserve of input token
   * @param liquidityUsd Total pool liquidity in USD
   * @returns Dynamic slippage value (capped at maxSlippage)
   */
  calculateDynamicSlippage(
    tradeSize: number,
    reserveIn: number,
    liquidityUsd: number = 0
  ): number {
    const config = this.slippageConfig;

    // Base slippage floor
    let slippage = config.baseSlippage;

    // Price impact contribution (standard AMM formula)
    if (reserveIn > 0) {
      const priceImpact = tradeSize / (reserveIn + tradeSize);
      slippage += priceImpact * config.priceImpactScale;
    }

    // Liquidity penalty for low-liquidity pools
    if (liquidityUsd > 0 && liquidityUsd < config.minLiquidityUsd) {
      const liquidityRatio = liquidityUsd / config.minLiquidityUsd;
      const liquidityPenalty = (1 - liquidityRatio) * config.liquidityPenaltyScale * 0.01;
      slippage += liquidityPenalty;
    }

    // Cap at maximum slippage
    return Math.min(slippage, config.maxSlippage);
  }

  // Find triangular arbitrage opportunities across DEXes
  async findTriangularOpportunities(
    chain: string,
    pools: DexPool[],
    baseTokens: string[] = ['USDT', 'USDC', 'WETH', 'WBTC']
  ): Promise<TriangularOpportunity[]> {
    const startTime = Date.now();
    const opportunities: TriangularOpportunity[] = [];

    // Group pools by token pairs for efficient lookup
    const tokenPairs = this.groupPoolsByPairs(pools);

    // Find all possible triangles starting from base tokens
    for (const baseToken of baseTokens) {
      const triangles = await this.findTrianglesFromBaseToken(
        baseToken,
        tokenPairs,
        pools,
        chain
      );

      opportunities.push(...triangles);
    }

    // Filter and rank opportunities
    const validOpportunities = this.filterAndRankOpportunities(opportunities);

    const processingTime = Date.now() - startTime;
    logger.info(`Found ${validOpportunities.length} triangular arbitrage opportunities`, {
      chain,
      totalPools: pools.length,
      processingTime,
      profitRange: validOpportunities.length > 0 ?
        `${Math.min(...validOpportunities.map(o => o.profitPercentage)).toFixed(3)}% - ${Math.max(...validOpportunities.map(o => o.profitPercentage)).toFixed(3)}%` :
        'N/A'
    });

    return validOpportunities;
  }

  // ===========================================================================
  // T2.6: Quadrilateral Arbitrage Detection
  // ===========================================================================

  /**
   * T2.6: Find quadrilateral (4-hop) arbitrage opportunities.
   * Detects A → B → C → D → A paths for potential profit.
   */
  async findQuadrilateralOpportunities(
    chain: string,
    pools: DexPool[],
    baseTokens: string[] = ['USDT', 'USDC', 'WETH', 'WBTC']
  ): Promise<QuadrilateralOpportunity[]> {
    const startTime = Date.now();
    const opportunities: QuadrilateralOpportunity[] = [];

    if (pools.length < 4) {
      // Need at least 4 pools for a quadrilateral
      return [];
    }

    // Group pools by token pairs for efficient lookup
    const tokenPairs = this.groupPoolsByPairs(pools);

    // Find all possible quadrilaterals starting from base tokens
    for (const baseToken of baseTokens) {
      const quads = await this.findQuadrilateralsFromBaseToken(
        baseToken,
        tokenPairs,
        pools,
        chain
      );

      opportunities.push(...quads);
    }

    // Filter and rank opportunities
    const validOpportunities = this.filterAndRankQuadrilaterals(opportunities);

    const processingTime = Date.now() - startTime;
    logger.info(`Found ${validOpportunities.length} quadrilateral arbitrage opportunities`, {
      chain,
      totalPools: pools.length,
      processingTime,
      profitRange: validOpportunities.length > 0 ?
        `${Math.min(...validOpportunities.map(o => o.profitPercentage)).toFixed(3)}% - ${Math.max(...validOpportunities.map(o => o.profitPercentage)).toFixed(3)}%` :
        'N/A'
    });

    return validOpportunities;
  }

  /**
   * T2.6: Find quadrilaterals starting from a specific base token.
   */
  private async findQuadrilateralsFromBaseToken(
    baseToken: string,
    tokenPairs: Map<string, DexPool[]>,
    allPools: DexPool[],
    chain: string
  ): Promise<QuadrilateralOpportunity[]> {
    const opportunities: QuadrilateralOpportunity[] = [];

    // Get all tokens reachable from base token
    const reachableTokens = this.findReachableTokens(baseToken, tokenPairs);

    // Need at least 4 tokens for a quadrilateral (including base)
    if (reachableTokens.length < 4) {
      return [];
    }

    // Try all possible quadrilaterals: baseToken -> tokenA -> tokenB -> tokenC -> baseToken
    // Use a limit on combinations to avoid O(n^3) explosion
    const maxTokensToCheck = Math.min(reachableTokens.length, 20); // Limit search space
    const tokensToCheck = reachableTokens.slice(0, maxTokensToCheck);

    for (const tokenA of tokensToCheck) {
      if (tokenA === baseToken) continue;

      for (const tokenB of tokensToCheck) {
        if (tokenB === baseToken || tokenB === tokenA) continue;

        for (const tokenC of tokensToCheck) {
          if (tokenC === baseToken || tokenC === tokenA || tokenC === tokenB) continue;

          // Check if we can form a valid quadrilateral
          const quad = await this.evaluateQuadrilateral(
            [baseToken, tokenA, tokenB, tokenC, baseToken],
            tokenPairs,
            allPools,
            chain
          );

          if (quad && quad.netProfit > 0) {
            opportunities.push(quad);
          }
        }
      }
    }

    return opportunities;
  }

  /**
   * T2.6: Evaluate a potential quadrilateral arbitrage.
   */
  private async evaluateQuadrilateral(
    tokens: [string, string, string, string, string], // [start, A, B, C, end]
    tokenPairs: Map<string, DexPool[]>,
    allPools: DexPool[],
    chain: string
  ): Promise<QuadrilateralOpportunity | null> {
    const [token0, token1, token2, token3, token4] = tokens;
    if (token4 !== token0) return null; // Must close the quadrilateral

    // Find best DEXes for each leg
    const leg1Pools = this.findBestPoolsForPair(tokenPairs, token0, token1);
    const leg2Pools = this.findBestPoolsForPair(tokenPairs, token1, token2);
    const leg3Pools = this.findBestPoolsForPair(tokenPairs, token2, token3);
    const leg4Pools = this.findBestPoolsForPair(tokenPairs, token3, token0);

    if (leg1Pools.length === 0 || leg2Pools.length === 0 ||
        leg3Pools.length === 0 || leg4Pools.length === 0) {
      return null;
    }

    // Try different combinations of DEXes (top 2 per leg to limit combinations)
    const opportunities: QuadrilateralOpportunity[] = [];

    for (const pool1 of leg1Pools.slice(0, 2)) {
      for (const pool2 of leg2Pools.slice(0, 2)) {
        for (const pool3 of leg3Pools.slice(0, 2)) {
          for (const pool4 of leg4Pools.slice(0, 2)) {
            const opportunity = await this.simulateQuadrilateral(
              [token0, token1, token2, token3, token0],
              [pool1, pool2, pool3, pool4],
              chain
            );

            if (opportunity && opportunity.netProfit > 0) {
              opportunities.push(opportunity);
            }
          }
        }
      }
    }

    // Return the best opportunity
    return opportunities.sort((a, b) => b.netProfit - a.netProfit)[0] || null;
  }

  /**
   * T2.6: Simulate a quadrilateral arbitrage execution.
   * Uses BigInt for precise wei calculations (same as triangular).
   */
  private async simulateQuadrilateral(
    tokens: [string, string, string, string, string],
    pools: [DexPool, DexPool, DexPool, DexPool],
    chain: string
  ): Promise<QuadrilateralOpportunity | null> {
    const [token0, token1, token2, token3, token4] = tokens;
    const [pool1, pool2, pool3, pool4] = pools;

    // Use BigInt for wei amounts to prevent precision loss
    let amountBigInt = ONE_ETH_WEI;
    const initialAmountBigInt = ONE_ETH_WEI;
    const steps: TriangularStep[] = [];

    try {
      // Leg 1: token0 -> token1
      const step1 = this.simulateSwapBigInt(token0, token1, amountBigInt, pool1);
      amountBigInt = step1.amountOutBigInt;
      steps.push(step1.step);

      // Leg 2: token1 -> token2
      const step2 = this.simulateSwapBigInt(token1, token2, amountBigInt, pool2);
      amountBigInt = step2.amountOutBigInt;
      steps.push(step2.step);

      // Leg 3: token2 -> token3
      const step3 = this.simulateSwapBigInt(token2, token3, amountBigInt, pool3);
      amountBigInt = step3.amountOutBigInt;
      steps.push(step3.step);

      // Leg 4: token3 -> token0 (close quadrilateral)
      const step4 = this.simulateSwapBigInt(token3, token0, amountBigInt, pool4);
      amountBigInt = step4.amountOutBigInt;
      steps.push(step4.step);

      // Calculate profit using BigInt then convert to decimal
      const profitBigInt = amountBigInt - initialAmountBigInt;
      const grossProfitScaled = (profitBigInt * PRECISION_MULTIPLIER) / initialAmountBigInt;
      const grossProfit = Number(grossProfitScaled) / Number(PRECISION_MULTIPLIER);

      // Estimate gas costs (4 swaps = higher gas than triangular)
      const gasCost = this.estimateGasCost(chain, steps.length);

      // Calculate net profit after fees and gas
      const totalFees = steps.reduce((sum, step) => sum + step.fee, 0);
      const netProfit = grossProfit - totalFees - gasCost;

      if (netProfit < this.minProfitThreshold) {
        return null;
      }

      // Estimate execution time
      const executionTime = this.estimateExecutionTime(chain, steps);

      // Calculate confidence based on liquidity and slippage
      const confidence = this.calculateConfidence(steps, pools);

      const opportunity: QuadrilateralOpportunity = {
        id: `quad_${chain}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        chain,
        path: [token0, token1, token2, token3],
        dexes: [pool1.dex, pool2.dex, pool3.dex, pool4.dex],
        profitPercentage: netProfit,
        profitUSD: netProfit * 2000, // Rough ETH to USD conversion
        gasCost,
        netProfit,
        confidence,
        steps,
        timestamp: Date.now(),
        executionTime
      };

      return opportunity;

    } catch (error: any) {
      logger.debug('Quadrilateral simulation failed', {
        tokens,
        dexes: pools.map(p => p.dex),
        error: error.message
      });
      return null;
    }
  }

  /**
   * T2.6: Filter and rank quadrilateral opportunities.
   */
  private filterAndRankQuadrilaterals(opportunities: QuadrilateralOpportunity[]): QuadrilateralOpportunity[] {
    return opportunities
      .filter(opp => {
        // Filter by minimum profit
        if (opp.netProfit < this.minProfitThreshold) return false;

        // Filter by maximum slippage
        const maxStepSlippage = Math.max(...opp.steps.map(s => s.slippage));
        if (maxStepSlippage > this.maxSlippage) return false;

        // Filter by execution time
        if (opp.executionTime > this.maxExecutionTime) return false;

        // Filter by confidence (slightly lower threshold for 4-hop due to complexity)
        if (opp.confidence < 0.5) return false; // Minimum 50% confidence

        return true;
      })
      .sort((a, b) => {
        // Rank by net profit, then by confidence, then by execution time
        if (Math.abs(a.netProfit - b.netProfit) > 0.001) {
          return b.netProfit - a.netProfit;
        }
        if (Math.abs(a.confidence - b.confidence) > 0.1) {
          return b.confidence - a.confidence;
        }
        return a.executionTime - b.executionTime;
      })
      .slice(0, 10); // Return top 10 opportunities
  }

  // Find triangles starting from a specific base token
  private async findTrianglesFromBaseToken(
    baseToken: string,
    tokenPairs: Map<string, DexPool[]>,
    allPools: DexPool[],
    chain: string
  ): Promise<TriangularOpportunity[]> {
    const opportunities: TriangularOpportunity[] = [];

    // Get all tokens that can be reached from base token
    const reachableTokens = this.findReachableTokens(baseToken, tokenPairs);

    // Try all possible triangles: baseToken -> tokenA -> tokenB -> baseToken
    for (const tokenA of reachableTokens) {
      if (tokenA === baseToken) continue;

      for (const tokenB of reachableTokens) {
        if (tokenB === baseToken || tokenB === tokenA) continue;

        // Check if we can close the triangle back to base token
        const triangle = await this.evaluateTriangle(
          [baseToken, tokenA, tokenB, baseToken],
          tokenPairs,
          allPools,
          chain
        );

        if (triangle && triangle.netProfit > 0) {
          opportunities.push(triangle);
        }
      }
    }

    return opportunities;
  }

  // Evaluate a potential triangular arbitrage
  private async evaluateTriangle(
    tokens: [string, string, string, string], // [start, middle1, middle2, end]
    tokenPairs: Map<string, DexPool[]>,
    allPools: DexPool[],
    chain: string
  ): Promise<TriangularOpportunity | null> {
    const [token0, token1, token2, token3] = tokens;
    if (token3 !== token0) return null; // Must close the triangle

    // Find best DEXes for each leg
    const leg1Pools = this.findBestPoolsForPair(tokenPairs, token0, token1);
    const leg2Pools = this.findBestPoolsForPair(tokenPairs, token1, token2);
    const leg3Pools = this.findBestPoolsForPair(tokenPairs, token2, token0);

    if (leg1Pools.length === 0 || leg2Pools.length === 0 || leg3Pools.length === 0) {
      return null;
    }

    // Try different combinations of DEXes
    const opportunities: TriangularOpportunity[] = [];

    for (const pool1 of leg1Pools.slice(0, 3)) { // Top 3 pools per leg
      for (const pool2 of leg2Pools.slice(0, 3)) {
        for (const pool3 of leg3Pools.slice(0, 3)) {
          const opportunity = await this.simulateTriangle(
            [token0, token1, token2, token0],
            [pool1, pool2, pool3],
            chain
          );

          if (opportunity && opportunity.netProfit > 0) {
            opportunities.push(opportunity);
          }
        }
      }
    }

    // Return the best opportunity
    return opportunities.sort((a, b) => b.netProfit - a.netProfit)[0] || null;
  }

  // Simulate a triangular arbitrage execution
  // P0-FIX: Uses BigInt for precise wei calculations
  private async simulateTriangle(
    tokens: [string, string, string, string],
    pools: [DexPool, DexPool, DexPool],
    chain: string
  ): Promise<TriangularOpportunity | null> {
    const [token0, token1, token2, token3] = tokens;
    const [pool1, pool2, pool3] = pools;

    // P0-FIX: Use BigInt for wei amounts to prevent precision loss
    // Start with 1 unit of token0 (1 ETH = 10^18 wei)
    let amountBigInt = ONE_ETH_WEI;
    const initialAmountBigInt = ONE_ETH_WEI;
    let steps: TriangularStep[] = [];

    try {
      // Leg 1: token0 -> token1
      const step1 = this.simulateSwapBigInt(token0, token1, amountBigInt, pool1);
      amountBigInt = step1.amountOutBigInt;
      steps.push(step1.step);

      // Leg 2: token1 -> token2
      const step2 = this.simulateSwapBigInt(token1, token2, amountBigInt, pool2);
      amountBigInt = step2.amountOutBigInt;
      steps.push(step2.step);

      // Leg 3: token2 -> token0 (close triangle)
      const step3 = this.simulateSwapBigInt(token2, token0, amountBigInt, pool3);
      amountBigInt = step3.amountOutBigInt;
      steps.push(step3.step);

      // P0-FIX: Calculate profit using BigInt then convert to decimal
      // grossProfit = (finalAmount - initialAmount) / initialAmount
      // To avoid precision loss: multiply by PRECISION_MULTIPLIER first
      const profitBigInt = amountBigInt - initialAmountBigInt;
      const grossProfitScaled = (profitBigInt * PRECISION_MULTIPLIER) / initialAmountBigInt;
      const grossProfit = Number(grossProfitScaled) / Number(PRECISION_MULTIPLIER);

      // Estimate gas costs (simplified)
      const gasCost = this.estimateGasCost(chain, steps.length);

      // Calculate net profit after fees and gas
      const totalFees = steps.reduce((sum, step) => sum + step.fee, 0);
      const netProfit = grossProfit - totalFees - gasCost;

      if (netProfit < this.minProfitThreshold) {
        return null;
      }

      // Estimate execution time
      const executionTime = this.estimateExecutionTime(chain, steps);

      // Calculate confidence based on liquidity and slippage
      const confidence = this.calculateConfidence(steps, pools);

      const opportunity: TriangularOpportunity = {
        id: `tri_${chain}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        chain,
        path: [token0, token1, token2],
        dexes: [pool1.dex, pool2.dex, pool3.dex],
        profitPercentage: netProfit,
        profitUSD: netProfit * 2000, // Rough ETH to USD conversion
        gasCost,
        netProfit,
        confidence,
        steps,
        timestamp: Date.now(),
        executionTime
      };

      return opportunity;

    } catch (error: any) {
      logger.debug('Triangle simulation failed', {
        tokens,
        dexes: pools.map(p => p.dex),
        error: error.message
      });
      return null;
    }
  }

  // P0-FIX: BigInt version of swap simulation for precise calculations
  // T1.2: Updated to use dynamic slippage calculation
  private simulateSwapBigInt(
    fromToken: string,
    toToken: string,
    amountInBigInt: bigint,
    pool: DexPool
  ): { amountOutBigInt: bigint; step: TriangularStep } {
    // Use AMM formula with BigInt: amountOut = (amountIn * reserveOut * (10000 - fee)) / (reserveIn * 10000 + amountIn * (10000 - fee))

    let reserveInStr: string, reserveOutStr: string;

    if (pool.token0 === fromToken && pool.token1 === toToken) {
      reserveInStr = pool.reserve0;
      reserveOutStr = pool.reserve1;
    } else if (pool.token0 === toToken && pool.token1 === fromToken) {
      reserveInStr = pool.reserve1;
      reserveOutStr = pool.reserve0;
    } else {
      throw new Error(`Pool does not contain token pair ${fromToken}/${toToken}`);
    }

    // P0-FIX: Parse reserves as BigInt (they're stored as strings in wei)
    const reserveInBigInt = BigInt(reserveInStr);
    const reserveOutBigInt = BigInt(reserveOutStr);
    const feeBigInt = BigInt(pool.fee);

    // P0-FIX: Apply fee using BigInt arithmetic
    // feeMultiplier = (10000 - fee) / 10000
    const feeMultiplierNumerator = BASIS_POINTS_DIVISOR - feeBigInt;

    // amountInWithFee = amountIn * (10000 - fee) / 10000
    const amountInWithFee = (amountInBigInt * feeMultiplierNumerator) / BASIS_POINTS_DIVISOR;

    // P0-FIX: Constant product formula with BigInt
    // amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee)
    const numerator = amountInWithFee * reserveOutBigInt;
    const denominator = reserveInBigInt + amountInWithFee;
    const amountOutBigInt = numerator / denominator;

    // T1.2: Calculate dynamic slippage based on trade size and pool liquidity
    // Convert BigInt to number for ratio calculation (safe as it's scaled down)
    const reserveInNumber = Number(reserveInBigInt / (10n ** 12n)) / 1e6; // Scale down for safe number conversion
    const amountInNumber = Number(amountInBigInt / (10n ** 12n)) / 1e6;

    // Use dynamic slippage calculation instead of static cap
    const slippage = this.calculateDynamicSlippage(
      amountInNumber,
      reserveInNumber,
      pool.liquidity // USD liquidity from pool
    );

    // Convert BigInt to number for step (for display purposes only)
    const amountInDisplay = Number(amountInBigInt) / 1e18;
    const amountOutDisplay = Number(amountOutBigInt) / 1e18;

    const step: TriangularStep = {
      fromToken,
      toToken,
      dex: pool.dex,
      amountIn: amountInDisplay,
      amountOut: amountOutDisplay,
      price: pool.price,
      fee: pool.fee / 10000, // Convert to decimal
      slippage
    };

    return { amountOutBigInt, step };
  }

  // Group pools by token pairs for efficient lookup
  private groupPoolsByPairs(pools: DexPool[]): Map<string, DexPool[]> {
    const pairs = new Map<string, DexPool[]>();

    for (const pool of pools) {
      const pairKey = `${pool.token0}_${pool.token1}`;
      const reverseKey = `${pool.token1}_${pool.token0}`;

      // Store both directions for easier lookup
      if (!pairs.has(pairKey)) pairs.set(pairKey, []);
      if (!pairs.has(reverseKey)) pairs.set(reverseKey, []);

      pairs.get(pairKey)!.push(pool);
      pairs.get(reverseKey)!.push(pool);
    }

    // Sort pools by liquidity (higher liquidity first)
    for (const poolList of pairs.values()) {
      poolList.sort((a, b) => b.liquidity - a.liquidity);
    }

    return pairs;
  }

  // Find tokens reachable from a base token
  private findReachableTokens(baseToken: string, tokenPairs: Map<string, DexPool[]>): string[] {
    const visited = new Set<string>();
    const queue = [baseToken];
    const reachable = new Set<string>();

    while (queue.length > 0) {
      const currentToken = queue.shift()!;
      if (visited.has(currentToken)) continue;

      visited.add(currentToken);
      reachable.add(currentToken);

      // Find all tokens directly connected to current token
      for (const [pairKey, pools] of tokenPairs) {
        const [tokenA, tokenB] = pairKey.split('_');
        if (tokenA === currentToken && !visited.has(tokenB)) {
          queue.push(tokenB);
        } else if (tokenB === currentToken && !visited.has(tokenA)) {
          queue.push(tokenA);
        }
      }
    }

    return Array.from(reachable);
  }

  // Find best pools for a token pair
  private findBestPoolsForPair(tokenPairs: Map<string, DexPool[]>, tokenA: string, tokenB: string): DexPool[] {
    const pairKey = `${tokenA}_${tokenB}`;
    return tokenPairs.get(pairKey) || [];
  }

  // Filter and rank opportunities
  private filterAndRankOpportunities(opportunities: TriangularOpportunity[]): TriangularOpportunity[] {
    return opportunities
      .filter(opp => {
        // Filter by minimum profit
        if (opp.netProfit < this.minProfitThreshold) return false;

        // Filter by maximum slippage
        const maxStepSlippage = Math.max(...opp.steps.map(s => s.slippage));
        if (maxStepSlippage > this.maxSlippage) return false;

        // Filter by execution time
        if (opp.executionTime > this.maxExecutionTime) return false;

        // Filter by confidence
        if (opp.confidence < 0.6) return false; // Minimum 60% confidence

        return true;
      })
      .sort((a, b) => {
        // Rank by net profit, then by confidence, then by execution time
        if (Math.abs(a.netProfit - b.netProfit) > 0.001) {
          return b.netProfit - a.netProfit;
        }
        if (Math.abs(a.confidence - b.confidence) > 0.1) {
          return b.confidence - a.confidence;
        }
        return a.executionTime - b.executionTime;
      })
      .slice(0, 10); // Return top 10 opportunities
  }

  // Estimate gas cost for triangular arbitrage
  private estimateGasCost(chain: string, steps: number): number {
    // Base gas costs for different chains (in ETH)
    const baseGasCosts: { [chain: string]: number } = {
      ethereum: 0.005, // ~$10 at $2000/ETH
      bsc: 0.0001,     // ~$0.02 at $200/BNB
      arbitrum: 0.00005, // Very low L2 fees
      base: 0.00001,   // Coinbase L2
      polygon: 0.0001  // Polygon fees
    };

    const baseCost = baseGasCosts[chain] || 0.001;
    // Each step adds complexity
    return baseCost * (1 + steps * 0.2);
  }

  // Estimate execution time
  private estimateExecutionTime(chain: string, steps: TriangularStep[]): number {
    // Base execution times for different chains (in ms)
    const baseExecutionTimes: { [chain: string]: number } = {
      ethereum: 15000, // 15 seconds average
      bsc: 3000,       // 3 seconds
      arbitrum: 1000,  // 1 second (fast L2)
      base: 2000,      // 2 seconds
      polygon: 2000    // 2 seconds
    };

    const baseTime = baseExecutionTimes[chain] || 5000;

    // Add time for each step and account for sequential execution
    const stepTime = 500; // 500ms per swap
    return baseTime + (steps.length * stepTime);
  }

  // Calculate confidence score
  private calculateConfidence(steps: TriangularStep[], pools: DexPool[]): number {
    let totalConfidence = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const pool = pools[i];

      // Liquidity confidence (higher liquidity = higher confidence)
      const liquidityConfidence = Math.min(1, pool.liquidity / 1000000); // $1M liquidity = 100% confidence

      // Slippage confidence (lower slippage = higher confidence)
      const slippageConfidence = Math.max(0, 1 - step.slippage / this.maxSlippage);

      // Fee confidence (lower fees = higher confidence)
      const feeConfidence = Math.max(0, 1 - pool.fee / 100); // 1% fee = 0 confidence

      const stepConfidence = (liquidityConfidence + slippageConfidence + feeConfidence) / 3;
      totalConfidence += stepConfidence;
    }

    return totalConfidence / steps.length;
  }

  // Get arbitrage statistics
  getStatistics(): any {
    return {
      minProfitThreshold: this.minProfitThreshold,
      maxSlippage: this.maxSlippage,
      maxExecutionTime: this.maxExecutionTime,
      supportedChains: ['ethereum', 'bsc', 'arbitrum', 'base', 'polygon'],
      // T1.2: Include dynamic slippage configuration
      slippageConfig: { ...this.slippageConfig }
    };
  }

  // Update configuration
  // T1.2: Extended to support dynamic slippage configuration
  updateConfig(config: {
    minProfitThreshold?: number;
    maxSlippage?: number;
    maxExecutionTime?: number;
    slippageConfig?: Partial<DynamicSlippageConfig>;
  }): void {
    if (config.minProfitThreshold !== undefined) {
      this.minProfitThreshold = config.minProfitThreshold;
    }
    if (config.maxSlippage !== undefined) {
      this.maxSlippage = config.maxSlippage;
    }
    if (config.maxExecutionTime !== undefined) {
      this.maxExecutionTime = config.maxExecutionTime;
    }
    // T1.2: Update dynamic slippage config
    if (config.slippageConfig) {
      this.slippageConfig = { ...this.slippageConfig, ...config.slippageConfig };
      // Also update maxSlippage to match config if provided
      if (config.slippageConfig.maxSlippage !== undefined) {
        this.maxSlippage = config.slippageConfig.maxSlippage;
      }
    }

    logger.info('Cross-DEX triangular arbitrage config updated', config);
  }

  /**
   * T1.2: Get current slippage configuration.
   * Useful for debugging and monitoring.
   */
  getSlippageConfig(): DynamicSlippageConfig {
    return { ...this.slippageConfig };
  }
}