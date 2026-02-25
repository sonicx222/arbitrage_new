/**
 * Arbitrage Execution Engine with MEV Protection
 *
 * Executes arbitrage opportunities detected by the system.
 * Uses distributed locking to prevent duplicate executions.
 *
 * Architecture (Phase 3.2 refactored):
 * - types.ts: Shared types and interfaces
 * - services/provider.service.ts: RPC provider management
 * - services/queue.service.ts: Execution queue with backpressure
 * - strategies/*.ts: Execution strategies (intra-chain, cross-chain, simulation)
 * - consumers/opportunity.consumer.ts: Redis Stream consumption
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
  ServiceStateManager,
  ServiceState,
  createServiceState,
  DistributedLockManager,
  getDistributedLockManager,
  NonceManager,
  getNonceManager,
  MevProviderFactory,
  BridgeRouterFactory,
  getErrorMessage,
  disconnectWithTimeout,
  // Phase 3: Capital Risk Management (Task 3.4.5)
  DrawdownCircuitBreaker,
  resetDrawdownCircuitBreaker,
  EVCalculator,
  resetEVCalculator,
  KellyPositionSizer,
  resetKellyPositionSizer,
  ExecutionProbabilityTracker,
  resetExecutionProbabilityTracker,
  type TradingAllowedResult,
  type EVCalculation,
  type PositionSize,
  stopAndNullify,
  clearIntervalSafe,
  TradeLogger,
  type TradeLoggerConfig,
  R2Uploader,
  type R2UploaderConfig,
  parseEnvIntSafe,
} from '@arbitrage/core';
// P1 FIX: Import extracted lock conflict tracker
import { LockConflictTracker } from './services/lock-conflict-tracker';
import { RISK_CONFIG, FEATURE_FLAGS, FLASH_LOAN_PROVIDERS, DEXES, R2_CONFIG, BALANCER_V2_VAULTS } from '@arbitrage/config';
// FIX 1.1: Import initialization module instead of duplicating initialization logic
import {
  initializeMevProviders,
  initializeRiskManagement,
  initializeBridgeRouter,
  resetInitializationState,
} from './initialization';
import { RedisStreams, type ArbitrageOpportunity, type ServiceHealth } from '@arbitrage/types';

// Internal modules
import {
  ExecutionEngineConfig,
  ExecutionStats,
  ExecutionResult,
  StrategyContext,
  Logger,
  ProviderHealth,
  SimulationConfig,
  ResolvedSimulationConfig,
  QueueConfig,
  StandbyConfig,
  CircuitBreakerConfig,
  PendingStateEngineConfig,
  ConsumerConfig,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_CONSUMER_CONFIG,
  EXECUTION_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  createInitialStats,
  resolveSimulationConfig,
  DEFAULT_QUEUE_CONFIG,
  createErrorResult,
  createSkippedResult,
  ExecutionErrorCode,
} from './types';
import { ProviderServiceImpl } from './services/provider.service';
import { QueueServiceImpl } from './services/queue.service';
import { IntraChainStrategy } from './strategies/intra-chain.strategy';
import { CrossChainStrategy } from './strategies/cross-chain.strategy';
import { SimulationStrategy } from './strategies/simulation.strategy';
import { FlashLoanStrategy } from './strategies/flash-loan.strategy';
import { createFlashLoanProviderFactory } from './strategies/flash-loan-providers/provider-factory';
import { ExecutionStrategyFactory, createStrategyFactory } from './strategies/strategy-factory';
// P0 Fix #1: Import backrun and UniswapX strategies for registration
import { BackrunStrategy } from './strategies/backrun.strategy';
import { UniswapXFillerStrategy } from './strategies/uniswapx-filler.strategy';
// Fix #51: Import MEV-Share event listener for backrun opportunity wiring
import type { MevShareEventListener, BackrunOpportunity, Logger as CoreLogger } from '@arbitrage/core';
import { OpportunityConsumer } from './consumers/opportunity.consumer';
import { FastLaneConsumer } from './consumers/fast-lane.consumer';
import type { ISimulationService } from './services/simulation/types';
import {
  recordExecutionAttempt,
  recordExecutionSuccess,
  recordOpportunityDetected,
  updateGasPrice,
  recordVolume,
} from './services/prometheus-metrics';
import {
  createSimulationMetricsCollector,
  SimulationMetricsCollector,
  SimulationMetricsSnapshot,
} from './services/simulation/simulation-metrics-collector';
import type {
  CircuitBreakerStatus,
} from './services/circuit-breaker';
// P0 Refactoring: Health monitoring extracted from engine.ts
import {
  HealthMonitoringManager,
  createHealthMonitoringManager,
} from './services/health-monitoring-manager';
// Finding #7: Circuit breaker management extracted from engine.ts
import {
  CircuitBreakerManager,
  createCircuitBreakerManager,
} from './services/circuit-breaker-manager';
// Finding #7: Pending state simulation extracted from engine.ts
import {
  PendingStateManager,
  createPendingStateManager,
} from './services/pending-state-manager';
// Finding #7: TX simulation init extracted from engine.ts
import { initializeTxSimulationService } from './services/tx-simulation-initializer';
// S6: Standby management extracted from engine.ts
import {
  StandbyManager,
  createStandbyManager,
} from './services/standby-manager';
// R2: Extracted risk management orchestrator
import { RiskManagementOrchestrator, createRiskOrchestrator } from './risk';
// T-13: Bridge Recovery Manager
import {
  BridgeRecoveryManager,
  createBridgeRecoveryManager,
  type RecoveryMetrics,
} from './services/bridge-recovery-manager';
// Task 3: A/B Testing Framework
import {
  ABTestingFramework,
  createABTestingFramework,
  type ABTestingConfig,
  type VariantAssignment,
  type ExperimentSummary,
} from './ab-testing';
// Task 4.1: Per-Chain Balance Monitor
import {
  BalanceMonitor,
  createBalanceMonitor,
  type BalanceSnapshot,
} from './services/balance-monitor';
// W1-42 FIX: Extracted execution pipeline
import { ExecutionPipeline, type PipelineDeps } from './execution-pipeline';

// Re-export types for consumers
export type {
  ExecutionEngineConfig,
  ExecutionStats,
  ExecutionResult,
  SimulationConfig,
  QueueConfig,
  ProviderHealth,
  CircuitBreakerConfig,
};

// Re-export simulation metrics type (Phase 1.1.3)
export type { SimulationMetricsSnapshot };

// Re-export circuit breaker status type (Phase 1.3.1)
export type { CircuitBreakerStatus };

// Re-export bridge recovery metrics type (T-13)
export type { RecoveryMetrics };

/**
 * Execution Engine Service - Composition Root
 *
 * Orchestrates all execution components:
 * - Provider management (RPC connections, health, reconnection)
 * - Queue management (backpressure, water marks)
 * - Stream consumption (opportunities from Redis)
 * - Execution strategies (intra-chain, cross-chain, simulation)
 * - Distributed locking (prevent duplicate executions)
 */
export class ExecutionEngineService {
  // Core dependencies
  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null;
  private lockManager: DistributedLockManager | null = null;
  private nonceManager: NonceManager | null = null;
  private mevProviderFactory: MevProviderFactory | null = null;
  private bridgeRouterFactory: BridgeRouterFactory | null = null;

  // Extracted services
  private providerService: ProviderServiceImpl | null = null;
  private queueService: QueueServiceImpl | null = null;
  private opportunityConsumer: OpportunityConsumer | null = null;
  private fastLaneConsumer: FastLaneConsumer | null = null;

  // Execution strategies (using factory pattern for clean dispatch)
  private strategyFactory: ExecutionStrategyFactory | null = null;
  private intraChainStrategy: IntraChainStrategy | null = null;
  private crossChainStrategy: CrossChainStrategy | null = null;
  private simulationStrategy: SimulationStrategy | null = null;
  // Fix 4: Store references for metrics exposure via health endpoint
  private backrunStrategy: BackrunStrategy | null = null;
  private uniswapxStrategy: UniswapXFillerStrategy | null = null;

  // Transaction simulation service (Phase 1.1)
  private txSimulationService: ISimulationService | null = null;

  // Simulation metrics collector (Phase 1.1.3)
  private simulationMetricsCollector: SimulationMetricsCollector | null = null;

  // Finding #7: Circuit breaker management extracted to dedicated manager
  private cbManager: CircuitBreakerManager | null = null;

  // Phase 3: Capital Risk Management (Task 3.4.5)
  private drawdownBreaker: DrawdownCircuitBreaker | null = null;
  private evCalculator: EVCalculator | null = null;
  private positionSizer: KellyPositionSizer | null = null;
  private probabilityTracker: ExecutionProbabilityTracker | null = null;
  private riskManagementEnabled = false;
  // R2: Extracted orchestrator encapsulates risk assessment logic
  private riskOrchestrator: RiskManagementOrchestrator | null = null;

  // Task 3: A/B Testing Framework
  private abTestingFramework: ABTestingFramework | null = null;
  private readonly abTestingConfig: Partial<ABTestingConfig>;

  // Finding #7: Pending state simulation extracted to dedicated manager
  private pendingStateManager: PendingStateManager | null = null;

  // Infrastructure
  private readonly logger: Logger;
  private readonly perfLogger: PerformanceLogger;
  private readonly stateManager: ServiceStateManager;
  private readonly instanceId: string;

  // Configuration
  private readonly simulationConfig: ResolvedSimulationConfig;
  private isSimulationMode: boolean; // Mutable for activation (ADR-007)
  private readonly queueConfig: QueueConfig;
  private readonly standbyConfig: StandbyConfig;
  private readonly circuitBreakerConfig: Required<CircuitBreakerConfig>;
  private readonly pendingStateConfig: PendingStateEngineConfig; // Phase 2 config
  private readonly consumerConfig: Partial<ConsumerConfig> | undefined; // Consumer tuning

  // S6: Standby activation management extracted to StandbyManager
  private standbyManager: StandbyManager | null = null;

  // State
  private stats: ExecutionStats;
  private gasBaselines: Map<string, { price: bigint; timestamp: number }[]> = new Map();
  // FIX 10.1: Pre-computed last gas prices for O(1) hot path access
  private lastGasPrices: Map<string, bigint> = new Map();
  private activeExecutionCount = 0;
  private readonly maxConcurrentExecutions: number;
  private isProcessingQueue = false; // Guard against concurrent processQueueItems calls (legacy, kept for pipeline fallback)

  // W1-42 FIX: Extracted execution pipeline
  private executionPipeline: ExecutionPipeline | null = null;

  // FIX 5: Track circuit breaker re-enqueue attempts per opportunity to prevent
  // infinite dequeue/re-enqueue loops when CB is in HALF_OPEN state
  private readonly cbReenqueueCounts = new Map<string, number>();
  private static readonly MAX_CB_REENQUEUE_ATTEMPTS = 3;
  /** Max size for cbReenqueueCounts before forced cleanup (prevents unbounded growth) */
  private static readonly MAX_CB_REENQUEUE_MAP_SIZE = 10_000;

  // P1 FIX: Lock conflict tracking extracted to dedicated class
  // Tracks repeated lock conflicts to detect crashed lock holders
  // P1 FIX: Logger injected via constructor DI (was module-level)
  private lockConflictTracker: LockConflictTracker = null!; // Initialized in constructor

