/**
 * S3.3.6 Solana-Specific Arbitrage Detection (Refactored)
 *
 * Provides specialized arbitrage detection for Solana blockchain:
 * - Intra-Solana arbitrage (between Solana DEXs)
 * - Triangular arbitrage paths (SOL→USDC→JUP→SOL)
 * - Cross-chain price comparison (Solana vs EVM)
 * - Priority fee estimation for Solana transactions
 *
 * R1 Refactoring:
 * This refactored version delegates to extracted modules for:
 * - Pool storage (./pool/versioned-pool-store)
 * - Detection logic (./detection/*)
 * - Opportunity creation (./opportunity-factory)
 * - Data structures (LRUCache, NumericRollingWindow from @arbitrage/core)
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.6
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import { EventEmitter } from 'events';
import { normalizeTokenForCrossChain, normalizeTokenForPricing } from '@arbitrage/config';
import { createSimpleCircuitBreaker, type SimpleCircuitBreaker } from '@arbitrage/core/circuit-breaker';
import { LRUCache, NumericRollingWindow } from '@arbitrage/core/data-structures';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { createTraceContext, propagateContext } from '@arbitrage/core/tracing';

// Import extracted modules
import { VersionedPoolStore } from './pool/versioned-pool-store';
import { OpportunityFactory } from './opportunity-factory';
import {
  detectIntraSolanaArbitrage,
  detectTriangularArbitrage,
  detectCrossChainArbitrage,
  compareCrossChainPrices as comparePrices,
  calculatePriorityFee,
  isValidPrice,
  isValidFee,
  isPriceStale,
  DEFAULT_DETECTION_CONFIG,
  CIRCUIT_BREAKER_CONFIG,
  CROSS_CHAIN_EXPIRY_MULTIPLIER,
} from './detection';

// Import types
import type {
  SolanaArbitrageConfig,
  SolanaArbitrageDeps,
  SolanaArbitrageLogger,
  SolanaArbitrageStreamsClient,
  SolanaPoolInfo,
  InternalPoolInfo,
  SolanaArbitrageOpportunity,
  SolanaArbitrageStats,
  EvmPriceUpdate,
  CrossChainPriceComparison,
  PriorityFeeEstimate,
  PriorityFeeRequest,
  UnifiedPriceUpdate,
  DetectorListenerRef,
  PoolUpdateHandler,
  PoolRemovedHandler,
  DetectorEventHandler,
} from './types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum size for token normalization cache */
const MAX_TOKEN_CACHE_SIZE = 10000;

/** Maximum size for pool store */
const MAX_POOL_STORE_SIZE = 50000;

/**
 * Minimum interval between updates for the same pool address (ms).
 * Prevents CPU saturation from rapid pool update floods.
 * @see Fix #22 - partition-solana-deep-analysis.md
 */
const POOL_UPDATE_COOLDOWN_MS = 100;

/** Maximum latency samples for rolling average */
const MAX_LATENCY_SAMPLES = 100;

/** Redis stream for opportunity publishing */
const OPPORTUNITY_STREAM = 'stream:opportunities';

/** Redis retry configuration */
const REDIS_RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 50,
  FAILURE_THRESHOLD: 10,
  COOLDOWN_MS: 60000,
} as const;

/** Token decimals registry for common tokens */
const TOKEN_DECIMALS: Record<string, number> = {
  SOL: 9, WSOL: 9, USDC: 6, USDT: 6, DAI: 18, BUSD: 18, USDH: 6,
  BTC: 8, WBTC: 8, ETH: 18, WETH: 18, JUP: 6, RAY: 6, ORCA: 6,
  MNDE: 9, MSOL: 9, JITOSOL: 9, STSOL: 9, BSOL: 9, DEFAULT: 9,
} as const;

/** Liquid staking tokens that can be excluded from normalization */
const LIQUID_STAKING_TOKENS = new Set([
  'MSOL', 'JITOSOL', 'STSOL', 'BSOL', 'LSOL', 'SCNSOL', 'CGTSOL', 'LAINESOL', 'EDGESOL', 'COMPASSSOL',
]);

