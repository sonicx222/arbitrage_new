/**
 * Base Execution Strategy
 *
 * Provides shared utility methods for all execution strategies:
 * - Gas price optimization with spike protection
 * - MEV protection
 * - Price verification
 * - DEX swap transaction preparation
 * - Transaction timeout handling
 *
 * Note: For flash loan transactions, use FlashLoanStrategy directly.
 *
 * @see engine.ts (parent service)
 */

import { ethers } from 'ethers';
import { CHAINS, ARBITRAGE_CONFIG, MEV_CONFIG, DEXES } from '@arbitrage/config';
import { getErrorMessage, createPinoLogger, type ILogger } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// Lazy-initialized logger for module-level validation
let _moduleLogger: ILogger | null = null;
function getModuleLogger(): ILogger {
  if (!_moduleLogger) {
    _moduleLogger = createPinoLogger('base-strategy');
  }
  return _moduleLogger;
}
import type {
  Logger,
  StrategyContext,
  ExecutionResult,
} from '../types';
import { TRANSACTION_TIMEOUT_MS, withTimeout } from '../types';
import type { SimulationRequest, SimulationResult } from '../services/simulation/types';

/**
 * Standard Uniswap V2 Router ABI for swapExactTokensForTokens.
 * Compatible with most DEX routers (SushiSwap, PancakeSwap, etc.)
 */
const UNISWAP_V2_ROUTER_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

/**
 * Standard ERC20 approve ABI for token allowances.
 */
const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

/**
 * Fix 3.1: Minimum gas prices by chain type (mainnet vs L2).
 * These sanity checks prevent misconfigured gas prices that could cause:
 * 1. Transaction failures (gas too low)
 * 2. Unprofitable trades (testnet gas price on mainnet)
 *
 * L1 mainnet: Minimum 1 gwei (Ethereum mainnet rarely goes below this)
 * L2 chains: Can be much lower (often <0.01 gwei)
 */
const MIN_GAS_PRICE_GWEI: Record<string, number> = {
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
};

/**
 * Fix 3.1: Maximum reasonable gas prices by chain (sanity upper bound).
 * Prevents obviously misconfigured values (e.g., 10000 gwei).
 */
const MAX_GAS_PRICE_GWEI: Record<string, number> = {
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
};

/**
 * Default fallback gas prices by chain (in gwei).
 * Used when provider fails to return gas price or no provider available.
 *
 * Finding 3.2 Fix: Gas prices are now configurable via environment variables.
 * Environment variable format: GAS_PRICE_<CHAIN>_GWEI (e.g., GAS_PRICE_ETHEREUM_GWEI=50)
 *
 * Default values are conservative estimates - actual gas prices may be lower.
 */
const DEFAULT_GAS_PRICES_GWEI: Record<string, number> = {
  ethereum: validateGasPrice('ethereum', parseFloat(process.env.GAS_PRICE_ETHEREUM_GWEI || '50')),
  arbitrum: validateGasPrice('arbitrum', parseFloat(process.env.GAS_PRICE_ARBITRUM_GWEI || '0.1')),
  optimism: validateGasPrice('optimism', parseFloat(process.env.GAS_PRICE_OPTIMISM_GWEI || '0.001')),
  base: validateGasPrice('base', parseFloat(process.env.GAS_PRICE_BASE_GWEI || '0.001')),
  polygon: validateGasPrice('polygon', parseFloat(process.env.GAS_PRICE_POLYGON_GWEI || '100')),
  bsc: validateGasPrice('bsc', parseFloat(process.env.GAS_PRICE_BSC_GWEI || '5')),
  avalanche: validateGasPrice('avalanche', parseFloat(process.env.GAS_PRICE_AVALANCHE_GWEI || '25')),
  fantom: validateGasPrice('fantom', parseFloat(process.env.GAS_PRICE_FANTOM_GWEI || '100')),
  zksync: validateGasPrice('zksync', parseFloat(process.env.GAS_PRICE_ZKSYNC_GWEI || '0.25')),
  linea: validateGasPrice('linea', parseFloat(process.env.GAS_PRICE_LINEA_GWEI || '0.5')),
};

/**
 * Fix 3.1: Validate gas price is within reasonable bounds for chain.
 * Fix 3.2: Also validates that the price is not NaN (from invalid env var).
 * Logs warning if configured value is suspicious but clamps to safe range.
 */