  // O-6: Persistent trade logger for audit and analysis
  private tradeLogger: TradeLogger | null = null;

  // Batch 6: R2 trade log uploader for durable storage
  private r2Uploader: R2Uploader | null = null;
  private r2DailyUploadInterval: ReturnType<typeof setInterval> | null = null;

  // T-13: Bridge recovery manager for cross-chain failure recovery
  private bridgeRecoveryManager: BridgeRecoveryManager | null = null;

  // Task 4.1: Per-chain balance monitor
  private balanceMonitor: BalanceMonitor | null = null;

  // Fix #51: MEV-Share SSE event listener for backrun opportunity ingestion
  private mevShareListener: MevShareEventListener | null = null;

  // P0 Refactoring: Health monitoring extracted to dedicated manager
  // Handles non-hot-path interval operations (health checks, gas cleanup, pending cleanup)
  private healthMonitoringManager: HealthMonitoringManager | null = null;

  // Intervals (only executionProcessingInterval remains in engine - hot path related)
  private executionProcessingInterval: NodeJS.Timeout | null = null;

  constructor(config: ExecutionEngineConfig = {}) {
    // Use injected dependencies or defaults (initialized early for use in safety guards)
    this.logger = config.logger ?? createLogger('execution-engine');
    this.perfLogger = config.perfLogger ?? getPerformanceLogger('execution-engine');

    // Initialize simulation config
    this.isSimulationMode = config.simulationConfig?.enabled ?? false;
    this.simulationConfig = resolveSimulationConfig(config.simulationConfig);

    // FIX-3.1: Production safety guard for simulation mode
    // Prevents accidental deployment with simulation mode enabled in production
    // which would cause the engine to NOT execute real transactions (capital drain risk)
    const isProduction = process.env.NODE_ENV === 'production';
    const hasOverride = process.env.SIMULATION_MODE_PRODUCTION_OVERRIDE === 'true';

    if (isProduction && this.isSimulationMode) {
      if (hasOverride) {
        // This is a deliberate override - log prominently but allow
        this.logger.error(
          'DANGER: SIMULATION MODE OVERRIDE ACTIVE IN PRODUCTION - ' +
          'No real transactions will be executed! ' +
          'Remove SIMULATION_MODE_PRODUCTION_OVERRIDE for live trading.'
        );
      } else {
        throw new Error(
          '[CRITICAL] Simulation mode is enabled in production environment. ' +
          'This would prevent real transaction execution. ' +
          'Either set NODE_ENV to a non-production value or disable simulation mode. ' +
          'Set SIMULATION_MODE_PRODUCTION_OVERRIDE=true to explicitly allow (dangerous).'
        );
      }
    }

    // Initialize queue config
    this.queueConfig = {
      ...DEFAULT_QUEUE_CONFIG,
      ...config.queueConfig
    };

    // Initialize standby config (ADR-007)
    this.standbyConfig = {
      isStandby: config.standbyConfig?.isStandby ?? false,
      queuePausedOnStart: config.standbyConfig?.queuePausedOnStart ?? false,
      activationDisablesSimulation: config.standbyConfig?.activationDisablesSimulation ?? true,
      regionId: config.standbyConfig?.regionId
    };

    // Initialize circuit breaker config (Phase 1.3.1)
    this.circuitBreakerConfig = {
      enabled: config.circuitBreakerConfig?.enabled ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.enabled,
      failureThreshold: config.circuitBreakerConfig?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold,
      cooldownPeriodMs: config.circuitBreakerConfig?.cooldownPeriodMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownPeriodMs,
      halfOpenMaxAttempts: config.circuitBreakerConfig?.halfOpenMaxAttempts ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts,
    };

    // Initialize Phase 2 pending state config
    this.pendingStateConfig = {
      enabled: config.pendingStateConfig?.enabled ?? false,
      rpcUrl: config.pendingStateConfig?.rpcUrl,
      chain: config.pendingStateConfig?.chain ?? 'ethereum',
      anvilPort: config.pendingStateConfig?.anvilPort ?? 8546,
      autoStartAnvil: config.pendingStateConfig?.autoStartAnvil ?? true,
      enableHotSync: config.pendingStateConfig?.enableHotSync ?? true,
      syncIntervalMs: config.pendingStateConfig?.syncIntervalMs ?? 1000,
      adaptiveSync: config.pendingStateConfig?.adaptiveSync ?? true,
      minSyncIntervalMs: config.pendingStateConfig?.minSyncIntervalMs ?? 200,
      maxSyncIntervalMs: config.pendingStateConfig?.maxSyncIntervalMs ?? 5000,
      maxConsecutiveFailures: config.pendingStateConfig?.maxConsecutiveFailures ?? 5,
      simulationTimeoutMs: config.pendingStateConfig?.simulationTimeoutMs ?? 5000,
    };

    // Store consumer config for passing to OpportunityConsumer
    this.consumerConfig = config.consumerConfig;

    // Task 3: A/B testing config (enabled via environment variable)
    // FIX P0-2: Validate env var parseFloat/parseInt to prevent NaN propagation
    const rawTrafficSplit = parseFloat(process.env.AB_TESTING_TRAFFIC_SPLIT || '0.1');
    const rawMinSampleSize = parseInt(process.env.AB_TESTING_MIN_SAMPLE_SIZE || '100', 10);
    const rawSignificance = parseFloat(process.env.AB_TESTING_SIGNIFICANCE || '0.05');

    const validTrafficSplit = !Number.isNaN(rawTrafficSplit) && rawTrafficSplit > 0 && rawTrafficSplit < 1
      ? rawTrafficSplit : 0.1;
    const validMinSampleSize = !Number.isNaN(rawMinSampleSize) && rawMinSampleSize > 0
      ? rawMinSampleSize : 100;
    const validSignificance = !Number.isNaN(rawSignificance) && rawSignificance > 0 && rawSignificance < 1
      ? rawSignificance : 0.05;

    this.abTestingConfig = {
      enabled: process.env.AB_TESTING_ENABLED === 'true',
      defaultTrafficSplit: validTrafficSplit,
      defaultMinSampleSize: validMinSampleSize,
      significanceThreshold: validSignificance,
      ...config.abTestingConfig,
    };

    // P1 FIX: Initialize lock conflict tracker with injected logger
    this.lockConflictTracker = new LockConflictTracker({ logger: this.logger });

    // O-6: Initialize persistent trade logger
    const tradeLogEnabled = process.env.TRADE_LOG_ENABLED !== 'false';
    const tradeLogDir = process.env.TRADE_LOG_DIR ?? './data/trades';
    this.tradeLogger = new TradeLogger(
      {
        enabled: config.tradeLoggerConfig?.enabled ?? tradeLogEnabled,
        outputDir: config.tradeLoggerConfig?.outputDir ?? tradeLogDir,
      },
      this.logger,
    );

    // Max concurrent executions: config > env var > default 5
    const envMaxConcurrent = parseInt(process.env.MAX_CONCURRENT_EXECUTIONS ?? '', 10);
    this.maxConcurrentExecutions = config.maxConcurrentExecutions
      ?? (!Number.isNaN(envMaxConcurrent) && envMaxConcurrent > 0 ? envMaxConcurrent : 5);

    // Generate unique instance ID
    this.instanceId = `execution-engine-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    // State machine for lifecycle management
    this.stateManager = config.stateManager ?? createServiceState({
      serviceName: 'execution-engine',
      transitionTimeoutMs: (() => { const v = parseInt(process.env.STATE_TRANSITION_TIMEOUT_MS ?? '', 10); return Number.isNaN(v) ? 30000 : v; })()
    });

    // Initialize stats
    this.stats = createInitialStats();
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(): Promise<void> {
    const result = await this.stateManager.executeStart(async () => {
      this.logger.info('Starting Execution Engine Service', {
        instanceId: this.instanceId,
        queueConfig: this.queueConfig,
        simulationMode: this.isSimulationMode
      });

      if (this.isSimulationMode) {
        this.logger.warn('⚠️ SIMULATION MODE ENABLED - No real transactions will be executed', {
          successRate: this.simulationConfig.successRate,
          executionLatencyMs: this.simulationConfig.executionLatencyMs,
          profitVariance: this.simulationConfig.profitVariance
        });
      }

      // Initialize Redis clients
      this.redis = await getRedisClient();
      this.streamsClient = await getRedisStreamsClient();

      // Initialize distributed lock manager
      this.lockManager = await getDistributedLockManager({
        keyPrefix: 'lock:execution:',
        defaultTtlMs: 60000
      });

      // Initialize nonce manager
      // Tier 2 Enhancement: Explicit pool configuration for burst submissions
      // Pool pre-allocates nonces for 5-10ms latency reduction during bursts
      this.nonceManager = getNonceManager({
        syncIntervalMs: 30000,
        pendingTimeoutMs: 300000,
        maxPendingPerChain: parseEnvIntSafe('NONCE_MAX_PENDING', 10, 1),
        // Tier 2: Pre-allocation pool for instant nonce access during bursts
        preAllocationPoolSize: parseEnvIntSafe('NONCE_POOL_SIZE', 5, 1),
        poolReplenishThreshold: parseEnvIntSafe('NONCE_POOL_REPLENISH_THRESHOLD', 2, 1),
      });

      // Initialize provider service
      // Phase 3: RPC batching controlled via environment variable
      const enableBatching = process.env.RPC_BATCHING_ENABLED === 'true';
      this.providerService = new ProviderServiceImpl({
        logger: this.logger,
        stateManager: this.stateManager,
        nonceManager: this.nonceManager,
        stats: this.stats,
        enableBatching,
        batchConfig: enableBatching ? {
          maxBatchSize: parseEnvIntSafe('RPC_BATCH_MAX_SIZE', 10, 1),
          batchTimeoutMs: parseEnvIntSafe('RPC_BATCH_TIMEOUT_MS', 10, 1),
          maxQueueSize: parseEnvIntSafe('RPC_BATCH_MAX_QUEUE', 100, 1),
          enabled: true,
        } : undefined,
      });

      // Clear stale gas baseline when provider reconnects
      // NOTE: We clear the array contents instead of deleting the Map entry to avoid
      // race conditions with strategies that may hold a reference to the array.
      // This ensures in-flight operations see empty data rather than orphaned arrays.
      this.providerService.onProviderReconnect((chainName: string) => {
        const history = this.gasBaselines.get(chainName);
        if (history) {
          history.length = 0; // Clear contents, keep array reference valid
        }
        // FIX 10.1: Also clear pre-computed last gas price
        this.lastGasPrices.delete(chainName);
        this.logger.debug('Cleared gas baseline after provider reconnect', { chainName });
      });

      // Initialize queue service
      this.queueService = new QueueServiceImpl({
        logger: this.logger,
        queueConfig: this.queueConfig
      });

      // Pause queue if standby mode configured (ADR-007)
      if (this.standbyConfig.queuePausedOnStart) {
        this.queueService.pause();
        this.logger.info('Queue paused on start (standby mode)', {
          isStandby: this.standbyConfig.isStandby,
          regionId: this.standbyConfig.regionId
        });
      }

      // Initialize blockchain providers (skip in simulation mode)
      if (!this.isSimulationMode) {
        await this.providerService.initialize();
        this.providerService.initializeWallets();
        // FIX 11: Await KMS address resolution before processing opportunities
        await this.providerService.waitForKmsRegistrations();

        // FIX 1.1: Use initialization module instead of duplicate private methods
        // Initialize MEV protection using module
        const mevResult = await initializeMevProviders(this.providerService, this.logger);
        this.mevProviderFactory = mevResult.factory;
        if (!mevResult.success && mevResult.error) {
          this.logger.warn('MEV initialization had issues', { error: mevResult.error });
        }

        // Initialize bridge router using module
        const bridgeResult = initializeBridgeRouter(this.providerService, this.logger);
        this.bridgeRouterFactory = bridgeResult.factory;
        if (!bridgeResult.success && bridgeResult.error) {
          this.logger.warn('Bridge router initialization had issues', { error: bridgeResult.error });
        }

        // Start nonce manager
        this.nonceManager.start();

        // Validate and start health monitoring
        await this.providerService.validateConnectivity();
        this.providerService.startHealthChecks();
      } else {
        this.logger.info('Skipping blockchain initialization in simulation mode');
      }

      // Initialize execution strategies (async for dynamic imports)
      await this.initializeStrategies();

      // Finding #7: Initialize Phase 2 pending state simulation via extracted manager
      if (this.pendingStateConfig.enabled && !this.isSimulationMode) {
        this.pendingStateManager = createPendingStateManager({
          config: this.pendingStateConfig,
          providerSource: this.providerService!,
          logger: this.logger,
        });
        await this.pendingStateManager.initialize();
      }

      // Finding #7: Initialize circuit breaker via extracted manager
      this.cbManager = createCircuitBreakerManager({
        config: this.circuitBreakerConfig,
        logger: this.logger,
        stats: this.stats,
        instanceId: this.instanceId,
        getStreamsClient: () => this.streamsClient,
      });
      this.cbManager.initialize();

      // Task 2.3: Validate trade log directory is writable at startup
      if (this.tradeLogger) {
        await this.tradeLogger.validateLogDir();
      }

      // Batch 6: Initialize R2 uploader for trade log durability
      if (R2_CONFIG.enabled) {
        this.r2Uploader = new R2Uploader(R2_CONFIG, this.logger);
        // Schedule daily upload of previous day's logs at midnight
        const tradeLogDir = this.tradeLogger?.getLogPath()
          ? this.tradeLogger.getLogPath().replace(/[/\\][^/\\]+$/, '')
          : (process.env.TRADE_LOG_DIR ?? './data/trades');
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        this.r2DailyUploadInterval = setInterval(() => {
          this.r2Uploader?.uploadPreviousDayLogs(tradeLogDir).catch((err: unknown) => {
            this.logger.warn('R2 daily upload failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, TWENTY_FOUR_HOURS_MS);
        // Prevent interval from keeping process alive
        if (this.r2DailyUploadInterval && typeof this.r2DailyUploadInterval === 'object' && 'unref' in this.r2DailyUploadInterval) {
          this.r2DailyUploadInterval.unref();
        }
        this.logger.info('R2 trade log uploader initialized', {
          bucket: R2_CONFIG.bucket,
          prefix: R2_CONFIG.prefix,
        });
      }

      // FIX 1.1: Use initialization module for risk management
      // Initialize capital risk management (Phase 3: Task 3.4.5)
      // Fix 2: Pass Redis client for probability tracker persistence
      const riskResult = initializeRiskManagement(this.logger, { skipValidation: false, redis: this.redis });
      this.drawdownBreaker = riskResult.drawdownBreaker;
      this.evCalculator = riskResult.evCalculator;
      this.positionSizer = riskResult.positionSizer;
      this.probabilityTracker = riskResult.probabilityTracker;
      this.riskManagementEnabled = riskResult.enabled;

      // R2: Create risk orchestrator to encapsulate assessment logic
      // This replaces ~110 LOC of inline risk checks in executeOpportunity()
      if (this.riskManagementEnabled) {
        this.riskOrchestrator = createRiskOrchestrator({
          drawdownBreaker: this.drawdownBreaker,
          evCalculator: this.evCalculator,
          positionSizer: this.positionSizer,
          probabilityTracker: this.probabilityTracker,
          logger: this.logger,
          stats: this.stats,
        });
      }

      // CRITICAL FIX: Throw on risk management failure in production
      // Previously this only logged a warning, allowing trades to execute without
      // proper risk controls (drawdown limits, position sizing). This is dangerous
      // and could lead to capital loss.
      if (!riskResult.success && riskResult.error) {
        if (this.isSimulationMode) {
          // In simulation mode, warn but continue (allows testing without full risk setup)
          this.logger.warn('Risk management initialization had issues (simulation mode - continuing)', {
            error: riskResult.error,
            componentStatus: riskResult.componentStatus,
          });
        } else {
          // In production mode, throw to prevent trading without risk controls
          this.logger.error('Risk management initialization FAILED - cannot proceed without risk controls', {
            error: riskResult.error,
            componentStatus: riskResult.componentStatus,
          });
          throw new Error(`Risk management initialization failed: ${riskResult.error}. Cannot execute trades without proper risk controls.`);
        }
      }

      // Task 3: Initialize A/B testing framework
      if (this.abTestingConfig.enabled) {
        this.abTestingFramework = createABTestingFramework(this.redis, this.abTestingConfig, this.logger);
        await this.abTestingFramework.start();
        this.logger.info('A/B testing framework initialized', {
          defaultTrafficSplit: this.abTestingConfig.defaultTrafficSplit,
          minSampleSize: this.abTestingConfig.defaultMinSampleSize,
        });
      }

      // T-13: Initialize bridge recovery manager (cross-chain failure recovery)
      // Requires: Redis client, bridge router factory
      // Only start in non-simulation mode with a bridge router available
      if (!this.isSimulationMode && this.redis && this.bridgeRouterFactory) {
        this.bridgeRecoveryManager = createBridgeRecoveryManager({
          logger: this.logger,
          redis: this.redis,
          bridgeRouterFactory: this.bridgeRouterFactory,
          config: {
            enabled: process.env.BRIDGE_RECOVERY_ENABLED !== 'false',
            checkIntervalMs: parseEnvIntSafe('BRIDGE_RECOVERY_CHECK_INTERVAL_MS', 60000, 5000),
            maxConcurrentRecoveries: parseEnvIntSafe('BRIDGE_RECOVERY_MAX_CONCURRENT', 3, 1),
          },
        });
        const recoveredCount = await this.bridgeRecoveryManager.start();
        if (recoveredCount > 0) {
          this.logger.info('Bridge recovery found pending bridges on startup', { count: recoveredCount });
        }
      }

      // Task 4.1: Start per-chain balance monitor (monitoring only, non-blocking)
      if (!this.isSimulationMode && this.providerService) {
        this.balanceMonitor = createBalanceMonitor({
          logger: this.logger,
          getProviders: () => this.providerService?.getProviders() ?? new Map(),
          getWallets: () => this.providerService?.getWallets() ?? new Map(),
          config: {
            enabled: process.env.BALANCE_MONITOR_ENABLED !== 'false',
            checkIntervalMs: parseEnvIntSafe('BALANCE_MONITOR_INTERVAL_MS', 60000, 5000),
            lowBalanceThresholdEth: parseFloat(process.env.BALANCE_MONITOR_LOW_THRESHOLD_ETH ?? '0.01'),
          },
        });
        await this.balanceMonitor.start();
      }

      // S6: Initialize standby manager (delegates activate/standby state)
      this.standbyManager = createStandbyManager({
        logger: this.logger,
        stateManager: this.stateManager,
        standbyConfig: this.standbyConfig,
        initialSimulationMode: this.isSimulationMode,
        getProviderService: () => this.providerService,
        getQueueService: () => this.queueService,
        getStrategyFactory: () => this.strategyFactory,
        getStreamsClient: () => this.streamsClient,
        getNonceManager: () => this.nonceManager,
        onMevProviderFactoryUpdated: (factory) => { this.mevProviderFactory = factory; this.invalidateStrategyContext(); },
        onBridgeRouterFactoryUpdated: (factory) => { this.bridgeRouterFactory = factory; this.invalidateStrategyContext(); },
        onSimulationModeChanged: (mode) => { this.isSimulationMode = mode; this.invalidateStrategyContext(); },
      });

      // Initialize opportunity consumer
      this.opportunityConsumer = new OpportunityConsumer({
        logger: this.logger,
        streamsClient: this.streamsClient,
        queueService: this.queueService,
        stats: this.stats,
        instanceId: this.instanceId,
        consumerConfig: this.consumerConfig,
      });

      // Create consumer groups and start consuming
      await this.opportunityConsumer.createConsumerGroup();
      this.opportunityConsumer.start();

      // Item 12: Initialize fast lane consumer (coordinator bypass for high-confidence opps)
      if (FEATURE_FLAGS.useFastLane) {
        this.fastLaneConsumer = new FastLaneConsumer({
          logger: this.logger,
          streamsClient: this.streamsClient,
          queueService: this.queueService,
          stats: this.stats,
          instanceId: this.instanceId,
          isAlreadySeen: (id) => this.opportunityConsumer?.isActive(id) ?? false,
          consumerConfig: this.consumerConfig,
        });
        await this.fastLaneConsumer.createConsumerGroup();
        this.fastLaneConsumer.start();
      }

      // Start execution processing
      this.startExecutionProcessing();

      // Fix #51: Wire MEV-Share backrun event listener when both flags are enabled
      // Requires useBackrunStrategy (registers BackrunStrategy) AND useMevShareBackrun (enables SSE stream)
      if (FEATURE_FLAGS.useMevShareBackrun && FEATURE_FLAGS.useBackrunStrategy) {
        await this.initializeMevShareListener();
      }

      // Start simulation metrics collector (Phase 1.1.3)
      // Note: Must start before health monitoring to provide metrics
      this.startSimulationMetricsCollection();

      // P0 Refactoring: Create and start health monitoring manager
      // All dependencies passed via constructor (one-time cost)
      // Maps passed by reference (no copy) per constraint #2
      this.healthMonitoringManager = createHealthMonitoringManager({
        logger: this.logger,
        perfLogger: this.perfLogger,
        stateManager: this.stateManager,
        stats: this.stats,
        gasBaselines: this.gasBaselines, // By reference
        lockConflictTracker: this.lockConflictTracker,
        consumerConfig: this.consumerConfig,
        // Getters for nullable services
        getStreamsClient: () => this.streamsClient,
        getRedis: () => this.redis,
        getQueueService: () => this.queueService,
        getOpportunityConsumer: () => this.opportunityConsumer,
        getSimulationMetricsSnapshot: () => this.simulationMetricsCollector?.getSnapshot() ?? null,
        // Fix 4: Expose strategy-specific metrics (backrun, UniswapX) in health data
        getStrategyMetrics: () => this.getStrategyMetrics(),
      });
      this.healthMonitoringManager.start();

      this.logger.info('Execution Engine Service started successfully');
    });

    if (!result.success) {
      this.logger.error('Failed to start Execution Engine Service', {
        error: result.error
      });
      throw result.error;
    }
  }

  async stop(): Promise<void> {
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping Execution Engine Service');

      // Clear execution processing interval (hot-path related)
      this.clearIntervals();

      // Fix R2: Wait for in-flight executions to complete before tearing down.
      // Without this, active executions lose access to providers/Redis/nonces mid-flight.
      if (this.activeExecutionCount > 0) {
        this.logger.info('Waiting for in-flight executions to complete', {
          activeCount: this.activeExecutionCount,
        });
        const drainStart = Date.now();
        const drainTimeoutMs = 10_000;
        while (this.activeExecutionCount > 0 && Date.now() - drainStart < drainTimeoutMs) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        if (this.activeExecutionCount > 0) {
          this.logger.warn('In-flight executions did not complete within drain timeout', {
            remaining: this.activeExecutionCount,
            drainTimeoutMs,
          });
        }
      }

      // Batch 6: Upload current day's trade log to R2 before shutdown
      if (this.r2Uploader && this.tradeLogger) {
        const tradeLogDir = this.tradeLogger.getLogPath().replace(/[/\\][^/\\]+$/, '');
        await this.r2Uploader.uploadDayLogs(tradeLogDir, new Date()).catch((err: unknown) => {
          this.logger.warn('R2 shutdown upload failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      this.r2DailyUploadInterval = clearIntervalSafe(this.r2DailyUploadInterval);
      this.r2Uploader = null;

      // O-6: Close persistent trade logger
      if (this.tradeLogger) {
        await this.tradeLogger.close();
        this.tradeLogger = null;
      }

      // T-13: Stop bridge recovery manager
      this.bridgeRecoveryManager = await stopAndNullify(this.bridgeRecoveryManager);

      // Task 4.1: Stop balance monitor
      if (this.balanceMonitor) {
        this.balanceMonitor.stop();
        this.balanceMonitor = null;
      }

      // P0 Refactoring: Stop health monitoring manager
      this.healthMonitoringManager = await stopAndNullify(this.healthMonitoringManager);

      // Stop simulation metrics collector (Phase 1.1.3)
      this.simulationMetricsCollector = await stopAndNullify(this.simulationMetricsCollector);

      // Finding #7: Circuit breaker manager has no async cleanup needed
      this.cbManager = null;

      // Task 3: Stop A/B testing framework
      this.abTestingFramework = await stopAndNullify(this.abTestingFramework);

      // Finding #7: Shutdown pending state via extracted manager
      if (this.pendingStateManager) {
        await this.pendingStateManager.shutdown();
        this.pendingStateManager = null;
      }

      // Fix #51: Stop MEV-Share event listener
      if (this.mevShareListener) {
        await this.mevShareListener.stop();
        this.mevShareListener = null;
      }

      // Stop consumers
      this.fastLaneConsumer = await stopAndNullify(this.fastLaneConsumer);
      this.opportunityConsumer = await stopAndNullify(this.opportunityConsumer);

      // Stop nonce manager
      this.nonceManager = await stopAndNullify(this.nonceManager);

      // Stop provider service (Phase 3: now async for batch provider shutdown)
      if (this.providerService) {
        await this.providerService.clear();
        this.providerService = null;
      }

      // Shutdown lock manager with timeout
      await disconnectWithTimeout(this.lockManager, 'Lock manager', SHUTDOWN_TIMEOUT_MS, this.logger);
      this.lockManager = null;

      // Disconnect streams client with timeout
      await disconnectWithTimeout(this.streamsClient, 'Streams client', SHUTDOWN_TIMEOUT_MS, this.logger);
      this.streamsClient = null;

      // Disconnect Redis with timeout
      await disconnectWithTimeout(this.redis, 'Redis', SHUTDOWN_TIMEOUT_MS, this.logger);
      this.redis = null;

      // Clear queue
      if (this.queueService) {
        this.queueService.clear();
        this.queueService = null;
      }

      // Clear state
      this.gasBaselines.clear();
      // FIX 10.1: Clear pre-computed last gas prices
      this.lastGasPrices.clear();
      // FIX 5: Clear CB re-enqueue tracking
      this.cbReenqueueCounts.clear();
      // FIX P1-13: Invalidate cached strategy context
      this.invalidateStrategyContext();
      this.mevProviderFactory = null;
      await this.bridgeRouterFactory?.dispose();
      this.bridgeRouterFactory = null;
      // Fix 4: Clear strategy references
      this.backrunStrategy = null;
      this.uniswapxStrategy = null;

      // S6: Nullify standby manager
      this.standbyManager = null;

      // Clear risk management components (Phase 3: Task 3.4.5)
      // Note: We don't reset singletons here as they may be shared across tests
      // Reset functions are available for test cleanup
      this.drawdownBreaker = null;
      this.evCalculator = null;
      this.positionSizer = null;
      // P0-4: Call destroy() to persist final batch of outcomes to Redis before clearing.
      // Previously just nullified, losing up to 10 outcomes per shutdown.
      // @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P0-4
      if (this.probabilityTracker) {
        try {
          await this.probabilityTracker.destroy();
        } catch (error) {
          this.logger.warn('Failed to destroy probability tracker on shutdown', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.probabilityTracker = null;
      this.riskManagementEnabled = false;
      this.riskOrchestrator = null;

      // FIX 1.1: Reset initialization module state to allow re-initialization
      resetInitializationState();

      this.logger.info('Execution Engine Service stopped');
    });

    if (!result.success) {
      this.logger.error('Error stopping Execution Engine Service', {
        error: result.error
      });
    }
  }

  /**
   * Clear execution processing interval.
   *
   * P0 Refactoring: Health monitoring intervals now managed by HealthMonitoringManager.
   * Only executionProcessingInterval remains here (hot-path related).
   */
  private clearIntervals(): void {
    this.executionProcessingInterval = clearIntervalSafe(this.executionProcessingInterval);
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  // FIX 1.1/9.3: Removed duplicate initializeMevProviders() - now in initialization module
  // FIX 1.1/9.3: Removed duplicate initializeBridgeRouter() - now in initialization module

  private async initializeStrategies(): Promise<void> {
    // F2: Build flash loan contract addresses and approved routers from config
    // Contract addresses sourced from env vars (FLASH_LOAN_CONTRACT_<CHAIN>)
    // Approved routers sourced from FLASH_LOAN_PROVIDERS.approvedRouters or DEXES config
    const contractAddresses: Record<string, string> = {};
    const approvedRouters: Record<string, string[]> = {};
    // Phase 5: Provider overrides for cheaper flash loan protocols (Balancer V2 at 0% > Aave V3 at 0.09%)
    const providerOverrides: Record<string, { address: string; protocol: string; fee: number }> = {};

    for (const chain of Object.keys(FLASH_LOAN_PROVIDERS)) {
      // Phase 5: Prefer Balancer V2 (0% fee) over default provider when deployed
      const balancerEnvKey = `BALANCER_V2_CONTRACT_${chain.toUpperCase()}`;
      const balancerAddress = process.env[balancerEnvKey];
      const vaultAddress = BALANCER_V2_VAULTS[chain as keyof typeof BALANCER_V2_VAULTS];

      if (balancerAddress && vaultAddress) {
        contractAddresses[chain] = balancerAddress;
        providerOverrides[chain] = {
          address: vaultAddress,
          protocol: 'balancer_v2',
          fee: 0,
        };
        this.logger.info('Preferring Balancer V2 (0% fee) over default provider', {
          chain,
          defaultProtocol: FLASH_LOAN_PROVIDERS[chain].protocol,
          defaultFee: FLASH_LOAN_PROVIDERS[chain].fee,
          contract: balancerAddress,
        });
      } else {
        // Fall back to generic flash loan contract
        const envKey = `FLASH_LOAN_CONTRACT_${chain.toUpperCase()}`;
        const address = process.env[envKey];
        if (address) {
          contractAddresses[chain] = address;
        }
      }

      if (contractAddresses[chain]) {
        // Source approved routers: prefer explicit config, fallback to DEXES router addresses
        const providerConfig = FLASH_LOAN_PROVIDERS[chain];
        if (providerConfig.approvedRouters && providerConfig.approvedRouters.length > 0) {
          approvedRouters[chain] = providerConfig.approvedRouters;
        } else if (DEXES[chain]) {
          approvedRouters[chain] = DEXES[chain]
            .map(dex => dex.routerAddress)
            .filter(Boolean);
        }
      }
    }

    // Create FlashLoanStrategy and FlashLoanProviderFactory if contract addresses are configured
    let flashLoanStrategy: FlashLoanStrategy | undefined;
    let flashLoanProviderFactory: ReturnType<typeof createFlashLoanProviderFactory> | undefined;

    if (Object.keys(contractAddresses).length > 0) {
      try {
        // Build fee overrides from provider overrides (e.g., Balancer V2 at 0%)
        const feeOverrides: Record<string, number> = {};
        for (const [chain, override] of Object.entries(providerOverrides)) {
          feeOverrides[chain] = override.fee;
        }

        flashLoanStrategy = new FlashLoanStrategy(this.logger, {
          contractAddresses,
          approvedRouters,
          feeOverrides: Object.keys(feeOverrides).length > 0 ? feeOverrides : undefined,
          enableAggregator: FEATURE_FLAGS.useFlashLoanAggregator,
        });

        flashLoanProviderFactory = createFlashLoanProviderFactory(this.logger, {
          contractAddresses,
          approvedRouters,
          providerOverrides: Object.keys(providerOverrides).length > 0 ? providerOverrides : undefined,
        });

        this.logger.info('FlashLoanStrategy initialized', {
          chains: Object.keys(contractAddresses),
          aggregatorEnabled: FEATURE_FLAGS.useFlashLoanAggregator,
        });
      } catch (error) {
        this.logger.warn('Failed to initialize FlashLoanStrategy', {
          error: getErrorMessage(error),
        });
      }
    } else {
      this.logger.debug('FlashLoanStrategy not registered - no contract addresses configured');
    }

    // Create strategy instances
    this.intraChainStrategy = new IntraChainStrategy(this.logger);
    this.simulationStrategy = new SimulationStrategy(this.logger, this.simulationConfig);

    // FE-001: Wire flash loan dependencies into CrossChainStrategy when feature flag enabled
    if (FEATURE_FLAGS.useDestChainFlashLoan && flashLoanProviderFactory && flashLoanStrategy) {
      this.crossChainStrategy = new CrossChainStrategy(
        this.logger,
        flashLoanProviderFactory,
        flashLoanStrategy,
      );
      this.logger.info('CrossChainStrategy initialized with destination flash loan support', {
        supportedChains: Object.keys(contractAddresses),
      });
    } else {
      this.crossChainStrategy = new CrossChainStrategy(this.logger);
      if (FEATURE_FLAGS.useDestChainFlashLoan) {
        this.logger.warn('Destination flash loan feature enabled but no flash loan contracts configured');
      }
    }

    // Create strategy factory and register strategies
    this.strategyFactory = createStrategyFactory({
      logger: this.logger,
      isSimulationMode: this.isSimulationMode,
    });

    this.strategyFactory.registerStrategies({
      simulation: this.simulationStrategy,
      crossChain: this.crossChainStrategy,
      intraChain: this.intraChainStrategy,
    });

    // Register FlashLoanStrategy with factory for direct flash loan opportunities
    if (flashLoanStrategy) {
      this.strategyFactory.registerFlashLoanStrategy(flashLoanStrategy);
    }

    // FIX 2: Respect feature flags for strategy registration.
    // Feature flags documentation states: "When disabled: BackrunStrategy is not registered."
    // Previous code always registered regardless of flag, contradicting the flag contract.
    // Fix 9: Wire env var configuration to strategy thresholds.
    // Fix 4: Store references for metrics exposure via health endpoint.
    // Regression guard CAUTION: validate numeric env vars to prevent NaN (which silently disables thresholds).
    const parseNumericEnv = (key: string): number | undefined => {
      const raw = process.env[key];
      if (!raw) return undefined;
      const parsed = Number(raw);
      if (isNaN(parsed)) {
        this.logger.warn(`Invalid numeric env var ${key}='${raw}', ignoring (using default)`);
        return undefined;
      }
      return parsed;
    };
    if (FEATURE_FLAGS.useBackrunStrategy) {
      this.backrunStrategy = new BackrunStrategy(this.logger, {
        minProfitUsd: parseNumericEnv('BACKRUN_MIN_PROFIT_USD'),
        maxGasPriceGwei: parseNumericEnv('BACKRUN_MAX_GAS_PRICE_GWEI'),
      });
      this.strategyFactory.registerBackrunStrategy(this.backrunStrategy);
    }
    if (FEATURE_FLAGS.useUniswapxFiller) {
      this.uniswapxStrategy = new UniswapXFillerStrategy(this.logger, {
        minProfitUsd: parseNumericEnv('UNISWAPX_MIN_PROFIT_USD'),
        maxGasPriceGwei: parseNumericEnv('UNISWAPX_MAX_GAS_PRICE_GWEI'),
      });
      this.strategyFactory.registerUniswapXStrategy(this.uniswapxStrategy);
    }

    // Phase 3 #29: Solana execution via Jupiter/Jito (feature-flagged, dynamic import)
    if (process.env.FEATURE_SOLANA_EXECUTION === 'true') {
      // H7: Validate SOLANA_RPC_URL before proceeding — connection stubs throw at runtime
      if (!process.env.SOLANA_RPC_URL) {
        this.logger.error('FEATURE_SOLANA_EXECUTION is enabled but SOLANA_RPC_URL is not set — skipping Solana strategy registration');
      } else try {
        const { JupiterSwapClient } = await import('./solana/jupiter-client');
        const { SolanaTransactionBuilder } = await import('./solana/transaction-builder');
        const { SolanaExecutionStrategy } = await import('./strategies/solana-execution.strategy');

        const jupiterClient = new JupiterSwapClient({
          apiUrl: process.env.JUPITER_API_URL ?? undefined,
          timeoutMs: parseNumericEnv('JUPITER_TIMEOUT_MS') ?? undefined,
          maxRetries: parseNumericEnv('JUPITER_MAX_RETRIES') ?? undefined,
          defaultSlippageBps: parseNumericEnv('JUPITER_DEFAULT_SLIPPAGE_BPS') ?? undefined,
        });

        // Jito tip accounts from jito-provider defaults
        const { JITO_TIP_ACCOUNTS } = await import('@arbitrage/core/mev-protection/jito-provider');
        const tipAccountsRaw = process.env.JITO_TIP_ACCOUNTS;
        const tipAccounts = tipAccountsRaw
          ? tipAccountsRaw.split(',').map((s: string) => s.trim())
          : JITO_TIP_ACCOUNTS;

        const txBuilder = new SolanaTransactionBuilder({ tipAccounts });

        // Create a minimal Jito provider for strategy use
        // In production, this would use a fully configured JitoProvider
        const { createJitoProvider } = await import('@arbitrage/core/mev-protection/jito-provider');

        // Build a connection interface for the Jito provider.
        // Stubs throw descriptive errors instead of returning empty values
        // to make misconfiguration visible. Configure SOLANA_RPC_URL for production.
        const notConfigured = (method: string) => async () => {
          throw new Error(`Solana connection not configured: ${method}() requires SOLANA_RPC_URL`);
        };
        const jitoProvider = createJitoProvider({
          chain: 'solana',
          connection: {
            getLatestBlockhash: notConfigured('getLatestBlockhash'),
            getSlot: notConfigured('getSlot'),
            getSignatureStatus: notConfigured('getSignatureStatus'),
            getBalance: notConfigured('getBalance'),
            sendRawTransaction: notConfigured('sendRawTransaction'),
          },
          keypair: {
            publicKey: { toBase58: () => process.env.SOLANA_WALLET_PUBLIC_KEY ?? '', toBuffer: () => Buffer.alloc(32) },
            secretKey: new Uint8Array(64),
          },
          enabled: true,
          jitoEndpoint: process.env.JITO_ENDPOINT ?? undefined,
          tipLamports: parseNumericEnv('JITO_TIP_LAMPORTS') ?? undefined,
          tipAccounts,
        });

        // H1: Build confirmation client from Solana RPC for transaction
        // finality polling. Uses direct JSON-RPC calls to avoid importing
        // @solana/web3.js at the engine level.
        const solanaRpcUrl = process.env.SOLANA_RPC_URL!;
        const confirmationClient = {
          async getSignatureStatus(signature: string) {
            const response = await fetch(solanaRpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignatureStatuses',
                params: [[signature]],
              }),
            });
            const data = (await response.json()) as {
              result?: { value?: Array<{ confirmationStatus: string; slot?: number } | null> };
            };
            const statuses = data.result?.value;
            return { value: statuses?.[0] ?? null };
          },
          async getBlockHeight() {
            const response = await fetch(solanaRpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getBlockHeight',
                params: [],
              }),
            });
            const data = (await response.json()) as { result?: number };
            return data.result ?? 0;
          },
        };

        const solanaStrategy = new SolanaExecutionStrategy(
          jupiterClient,
          txBuilder,
          jitoProvider,
          {
            walletPublicKey: process.env.SOLANA_WALLET_PUBLIC_KEY ?? '',
            tipLamports: parseNumericEnv('JITO_TIP_LAMPORTS') ?? 1_000_000,
            maxSlippageBps: parseNumericEnv('SOLANA_MAX_SLIPPAGE_BPS') ?? 100,
            minProfitLamports: BigInt(process.env.SOLANA_MIN_PROFIT_LAMPORTS ?? '100000'),
            maxPriceDeviationPct: parseNumericEnv('SOLANA_MAX_PRICE_DEVIATION_PCT') ?? 1.0,
            confirmationTimeoutMs: parseNumericEnv('SOLANA_CONFIRMATION_TIMEOUT_MS') ?? undefined,
            confirmationPollIntervalMs: parseNumericEnv('SOLANA_CONFIRMATION_POLL_INTERVAL_MS') ?? undefined,
          },
          this.logger,
          confirmationClient,
        );

        this.strategyFactory.registerSolanaStrategy(solanaStrategy);
        this.logger.info('Solana execution strategy registered');
      } catch (error) {
        this.logger.error('Failed to initialize Solana execution strategy', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      this.logger.info('Solana execution disabled (FEATURE_SOLANA_EXECUTION != true)');
    }

    // Phase 3 #31: Statistical arbitrage strategy (feature-flagged, dynamic import)
    if (process.env.FEATURE_STATISTICAL_ARB === 'true') {
      try {
        const { StatisticalArbitrageStrategy } = await import('./strategies/statistical-arbitrage.strategy');
        const statArbStrategy = new StatisticalArbitrageStrategy(
          this.logger,
          {
            minConfidence: parseNumericEnv('STAT_ARB_MIN_CONFIDENCE') ?? 0.5,
            maxOpportunityAgeMs: parseNumericEnv('STAT_ARB_MAX_AGE_MS') ?? 30_000,
            minExpectedProfitUsd: parseNumericEnv('STAT_ARB_MIN_PROFIT_USD') ?? 5,
          },
          flashLoanStrategy ?? undefined,
        );
        this.strategyFactory.registerStatisticalStrategy(statArbStrategy);
        this.logger.info('Statistical arbitrage strategy registered');
      } catch (error) {
        this.logger.error('Failed to initialize statistical arbitrage strategy', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info('Strategy factory initialized', {
      registeredTypes: this.strategyFactory.getRegisteredTypes(),
      simulationMode: this.isSimulationMode,
      destChainFlashLoan: FEATURE_FLAGS.useDestChainFlashLoan,
    });

    // Finding #7: Initialize tx simulation service via extracted function
    if (!this.isSimulationMode && this.providerService) {
      this.txSimulationService = initializeTxSimulationService(this.providerService, this.logger);
    }
  }

  /**
   * Fix #51: Initialize MEV-Share SSE event listener for backrun opportunity ingestion.
   *
   * Collects DEX router addresses from config, creates the listener, subscribes
   * to backrunOpportunity events, and converts them to ArbitrageOpportunity objects
   * that are enqueued into the execution pipeline.
   *
   * @see shared/core/src/mev-protection/mev-share-event-listener.ts
   */
  private async initializeMevShareListener(): Promise<void> {
    // Collect all Ethereum DEX router addresses (MEV-Share is Ethereum-only)
    const ethereumDexes = DEXES['ethereum'] ?? [];
    const dexRouterAddresses = new Set<string>(
      ethereumDexes
        .map(dex => dex.routerAddress.toLowerCase())
        .filter(Boolean)
    );

    if (dexRouterAddresses.size === 0) {
      this.logger.warn('MEV-Share listener: no Ethereum DEX routers configured, skipping');
      return;
    }

    // Dynamic import to avoid pulling the listener into the module graph
    // when the feature flag is disabled
    const { createMevShareEventListener } = await import('@arbitrage/core');

    this.mevShareListener = createMevShareEventListener({
      sseEndpoint: process.env.MEV_SHARE_SSE_ENDPOINT,
      dexRouterAddresses,
      // Cast: engine's Logger type is a subset of core's Logger; the actual value
      // is created via createLogger() which returns the full core Logger.
      logger: this.logger as unknown as CoreLogger,
    });

    // Subscribe to backrun opportunities and convert to ArbitrageOpportunity
    this.mevShareListener.on('backrunOpportunity', (backrun: BackrunOpportunity) => {
      if (!this.queueService || !this.stateManager.isRunning()) {
        return;
      }

      const opportunity: ArbitrageOpportunity = {
        id: `backrun-${backrun.txHash}-${backrun.detectedAt}`,
        type: 'backrun',
        chain: 'ethereum',
        confidence: 0.5, // MEV-Share hints are partial; confidence is moderate
        timestamp: backrun.detectedAt,
        backrunTarget: {
          txHash: backrun.txHash,
          routerAddress: backrun.routerAddress,
          swapDirection: 'buy', // Default; BackrunStrategy will refine from calldata
          source: 'mev-share',
          poolAddress: backrun.pairAddress,
          traceId: backrun.traceId,
        },
      };

      const enqueued = this.queueService.enqueue(opportunity);
      if (enqueued) {
        this.logger.debug('MEV-Share backrun opportunity enqueued', {
          txHash: backrun.txHash,
          router: backrun.routerAddress,
          traceId: backrun.traceId,
        });
      }
    });

    await this.mevShareListener.start();
    this.logger.info('MEV-Share event listener started', {
      routerCount: dexRouterAddresses.size,
      endpoint: process.env.MEV_SHARE_SSE_ENDPOINT ?? 'https://mev-share.flashbots.net',
    });
  }

  // Finding #7: initializeCircuitBreaker, handleCircuitBreakerStateChange,
  // publishCircuitBreakerEvent extracted to CircuitBreakerManager
  // @see services/circuit-breaker-manager.ts

  // FIX 1.1/9.3: Removed duplicate initializeRiskManagement() - now in initialization module

  // Finding #7: initializeTransactionSimulationService extracted to
  // tx-simulation-initializer.ts
  // @see services/tx-simulation-initializer.ts

  // Finding #7: initializePendingStateSimulation, shutdownPendingStateSimulation
  // extracted to PendingStateManager
  // @see services/pending-state-manager.ts

  // ===========================================================================
  // Execution Processing
  // ===========================================================================

  /**
   * Start execution processing with event-driven approach.
   * Uses queue's onItemAvailable callback for immediate processing.
   * Keeps a low-frequency fallback interval (1s) for edge cases.
   */
  private startExecutionProcessing(): void {
    // W1-42 FIX: Create execution pipeline instance
    this.executionPipeline = this.createExecutionPipeline();

    // Event-driven: process immediately when item is enqueued
    if (this.queueService) {
      this.queueService.onItemAvailable(() => {
        this.processQueueItems();
      });
    }

    // Fallback interval (1s) for edge cases and recovery
    // This catches any items that might be missed due to timing
    // FIX Race 1.1: Check stateManager.isRunning() to prevent processing during shutdown
    this.executionProcessingInterval = setInterval(() => {
      if (!this.stateManager.isRunning()) return;

      // Prevent unbounded growth of cbReenqueueCounts. Entries accumulate for
      // opportunities that expire without ever passing the CB check. Clearing
      // is safe — it only resets retry counts, potentially allowing a few
      // extra re-enqueue attempts for in-flight opportunities.
      if (this.cbReenqueueCounts.size > ExecutionEngineService.MAX_CB_REENQUEUE_MAP_SIZE) {
        this.logger.warn('cbReenqueueCounts exceeded size limit, clearing', {
          size: this.cbReenqueueCounts.size,
          limit: ExecutionEngineService.MAX_CB_REENQUEUE_MAP_SIZE,
        });
        this.cbReenqueueCounts.clear();
      }

      this.processQueueItems();
    }, 1000);
  }

  /**
   * W1-42 FIX: Create ExecutionPipeline with all dependencies injected.
   * Called once during startExecutionProcessing().
   */
  private createExecutionPipeline(): ExecutionPipeline {
    if (!this.lockManager) throw new Error('Lock manager not initialized for pipeline');
    if (!this.queueService) throw new Error('Queue service not initialized for pipeline');
    if (!this.opportunityConsumer) throw new Error('Opportunity consumer not initialized for pipeline');
    if (!this.strategyFactory) throw new Error('Strategy factory not initialized for pipeline');

    const deps: PipelineDeps = {
      logger: this.logger,
      perfLogger: this.perfLogger,
      stateManager: this.stateManager,
      stats: this.stats,
      queueService: this.queueService,
      maxConcurrentExecutions: this.maxConcurrentExecutions,
      lockManager: this.lockManager,
      lockConflictTracker: this.lockConflictTracker,
      opportunityConsumer: this.opportunityConsumer,
      strategyFactory: this.strategyFactory,
      cbManager: this.cbManager,
      riskOrchestrator: this.riskOrchestrator,
      abTestingFramework: this.abTestingFramework,
      isSimulationMode: this.isSimulationMode,
      riskManagementEnabled: this.riskManagementEnabled,
      buildStrategyContext: () => this.buildStrategyContext(),
      publishExecutionResult: (result, opp) => this.publishExecutionResult(result, opp),
      getLastGasPrice: (chain) => this.lastGasPrices.get(chain) ?? 0n,
    };

    return new ExecutionPipeline(deps);
  }

  /**
   * Process available queue items up to concurrency limit.
   * Called both by event callback and fallback interval.
   *
   * Uses a processing guard to prevent race conditions from concurrent calls.
   * This ensures activeExecutionCount is accurately tracked.
   *
   * Circuit breaker integration (Phase 1.3.1):
   * - Checks `canExecute()` before processing
   * - Blocks processing when circuit is OPEN
   * - Tracks blocked executions in stats
   */
  private processQueueItems(): void {
    // W1-42 FIX: Delegate to extracted pipeline when available
    if (this.executionPipeline) {
      this.executionPipeline.processQueueItems();
      return;
    }

    // Legacy fallback (during initialization before pipeline is created)
    // Check preconditions: running, queue exists
    if (!this.stateManager.isRunning()) return;
    if (!this.queueService) return;

    // Guard against concurrent entry - prevents race condition where multiple
    // callers could each increment activeExecutionCount past the limit
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      // Process multiple items if under concurrency limit
      while (
        this.queueService.size() > 0 &&
        this.activeExecutionCount < this.maxConcurrentExecutions
      ) {
        // Dequeue first, then check per-chain circuit breaker
        const opportunity = this.queueService.dequeue();
        if (!opportunity) break;

        // Task 1.1: Per-chain circuit breaker check — only blocks the affected chain
        const oppChain = opportunity.buyChain || 'unknown';
        if (this.cbManager && !this.cbManager.canExecute(oppChain)) {
          // FIX 5: Track re-enqueue count to prevent infinite dequeue/re-enqueue loop
          // when circuit breaker is in HALF_OPEN state. Without this limit, the
          // setImmediate in .finally() triggers processQueueItems() again, creating
          // a tight cycle until CB transitions.
          const reenqueueCount = (this.cbReenqueueCounts.get(opportunity.id) ?? 0) + 1;
          if (reenqueueCount >= ExecutionEngineService.MAX_CB_REENQUEUE_ATTEMPTS) {
            // Drop opportunity after max re-enqueue attempts — stream will redeliver
            this.cbReenqueueCounts.delete(opportunity.id);
            this.logger.warn('Dropping opportunity after max CB re-enqueue attempts', {
              opportunityId: opportunity.id,
              attempts: reenqueueCount,
            });
            this.stats.circuitBreakerBlocks++;
          } else {
            // Re-enqueue with tracked count
            this.cbReenqueueCounts.set(opportunity.id, reenqueueCount);
            this.queueService.enqueue(opportunity);
            this.stats.circuitBreakerBlocks++;
          }
          continue;
        }

        // FIX 5: Clear re-enqueue tracking when opportunity proceeds to execution
        this.cbReenqueueCounts.delete(opportunity.id);

        // Fix 5.2: Increment counter before async operation with bounds check
        this.activeExecutionCount++;

        // Execute and decrement counter when done (success or failure)
        // Also trigger another processing cycle to handle queued items
        this.executeOpportunityWithLock(opportunity)
          .catch((error) => {
            // Prevent unhandled promise rejection. The execution result
            // (success/failure) is already tracked inside executeOpportunityWithLock
            // and executeWithTimeout. This catch handles unexpected errors like
            // lock acquisition failures or uncaught throws.
            this.logger.error('Execution failed for opportunity', {
              opportunityId: opportunity.id,
              traceId: (opportunity as unknown as Record<string, unknown>)._traceId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            // Fix 5.2: Ensure counter doesn't go negative (defensive check)
            if (this.activeExecutionCount > 0) {
              this.activeExecutionCount--;
            } else {
              this.logger.warn('activeExecutionCount was already 0, not decrementing');
            }
            // Process more items if available (avoids waiting for next event/interval)
            // Check isProcessingQueue INSIDE setImmediate to prevent race condition
            // where multiple .finally() callbacks could each check the flag before any
            // of them had a chance to set it, resulting in multiple processQueueItems calls
            if (
              this.stateManager.isRunning() &&
              this.queueService &&
              this.queueService.size() > 0
            ) {
              setImmediate(() => {
                // Double-check guard inside callback to prevent concurrent processing
                if (!this.isProcessingQueue) {
                  this.processQueueItems();
                }
              });
            }
          });
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async executeOpportunityWithLock(opportunity: ArbitrageOpportunity): Promise<void> {
    if (!this.lockManager) {
      this.logger.error('Lock manager not initialized');
      return;
    }

    // Extract trace context injected by opportunity consumer for cross-service correlation
    const traceId = (opportunity as unknown as Record<string, unknown>)._traceId as string | undefined;

    const lockResourceId = `opportunity:${opportunity.id}`;

    const lockResult = await this.lockManager.withLock(
      lockResourceId,
      async () => {
        await this.executeWithTimeout(opportunity);
      },
      {
        ttlMs: EXECUTION_TIMEOUT_MS * 2, // 2x execution timeout for safety
        retries: 0
      }
    );

    if (!lockResult.success) {
      if (lockResult.reason === 'lock_not_acquired') {
        // SPRINT 1 FIX: Crash recovery for stuck locks
        // P1 FIX: Use extracted LockConflictTracker for crash detection
        const shouldForceRelease = this.lockConflictTracker.recordConflict(opportunity.id);

        if (shouldForceRelease) {
          // Lock holder appears to have crashed - force release and retry
          this.logger.warn('Detected potential crashed lock holder - force releasing lock', {
            id: opportunity.id,
            traceId,
            conflictCount: this.lockConflictTracker.getConflictInfo(opportunity.id)?.count
          });

          const released = await this.lockManager.forceRelease(lockResourceId);
          if (released) {
            this.stats.staleLockRecoveries++;
            // Clear tracker and retry execution
            this.lockConflictTracker.clear(opportunity.id);

            // Retry with fresh lock acquisition
            const retryResult = await this.lockManager.withLock(
              lockResourceId,
              async () => {
                await this.executeWithTimeout(opportunity);
              },
              {
                ttlMs: EXECUTION_TIMEOUT_MS * 2,
                retries: 0
              }
            );

            if (retryResult.success) {
              // Success after recovery - ACK the message
              await this.opportunityConsumer?.ackMessageAfterExecution(opportunity.id);
              return;
            } else if (retryResult.reason === 'execution_error') {
              // Had lock, execution failed - ACK to prevent infinite redelivery
              this.logger.error('Opportunity execution failed after crash recovery', {
                id: opportunity.id,
                traceId,
                error: retryResult.error
              });
              await this.opportunityConsumer?.ackMessageAfterExecution(opportunity.id);
              return;
            }
            // If retry still can't get lock, another instance recovered faster - fall through
          }
        }

        // Another instance is executing this opportunity - DO NOT ACK
        // Let Redis redeliver to the instance that holds the lock
        this.stats.lockConflicts++;
        this.logger.debug('Opportunity skipped - already being executed by another instance', {
          id: opportunity.id,
          traceId,
        });
        return; // Don't ACK - another instance will handle it
      } else if (lockResult.reason === 'redis_error') {
        // Redis unavailable - can't reliably ACK anyway
        this.logger.error('Opportunity skipped - Redis unavailable', {
          id: opportunity.id,
          traceId,
          error: lockResult.error?.message
        });
        return; // Don't ACK - Redis is down
      } else if (lockResult.reason === 'execution_error') {
        // We had the lock, execution failed - ACK to prevent infinite redelivery
        this.logger.error('Opportunity execution failed', {
          id: opportunity.id,
          traceId,
          error: lockResult.error
        });
        // Fall through to ACK below
      }
    } else {
      // Success - clear any conflict tracking for this opportunity
      this.lockConflictTracker.clear(opportunity.id);
    }

    // ACK the message only after we've processed it (success or execution_error)
    // This ensures messages aren't lost when lock conflicts occur
    await this.opportunityConsumer?.ackMessageAfterExecution(opportunity.id);
  }

  // P1 FIX: Lock conflict tracking methods moved to LockConflictTracker class
  // See: services/lock-conflict-tracker.ts

  private async executeWithTimeout(opportunity: ArbitrageOpportunity): Promise<void> {
    let timeoutId: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Execution timeout after ${EXECUTION_TIMEOUT_MS}ms`));
      }, EXECUTION_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        this.executeOpportunity(opportunity),
        timeoutPromise
      ]);
    } catch (error) {
      if (getErrorMessage(error).includes('timeout')) {
        this.stats.executionTimeouts++;
        this.logger.error('Execution timed out', {
          opportunityId: opportunity.id,
          traceId: (opportunity as unknown as Record<string, unknown>)._traceId,
          timeoutMs: EXECUTION_TIMEOUT_MS
        });
      }
      throw error;
    } finally {
      // Always clear the timeout to prevent timer leaks
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const startTime = performance.now();

    // FIX P0-3: Fail fast on missing buyChain instead of proceeding with 'unknown'
    if (!opportunity.buyChain) {
      const errorResult = createErrorResult(
        opportunity.id,
        'Missing required buyChain field',
        'unknown',
        opportunity.buyDex || 'unknown'
      );
      await this.publishExecutionResult(errorResult, opportunity);
      this.opportunityConsumer?.markComplete(opportunity.id);
      return;
    }

    const chain = opportunity.buyChain || 'unknown';
    const dex = opportunity.buyDex || 'unknown';

    // Variables for risk management
    let evCalc: EVCalculation | null = null;
    let positionSize: PositionSize | null = null;
    let drawdownCheck: TradingAllowedResult | null = null;

    // Task 3: A/B testing variant assignment
    let abVariants: Map<string, VariantAssignment> | null = null;

    try {
      this.opportunityConsumer?.markActive(opportunity.id);
      this.stats.executionAttempts++;
      recordExecutionAttempt(chain, opportunity.type ?? 'unknown');

      this.logger.info('Executing arbitrage opportunity', {
        id: opportunity.id,
        traceId: (opportunity as unknown as Record<string, unknown>)._traceId,
        type: opportunity.type,
        buyChain: chain,
        buyDex: dex,
        sellDex: opportunity.sellDex,
        expectedProfit: opportunity.expectedProfit,
        simulationMode: this.isSimulationMode
      });

      // =======================================================================
      // Phase 3: Capital Risk Management Checks (Task 3.4.5)
      // R2: Refactored to use RiskManagementOrchestrator
      // =======================================================================

      if (this.riskManagementEnabled && !this.isSimulationMode && this.riskOrchestrator) {
        // BUG-005 FIX: Guard against precision loss for gas estimates > Number.MAX_SAFE_INTEGER
        let safeGasEstimate: number | undefined;
        if (opportunity.gasEstimate) {
          const raw = Number(opportunity.gasEstimate);
          safeGasEstimate = Number.isFinite(raw) && raw <= Number.MAX_SAFE_INTEGER ? raw : undefined;
        }

        const riskDecision = this.riskOrchestrator.assess({
          chain,
          dex,
          pathLength: opportunity.path?.length ?? 2,
          expectedProfit: opportunity.expectedProfit,
          gasEstimate: safeGasEstimate,
        });

        // Store results for later use (outcome recording)
        drawdownCheck = riskDecision.drawdownCheck ?? null;
        evCalc = riskDecision.evCalculation ?? null;
        positionSize = riskDecision.positionSize ?? null;

        if (!riskDecision.allowed) {
          // Map rejection code to execution error code
          const errorCode = riskDecision.rejectionCode === 'DRAWDOWN_HALT'
            ? ExecutionErrorCode.DRAWDOWN_HALT
            : riskDecision.rejectionCode === 'LOW_EV'
              ? ExecutionErrorCode.LOW_EV
              : ExecutionErrorCode.POSITION_SIZE;

          // Log with opportunity context
          if (riskDecision.rejectionCode === 'DRAWDOWN_HALT') {
            this.logger.warn('Trade blocked by drawdown circuit breaker', {
              id: opportunity.id,
              state: drawdownCheck?.state,
              reason: riskDecision.rejectionReason,
            });
          } else {
            this.logger.debug(`Trade rejected: ${riskDecision.rejectionReason}`, {
              id: opportunity.id,
              code: riskDecision.rejectionCode,
            });
          }

          const skippedResult = createSkippedResult(
            opportunity.id,
            `${errorCode}: ${riskDecision.rejectionReason}`,
            chain,
            dex
          );
          await this.publishExecutionResult(skippedResult, opportunity);
          return;
        }

        // Log position sizing info for allowed trades
        if (positionSize && riskDecision.recommendedSize) {
          this.logger.debug('Position sized for trade', {
            id: opportunity.id,
            recommendedSize: riskDecision.recommendedSize.toString(),
            fractionOfCapital: positionSize.fractionOfCapital,
            sizeMultiplier: drawdownCheck?.sizeMultiplier ?? 1.0,
          });
        }

        // Log reduced position states
        if (drawdownCheck?.state === 'CAUTION' || drawdownCheck?.state === 'RECOVERY') {
          this.logger.debug(`Trading with reduced position size (${drawdownCheck.state})`, {
            id: opportunity.id,
            sizeMultiplier: drawdownCheck.sizeMultiplier,
          });
        }
      }

      // =======================================================================
      // Task 3: A/B Testing Variant Assignment
      // =======================================================================

      if (this.abTestingFramework) {
        // Use opportunity ID as the hash for deterministic variant assignment
        abVariants = this.abTestingFramework.assignAllVariants(
          opportunity.id,
          chain,
          dex
        );

        if (abVariants.size > 0) {
          this.logger.debug('A/B variant assignments', {
            id: opportunity.id,
            variants: Object.fromEntries(abVariants),
          });
        }
      }

      // =======================================================================
      // Execute Trade
      // =======================================================================

      // Build strategy context
      const ctx = this.buildStrategyContext();

      // Use strategy factory for clean dispatch (replaces if/else chain)
      if (!this.strategyFactory) {
        throw new Error('Strategy factory not initialized');
      }

      const result = await this.strategyFactory.execute(opportunity, ctx);

      // Publish result
      await this.publishExecutionResult(result, opportunity);
      this.perfLogger.logExecutionResult(result);

      // =======================================================================
      // Record Outcome for Risk Management (Task 3.4.5)
      // R2: Refactored to use RiskManagementOrchestrator
      // =======================================================================

      if (this.riskManagementEnabled && !this.isSimulationMode && this.riskOrchestrator) {
        // FIX 10.1: Use pre-computed last gas price for O(1) hot path access
        const currentGasPrice = this.lastGasPrices.get(chain) ?? 0n;

        this.riskOrchestrator.recordOutcome({
          chain,
          dex,
          pathLength: opportunity.path?.length ?? 2,
          success: result.success,
          actualProfit: result.actualProfit,
          gasCost: result.gasCost,
          gasPrice: currentGasPrice,
        });
      }

      // =======================================================================
      // Task 3: Record A/B Testing Results
      // =======================================================================

      const latencyMs = performance.now() - startTime;

      if (this.abTestingFramework && abVariants && abVariants.size > 0) {
        // Record result for each active experiment
        for (const [experimentId, variant] of abVariants) {
          await this.abTestingFramework.recordResult(
            experimentId,
            variant,
            result,
            latencyMs,
            false // MEV frontrun detection - can be enhanced later
          );
        }
      }

      if (result.success) {
        this.stats.successfulExecutions++;
        recordExecutionSuccess(chain, opportunity.type ?? 'unknown');
        // Record volume for successful trades
        if (result.actualProfit !== undefined && result.actualProfit > 0) {
          recordVolume(chain, result.actualProfit);
        }
        // Task 1.1: Record success on chain-specific circuit breaker
        this.cbManager?.recordSuccess(chain);
      } else {
        this.stats.failedExecutions++;
        // Task 1.1: Record failure on chain-specific circuit breaker
        this.cbManager?.recordFailure(chain);
      }

      this.perfLogger.logEventLatency('opportunity_execution', latencyMs, {
        success: result.success,
        profit: result.actualProfit ?? 0
      });

    } catch (error) {
      this.stats.failedExecutions++;
      // Task 1.1: Record failure on chain-specific circuit breaker
      this.cbManager?.recordFailure(chain);

      // Record failure to risk management
      // R2: Use orchestrator when available for consistency
      if (this.riskManagementEnabled && !this.isSimulationMode && this.riskOrchestrator) {
        this.riskOrchestrator.recordOutcome({
          chain,
          dex,
          pathLength: opportunity.path?.length ?? 2,
          success: false,
          actualProfit: undefined,
          gasCost: undefined,
        });
      }

      this.logger.error('Failed to execute opportunity', {
        error,
        opportunityId: opportunity.id
      });

      const errorResult = createErrorResult(
        opportunity.id,
        getErrorMessage(error),
        chain,
        dex
      );

      await this.publishExecutionResult(errorResult, opportunity);
    } finally {
      this.opportunityConsumer?.markComplete(opportunity.id);
    }
  }

  // FIX P1-13: Cached strategy context to avoid allocating a new 15-field object
  // on every executeOpportunity() call. All fields are stable references that only
  // change during start()/stop() or activation events. The cache is invalidated by
  // setting it to null when dependencies change.
  // @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P1 #13
  private cachedStrategyContext: StrategyContext | null = null;

  private buildStrategyContext(): StrategyContext {
    if (this.cachedStrategyContext) {
      return this.cachedStrategyContext;
    }

    this.cachedStrategyContext = {
      logger: this.logger,
      perfLogger: this.perfLogger,
      providers: this.providerService?.getProviders() ?? new Map(),
      wallets: this.providerService?.getWallets() ?? new Map(),
      providerHealth: this.providerService?.getHealthMap() ?? new Map(),
      nonceManager: this.nonceManager,
      mevProviderFactory: this.mevProviderFactory,
      bridgeRouterFactory: this.bridgeRouterFactory,
      stateManager: this.stateManager,
      gasBaselines: this.gasBaselines,
      // FIX 10.1: Pre-computed last gas prices for O(1) hot path access
      lastGasPrices: this.lastGasPrices,
      stats: this.stats,
      simulationService: this.txSimulationService ?? undefined,
      // Finding #7: Pending state simulator via extracted manager
      pendingStateSimulator: this.pendingStateManager?.getSimulator() ?? undefined,
      // Phase 3: Batch providers for RPC request optimization
      batchProviders: this.providerService?.getBatchProviders(),
      // Fix #1: Redis client for bridge recovery state persistence
      redis: this.redis ?? undefined,
    };

    return this.cachedStrategyContext;
  }

  /** Invalidate cached strategy context (call when dependencies change). */
  private invalidateStrategyContext(): void {
    this.cachedStrategyContext = null;
  }

  // ===========================================================================
  // Result Publishing
  // ===========================================================================

  private async publishExecutionResult(result: ExecutionResult, opportunity?: ArbitrageOpportunity): Promise<void> {
    // O-6: Log trade to persistent JSONL file (non-blocking, never throws)
    if (this.tradeLogger) {
      await this.tradeLogger.logTrade(result, opportunity).catch(() => {
        // logTrade already handles errors internally; this catch is defense-in-depth
      });
    }

    if (!this.streamsClient) return;

    try {
      await this.streamsClient.xadd(RedisStreams.EXECUTION_RESULTS, result);
    } catch (error) {
      this.logger.error('Failed to publish execution result', { error });
    }
  }

  // ===========================================================================
  // Health Monitoring
  // P0 Refactoring: Health monitoring logic extracted to HealthMonitoringManager
  // See: services/health-monitoring-manager.ts
  // ===========================================================================

  /**
   * Start simulation metrics collection (Phase 1.1.3)
   *
   * Creates and starts the simulation metrics collector to track:
   * - Simulation success rate
   * - Simulation latency
   * - Transactions skipped due to simulation failure
   */
  private startSimulationMetricsCollection(): void {
    this.simulationMetricsCollector = createSimulationMetricsCollector({
      logger: this.logger,
      perfLogger: this.perfLogger,
      getStats: () => this.stats,
      simulationService: this.txSimulationService,
      stateManager: this.stateManager,
      collectionIntervalMs: 30000, // Collect every 30 seconds
    });

    this.simulationMetricsCollector.start();
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

  getQueueSize(): number {
    return this.queueService?.size() ?? 0;
  }

  isQueuePaused(): boolean {
    return this.queueService?.isPaused() ?? false;
  }

  getStats(): ExecutionStats {
    return { ...this.stats };
  }

  getActiveExecutionsCount(): number {
    return this.opportunityConsumer?.getActiveCount() ?? 0;
  }

  /**
   * W2-18 FIX: Get consumer lag via XPENDING.
   * NOT for hot path — intended for periodic health checks.
   */
  async getConsumerLag(): Promise<{ pendingCount: number; minId: string | null; maxId: string | null }> {
    return this.opportunityConsumer?.getConsumerLag()
      ?? { pendingCount: 0, minId: null, maxId: null };
  }

  getProviderHealth(): Map<string, ProviderHealth> {
    return this.providerService?.getHealthMap() ?? new Map();
  }

  getHealthyProvidersCount(): number {
    return this.providerService?.getHealthyCount() ?? 0;
  }

  getIsSimulationMode(): boolean {
    return this.isSimulationMode;
  }

  /**
   * Fix 4: Get strategy-specific metrics for health endpoint exposure.
   * Returns metrics from backrun and UniswapX strategies if registered.
   */
  getStrategyMetrics(): Record<string, unknown> {
    const metrics: Record<string, unknown> = {};
    if (this.backrunStrategy) {
      metrics.backrun = this.backrunStrategy.getBackrunMetrics();
    }
    if (this.uniswapxStrategy) {
      metrics.uniswapx = this.uniswapxStrategy.getFillerMetrics();
    }
    return metrics;
  }

  /**
   * Check if Redis is connected. Uses a fast ping with cached result
   * to avoid blocking health check responses.
   */
  async isRedisHealthy(): Promise<boolean> {
    if (!this.redis) return false;
    try {
      return await this.redis.ping();
    } catch {
      return false;
    }
  }

  /**
   * P1-6: Get the length of the dead-letter queue stream.
   * Used by health monitoring to alert when failed messages accumulate.
   * @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P1-6
   */
  async getDlqLength(): Promise<number> {
    if (!this.streamsClient) return 0;
    try {
      return await this.streamsClient.xlen(RedisStreams.DEAD_LETTER_QUEUE);
    } catch {
      return 0;
    }
  }

  getSimulationConfig(): Readonly<ResolvedSimulationConfig> {
    return this.simulationConfig;
  }

  /**
   * Get current simulation metrics snapshot (Phase 1.1.3)
   *
   * Returns metrics including:
   * - Simulation success rate
   * - Average latency
   * - Transactions skipped due to simulation failure
   * - Provider health status
   */
  getSimulationMetrics(): SimulationMetricsSnapshot | null {
    return this.simulationMetricsCollector?.getSnapshot() ?? null;
  }

  // ===========================================================================
  // Bridge Recovery Getters (T-13)
  // ===========================================================================

  /**
   * Get bridge recovery metrics snapshot.
   * Returns null if bridge recovery is not initialized.
   */
  getBridgeRecoveryMetrics(): Readonly<RecoveryMetrics> | null {
    return this.bridgeRecoveryManager?.getMetrics() ?? null;
  }

  /**
   * Check if bridge recovery manager is running.
   */
  isBridgeRecoveryRunning(): boolean {
    return this.bridgeRecoveryManager?.getIsRunning() ?? false;
  }

  // ===========================================================================
  // Task 4.1: Balance Monitor Getters
  // ===========================================================================

  /**
   * Get per-chain balance snapshot for health endpoints.
   * Returns null if balance monitor is not initialized.
   */
  getBalanceSnapshot(): BalanceSnapshot | null {
    return this.balanceMonitor?.getSnapshot() ?? null;
  }

  // S6: Standby getters delegated to StandbyManager
  getIsStandby(): boolean {
    return this.standbyManager?.getIsStandby() ?? this.standbyConfig.isStandby;
  }

  getIsActivated(): boolean {
    return this.standbyManager?.getIsActivated() ?? false;
  }

  getStandbyConfig(): Readonly<StandbyConfig> {
    return this.standbyManager?.getStandbyConfig() ?? this.standbyConfig;
  }

  // ===========================================================================
  // Circuit Breaker Getters (Finding #7: delegated to CircuitBreakerManager)
  // ===========================================================================

  /** Get circuit breaker status snapshot. Returns null if disabled. */
  getCircuitBreakerStatus(): CircuitBreakerStatus | null {
    return this.cbManager?.getStatus() ?? null;
  }

  /** Check if circuit breaker is currently open (blocking executions). */
  isCircuitBreakerOpen(): boolean {
    return this.cbManager?.isOpen() ?? false;
  }

  /** Get circuit breaker configuration. */
  getCircuitBreakerConfig(): Readonly<Required<CircuitBreakerConfig>> {
    return this.cbManager?.getConfig() ?? this.circuitBreakerConfig;
  }

  /** Force close the circuit breaker (manual override). */
  forceCloseCircuitBreaker(): void {
    this.cbManager?.forceClose();
  }

  /** Force open the circuit breaker (manual override). */
  forceOpenCircuitBreaker(reason = 'manual override'): void {
    this.cbManager?.forceOpen(reason);
  }

  // ===========================================================================
  // Capital Risk Management Getters (Phase 3: Task 3.4.5)
  // ===========================================================================

  /**
   * Check if capital risk management is enabled and initialized.
   */
  isRiskManagementEnabled(): boolean {
    return this.riskManagementEnabled;
  }

  /**
   * Get drawdown circuit breaker state.
   *
   * Returns null if risk management is disabled.
   */
  getDrawdownState(): Readonly<import('@arbitrage/core').DrawdownState> | null {
    return this.drawdownBreaker?.getState() ?? null;
  }

  /**
   * Get drawdown circuit breaker statistics.
   *
   * Returns null if risk management is disabled.
   */
  getDrawdownStats(): import('@arbitrage/core').DrawdownStats | null {
    return this.drawdownBreaker?.getStats() ?? null;
  }

  /**
   * Check if trading is currently allowed by the drawdown circuit breaker.
   *
   * Returns null if risk management is disabled.
   */
  isTradingAllowed(): TradingAllowedResult | null {
    return this.drawdownBreaker?.isTradingAllowed() ?? null;
  }

  /**
   * Get EV calculator statistics.
   *
   * Returns null if risk management is disabled.
   */
  getEVCalculatorStats(): import('@arbitrage/core').EVCalculatorStats | null {
    return this.evCalculator?.getStats() ?? null;
  }

  /**
   * Get position sizer statistics.
   *
   * Returns null if risk management is disabled.
   */
  getPositionSizerStats(): import('@arbitrage/core').PositionSizerStats | null {
    return this.positionSizer?.getStats() ?? null;
  }

  /**
   * Get execution probability tracker statistics.
   *
   * Returns null if risk management is disabled.
   */
  getProbabilityTrackerStats(): import('@arbitrage/core').ExecutionTrackerStats | null {
    return this.probabilityTracker?.getStats() ?? null;
  }

  /**
   * Force reset the drawdown circuit breaker to NORMAL state.
   * WARNING: This bypasses all safety checks - use with caution.
   */
  forceResetDrawdownBreaker(): void {
    if (this.drawdownBreaker) {
      this.logger.warn('Manually force-resetting drawdown circuit breaker');
      this.drawdownBreaker.forceReset();
    }
  }

  /**
   * Manually reset the drawdown circuit breaker from HALT to RECOVERY.
   * Only works if cooldown period has expired.
   *
   * @returns true if reset was successful, false otherwise
   */
  manualResetDrawdownBreaker(): boolean {
    if (this.drawdownBreaker) {
      return this.drawdownBreaker.manualReset();
    }
    return false;
  }

  /**
   * Update total capital for risk management components.
   * Call this when capital changes (deposits/withdrawals).
   */
  updateRiskCapital(newCapital: bigint): void {
    if (this.drawdownBreaker) {
      this.drawdownBreaker.updateCapital(newCapital);
    }
    if (this.positionSizer) {
      this.positionSizer.updateCapital(newCapital);
    }
    this.logger.info('Risk management capital updated', {
      newCapital: newCapital.toString(),
    });
  }

  // ===========================================================================
  // A/B Testing Getters (Task 3)
  // ===========================================================================

  /**
   * Check if A/B testing is enabled.
   */
  isABTestingEnabled(): boolean {
    return this.abTestingConfig.enabled ?? false;
  }

  /**
   * Get experiment summary with metrics and significance analysis.
   *
   * @param experimentId - The experiment ID
   * @returns Experiment summary or null if not found
   */
  async getExperimentSummary(experimentId: string): Promise<ExperimentSummary | null> {
    return this.abTestingFramework?.getExperimentSummary(experimentId) ?? null;
  }

  /**
   * List all A/B testing experiments.
   *
   * @param status - Optional filter by status
   * @returns List of experiments
   */
  async listExperiments(status?: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled'): Promise<unknown[]> {
    return this.abTestingFramework?.listExperiments(status) ?? [];
  }

  /**
   * Create a new A/B testing experiment.
   *
   * @param params - Experiment parameters
   * @returns Created experiment
   */
  async createExperiment(params: {
    name: string;
    control: string;
    variant: string;
    trafficSplit?: number;
    minSampleSize?: number;
    description?: string;
    chainFilter?: string;
    dexFilter?: string;
    startImmediately?: boolean;
  }): Promise<unknown> {
    if (!this.abTestingFramework) {
      throw new Error('A/B testing framework not initialized');
    }
    return this.abTestingFramework.createExperiment(params);
  }

  /**
   * Update experiment status.
   *
   * @param experimentId - The experiment ID
   * @param status - New status
   */
  async updateExperimentStatus(
    experimentId: string,
    status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled'
  ): Promise<void> {
    if (!this.abTestingFramework) {
      throw new Error('A/B testing framework not initialized');
    }
    return this.abTestingFramework.updateExperimentStatus(experimentId, status);
  }

  // ===========================================================================
  // Standby Activation (ADR-007)
  // S6: Delegated to StandbyManager
  // @see services/standby-manager.ts
  // ===========================================================================

  /**
   * Activate a standby executor to become the active executor.
   * S6: Delegates to StandbyManager.
   *
   * @returns Promise<boolean> - true if activation succeeded
   */
  async activate(): Promise<boolean> {
    if (!this.standbyManager) {
      this.logger.error('Cannot activate - standby manager not initialized');
      return false;
    }
    return this.standbyManager.activate();
  }
}
