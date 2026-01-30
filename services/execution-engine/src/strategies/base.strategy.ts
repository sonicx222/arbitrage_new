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
 * Issue 3.3 Fix: Configurable swap deadline in seconds.
 * This is the duration after which a swap transaction will revert if not mined.
 *
 * Default: 300 seconds (5 minutes)
 * Configurable via: SWAP_DEADLINE_SECONDS environment variable
 *
 * Considerations:
 * - Too short: Risk of failed transactions during network congestion
 * - Too long: Risk of executing stale prices
 * - 5 minutes is a reasonable balance for most chains
 *
 * @see prepareDexSwapTransaction where this is used
 */
const SWAP_DEADLINE_SECONDS = parseInt(process.env.SWAP_DEADLINE_SECONDS || '300', 10);

// Validate the deadline is reasonable (30 seconds to 30 minutes)
if (Number.isNaN(SWAP_DEADLINE_SECONDS) || SWAP_DEADLINE_SECONDS < 30 || SWAP_DEADLINE_SECONDS > 1800) {
  getModuleLogger().warn('Invalid SWAP_DEADLINE_SECONDS, using default 300', {
    configured: process.env.SWAP_DEADLINE_SECONDS,
    using: 300,
  });
}
const VALIDATED_SWAP_DEADLINE_SECONDS = Number.isNaN(SWAP_DEADLINE_SECONDS) || SWAP_DEADLINE_SECONDS < 30 || SWAP_DEADLINE_SECONDS > 1800
  ? 300
  : SWAP_DEADLINE_SECONDS;

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
/**
 * Issue 3.2 Fix: Updated default gas prices to more realistic values.
 * Previous Polygon/Fantom defaults of 100 gwei were too high (typical is 30-50 gwei).
 *
 * Current typical gas prices (as of Jan 2026):
 * - Ethereum: 30-100 gwei (volatile)
 * - Polygon: 30-50 gwei
 * - BSC: 3-5 gwei
 * - Avalanche: 25-50 gwei
 * - Fantom: 20-50 gwei (post-Andre era, lower activity)
 * - L2s (Arbitrum, Optimism, Base): Sub-gwei typically
 *
 * Fix 3.2 STALENESS WARNING:
 * ===========================
 * These defaults are fallbacks when RPC fails. They should be reviewed quarterly.
 * Gas market conditions change over time. Monitor actual gas prices via:
 * - Ethereum: https://etherscan.io/gastracker
 * - L2Beat for L2s: https://l2beat.com
 *
 * Last review: Jan 2026
 * Next review: Apr 2026
 *
 * If defaults seem wrong, override via environment variables:
 * GAS_PRICE_<CHAIN>_GWEI (e.g., GAS_PRICE_ETHEREUM_GWEI=40)
 */
