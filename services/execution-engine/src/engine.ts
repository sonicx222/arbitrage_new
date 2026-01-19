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
  EXECUTION_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  createInitialStats,
  resolveSimulationConfig,
  DEFAULT_QUEUE_CONFIG,
} from './types';
import { ProviderServiceImpl } from './services/provider.service';
import { QueueServiceImpl } from './services/queue.service';
import { IntraChainStrategy } from './strategies/intra-chain.strategy';
import { CrossChainStrategy } from './strategies/cross-chain.strategy';
import { SimulationStrategy } from './strategies/simulation.strategy';
import { OpportunityConsumer } from './consumers/opportunity.consumer';

// Re-export types for consumers
export type {
  ExecutionEngineConfig,
  ExecutionStats,
  ExecutionResult,
  SimulationConfig,
  QueueConfig,
  ProviderHealth,
};

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

  // Execution strategies
  private intraChainStrategy: IntraChainStrategy | null = null;
  private crossChainStrategy: CrossChainStrategy | null = null;
  private simulationStrategy: SimulationStrategy | null = null;

  // Infrastructure
  private readonly logger: Logger;
  private readonly perfLogger: PerformanceLogger;
  private readonly stateManager: ServiceStateManager;
  private readonly instanceId: string;

  // Configuration
  private readonly simulationConfig: ResolvedSimulationConfig;
  private readonly isSimulationMode: boolean;
  private readonly queueConfig: QueueConfig;

  // State
  private stats: ExecutionStats;
  private gasBaselines: Map<string, { price: bigint; timestamp: number }[]> = new Map();
  private activeExecutionCount = 0;
  private readonly maxConcurrentExecutions = 5; // Limit parallel executions

  // Intervals
  private executionProcessingInterval: NodeJS.Timeout | null = null;
  private healthMonitoringInterval: NodeJS.Timeout | null = null;

  constructor(config: ExecutionEngineConfig = {}) {
    // Initialize simulation config
    this.isSimulationMode = config.simulationConfig?.enabled ?? false;
    this.simulationConfig = resolveSimulationConfig(config.simulationConfig);

    // Initialize queue config
    this.queueConfig = {
      ...DEFAULT_QUEUE_CONFIG,
      ...config.queueConfig
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

      // Initialize queue service
      this.queueService = new QueueServiceImpl({
        logger: this.logger,
        queueConfig: this.queueConfig
      });

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
    this.intraChainStrategy = new IntraChainStrategy(this.logger);
    this.crossChainStrategy = new CrossChainStrategy(this.logger);
    this.simulationStrategy = new SimulationStrategy(this.logger, this.simulationConfig);
  }

  // ===========================================================================
  // Execution Processing
  // ===========================================================================

  private startExecutionProcessing(): void {
    this.executionProcessingInterval = setInterval(() => {
      // Check preconditions: running, queue exists, items available, under concurrency limit
      if (!this.stateManager.isRunning()) return;
      if (!this.queueService || this.queueService.size() === 0) return;
      if (this.activeExecutionCount >= this.maxConcurrentExecutions) return;

      const opportunity = this.queueService.dequeue();
      if (opportunity) {
        // Increment counter before async operation
        this.activeExecutionCount++;

        // Execute and decrement counter when done (success or failure)
        this.executeOpportunityWithLock(opportunity)
          .finally(() => {
            this.activeExecutionCount--;
          });
      }
    }, 50);
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

    // ACK the message after execution
    await this.opportunityConsumer?.ackMessageAfterExecution(opportunity.id);

    if (!lockResult.success) {
      if (lockResult.reason === 'lock_not_acquired') {
        this.stats.lockConflicts++;
        this.logger.debug('Opportunity skipped - already being executed by another instance', {
          id: opportunity.id
        });
      } else if (lockResult.reason === 'redis_error') {
        this.logger.error('Opportunity skipped - Redis unavailable', {
          id: opportunity.id,
          error: lockResult.error?.message
        });
      } else if (lockResult.reason === 'execution_error') {
        this.logger.error('Opportunity execution failed', {
          id: opportunity.id,
          error: lockResult.error
        });
      }
    }
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
      this.stats.opportunitiesExecuted++;

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

      let result: ExecutionResult;

      // Select and execute strategy
      if (this.isSimulationMode && this.simulationStrategy) {
        result = await this.simulationStrategy.execute(opportunity, ctx);
      } else if (opportunity.type === 'cross-chain' && this.crossChainStrategy) {
        result = await this.crossChainStrategy.execute(opportunity, ctx);
      } else if (this.intraChainStrategy) {
        result = await this.intraChainStrategy.execute(opportunity, ctx);
      } else {
        throw new Error('No execution strategy available');
      }

      // Publish result
      await this.publishExecutionResult(result);
      this.perfLogger.logExecutionResult(result);

      if (result.success) {
        this.stats.successfulExecutions++;
      } else {
        this.stats.failedExecutions++;
      }

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('opportunity_execution', latency, {
        success: result.success,
        profit: result.actualProfit ?? 0
      });

    } catch (error) {
      this.stats.failedExecutions++;
      this.logger.error('Failed to execute opportunity', {
        error,
        opportunityId: opportunity.id
      });

      const errorResult: ExecutionResult = {
        opportunityId: opportunity.id,
        success: false,
        error: getErrorMessage(error),
        timestamp: Date.now(),
        chain: opportunity.buyChain || 'unknown',
        dex: opportunity.buyDex || 'unknown'
      };

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
        const health: ServiceHealth = {
          name: 'execution-engine',
          status: this.stateManager.isRunning() ? 'healthy' : 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now(),
          error: undefined
        };

        if (this.streamsClient) {
          await this.streamsClient.xadd(
            RedisStreamsClient.STREAMS.HEALTH,
            {
              ...health,
              queueSize: this.queueService?.size() ?? 0,
              queuePaused: this.queueService?.isPaused() ?? false,
              activeExecutions: this.opportunityConsumer?.getActiveCount() ?? 0,
              stats: this.stats
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
}
