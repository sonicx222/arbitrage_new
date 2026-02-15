/**
 * Cross-Chain Arbitrage Detector Service
 *
 * Detects arbitrage opportunities across multiple chains by monitoring
 * price discrepancies and accounting for bridge costs.
 *
 * Uses Redis Streams for event consumption (ADR-002 compliant).
 * Uses ServiceStateManager for lifecycle management.
 *
 * Architecture Note: Intentional Exception to BaseDetector Pattern
 * ----------------------------------------------------------------
 * This service does NOT extend BaseDetector for the following reasons:
 *
 * 1. **Consumer vs Producer**: BaseDetector is designed for single-chain
 *    event producers (subscribe to chain -> publish price updates).
 *    CrossChainDetector is an event consumer (consume price updates from
 *    ALL chains -> detect cross-chain opportunities).
 *
 * 2. **No WebSocket Connection**: BaseDetector manages WebSocket connections
 *    to blockchain nodes. CrossChainDetector has no direct blockchain
 *    connection - it consumes from Redis Streams.
 *
 * 3. **Different Lifecycle**: BaseDetector's lifecycle is tied to chain
 *    availability. CrossChainDetector's lifecycle is tied to Redis Streams.
 *
 * 4. **Multi-Chain by Design**: BaseDetector = 1 chain per instance.
 *    CrossChainDetector = aggregates ALL chains in one instance.
 *
 * This architectural decision is documented here as there is no separate ADR.
 * FIX 2.1: Removed reference to non-existent ADR-003.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Failover Strategy
 */

import {
  getRedisClient,
  RedisClient,
  createLogger,
  getPerformanceLogger,
  PerformanceLogger,
  RedisStreamsClient,
  getRedisStreamsClient,
  ConsumerGroupConfig,
  ServiceStateManager,
  ServiceState,
  createServiceState,
  getPriceOracle,
  PriceOracle,
  // P1-5 FIX: Reusable concurrency guard for detection and health loops
  OperationGuard,
  disconnectWithTimeout,
  clearIntervalSafe,
  clearTimeoutSafe,
} from '@arbitrage/core';
import {
  ARBITRAGE_CONFIG,
  // Used for individual token normalization in extractTokenFromPair, whale analysis, etc.
  normalizeTokenForCrossChain,
  // REFACTOR: Use centralized default quote tokens from config
  getDefaultQuoteToken,
  // FIX 9.1: Use centralized chain ID mapping
  getChainName,
} from '@arbitrage/config';
import {
  PriceUpdate,
  WhaleTransaction,
  CrossChainBridge,
  // Task 1.3.3: Pending opportunity types for mempool integration
  PendingOpportunity,
  // FIX 7.1: Import PendingSwapIntent for pending opportunity analysis
  PendingSwapIntent,
} from '@arbitrage/types';
import { BridgeLatencyPredictor } from './bridge-predictor';

// ADR-014: Import modular components for single-responsibility design
import { createStreamConsumer, StreamConsumer } from './stream-consumer';
import { createPriceDataManager, PriceDataManager, PricePoint } from './price-data-manager';
import { createOpportunityPublisher, OpportunityPublisher } from './opportunity-publisher';
import { createBridgeCostEstimator, BridgeCostEstimator } from './bridge-cost-estimator';
// ADR-014: Import MLPredictionManager for centralized ML prediction handling
import { createMLPredictionManager, MLPredictionManager } from './ml-prediction-manager';
// P0-7: Import PreValidationOrchestrator for extracted pre-validation logic
import { PreValidationOrchestrator } from './pre-validation-orchestrator';
// P2-2: Import ConfidenceCalculator for extracted confidence calculation logic
// Note: WhaleActivitySummary is already imported from @arbitrage/core
import {
  createConfidenceCalculator,
  ConfidenceCalculator,
  type WhaleActivitySummary as ConfidenceWhaleActivitySummary,
} from './confidence-calculator';
// TYPE-CONSOLIDATION: Import shared types from types.ts
import {
  CrossChainOpportunity,
  DetectorConfig,
  WhaleAnalysisConfig,
  MLPredictionConfig,
  // FIX 7.1: Import toDisplayTokenPair for pending opportunity formatting
  toDisplayTokenPair,
  // FIX #13: Import separator for exact token matching in whale pair lookup
  TOKEN_PAIR_INTERNAL_SEPARATOR,
  // P0-7: Pre-validation types (config and callback used for DI)
  PreValidationConfig,
  PreValidationSimulationCallback,
} from './types';

// Phase 3: Whale Activity Tracker imports
// DEAD-CODE-REMOVED: PriceMomentumTracker, MomentumSignal - never used in detection
import {
  getWhaleActivityTracker,
  WhaleActivityTracker,
  WhaleActivitySummary,
  TrackedWhaleTransaction,
} from '@arbitrage/core';
// ML Predictor types - P0-3 FIX: getLSTMPredictor and LSTMPredictor now owned by MLPredictionManager
import {
  PredictionResult,
} from '@arbitrage/ml';

// =============================================================================
// Types
// =============================================================================

// PriceData, CrossChainOpportunity, DetectorConfig, WhaleAnalysisConfig, MLPredictionConfig
// are now imported from ./types.ts - See ADR-014: Type Consolidation

// FIX #7: Module-scoped constant to avoid per-call BigInt construction
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// =============================================================================
// Default Configuration (Config C1: Configurable Values)
// =============================================================================

/** Default whale analysis configuration */
const DEFAULT_WHALE_CONFIG: WhaleAnalysisConfig = {
  superWhaleThresholdUsd: 500000,
  significantFlowThresholdUsd: 100000,
  whaleBullishBoost: 1.15,
  whaleBearishPenalty: 0.85,
  superWhaleBoost: 1.25,
  activityWindowMs: 5 * 60 * 1000, // 5 minutes
};

/** Default ML prediction configuration */
const DEFAULT_ML_CONFIG: MLPredictionConfig = {
  enabled: true,
  minConfidence: 0.6,
  alignedBoost: 1.15,
  opposedPenalty: 0.9,
  // FIX PERF-1: Increased from 10ms to 50ms - TensorFlow.js predictions typically take 20-50ms
  // 10ms caused most predictions to timeout, wasting computation
  maxLatencyMs: 50,
  cacheTtlMs: 1000,
};

/**
 * FIX #12: Environment-aware detector configuration
 * Production environments need faster detection for competitive arbitrage trading.
 *
 * FIX 3.1: Detection interval must be greater than typical detection cycle time
 * to prevent cycles from being skipped. Typical cycle time includes:
 * - Snapshot creation: ~1-5ms
 * - ML predictions (optional): up to 50ms
 * - Price comparison: ~1-10ms (depends on pair count)
 * - Opportunity publishing: ~1-5ms
 * Total: ~10-70ms typical, 100ms safe minimum for production.
 */
const isProduction = process.env.NODE_ENV === 'production';

/** Phase 3: Default pre-validation configuration */
const DEFAULT_PRE_VALIDATION_CONFIG: PreValidationConfig = {
  enabled: false, // Disabled by default until SimulationService integration is complete
  sampleRate: 0.1, // 10% of opportunities
  minProfitForValidation: 50, // Only validate $50+ opportunities
  maxLatencyMs: 100, // Skip if validation takes too long
  monthlyBudget: 2500, // 10% of Tenderly's 25K/month
  preferredProvider: 'alchemy', // Preserve Tenderly budget for execution
};

const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  // FIX 3.1: Production interval increased from 50ms to 100ms
  // 50ms was too aggressive - detection cycles would overlap and get skipped
  // 100ms provides good balance between speed and reliability
  detectionIntervalMs: isProduction ? 100 : 200,
  // FIX #12: More frequent health checks in production for faster failover
  healthCheckIntervalMs: isProduction ? 10000 : 30000,
  bridgeCleanupFrequency: 100,
  defaultTradeSizeUsd: 1000,
  // P1-FIX 2.3: Configurable gas estimate for swap operations
  // ~200k gas is typical for complex DEX swaps (Uniswap V3, multi-hop, etc.)
  estimatedSwapGas: 200000,
  whaleConfig: DEFAULT_WHALE_CONFIG,
  mlConfig: DEFAULT_ML_CONFIG,
  // Phase 3: Pre-validation config (disabled by default)
  preValidationConfig: DEFAULT_PRE_VALIDATION_CONFIG,
};

// =============================================================================
// Cross-Chain Detector Service
// =============================================================================

export class CrossChainDetectorService {
  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null;
  private priceOracle: PriceOracle | null = null;
  private logger = createLogger('cross-chain-detector');
  private perfLogger: PerformanceLogger;
  private stateManager: ServiceStateManager;

  // ADR-014: Modular components for single-responsibility design
  private streamConsumer: StreamConsumer | null = null;
  private priceDataManager: PriceDataManager | null = null;
  private opportunityPublisher: OpportunityPublisher | null = null;
  private bridgeCostEstimator: BridgeCostEstimator | null = null;
  // ADR-014: MLPredictionManager for centralized ML prediction handling (replaces inline implementation)
  private mlPredictionManager: MLPredictionManager | null = null;

  private bridgePredictor: BridgeLatencyPredictor;

  // Phase 3: ML Predictor state and Whale Activity Tracker
  // P0-3 FIX: LSTMPredictor instance now owned exclusively by MLPredictionManager
  private mlPredictorInitialized = false;
  private whaleTracker: WhaleActivityTracker | null = null;
  // DEAD-CODE-REMOVED: momentumTracker was never used in detection logic

  // Config C1: Configurable values (replaces hardcoded constants)
  private readonly config: Required<DetectorConfig>;
  private readonly whaleConfig: WhaleAnalysisConfig;
  private readonly mlConfig: MLPredictionConfig;

  // Consumer group configuration
  private readonly consumerGroups: ConsumerGroupConfig[];
  private readonly instanceId: string;

  // Intervals
  private opportunityDetectionInterval: NodeJS.Timeout | null = null;
  private healthMonitoringInterval: NodeJS.Timeout | null = null;
  // Phase 3: ETH price refresh interval for accurate bridge cost estimation
  private ethPriceRefreshInterval: NodeJS.Timeout | null = null;

