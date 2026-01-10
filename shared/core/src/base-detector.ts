// Base Detector Class
// Provides common functionality for all blockchain detectors
// Updated 2025-01-10: Migrated from Pub/Sub to Redis Streams (ADR-002, S1.1.4)

import { ethers } from 'ethers';
import {
  RedisClient,
  getRedisClient,
  createLogger,
  getPerformanceLogger,
  PerformanceLogger,
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
  VolumeAggregate
} from './index';
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG, EVENT_CONFIG } from '../../config/src';
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

export abstract class BaseDetector {
  protected provider: ethers.JsonRpcProvider;
  protected wsManager: WebSocketManager | null = null;
  protected redis: RedisClient | null = null;
  protected streamsClient: RedisStreamsClient | null = null;
  protected logger: any;
  protected perfLogger: PerformanceLogger;
  protected eventBatcher: any;

  // Stream batchers for efficient Redis command usage (ADR-002)
  protected priceUpdateBatcher: StreamBatcher<any> | null = null;
  protected swapEventBatcher: StreamBatcher<any> | null = null;
  protected whaleAlertBatcher: StreamBatcher<any> | null = null;

  // Smart Swap Event Filter (S1.2)
  protected swapEventFilter: SwapEventFilter | null = null;

  protected dexes: Dex[];
  protected tokens: Token[];
  protected pairs: Map<string, Pair> = new Map();
  protected monitoredPairs: Set<string> = new Set();
  protected isRunning = false;

  // Stop/start synchronization (race condition fix)
  // stopPromise ensures start() waits for stop() to fully complete
  protected stopPromise: Promise<void> | null = null;

  // Feature flag for gradual migration (default: use streams)
  protected useStreams = true;

  protected config: DetectorConfig;
  protected chain: string;