const DEFAULT_GAS_PRICES_GWEI: Record<string, number> = {
  ethereum: validateGasPrice('ethereum', parseFloat(process.env.GAS_PRICE_ETHEREUM_GWEI || '50')),
  arbitrum: validateGasPrice('arbitrum', parseFloat(process.env.GAS_PRICE_ARBITRUM_GWEI || '0.1')),
  optimism: validateGasPrice('optimism', parseFloat(process.env.GAS_PRICE_OPTIMISM_GWEI || '0.001')),
  base: validateGasPrice('base', parseFloat(process.env.GAS_PRICE_BASE_GWEI || '0.001')),
  polygon: validateGasPrice('polygon', parseFloat(process.env.GAS_PRICE_POLYGON_GWEI || '35')),  // Issue 3.2: 100 -> 35 gwei
  bsc: validateGasPrice('bsc', parseFloat(process.env.GAS_PRICE_BSC_GWEI || '3')),              // Issue 3.2: 5 -> 3 gwei
  avalanche: validateGasPrice('avalanche', parseFloat(process.env.GAS_PRICE_AVALANCHE_GWEI || '25')),
  fantom: validateGasPrice('fantom', parseFloat(process.env.GAS_PRICE_FANTOM_GWEI || '35')),    // Issue 3.2: 100 -> 35 gwei
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

/**
 * Refactor 9.5: Pre-computed DEX lookup by chain and name for O(1) access.
 *
 * The original DEXES config is structured as Record<chain, Dex[]>, requiring
 * Array.find() for each DEX lookup (O(n) per lookup).
 *
 * This pre-computed map provides O(1) lookup by name within a chain.
 * Structure: Map<chain, Map<dexName (lowercase), Dex>>
 *
 * Performance impact:
 * - Before: O(n) linear search on every prepareDexSwapTransaction call
 * - After: O(1) Map lookup
 * - Memory: ~2KB additional (49 DEXes across 11 chains)
 *
 * Note: DEX names are normalized to lowercase for case-insensitive matching.
 */
const DEXES_BY_CHAIN_AND_NAME: Map<string, Map<string, typeof DEXES[string][number]>> = new Map(
  Object.entries(DEXES).map(([chain, dexes]) => [
    chain,
    new Map(dexes.map(dex => [dex.name.toLowerCase(), dex]))
  ])
);

/**
 * Refactor 9.5: O(1) DEX lookup by chain and name.
 *
 * @param chain - Chain identifier
 * @param dexName - DEX name (case-insensitive)
 * @returns DEX config or undefined if not found
 */
function getDexByName(chain: string, dexName: string): typeof DEXES[string][number] | undefined {
  return DEXES_BY_CHAIN_AND_NAME.get(chain)?.get(dexName.toLowerCase());
}

/**
 * Refactor 9.5: Get first DEX for a chain (fallback when no specific DEX requested).
 *
 * @param chain - Chain identifier
 * @returns First DEX config or undefined if chain not configured
 */
function getFirstDex(chain: string): typeof DEXES[string][number] | undefined {
  return DEXES[chain]?.[0];
}

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

/**
 * Fix 3.1: Validate gas price configuration at startup.
 *
 * Call this from engine initialization to log a summary of gas price configuration
 * and warn if any values fell back to minimum (which may indicate misconfiguration).
 *
 * @param logger - Logger instance for output
 * @returns Validation result with warnings
 *
 * @example
 * const result = validateGasPriceConfiguration(logger);
 * if (!result.valid) {
 *   logger.warn('Gas configuration issues detected', { warnings: result.warnings });
 * }
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
 * Doc 2.1: Gas Spike Detection Thresholds
 * ========================================
 * The system uses two gas price thresholds to protect against unprofitable trades:
 *
 * 1. **Initial Fetch (getOptimalGasPrice)**:
 *    - Compares current price against median baseline
 *    - Threshold: gasPriceSpikeMultiplier (default 1.5x = 150%)
 *    - Action: Throws Error, aborting the trade
 *    - Configurable via: ARBITRAGE_CONFIG.gasPriceSpikeMultiplier
 *
 * 2. **Pre-Submission Refresh (refreshGasPriceForSubmission)**:
 *    - Compares current price against the initial fetch price
 *    - Warning threshold: >20% increase (logs warning, continues)
 *    - Abort threshold: >50% increase (throws Error, aborts trade)
 *    - These thresholds are hardcoded as they represent safe operational bounds
 *
 * **Example Scenario**:
 * - Median baseline: 50 gwei
 * - Initial fetch: 60 gwei (within 1.5x baseline, proceeds)
 * - Pre-submission: 72 gwei (20% increase, warns but continues)
 * - Pre-submission: 95 gwei (>50% increase, would abort)
 *
 * **Rationale for 50% abort threshold**:
 * If gas price increases >50% between opportunity detection and submission,
 * the profit calculation is likely invalid. This prevents executing trades
 * that become unprofitable due to gas cost changes during preparation.
 *
 * GAS_SPIKE_MULTIPLIER_BIGINT: Used for initial spike detection (e.g., 1.5x = 150)
 * SLIPPAGE_BASIS_POINTS_BIGINT: Slippage tolerance in basis points (e.g., 0.5% = 50)
 * WEI_PER_GWEI: 10^9, pre-computed for wei-to-gwei conversions (Finding 10.2 fix)
 *               Fix 2.2: Renamed from WEI_PER_GWEI for clarity - this is wei per gwei, not a divisor
 */
const GAS_SPIKE_MULTIPLIER_BIGINT = BigInt(Math.floor(ARBITRAGE_CONFIG.gasPriceSpikeMultiplier * 100));
const SLIPPAGE_BASIS_POINTS_BIGINT = BigInt(Math.floor(ARBITRAGE_CONFIG.slippageTolerance * 10000));
const WEI_PER_GWEI = BigInt(1e9);

/**
 * Fix 5.1: Track in-progress nonce allocations per chain.
 * Used to detect potential race conditions when multiple strategies
 * attempt to allocate nonces for the same chain concurrently.
 *
 * Key: chain name
 * Value: Set of opportunity IDs currently allocating nonces
 */
const IN_PROGRESS_NONCE_ALLOCATIONS = new Map<string, Set<string>>();

/**
 * Fix 3.1: Per-chain nonce locks to prevent concurrent nonce allocation.
 *
 * Problem: Multiple strategies executing in parallel for the SAME chain could
 * allocate the same nonce, causing transaction failures and wasted gas.
 *
 * Solution: Simple mutex per chain using Promise-based locking.
 * When acquiring a lock, if another operation holds it, we wait for its release.
 *
 * Key: chain name
 * Value: Promise that resolves when the current lock holder releases
 */
const CHAIN_NONCE_LOCKS = new Map<string, Promise<void>>();
const CHAIN_NONCE_LOCK_RESOLVERS = new Map<string, () => void>();

/**
 * Fix 3.1: Acquire per-chain nonce lock.
 *
 * This ensures only one nonce allocation happens at a time per chain,
 * preventing the race condition in Issue #156.
 *
 * @param chain - Chain to acquire lock for
 * @param opportunityId - ID for logging
 * @param logger - Logger instance
 * @param timeoutMs - Max time to wait for lock (default 10s)
 * @returns Promise that resolves when lock is acquired
 * @throws Error if timeout waiting for lock
 */
async function acquireChainNonceLock(
  chain: string,
  opportunityId: string,
  logger: Logger,
  timeoutMs = 10000
): Promise<void> {
  const existingLock = CHAIN_NONCE_LOCKS.get(chain);

  if (existingLock) {
    logger.debug('[NONCE_LOCK] Waiting for existing lock', {
      chain,
      opportunityId,
    });

    // Wait for existing lock with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`[ERR_NONCE_LOCK_TIMEOUT] Timeout waiting for nonce lock on ${chain}`)), timeoutMs);
    });

    try {
      await Promise.race([existingLock, timeoutPromise]);
    } catch (error) {
      // If timeout, log and throw
      logger.warn('[WARN_NONCE_LOCK_TIMEOUT] Timeout waiting for nonce lock', {
        chain,
        opportunityId,
        timeoutMs,
      });
      throw error;
    }
  }

  // Create new lock
  let resolver: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    resolver = resolve;
  });

  CHAIN_NONCE_LOCKS.set(chain, lockPromise);
  CHAIN_NONCE_LOCK_RESOLVERS.set(chain, resolver!);

  logger.debug('[NONCE_LOCK] Lock acquired', {
    chain,
    opportunityId,
  });
}

