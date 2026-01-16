// Base Detector Class
// Provides common functionality for all blockchain detectors
// Updated 2025-01-10: Migrated from Pub/Sub to Redis Streams (ADR-002, S1.1.4)
// Updated 2025-01-10: Consolidated with ServiceStateManager and template method pattern

import { ethers } from 'ethers';
import {
  RedisClient,
  getRedisClient,
  createLogger,
  getPerformanceLogger,
  PerformanceLogger,
  Logger,  // P2-FIX: Import Logger type
  EventBatcher,
  BatchedEvent,
  createEventBatcher,
  WebSocketManager,
  WebSocketMessage,
  RedisStreamsClient,
  StreamBatcher,
  getRedisStreamsClient,
  SwapEventFilter,
  WhaleAlert,
  VolumeAggregate,
  ServiceStateManager,
  ServiceState,
  createServiceState,
  // S2.2.5: Pair Discovery and Caching
  PairDiscoveryService,
  getPairDiscoveryService,
  PairCacheService,
  getPairCacheService
} from './index';
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG, EVENT_CONFIG, EVENT_SIGNATURES, DETECTOR_CONFIG, TOKEN_METADATA, getEnabledDexes, dexFeeToPercentage } from '../../config/src';
import {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
  MessageEvent,
  Pair
} from '../../types/src';

export interface DetectorConfig {
  chain: string;
  enabled: boolean;
  wsUrl?: string;
  rpcUrl?: string;
  batchSize?: number;
  batchTimeout?: number;
  healthCheckInterval?: number;
}

/**
 * Extended pair interface with reserve data
 */
export interface ExtendedPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

/**
 * Snapshot of pair data for thread-safe arbitrage detection.
 * Captures reserve values at a point in time to avoid race conditions
 * when reserves are updated by concurrent processSyncEvent calls.
 */
export interface PairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number;
}

// =============================================================================
// DI Types (P16 pattern - enables testability without Jest mock hoisting)
// =============================================================================

/**
 * Logger interface for BaseDetector DI.
 */
export interface BaseDetectorLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Dependencies that can be injected into BaseDetector.
 * This enables proper testing without Jest mock hoisting issues.
 */
export interface BaseDetectorDeps {
  /** Logger instance - if provided, used instead of createLogger() */
  logger?: BaseDetectorLogger;
  /** Performance logger instance - if provided, used instead of getPerformanceLogger() */
  perfLogger?: PerformanceLogger;
}

export abstract class BaseDetector {
  protected provider: ethers.JsonRpcProvider;
  protected wsManager: WebSocketManager | null = null;
  protected redis: RedisClient | null = null;
  protected streamsClient: RedisStreamsClient | null = null;
  // P2-FIX: Use proper Logger type (changed to interface for DI support)
  protected logger: BaseDetectorLogger;
  protected perfLogger: PerformanceLogger;
  // P2-FIX: Use proper EventBatcher type instead of any
  protected eventBatcher: EventBatcher | null = null;

  // Stream batchers for efficient Redis command usage (ADR-002)
  protected priceUpdateBatcher: StreamBatcher<any> | null = null;
  protected swapEventBatcher: StreamBatcher<any> | null = null;
  protected whaleAlertBatcher: StreamBatcher<any> | null = null;

  // Smart Swap Event Filter (S1.2)
  protected swapEventFilter: SwapEventFilter | null = null;

  // S2.2.5: Pair Discovery and Caching Services
  protected pairDiscoveryService: PairDiscoveryService | null = null;
  protected pairCacheService: PairCacheService | null = null;

  protected dexes: Dex[];
  protected tokens: Token[];
  protected pairs: Map<string, Pair> = new Map();
  protected monitoredPairs: Set<string> = new Set();
  protected isRunning = false;

  // O(1) pair lookup by address (performance optimization)
  protected pairsByAddress: Map<string, Pair> = new Map();

  /**
   * T1.1: Token Pair Index for O(1) arbitrage detection.
   * Maps normalized token pair key to array of pairs with those tokens.
   * Key format: "tokenA_tokenB" where tokenA < tokenB (alphabetically sorted, lowercase)
   * This enables O(1) lookup instead of O(n) scan when checking for arbitrage.
   */
  protected pairsByTokens: Map<string, Pair[]> = new Map();

  // Stop/start synchronization (race condition fix)
  // stopPromise ensures start() waits for stop() to fully complete
  protected stopPromise: Promise<void> | null = null;

  // Service state management (prevents lifecycle race conditions)
  protected stateManager: ServiceStateManager;
  protected healthMonitoringInterval: NodeJS.Timeout | null = null;

  // Race condition protection (additional guard alongside state machine)
  protected isStopping = false;

  // Redis Streams is REQUIRED per ADR-002 - fail fast if unavailable
  // Removed useStreams flag - Streams is always required

  protected config: DetectorConfig;
  protected chain: string;

  // Token metadata for USD estimation (chain-specific)
  protected tokenMetadata: any;

  constructor(config: DetectorConfig, deps?: BaseDetectorDeps) {
    this.config = config;
    this.chain = config.chain;

    // DI: Use injected logger/perfLogger if provided, otherwise create defaults
    this.logger = deps?.logger ?? createLogger(`${this.chain}-detector`);
    this.perfLogger = deps?.perfLogger ?? getPerformanceLogger(`${this.chain}-detector`);

    // Initialize state manager for lifecycle control
    this.stateManager = createServiceState({
      serviceName: `${this.chain}-detector`,
      transitionTimeoutMs: 30000
    });

    // Initialize chain-specific data (using getEnabledDexes to filter disabled DEXs)
    this.dexes = getEnabledDexes(this.chain);
    this.tokens = CORE_TOKENS[this.chain as keyof typeof CORE_TOKENS] || [];
    this.tokenMetadata = TOKEN_METADATA[this.chain as keyof typeof TOKEN_METADATA] || {};

    // Initialize provider
    const chainConfig = CHAINS[this.chain as keyof typeof CHAINS];
    if (!chainConfig) {
      throw new Error(`Unsupported chain: ${this.chain}`);
    }

    this.provider = new ethers.JsonRpcProvider(
      config.rpcUrl || chainConfig.rpcUrl
    );

    // Initialize event batcher for optimized processing
    this.eventBatcher = createEventBatcher(
      {
        maxBatchSize: config.batchSize || 20,
        // T1.3: Reduced from 30ms to 5ms for ultra-low latency detection
        maxWaitTime: config.batchTimeout || 5,
        enableDeduplication: true,
        enablePrioritization: true
      },
      (batch: BatchedEvent) => this.processBatchedEvents(batch)
    );

    // Initialize WebSocket manager
    const wsUrl = config.wsUrl || chainConfig.wsUrl || chainConfig.rpcUrl;
    this.wsManager = new WebSocketManager({
      url: wsUrl!,
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      connectionTimeout: 10000
    });

    // Set up WebSocket message handler
    this.wsManager.onMessage((message: WebSocketMessage) => {
      this.handleWebSocketMessage(message);
    });

    this.logger.info(`Initialized ${this.chain} detector`, {
      dexes: this.dexes.length,
      tokens: this.tokens.length,
      rpcUrl: config.rpcUrl || chainConfig.rpcUrl,
      wsUrl
    });
  }

