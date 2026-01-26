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
  MevGlobalConfig,
  BridgeRouterFactory,
  createBridgeRouterFactory,
  getErrorMessage,
} from '@arbitrage/core';
import { MEV_CONFIG } from '@arbitrage/config';
import type { ArbitrageOpportunity, ServiceHealth } from '@arbitrage/types';

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
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  EXECUTION_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  createInitialStats,
  resolveSimulationConfig,
  DEFAULT_QUEUE_CONFIG,
  createErrorResult,
} from './types';
import { ProviderServiceImpl } from './services/provider.service';
import { QueueServiceImpl } from './services/queue.service';
import { IntraChainStrategy } from './strategies/intra-chain.strategy';
import { CrossChainStrategy } from './strategies/cross-chain.strategy';
import { SimulationStrategy } from './strategies/simulation.strategy';
import { ExecutionStrategyFactory, createStrategyFactory } from './strategies/strategy-factory';
import { OpportunityConsumer } from './consumers/opportunity.consumer';
import type { ISimulationService, ISimulationProvider, SimulationProviderConfig } from './services/simulation/types';
import { SimulationService } from './services/simulation/simulation.service';
import { TenderlyProvider, createTenderlyProvider } from './services/simulation/tenderly-provider';
import { AlchemySimulationProvider, createAlchemyProvider } from './services/simulation/alchemy-provider';
import {
  createSimulationMetricsCollector,
  SimulationMetricsCollector,
  SimulationMetricsSnapshot,
} from './services/simulation/simulation-metrics-collector';
import {
  createCircuitBreaker,
  CircuitBreaker,
  CircuitBreakerEvent,
  CircuitBreakerStatus,
} from './services/circuit-breaker';
// Phase 2 components
import { AnvilForkManager, createAnvilForkManager } from './services/simulation/anvil-manager';
import { PendingStateSimulator, createPendingStateSimulator } from './services/simulation/pending-state-simulator';
import { HotForkSynchronizer, createHotForkSynchronizer } from './services/simulation/hot-fork-synchronizer';

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

  // Execution strategies (using factory pattern for clean dispatch)
  private strategyFactory: ExecutionStrategyFactory | null = null;
  private intraChainStrategy: IntraChainStrategy | null = null;
  private crossChainStrategy: CrossChainStrategy | null = null;
  private simulationStrategy: SimulationStrategy | null = null;

  // Transaction simulation service (Phase 1.1)
  private txSimulationService: ISimulationService | null = null;

  // Simulation metrics collector (Phase 1.1.3)
  private simulationMetricsCollector: SimulationMetricsCollector | null = null;

  // Circuit breaker for execution protection (Phase 1.3.1)
  private circuitBreaker: CircuitBreaker | null = null;

  // Phase 2: Pending state simulation components
  private anvilForkManager: AnvilForkManager | null = null;
  private pendingStateSimulator: PendingStateSimulator | null = null;
  private hotForkSynchronizer: HotForkSynchronizer | null = null;

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
  private isActivated = false; // Track if standby has been activated
  private activationPromise: Promise<boolean> | null = null; // Atomic mutex for activation (ADR-007)
  private isInitializingProviders = false; // Guard against concurrent provider initialization

  // State
  private stats: ExecutionStats;
  private gasBaselines: Map<string, { price: bigint; timestamp: number }[]> = new Map();
  private activeExecutionCount = 0;
  private readonly maxConcurrentExecutions = 5; // Limit parallel executions
  private isProcessingQueue = false; // Guard against concurrent processQueueItems calls

  // Intervals
  private executionProcessingInterval: NodeJS.Timeout | null = null;
  private healthMonitoringInterval: NodeJS.Timeout | null = null;

  constructor(config: ExecutionEngineConfig = {}) {
    // Initialize simulation config
    this.isSimulationMode = config.simulationConfig?.enabled ?? false;
    this.simulationConfig = resolveSimulationConfig(config.simulationConfig);

    // FIX-3.1: Production safety guard for simulation mode
    // Prevents accidental deployment with simulation mode enabled in production
    // which would cause the engine to NOT execute real transactions (capital drain risk)
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && this.isSimulationMode) {
      throw new Error(
        '[CRITICAL] Simulation mode is enabled in production environment. ' +
        'This would prevent real transaction execution. ' +
        'Either set NODE_ENV to a non-production value or disable simulation mode. ' +
        'Set SIMULATION_MODE_PRODUCTION_OVERRIDE=true to explicitly allow (dangerous).'
      );
    }

    // Allow explicit override for production testing scenarios (with extra warning)
    if (isProduction && process.env.SIMULATION_MODE_PRODUCTION_OVERRIDE === 'true') {
      // This is a deliberate override - log prominently but allow
      console.error(
        '\n' +
        '╔══════════════════════════════════════════════════════════════════╗\n' +
        '║  ⚠️  DANGER: SIMULATION MODE OVERRIDE ACTIVE IN PRODUCTION  ⚠️   ║\n' +
        '║                                                                  ║\n' +
        '║  No real transactions will be executed!                          ║\n' +
        '║  Remove SIMULATION_MODE_PRODUCTION_OVERRIDE for live trading.    ║\n' +
        '╚══════════════════════════════════════════════════════════════════╝\n'
      );
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

    // Use injected dependencies or defaults
    this.logger = config.logger ?? createLogger('execution-engine');
    this.perfLogger = config.perfLogger ?? getPerformanceLogger('execution-engine');

    // Generate unique instance ID
    this.instanceId = `execution-engine-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    // State machine for lifecycle management
    this.stateManager = config.stateManager ?? createServiceState({
      serviceName: 'execution-engine',
      transitionTimeoutMs: 30000
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
      this.nonceManager = getNonceManager({
        syncIntervalMs: 30000,
        pendingTimeoutMs: 300000,
        maxPendingPerChain: 10
      });

      // Initialize provider service
      this.providerService = new ProviderServiceImpl({
        logger: this.logger,
        stateManager: this.stateManager,
        nonceManager: this.nonceManager,
        stats: this.stats
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

        // Initialize MEV protection
        this.initializeMevProviders();

        // Initialize bridge router
        this.initializeBridgeRouter();

        // Start nonce manager
        this.nonceManager.start();

        // Validate and start health monitoring
        await this.providerService.validateConnectivity();
        this.providerService.startHealthChecks();
      } else {
        this.logger.info('Skipping blockchain initialization in simulation mode');
      }

      // Initialize execution strategies
      this.initializeStrategies();

      // Initialize Phase 2 pending state simulation (if enabled and not in dev simulation mode)
      if (this.pendingStateConfig.enabled && !this.isSimulationMode) {
        await this.initializePendingStateSimulation();
      }

      // Initialize circuit breaker (Phase 1.3.1)
      this.initializeCircuitBreaker();

      // Initialize opportunity consumer
      this.opportunityConsumer = new OpportunityConsumer({
        logger: this.logger,
        streamsClient: this.streamsClient,
        queueService: this.queueService,
        stats: this.stats,
        instanceId: this.instanceId
      });

      // Create consumer groups and start consuming
      await this.opportunityConsumer.createConsumerGroup();
      this.opportunityConsumer.start();

      // Start execution processing
      this.startExecutionProcessing();

      // Start health monitoring
      this.startHealthMonitoring();

      // Start simulation metrics collector (Phase 1.1.3)
      this.startSimulationMetricsCollection();

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

      // Clear intervals
      this.clearIntervals();

      // Stop simulation metrics collector (Phase 1.1.3)
      if (this.simulationMetricsCollector) {
        this.simulationMetricsCollector.stop();
        this.simulationMetricsCollector = null;
      }

      // Stop circuit breaker (Phase 1.3.1)
      if (this.circuitBreaker) {
        this.circuitBreaker.stop();
        this.circuitBreaker = null;
      }

      // Stop Phase 2 pending state components
      await this.shutdownPendingStateSimulation();

      // Stop consumer
      if (this.opportunityConsumer) {
        await this.opportunityConsumer.stop();
        this.opportunityConsumer = null;
      }

      // Stop nonce manager
      if (this.nonceManager) {
        this.nonceManager.stop();
        this.nonceManager = null;
      }

      // Stop provider service
      if (this.providerService) {
        this.providerService.clear();
        this.providerService = null;
      }

      // Shutdown lock manager with timeout
      if (this.lockManager) {
        try {
          await Promise.race([
            this.lockManager.shutdown(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Lock manager shutdown timeout')), SHUTDOWN_TIMEOUT_MS)
            )
          ]);
        } catch (error) {
          this.logger.warn('Lock manager shutdown timeout or error', { error: getErrorMessage(error) });
        }
        this.lockManager = null;
      }

      // Disconnect streams client with timeout
      if (this.streamsClient) {
        try {
          await Promise.race([
            this.streamsClient.disconnect(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Streams client disconnect timeout')), SHUTDOWN_TIMEOUT_MS)
            )
          ]);
        } catch (error) {
          this.logger.warn('Streams client disconnect timeout or error', { error: getErrorMessage(error) });
        }
        this.streamsClient = null;
      }

      // Disconnect Redis with timeout
      if (this.redis) {
        try {
          await Promise.race([
            this.redis.disconnect(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Redis disconnect timeout')), SHUTDOWN_TIMEOUT_MS)
            )
          ]);
        } catch (error) {
          this.logger.warn('Redis disconnect timeout or error', { error: getErrorMessage(error) });
        }
        this.redis = null;
      }

      // Clear queue
      if (this.queueService) {
        this.queueService.clear();
        this.queueService = null;
      }

      // Clear state
      this.gasBaselines.clear();
      this.mevProviderFactory = null;
      this.bridgeRouterFactory = null;

      this.logger.info('Execution Engine Service stopped');
    });

    if (!result.success) {
      this.logger.error('Error stopping Execution Engine Service', {
        error: result.error
      });
    }
  }

  private clearIntervals(): void {
    if (this.executionProcessingInterval) {
      clearInterval(this.executionProcessingInterval);
      this.executionProcessingInterval = null;
    }
    if (this.healthMonitoringInterval) {
      clearInterval(this.healthMonitoringInterval);
      this.healthMonitoringInterval = null;
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private initializeMevProviders(): void {
    if (!MEV_CONFIG.enabled || !this.providerService) {
      this.logger.info('MEV protection disabled by configuration');
      return;
    }

    const mevGlobalConfig: MevGlobalConfig = {
      enabled: MEV_CONFIG.enabled,
      flashbotsAuthKey: MEV_CONFIG.flashbotsAuthKey,
      bloxrouteAuthHeader: MEV_CONFIG.bloxrouteAuthHeader,
      flashbotsRelayUrl: MEV_CONFIG.flashbotsRelayUrl,
      submissionTimeoutMs: MEV_CONFIG.submissionTimeoutMs,
      maxRetries: MEV_CONFIG.maxRetries,
      fallbackToPublic: MEV_CONFIG.fallbackToPublic,
    };

    this.mevProviderFactory = new MevProviderFactory(mevGlobalConfig);

    let providersInitialized = 0;
    for (const chainName of this.providerService.getWallets().keys()) {
      const provider = this.providerService.getProvider(chainName);
      const wallet = this.providerService.getWallet(chainName);

      if (provider && wallet) {
        const chainSettings = MEV_CONFIG.chainSettings[chainName];
        if (chainSettings?.enabled !== false) {
          try {
            const mevProvider = this.mevProviderFactory.createProvider({
              chain: chainName,
              provider,
              wallet,
            });

            providersInitialized++;
            this.logger.info(`MEV provider initialized for ${chainName}`, {
              strategy: mevProvider.strategy,
              enabled: mevProvider.isEnabled(),
            });
          } catch (error) {
            this.logger.warn(`Failed to initialize MEV provider for ${chainName}`, {
              error: getErrorMessage(error),
            });
          }
        }
      }
    }

    this.logger.info('MEV protection initialization complete', {
      providersInitialized,
      globalEnabled: MEV_CONFIG.enabled,
    });
  }

  private initializeBridgeRouter(): void {
    if (!this.providerService) return;

    try {
      this.bridgeRouterFactory = createBridgeRouterFactory({
        defaultProtocol: 'stargate',
        providers: this.providerService.getProviders(),
      });

      this.logger.info('Bridge router initialized', {
        protocols: this.bridgeRouterFactory.getAvailableProtocols(),
        chainsWithProviders: Array.from(this.providerService.getProviders().keys()),
      });
    } catch (error) {
      this.logger.error('Failed to initialize bridge router', {
        error: getErrorMessage(error),
      });
    }
  }

  private initializeStrategies(): void {
    // Create strategy instances
    this.intraChainStrategy = new IntraChainStrategy(this.logger);
    this.crossChainStrategy = new CrossChainStrategy(this.logger);
    this.simulationStrategy = new SimulationStrategy(this.logger, this.simulationConfig);

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

    this.logger.info('Strategy factory initialized', {
      registeredTypes: this.strategyFactory.getRegisteredTypes(),
      simulationMode: this.isSimulationMode,
    });

    // Initialize transaction simulation service (Phase 1.1) if not in dev simulation mode
    // Note: Actual providers (Tenderly, Alchemy) require API keys from environment
    if (!this.isSimulationMode) {
      this.initializeTransactionSimulationService();
    }
  }

  /**
   * Initialize circuit breaker for execution protection (Phase 1.3.1)
   *
   * Creates a circuit breaker that:
   * - Halts execution after consecutive failures (prevents capital drain)
   * - Emits state change events to Redis Stream for monitoring
   * - Uses configurable threshold and cooldown period
   *
   * @see services/circuit-breaker.ts for implementation details
   */
  private initializeCircuitBreaker(): void {
    if (!this.circuitBreakerConfig.enabled) {
      this.logger.info('Circuit breaker disabled by configuration');
      return;
    }

    this.circuitBreaker = createCircuitBreaker({
      logger: this.logger,
      failureThreshold: this.circuitBreakerConfig.failureThreshold,
      cooldownPeriodMs: this.circuitBreakerConfig.cooldownPeriodMs,
      halfOpenMaxAttempts: this.circuitBreakerConfig.halfOpenMaxAttempts,
      enabled: this.circuitBreakerConfig.enabled,
      onStateChange: (event: CircuitBreakerEvent) => {
        this.handleCircuitBreakerStateChange(event);
      },
    });

    this.logger.info('Circuit breaker initialized', {
      failureThreshold: this.circuitBreakerConfig.failureThreshold,
      cooldownPeriodMs: this.circuitBreakerConfig.cooldownPeriodMs,
      halfOpenMaxAttempts: this.circuitBreakerConfig.halfOpenMaxAttempts,
    });
  }

  /**
   * Handle circuit breaker state change events.
   *
   * Publishes events to Redis Stream for monitoring and alerting.
   * Logs state transitions for operational visibility.
   */
  private handleCircuitBreakerStateChange(event: CircuitBreakerEvent): void {
    // Log state change
    if (event.newState === 'OPEN') {
      this.logger.warn('Circuit breaker OPENED - halting executions', {
        reason: event.reason,
        consecutiveFailures: event.consecutiveFailures,
        cooldownRemainingMs: event.cooldownRemainingMs,
      });
      this.stats.circuitBreakerTrips++;
    } else if (event.newState === 'CLOSED') {
      this.logger.info('Circuit breaker CLOSED - resuming executions', {
        reason: event.reason,
      });
    } else if (event.newState === 'HALF_OPEN') {
      this.logger.info('Circuit breaker HALF_OPEN - testing recovery', {
        reason: event.reason,
      });
    }

    // Publish event to Redis Stream for monitoring
    this.publishCircuitBreakerEvent(event);
  }

  /**
   * Publish circuit breaker event to Redis Stream.
   *
   * Events are published to stream:circuit-breaker for:
   * - Monitoring dashboards
   * - Alerting systems
   * - Audit trail
   */
  private async publishCircuitBreakerEvent(event: CircuitBreakerEvent): Promise<void> {
    if (!this.streamsClient) return;

    try {
      await this.streamsClient.xadd('stream:circuit-breaker', {
        service: 'execution-engine',
        instanceId: this.instanceId,
        previousState: event.previousState,
        newState: event.newState,
        reason: event.reason,
        timestamp: event.timestamp,
        consecutiveFailures: event.consecutiveFailures,
        cooldownRemainingMs: event.cooldownRemainingMs,
      });
    } catch (error) {
      this.logger.error('Failed to publish circuit breaker event', {
        error: getErrorMessage(error),
        event,
      });
    }
  }

  /**
   * Initialize the transaction simulation service (Phase 1.1).
   *
   * Initializes simulation providers from environment variables:
   * - TENDERLY_API_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
   * - ALCHEMY_API_KEY (with chain-specific URLs)
   *
   * @see services/simulation/ for provider implementations.
   */
  private initializeTransactionSimulationService(): void {
    const providers: ISimulationProvider[] = [];
    const configuredChains = Array.from(this.providerService?.getProviders().keys() ?? []);

    // Initialize Tenderly provider if configured
    const tenderlyApiKey = process.env.TENDERLY_API_KEY;
    const tenderlyAccountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
    const tenderlyProjectSlug = process.env.TENDERLY_PROJECT_SLUG;

    if (tenderlyApiKey && tenderlyAccountSlug && tenderlyProjectSlug) {
      try {
        // Create Tenderly provider for each chain
        for (const chain of configuredChains) {
          const provider = this.providerService?.getProvider(chain);
          if (provider) {
            const tenderlyProvider = createTenderlyProvider({
              type: 'tenderly',
              chain,
              provider,
              enabled: true,
              apiKey: tenderlyApiKey,
              accountSlug: tenderlyAccountSlug,
              projectSlug: tenderlyProjectSlug,
            });
            providers.push(tenderlyProvider);
            this.logger.debug('Tenderly provider initialized', { chain });
          }
        }
      } catch (error) {
        this.logger.warn('Failed to initialize Tenderly provider', {
          error: getErrorMessage(error),
        });
      }
    }

    // Initialize Alchemy provider if configured (fallback)
    const alchemyApiKey = process.env.ALCHEMY_API_KEY;
    if (alchemyApiKey && providers.length === 0) {
      try {
        for (const chain of configuredChains) {
          const provider = this.providerService?.getProvider(chain);
          if (provider) {
            const alchemyProvider = createAlchemyProvider({
              type: 'alchemy',
              chain,
              provider,
              enabled: true,
              apiKey: alchemyApiKey,
            });
            providers.push(alchemyProvider);
            this.logger.debug('Alchemy provider initialized', { chain });
          }
        }
      } catch (error) {
        this.logger.warn('Failed to initialize Alchemy provider', {
          error: getErrorMessage(error),
        });
      }
    }

    if (providers.length === 0) {
      this.logger.info('Transaction simulation service not initialized - no providers configured', {
        hint: 'Set TENDERLY_API_KEY/TENDERLY_ACCOUNT_SLUG/TENDERLY_PROJECT_SLUG or ALCHEMY_API_KEY',
      });
      return;
    }

    // Read config from environment with defaults
    const minProfitForSimulation = parseInt(process.env.SIMULATION_MIN_PROFIT || '50', 10);
    const timeCriticalThresholdMs = parseInt(process.env.SIMULATION_TIME_CRITICAL_MS || '2000', 10);

    this.txSimulationService = new SimulationService({
      providers,
      logger: this.logger,
      config: {
        minProfitForSimulation,
        bypassForTimeCritical: true,
        timeCriticalThresholdMs,
        useFallback: true,
      },
    });

    this.logger.info('Transaction simulation service initialized', {
      providerCount: providers.length,
      chains: configuredChains,
      minProfitForSimulation,
      timeCriticalThresholdMs,
    });
  }

  /**
   * Initialize Phase 2 pending state simulation components.
   *
   * Creates and starts:
   * - AnvilForkManager: Local Anvil fork for state simulation
   * - PendingStateSimulator: Simulates pending swaps on the fork
   * - HotForkSynchronizer: Keeps the fork in sync with mainnet
   *
   * @see implementation_plan_v3.md Phase 2
   */
  private async initializePendingStateSimulation(): Promise<void> {
    if (!this.pendingStateConfig.rpcUrl) {
      this.logger.warn('Phase 2 pending state simulation skipped - no RPC URL configured', {
        hint: 'Set pendingStateConfig.rpcUrl to enable pending state simulation',
      });
      return;
    }

    try {
      this.logger.info('Initializing Phase 2 pending state simulation', {
        chain: this.pendingStateConfig.chain,
        anvilPort: this.pendingStateConfig.anvilPort,
        enableHotSync: this.pendingStateConfig.enableHotSync,
        adaptiveSync: this.pendingStateConfig.adaptiveSync,
      });

      // Create Anvil fork manager
      this.anvilForkManager = createAnvilForkManager({
        rpcUrl: this.pendingStateConfig.rpcUrl,
        chain: this.pendingStateConfig.chain ?? 'ethereum',
        port: this.pendingStateConfig.anvilPort,
        autoStart: false, // We'll start manually to handle errors
      });

      // Start the fork if autoStartAnvil is enabled
      if (this.pendingStateConfig.autoStartAnvil) {
        await this.anvilForkManager.startFork();
        this.logger.info('Anvil fork started', {
          port: this.pendingStateConfig.anvilPort,
          state: this.anvilForkManager.getState(),
        });
      }

      // Create pending state simulator
      this.pendingStateSimulator = createPendingStateSimulator({
        anvilManager: this.anvilForkManager,
        timeoutMs: this.pendingStateConfig.simulationTimeoutMs,
      });

      // Create hot fork synchronizer if enabled
      if (this.pendingStateConfig.enableHotSync && this.anvilForkManager.getState() === 'running') {
        const sourceProvider = this.providerService?.getProvider(this.pendingStateConfig.chain ?? 'ethereum');
        if (sourceProvider) {
          this.hotForkSynchronizer = createHotForkSynchronizer({
            anvilManager: this.anvilForkManager,
            sourceProvider,
            syncIntervalMs: this.pendingStateConfig.syncIntervalMs,
            adaptiveSync: this.pendingStateConfig.adaptiveSync,
            minSyncIntervalMs: this.pendingStateConfig.minSyncIntervalMs,
            maxSyncIntervalMs: this.pendingStateConfig.maxSyncIntervalMs,
            maxConsecutiveFailures: this.pendingStateConfig.maxConsecutiveFailures,
            logger: {
              // Use structured component field instead of template literals
              // Template literals are evaluated on every call, creating overhead
              error: (msg, meta) => this.logger.error(msg, { component: 'HotForkSync', ...meta }),
              warn: (msg, meta) => this.logger.warn(msg, { component: 'HotForkSync', ...meta }),
              info: (msg, meta) => this.logger.info(msg, { component: 'HotForkSync', ...meta }),
              debug: (msg, meta) => this.logger.debug(msg, { component: 'HotForkSync', ...meta }),
            },
          });

          await this.hotForkSynchronizer.start();
          this.logger.info('Hot fork synchronizer started', {
            syncIntervalMs: this.pendingStateConfig.syncIntervalMs,
            adaptiveSync: this.pendingStateConfig.adaptiveSync,
            minSyncIntervalMs: this.pendingStateConfig.minSyncIntervalMs,
            maxSyncIntervalMs: this.pendingStateConfig.maxSyncIntervalMs,
          });
        }
      }

      this.logger.info('Phase 2 pending state simulation initialized successfully');

    } catch (error) {
      this.logger.error('Failed to initialize Phase 2 pending state simulation', {
        error: getErrorMessage(error),
      });
      // Clean up partial initialization
      await this.shutdownPendingStateSimulation();
    }
  }

  /**
   * Shutdown Phase 2 pending state simulation components.
   */
  private async shutdownPendingStateSimulation(): Promise<void> {
    // Stop hot fork synchronizer
    if (this.hotForkSynchronizer) {
      try {
        await this.hotForkSynchronizer.stop();
      } catch (error) {
        this.logger.warn('Error stopping hot fork synchronizer', {
          error: getErrorMessage(error),
        });
      }
      this.hotForkSynchronizer = null;
    }

    // Shutdown Anvil fork
    if (this.anvilForkManager) {
      try {
        await this.anvilForkManager.shutdown();
      } catch (error) {
        this.logger.warn('Error shutting down Anvil fork', {
          error: getErrorMessage(error),
        });
      }
      this.anvilForkManager = null;
    }

    // Clear simulator reference
    this.pendingStateSimulator = null;
  }

  // ===========================================================================
  // Execution Processing
  // ===========================================================================

  /**
   * Start execution processing with event-driven approach.
   * Uses queue's onItemAvailable callback for immediate processing.
   * Keeps a low-frequency fallback interval (1s) for edge cases.
   */
  private startExecutionProcessing(): void {
    // Event-driven: process immediately when item is enqueued
    if (this.queueService) {
      this.queueService.onItemAvailable(() => {
        this.processQueueItems();
      });
    }

    // Fallback interval (1s) for edge cases and recovery
    // This catches any items that might be missed due to timing
    this.executionProcessingInterval = setInterval(() => {
      this.processQueueItems();
    }, 1000);
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
        // Fix 5.1: Check circuit breaker state BEFORE dequeue to avoid blocking
        // For OPEN state, we can skip without side effects
        if (this.circuitBreaker) {
          const cbState = this.circuitBreaker.getState();
          if (cbState === 'OPEN') {
            // Circuit is fully open - block all executions
            // NOTE: Per-block debug logging removed - tracked via stats.circuitBreakerBlocks
            if (this.queueService.size() > 0) {
              this.stats.circuitBreakerBlocks++;
            }
            break;
          }
        }

        // Dequeue first, then check if we can actually execute
        const opportunity = this.queueService.dequeue();
        if (!opportunity) break;

        // Fix 5.1: Check canExecute() AFTER successful dequeue to avoid wasting
        // HALF_OPEN attempts on empty queue race conditions
        if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
          // Put the opportunity back at the front of the queue
          // This avoids losing the opportunity when circuit breaker blocks
          // NOTE: Per-block debug logging removed - tracked via stats.circuitBreakerBlocks
          this.queueService.enqueue(opportunity);
          this.stats.circuitBreakerBlocks++;
          break;
        }

        // Fix 5.2: Increment counter before async operation with bounds check
        this.activeExecutionCount++;

        // Execute and decrement counter when done (success or failure)
        // Also trigger another processing cycle to handle queued items
        this.executeOpportunityWithLock(opportunity)
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

    const lockResult = await this.lockManager.withLock(
      `opportunity:${opportunity.id}`,
      async () => {
        await this.executeWithTimeout(opportunity);
      },
      {
        ttlMs: 120000, // 2x execution timeout for safety
        retries: 0
      }
    );

    if (!lockResult.success) {
      if (lockResult.reason === 'lock_not_acquired') {
        // Another instance is executing this opportunity - DO NOT ACK
        // Let Redis redeliver to the instance that holds the lock
        this.stats.lockConflicts++;
        this.logger.debug('Opportunity skipped - already being executed by another instance', {
          id: opportunity.id
        });
        return; // Don't ACK - another instance will handle it
      } else if (lockResult.reason === 'redis_error') {
        // Redis unavailable - can't reliably ACK anyway
        this.logger.error('Opportunity skipped - Redis unavailable', {
          id: opportunity.id,
          error: lockResult.error?.message
        });
        return; // Don't ACK - Redis is down
      } else if (lockResult.reason === 'execution_error') {
        // We had the lock, execution failed - ACK to prevent infinite redelivery
        this.logger.error('Opportunity execution failed', {
          id: opportunity.id,
          error: lockResult.error
        });
        // Fall through to ACK below
      }
    }

    // ACK the message only after we've processed it (success or execution_error)
    // This ensures messages aren't lost when lock conflicts occur
    await this.opportunityConsumer?.ackMessageAfterExecution(opportunity.id);
  }

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

    try {
      this.opportunityConsumer?.markActive(opportunity.id);
      this.stats.executionAttempts++;

      this.logger.info('Executing arbitrage opportunity', {
        id: opportunity.id,
        type: opportunity.type,
        buyChain: opportunity.buyChain,
        buyDex: opportunity.buyDex,
        sellDex: opportunity.sellDex,
        expectedProfit: opportunity.expectedProfit,
        simulationMode: this.isSimulationMode
      });

      // Build strategy context
      const ctx = this.buildStrategyContext();

      // Use strategy factory for clean dispatch (replaces if/else chain)
      if (!this.strategyFactory) {
        throw new Error('Strategy factory not initialized');
      }

      const result = await this.strategyFactory.execute(opportunity, ctx);

      // Publish result
      await this.publishExecutionResult(result);
      this.perfLogger.logExecutionResult(result);

      if (result.success) {
        this.stats.successfulExecutions++;
        // Record success with circuit breaker (resets consecutive failures)
        this.circuitBreaker?.recordSuccess();
      } else {
        this.stats.failedExecutions++;
        // Record failure with circuit breaker (may trip circuit)
        this.circuitBreaker?.recordFailure();
      }

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('opportunity_execution', latency, {
        success: result.success,
        profit: result.actualProfit ?? 0
      });

    } catch (error) {
      this.stats.failedExecutions++;
      // Record failure with circuit breaker (may trip circuit)
      this.circuitBreaker?.recordFailure();

      this.logger.error('Failed to execute opportunity', {
        error,
        opportunityId: opportunity.id
      });

      const errorResult = createErrorResult(
        opportunity.id,
        getErrorMessage(error),
        opportunity.buyChain || 'unknown',
        opportunity.buyDex || 'unknown'
      );

      await this.publishExecutionResult(errorResult);
    } finally {
      this.opportunityConsumer?.markComplete(opportunity.id);
    }
  }

  private buildStrategyContext(): StrategyContext {
    return {
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
      stats: this.stats,
      simulationService: this.txSimulationService ?? undefined,
      // Phase 2: Pending state simulator for mempool-aware execution
      pendingStateSimulator: this.pendingStateSimulator ?? undefined,
    };
  }

  // ===========================================================================
  // Result Publishing
  // ===========================================================================

  private async publishExecutionResult(result: ExecutionResult): Promise<void> {
    if (!this.streamsClient) return;

    try {
      await this.streamsClient.xadd('stream:execution-results', result);
    } catch (error) {
      this.logger.error('Failed to publish execution result', { error });
    }
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  private startHealthMonitoring(): void {
    this.healthMonitoringInterval = setInterval(async () => {
      try {
        // Fix 4.2: Cleanup old gas baseline entries to prevent memory leak
        this.cleanupGasBaselines();

        const health: ServiceHealth = {
          name: 'execution-engine',
          status: this.stateManager.isRunning() ? 'healthy' : 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now(),
          error: undefined
        };

        // Get simulation metrics snapshot (Phase 1.1.3)
        const simulationMetrics = this.simulationMetricsCollector?.getSnapshot();

        if (this.streamsClient) {
          await this.streamsClient.xadd(
            RedisStreamsClient.STREAMS.HEALTH,
            {
              ...health,
              queueSize: this.queueService?.size() ?? 0,
              queuePaused: this.queueService?.isPaused() ?? false,
              activeExecutions: this.opportunityConsumer?.getActiveCount() ?? 0,
              stats: this.stats,
              // Include simulation metrics (Phase 1.1.3)
              simulationMetrics: simulationMetrics ?? null,
            }
          );
        }

        if (this.redis) {
          await this.redis.updateServiceHealth('execution-engine', health);
        }

        this.perfLogger.logHealthCheck('execution-engine', health);
      } catch (error) {
        this.logger.error('Execution engine health monitoring failed', { error });
      }
    }, 30000);
  }

  /**
   * Cleanup old gas baseline entries to prevent memory leak.
   * Fix 4.2: Removes entries older than 5 minutes and limits to 100 entries per chain.
   */
  private cleanupGasBaselines(): void {
    const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
    const MAX_ENTRIES_PER_CHAIN = 100;
    const now = Date.now();

    for (const [chain, history] of this.gasBaselines) {
      if (history.length === 0) continue;

      // Filter out entries older than MAX_AGE_MS
      const validEntries = history.filter(entry => (now - entry.timestamp) < MAX_AGE_MS);

      // Also limit to MAX_ENTRIES_PER_CHAIN (keep most recent)
      const trimmedEntries = validEntries.length > MAX_ENTRIES_PER_CHAIN
        ? validEntries.slice(-MAX_ENTRIES_PER_CHAIN)
        : validEntries;

      // Update in place to preserve references (strategies may hold reference to array)
      history.length = 0;
      history.push(...trimmedEntries);
    }
  }

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

  getProviderHealth(): Map<string, ProviderHealth> {
    return this.providerService?.getHealthMap() ?? new Map();
  }

  getHealthyProvidersCount(): number {
    return this.providerService?.getHealthyCount() ?? 0;
  }

  getIsSimulationMode(): boolean {
    return this.isSimulationMode;
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

  getIsStandby(): boolean {
    return this.standbyConfig.isStandby;
  }

  getIsActivated(): boolean {
    return this.isActivated;
  }

  getStandbyConfig(): Readonly<StandbyConfig> {
    return this.standbyConfig;
  }

  // ===========================================================================
  // Circuit Breaker Getters (Phase 1.3.1)
  // ===========================================================================

  /**
   * Get circuit breaker status snapshot.
   *
   * Returns null if circuit breaker is disabled.
   */
  getCircuitBreakerStatus(): CircuitBreakerStatus | null {
    return this.circuitBreaker?.getStatus() ?? null;
  }

  /**
   * Check if circuit breaker is currently open (blocking executions).
   */
  isCircuitBreakerOpen(): boolean {
    return this.circuitBreaker?.isOpen() ?? false;
  }

  /**
   * Get circuit breaker configuration.
   */
  getCircuitBreakerConfig(): Readonly<Required<CircuitBreakerConfig>> {
    return this.circuitBreakerConfig;
  }

  /**
   * Force close the circuit breaker (manual override).
   *
   * Use with caution - this bypasses the protection mechanism.
   */
  forceCloseCircuitBreaker(): void {
    if (this.circuitBreaker) {
      this.logger.warn('Manually force-closing circuit breaker');
      this.circuitBreaker.forceClose();
    }
  }

  /**
   * Force open the circuit breaker (manual override).
   *
   * Useful for emergency stops or maintenance.
   */
  forceOpenCircuitBreaker(reason = 'manual override'): void {
    if (this.circuitBreaker) {
      this.logger.warn('Manually force-opening circuit breaker', { reason });
      this.circuitBreaker.forceOpen(reason);
    }
  }

  // ===========================================================================
  // Standby Activation (ADR-007)
  // ===========================================================================

  /**
   * Activate a standby executor to become the active executor.
   * This is called when the primary executor fails and this standby takes over.
   *
   * Activation:
   * 1. Disables simulation mode (if configured)
   * 2. Resumes the paused queue
   * 3. Initializes real blockchain providers if not already done
   *
   * Uses Promise-based mutex to prevent race conditions in concurrent activation.
   *
   * @returns Promise<boolean> - true if activation succeeded
   */
  async activate(): Promise<boolean> {
    // Check if already activated
    if (this.isActivated) {
      this.logger.warn('Executor already activated, skipping');
      return true;
    }

    // Atomic mutex: if activation is in progress, wait for it to complete
    // This prevents race conditions where two callers could both pass the check
    if (this.activationPromise) {
      this.logger.warn('Activation already in progress, waiting for completion');
      return this.activationPromise;
    }

    if (!this.stateManager.isRunning()) {
      this.logger.error('Cannot activate - executor not running');
      return false;
    }

    // Create the activation promise atomically - this is the mutex
    // FIX-5.2: The promise-based mutex pattern ensures:
    // 1. Only one activation runs at a time
    // 2. Concurrent callers wait for the same result
    // 3. The mutex is always cleared (via finally) even on error
    this.activationPromise = this.performActivation();

    try {
      return await this.activationPromise;
    } catch (error) {
      // FIX-5.2: Defensive error handling - performActivation catches internally,
      // but if an unexpected error escapes (e.g., from logger), log and return false
      this.logger.error('Unexpected error during activation', {
        error: getErrorMessage(error)
      });
      return false;
    } finally {
      // FIX-5.2: Clear the mutex after activation completes (success or failure)
      // This is critical - without this, failed activations would block all future attempts
      this.activationPromise = null;
    }
  }

  /**
   * Internal activation logic, separated for mutex pattern.
   */
  private async performActivation(): Promise<boolean> {
    this.logger.warn('ACTIVATING STANDBY EXECUTOR', {
      previousSimulationMode: this.isSimulationMode,
      queuePaused: this.queueService?.isPaused() ?? false,
      regionId: this.standbyConfig.regionId
    });

    try {
      // Step 1: Disable simulation mode if configured
      if (this.standbyConfig.activationDisablesSimulation && this.isSimulationMode) {
        this.isSimulationMode = false;
        // Sync strategy factory with new simulation mode state
        this.strategyFactory?.setSimulationMode(false);
        this.logger.warn('SIMULATION MODE DISABLED - Real transactions will now execute');

        // Initialize real blockchain providers if not already done
        // Guard against concurrent initialization (race condition prevention)
        if (this.providerService && !this.providerService.getHealthyCount() && !this.isInitializingProviders) {
          this.isInitializingProviders = true;
          try {
            this.logger.info('Initializing blockchain providers for real execution');
            await this.providerService.initialize();
            this.providerService.initializeWallets();

            // Initialize MEV protection
            this.initializeMevProviders();

            // Initialize bridge router
            this.initializeBridgeRouter();

            // Start nonce manager
            if (this.nonceManager) {
              this.nonceManager.start();
            }

            // Validate and start health monitoring
            await this.providerService.validateConnectivity();
            this.providerService.startHealthChecks();
          } finally {
            this.isInitializingProviders = false;
          }
        }
      }

      // Step 2: Resume the queue
      if (this.queueService?.isManuallyPaused()) {
        this.queueService.resume();
        this.logger.info('Queue resumed - now processing opportunities');
      }

      // Mark as activated
      this.isActivated = true;

      this.logger.warn('STANDBY EXECUTOR ACTIVATED SUCCESSFULLY', {
        simulationMode: this.isSimulationMode,
        queuePaused: this.queueService?.isPaused() ?? false,
        healthyProviders: this.providerService?.getHealthyCount() ?? 0
      });

      // Publish activation event to stream
      if (this.streamsClient) {
        await this.streamsClient.xadd(RedisStreamsClient.STREAMS.HEALTH, {
          name: 'execution-engine',
          service: 'execution-engine',
          status: 'healthy',
          event: 'standby_activated',
          regionId: this.standbyConfig.regionId,
          simulationMode: this.isSimulationMode,
          timestamp: Date.now()
        });
      }

      return true;

    } catch (error) {
      this.logger.error('Failed to activate standby executor', {
        error: getErrorMessage(error)
      });
      return false;
    }
  }
}
