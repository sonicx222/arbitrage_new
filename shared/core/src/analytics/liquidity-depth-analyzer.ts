/**
 * T3.15: Liquidity Depth Analysis
 *
 * Professional-grade liquidity analysis for optimal trade execution:
 * - Order book depth tracking (simulated from AMM reserves)
 * - Slippage prediction based on trade size
 * - Multi-level price impact calculation
 * - Optimal trade size recommendation
 *
 * Supported AMM models:
 * - Constant Product (x * y = k) — Uniswap V2 style (default)
 * - Concentrated Liquidity — Uniswap V3 style (single-tick or multi-tick traversal)
 * - StableSwap — Curve style (Newton's method for StableSwap invariant)
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding T3.15
 * @see .agent-reports/analytics-deep-analysis.md - Finding #26
 */

import { createLogger } from '../logger';
import { findKSmallest } from '../data-structures/min-heap';

const logger = createLogger('liquidity-depth-analyzer');

// BigInt precision for calculations
const PRECISION = 10n ** 18n;

/**
 * PRECISION-FIX: Safely convert a float to BigInt with 18 decimal places.
 *
 * P2-21: Optimized to avoid string allocation on the hot path.
 * Splits into integer and fractional parts using arithmetic, then combines
 * as BigInt. The fractional part (0..1) multiplied by 1e18 always fits
 * within Number.MAX_SAFE_INTEGER, preserving precision without toFixed().
 *
 * @param value - Float value to convert (e.g., 0.000000123456789)
 * @returns BigInt representation in wei (value * 10^18)
 */
function floatToBigInt18(value: number): bigint {
  if (value === 0) return 0n;

  const sign = value < 0 ? -1n : 1n;
  const abs = Math.abs(value);
  const intPart = Math.trunc(abs);
  const fracPart = abs - intPart;

  // intPart as BigInt * 10^18 + fractional part (always < 1e18, safe in float)
  return sign * (BigInt(intPart) * PRECISION + BigInt(Math.round(fracPart * 1e18)));
}

// =============================================================================
// Types
// =============================================================================

/**
 * AMM model type for swap output calculation.
 * - 'constant_product': Uniswap V2 style (x * y = k)
 * - 'concentrated': Uniswap V3 style (concentrated liquidity, single-tick approximation)
 * - 'stable_swap': Curve style (StableSwap invariant with amplification parameter)
 */
export type AmmType = 'constant_product' | 'concentrated' | 'stable_swap';

/**
 * Configuration for liquidity depth analysis.
 */
export interface LiquidityDepthConfig {
  /** Number of price levels to simulate (default: 10) */
  depthLevels: number;
  /** Trade size step for depth simulation in USD (default: $1000) */
  tradeSizeStepUsd: number;
  /** Maximum trade size to simulate in USD (default: $1M) */
  maxTradeSizeUsd: number;
  /** Maximum pools to track (LRU eviction, default: 1000) */
  maxTrackedPools: number;
  /** Cache TTL in ms (default: 30 seconds) */
  cacheTtlMs: number;
  // REMOVED: maxCachedLevels - was defined but never used in implementation
}

/**
 * Pool liquidity snapshot.
 */
export interface PoolLiquidity {
  poolAddress: string;
  chain: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  /** Fee in basis points (e.g., 30 = 0.3%) */
  feeBps: number;
  /** Total liquidity in USD */
  liquidityUsd: number;
  /** Current price (token1/token0) */
  price: number;
  timestamp: number;
  /** AMM model type. Defaults to 'constant_product' if not specified. */
  ammType?: AmmType;
  // --- V3 Concentrated Liquidity fields ---
  /** sqrt(price) in Q64.96 format (Uniswap V3 convention) */
  sqrtPriceX96?: bigint;
  /** Active liquidity at current tick */
  liquidity?: bigint;
  /** Tick spacing for fee tier (1, 10, 60, 200) */
  tickSpacing?: number;
  /** Initialized tick liquidity data for multi-tick swap simulation */
  ticks?: TickLiquidityData[];
  // --- Curve StableSwap fields ---
  /** Curve amplification parameter A (typically 100-2000) */
  amplificationParameter?: number;
  /** Multi-token pool reserves (for Curve 3pool, sUSD 4-token pools). If provided, used instead of reserve0/reserve1 for StableSwap. */
  reserves?: bigint[];
  /** Index of input token in reserves array (for multi-token StableSwap) */
  inputIndex?: number;
  /** Index of output token in reserves array (for multi-token StableSwap) */
  outputIndex?: number;
  /** Token decimals for each reserve in order (for multi-token StableSwap with mixed decimals, e.g. [18, 6, 6] for DAI/USDC/USDT) */
  tokenDecimals?: number[];
}

/**
 * Liquidity at a specific price level.
 */
export interface LiquidityLevel {
  /** Trade size in token units */
  tradeSize: number;
  /** Trade size in USD */
  tradeSizeUsd: number;
  /** Expected price after trade */
  expectedPrice: number;
  /** Price impact percentage */
  priceImpactPercent: number;
  /** Slippage percentage */
  slippagePercent: number;
  /** Output amount */
  outputAmount: number;
  /** Effective rate (output/input) */
  effectiveRate: number;
}

/**
 * Full depth analysis for a pool.
 */
export interface DepthAnalysis {
  poolAddress: string;
  chain: string;
  token0: string;
  token1: string;
  /** Buy-side depth (buying token1 with token0) */
  buyLevels: LiquidityLevel[];
  /** Sell-side depth (selling token1 for token0) */
  sellLevels: LiquidityLevel[];
  /** Optimal trade size for minimal slippage */
  optimalTradeSizeUsd: number;
  /** Maximum trade size before 1% slippage */
  maxTradeSizeFor1PercentSlippage: number;
  /** Maximum trade size before 5% slippage */
  maxTradeSizeFor5PercentSlippage: number;
  /** Overall liquidity score (0-1) */
  liquidityScore: number;
  timestamp: number;
}