  // P1-5 FIX: Reusable concurrency guards for async operations
  // Replaces manual boolean flags (isMonitoringHealth, isDetecting) with OperationGuard
  private readonly healthGuard = new OperationGuard('health-monitoring');
  private readonly detectionGuard = new OperationGuard('detection');
  // SECURITY-FIX: Rate limiting for whale-triggered detection to prevent DoS
  private readonly whaleGuard = new OperationGuard('whale-detection', { cooldownMs: 1000 });

  // FIX #5: Rate limiting for updateBridgeData() to prevent abuse
  private bridgeDataRateLimit: Map<string, number[]> = new Map();

  // FIX #5: Circuit breaker for detection loop errors
  private consecutiveDetectionErrors = 0;
  private static readonly DETECTION_ERROR_THRESHOLD = 5;
  private static readonly CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds to reset
  private lastCircuitBreakerTrip = 0;

  // FIX #22: Reuse ML predictions map across cycles to reduce GC pressure
  private mlPredictionsCache = new Map<string, PredictionResult | null>();

  // FIX #9: ETH price circuit breaker - track recent prices for rate-of-change rejection
  private recentEthPrices: number[] = [];
  private static readonly ETH_PRICE_HISTORY_SIZE = 10;
  private static readonly ETH_PRICE_MAX_DEVIATION = 0.2; // 20% from median

  // FIX #23: Cycle counter for structured logging
  private detectionCycleCounter = 0;

  // Task 1.3.3: Counter for pending opportunities received from mempool
  private pendingOpportunitiesReceived = 0;

  // P0-7: Pre-validation delegated to PreValidationOrchestrator
  // Extracted for SRP - see REFACTORING_IMPLEMENTATION_PLAN.md P0-7
  private preValidationOrchestrator: PreValidationOrchestrator | null = null;

  // P2-2: Confidence calculation delegated to ConfidenceCalculator
  // Extracted for SRP - see REFACTORING_IMPLEMENTATION_PLAN.md P2-2
  private confidenceCalculator: ConfidenceCalculator | null = null;

  // ADR-014: ML Integration now handled by MLPredictionManager module
  // REMOVED: priceHistoryCache, priceHistoryMaxLength, mlPredictionCache
  // These are now managed by mlPredictionManager for single-responsibility design