/**
 * Fix 3.1: Release per-chain nonce lock.
 *
 * @param chain - Chain to release lock for
 * @param opportunityId - ID for logging
 * @param logger - Logger instance
 */
function releaseChainNonceLock(
  chain: string,
  opportunityId: string,
  logger: Logger
): void {
  const resolver = CHAIN_NONCE_LOCK_RESOLVERS.get(chain);
  if (resolver) {
    resolver();
    CHAIN_NONCE_LOCKS.delete(chain);
    CHAIN_NONCE_LOCK_RESOLVERS.delete(chain);

    logger.debug('[NONCE_LOCK] Lock released', {
      chain,
      opportunityId,
    });
  }
}

/**
 * Fix 5.1: Check and warn if concurrent nonce access is detected.
 * Now deprecated in favor of acquireChainNonceLock (Fix 3.1), but kept
 * for backward compatibility and additional logging.
 *
 * @param chain - Chain being accessed
 * @param opportunityId - ID of the opportunity requesting nonce
 * @param logger - Logger for warning output
 * @returns true if concurrency was detected
 */
function checkConcurrentNonceAccess(
  chain: string,
  opportunityId: string,
  logger: Logger
): boolean {
  let inProgress = IN_PROGRESS_NONCE_ALLOCATIONS.get(chain);
  if (!inProgress) {
    inProgress = new Set();
    IN_PROGRESS_NONCE_ALLOCATIONS.set(chain, inProgress);
  }

  const hadConcurrency = inProgress.size > 0;
  if (hadConcurrency) {
    // Fix 3.1: This should now rarely happen due to per-chain locking
    // If it does happen, it indicates a bug in the locking logic
    logger.warn('[WARN_RACE_CONDITION] Concurrent nonce access detected despite locking', {
      chain,
      opportunityId,
      concurrentOpportunities: Array.from(inProgress),
      warning: 'This indicates a potential bug in per-chain nonce locking.',
      tracking: 'https://github.com/arbitrage-system/arbitrage/issues/156',
    });
  }

  inProgress.add(opportunityId);
  return hadConcurrency;
}