/**
 * Slippage estimate for a specific trade.
 */
export interface SlippageEstimate {
  poolAddress: string;
  tradeDirection: 'buy' | 'sell';
  inputAmount: number;
  inputAmountUsd: number;
  outputAmount: number;
  outputAmountUsd: number;
  priceImpactPercent: number;
  slippagePercent: number;
  effectivePrice: number;
  confidence: number;
}

/**
 * Analyzer statistics.
 */
export interface LiquidityAnalyzerStats {
  poolsTracked: number;
  analysisCount: number;
  avgAnalysisTimeMs: number;
  cacheHits: number;
  cacheMisses: number;
  poolEvictions: number;
}

/**
 * Tick liquidity data for V3 multi-tick swap simulation.
 *
 * Each entry represents a tick boundary with the net liquidity change
 * that occurs when the price crosses that tick. Used by the multi-tick
 * swap model to accurately simulate slippage across tick boundaries.
 *
 * @see calculateV3SwapOutputMultiTick
 */
export interface TickLiquidityData {
  /** Tick index (e.g., -887220 to 887220 for Uniswap V3) */
  tickIndex: number;
  /** Signed net liquidity: + when crossing upward, - when crossing downward */
  liquidityNet: bigint;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: LiquidityDepthConfig = {
  depthLevels: 10,
  tradeSizeStepUsd: 1000,
  maxTradeSizeUsd: 1000000,
  maxTrackedPools: 1000,
  cacheTtlMs: 30000
};

// =============================================================================
// Liquidity Depth Analyzer
// =============================================================================

/**
 * T3.15: Liquidity Depth Analyzer
 *
 * Analyzes AMM pool liquidity to predict slippage and optimize trade sizes.
 */
export class LiquidityDepthAnalyzer {
  private config: LiquidityDepthConfig;
  private pools: Map<string, PoolLiquidity> = new Map();
  private depthCache: Map<string, { analysis: DepthAnalysis; timestamp: number }> = new Map();
  private tickMapCache: Map<string, { ticks: TickLiquidityData[]; timestamp: number }> = new Map();
  private stats = {
    analysisCount: 0,
    totalAnalysisTimeMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    poolEvictions: 0
  };

  constructor(config: Partial<LiquidityDepthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('LiquidityDepthAnalyzer initialized', {
      depthLevels: this.config.depthLevels,
      maxTrackedPools: this.config.maxTrackedPools,
      cacheTtlMs: this.config.cacheTtlMs
    });
  }

  /**
   * Update pool liquidity snapshot.
   * Validates pool data before storing.
   */
  updatePoolLiquidity(pool: PoolLiquidity): void {
    // Input validation
    if (!pool.poolAddress) {
      logger.warn('Pool update skipped: missing poolAddress');
      return;
    }
    if (pool.reserve0 < 0n || pool.reserve1 < 0n) {
      logger.warn('Pool update skipped: negative reserves', { poolAddress: pool.poolAddress });
      return;
    }
    if (pool.price <= 0 || !Number.isFinite(pool.price)) {
      logger.warn('Pool update skipped: invalid price', { poolAddress: pool.poolAddress, price: pool.price });
      return;
    }
    if (pool.liquidityUsd < 0 || !Number.isFinite(pool.liquidityUsd)) {
      logger.warn('Pool update skipped: invalid liquidityUsd', { poolAddress: pool.poolAddress });
      return;
    }

    this.evictLRUPoolsIfNeeded();

    // P1-5: Only invalidate depth cache when reserves change significantly (>1%).
    // Pool data updates with each price event (hundreds/sec), so unconditional
    // cache invalidation causes perpetual thrashing — enrichment always pays
    // full computation cost (0.5-5ms for StableSwap Newton's method).
    // @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P1-5
    const existing = this.pools.get(pool.poolAddress);
    this.pools.set(pool.poolAddress, pool);

    if (existing) {
      // Check reserve change (V2/StableSwap primary indicator)
      const prevR0 = existing.reserve0;
      const prevR1 = existing.reserve1;
      let reservesSignificant = false;
      if (prevR0 > 0n && prevR1 > 0n) {
        const delta0 = pool.reserve0 > prevR0 ? pool.reserve0 - prevR0 : prevR0 - pool.reserve0;
        const delta1 = pool.reserve1 > prevR1 ? pool.reserve1 - prevR1 : prevR1 - pool.reserve1;
        reservesSignificant = delta0 * 100n / prevR0 >= 1n || delta1 * 100n / prevR1 >= 1n;
      } else {
        reservesSignificant = true; // New pool or zero reserves — always invalidate
      }

      // Check price change (V3 primary indicator — sqrtPriceX96 moves with ticks)
      const priceSignificant = existing.price > 0
        ? Math.abs(pool.price - existing.price) / existing.price >= 0.01
        : true;

      if (!reservesSignificant && !priceSignificant) {
        // Neither reserves nor price changed significantly — keep cache valid
        return;
      }
    }

    this.depthCache.delete(pool.poolAddress);
    this.tickMapCache.delete(pool.poolAddress);
  }

  /**
   * Get full depth analysis for a pool.
   */
  analyzeDepth(poolAddress: string): DepthAnalysis | null {
    const startTime = performance.now();

    // Check cache
    const cached = this.depthCache.get(poolAddress);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) {
      this.stats.cacheHits++;
      return cached.analysis;
    }
    this.stats.cacheMisses++;

    const pool = this.pools.get(poolAddress);
    if (!pool) {
      return null;
    }

    this.stats.analysisCount++;