  constructor(config: DetectorConfig) {
    this.config = config;
    this.chain = config.chain;

    this.logger = createLogger(`${this.chain}-detector`);
    this.perfLogger = getPerformanceLogger(`${this.chain}-detector`);

    // Initialize chain-specific data
    this.dexes = DEXES[this.chain as keyof typeof DEXES] || [];
    this.tokens = CORE_TOKENS[this.chain as keyof typeof CORE_TOKENS] || [];

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
        maxWaitTime: config.batchTimeout || 30,
        enableDeduplication: true,
        enablePrioritization: true
      },
      (batch: BatchedEvent) => this.processBatchedEvents(batch)
    );

    // Initialize WebSocket manager
    const wsUrl = config.wsUrl || chainConfig.wsUrl;
    this.wsManager = new WebSocketManager({
      url: wsUrl,
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
      // Initialize legacy Redis Pub/Sub client (for backward compatibility)
      this.redis = await getRedisClient() as RedisClient;
      this.logger.debug('Redis Pub/Sub client initialized');

      // Initialize Redis Streams client (ADR-002)
      if (this.useStreams) {
        try {
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

          // Set up whale alert handler to publish to stream
          this.swapEventFilter.onWhaleAlert((alert: WhaleAlert) => {
            this.publishWhaleAlert(alert).catch(err => {
              this.logger.error('Failed to publish whale alert', { error: err });
            });
          });

          // Set up volume aggregate handler to publish to stream
          this.swapEventFilter.onVolumeAggregate((aggregate: VolumeAggregate) => {
            this.publishVolumeAggregate(aggregate).catch(err => {
              this.logger.error('Failed to publish volume aggregate', { error: err });
            });
          });

          this.logger.info('Smart Swap Event Filter initialized', {
            minUsdValue: 10,
            whaleThreshold: 50000
          });
        } catch (streamsError) {
          this.logger.warn('Failed to initialize Redis Streams, falling back to Pub/Sub', {
            error: streamsError
          });
          this.useStreams = false;
        }
      }
    } catch (error) {
      this.logger.error('Failed to initialize Redis client', { error });
      throw new Error('Redis initialization failed');
    }
  }

  // Abstract methods that must be implemented by subclasses
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract getHealth(): Promise<any>;
  protected abstract processSyncEvent(log: any, pair: Pair): Promise<void>;
  protected abstract processSwapEvent(log: any, pair: Pair): Promise<void>;
  protected abstract checkIntraDexArbitrage(pair: Pair): Promise<void>;
  protected abstract checkWhaleActivity(swapEvent: SwapEvent): Promise<void>;
  protected abstract estimateUsdValue(pair: Pair, amount0In: string, amount1In: string, amount0Out: string, amount1Out: string): Promise<number>;
  protected abstract calculatePriceImpact(swapEvent: SwapEvent): Promise<number>;

  // Common functionality
  protected async initializePairs(): Promise<void> {
    this.logger.info(`Initializing ${this.chain} trading pairs`);

    const pairsProcessed = new Set<string>();

    for (const dex of this.dexes) {
      if (!dex.enabled) continue;

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
              const pair: Pair = {
                name: `${token0.symbol}/${token1.symbol}`,
                address: pairAddress,
                token0: token0.address,
                token1: token1.address,
                dex: dex.name,
                fee: dex.fee || 0.003 // Default 0.3% fee
              };

              const pairKey = `${dex.name}_${pair.name}`;
              this.pairs.set(pairKey, pair);
              this.monitoredPairs.add(pairKey);
              pairsProcessed.add(pairKey);

              this.logger.debug(`Added pair: ${pair.name} on ${dex.name}`, {
                address: pairAddress,
                pairKey
              });
            }
          } catch (error) {
            this.logger.warn(`Failed to get pair address for ${token0.symbol}/${token1.symbol} on ${dex.name}`, {
              error: error.message
            });
          }
        }
      }
    }

    this.logger.info(`Initialized ${this.pairs.size} trading pairs for ${this.chain}`);
  }

  protected async getPairAddress(dex: Dex, token0: Token, token1: Token): Promise<string | null> {
    try {
      // This is a placeholder - actual implementation depends on DEX factory contract
      // Each DEX has different factory contracts and methods

      if (dex.name === 'uniswap_v3' || dex.name === 'pancakeswap') {
        // Mock implementation - replace with actual contract calls
        return `0x${Math.random().toString(16).substr(2, 40)}`; // Mock address
      }

      return null;
    } catch (error) {
      this.logger.error(`Error getting pair address for ${dex.name}`, { error });
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
      const priceDiff = Math.abs(sourceUpdate.price0 - targetUpdate.price0);
      const avgPrice = (sourceUpdate.price0 + targetUpdate.price0) / 2;
      const percentageDiff = (priceDiff / avgPrice) * 100;

      // Apply fees and slippage
      const totalFees = ARBITRAGE_CONFIG.feePercentage * 2; // Round trip
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
        estimatedProfit: (ARBITRAGE_CONFIG.defaultAmount * netPercentage) / 100,
        gasCost: ARBITRAGE_CONFIG.estimatedGasCost,
        netProfit: ((ARBITRAGE_CONFIG.defaultAmount * netPercentage) / 100) - ARBITRAGE_CONFIG.estimatedGasCost,
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
    if (opportunity.netProfit < ARBITRAGE_CONFIG.minProfitThreshold) {
      return false;
    }

    if (opportunity.confidence < ARBITRAGE_CONFIG.minConfidenceThreshold) {
      return false;
    }

    if (opportunity.expiresAt < Date.now()) {
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
        // Add event to batcher for optimized processing
        this.eventBatcher.addEvent(result);
      }
    } catch (error) {
      this.logger.error('Failed to process WebSocket message', { error });
    }
  }

  // Common log event processor
  protected async processLogEvent(log: any): Promise<void> {
    const startTime = performance.now();

    try {
      // Find the pair this log belongs to
      const pair = Array.from(this.pairs.values()).find(p => p.address.toLowerCase() === log.address.toLowerCase());
      if (!pair) {
        return; // Not a monitored pair
      }

      // Decode the event based on topics
      if (log.topics[0] === '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1') {
        // Sync event (reserve update)
        await this.processSyncEvent(log, pair);
      } else if (log.topics[0] === '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822') {
        // Swap V2 event (trade)
        await this.processSwapEvent(log, pair);
      }

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('log_processing', latency, {
        pair: `${pair.token0.symbol}-${pair.token1.symbol}`,
        dex: pair.dex.name,
        eventType: log.topics[0]
      });

    } catch (error) {
      this.logger.error('Failed to process log event', { error, log });
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

      if (reserve0 === 0 || reserve1 === 0) return 0;

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
      fee: pair.fee || 30
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
  // Updated 2025-01-10: Migrated to Redis Streams with batching (ADR-002, S1.1.4)

  protected async publishPriceUpdate(update: PriceUpdate): Promise<void> {
    const message: MessageEvent = {
      type: 'price-update',
      data: update,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (primary) or fallback to Pub/Sub
    if (this.useStreams && this.priceUpdateBatcher) {
      try {
        this.priceUpdateBatcher.add(message);
      } catch (error) {
        this.logger.warn('Stream batcher failed, falling back to Pub/Sub', { error });
        if (this.redis) {
          await this.redis.publish('price-updates', message);
        }
      }
    } else if (this.redis) {
      await this.redis.publish('price-updates', message);
    }
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

    const message: MessageEvent = {
      type: 'swap-event',
      data: swapEvent,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (primary) or fallback to Pub/Sub
    if (this.useStreams && this.swapEventBatcher) {
      try {
        this.swapEventBatcher.add(message);
      } catch (error) {
        this.logger.warn('Stream batcher failed, falling back to Pub/Sub', { error });
        if (this.redis) {
          await this.redis.publish('swap-events', message);
        }
      }
    } else if (this.redis) {
      await this.redis.publish('swap-events', message);
    }
  }

  protected async publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    const message: MessageEvent = {
      type: 'arbitrage-opportunity',
      data: opportunity,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Arbitrage opportunities are high-priority - publish directly to stream (no batching)
    if (this.useStreams && this.streamsClient) {
      try {
        await this.streamsClient.xadd(
          RedisStreamsClient.STREAMS.OPPORTUNITIES,
          message
        );
      } catch (error) {
        this.logger.warn('Stream publish failed, falling back to Pub/Sub', { error });
        if (this.redis) {
          await this.redis.publish('arbitrage-opportunities', message);
        }
      }
    } else if (this.redis) {
      await this.redis.publish('arbitrage-opportunities', message);
    }
  }

  protected async publishWhaleTransaction(whaleTransaction: any): Promise<void> {
    const message: MessageEvent = {
      type: 'whale-transaction',
      data: whaleTransaction,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (primary) or fallback to Pub/Sub
    if (this.useStreams && this.whaleAlertBatcher) {
      try {
        this.whaleAlertBatcher.add(message);
      } catch (error) {
        this.logger.warn('Stream batcher failed, falling back to Pub/Sub', { error });
        if (this.redis) {
          await this.redis.publish('whale-transactions', message);
        }
      }
    } else if (this.redis) {
      await this.redis.publish('whale-transactions', message);
    }
  }

  // Publish whale alert from SwapEventFilter (S1.2)
  protected async publishWhaleAlert(alert: WhaleAlert): Promise<void> {
    const message: MessageEvent = {
      type: 'whale-alert',
      data: alert,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams with batching (primary) or fallback to Pub/Sub
    if (this.useStreams && this.whaleAlertBatcher) {
      try {
        this.whaleAlertBatcher.add(message);
      } catch (error) {
        this.logger.warn('Stream batcher failed, falling back to Pub/Sub', { error });
        if (this.redis) {
          await this.redis.publish('whale-alerts', message);
        }
      }
    } else if (this.redis) {
      await this.redis.publish('whale-alerts', message);
    }
  }

  // Publish volume aggregate from SwapEventFilter (S1.2)
  protected async publishVolumeAggregate(aggregate: VolumeAggregate): Promise<void> {
    const message: MessageEvent = {
      type: 'volume-aggregate',
      data: aggregate,
      timestamp: Date.now(),
      source: `${this.chain}-detector`
    };

    // Use Redis Streams (primary) or fallback to Pub/Sub
    if (this.useStreams && this.streamsClient) {
      try {
        await this.streamsClient.xadd(
          RedisStreamsClient.STREAMS.VOLUME_AGGREGATES,
          message
        );
      } catch (error) {
        this.logger.warn('Stream publish failed, falling back to Pub/Sub', { error });
        if (this.redis) {
          await this.redis.publish('volume-aggregates', message);
        }
      }
    } else if (this.redis) {
      await this.redis.publish('volume-aggregates', message);
    }
  }

  // Cleanup method for stream batchers
  protected async cleanupStreamBatchers(): Promise<void> {
    const batchers = [
      { name: 'priceUpdate', batcher: this.priceUpdateBatcher },
      { name: 'swapEvent', batcher: this.swapEventBatcher },
      { name: 'whaleAlert', batcher: this.whaleAlertBatcher }
    ];

    for (const { name, batcher } of batchers) {
      if (batcher) {
        try {
          // destroy() flushes remaining messages internally before cleanup
          await batcher.destroy();
          this.logger.debug(`Cleaned up ${name} batcher`);
        } catch (error) {
          this.logger.warn(`Failed to cleanup ${name} batcher`, { error });
        }
      }
    }

    this.priceUpdateBatcher = null;
    this.swapEventBatcher = null;
    this.whaleAlertBatcher = null;

    // Cleanup SwapEventFilter (S1.2)
    if (this.swapEventFilter) {
      this.swapEventFilter.destroy();
      this.swapEventFilter = null;
      this.logger.debug('Cleaned up swap event filter');
    }
  }

  // Get batcher statistics for monitoring
  protected getBatcherStats(): Record<string, any> {
    return {
      priceUpdates: this.priceUpdateBatcher?.getStats() || null,
      swapEvents: this.swapEventBatcher?.getStats() || null,
      whaleAlerts: this.whaleAlertBatcher?.getStats() || null,
      useStreams: this.useStreams,
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
}