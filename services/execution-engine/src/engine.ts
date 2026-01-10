/**
 * Arbitrage Execution Engine with MEV Protection
 *
 * Executes arbitrage opportunities detected by the system.
 * Uses distributed locking to prevent duplicate executions.
 *
 * Fixes applied:
 * - Redis Streams for event consumption (ADR-002 compliant)
 * - DistributedLockManager for atomic execution locking
 * - ServiceStateManager for lifecycle management
 * - Queue size limits with backpressure
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Failover Strategy
 */

import { ethers } from 'ethers';
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
  DistributedLockManager,
  getDistributedLockManager
} from '../../../shared/core/src';
import { CHAINS, ARBITRAGE_CONFIG } from '../../../shared/config/src';
import {
  ArbitrageOpportunity,
  ServiceHealth
} from '../../../shared/types/src';

// =============================================================================
// Types
// =============================================================================

interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  transactionHash?: string;
  actualProfit?: number;
  gasUsed?: number;
  gasCost?: number;
  error?: string;
  timestamp: number;
  chain: string;
  dex: string;
}

interface FlashLoanParams {
  token: string;
  amount: string;
  path: string[];
  minProfit: number;
}

interface QueueConfig {
  maxSize: number;        // Maximum queue size
  highWaterMark: number;  // Start rejecting at this level
  lowWaterMark: number;   // Resume accepting at this level
}

interface ExecutionStats {
  opportunitiesReceived: number;
  opportunitiesExecuted: number;
  opportunitiesRejected: number;
  successfulExecutions: number;
  failedExecutions: number;
  queueRejects: number;
  lockConflicts: number;
}

// =============================================================================
// Execution Engine Service
// =============================================================================

export class ExecutionEngineService {
  private redis: RedisClient | null = null;
  private streamsClient: RedisStreamsClient | null = null;
  private lockManager: DistributedLockManager | null = null;
  private logger = createLogger('execution-engine');
  private perfLogger: PerformanceLogger;
  private stateManager: ServiceStateManager;

  private wallets: Map<string, ethers.Wallet> = new Map();
  private providers: Map<string, ethers.JsonRpcProvider> = new Map();
  private executionQueue: ArbitrageOpportunity[] = [];
  private activeExecutions: Set<string> = new Set();

  // Consumer group configuration
  private readonly consumerGroups: ConsumerGroupConfig[];
  private readonly instanceId: string;

  // Queue configuration with backpressure
  private readonly queueConfig: QueueConfig = {
    maxSize: 1000,
    highWaterMark: 800,
    lowWaterMark: 200
  };
  private queuePaused = false;

  // Statistics
  private stats: ExecutionStats = {
    opportunitiesReceived: 0,
    opportunitiesExecuted: 0,
    opportunitiesRejected: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    queueRejects: 0,
    lockConflicts: 0
  };

  // Intervals
  private executionProcessingInterval: NodeJS.Timeout | null = null;
  private healthMonitoringInterval: NodeJS.Timeout | null = null;
  private streamConsumerInterval: NodeJS.Timeout | null = null;

