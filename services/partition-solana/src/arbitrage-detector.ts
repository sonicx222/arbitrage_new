/**
 * S3.3.6 Solana-Specific Arbitrage Detection
 *
 * Provides specialized arbitrage detection for Solana blockchain:
 * - Intra-Solana arbitrage (between Solana DEXs)
 * - Triangular arbitrage paths (SOL→USDC→JUP→SOL)
 * - Cross-chain price comparison (Solana vs EVM)
 * - Priority fee estimation for Solana transactions
 *
 * Key Differences from EVM:
 * - Uses compute units instead of gas
 * - Priority fees paid per compute unit (microLamports/CU)
 * - ~400ms block time enables faster arbitrage cycles
 * - Program account subscriptions instead of event logs
 *
 * Architecture:
 * This module provides arbitrage-specific detection logic that can be:
 * 1. Used standalone for testing with mock pools (current implementation)
 * 2. Composed with SolanaDetector or UnifiedChainDetector for production use
 *
 * Pool Discovery Note (Issue 1.2):
 * This detector does NOT discover pools automatically. Pools must be provided via:
 * - connectToSolanaDetector() for integration with UnifiedChainDetector
 * - addPool() for manual/test injection
 * - importPools() for batch initialization
 * The base SolanaDetector (shared/core/src/solana/solana-detector.ts) handles actual
 * program account subscriptions and pool discovery.
 *
 * Token Normalization Note (Issue 6.1):
 * This module uses normalizeTokenForCrossChain() from @arbitrage/config for
 * cross-chain matching (e.g., MSOL→SOL, WETH.e→WETH). This is DIFFERENT from
 * price-oracle's normalization which maps wrapped→native for pricing (WETH→ETH).
 * The different strategies serve different purposes and are intentional.
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.6
 * @see shared/core/src/solana/solana-detector.ts - Base infrastructure
 */

import { EventEmitter } from 'events';
import { normalizeTokenForCrossChain } from '@arbitrage/config';
import {
  basisPointsToDecimal,
  meetsThreshold,
  getDefaultPrice,
} from '@arbitrage/core';

// =============================================================================
// Types
// =============================================================================

/**
 * Logger interface for SolanaArbitrageDetector.
 */
export interface SolanaArbitrageLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Configuration for SolanaArbitrageDetector.
 *
 * Note: This detector does not manage RPC connections directly.
 * Use SolanaDetector for connection management and compose with this detector
 * via connectToSolanaDetector() for pool updates.
 */
export interface SolanaArbitrageConfig {
  /**
   * Solana RPC endpoint URL.
   * Used for logging and identification purposes only.
   * Actual RPC connections are managed by the upstream SolanaDetector.
   *
   * @deprecated Consider removing this requirement in future versions
   *             since connections are managed externally.
   */
  rpcUrl?: string;

  /**
   * Chain identifier (default: 'solana').
   * Used in opportunity records for cross-chain matching.
   * Fix for Issue 1.3: Chain identifier should be configurable.
   */
  chainId?: string;

  /** Minimum profit threshold in percentage points (default: 0.3 = 0.3%) */
  minProfitThreshold?: number;

  /** Priority fee multiplier (default: 1.0) */
  priorityFeeMultiplier?: number;

  /** Base priority fee in lamports (default: 10000 = 0.00001 SOL) */
  basePriorityFeeLamports?: number;

  /** Enable cross-chain price comparison (default: true) */
  crossChainEnabled?: boolean;

  /** Enable triangular arbitrage detection (default: true) */
  triangularEnabled?: boolean;

  /** Maximum depth for triangular paths (default: 3) */
  maxTriangularDepth?: number;

  /** Opportunity expiry time in ms (default: 1000 = 1s) */
  opportunityExpiryMs?: number;

  /**
   * Price staleness threshold in ms (default: 5000 = 5s).
   * Pools with prices older than this are excluded from detection.
   * Fix for Issue 10.7: Missing price staleness check.
   */
  priceStalenessMs?: number;

  /**
   * Default trade value in USD for gas cost estimation (default: 1000).
   * Fix for Issue 4.4: Hardcoded trade value.
   */
  defaultTradeValueUsd?: number;

  /**
   * Whether to normalize liquid staking tokens (mSOL, jitoSOL, etc.) to SOL.
   * BUG-FIX: For intra-Solana arbitrage, these tokens have different values
   * and shouldn't be treated as equivalent.
   * - true (default): Normalize for cross-chain matching (mSOL → SOL)
   * - false: Keep distinct for intra-chain arbitrage accuracy
   */
  normalizeLiquidStaking?: boolean;

  /**
   * Cross-chain cost configuration.
   * P1-FIX: These were hardcoded but should be configurable for accuracy.
   */
  crossChainCosts?: {
    /** Bridge fee as decimal (default: 0.001 = 0.1%) */
    bridgeFeeDefault?: number;
    /** EVM gas cost in USD (default: 15) */
    evmGasCostUsd?: number;
    /** Solana transaction cost in USD (default: 0.01) */
    solanaTxCostUsd?: number;
    /** Latency risk premium as decimal (default: 0.002 = 0.2%) */
    latencyRiskPremium?: number;
  };
}

/**
 * Redis Streams client interface for opportunity publishing.
 * Matches the subset of RedisStreamsClient methods used.
 */
export interface SolanaArbitrageStreamsClient {
  xadd(stream: string, data: Record<string, string>): Promise<string | null>;
}

/**
 * Dependencies for SolanaArbitrageDetector.
 */
export interface SolanaArbitrageDeps {
  logger?: SolanaArbitrageLogger;
  /** Optional Redis Streams client for opportunity publishing */
  streamsClient?: SolanaArbitrageStreamsClient;
}

/**
 * Solana token info in a pool.
 */
export interface SolanaTokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

/**
 * Solana pool information.
 *
 * Compatibility: This interface is designed to be compatible with
 * SolanaPool from shared/core/src/solana/solana-detector.ts.
 * Pools from SolanaDetector can be passed directly to SolanaArbitrageDetector.
 *
 * Fee Documentation (Issue 6.2):
 * The `fee` field is in basis points (1 basis point = 0.01%).
 * Example: fee=25 means 0.25% trading fee.
 * Use basisPointsToDecimal(fee) to convert to decimal (25 → 0.0025).
 */
export interface SolanaPoolInfo {
  address: string;
  programId: string;
  dex: string;
  token0: SolanaTokenInfo;
  token1: SolanaTokenInfo;
  /** Trading fee in basis points (e.g., 25 = 0.25% = 25/10000) */
  fee: number;
  reserve0?: string;
  reserve1?: string;
  price?: number;
  lastSlot?: number;
  /** Timestamp when price was last updated (ms since epoch) */
  lastUpdated?: number;
}

/**
 * Internal pool representation with pre-computed normalized tokens.
 * Performance optimization (Issue 10.2): Pre-normalize on pool add.
 */
interface InternalPoolInfo extends SolanaPoolInfo {
  /** Pre-normalized token0 symbol */
  normalizedToken0: string;
  /** Pre-normalized token1 symbol */
  normalizedToken1: string;
  /** Pre-computed pair key for fast lookup */
  pairKey: string;
}

/**
 * EVM price update for cross-chain comparison.
 *
 * Event Type Adapter (Issue 1.1):
 * UnifiedChainDetector emits PriceUpdate events with this shape.
 * The connectToSolanaDetector() method adapts these to pool updates.
 */
export interface EvmPriceUpdate {
  pairKey: string;
  chain: string;
  dex: string;
  token0: string;
  token1: string;
  price: number;
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  timestamp: number;
  latency: number;
  fee?: number;
}

/**
 * Generic price update from UnifiedChainDetector.
 * Issue 1.1 Fix: Define the actual interface emitted by UnifiedChainDetector.
 */
export interface UnifiedPriceUpdate {
  chain: string;
  dex: string;
  pairKey: string;
  token0: string;
  token1: string;
  price: number;
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  timestamp: number;
  latency: number;
  fee?: number;
}

/**
 * Solana arbitrage opportunity.
 *
 * Token Semantics:
 * - token0/token1: Normalized canonical symbols (e.g., 'SOL', 'USDC', 'WETH')
 *   - Liquid staking tokens are normalized (MSOL→SOL, JITOSOL→SOL)
 *   - Bridged tokens are normalized (WETH.e→WETH)
 *   - Use these for display and cross-chain matching
 * - buyPair/sellPair: Pool/pair addresses or identifiers
 *   - Solana: Pool program address
 *   - EVM (cross-chain): Pair key string
 */
export interface SolanaArbitrageOpportunity {
  id: string;
  type: 'intra-solana' | 'triangular' | 'cross-chain';
  chain: string;
  buyDex: string;
  sellDex: string;
  /** Pool/pair address for buy side (Solana address or EVM pair key) */
  buyPair: string;
  /** Pool/pair address for sell side (Solana address or EVM pair key) */
  sellPair: string;
  /** Normalized base token symbol (e.g., 'SOL', 'WETH') */
  token0: string;
  /** Normalized quote token symbol (e.g., 'USDC', 'USDT') */
  token1: string;
  buyPrice: number;
  sellPrice: number;
  profitPercentage: number;
  expectedProfit: number;
  netProfitAfterGas?: number;
  estimatedGasCost?: number;
  confidence: number;
  timestamp: number;
  expiresAt: number;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  // Cross-chain specific
  sourceChain?: string;
  targetChain?: string;
  direction?: 'buy-solana-sell-evm' | 'buy-evm-sell-solana';
  token?: string;      // Base token (e.g., SOL) for cross-chain
  quoteToken?: string; // Quote token (e.g., USDC) for cross-chain
  // Triangular specific
  path?: TriangularPathStep[];
  estimatedOutput?: number;
}

/**
 * Step in a triangular arbitrage path.
 *
 * Fee Format Note (P2-FIX):
 * The `fee` field is in DECIMAL format (not basis points), as it's already
 * converted via basisPointsToDecimal() when building the adjacency graph.
 * - 0.003 = 0.3% (typical AMM fee)
 * - 0.0025 = 0.25% (Raydium default)
 */
export interface TriangularPathStep {
  token: string;
  pool: string;
  dex: string;
  price: number;
  /** Fee in DECIMAL format (0.003 = 0.3%) - already converted from basis points */
  fee: number;
}

/**
 * Complete triangular path.
 */
export interface TriangularPath {
  steps: TriangularPathStep[];
  inputToken: string;
  outputToken: string;
  profitPercentage: number;
  estimatedOutput: number;
}

/**
 * Cross-chain price comparison result.
 * P1-FIX: Added fee fields for accurate profit calculation in detection.
 */
export interface CrossChainPriceComparison {
  token: string;
  quoteToken: string;
  solanaPrice: number;
  solanaDex: string;
  solanaPoolAddress: string;
  evmChain: string;
  evmDex: string;
  evmPrice: number;
  evmPairKey: string;
  priceDifferencePercent: number;
  timestamp: number;
  /** Solana pool fee in basis points (e.g., 30 = 0.3%) */
  solanaFee?: number;
  /** EVM pool fee in basis points (may be undefined) */
  evmFee?: number;
}

/**
 * Priority fee estimation.
 *
 * Limitation Note (Issue 7.3):
 * This is a calculated estimate based on config parameters.
 * For production use, consider fetching live priority fees from
 * getRecentPrioritizationFees() RPC method.
 */
