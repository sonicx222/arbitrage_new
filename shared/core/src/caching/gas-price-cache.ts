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

import { createLogger, type Logger } from '../logger';
import { clearIntervalSafe } from '../async/lifecycle-utils';
import { CHAINS, NATIVE_TOKEN_PRICES, FEATURE_FLAGS, isEvmChainSafe } from '@arbitrage/config';

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
  // P1-3 FIX: Increased from 120s (2min) to 180s (3min).
  // With 13+ chains, a single refresh cycle can take >60s due to RPC timeouts.
  // A stale threshold of only 2x the refresh interval caused spurious stale
  // warnings for L2 chains (optimism, base were 2.3min stale). 3x provides
  // a safe margin: refresh at 60s + worst-case RPC timeout ~30s = 90s << 180s.
  staleThresholdMs: 180000, // 3 minutes
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
// FIX P1-8: Aligned with gas-price-optimizer.ts DEFAULT_GAS_PRICES_GWEI and .env.example.
// Previously polygon=50 and fantom=50, while optimizer and .env use 35 for both.
// @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P1 #8
const FALLBACK_GAS_PRICES: Record<string, number> = {
  ethereum: 30,    // ~30 gwei average
  arbitrum: 0.1,   // Very low L2 fees
  optimism: 0.01,  // Low L2 fees
  base: 0.01,      // Low L2 fees
  polygon: 35,     // ~35 gwei average (aligned with gas-price-optimizer)
  bsc: 3,          // ~3 gwei average
  avalanche: 25,   // ~25 nAVAX
  fantom: 35,      // ~35 gwei (aligned with gas-price-optimizer)
  zksync: 0.25,    // L2 fees
  linea: 0.5,      // L2 fees
  blast: 0.001,    // OP-stack L2 (very low fees)
  scroll: 0.5,     // zkRollup (similar to zkSync/Linea)
  // IMPORTANT: Mantle uses MNT (~$0.80) not ETH (~$3200) as native token.
  // Gas cost in USD must use MNT price, not ETH price, when Mantle exits stub status.
  mantle: 0.02,    // OP-stack L2 (MNT native token, low fees)
  mode: 0.001,     // OP-stack L2 (very low fees)
};

/**
 * FIX P0-5: L1 data fee estimates for rollup chains (in USD per arbitrage transaction).
 *
 * L2 rollups post transaction data to L1 (Ethereum). The L1 data fee is often the
 * dominant cost component and was previously missing from gas estimates, causing
 * 30-300x underestimation on L2 chains.
 *
 * Estimates assume ~500 bytes calldata for a typical arbitrage tx at ~30 gwei L1 gas
 * and ~$3500/ETH. These are conservative fallback values; real-time L1 fee estimation
 * would require querying each rollup's fee oracle (e.g., Arbitrum's ArbGasInfo,
 * Optimism's GasPriceOracle L1 fee function).
 *
 * Last updated: 2026-02-20
 * @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P0-5
 */
const L1_DATA_FEE_USD: Record<string, number> = {
  arbitrum: 0.50,   // Arbitrum posts calldata to L1; ~500 bytes @ 30 gwei ≈ $0.30-0.70
  optimism: 0.40,   // OP-stack with EIP-4844 blobs; cheaper than Arbitrum
  base: 0.40,       // OP-stack (same model as Optimism)
  zksync: 0.30,     // zkSync Era uses validity proofs; data cost amortized across batch
  linea: 0.35,      // Consensys zkEVM; similar to zkSync cost model
  blast: 0.40,      // OP-stack L2; same fee model as Optimism
  scroll: 0.35,     // zkRollup; similar cost model to zkSync/Linea
  mantle: 0.10,     // Uses EigenDA for modular data availability; very low L1 fees
  mode: 0.40,       // OP-stack L2; same fee model as Optimism
};

// =============================================================================
// L1 Oracle Configuration (Fix 3: Dynamic L1 Gas Fee Oracle)
// =============================================================================

/** TTL for cached L1 oracle values in milliseconds (default: 5 minutes). */
const L1_ORACLE_CACHE_TTL_MS = parseInt(process.env.L1_ORACLE_CACHE_TTL_MS ?? '300000', 10);