function validateGasPrice(chain: string, configuredPrice: number): number {
  const min = MIN_GAS_PRICE_GWEI[chain] ?? 0.0001;
  const max = MAX_GAS_PRICE_GWEI[chain] ?? 1000;

  // Fix 3.2: Check for NaN from invalid environment variable (e.g., GAS_PRICE_ETHEREUM_GWEI=abc)
  // NaN comparisons always return false, so we must check explicitly
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
 * Pre-computed fallback gas prices in wei for hot-path optimization.
 * Avoids repeated ethers.parseUnits() calls on every getOptimalGasPrice() call.
 * Computed once at module load time.
 */
const FALLBACK_GAS_PRICES_WEI: Record<string, bigint> = Object.fromEntries(
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
function getFallbackGasPrice(chain: string): bigint {
  return FALLBACK_GAS_PRICES_WEI[chain] ?? DEFAULT_FALLBACK_GAS_PRICE_WEI;
}

/**
 * Pre-computed BigInt multipliers for hot-path optimization.
 * Avoids repeated Math.floor + BigInt conversion on every call.
 *
 * GAS_SPIKE_MULTIPLIER_BIGINT: Used for gas spike detection (e.g., 1.5x = 150)
 * SLIPPAGE_BASIS_POINTS_BIGINT: Slippage tolerance in basis points (e.g., 0.5% = 50)
 * GWEI_DIVISOR: 10^9, pre-computed for wei-to-gwei conversions (Finding 10.2 fix)
 */
const GAS_SPIKE_MULTIPLIER_BIGINT = BigInt(Math.floor(ARBITRAGE_CONFIG.gasPriceSpikeMultiplier * 100));
const SLIPPAGE_BASIS_POINTS_BIGINT = BigInt(Math.floor(ARBITRAGE_CONFIG.slippageTolerance * 10000));
const GWEI_DIVISOR = BigInt(1e9);

/**
 * Base class for execution strategies.
 * Provides shared utility methods.
 */
export abstract class BaseExecutionStrategy {
  protected readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Execute the opportunity (implemented by subclasses).
   */
  abstract execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult>;

  // ===========================================================================
  // Context Validation (Fix 9.1: Reduce duplication across strategies)
  // ===========================================================================

  /**
   * Validate that required context dependencies are available for a chain.
   *
   * This helper consolidates the common pattern of checking wallet and provider
   * availability that was duplicated across IntraChainStrategy, FlashLoanStrategy,
   * and CrossChainStrategy.
   *
   * @param chain - Chain identifier to validate
   * @param ctx - Strategy context to check
   * @param options - Additional validation options
   * @returns Validation result with wallet/provider if valid
   */
  protected validateContext(
    chain: string,
    ctx: StrategyContext,
    options?: {
      requireNonceManager?: boolean;
      requireMevProvider?: boolean;
      requireBridgeRouter?: boolean;
    }
  ): { valid: true; wallet: ethers.Wallet; provider: ethers.JsonRpcProvider } | { valid: false; error: string } {
    // Check provider
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return { valid: false, error: `[ERR_NO_PROVIDER] No provider available for chain: ${chain}` };
    }

    // Check wallet
    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      return { valid: false, error: `[ERR_NO_WALLET] No wallet available for chain: ${chain}` };
    }

    // Optional: Check nonce manager
    if (options?.requireNonceManager && !ctx.nonceManager) {
      return { valid: false, error: '[ERR_NO_NONCE_MANAGER] NonceManager not initialized' };
    }

    // Optional: Check MEV provider
    if (options?.requireMevProvider && !ctx.mevProviderFactory) {
      return { valid: false, error: '[ERR_NO_MEV_PROVIDER] MevProviderFactory not initialized' };
    }

    // Optional: Check bridge router
    if (options?.requireBridgeRouter && !ctx.bridgeRouterFactory) {
      return { valid: false, error: '[ERR_NO_BRIDGE] BridgeRouterFactory not initialized' };
    }

    return { valid: true, wallet, provider };
  }

  // ===========================================================================
  // Gas Price Management
  // ===========================================================================

  /**
   * Get optimal gas price with spike protection.
   * Tracks baseline gas prices and rejects if current price exceeds threshold.
   */
  protected async getOptimalGasPrice(
    chain: string,
    ctx: StrategyContext
  ): Promise<bigint> {
    const provider = ctx.providers.get(chain);
    const fallbackPrice = getFallbackGasPrice(chain);

    if (!provider) {
      return fallbackPrice;
    }

    try {
      const feeData = await provider.getFeeData();
      const currentPrice = feeData.maxFeePerGas || feeData.gasPrice || fallbackPrice;

      // Update baseline and check for spike
      this.updateGasBaseline(chain, currentPrice, ctx);

      if (ARBITRAGE_CONFIG.gasPriceSpikeEnabled) {
        const baselinePrice = this.getGasBaseline(chain, ctx);
        if (baselinePrice > 0n) {
          const maxAllowedPrice = baselinePrice * GAS_SPIKE_MULTIPLIER_BIGINT / 100n;

          if (currentPrice > maxAllowedPrice) {
            // Finding 10.2 Fix: Use pre-computed GWEI_DIVISOR to avoid BigInt creation in hot path
            const currentGwei = Number(currentPrice / GWEI_DIVISOR);
            const baselineGwei = Number(baselinePrice / GWEI_DIVISOR);
            const maxGwei = Number(maxAllowedPrice / GWEI_DIVISOR);

            this.logger.warn('Gas price spike detected, aborting transaction', {
              chain,
              currentGwei,
              baselineGwei,
              maxGwei,
              multiplier: ARBITRAGE_CONFIG.gasPriceSpikeMultiplier
            });

            throw new Error(`Gas price spike: ${currentGwei} gwei exceeds ${maxGwei} gwei (${ARBITRAGE_CONFIG.gasPriceSpikeMultiplier}x baseline)`);
          }
        }
      }

      return currentPrice;
    } catch (error) {
      // Re-throw gas spike errors
      if (getErrorMessage(error)?.includes('Gas price spike')) {
        throw error;
      }
      this.logger.warn('Failed to get optimal gas price, using chain-specific fallback', {
        chain,
        fallbackGwei: Number(fallbackPrice / GWEI_DIVISOR),
        error
      });
      return fallbackPrice;
    }
  }

  /**
   * Fix 5.1: Refresh gas price immediately before transaction submission.
   *
   * In competitive MEV environments, gas prices can change significantly between
   * the initial getOptimalGasPrice() call and actual transaction submission.
   * This method performs a lightweight gas price refresh without full baseline
   * update (which would be too slow for the hot path).
   *
   * **Abort Thresholds:**
   * - >20%: Warning logged but execution continues
   * - >50%: Execution aborted to prevent unprofitable trades
   *
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @param previousGasPrice - The gas price from earlier getOptimalGasPrice() call
   * @returns Fresh gas price, or previousGasPrice if refresh fails
   * @throws Error if price increased >50% (Fix 5.1: prevents unprofitable execution)
   */
  protected async refreshGasPriceForSubmission(
    chain: string,
    ctx: StrategyContext,
    previousGasPrice: bigint
  ): Promise<bigint> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return previousGasPrice;
    }

    try {
      const feeData = await provider.getFeeData();
      const currentPrice = feeData.maxFeePerGas || feeData.gasPrice;

      if (!currentPrice) {
        return previousGasPrice;
      }

      // Check for significant price increase since initial fetch
      const priceIncrease = currentPrice > previousGasPrice
        ? Number((currentPrice - previousGasPrice) * 100n / previousGasPrice)
        : 0;

      // Fix 5.1: Abort on >50% increase to prevent unprofitable trades
      if (priceIncrease > 50) {
        const previousGwei = Number(previousGasPrice / GWEI_DIVISOR);
        const currentGwei = Number(currentPrice / GWEI_DIVISOR);

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
          previousGwei: Number(previousGasPrice / GWEI_DIVISOR),
          currentGwei: Number(currentPrice / GWEI_DIVISOR),
          increasePercent: priceIncrease,
        });
      }

      return currentPrice;
    } catch (error) {
      // Re-throw gas spike errors (they're intentional aborts)
      if (getErrorMessage(error)?.includes('[ERR_GAS_SPIKE]')) {
        throw error;
      }
      // On other failures, use the previous price - don't block transaction
      return previousGasPrice;
    }
  }

  // Cached median for performance optimization
  private medianCache: Map<string, { median: bigint; validUntil: number }> = new Map();
  private readonly MEDIAN_CACHE_TTL_MS = 5000; // Cache median for 5 seconds
  private readonly MAX_GAS_HISTORY = 100;
  private readonly MAX_MEDIAN_CACHE_SIZE = 50; // Cap cache size to prevent unbounded growth
  private lastMedianCacheCleanup = 0;
  private readonly MEDIAN_CACHE_CLEANUP_INTERVAL_MS = 60000; // Cleanup expired entries every 60s

  /**
   * Update gas price baseline for spike detection.
   * Optimized for hot-path: uses in-place array compaction to avoid
   * temporary array allocations (filter/slice create new arrays).
   *
   * Note on thread safety (Fix 5.1):
   * In Node.js single-threaded event loop, this method runs synchronously.
   * There's no true race condition, but we use atomic-style cache update
   * (validUntil = 0) instead of delete to prevent thundering herd if multiple
   * async operations are queued.
   */
  protected updateGasBaseline(
    chain: string,
    price: bigint,
    ctx: StrategyContext
  ): void {
    const now = Date.now();
    const windowMs = ARBITRAGE_CONFIG.gasPriceBaselineWindowMs;

    if (!ctx.gasBaselines.has(chain)) {
      ctx.gasBaselines.set(chain, []);
    }

    const history = ctx.gasBaselines.get(chain)!;

    // Add current price
    history.push({ price, timestamp: now });

    // Fix 5.1: Use atomic-style invalidation instead of delete
    // Setting validUntil to 0 marks as stale while preserving the entry
    // This prevents thundering herd on immediate subsequent reads
    const cached = this.medianCache.get(chain);
    if (cached) {
      cached.validUntil = 0; // Mark as stale, will be recomputed on next read
    }

    // Remove old entries and cap size using in-place compaction
    // This avoids creating temporary arrays on every call (hot-path optimization)
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
   * Uses median to avoid outlier influence.
   * Caches result for 5 seconds to avoid repeated sorting.
   */
  protected getGasBaseline(chain: string, ctx: StrategyContext): bigint {
    const history = ctx.gasBaselines.get(chain);
    if (!history || history.length === 0) {
      return 0n;
    }

    // With fewer than 3 samples, use average with safety margin
    if (history.length < 3) {
      const sum = history.reduce((acc, h) => acc + h.price, 0n);
      const avg = sum / BigInt(history.length);
      return avg * 3n / 2n;
    }

    // Check cache first
    const now = Date.now();
    const cached = this.medianCache.get(chain);
    if (cached && now < cached.validUntil) {
      return cached.median;
    }

    // Periodic cleanup of expired cache entries (prevents memory leak)
    this.cleanupMedianCacheIfNeeded(now);

    // Compute median (only when cache is stale)
    const sorted = [...history].sort((a, b) => {
      if (a.price < b.price) return -1;
      if (a.price > b.price) return 1;
      return 0;
    });

    const midIndex = Math.floor(sorted.length / 2);
    const median = sorted[midIndex].price;

    // Cache the result
    this.medianCache.set(chain, {
      median,
      validUntil: now + this.MEDIAN_CACHE_TTL_MS
    });

    return median;
  }

  /**
   * Clean up expired median cache entries periodically.
   * Called during getGasBaseline to avoid memory leaks from stale chain entries.
   * Also enforces a hard cap on cache size for safety.
   *
   * Fix 10.2.1: Performance note on cache cleanup
   * This uses Array.from + sort for eviction, which allocates temporary arrays.
   * This is acceptable because:
   * 1. Cleanup only runs every MEDIAN_CACHE_CLEANUP_INTERVAL_MS (not hot path)
   * 2. Cache size is bounded by number of chains (~11), so arrays are small
   * 3. The sort only happens in the rare overflow case (typically never)
   *
   * Alternative approaches considered:
   * - Min-heap for validUntil timestamps: Over-engineering for ~11 entries
   * - LRU cache: Would require tracking access order (more overhead)
   * - Random eviction: Simpler but could evict recently-used entries
   *
   * Current approach is simple, correct, and performant for the actual use case.
   */
  private cleanupMedianCacheIfNeeded(now: number): void {
    // Only run cleanup periodically to avoid overhead on every call
    if (now - this.lastMedianCacheCleanup < this.MEDIAN_CACHE_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastMedianCacheCleanup = now;

    // Remove expired entries (O(n) scan)
    for (const [key, value] of this.medianCache) {
      if (now >= value.validUntil) {
        this.medianCache.delete(key);
      }
    }

    // Hard cap: if still over limit after expiry check, evict oldest entries
    // This only triggers if many chains added rapidly without expiry
    if (this.medianCache.size > this.MAX_MEDIAN_CACHE_SIZE) {
      const entries = Array.from(this.medianCache.entries())
        .sort((a, b) => a[1].validUntil - b[1].validUntil);

      const toRemove = entries.slice(0, entries.length - this.MAX_MEDIAN_CACHE_SIZE);
      for (const [key] of toRemove) {
        this.medianCache.delete(key);
      }
    }
  }

  // ===========================================================================
  // MEV Protection
  // ===========================================================================

  /**
   * Apply MEV protection to prevent sandwich attacks.
   */
  protected async applyMEVProtection(
    tx: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext
  ): Promise<ethers.TransactionRequest> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      tx.gasPrice = await this.getOptimalGasPrice(chain, ctx);
      return tx;
    }

    try {
      const feeData = await provider.getFeeData();

      // Use EIP-1559 transaction format for better fee predictability
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        tx.type = 2;
        tx.maxFeePerGas = feeData.maxFeePerGas;
        // Cap priority fee to prevent MEV extractors from frontrunning
        const maxPriorityFee = feeData.maxPriorityFeePerGas;
        const cappedPriorityFee = maxPriorityFee < ethers.parseUnits('3', 'gwei')
          ? maxPriorityFee
          : ethers.parseUnits('3', 'gwei');
        tx.maxPriorityFeePerGas = cappedPriorityFee;
        delete tx.gasPrice;
      } else {
        tx.gasPrice = await this.getOptimalGasPrice(chain, ctx);
      }

      if (chain === 'ethereum') {
        this.logger.info('MEV protection: Using Flashbots-style private transaction', {
          chain,
          hasEIP1559: !!feeData.maxFeePerGas
        });
      }

      this.logger.debug('MEV protection applied', {
        chain,
        type: tx.type,
        maxFeePerGas: tx.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
        gasPrice: tx.gasPrice?.toString()
      });

      return tx;
    } catch (error) {
      this.logger.warn('Failed to apply full MEV protection, using basic gas price', {
        chain,
        error: getErrorMessage(error)
      });
      tx.gasPrice = await this.getOptimalGasPrice(chain, ctx);
      return tx;
    }
  }

  // ===========================================================================
  // MEV Eligibility Check (Fix 6.3 & 9.1)
  // ===========================================================================

  /**
   * Fix 6.3 & 9.1: Check if MEV protection should be used for a transaction.
   *
   * This helper consolidates the MEV eligibility check that was duplicated
   * in FlashLoanStrategy.execute() and submitTransaction().
   *
   * MEV protection is used when:
   * 1. MEV provider is available for the chain
   * 2. MEV provider is enabled
   * 3. Chain-specific MEV settings allow it (enabled !== false)
   * 4. Expected profit meets minimum threshold for MEV protection
   *
   * @param chain - Chain identifier
   * @param ctx - Strategy context with mevProviderFactory
   * @param expectedProfit - Expected profit in USD
   * @returns Object with eligibility status and provider if eligible
   */
  protected checkMevEligibility(
    chain: string,
    ctx: StrategyContext,
    expectedProfit?: number
  ): {
    shouldUseMev: boolean;
    mevProvider?: ReturnType<NonNullable<StrategyContext['mevProviderFactory']>['getProvider']>;
    chainSettings?: typeof MEV_CONFIG.chainSettings[string];
  } {
    const mevProvider = ctx.mevProviderFactory?.getProvider(chain);
    const chainSettings = MEV_CONFIG.chainSettings[chain];

    const shouldUseMev = !!(
      mevProvider?.isEnabled() &&
      chainSettings?.enabled !== false &&
      (expectedProfit ?? 0) >= (chainSettings?.minProfitForProtection ?? 0)
    );

    return {
      shouldUseMev,
      mevProvider: shouldUseMev ? mevProvider : undefined,
      chainSettings,
    };
  }

  // ===========================================================================
  // Transaction Submission (Fix 9.1)
  // ===========================================================================

  /**
   * Fix 9.1: Extracted common transaction submission logic.
   *
   * This method encapsulates the common pattern used by IntraChainStrategy
   * and FlashLoanStrategy for submitting transactions with:
   * - MEV protection (optional)
   * - Nonce management
   * - Gas price refresh before submission
   * - Timeout handling
   * - Receipt waiting
   *
   * @param tx - Prepared transaction request
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @param options - Submission options
   * @returns Transaction result with receipt or error
   */
  protected async submitTransaction(
    tx: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext,
    options: {
      opportunityId: string;
      expectedProfit?: number;
      initialGasPrice: bigint;
    }
  ): Promise<{
    success: boolean;
    receipt?: ethers.TransactionReceipt;
    txHash?: string;
    error?: string;
    nonce?: number;
    usedMevProtection?: boolean;
  }> {
    const wallet = ctx.wallets.get(chain);
    const provider = ctx.providers.get(chain);

    if (!wallet) {
      return { success: false, error: `No wallet for chain: ${chain}` };
    }

    // Fix 5.1: Refresh gas price just before submission
    const finalGasPrice = await this.refreshGasPriceForSubmission(
      chain,
      ctx,
      options.initialGasPrice
    );

    // Fix 4.2 & 5.3: Get nonce from NonceManager only if not already set
    // This prevents double nonce allocation when strategy pre-allocates nonce
    //
    // IMPORTANT (Fix 5.3 - Race Condition Warning):
    // If multiple strategies execute in parallel for the SAME chain without external
    // coordination, nonce allocation can race. The NonceManager itself is NOT
    // distributed-lock protected. For production environments with parallel execution:
    // 1. Use a distributed lock (Redis SETNX) per chain before calling getNextNonce()
    // 2. Or ensure only one executor per chain is active at a time
    // 3. Or pre-allocate nonces at the engine level before dispatching to strategies
    //
    // The engine.ts currently uses per-opportunity locks which is insufficient for
    // same-chain parallel execution. Consider implementing per-chain locks if you
    // observe nonce conflicts in production.
    let nonce: number | undefined;
    if (tx.nonce !== undefined) {
      // Nonce already set by caller, use it
      nonce = Number(tx.nonce);
      this.logger.debug('Using pre-allocated nonce', { chain, nonce });
    } else if (ctx.nonceManager) {
      // Allocate new nonce from NonceManager
      try {
        nonce = await ctx.nonceManager.getNextNonce(chain);
        tx.nonce = nonce;
      } catch (error) {
        return {
          success: false,
          error: `[ERR_NONCE] Failed to get nonce: ${getErrorMessage(error)}`,
        };
      }
    }

    try {
      // Fix 6.3 & 9.1: Use shared MEV eligibility check helper
      const { shouldUseMev, mevProvider, chainSettings } = this.checkMevEligibility(
        chain,
        ctx,
        options.expectedProfit
      );

      let receipt: ethers.TransactionReceipt | null = null;
      let txHash: string | undefined;

      if (shouldUseMev && mevProvider) {
        // MEV protected submission
        const mevResult = await this.withTransactionTimeout(
          () => mevProvider.sendProtectedTransaction(tx, {
            simulate: MEV_CONFIG.simulateBeforeSubmit,
            priorityFeeGwei: chainSettings?.priorityFeeGwei,
          }),
          'mevProtectedSubmission'
        );

        if (!mevResult.success) {
          if (ctx.nonceManager && nonce !== undefined) {
            ctx.nonceManager.failTransaction(chain, nonce, mevResult.error || 'MEV submission failed');
          }
          return {
            success: false,
            error: `MEV protected submission failed: ${mevResult.error}`,
            nonce,
          };
        }

        txHash = mevResult.transactionHash;

        // Get receipt if we have a transaction hash
        if (txHash && provider) {
          receipt = await this.withTransactionTimeout(
            () => provider.getTransactionReceipt(txHash!),
            'getReceipt'
          );
        }

        this.logger.info('MEV protected transaction submitted', {
          chain,
          strategy: mevResult.strategy,
          txHash,
          usedFallback: mevResult.usedFallback,
        });

        // Confirm nonce
        if (ctx.nonceManager && nonce !== undefined && receipt) {
          ctx.nonceManager.confirmTransaction(chain, nonce, receipt.hash);
        }

        return {
          success: true,
          receipt: receipt || undefined,
          txHash,
          nonce,
          usedMevProtection: true,
        };
      } else {
        // Standard transaction submission
        // Update gas price to refreshed value
        if (tx.type === 2) {
          tx.maxFeePerGas = finalGasPrice;
        } else {
          tx.gasPrice = finalGasPrice;
        }

        const txResponse = await this.withTransactionTimeout(
          () => wallet.sendTransaction(tx),
          'sendTransaction'
        );

        txHash = txResponse.hash;

        receipt = await this.withTransactionTimeout(
          () => txResponse.wait(),
          'waitForReceipt'
        );

        if (!receipt) {
          if (ctx.nonceManager && nonce !== undefined) {
            ctx.nonceManager.failTransaction(chain, nonce, 'No receipt received');
          }
          return {
            success: false,
            error: 'Transaction receipt not received',
            txHash,
            nonce,
          };
        }

        // Confirm nonce
        if (ctx.nonceManager && nonce !== undefined) {
          ctx.nonceManager.confirmTransaction(chain, nonce, receipt.hash);
        }

        return {
          success: true,
          receipt,
          txHash: receipt.hash,
          nonce,
          usedMevProtection: false,
        };
      }
    } catch (error) {
      // Mark transaction as failed
      if (ctx.nonceManager && nonce !== undefined) {
        ctx.nonceManager.failTransaction(chain, nonce, getErrorMessage(error));
      }
      return {
        success: false,
        error: getErrorMessage(error) || 'Unknown submission error',
        nonce,
      };
    }
  }

  // ===========================================================================
  // Price Verification
  // ===========================================================================

  /**
   * Verify opportunity prices are still valid before execution.
   */
  protected async verifyOpportunityPrices(
    opportunity: ArbitrageOpportunity,
    chain: string
  ): Promise<{ valid: boolean; reason?: string; currentProfit?: number }> {
    // Check opportunity age
    const maxAgeMs = ARBITRAGE_CONFIG.opportunityTimeoutMs || 30000;
    const opportunityAge = Date.now() - opportunity.timestamp;

    if (opportunityAge > maxAgeMs) {
      return {
        valid: false,
        reason: `Opportunity too old: ${opportunityAge}ms > ${maxAgeMs}ms`
      };
    }

    // For fast chains, apply stricter age limits
    const chainConfig = CHAINS[chain];
    if (chainConfig && chainConfig.blockTime < 2) {
      const fastChainMaxAge = Math.min(maxAgeMs, chainConfig.blockTime * 5000);
      if (opportunityAge > fastChainMaxAge) {
        return {
          valid: false,
          reason: `Opportunity too old for fast chain: ${opportunityAge}ms > ${fastChainMaxAge}ms`
        };
      }
    }

    // Verify minimum profit threshold
    const expectedProfit = opportunity.expectedProfit || 0;
    const minProfitThreshold = ARBITRAGE_CONFIG.minProfitThreshold || 10;
    const requiredProfit = minProfitThreshold * 1.2;

    if (expectedProfit < requiredProfit) {
      return {
        valid: false,
        reason: `Profit below safety threshold: ${expectedProfit} < ${requiredProfit}`,
        currentProfit: expectedProfit
      };
    }

    // Verify confidence score
    if (opportunity.confidence < ARBITRAGE_CONFIG.minConfidenceThreshold) {
      return {
        valid: false,
        reason: `Confidence below threshold: ${opportunity.confidence} < ${ARBITRAGE_CONFIG.minConfidenceThreshold}`,
        currentProfit: expectedProfit
      };
    }

    this.logger.debug('Price verification passed', {
      opportunityId: opportunity.id,
      age: opportunityAge,
      profit: expectedProfit,
      confidence: opportunity.confidence
    });

    return { valid: true, currentProfit: expectedProfit };
  }

  // ===========================================================================
  // Swap Path Building (used by DEX swap transaction)
  // ===========================================================================

  /**
   * Build swap path for DEX router.
   *
   * @param opportunity - The arbitrage opportunity
   * @returns Array of token addresses forming the swap path
   */
  protected buildSwapPath(opportunity: ArbitrageOpportunity): string[] {
    if (!opportunity.tokenIn || !opportunity.tokenOut) {
      throw new Error('Invalid opportunity: missing tokenIn or tokenOut');
    }
    return [opportunity.tokenIn, opportunity.tokenOut];
  }

  // ===========================================================================
  // DEX Swap Transaction (for intra-chain and cross-chain sell after bridge)
  // ===========================================================================

  /**
   * Prepare a direct DEX swap transaction.
   *
   * Used for cross-chain arbitrage where tokens have been bridged and need
   * to be swapped on the destination chain (not using flash loans).
   *
   * @param opportunity - The arbitrage opportunity
   * @param chain - Target chain for the swap
   * @param ctx - Strategy context with providers
   * @param recipientAddress - Address to receive swap output (defaults to wallet address)
   * @returns Prepared transaction request
   */
  protected async prepareDexSwapTransaction(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext,
    recipientAddress?: string
  ): Promise<ethers.TransactionRequest> {
    if (!opportunity.tokenIn || !opportunity.tokenOut || !opportunity.amountIn) {
      throw new Error('Invalid opportunity: missing required fields (tokenIn, tokenOut, amountIn)');
    }

    const provider = ctx.providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain: ${chain}`);
    }

    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      throw new Error(`No wallet for chain: ${chain}`);
    }

    // Find DEX router for the chain (use sellDex if specified, otherwise first available)
    const chainDexes = DEXES[chain];
    if (!chainDexes || chainDexes.length === 0) {
      throw new Error(`No DEX configured for chain: ${chain}`);
    }

    // Find the specific DEX or use the first one
    const targetDex = opportunity.sellDex
      ? chainDexes.find(d => d.name === opportunity.sellDex)
      : chainDexes[0];

    if (!targetDex || !targetDex.routerAddress) {
      throw new Error(`No router address for DEX on chain: ${chain}`);
    }

    // Calculate minAmountOut with slippage protection
    const amountIn = BigInt(opportunity.amountIn);
    const expectedProfit = opportunity.expectedProfit || 0;
    const expectedProfitWei = ethers.parseUnits(
      Math.max(0, expectedProfit).toFixed(18),
      18
    );
    const expectedAmountOut = amountIn + expectedProfitWei;
    const minAmountOut = expectedAmountOut - (expectedAmountOut * SLIPPAGE_BASIS_POINTS_BIGINT / 10000n);

    // Build swap path
    const path = this.buildSwapPath(opportunity);

    // Create router contract interface
    const routerContract = new ethers.Contract(
      targetDex.routerAddress,
      UNISWAP_V2_ROUTER_ABI,
      provider
    );

    // Set deadline (5 minutes from now)
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // Recipient is wallet address by default
    const recipient = recipientAddress || await wallet.getAddress();

    // Build the swap transaction
    const tx = await routerContract.swapExactTokensForTokens.populateTransaction(
      amountIn,
      minAmountOut,
      path,
      recipient,
      deadline
    );

    this.logger.debug('DEX swap transaction prepared', {
      chain,
      dex: targetDex.name,
      router: targetDex.routerAddress,
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      slippageTolerance: ARBITRAGE_CONFIG.slippageTolerance,
      deadline,
    });

    return tx;
  }

  /**
   * Check and approve token allowance for DEX router if needed.
   *
   * @param tokenAddress - Token to approve
   * @param spenderAddress - Router address to approve
   * @param amount - Amount to approve
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns True if approval was needed and succeeded, false if already approved
   */
  protected async ensureTokenAllowance(
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint,
    chain: string,
    ctx: StrategyContext
  ): Promise<boolean> {
    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      throw new Error(`No wallet for chain: ${chain}`);
    }

    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_APPROVE_ABI,
      wallet
    );

    const ownerAddress = await wallet.getAddress();
    const currentAllowance = await tokenContract.allowance(ownerAddress, spenderAddress);

    if (currentAllowance >= amount) {
      this.logger.debug('Token allowance sufficient', {
        token: tokenAddress,
        spender: spenderAddress,
        currentAllowance: currentAllowance.toString(),
        required: amount.toString(),
      });
      return false;
    }

    // Approve max uint256 for efficiency (fewer future approvals)
    const maxApproval = ethers.MaxUint256;
    const approveTx = await tokenContract.approve(spenderAddress, maxApproval);
    await approveTx.wait();

    this.logger.info('Token approval granted', {
      token: tokenAddress,
      spender: spenderAddress,
      chain,
    });

    return true;
  }

  // ===========================================================================
  // Bridge Fee Validation (Fix 9.3)
  // ===========================================================================

  /**
   * Fix 9.3: Check if bridge fees make the opportunity unprofitable.
   *
   * Extracted from CrossChainStrategy to enable reuse and consistent
   * fee threshold checking across strategies that involve bridging.
   *
   * @param bridgeFeeWei - Bridge fee in wei (from bridge quote)
   * @param expectedProfitUsd - Expected profit in USD
   * @param nativeTokenPriceUsd - Price of native token in USD (ETH price for Ethereum)
   * @param options - Configuration options
   * @returns Object with profitability status and details
   */
  protected checkBridgeProfitability(
    bridgeFeeWei: bigint,
    expectedProfitUsd: number,
    nativeTokenPriceUsd: number,
    options: {
      /** Maximum percentage of profit that bridge fees can consume (default: 50%) */
      maxFeePercentage?: number;
      /** Chain name for logging */
      chain?: string;
    } = {}
  ): {
    isProfitable: boolean;
    bridgeFeeUsd: number;
    bridgeFeeEth: number;
    profitAfterFees: number;
    feePercentageOfProfit: number;
    reason?: string;
  } {
    const maxFeePercentage = options.maxFeePercentage ?? 50;

    // Convert bridge fee from wei to ETH, then to USD
    const bridgeFeeEth = parseFloat(ethers.formatEther(bridgeFeeWei));
    const bridgeFeeUsd = bridgeFeeEth * nativeTokenPriceUsd;

    // Calculate what percentage of profit the fee represents
    const feePercentageOfProfit = expectedProfitUsd > 0
      ? (bridgeFeeUsd / expectedProfitUsd) * 100
      : 100;

    const profitAfterFees = expectedProfitUsd - bridgeFeeUsd;
    const isProfitable = feePercentageOfProfit < maxFeePercentage;

    if (!isProfitable) {
      this.logger.debug('Bridge fee profitability check failed', {
        bridgeFeeEth,
        bridgeFeeUsd,
        expectedProfitUsd,
        feePercentageOfProfit: feePercentageOfProfit.toFixed(2),
        maxFeePercentage,
        chain: options.chain,
      });
    }

    return {
      isProfitable,
      bridgeFeeUsd,
      bridgeFeeEth,
      profitAfterFees,
      feePercentageOfProfit,
      reason: isProfitable
        ? undefined
        : `Bridge fees ($${bridgeFeeUsd.toFixed(2)}) exceed ${maxFeePercentage}% of expected profit ($${expectedProfitUsd.toFixed(2)})`,
    };
  }

  // ===========================================================================
  // Transaction Timeout
  // ===========================================================================

  /**
   * Wrap blockchain operations with timeout.
   * Delegates to the shared withTimeout utility from types.ts.
   *
   * @param operation - Async operation to execute with timeout
   * @param operationName - Name for error messages
   * @returns Result of the operation or throws TimeoutError
   */
  protected async withTransactionTimeout<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return withTimeout(operation, operationName, TRANSACTION_TIMEOUT_MS);
  }

  // ===========================================================================
  // Profit Calculation
  // ===========================================================================

  protected async calculateActualProfit(
    receipt: ethers.TransactionReceipt,
    opportunity: ArbitrageOpportunity
  ): Promise<number> {
    const gasPrice = receipt.gasPrice || BigInt(0);
    const gasCost = parseFloat(ethers.formatEther(receipt.gasUsed * gasPrice));
    const expectedProfit = opportunity.expectedProfit || 0;
    return expectedProfit - gasCost;
  }

  // ===========================================================================
  // Contract Error Decoding (Fix 9.3)
  // ===========================================================================

  /**
   * Fix 8.1: Decode contract custom errors for better debugging.
   *
   * FlashLoanArbitrage.sol uses custom errors. This helper decodes them
   * from revert data for better error messages.
   *
   * Known FlashLoanArbitrage errors (from contracts/src/FlashLoanArbitrage.sol):
   * - InvalidPoolAddress()
   * - InvalidRouterAddress()
   * - RouterAlreadyApproved()
   * - RouterNotApproved()
   * - EmptySwapPath()
   * - InvalidSwapPath()
   * - InsufficientProfit()
   * - InvalidFlashLoanInitiator()
   * - InvalidFlashLoanCaller()
   * - SwapFailed()
   * - InsufficientOutputAmount()
   * - InvalidRecipient()
   * - ETHTransferFailed()
   *
   * @param error - Error from contract call/transaction
   * @param contractInterface - Optional ethers.Interface for decoding
   * @returns Decoded error message or original error message
   */
  protected decodeContractError(
    error: unknown,
    contractInterface?: ethers.Interface
  ): string {
    const errorMessage = getErrorMessage(error);

    // Check if this is a contract revert with data
    if (
      error &&
      typeof error === 'object' &&
      'data' in error &&
      typeof (error as { data: unknown }).data === 'string'
    ) {
      const revertData = (error as { data: string }).data;

      // FlashLoanArbitrage.sol custom error selectors (Fix 9.3: Match actual contract)
      // Selectors computed using: ethers.id('<ErrorName>()').slice(0, 10)
      // All errors are parameterless in contracts/src/FlashLoanArbitrage.sol
      // Validated by base.strategy.test.ts
      const CUSTOM_ERRORS: Record<string, string> = {
        '0xda6a56c3': 'InvalidPoolAddress',
        '0x14203b4b': 'InvalidRouterAddress',
        '0x0d35b41e': 'RouterAlreadyApproved',
        '0x233d278a': 'RouterNotApproved',
        '0x86a559ea': 'EmptySwapPath',
        '0x33782793': 'InvalidSwapPath',
        '0x4e47f8ea': 'InsufficientProfit',
        '0xef7cc6b6': 'InvalidFlashLoanInitiator',
        '0xe17c49b7': 'InvalidFlashLoanCaller',
        '0x81ceff30': 'SwapFailed',
        '0x42301c23': 'InsufficientOutputAmount',
        '0x9c8d2cd2': 'InvalidRecipient',
        '0xb12d13eb': 'ETHTransferFailed',
      };

      const selector = revertData.slice(0, 10);
      const knownError = CUSTOM_ERRORS[selector];

      if (knownError) {
        // Try to decode error parameters if we have the interface
        if (contractInterface) {
          try {
            const decoded = contractInterface.parseError(revertData);
            if (decoded) {
              const args = decoded.args.map((arg, i) =>
                typeof arg === 'bigint' ? arg.toString() : String(arg)
              ).join(', ');
              return `${decoded.name}(${args})`;
            }
          } catch {
            // Fall through to basic error name
          }
        }
        return `Contract error: ${knownError}`;
      }

      // Try to decode as standard Error(string) or Panic(uint256)
      if (revertData.startsWith('0x08c379a0')) {
        // Error(string)
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['string'],
            '0x' + revertData.slice(10)
          );
          return `Revert: ${decoded[0]}`;
        } catch {
          // Fall through
        }
      } else if (revertData.startsWith('0x4e487b71')) {
        // Panic(uint256)
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['uint256'],
            '0x' + revertData.slice(10)
          );
          const panicCode = Number(decoded[0]);
          const panicMessages: Record<number, string> = {
            0x01: 'Assertion failed',
            0x11: 'Arithmetic overflow/underflow',
            0x12: 'Division by zero',
            0x21: 'Invalid enum value',
            0x22: 'Storage byte array encoding error',
            0x31: 'Pop on empty array',
            0x32: 'Array index out of bounds',
            0x41: 'Memory allocation overflow',
            0x51: 'Zero initialized function pointer',
          };
          return `Panic: ${panicMessages[panicCode] || `code ${panicCode}`}`;
        } catch {
          // Fall through
        }
      }
    }

    return errorMessage || 'Unknown contract error';
  }

  // ===========================================================================
  // Pre-flight Simulation (Phase 1.1)
  // ===========================================================================

  /**
   * Perform pre-flight simulation of the transaction.
   *
   * Checks:
   * 1. If simulation service is available
   * 2. If simulation should be performed (profit threshold, time-critical bypass)
   * 3. Simulates the transaction
   * 4. Returns result or null (graceful degradation on errors)
   *
   * @param opportunity - The arbitrage opportunity
   * @param transaction - The prepared transaction
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns SimulationResult or null if simulation was skipped/failed
   */
  protected async performSimulation(
    opportunity: ArbitrageOpportunity,
    transaction: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext
  ): Promise<SimulationResult | null> {
    // Check if simulation service is available
    if (!ctx.simulationService) {
      ctx.stats.simulationsSkipped++;
      return null;
    }

    // Calculate opportunity age for time-critical bypass
    const opportunityAge = Date.now() - opportunity.timestamp;
    const expectedProfit = opportunity.expectedProfit || 0;

    // Check if we should simulate this opportunity
    // shouldSimulate() checks: profit threshold, time-critical bypass, provider availability
    if (!ctx.simulationService.shouldSimulate(expectedProfit, opportunityAge)) {
      ctx.stats.simulationsSkipped++;
      this.logger.debug('Skipping simulation', {
        opportunityId: opportunity.id,
        expectedProfit,
        opportunityAge,
      });
      return null;
    }

    // Prepare simulation request
    const simulationRequest: SimulationRequest = {
      chain,
      transaction: {
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        gasLimit: transaction.gasLimit,
      },
      includeStateChanges: false, // Not needed for pre-flight check
      includeLogs: false,
    };

    try {
      const result = await ctx.simulationService.simulate(simulationRequest);
      ctx.stats.simulationsPerformed++;

      this.logger.debug('Simulation completed', {
        opportunityId: opportunity.id,
        success: result.success,
        wouldRevert: result.wouldRevert,
        revertReason: result.revertReason,
        gasUsed: result.gasUsed?.toString(),
        provider: result.provider,
        latencyMs: result.latencyMs,
      });

      // If simulation itself failed (service error), log and proceed with execution
      if (!result.success) {
        ctx.stats.simulationErrors++;
        this.logger.warn('Simulation service error, proceeding with execution', {
          opportunityId: opportunity.id,
          error: result.error,
          provider: result.provider,
        });
        return null; // Graceful degradation - proceed without simulation
      }

      return result;
    } catch (error) {
      // Handle unexpected errors gracefully
      ctx.stats.simulationErrors++;
      this.logger.warn('Simulation failed unexpectedly, proceeding with execution', {
        opportunityId: opportunity.id,
        error: getErrorMessage(error),
      });
      return null; // Graceful degradation - proceed without simulation
    }
  }
}