/** Regex for validating Solana addresses */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Regex for test/mock addresses (allows 1-64 char alphanumeric with hyphens/underscores) */
const TEST_ADDRESS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Default fee in basis points used when adapting a UnifiedPriceUpdate with no fee field */
const DEFAULT_ADAPTED_FEE_BPS = 30;

// =============================================================================
// Utility Functions
// =============================================================================

function getTokenDecimals(symbol: string): number {
  return TOKEN_DECIMALS[symbol.toUpperCase()] ?? TOKEN_DECIMALS.DEFAULT;
}

function isValidPoolAddress(address: string): boolean {
  if (typeof address !== 'string' || !address) return false;
  return SOLANA_ADDRESS_REGEX.test(address) || TEST_ADDRESS_REGEX.test(address);
}

function sanitizeTokenSymbol(symbol: string): string {
  if (typeof symbol !== 'string') return '';
  return symbol.replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 20);
}

// =============================================================================
// SolanaArbitrageDetector Class
// =============================================================================

/**
 * Internal config type with all required properties.
 */
interface ResolvedConfig {
  rpcUrl?: string;
  chainId: string;
  minProfitThreshold: number;
  priorityFeeMultiplier: number;
  basePriorityFeeLamports: number;
  crossChainEnabled: boolean;
  triangularEnabled: boolean;
  maxTriangularDepth: number;
  opportunityExpiryMs: number;
  priceStalenessMs: number;
  defaultTradeValueUsd: number;
  normalizeLiquidStaking: boolean;
  crossChainCosts: {
    bridgeFeeDefault: number;
    evmGasCostUsd: number;
    solanaTxCostUsd: number;
    latencyRiskPremium: number;
  };
}

/**
 * Solana-specific arbitrage detector.
 * Extends EventEmitter for opportunity and price update events.
 */
export class SolanaArbitrageDetector extends EventEmitter {
  // Configuration
  private readonly config: ResolvedConfig;
  private readonly logger: SolanaArbitrageLogger;

  // Redis Streams client
  private streamsClient?: SolanaArbitrageStreamsClient;

  // Pool management
  private readonly poolStore = new VersionedPoolStore(MAX_POOL_STORE_SIZE);
  private readonly tokenCache = new LRUCache<string, string>(MAX_TOKEN_CACHE_SIZE);
  /** Tracks last update time per pool address for rate limiting (Fix #22) */
  private readonly poolUpdateTimestamps = new Map<string, number>();

  // Opportunity factory
  private opportunityFactory!: OpportunityFactory;

  // Statistics
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
  private detectionLatencies = new NumericRollingWindow(MAX_LATENCY_SAMPLES);

  // State
  private running = false;

  // Circuit breaker - uses shared SimpleCircuitBreaker (R12 consolidation)
  private circuitBreaker: SimpleCircuitBreaker;

  // Redis publishing state
  private redisPublishState = {
    consecutiveFailures: 0,
    lastFailureTime: 0,
    isDisabled: false,
  };

  // Detector connection
  private connectedDetector: EventEmitter | null = null;
  private detectorListeners: DetectorListenerRef[] = [];