/**
 * Fix 5.1: Clear in-progress nonce allocation tracking for an opportunity.
 *
 * @param chain - Chain being accessed
 * @param opportunityId - ID of the opportunity that finished
 */
function clearNonceAllocationTracking(chain: string, opportunityId: string): void {
  const inProgress = IN_PROGRESS_NONCE_ALLOCATIONS.get(chain);
  if (inProgress) {
    inProgress.delete(opportunityId);
    if (inProgress.size === 0) {
      IN_PROGRESS_NONCE_ALLOCATIONS.delete(chain);
    }
  }
}

/**
 * Base class for execution strategies.
 * Provides shared utility methods.
 */
export abstract class BaseExecutionStrategy {
  protected readonly logger: Logger;

  /**
   * Refactor 9.2: Consolidated slippage tolerance in basis points.
   *
   * Single source of truth for slippage calculations across all strategies.
   * Derived from ARBITRAGE_CONFIG.slippageTolerance (e.g., 0.005 = 50 bps = 0.5%)
   *
   * Usage in derived strategies:
   * ```typescript
   * const minAmountOut = expectedAmount - (expectedAmount * this.slippageBps / 10000n);
   * ```
   */
  protected readonly slippageBps: bigint = SLIPPAGE_BASIS_POINTS_BIGINT;

  /**
   * Refactor 9.2: Basis points denominator (10000 = 100%)
   * Use with slippageBps: `amount * slippageBps / BPS_DENOMINATOR`
   */
  protected readonly BPS_DENOMINATOR = 10000n;

  /**
   * Fix 10.1: Router contract cache for hot-path optimization.
   * Avoids creating new Contract instances for every transaction.
   * Key: `${chain}:${routerAddress}`
   * Value: ethers.Contract instance
   */
  private readonly routerContractCache = new Map<string, ethers.Contract>();

  /**
   * Fix 10.1: Maximum number of cached router contracts.
   * Prevents unbounded memory growth in case of many chains/routers.
   */
  private readonly MAX_ROUTER_CACHE_SIZE = 50;