  constructor(queueConfig?: Partial<QueueConfig>) {
    this.perfLogger = getPerformanceLogger('execution-engine');

    // Apply custom queue config
    if (queueConfig) {
      this.queueConfig = { ...this.queueConfig, ...queueConfig };
    }

    // Generate unique instance ID
    this.instanceId = `execution-engine-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    // State machine for lifecycle management
    this.stateManager = createServiceState({
      serviceName: 'execution-engine',
      transitionTimeoutMs: 30000
    });

    // Define consumer groups for streams
    this.consumerGroups = [
      {
        streamName: RedisStreamsClient.STREAMS.OPPORTUNITIES,
        groupName: 'execution-engine-group',
        consumerName: this.instanceId,
        startId: '$'
      }
    ];
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(): Promise<void> {
    const result = await this.stateManager.executeStart(async () => {
      this.logger.info('Starting Execution Engine Service', {
        instanceId: this.instanceId,
        queueConfig: this.queueConfig
      });

      // Initialize Redis clients
      this.redis = await getRedisClient();
      this.streamsClient = await getRedisStreamsClient();

      // Initialize distributed lock manager
      this.lockManager = await getDistributedLockManager({
        keyPrefix: 'lock:execution:',
        defaultTtlMs: 60000 // 60 second lock TTL
      });

      // Initialize blockchain providers and wallets
      this.initializeProviders();
      this.initializeWallets();

      // Create consumer groups for Redis Streams
      await this.createConsumerGroups();

      // Start stream consumers
      this.startStreamConsumers();

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

      // Clear all intervals
      this.clearAllIntervals();

      // Shutdown lock manager
      if (this.lockManager) {
        await this.lockManager.shutdown();
        this.lockManager = null;
      }

      // Disconnect streams client
      if (this.streamsClient) {
        await this.streamsClient.disconnect();
        this.streamsClient = null;
      }

      // Disconnect Redis
      if (this.redis) {
        await this.redis.disconnect();
        this.redis = null;
      }

      // Clear state
      this.executionQueue = [];
      this.activeExecutions.clear();
      this.wallets.clear();
      this.providers.clear();

      this.logger.info('Execution Engine Service stopped');
    });

    if (!result.success) {
      this.logger.error('Error stopping Execution Engine Service', {
        error: result.error
      });
    }
  }

  private clearAllIntervals(): void {
    if (this.executionProcessingInterval) {
      clearInterval(this.executionProcessingInterval);
      this.executionProcessingInterval = null;
    }
    if (this.healthMonitoringInterval) {
      clearInterval(this.healthMonitoringInterval);
      this.healthMonitoringInterval = null;
    }
    if (this.streamConsumerInterval) {
      clearInterval(this.streamConsumerInterval);
      this.streamConsumerInterval = null;
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private initializeProviders(): void {
    for (const [chainName, chainConfig] of Object.entries(CHAINS)) {
      try {
        this.providers.set(chainName, new ethers.JsonRpcProvider(chainConfig.rpcUrl));
      } catch (error) {
        this.logger.warn(`Failed to initialize provider for ${chainName}`, { error });
      }
    }
    this.logger.info('Initialized blockchain providers', {
      count: this.providers.size
    });
  }

  private initializeWallets(): void {
    for (const chainName of Object.keys(CHAINS)) {
      const privateKey = process.env[`${chainName.toUpperCase()}_PRIVATE_KEY`];

      // Skip if no private key configured
      if (!privateKey) {
        this.logger.debug(`No private key configured for ${chainName}`);
        continue;
      }

      const provider = this.providers.get(chainName);
      if (provider) {
        try {
          const wallet = new ethers.Wallet(privateKey, provider);
          this.wallets.set(chainName, wallet);
          this.logger.info(`Initialized wallet for ${chainName}`, {
            address: wallet.address
          });
        } catch (error) {
          this.logger.error(`Failed to initialize wallet for ${chainName}`, { error });
        }
      }
    }
  }

  // ===========================================================================
  // Redis Streams (ADR-002 Compliant)
  // ===========================================================================

  private async createConsumerGroups(): Promise<void> {
    if (!this.streamsClient) return;

    for (const config of this.consumerGroups) {
      try {
        await this.streamsClient.createConsumerGroup(config);
        this.logger.info('Consumer group ready', {
          stream: config.streamName,
          group: config.groupName
        });
      } catch (error) {
        this.logger.error('Failed to create consumer group', {
          error,
          stream: config.streamName
        });
      }
    }
  }

  private startStreamConsumers(): void {
    // Poll streams every 50ms for low latency
    this.streamConsumerInterval = setInterval(async () => {
      if (!this.stateManager.isRunning() || !this.streamsClient) return;

      try {
        await this.consumeOpportunitiesStream();
      } catch (error) {
        this.logger.error('Stream consumer error', { error });
      }
    }, 50);
  }

  private async consumeOpportunitiesStream(): Promise<void> {
    if (!this.streamsClient) return;

    const config = this.consumerGroups.find(
      c => c.streamName === RedisStreamsClient.STREAMS.OPPORTUNITIES
    );
    if (!config) return;

    try {
      const messages = await this.streamsClient.xreadgroup(config, {
        count: 10,
        block: 0,
        startId: '>'
      });

      for (const message of messages) {
        this.handleArbitrageOpportunity(message.data as ArbitrageOpportunity);
        await this.streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        this.logger.error('Error consuming opportunities stream', { error });
      }
    }
  }

  // ===========================================================================
  // Opportunity Handling with Queue Backpressure
  // ===========================================================================

  private handleArbitrageOpportunity(opportunity: ArbitrageOpportunity): void {
    this.stats.opportunitiesReceived++;

    try {
      // Check queue backpressure
      if (!this.canEnqueue()) {
        this.stats.queueRejects++;
        this.logger.warn('Opportunity rejected due to queue backpressure', {
          id: opportunity.id,
          queueSize: this.executionQueue.length,
          highWaterMark: this.queueConfig.highWaterMark
        });
        return;
      }

      // Validate opportunity
      if (this.validateOpportunity(opportunity)) {
        this.executionQueue.push(opportunity);
        this.updateQueueStatus();

        this.logger.info('Added opportunity to execution queue', {
          id: opportunity.id,
          type: opportunity.type,
          profit: opportunity.expectedProfit,
          queueSize: this.executionQueue.length
        });
      } else {
        this.stats.opportunitiesRejected++;
      }
    } catch (error) {
      this.logger.error('Failed to handle arbitrage opportunity', { error });
    }
  }

  private canEnqueue(): boolean {
    // If paused, check if we're below low water mark
    if (this.queuePaused) {
      if (this.executionQueue.length <= this.queueConfig.lowWaterMark) {
        this.queuePaused = false;
        this.logger.info('Queue backpressure released', {
          queueSize: this.executionQueue.length,
          lowWaterMark: this.queueConfig.lowWaterMark
        });
      } else {
        return false;
      }
    }

    // Check if we've hit high water mark
    if (this.executionQueue.length >= this.queueConfig.highWaterMark) {
      this.queuePaused = true;
      this.logger.warn('Queue backpressure engaged', {
        queueSize: this.executionQueue.length,
        highWaterMark: this.queueConfig.highWaterMark
      });
      return false;
    }

    return this.executionQueue.length < this.queueConfig.maxSize;
  }

  private updateQueueStatus(): void {
    // Check if we need to engage/release backpressure
    if (!this.queuePaused && this.executionQueue.length >= this.queueConfig.highWaterMark) {
      this.queuePaused = true;
    } else if (this.queuePaused && this.executionQueue.length <= this.queueConfig.lowWaterMark) {
      this.queuePaused = false;
    }
  }

  private validateOpportunity(opportunity: ArbitrageOpportunity): boolean {
    // Basic validation checks
    if (opportunity.confidence < ARBITRAGE_CONFIG.confidenceThreshold) {
      this.logger.debug('Opportunity rejected: low confidence', {
        id: opportunity.id,
        confidence: opportunity.confidence
      });
      return false;
    }

    if (opportunity.expectedProfit < ARBITRAGE_CONFIG.minProfitPercentage) {
      this.logger.debug('Opportunity rejected: insufficient profit', {
        id: opportunity.id,
        profit: opportunity.expectedProfit
      });
      return false;
    }

    // Check if already in local tracking (non-atomic, but quick filter)
    if (this.activeExecutions.has(opportunity.id)) {
      this.logger.debug('Opportunity rejected: already executing', {
        id: opportunity.id
      });
      return false;
    }

    // Check if we have wallet for the chain
    const chain = opportunity.buyChain;
    if (chain && !this.wallets.has(chain)) {
      this.logger.warn('Opportunity rejected: no wallet for chain', {
        id: opportunity.id,
        chain
      });
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Execution Processing
  // ===========================================================================

  private startExecutionProcessing(): void {
    // Process execution queue every 50ms
    this.executionProcessingInterval = setInterval(() => {
      if (this.stateManager.isRunning() && this.executionQueue.length > 0) {
        const opportunity = this.executionQueue.shift();
        if (opportunity) {
          this.executeOpportunityWithLock(opportunity);
        }
      }
    }, 50);
  }

  /**
   * Execute opportunity with distributed lock to prevent duplicate executions.
   * This fixes the TOCTOU race condition.
   */
  private async executeOpportunityWithLock(opportunity: ArbitrageOpportunity): Promise<void> {
    if (!this.lockManager) {
      this.logger.error('Lock manager not initialized');
      return;
    }

    const lockResult = await this.lockManager.withLock(
      `opportunity:${opportunity.id}`,
      async () => {
        await this.executeOpportunity(opportunity);
      },
      {
        ttlMs: 60000, // 60 second lock
        retries: 0    // No retry - if locked, another instance is handling it
      }
    );

    if (!lockResult.success) {
      if (lockResult.reason === 'lock_not_acquired') {
        this.stats.lockConflicts++;
        this.logger.debug('Opportunity skipped - already being executed by another instance', {
          id: opportunity.id
        });
      } else if (lockResult.reason === 'execution_error') {
        this.logger.error('Opportunity execution failed', {
          id: opportunity.id,
          error: lockResult.error
        });
      }
    }
  }

  private async executeOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const startTime = performance.now();

    try {
      this.activeExecutions.add(opportunity.id);
      this.stats.opportunitiesExecuted++;

      this.logger.info('Executing arbitrage opportunity', {
        id: opportunity.id,
        type: opportunity.type,
        buyChain: opportunity.buyChain,
        buyDex: opportunity.buyDex,
        sellDex: opportunity.sellDex,
        expectedProfit: opportunity.expectedProfit
      });

      let result: ExecutionResult;

      if (opportunity.type === 'cross-chain') {
        result = await this.executeCrossChainArbitrage(opportunity);
      } else {
        result = await this.executeIntraChainArbitrage(opportunity);
      }

      // Publish execution result
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
        profit: result.actualProfit || 0
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
        error: (error as Error).message,
        timestamp: Date.now(),
        chain: opportunity.buyChain || 'unknown',
        dex: opportunity.buyDex
      };

      await this.publishExecutionResult(errorResult);
    } finally {
      this.activeExecutions.delete(opportunity.id);
    }
  }

  // ===========================================================================
  // Arbitrage Execution
  // ===========================================================================

  private async executeIntraChainArbitrage(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    const chain = opportunity.buyChain;
    if (!chain) {
      throw new Error('No chain specified for opportunity');
    }

    const wallet = this.wallets.get(chain);
    if (!wallet) {
      throw new Error(`No wallet available for chain: ${chain}`);
    }

    // Get optimal gas price
    const gasPrice = await this.getOptimalGasPrice(chain);

    // Prepare flash loan transaction
    const flashLoanTx = await this.prepareFlashLoanTransaction(opportunity, chain);

    // Apply MEV protection
    const protectedTx = await this.applyMEVProtection(flashLoanTx, chain);

    // Execute transaction
    const txResponse = await wallet.sendTransaction(protectedTx);
    const receipt = await txResponse.wait();

    if (!receipt) {
      throw new Error('Transaction receipt not received');
    }

    // Calculate actual profit
    const actualProfit = await this.calculateActualProfit(receipt, opportunity);

    return {
      opportunityId: opportunity.id,
      success: true,
      transactionHash: receipt.hash,
      actualProfit,
      gasUsed: Number(receipt.gasUsed),
      gasCost: parseFloat(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice || gasPrice))),
      timestamp: Date.now(),
      chain,
      dex: opportunity.buyDex
    };
  }

  private async executeCrossChainArbitrage(opportunity: ArbitrageOpportunity): Promise<ExecutionResult> {
    // Cross-chain execution requires bridge interaction
    this.logger.warn('Cross-chain execution not fully implemented yet', {
      opportunityId: opportunity.id
    });

    return {
      opportunityId: opportunity.id,
      success: false,
      error: 'Cross-chain execution not implemented',
      timestamp: Date.now(),
      chain: opportunity.buyChain || 'unknown',
      dex: opportunity.buyDex
    };
  }

  private async prepareFlashLoanTransaction(
    opportunity: ArbitrageOpportunity,
    chain: string
  ): Promise<ethers.TransactionRequest> {
    const flashParams: FlashLoanParams = {
      token: opportunity.tokenIn,
      amount: opportunity.amountIn,
      path: this.buildSwapPath(opportunity),
      minProfit: opportunity.expectedProfit * 0.9 // 10% slippage tolerance
    };

    const flashLoanContract = await this.getFlashLoanContract(chain);

    const tx = await flashLoanContract.executeFlashLoan.populateTransaction(
      flashParams.token,
      flashParams.amount,
      flashParams.path,
      flashParams.minProfit
    );

    return tx;
  }

  private buildSwapPath(opportunity: ArbitrageOpportunity): string[] {
    return [opportunity.tokenIn, opportunity.tokenOut];
  }

  private async getFlashLoanContract(chain: string): Promise<ethers.Contract> {
    const provider = this.providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain: ${chain}`);
    }

    // Aave V3 flash loan contract addresses
    const flashLoanAddresses: {[chain: string]: string} = {
      ethereum: '0x87870Bcd2C4c2e84A8c3C3a3FcACC94666c0d6Cf',
      polygon: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'
    };

    const address = flashLoanAddresses[chain];
    if (!address) {
      throw new Error(`No flash loan contract for chain: ${chain}`);
    }

    const flashLoanAbi = [
      'function executeFlashLoan(address asset, uint256 amount, address[] calldata path, uint256 minProfit) external'
    ];

    return new ethers.Contract(address, flashLoanAbi, provider);
  }

  private async applyMEVProtection(
    tx: ethers.TransactionRequest,
    chain: string
  ): Promise<ethers.TransactionRequest> {
    // Apply MEV protection strategies
    tx.gasPrice = await this.getOptimalGasPrice(chain);

    // TODO: Implement Flashbots integration for production
    // TODO: Add transaction bundling

    return tx;
  }

  private async getOptimalGasPrice(chain: string): Promise<bigint> {
    const provider = this.providers.get(chain);
    if (!provider) {
      return ethers.parseUnits('50', 'gwei');
    }

    try {
      const feeData = await provider.getFeeData();

      if (feeData.maxFeePerGas) {
        return feeData.maxFeePerGas;
      }

      const gasPrice = feeData.gasPrice;
      return gasPrice || ethers.parseUnits('50', 'gwei');
    } catch (error) {
      this.logger.warn('Failed to get optimal gas price, using default', {
        chain,
        error
      });
      return ethers.parseUnits('50', 'gwei');
    }
  }

  private async calculateActualProfit(
    receipt: ethers.TransactionReceipt,
    opportunity: ArbitrageOpportunity
  ): Promise<number> {
    // Analyze transaction logs to calculate actual profit
    // Simplified - in production would parse specific events
    const gasPrice = receipt.gasPrice || BigInt(0);
    const gasCost = parseFloat(ethers.formatEther(receipt.gasUsed * gasPrice));
    return opportunity.expectedProfit - gasCost;
  }

  // ===========================================================================
  // Result Publishing
  // ===========================================================================

  private async publishExecutionResult(result: ExecutionResult): Promise<void> {
    if (!this.streamsClient) return;

    try {
      // Publish to a new execution-results stream
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
          service: 'execution-engine',
          status: this.stateManager.isRunning() ? 'healthy' : 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now(),
          error: undefined
        };

        // Publish health to stream
        if (this.streamsClient) {
          await this.streamsClient.xadd(
            RedisStreamsClient.STREAMS.HEALTH,
            {
              ...health,
              queueSize: this.executionQueue.length,
              queuePaused: this.queuePaused,
              activeExecutions: this.activeExecutions.size,
              stats: this.stats
            }
          );
        }

        // Also update legacy health key
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
    return this.executionQueue.length;
  }

  isQueuePaused(): boolean {
    return this.queuePaused;
  }

  getStats(): ExecutionStats {
    return { ...this.stats };
  }

  getActiveExecutionsCount(): number {
    return this.activeExecutions.size;
  }
}