/** How often to refresh L1 oracle cache in milliseconds (default: 60 seconds). */
const L1_ORACLE_REFRESH_INTERVAL_MS = parseInt(process.env.L1_ORACLE_REFRESH_INTERVAL_MS ?? '60000', 10);

/** Typical arbitrage tx calldata size in bytes for L1 cost estimation. */
const L1_CALLDATA_BYTES = 500;

/**
 * L1 fee oracle contract addresses (precompiles/predeploys).
 * These are the same on all networks of the respective chain.
 *
 * Note: zkSync and Linea use RPC-based fee estimation (no oracle contract).
 * See refreshL1OracleCache() for their handling.
 */
const L1_ORACLE_ADDRESSES: Record<string, string> = {
  arbitrum: '0x000000000000000000000000000000000000006C', // ArbGasInfo
  optimism: '0x420000000000000000000000000000000000000F', // GasPriceOracle
  base: '0x420000000000000000000000000000000000000F',     // GasPriceOracle (OP Stack)
  blast: '0x420000000000000000000000000000000000000F',    // GasPriceOracle (OP Stack)
  mode: '0x420000000000000000000000000000000000000F',     // GasPriceOracle (OP Stack)
};

/**
 * Chains that use RPC-based L1 fee estimation instead of oracle contracts.
 * These chains have custom fee models that require specific RPC methods.
 */
const L1_RPC_FEE_CHAINS = ['zksync', 'linea', 'scroll', 'mantle'] as const;

/** Cached L1 oracle fee data per chain. */
interface L1OracleCacheEntry {
  feeUsd: number;
  updatedAt: number;
}

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
  linea: 0.0001,       // Consensys L2
  blast: 0.00005,      // OP-stack L2 with calldata compression
  scroll: 0.00008,     // zkRollup, slightly higher than zkSync
  mantle: 0.001,       // MNT-native; ~0.001 MNT ≈ $0.001 at $0.80/MNT
  mode: 0.00001,       // OP-stack L2, very low fees (similar to Base)
};

/**
 * Consistent fallback scaling factor per step.
 * Each additional step adds 25% to base gas cost.
 */
export const FALLBACK_GAS_SCALING_PER_STEP = 0.25;

/**
 * Safety multiplier for fallback gas estimates.
 * Applied when using static fallback values (RPC unavailable).
 * Prevents submitting trades that lose money during gas spikes.
 *
 * Default: 2.0x — conservative to avoid unprofitable trades on stale data.
 * Configurable via GAS_FALLBACK_SAFETY_FACTOR env var.
 */