  /**
   * Perf 10.2: Wallet address cache for hot-path optimization.
   * Avoids calling async wallet.getAddress() multiple times per execution.
   * Key: wallet object identity (using WeakMap for memory-safe caching)
   */
  private readonly walletAddressCache = new WeakMap<ethers.Wallet, string>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ===========================================================================
  // Perf 10.2: Wallet Address Caching
  // ===========================================================================

  /**
   * Perf 10.2: Get wallet address with caching.
   *
   * wallet.getAddress() is async and may involve cryptographic operations.
   * This method caches the result to avoid repeated calls during a single
   * execution flow.
   *
   * @param wallet - Wallet to get address from
   * @returns Wallet address (checksummed)
   */
  protected async getWalletAddress(wallet: ethers.Wallet): Promise<string> {
    // Check cache first
    const cached = this.walletAddressCache.get(wallet);
    if (cached) {
      return cached;
    }

    // Fetch and cache
    const address = await wallet.getAddress();
    this.walletAddressCache.set(wallet, address);
    return address;
  }

  /**
   * Fix 10.1: Get or create a cached router contract instance.
   * This avoids creating new Contract instances on every transaction,
   * reducing GC pressure and allocation overhead on the hot path.
   *
   * @param routerAddress - DEX router address
   * @param provider - JSON-RPC provider for the chain
   * @param chain - Chain identifier (for cache key)
   * @returns Cached or newly created Contract instance
   */
  protected getRouterContract(
    routerAddress: string,
    provider: ethers.JsonRpcProvider,
    chain: string
  ): ethers.Contract {
    const cacheKey = `${chain}:${routerAddress}`;
    let router = this.routerContractCache.get(cacheKey);

    if (!router) {
      // Evict oldest entries if cache is full
      if (this.routerContractCache.size >= this.MAX_ROUTER_CACHE_SIZE) {
        const firstKey = this.routerContractCache.keys().next().value;
        if (firstKey) {
          this.routerContractCache.delete(firstKey);
        }
      }

      router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
      this.routerContractCache.set(cacheKey, router);

      this.logger.debug('Router contract cached', { chain, routerAddress });
    }

    return router;
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

  /**
   * Race 5.4 Fix: Check provider health before critical operations.
   *
   * This performs a lightweight health check to detect disconnected providers
   * before attempting transaction submission. Without this check, transactions
   * could fail with confusing errors if the provider disconnects between
   * getOptimalGasPrice and sendTransaction.
   *
   * @param provider - Provider to check
   * @param chain - Chain identifier for logging
   * @param ctx - Strategy context to update health metrics
   * @returns true if provider is healthy, false otherwise
   */
  protected async isProviderHealthy(
    provider: ethers.JsonRpcProvider,
    chain: string,
    ctx: StrategyContext
  ): Promise<boolean> {
    try {
      // Quick health check - getNetwork() is faster than getBlockNumber()
      // and still verifies the provider is connected
      await Promise.race([
        provider.getNetwork(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Provider health check timeout')), 3000)
        ),
      ]);
      return true;
    } catch (error) {
      const providerHealth = ctx.providerHealth.get(chain);
      if (providerHealth) {
        providerHealth.healthy = false;
        providerHealth.lastError = getErrorMessage(error);
        providerHealth.lastCheck = Date.now();
        providerHealth.consecutiveFailures++;
      }
      ctx.stats.providerHealthCheckFailures++;

      this.logger.warn('[WARN_PROVIDER_UNHEALTHY] Provider health check failed before transaction', {
        chain,
        error: getErrorMessage(error),
      });
      return false;
    }
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
            // Finding 10.2 Fix: Use pre-computed WEI_PER_GWEI to avoid BigInt creation in hot path
            const currentGwei = Number(currentPrice / WEI_PER_GWEI);
            const baselineGwei = Number(baselinePrice / WEI_PER_GWEI);
            const maxGwei = Number(maxAllowedPrice / WEI_PER_GWEI);

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
        fallbackGwei: Number(fallbackPrice / WEI_PER_GWEI),
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
      if (getErrorMessage(error)?.includes('[ERR_GAS_SPIKE]')) {
        throw error;
      }
      // On other failures, use the previous price - don't block transaction
      return previousGasPrice;
    }
  }