  protected async initializeRedis(): Promise<void> {
    try {
      // Initialize Redis client for basic operations
      this.redis = await getRedisClient() as RedisClient;
      this.logger.debug('Redis client initialized');

      // Initialize Redis Streams client (REQUIRED per ADR-002 - no fallback)
      this.streamsClient = await getRedisStreamsClient();
      this.logger.debug('Redis Streams client initialized');

      // Create batchers for efficient command usage (50:1 target ratio)
      this.priceUpdateBatcher = this.streamsClient.createBatcher(
        RedisStreamsClient.STREAMS.PRICE_UPDATES,
        {
          maxBatchSize: 50,
          maxWaitMs: 100 // Flush every 100ms for latency-sensitive price data
        }
      );

      this.swapEventBatcher = this.streamsClient.createBatcher(
        RedisStreamsClient.STREAMS.SWAP_EVENTS,
        {
          maxBatchSize: 100,
          maxWaitMs: 500 // Less time-sensitive
        }
      );

      this.whaleAlertBatcher = this.streamsClient.createBatcher(
        RedisStreamsClient.STREAMS.WHALE_ALERTS,
        {
          maxBatchSize: 10,
          maxWaitMs: 50 // Whale alerts are time-sensitive
        }
      );

      this.logger.info('Redis Streams batchers initialized', {
        priceUpdates: { maxBatch: 50, maxWaitMs: 100 },
        swapEvents: { maxBatch: 100, maxWaitMs: 500 },
        whaleAlerts: { maxBatch: 10, maxWaitMs: 50 }
      });

      // Initialize Smart Swap Event Filter (S1.2)
      this.swapEventFilter = new SwapEventFilter({
        minUsdValue: 10,       // Filter dust transactions < $10
        whaleThreshold: 50000, // Alert for transactions >= $50K
        dedupWindowMs: 5000,   // 5 second dedup window
        aggregationWindowMs: 5000 // 5 second volume aggregation
      });

      // Set up whale alert handler to publish to stream with retry (P0-6 fix)
      this.swapEventFilter.onWhaleAlert((alert: WhaleAlert) => {
        this.publishWithRetry(
          () => this.publishWhaleAlert(alert),
          'whale alert',
          3 // max retries
        );
      });

      // Set up volume aggregate handler to publish to stream with retry
      this.swapEventFilter.onVolumeAggregate((aggregate: VolumeAggregate) => {
        this.publishWithRetry(
          () => this.publishVolumeAggregate(aggregate),
          'volume aggregate',
          3 // max retries
        );
      });

      this.logger.info('Smart Swap Event Filter initialized', {
        minUsdValue: 10,
        whaleThreshold: 50000
      });
    } catch (error) {
      this.logger.error('Failed to initialize Redis/Streams', { error });
      throw new Error('Redis Streams initialization failed - Streams required per ADR-002');
    }
  }

  /**
   * S2.2.5: Initialize pair discovery and caching services.
   * Sets up the provider for factory contract queries and initializes cache.
   */
  protected async initializePairServices(): Promise<void> {
    try {
      // Initialize pair discovery service (singleton)
      this.pairDiscoveryService = getPairDiscoveryService({
        maxConcurrentQueries: 10,
        batchSize: 50,
        batchDelayMs: 100,
        retryAttempts: 3,
        retryDelayMs: 1000,
        circuitBreakerThreshold: 10,
        circuitBreakerResetMs: 60000,
        queryTimeoutMs: 10000
      });

      // Set provider for this chain to enable factory queries
      this.pairDiscoveryService.setProvider(this.chain, this.provider);

      // Initialize pair cache service (singleton with async init)
      this.pairCacheService = await getPairCacheService({
        pairAddressTtlSec: 24 * 60 * 60,  // 24 hours - pair addresses are static
        nullResultTtlSec: 60 * 60,         // 1 hour for non-existent pairs
        maxBatchSize: 50,
        keyPrefix: 'pair:'
      });

      this.logger.info('Pair discovery and caching services initialized', {
        chain: this.chain
      });
    } catch (error) {
      this.logger.error('Failed to initialize pair services', { error });
      // Non-fatal: fall back to CREATE2 computation if services fail
      this.logger.warn('Will fall back to CREATE2 address computation');
    }
  }

  // ===========================================================================
  // Lifecycle Methods (Concrete with hooks for subclass customization)
  // Uses ServiceStateManager to prevent race conditions
  // ===========================================================================

  /**
   * Start the detector service.
   * Uses ServiceStateManager to prevent race conditions.
   * Override onStart() for chain-specific initialization.
   */
  async start(): Promise<void> {
    // Wait for any pending stop operation to complete
    if (this.stopPromise) {
      this.logger.debug('Waiting for pending stop operation to complete');
      await this.stopPromise;
    }

    // Guard against starting while stopping
    if (this.isStopping) {
      this.logger.warn('Cannot start: service is currently stopping');
      return;
    }

    // Guard against double start
    if (this.isRunning) {
      this.logger.warn('Service is already running');
      return;
    }

    try {
      this.logger.info(`Starting ${this.chain} detector service`);

      // Initialize Redis client
      await this.initializeRedis();

      // S2.2.5: Initialize pair discovery and caching services
      await this.initializePairServices();

      // Initialize pairs from DEX factories
      await this.initializePairs();

      // Connect to WebSocket for real-time events
      await this.connectWebSocket();

      // Subscribe to Sync and Swap events
      await this.subscribeToEvents();

      // Hook for chain-specific initialization
      await this.onStart();

      this.isRunning = true;
      this.logger.info(`${this.chain} detector service started successfully`, {
        pairs: this.pairs.size,
        dexes: this.dexes.length,
        tokens: this.tokens.length
      });

      // Start health monitoring
      this.startHealthMonitoring();

    } catch (error) {
      this.logger.error(`Failed to start ${this.chain} detector service`, { error });
      throw error;
    }
  }

  /**
   * Stop the detector service.
   * Uses ServiceStateManager to prevent race conditions.
   * Override onStop() for chain-specific cleanup.
   */
  async stop(): Promise<void> {
    // If stop is already in progress, wait for it (regardless of other state)
    if (this.stopPromise) {
      return this.stopPromise;
    }

    // Guard against double stop when already stopped
    if (!this.isRunning && !this.isStopping) {
      this.logger.debug('Service is already stopped');
      return;
    }

    // Mark as stopping BEFORE creating the promise to prevent races
    this.isStopping = true;
    this.isRunning = false;
    this.logger.info(`Stopping ${this.chain} detector service`);

    // Create and store the promise BEFORE awaiting
    this.stopPromise = this.performCleanup();

    try {
      await this.stopPromise;
    } finally {
      // Only clear state after cleanup is fully complete
      this.isStopping = false;
      this.stopPromise = null;
    }
  }

