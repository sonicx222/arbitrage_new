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
 */
export interface TriangularPathStep {
  token: string;
  pool: string;
  dex: string;
  price: number;
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
// Versioned Pool Store
// =============================================================================

/**
 * Versioned pool store for efficient snapshotting.
 * Issue 10.1 Fix: Avoid deep copying on every detection.
 *
 * Uses a version counter to track changes. Detection methods
 * work on a "logical snapshot" by checking version at start.
 */
class VersionedPoolStore {
  private pools = new Map<string, InternalPoolInfo>();
  private poolsByPair = new Map<string, Set<string>>();
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  set(pool: InternalPoolInfo): void {
    const existing = this.pools.get(pool.address);
    this.pools.set(pool.address, pool);

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

  get(address: string): InternalPoolInfo | undefined {
    return this.pools.get(address);
  }

  delete(address: string): boolean {
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
   * Get all pools.
   */
  getAllPools(): InternalPoolInfo[] {
    return Array.from(this.pools.values());
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
  private detectionLatencies: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 100;

  // State
  private running = false;

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
    if (!this.running) return;
    this.running = false;

    // Clear caches to prevent memory leaks
    this.tokenCache.clear();

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
   *
   * Architecture Decision: Synchronous pool management
   * - Node.js is single-threaded, no need for mutex on in-memory data
   * - ARCHITECTURE_V2.md requires <1ms for price matrix updates
   * - TDD tests expect synchronous behavior
   */
  addPool(pool: SolanaPoolInfo): void {
    // Pre-normalize tokens (Issue 10.2)
    const normalizedToken0 = this.getNormalizedToken(pool.token0.symbol);
    const normalizedToken1 = this.getNormalizedToken(pool.token1.symbol);
    const pairKey = this.createPairKeyFromNormalized(normalizedToken0, normalizedToken1);

    const internalPool: InternalPoolInfo = {
      ...pool,
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
   */
  updatePoolPrice(address: string, newPrice: number, lastSlot?: number): void {
    const pool = this.poolStore.get(address);
    if (!pool) {
      this.logger.warn('Cannot update price for non-existent pool', { address });
      return;
    }

    const oldPrice = pool.price;

    // Create updated pool (immutable update)
    const updatedPool: InternalPoolInfo = {
      ...pool,
      price: newPrice,
      lastUpdated: Date.now(),
      lastSlot: lastSlot ?? pool.lastSlot,
    };

    this.poolStore.set(updatedPool);

    this.emit('price-update', {
      poolAddress: address,
      oldPrice,
      newPrice,
      dex: pool.dex,
      token0: pool.token0.symbol,
      token1: pool.token1.symbol,
    });
  }

  /**
   * Get cached normalized token symbol.
   * Performance optimization with LRU cache (Issue 4.2).
   */
  private getNormalizedToken(symbol: string): string {
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
   */
  private isPriceStale(pool: InternalPoolInfo): boolean {
    if (!pool.lastUpdated) return false; // No timestamp = assume fresh
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
  // Intra-Solana Arbitrage Detection
  // ===========================================================================

  async detectIntraSolanaArbitrage(): Promise<SolanaArbitrageOpportunity[]> {
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

      // Compare all pool pairs
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
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

    return opportunities;
  }

  private calculateOpportunity(
    pool1: InternalPoolInfo,
    pool2: InternalPoolInfo,
    thresholdDecimal: number
  ): SolanaArbitrageOpportunity | null {
    // Issue 4.3: Already validated in caller, but double-check
    if (!this.isValidPrice(pool1.price) || !this.isValidPrice(pool2.price)) return null;

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
   */
  private estimateGasCost(computeUnits: number, tradeValueUsd: number): number {
    const feeEstimate = this.calculatePriorityFeeInternal(computeUnits, 'medium');
    const feeInSol = feeEstimate.totalFee / 1e9;
    const solPriceUsd = getDefaultPrice('SOL');
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

    return opportunities;
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

    for (const pool of this.poolStore.getAllPools()) {
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
      if (!graph.has(token1)) graph.set(token1, []);
      graph.get(token1)!.push({
        nextToken: token0,
        pool,
        effectivePrice: 1 / pool.price!,
        fee,
      });
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

  private calculateTriangularProfit(
    path: TriangularPathStep[]
  ): { profitPercentage: number; estimatedOutput: number } | null {
    if (path.length < 3) return null;

    let amount = 1.0;

    for (const step of path) {
      amount = amount * step.price;
      amount = amount * (1 - step.fee);
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
        });
      }
    }

    return comparisons;
  }

  async detectCrossChainArbitrage(evmPrices: EvmPriceUpdate[]): Promise<SolanaArbitrageOpportunity[]> {
    if (!this.config.crossChainEnabled) {
      return [];
    }

    const startTime = Date.now();
    const opportunities: SolanaArbitrageOpportunity[] = [];
    const thresholdDecimal = this.config.minProfitThreshold / 100;

    const comparisons = await this.compareCrossChainPrices(evmPrices);

    for (const comparison of comparisons) {
      const absDiff = Math.abs(comparison.priceDifferencePercent) / 100;

      if (!meetsThreshold(absDiff, thresholdDecimal)) {
        continue;
      }

      const direction = comparison.solanaPrice < comparison.evmPrice
        ? 'buy-solana-sell-evm'
        : 'buy-evm-sell-solana';

      const opportunity = this.opportunityFactory.createCrossChain(
        comparison,
        direction,
        absDiff,
        CROSS_CHAIN_EXPIRY_MULTIPLIER
      );

      opportunities.push(opportunity);
      this.emit('opportunity', opportunity);
    }

    this.updateDetectionStats('crossChain', opportunities.length, 0, Date.now() - startTime);

    return opportunities;
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
    // Atomic-like update (Issue 5.2)
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

    // Update rolling average latency
    this.detectionLatencies.push(latencyMs);
    if (this.detectionLatencies.length > SolanaArbitrageDetector.MAX_LATENCY_SAMPLES) {
      this.detectionLatencies.shift();
    }
    this.stats.avgDetectionLatencyMs =
      this.detectionLatencies.reduce((a, b) => a + b, 0) / this.detectionLatencies.length;
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
    this.detectionLatencies = [];
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

  async publishOpportunity(opportunity: SolanaArbitrageOpportunity): Promise<void> {
    if (!this.streamsClient) {
      this.logger.debug('No streams client, skipping opportunity publish', {
        opportunityId: opportunity.id,
      });
      return;
    }

    try {
      await this.streamsClient.xadd(SolanaArbitrageDetector.OPPORTUNITY_STREAM, {
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
      });

      this.logger.debug('Published opportunity to Redis Streams', {
        opportunityId: opportunity.id,
        stream: SolanaArbitrageDetector.OPPORTUNITY_STREAM,
      });
    } catch (error) {
      this.logger.error('Failed to publish opportunity to Redis Streams', {
        error,
        opportunityId: opportunity.id,
      });
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
   * @param detector - EventEmitter that emits pool/price update events
   */
  connectToSolanaDetector(detector: EventEmitter): void {
    /**
     * Adapter for UnifiedPriceUpdate -> SolanaPoolInfo.
     * Issue 1.1 Fix: Handle schema differences.
     */
    const adaptPriceUpdate = (update: UnifiedPriceUpdate | SolanaPoolInfo): SolanaPoolInfo | null => {
      // If it already has token0.symbol, it's SolanaPoolInfo
      if ('token0' in update && typeof update.token0 === 'object' && 'symbol' in update.token0) {
        return update as SolanaPoolInfo;
      }

      // It's a UnifiedPriceUpdate - adapt it
      const priceUpdate = update as UnifiedPriceUpdate;

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
          decimals: 9, // Default, not available in update
        },
        token1: {
          mint: priceUpdate.token1,
          symbol: priceUpdate.token1,
          decimals: 6, // Default, not available in update
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
     */
    const handleUpdate = (update: UnifiedPriceUpdate | SolanaPoolInfo): void => {
      const pool = adaptPriceUpdate(update);
      if (!pool) return;

      const existing = this.poolStore.get(pool.address);
      if (existing) {
        if (pool.price !== undefined) {
          this.updatePoolPrice(pool.address, pool.price);
        }
      } else {
        this.addPool(pool);
      }
    };

    // Listen for both event types for compatibility
    detector.on('poolUpdate', handleUpdate);
    detector.on('priceUpdate', handleUpdate);

    // Listen for pool removals - synchronous
    detector.on('poolRemoved', (address: string) => {
      this.removePool(address);
    });

    this.logger.info('Connected to SolanaDetector for pool updates');
  }

  /**
   * Batch import pools from a SolanaDetector or other source.
   * Returns Promise for backward compatibility with tests that await it.
   */
  importPools(pools: SolanaPoolInfo[]): void {
    for (const pool of pools) {
      this.addPool(pool);
    }
    this.logger.info('Imported pools', { count: pools.length });
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  SolanaArbitrageDetector as default,
};