  // Cached median for performance optimization
  private medianCache: Map<string, { median: bigint; validUntil: number }> = new Map();
  /**
   * Fix 8.5: Chain-specific median cache TTL based on block time.
   * Fast chains (L2s with <2s blocks) use shorter TTL for fresher gas data.
   * Default: 5000ms for L1 chains, 2000ms for fast L2s.
   */
  private readonly DEFAULT_MEDIAN_CACHE_TTL_MS = 5000;
  private readonly FAST_CHAIN_MEDIAN_CACHE_TTL_MS = 2000;
  private readonly FAST_CHAINS = new Set(['arbitrum', 'optimism', 'base', 'zksync', 'linea']);
  private readonly MAX_GAS_HISTORY = 100;
  private readonly MAX_MEDIAN_CACHE_SIZE = 50; // Cap cache size to prevent unbounded growth
  private lastMedianCacheCleanup = 0;
  private readonly MEDIAN_CACHE_CLEANUP_INTERVAL_MS = 60000; // Cleanup expired entries every 60s

  /**
   * Fix 8.5: Get chain-specific median cache TTL.
   * Fast chains use shorter TTL to ensure fresher gas price data.
   */
  private getMedianCacheTTL(chain: string): number {
    return this.FAST_CHAINS.has(chain)
      ? this.FAST_CHAIN_MEDIAN_CACHE_TTL_MS
      : this.DEFAULT_MEDIAN_CACHE_TTL_MS;
  }

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

    // FIX 10.1 & 1.2: Update pre-computed last gas price for O(1) hot path access
    // Safety check ensures lastGasPrices is initialized (Fix 1.2)
    if (ctx.lastGasPrices) {
      ctx.lastGasPrices.set(chain, price);
    }

