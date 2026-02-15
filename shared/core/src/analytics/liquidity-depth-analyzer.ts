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
 * - Concentrated Liquidity — Uniswap V3 style (single-tick approximation)
 * - StableSwap — Curve style (Newton's method for StableSwap invariant)
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding T3.15
 * @see .agent-reports/analytics-deep-analysis.md - Finding #26
 */

import { createLogger } from '../logger';

const logger = createLogger('liquidity-depth-analyzer');

// BigInt precision for calculations
const PRECISION = 10n ** 18n;

/**
 * PRECISION-FIX: Safely convert a float to BigInt with 18 decimal places.
 * Avoids float multiplication precision loss by using string manipulation.
 *
 * @param value - Float value to convert (e.g., 0.000000123456789)
 * @returns BigInt representation in wei (value * 10^18)
 */
function floatToBigInt18(value: number): bigint {
  if (value === 0) return 0n;

  // Use toFixed to get a precise string representation
  // Then split on decimal and pad/truncate to 18 decimal places
  const [intPart, decPart = ''] = value.toFixed(18).split('.');
  const paddedDec = decPart.padEnd(18, '0').slice(0, 18);

  // Combine integer and decimal parts as a single BigInt
  return BigInt(intPart + paddedDec);
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
  // --- Curve StableSwap fields ---
  /** Curve amplification parameter A (typically 100-2000) */
  amplificationParameter?: number;
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
    this.pools.set(pool.poolAddress, pool);

    // Invalidate depth cache for this pool
    this.depthCache.delete(pool.poolAddress);
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
        return this.calculateStableSwapOutput(
          amountIn,
          reserveIn,
          reserveOut,
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
  private calculateStableSwapOutput(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: number,
    amplificationParameter: number
  ): { amountOut: bigint; priceImpact: number } {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    // Apply fee
    const feeMultiplier = BigInt(10000 - feeBps);
    const amountInWithFee = (amountIn * feeMultiplier) / 10000n;

    const A = BigInt(amplificationParameter);
    const n = 2n; // 2-token pool
    const Ann = A * n * n; // A * n^n for n=2

    // Step 1: Compute D (invariant) from current reserves
    const D = this.computeStableSwapD(reserveIn, reserveOut, Ann);
    if (D <= 0n) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    // Step 2: Compute new output reserve y given new input reserve
    const newReserveIn = reserveIn + amountInWithFee;
    const newReserveOut = this.computeStableSwapY(newReserveIn, D, Ann);
    if (newReserveOut <= 0n || newReserveOut >= reserveOut) {
      return { amountOut: 0n, priceImpact: 1 };
    }

    // Step 3: amountOut = old_y - new_y
    const amountOut = reserveOut - newReserveOut;

    // Calculate price impact
    // Initial price for stableswap at balanced reserves ≈ 1:1
    // Effective price = amountOut / amountIn
    const initialPriceScaled = (reserveOut * PRECISION) / reserveIn;
    const effectivePriceScaled = (amountOut * PRECISION) / amountIn;

    const priceImpact = initialPriceScaled > 0n
      ? Number(PRECISION - (effectivePriceScaled * PRECISION) / initialPriceScaled) / Number(PRECISION)
      : 1;

    return { amountOut, priceImpact: Math.max(0, priceImpact) };
  }

  /**
   * Compute the StableSwap invariant D for a 2-token pool using Newton's method.
   *
   * Solves: Ann * S + D = Ann * D + D^3 / (4 * x * y)
   * Where S = x + y
   *
   * Newton iteration:
   *   D_next = (Ann * S + 2 * D_prod - D * (Ann - 1)) * D / ((Ann + 1) * D - (Ann - 1) * D + 3 * D_prod)
   *   Simplified: D_next = (Ann * S + n * D_prod) * D / ((Ann - 1) * D + (n + 1) * D_prod)
   *
   * @param x - Reserve of token 0
   * @param y - Reserve of token 1
   * @param Ann - A * n^n (amplification * 4 for n=2)
   * @returns D - the invariant value
   */
  private computeStableSwapD(x: bigint, y: bigint, Ann: bigint): bigint {
    const S = x + y;
    if (S === 0n) return 0n;

    let D = S;
    const n = 2n;

    // Newton's method — converges in ~10 iterations for typical values
    for (let i = 0; i < 256; i++) {
      // D_prod = D^3 / (n^n * prod(reserves)) = D^3 / (4*x*y)
      let D_prod = D;
      D_prod = (D_prod * D) / (x * n);
      D_prod = (D_prod * D) / (y * n);

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
   * Compute the output reserve y for a 2-token StableSwap pool using Newton's method.
   *
   * Given the new input reserve x and invariant D, find y such that:
   *   Ann * (x + y) + D = Ann * D + D^3 / (4*x*y)
   *
   * Rearranged as f(y) = 0:
   *   y^2 + (x + D/Ann - D) * y = D^3 / (4 * Ann * x)
   *
   * Newton iteration:
   *   y_next = (y^2 + c) / (2*y + b - D)
   *   where b = x + D/Ann, c = D^3 / (4*Ann*x)
   */
  private computeStableSwapY(x: bigint, D: bigint, Ann: bigint): bigint {
    if (x <= 0n || D <= 0n || Ann <= 0n) return 0n;

    const n = 2n;
    // c = D^3 / (4 * Ann * x) — but we compute step by step to avoid overflow
    let c = D;
    c = (c * D) / (x * n);
    c = (c * D) / (Ann * n);

    // b = x + D/Ann
    const b = x + D / Ann;

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
    const oldest = this.findOldestN(this.pools, toRemove, (pool) => pool.timestamp);

    for (const key of oldest) {
      this.pools.delete(key);
      this.depthCache.delete(key);
      this.stats.poolEvictions++;
    }

    logger.debug('Evicted LRU pools', {
      evicted: toRemove,
      remaining: this.pools.size
    });
  }

  /**
   * Find the N entries with the smallest timestamps in a single pass.
   * O(N*k) where k = n, much better than O(N log N) sort when k << N.
   */
  private findOldestN<V>(
    map: Map<string, V>,
    n: number,
    getTime: (value: V) => number
  ): string[] {
    const oldest: Array<{ key: string; time: number }> = [];

    for (const [key, value] of map) {
      const time = getTime(value);
      if (oldest.length < n) {
        oldest.push({ key, time });
        if (oldest.length === n) {
          oldest.sort((a, b) => b.time - a.time);
        }
      } else if (time < oldest[0].time) {
        oldest[0] = { key, time };
        oldest.sort((a, b) => b.time - a.time);
      }
    }

    return oldest.map(e => e.key);
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
