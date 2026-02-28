/**
 * Gas Price Optimizer Service
 *
 * Centralized gas price management with spike detection and baseline tracking.
 * Extracted from base.strategy.ts as part of R4 refactoring.
 *
 * Features:
 * - Chain-specific gas price validation and fallbacks
 * - Gas price spike detection using median baseline
 * - Pre-submission gas price refresh with abort thresholds
 * - Configurable via environment variables
 *
 * @see base.strategy.ts (consumer)
 * @see REFACTORING_ROADMAP.md R4
 */

import { ethers } from 'ethers';
import { ARBITRAGE_CONFIG, getGasSpikeMultiplier } from '@arbitrage/config';
import { createPinoLogger, type ILogger } from '@arbitrage/core/logging';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { Logger, GasBaselineEntry } from '../types';
import { updateGasPrice as updateGasPriceMetric } from './prometheus-metrics';

// =============================================================================
// Module Logger
// =============================================================================

let _moduleLogger: ILogger | null = null;
function getModuleLogger(): ILogger {
  if (!_moduleLogger) {
    _moduleLogger = createPinoLogger('gas-price-optimizer');
  }
  return _moduleLogger;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Pre-computed BigInt multipliers for hot-path optimization.
 * Avoids repeated Math.floor + BigInt conversion on every call.
 *
 * GAS_SPIKE_MULTIPLIER_BIGINT: Global default (kept for backward compatibility).
 *   Per-chain multipliers are resolved via getGasSpikeMultiplierBigInt().
 * WEI_PER_GWEI: 10^9, pre-computed for wei-to-gwei conversions
 *
 * P2 FIX #15: Guard against NaN/Infinity from corrupt config.
 * BigInt(NaN) throws at module load, crashing the service with an unhelpful error.
 */
const _rawMultiplier = ARBITRAGE_CONFIG.gasPriceSpikeMultiplier;
const _safeMultiplier = (Number.isFinite(_rawMultiplier) && _rawMultiplier > 0) ? _rawMultiplier : 1.5;
export const GAS_SPIKE_MULTIPLIER_BIGINT = BigInt(Math.floor(_safeMultiplier * 100));
export const WEI_PER_GWEI = BigInt(1e9);

/**
 * Pre-computed per-chain gas spike multiplier cache (BigInt, scaled by 100).
 * Populated lazily on first access per chain. O(1) lookup after initialization.
 *
 * @see getGasSpikeMultiplier in @arbitrage/config for authoritative per-chain values
 */
const _chainSpikeMultiplierCache = new Map<string, bigint>();

/**
 * Get the gas spike multiplier for a specific chain as a BigInt (scaled by 100).
 * Uses per-chain config from @arbitrage/config with lazy caching for O(1) hot-path access.
 *
 * Example: Ethereum 5.0x → returns 500n; Arbitrum 2.0x → returns 200n
 *
 * @param chain - Chain identifier
 * @returns Spike multiplier as BigInt scaled by 100
 */
export function getGasSpikeMultiplierBigInt(chain: string): bigint {
  let cached = _chainSpikeMultiplierCache.get(chain);
  if (cached !== undefined) {
    return cached;
  }
  const multiplier = getGasSpikeMultiplier(chain);
  const safeMultiplier = (Number.isFinite(multiplier) && multiplier > 0) ? multiplier : _safeMultiplier;
  cached = BigInt(Math.floor(safeMultiplier * 100));
  _chainSpikeMultiplierCache.set(chain, cached);
  return cached;
}

/**
 * Fix 3.1: Minimum gas prices by chain type (mainnet vs L2).
 * These sanity checks prevent misconfigured gas prices that could cause:
 * 1. Transaction failures (gas too low)
 * 2. Unprofitable trades (testnet gas price on mainnet)
 *
 * L1 mainnet: Minimum 1 gwei (Ethereum mainnet rarely goes below this)
 * L2 chains: Can be much lower (often <0.01 gwei)
 */
export const MIN_GAS_PRICE_GWEI: Record<string, number> = {
  ethereum: 1,       // Mainnet minimum
  polygon: 1,        // Mainnet minimum
  bsc: 1,            // Mainnet minimum
  avalanche: 1,      // Mainnet minimum
  fantom: 1,         // Mainnet minimum
  // L2s can have very low gas
  arbitrum: 0.001,
  optimism: 0.0001,
  base: 0.0001,
  zksync: 0.01,
  linea: 0.01,
  blast: 0.0001,     // OP-stack L2
  scroll: 0.01,      // zkRollup (like zkSync/Linea)
  mantle: 0.0001,    // OP-stack L2 (MNT native token)
  mode: 0.0001,      // OP-stack L2
};

/**
 * Fix 3.1: Maximum reasonable gas prices by chain (sanity upper bound).
 * Prevents obviously misconfigured values (e.g., 10000 gwei).
 */
export const MAX_GAS_PRICE_GWEI: Record<string, number> = {
  ethereum: 500,     // Very high but possible during extreme congestion
  polygon: 1000,     // Polygon can spike
  bsc: 100,
  avalanche: 200,
  fantom: 500,
  arbitrum: 10,
  optimism: 1,
  base: 1,
  zksync: 10,
  linea: 10,
  blast: 1,          // OP-stack L2
  scroll: 10,        // zkRollup (like zkSync/Linea)
  mantle: 1,         // OP-stack L2 (MNT native token)
  mode: 1,           // OP-stack L2
};

/**
 * Fix 3.1: Validate gas price is within reasonable bounds for chain.
 * Fix 3.2: Also validates that the price is not NaN (from invalid env var).
 * Logs warning if configured value is suspicious but clamps to safe range.
 */
export function validateGasPrice(chain: string, configuredPrice: number): number {
  const min = MIN_GAS_PRICE_GWEI[chain] ?? 0.0001;
  const max = MAX_GAS_PRICE_GWEI[chain] ?? 1000;

  // Fix 3.2: Check for NaN from invalid environment variable
  if (Number.isNaN(configuredPrice)) {
    getModuleLogger().error('Invalid gas price (NaN)', {
      chain,
      envVar: `GAS_PRICE_${chain.toUpperCase()}_GWEI`,
      fallback: min,
    });
    return min;
  }

  if (configuredPrice < min) {
    getModuleLogger().warn('Gas price below minimum', {
      chain,
      configured: configuredPrice,
      min,
      using: min,
    });
    return min;
  }

  if (configuredPrice > max) {
    getModuleLogger().warn('Gas price above maximum', {
      chain,
      configured: configuredPrice,
      max,
      using: max,
    });
    return max;
  }

  return configuredPrice;
}

/**
 * Default fallback gas prices by chain (in gwei).
 * Used when provider fails to return gas price or no provider available.
 *
 * Finding 3.2 Fix: Gas prices are now configurable via environment variables.
 * Environment variable format: GAS_PRICE_<CHAIN>_GWEI (e.g., GAS_PRICE_ETHEREUM_GWEI=50)
 */
export const DEFAULT_GAS_PRICES_GWEI: Record<string, number> = {
  ethereum: validateGasPrice('ethereum', parseFloat(process.env.GAS_PRICE_ETHEREUM_GWEI || '50')),
  arbitrum: validateGasPrice('arbitrum', parseFloat(process.env.GAS_PRICE_ARBITRUM_GWEI || '0.1')),
  optimism: validateGasPrice('optimism', parseFloat(process.env.GAS_PRICE_OPTIMISM_GWEI || '0.001')),
  base: validateGasPrice('base', parseFloat(process.env.GAS_PRICE_BASE_GWEI || '0.001')),
  polygon: validateGasPrice('polygon', parseFloat(process.env.GAS_PRICE_POLYGON_GWEI || '35')),
  bsc: validateGasPrice('bsc', parseFloat(process.env.GAS_PRICE_BSC_GWEI || '3')),
  avalanche: validateGasPrice('avalanche', parseFloat(process.env.GAS_PRICE_AVALANCHE_GWEI || '25')),
  fantom: validateGasPrice('fantom', parseFloat(process.env.GAS_PRICE_FANTOM_GWEI || '35')),
  zksync: validateGasPrice('zksync', parseFloat(process.env.GAS_PRICE_ZKSYNC_GWEI || '0.25')),
  linea: validateGasPrice('linea', parseFloat(process.env.GAS_PRICE_LINEA_GWEI || '0.5')),
  blast: validateGasPrice('blast', parseFloat(process.env.GAS_PRICE_BLAST_GWEI || '0.001')),
  scroll: validateGasPrice('scroll', parseFloat(process.env.GAS_PRICE_SCROLL_GWEI || '0.5')),
  // IMPORTANT: Mantle uses MNT (~$0.80) as native token, NOT ETH (~$3200).
  // Gas cost calculations that assume ETH pricing will overestimate by ~4000x.
  // When Mantle exits stub status, add MNT-aware gas cost conversion.
  mantle: validateGasPrice('mantle', parseFloat(process.env.GAS_PRICE_MANTLE_GWEI || '0.02')),
  mode: validateGasPrice('mode', parseFloat(process.env.GAS_PRICE_MODE_GWEI || '0.001')),
};

/**
 * Pre-computed fallback gas prices in wei for hot-path optimization.
 * Avoids repeated ethers.parseUnits() calls on every getOptimalGasPrice() call.
 * Computed once at module load time.
 */
export const FALLBACK_GAS_PRICES_WEI: Record<string, bigint> = Object.fromEntries(
  Object.entries(DEFAULT_GAS_PRICES_GWEI).map(([chain, gwei]) => [
    chain,
    ethers.parseUnits(gwei.toString(), 'gwei'),
  ])
);

/** Default fallback price when chain is unknown (50 gwei) */
const DEFAULT_FALLBACK_GAS_PRICE_WEI = ethers.parseUnits('50', 'gwei');

/**
 * Get fallback gas price for a chain (O(1) lookup, no computation).
 * @param chain - Chain name
 * @returns Gas price in wei
 */
export function getFallbackGasPrice(chain: string): bigint {
  return FALLBACK_GAS_PRICES_WEI[chain] ?? DEFAULT_FALLBACK_GAS_PRICE_WEI;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Fix 3.1: Startup validation result for gas price configuration.
 * Tracks which chains are using fallback/minimum values.
 */
export interface GasConfigValidationResult {
  valid: boolean;
  warnings: string[];
  chainConfigs: Record<string, {
    configuredGwei: number;
    isMinimum: boolean;
    isMaximum: boolean;
    source: 'env' | 'default';
  }>;
}

// GasBaselineEntry is now imported from ../types (unified definition)
export type { GasBaselineEntry } from '../types';

/**
 * Configuration for the GasPriceOptimizer.
 */
export interface GasPriceOptimizerConfig {
  /** Maximum number of gas price samples to keep in history */
  maxGasHistory?: number;
  /** Maximum number of cached median values */
  maxMedianCacheSize?: number;
  /** Default median cache TTL for L1 chains (ms) */
  defaultMedianCacheTtlMs?: number;
  /** Median cache TTL for fast L2 chains (ms) */
  fastChainMedianCacheTtlMs?: number;
  /** Interval between median cache cleanup runs (ms) */
  medianCacheCleanupIntervalMs?: number;
  /**
   * EMA smoothing factor (alpha). Range: 0-1.
   * Higher values = more weight on recent prices (more responsive).
   * Default: 0.3 (30% weight on latest price)
   */
  emaSmoothingFactor?: number;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Fix 3.1: Validate gas price configuration at startup.
 *
 * Call this from engine initialization to log a summary of gas price configuration
 * and warn if any values fell back to minimum (which may indicate misconfiguration).
 *
 * @param logger - Logger instance for output
 * @returns Validation result with warnings
 */
export function validateGasPriceConfiguration(logger: Logger): GasConfigValidationResult {
  const warnings: string[] = [];
  const chainConfigs: GasConfigValidationResult['chainConfigs'] = {};

  for (const [chain, configuredPrice] of Object.entries(DEFAULT_GAS_PRICES_GWEI)) {
    const min = MIN_GAS_PRICE_GWEI[chain] ?? 0.0001;
    const max = MAX_GAS_PRICE_GWEI[chain] ?? 1000;
    const envVar = `GAS_PRICE_${chain.toUpperCase()}_GWEI`;
    const envValue = process.env[envVar];
    const source: 'env' | 'default' = envValue !== undefined ? 'env' : 'default';

    const isMinimum = configuredPrice === min;
    const isMaximum = configuredPrice === max;

    chainConfigs[chain] = {
      configuredGwei: configuredPrice,
      isMinimum,
      isMaximum,
      source,
    };

    // Warn if using minimum (may indicate NaN fallback or too-low config)
    if (isMinimum && source === 'env') {
      warnings.push(
        `[WARN] ${chain}: Using minimum gas price (${min} gwei). ` +
        `Check ${envVar} environment variable for validity.`
      );
    }

    // Warn if using maximum (may indicate typo or extreme congestion config)
    if (isMaximum && source === 'env') {
      warnings.push(
        `[WARN] ${chain}: Using maximum gas price (${max} gwei). ` +
        `Check ${envVar} environment variable - value may be too high.`
      );
    }
  }

  // Log summary
  const envConfigured = Object.values(chainConfigs).filter(c => c.source === 'env').length;
  logger.info('Gas price configuration validated', {
    totalChains: Object.keys(chainConfigs).length,
    envConfigured,
    warnings: warnings.length,
  });

  if (warnings.length > 0) {
    logger.warn('Gas configuration warnings', { warnings });
  }

  return {
    valid: warnings.length === 0,
    warnings,
    chainConfigs,
  };
}

// =============================================================================
// GasPriceOptimizer Class
// =============================================================================

/**
 * GasPriceOptimizer - Manages gas price tracking, baseline calculation, and spike detection.
 *
 * This class encapsulates all gas price management logic previously in BaseExecutionStrategy.
 * It maintains per-chain gas price baselines and provides spike detection to prevent
 * unprofitable transaction execution.
 *
 * Usage:
 * ```typescript
 * const optimizer = new GasPriceOptimizer(logger);
 * const gasPrice = await optimizer.getOptimalGasPrice(chain, provider, gasBaselines, lastGasPrices);
 * const refreshed = await optimizer.refreshGasPriceForSubmission(chain, provider, initialPrice);
 * ```
 */
export class GasPriceOptimizer {
  private readonly logger: Logger;

  // Cached median for performance optimization
  private medianCache: Map<string, { median: bigint; validUntil: number }> = new Map();

  /**
   * Phase 2 Optimization: Exponential Moving Average (EMA) for O(1) baseline tracking.
   * EMA = price * α + prevEMA * (1 - α)
   * Provides fast baseline estimation without O(n log n) median sort.
   */
  private emaBaselines: Map<string, bigint> = new Map();

  // Configuration
  private readonly MAX_GAS_HISTORY: number;
  private readonly MAX_MEDIAN_CACHE_SIZE: number;
  private readonly DEFAULT_MEDIAN_CACHE_TTL_MS: number;
  private readonly FAST_CHAIN_MEDIAN_CACHE_TTL_MS: number;
  private readonly MEDIAN_CACHE_CLEANUP_INTERVAL_MS: number;
  /** Chains with block times <= 2s. @see BLOCK_TIMES_MS in @arbitrage/config for authoritative source. */
  private readonly FAST_CHAINS = new Set([
    'arbitrum', 'optimism', 'base', 'zksync', 'linea', 'avalanche', 'fantom',
    // P3 Fix CC-7: Add remaining chains with blockTime <= 2s
    'polygon', 'blast', 'mantle', 'mode',
  ]);

  /**
   * EMA smoothing factor (α). Higher = more responsive to price changes.
   * 0.3 = 30% weight on latest price, 70% on historical average.
   */
  private readonly EMA_SMOOTHING_FACTOR: number;

  private lastMedianCacheCleanup = 0;

  constructor(logger: Logger, config?: GasPriceOptimizerConfig) {
    this.logger = logger;
    this.MAX_GAS_HISTORY = config?.maxGasHistory ?? 100;
    this.MAX_MEDIAN_CACHE_SIZE = config?.maxMedianCacheSize ?? 50;
    this.DEFAULT_MEDIAN_CACHE_TTL_MS = config?.defaultMedianCacheTtlMs ?? 5000;
    this.FAST_CHAIN_MEDIAN_CACHE_TTL_MS = config?.fastChainMedianCacheTtlMs ?? 2000;
    this.MEDIAN_CACHE_CLEANUP_INTERVAL_MS = config?.medianCacheCleanupIntervalMs ?? 60000;

    // Validate and clamp EMA smoothing factor to valid range [0.01, 0.99]
    // Invalid values could break EMA calculation math
    const rawAlpha = config?.emaSmoothingFactor ?? 0.3;
    const MIN_ALPHA = 0.01;
    const MAX_ALPHA = 0.99;

    if (Number.isNaN(rawAlpha) || rawAlpha < MIN_ALPHA || rawAlpha > MAX_ALPHA) {
      const clampedAlpha = Number.isNaN(rawAlpha) ? 0.3 : Math.max(MIN_ALPHA, Math.min(MAX_ALPHA, rawAlpha));
      this.logger.warn('EMA smoothing factor out of valid range, clamping', {
        configured: rawAlpha,
        validRange: `[${MIN_ALPHA}, ${MAX_ALPHA}]`,
        using: clampedAlpha,
      });
      this.EMA_SMOOTHING_FACTOR = clampedAlpha;
    } else {
      this.EMA_SMOOTHING_FACTOR = rawAlpha;
    }
  }

  /**
   * Get optimal gas price with spike protection.
   * Tracks baseline gas prices and rejects if current price exceeds threshold.
   *
   * @param chain - Chain identifier
   * @param provider - JSON-RPC provider (optional)
   * @param gasBaselines - Map of chain to gas baseline history
   * @param lastGasPrices - Optional map for O(1) last price access
   * @returns Optimal gas price in wei
   * @throws Error if gas spike detected
   */
  async getOptimalGasPrice(
    chain: string,
    provider: ethers.JsonRpcProvider | undefined,
    gasBaselines: Map<string, GasBaselineEntry[]>,
    lastGasPrices?: Map<string, bigint>
  ): Promise<bigint> {
    const fallbackPrice = getFallbackGasPrice(chain);

    if (!provider) {
      return fallbackPrice;
    }

    try {
      const feeData = await provider.getFeeData();
      const currentPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? fallbackPrice;

      // Update baseline and check for spike
      this.updateGasBaseline(chain, currentPrice, gasBaselines, lastGasPrices);

      if (ARBITRAGE_CONFIG.gasPriceSpikeEnabled) {
        const baselinePrice = this.getGasBaseline(chain, gasBaselines);
        if (baselinePrice > 0n) {
          const spikeMultiplierBigInt = getGasSpikeMultiplierBigInt(chain);
          const maxAllowedPrice = baselinePrice * spikeMultiplierBigInt / 100n;

          if (currentPrice > maxAllowedPrice) {
            const currentGwei = Number(currentPrice / WEI_PER_GWEI);
            const baselineGwei = Number(baselinePrice / WEI_PER_GWEI);
            const maxGwei = Number(maxAllowedPrice / WEI_PER_GWEI);
            const chainMultiplier = getGasSpikeMultiplier(chain);

            this.logger.warn('Gas price spike detected, aborting transaction', {
              chain,
              currentGwei,
              baselineGwei,
              maxGwei,
              multiplier: chainMultiplier,
            });

            throw new Error(`Gas price spike: ${currentGwei} gwei exceeds ${maxGwei} gwei (${chainMultiplier}x baseline)`);
          }
        }
      }

      return currentPrice;
    } catch (error) {
      // Re-throw gas spike errors
      const errorMessage = getErrorMessage(error);
      if (errorMessage.includes('Gas price spike')) {
        throw error;
      }
      this.logger.warn('Failed to get optimal gas price, using chain-specific fallback', {
        chain,
        fallbackGwei: Number(fallbackPrice / WEI_PER_GWEI),
        error
      });
      return fallbackPrice;
    }
  }

  /**
   * Refresh gas price immediately before transaction submission.
   *
   * In competitive MEV environments, gas prices can change significantly between
   * the initial getOptimalGasPrice() call and actual transaction submission.
   *
   * Abort Thresholds:
   * - >20%: Warning logged but execution continues
   * - >50%: Execution aborted to prevent unprofitable trades
   *
   * @param chain - Chain identifier
   * @param provider - JSON-RPC provider (optional)
   * @param previousGasPrice - The gas price from earlier getOptimalGasPrice() call
   * @returns Fresh gas price, or previousGasPrice if refresh fails
   * @throws Error if price increased >50%
   */
  async refreshGasPriceForSubmission(
    chain: string,
    provider: ethers.JsonRpcProvider | undefined,
    previousGasPrice: bigint
  ): Promise<bigint> {
    if (!provider) {
      return previousGasPrice;
    }

    try {
      const feeData = await provider.getFeeData();
      const currentPrice = feeData.maxFeePerGas ?? feeData.gasPrice;

      if (!currentPrice) {
        return previousGasPrice;
      }

      // Check for significant price increase since initial fetch
      const priceIncrease = currentPrice > previousGasPrice
        ? Number((currentPrice - previousGasPrice) * 100n / previousGasPrice)
        : 0;

      // Abort on >50% increase to prevent unprofitable trades
      if (priceIncrease > 50) {
        const previousGwei = Number(previousGasPrice / WEI_PER_GWEI);
        const currentGwei = Number(currentPrice / WEI_PER_GWEI);

        this.logger.error('[ERR_GAS_SPIKE] Aborting: gas price increased >50% since preparation', {
          chain,
          previousGwei,
          currentGwei,
          increasePercent: priceIncrease,
        });

        throw new Error(
          `[ERR_GAS_SPIKE] Gas price spike during submission: ` +
          `${previousGwei.toFixed(2)} -> ${currentGwei.toFixed(2)} gwei (+${priceIncrease}%)`
        );
      }

      if (priceIncrease > 20) {
        this.logger.warn('[WARN_GAS_INCREASE] Significant gas price increase since initial fetch', {
          chain,
          previousGwei: Number(previousGasPrice / WEI_PER_GWEI),
          currentGwei: Number(currentPrice / WEI_PER_GWEI),
          increasePercent: priceIncrease,
        });
      }

      return currentPrice;
    } catch (error) {
      // Re-throw gas spike errors (they're intentional aborts)
      const errorMessage = getErrorMessage(error);
      if (errorMessage.includes('[ERR_GAS_SPIKE]')) {
        throw error;
      }
      // On other failures, use the previous price - don't block transaction
      return previousGasPrice;
    }
  }

  /**
   * Update gas price baseline for spike detection.
   * Optimized for hot-path: uses in-place array compaction to avoid
   * temporary array allocations (filter/slice create new arrays).
   *
   * Phase 2 Enhancement: Also updates EMA baseline for O(1) spike detection.
   *
   * @param chain - Chain identifier
   * @param price - Current gas price in wei
   * @param gasBaselines - Map of chain to gas baseline history
   * @param lastGasPrices - Optional map for O(1) last price access
   */
  updateGasBaseline(
    chain: string,
    price: bigint,
    gasBaselines: Map<string, GasBaselineEntry[]>,
    lastGasPrices?: Map<string, bigint>
  ): void {
    const now = Date.now();
    const windowMs = ARBITRAGE_CONFIG.gasPriceBaselineWindowMs;

    if (!gasBaselines.has(chain)) {
      gasBaselines.set(chain, []);
    }

    const history = gasBaselines.get(chain)!;

    // Add current price
    history.push({ price, timestamp: now });

    // Update pre-computed last gas price for O(1) hot path access
    if (lastGasPrices) {
      lastGasPrices.set(chain, price);
    }

    // Update Prometheus gas price gauge (convert wei to gwei)
    if (price > 0n) {
      const priceGwei = Number(price / 1_000_000_000n);
      updateGasPriceMetric(chain, priceGwei);
    }

    // Record sample for linear regression prediction
    if (price > 0n) {
      this.recordPredictionSample(chain, price);
    }

    // Phase 2: Update EMA baseline (O(1) operation)
    // EMA = price * α + prevEMA * (1 - α)
    // Using scaled integer math: EMA = (price * α_scaled + prevEMA * (1000 - α_scaled)) / 1000
    if (price > 0n) {
      const existingEma = this.emaBaselines.get(chain);
      if (existingEma === undefined) {
        // First price: initialize EMA directly
        this.emaBaselines.set(chain, price);
      } else {
        // EMA update using scaled integer arithmetic (avoid floating point)
        // α = 0.3 → α_scaled = 300, (1-α) = 700
        const alphaScaled = BigInt(Math.floor(this.EMA_SMOOTHING_FACTOR * 1000));
        const oneMinusAlphaScaled = 1000n - alphaScaled;
        const newEma = (price * alphaScaled + existingEma * oneMinusAlphaScaled) / 1000n;
        this.emaBaselines.set(chain, newEma);
      }
    }

    // Invalidate median cache
    this.medianCache.delete(chain);

    // Remove old entries and cap size using in-place compaction
    const cutoff = now - windowMs;
    if (history.length > this.MAX_GAS_HISTORY || history[0]?.timestamp < cutoff) {
      // In-place compaction: single pass, no temporary arrays
      let writeIdx = 0;
      for (let readIdx = 0; readIdx < history.length; readIdx++) {
        if (history[readIdx].timestamp >= cutoff) {
          if (writeIdx !== readIdx) {
            history[writeIdx] = history[readIdx];
          }
          writeIdx++;
        }
      }

      // If still over limit, keep only most recent entries
      if (writeIdx > this.MAX_GAS_HISTORY) {
        const offset = writeIdx - this.MAX_GAS_HISTORY;
        for (let i = 0; i < this.MAX_GAS_HISTORY; i++) {
          history[i] = history[i + offset];
        }
        writeIdx = this.MAX_GAS_HISTORY;
      }

      // Truncate to valid entries
      history.length = writeIdx;
    }
  }

  /**
   * Calculate baseline gas price from recent history.
   *
   * Phase 2 Enhancement: Uses EMA for O(1) fast-path baseline estimation.
   * Falls back to median calculation with caching for edge cases.
   *
   * @param chain - Chain identifier
   * @param gasBaselines - Map of chain to gas baseline history
   * @returns Baseline gas price in wei, or 0n if no history
   */
  getGasBaseline(chain: string, gasBaselines: Map<string, GasBaselineEntry[]>): bigint {
    // Phase 2: Fast-path using EMA (O(1) lookup)
    const emaBaseline = this.emaBaselines.get(chain);
    if (emaBaseline !== undefined && emaBaseline > 0n) {
      return emaBaseline;
    }

    // Fallback to historical median calculation for cold start
    const history = gasBaselines.get(chain);
    if (!history || history.length === 0) {
      return 0n;
    }

    // With fewer than 3 samples, use graduated safety multipliers
    if (history.length < 3) {
      const sum = history.reduce((acc, h) => acc + h.price, 0n);
      const avg = sum / BigInt(history.length);

      // Graduated multiplier: more conservative with fewer samples
      const multiplier = history.length === 1 ? 5n : 4n; // 5/2 = 2.5x, 4/2 = 2.0x
      return avg * multiplier / 2n;
    }

    // Check cache first
    const now = Date.now();
    const cached = this.medianCache.get(chain);
    if (cached && now < cached.validUntil) {
      return cached.median;
    }

    // Periodic cleanup of expired cache entries
    this.cleanupMedianCacheIfNeeded(now);

    // Compute median (only for cold start when EMA not yet established)
    const sorted = [...history].sort((a, b) => {
      if (a.price < b.price) return -1;
      if (a.price > b.price) return 1;
      return 0;
    });

    const midIndex = Math.floor(sorted.length / 2);
    const median = sorted[midIndex].price;

    // Cache with chain-specific TTL
    const cacheTTL = this.getMedianCacheTTL(chain);
    this.medianCache.set(chain, {
      median,
      validUntil: now + cacheTTL
    });

    return median;
  }

  /**
   * Get the current EMA baseline for a chain (for monitoring/testing).
   * @param chain - Chain identifier
   * @returns EMA baseline in wei, or undefined if not established
   */
  getEmaBaseline(chain: string): bigint | undefined {
    return this.emaBaselines.get(chain);
  }

  /**
   * Get chain-specific median cache TTL.
   * Fast chains use shorter TTL to ensure fresher gas price data.
   */
  private getMedianCacheTTL(chain: string): number {
    return this.FAST_CHAINS.has(chain)
      ? this.FAST_CHAIN_MEDIAN_CACHE_TTL_MS
      : this.DEFAULT_MEDIAN_CACHE_TTL_MS;
  }

  /**
   * Clean up expired median cache entries periodically.
   * Called during getGasBaseline to avoid memory leaks.
   */
  private cleanupMedianCacheIfNeeded(now: number): void {
    if (now - this.lastMedianCacheCleanup < this.MEDIAN_CACHE_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastMedianCacheCleanup = now;

    // Collect keys to delete first
    const expiredKeys: string[] = [];
    for (const [key, value] of this.medianCache) {
      if (now >= value.validUntil) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this.medianCache.delete(key);
    }

    // Hard cap: if still over limit, evict oldest entries
    if (this.medianCache.size > this.MAX_MEDIAN_CACHE_SIZE) {
      const entries = Array.from(this.medianCache.entries())
        .sort((a, b) => a[1].validUntil - b[1].validUntil);

      const toRemove = entries.slice(0, entries.length - this.MAX_MEDIAN_CACHE_SIZE);
      for (const [key] of toRemove) {
        this.medianCache.delete(key);
      }
    }
  }

  /**
   * Reset the median cache and EMA baselines (for testing).
   */
  resetMedianCache(): void {
    this.medianCache.clear();
    this.emaBaselines.clear();
    this.lastMedianCacheCleanup = 0;
  }

  /**
   * Reset only EMA baselines (for testing specific scenarios).
   */
  resetEmaBaselines(): void {
    this.emaBaselines.clear();
  }

  // ===========================================================================
  // Gas Price Prediction via Linear Regression
  // ===========================================================================

  /**
   * Ring buffer of recent (timestamp, gasPrice) samples per chain.
   * Uses index wrapping (O(1) insertion) instead of splice (O(n) shift).
   */
  private predictionSamples: Map<string, {
    data: Array<{ timestamp: number; price: bigint }>;
    writeIdx: number;
    count: number;
  }> = new Map();

  /** Maximum samples kept for regression (ring buffer size) */
  private readonly PREDICTION_BUFFER_SIZE = 30;
  /** Minimum samples needed for a valid regression */
  private readonly MIN_REGRESSION_SAMPLES = 5;

  /**
   * Record a gas price sample for prediction.
   * Called automatically from updateGasBaseline.
   */
  private recordPredictionSample(chain: string, price: bigint): void {
    let buffer = this.predictionSamples.get(chain);
    if (!buffer) {
      buffer = { data: new Array(this.PREDICTION_BUFFER_SIZE), writeIdx: 0, count: 0 };
      this.predictionSamples.set(chain, buffer);
    }

    buffer.data[buffer.writeIdx] = { timestamp: Date.now(), price };
    buffer.writeIdx = (buffer.writeIdx + 1) % this.PREDICTION_BUFFER_SIZE;
    if (buffer.count < this.PREDICTION_BUFFER_SIZE) {
      buffer.count++;
    }
  }

  /**
   * Predict the gas price at a future time using simple linear regression.
   *
   * Fits a line y = slope * x + intercept on recent (timestamp, gasPrice) samples,
   * then extrapolates to `now + estimatedDelayMs`.
   *
   * Falls back to EMA baseline when insufficient samples (<5).
   *
   * @param chain - Chain identifier
   * @param estimatedDelayMs - How far into the future to predict (default: 2000ms)
   * @returns Predicted gas price in wei, or EMA baseline as fallback
   */
  predictGasPrice(chain: string, estimatedDelayMs: number = 2000): bigint | undefined {
    const buffer = this.predictionSamples.get(chain);

    // Insufficient data: fall back to EMA
    if (!buffer || buffer.count < this.MIN_REGRESSION_SAMPLES) {
      return this.emaBaselines.get(chain);
    }

    // Simple linear regression: y = slope * x + intercept
    // x = timestamp (ms), y = gas price (Number, in gwei for precision)
    const n = buffer.count;

    // Ring buffer oldest entry: if not full, starts at 0; if full, starts at writeIdx
    const oldestIdx = buffer.count < this.PREDICTION_BUFFER_SIZE ? 0 : buffer.writeIdx;

    // Use relative timestamps to avoid precision loss with large epoch values
    const t0 = buffer.data[oldestIdx].timestamp;

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (let i = 0; i < n; i++) {
      const idx = (oldestIdx + i) % this.PREDICTION_BUFFER_SIZE;
      const x = buffer.data[idx].timestamp - t0;
      // Convert to gwei for regression to avoid BigInt precision issues
      const y = Number(buffer.data[idx].price / WEI_PER_GWEI);

      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    const denominator = n * sumX2 - sumX * sumX;

    // Degenerate case: all samples at same timestamp
    if (Math.abs(denominator) < 1e-10) {
      return this.emaBaselines.get(chain);
    }

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    // Predict at future timestamp
    const futureX = (Date.now() - t0) + estimatedDelayMs;
    const predictedGwei = slope * futureX + intercept;

    // Sanity: predicted price must be positive
    if (predictedGwei <= 0) {
      return this.emaBaselines.get(chain);
    }

    // Convert back to wei
    return ethers.parseUnits(predictedGwei.toFixed(9), 'gwei');
  }

  /**
   * Reset prediction samples (for testing).
   */
  resetPredictionSamples(): void {
    this.predictionSamples.clear();
  }
}