  constructor(config: SolanaArbitrageConfig = {}, deps?: SolanaArbitrageDeps) {
    super();

    if (config.rpcUrl !== undefined && config.rpcUrl.trim() === '') {
      throw new Error('rpcUrl cannot be empty. Provide a valid Solana RPC URL.');
    }

    this.validateConfig(config);

    this.config = {
      rpcUrl: config.rpcUrl,
      chainId: config.chainId ?? DEFAULT_DETECTION_CONFIG.chainId,
      minProfitThreshold: config.minProfitThreshold ?? DEFAULT_DETECTION_CONFIG.minProfitThreshold,
      priorityFeeMultiplier: config.priorityFeeMultiplier ?? DEFAULT_DETECTION_CONFIG.priorityFeeMultiplier,
      basePriorityFeeLamports: config.basePriorityFeeLamports ?? DEFAULT_DETECTION_CONFIG.basePriorityFeeLamports,
      crossChainEnabled: config.crossChainEnabled ?? DEFAULT_DETECTION_CONFIG.crossChainEnabled,
      triangularEnabled: config.triangularEnabled ?? DEFAULT_DETECTION_CONFIG.triangularEnabled,
      maxTriangularDepth: config.maxTriangularDepth ?? DEFAULT_DETECTION_CONFIG.maxTriangularDepth,
      opportunityExpiryMs: config.opportunityExpiryMs ?? DEFAULT_DETECTION_CONFIG.opportunityExpiryMs,
      priceStalenessMs: config.priceStalenessMs ?? DEFAULT_DETECTION_CONFIG.priceStalenessMs,
      defaultTradeValueUsd: config.defaultTradeValueUsd ?? DEFAULT_DETECTION_CONFIG.defaultTradeValueUsd,
      normalizeLiquidStaking: config.normalizeLiquidStaking ?? DEFAULT_DETECTION_CONFIG.normalizeLiquidStaking,
      crossChainCosts: {
        bridgeFeeDefault: config.crossChainCosts?.bridgeFeeDefault ?? DEFAULT_DETECTION_CONFIG.crossChainCosts.bridgeFeeDefault,
        evmGasCostUsd: config.crossChainCosts?.evmGasCostUsd ?? DEFAULT_DETECTION_CONFIG.crossChainCosts.evmGasCostUsd,
        solanaTxCostUsd: config.crossChainCosts?.solanaTxCostUsd ?? DEFAULT_DETECTION_CONFIG.crossChainCosts.solanaTxCostUsd,
        latencyRiskPremium: config.crossChainCosts?.latencyRiskPremium ?? DEFAULT_DETECTION_CONFIG.crossChainCosts.latencyRiskPremium,
      },
    };

    this.opportunityFactory = new OpportunityFactory(
      this.config.chainId,
      this.config.opportunityExpiryMs
    );

    // Initialize circuit breaker with configured thresholds (R12 consolidation)
    this.circuitBreaker = createSimpleCircuitBreaker({
      threshold: CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD,
      resetTimeoutMs: CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS,
    });

    this.logger = deps?.logger ?? {
      info: console.log,
      warn: console.warn,
      error: console.error,
      debug: () => {},
    };

    this.streamsClient = deps?.streamsClient;

    this.logger.info('SolanaArbitrageDetector initialized', {
      chainId: this.config.chainId,
      minProfitThreshold: this.config.minProfitThreshold,
      crossChainEnabled: this.config.crossChainEnabled,
      triangularEnabled: this.config.triangularEnabled,
      hasStreamsClient: !!this.streamsClient,
    });
  }