    const buyLevels = this.calculateDepthLevels(pool, 'buy');
    const sellLevels = this.calculateDepthLevels(pool, 'sell');

    // Calculate optimal trade sizes
    const optimalTradeSizeUsd = this.findOptimalTradeSize(buyLevels);
    const maxTradeSizeFor1PercentSlippage = this.findMaxTradeSizeForSlippage(buyLevels, 1.0);
    const maxTradeSizeFor5PercentSlippage = this.findMaxTradeSizeForSlippage(buyLevels, 5.0);

    // Calculate liquidity score (0-1)
    const liquidityScore = this.calculateLiquidityScore(pool, buyLevels, sellLevels);

    const analysis: DepthAnalysis = {
      poolAddress,
      chain: pool.chain,
      token0: pool.token0,
      token1: pool.token1,
      buyLevels,
      sellLevels,
      optimalTradeSizeUsd,
      maxTradeSizeFor1PercentSlippage,
      maxTradeSizeFor5PercentSlippage,
      liquidityScore,
      timestamp: Date.now()
    };

    // Cache the result
    this.depthCache.set(poolAddress, { analysis, timestamp: Date.now() });

    const analysisTime = performance.now() - startTime;
    this.stats.totalAnalysisTimeMs += analysisTime;

    return analysis;
  }

  /**
   * Estimate slippage for a specific trade.
   */
  estimateSlippage(
    poolAddress: string,
    inputAmountUsd: number,
    direction: 'buy' | 'sell'
  ): SlippageEstimate | null {
    const pool = this.pools.get(poolAddress);
    if (!pool) {
      return null;
    }

    // Convert USD to token amount
    // price = token1 price in terms of token0 (e.g., WETH price in USDT)
    const price = pool.price;
    const inputToken = direction === 'buy' ? pool.token0 : pool.token1;
    const outputToken = direction === 'buy' ? pool.token1 : pool.token0;

    // For 'buy': input is token0 (stablecoin), so inputAmount = inputAmountUsd
    // For 'sell': input is token1 (priced asset), so convert USD to token1 units
    const inputAmount = direction === 'buy'
      ? inputAmountUsd
      : inputAmountUsd / price;

    // Calculate output using the appropriate AMM model
    const reserveIn = direction === 'buy' ? pool.reserve0 : pool.reserve1;
    const reserveOut = direction === 'buy' ? pool.reserve1 : pool.reserve0;

    const result = this.dispatchSwapCalculation(
      pool,
      floatToBigInt18(inputAmount), // PRECISION-FIX: Use helper to avoid float precision loss
      reserveIn,
      reserveOut,
      direction
    );

    const outputAmount = Number(result.amountOut) / 1e18;
    const effectivePrice = outputAmount / inputAmount;
    const priceImpactPercent = result.priceImpact * 100;
    const slippagePercent = priceImpactPercent + (pool.feeBps / 100);

    // Calculate output in USD
    const outputAmountUsd = direction === 'buy'
      ? outputAmount * price
      : outputAmount;

    // Confidence decreases with larger trades and higher slippage
    const sizeConfidence = Math.max(0.3, 1 - (inputAmountUsd / pool.liquidityUsd) * 2);
    const slippageConfidence = Math.max(0.5, 1 - slippagePercent / 10);
    const confidence = (sizeConfidence + slippageConfidence) / 2;

    return {
      poolAddress,
      tradeDirection: direction,
      inputAmount,
      inputAmountUsd,
      outputAmount,
      outputAmountUsd,
      priceImpactPercent,
      slippagePercent,
      effectivePrice,
      confidence
    };
  }

  /**
   * Find the best pool for a given trade size.
   */
  findBestPool(
    token0: string,
    token1: string,
    tradeSizeUsd: number,
    direction: 'buy' | 'sell'
  ): { poolAddress: string; slippage: number } | null {
    let bestPool: string | null = null;
    let bestSlippage = Infinity;

    for (const [address, pool] of this.pools) {
      // Check if pool has the right tokens
      const hasTokens = (pool.token0 === token0 && pool.token1 === token1) ||
                        (pool.token0 === token1 && pool.token1 === token0);
      if (!hasTokens) continue;

      const estimate = this.estimateSlippage(address, tradeSizeUsd, direction);
      if (estimate && estimate.slippagePercent < bestSlippage) {
        bestSlippage = estimate.slippagePercent;
        bestPool = address;
      }
    }

    if (!bestPool) return null;

    return { poolAddress: bestPool, slippage: bestSlippage };
  }

  /**
   * Get pool liquidity.
   */
  getPoolLiquidity(poolAddress: string): PoolLiquidity | undefined {
    return this.pools.get(poolAddress);
  }

  /**
   * Get all tracked pools.
   */
  getTrackedPools(): string[] {
    return Array.from(this.pools.keys());
  }

  /**
   * Get analyzer statistics.
   */
  getStats(): LiquidityAnalyzerStats {
    const avgAnalysisTime = this.stats.analysisCount > 0
      ? this.stats.totalAnalysisTimeMs / this.stats.analysisCount
      : 0;

    return {
      poolsTracked: this.pools.size,
      analysisCount: this.stats.analysisCount,
      avgAnalysisTimeMs: avgAnalysisTime,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      poolEvictions: this.stats.poolEvictions
    };
  }