export interface PriorityFeeEstimate {
  baseFee: number;
  priorityFee: number;
  totalFee: number;
  computeUnits: number;
  microLamportsPerCu: number;
}

/**
 * Priority fee estimation request.
 */
export interface PriorityFeeRequest {
  computeUnits: number;
  urgency: 'low' | 'medium' | 'high';
}

/**
 * Arbitrage detection statistics.
 */
export interface SolanaArbitrageStats {
  totalDetections: number;
  intraSolanaOpportunities: number;
  triangularOpportunities: number;
  crossChainOpportunities: number;
  poolsTracked: number;
  lastDetectionTime: number;
  /** Number of pools skipped due to stale prices */
  stalePoolsSkipped: number;
  /** Average detection latency in ms */
  avgDetectionLatencyMs: number;
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Union type for detector event handlers.
 * These handlers are created internally and used for EventEmitter.on/off.
 */
type PoolUpdateHandler = (update: UnifiedPriceUpdate | SolanaPoolInfo) => void;
type PoolRemovedHandler = (address: string) => void;
type DetectorEventHandler = PoolUpdateHandler | PoolRemovedHandler;

/**
 * Stored listener reference for cleanup.
 * Tracks event name and handler so we can properly remove listeners on stop().
 */
interface DetectorListenerRef {
  event: string;
  handler: DetectorEventHandler;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG = {
  chainId: 'solana',
  minProfitThreshold: 0.3, // 0.3%
  priorityFeeMultiplier: 1.0,
  basePriorityFeeLamports: 10000, // 0.00001 SOL
  crossChainEnabled: true,
  triangularEnabled: true,
  maxTriangularDepth: 3,
  opportunityExpiryMs: 1000, // 1 second (Solana is fast)
  priceStalenessMs: 5000, // 5 seconds
  defaultTradeValueUsd: 1000,
  // BUG-FIX: Default true for backward compatibility with cross-chain matching
  normalizeLiquidStaking: true,
  // P1-FIX: Cross-chain costs now configurable
  crossChainCosts: {
    bridgeFeeDefault: 0.001, // 0.1%
    evmGasCostUsd: 15, // ~150k gas at 30 gwei, ETH ~$3000
    solanaTxCostUsd: 0.01, // ~5000 compute units at priority
    latencyRiskPremium: 0.002, // 0.2% price movement risk during bridge
  },
} as const;

// Compute unit estimates for different operations
const COMPUTE_UNITS = {
  SIMPLE_SWAP: 150000,
  CLMM_SWAP: 300000,
  TRIANGULAR_BASE: 400000,
} as const;

// Urgency multipliers for priority fees
const URGENCY_MULTIPLIERS = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
} as const;

/**
 * Confidence scores for different arbitrage types.
 *
 * These values represent the estimated reliability of the arbitrage opportunity:
 * - INTRA_SOLANA (0.85): Highest confidence - same chain, fast execution
 * - TRIANGULAR (0.75): Medium confidence - multiple hops increase slippage risk
 * - CROSS_CHAIN (0.6): Lower confidence - bridge delays, price volatility
 */
const CONFIDENCE_SCORES = {
  INTRA_SOLANA: 0.85,
  TRIANGULAR: 0.75,
  CROSS_CHAIN: 0.6,
} as const;

/**
 * Cross-chain opportunities need longer expiry due to bridge delays.
 * Standard expiry is ~1s for Solana, cross-chain gets 10s (10x multiplier).
 */
const CROSS_CHAIN_EXPIRY_MULTIPLIER = 10;

/**
 * Maximum paths to explore per level during triangular path finding.
 * Prevents exponential blowup in dense liquidity graphs.
 */
const MAX_PATHS_PER_LEVEL = 100;

/**
 * Maximum size for memoization cache in path finding.
 * Issue 4.5 Fix: Bound memoization cache to prevent memory leaks.
 */
const MAX_MEMO_CACHE_SIZE = 10000;

/**
 * Minimum valid price value.
 * Issue 4.3 Fix: Prevent division by zero and precision issues.
 */
const MIN_VALID_PRICE = 1e-12;

/**
 * LRU cache size for normalized tokens.
 */
const MAX_TOKEN_CACHE_SIZE = 10000;

/**
 * Maximum number of pools in VersionedPoolStore.
 * BUG-FIX: Prevent unbounded cache growth causing OOM.
 * 50,000 pools is generous for most Solana DEX scenarios.
 */
const MAX_POOL_STORE_SIZE = 50000;

/**
 * Circuit breaker configuration for detection methods.
 * BUG-FIX: Prevent wasted resources from repeated failures.
 */
const CIRCUIT_BREAKER = {
  /** Number of consecutive failures before circuit opens */
  FAILURE_THRESHOLD: 5,
  /** Time in ms before attempting to close circuit (half-open state) */
  RESET_TIMEOUT_MS: 30000, // 30 seconds
} as const;

/**
 * Maximum pool comparisons per pair for O(n²) detection.
 * BUG-FIX: Prevent performance degradation with many pools per pair.
 * With 100 pools: 100*99/2 = 4950 comparisons, limit to prevent CPU spikes.
 */
const MAX_COMPARISONS_PER_PAIR = 500;

/**
 * Default SOL price fallback in USD.
 * P1-FIX: Used when price oracle doesn't have SOL price.
 * Conservative estimate - actual price should come from oracle.
 */
const DEFAULT_SOL_PRICE_USD = 100;

/**
 * Redis publishing retry configuration.
 * BUG-FIX: Add retry mechanism for transient Redis failures.
 */
const REDIS_RETRY = {
  /** Maximum number of retry attempts */
  MAX_ATTEMPTS: 3,
  /** Base delay in ms between retries (doubles each attempt) */
  BASE_DELAY_MS: 50,
  /** Number of consecutive failures before disabling publishing */
  FAILURE_THRESHOLD: 10,
  /** Time in ms before re-enabling publishing after threshold reached */
  COOLDOWN_MS: 60000, // 1 minute
} as const;

/**
 * Cross-chain bridge fee estimates.
 * BUG-FIX: Include bridge costs in cross-chain profit calculations.
 * These are conservative estimates - actual fees vary by bridge and amount.
 */
const CROSS_CHAIN_COSTS = {
  /** Default bridge fee as decimal (0.1% = 0.001) */
  BRIDGE_FEE_DEFAULT: 0.001,
  /** Estimated EVM gas cost in USD for a swap (~150k gas at 30 gwei, ETH ~$3000) */
  EVM_GAS_COST_USD: 15,
  /** Estimated Solana transaction cost in USD (~5000 compute units at priority) */
  SOLANA_TX_COST_USD: 0.01,
  /** Bridge latency risk premium (price can move during bridge) */
  LATENCY_RISK_PREMIUM: 0.002, // 0.2%
} as const;

/**
 * Token decimals registry for common Solana tokens.
 * BUG-FIX: Avoid hardcoded decimals in UnifiedPriceUpdate adapter.
 * Most SPL tokens use 6 or 9 decimals.
 */
const TOKEN_DECIMALS: Record<string, number> = {
  // Native and wrapped SOL
  SOL: 9,
  WSOL: 9,
  // Stablecoins (typically 6 decimals like USDC)
  USDC: 6,
  USDT: 6,
  DAI: 18, // DAI uses 18 on all chains
  BUSD: 18,
  USDH: 6,
  // Major tokens
  BTC: 8,
  WBTC: 8,
  ETH: 18,
  WETH: 18,
  // Solana ecosystem tokens
  JUP: 6,
  RAY: 6,
  ORCA: 6,
  MNDE: 9,
  // Liquid staking tokens
  MSOL: 9,
  JITOSOL: 9,
  STSOL: 9,
  BSOL: 9,
  // Default for unknown tokens
  DEFAULT: 9,
} as const;

/**
 * Get decimals for a token symbol.
 * BUG-FIX: Provides consistent decimal handling.
 */
function getTokenDecimals(symbol: string): number {
  const upperSymbol = symbol.toUpperCase();
  return TOKEN_DECIMALS[upperSymbol] ?? TOKEN_DECIMALS.DEFAULT;
}

/**
 * Liquid staking tokens that can be optionally excluded from normalization.
 * BUG-FIX: These tokens have different values from SOL and shouldn't be
 * automatically treated as equivalent for intra-chain arbitrage.
 */
const LIQUID_STAKING_TOKENS = new Set([
  'MSOL',
  'JITOSOL',
  'STSOL',
  'BSOL',
  'LSOL',
  'SCNSOL',
  'CGTSOL',
  'LAINESOL',
  'EDGESOL',
  'COMPASSSOL',
]);

/**
 * Regex pattern for validating Solana addresses.
 * Solana addresses are base58-encoded public keys (32 bytes = 43-44 chars).
 * BUG-FIX: Validate addresses to prevent injection attacks via Redis keys or logs.
 */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Regex pattern for valid test/mock pool addresses.
 * Allows alphanumeric strings with hyphens for testing purposes.
 * These are valid for in-memory operations but not for on-chain transactions.
 */
const TEST_ADDRESS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/;

/**
 * Validate a pool address format for internal use.
 * P3-FIX: Renamed from isValidSolanaAddress to accurately reflect its purpose.
 *
 * BUG-FIX: Security - validate addresses before using in Redis keys or operations.
 *
 * Accepts:
 * - Valid base58 Solana addresses (32-44 chars) - for real pool addresses
 * - Test/mock addresses (alphanumeric with hyphens) - for testing purposes
 *
 * Does NOT accept:
 * - pairKey-style addresses (checked separately with ':' check in addPool)
 * - Addresses with special characters that could cause injection
 * - Empty or non-string values
 *
 * @param address - The address string to validate
 * @returns true if the address is valid for use
 */
function isValidPoolAddress(address: string): boolean {
  if (typeof address !== 'string' || !address) {
    return false;
  }
  // Accept valid base58 Solana addresses
  if (SOLANA_ADDRESS_REGEX.test(address)) {
    return true;
  }
  // Accept test/mock addresses (alphanumeric with hyphens only)
  // This allows addresses like 'pool-abc123' for testing
  if (TEST_ADDRESS_REGEX.test(address)) {
    return true;
  }
  return false;
}

/**
 * Sanitize a token symbol to prevent injection.
 * BUG-FIX: Remove special characters that could cause issues in Redis keys or logs.
 *
 * @param symbol - The token symbol to sanitize
 * @returns Sanitized symbol containing only alphanumeric, dot, and hyphen
 */
function sanitizeTokenSymbol(symbol: string): string {
  if (typeof symbol !== 'string') {
    return '';
  }
  // Keep only alphanumeric, dots, and hyphens (common in bridged tokens like WETH.e)
  return symbol.replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 20); // Limit length too
}

// =============================================================================
// LRU Cache Implementation
// =============================================================================

/**
 * Simple LRU (Least Recently Used) cache.
 * Issue 4.2 Fix: Proper cache eviction based on usage.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // If key exists, delete to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// =============================================================================
// Circular Buffer for Latency Tracking
// =============================================================================

/**
 * Efficient circular buffer for numeric samples.
 * BUG-FIX: Replace O(n) array shift with O(1) circular buffer.
 * Uses Float64Array for memory efficiency and cache locality.
 */
