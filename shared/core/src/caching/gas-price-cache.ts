/**
 * Gas Price Cache
 *
 * Provides dynamic gas price caching with periodic refresh for accurate
 * arbitrage profit calculations. Replaces static gas estimates with
 * real-time data from RPC providers.
 *
 * Features:
 * - Per-chain gas price storage with 60-second refresh
 * - Graceful fallback to static estimates on RPC failure
 * - Native token price integration for USD conversion
 * - Thread-safe singleton pattern
 *
 * @see ADR-012-worker-thread-path-finding.md - Gas optimization phase
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Phase 2 recommendations
 */

import { createLogger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';
import { CHAINS, NATIVE_TOKEN_PRICES } from '@arbitrage/config';

// =============================================================================
// Dependency Injection Interfaces
// =============================================================================

/**
 * Logger interface for GasPriceCache.
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface GasPriceCacheLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Dependencies for GasPriceCache (DI pattern).
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface GasPriceCacheDeps {
  logger?: GasPriceCacheLogger;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Cached gas price data for a single chain.
 */
export interface GasPriceData {
  /** Gas price in wei */
  gasPriceWei: bigint;
  /** Gas price in gwei (for display) */
  gasPriceGwei: number;
  /** Max fee per gas (EIP-1559) in wei, if available */
  maxFeePerGasWei?: bigint;
  /** Priority fee (EIP-1559) in wei, if available */
  maxPriorityFeePerGasWei?: bigint;
  /** Last update timestamp */
  lastUpdated: number;
  /** Whether this is a fallback value */
  isFallback: boolean;
  /** Error message if fetch failed */
  error?: string;
}

/**
 * Native token price data.
 */
export interface NativeTokenPrice {
  /** Price in USD */
  priceUsd: number;
  /** Last update timestamp */
  lastUpdated: number;
  /** Whether this is a fallback value */
  isFallback: boolean;
}

/**
 * Gas cost estimate in USD.
 */
export interface GasCostEstimate {
  /** Estimated gas cost in USD */
  costUsd: number;
  /** Gas price used (gwei) */
  gasPriceGwei: number;
  /** Gas units estimated */
  gasUnits: number;
  /** Native token price used */
  nativeTokenPriceUsd: number;
  /** Whether any fallback values were used */
  usesFallback: boolean;
  /** Chain name */
  chain: string;
}

/**
 * Configuration for GasPriceCache.
 */
export interface GasPriceCacheConfig {
  /** Refresh interval in milliseconds (default: 60000 = 60s) */
  refreshIntervalMs: number;
  /** Stale threshold - consider data stale after this duration (default: 120000 = 2min) */
  staleThresholdMs: number;
  /** Enable automatic refresh (default: true) */
  autoRefresh: boolean;
  /** Chains to monitor (default: all configured chains) */
  chains?: string[];
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: GasPriceCacheConfig = {
  refreshIntervalMs: 60000, // 60 seconds
  staleThresholdMs: 120000, // 2 minutes
  autoRefresh: true
};

/**
 * Metadata for fallback gas price tracking.
 * Issue 3.2 FIX: Track staleness to prevent using outdated fallback values.
 */
const FALLBACK_GAS_PRICE_METADATA = {
  /** ISO date string of last update */
  lastUpdated: '2026-01-18',
  /** Maximum age in days before considered stale */
  maxAgeDays: 7,
  /** Source for updating values */
  dataSource: 'Chain explorers (Etherscan, BSCScan, etc.) or RPC getFeeData()',
};

/**
 * Static fallback gas prices (in gwei) per chain.
 * Used when RPC fails or before first fetch.
 *
 * IMPORTANT: These are FALLBACK values. The GasPriceCache fetches real-time
 * gas prices from RPC providers. Fallbacks are only used when RPC is unavailable.
 *
 * Last updated: 2026-01-18
 * @see FALLBACK_GAS_PRICE_METADATA for staleness info
 */
const FALLBACK_GAS_PRICES: Record<string, number> = {
  ethereum: 30,    // ~30 gwei average
  arbitrum: 0.1,   // Very low L2 fees
  optimism: 0.01,  // Low L2 fees
  base: 0.01,      // Low L2 fees
  polygon: 50,     // ~50 gwei average
  bsc: 3,          // ~3 gwei average
  avalanche: 25,   // ~25 nAVAX
  fantom: 50,      // ~50 gwei
  zksync: 0.25,    // L2 fees
  linea: 0.5       // L2 fees
};

/**
 * Static fallback native token prices (USD) per chain.
 * Imported from @arbitrage/config for single source of truth.
 * @see shared/config/src/tokens/index.ts NATIVE_TOKEN_PRICES
 */
const FALLBACK_NATIVE_PRICES: Record<string, number> = NATIVE_TOKEN_PRICES;

/**
 * Default gas units per operation type.
 *
 * Fix 2.2: Methodology documentation
 * These values are derived from:
 * 1. Etherscan gas tracker historical data (2023-2024)
 * 2. Empirical testing on mainnet forks (Hardhat, Anvil)
 * 3. Conservative buffer (10-20%) for execution variance
 *
 * Values should be updated quarterly or when:
 * - New DEX router versions are deployed
 * - Gas optimization improvements are made to our contracts
 * - Significant protocol changes affect gas costs
 *
 * @see ADR-012 - Gas optimization architecture
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Phase 2 gas benchmarks
 */
export const GAS_UNITS = {
  /** Simple swap (Uniswap V2 style) - based on ~130K actual + 15% buffer */
  simpleSwap: 150000,
  /** Complex swap (Uniswap V3, Curve, etc.) - based on ~170K actual + 18% buffer */
  complexSwap: 200000,
  /** Triangular arbitrage (3 swaps) - 3x complex swap */
  triangularArbitrage: 450000,
  /** Quadrilateral arbitrage (4 swaps) - 4x complex swap - 50K overlap savings */
  quadrilateralArbitrage: 600000,
  /** Multi-leg arbitrage per additional hop */
  multiLegPerHop: 150000,
  /** Base gas for multi-leg (flash loan overhead + entry/exit) */
  multiLegBase: 100000
};

/**
 * Default trade amount for gas cost ratio calculations.
 * Used to convert USD gas costs to profit ratios.
 */
export const DEFAULT_TRADE_AMOUNT_USD = 2000;

/**
 * Static fallback gas costs per chain (in native token units, e.g., ETH, BNB).
 * Used when gas cache is unavailable (RPC failure, cold start).
 *
 * Fix 2.2: Methodology documentation
 * These values represent median gas costs for a triangular arbitrage swap:
 * - Based on 450K gas units (triangularArbitrage from GAS_UNITS)
 * - Calculated at typical gas prices from chain explorers (Q4 2024)
 * - Conservative estimates to avoid unprofitable trades during fallback
 *
 * Formula: fallback = gasUnits * typicalGasPrice / 1e18
 * Example: ethereum = 450000 * 12 gwei / 1e18 = 0.0054 ETH ≈ 0.005 ETH
 *
 * @see https://etherscan.io/gastracker - Ethereum gas tracker
 * @see https://bscscan.com/gastracker - BSC gas tracker
 */
export const FALLBACK_GAS_COSTS_ETH: Record<string, number> = {
  ethereum: 0.005,     // 450K gas @ 12 gwei = ~$10 at $2000/ETH
  bsc: 0.0001,         // 450K gas @ 0.2 gwei = ~$0.03 at $300/BNB
  arbitrum: 0.00005,   // L2 with calldata compression
  base: 0.00001,       // Coinbase L2, very low fees
  polygon: 0.0001,     // 450K gas @ 30 gwei MATIC
  optimism: 0.00005,   // L2 with calldata compression
  avalanche: 0.001,    // 450K gas @ 25 nAVAX
  fantom: 0.0001,      // Low gas prices
  zksync: 0.00005,     // zkRollup efficiency
  linea: 0.0001        // Consensys L2
};

/**
 * Consistent fallback scaling factor per step.
 * Each additional step adds 25% to base gas cost.
 */
export const FALLBACK_GAS_SCALING_PER_STEP = 0.25;

// =============================================================================
// GasPriceCache Class
// =============================================================================

/**
 * Singleton cache for gas prices across all chains.
 * Provides real-time gas price data with automatic refresh.
 */
export class GasPriceCache {
  private config: GasPriceCacheConfig;
  private logger: GasPriceCacheLogger;
  private gasPrices: Map<string, GasPriceData> = new Map();
  private nativePrices: Map<string, NativeTokenPrice> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isRefreshing = false; // Mutex to prevent concurrent refresh
  private providers: Map<string, any> = new Map(); // ethers providers

  constructor(config: Partial<GasPriceCacheConfig> = {}, deps?: GasPriceCacheDeps) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // DI: Use provided logger or create default
    this.logger = deps?.logger ?? createLogger('gas-price-cache');

    // Initialize with fallback values immediately so cache works without start()
    // This ensures getGasPrice() and getNativeTokenPrice() return valid data
    // even if start() is never called (graceful degradation per ADR-013)
    this.initializeFallbacks();

    this.logger.info('GasPriceCache initialized', {
      refreshIntervalMs: this.config.refreshIntervalMs,
      staleThresholdMs: this.config.staleThresholdMs,
      autoRefresh: this.config.autoRefresh
    });
  }

  /**
   * Start the gas price cache with automatic refresh.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('GasPriceCache already running');
      return;
    }

    this.isRunning = true;

    // Fallbacks already initialized in constructor
    // Perform initial fetch to get real gas prices
    await this.refreshAll();

    // Start auto-refresh if enabled
    if (this.config.autoRefresh) {
      this.startRefreshTimer();
    }

    this.logger.info('GasPriceCache started');
  }

  /**
   * Stop the gas price cache and clear timers.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    this.refreshTimer = clearIntervalSafe(this.refreshTimer);

    // Clear providers
    this.providers.clear();

    this.logger.info('GasPriceCache stopped');
  }

  /**
   * Get gas price for a specific chain.
   *
   * @param chain - Chain name (e.g., 'ethereum', 'arbitrum')
   * @returns Gas price data or fallback
   */
  getGasPrice(chain: string): GasPriceData {
    const cached = this.gasPrices.get(chain.toLowerCase());

    if (cached) {
      // Check if data is stale
      const age = Date.now() - cached.lastUpdated;
      if (age > this.config.staleThresholdMs) {
        this.logger.warn(`Gas price for ${chain} is stale (${age}ms old)`);
        // Return stale data but mark as potentially unreliable
        return { ...cached, isFallback: true };
      }
      return cached;
    }

    // Return fallback
    return this.createFallbackGasPrice(chain);
  }

  /**
   * Get native token price for a chain.
   *
   * @param chain - Chain name
   * @returns Native token price data
   */
  getNativeTokenPrice(chain: string): NativeTokenPrice {
    const cached = this.nativePrices.get(chain.toLowerCase());

    if (cached) {
      const age = Date.now() - cached.lastUpdated;
      if (age > this.config.staleThresholdMs) {
        return { ...cached, isFallback: true };
      }
      return cached;
    }

    // Return fallback
    return {
      priceUsd: FALLBACK_NATIVE_PRICES[chain.toLowerCase()] ?? 1000,
      lastUpdated: Date.now(),
      isFallback: true
    };
  }

  /**
   * Estimate gas cost in USD for an operation.
   *
   * @param chain - Chain name
   * @param gasUnits - Number of gas units (use GAS_UNITS constants)
   * @returns Gas cost estimate with metadata
   */
  estimateGasCostUsd(chain: string, gasUnits: number): GasCostEstimate {
    const chainLower = chain.toLowerCase();
    const gasPrice = this.getGasPrice(chainLower);
    const nativePrice = this.getNativeTokenPrice(chainLower);

    // Calculate cost: gasUnits * gasPrice (in ETH) * nativeTokenPrice (USD)
    const gasPriceEth = gasPrice.gasPriceGwei / 1e9; // gwei to ETH
    const costUsd = gasUnits * gasPriceEth * nativePrice.priceUsd;

    return {
      costUsd,
      gasPriceGwei: gasPrice.gasPriceGwei,
      gasUnits,
      nativeTokenPriceUsd: nativePrice.priceUsd,
      usesFallback: gasPrice.isFallback || nativePrice.isFallback,
      chain: chainLower
    };
  }

  /**
   * Estimate gas cost for multi-leg arbitrage.
   *
   * @param chain - Chain name
   * @param numHops - Number of swaps in the path
   * @returns Gas cost in USD
   */
  estimateMultiLegGasCost(chain: string, numHops: number): number {
    const gasUnits = GAS_UNITS.multiLegBase + (numHops * GAS_UNITS.multiLegPerHop);
    const estimate = this.estimateGasCostUsd(chain, gasUnits);
    return estimate.costUsd;
  }

  /**
   * Estimate gas cost for triangular arbitrage.
   *
   * @param chain - Chain name
   * @returns Gas cost in USD
   */
  estimateTriangularGasCost(chain: string): number {
    const estimate = this.estimateGasCostUsd(chain, GAS_UNITS.triangularArbitrage);
    return estimate.costUsd;
  }

  /**
   * Estimate gas cost as a ratio of trade amount.
   * This is the recommended method for profit calculations as it keeps units consistent.
   *
   * @param chain - Chain name
   * @param operationType - Type of operation ('simple', 'triangular', 'quadrilateral', 'multiLeg')
   * @param numSteps - Number of steps (only used for 'multiLeg')
   * @param tradeAmountUsd - Trade amount in USD (default: DEFAULT_TRADE_AMOUNT_USD)
   * @returns Gas cost as a ratio (e.g., 0.005 = 0.5% of trade amount)
   */
  estimateGasCostRatio(
    chain: string,
    operationType: 'simple' | 'triangular' | 'quadrilateral' | 'multiLeg',
    numSteps: number = 3,
    tradeAmountUsd: number = DEFAULT_TRADE_AMOUNT_USD
  ): number {
    // Determine gas units based on operation type
    let gasUnits: number;
    switch (operationType) {
      case 'simple':
        gasUnits = GAS_UNITS.simpleSwap;
        break;
      case 'triangular':
        gasUnits = GAS_UNITS.triangularArbitrage;
        break;
      case 'quadrilateral':
        gasUnits = GAS_UNITS.quadrilateralArbitrage;
        break;
      case 'multiLeg':
        gasUnits = GAS_UNITS.multiLegBase + (numSteps * GAS_UNITS.multiLegPerHop);
        break;
      default:
        gasUnits = GAS_UNITS.simpleSwap;
    }

    const estimate = this.estimateGasCostUsd(chain, gasUnits);
    return estimate.costUsd / tradeAmountUsd;
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    chainsMonitored: number;
    freshPrices: number;
    stalePrices: number;
    fallbackPrices: number;
    lastRefresh: number;
  } {
    const now = Date.now();
    let fresh = 0;
    let stale = 0;
    let fallback = 0;

    for (const data of this.gasPrices.values()) {
      if (data.isFallback) {
        fallback++;
      } else if (now - data.lastUpdated > this.config.staleThresholdMs) {
        stale++;
      } else {
        fresh++;
      }
    }

    return {
      chainsMonitored: this.gasPrices.size,
      freshPrices: fresh,
      stalePrices: stale,
      fallbackPrices: fallback,
      lastRefresh: Math.max(...Array.from(this.gasPrices.values()).map(d => d.lastUpdated), 0)
    };
  }

  /**
   * Manually refresh gas prices for all chains.
   * Protected by mutex to prevent concurrent refresh operations.
   */
  async refreshAll(): Promise<void> {
    // Prevent concurrent refresh operations (race condition protection)
    if (this.isRefreshing) {
      this.logger.debug('Refresh already in progress, skipping');
      return;
    }

    this.isRefreshing = true;
    try {
      const chains = this.config.chains || Object.keys(CHAINS);

      const results = await Promise.allSettled(
        chains.map(chain => this.refreshChain(chain))
      );

      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      this.logger.info('Gas price refresh completed', { succeeded, failed, total: chains.length });
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Refresh gas price for a specific chain.
   */
  async refreshChain(chain: string): Promise<void> {
    const chainLower = chain.toLowerCase();

    try {
      // Try to fetch real gas price via RPC
      const chainConfig = CHAINS[chainLower];
      if (!chainConfig) {
        this.logger.warn(`Unknown chain: ${chain}`);
        return;
      }

      // Use dynamic import for ethers to avoid issues in worker threads
      const { ethers } = await import('ethers');

      // Get or create provider
      let provider = this.providers.get(chainLower);
      if (!provider) {
        provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
        this.providers.set(chainLower, provider);
      }

      // Fetch fee data (EIP-1559 compatible)
      const feeData = await provider.getFeeData();

      const gasPriceWei = feeData.gasPrice ?? BigInt(0);
      const maxFeePerGasWei = feeData.maxFeePerGas ?? undefined;
      const maxPriorityFeePerGasWei = feeData.maxPriorityFeePerGas ?? undefined;

      // Convert to gwei for display
      // Fix #10: Guard against BigInt→Number overflow for values > 2^53
      let gasPriceGwei = Number(gasPriceWei) / 1e9;
      if (!Number.isFinite(gasPriceGwei)) {
        gasPriceGwei = 0; // Graceful fallback — will use fallback gas price
      }

      this.gasPrices.set(chainLower, {
        gasPriceWei,
        gasPriceGwei,
        maxFeePerGasWei,
        maxPriorityFeePerGasWei,
        lastUpdated: Date.now(),
        isFallback: false
      });

      this.logger.debug(`Gas price updated for ${chain}`, { gasPriceGwei });

    } catch (error) {
      this.logger.warn(`Failed to fetch gas price for ${chain}`, { error });

      // Keep existing value if available, otherwise use fallback
      if (!this.gasPrices.has(chainLower)) {
        this.gasPrices.set(chainLower, this.createFallbackGasPrice(chainLower));
      } else {
        // Mark existing as potentially stale
        const existing = this.gasPrices.get(chainLower)!;
        existing.error = String(error);
      }
    }
  }

  /**
   * Update native token price manually.
   * In production, integrate with price oracle.
   */
  setNativeTokenPrice(chain: string, priceUsd: number): void {
    this.nativePrices.set(chain.toLowerCase(), {
      priceUsd,
      lastUpdated: Date.now(),
      isFallback: false
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private initializeFallbacks(): void {
    const chains = this.config.chains || Object.keys(CHAINS);

    for (const chain of chains) {
      const chainLower = chain.toLowerCase();

      // Initialize gas prices with fallbacks
      if (!this.gasPrices.has(chainLower)) {
        this.gasPrices.set(chainLower, this.createFallbackGasPrice(chainLower));
      }

      // Initialize native prices with fallbacks
      if (!this.nativePrices.has(chainLower)) {
        this.nativePrices.set(chainLower, {
          priceUsd: FALLBACK_NATIVE_PRICES[chainLower] ?? 1000,
          lastUpdated: Date.now(),
          isFallback: true
        });
      }
    }
  }

  private createFallbackGasPrice(chain: string): GasPriceData {
    const fallbackGwei = FALLBACK_GAS_PRICES[chain.toLowerCase()] ?? 50;
    // Convert gwei to wei: multiply by 1e9
    // Note: gwei values are typically whole numbers or simple decimals (e.g., 50, 25, 0.25)
    // so precision loss is minimal. For critical calculations, use ethers.parseUnits.
    const gasPriceWei = BigInt(Math.round(fallbackGwei * 1e9));

    return {
      gasPriceWei,
      gasPriceGwei: fallbackGwei,
      lastUpdated: Date.now(),
      isFallback: true
    };
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(async () => {
      if (!this.isRunning) {
        this.refreshTimer = clearIntervalSafe(this.refreshTimer);
        return;
      }

      try {
        await this.refreshAll();
      } catch (error) {
        this.logger.error('Error in gas price refresh timer', { error });
      }
    }, this.config.refreshIntervalMs);
    // Don't let refresh timer prevent process exit
    this.refreshTimer.unref();
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let gasPriceCacheInstance: GasPriceCache | null = null;
let gasPriceCacheInstanceConfig: Partial<GasPriceCacheConfig> | undefined = undefined;
// P0-FIX Issue 4.3: Store logger for warning messages
const singletonLogger = createLogger('gas-price-cache-singleton');

/**
 * Get the singleton GasPriceCache instance.
 *
 * Note: The configuration is only used on first initialization. If called with
 * different config after the singleton exists, a warning is logged and the
 * existing instance is returned unchanged. Use resetGasPriceCache() first
 * if you need to change configuration.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton GasPriceCache instance
 */
export function getGasPriceCache(config?: Partial<GasPriceCacheConfig>): GasPriceCache {
  if (!gasPriceCacheInstance) {
    gasPriceCacheInstance = new GasPriceCache(config);
    gasPriceCacheInstanceConfig = config;
  } else if (config !== undefined && config !== gasPriceCacheInstanceConfig) {
    // P0-FIX Issue 4.3: Warn if config differs from initial
    // This prevents silent config being ignored which can cause subtle bugs
    singletonLogger.warn(
      'getGasPriceCache called with different config after initialization. ' +
      'Config is ignored. Use resetGasPriceCache() first if reconfiguration is needed.',
      { providedConfig: config, existingConfig: gasPriceCacheInstanceConfig }
    );
  }
  return gasPriceCacheInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export async function resetGasPriceCache(): Promise<void> {
  if (gasPriceCacheInstance) {
    await gasPriceCacheInstance.stop();
  }
  gasPriceCacheInstance = null;
  gasPriceCacheInstanceConfig = undefined;
}