  private validateConfig(config: SolanaArbitrageConfig): void {
    if (config.minProfitThreshold !== undefined) {
      if (isNaN(config.minProfitThreshold) || config.minProfitThreshold < 0) {
        throw new Error(`Invalid minProfitThreshold: ${config.minProfitThreshold}. Must be >= 0.`);
      }
    }
    if (config.defaultTradeValueUsd !== undefined) {
      if (isNaN(config.defaultTradeValueUsd) || config.defaultTradeValueUsd <= 0) {
        throw new Error(`Invalid defaultTradeValueUsd: ${config.defaultTradeValueUsd}. Must be > 0.`);
      }
    }
    if (config.maxTriangularDepth !== undefined) {
      if (!Number.isInteger(config.maxTriangularDepth) || config.maxTriangularDepth < 2 || config.maxTriangularDepth > 10) {
        throw new Error(`Invalid maxTriangularDepth: ${config.maxTriangularDepth}. Must be integer between 2 and 10.`);
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
    // Always clean up detector listeners, even if not running
    // (connectToSolanaDetector can be called independently of start)
    if (this.connectedDetector && this.detectorListeners.length > 0) {
      for (const { event, handler } of this.detectorListeners) {
        this.connectedDetector.off(event, handler);
      }
      this.detectorListeners = [];
      this.connectedDetector = null;
      this.logger.debug('Cleaned up detector event listeners');
    }

    if (!this.running) return;
    this.running = false;

    this.tokenCache.clear();
    this.poolUpdateTimestamps.clear();

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
    // Fix #22: Rate limit pool updates to prevent CPU saturation from update floods
    const now = Date.now();
    const lastUpdate = this.poolUpdateTimestamps.get(pool.address);
    if (lastUpdate !== undefined && (now - lastUpdate) < POOL_UPDATE_COOLDOWN_MS) {
      this.logger.debug('Pool update throttled', { address: pool.address });
      return;
    }
    this.poolUpdateTimestamps.set(pool.address, now);

    if (!isValidPoolAddress(pool.address) && !pool.address.includes(':')) {
      this.logger.warn('Invalid pool address format, skipping', {
        address: pool.address?.slice(0, 50),
      });
      return;
    }

    if (!isValidFee(pool.fee)) {
      this.logger.warn('Invalid pool fee, skipping', {
        address: pool.address,
        fee: pool.fee,
      });
      return;
    }

    const sanitizedToken0Symbol = sanitizeTokenSymbol(pool.token0.symbol);
    const sanitizedToken1Symbol = sanitizeTokenSymbol(pool.token1.symbol);

    if (!sanitizedToken0Symbol || !sanitizedToken1Symbol) {
      this.logger.warn('Invalid token symbols, skipping pool', {
        address: pool.address,
      });
      return;
    }

    const normalizedToken0 = this.getNormalizedToken(sanitizedToken0Symbol);
    const normalizedToken1 = this.getNormalizedToken(sanitizedToken1Symbol);
    const pairKey = this.createPairKeyFromNormalized(normalizedToken0, normalizedToken1);

    const internalPool: InternalPoolInfo = {
      ...pool,
      token0: { ...pool.token0, symbol: sanitizedToken0Symbol },
      token1: { ...pool.token1, symbol: sanitizedToken1Symbol },
      normalizedToken0,
      normalizedToken1,
      pairKey,
      lastUpdated: pool.lastUpdated ?? Date.now(),
    };

    this.poolStore.set(internalPool);
    this.stats.poolsTracked = this.poolStore.size;

    this.logger.debug('Pool added', { address: pool.address, dex: pool.dex, pairKey });
  }

  removePool(address: string): void {
    this.poolStore.delete(address);
    this.stats.poolsTracked = this.poolStore.size;
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

  updatePoolPrice(address: string, newPrice: number, lastSlot?: number): void {
    const pool = this.poolStore.get(address);
    if (!pool) {
      this.logger.warn('Cannot update price for non-existent pool', { address });
      return;
    }

    const oldPrice = pool.price;
    if (oldPrice === newPrice && !lastSlot) return;

    // Mutate in-place (VersionedPoolStore stores by reference) — avoids spread allocation per price tick
    pool.price = newPrice;
    pool.lastUpdated = Date.now();
    if (lastSlot !== undefined) {
      pool.lastSlot = lastSlot;
    }

    // Re-set to update version tracking in pool store
    this.poolStore.set(pool);

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

  private getNormalizedToken(symbol: string): string {
    let normalized = this.tokenCache.get(symbol);
    if (normalized === undefined) {
      // Phase 0 Item 2: Use pricing normalization (preserves LST identities) unless
      // explicitly configured to collapse LSTs for cross-chain routing
      normalized = this.config.normalizeLiquidStaking
        ? normalizeTokenForCrossChain(symbol)
        : normalizeTokenForPricing(symbol);
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
    const sorted = token0 < token1 ? [token0, token1] : [token1, token0];
    return `${sorted[0]}-${sorted[1]}`;
  }

  // ===========================================================================
  // Circuit Breaker (R12 consolidation - uses shared SimpleCircuitBreaker)
  // ===========================================================================

  /**
   * Check if detection is allowed (circuit not open).
   * Uses SimpleCircuitBreaker which handles implicit half-open state.
   */
  private isDetectionAllowed(): boolean {
    if (this.circuitBreaker.isCurrentlyOpen()) {
      return false;
    }
    // Log when entering half-open state (cooldown expired, allowing one attempt)
    const status = this.circuitBreaker.getStatus();
    if (status.isOpen && status.lastFailure > 0) {
      this.logger.info('Circuit breaker allowing attempt after cooldown (half-open)');
    }
    return true;
  }

  /**
   * Record successful detection - resets circuit breaker.
   */
  private recordDetectionSuccess(): void {
    const wasOpen = this.circuitBreaker.recordSuccess();
    if (wasOpen) {
      this.logger.info('Circuit breaker reset after successful detection');
    }
  }

  /**
   * Record detection failure - may open circuit breaker.
   */
  private recordDetectionFailure(_error: unknown): void {
    const justOpened = this.circuitBreaker.recordFailure();
    if (justOpened) {
      this.logger.warn('Circuit breaker opened after repeated failures', {
        failures: this.circuitBreaker.getFailures(),
      });
    }
  }

  /**
   * Get circuit breaker status for monitoring.
   * Maintains backward-compatible return type.
   */
  getCircuitBreakerStatus(): { isOpen: boolean; failures: number; lastFailureTime: number; inHalfOpenState: boolean } {
    const status = this.circuitBreaker.getStatus();
    // Derive inHalfOpenState: circuit is open but cooldown has expired
    const inHalfOpenState = status.isOpen && !this.circuitBreaker.isCurrentlyOpen();
    return {
      isOpen: status.isOpen,
      failures: status.failures,
      lastFailureTime: status.lastFailure,
      inHalfOpenState,
    };
  }

  // ===========================================================================
  // Detection Methods (Delegating to extracted modules)
  // ===========================================================================

  async detectIntraSolanaArbitrage(): Promise<SolanaArbitrageOpportunity[]> {
    if (!this.isDetectionAllowed()) return [];

    try {
      const result = detectIntraSolanaArbitrage(
        this.poolStore,
        this.opportunityFactory,
        {
          minProfitThreshold: this.config.minProfitThreshold,
          priceStalenessMs: this.config.priceStalenessMs,
          basePriorityFeeLamports: this.config.basePriorityFeeLamports,
          priorityFeeMultiplier: this.config.priorityFeeMultiplier,
          defaultTradeValueUsd: this.config.defaultTradeValueUsd,
        },
        this.logger
      );

      // Emit opportunities
      for (const opportunity of result.opportunities) {
        this.emit('opportunity', opportunity);
      }

      this.updateDetectionStats('intra', result.opportunities.length, result.stalePoolsSkipped, result.latencyMs);
      this.recordDetectionSuccess();

      return result.opportunities;
    } catch (error) {
      this.recordDetectionFailure(error);
      this.logger.error('Error in intra-Solana arbitrage detection', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  async detectTriangularArbitrage(): Promise<SolanaArbitrageOpportunity[]> {
    if (!this.config.triangularEnabled) return [];
    if (!this.isDetectionAllowed()) return [];

    try {
      const result = detectTriangularArbitrage(
        this.poolStore,
        this.opportunityFactory,
        {
          minProfitThreshold: this.config.minProfitThreshold,
          maxTriangularDepth: this.config.maxTriangularDepth,
          priceStalenessMs: this.config.priceStalenessMs,
        },
        this.logger
      );

      for (const opportunity of result.opportunities) {
        this.emit('opportunity', opportunity);
      }

      this.updateDetectionStats('triangular', result.opportunities.length, 0, result.latencyMs);
      this.recordDetectionSuccess();

      return result.opportunities;
    } catch (error) {
      this.recordDetectionFailure(error);
      this.logger.error('Error in triangular arbitrage detection', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  async compareCrossChainPrices(evmPrices: EvmPriceUpdate[]): Promise<CrossChainPriceComparison[]> {
    if (!this.config.crossChainEnabled) return [];

    // Phase 0 Item 2: Cross-chain comparison always uses cross-chain normalization
    // (MSOL→SOL) regardless of normalizeLiquidStaking setting, because the purpose
    // of this function is to match Solana tokens to their EVM equivalents.
    return comparePrices(
      evmPrices,
      this.poolStore,
      (symbol) => normalizeTokenForCrossChain(symbol),
      (t0, t1) => this.createPairKeyFromNormalized(t0, t1),
      {
        minProfitThreshold: this.config.minProfitThreshold,
        priceStalenessMs: this.config.priceStalenessMs,
        defaultTradeValueUsd: this.config.defaultTradeValueUsd,
        crossChainCosts: {
          bridgeFeeDefault: this.config.crossChainCosts.bridgeFeeDefault,
          evmGasCostUsd: this.config.crossChainCosts.evmGasCostUsd,
          solanaTxCostUsd: this.config.crossChainCosts.solanaTxCostUsd,
          latencyRiskPremium: this.config.crossChainCosts.latencyRiskPremium,
        },
      },
      this.logger
    );
  }

  async detectCrossChainArbitrage(evmPrices: EvmPriceUpdate[]): Promise<SolanaArbitrageOpportunity[]> {
    if (!this.config.crossChainEnabled) return [];
    if (!this.isDetectionAllowed()) return [];

    try {
      // Fix 10: Use normalizeTokenForCrossChain for cross-chain detection consistency.
      // Previously used getNormalizedToken() which may use pricing normalization
      // (preserving LST identities), causing missed cross-chain LST opportunities.
      // @see compareCrossChainPrices() which already uses normalizeTokenForCrossChain
      const result = detectCrossChainArbitrage(
        evmPrices,
        this.poolStore,
        this.opportunityFactory,
        (symbol) => normalizeTokenForCrossChain(symbol),
        (t0, t1) => this.createPairKeyFromNormalized(t0, t1),
        {
          minProfitThreshold: this.config.minProfitThreshold,
          priceStalenessMs: this.config.priceStalenessMs,
          defaultTradeValueUsd: this.config.defaultTradeValueUsd,
          crossChainCosts: {
            bridgeFeeDefault: this.config.crossChainCosts.bridgeFeeDefault,
            evmGasCostUsd: this.config.crossChainCosts.evmGasCostUsd,
            solanaTxCostUsd: this.config.crossChainCosts.solanaTxCostUsd,
            latencyRiskPremium: this.config.crossChainCosts.latencyRiskPremium,
          },
        },
        this.logger
      );

      for (const opportunity of result.opportunities) {
        this.emit('opportunity', opportunity);
      }

      this.updateDetectionStats('crossChain', result.opportunities.length, 0, result.latencyMs);
      this.recordDetectionSuccess();

      return result.opportunities;
    } catch (error) {
      this.recordDetectionFailure(error);
      this.logger.error('Error in cross-chain arbitrage detection', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  // ===========================================================================
  // Priority Fee Estimation
  // ===========================================================================

  async estimatePriorityFee(request: PriorityFeeRequest): Promise<PriorityFeeEstimate> {
    return calculatePriorityFee(request.computeUnits, request.urgency, {
      basePriorityFeeLamports: this.config.basePriorityFeeLamports,
      priorityFeeMultiplier: this.config.priorityFeeMultiplier,
    });
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
    this.detectionLatencies.clear();
  }

  getMetrics(): Record<string, number> {
    const cb = this.getCircuitBreakerStatus();
    return {
      'solana_arbitrage_pools_tracked': this.stats.poolsTracked,
      'solana_arbitrage_pool_store_version': this.poolStore.getVersion(),
      'solana_arbitrage_detections_total': this.stats.totalDetections,
      'solana_arbitrage_opportunities_intra_total': this.stats.intraSolanaOpportunities,
      'solana_arbitrage_opportunities_triangular_total': this.stats.triangularOpportunities,
      'solana_arbitrage_opportunities_crosschain_total': this.stats.crossChainOpportunities,
      'solana_arbitrage_detection_latency_ms': this.stats.avgDetectionLatencyMs,
      'solana_arbitrage_stale_pools_skipped_total': this.stats.stalePoolsSkipped,
      'solana_arbitrage_circuit_breaker_open': cb.isOpen ? 1 : 0,
      'solana_arbitrage_circuit_breaker_failures': cb.failures,
      'solana_arbitrage_running': this.running ? 1 : 0,
      'solana_arbitrage_token_cache_size': this.tokenCache.size,
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

  async publishOpportunity(opportunity: SolanaArbitrageOpportunity): Promise<void> {
    if (!this.streamsClient) {
      this.logger.debug('No streams client, skipping opportunity publish', {
        opportunityId: opportunity.id,
      });
      return;
    }

    if (this.redisPublishState.isDisabled) {
      const timeSinceFailure = Date.now() - this.redisPublishState.lastFailureTime;
      if (timeSinceFailure < REDIS_RETRY.COOLDOWN_MS) {
        return;
      }
      this.redisPublishState.isDisabled = false;
      this.redisPublishState.consecutiveFailures = 0;
    }

    // P1-7: Inject trace context for cross-service correlation, matching P1-P3 pattern.
    // Previously raw xadd without tracing made end-to-end debugging impossible.
    // @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P1-7
    const traceCtx = createTraceContext('partition-solana');
    const baseData: Record<string, string> = {
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
    const data = propagateContext(baseData, traceCtx) as Record<string, string>;

    for (let attempt = 1; attempt <= REDIS_RETRY.MAX_ATTEMPTS; attempt++) {
      try {
        await this.streamsClient.xadd(OPPORTUNITY_STREAM, data);
        if (this.redisPublishState.consecutiveFailures > 0) {
          this.redisPublishState.consecutiveFailures = 0;
        }
        return;
      } catch (error) {
        if (attempt === REDIS_RETRY.MAX_ATTEMPTS) {
          this.redisPublishState.consecutiveFailures++;
          this.redisPublishState.lastFailureTime = Date.now();

          if (this.redisPublishState.consecutiveFailures >= REDIS_RETRY.FAILURE_THRESHOLD) {
            this.redisPublishState.isDisabled = true;
            this.emit('redis-publishing-disabled', {
              failures: this.redisPublishState.consecutiveFailures,
            });
          }

          // Log the error after all retries exhausted
          this.logger.error('Failed to publish opportunity to Redis Streams', {
            error: getErrorMessage(error),
            opportunityId: opportunity.id,
            attempts: REDIS_RETRY.MAX_ATTEMPTS,
          });
        } else {
          const delay = REDIS_RETRY.BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  // ===========================================================================
  // SolanaDetector Integration
  // ===========================================================================

  connectToSolanaDetector(detector: EventEmitter): void {
    // Clean up existing connection
    if (this.connectedDetector && this.detectorListeners.length > 0) {
      for (const { event, handler } of this.detectorListeners) {
        this.connectedDetector.off(event, handler);
      }
      this.detectorListeners = [];
      this.connectedDetector = null;
    }

    const adaptPriceUpdate = (update: UnifiedPriceUpdate | SolanaPoolInfo): SolanaPoolInfo | null => {
      if (!update || typeof update !== 'object') {
        this.logger.warn('Received invalid price update (null/undefined/non-object)', {
          type: typeof update,
        });
        return null;
      }

      if ('token0' in update && typeof update.token0 === 'object' && 'symbol' in update.token0) {
        return update as SolanaPoolInfo;
      }

      const priceUpdate = update as UnifiedPriceUpdate;
      if (!priceUpdate.chain || !priceUpdate.dex || !priceUpdate.pairKey ||
          !priceUpdate.token0 || !priceUpdate.token1 || typeof priceUpdate.price !== 'number') {
        this.logger.warn('Received malformed price update with missing fields', {
          chain: priceUpdate.chain,
          hasDex: !!priceUpdate.dex,
          hasPairKey: !!priceUpdate.pairKey,
        });
        return null;
      }

      if (priceUpdate.chain !== this.config.chainId && priceUpdate.chain !== 'solana') {
        return null;
      }

      const fee = priceUpdate.fee ?? DEFAULT_ADAPTED_FEE_BPS;
      if (priceUpdate.fee === undefined || priceUpdate.fee === null) {
        this.logger.debug('Using default adapted fee for price update', {
          pairKey: priceUpdate.pairKey,
          dex: priceUpdate.dex,
          defaultFeeBps: DEFAULT_ADAPTED_FEE_BPS,
        });
      }

      return {
        address: priceUpdate.pairKey,
        programId: 'unknown',
        dex: priceUpdate.dex,
        token0: { mint: priceUpdate.token0, symbol: priceUpdate.token0, decimals: getTokenDecimals(priceUpdate.token0) },
        token1: { mint: priceUpdate.token1, symbol: priceUpdate.token1, decimals: getTokenDecimals(priceUpdate.token1) },
        fee,
        reserve0: priceUpdate.reserve0,
        reserve1: priceUpdate.reserve1,
        price: priceUpdate.price,
        lastUpdated: priceUpdate.timestamp,
      };
    };

    const handleUpdate = (update: UnifiedPriceUpdate | SolanaPoolInfo): void => {
      const pool = adaptPriceUpdate(update);
      if (!pool) return;

      const existing = this.poolStore.get(pool.address);
      if (existing) {
        if (pool.price !== undefined && isValidPrice(pool.price)) {
          this.updatePoolPrice(pool.address, pool.price);
        }
      } else {
        if (this.isValidPool(pool)) {
          if (pool.price === undefined || isValidPrice(pool.price)) {
            this.addPool(pool);
          }
        }
      }
    };

    const handlePoolRemoved = (address: string): void => {
      this.removePool(address);
    };

    this.connectedDetector = detector;
    this.detectorListeners = [
      { event: 'poolUpdate', handler: handleUpdate as PoolUpdateHandler },
      { event: 'priceUpdate', handler: handleUpdate as PoolUpdateHandler },
      { event: 'poolRemoved', handler: handlePoolRemoved as PoolRemovedHandler },
    ];

    detector.on('poolUpdate', handleUpdate);
    detector.on('priceUpdate', handleUpdate);
    detector.on('poolRemoved', handlePoolRemoved);

    this.logger.info('Connected to SolanaDetector for pool updates');
  }

  private isValidPool(pool: unknown): pool is SolanaPoolInfo {
    if (!pool || typeof pool !== 'object') return false;
    const p = pool as Record<string, unknown>;

    if (typeof p.address !== 'string' || !p.address) return false;
    if (typeof p.programId !== 'string') return false;
    if (typeof p.dex !== 'string') return false;
    if (typeof p.fee !== 'number' || !isFinite(p.fee) || p.fee < 0 || p.fee > 10000) return false;

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

  importPools(pools: SolanaPoolInfo[]): void {
    if (!pools || !Array.isArray(pools)) {
      this.logger.warn('importPools called with invalid pools array');
      return;
    }

    if (pools.length === 0) {
      this.logger.debug('importPools called with empty array, nothing to import');
      return;
    }

    let imported = 0;
    let skipped = 0;

    for (const pool of pools) {
      if (this.isValidPool(pool)) {
        this.addPool(pool);
        imported++;
      } else {
        skipped++;
      }
    }

    this.logger.info('Imported pools', { imported, skipped, total: pools.length });
  }
}

// =============================================================================
// Exports
// =============================================================================

export { SolanaArbitrageDetector as default };

// Re-export types for convenience
export type {
  SolanaArbitrageConfig,
  SolanaArbitrageDeps,
  SolanaArbitrageOpportunity,
  SolanaPoolInfo,
  SolanaTokenInfo,
  SolanaArbitrageStats,
  EvmPriceUpdate,
  CrossChainPriceComparison,
  PriorityFeeEstimate,
  PriorityFeeRequest,
  SolanaArbitrageLogger,
  SolanaArbitrageStreamsClient,
  TriangularPath,
  TriangularPathStep,
} from './types';