class CircularBuffer {
  private readonly buffer: Float64Array;
  private readonly maxSize: number;
  private index = 0;
  private count = 0;
  private sum = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer = new Float64Array(maxSize);
  }

  /**
   * Add a value to the buffer (O(1) operation).
   */
  push(value: number): void {
    // If buffer is full, subtract the value being overwritten from sum
    if (this.count === this.maxSize) {
      this.sum -= this.buffer[this.index];
    } else {
      this.count++;
    }

    // Add new value
    this.buffer[this.index] = value;
    this.sum += value;

    // Move to next position (circular)
    this.index = (this.index + 1) % this.maxSize;
  }

  /**
   * Get the average of all values in the buffer (O(1) operation).
   */
  average(): number {
    if (this.count === 0) return 0;
    return this.sum / this.count;
  }

  /**
   * Get current number of samples in buffer.
   */
  get size(): number {
    return this.count;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer.fill(0);
    this.index = 0;
    this.count = 0;
    this.sum = 0;
  }
}

// =============================================================================
// Versioned Pool Store
// =============================================================================

/**
 * Versioned pool store for efficient snapshotting.
 * Issue 10.1 Fix: Avoid deep copying on every detection.
 * BUG-FIX: Added size limit to prevent unbounded growth causing OOM.
 * BUG-FIX: Optimized delete() to O(1) by not removing from insertionOrder.
 *
 * Uses a version counter to track changes. Detection methods
 * work on a "logical snapshot" by checking version at start.
 */
class VersionedPoolStore {
  private pools = new Map<string, InternalPoolInfo>();
  private poolsByPair = new Map<string, Set<string>>();
  private version = 0;
  private readonly maxSize: number;
  /**
   * Track insertion order for LRU eviction using a Set for O(1) membership checks.
   * BUG-FIX: Use Set instead of array to avoid O(n) indexOf/splice operations.
   * Eviction order is maintained by iterating the Set (ES6 Sets preserve insertion order).
   */
  private insertionOrder = new Set<string>();

  constructor(maxSize: number = MAX_POOL_STORE_SIZE) {
    this.maxSize = maxSize;
  }

  getVersion(): number {
    return this.version;
  }

  set(pool: InternalPoolInfo): void {
    const existing = this.pools.get(pool.address);

    // BUG-FIX: Enforce size limit with LRU eviction
    if (!existing && this.pools.size >= this.maxSize) {
      this.evictOldestPool();
    }

    this.pools.set(pool.address, pool);

    // Update insertion order for LRU tracking
    // BUG-FIX: For Set, if key exists we need to delete and re-add to move to end
    if (existing) {
      // Move to end (most recently used) by re-adding
      this.insertionOrder.delete(pool.address);
    }
    this.insertionOrder.add(pool.address);

    // Update pair index
    if (!existing || existing.pairKey !== pool.pairKey) {
      // Remove from old pair index if different
      if (existing && existing.pairKey !== pool.pairKey) {
        this.poolsByPair.get(existing.pairKey)?.delete(pool.address);
      }
      // Add to new pair index
      if (!this.poolsByPair.has(pool.pairKey)) {
        this.poolsByPair.set(pool.pairKey, new Set());
      }
      this.poolsByPair.get(pool.pairKey)!.add(pool.address);
    }

    this.version++;
  }

  /**
   * Evict the oldest pool to make room for new entries.
   * BUG-FIX: Use Set iterator for O(1) access to oldest entry.
   * BUG-FIX: Added defensive check for empty set to prevent silent failures.
   */
  private evictOldestPool(): void {
    // BUG-FIX: Defensive check for empty set
    if (this.insertionOrder.size === 0) {
      // This should never happen if size limit is enforced correctly,
      // but log warning for debugging if it does occur
      return;
    }

    // Get the first (oldest) entry from the Set
    const oldest = this.insertionOrder.values().next().value;
    if (oldest !== undefined) {
      this.deleteInternal(oldest);
      this.insertionOrder.delete(oldest);
    }
  }

  get(address: string): InternalPoolInfo | undefined {
    return this.pools.get(address);
  }

  /**
   * Delete a pool from the store.
   * BUG-FIX: O(1) operation using Set.delete() instead of array indexOf/splice.
   */
  delete(address: string): boolean {
    const result = this.deleteInternal(address);
    if (result) {
      // O(1) removal from Set
      this.insertionOrder.delete(address);
    }
    return result;
  }

  private deleteInternal(address: string): boolean {
    const pool = this.pools.get(address);
    if (!pool) return false;

    this.poolsByPair.get(pool.pairKey)?.delete(address);
    this.pools.delete(address);
    this.version++;
    return true;
  }

  get size(): number {
    return this.pools.size;
  }

  /**
   * Get pools iterator for a pair key.
   * Returns current pools - caller should handle concurrency.
   */
  getPoolsForPair(pairKey: string): InternalPoolInfo[] {
    const addresses = this.poolsByPair.get(pairKey);
    if (!addresses) return [];

    const result: InternalPoolInfo[] = [];
    for (const addr of addresses) {
      const pool = this.pools.get(addr);
      if (pool) result.push(pool);
    }
    return result;
  }

  /**
   * Get all pair keys.
   */
  getPairKeys(): string[] {
    return Array.from(this.poolsByPair.keys());
  }

  /**
   * Get all pools as array (creates copy).
   * P3-FIX: For iteration, prefer poolsIterator() to avoid array allocation.
   */
  getAllPools(): InternalPoolInfo[] {
    return Array.from(this.pools.values());
  }

  /**
   * Get iterator over all pools.
   * P3-FIX: Performance optimization - avoids array allocation for large pool sets.
   * Use this when iterating over all pools instead of getAllPools().
   */
  poolsIterator(): IterableIterator<InternalPoolInfo> {
    return this.pools.values();
  }

  /**
   * Clear all pools (useful for testing and shutdown).
   */
  clear(): void {
    this.pools.clear();
    this.poolsByPair.clear();
    this.insertionOrder.clear();
    this.version++;
  }
}

// =============================================================================
// ID Generator
// =============================================================================

/**
 * Fast ID generator using pre-allocated buffer.
 * Issue 10.6 Fix: Avoid Math.random() in hot path.
 */
class IdGenerator {
  private counter = 0;
  private prefix: string;

  constructor(prefix: string = '') {
    // Use process.pid and timestamp for uniqueness across instances
    this.prefix = prefix || `${process.pid}-${Date.now().toString(36)}`;
  }

  next(type: string): string {
    return `sol-${type}-${this.prefix}-${(++this.counter).toString(36)}`;
  }
}

// =============================================================================
// Opportunity Factory
// =============================================================================

/**
 * Factory for creating arbitrage opportunities.
 * Issue 9.4 Fix: Centralize opportunity creation.
 */
class OpportunityFactory {
  private idGen: IdGenerator;
  private chainId: string;
  private expiryMs: number;

  constructor(chainId: string, expiryMs: number) {
    this.idGen = new IdGenerator();
    this.chainId = chainId;
    this.expiryMs = expiryMs;
  }

  createIntraSolana(
    buyPool: InternalPoolInfo,
    sellPool: InternalPoolInfo,
    netProfit: number,
    gasCost: number
  ): SolanaArbitrageOpportunity {
    const timestamp = Date.now();
    return {
      id: this.idGen.next('arb'),
      type: 'intra-solana',
      chain: this.chainId,
      buyDex: buyPool.dex,
      sellDex: sellPool.dex,
      buyPair: buyPool.address,
      sellPair: sellPool.address,
      token0: buyPool.normalizedToken0,
      token1: buyPool.normalizedToken1,
      buyPrice: buyPool.price!,
      sellPrice: sellPool.price!,
      profitPercentage: netProfit * 100,
      expectedProfit: netProfit,
      estimatedGasCost: gasCost,
      netProfitAfterGas: netProfit - gasCost,
      confidence: CONFIDENCE_SCORES.INTRA_SOLANA,
      timestamp,
      expiresAt: timestamp + this.expiryMs,
      status: 'pending',
    };
  }

  createTriangular(path: TriangularPath): SolanaArbitrageOpportunity {
    const timestamp = Date.now();
    return {
      id: this.idGen.next('tri'),
      type: 'triangular',
      chain: this.chainId,
      buyDex: path.steps[0]?.dex || 'unknown',
      sellDex: path.steps[path.steps.length - 1]?.dex || 'unknown',
      buyPair: path.steps[0]?.pool || '',
      sellPair: path.steps[path.steps.length - 1]?.pool || '',
      token0: path.inputToken,
      token1: path.outputToken,
      buyPrice: path.steps[0]?.price || 0,
      sellPrice: path.steps[path.steps.length - 1]?.price || 0,
      profitPercentage: path.profitPercentage,
      expectedProfit: path.profitPercentage / 100,
      estimatedOutput: path.estimatedOutput,
      path: path.steps,
      confidence: CONFIDENCE_SCORES.TRIANGULAR,
      timestamp,
      expiresAt: timestamp + this.expiryMs,
      status: 'pending',
    };
  }

  createCrossChain(
    comparison: CrossChainPriceComparison,
    direction: 'buy-solana-sell-evm' | 'buy-evm-sell-solana',
    profit: number,
    crossChainExpiryMultiplier: number
  ): SolanaArbitrageOpportunity {
    const timestamp = Date.now();
    const buyPair = direction === 'buy-solana-sell-evm'
      ? comparison.solanaPoolAddress
      : comparison.evmPairKey;
    const sellPair = direction === 'buy-solana-sell-evm'
      ? comparison.evmPairKey
      : comparison.solanaPoolAddress;

    return {
      id: this.idGen.next('xchain'),
      type: 'cross-chain',
      chain: this.chainId,
      sourceChain: this.chainId,
      targetChain: comparison.evmChain,
      direction,
      buyDex: direction === 'buy-solana-sell-evm' ? comparison.solanaDex : comparison.evmDex,
      sellDex: direction === 'buy-solana-sell-evm' ? comparison.evmDex : comparison.solanaDex,
      buyPair,
      sellPair,
      token0: comparison.token,
      token1: comparison.quoteToken,
      token: comparison.token,
      quoteToken: comparison.quoteToken,
      buyPrice: direction === 'buy-solana-sell-evm' ? comparison.solanaPrice : comparison.evmPrice,
      sellPrice: direction === 'buy-solana-sell-evm' ? comparison.evmPrice : comparison.solanaPrice,
      profitPercentage: profit * 100,
      expectedProfit: profit,
      confidence: CONFIDENCE_SCORES.CROSS_CHAIN,
      timestamp,
      expiresAt: timestamp + this.expiryMs * crossChainExpiryMultiplier,
      status: 'pending',
    };
  }
}

// =============================================================================
// SolanaArbitrageDetector Class
// =============================================================================

/**
 * Solana-specific arbitrage detector.
 * Extends EventEmitter for opportunity and price update events.
 */
export class SolanaArbitrageDetector extends EventEmitter {
  // Configuration
  private readonly config: Required<Omit<SolanaArbitrageConfig, 'rpcUrl'>> & { rpcUrl?: string };
  private readonly logger: SolanaArbitrageLogger;

  // Redis Streams client for opportunity publishing
  private streamsClient?: SolanaArbitrageStreamsClient;
  private static readonly OPPORTUNITY_STREAM = 'arbitrage:opportunities';