    // Fix 5.2: Use simple delete instead of atomic-style invalidation
    // In Node.js single-threaded event loop, there's no race between invalidation
    // and recomputation. The previous "atomic-style" pattern (setting validUntil = 0)
    // added unnecessary complexity for no benefit in this runtime model.
    this.medianCache.delete(chain);

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
   * Caches result with chain-specific TTL (Fix 8.5).
   *
   * Fix 2.3: Improved handling of sparse history (<3 samples).
   * Problem: With only 1 sample, if that sample was unusually low (e.g., first block
   * after service restart during low activity), normal gas prices would trigger spike
   * detection. The previous 1.5x multiplier was insufficient protection.
   *
   * Solution: Use a graduated safety multiplier based on sample count:
   * - 1 sample: 2.5x multiplier (very conservative - we know almost nothing)
   * - 2 samples: 2.0x multiplier (slightly more confident)
   * - 3+ samples: Use median (reliable baseline)
   *
   * This ensures that early trades after service startup don't get false-positive
   * spike rejections, while still providing spike protection once we have enough data.
   */
  protected getGasBaseline(chain: string, ctx: StrategyContext): bigint {
    const history = ctx.gasBaselines.get(chain);
    if (!history || history.length === 0) {
      return 0n;
    }

    // Fix 2.3: With fewer than 3 samples, use graduated safety multipliers
    // to avoid false-positive spike detection on startup
    if (history.length < 3) {
      const sum = history.reduce((acc, h) => acc + h.price, 0n);
      const avg = sum / BigInt(history.length);

      // Graduated multiplier: more conservative with fewer samples
      // 1 sample: 2.5x (we know very little, be very permissive)
      // 2 samples: 2.0x (slightly more data, can be slightly stricter)
      const multiplier = history.length === 1 ? 5n : 4n; // 5/2 = 2.5x, 4/2 = 2.0x
      return avg * multiplier / 2n;
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

    // Fix 8.5: Use chain-specific TTL for cache
    const cacheTTL = this.getMedianCacheTTL(chain);

    // Cache the result
    this.medianCache.set(chain, {
      median,
      validUntil: now + cacheTTL
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

    // Fix Race 5.1: Collect keys to delete first, then delete after iteration
    // While ES6 Maps technically allow deletion during iteration, this pattern
    // is more defensive and clearer in intent
    const expiredKeys: string[] = [];
    for (const [key, value] of this.medianCache) {
      if (now >= value.validUntil) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this.medianCache.delete(key);
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
   *
   * ## Fix 5.2: Thread-Safety Considerations for MEV Provider
   *
   * The ctx.mevProviderFactory is accessed without explicit synchronization because:
   *
   * 1. **Read-Only Access**: This method only reads from mevProviderFactory, it doesn't
   *    modify the factory or its providers.
   *
   * 2. **Provider Immutability**: Once created, MEV providers are stateless for sending
   *    transactions. Each sendProtectedTransaction() call is independent.
   *
   * 3. **JavaScript Single-Threaded**: Node.js runs on a single event loop. While multiple
   *    async operations may be in flight, they don't execute in parallel - they yield at
   *    await points. This means no true concurrent access during a single sync block.
   *
   * **Potential Race**: If mevProviderFactory is reconfigured (e.g., hot reload of
   * MEV settings) during an execution, a strategy might use a stale provider reference.
   *
   * **Mitigation**: MEV reconfiguration is rare (typically requires restart). If live
   * reconfiguration is needed, implement factory versioning or atomic swap patterns.
   *
   * **Risk Level**: Low - MEV config rarely changes at runtime in production.
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
   * Fix 6.2 & 6.3 & 9.1: Check if MEV protection should be used for a transaction.
   *
   * This helper consolidates the MEV eligibility check that was duplicated
   * in FlashLoanStrategy.execute() and submitTransaction().
   *
   * ## MEV Protection Flow by Strategy (Fix 6.2 Documentation)
   *
   * ### IntraChainStrategy (same-chain DEX arbitrage)
   * 1. applyMEVProtection() - Adjusts gas prices for MEV resistance
   * 2. submitTransaction() internally calls checkMevEligibility()
   * 3. If eligible: Uses mevProvider.sendProtectedTransaction() (Flashbots/Protect)
   * 4. If not eligible: Uses wallet.sendTransaction() directly
   *
   * ### FlashLoanStrategy (flash loan arbitrage)
   * 1. applyMEVProtection() - Adjusts gas prices for MEV resistance
   * 2. Calls checkMevEligibility() directly in execute()
   * 3. If eligible: Uses mevProvider.sendProtectedTransaction()
   * 4. If not eligible: Uses wallet.sendTransaction() directly
   * Note: FlashLoanStrategy has its own submission logic (pending Fix 9.3 refactor)
   *
   * ### CrossChainStrategy (cross-chain bridge arbitrage)
   * 1. applyMEVProtection() - Adjusts gas prices for source chain transactions
   * 2. Calls checkMevEligibility() for both source and destination chains
   * 3. MEV protection on SOURCE chain: Protects initial swap
   * 4. Bridge transaction: Not MEV-protected (handled by bridge protocol)
   * 5. MEV protection on DESTINATION chain: Protects final sell
   *
   * ## MEV Protection Criteria
   *
   * MEV protection is used when ALL conditions are met:
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

    // Race 5.4 Fix: Verify provider health before transaction submission
    // This catches provider disconnection between gas price fetch and sendTransaction
    if (provider) {
      const isHealthy = await this.isProviderHealthy(provider, chain, ctx);
      if (!isHealthy) {
        return {
          success: false,
          error: `[ERR_PROVIDER_UNHEALTHY] Provider for ${chain} failed health check before transaction`,
        };
      }
    }

    // Fix 5.1: Refresh gas price just before submission
    const finalGasPrice = await this.refreshGasPriceForSubmission(
      chain,
      ctx,
      options.initialGasPrice
    );

    // Fix 3.1 & 4.2 & 5.3: Get nonce from NonceManager only if not already set
    // This prevents double nonce allocation when strategy pre-allocates nonce
    //
    // Fix 3.1: Per-chain locking now prevents the race condition where multiple
    // strategies could allocate the same nonce. The acquireChainNonceLock() call
    // ensures only one nonce allocation happens at a time per chain.
    //
    // Previous Issue (now resolved by Fix 3.1):
    // Multiple strategies executing in parallel for the SAME chain would race
    // to allocate nonces, causing transaction failures and wasted gas.
    //
    // Tracking: https://github.com/arbitrage-system/arbitrage/issues/156
    let nonce: number | undefined;
    const needsNonceAllocation = tx.nonce === undefined && ctx.nonceManager;

    if (tx.nonce !== undefined) {
      // Nonce already set by caller, use it
      nonce = Number(tx.nonce);
      this.logger.debug('Using pre-allocated nonce', { chain, nonce });
    } else if (ctx.nonceManager) {
      // Fix 3.1: Acquire per-chain lock before nonce allocation
      try {
        await acquireChainNonceLock(chain, options.opportunityId, this.logger);
      } catch (lockError) {
        return {
          success: false,
          error: getErrorMessage(lockError) || '[ERR_NONCE_LOCK] Failed to acquire nonce lock',
        };
      }

      // Allocate new nonce from NonceManager (under lock)
      try {
        // Fix 5.1: Track nonce allocation to detect any remaining concurrent access
        checkConcurrentNonceAccess(chain, options.opportunityId, this.logger);

        nonce = await ctx.nonceManager.getNextNonce(chain);
        tx.nonce = nonce;
      } catch (error) {
        return {
          success: false,
          error: `[ERR_NONCE] Failed to get nonce: ${getErrorMessage(error)}`,
        };
      } finally {
        // Fix 3.1: Release lock after nonce allocation
        releaseChainNonceLock(chain, options.opportunityId, this.logger);
        // Fix 5.1: Clear tracking after nonce allocation
        if (needsNonceAllocation) {
          clearNonceAllocationTracking(chain, options.opportunityId);
        }
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

    // Refactor 9.5: Use O(1) DEX lookup instead of linear Array.find()
    // Find DEX router for the chain (use sellDex if specified, otherwise first available)
    const targetDex = opportunity.sellDex
      ? getDexByName(chain, opportunity.sellDex)
      : getFirstDex(chain);

    if (!targetDex) {
      throw new Error(`No DEX configured for chain: ${chain}${opportunity.sellDex ? ` (requested: ${opportunity.sellDex})` : ''}`);
    }

    if (!targetDex.routerAddress) {
      throw new Error(`No router address for DEX '${targetDex.name}' on chain: ${chain}`);
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

    // Fix 10.1: Use cached router contract for hot-path optimization
    const routerContract = this.getRouterContract(targetDex.routerAddress, provider, chain);

    // Issue 3.3 Fix: Use configurable deadline constant instead of hardcoded 300
    const deadline = Math.floor(Date.now() / 1000) + VALIDATED_SWAP_DEADLINE_SECONDS;

    // Recipient is wallet address by default
    // Perf 10.2: Use cached wallet address
    const recipient = recipientAddress || await this.getWalletAddress(wallet);

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

    // Perf 10.2: Use cached wallet address
    const ownerAddress = await this.getWalletAddress(wallet);
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
      //
      // Fix 2.1: IMPORTANT - If FlashLoanArbitrage.sol errors change, these selectors
      // become stale. Consider generating selectors at build time from contract ABI.
      // Tracking: Run `npm run generate:error-selectors` after contract changes.
      // TODO: Automate selector generation in build pipeline to prevent drift.
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