  constructor(userConfig: DetectorConfig = {}) {
    this.perfLogger = getPerformanceLogger('cross-chain-detector');
    this.bridgePredictor = new BridgeLatencyPredictor(this.logger);

    // Config C1: Merge user config with defaults
    this.config = {
      ...DEFAULT_DETECTOR_CONFIG,
      ...userConfig,
      whaleConfig: { ...DEFAULT_WHALE_CONFIG, ...userConfig.whaleConfig },
      mlConfig: { ...DEFAULT_ML_CONFIG, ...userConfig.mlConfig },
      // Phase 3: Merge pre-validation config
      preValidationConfig: { ...DEFAULT_PRE_VALIDATION_CONFIG, ...userConfig.preValidationConfig },
    } as Required<DetectorConfig>;
    this.whaleConfig = this.config.whaleConfig!;
    this.mlConfig = this.config.mlConfig!;

    // P0-7: Initialize PreValidationOrchestrator with config and simulation callback
    this.preValidationOrchestrator = new PreValidationOrchestrator(
      this.config.preValidationConfig!,
      this.logger,
      this.config.defaultTradeSizeUsd
    );
    // Set simulation callback if provided
    if (userConfig.simulationCallback) {
      this.preValidationOrchestrator.setSimulationCallback(userConfig.simulationCallback);
    }

    // P2-2: Initialize ConfidenceCalculator with ML and whale configs
    this.confidenceCalculator = createConfidenceCalculator(
      {
        ml: this.mlConfig,
        whale: this.whaleConfig,
      },
      this.logger
    );

    // FIX: Configuration validation
    this.validateConfiguration();

    // Generate unique instance ID
    this.instanceId = `cross-chain-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    // State machine for lifecycle management
    this.stateManager = createServiceState({
      serviceName: 'cross-chain-detector',
      transitionTimeoutMs: 30000
    });

    // Define consumer groups for streams we need to consume
    this.consumerGroups = [
      {
        streamName: RedisStreamsClient.STREAMS.PRICE_UPDATES,
        groupName: 'cross-chain-detector-group',
        consumerName: this.instanceId,
        startId: '$'
      },
      {
        streamName: RedisStreamsClient.STREAMS.WHALE_ALERTS,
        groupName: 'cross-chain-detector-group',
        consumerName: this.instanceId,
        startId: '$'
      },
      // Task 1.3.3: Pending opportunities from mempool detection
      {
        streamName: RedisStreamsClient.STREAMS.PENDING_OPPORTUNITIES,
        groupName: 'cross-chain-detector-group',
        consumerName: this.instanceId,
        startId: '$'
      }
    ];
  }

  // ===========================================================================
  // Configuration Validation
  // ===========================================================================

  /**
   * Validate configuration values are within acceptable bounds.
   * Throws on invalid configuration, warns on suboptimal values.
   */
  private validateConfiguration(): void {
    const { detectionIntervalMs, healthCheckIntervalMs, defaultTradeSizeUsd } = this.config;
    const { maxLatencyMs, minConfidence, alignedBoost, opposedPenalty } = this.mlConfig;

    // Critical validation - throw on invalid config
    if (detectionIntervalMs !== undefined && detectionIntervalMs < 10) {
      throw new Error(`detectionIntervalMs must be >= 10ms, got ${detectionIntervalMs}`);
    }

    if (defaultTradeSizeUsd !== undefined && defaultTradeSizeUsd <= 0) {
      throw new Error(`defaultTradeSizeUsd must be > 0, got ${defaultTradeSizeUsd}`);
    }

    if (minConfidence !== undefined && (minConfidence < 0 || minConfidence > 1)) {
      throw new Error(`mlConfig.minConfidence must be 0-1, got ${minConfidence}`);
    }

    if (alignedBoost !== undefined && alignedBoost < 1) {
      throw new Error(`mlConfig.alignedBoost must be >= 1, got ${alignedBoost}`);
    }

    if (opposedPenalty !== undefined && (opposedPenalty < 0 || opposedPenalty > 1)) {
      throw new Error(`mlConfig.opposedPenalty must be 0-1, got ${opposedPenalty}`);
    }

    // Warning validation - suboptimal but valid config
    if (maxLatencyMs !== undefined && detectionIntervalMs !== undefined && maxLatencyMs > detectionIntervalMs) {
      this.logger.warn('mlConfig.maxLatencyMs exceeds detectionIntervalMs - ML predictions may delay detection', {
        maxLatencyMs,
        detectionIntervalMs,
      });
    }

    if (healthCheckIntervalMs !== undefined && healthCheckIntervalMs < 5000) {
      this.logger.warn('healthCheckIntervalMs is very low - may cause excessive Redis writes', {
        healthCheckIntervalMs,
      });
    }

    this.logger.debug('Configuration validated', {
      detectionIntervalMs,
      healthCheckIntervalMs,
      defaultTradeSizeUsd,
      mlEnabled: this.mlConfig.enabled,
    });
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(): Promise<void> {
    const result = await this.stateManager.executeStart(async () => {
      this.logger.info('Starting Cross-Chain Detector Service', {
        instanceId: this.instanceId
      });

      // FIX: Check if cross-chain arbitrage is enabled in config
      if (!ARBITRAGE_CONFIG.crossChainEnabled) {
        this.logger.warn('Cross-chain arbitrage is DISABLED in config (ARBITRAGE_CONFIG.crossChainEnabled=false). ' +
          'Service will start but opportunities will not be published until enabled.');
      }

      // Initialize Redis clients
      this.redis = await getRedisClient();
      this.streamsClient = await getRedisStreamsClient();

      // P0-6 FIX: Validate Redis clients initialized successfully
      if (!this.redis) {
        throw new Error('Failed to initialize Redis client - returned null');
      }
      if (!this.streamsClient) {
        throw new Error('Failed to initialize Redis Streams client - returned null');
      }

      // Initialize price oracle
      this.priceOracle = await getPriceOracle();

      // P0-6 FIX: Validate price oracle initialized successfully
      if (!this.priceOracle) {
        throw new Error('Failed to initialize Price Oracle - returned null');
      }

      // ADR-014: Initialize modular components
      this.initializeModules();

      // Create consumer groups and start stream consumption
      await this.streamConsumer!.createConsumerGroups();
      this.streamConsumer!.start();

      // Phase 3: Initialize ML predictor (TensorFlow.js LSTM)
      await this.initializeMLPredictor();

      // Phase 3: Initialize whale activity tracker
      this.initializeWhaleTracker();

      // Start opportunity detection loop
      this.startOpportunityDetection();

      // Start health monitoring
      this.startHealthMonitoring();

      // Phase 3: Start ETH price refresh for accurate bridge cost estimation
      this.startEthPriceRefresh();

      this.logger.info('Cross-Chain Detector Service started successfully', {
        crossChainEnabled: ARBITRAGE_CONFIG.crossChainEnabled,
        mlPredictorActive: this.mlPredictorInitialized,
        whaleTrackerActive: !!this.whaleTracker,
        // DEAD-CODE-REMOVED: momentumTrackerActive removed - feature was never used
      });
    });

    if (!result.success) {
      this.logger.error('Failed to start Cross-Chain Detector Service', {
        error: result.error
      });
      throw result.error;
    }
  }

  // P0-NEW-6 FIX: Timeout constant for shutdown operations
  private static readonly SHUTDOWN_TIMEOUT_MS = 5000;

  async stop(): Promise<void> {
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping Cross-Chain Detector Service');

      // Stop modular components and clear intervals
      this.clearAllIntervals();

      // P0-NEW-6 FIX: Disconnect streams client with timeout
      await disconnectWithTimeout(this.streamsClient, 'Streams client', CrossChainDetectorService.SHUTDOWN_TIMEOUT_MS, this.logger);
      this.streamsClient = null;

      // P0-NEW-6 FIX: Disconnect Redis with timeout
      await disconnectWithTimeout(this.redis, 'Redis', CrossChainDetectorService.SHUTDOWN_TIMEOUT_MS, this.logger);
      this.redis = null;

      // ADR-014: Clear modular components
      if (this.priceDataManager) {
        this.priceDataManager.clear();
        this.priceDataManager = null;
      }
      if (this.opportunityPublisher) {
        this.opportunityPublisher.clear();
        this.opportunityPublisher = null;
      }
      // ADR-014: Clear MLPredictionManager (replaces priceHistoryCache and mlPredictionCache)
      if (this.mlPredictionManager) {
        this.mlPredictionManager.clear();
        this.mlPredictionManager = null;
      }
      if (this.streamConsumer) {
        this.streamConsumer.removeAllListeners();
      }
      this.streamConsumer = null;
      this.bridgeCostEstimator = null;

      // P1-5 FIX: Reset concurrency guards for clean restart
      this.healthGuard.forceRelease();
      this.detectionGuard.forceRelease();
      // FIX #4: Release whaleGuard to prevent stale guard blocking whale detection on hot restart
      this.whaleGuard.forceRelease();

      this.logger.info('Cross-Chain Detector Service stopped');
    });

    if (!result.success) {
      this.logger.error('Error stopping Cross-Chain Detector Service', {
        error: result.error
      });
    }
  }

  private clearAllIntervals(): void {
    // ADR-014: Stop stream consumer module
    if (this.streamConsumer) {
      this.streamConsumer.stop();
    }
    // NOTE: Detection and health use setInterval + OperationGuard (performance-critical,
    // guard prevents overlap). ETH price refresh uses setTimeout chain (FIX #28).
    this.opportunityDetectionInterval = clearIntervalSafe(this.opportunityDetectionInterval);
    this.healthMonitoringInterval = clearIntervalSafe(this.healthMonitoringInterval);
    // FIX #28: ETH price refresh uses setTimeout chain
    this.ethPriceRefreshInterval = clearTimeoutSafe(this.ethPriceRefreshInterval);
    // FIX #5: Clear rate limit state on shutdown
    this.bridgeDataRateLimit.clear();
    // FIX #9: Clear ETH price history on shutdown
    this.recentEthPrices.length = 0;
  }

  // ===========================================================================
  // ADR-014: Modular Component Initialization
  // ===========================================================================

  /**
   * Initialize modular components and wire up event handlers.
   * This method must be called after Redis clients are initialized.
   */
  private initializeModules(): void {
    if (!this.streamsClient) {
      throw new Error('Cannot initialize modules: streamsClient is null');
    }

    // Create PriceDataManager
    this.priceDataManager = createPriceDataManager({
      logger: this.logger,
      cleanupFrequency: 100,
      maxPriceAgeMs: 5 * 60 * 1000, // 5 minutes
    });

    // Create OpportunityPublisher
    this.opportunityPublisher = createOpportunityPublisher({
      streamsClient: this.streamsClient,
      perfLogger: this.perfLogger,
      logger: this.logger,
      dedupeWindowMs: 5000,
      minProfitImprovement: 0.1,
      maxCacheSize: 1000,
      cacheTtlMs: 10 * 60 * 1000, // 10 minutes
    });

    // Create BridgeCostEstimator (ADR-014: modular bridge cost estimation)
    // Note: cachedEthPriceUsd uses default value; for production, consider
    // periodic updates from priceOracle to improve accuracy
    this.bridgeCostEstimator = createBridgeCostEstimator({
      bridgePredictor: this.bridgePredictor,
      logger: this.logger,
      defaultTradeSizeUsd: this.config.defaultTradeSizeUsd,
    });

    // ADR-014: Create MLPredictionManager for centralized ML prediction handling
    // Replaces inline priceHistoryCache, mlPredictionCache, and related methods
    this.mlPredictionManager = createMLPredictionManager({
      logger: this.logger,
      mlConfig: this.mlConfig,
      priceHistoryMaxLength: 100,
      maxPriceHistoryKeys: 10000,
      priceHistoryTtlMs: 10 * 60 * 1000, // 10 minutes
    });

    // Create StreamConsumer and wire up events
    this.streamConsumer = createStreamConsumer({
      instanceId: this.instanceId,
      streamsClient: this.streamsClient,
      stateManager: this.stateManager,
      logger: this.logger,
      consumerGroups: this.consumerGroups,
      pollIntervalMs: 100,
      priceUpdatesBatchSize: 50,
      whaleAlertsBatchSize: 10,
    });

    // Wire StreamConsumer events to handlers
    this.streamConsumer.on('priceUpdate', (update: PriceUpdate) => {
      this.handlePriceUpdate(update);
    });

    this.streamConsumer.on('whaleTransaction', (tx: WhaleTransaction) => {
      this.handleWhaleTransaction(tx);
    });

    // Task 1.3.3: Handle pending opportunities from mempool detection
    this.streamConsumer.on('pendingOpportunity', (opp: PendingOpportunity) => {
      this.handlePendingOpportunity(opp);
    });

    this.streamConsumer.on('error', (error: Error) => {
      this.logger.error('StreamConsumer error', { error: error.message });
    });

    this.logger.info('Modular components initialized', {
      modules: ['StreamConsumer', 'PriceDataManager', 'OpportunityPublisher'],
    });
  }

  // ===========================================================================
  // Price Update Handling (delegates to PriceDataManager)
  // ===========================================================================

  private handlePriceUpdate(update: PriceUpdate): void {
    if (!this.priceDataManager) return;

    try {
      // ADR-014: Delegate to PriceDataManager
      this.priceDataManager.handlePriceUpdate(update);

      // ADR-014: ML Integration via MLPredictionManager (replaces inline trackPriceHistory)
      if (this.mlPredictionManager) {
        this.mlPredictionManager.trackPriceUpdate(update);
      }

      // FIX: Update ETH price in BridgeCostEstimator for accurate gas cost estimation
      // Check if this is an ETH or WETH price update paired with a stablecoin
      this.maybeUpdateEthPrice(update);

      // Periodic bridge predictor cleanup (still managed here as cross-cutting concern)
      // PriceDataManager handles its own cleanup internally
      // FIX 4.1: Cache pair count before modulo check to ensure consistent behavior
      const currentPairCount = this.priceDataManager.getPairCount();
      if (currentPairCount > 0 && currentPairCount % 100 === 0) {
        this.bridgePredictor.cleanup();
        if (this.opportunityPublisher) {
          this.opportunityPublisher.cleanup();
        }
        // ADR-014: MLPredictionManager handles its own cleanup internally via trackPriceUpdate
        // (cleanup triggered every 1000 updates)
        if (this.mlPredictionManager) {
          this.mlPredictionManager.cleanup();
        }
      }
    } catch (error) {
      this.logger.error('Failed to handle price update', { error });
    }
  }

  /**
   * FIX #9: Validate ETH price against recent history to reject poisoned prices.
   * Uses median of recent prices and rejects deviations >20%.
   * Returns true if price is valid, false if rejected.
   */
  private validateEthPriceRate(price: number): boolean {
    // Need at least 3 data points for meaningful median comparison
    if (this.recentEthPrices.length >= 3) {
      const sorted = this.recentEthPrices.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

      const deviation = Math.abs(price - median) / median;
      if (deviation > CrossChainDetectorService.ETH_PRICE_MAX_DEVIATION) {
        this.logger.warn('ETH price rejected: exceeds rate-of-change threshold', {
          price,
          median,
          deviation: (deviation * 100).toFixed(1) + '%',
          threshold: (CrossChainDetectorService.ETH_PRICE_MAX_DEVIATION * 100) + '%',
          recentCount: this.recentEthPrices.length,
        });
        return false;
      }
    }

    // Track accepted price
    this.recentEthPrices.push(price);
    if (this.recentEthPrices.length > CrossChainDetectorService.ETH_PRICE_HISTORY_SIZE) {
      this.recentEthPrices.splice(0, this.recentEthPrices.length - CrossChainDetectorService.ETH_PRICE_HISTORY_SIZE);
    }
    return true;
  }

  /**
   * FIX: Update ETH price in BridgeCostEstimator when we receive ETH/WETH price updates.
   * This ensures bridge cost estimation uses accurate gas prices.
   */
  private maybeUpdateEthPrice(update: PriceUpdate): void {
    if (!this.bridgeCostEstimator) return;

    // Check if this is an ETH or WETH price against a stablecoin
    const pairKey = update.pairKey.toUpperCase();
    const isEthPair = (
      (pairKey.includes('WETH') || pairKey.includes('_ETH_') || pairKey.startsWith('ETH_')) &&
      (pairKey.includes('USDC') || pairKey.includes('USDT') || pairKey.includes('DAI') || pairKey.includes('BUSD'))
    );

    if (isEthPair && update.price > 0) {
      // ETH price should be in the thousands range (sanity check)
      if (update.price > 100 && update.price < 100000) {
        // FIX #9: Apply rate-of-change circuit breaker
        if (this.validateEthPriceRate(update.price)) {
          this.bridgeCostEstimator.updateEthPrice(update.price);
        }
      }
    }
  }

  // ===========================================================================
  // Phase 3: Real-Time ETH Price Feed
  // ===========================================================================

  /** ETH price refresh interval in milliseconds (5 seconds per research report) */
  private static readonly ETH_PRICE_REFRESH_INTERVAL_MS = 5000;

  /**
   * Phase 3 Enhancement: Start periodic ETH price refresh from PriceOracle.
   *
   * This ensures bridge cost estimation uses fresh ETH prices even when
   * no WETH trading activity is occurring. Per research report:
   * - Current: ETH price cached at startup, only updated on WETH pair events
   * - Enhanced: Periodic refresh every 5 seconds from PriceOracle
   *
   * Impact: +5-10% cost estimation accuracy
   */
  private startEthPriceRefresh(): void {
    // P3-002 FIX: Defensive guard - clear existing timeout if called twice
    this.ethPriceRefreshInterval = clearTimeoutSafe(this.ethPriceRefreshInterval);

    // FIX #28: Use setTimeout chain instead of setInterval to prevent overlapping
    // async calls. Unlike detection/health which have OperationGuard, ETH price
    // refresh has no concurrency guard, so setTimeout chain is the safest pattern.
    const scheduleRefresh = async (): Promise<void> => {
      if (!this.stateManager.isRunning()) return;

      try {
        await this.refreshEthPrice();
      } catch (error) {
        this.logger.warn('ETH price refresh failed', {
          error: (error as Error).message
        });
      }

      // Reschedule only if still running (delay starts AFTER completion)
      if (this.stateManager.isRunning()) {
        this.ethPriceRefreshInterval = setTimeout(
          () => { scheduleRefresh().catch(() => {}); },
          CrossChainDetectorService.ETH_PRICE_REFRESH_INTERVAL_MS
        );
      }
    };

    // Refresh immediately on start, then schedule chain
    scheduleRefresh().catch(error => {
      this.logger.warn('Initial ETH price refresh failed', {
        error: (error as Error).message
      });
    });

    this.logger.info('ETH price refresh started', {
      intervalMs: CrossChainDetectorService.ETH_PRICE_REFRESH_INTERVAL_MS
    });
  }

  /**
   * Refresh ETH price from PriceOracle and update BridgeCostEstimator.
   */
  private async refreshEthPrice(): Promise<void> {
    if (!this.priceOracle || !this.bridgeCostEstimator) return;

    try {
      // Fetch ETH price from PriceOracle (handles caching, fallback internally)
      const ethPrice = await this.priceOracle.getPrice('ETH');

      // Only update if we got a valid, non-stale price
      if (ethPrice.price > 0 && !ethPrice.isStale) {
        // Sanity check: ETH should be in reasonable range
        if (ethPrice.price > 100 && ethPrice.price < 100000) {
          // FIX #9: Apply rate-of-change circuit breaker
          if (this.validateEthPriceRate(ethPrice.price)) {
            this.bridgeCostEstimator.updateEthPrice(ethPrice.price);
            this.logger.debug('ETH price refreshed from PriceOracle', {
              price: ethPrice.price,
              source: ethPrice.source
            });
          }
        }
      } else if (ethPrice.isStale) {
        this.logger.debug('ETH price is stale, skipping update', {
          price: ethPrice.price,
          source: ethPrice.source,
          timestamp: ethPrice.timestamp
        });
      }
    } catch (error) {
      // Log but don't throw - price feed is best-effort
      this.logger.debug('Failed to refresh ETH price', {
        error: (error as Error).message
      });
    }
  }

  // ADR-014: REMOVED - trackPriceHistory, cleanupMlPredictionCache, getCachedMlPrediction, calculateSimpleVolatility
  // These methods are now handled by MLPredictionManager module for single-responsibility design
  // See: mlPredictionManager.trackPriceUpdate(), mlPredictionManager.cleanup(),
  //      mlPredictionManager.getCachedPrediction(), mlPredictionManager.calculateVolatility()

  private handleWhaleTransaction(whaleTx: WhaleTransaction): void {
    // Phase 3: Async whale analysis - handle errors gracefully
    this.analyzeWhaleImpact(whaleTx).catch(error => {
      this.logger.error('Failed to handle whale transaction', {
        error: (error as Error).message,
        txHash: whaleTx.transactionHash
      });
    });
  }

  // ===========================================================================
  // Task 1.3.3: Pending Opportunity Handling (Mempool Integration)
  // ===========================================================================

  // FIX 9.1: Removed duplicate CHAIN_ID_TO_NAME - use getChainName() from @arbitrage/config

  /**
   * Handle a pending opportunity from the mempool detector.
   *
   * This converts a pending swap intent into a potential arbitrage opportunity
   * by checking if the pending transaction creates a price discrepancy that
   * can be exploited.
   *
   * Task 1.3.3: Integration with Existing Detection
   */
  private async handlePendingOpportunity(opp: PendingOpportunity): Promise<void> {
    try {
      const intent = opp.intent;

      // Get chain name from chain ID (FIX 9.1: Use centralized getChainName)
      const chainName = getChainName(intent.chainId);
      if (chainName === 'unknown') {
        this.logger.debug('Unknown chain ID in pending opportunity', {
          chainId: intent.chainId,
          txHash: intent.hash,
        });
        return;
      }

      // Check if deadline has passed
      // BUG-FIX: Normalize deadline to milliseconds - handle both seconds and milliseconds formats
      // If deadline < 1e10, it's likely in seconds (Unix timestamp); convert to ms
      // If deadline >= 1e10, it's likely already in milliseconds
      const currentTimestampMs = Date.now();
      const deadlineMs = intent.deadline < 1e10 ? intent.deadline * 1000 : intent.deadline;
      if (deadlineMs < currentTimestampMs) {
        this.logger.debug('Pending opportunity expired', {
          txHash: intent.hash,
          deadline: intent.deadline,
          deadlineMs,
          nowMs: currentTimestampMs,
        });
        return;
      }

      // NOTE: Per-event debug logging removed - high-frequency mempool events
      // Track pending opportunities for metrics (increment internal counter)
      this.pendingOpportunitiesReceived++;

      // FIX 7.1: Implement pending opportunity analysis
      // Task 1.3.4: Full implementation of mempool-based opportunity detection
      await this.analyzePendingOpportunity(intent, chainName, opp.estimatedImpact);

    } catch (error) {
      this.logger.error('Error handling pending opportunity', {
        error: (error as Error).message,
        txHash: opp.intent?.hash,
      });
    }
  }

  /**
   * FIX 7.1: Analyze pending swap for arbitrage opportunities.
   *
   * This method implements the full pending opportunity analysis:
   * 1. Calculate expected price impact from the pending swap
   * 2. Check current prices on other DEXes (same chain for now)
   * 3. Determine if backrunning is profitable after the pending swap executes
   * 4. Publish enhanced opportunity with pending tx metadata
   *
   * Task 1.3.4: Full implementation of mempool-based opportunity detection
   *
   * @param intent - The pending swap intent from mempool
   * @param chainName - The chain name (e.g., 'ethereum')
   * @param estimatedImpact - Optional estimated price impact from mempool detector
   */
  private async analyzePendingOpportunity(
    intent: PendingSwapIntent,
    chainName: string,
    estimatedImpact?: number
  ): Promise<void> {
    if (!this.priceDataManager || !this.opportunityPublisher) {
      return;
    }

    try {
      // Get current price snapshot
      const snapshot = this.priceDataManager.createIndexedSnapshot();

      // Normalize token addresses to find matching pairs
      const normalizedTokenIn = normalizeTokenForCrossChain(intent.tokenIn);
      const normalizedTokenOut = normalizeTokenForCrossChain(intent.tokenOut);
      const normalizedPair = `${normalizedTokenIn}_${normalizedTokenOut}`;
      const reversePair = `${normalizedTokenOut}_${normalizedTokenIn}`;

      // Look for prices on this token pair
      const pricesForPair = snapshot.byToken.get(normalizedPair)
        ?? snapshot.byToken.get(reversePair)
        ?? [];

      if (pricesForPair.length < 2) {
        // Need at least 2 price sources to find arbitrage
        this.logger.debug('Insufficient price sources for pending opportunity', {
          txHash: intent.hash,
          pair: normalizedPair,
          priceCount: pricesForPair.length,
        });
        return;
      }

      // Calculate expected price impact from pending swap
      // For AMM DEXs, price impact ≈ amountIn / reserve (simplified constant product)
      // Use estimatedImpact from mempool detector if available, otherwise estimate
      // Use the update object which contains reserve0/reserve1
      // FIX #8: Validate estimatedImpact bounds before using it
      // If the value from Redis is not finite or exceeds 50% impact, fall back to local estimation
      const rawImpact = estimatedImpact;
      const priceImpact = (rawImpact !== undefined && Number.isFinite(rawImpact) && rawImpact >= 0 && rawImpact <= 0.5)
        ? rawImpact
        : this.estimatePriceImpact(intent, pricesForPair[0].update);

      if (priceImpact < 0.001) {
        // Less than 0.1% impact - not significant enough
        return;
      }

      // Find the price point that would be affected by this pending swap
      // (the DEX where the pending swap is executing)
      // FIX #3: Use intent.type (DEX name like 'uniswapV2') instead of intent.router (hex address)
      // for matching against p.dex (e.g., 'uniswap'). Hex addresses never contain DEX names.
      // Fall back to chain-only match if intent.type doesn't match any tracked DEX.
      // PERF: Pre-lowercase intent.type once and use single-pass with fallback tracking
      const intentTypeLower = intent.type.toLowerCase();
      let affectedPrice: (typeof pricesForPair)[number] | undefined;
      let chainFallback: (typeof pricesForPair)[number] | undefined;
      for (const p of pricesForPair) {
        if (p.chain !== chainName) continue;
        if (intentTypeLower.includes(p.dex.toLowerCase())) {
          affectedPrice = p;
          break;
        }
        if (!chainFallback) chainFallback = p;
      }
      if (!affectedPrice) affectedPrice = chainFallback;

      if (!affectedPrice) {
        // Pending swap is on a DEX we're not tracking
        return;
      }

      // Calculate post-swap price (after pending tx executes)
      // If buying tokenOut, price of tokenOut increases
      const postSwapPrice = affectedPrice.price * (1 + priceImpact);

      // P2-2 FIX: Guard against zero/negative post-swap price to prevent division by zero
      if (postSwapPrice <= 0) {
        return;
      }

      // Find best alternative price on other DEXes/chains
      let bestAltPrice = 0;
      let bestAltSource: typeof pricesForPair[0] | null = null;

      for (const pricePoint of pricesForPair) {
        if (pricePoint === affectedPrice) continue;

        if (pricePoint.price > bestAltPrice) {
          bestAltPrice = pricePoint.price;
          bestAltSource = pricePoint;
        }
      }

      if (!bestAltSource || bestAltPrice === 0) {
        return;
      }

      // Calculate potential profit from backrunning
      // Buy on affected DEX (at post-swap price), sell on alternative DEX
      const priceDiff = bestAltPrice - postSwapPrice;
      const priceDiffPercent = priceDiff / postSwapPrice;

      // Apply confidence boost for pending opportunities
      // Higher confidence for larger pending swaps and shorter deadline
      // P1-3 FIX: Normalize deadline to ms (same as handlePendingOpportunity) before computing time delta
      const normalizedDeadlineMs = intent.deadline < 1e10 ? intent.deadline * 1000 : intent.deadline;
      const timeToDeadlineSec = (normalizedDeadlineMs - Date.now()) / 1000;
      const deadlineBoost = Math.max(0, Math.min(timeToDeadlineSec / 300, 1.0)); // Clamp [0, 1.0], max boost at 5min deadline
      const baseConfidence = 0.6 + (priceImpact * 10); // Higher impact = higher confidence
      const confidence = Math.min(baseConfidence * deadlineBoost, 0.95);

      // Minimum profitability threshold: 0.5% after estimated gas costs
      const MIN_PROFIT_THRESHOLD = 0.005;
      if (priceDiffPercent < MIN_PROFIT_THRESHOLD) {
        return;
      }

      // Estimate net profit (simplified - assumes same trade size as pending)
      // P1-FIX 2.3: Use configurable gas estimate instead of hardcoded value
      const estimatedGasCost = BigInt(intent.gasPrice) * BigInt(this.config.estimatedSwapGas ?? 200000);
      const amountInBigInt = BigInt(intent.amountIn);
      const grossProfit = (amountInBigInt * BigInt(Math.floor(priceDiffPercent * 10000))) / BigInt(10000);

      // FIX #7: BigInt precision handling for grossProfit > 2^53
      // Number() loses precision for BigInt values beyond MAX_SAFE_INTEGER.
      // Use BigInt comparison when values are large, Number conversion otherwise.
      let netProfit: number;
      if (grossProfit > MAX_SAFE_BIGINT || estimatedGasCost > MAX_SAFE_BIGINT) {
        // Stay in BigInt domain for the comparison
        const netProfitBigInt = grossProfit - estimatedGasCost;
        if (netProfitBigInt <= 0n) {
          return;
        }
        // Safe to convert result since we only need an approximate numeric value for the opportunity
        netProfit = Number(netProfitBigInt);
      } else {
        netProfit = Number(grossProfit) - Number(estimatedGasCost);
      }

      if (netProfit <= 0) {
        return;
      }

      // Create and publish opportunity
      const now = Date.now();
      const opportunity: CrossChainOpportunity = {
        token: toDisplayTokenPair(normalizedPair),
        sourceChain: chainName,
        sourceDex: affectedPrice.dex,
        sourcePrice: postSwapPrice,
        targetChain: bestAltSource.chain,
        targetDex: bestAltSource.dex,
        targetPrice: bestAltPrice,
        priceDiff: priceDiff,
        // P0 FIX: Convert decimal ratio to percentage to match cross-chain path convention
        // (publisher divides by 100, so store as percentage e.g. 2.0 for 2%)
        percentageDiff: priceDiffPercent * 100,
        tradeSizeUsd: this.config.defaultTradeSizeUsd ?? 1000,
        // FIX #1: Use priceDiff (gross profit) to match cross-chain path and JSDoc semantics
        estimatedProfit: priceDiff,
        bridgeCost: 0, // Same-chain opportunity
        netProfit: netProfit,
        createdAt: now,
        timestamp: now,
        confidence,
        // Pending opportunity metadata
        pendingTxHash: intent.hash,
        pendingDeadline: intent.deadline,
        pendingSlippage: intent.slippageTolerance,
      };

      // Publish with higher priority due to time sensitivity
      await this.publishArbitrageOpportunity(opportunity);

      this.logger.info('Pending opportunity detected and published', {
        txHash: intent.hash,
        chain: chainName,
        pair: normalizedPair,
        priceDiff: `${(priceDiffPercent * 100).toFixed(2)}%`,
        netProfit: opportunity.netProfit,
        confidence: opportunity.confidence,
      });

    } catch (error) {
      this.logger.error('Failed to analyze pending opportunity', {
        error: (error as Error).message,
        txHash: intent.hash,
      });
    }
  }

  /**
   * FIX 7.1: Estimate price impact for a pending swap.
   * Uses simplified constant product formula for AMM DEXs.
   */
  private estimatePriceImpact(
    intent: PendingSwapIntent,
    priceUpdate: PriceUpdate
  ): number {
    try {
      // If we have reserve data, calculate impact
      if (priceUpdate.reserve0 && priceUpdate.reserve1) {
        const reserve = BigInt(priceUpdate.reserve0);
        const amountIn = BigInt(intent.amountIn);

        // Price impact ≈ amountIn / (reserve + amountIn) for constant product
        const impact = Number(amountIn * BigInt(10000) / (reserve + amountIn)) / 10000;
        return impact;
      }

      // Fallback: estimate based on slippage tolerance
      // If user set high slippage, they expect high impact
      return intent.slippageTolerance * 2; // Conservative estimate
    } catch {
      return intent.slippageTolerance; // Safe fallback
    }
  }

  // ===========================================================================
  // ADR-014: Validation and cleanup now handled by modular components
  // - StreamConsumer handles message validation
  // - PriceDataManager handles price data cleanup and snapshots
  // - OpportunityPublisher handles opportunity cache cleanup
  // ===========================================================================

  // ===========================================================================
  // Phase 3: ML Predictor and Whale/Momentum Trackers
  // ===========================================================================

  private async initializeMLPredictor(): Promise<void> {
    // P0-3 FIX: Unified ML initialization path via MLPredictionManager
    // MLPredictionManager owns the LSTMPredictor instance; detector just tracks state
    if (this.mlPredictionManager) {
      const success = await this.mlPredictionManager.initialize();
      this.mlPredictorInitialized = success;

      if (success) {
        this.logger.info('ML predictor initialized via MLPredictionManager (TensorFlow.js LSTM)');
      } else {
        // Graceful degradation - service continues without ML
        this.logger.warn('ML predictor initialization failed, continuing without ML predictions');
      }
    } else {
      // Safety fallback - should not happen since mlPredictionManager is created in initializeComponents
      this.logger.warn('MLPredictionManager not available, ML predictions disabled');
      this.mlPredictorInitialized = false;
    }
  }

  private initializeWhaleTracker(): void {
    try {
      // Initialize whale activity tracker singleton
      this.whaleTracker = getWhaleActivityTracker();
      this.logger.info('Whale activity tracker initialized');
      // DEAD-CODE-REMOVED: momentumTracker was never used in detection logic
    } catch (error) {
      this.logger.warn('Failed to initialize whale tracker', {
        error: (error as Error).message
      });
    }
  }

  // ===========================================================================
  // Opportunity Detection
  // ===========================================================================

  private startOpportunityDetection(): void {
    // CONFIG-C1: Use configurable detection interval
    const intervalMs = this.config.detectionIntervalMs!;
    this.opportunityDetectionInterval = setInterval(async () => {
      if (!this.stateManager.isRunning()) return;

      // P1-5 FIX: Use OperationGuard for concurrency control
      // Skip if previous detection cycle is still running (prevents duplicate opportunities)
      const releaseGuard = this.detectionGuard.tryAcquire();
      if (!releaseGuard) {
        return;
      }

      // FIX #5: Circuit breaker - skip detection if too many consecutive errors
      const now = Date.now();
      if (this.consecutiveDetectionErrors >= CrossChainDetectorService.DETECTION_ERROR_THRESHOLD) {
        // Check if we should reset the circuit breaker
        if (now - this.lastCircuitBreakerTrip < CrossChainDetectorService.CIRCUIT_BREAKER_RESET_MS) {
          releaseGuard(); // Release immediately if we're in cooldown
          return;
        }
        // Reset circuit breaker after cooldown
        this.logger.info('Circuit breaker reset after cooldown', {
          previousErrors: this.consecutiveDetectionErrors,
          cooldownMs: CrossChainDetectorService.CIRCUIT_BREAKER_RESET_MS,
        });
        this.consecutiveDetectionErrors = 0;
      }

      try {
        await this.detectCrossChainOpportunities();
        // Reset error count on success
        this.consecutiveDetectionErrors = 0;
      } catch (error) {
        this.consecutiveDetectionErrors++;
        this.logger.error('Opportunity detection error', {
          error: (error as Error).message,
          consecutiveErrors: this.consecutiveDetectionErrors,
          threshold: CrossChainDetectorService.DETECTION_ERROR_THRESHOLD,
        });

        // FIX #5: Trip circuit breaker if threshold exceeded
        if (this.consecutiveDetectionErrors >= CrossChainDetectorService.DETECTION_ERROR_THRESHOLD) {
          this.lastCircuitBreakerTrip = now;
          this.logger.error('Circuit breaker triggered - pausing detection', {
            consecutiveErrors: this.consecutiveDetectionErrors,
            cooldownMs: CrossChainDetectorService.CIRCUIT_BREAKER_RESET_MS,
          });
        }
      } finally {
        // P1-5 FIX: Always release guard, even on error
        releaseGuard();
      }
    }, intervalMs);
  }

  private async detectCrossChainOpportunities(): Promise<void> {
    if (!this.priceDataManager) return;

    // FIX: Check if cross-chain arbitrage is enabled before detection
    if (!ARBITRAGE_CONFIG.crossChainEnabled) {
      return; // Skip detection if disabled
    }

    const startTime = performance.now();

    // FIX #23: Generate cycle ID for structured logging traceability
    this.detectionCycleCounter++;
    const cycleId = `det-${this.detectionCycleCounter}`;

    try {
      // PERF-P1: Use IndexedSnapshot for O(1) token pair lookups instead of O(n²) iteration
      const indexedSnapshot = this.priceDataManager.createIndexedSnapshot();

      // ADR-014: ML Integration via MLPredictionManager
      // FIX #22: Reuse map instance to reduce GC pressure (clear instead of new)
      this.mlPredictionsCache.clear();

      if (this.mlPredictionManager && this.mlPredictionManager.isReady()) {
        // P2-FIX: Pre-filter by minimum spread (>0.5%) before ML predictions
        // @see docs/reports/ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 3.4
        // Impact: -30-50% ML latency per cycle by eliminating low-value pairs
        const MIN_SPREAD_THRESHOLD = 0.005; // 0.5%

        // Build list of pairs to fetch predictions for, pre-filtered by spread
        const pairsToFetch: Array<{ chain: string; pairKey: string; price: number }> = [];

        for (const tokenPair of indexedSnapshot.tokenPairs) {
          const chainPrices = indexedSnapshot.byToken.get(tokenPair);
          if (!chainPrices || chainPrices.length < 2) continue;

          // P2-FIX: Calculate price spread across chains for this token pair
          let minPrice = Infinity;
          let maxPrice = -Infinity;
          for (const point of chainPrices) {
            if (point.price > 0) {
              if (point.price < minPrice) minPrice = point.price;
              if (point.price > maxPrice) maxPrice = point.price;
            }
          }

          // P2-FIX: Only fetch ML predictions for pairs with meaningful spread
          // Pairs below 0.5% spread are unlikely to be profitable after costs
          const spread = minPrice > 0 ? (maxPrice - minPrice) / minPrice : 0;
          if (spread < MIN_SPREAD_THRESHOLD) continue;

          // This token pair has potential - include all its price points
          for (const pricePoint of chainPrices) {
            pairsToFetch.push({
              chain: pricePoint.chain,
              pairKey: pricePoint.pairKey,
              price: pricePoint.price,
            });
          }
        }

        // ADR-014: Use MLPredictionManager.prefetchPredictions for parallel fetching
        // This method handles deduplication, caching, and batch-write internally
        if (pairsToFetch.length > 0) {
          // FIX #22: Copy results into reusable cache to reduce GC pressure
          const fetchedPredictions = await this.mlPredictionManager.prefetchPredictions(pairsToFetch);
          for (const [key, value] of fetchedPredictions) {
            this.mlPredictionsCache.set(key, value);
          }
        }
      }

      const opportunities: CrossChainOpportunity[] = [];

      // PERF-P1: Token pairs are pre-computed in snapshot, no need to iterate
      for (const tokenPair of indexedSnapshot.tokenPairs) {
        // PERF-P1: O(1) lookup instead of O(chains × dexes × pairs) iteration
        const chainPrices = indexedSnapshot.byToken.get(tokenPair);

        if (chainPrices && chainPrices.length >= 2) {
          // Pass ML predictions to arbitrage detection
          const pairOpportunities = this.findArbitrageInPrices(
            chainPrices,
            undefined, // whaleData
            undefined, // whaleTx
            this.mlPredictionsCache.size > 0 ? this.mlPredictionsCache : undefined
          );
          // FIX #14: Replace spread push with loop push to avoid call stack limit for large results
          for (const opp of pairOpportunities) {
            opportunities.push(opp);
          }
        }
      }

      // Filter and rank opportunities
      const validOpportunities = this.filterValidOpportunities(opportunities);

      // FIX: Await async publish calls to properly handle errors and backpressure
      // ADR-014: Publish opportunities via OpportunityPublisher
      for (const opportunity of validOpportunities) {
        await this.publishArbitrageOpportunity(opportunity);
      }

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('cross_chain_detection', latency, {
        opportunitiesFound: validOpportunities.length,
        totalPairs: indexedSnapshot.tokenPairs.length,
        mlPredictionsUsed: this.mlPredictionsCache.size,
        cycleId, // FIX #23: Include cycle ID for traceability
      });
    } catch (error) {
      this.logger.error('Failed to detect cross-chain opportunities', { error });
    }
  }

  // ===========================================================================
  // DUPLICATION-I1: Shared Arbitrage Detection Logic
  // Extracted from findArbitrageInPair and findArbitrageInPairWithWhaleData
  // ===========================================================================

  /**
   * Core arbitrage detection algorithm - finds min/max prices and calculates opportunity.
   * This is the shared logic extracted from findArbitrageInPair and findArbitrageInPairWithWhaleData.
   *
   * @param chainPrices - Array of price points from different chains/dexes
   * @param whaleData - Optional whale activity summary for confidence boost
   * @param whaleTx - Optional whale transaction for opportunity tagging
   * @param mlPredictions - Optional ML predictions for source and target chains
   * @returns Array of detected opportunities (0 or 1 elements)
   */
  private findArbitrageInPrices(
    chainPrices: PricePoint[],
    whaleData?: WhaleActivitySummary,
    whaleTx?: WhaleTransaction,
    mlPredictions?: Map<string, PredictionResult | null>
  ): CrossChainOpportunity[] {
    const opportunities: CrossChainOpportunity[] = [];

    // PERF-OPT: Use O(n) min/max instead of O(n log n) sorting
    if (chainPrices.length < 2) {
      return opportunities;
    }

    let lowestPrice = chainPrices[0];
    let highestPrice = chainPrices[0];

    for (let i = 1; i < chainPrices.length; i++) {
      if (chainPrices[i].price < lowestPrice.price) {
        lowestPrice = chainPrices[i];
      }
      if (chainPrices[i].price > highestPrice.price) {
        highestPrice = chainPrices[i];
      }
    }

    // BUG-B2-FIX: Guard against invalid prices before calculation
    if (lowestPrice.price <= 0 || !Number.isFinite(lowestPrice.price)) {
      return opportunities;
    }

    // FIX #11: Hard staleness rejection - reject prices beyond max age
    // This prevents trading on outdated prices even when confidence boosters
    // (whale + ML) could push stale opportunities above the threshold.
    // Hot-path: single Date.now() call, two comparisons, no allocations.
    const now = Date.now();
    const maxPriceAgeMs = this.config.maxPriceAgeMs ?? 30000;
    if (now - lowestPrice.update.timestamp > maxPriceAgeMs ||
        now - highestPrice.update.timestamp > maxPriceAgeMs) {
      this.logger.debug('Rejecting stale price pair', {
        lowestAge: now - lowestPrice.update.timestamp,
        highestAge: now - highestPrice.update.timestamp,
        maxAgeMs: maxPriceAgeMs,
      });
      return opportunities;
    }

    const priceDiff = highestPrice.price - lowestPrice.price;
    const percentageDiff = (priceDiff / lowestPrice.price) * 100;

    // Check if profitable after estimated bridge costs
    const bridgeCost = this.estimateBridgeCost(lowestPrice.chain, highestPrice.chain, lowestPrice.update);

    // BUG-FIX: Validate bridge cost to prevent invalid profit calculations
    // Bridge cost could be NaN, Infinity, or negative from failed estimation
    if (!Number.isFinite(bridgeCost) || bridgeCost < 0) {
      this.logger.warn('Invalid bridge cost estimate, skipping opportunity', {
        bridgeCost,
        sourceChain: lowestPrice.chain,
        targetChain: highestPrice.chain,
      });
      return opportunities;
    }

    // P0 FIX: Include gas costs and swap fees in net profit calculation
    // Gas costs: source chain swap + dest chain swap, converted to per-token units
    const tradeTokens = this.bridgeCostEstimator!.extractTokenAmount(lowestPrice.update);
    const gasCostPerToken = tradeTokens > 0
      ? (ARBITRAGE_CONFIG.estimatedGasCost * 2) / tradeTokens
      : 0;
    // Swap fees: buy on source + sell on dest (per-token cost from price * fee rate)
    const swapFeePerToken = ARBITRAGE_CONFIG.feePercentage * (lowestPrice.price + highestPrice.price);

    const netProfit = priceDiff - bridgeCost - gasCostPerToken - swapFeePerToken;

    if (netProfit > ARBITRAGE_CONFIG.minProfitPercentage * lowestPrice.price) {
      // Build ML prediction object if predictions available
      let mlPredictionData: { source?: PredictionResult | null; target?: PredictionResult | null } | undefined;
      if (mlPredictions) {
        const sourceKey = `${lowestPrice.chain}:${lowestPrice.pairKey}`;
        const targetKey = `${highestPrice.chain}:${highestPrice.pairKey}`;
        mlPredictionData = {
          source: mlPredictions.get(sourceKey),
          target: mlPredictions.get(targetKey),
        };
      }

      // Calculate confidence with optional whale data and ML predictions
      const confidence = this.calculateConfidence(
        { update: lowestPrice.update, price: lowestPrice.price },
        { price: highestPrice.price },
        whaleData,
        mlPredictionData
      );

      // Compute ML fields for opportunity tracking
      let mlFields: Partial<CrossChainOpportunity> = {};
      if (mlPredictionData) {
        const { source, target } = mlPredictionData;
        const hasValidSource = source && source.confidence >= this.mlConfig.minConfidence;
        const hasValidTarget = target && target.confidence >= this.mlConfig.minConfidence;

        if (hasValidSource || hasValidTarget) {
          // Calculate ML confidence boost (same logic as in calculateConfidence)
          let mlBoost = 1.0;
          let supported = false;

          if (hasValidSource) {
            if (source!.direction === 'up') {
              mlBoost *= this.mlConfig.alignedBoost;
              supported = true;
            } else if (source!.direction === 'down') {
              mlBoost *= this.mlConfig.opposedPenalty;
            }
          }
          if (hasValidTarget) {
            if (target!.direction === 'up' || target!.direction === 'sideways') {
              mlBoost *= supported ? 1.05 : this.mlConfig.alignedBoost;
              supported = true;
            } else if (target!.direction === 'down') {
              mlBoost *= this.mlConfig.opposedPenalty;
              supported = false;
            }
          }

          mlFields = {
            mlConfidenceBoost: mlBoost,
            mlSourceDirection: hasValidSource ? source!.direction : undefined,
            mlTargetDirection: hasValidTarget ? target!.direction : undefined,
            mlSupported: supported,
          };
        }
      }

      const opportunity: CrossChainOpportunity = {
        token: this.extractTokenFromPair(lowestPrice.pairKey),
        sourceChain: lowestPrice.chain,
        sourceDex: lowestPrice.dex,
        sourcePrice: lowestPrice.price,
        targetChain: highestPrice.chain,
        targetDex: highestPrice.dex,
        targetPrice: highestPrice.price,
        priceDiff,
        percentageDiff,
        estimatedProfit: priceDiff,
        bridgeCost,
        netProfit,
        confidence,
        createdAt: Date.now(),
        // Whale enhancement fields (only set if whale data provided)
        ...(whaleTx && whaleData ? {
          whaleTriggered: true,
          whaleTxHash: whaleTx.transactionHash,
          whaleDirection: whaleData.dominantDirection as 'bullish' | 'bearish' | 'neutral',
          whaleVolumeUsd: whaleData.buyVolumeUsd + whaleData.sellVolumeUsd,
        } : {}),
        // ML enhancement fields
        ...mlFields,
      };

      opportunities.push(opportunity);
    }

    return opportunities;
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private extractTokenFromPair(pairKey: string): string {
    // FIX 4.4: Guard against empty or invalid pairKey
    if (!pairKey || typeof pairKey !== 'string' || pairKey.length === 0) {
      this.logger.warn('Invalid pairKey in extractTokenFromPair', { pairKey });
      return 'UNKNOWN/UNKNOWN';
    }

    // S3.2.4-FIX: Extract and normalize tokens from pair key
    // Handles both formats:
    // - "traderjoe_WETH.e_USDT" (3 parts) -> "WETH/USDT"
    // - "uniswap_v3_WETH_USDT" (4 parts) -> "WETH/USDT"
    const parts = pairKey.split('_');
    if (parts.length >= 2) {
      // Always take last 2 parts as tokens regardless of DEX name format
      const token0 = parts[parts.length - 2];
      const token1 = parts[parts.length - 1];

      // FIX 4.4: Validate extracted tokens are non-empty
      if (!token0 || !token1 || token0.length === 0 || token1.length === 0) {
        this.logger.warn('Empty tokens extracted from pairKey', { pairKey, token0, token1 });
        return pairKey; // Return original as fallback
      }

      // FIX 4.2: Wrap normalization in try-catch
      try {
        const normalizedToken0 = normalizeTokenForCrossChain(token0);
        const normalizedToken1 = normalizeTokenForCrossChain(token1);
        return `${normalizedToken0 || token0}/${normalizedToken1 || token1}`;
      } catch (error) {
        this.logger.warn('Token normalization failed in extractTokenFromPair', {
          pairKey,
          error: (error as Error).message
        });
        return `${token0}/${token1}`;
      }
    }
    return pairKey;
  }

  /**
   * ADR-014: Delegate bridge cost estimation to BridgeCostEstimator module.
   *
   * P0-1 FIX: Returns bridge cost in USD/token for correct comparison with priceDiff.
   * Previously called estimateBridgeCost() which returns cost in token units,
   * but priceDiff and the threshold (minProfitPercentage * price) are in USD/token.
   */
  private estimateBridgeCost(sourceChain: string, targetChain: string, tokenUpdate: PriceUpdate): number {
    if (!this.bridgeCostEstimator) {
      throw new Error('BridgeCostEstimator not initialized — cannot estimate bridge cost before initialize()');
    }
    const estimate = this.bridgeCostEstimator.getDetailedEstimate(sourceChain, targetChain, tokenUpdate);
    const tradeTokens = this.bridgeCostEstimator.extractTokenAmount(tokenUpdate);
    if (tradeTokens <= 0) return estimate.costUsd; // Conservative fallback
    return estimate.costUsd / tradeTokens;
  }

  // Method to update bridge predictor with actual bridge transaction data
  public updateBridgeData(bridgeResult: {
    sourceChain: string;
    targetChain: string;
    bridge: string;
    token: string;
    amount: number;
    actualLatency: number;
    actualCost: number;
    success: boolean;
    timestamp: number;
  }): void {
    // FIX #5: Rate limit per route (max 10 updates per 60 seconds)
    const routeKey = `${bridgeResult.sourceChain}-${bridgeResult.targetChain}-${bridgeResult.bridge}`;
    const now = Date.now();
    const windowMs = 60000;
    const maxUpdatesPerWindow = 10;

    let timestamps = this.bridgeDataRateLimit.get(routeKey);
    if (timestamps) {
      // Prune timestamps outside the window
      timestamps = timestamps.filter(t => now - t < windowMs);
      this.bridgeDataRateLimit.set(routeKey, timestamps);

      if (timestamps.length >= maxUpdatesPerWindow) {
        this.logger.warn('Rate limited updateBridgeData', {
          routeKey,
          updatesInWindow: timestamps.length,
        });
        return;
      }
    } else {
      timestamps = [];
      this.bridgeDataRateLimit.set(routeKey, timestamps);
    }
    timestamps.push(now);

    // FIX #7: Validate bridge data bounds before passing to predictor
    // Prevents poisoned/invalid data from corrupting the prediction model
    const { actualLatency, actualCost, amount, timestamp } = bridgeResult;

    // Validate actualLatency: positive, finite, < ~41.7 days (3600000s)
    // Accommodates native L2-to-L1 bridges (up to 7 days / 604800s)
    if (!Number.isFinite(actualLatency) || actualLatency <= 0 || actualLatency > 3600000) {
      this.logger.warn('Rejected bridge data: invalid actualLatency', {
        actualLatency,
        bridge: bridgeResult.bridge,
      });
      return;
    }

    // Validate actualCost: non-negative, finite, < 1000 (reasonable upper bound in token units)
    if (!Number.isFinite(actualCost) || actualCost < 0 || actualCost > 1000) {
      this.logger.warn('Rejected bridge data: invalid actualCost', {
        actualCost,
        bridge: bridgeResult.bridge,
      });
      return;
    }

    // Validate amount: positive, finite
    if (!Number.isFinite(amount) || amount <= 0) {
      this.logger.warn('Rejected bridge data: invalid amount', {
        amount,
        bridge: bridgeResult.bridge,
      });
      return;
    }

    // Validate timestamp: positive, not in the future (with 60s tolerance)
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 60000) {
      this.logger.warn('Rejected bridge data: invalid timestamp', {
        timestamp,
        bridge: bridgeResult.bridge,
      });
      return;
    }

    const bridgeObj: CrossChainBridge = {
      bridge: bridgeResult.bridge,
      sourceChain: bridgeResult.sourceChain,
      targetChain: bridgeResult.targetChain,
      token: bridgeResult.token,
      amount: bridgeResult.amount
    };

    this.bridgePredictor.updateModel({
      bridge: bridgeObj,
      actualLatency: bridgeResult.actualLatency,
      actualCost: bridgeResult.actualCost,
      success: bridgeResult.success,
      timestamp: bridgeResult.timestamp
    });

    this.logger.debug('Updated bridge predictor with transaction data', {
      bridge: bridgeResult.bridge,
      latency: bridgeResult.actualLatency,
      cost: bridgeResult.actualCost,
      success: bridgeResult.success
    });
  }

  /**
   * P2-2: Delegated to ConfidenceCalculator for single-responsibility design.
   * @see confidence-calculator.ts
   */
  private calculateConfidence(
    lowPrice: {update: PriceUpdate; price: number},
    highPrice: {price: number},
    whaleData?: WhaleActivitySummary,
    mlPrediction?: { source?: PredictionResult | null; target?: PredictionResult | null }
  ): number {
    // P2-2: Delegate to ConfidenceCalculator
    if (!this.confidenceCalculator) {
      this.logger.warn('ConfidenceCalculator not initialized');
      return 0;
    }

    return this.confidenceCalculator.calculate(lowPrice, highPrice, whaleData, mlPrediction);
  }

  private filterValidOpportunities(opportunities: CrossChainOpportunity[]): CrossChainOpportunity[] {
    return opportunities
      .filter(opp => opp.netProfit > 0 && opp.confidence > ARBITRAGE_CONFIG.confidenceThreshold)
      // Phase 3: Prioritize whale-triggered opportunities
      .sort((a, b) => {
        // Whale-triggered first
        if (a.whaleTriggered && !b.whaleTriggered) return -1;
        if (!a.whaleTriggered && b.whaleTriggered) return 1;
        // Then by net profit
        return b.netProfit - a.netProfit;
      })
      .slice(0, 10); // Top 10 opportunities
  }

  /**
   * Phase 3: Analyze whale transaction impact on cross-chain opportunities.
   * Records whale activity to tracker and triggers immediate detection for super whales.
   */
  private async analyzeWhaleImpact(whaleTx: WhaleTransaction): Promise<void> {
    if (!this.whaleTracker) {
      this.logger.debug('Whale tracker not initialized, skipping impact analysis');
      return;
    }

    try {
      // Convert WhaleTransaction to TrackedWhaleTransaction format
      // Note: TrackedWhaleTransaction has more detailed fields; we map what's available
      // FIX 4.3: Improved token parsing - handle multiple formats:
      // - "WETH/USDC" (standard pair format)
      // - "WETH_USDC" (underscore separator)
      // - "WETH" (single token - use chain-specific quote token)

      // REFACTOR: Use getDefaultQuoteToken from @arbitrage/config
      // See shared/config/src/cross-chain.ts for chain-specific default quote tokens

      let baseToken: string;
      let quoteToken: string;

      // BUG-FIX: More robust token parsing with validation for edge cases
      // Handle multiple formats: "TOKEN0/TOKEN1", "TOKEN0_TOKEN1", "DEX_TOKEN0_TOKEN1", "TOKEN"
      const tokenString = whaleTx.token.trim();

      if (tokenString.includes('/')) {
        // Format: "TOKEN0/TOKEN1"
        const tokenParts = tokenString.split('/').filter((p: string) => p.trim().length > 0);
        baseToken = tokenParts[0]?.trim() || tokenString;
        quoteToken = tokenParts[1]?.trim() || getDefaultQuoteToken(whaleTx.chain);
      } else if (tokenString.includes('_')) {
        // Format: "TOKEN0_TOKEN1" or "DEX_TOKEN0_TOKEN1"
        const tokenParts = tokenString.split('_').filter((p: string) => p.trim().length > 0);
        if (tokenParts.length >= 2) {
          // Take last two parts as tokens (handles DEX_TOKEN0_TOKEN1 format)
          baseToken = tokenParts[tokenParts.length - 2].trim();
          quoteToken = tokenParts[tokenParts.length - 1].trim();
        } else if (tokenParts.length === 1) {
          // Single part after filtering - treat as single token
          baseToken = tokenParts[0].trim();
          quoteToken = getDefaultQuoteToken(whaleTx.chain);
        } else {
          // Empty after filtering - use original
          baseToken = tokenString;
          quoteToken = getDefaultQuoteToken(whaleTx.chain);
        }
      } else {
        // Single token - common case is trading against stablecoins
        baseToken = tokenString;
        quoteToken = getDefaultQuoteToken(whaleTx.chain);
      }

      // Validate extracted tokens are non-empty
      if (!baseToken || baseToken.length === 0) {
        this.logger.warn('Invalid base token extracted from whale transaction', {
          originalToken: whaleTx.token,
          txHash: whaleTx.transactionHash,
        });
        baseToken = whaleTx.token;
      }
      if (!quoteToken || quoteToken.length === 0) {
        quoteToken = getDefaultQuoteToken(whaleTx.chain);
      }

      // Normalize tokens for consistency
      try {
        baseToken = normalizeTokenForCrossChain(baseToken) || baseToken;
        quoteToken = normalizeTokenForCrossChain(quoteToken) || quoteToken;
      } catch {
        // Keep original tokens if normalization fails
      }

      const trackedTx: TrackedWhaleTransaction = {
        transactionHash: whaleTx.transactionHash,
        walletAddress: whaleTx.address,
        chain: whaleTx.chain,
        dex: whaleTx.dex,
        pairAddress: whaleTx.token, // Token being traded (used as pair identifier)
        // FIX: Use actual token pair info instead of hardcoded USDC assumption
        tokenIn: whaleTx.direction === 'buy' ? quoteToken : baseToken,
        tokenOut: whaleTx.direction === 'buy' ? baseToken : quoteToken,
        amountIn: whaleTx.direction === 'buy' ? whaleTx.usdValue : whaleTx.amount,
        amountOut: whaleTx.direction === 'buy' ? whaleTx.amount : whaleTx.usdValue,
        usdValue: whaleTx.usdValue,
        direction: whaleTx.direction,
        priceImpact: whaleTx.impact,
        timestamp: whaleTx.timestamp,
      };

      // Record transaction in whale tracker
      this.whaleTracker.recordTransaction(trackedTx);

      // Get whale activity summary for this chain/token
      const summary = this.whaleTracker.getActivitySummary(whaleTx.token, whaleTx.chain);

      this.logger.debug('Whale transaction analyzed', {
        chain: whaleTx.chain,
        usdValue: whaleTx.usdValue,
        direction: whaleTx.direction,
        dominantDirection: summary.dominantDirection,
        netFlowUsd: summary.netFlowUsd,
        superWhaleCount: summary.superWhaleCount
      });

      // Phase 3: Trigger immediate detection for super whale or significant activity
      if (whaleTx.usdValue >= this.whaleConfig.superWhaleThresholdUsd ||
          Math.abs(summary.netFlowUsd) > this.whaleConfig.significantFlowThresholdUsd) {

        // P1-5 FIX: Use OperationGuard for rate limiting (prevents DoS via whale spam)
        const releaseWhaleGuard = this.whaleGuard.tryAcquire();
        if (!releaseWhaleGuard) {
          this.logger.debug('Whale detection rate limited, skipping', {
            remainingCooldownMs: this.whaleGuard.getRemainingCooldownMs(),
          });
          return;
        }

        try {
          this.logger.info('Super whale detected, triggering immediate opportunity scan', {
            token: whaleTx.token,
            chain: whaleTx.chain,
            usdValue: whaleTx.usdValue,
            isSuperWhale: whaleTx.usdValue >= this.whaleConfig.superWhaleThresholdUsd
          });

          // Trigger immediate cross-chain detection for this token
          await this.detectWhaleInducedOpportunities(whaleTx, summary);
        } finally {
          releaseWhaleGuard();
        }
      }
    } catch (error) {
      this.logger.error('Failed to analyze whale impact', {
        error: (error as Error).message,
        txHash: whaleTx.transactionHash
      });
    }
  }

  /**
   * Phase 3: Detect opportunities specifically triggered by whale activity.
   * Scans for cross-chain opportunities for the affected token with whale-boosted confidence.
   * DUPLICATION-I1: Now uses shared findArbitrageInPrices method.
   */
  private async detectWhaleInducedOpportunities(
    whaleTx: WhaleTransaction,
    summary: WhaleActivitySummary
  ): Promise<void> {
    if (!this.priceDataManager || !ARBITRAGE_CONFIG.crossChainEnabled) return;

    // FIX 4.2: Validate whale token before processing
    if (!whaleTx.token || typeof whaleTx.token !== 'string' || whaleTx.token.trim().length === 0) {
      this.logger.debug('Skipping whale opportunity detection: invalid token', {
        txHash: whaleTx.transactionHash,
      });
      return;
    }

    try {
      // PERF-P1: Use indexed snapshot for O(1) lookups
      const indexedSnapshot = this.priceDataManager.createIndexedSnapshot();

      // FIX 4.2: WhaleTransaction.token is a single token (e.g., "WETH"), not a pair.
      // We need to find ALL pairs that contain this token and check for arbitrage.
      const normalizedWhaleToken = normalizeTokenForCrossChain(whaleTx.token);

      // FIX #13: Use exact token part matching instead of substring includes()
      // to prevent "ETH" from matching "WETH_USDC" via substring
      const matchingPairs: string[] = [];
      for (const tokenPair of indexedSnapshot.tokenPairs) {
        const tokenParts = tokenPair.split(TOKEN_PAIR_INTERNAL_SEPARATOR);
        if (tokenParts.some(part => part === normalizedWhaleToken)) {
          matchingPairs.push(tokenPair);
        }
      }

      if (matchingPairs.length === 0) {
        this.logger.debug('No pairs found for whale token', {
          token: whaleTx.token,
          normalized: normalizedWhaleToken,
        });
        return;
      }

      // Check each matching pair for cross-chain arbitrage
      for (const tokenPair of matchingPairs) {
        const chainPrices = indexedSnapshot.byToken.get(tokenPair);

        if (chainPrices && chainPrices.length >= 2) {
          // DUPLICATION-I1: Use shared method with whale data
          const opportunities = this.findArbitrageInPrices(chainPrices, summary, whaleTx);

          for (const opportunity of opportunities) {
            if (opportunity.confidence > ARBITRAGE_CONFIG.confidenceThreshold) {
              await this.publishArbitrageOpportunity(opportunity);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to detect whale-induced opportunities', {
        error: (error as Error).message,
        token: whaleTx.token,
      });
    }
  }

  // DUPLICATION-I1: findArbitrageInPairWithWhaleData removed - logic merged into findArbitrageInPrices

  /**
   * ADR-014: Publish opportunity via OpportunityPublisher module.
   * The module handles deduplication, conversion, and caching.
   *
   * P0-7: Pre-validation logic delegated to PreValidationOrchestrator.
   * The orchestrator handles sampling, budget management, and simulation.
   */
  private async publishArbitrageOpportunity(opportunity: CrossChainOpportunity): Promise<void> {
    if (!this.opportunityPublisher) return;

    try {
      // P0-7: Delegate pre-validation to orchestrator
      if (this.preValidationOrchestrator) {
        const result = await this.preValidationOrchestrator.validateOpportunity(opportunity);
        if (!result.allowed) {
          // Opportunity filtered by pre-validation
          return;
        }
      }

      await this.opportunityPublisher.publish(opportunity);
    } catch (error) {
      this.logger.error('Failed to publish arbitrage opportunity', { error });
    }
  }

  // P0-7: Pre-validation methods extracted to PreValidationOrchestrator
  // See pre-validation-orchestrator.ts for implementation

  /**
   * P0-7: Get pre-validation metrics from orchestrator.
   */
  getPreValidationMetrics(): {
    budgetUsed: number;
    budgetRemaining: number;
    successCount: number;
    failCount: number;
    successRate: number;
  } {
    if (!this.preValidationOrchestrator) {
      return {
        budgetUsed: 0,
        budgetRemaining: 0,
        successCount: 0,
        failCount: 0,
        successRate: 0,
      };
    }
    return this.preValidationOrchestrator.getMetrics();
  }

  /**
   * P0-7: Set simulation callback via orchestrator.
   *
   * Allows runtime injection of simulation capability after detector initialization.
   * The orchestrator calls this once SimulationService is ready.
   *
   * @param callback - The simulation callback or null to disable
   */
  setSimulationCallback(callback: PreValidationSimulationCallback | null): void {
    this.preValidationOrchestrator?.setSimulationCallback(callback);
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  private startHealthMonitoring(): void {
    // CONFIG-C1: Use configurable health check interval
    const intervalMs = this.config.healthCheckIntervalMs!;
    this.healthMonitoringInterval = setInterval(async () => {
      if (!this.stateManager.isRunning()) return;

      // P1-5 FIX: Use OperationGuard for concurrency control
      const releaseGuard = this.healthGuard.tryAcquire();
      if (!releaseGuard) {
        return; // Previous health check still running
      }

      try {
        // P3-2 FIX: Use unified ServiceHealth with 'name' field
        // FIX 6.3: Standardized to 'lastHeartbeat' per ServiceHealth interface.
        // FIX 8.1: Removed deprecated 'timestamp' field - coordinator now uses 'lastHeartbeat' only
        const now = Date.now();
        const health = {
          name: 'cross-chain-detector',
          status: (this.stateManager.isRunning() ? 'healthy' : 'unhealthy') as 'healthy' | 'degraded' | 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: now,    // FIX 6.3: Primary field per ServiceHealth interface
          // ADR-014: Use module getters for health metrics
          chainsMonitored: this.priceDataManager?.getChains().length ?? 0,
          opportunitiesCache: this.opportunityPublisher?.getCacheSize() ?? 0,
          mlPredictorActive: this.mlPredictorInitialized
        };

        // FIX 2.2: Publish health to stream with MAXLEN limit
        // STREAM_MAX_LENGTHS[HEALTH] = 1000 per redis-streams.ts
        if (this.streamsClient) {
          await this.streamsClient.xaddWithLimit(
            RedisStreamsClient.STREAMS.HEALTH,
            health
          );
        }

        // Also update legacy health key
        if (this.redis) {
          await this.redis.updateServiceHealth('cross-chain-detector', health);
        }

        this.perfLogger.logHealthCheck('cross-chain-detector', health);
      } catch (error) {
        this.logger.error('Cross-chain health monitoring failed', { error });
      } finally {
        releaseGuard();
      }
    }, intervalMs);
  }

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  isRunning(): boolean {
    return this.stateManager.isRunning();
  }

  getState(): ServiceState {
    return this.stateManager.getState();
  }

  // ADR-014: Use PriceDataManager for chain information
  getChainsMonitored(): string[] {
    return this.priceDataManager?.getChains() ?? [];
  }

  // ADR-014: Use OpportunityPublisher for cache metrics
  getOpportunitiesCount(): number {
    return this.opportunityPublisher?.getCacheSize() ?? 0;
  }
}