  // Pool management with versioned store (Issue 10.1)
  private readonly poolStore = new VersionedPoolStore();

  // Normalized token cache with LRU eviction (Issue 4.2)
  private readonly tokenCache = new LRUCache<string, string>(MAX_TOKEN_CACHE_SIZE);

  // Opportunity factory (Issue 9.4)
  private opportunityFactory!: OpportunityFactory;

  // Statistics with atomic-like updates (Issue 5.2)
  private stats: SolanaArbitrageStats = {
    totalDetections: 0,
    intraSolanaOpportunities: 0,
    triangularOpportunities: 0,
    crossChainOpportunities: 0,
    poolsTracked: 0,
    lastDetectionTime: 0,
    stalePoolsSkipped: 0,
    avgDetectionLatencyMs: 0,
  };
  /**
   * BUG-FIX: Use CircularBuffer instead of array for O(1) latency tracking.
   * Previously used array.push/shift which was O(n) for shift operations.
   */
  private static readonly MAX_LATENCY_SAMPLES = 100;
  private detectionLatencies = new CircularBuffer(SolanaArbitrageDetector.MAX_LATENCY_SAMPLES);

  // State
  private running = false;

  // BUG-FIX: Circuit breaker state for detection methods
  // BUG-FIX: Added inHalfOpenState to prevent multiple concurrent half-open attempts
  private circuitBreaker = {
    failures: 0,
    lastFailureTime: 0,
    isOpen: false,
    /** Flag to prevent multiple concurrent detection attempts during half-open state */
    inHalfOpenState: false,
  };

  // BUG-FIX: Redis publishing failure tracking for retry mechanism
  private redisPublishState = {
    consecutiveFailures: 0,
    lastFailureTime: 0,
    isDisabled: false,
  };

  // P2-FIX: Store connected detector and listener references for cleanup
  private connectedDetector: EventEmitter | null = null;
  private detectorListeners: DetectorListenerRef[] = [];

  constructor(config: SolanaArbitrageConfig = {}, deps?: SolanaArbitrageDeps) {
    super();

    // Validate rpcUrl - required per TDD test expectations
    if (config.rpcUrl !== undefined && config.rpcUrl.trim() === '') {
      throw new Error('rpcUrl cannot be empty. Provide a valid Solana RPC URL.');
    }

    // Validate config (Issue 3.2)
    this.validateConfig(config);

    // Set defaults
    this.config = {
      rpcUrl: config.rpcUrl,
      chainId: config.chainId ?? DEFAULT_CONFIG.chainId,
      minProfitThreshold: config.minProfitThreshold ?? DEFAULT_CONFIG.minProfitThreshold,
      priorityFeeMultiplier: config.priorityFeeMultiplier ?? DEFAULT_CONFIG.priorityFeeMultiplier,
      basePriorityFeeLamports: config.basePriorityFeeLamports ?? DEFAULT_CONFIG.basePriorityFeeLamports,
      crossChainEnabled: config.crossChainEnabled ?? DEFAULT_CONFIG.crossChainEnabled,
      triangularEnabled: config.triangularEnabled ?? DEFAULT_CONFIG.triangularEnabled,
      maxTriangularDepth: config.maxTriangularDepth ?? DEFAULT_CONFIG.maxTriangularDepth,
      opportunityExpiryMs: config.opportunityExpiryMs ?? DEFAULT_CONFIG.opportunityExpiryMs,
      priceStalenessMs: config.priceStalenessMs ?? DEFAULT_CONFIG.priceStalenessMs,
      defaultTradeValueUsd: config.defaultTradeValueUsd ?? DEFAULT_CONFIG.defaultTradeValueUsd,
      normalizeLiquidStaking: config.normalizeLiquidStaking ?? DEFAULT_CONFIG.normalizeLiquidStaking,
      // P1-FIX: Merge cross-chain costs with defaults
      crossChainCosts: {
        bridgeFeeDefault: config.crossChainCosts?.bridgeFeeDefault ?? DEFAULT_CONFIG.crossChainCosts.bridgeFeeDefault,
        evmGasCostUsd: config.crossChainCosts?.evmGasCostUsd ?? DEFAULT_CONFIG.crossChainCosts.evmGasCostUsd,
        solanaTxCostUsd: config.crossChainCosts?.solanaTxCostUsd ?? DEFAULT_CONFIG.crossChainCosts.solanaTxCostUsd,
        latencyRiskPremium: config.crossChainCosts?.latencyRiskPremium ?? DEFAULT_CONFIG.crossChainCosts.latencyRiskPremium,
      },
    };

    // Initialize factory
    this.opportunityFactory = new OpportunityFactory(
      this.config.chainId,
      this.config.opportunityExpiryMs
    );

    // Setup logger
    this.logger = deps?.logger ?? {
      info: console.log,
      warn: console.warn,
      error: console.error,
      debug: () => {},
    };

    // Store optional Redis Streams client
    this.streamsClient = deps?.streamsClient;

    this.logger.info('SolanaArbitrageDetector initialized', {
      chainId: this.config.chainId,
      minProfitThreshold: this.config.minProfitThreshold,
      crossChainEnabled: this.config.crossChainEnabled,
      triangularEnabled: this.config.triangularEnabled,
      hasStreamsClient: !!this.streamsClient,
    });
  }

