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
 * 2. Composed with SolanaDetector for production use
 *
 * The base SolanaDetector (shared/core/src/solana/solana-detector.ts) handles:
 * - Connection pooling and RPC management
 * - Program account subscriptions
 * - Redis Streams integration for price updates
 * - Health monitoring
 *
 * This module adds:
 * - Multi-DEX arbitrage detection
 * - Triangular path finding
 * - Cross-chain price comparison
 * - Priority fee estimation
 *
 * Integration Note:
 * SolanaPoolInfo is compatible with SolanaPool from solana-detector.ts.
 * Pools can be passed from SolanaDetector to this detector for processing.
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.6
 * @see shared/core/src/solana/solana-detector.ts - Base infrastructure
 */

import { EventEmitter } from 'events';
import { normalizeTokenForCrossChain } from '@arbitrage/config';
import {
  basisPointsToDecimal,
  meetsThreshold,
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
   * Solana RPC endpoint URL (required for identification/logging).
   * Note: Actual RPC connections are managed by SolanaDetector, not this class.
   */
  rpcUrl: string;

  /** Minimum profit threshold in percent (default: 0.3 = 0.3%) */
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
 */
export interface SolanaPoolInfo {
  address: string;
  programId: string;
  dex: string;
  token0: SolanaTokenInfo;
  token1: SolanaTokenInfo;
  fee: number; // Basis points (e.g., 25 = 0.25%)
  reserve0?: string;
  reserve1?: string;
  price?: number;
  lastSlot?: number;
}

/**
 * EVM price update for cross-chain comparison.
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
  solanaPoolAddress: string; // Solana pool address for opportunity tracking
  evmChain: string;
  evmDex: string;
  evmPrice: number;
  evmPairKey: string; // EVM pair key for opportunity tracking
  priceDifferencePercent: number;
  timestamp: number;
}

/**
 * Priority fee estimation.
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
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG = {
  minProfitThreshold: 0.3, // 0.3%
  priorityFeeMultiplier: 1.0,
  basePriorityFeeLamports: 10000, // 0.00001 SOL
  crossChainEnabled: true,
  triangularEnabled: true,
  maxTriangularDepth: 3,
  opportunityExpiryMs: 1000, // 1 second (Solana is fast)
};

// Compute unit estimates for different operations
const COMPUTE_UNITS = {
  SIMPLE_SWAP: 150000,
  CLMM_SWAP: 300000,
  TRIANGULAR_BASE: 400000,
};

// Urgency multipliers for priority fees
const URGENCY_MULTIPLIERS = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
};

// =============================================================================
// SolanaArbitrageDetector Class
// =============================================================================

/**
 * Solana-specific arbitrage detector.
 * Extends EventEmitter for opportunity and price update events.
 */
export class SolanaArbitrageDetector extends EventEmitter {
  // Configuration
  private config: Required<SolanaArbitrageConfig>;
  private logger: SolanaArbitrageLogger;

  // Redis Streams client for opportunity publishing
  private streamsClient?: SolanaArbitrageStreamsClient;
  private static readonly OPPORTUNITY_STREAM = 'arbitrage:opportunities';

  // Pool management
  private pools: Map<string, SolanaPoolInfo> = new Map();
  private poolsByTokenPair: Map<string, Set<string>> = new Map();

  // Statistics
  private stats: SolanaArbitrageStats = {
    totalDetections: 0,
    intraSolanaOpportunities: 0,
    triangularOpportunities: 0,
    crossChainOpportunities: 0,
    poolsTracked: 0,
    lastDetectionTime: 0,
  };

  // Performance optimization: Cache normalized token symbols
  // Avoids repeated normalizeTokenForCrossChain calls in hot paths
  private normalizedTokenCache: Map<string, string> = new Map();

  // State
  private running = false;

  constructor(config: SolanaArbitrageConfig, deps?: SolanaArbitrageDeps) {
    super();

    // Validate required config
    if (!config.rpcUrl || config.rpcUrl.trim() === '') {
      throw new Error('rpcUrl is required for SolanaArbitrageDetector');
    }

    // Set defaults
    this.config = {
      rpcUrl: config.rpcUrl,
      minProfitThreshold: config.minProfitThreshold ?? DEFAULT_CONFIG.minProfitThreshold,
      priorityFeeMultiplier: config.priorityFeeMultiplier ?? DEFAULT_CONFIG.priorityFeeMultiplier,
      basePriorityFeeLamports: config.basePriorityFeeLamports ?? DEFAULT_CONFIG.basePriorityFeeLamports,
      crossChainEnabled: config.crossChainEnabled ?? DEFAULT_CONFIG.crossChainEnabled,
      triangularEnabled: config.triangularEnabled ?? DEFAULT_CONFIG.triangularEnabled,
      maxTriangularDepth: config.maxTriangularDepth ?? DEFAULT_CONFIG.maxTriangularDepth,
      opportunityExpiryMs: config.opportunityExpiryMs ?? DEFAULT_CONFIG.opportunityExpiryMs,
    };

    // Setup logger
    this.logger = deps?.logger ?? {
      info: console.log,
      warn: console.warn,
      error: console.error,
      debug: () => {},
    };

    // Store optional Redis Streams client for opportunity publishing
    this.streamsClient = deps?.streamsClient;

    this.logger.info('SolanaArbitrageDetector initialized', {
      rpcUrl: this.config.rpcUrl,
      minProfitThreshold: this.config.minProfitThreshold,
      crossChainEnabled: this.config.crossChainEnabled,
      triangularEnabled: this.config.triangularEnabled,
      hasStreamsClient: !!this.streamsClient,
    });
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
    this.logger.info('SolanaArbitrageDetector stopped');
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ===========================================================================
  // Pool Management
  // ===========================================================================

  addPool(pool: SolanaPoolInfo): void {
    this.pools.set(pool.address, pool);

    // Index by token pair (normalized for cross-chain matching)
    const pairKey = this.createPairKey(pool.token0.symbol, pool.token1.symbol);
    if (!this.poolsByTokenPair.has(pairKey)) {
      this.poolsByTokenPair.set(pairKey, new Set());
    }
    this.poolsByTokenPair.get(pairKey)!.add(pool.address);

    this.stats.poolsTracked = this.pools.size;

    this.logger.debug('Pool added', { address: pool.address, dex: pool.dex, pairKey });
  }

  removePool(address: string): void {
    const pool = this.pools.get(address);
    if (!pool) return;

    // Remove from token pair index
    const pairKey = this.createPairKey(pool.token0.symbol, pool.token1.symbol);
    this.poolsByTokenPair.get(pairKey)?.delete(address);

    // Remove from main map
    this.pools.delete(address);
    this.stats.poolsTracked = this.pools.size;
  }

  getPool(address: string): SolanaPoolInfo | undefined {
    return this.pools.get(address);
  }

  getPoolCount(): number {
    return this.pools.size;
  }

  getPoolsByTokenPair(token0: string, token1: string): SolanaPoolInfo[] {
    const pairKey = this.createPairKey(token0, token1);
    const addresses = this.poolsByTokenPair.get(pairKey);
    if (!addresses) return [];

    return Array.from(addresses)
      .map(addr => this.pools.get(addr))
      .filter((p): p is SolanaPoolInfo => p !== undefined);
  }

  updatePoolPrice(address: string, newPrice: number): void {
    const pool = this.pools.get(address);
    if (!pool) {
      this.logger.warn('Cannot update price for non-existent pool', { address });
      return;
    }

    const oldPrice = pool.price;
    pool.price = newPrice;

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
   * Performance optimization: Caches results to avoid repeated lookups.
   */
  private getNormalizedToken(symbol: string): string {
    let normalized = this.normalizedTokenCache.get(symbol);
    if (!normalized) {
      normalized = normalizeTokenForCrossChain(symbol);
      this.normalizedTokenCache.set(symbol, normalized);
    }
    return normalized;
  }

  private createPairKey(token0: string, token1: string): string {
    // Normalize tokens for cross-chain matching and sort for consistency
    const normalized0 = this.getNormalizedToken(token0);
    const normalized1 = this.getNormalizedToken(token1);
    const sorted = [normalized0, normalized1].sort();
    return `${sorted[0]}-${sorted[1]}`;
  }

  // ===========================================================================
  // Intra-Solana Arbitrage Detection
  // ===========================================================================

  async detectIntraSolanaArbitrage(): Promise<SolanaArbitrageOpportunity[]> {
    const opportunities: SolanaArbitrageOpportunity[] = [];
    const thresholdDecimal = this.config.minProfitThreshold / 100;

    // Iterate over all token pairs
    for (const [pairKey, poolAddresses] of this.poolsByTokenPair) {
      if (poolAddresses.size < 2) continue;

      // Get pools with valid prices
      const pools = Array.from(poolAddresses)
        .map(addr => this.pools.get(addr))
        .filter((p): p is SolanaPoolInfo => p !== undefined && p.price !== undefined);

      if (pools.length < 2) continue;

      // Compare all pool pairs
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          const pool1 = pools[i];
          const pool2 = pools[j];

          const opportunity = this.calculateOpportunity(pool1, pool2, thresholdDecimal);
          if (opportunity) {
            opportunities.push(opportunity);
            this.emit('opportunity', opportunity);
          }
        }
      }
    }

    this.stats.totalDetections++;
    this.stats.intraSolanaOpportunities += opportunities.length;
    this.stats.lastDetectionTime = Date.now();

    return opportunities;
  }

  private calculateOpportunity(
    pool1: SolanaPoolInfo,
    pool2: SolanaPoolInfo,
    thresholdDecimal: number
  ): SolanaArbitrageOpportunity | null {
    if (!pool1.price || !pool2.price) return null;

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

    // Estimate gas cost
    const gasCost = this.estimateGasCost(COMPUTE_UNITS.SIMPLE_SWAP);

    // Generate unique ID
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 11);

    // Use normalized symbols for consistency with triangular and cross-chain opportunities
    const normalizedToken0 = this.getNormalizedToken(buyPool.token0.symbol);
    const normalizedToken1 = this.getNormalizedToken(buyPool.token1.symbol);

    return {
      id: `sol-arb-${buyPool.address.slice(0, 8)}-${sellPool.address.slice(0, 8)}-${timestamp}-${randomSuffix}`,
      type: 'intra-solana',
      chain: 'solana',
      buyDex: buyPool.dex,
      sellDex: sellPool.dex,
      buyPair: buyPool.address,
      sellPair: sellPool.address,
      token0: normalizedToken0,
      token1: normalizedToken1,
      buyPrice: buyPool.price!,
      sellPrice: sellPool.price!,
      profitPercentage: netProfit * 100,
      expectedProfit: netProfit,
      estimatedGasCost: gasCost,
      netProfitAfterGas: netProfit - gasCost,
      confidence: 0.85,
      timestamp,
      expiresAt: timestamp + this.config.opportunityExpiryMs,
      status: 'pending',
    };
  }

  private estimateGasCost(computeUnits: number): number {
    // Estimate gas cost as a fraction of trade value
    // In reality, this would be based on SOL price and priority fees
    const feeEstimate = this.calculatePriorityFeeInternal(computeUnits, 'medium');
    // Return as a percentage (assuming 1 SOL = $100 and typical trade value)
    return (feeEstimate.totalFee / 1e9) * 100 / 1000; // Very rough estimate
  }

  // ===========================================================================
  // Triangular Arbitrage Detection
  // ===========================================================================

  async detectTriangularArbitrage(): Promise<SolanaArbitrageOpportunity[]> {
    if (!this.config.triangularEnabled) {
      return [];
    }

    const opportunities: SolanaArbitrageOpportunity[] = [];
    const thresholdDecimal = this.config.minProfitThreshold / 100;

    // Find all triangular paths
    const paths = this.findTriangularPaths();

    for (const path of paths) {
      const opportunity = this.evaluateTriangularPath(path, thresholdDecimal);
      if (opportunity) {
        opportunities.push(opportunity);
        this.emit('opportunity', opportunity);
      }
    }

    this.stats.triangularOpportunities += opportunities.length;
    this.stats.lastDetectionTime = Date.now();

    return opportunities;
  }

  private findTriangularPaths(): TriangularPath[] {
    const paths: TriangularPath[] = [];
    const visitedPairs = new Set<string>();

    // Start from each token pair
    for (const [pairKey, poolAddresses] of this.poolsByTokenPair) {
      if (visitedPairs.has(pairKey)) continue;
      visitedPairs.add(pairKey);

      const [token0, token1] = pairKey.split('-');

      // Try to find paths that start with token0 and return to token0
      const triangularPaths = this.findPathsFromToken(token0, token0, []);
      paths.push(...triangularPaths);
    }

    return paths;
  }

  private findPathsFromToken(
    startToken: string,
    currentToken: string,
    currentPath: TriangularPathStep[],
    depth: number = 0
  ): TriangularPath[] {
    const paths: TriangularPath[] = [];

    // Max depth check
    if (depth >= this.config.maxTriangularDepth) {
      // Check if we're back at start
      if (currentToken === startToken && currentPath.length >= 3) {
        const profitResult = this.calculateTriangularProfit(currentPath);
        if (profitResult) {
          paths.push({
            steps: currentPath,
            inputToken: startToken,
            outputToken: startToken,
            profitPercentage: profitResult.profitPercentage,
            estimatedOutput: profitResult.estimatedOutput,
          });
        }
      }
      return paths;
    }

    // Find pools containing currentToken (using cached normalization for performance)
    const normalizedCurrent = this.getNormalizedToken(currentToken);

    for (const [_pairKey, poolAddresses] of this.poolsByTokenPair) {
      // Try each pool for this pair
      for (const poolAddr of poolAddresses) {
        const pool = this.pools.get(poolAddr);
        if (!pool || !pool.price || pool.price === 0) continue;

        // Check if pool contains currentToken and determine swap direction
        // Use pool's actual token symbols, not the sorted pair key
        const poolToken0 = this.getNormalizedToken(pool.token0.symbol);
        const poolToken1 = this.getNormalizedToken(pool.token1.symbol);

        let nextToken: string | null = null;
        let effectivePrice: number;

        if (poolToken0 === normalizedCurrent) {
          // Swapping token0 → token1
          // Price is typically token1/token0 (output/input), use directly
          nextToken = poolToken1;
          effectivePrice = pool.price;
        } else if (poolToken1 === normalizedCurrent) {
          // Swapping token1 → token0
          // Need inverse of price
          nextToken = poolToken0;
          effectivePrice = 1 / pool.price;
        } else {
          continue;
        }

        // Avoid cycles except returning to start
        const tokenVisited = currentPath.some(step => step.token === nextToken);
        if (tokenVisited && nextToken !== startToken) continue;

        const step: TriangularPathStep = {
          token: nextToken,
          pool: pool.address,
          dex: pool.dex,
          price: effectivePrice,
          fee: basisPointsToDecimal(pool.fee),
        };

        const newPath = [...currentPath, step];

        // Recurse
        const foundPaths = this.findPathsFromToken(startToken, nextToken, newPath, depth + 1);
        paths.push(...foundPaths);
      }
    }

    return paths;
  }

  private calculateTriangularProfit(
    path: TriangularPathStep[]
  ): { profitPercentage: number; estimatedOutput: number } | null {
    if (path.length < 3) return null;

    // Start with 1 unit
    let amount = 1.0;

    for (const step of path) {
      // Apply swap (simplified - assumes price is output/input)
      amount = amount * step.price;
      // Apply fee (already included in amount calculation)
      amount = amount * (1 - step.fee);
    }

    // Calculate profit (should end up with more than 1)
    // Fees are already accounted for in the amount calculation above
    const profit = amount - 1;

    if (profit <= 0) return null;

    return {
      profitPercentage: profit * 100,
      estimatedOutput: amount,
    };
  }

  private evaluateTriangularPath(
    path: TriangularPath,
    thresholdDecimal: number
  ): SolanaArbitrageOpportunity | null {
    if (path.profitPercentage / 100 < thresholdDecimal) {
      return null;
    }

    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 11);

    return {
      id: `sol-tri-${path.inputToken}-${timestamp}-${randomSuffix}`,
      type: 'triangular',
      chain: 'solana',
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
      confidence: 0.75, // Lower confidence for triangular
      timestamp,
      expiresAt: timestamp + this.config.opportunityExpiryMs,
      status: 'pending',
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
      // Normalize EVM tokens (using cached normalization for performance)
      const evmToken0 = this.getNormalizedToken(evmPrice.token0);
      const evmToken1 = this.getNormalizedToken(evmPrice.token1);
      const evmPairKey = this.createPairKey(evmToken0, evmToken1);

      // Find matching Solana pools
      const solanaPools = Array.from(this.poolsByTokenPair.get(evmPairKey) || [])
        .map(addr => this.pools.get(addr))
        .filter((p): p is SolanaPoolInfo => p !== undefined && p.price !== undefined);

      for (const solanaPool of solanaPools) {
        const priceDiff = ((evmPrice.price - solanaPool.price!) / solanaPool.price!) * 100;

        comparisons.push({
          token: normalizeTokenForCrossChain(solanaPool.token0.symbol),
          quoteToken: normalizeTokenForCrossChain(solanaPool.token1.symbol),
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

    const opportunities: SolanaArbitrageOpportunity[] = [];
    const thresholdDecimal = this.config.minProfitThreshold / 100;

    const comparisons = await this.compareCrossChainPrices(evmPrices);

    for (const comparison of comparisons) {
      const absDiff = Math.abs(comparison.priceDifferencePercent) / 100;

      if (!meetsThreshold(absDiff, thresholdDecimal)) {
        continue;
      }

      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).slice(2, 11);

      const direction = comparison.solanaPrice < comparison.evmPrice
        ? 'buy-solana-sell-evm'
        : 'buy-evm-sell-solana';

      // Determine buy/sell pair addresses based on direction
      const buyPair = direction === 'buy-solana-sell-evm'
        ? comparison.solanaPoolAddress
        : comparison.evmPairKey;
      const sellPair = direction === 'buy-solana-sell-evm'
        ? comparison.evmPairKey
        : comparison.solanaPoolAddress;

      opportunities.push({
        id: `sol-xchain-${comparison.token}-${comparison.evmChain}-${timestamp}-${randomSuffix}`,
        type: 'cross-chain',
        chain: 'solana',
        sourceChain: 'solana',
        targetChain: comparison.evmChain,
        direction,
        buyDex: direction === 'buy-solana-sell-evm' ? comparison.solanaDex : comparison.evmDex,
        sellDex: direction === 'buy-solana-sell-evm' ? comparison.evmDex : comparison.solanaDex,
        buyPair,
        sellPair,
        token0: comparison.token,
        token1: comparison.quoteToken,
        token: comparison.token,       // Cross-chain base token
        quoteToken: comparison.quoteToken, // Cross-chain quote token
        buyPrice: direction === 'buy-solana-sell-evm' ? comparison.solanaPrice : comparison.evmPrice,
        sellPrice: direction === 'buy-solana-sell-evm' ? comparison.evmPrice : comparison.solanaPrice,
        profitPercentage: absDiff * 100,
        expectedProfit: absDiff,
        confidence: 0.6, // Lower confidence for cross-chain
        timestamp,
        expiresAt: timestamp + this.config.opportunityExpiryMs * 10, // Longer expiry for cross-chain
        status: 'pending',
      });

      this.emit('opportunity', opportunities[opportunities.length - 1]);
    }

    this.stats.crossChainOpportunities += opportunities.length;
    this.stats.lastDetectionTime = Date.now();

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

    // Calculate priority fee based on compute units and urgency
    // microLamports per CU = base fee / compute unit estimate * urgency * multiplier
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

  getStats(): SolanaArbitrageStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalDetections: 0,
      intraSolanaOpportunities: 0,
      triangularOpportunities: 0,
      crossChainOpportunities: 0,
      poolsTracked: this.pools.size,
      lastDetectionTime: 0,
    };
  }

  // ===========================================================================
  // Redis Streams Integration
  // ===========================================================================

  /**
   * Set the Redis Streams client for opportunity publishing.
   * Allows late initialization when the detector is used without DI.
   *
   * @param client - Redis Streams client instance
   */
  setStreamsClient(client: SolanaArbitrageStreamsClient): void {
    this.streamsClient = client;
    this.logger.info('Redis Streams client attached');
  }

  /**
   * Check if Redis Streams client is available.
   */
  hasStreamsClient(): boolean {
    return !!this.streamsClient;
  }

  /**
   * Publish an opportunity to Redis Streams.
   * Called automatically when opportunities are detected if streams client is set.
   *
   * @param opportunity - The arbitrage opportunity to publish
   */
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
   * Connect to a SolanaDetector instance for pool updates.
   * The SolanaDetector handles RPC connections, program subscriptions, and health monitoring.
   * This detector handles arbitrage-specific detection logic.
   *
   * Usage:
   * ```typescript
   * const baseDetector = new SolanaDetector(config);
   * const arbDetector = new SolanaArbitrageDetector(config);
   *
   * // Connect for pool updates
   * arbDetector.connectToSolanaDetector(baseDetector);
   *
   * await baseDetector.start();
   * ```
   *
   * @param solanaDetector - SolanaDetector-compatible EventEmitter with 'poolUpdate' events
   */
  connectToSolanaDetector(solanaDetector: EventEmitter): void {
    // Listen for pool updates from the base detector
    solanaDetector.on('poolUpdate', (pool: SolanaPoolInfo) => {
      const existingPool = this.pools.get(pool.address);
      if (existingPool) {
        // Update existing pool
        if (pool.price !== undefined) {
          this.updatePoolPrice(pool.address, pool.price);
        }
      } else {
        // Add new pool
        this.addPool(pool);
      }
    });

    // Listen for pool removals
    solanaDetector.on('poolRemoved', (address: string) => {
      this.removePool(address);
    });

    this.logger.info('Connected to SolanaDetector for pool updates');
  }

  /**
   * Batch import pools from a SolanaDetector or other source.
   * Useful for initial synchronization.
   *
   * @param pools - Array of pools to import
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