  /**
   * Internal cleanup method called by stop()
   * Note: State cleanup (isStopping, stopPromise) is handled in stop()
   */
  private async performCleanup(): Promise<void> {
    // Stop health monitoring first to prevent racing
    if (this.healthMonitoringInterval) {
      clearInterval(this.healthMonitoringInterval);
      this.healthMonitoringInterval = null;
    }

    // Hook for chain-specific cleanup
    await this.onStop();

    // Flush any remaining batched events
    if (this.eventBatcher) {
      try {
        if (this.eventBatcher.flushAll) {
          await Promise.resolve(this.eventBatcher.flushAll());
        }
        if (this.eventBatcher.destroy) {
          this.eventBatcher.destroy();
        }
      } catch (error) {
        this.logger.warn('Error flushing event batcher', { error });
      }
      // P2-FIX: No need for 'as any' with proper type
      this.eventBatcher = null;
    }

    // Clean up Redis Streams batchers (ADR-002, S1.1.4)
    await this.cleanupStreamBatchers();

    // Disconnect WebSocket manager
    if (this.wsManager) {
      try {
        this.wsManager.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting WebSocket', { error });
      }
    }

    // Disconnect Redis Streams client
    if (this.streamsClient) {
      try {
        await this.streamsClient.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting Redis Streams client', { error });
      }
      this.streamsClient = null;
    }

    // Disconnect Redis
    if (this.redis) {
      try {
        await this.redis.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting Redis', { error });
      }
      this.redis = null;
    }

    // Clear collections to prevent memory leaks
    this.pairs.clear();
    this.pairsByAddress.clear();
    // T1.1: Clear token pair index
    this.pairsByTokens.clear();
    this.monitoredPairs.clear();

    // P0-2 fix: Clean up state manager event listeners
    if (this.stateManager) {
      this.stateManager.removeAllListeners();
    }

    this.logger.info(`${this.chain} detector service stopped`);
  }

  /**
   * Hook for chain-specific initialization.
   * Override in subclass for custom setup.
   */
  protected async onStart(): Promise<void> {
    // Default: no-op, override in subclass if needed
  }

  /**
   * Hook for chain-specific cleanup.
   * Override in subclass for custom cleanup.
   */
  protected async onStop(): Promise<void> {
    // Default: no-op, override in subclass if needed
  }

  /**
   * Get service health status.
   * Override in subclass for chain-specific health info.
   */
  async getHealth(): Promise<any> {
    const batcherStats = this.eventBatcher ? this.eventBatcher.getStats() : null;
    const wsStats = this.wsManager ? this.wsManager.getConnectionStats() : null;

    return {
      service: `${this.chain}-detector`,
      status: (this.isRunning && !this.isStopping ? 'healthy' : 'unhealthy') as 'healthy' | 'degraded' | 'unhealthy',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().heapUsed,
      cpuUsage: 0,
      lastHeartbeat: Date.now(),
      pairs: this.pairs.size,
      websocket: wsStats,
      batcherStats,
      chain: this.chain,
      dexCount: this.dexes.length,
      tokenCount: this.tokens.length
    };
  }

  /**
   * Start health monitoring interval
   * P1-FIX: Self-clears interval when stopping to prevent memory leak
   */
  protected startHealthMonitoring(): void {
    const interval = this.config.healthCheckInterval || 30000;
    this.healthMonitoringInterval = setInterval(async () => {
      // P1-FIX: Self-clear when stopping to prevent wasted cycles and memory leak
      if (this.isStopping || !this.isRunning) {
        if (this.healthMonitoringInterval) {
          clearInterval(this.healthMonitoringInterval);
          this.healthMonitoringInterval = null;
        }
        return;
      }

      try {
        const health = await this.getHealth();

        // Re-check shutdown state after async operation
        if (this.isStopping || !this.isRunning) {
          return;
        }

        // Capture redis reference to prevent null access during shutdown
        const redis = this.redis;
        if (redis) {
          await redis.updateServiceHealth(`${this.chain}-detector`, health);
        }

        // Final check before logging
        if (!this.isStopping) {
          this.perfLogger.logHealthCheck(`${this.chain}-detector`, health);
        }

      } catch (error) {
        // Only log error if not stopping (errors during shutdown are expected)
        if (!this.isStopping) {
          this.logger.error('Health monitoring failed', { error });
        }
      }
    }, interval);
  }

  // ===========================================================================
  // Configuration Getters (Override in subclass for chain-specific values)
  // ===========================================================================

  /**
   * Get minimum profit threshold for this chain.
   * Override in subclass for chain-specific thresholds.
   */
  getMinProfitThreshold(): number {
    const chainMinProfits = ARBITRAGE_CONFIG.chainMinProfits as Record<string, number>;
    // S2.2.3 FIX: Use ?? instead of || to correctly handle 0 min profit (if any chain allows it)
    return chainMinProfits[this.chain] ?? 0.003; // Default 0.3%
  }

  /**
   * Get chain-specific detector config.
   * Override in subclass if needed.
   */
  protected getChainDetectorConfig(): any {
    return (DETECTOR_CONFIG as Record<string, any>)[this.chain] || {
      confidence: 0.8,
      expiryMs: 5000,
      gasEstimate: 200000,
      whaleThreshold: 50000
    };
  }

  // ===========================================================================
  // Event Processing (Concrete implementations with sensible defaults)
  // ===========================================================================