  /**
   * Validate configuration values.
   * Issue 3.2 Fix: Validate environment variable values.
   */
  private validateConfig(config: SolanaArbitrageConfig): void {
    if (config.minProfitThreshold !== undefined) {
      if (isNaN(config.minProfitThreshold) || config.minProfitThreshold < 0) {
        throw new Error(`Invalid minProfitThreshold: ${config.minProfitThreshold}. Must be >= 0.`);
      }
    }
    if (config.maxTriangularDepth !== undefined) {
      if (!Number.isInteger(config.maxTriangularDepth) || config.maxTriangularDepth < 2) {
        throw new Error(`Invalid maxTriangularDepth: ${config.maxTriangularDepth}. Must be integer >= 2.`);
      }
    }
    if (config.opportunityExpiryMs !== undefined) {
      if (!Number.isInteger(config.opportunityExpiryMs) || config.opportunityExpiryMs <= 0) {
        throw new Error(`Invalid opportunityExpiryMs: ${config.opportunityExpiryMs}. Must be positive integer.`);
      }
    }
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  getConfig(): Readonly<typeof this.config> {
    return { ...this.config };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info('SolanaArbitrageDetector started');
    this.emit('started');
  }

  async stop(): Promise<void> {
    // P0-FIX: Always clean up event listeners, even if detector wasn't running
    // This prevents memory leaks from connectToSolanaDetector() calls before start()
    if (this.connectedDetector && this.detectorListeners.length > 0) {
      for (const { event, handler } of this.detectorListeners) {
        this.connectedDetector.off(event, handler);
      }
      this.detectorListeners = [];
      this.connectedDetector = null;
      this.logger.debug('Cleaned up detector event listeners');
    }

    // Clear caches to prevent memory leaks
    this.tokenCache.clear();

    if (!this.running) return;
    this.running = false;

    this.logger.info('SolanaArbitrageDetector stopped');
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ===========================================================================
  // Pool Management
  // ===========================================================================

  /**
   * Add a pool to tracking.
   * Pre-normalizes tokens for performance (Issue 10.2).
   * BUG-FIX: Added address validation and token sanitization.
   * P1-FIX: Added fee validation (0-10000 basis points).
   *
   * Architecture Decision: Synchronous pool management
   * - Node.js is single-threaded, no need for mutex on in-memory data
   * - ARCHITECTURE_V2.md requires <1ms for price matrix updates
   * - TDD tests expect synchronous behavior
   *
   * Address Format Support:
   * This method accepts three address formats for flexibility:
   * 1. **Base58 Solana addresses** (32-44 chars): Real on-chain pool addresses
   *    Example: "So11111111111111111111111111111111111111112"
   * 2. **Test/mock addresses** (alphanumeric with hyphens): For unit testing
   *    Example: "pool-abc123", "raydium-sol-usdc"
   * 3. **PairKey-style addresses** (contain ":"): From UnifiedPriceUpdate adapter
   *    Example: "ethereum:uniswap:WETH-USDC"
   *
   * Invalid addresses are logged and silently skipped to prevent injection attacks.
   */
  addPool(pool: SolanaPoolInfo): void {
    // Validate address format - accepts base58, test addresses, and pairKey format
    // See JSDoc above for supported formats
    if (!isValidPoolAddress(pool.address) && !pool.address.includes(':')) {
      this.logger.warn('Invalid pool address format, skipping', {
        address: pool.address?.slice(0, 50), // Truncate for safety
      });
      return;
    }

    // P1-FIX: Validate fee is within valid range (0-10000 basis points)
    // Invalid fees would cause incorrect profit calculations
    if (!this.isValidFee(pool.fee)) {
      this.logger.warn('Invalid pool fee, skipping', {
        address: pool.address,
        fee: pool.fee,
        validRange: '0-10000 basis points',
      });
      return;
    }

    // BUG-FIX: Sanitize token symbols to prevent injection
    const sanitizedToken0Symbol = sanitizeTokenSymbol(pool.token0.symbol);
    const sanitizedToken1Symbol = sanitizeTokenSymbol(pool.token1.symbol);

    if (!sanitizedToken0Symbol || !sanitizedToken1Symbol) {
      this.logger.warn('Invalid token symbols, skipping pool', {
        address: pool.address,
        token0: pool.token0.symbol,
        token1: pool.token1.symbol,
      });
      return;
    }

    // Pre-normalize tokens (Issue 10.2)
    const normalizedToken0 = this.getNormalizedToken(sanitizedToken0Symbol);
    const normalizedToken1 = this.getNormalizedToken(sanitizedToken1Symbol);
    const pairKey = this.createPairKeyFromNormalized(normalizedToken0, normalizedToken1);

    const internalPool: InternalPoolInfo = {
      ...pool,
      // BUG-FIX: Use sanitized symbols in stored pool
      token0: { ...pool.token0, symbol: sanitizedToken0Symbol },
      token1: { ...pool.token1, symbol: sanitizedToken1Symbol },
      normalizedToken0,
      normalizedToken1,
      pairKey,
      lastUpdated: pool.lastUpdated ?? Date.now(),
    };

    this.poolStore.set(internalPool);
    this.updatePoolStats();

    this.logger.debug('Pool added', { address: pool.address, dex: pool.dex, pairKey });
  }

  /**
   * Remove a pool from tracking.
   * Synchronous for Node.js single-threaded model.
   */
  removePool(address: string): void {
    this.poolStore.delete(address);
    this.updatePoolStats();
  }

  getPool(address: string): SolanaPoolInfo | undefined {
    return this.poolStore.get(address);
  }

  getPoolCount(): number {
    return this.poolStore.size;
  }

  getPoolsByTokenPair(token0: string, token1: string): SolanaPoolInfo[] {
    const pairKey = this.createPairKey(token0, token1);
    return this.poolStore.getPoolsForPair(pairKey);
  }

  /**
   * Update a pool's price.
   * Synchronous for Node.js single-threaded model.
   *
   * Hot-path optimization: Only updates and emits if price actually changed.
   */
  updatePoolPrice(address: string, newPrice: number, lastSlot?: number): void {
    const pool = this.poolStore.get(address);
    if (!pool) {
      this.logger.warn('Cannot update price for non-existent pool', { address });
      return;
    }

    const oldPrice = pool.price;

    // Hot-path optimization: Skip update if price hasn't changed
    // This saves object allocation and event emission for no-op updates
    if (oldPrice === newPrice && !lastSlot) {
      return;
    }

    // Create updated pool (immutable update)
    const updatedPool: InternalPoolInfo = {
      ...pool,
      price: newPrice,
      lastUpdated: Date.now(),
      lastSlot: lastSlot ?? pool.lastSlot,
    };

    this.poolStore.set(updatedPool);

    // Only emit price-update event if price actually changed (not just slot update)
    if (oldPrice !== newPrice) {
      this.emit('price-update', {
        poolAddress: address,
        oldPrice,
        newPrice,
        dex: pool.dex,
        token0: pool.token0.symbol,
        token1: pool.token1.symbol,
      });
    }
  }

  /**
   * Get cached normalized token symbol.
   * Performance optimization with LRU cache (Issue 4.2).
   * BUG-FIX: Respects normalizeLiquidStaking config for LST tokens.
   */
  private getNormalizedToken(symbol: string): string {
    // BUG-FIX: Check if this is a liquid staking token and normalization is disabled
    const upperSymbol = symbol.toUpperCase();
    if (!this.config.normalizeLiquidStaking && LIQUID_STAKING_TOKENS.has(upperSymbol)) {
      // Keep liquid staking tokens distinct for accurate intra-chain arbitrage
      return upperSymbol;
    }

    // Use cache for normalized tokens
    let normalized = this.tokenCache.get(symbol);
    if (normalized === undefined) {
      normalized = normalizeTokenForCrossChain(symbol);
      this.tokenCache.set(symbol, normalized);
    }
    return normalized;
  }

  private createPairKey(token0: string, token1: string): string {
    const normalized0 = this.getNormalizedToken(token0);
    const normalized1 = this.getNormalizedToken(token1);
    return this.createPairKeyFromNormalized(normalized0, normalized1);
  }

  private createPairKeyFromNormalized(token0: string, token1: string): string {
    // Sort for consistency
    const sorted = token0 < token1 ? [token0, token1] : [token1, token0];
    return `${sorted[0]}-${sorted[1]}`;
  }

  private updatePoolStats(): void {
    this.stats.poolsTracked = this.poolStore.size;
  }

  /**
   * Check if a pool's price is stale.
   * Issue 10.7 Fix: Add price staleness check.
   * BUG-FIX: Default to stale when lastUpdated is missing (defensive approach).
   */
  private isPriceStale(pool: InternalPoolInfo): boolean {
    if (!pool.lastUpdated) {
      // BUG-FIX: Missing timestamp should be treated as stale, not fresh
      // This is a defensive approach - pools should always have timestamps
      this.logger.debug('Pool missing lastUpdated timestamp, treating as stale', {
        address: pool.address,
      });
      return true;
    }
    return Date.now() - pool.lastUpdated > this.config.priceStalenessMs;
  }

  /**
   * Check if price is valid (non-zero, not too small).
   * Issue 4.3 Fix: Prevent division by zero.
   */
  private isValidPrice(price: number | undefined): price is number {
    return price !== undefined && price >= MIN_VALID_PRICE && isFinite(price);
  }

  // ===========================================================================
  // Circuit Breaker
  // ===========================================================================

  /**
   * Check if circuit breaker allows detection to proceed.
   * BUG-FIX: Prevent wasted resources from repeated failures.
   * BUG-FIX: Added half-open state tracking to prevent concurrent recovery attempts.
   * P0-FIX: Use compare-and-swap pattern to atomically transition to half-open state,
   *         preventing multiple concurrent detection attempts from bypassing protection.
   */
  private checkCircuitBreaker(): boolean {
    if (!this.circuitBreaker.isOpen) {
      return true; // Circuit closed, allow detection
    }

    // Check if we should try half-open state
    const timeSinceLastFailure = Date.now() - this.circuitBreaker.lastFailureTime;
    if (timeSinceLastFailure >= CIRCUIT_BREAKER.RESET_TIMEOUT_MS) {
      // P0-FIX: Use compare-and-swap pattern to atomically check AND set half-open state
      // This prevents race conditions where multiple async callers could both read
      // inHalfOpenState=false before either sets it to true
      const wasInHalfOpen = this.circuitBreaker.inHalfOpenState;
      if (!wasInHalfOpen) {
        this.circuitBreaker.inHalfOpenState = true;
        this.logger.info('Circuit breaker entering half-open state, attempting detection');
        return true; // Allow one attempt
      }
      // Already in half-open state - another detection is testing the circuit
      this.logger.debug('Circuit breaker already in half-open state, detection in progress');
      return false;
    }

    this.logger.debug('Circuit breaker open, skipping detection', {
      failures: this.circuitBreaker.failures,
      timeUntilRetryMs: CIRCUIT_BREAKER.RESET_TIMEOUT_MS - timeSinceLastFailure,
    });
    return false;
  }

  /**
   * Record a successful detection, resetting the circuit breaker.
   * BUG-FIX: Also resets half-open state flag.
   */
  private recordDetectionSuccess(): void {
    if (this.circuitBreaker.failures > 0 || this.circuitBreaker.isOpen) {
      this.logger.info('Circuit breaker reset after successful detection');
    }
    this.circuitBreaker.failures = 0;
    this.circuitBreaker.isOpen = false;
    // BUG-FIX: Reset half-open state on success
    this.circuitBreaker.inHalfOpenState = false;
  }

  /**
   * Record a failed detection, potentially opening the circuit breaker.
   * BUG-FIX: Also handles half-open state transition on failure.
   */
  private recordDetectionFailure(error: unknown): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    // BUG-FIX: If we were in half-open state and failed, re-open the circuit
    if (this.circuitBreaker.inHalfOpenState) {
      this.circuitBreaker.isOpen = true;
      this.circuitBreaker.inHalfOpenState = false;
      this.logger.warn('Circuit breaker re-opened after half-open attempt failed', {
        failures: this.circuitBreaker.failures,
        resetTimeoutMs: CIRCUIT_BREAKER.RESET_TIMEOUT_MS,
        lastError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (this.circuitBreaker.failures >= CIRCUIT_BREAKER.FAILURE_THRESHOLD) {
      this.circuitBreaker.isOpen = true;
      this.logger.warn('Circuit breaker opened after repeated detection failures', {
        failures: this.circuitBreaker.failures,
        resetTimeoutMs: CIRCUIT_BREAKER.RESET_TIMEOUT_MS,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get circuit breaker status for monitoring.
   * BUG-FIX: Also returns half-open state for complete visibility.
   */
  getCircuitBreakerStatus(): { isOpen: boolean; failures: number; lastFailureTime: number; inHalfOpenState: boolean } {
    return { ...this.circuitBreaker };
  }

  // ===========================================================================
  // Intra-Solana Arbitrage Detection
  // ===========================================================================

  async detectIntraSolanaArbitrage(): Promise<SolanaArbitrageOpportunity[]> {
    // BUG-FIX: Check circuit breaker before proceeding
    if (!this.checkCircuitBreaker()) {
      return [];
    }

    try {
      const startTime = Date.now();
      const opportunities: SolanaArbitrageOpportunity[] = [];
      const thresholdDecimal = this.config.minProfitThreshold / 100;
      let staleSkipped = 0;

      // Get pair keys - no mutex needed for reads (Issue 10.4)
      const pairKeys = this.poolStore.getPairKeys();

      for (const pairKey of pairKeys) {
        // Get pools for this pair
        const pools = this.poolStore.getPoolsForPair(pairKey)
          .filter(p => {
            if (!this.isValidPrice(p.price)) return false;
            if (this.isPriceStale(p)) {
              staleSkipped++;
              return false;
            }
            return true;
          });

        if (pools.length < 2) continue;

        // BUG-FIX: Track comparisons to prevent O(n²) performance issues with many pools
        let comparisons = 0;
        let limitReached = false;

        // Compare all pool pairs with bounded iteration
        for (let i = 0; i < pools.length && !limitReached; i++) {
          for (let j = i + 1; j < pools.length && !limitReached; j++) {
            comparisons++;
            if (comparisons > MAX_COMPARISONS_PER_PAIR) {
              limitReached = true;
              this.logger.debug('Comparison limit reached for pair', {
                pairKey,
                totalPools: pools.length,
                comparisons: comparisons - 1,
                maxComparisons: MAX_COMPARISONS_PER_PAIR,
              });
              break;
            }

            const opportunity = this.calculateOpportunity(pools[i], pools[j], thresholdDecimal);
            if (opportunity) {
              opportunities.push(opportunity);
              this.emit('opportunity', opportunity);
            }
          }
        }
      }

      // Update stats atomically (Issue 5.2)
      this.updateDetectionStats('intra', opportunities.length, staleSkipped, Date.now() - startTime);

      // BUG-FIX: Record successful detection for circuit breaker
      this.recordDetectionSuccess();

      return opportunities;
    } catch (error) {
      // BUG-FIX: Record failure for circuit breaker
      this.recordDetectionFailure(error);
      this.logger.error('Error in intra-Solana arbitrage detection', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate that a fee value is within the valid range for BASIS POINTS format.
   * P1-FIX: Prevent incorrect profit calculations from invalid fee values.
   *
   * Fee Format: This method validates fees in BASIS POINTS (bp):
   * - 1 bp = 0.01% = 0.0001 decimal
   * - 30 bp = 0.3% (typical AMM fee)
   * - 10000 bp = 100% (maximum, would take entire trade)
   *
   * Use basisPointsToDecimal() to convert to decimal for calculations.
   *
   * @param fee - Fee in basis points (0-10000, where 10000 = 100%)
   * @returns true if fee is valid
   */
  private isValidFee(fee: number): boolean {
    return typeof fee === 'number' && isFinite(fee) && fee >= 0 && fee <= 10000;
  }

  /**
   * Validate that a fee value is within the valid range for DECIMAL format.
   * P2-FIX: Separate validation for fees after conversion from basis points.
   *
   * Fee Format: This method validates fees in DECIMAL format:
   * - 0.003 = 0.3% (typical AMM fee)
   * - 1.0 = 100% (maximum, would take entire trade)
   *
   * @param fee - Fee as decimal (0-1, where 1 = 100%)
   * @returns true if fee is valid
   */
  private isValidDecimalFee(fee: number): boolean {
    return typeof fee === 'number' && isFinite(fee) && fee >= 0 && fee < 1;
  }

  private calculateOpportunity(
    pool1: InternalPoolInfo,
    pool2: InternalPoolInfo,
    thresholdDecimal: number
  ): SolanaArbitrageOpportunity | null {
    // Issue 4.3: Already validated in caller, but double-check
    if (!this.isValidPrice(pool1.price) || !this.isValidPrice(pool2.price)) return null;

    // P1-FIX: Validate fees are within valid range (0-10000 basis points)
    // Invalid fees would cause incorrect profit calculations
    if (!this.isValidFee(pool1.fee) || !this.isValidFee(pool2.fee)) {
      this.logger.debug('Invalid fee value detected, skipping opportunity', {
        pool1Address: pool1.address,
        pool1Fee: pool1.fee,
        pool2Address: pool2.address,
        pool2Fee: pool2.fee,
      });
      return null;
    }

    // Calculate price difference
    const minPrice = Math.min(pool1.price, pool2.price);
    const maxPrice = Math.max(pool1.price, pool2.price);
    const grossDiff = (maxPrice - minPrice) / minPrice;

    // Calculate fees
    const fee1 = basisPointsToDecimal(pool1.fee);
    const fee2 = basisPointsToDecimal(pool2.fee);
    const totalFees = fee1 + fee2;

    // Net profit after fees
    const netProfit = grossDiff - totalFees;

    // Check against threshold
    if (!meetsThreshold(netProfit, thresholdDecimal)) {
      return null;
    }

    // Determine buy/sell direction
    const buyPool = pool1.price < pool2.price ? pool1 : pool2;
    const sellPool = pool1.price < pool2.price ? pool2 : pool1;

    // Estimate gas cost (Issue 4.4: Use configurable trade value)
    const gasCost = this.estimateGasCost(COMPUTE_UNITS.SIMPLE_SWAP, this.config.defaultTradeValueUsd);

    return this.opportunityFactory.createIntraSolana(buyPool, sellPool, netProfit, gasCost);
  }

  /**
   * Estimate gas cost as a decimal fraction of trade value.
   * Issue 4.4 Fix: Accept trade value parameter.
   * P1-FIX: Add fallback for missing SOL price.
   */
  private estimateGasCost(computeUnits: number, tradeValueUsd: number): number {
    const feeEstimate = this.calculatePriorityFeeInternal(computeUnits, 'medium');
    const feeInSol = feeEstimate.totalFee / 1e9;
    // P1-FIX: Use fallback if SOL price is unavailable from oracle
    const solPriceUsd = getDefaultPrice('SOL') ?? DEFAULT_SOL_PRICE_USD;
    const feeInUsd = feeInSol * solPriceUsd;
    return feeInUsd / tradeValueUsd;
  }

  // ===========================================================================
  // Triangular Arbitrage Detection
  // ===========================================================================

  async detectTriangularArbitrage(): Promise<SolanaArbitrageOpportunity[]> {
    if (!this.config.triangularEnabled) {
      return [];
    }

    // BUG-FIX: Check circuit breaker before proceeding
    if (!this.checkCircuitBreaker()) {
      return [];
    }

    try {
      const startTime = Date.now();
      const opportunities: SolanaArbitrageOpportunity[] = [];
      const thresholdDecimal = this.config.minProfitThreshold / 100;

      // Build adjacency graph for efficient path finding (Issue 10.3)
      const adjacencyGraph = this.buildAdjacencyGraph();

      // Find triangular paths
      const paths = this.findTriangularPathsOptimized(adjacencyGraph);

      for (const path of paths) {
        if (path.profitPercentage / 100 >= thresholdDecimal) {
          const opportunity = this.opportunityFactory.createTriangular(path);
          opportunities.push(opportunity);
          this.emit('opportunity', opportunity);
        }
      }

      this.updateDetectionStats('triangular', opportunities.length, 0, Date.now() - startTime);

      // BUG-FIX: Record successful detection for circuit breaker
      this.recordDetectionSuccess();

      return opportunities;
    } catch (error) {
      // BUG-FIX: Record failure for circuit breaker
      this.recordDetectionFailure(error);
      this.logger.error('Error in triangular arbitrage detection', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Build adjacency graph for efficient path finding.
   * Issue 10.3 Fix: Pre-compute graph structure.
   */
  private buildAdjacencyGraph(): Map<string, Array<{
    nextToken: string;
    pool: InternalPoolInfo;
    effectivePrice: number;
    fee: number;
  }>> {
    const graph = new Map<string, Array<{
      nextToken: string;
      pool: InternalPoolInfo;
      effectivePrice: number;
      fee: number;
    }>>();

    // P3-FIX: Use iterator instead of getAllPools() to avoid array allocation
    for (const pool of this.poolStore.poolsIterator()) {
      if (!this.isValidPrice(pool.price) || this.isPriceStale(pool)) continue;

      const token0 = pool.normalizedToken0;
      const token1 = pool.normalizedToken1;
      const fee = basisPointsToDecimal(pool.fee);

      // Add edge token0 -> token1
      if (!graph.has(token0)) graph.set(token0, []);
      graph.get(token0)!.push({
        nextToken: token1,
        pool,
        effectivePrice: pool.price!,
        fee,
      });

      // Add edge token1 -> token0 (inverse price)
      // P1-FIX: Check price is valid BEFORE division to prevent NaN/Infinity from zero/tiny prices
      // The isValidPrice check above ensures pool.price >= MIN_VALID_PRICE, but we double-check
      // here since division by very small numbers can still cause precision issues
      if (pool.price && pool.price > MIN_VALID_PRICE) {
        const inversePrice = 1 / pool.price;
        if (isFinite(inversePrice) && inversePrice >= MIN_VALID_PRICE) {
          if (!graph.has(token1)) graph.set(token1, []);
          graph.get(token1)!.push({
            nextToken: token0,
            pool,
            effectivePrice: inversePrice,
            fee,
          });
        }
      }
    }

    return graph;
  }

  /**
   * Optimized triangular path finding using BFS with bounded search.
   * Issue 4.1 Fix: Check for valid completion at any depth.
   * Issue 10.3 Fix: Use pre-computed adjacency graph.
   */
  private findTriangularPathsOptimized(
    graph: Map<string, Array<{
      nextToken: string;
      pool: InternalPoolInfo;
      effectivePrice: number;
      fee: number;
    }>>
  ): TriangularPath[] {
    const paths: TriangularPath[] = [];
    const startTokens = Array.from(graph.keys());

    // Bounded memoization cache (Issue 4.5)
    const visited = new Set<string>();
    let pathsFound = 0;

    for (const startToken of startTokens) {
      if (pathsFound >= MAX_PATHS_PER_LEVEL * 10) break; // Global limit

      // DFS from each start token
      const found = this.dfsPathFinding(
        graph,
        startToken,
        startToken,
        [],
        new Set<string>(),
        0,
        visited
      );

      paths.push(...found);
      pathsFound += found.length;
    }

    return paths;
  }

  private dfsPathFinding(
    graph: Map<string, Array<{
      nextToken: string;
      pool: InternalPoolInfo;
      effectivePrice: number;
      fee: number;
    }>>,
    startToken: string,
    currentToken: string,
    currentPath: TriangularPathStep[],
    visitedPools: Set<string>,
    depth: number,
    globalVisited: Set<string>
  ): TriangularPath[] {
    const paths: TriangularPath[] = [];

    // Issue 4.1 Fix: Check for valid completion at ANY depth >= 3
    if (currentToken === startToken && currentPath.length >= 3) {
      const profitResult = this.calculateTriangularProfit(currentPath);
      if (profitResult && profitResult.profitPercentage > 0) {
        paths.push({
          steps: [...currentPath],
          inputToken: startToken,
          outputToken: startToken,
          profitPercentage: profitResult.profitPercentage,
          estimatedOutput: profitResult.estimatedOutput,
        });
      }
    }

    // Max depth check
    if (depth >= this.config.maxTriangularDepth) {
      return paths;
    }

    // Issue 4.5: Limit global visited to prevent memory leak
    if (globalVisited.size >= MAX_MEMO_CACHE_SIZE) {
      return paths;
    }

    const edges = graph.get(currentToken) || [];
    let pathsAtLevel = 0;

    for (const edge of edges) {
      if (pathsAtLevel >= MAX_PATHS_PER_LEVEL) break;
      if (visitedPools.has(edge.pool.address)) continue;

      // Allow returning to start, but not other revisits
      const tokenVisited = currentPath.some(s => s.token === edge.nextToken);
      if (tokenVisited && edge.nextToken !== startToken) continue;

      const step: TriangularPathStep = {
        token: edge.nextToken,
        pool: edge.pool.address,
        dex: edge.pool.dex,
        price: edge.effectivePrice,
        fee: edge.fee,
      };

      const newVisited = new Set(visitedPools);
      newVisited.add(edge.pool.address);

      const cacheKey = `${startToken}-${edge.nextToken}-${depth}-${edge.pool.address}`;
      if (!globalVisited.has(cacheKey)) {
        globalVisited.add(cacheKey);

        const found = this.dfsPathFinding(
          graph,
          startToken,
          edge.nextToken,
          [...currentPath, step],
          newVisited,
          depth + 1,
          globalVisited
        );

        paths.push(...found);
        pathsAtLevel += found.length;
      }
    }

    return paths;
  }

  /**
   * Calculate profit for a triangular path.
   * BUG-FIX: Added price validation to prevent NaN/infinite values.
   */
  private calculateTriangularProfit(
    path: TriangularPathStep[]
  ): { profitPercentage: number; estimatedOutput: number } | null {
    if (path.length < 3) return null;

    let amount = 1.0;

    for (const step of path) {
      // BUG-FIX: Validate price before using to prevent NaN/infinite values
      if (!this.isValidPrice(step.price)) {
        this.logger.debug('Invalid price in triangular path step', {
          pool: step.pool,
          price: step.price,
        });
        return null;
      }

      // P2-FIX: Validate fee is in valid DECIMAL format (already converted from basis points)
      // TriangularPathStep.fee is decimal (e.g., 0.003 = 0.3%) from basisPointsToDecimal()
      if (!this.isValidDecimalFee(step.fee)) {
        this.logger.debug('Invalid fee in triangular path step', {
          pool: step.pool,
          fee: step.fee,
          expectedFormat: 'decimal (0-1)',
        });
        return null;
      }

      amount = amount * step.price;
      amount = amount * (1 - step.fee);

      // BUG-FIX: Check for overflow/underflow after each step
      if (!isFinite(amount) || amount <= 0) {
        return null;
      }
    }

    const profit = amount - 1;
    if (profit <= 0) return null;

    return {
      profitPercentage: profit * 100,
      estimatedOutput: amount,
    };
  }

  // ===========================================================================
  // Cross-Chain Price Comparison
  // ===========================================================================

  async compareCrossChainPrices(evmPrices: EvmPriceUpdate[]): Promise<CrossChainPriceComparison[]> {
    if (!this.config.crossChainEnabled) {
      return [];
    }

    const comparisons: CrossChainPriceComparison[] = [];

    for (const evmPrice of evmPrices) {
      const evmToken0 = this.getNormalizedToken(evmPrice.token0);
      const evmToken1 = this.getNormalizedToken(evmPrice.token1);
      const evmPairKey = this.createPairKeyFromNormalized(evmToken0, evmToken1);

      const solanaPools = this.poolStore.getPoolsForPair(evmPairKey)
        .filter(p => this.isValidPrice(p.price) && !this.isPriceStale(p));

      for (const solanaPool of solanaPools) {
        // Raw price difference - fees are applied in detectCrossChainArbitrage
        const priceDiff = ((evmPrice.price - solanaPool.price!) / solanaPool.price!) * 100;

        comparisons.push({
          token: solanaPool.normalizedToken0,
          quoteToken: solanaPool.normalizedToken1,
          solanaPrice: solanaPool.price!,
          solanaDex: solanaPool.dex,
          solanaPoolAddress: solanaPool.address,
          evmChain: evmPrice.chain,
          evmDex: evmPrice.dex,
          evmPrice: evmPrice.price,
          evmPairKey: evmPrice.pairKey,
          priceDifferencePercent: priceDiff,
          timestamp: Date.now(),
          // P1-FIX: Store fee info for accurate profit calculation in detection
          solanaFee: solanaPool.fee,
          evmFee: evmPrice.fee,
        });
      }
    }

    return comparisons;
  }

  async detectCrossChainArbitrage(evmPrices: EvmPriceUpdate[]): Promise<SolanaArbitrageOpportunity[]> {
    if (!this.config.crossChainEnabled) {
      return [];
    }

    // BUG-FIX: Check circuit breaker before proceeding
    if (!this.checkCircuitBreaker()) {
      return [];
    }

    try {
      const startTime = Date.now();
      const opportunities: SolanaArbitrageOpportunity[] = [];
      const thresholdDecimal = this.config.minProfitThreshold / 100;

      const comparisons = await this.compareCrossChainPrices(evmPrices);

      for (const comparison of comparisons) {
        // P1-FIX: Calculate net profit after accounting for trading fees on both sides
        const solanaFeeDecimal = comparison.solanaFee !== undefined
          ? basisPointsToDecimal(comparison.solanaFee)
          : 0.003; // Default 0.3%
        const evmFeeDecimal = comparison.evmFee !== undefined
          ? basisPointsToDecimal(comparison.evmFee)
          : 0.003; // Default 0.3%

        // BUG-FIX: Include ALL cross-chain costs, not just trading fees
        // 1. Trading fees on both chains
        const tradingFees = solanaFeeDecimal + evmFeeDecimal;

        // 2. Bridge fee (typically 0.1% of transfer amount)
        // P1-FIX: Now uses configurable value instead of hardcoded constant
        // Defense-in-depth: Use nullish coalescing with fallback to DEFAULT_CONFIG values
        const bridgeFee = this.config.crossChainCosts?.bridgeFeeDefault ?? DEFAULT_CONFIG.crossChainCosts.bridgeFeeDefault;

        // 3. Gas costs as percentage of trade value
        const gasCostPercent = this.estimateCrossChainGasCostPercent();

        // 4. Latency risk premium (price can move during bridge time)
        // P1-FIX: Now uses configurable value instead of hardcoded constant
        // Defense-in-depth: Use nullish coalescing with fallback to DEFAULT_CONFIG values
        const latencyRisk = this.config.crossChainCosts?.latencyRiskPremium ?? DEFAULT_CONFIG.crossChainCosts.latencyRiskPremium;

        // Total costs
        const totalCosts = tradingFees + bridgeFee + gasCostPercent + latencyRisk;

        const grossDiff = Math.abs(comparison.priceDifferencePercent) / 100;
        const netProfit = grossDiff - totalCosts;

        if (!meetsThreshold(netProfit, thresholdDecimal)) {
          continue;
        }

        const direction = comparison.solanaPrice < comparison.evmPrice
          ? 'buy-solana-sell-evm'
          : 'buy-evm-sell-solana';

        const opportunity = this.opportunityFactory.createCrossChain(
          comparison,
          direction,
          netProfit, // BUG-FIX: Net profit now includes all cross-chain costs
          CROSS_CHAIN_EXPIRY_MULTIPLIER
        );

        // BUG-FIX: Add estimated gas cost to opportunity for transparency
        opportunity.estimatedGasCost = gasCostPercent;

        opportunities.push(opportunity);
        this.emit('opportunity', opportunity);
      }

      this.updateDetectionStats('crossChain', opportunities.length, 0, Date.now() - startTime);

      // BUG-FIX: Record successful detection for circuit breaker
      this.recordDetectionSuccess();

      return opportunities;
    } catch (error) {
      // BUG-FIX: Record failure for circuit breaker
      this.recordDetectionFailure(error);
      this.logger.error('Error in cross-chain arbitrage detection', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Estimate cross-chain gas costs as a percentage of trade value.
   * BUG-FIX: Account for gas on both chains in cross-chain arbitrage.
   * P1-FIX: Now uses configurable gas cost values instead of hardcoded constants.
   */
  private estimateCrossChainGasCostPercent(): number {
    // Total gas cost in USD (EVM + Solana)
    // Defense-in-depth: Use nullish coalescing with fallback to DEFAULT_CONFIG values
    const evmGasCost = this.config.crossChainCosts?.evmGasCostUsd ?? DEFAULT_CONFIG.crossChainCosts.evmGasCostUsd;
    const solanaTxCost = this.config.crossChainCosts?.solanaTxCostUsd ?? DEFAULT_CONFIG.crossChainCosts.solanaTxCostUsd;
    const totalGasCostUsd = evmGasCost + solanaTxCost;
    // As percentage of default trade value
    return totalGasCostUsd / this.config.defaultTradeValueUsd;
  }

  // ===========================================================================
  // Priority Fee Estimation
  // ===========================================================================

  async estimatePriorityFee(request: PriorityFeeRequest): Promise<PriorityFeeEstimate> {
    return this.calculatePriorityFeeInternal(request.computeUnits, request.urgency);
  }

  private calculatePriorityFeeInternal(
    computeUnits: number,
    urgency: 'low' | 'medium' | 'high'
  ): PriorityFeeEstimate {
    const urgencyMultiplier = URGENCY_MULTIPLIERS[urgency];
    const baseFee = this.config.basePriorityFeeLamports;

    const microLamportsPerCu = Math.ceil(
      (baseFee * 1e6 / COMPUTE_UNITS.SIMPLE_SWAP) *
      urgencyMultiplier *
      this.config.priorityFeeMultiplier
    );

    const priorityFee = Math.ceil((computeUnits * microLamportsPerCu) / 1e6);
    const totalFee = baseFee + priorityFee;

    return {
      baseFee,
      priorityFee,
      totalFee,
      computeUnits,
      microLamportsPerCu,
    };
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  private updateDetectionStats(
    type: 'intra' | 'triangular' | 'crossChain',
    count: number,
    staleSkipped: number,
    latencyMs: number
  ): void {
    // P3-FIX: Stats updates are NOT truly atomic in JavaScript.
    // However, Node.js single-threaded execution model ensures these assignments
    // complete before any async operation (like I/O or timers) can interrupt.
    // For metrics/monitoring purposes, this is acceptable - exact consistency
    // is not critical for stats counters.
    this.stats.totalDetections++;
    this.stats.lastDetectionTime = Date.now();
    this.stats.stalePoolsSkipped += staleSkipped;

    switch (type) {
      case 'intra':
        this.stats.intraSolanaOpportunities += count;
        break;
      case 'triangular':
        this.stats.triangularOpportunities += count;
        break;
      case 'crossChain':
        this.stats.crossChainOpportunities += count;
        break;
    }

    // BUG-FIX: Use CircularBuffer for O(1) latency tracking instead of O(n) array operations
    this.detectionLatencies.push(latencyMs);
    this.stats.avgDetectionLatencyMs = this.detectionLatencies.average();
  }

  getStats(): SolanaArbitrageStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalDetections: 0,
      intraSolanaOpportunities: 0,
      triangularOpportunities: 0,
      crossChainOpportunities: 0,
      poolsTracked: this.poolStore.size,
      lastDetectionTime: 0,
      stalePoolsSkipped: 0,
      avgDetectionLatencyMs: 0,
    };
    // BUG-FIX: Clear circular buffer instead of creating new array
    this.detectionLatencies.clear();
  }

  /**
   * Get metrics in a format suitable for monitoring systems (e.g., Prometheus).
   * BUG-FIX: Export metrics for observability and alerting.
   *
   * @returns Record of metric names to numeric values
   */
  getMetrics(): Record<string, number> {
    const circuitBreaker = this.getCircuitBreakerStatus();

    return {
      // Pool tracking metrics
      'solana_arbitrage_pools_tracked': this.stats.poolsTracked,
      'solana_arbitrage_pool_store_version': this.poolStore.getVersion(),

      // Detection metrics
      'solana_arbitrage_detections_total': this.stats.totalDetections,
      'solana_arbitrage_opportunities_intra_total': this.stats.intraSolanaOpportunities,
      'solana_arbitrage_opportunities_triangular_total': this.stats.triangularOpportunities,
      'solana_arbitrage_opportunities_crosschain_total': this.stats.crossChainOpportunities,

      // Performance metrics
      'solana_arbitrage_detection_latency_ms': this.stats.avgDetectionLatencyMs,
      'solana_arbitrage_stale_pools_skipped_total': this.stats.stalePoolsSkipped,

      // Health metrics
      'solana_arbitrage_circuit_breaker_open': circuitBreaker.isOpen ? 1 : 0,
      'solana_arbitrage_circuit_breaker_failures': circuitBreaker.failures,
      'solana_arbitrage_running': this.running ? 1 : 0,

      // Cache metrics
      'solana_arbitrage_token_cache_size': this.tokenCache.size,

      // Last activity timestamp (for staleness detection)
      'solana_arbitrage_last_detection_timestamp_ms': this.stats.lastDetectionTime,
    };
  }

  // ===========================================================================
  // Redis Streams Integration
  // ===========================================================================

  setStreamsClient(client: SolanaArbitrageStreamsClient): void {
    this.streamsClient = client;
    this.logger.info('Redis Streams client attached');
  }

  hasStreamsClient(): boolean {
    return !!this.streamsClient;
  }

  /**
   * Publish an opportunity to Redis Streams with retry logic.
   * BUG-FIX: Added retry mechanism with exponential backoff for transient failures.
   */
  async publishOpportunity(opportunity: SolanaArbitrageOpportunity): Promise<void> {
    if (!this.streamsClient) {
      this.logger.debug('No streams client, skipping opportunity publish', {
        opportunityId: opportunity.id,
      });
      return;
    }

    // BUG-FIX: Check if publishing is temporarily disabled due to repeated failures
    if (this.redisPublishState.isDisabled) {
      const timeSinceFailure = Date.now() - this.redisPublishState.lastFailureTime;
      if (timeSinceFailure < REDIS_RETRY.COOLDOWN_MS) {
        this.logger.debug('Redis publishing temporarily disabled, skipping', {
          opportunityId: opportunity.id,
          cooldownRemainingMs: REDIS_RETRY.COOLDOWN_MS - timeSinceFailure,
        });
        return;
      }
      // Cooldown expired, re-enable publishing
      this.redisPublishState.isDisabled = false;
      this.redisPublishState.consecutiveFailures = 0;
      this.logger.info('Redis publishing re-enabled after cooldown');
    }

    const data = {
      id: opportunity.id,
      type: opportunity.type,
      chain: opportunity.chain,
      buyDex: opportunity.buyDex,
      sellDex: opportunity.sellDex,
      token0: opportunity.token0,
      token1: opportunity.token1,
      buyPrice: String(opportunity.buyPrice),
      sellPrice: String(opportunity.sellPrice),
      profitPercentage: String(opportunity.profitPercentage),
      confidence: String(opportunity.confidence),
      timestamp: String(opportunity.timestamp),
      expiresAt: String(opportunity.expiresAt),
      status: opportunity.status,
      source: 'solana-arbitrage-detector',
    };

    // BUG-FIX: Retry loop with exponential backoff
    for (let attempt = 1; attempt <= REDIS_RETRY.MAX_ATTEMPTS; attempt++) {
      try {
        await this.streamsClient.xadd(SolanaArbitrageDetector.OPPORTUNITY_STREAM, data);

        // Success - reset failure counter
        if (this.redisPublishState.consecutiveFailures > 0) {
          this.redisPublishState.consecutiveFailures = 0;
        }

        this.logger.debug('Published opportunity to Redis Streams', {
          opportunityId: opportunity.id,
          stream: SolanaArbitrageDetector.OPPORTUNITY_STREAM,
          attempt,
        });
        return; // Success, exit function
      } catch (error) {
        const isLastAttempt = attempt === REDIS_RETRY.MAX_ATTEMPTS;

        if (isLastAttempt) {
          // All retries exhausted
          this.redisPublishState.consecutiveFailures++;
          this.redisPublishState.lastFailureTime = Date.now();

          // Check if we should disable publishing
          if (this.redisPublishState.consecutiveFailures >= REDIS_RETRY.FAILURE_THRESHOLD) {
            this.redisPublishState.isDisabled = true;
            this.logger.error('Redis publishing disabled due to repeated failures', {
              consecutiveFailures: this.redisPublishState.consecutiveFailures,
              cooldownMs: REDIS_RETRY.COOLDOWN_MS,
            });
            this.emit('redis-publishing-disabled', {
              failures: this.redisPublishState.consecutiveFailures,
            });
          }

          this.logger.error('Failed to publish opportunity to Redis Streams after retries', {
            error,
            opportunityId: opportunity.id,
            attempts: REDIS_RETRY.MAX_ATTEMPTS,
            consecutiveFailures: this.redisPublishState.consecutiveFailures,
          });
        } else {
          // Retry with exponential backoff + jitter to prevent thundering herd
          const baseDelay = REDIS_RETRY.BASE_DELAY_MS * Math.pow(2, attempt - 1);
          const jitter = Math.random() * 0.3; // 0-30% jitter
          const delayMs = Math.floor(baseDelay * (1 + jitter));
          this.logger.warn(`Redis publish attempt ${attempt} failed, retrying in ${delayMs}ms`, {
            error: error instanceof Error ? error.message : String(error),
            opportunityId: opportunity.id,
          });
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  // ===========================================================================
  // SolanaDetector Integration
  // ===========================================================================

  /**
   * Connect to a SolanaDetector or UnifiedChainDetector for pool updates.
   *
   * Issue 1.1 Fix: Properly adapt UnifiedPriceUpdate to SolanaPoolInfo.
   * The UnifiedChainDetector emits PriceUpdate events with a different schema.
   * This method handles both SolanaPoolInfo (direct) and UnifiedPriceUpdate (adapted).
   *
   * Architecture Decision: Synchronous event handlers
   * - Node.js is single-threaded, events are processed sequentially
   * - TDD tests expect immediate effect after emit()
   * - ARCHITECTURE_V2.md requires <1ms for price updates
   *
   * P0-FIX: Cleans up existing listeners if already connected to prevent memory leaks
   * when called multiple times.
   *
   * @param detector - EventEmitter that emits pool/price update events
   */
  connectToSolanaDetector(detector: EventEmitter): void {
    // P0-FIX: Clean up existing listeners if already connected to another detector
    // This prevents memory leaks when connectToSolanaDetector is called multiple times
    if (this.connectedDetector && this.detectorListeners.length > 0) {
      this.logger.debug('Cleaning up existing detector connection before connecting to new detector');
      for (const { event, handler } of this.detectorListeners) {
        this.connectedDetector.off(event, handler);
      }
      this.detectorListeners = [];
      this.connectedDetector = null;
    }
    /**
     * Adapter for UnifiedPriceUpdate -> SolanaPoolInfo.
     * Issue 1.1 Fix: Handle schema differences.
     * BUG-FIX: Added input validation to prevent crashes from malformed data.
     */
    const adaptPriceUpdate = (update: UnifiedPriceUpdate | SolanaPoolInfo): SolanaPoolInfo | null => {
      // BUG-FIX: Validate input is not null/undefined
      if (!update || typeof update !== 'object') {
        this.logger.warn('Received invalid update from detector (null/undefined)', {
          updateType: typeof update,
        });
        return null;
      }

      // If it already has token0.symbol, it's SolanaPoolInfo
      if ('token0' in update && typeof update.token0 === 'object' && 'symbol' in update.token0) {
        return update as SolanaPoolInfo;
      }

      // It's a UnifiedPriceUpdate - adapt it
      const priceUpdate = update as UnifiedPriceUpdate;

      // BUG-FIX: Validate required fields exist before accessing
      if (!priceUpdate.chain || !priceUpdate.dex || !priceUpdate.pairKey ||
          !priceUpdate.token0 || !priceUpdate.token1 ||
          typeof priceUpdate.price !== 'number') {
        this.logger.warn('Malformed UnifiedPriceUpdate, missing required fields', {
          pairKey: priceUpdate.pairKey,
          hasChain: !!priceUpdate.chain,
          hasDex: !!priceUpdate.dex,
          hasTokens: !!(priceUpdate.token0 && priceUpdate.token1),
          hasPrice: typeof priceUpdate.price === 'number',
        });
        return null;
      }

      // Skip non-Solana chains
      if (priceUpdate.chain !== this.config.chainId && priceUpdate.chain !== 'solana') {
        return null;
      }

      return {
        // Use pairKey as address (unique identifier)
        address: priceUpdate.pairKey,
        programId: 'unknown', // Not available in UnifiedPriceUpdate
        dex: priceUpdate.dex,
        token0: {
          mint: priceUpdate.token0,
          symbol: priceUpdate.token0,
          // BUG-FIX: Use token decimals registry instead of hardcoded values
          decimals: getTokenDecimals(priceUpdate.token0),
        },
        token1: {
          mint: priceUpdate.token1,
          symbol: priceUpdate.token1,
          // BUG-FIX: Use token decimals registry instead of hardcoded values
          decimals: getTokenDecimals(priceUpdate.token1),
        },
        fee: priceUpdate.fee ?? 30, // Default 0.3% if not provided
        reserve0: priceUpdate.reserve0,
        reserve1: priceUpdate.reserve1,
        price: priceUpdate.price,
        lastUpdated: priceUpdate.timestamp,
      };
    };

    /**
     * Handler for pool/price updates.
     * Synchronous for immediate effect per TDD test expectations.
     * BUG-FIX: Added pool validation before adding to prevent invalid data corruption.
     */
    const handleUpdate = (update: UnifiedPriceUpdate | SolanaPoolInfo): void => {
      const pool = adaptPriceUpdate(update);
      if (!pool) return;

      // Save address before type guard narrowing
      const poolAddress = pool.address;
      const existing = this.poolStore.get(poolAddress);

      if (existing) {
        // BUG-FIX: Validate price before updating
        if (pool.price !== undefined && this.isValidPrice(pool.price)) {
          this.updatePoolPrice(poolAddress, pool.price);
        }
      } else {
        // BUG-FIX: Validate pool before adding to prevent invalid data
        if (!this.isValidPool(pool)) {
          this.logger.warn('Received invalid pool update from detector, skipping', {
            address: poolAddress,
            source: 'external-detector',
          });
          return;
        }
        // P1-FIX: Also validate price if provided - don't add pools with invalid prices
        // This prevents invalid price data from corrupting pool state
        if (pool.price !== undefined && !this.isValidPrice(pool.price)) {
          this.logger.warn('Received pool with invalid price from detector, skipping', {
            address: poolAddress,
            price: pool.price,
            source: 'external-detector',
          });
          return;
        }
        this.addPool(pool);
      }
    };

    // P2-FIX: Store handler for pool removals so it can be cleaned up
    const handlePoolRemoved = (address: string): void => {
      this.removePool(address);
    };

    // P2-FIX: Store detector reference and listeners for cleanup in stop()
    this.connectedDetector = detector;
    // Type assertions are safe here - we control the handler creation above
    this.detectorListeners = [
      { event: 'poolUpdate', handler: handleUpdate as PoolUpdateHandler },
      { event: 'priceUpdate', handler: handleUpdate as PoolUpdateHandler },
      { event: 'poolRemoved', handler: handlePoolRemoved as PoolRemovedHandler },
    ];

    // Listen for both event types for compatibility
    detector.on('poolUpdate', handleUpdate);
    detector.on('priceUpdate', handleUpdate);

    // Listen for pool removals - synchronous
    detector.on('poolRemoved', handlePoolRemoved);

    this.logger.info('Connected to SolanaDetector for pool updates');
  }

  /**
   * Validate a pool object has required fields.
   * BUG-FIX: Prevent invalid pools from being added.
   * P1-FIX: Added stricter fee validation (0-10000 basis points).
   */
  private isValidPool(pool: unknown): pool is SolanaPoolInfo {
    if (!pool || typeof pool !== 'object') {
      return false;
    }

    const p = pool as Record<string, unknown>;

    // Check required fields
    if (typeof p.address !== 'string' || !p.address) return false;
    if (typeof p.programId !== 'string') return false;
    if (typeof p.dex !== 'string') return false;
    // P1-FIX: Fee must be valid (0-10000 basis points)
    if (typeof p.fee !== 'number' || !isFinite(p.fee) || p.fee < 0 || p.fee > 10000) return false;

    // Check token objects
    if (!p.token0 || typeof p.token0 !== 'object') return false;
    if (!p.token1 || typeof p.token1 !== 'object') return false;

    const t0 = p.token0 as Record<string, unknown>;
    const t1 = p.token1 as Record<string, unknown>;

    if (typeof t0.symbol !== 'string' || !t0.symbol) return false;
    if (typeof t1.symbol !== 'string' || !t1.symbol) return false;
    if (typeof t0.mint !== 'string') return false;
    if (typeof t1.mint !== 'string') return false;
    if (typeof t0.decimals !== 'number' || t0.decimals < 0) return false;
    if (typeof t1.decimals !== 'number' || t1.decimals < 0) return false;

    return true;
  }

  /**
   * Batch import pools from a SolanaDetector or other source.
   *
   * Note: This method is synchronous (returns void). Tests can safely await it
   * since `await undefined` is valid JavaScript and completes immediately.
   *
   * P2-FIX: Add defensive null/array validation.
   * BUG-FIX: Add individual pool validation.
   */
  importPools(pools: SolanaPoolInfo[]): void {
    // P2-FIX: Defensive check for null/undefined/non-array input
    if (!pools || !Array.isArray(pools)) {
      this.logger.warn('importPools called with invalid pools array', {
        received: pools === null ? 'null' : typeof pools,
      });
      return;
    }

    // P3-FIX: Handle empty array case explicitly - don't log misleading "Imported pools" message
    if (pools.length === 0) {
      this.logger.debug('importPools called with empty array, nothing to import');
      return;
    }

    let imported = 0;
    let skipped = 0;

    for (const pool of pools) {
      // BUG-FIX: Validate individual pool objects
      if (!this.isValidPool(pool)) {
        this.logger.debug('Skipping invalid pool in import', {
          pool: pool && typeof pool === 'object' ? (pool as Record<string, unknown>).address : 'invalid',
        });
        skipped++;
        continue;
      }
      this.addPool(pool);
      imported++;
    }

    this.logger.info('Imported pools', { imported, skipped, total: pools.length });
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  SolanaArbitrageDetector as default,
};