  /**
   * Reset all data.
   */
  reset(): void {
    this.pools.clear();
    this.depthCache.clear();
    this.tickMapCache.clear();
    this.stats = {
      analysisCount: 0,
      totalAnalysisTimeMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      poolEvictions: 0
    };
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private calculateDepthLevels(pool: PoolLiquidity, direction: 'buy' | 'sell'): LiquidityLevel[] {
    const levels: LiquidityLevel[] = [];
    const stepUsd = this.config.tradeSizeStepUsd;
    const maxUsd = Math.min(this.config.maxTradeSizeUsd, pool.liquidityUsd * 0.5);
    const numLevels = Math.min(this.config.depthLevels, Math.floor(maxUsd / stepUsd));

    const reserveIn = direction === 'buy' ? pool.reserve0 : pool.reserve1;
    const reserveOut = direction === 'buy' ? pool.reserve1 : pool.reserve0;
    const basePrice = pool.price;

    for (let i = 1; i <= numLevels; i++) {
      const tradeSizeUsd = i * stepUsd;
      const tradeSize = tradeSizeUsd / basePrice;
      // PRECISION-FIX: Use helper to avoid float precision loss
      const tradeSizeBigInt = floatToBigInt18(tradeSize);

      const result = this.dispatchSwapCalculation(pool, tradeSizeBigInt, reserveIn, reserveOut, direction);

      const outputAmount = Number(result.amountOut) / 1e18;
      const effectiveRate = outputAmount / tradeSize;
      const expectedPrice = basePrice * (1 - result.priceImpact);
      const slippagePercent = (result.priceImpact * 100) + (pool.feeBps / 100);

      levels.push({
        tradeSize,
        tradeSizeUsd,
        expectedPrice,
        priceImpactPercent: result.priceImpact * 100,
        slippagePercent,
        outputAmount,
        effectiveRate
      });
    }

    return levels;
  }

  /**
   * Dispatch swap calculation to the appropriate AMM model.
   * Falls back to constant-product if V3/Curve data is missing.
   */
  private dispatchSwapCalculation(
    pool: PoolLiquidity,
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    direction: 'buy' | 'sell'
  ): { amountOut: bigint; priceImpact: number } {
    const ammType = pool.ammType ?? 'constant_product';

    switch (ammType) {
      case 'concentrated': {
        if (pool.sqrtPriceX96 == null || pool.liquidity == null) {
          logger.debug('V3 pool missing sqrtPriceX96/liquidity, falling back to constant_product', {
            poolAddress: pool.poolAddress
          });
          return this.calculateSwapOutput(amountIn, reserveIn, reserveOut, pool.feeBps);
        }
        // Use multi-tick model when tick data is available
        if (pool.ticks != null && pool.ticks.length > 0) {
          return this.calculateV3SwapOutputMultiTick(
            amountIn,
            pool.sqrtPriceX96,
            pool.liquidity,
            pool.ticks,
            pool.feeBps,
            direction,
            pool.poolAddress
          );
        }
        return this.calculateV3SwapOutput(
          amountIn,
          pool.sqrtPriceX96,
          pool.liquidity,
          pool.feeBps,
          direction
        );
      }
      case 'stable_swap': {
        if (pool.amplificationParameter == null || pool.amplificationParameter <= 0) {
          logger.debug('StableSwap pool missing/invalid amplificationParameter, falling back to constant_product', {
            poolAddress: pool.poolAddress
          });
          return this.calculateSwapOutput(amountIn, reserveIn, reserveOut, pool.feeBps);
        }
        // Multi-token pool: use reserves array with indices
        if (pool.reserves && pool.reserves.length > 2 && pool.inputIndex != null && pool.outputIndex != null) {
          return this.calculateStableSwapOutput(
            amountIn,
            pool.reserves,
            pool.inputIndex,
            pool.outputIndex,
            pool.feeBps,
            pool.amplificationParameter,
            pool.tokenDecimals
          );
        }
        // 2-token pool: use reserve0/reserve1 as array
        return this.calculateStableSwapOutput(
          amountIn,
          [reserveIn, reserveOut],
          0,
          1,
          pool.feeBps,
          pool.amplificationParameter
        );
      }
      case 'constant_product':
      default:
        return this.calculateSwapOutput(amountIn, reserveIn, reserveOut, pool.feeBps);
    }
  }

  /**
   * Constant product (x * y = k) swap calculation — Uniswap V2 style.
   */
  private calculateSwapOutput(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: number
  ): { amountOut: bigint; priceImpact: number } {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    // Apply fee
    const feeMultiplier = BigInt(10000 - feeBps);
    const amountInWithFee = (amountIn * feeMultiplier) / 10000n;

    // Constant product formula: x * y = k
    // amountOut = (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee)
    const numerator = reserveOut * amountInWithFee;
    const denominator = reserveIn + amountInWithFee;

    if (denominator === 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    const amountOut = numerator / denominator;

    // Calculate price impact
    // Price impact = 1 - (effective_price / initial_price)
    // Initial price = reserveOut / reserveIn
    // Effective price = amountOut / amountIn
    const initialPriceScaled = (reserveOut * PRECISION) / reserveIn;
    const effectivePriceScaled = (amountOut * PRECISION) / amountIn;

    const priceImpact = initialPriceScaled > 0n
      ? Number(PRECISION - (effectivePriceScaled * PRECISION) / initialPriceScaled) / Number(PRECISION)
      : 1;

    return { amountOut, priceImpact: Math.max(0, priceImpact) };
  }

  /**
   * V3 Concentrated Liquidity swap calculation (single-tick approximation).
   *
   * Models all active liquidity as concentrated at the current price.
   * Within a single tick, V3 behaves as constant-product on virtual reserves:
   *   virtualReserve0 = L * Q96 / sqrtPriceX96
   *   virtualReserve1 = L * sqrtPriceX96 / Q96
   *
   * Higher L means deeper effective liquidity and lower slippage.
   * This is accurate for small-to-medium trades that don't cross tick boundaries.
   *
   * @see https://uniswap.org/whitepaper-v3.pdf
   */
  private calculateV3SwapOutput(
    amountIn: bigint,
    sqrtPriceX96: bigint,
    liquidity: bigint,
    feeBps: number,
    direction: 'buy' | 'sell'
  ): { amountOut: bigint; priceImpact: number } {
    if (amountIn <= 0n || sqrtPriceX96 <= 0n || liquidity <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    const Q96 = 1n << 96n;

    // Compute virtual reserves from concentrated liquidity parameters.
    // In V3, the virtual reserves at the current tick are derived from L and sqrtPrice.
    // These represent the effective depth available for trading within the tick range.
    const virtualReserve0 = (liquidity * Q96) / sqrtPriceX96;
    const virtualReserve1 = (liquidity * sqrtPriceX96) / Q96;

    if (virtualReserve0 <= 0n || virtualReserve1 <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    // Within a single tick, V3 is mathematically equivalent to constant-product
    // on virtual reserves. Delegate to the proven constant-product formula.
    const reserveIn = direction === 'buy' ? virtualReserve0 : virtualReserve1;
    const reserveOut = direction === 'buy' ? virtualReserve1 : virtualReserve0;

    return this.calculateSwapOutput(amountIn, reserveIn, reserveOut, feeBps);
  }

  /**
   * V3 Concentrated Liquidity swap calculation with multi-tick traversal.
   *
   * Unlike the single-tick approximation, this method simulates crossing
   * tick boundaries where liquidity changes. For each tick range:
   * 1. Compute the max input consumable within the current tick range
   * 2. If remaining input fits, compute final output and break
   * 3. Otherwise, consume all liquidity to the boundary, update L, continue
   *
   * This produces accurate slippage estimates for large trades that cross
   * multiple tick boundaries where liquidity providers have different positions.
   *
   * Falls back to single-tick if tick data is stale (>30s) or malformed.
   *
   * @param amountIn - Input token amount (18-decimal scaled BigInt)
   * @param sqrtPriceX96 - Current sqrt(price) in Q64.96 format
   * @param liquidity - Active liquidity L at current tick
   * @param ticks - Sorted tick liquidity data from pool
   * @param feeBps - Fee in basis points
   * @param direction - 'buy' (token0 -> token1) or 'sell' (token1 -> token0)
   * @param poolAddress - Pool address for tick map cache key
   * @returns amountOut and priceImpact
   *
   * @see https://uniswap.org/whitepaper-v3.pdf Section 6.2
   */
  private calculateV3SwapOutputMultiTick(
    amountIn: bigint,
    sqrtPriceX96: bigint,
    liquidity: bigint,
    ticks: TickLiquidityData[],
    feeBps: number,
    direction: 'buy' | 'sell',
    poolAddress: string
  ): { amountOut: bigint; priceImpact: number } {
    if (amountIn <= 0n || sqrtPriceX96 <= 0n || liquidity <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    const Q96 = 1n << 96n;

    // Resolve tick data from cache or pool, enforcing 30s TTL
    const resolvedTicks = this.resolveTickData(poolAddress, ticks);
    if (resolvedTicks.length === 0) {
      // No valid ticks — fall back to single-tick model
      return this.calculateV3SwapOutput(amountIn, sqrtPriceX96, liquidity, feeBps, direction);
    }

    // Sort ticks by index ascending
    const sortedTicks = [...resolvedTicks].sort((a, b) => a.tickIndex - b.tickIndex);

    // Apply fee upfront (same as single-tick model for consistency)
    const feeMultiplier = BigInt(10000 - feeBps);
    const amountInAfterFee = (amountIn * feeMultiplier) / 10000n;

    // Compute initial price for price impact calculation
    const initialVR0 = (liquidity * Q96) / sqrtPriceX96;
    const initialVR1 = (liquidity * sqrtPriceX96) / Q96;
    const initialPriceScaled = direction === 'buy'
      ? (initialVR1 * PRECISION) / initialVR0
      : (initialVR0 * PRECISION) / initialVR1;

    // Filter ticks relevant to the swap direction
    // buy (token0 -> token1): price increases, we cross ticks upward (above current price)
    // sell (token1 -> token0): price decreases, we cross ticks downward (below current price)
    const currentTick = this.sqrtPriceToTick(sqrtPriceX96);

    let relevantTicks: TickLiquidityData[];
    if (direction === 'buy') {
      // Buying token1: sqrtPrice increases, cross ticks above current
      relevantTicks = sortedTicks.filter(t => t.tickIndex > currentTick);
    } else {
      // Selling token1: sqrtPrice decreases, cross ticks below current (reverse order)
      relevantTicks = sortedTicks.filter(t => t.tickIndex <= currentTick).reverse();
    }

    let remainingIn = amountInAfterFee;
    let totalOut = 0n;
    let currentSqrtPrice = sqrtPriceX96;
    let currentL = liquidity;

    for (const tick of relevantTicks) {
      if (remainingIn <= 0n || currentL <= 0n) break;

      // Compute sqrtPrice at the tick boundary
      const tickSqrtPrice = this.tickToSqrtPriceX96(tick.tickIndex);

      // Compute max input consumable within current tick range
      // Within a tick range, V3 acts as constant-product on virtual reserves
      const vr0 = (currentL * Q96) / currentSqrtPrice;
      const vr1 = (currentL * currentSqrtPrice) / Q96;

      if (vr0 <= 0n || vr1 <= 0n) break;

      // Compute the virtual reserves at the tick boundary
      const boundaryVr0 = (currentL * Q96) / tickSqrtPrice;
      const boundaryVr1 = (currentL * tickSqrtPrice) / Q96;

      // Max input to reach tick boundary
      let maxInputInRange: bigint;
      let maxOutputInRange: bigint;

      if (direction === 'buy') {
        // Input is token0, consuming reserve0 up to boundary
        maxInputInRange = boundaryVr0 > vr0 ? 0n : vr0 - boundaryVr0;
        maxOutputInRange = boundaryVr1 > vr1 ? boundaryVr1 - vr1 : 0n;

        // Use constant-product math for accuracy within the range
        if (maxInputInRange <= 0n) {
          // Boundary is at a higher reserve0 (unusual), skip
          break;
        }
      } else {
        // Input is token1, consuming reserve1 up to boundary
        maxInputInRange = boundaryVr1 > vr1 ? 0n : vr1 - boundaryVr1;
        maxOutputInRange = boundaryVr0 > vr0 ? boundaryVr0 - vr0 : 0n;

        if (maxInputInRange <= 0n) {
          break;
        }
      }

      if (remainingIn <= maxInputInRange) {
        // Trade fits within current tick range — compute exact output via x*y=k
        const reserveIn = direction === 'buy' ? vr0 : vr1;
        const reserveOut = direction === 'buy' ? vr1 : vr0;
        const numerator = reserveOut * remainingIn;
        const denominator = reserveIn + remainingIn;
        if (denominator > 0n) {
          totalOut += numerator / denominator;
        }
        remainingIn = 0n;
        break;
      }

      // Consume all liquidity to tick boundary
      totalOut += maxOutputInRange;
      remainingIn -= maxInputInRange;

      // Cross the tick: update liquidity
      if (direction === 'buy') {
        currentL += tick.liquidityNet;
      } else {
        currentL -= tick.liquidityNet;
      }

      // Guard against negative liquidity (malformed tick data)
      if (currentL <= 0n) {
        logger.debug('V3 multi-tick: liquidity depleted after crossing tick', {
          poolAddress,
          tickIndex: tick.tickIndex,
          remainingIn: remainingIn.toString()
        });
        break;
      }

      currentSqrtPrice = tickSqrtPrice;
    }

    // If there's remaining input and we still have liquidity, compute within last range
    if (remainingIn > 0n && currentL > 0n) {
      const vr0 = (currentL * Q96) / currentSqrtPrice;
      const vr1 = (currentL * currentSqrtPrice) / Q96;
      const reserveIn = direction === 'buy' ? vr0 : vr1;
      const reserveOut = direction === 'buy' ? vr1 : vr0;

      if (reserveIn > 0n && reserveOut > 0n) {
        const numerator = reserveOut * remainingIn;
        const denominator = reserveIn + remainingIn;
        if (denominator > 0n) {
          totalOut += numerator / denominator;
        }
      }
    }

    // Calculate price impact
    if (totalOut <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    const effectivePriceScaled = (totalOut * PRECISION) / amountIn;
    const priceImpact = initialPriceScaled > 0n
      ? Number(PRECISION - (effectivePriceScaled * PRECISION) / initialPriceScaled) / Number(PRECISION)
      : 1;

    return { amountOut: totalOut, priceImpact: Math.max(0, priceImpact) };
  }

  /**
   * Resolve tick data for a pool, using the tick map cache with 30s TTL.
   * Returns cached ticks if fresh, otherwise stores the provided ticks.
   */
  private resolveTickData(poolAddress: string, ticks: TickLiquidityData[]): TickLiquidityData[] {
    const now = Date.now();
    const cached = this.tickMapCache.get(poolAddress);

    if (cached && now - cached.timestamp < this.config.cacheTtlMs) {
      return cached.ticks;
    }

    // Store fresh tick data
    this.tickMapCache.set(poolAddress, { ticks, timestamp: now });
    return ticks;
  }

  /**
   * Convert tick index to sqrtPriceX96 using the V3 formula:
   *   sqrtPrice = sqrt(1.0001^tick) * 2^96
   *
   * Uses floating-point math for the exponentiation, then converts to BigInt.
   * Precision is sufficient for slippage estimation (not on-chain execution).
   */
  private tickToSqrtPriceX96(tick: number): bigint {
    // sqrtPrice = 1.0001^(tick/2) = e^(tick * ln(1.0001) / 2)
    const sqrtPrice = Math.pow(1.0001, tick / 2);
    const Q96 = 2 ** 96;
    // Convert to Q64.96 format
    return BigInt(Math.round(sqrtPrice * Q96));
  }

  /**
   * Convert sqrtPriceX96 to approximate tick index.
   * tick = floor(log(price) / log(1.0001))
   * where price = (sqrtPriceX96 / 2^96)^2
   */
  private sqrtPriceToTick(sqrtPriceX96: bigint): number {
    const Q96 = 2 ** 96;
    const sqrtPrice = Number(sqrtPriceX96) / Q96;
    const price = sqrtPrice * sqrtPrice;
    if (price <= 0) return 0;
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }

  /**
   * Curve StableSwap swap calculation using Newton's method.
   *
   * The StableSwap invariant for n=2 tokens:
   *   4A(x + y) + D = 4AD + D³/(4xy)
   *
   * Where:
   * - A = amplification parameter (higher = tighter peg)
   * - D = total deposit when balanced (x = y = D/2)
   * - x, y = current reserves
   *
   * Steps:
   * 1. Compute D from current reserves using Newton's method
   * 2. Compute new y (output reserve) given new x = reserveIn + amountIn
   * 3. amountOut = old_y - new_y
   *
   * At A=0: behaves like constant product (x*y = k)
   * At A→∞: behaves like constant sum (x+y = k, zero slippage)
   *
   * @see https://curve.fi/files/stableswap-paper.pdf
   */
  /**
   * Generalized StableSwap output for n-token pools (n=2,3,4).
   *
   * When tokenDecimals is provided, reserves are normalized to 18-decimal
   * precision before running Newton's method (matching Curve's _xp() pattern),
   * then the output is de-normalized back to the output token's native decimals.
   *
   * @param amountIn - Input amount in native token decimals
   * @param reserves - Array of all pool reserves (length 2, 3, or 4) in native decimals
   * @param inputIdx - Index of input token in reserves array
   * @param outputIdx - Index of output token in reserves array
   * @param feeBps - Fee in basis points
   * @param amplificationParameter - Curve A parameter
   * @param tokenDecimals - Optional array of decimal counts per token (e.g. [18, 6, 6])
   */
  private calculateStableSwapOutput(
    amountIn: bigint,
    reserves: bigint[],
    inputIdx: number,
    outputIdx: number,
    feeBps: number,
    amplificationParameter: number,
    tokenDecimals?: number[]
  ): { amountOut: bigint; priceImpact: number } {
    const n = reserves.length;
    if (amountIn <= 0n || n < 2 || inputIdx >= n || outputIdx >= n || inputIdx === outputIdx) {
      return { amountOut: 0n, priceImpact: 1 };
    }
    for (const r of reserves) {
      if (r <= 0n) return { amountOut: 0n, priceImpact: 1 };
    }

    // Normalize reserves to 18 decimals if tokenDecimals provided.
    // This matches Curve's _xp() pattern: all math operates on a common scale.
    // Note: amountIn from the caller (estimateSlippage) is already in 18-decimal
    // format via floatToBigInt18(), so only reserves need normalization.
    // Output stays in 18-decimal format to match the caller's expectation.
    const needsNormalization = tokenDecimals && tokenDecimals.length === n;
    let normalizedReserves: bigint[];

    if (needsNormalization) {
      normalizedReserves = reserves.map((r, i) => {
        const scale = 18 - tokenDecimals[i];
        return scale > 0 ? r * 10n ** BigInt(scale) : scale < 0 ? r / 10n ** BigInt(-scale) : r;
      });
    } else {
      normalizedReserves = reserves;
    }

    // Apply fee (amountIn is already 18-decimal from caller)
    const feeMultiplier = BigInt(10000 - feeBps);
    const amountInWithFee = (amountIn * feeMultiplier) / 10000n;

    const A = BigInt(amplificationParameter);
    const nBig = BigInt(n);
    // A * n^n
    let Ann = A;
    for (let i = 0; i < n; i++) {
      Ann = Ann * nBig;
    }

    // Step 1: Compute D (invariant) from normalized reserves
    const D = this.computeStableSwapD(normalizedReserves, Ann);
    if (D <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    // Step 2: Build updated reserves with new input, compute new output reserve
    const updatedReserves: bigint[] = [];
    for (let i = 0; i < n; i++) {
      if (i === inputIdx) {
        updatedReserves.push(normalizedReserves[i] + amountInWithFee);
      } else if (i !== outputIdx) {
        updatedReserves.push(normalizedReserves[i]);
      }
      // skip outputIdx — that's what we solve for
    }

    const newReserveOut = this.computeStableSwapY(updatedReserves, D, Ann, nBig);
    if (newReserveOut <= 0n || newReserveOut >= normalizedReserves[outputIdx]) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    // Step 3: amountOut = old_y - new_y (in 18-decimal space)
    const amountOut = normalizedReserves[outputIdx] - newReserveOut;

    // Calculate price impact using normalized (18-decimal) reserves and amounts.
    // All values are in the same 18-decimal scale, so ratios are meaningful.
    const initialPriceScaled = (normalizedReserves[outputIdx] * PRECISION) / normalizedReserves[inputIdx];
    const effectivePriceScaled = (amountOut * PRECISION) / amountIn;

    const priceImpact = initialPriceScaled > 0n
      ? Number(PRECISION - (effectivePriceScaled * PRECISION) / initialPriceScaled) / Number(PRECISION)
      : 1;

    return { amountOut, priceImpact: Math.max(0, priceImpact) };
  }

  /**
   * Compute the StableSwap invariant D for an n-token pool using Newton's method.
   *
   * Generalized formula: Ann * S + D = Ann * D + D^(n+1) / (n^n * prod(reserves))
   * Where S = sum(reserves)
   *
   * Newton iteration:
   *   D_next = (Ann * S + n * D_prod) * D / ((Ann - 1) * D + (n + 1) * D_prod)
   *   where D_prod = D^(n+1) / (n^n * prod(reserves))
   *
   * @param reserves - Array of all pool reserves
   * @param Ann - A * n^n
   * @returns D - the invariant value
   */
  private computeStableSwapD(reserves: bigint[], Ann: bigint): bigint {
    const n = BigInt(reserves.length);
    let S = 0n;
    for (const r of reserves) {
      S += r;
    }
    if (S === 0n) return 0n;

    let D = S;

    // Newton's method — converges in ~10 iterations for typical values
    for (let i = 0; i < 256; i++) {
      // D_prod = D^(n+1) / (n^n * prod(reserves))
      // Computed iteratively: start with D, then for each reserve r: D_prod = D_prod * D / (r * n)
      let D_prod = D;
      for (const r of reserves) {
        D_prod = (D_prod * D) / (r * n);
      }

      const D_prev = D;

      // D = (Ann * S + n * D_prod) * D / ((Ann - 1) * D + (n + 1) * D_prod)
      const numerator = (Ann * S + n * D_prod) * D;
      const denominator = (Ann - 1n) * D + (n + 1n) * D_prod;

      if (denominator === 0n) return 0n;

      D = numerator / denominator;

      // Convergence check: |D - D_prev| <= 1
      const diff = D > D_prev ? D - D_prev : D_prev - D;
      if (diff <= 1n) {
        return D;
      }
    }

    // Didn't converge — return best estimate
    logger.debug('StableSwap D computation did not converge');
    return D;
  }

  /**
   * Compute the output reserve y for an n-token StableSwap pool using Newton's method.
   *
   * Given the other reserves (excluding the output token) and invariant D, find y such that
   * the StableSwap invariant holds.
   *
   * @param otherReserves - All reserves except the output token (already updated with new input)
   * @param D - The pool invariant
   * @param Ann - A * n^n
   * @param n - Number of tokens in the pool
   */
  private computeStableSwapY(otherReserves: bigint[], D: bigint, Ann: bigint, n?: bigint): bigint {
    if (D <= 0n || Ann <= 0n) return 0n;
    for (const r of otherReserves) {
      if (r <= 0n) return 0n;
    }

    const nTokens = n ?? BigInt(otherReserves.length + 1);

    // S_ = sum of other reserves (all except the one we're solving for)
    let S_ = 0n;
    for (const r of otherReserves) {
      S_ += r;
    }

    // c = D^(n+1) / (Ann * n^n * prod(otherReserves))
    // Computed iteratively to avoid overflow
    let c = D;
    for (const r of otherReserves) {
      c = (c * D) / (r * nTokens);
    }
    c = (c * D) / (Ann * nTokens);

    // b = S_ + D / Ann
    const b = S_ + D / Ann;

    let y = D;

    for (let i = 0; i < 256; i++) {
      const y_prev = y;

      // y = (y^2 + c) / (2*y + b - D)
      const numerator = y * y + c;
      const denominator = 2n * y + b - D;

      if (denominator <= 0n) return 0n;

      y = numerator / denominator;

      const diff = y > y_prev ? y - y_prev : y_prev - y;
      if (diff <= 1n) {
        return y;
      }
    }

    logger.debug('StableSwap Y computation did not converge');
    return y;
  }

  private findOptimalTradeSize(levels: LiquidityLevel[]): number {
    // Optimal trade size is where marginal slippage cost equals marginal opportunity gain
    // Simplified: find the knee of the slippage curve
    if (levels.length < 2) return levels[0]?.tradeSizeUsd ?? 0;

    for (let i = 1; i < levels.length; i++) {
      const prevSlippage = levels[i - 1].slippagePercent;
      const currSlippage = levels[i].slippagePercent;
      const slippageIncrease = currSlippage - prevSlippage;

      // If slippage is increasing faster than linear, we've passed optimal
      if (slippageIncrease > 0.5) {
        return levels[i - 1].tradeSizeUsd;
      }
    }

    // If we didn't find a knee, return the largest size with < 1% slippage
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i].slippagePercent < 1.0) {
        return levels[i].tradeSizeUsd;
      }
    }

    return levels[0]?.tradeSizeUsd ?? 0;
  }

  private findMaxTradeSizeForSlippage(levels: LiquidityLevel[], maxSlippage: number): number {
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i].slippagePercent <= maxSlippage) {
        return levels[i].tradeSizeUsd;
      }
    }
    return 0;
  }

  private calculateLiquidityScore(
    pool: PoolLiquidity,
    buyLevels: LiquidityLevel[],
    sellLevels: LiquidityLevel[]
  ): number {
    let score = 0;

    // Base score from total liquidity (max 0.4)
    const liquidityScore = Math.min(0.4, pool.liquidityUsd / 10000000 * 0.4);
    score += liquidityScore;

    // Score from depth (can trade $10K with < 0.5% slippage) (max 0.3)
    const trade10K = buyLevels.find(l => l.tradeSizeUsd >= 10000);
    if (trade10K && trade10K.slippagePercent < 0.5) {
      score += 0.3;
    } else if (trade10K && trade10K.slippagePercent < 1.0) {
      score += 0.2;
    } else if (trade10K && trade10K.slippagePercent < 2.0) {
      score += 0.1;
    }

    // Score from symmetry (buy/sell depth similar) (max 0.2)
    if (buyLevels.length > 0 && sellLevels.length > 0) {
      const buyDepth = buyLevels[buyLevels.length - 1]?.tradeSizeUsd ?? 0;
      const sellDepth = sellLevels[sellLevels.length - 1]?.tradeSizeUsd ?? 0;
      const minDepth = Math.min(buyDepth, sellDepth);
      const maxDepth = Math.max(buyDepth, sellDepth);
      const symmetry = maxDepth > 0 ? minDepth / maxDepth : 0;
      score += symmetry * 0.2;
    }

    // Score from low fees (max 0.1)
    const feeScore = Math.max(0, (100 - pool.feeBps) / 100) * 0.1;
    score += feeScore;

    return Math.min(1, score);
  }

  private evictLRUPoolsIfNeeded(): void {
    if (this.pools.size < this.config.maxTrackedPools) {
      return;
    }

    // Find and remove the oldest 10% of pools by timestamp
    // Uses O(N*k) partial selection instead of O(N log N) full sort
    const toRemove = Math.max(1, Math.floor(this.config.maxTrackedPools * 0.1));
    const oldestEntries = findKSmallest(
      this.pools.entries(),
      toRemove,
      ([, a], [, b]) => a.timestamp - b.timestamp
    );
    const oldest = oldestEntries.map(([key]) => key);

    for (const key of oldest) {
      this.pools.delete(key);
      this.depthCache.delete(key);
      this.tickMapCache.delete(key);
      this.stats.poolEvictions++;
    }

    logger.debug('Evicted LRU pools', {
      evicted: toRemove,
      remaining: this.pools.size
    });
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
 */
let analyzerInstance: LiquidityDepthAnalyzer | null = null;

/**
 * Get the singleton LiquidityDepthAnalyzer instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton LiquidityDepthAnalyzer instance
 */
export function getLiquidityDepthAnalyzer(config?: Partial<LiquidityDepthConfig>): LiquidityDepthAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new LiquidityDepthAnalyzer(config);
  }
  return analyzerInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export function resetLiquidityDepthAnalyzer(): void {
  if (analyzerInstance) {
    analyzerInstance.reset();
  }
  analyzerInstance = null;
}