  /**
   * Process Sync event (reserve update).
   * Default implementation - can be overridden for chain-specific behavior.
   */
  protected async processSyncEvent(log: any, pair: Pair): Promise<void> {
    try {
      // Decode reserve data from log data
      const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint112', 'uint112'],
        log.data
      );

      const reserve0 = decodedData[0].toString();
      const reserve1 = decodedData[1].toString();
      const blockNumber = typeof log.blockNumber === 'string'
        ? parseInt(log.blockNumber, 16)
        : log.blockNumber;

      // Update pair data atomically (P0-1 fix: prevents race conditions)
      // Using Object.assign ensures all properties are updated in a single operation,
      // so readers either see all old values or all new values, never a mix
      const extendedPair = pair as ExtendedPair;
      Object.assign(extendedPair, {
        reserve0,
        reserve1,
        blockNumber,
        lastUpdate: Date.now()
      });

      // Calculate price
      const price = this.calculatePrice(extendedPair);

      // Create price update
      const priceUpdate: PriceUpdate = {
        pairKey: `${pair.dex}_${pair.token0}_${pair.token1}`,
        dex: pair.dex,
        chain: this.chain,
        token0: pair.token0,
        token1: pair.token1,
        price,
        reserve0,
        reserve1,
        blockNumber,
        timestamp: Date.now(),
        latency: 0,
        // Include DEX-specific fee for accurate arbitrage calculations (supports Maverick 1bp, Curve 4bp, etc.)
        fee: pair.fee
      };

      // Publish price update (uses Redis Streams batching)
      await this.publishPriceUpdate(priceUpdate);

      // Check for intra-DEX arbitrage
      await this.checkIntraDexArbitrage(pair);

    } catch (error) {
      this.logger.error('Failed to process sync event', { error, pair: pair.address });
    }
  }

  /**
   * Process Swap event (trade).
   * Default implementation - can be overridden for chain-specific behavior.
   */
  protected async processSwapEvent(log: any, pair: Pair): Promise<void> {
    try {
      // Decode swap data
      const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256', 'uint256', 'uint256', 'uint256'],
        log.data
      );

      const amount0In = decodedData[0].toString();
      const amount1In = decodedData[1].toString();
      const amount0Out = decodedData[2].toString();
      const amount1Out = decodedData[3].toString();

      // Calculate USD value
      const usdValue = await this.estimateUsdValue(pair, amount0In, amount1In, amount0Out, amount1Out);

      // Apply filtering based on configuration
      if (usdValue < EVENT_CONFIG.swapEvents.minAmountUSD) {
        // Apply sampling for small trades
        if (Math.random() > EVENT_CONFIG.swapEvents.samplingRate) {
          return; // Skip this event
        }
      }

      const blockNumber = typeof log.blockNumber === 'string'
        ? parseInt(log.blockNumber, 16)
        : log.blockNumber;

      const swapEvent: SwapEvent = {
        pairAddress: pair.address,
        sender: log.topics?.[1] ? '0x' + log.topics[1].slice(26) : '0x0',
        recipient: log.topics?.[2] ? '0x' + log.topics[2].slice(26) : '0x0',
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to: log.topics?.[2] ? '0x' + log.topics[2].slice(26) : '0x0',
        blockNumber,
        transactionHash: log.transactionHash || '0x0',
        timestamp: Date.now(),
        dex: pair.dex,
        chain: this.chain,
        usdValue
      };

      // Publish swap event (uses Smart Swap Event Filter)
      await this.publishSwapEvent(swapEvent);

      // Check for whale activity
      await this.checkWhaleActivity(swapEvent);

    } catch (error) {
      this.logger.error('Failed to process swap event', { error, pair: pair.address });
    }
  }

  /**
   * Check for intra-DEX arbitrage opportunities.
   * T1.1 OPTIMIZED: Uses token pair index for O(1) lookup instead of O(n) iteration.
   * Default implementation using pair snapshots for thread safety.
   */
  protected async checkIntraDexArbitrage(pair: Pair): Promise<void> {
    // Guard against processing during shutdown (P2 fix: consistent order)
    if (this.isStopping || !this.isRunning) {
      return;
    }

    const opportunities: ArbitrageOpportunity[] = [];

    // Create snapshot of current pair for thread-safe comparison
    const currentSnapshot = this.createPairSnapshot(pair);
    if (!currentSnapshot) return;

    const currentPrice = this.calculatePriceFromSnapshot(currentSnapshot);
    if (currentPrice === 0) return;

    // T1.1: O(1) lookup - Get only pairs with matching tokens instead of scanning all pairs
    // This is the key optimization: from O(n) to O(k) where k is number of DEXs trading this pair
    const matchingPairs = this.getPairsForTokens(currentSnapshot.token0, currentSnapshot.token1);

    // Skip if no other pairs to compare with (need at least 2 pairs for arbitrage)
    if (matchingPairs.length < 2) return;

    for (const otherPair of matchingPairs) {
      // Skip self-comparison and same-DEX comparison
      if (otherPair.address.toLowerCase() === currentSnapshot.address.toLowerCase()) continue;
      if (otherPair.dex === currentSnapshot.dex) continue;

      // Create snapshot of other pair for thread-safe comparison
      const otherSnapshot = this.createPairSnapshot(otherPair);
      if (!otherSnapshot) continue;

      let otherPrice = this.calculatePriceFromSnapshot(otherSnapshot);
      if (otherPrice === 0) continue;

      // Check if token order is reversed and adjust price accordingly
      const currentToken0Lower = currentSnapshot.token0.toLowerCase();
      const otherToken0Lower = otherSnapshot.token0.toLowerCase();
      const isReverseOrder = currentToken0Lower !== otherToken0Lower;

      if (isReverseOrder && otherPrice !== 0) {
        otherPrice = 1 / otherPrice;
      }

      // Calculate price difference percentage (gross spread)
      const priceDiff = Math.abs(currentPrice - otherPrice) / Math.min(currentPrice, otherPrice);

      // Calculate fee-adjusted net profit (S2.2.2 fix: use pair-specific fees)
      const currentFee = currentSnapshot.fee ?? 0.003;
      const otherFee = otherSnapshot.fee ?? 0.003;
      const totalFees = currentFee + otherFee;
      const netProfitPct = priceDiff - totalFees;

      // Check against threshold using NET profit (not gross)
      if (netProfitPct >= this.getMinProfitThreshold()) {
        const chainConfig = this.getChainDetectorConfig();
        const opportunity: ArbitrageOpportunity = {
          id: `${currentSnapshot.address}-${otherSnapshot.address}-${Date.now()}`,
          type: 'simple',
          chain: this.chain,
          buyDex: currentPrice < otherPrice ? currentSnapshot.dex : otherSnapshot.dex,
          sellDex: currentPrice < otherPrice ? otherSnapshot.dex : currentSnapshot.dex,
          buyPair: currentPrice < otherPrice ? currentSnapshot.address : otherSnapshot.address,
          sellPair: currentPrice < otherPrice ? otherSnapshot.address : currentSnapshot.address,
          token0: currentSnapshot.token0,
          token1: currentSnapshot.token1,
          buyPrice: Math.min(currentPrice, otherPrice),
          sellPrice: Math.max(currentPrice, otherPrice),
          profitPercentage: netProfitPct * 100, // Report NET profit percentage
          expectedProfit: netProfitPct, // Net profit as decimal
          estimatedProfit: 0,
          confidence: chainConfig.confidence,
          timestamp: Date.now(),
          expiresAt: Date.now() + chainConfig.expiryMs,
          gasEstimate: chainConfig.gasEstimate,
          status: 'pending'
        };

        opportunities.push(opportunity);
      }
    }

    // Publish opportunities
    for (const opportunity of opportunities) {
      await this.publishArbitrageOpportunity(opportunity);
      this.perfLogger.logArbitrageOpportunity(opportunity);
    }
  }

  /**
   * Check for whale activity.
   * Default implementation using chain config thresholds.
   */
  protected async checkWhaleActivity(swapEvent: SwapEvent): Promise<void> {
    const chainConfig = this.getChainDetectorConfig();
    const whaleThreshold = chainConfig.whaleThreshold;

    if (!swapEvent.usdValue || swapEvent.usdValue < whaleThreshold) {
      return;
    }

    const amount0InNum = parseFloat(swapEvent.amount0In);
    const amount1InNum = parseFloat(swapEvent.amount1In);

    const whaleTransaction = {
      transactionHash: swapEvent.transactionHash,
      address: swapEvent.sender,
      token: amount0InNum > amount1InNum ? 'token0' : 'token1',
      amount: Math.max(amount0InNum, amount1InNum),
      usdValue: swapEvent.usdValue,
      direction: amount0InNum > amount1InNum ? 'sell' : 'buy',
      dex: swapEvent.dex,
      chain: swapEvent.chain,
      timestamp: swapEvent.timestamp,
      impact: await this.calculatePriceImpact(swapEvent)
    };

    await this.publishWhaleTransaction(whaleTransaction);
  }

  /**
   * Estimate USD value of a swap.
   * Default implementation - should be overridden for chain-specific tokens.
   */
  protected async estimateUsdValue(
    pair: Pair,
    amount0In: string,
    amount1In: string,
    amount0Out: string,
    amount1Out: string
  ): Promise<number> {
    // Default prices (fallback)
    const defaultPrices: Record<string, number> = {
      ETH: 2500, WETH: 2500,
      BNB: 300, WBNB: 300,
      MATIC: 0.80, WMATIC: 0.80,
      ARB: 1.20,
      OP: 2.50
    };

    const token0Lower = pair.token0.toLowerCase();
    const token1Lower = pair.token1.toLowerCase();

    // Check for native wrapper token
    const nativeWrapper = this.tokenMetadata?.nativeWrapper || this.tokenMetadata?.weth || this.tokenMetadata?.wmatic;
    if (nativeWrapper) {
      const nativeWrapperLower = nativeWrapper.toLowerCase();

      if (token0Lower === nativeWrapperLower || token1Lower === nativeWrapperLower) {
        const isToken0Native = token0Lower === nativeWrapperLower;
        const amount = isToken0Native
          ? Math.max(parseFloat(amount0In), parseFloat(amount0Out))
          : Math.max(parseFloat(amount1In), parseFloat(amount1Out));

        // Get chain-specific native token price
        const nativeSymbol = this.chain === 'bsc' ? 'BNB' : this.chain === 'polygon' ? 'MATIC' : 'ETH';
        const price = defaultPrices[nativeSymbol] || 2500;
        return (amount / 1e18) * price;
      }
    }

    // Check for stablecoins
    const stablecoins = this.tokenMetadata?.stablecoins || [];
    for (const stable of stablecoins) {
      const stableLower = stable.address.toLowerCase();

      if (token0Lower === stableLower) {
        const stableAmount = Math.max(parseFloat(amount0In), parseFloat(amount0Out));
        return stableAmount / Math.pow(10, stable.decimals || 18);
      }

      if (token1Lower === stableLower) {
        const stableAmount = Math.max(parseFloat(amount1In), parseFloat(amount1Out));
        return stableAmount / Math.pow(10, stable.decimals || 18);
      }
    }

    return 0;
  }

  /**
   * Calculate price impact of a swap.
   * Default implementation using reserve ratios.
   */
  protected async calculatePriceImpact(swapEvent: SwapEvent): Promise<number> {
    const pair = this.pairsByAddress.get(swapEvent.pairAddress.toLowerCase()) as ExtendedPair;

    if (!pair || !pair.reserve0 || !pair.reserve1) {
      return 0.02; // Default 2% if reserves not available
    }

    const reserve0 = parseFloat(pair.reserve0);
    const reserve1 = parseFloat(pair.reserve1);
    const tradeAmount = Math.max(
      parseFloat(swapEvent.amount0In),
      parseFloat(swapEvent.amount1In),
      parseFloat(swapEvent.amount0Out),
      parseFloat(swapEvent.amount1Out)
    );

    // Simple impact calculation: trade_size / reserve
    const relevantReserve = parseFloat(swapEvent.amount0In) > 0 ? reserve0 : reserve1;
    if (relevantReserve === 0) return 0.02;

    return Math.min(tradeAmount / relevantReserve, 0.5); // Cap at 50%
  }

  // ===========================================================================
  // Pair Initialization (Common functionality)
  // ===========================================================================

  protected async initializePairs(): Promise<void> {
    this.logger.info(`Initializing ${this.chain} trading pairs`);

    const pairsProcessed = new Set<string>();

    // Note: this.dexes is already filtered by getEnabledDexes() in constructor
    for (const dex of this.dexes) {
      for (let i = 0; i < this.tokens.length; i++) {
        for (let j = i + 1; j < this.tokens.length; j++) {
          const token0 = this.tokens[i];
          const token1 = this.tokens[j];

          // Skip if pair already processed
          const pairKey = `${token0.symbol}_${token1.symbol}`;
          if (pairsProcessed.has(pairKey)) continue;

          try {
            const pairAddress = await this.getPairAddress(dex, token0, token1);
            if (pairAddress && pairAddress !== ethers.ZeroAddress) {
              // Convert fee from basis points to percentage for pair storage
              // Config stores fees in basis points (30 = 0.30%), Pair uses percentage (0.003)
              // S2.2.3 FIX: Use ?? instead of ternary to correctly handle fee: 0 (if any DEX has 0% fee)
              const feePercentage = dexFeeToPercentage(dex.fee ?? 30);
              const pair: Pair = {
                name: `${token0.symbol}/${token1.symbol}`,
                address: pairAddress,
                token0: token0.address,
                token1: token1.address,
                dex: dex.name,
                fee: feePercentage
              };

              const fullPairKey = `${dex.name}_${pair.name}`;
              this.pairs.set(fullPairKey, pair);
              // O(1) lookup by address (used in processLogEvent, calculatePriceImpact)
              this.pairsByAddress.set(pairAddress.toLowerCase(), pair);
              // T1.1: Add to token pair index for O(1) arbitrage detection
              this.addPairToTokenIndex(pair);
              this.monitoredPairs.add(pairAddress.toLowerCase());
              pairsProcessed.add(pairKey);

              this.logger.debug(`Added pair: ${pair.name} on ${dex.name}`, {
                address: pairAddress,
                pairKey: fullPairKey
              });
            }
          } catch (error) {
            this.logger.warn(`Failed to get pair address for ${token0.symbol}/${token1.symbol} on ${dex.name}`, {
              error: (error as Error).message
            });
          }
        }
      }
    }

    this.logger.info(`Initialized ${this.pairs.size} trading pairs for ${this.chain}`);
  }

  /**
   * S2.2.5: Get pair address using cache-first strategy.
   * 1. Check Redis cache for existing pair address
   * 2. On miss, query factory contract via PairDiscoveryService
   * 3. Cache the result for future lookups
   * 4. Fall back to CREATE2 computation if factory query fails
   */
  protected async getPairAddress(dex: Dex, token0: Token, token1: Token): Promise<string | null> {
    try {
      // Step 1: Check cache first (fast path)
      if (this.pairCacheService) {
        const cacheResult = await this.pairCacheService.get(
          this.chain,
          dex.name,
          token0.address,
          token1.address
        );

        if (cacheResult.status === 'hit') {
          // Cache hit - return cached address
          if (this.pairDiscoveryService) {
            this.pairDiscoveryService.incrementCacheHits();
          }
          return cacheResult.data.address;
        }

        if (cacheResult.status === 'null') {
          // Pair was previously checked and doesn't exist
          return null;
        }
        // Cache miss - proceed to discovery
      }

      // Step 2: Try factory query via PairDiscoveryService
      if (this.pairDiscoveryService) {
        const discoveredPair = await this.pairDiscoveryService.discoverPair(
          this.chain,
          dex,
          token0,
          token1
        );

        if (discoveredPair) {
          // Step 3: Cache the discovered pair
          if (this.pairCacheService) {
            await this.pairCacheService.set(
              this.chain,
              dex.name,
              token0.address,
              token1.address,
              {
                address: discoveredPair.address,
                token0: discoveredPair.token0,
                token1: discoveredPair.token1,
                dex: dex.name,
                chain: this.chain,
                factoryAddress: dex.factoryAddress,
                discoveredAt: discoveredPair.discoveredAt,
                lastVerified: Date.now(),
                discoveryMethod: discoveredPair.discoveryMethod
              }
            );
          }
          return discoveredPair.address;
        }

        // Pair doesn't exist - cache the null result to avoid repeated queries
        if (this.pairCacheService) {
          await this.pairCacheService.setNull(
            this.chain,
            dex.name,
            token0.address,
            token1.address
          );
        }
        return null;
      }

      // Step 4: Fallback - services not available, return null
      // Note: This shouldn't happen in production since services are initialized in start()
      this.logger.warn('Pair services not initialized, returning null', {
        dex: dex.name,
        token0: token0.symbol,
        token1: token1.symbol
      });
      return null;
    } catch (error) {
      this.logger.error(`Error getting pair address for ${dex.name}`, {
        error: (error as Error).message,
        token0: token0.symbol,
        token1: token1.symbol
      });
      return null;
    }
  }

  // NOTE: publishPriceUpdate, publishSwapEvent, and publishArbitrageOpportunity
  // are defined below with Redis Streams support (Lines 497+, ADR-002 migration)

  protected calculateArbitrageOpportunity(
    sourceUpdate: PriceUpdate,
    targetUpdate: PriceUpdate
  ): ArbitrageOpportunity | null {
    try {
      // Basic arbitrage calculation
      const priceDiff = Math.abs(sourceUpdate.price - targetUpdate.price);
      const avgPrice = (sourceUpdate.price + targetUpdate.price) / 2;
      // BUG FIX: Keep percentageDiff as decimal (0.005 = 0.5%), not multiplied by 100
      // This ensures consistent units with ARBITRAGE_CONFIG values (also in decimal)
      const percentageDiff = priceDiff / avgPrice;

      // Apply fees and slippage
      // Use pair-specific fees when available (supports different DEX fees like Maverick 1bp)
      // Fallback to config default if pair fees not available
      const sourceFee = sourceUpdate.fee ?? ARBITRAGE_CONFIG.feePercentage;
      const targetFee = targetUpdate.fee ?? ARBITRAGE_CONFIG.feePercentage;
      const totalFees = sourceFee + targetFee; // Round trip
      const netPercentage = percentageDiff - totalFees;

      if (netPercentage < ARBITRAGE_CONFIG.minProfitPercentage) {
        return null;
      }

      // Calculate confidence based on data freshness and volume
      const agePenalty = Math.max(0, (Date.now() - sourceUpdate.timestamp) / 60000); // 1 minute penalty
      const confidence = Math.max(0.1, Math.min(1.0, 1.0 - (agePenalty * 0.1)));

      const opportunity: ArbitrageOpportunity = {
        id: `arb_${this.chain}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        sourceChain: this.chain,
        targetChain: this.chain, // Same chain for now
        sourceDex: sourceUpdate.dex,
        targetDex: targetUpdate.dex,
        tokenAddress: sourceUpdate.token0,
        amount: ARBITRAGE_CONFIG.defaultAmount,
        priceDifference: priceDiff,
        percentageDifference: percentageDiff,
        // BUG FIX: No division by 100 needed since percentageDiff is already in decimal form
        estimatedProfit: ARBITRAGE_CONFIG.defaultAmount * netPercentage,
        gasCost: ARBITRAGE_CONFIG.estimatedGasCost,
        netProfit: (ARBITRAGE_CONFIG.defaultAmount * netPercentage) - ARBITRAGE_CONFIG.estimatedGasCost,
        confidence,
        timestamp: Date.now(),
        expiresAt: Date.now() + ARBITRAGE_CONFIG.opportunityTimeoutMs
      };

      return opportunity;
    } catch (error) {
      this.logger.error('Error calculating arbitrage opportunity', { error });
      return null;
    }
  }

  protected validateOpportunity(opportunity: ArbitrageOpportunity): boolean {
    // Validate opportunity meets minimum requirements
    if ((opportunity.netProfit ?? 0) < ARBITRAGE_CONFIG.minProfitThreshold) {
      return false;
    }

    if (opportunity.confidence < ARBITRAGE_CONFIG.minConfidenceThreshold) {
      return false;
    }

    if (opportunity.expiresAt && opportunity.expiresAt < Date.now()) {
      return false;
    }

    return true;
  }

  // Common WebSocket connection method
  protected async connectWebSocket(): Promise<void> {
    if (!this.wsManager) {
      throw new Error('WebSocket manager not initialized');
    }

    try {
      await this.wsManager.connect();
    } catch (error) {
      this.logger.error(`Failed to connect to ${this.chain} WebSocket`, { error });
      throw error;
    }
  }

  // Common event subscription method
  protected async subscribeToEvents(): Promise<void> {
    if (!this.wsManager) {
      throw new Error('WebSocket manager not initialized');
    }

    // Subscribe to Sync events (reserve changes)
    if (EVENT_CONFIG.syncEvents.enabled) {
      this.wsManager.subscribe({
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: [
              '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1', // Sync event signature
            ],
            address: Array.from(this.monitoredPairs)
          }
        ]
      });
      this.logger.info(`Subscribed to Sync events for ${this.monitoredPairs.size} pairs`);
    }

    // Subscribe to Swap events (trading activity)
    if (EVENT_CONFIG.swapEvents.enabled) {
      this.wsManager.subscribe({
        method: 'eth_subscribe',
        params: [
          'logs',
          {
            topics: [
              '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', // Swap V2 event signature
            ],
            address: Array.from(this.monitoredPairs)
          }
        ]
      });
      this.logger.info(`Subscribed to Swap events for ${this.monitoredPairs.size} pairs`);
    }
  }

  // Common WebSocket message handler
  protected handleWebSocketMessage(message: WebSocketMessage): void {
    try {
      if (message.method === 'eth_subscription') {
        const { result } = message;
        // P2-FIX: Add null check for eventBatcher
        if (this.eventBatcher) {
          this.eventBatcher.addEvent(result);
        }
      }
    } catch (error) {
      this.logger.error('Failed to process WebSocket message', { error });
    }
  }

  // Common log event processor
  /**
   * Process a log event (public for testing).
   * Uses O(1) lookup via pairsByAddress map.
   */
  async processLogEvent(log: any): Promise<void> {
    // Guard against processing during shutdown (P2 fix: consistent order)
    if (this.isStopping || !this.isRunning) {
      return;
    }

    try {
      // O(1) pair lookup by address
      const pairAddress = log.address?.toLowerCase();
      if (!pairAddress || !this.monitoredPairs.has(pairAddress)) {
        return;
      }

      const pair = this.pairsByAddress.get(pairAddress);
      if (!pair) {
        return;
      }

      // Route based on event topic (using cached signatures)
      const topic = log.topics?.[0];
      if (!topic) {
        return;
      }

      if (topic === EVENT_SIGNATURES.SYNC) {
        await this.processSyncEvent(log, pair);
      } else if (topic === EVENT_SIGNATURES.SWAP_V2) {
        await this.processSwapEvent(log, pair);
      }
    } catch (error) {
      this.logger.error('Failed to process log event', { error, log: log?.address });
    }
  }

  // Common batched event processor
  protected async processBatchedEvents(batch: BatchedEvent): Promise<void> {
    const startTime = performance.now();

    try {
      // Process all events in the batch
      const processPromises = batch.events.map(event => this.processLogEvent(event));
      await Promise.all(processPromises);

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('batch_processing', latency, {
        pairKey: batch.pairKey,
        batchSize: batch.batchSize,
        eventsPerMs: batch.batchSize / (latency / 1000)
      });

    } catch (error) {
      this.logger.error('Failed to process batched events', {
        error,
        pairKey: batch.pairKey,
        batchSize: batch.batchSize
      });
    }
  }


  // Common price calculation
  protected calculatePrice(pair: Pair): number {
    try {
      const reserve0 = parseFloat(pair.reserve0 || '0');
      const reserve1 = parseFloat(pair.reserve1 || '0');

      // Return 0 for invalid reserves (zero, NaN, or infinite values)
      if (reserve0 === 0 || reserve1 === 0 || isNaN(reserve0) || isNaN(reserve1)) {
        return 0;
      }

      // Price of token1 in terms of token0
      return reserve0 / reserve1;
    } catch (error) {
      this.logger.error('Failed to calculate price', { error, pair });
      return 0;
    }
  }

  /**
   * Create a snapshot of pair data for thread-safe arbitrage detection.
   * This captures reserve values at a point in time to avoid race conditions.
   * @param pair The pair to snapshot
   * @returns PairSnapshot with immutable reserve values, or null if reserves not available
   */
  protected createPairSnapshot(pair: Pair): PairSnapshot | null {
    // Capture reserves atomically (both at same instant)
    const reserve0 = (pair as any).reserve0;
    const reserve1 = (pair as any).reserve1;

    // Skip pairs without initialized reserves
    if (!reserve0 || !reserve1) {
      return null;
    }

    return {
      address: pair.address,
      dex: pair.dex,
      token0: pair.token0,
      token1: pair.token1,
      reserve0: reserve0,
      reserve1: reserve1,
      // BUG FIX: Fallback should be in percentage (0.003 = 0.3%), not basis points (30)
      // Pair.fee is already converted from basis points to percentage during initialization
      // S2.2.3 FIX: Use ?? instead of || to correctly handle fee: 0
      fee: pair.fee ?? 0.003
    };
  }

  /**
   * Calculate price from a snapshot (thread-safe).
   * Uses pre-captured reserve values that won't change during calculation.
   */
  protected calculatePriceFromSnapshot(snapshot: PairSnapshot): number {
    try {
      const reserve0 = parseFloat(snapshot.reserve0);
      const reserve1 = parseFloat(snapshot.reserve1);

      if (reserve0 === 0 || reserve1 === 0 || isNaN(reserve0) || isNaN(reserve1)) {
        return 0;
      }

      return reserve0 / reserve1;
    } catch (error) {
      this.logger.error('Failed to calculate price from snapshot', { error });
      return 0;
    }
  }

  /**
   * Create snapshots of all pairs for thread-safe iteration.
   * Should be called at the start of arbitrage detection to capture
   * a consistent view of all pair reserves.
   */
  protected createPairsSnapshot(): Map<string, PairSnapshot> {
    const snapshots = new Map<string, PairSnapshot>();

    for (const [key, pair] of this.pairs.entries()) {
      const snapshot = this.createPairSnapshot(pair);
      if (snapshot) {
        snapshots.set(key, snapshot);
      }
    }

    return snapshots;
  }

  // Common publishing methods
  // Updated 2025-01-11: ADR-002 compliant - Redis Streams ONLY (no Pub/Sub fallback)

  protected async publishPriceUpdate(update: PriceUpdate): Promise<void> {
    // Streams required per ADR-002 - fail fast if not available
    if (!this.priceUpdateBatcher) {
      throw new Error('Price update batcher not initialized - Streams required per ADR-002');
    }

    const message: MessageEvent = {
      type: 'price-update',
      data: update,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (ADR-002 - no fallback)
    this.priceUpdateBatcher.add(message);
  }

  protected async publishSwapEvent(swapEvent: SwapEvent): Promise<void> {
    // Apply Smart Swap Event Filter (S1.2) before publishing
    // This filters dust transactions, deduplicates, and triggers whale alerts
    if (this.swapEventFilter) {
      const filterResult = this.swapEventFilter.processEvent(swapEvent);

      // If filtered out, don't publish to downstream consumers
      if (!filterResult.passed) {
        this.logger.debug('Swap event filtered', {
          reason: filterResult.filterReason,
          txHash: swapEvent.transactionHash
        });
        return; // Event filtered - don't publish
      }
    }

    // Streams required per ADR-002 - fail fast if not available
    if (!this.swapEventBatcher) {
      throw new Error('Swap event batcher not initialized - Streams required per ADR-002');
    }

    const message: MessageEvent = {
      type: 'swap-event',
      data: swapEvent,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (ADR-002 - no fallback)
    this.swapEventBatcher.add(message);
  }

  protected async publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    // Streams required per ADR-002 - fail fast if not available
    if (!this.streamsClient) {
      throw new Error('Streams client not initialized - Streams required per ADR-002');
    }

    // P2-4 FIX: Redis-based deduplication for multi-instance deployments
    // Use SET NX with TTL to atomically check if opportunity was already published
    const dedupKey = `opp:dedup:${opportunity.id}`;
    const DEDUP_TTL_SECONDS = 30; // 30 second deduplication window

    try {
      const redis = await this.redis;
      if (!redis) {
        // Redis not initialized, skip deduplication
        this.logger.debug('Redis not available for dedup check');
      } else {
        // setNx returns true if key was set (first to publish), false if exists (duplicate)
        const isFirstPublisher = await redis.setNx(dedupKey, '1', DEDUP_TTL_SECONDS);

        if (!isFirstPublisher) {
          this.logger.debug('Duplicate opportunity filtered', { id: opportunity.id });
          return; // Another instance already published this opportunity
        }
      }
    } catch (error) {
      // If Redis fails, log warning but still publish to avoid missing opportunities
      // This degrades to in-process dedup only, which may cause duplicates across instances
      this.logger.warn('Redis dedup check failed, publishing anyway', {
        id: opportunity.id,
        error: (error as Error).message
      });
    }

    const message: MessageEvent = {
      type: 'arbitrage-opportunity',
      data: opportunity,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Arbitrage opportunities are high-priority - publish directly to stream (no batching)
    await this.streamsClient.xadd(
      RedisStreamsClient.STREAMS.OPPORTUNITIES,
      message
    );
  }

  protected async publishWhaleTransaction(whaleTransaction: any): Promise<void> {
    // Streams required per ADR-002 - fail fast if not available
    if (!this.whaleAlertBatcher) {
      throw new Error('Whale alert batcher not initialized - Streams required per ADR-002');
    }

    const message: MessageEvent = {
      type: 'whale-transaction',
      data: whaleTransaction,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (ADR-002 - no fallback)
    this.whaleAlertBatcher.add(message);
  }

  // Publish whale alert from SwapEventFilter (S1.2)
  protected async publishWhaleAlert(alert: WhaleAlert): Promise<void> {
    // Streams required per ADR-002 - fail fast if not available
    if (!this.whaleAlertBatcher) {
      throw new Error('Whale alert batcher not initialized - Streams required per ADR-002');
    }

    const message: MessageEvent = {
      type: 'whale-alert',
      data: alert,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (ADR-002 - no fallback)
    this.whaleAlertBatcher.add(message);
  }

  // Publish volume aggregate from SwapEventFilter (S1.2)
  protected async publishVolumeAggregate(aggregate: VolumeAggregate): Promise<void> {
    // Streams required per ADR-002 - fail fast if not available
    if (!this.streamsClient) {
      throw new Error('Streams client not initialized - Streams required per ADR-002');
    }

    const message: MessageEvent = {
      type: 'volume-aggregate',
      data: aggregate,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams directly (ADR-002 - no fallback)
    await this.streamsClient.xadd(
      RedisStreamsClient.STREAMS.VOLUME_AGGREGATES,
      message
    );
  }

  // Cleanup method for stream batchers
  // Uses Promise.allSettled for parallel, resilient cleanup (one failure doesn't block others)
  protected async cleanupStreamBatchers(): Promise<void> {
    const batchers = [
      { name: 'priceUpdate', batcher: this.priceUpdateBatcher },
      { name: 'swapEvent', batcher: this.swapEventBatcher },
      { name: 'whaleAlert', batcher: this.whaleAlertBatcher }
    ];

    // Use Promise.allSettled for parallel cleanup - one failure doesn't block others
    const cleanupPromises = batchers
      .filter(({ batcher }) => batcher !== null)
      .map(async ({ name, batcher }) => {
        // destroy() flushes remaining messages internally before cleanup
        await batcher!.destroy();
        this.logger.debug(`Cleaned up ${name} batcher`);
        return name;
      });

    const results = await Promise.allSettled(cleanupPromises);

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const batcherName = batchers.filter(b => b.batcher !== null)[index]?.name || 'unknown';
        this.logger.warn(`Failed to cleanup ${batcherName} batcher`, { error: result.reason });
      }
    });

    // Always null out references regardless of cleanup success
    this.priceUpdateBatcher = null;
    this.swapEventBatcher = null;
    this.whaleAlertBatcher = null;

    // Cleanup SwapEventFilter (S1.2)
    if (this.swapEventFilter) {
      try {
        this.swapEventFilter.destroy();
        this.logger.debug('Cleaned up swap event filter');
      } catch (error) {
        this.logger.warn('Failed to cleanup swap event filter', { error });
      }
      this.swapEventFilter = null;
    }
  }

  // Get batcher statistics for monitoring
  protected getBatcherStats(): Record<string, any> {
    return {
      priceUpdates: this.priceUpdateBatcher?.getStats() || null,
      swapEvents: this.swapEventBatcher?.getStats() || null,
      whaleAlerts: this.whaleAlertBatcher?.getStats() || null,
      streamsEnabled: true, // Always true per ADR-002
      // Smart Swap Event Filter stats (S1.2)
      swapEventFilter: this.swapEventFilter?.getStats() || null
    };
  }

  protected getStats(): any {
    return {
      chain: this.chain,
      pairs: this.pairs.size,
      monitoredPairs: this.monitoredPairs.size,
      dexes: this.dexes.filter(d => d.enabled).length,
      tokens: this.tokens.length,
      isRunning: this.isRunning,
      config: this.config,
      // Include stream/batcher stats (ADR-002)
      streaming: this.getBatcherStats()
    };
  }

  // Utility methods

  /**
   * Publish with retry and exponential backoff (P0-6 fix).
   * Prevents silent failures for critical alerts like whale transactions.
   */
  protected async publishWithRetry(
    publishFn: () => Promise<void>,
    operationName: string,
    maxRetries: number = 3
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await publishFn();
        return; // Success
      } catch (error) {
        lastError = error as Error;

        if (attempt < maxRetries) {
          // Exponential backoff: 100ms, 200ms, 400ms...
          const backoffMs = 100 * Math.pow(2, attempt - 1);
          this.logger.warn(`${operationName} publish failed, retrying in ${backoffMs}ms`, {
            attempt,
            maxRetries,
            error: this.formatError(error)
          });
          await this.sleep(backoffMs);
        }
      }
    }

    // All retries exhausted - log error with full context
    this.logger.error(`${operationName} publish failed after ${maxRetries} attempts`, {
      error: lastError,
      operationName
    });
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected formatError(error: any): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  protected isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  }

  protected normalizeAddress(address: string): string {
    return ethers.getAddress(address);
  }

  // ===========================================================================
  // T1.1: Token Pair Indexing Utilities
  // ===========================================================================

  /**
   * T1.1: Generate normalized token pair key for O(1) index lookup.
   * Tokens are sorted alphabetically (lowercase) to ensure consistent key
   * regardless of token order in the pair.
   * @param token0 First token address
   * @param token1 Second token address
   * @returns Normalized key "tokenA_tokenB" where tokenA < tokenB
   */
  protected getTokenPairKey(token0: string, token1: string): string {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    // Sort alphabetically for consistent key
    return t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;
  }

  /**
   * T1.1: Add a pair to the token pair index.
   * Called during pair initialization to build the index.
   */
  protected addPairToTokenIndex(pair: Pair): void {
    const key = this.getTokenPairKey(pair.token0, pair.token1);
    let pairsForKey = this.pairsByTokens.get(key);
    if (!pairsForKey) {
      pairsForKey = [];
      this.pairsByTokens.set(key, pairsForKey);
    }
    // Avoid duplicates
    if (!pairsForKey.some(p => p.address.toLowerCase() === pair.address.toLowerCase())) {
      pairsForKey.push(pair);
    }
  }

  /**
   * T1.1: Remove a pair from the token pair index.
   */
  protected removePairFromTokenIndex(pair: Pair): void {
    const key = this.getTokenPairKey(pair.token0, pair.token1);
    const pairsForKey = this.pairsByTokens.get(key);
    if (pairsForKey) {
      const index = pairsForKey.findIndex(p => p.address.toLowerCase() === pair.address.toLowerCase());
      if (index !== -1) {
        pairsForKey.splice(index, 1);
      }
      if (pairsForKey.length === 0) {
        this.pairsByTokens.delete(key);
      }
    }
  }

  /**
   * T1.1: Get all pairs for a given token combination.
   * Returns pairs on different DEXs that trade the same tokens.
   * @param token0 First token address
   * @param token1 Second token address
   * @returns Array of pairs trading these tokens (may be empty)
   */
  protected getPairsForTokens(token0: string, token1: string): Pair[] {
    const key = this.getTokenPairKey(token0, token1);
    return this.pairsByTokens.get(key) || [];
  }
}