export const GAS_FALLBACK_SAFETY_FACTOR = parseFloat(
  process.env.GAS_FALLBACK_SAFETY_FACTOR ?? '2.0'
);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ethers.JsonRpcProvider is dynamically imported, no static type available
  private providers: Map<string, any> = new Map(); // ethers providers

  // Fix 3: Dynamic L1 oracle cache (background-refreshed, sync reads)
  private l1OracleCache: Map<string, L1OracleCacheEntry> = new Map();
  private l1OracleRefreshTimer: NodeJS.Timeout | null = null;

  // FIX #1: Rate-limit stale gas price warnings (per chain).
  // Without this, the warn() in getGasPrice() fires on every hot-path call (~63K/sec),
  // producing 37.6M log lines in 10 minutes and saturating disk I/O.
  private staleWarnLastLogged: Map<string, number> = new Map();
  private static readonly STALE_WARN_INTERVAL_MS = 30_000; // Log at most once per 30s per chain

  constructor(config: Partial<GasPriceCacheConfig> = {}, deps?: GasPriceCacheDeps) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // DI: Use provided logger or create default
    this.logger = (deps?.logger ?? createLogger('gas-price-cache')) as GasPriceCacheLogger;

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

    // Fix 3: Start L1 oracle background refresh if dynamic fees are enabled
    this.startL1OracleRefresh();

    this.logger.info('GasPriceCache started');
  }

  /**
   * Stop the gas price cache and clear timers.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    this.refreshTimer = clearIntervalSafe(this.refreshTimer);

    // Fix 3: Clear L1 oracle refresh timer
    this.l1OracleRefreshTimer = clearIntervalSafe(this.l1OracleRefreshTimer);
    this.l1OracleCache.clear();

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
        // FIX #1: Rate-limit stale warnings — this runs in the hot path (~1000s/sec)
        // and must not emit a log line on every call. Log at most once per 30s per chain.
        const now = Date.now();
        const lastLogged = this.staleWarnLastLogged.get(chain) ?? 0;
        if (now - lastLogged >= GasPriceCache.STALE_WARN_INTERVAL_MS) {
          this.staleWarnLastLogged.set(chain, now);
          this.logger.warn(`Gas price for ${chain} is stale (${age}ms old)`);
        }
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

    // Calculate L2 execution cost: gasUnits * gasPrice (in ETH) * nativeTokenPrice (USD)
    const gasPriceEth = gasPrice.gasPriceGwei / 1e9; // gwei to ETH
    const l2ExecutionCostUsd = gasUnits * gasPriceEth * nativePrice.priceUsd;

    // FIX P0-5: Add L1 data fee for rollup chains.
    // L2 rollups post tx data to L1; this is often the dominant cost component.
    // Without this, L2 gas estimates were 30-300x too low.
    // Fix 3: Use dynamic oracle value when available, otherwise static fallback.
    // @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P0-5
    const l1DataFeeUsd = this.getL1DataFee(chainLower);
    const costUsd = l2ExecutionCostUsd + l1DataFeeUsd;

    this.logger.debug('L1 fee estimation', {
      chain: chainLower,
      l1DataFeeUsd,
      l2ExecutionCostUsd,
      totalCostUsd: costUsd,
      usesFallback: gasPrice.isFallback || nativePrice.isFallback,
    });

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

    // Skip non-EVM chains (e.g., Solana) — they don't use ethers.JsonRpcProvider.
    // Solana has its own gas estimation via compute units in partition-solana.
    if (!isEvmChainSafe(chainLower)) {
      this.logger.debug(`Skipping non-EVM chain: ${chain}`);
      return;
    }

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
      // P1 Fix LW-012: Use staticNetwork to prevent ethers' infinite retry loop on network detection
      let provider = this.providers.get(chainLower);
      if (!provider) {
        const network = chainConfig.id ? ethers.Network.from(chainConfig.id) : undefined;
        provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl, network, { staticNetwork: !!network });
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

  /**
   * Fix 3: Get L1 data fee for a chain, using dynamic oracle value when available.
   *
   * MUST remain synchronous — oracle queries happen in background only.
   * Falls back to static L1_DATA_FEE_USD when:
   * - FEATURE_FLAGS.useDynamicL1Fees is false
   * - Oracle cache is empty or stale (beyond TTL)
   * - Chain is not an L2 rollup (returns 0)
   */
  private getL1DataFee(chain: string): number {
    // If dynamic L1 fees are disabled, use static fallback
    if (!FEATURE_FLAGS.useDynamicL1Fees) {
      return L1_DATA_FEE_USD[chain] ?? 0;
    }

    // Check oracle cache for fresh value
    const cached = this.l1OracleCache.get(chain);
    if (cached && (Date.now() - cached.updatedAt) < L1_ORACLE_CACHE_TTL_MS) {
      return cached.feeUsd;
    }

    // Stale or no oracle data — use static fallback
    return L1_DATA_FEE_USD[chain] ?? 0;
  }

  /**
   * Fix 3: Start background L1 oracle refresh.
   * Only starts if FEATURE_FLAGS.useDynamicL1Fees is enabled.
   */
  private startL1OracleRefresh(): void {
    if (!FEATURE_FLAGS.useDynamicL1Fees) {
      return;
    }

    this.logger.info('Starting L1 oracle background refresh', {
      refreshIntervalMs: L1_ORACLE_REFRESH_INTERVAL_MS,
      cacheTtlMs: L1_ORACLE_CACHE_TTL_MS,
      oracleChains: Object.keys(L1_ORACLE_ADDRESSES),
      rpcFeeChains: L1_RPC_FEE_CHAINS,
    });

    // Initial refresh (fire-and-forget, errors are logged internally)
    this.refreshL1OracleCache().catch((error) => {
      this.logger.error('Initial L1 oracle refresh failed', { error });
    });

    // Set up periodic refresh
    this.l1OracleRefreshTimer = setInterval(async () => {
      if (!this.isRunning) {
        this.l1OracleRefreshTimer = clearIntervalSafe(this.l1OracleRefreshTimer);
        return;
      }
      try {
        await this.refreshL1OracleCache();
      } catch (error) {
        this.logger.error('L1 oracle refresh failed', { error });
      }
    }, L1_ORACLE_REFRESH_INTERVAL_MS);
    this.l1OracleRefreshTimer.unref();
  }

  /**
   * Fix 3: Refresh L1 oracle cache by querying on-chain fee oracles.
   *
   * Queries per-chain oracles:
   * - Arbitrum: ArbGasInfo precompile getL1BaseFeeEstimate()
   * - Optimism/Base: GasPriceOracle l1BaseFee()
   * - zkSync: zks_estimateFee RPC method (validity proof fee model)
   * - Linea: Derives L1 fee from Ethereum L1 base fee with compression ratio
   *
   * Calculates USD cost as: l1BaseFeeWei * L1_CALLDATA_BYTES * 16 / 1e18 * ethPriceUsd
   * (16 gas per non-zero calldata byte on L1)
   */
  private async refreshL1OracleCache(): Promise<void> {
    const { ethers } = await import('ethers');
    const ethPrice = this.getNativeTokenPrice('ethereum').priceUsd;

    // Refresh oracle-based chains (Arbitrum, Optimism, Base)
    const oracleChains = Object.keys(L1_ORACLE_ADDRESSES);
    const oracleResults = await Promise.allSettled(
      oracleChains.map(async (chain) => {
        const chainConfig = CHAINS[chain];
        if (!chainConfig) return;

        let provider = this.providers.get(chain);
        if (!provider) {
          const network = chainConfig.id ? ethers.Network.from(chainConfig.id) : undefined;
          provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl, network, { staticNetwork: !!network });
          this.providers.set(chain, provider);
        }

        const oracleAddress = L1_ORACLE_ADDRESSES[chain];
        let l1BaseFeeWei: bigint;

        if (chain === 'arbitrum') {
          // ArbGasInfo.getL1BaseFeeEstimate() returns uint256 (L1 base fee in wei)
          const abi = ['function getL1BaseFeeEstimate() external view returns (uint256)'];
          const oracle = new ethers.Contract(oracleAddress, abi, provider);
          l1BaseFeeWei = await oracle.getL1BaseFeeEstimate();
        } else {
          // OP Stack: GasPriceOracle.l1BaseFee() returns uint256
          const abi = ['function l1BaseFee() external view returns (uint256)'];
          const oracle = new ethers.Contract(oracleAddress, abi, provider);
          l1BaseFeeWei = await oracle.l1BaseFee();
        }

        // Calculate L1 data cost in USD:
        // cost = l1BaseFee (wei) * calldataBytes * 16 (gas per non-zero byte) / 1e18 * ethPrice
        const l1GasUsed = BigInt(L1_CALLDATA_BYTES) * 16n;
        const l1CostWei = l1BaseFeeWei * l1GasUsed;
        const l1CostEth = Number(l1CostWei) / 1e18;
        const feeUsd = l1CostEth * ethPrice;

        this.l1OracleCache.set(chain, {
          feeUsd,
          updatedAt: Date.now(),
        });

        this.logger.debug('L1 oracle updated', {
          chain,
          l1BaseFeeGwei: Number(l1BaseFeeWei) / 1e9,
          feeUsd,
        });
      })
    );

    // Refresh RPC-based chains (zkSync, Linea, Scroll, Mantle)
    const rpcResults = await Promise.allSettled(
      L1_RPC_FEE_CHAINS.map(async (chain) => {
        const chainConfig = CHAINS[chain];
        if (!chainConfig) return;

        let provider = this.providers.get(chain);
        if (!provider) {
          const network = chainConfig.id ? ethers.Network.from(chainConfig.id) : undefined;
          provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl, network, { staticNetwork: !!network });
          this.providers.set(chain, provider);
        }

        if (chain === 'zksync') {
          await this.refreshZkSyncL1Fee(provider, ethPrice);
        } else if (chain === 'linea') {
          await this.refreshLineaL1Fee(ethPrice);
        } else if (chain === 'scroll') {
          // FIX H4: Scroll uses L1GasOracle precompile like OP-stack
          await this.refreshScrollL1Fee(provider, ethPrice);
        } else if (chain === 'mantle') {
          // FIX H4: Mantle uses EigenDA — L1 fee is minimal, use static estimate
          await this.refreshMantleL1Fee(ethPrice);
        }
      })
    );

    const allResults = [...oracleResults, ...rpcResults];
    const succeeded = allResults.filter(r => r.status === 'fulfilled').length;
    const failed = allResults.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn('L1 oracle refresh partial failure', { succeeded, failed });
    }
  }

  /**
   * Refresh zkSync L1 fee estimate using zks_estimateFee RPC method.
   *
   * zkSync Era uses a different fee model where fees are charged as
   * gasLimit * gasPerPubdataLimit * l1GasPrice. The zks_estimateFee
   * method returns the estimated fee for a reference transaction.
   *
   * Falls back to static L1_DATA_FEE_USD['zksync'] on failure.
   */
  private async refreshZkSyncL1Fee(provider: { send: (method: string, params: unknown[]) => Promise<unknown> }, ethPrice: number): Promise<void> {
    try {
      // Reference tx for fee estimation: ~500 bytes calldata to a contract
      const referenceTx = {
        from: '0x0000000000000000000000000000000000000001',
        to: '0x0000000000000000000000000000000000000002',
        data: '0x' + '00'.repeat(L1_CALLDATA_BYTES),
      };

      const feeEstimate = await provider.send('zks_estimateFee', [referenceTx]) as { gas_limit: string; max_fee_per_gas: string };

      // zks_estimateFee returns { gas_limit, max_fee_per_gas, max_priority_fee_per_gas, gas_per_pubdata_limit }
      // Total fee in wei = gas_limit * max_fee_per_gas
      const gasLimit = BigInt(feeEstimate.gas_limit);
      const maxFeePerGas = BigInt(feeEstimate.max_fee_per_gas);
      const totalFeeWei = gasLimit * maxFeePerGas;
      const feeEth = Number(totalFeeWei) / 1e18;
      const feeUsd = feeEth * ethPrice;

      this.l1OracleCache.set('zksync', {
        feeUsd,
        updatedAt: Date.now(),
      });

      this.logger.debug('zkSync L1 fee updated via zks_estimateFee', {
        chain: 'zksync',
        gasLimit: gasLimit.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        feeUsd,
      });
    } catch (error) {
      this.logger.warn('zkSync zks_estimateFee failed, using static fallback', { error });
      // Do not cache — getL1DataFee() will return static fallback
    }
  }

  /**
   * Refresh Linea L1 fee estimate.
   *
   * Linea posts compressed data to L1. The L1 data fee is estimated by
   * querying the Ethereum L1 base fee (already cached by refreshChain('ethereum'))
   * and applying Linea's compression ratio (~4x reduction).
   *
   * Formula: l1BaseFee * calldataBytes * 16 / compressionRatio / 1e18 * ethPrice
   *
   * Falls back to static L1_DATA_FEE_USD['linea'] on failure.
   */
  private async refreshLineaL1Fee(ethPrice: number): Promise<void> {
    try {
      // Use Ethereum L1 gas price from our cache (already fetched by refreshChain)
      const ethGasPrice = this.getGasPrice('ethereum');
      const l1BaseFeeWei = ethGasPrice.gasPriceWei;

      // Linea compresses calldata ~4x before posting to L1
      const LINEA_COMPRESSION_RATIO = 4;

      // L1 data cost = l1BaseFee * calldataBytes * 16 (gas/byte) / compressionRatio
      const l1GasUsed = BigInt(L1_CALLDATA_BYTES) * 16n;
      const l1CostWei = (l1BaseFeeWei * l1GasUsed) / BigInt(LINEA_COMPRESSION_RATIO);
      const l1CostEth = Number(l1CostWei) / 1e18;
      const feeUsd = l1CostEth * ethPrice;

      this.l1OracleCache.set('linea', {
        feeUsd,
        updatedAt: Date.now(),
      });

      this.logger.debug('Linea L1 fee updated from Ethereum base fee', {
        chain: 'linea',
        l1BaseFeeGwei: ethGasPrice.gasPriceGwei,
        compressionRatio: LINEA_COMPRESSION_RATIO,
        feeUsd,
      });
    } catch (error) {
      this.logger.warn('Linea L1 fee estimation failed, using static fallback', { error });
      // Do not cache — getL1DataFee() will return static fallback
    }
  }

  /**
   * FIX H4: Refresh Scroll L1 fee estimate.
   *
   * Scroll is a zkRollup that posts compressed data to L1. It has a
   * L1GasOracle precompile similar to OP-stack chains but with different
   * compression characteristics (~5x compression from zk proofs).
   *
   * Uses Ethereum L1 base fee from cache with Scroll's compression ratio.
   * Falls back to static L1_DATA_FEE_USD['scroll'] on failure.
   */
  private async refreshScrollL1Fee(provider: { send: (method: string, params: unknown[]) => Promise<unknown> }, ethPrice: number): Promise<void> {
    try {
      // Try Scroll's L1GasOracle precompile at 0x5300000000000000000000000000000000000002
      const SCROLL_L1_GAS_ORACLE = '0x5300000000000000000000000000000000000002';
      // l1BaseFee() selector: 0x519b4bd3
      const l1BaseFeeHex = await provider.send('eth_call', [{
        to: SCROLL_L1_GAS_ORACLE,
        data: '0x519b4bd3',
      }, 'latest']) as string;

      const l1BaseFeeWei = BigInt(l1BaseFeeHex);

      // Scroll compresses data ~5x via zk proofs before posting to L1
      const SCROLL_COMPRESSION_RATIO = 5;
      const l1GasUsed = BigInt(L1_CALLDATA_BYTES) * 16n;
      const l1CostWei = (l1BaseFeeWei * l1GasUsed) / BigInt(SCROLL_COMPRESSION_RATIO);
      const l1CostEth = Number(l1CostWei) / 1e18;
      const feeUsd = l1CostEth * ethPrice;

      this.l1OracleCache.set('scroll', {
        feeUsd,
        updatedAt: Date.now(),
      });

      this.logger.debug('Scroll L1 fee updated via L1GasOracle', {
        chain: 'scroll',
        l1BaseFeeGwei: Number(l1BaseFeeWei) / 1e9,
        compressionRatio: SCROLL_COMPRESSION_RATIO,
        feeUsd,
      });
    } catch (error) {
      // Fallback: use Ethereum L1 base fee with compression ratio
      try {
        const ethGasPrice = this.getGasPrice('ethereum');
        const SCROLL_COMPRESSION_RATIO = 5;
        const l1GasUsed = BigInt(L1_CALLDATA_BYTES) * 16n;
        const l1CostWei = (ethGasPrice.gasPriceWei * l1GasUsed) / BigInt(SCROLL_COMPRESSION_RATIO);
        const l1CostEth = Number(l1CostWei) / 1e18;
        const feeUsd = l1CostEth * ethPrice;

        this.l1OracleCache.set('scroll', { feeUsd, updatedAt: Date.now() });
        this.logger.debug('Scroll L1 fee estimated from Ethereum base fee (oracle fallback)', {
          chain: 'scroll', feeUsd,
        });
      } catch {
        this.logger.warn('Scroll L1 fee estimation failed, using static fallback', { error });
      }
    }
  }

  /**
   * FIX H4: Refresh Mantle L1 fee estimate.
   *
   * Mantle uses EigenDA for data availability instead of posting to Ethereum L1.
   * This makes L1 data fees minimal (~$0.01-0.10 per tx). Since there's no
   * on-chain oracle to query, we estimate based on the known EigenDA fee model.
   *
   * The primary cost factor for Mantle is the MNT gas price on L2 itself,
   * not L1 data posting. We update the cache with a minimal estimated L1 fee.
   *
   * Falls back to static L1_DATA_FEE_USD['mantle'] on failure.
   */
  private async refreshMantleL1Fee(ethPrice: number): Promise<void> {
    try {
      // Mantle's L1 data fee is minimal due to EigenDA.
      // Estimate: ~0.001 ETH equivalent per tx at current rates
      // This is much cheaper than Ethereum-posting L2s.
      const MANTLE_EIGENDATA_COST_ETH = 0.00005; // ~50 gas units of EigenDA cost
      const feeUsd = MANTLE_EIGENDATA_COST_ETH * ethPrice;

      this.l1OracleCache.set('mantle', {
        feeUsd,
        updatedAt: Date.now(),
      });

      this.logger.debug('Mantle L1 fee updated (EigenDA estimate)', {
        chain: 'mantle',
        feeUsd,
      });
    } catch (error) {
      this.logger.warn('Mantle L1 fee estimation failed, using static fallback', { error });
    }
  }

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
