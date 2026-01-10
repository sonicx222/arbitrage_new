/**
 * Cross-Chain Arbitrage Detector Service
 *
 * Detects arbitrage opportunities across multiple chains by monitoring
 * price discrepancies and accounting for bridge costs.
 *
 * Uses Redis Streams for event consumption (ADR-002 compliant).
 * Uses ServiceStateManager for lifecycle management.
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
  PriceOracle
} from '../../../shared/core/src';
import { ARBITRAGE_CONFIG } from '../../../shared/config/src';
import {
  PriceUpdate,
  ArbitrageOpportunity,
  WhaleTransaction,
  CrossChainBridge
} from '../../../shared/types/src';
import { BridgeLatencyPredictor } from './bridge-predictor';

// =============================================================================
// Types
// =============================================================================

interface PriceData {
  [chain: string]: {
    [dex: string]: {
      [pairKey: string]: PriceUpdate
    }
  }
}

interface CrossChainOpportunity {
  token: string;
  sourceChain: string;
  sourceDex: string;
  sourcePrice: number;
  targetChain: string;
  targetDex: string;
  targetPrice: number;
  priceDiff: number;
  percentageDiff: number;
  estimatedProfit: number;
  bridgeCost?: number;
  netProfit: number;
  confidence: number;
}

interface MLPredictor {
  predictPriceMovement: () => Promise<{ direction: number; confidence: number }>;
  predictOpportunity: () => Promise<{ confidence: number; expectedProfit: number }>;
}

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

  private priceData: PriceData = {};
  private opportunitiesCache: Map<string, CrossChainOpportunity> = new Map();
  private bridgePredictor: BridgeLatencyPredictor;
  private mlPredictor: MLPredictor | null = null;

  // Consumer group configuration
  private readonly consumerGroups: ConsumerGroupConfig[];
  private readonly instanceId: string;

  // Intervals
  private opportunityDetectionInterval: NodeJS.Timeout | null = null;
  private healthMonitoringInterval: NodeJS.Timeout | null = null;
  private streamConsumerInterval: NodeJS.Timeout | null = null;
  private cacheCleanupInterval: NodeJS.Timeout | null = null;

  // Counter for deterministic cleanup (replaces random sampling)
  private priceUpdateCounter = 0;
  private readonly CLEANUP_FREQUENCY = 100; // Cleanup every 100 price updates

  constructor() {
    this.perfLogger = getPerformanceLogger('cross-chain-detector');
    this.bridgePredictor = new BridgeLatencyPredictor();

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
      }
    ];
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(): Promise<void> {
    const result = await this.stateManager.executeStart(async () => {
      this.logger.info('Starting Cross-Chain Detector Service', {
        instanceId: this.instanceId
      });

      // Initialize Redis clients
      this.redis = await getRedisClient();
      this.streamsClient = await getRedisStreamsClient();

      // Initialize price oracle
      this.priceOracle = await getPriceOracle();

      // Create consumer groups for Redis Streams
      await this.createConsumerGroups();

      // Initialize ML predictor (placeholder)
      await this.initializeMLPredictor();

      // Start stream consumers
      this.startStreamConsumers();

      // Start opportunity detection loop
      this.startOpportunityDetection();

      // Start health monitoring
      this.startHealthMonitoring();

      this.logger.info('Cross-Chain Detector Service started successfully');
    });

    if (!result.success) {
      this.logger.error('Failed to start Cross-Chain Detector Service', {
        error: result.error
      });
      throw result.error;
    }
  }

  async stop(): Promise<void> {
    const result = await this.stateManager.executeStop(async () => {
      this.logger.info('Stopping Cross-Chain Detector Service');

      // Clear all intervals
      this.clearAllIntervals();

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

      // Clear caches
      this.priceData = {};
      this.opportunitiesCache.clear();

      this.logger.info('Cross-Chain Detector Service stopped');
    });

    if (!result.success) {
      this.logger.error('Error stopping Cross-Chain Detector Service', {
        error: result.error
      });
    }
  }

  private clearAllIntervals(): void {
    if (this.opportunityDetectionInterval) {
      clearInterval(this.opportunityDetectionInterval);
      this.opportunityDetectionInterval = null;
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
    // Poll streams every 100ms
    this.streamConsumerInterval = setInterval(async () => {
      if (!this.stateManager.isRunning() || !this.streamsClient) return;

      try {
        await Promise.all([
          this.consumePriceUpdatesStream(),
          this.consumeWhaleAlertsStream()
        ]);
      } catch (error) {
        this.logger.error('Stream consumer error', { error });
      }
    }, 100);
  }

  private async consumePriceUpdatesStream(): Promise<void> {
    if (!this.streamsClient) return;

    const config = this.consumerGroups.find(
      c => c.streamName === RedisStreamsClient.STREAMS.PRICE_UPDATES
    );
    if (!config) return;

    try {
      const messages = await this.streamsClient.xreadgroup(config, {
        count: 50,
        block: 0,
        startId: '>'
      });

      for (const message of messages) {
        this.handlePriceUpdate(message.data as PriceUpdate);
        await this.streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        this.logger.error('Error consuming price updates stream', { error });
      }
    }
  }

  private async consumeWhaleAlertsStream(): Promise<void> {
    if (!this.streamsClient) return;

    const config = this.consumerGroups.find(
      c => c.streamName === RedisStreamsClient.STREAMS.WHALE_ALERTS
    );
    if (!config) return;

    try {
      const messages = await this.streamsClient.xreadgroup(config, {
        count: 10,
        block: 0,
        startId: '>'
      });

      for (const message of messages) {
        this.handleWhaleTransaction(message.data as WhaleTransaction);
        await this.streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        this.logger.error('Error consuming whale alerts stream', { error });
      }
    }
  }

  // ===========================================================================
  // Price Update Handling
  // ===========================================================================

  private handlePriceUpdate(update: PriceUpdate): void {
    try {
      // Update price data structure
      if (!this.priceData[update.chain]) {
        this.priceData[update.chain] = {};
      }
      if (!this.priceData[update.chain][update.dex]) {
        this.priceData[update.chain][update.dex] = {};
      }

      this.priceData[update.chain][update.dex][update.pairKey] = update;

      // Deterministic cleanup instead of random sampling (fixes P0 issue)
      this.priceUpdateCounter++;
      if (this.priceUpdateCounter >= this.CLEANUP_FREQUENCY) {
        this.priceUpdateCounter = 0;
        this.cleanOldPriceData();
        this.cleanOldOpportunityCache();
      }

      this.logger.debug(`Updated price: ${update.chain}/${update.dex}/${update.pairKey} = ${update.price}`);
    } catch (error) {
      this.logger.error('Failed to handle price update', { error });
    }
  }

  private handleWhaleTransaction(whaleTx: WhaleTransaction): void {
    try {
      // Analyze whale transaction for cross-chain implications
      this.analyzeWhaleImpact(whaleTx);
    } catch (error) {
      this.logger.error('Failed to handle whale transaction', { error });
    }
  }

  private cleanOldPriceData(): void {
    const cutoffTime = Date.now() - (5 * 60 * 1000); // 5 minutes ago

    for (const chain of Object.keys(this.priceData)) {
      for (const dex of Object.keys(this.priceData[chain])) {
        for (const pairKey of Object.keys(this.priceData[chain][dex])) {
          const update = this.priceData[chain][dex][pairKey];
          if (update.timestamp < cutoffTime) {
            delete this.priceData[chain][dex][pairKey];
          }
        }
        // Clean empty dex objects
        if (Object.keys(this.priceData[chain][dex]).length === 0) {
          delete this.priceData[chain][dex];
        }
      }
      // Clean empty chain objects
      if (Object.keys(this.priceData[chain]).length === 0) {
        delete this.priceData[chain];
      }
    }
  }

  /**
   * Clean old entries from opportunity cache to prevent memory leak (P0 fix)
   * Keeps cache bounded to prevent unbounded growth
   */
  private cleanOldOpportunityCache(): void {
    const maxCacheSize = 1000; // Hard limit on cache size
    const maxAgeMs = 10 * 60 * 1000; // 10 minutes TTL
    const now = Date.now();

    // First pass: remove old entries
    for (const [id, opp] of this.opportunitiesCache) {
      // Extract timestamp from ID (format: cross-chain-{timestamp}-{random})
      const idParts = id.split('-');
      if (idParts.length >= 3) {
        const timestamp = parseInt(idParts[2], 10);
        if (!isNaN(timestamp) && (now - timestamp) > maxAgeMs) {
          this.opportunitiesCache.delete(id);
        }
      }
    }

    // Second pass: if still over limit, remove oldest entries
    if (this.opportunitiesCache.size > maxCacheSize) {
      const entries = Array.from(this.opportunitiesCache.entries());
      // Sort by timestamp in ID (oldest first)
      entries.sort((a, b) => {
        const tsA = parseInt(a[0].split('-')[2], 10) || 0;
        const tsB = parseInt(b[0].split('-')[2], 10) || 0;
        return tsA - tsB;
      });

      // Remove oldest entries to get under limit
      const toRemove = entries.slice(0, entries.length - maxCacheSize);
      for (const [id] of toRemove) {
        this.opportunitiesCache.delete(id);
      }

      this.logger.debug('Trimmed opportunity cache', {
        removed: toRemove.length,
        remaining: this.opportunitiesCache.size
      });
    }
  }

  /**
   * Create atomic snapshot of priceData for thread-safe detection (P1 fix)
   * Prevents race conditions where priceData is modified during detection
   */
  private createPriceDataSnapshot(): PriceData {
    const snapshot: PriceData = {};

    for (const chain of Object.keys(this.priceData)) {
      snapshot[chain] = {};
      for (const dex of Object.keys(this.priceData[chain])) {
        snapshot[chain][dex] = {};
        for (const pairKey of Object.keys(this.priceData[chain][dex])) {
          // Deep copy the PriceUpdate object
          const original = this.priceData[chain][dex][pairKey];
          snapshot[chain][dex][pairKey] = { ...original };
        }
      }
    }

    return snapshot;
  }

  // ===========================================================================
  // ML Predictor
  // ===========================================================================

  private async initializeMLPredictor(): Promise<void> {
    // Placeholder for ML predictor initialization
    // Will be implemented in Phase 3 with TensorFlow.js
    this.mlPredictor = {
      predictPriceMovement: async () => ({ direction: 0, confidence: 0.5 }),
      predictOpportunity: async () => ({ confidence: 0.5, expectedProfit: 0 })
    };
    this.logger.info('ML predictor initialized (placeholder)');
  }

  // ===========================================================================
  // Opportunity Detection
  // ===========================================================================

  private startOpportunityDetection(): void {
    // Run opportunity detection every 100ms for real-time analysis
    this.opportunityDetectionInterval = setInterval(() => {
      if (this.stateManager.isRunning()) {
        this.detectCrossChainOpportunities();
      }
    }, 100);
  }

  private detectCrossChainOpportunities(): void {
    const startTime = performance.now();

    try {
      // P1 fix: Take atomic snapshot of priceData to prevent race conditions
      // during concurrent modifications by handlePriceUpdate
      const priceSnapshot = this.createPriceDataSnapshot();

      const opportunities: CrossChainOpportunity[] = [];

      // Get all unique token pairs across chains (using snapshot)
      const tokenPairs = this.getAllTokenPairsFromSnapshot(priceSnapshot);

      for (const tokenPair of tokenPairs) {
        const chainPrices = this.getPricesForTokenPairFromSnapshot(tokenPair, priceSnapshot);

        if (chainPrices.length >= 2) {
          const pairOpportunities = this.findArbitrageInPair(chainPrices);
          opportunities.push(...pairOpportunities);
        }
      }

      // Filter and rank opportunities
      const validOpportunities = this.filterValidOpportunities(opportunities);

      // Publish opportunities
      for (const opportunity of validOpportunities) {
        this.publishArbitrageOpportunity(opportunity);
      }

      const latency = performance.now() - startTime;
      this.perfLogger.logEventLatency('cross_chain_detection', latency, {
        opportunitiesFound: validOpportunities.length,
        totalPairs: tokenPairs.length
      });
    } catch (error) {
      this.logger.error('Failed to detect cross-chain opportunities', { error });
    }
  }

  private getAllTokenPairsFromSnapshot(priceData: PriceData): string[] {
    const tokenPairs = new Set<string>();

    for (const chain of Object.keys(priceData)) {
      for (const dex of Object.keys(priceData[chain])) {
        for (const pairKey of Object.keys(priceData[chain][dex])) {
          // Extract token pair from pairKey (format: DEX_TOKEN1_TOKEN2)
          const tokens = pairKey.split('_').slice(1).join('_');
          tokenPairs.add(tokens);
        }
      }
    }

    return Array.from(tokenPairs);
  }

  private getPricesForTokenPairFromSnapshot(
    tokenPair: string,
    priceData: PriceData
  ): Array<{chain: string, dex: string, price: number, update: PriceUpdate}> {
    const prices: Array<{chain: string, dex: string, price: number, update: PriceUpdate}> = [];

    for (const chain of Object.keys(priceData)) {
      for (const dex of Object.keys(priceData[chain])) {
        for (const pairKey of Object.keys(priceData[chain][dex])) {
          const tokens = pairKey.split('_').slice(1).join('_');
          if (tokens === tokenPair) {
            const update = priceData[chain][dex][pairKey];
            prices.push({
              chain,
              dex,
              price: update.price,
              update
            });
          }
        }
      }
    }

    return prices;
  }

  private findArbitrageInPair(chainPrices: Array<{chain: string, dex: string, price: number, update: PriceUpdate}>): CrossChainOpportunity[] {
    const opportunities: CrossChainOpportunity[] = [];

    // Sort by price to find best buy/sell opportunities
    const sortedPrices = chainPrices.sort((a, b) => a.price - b.price);

    if (sortedPrices.length >= 2) {
      const lowestPrice = sortedPrices[0];
      const highestPrice = sortedPrices[sortedPrices.length - 1];

      const priceDiff = highestPrice.price - lowestPrice.price;
      const percentageDiff = (priceDiff / lowestPrice.price) * 100;

      // Check if profitable after estimated bridge costs
      const bridgeCost = this.estimateBridgeCost(lowestPrice.chain, highestPrice.chain, lowestPrice.update);
      const netProfit = priceDiff - bridgeCost;

      if (netProfit > ARBITRAGE_CONFIG.minProfitPercentage * lowestPrice.price) {
        const opportunity: CrossChainOpportunity = {
          token: this.extractTokenFromPair(lowestPrice.update.pairKey),
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
          confidence: this.calculateConfidence(lowestPrice, highestPrice)
        };

        opportunities.push(opportunity);
      }
    }

    return opportunities;
  }

  private extractTokenFromPair(pairKey: string): string {
    // Extract token from pair key (e.g., "uniswap_v3_WETH_USDT" -> "WETH/USDT")
    const parts = pairKey.split('_');
    return parts.length >= 4 ? `${parts[2]}/${parts[3]}` : pairKey;
  }

  private estimateBridgeCost(sourceChain: string, targetChain: string, tokenUpdate: PriceUpdate): number {
    // Use bridge predictor for accurate cost estimation
    const availableBridges = this.bridgePredictor.getAvailableRoutes(sourceChain, targetChain);

    if (availableBridges.length === 0) {
      // Fallback to simplified estimation if no bridge data available
      return this.fallbackBridgeCost(sourceChain, targetChain, tokenUpdate);
    }

    // Get the best bridge prediction
    const tokenAmount = this.extractTokenAmount(tokenUpdate);
    const prediction = this.bridgePredictor.predictOptimalBridge(
      sourceChain,
      targetChain,
      tokenAmount,
      'medium' // Default urgency
    );

    if (prediction && prediction.confidence > 0.3) {
      // Convert from wei to token units (simplified conversion)
      return prediction.estimatedCost / 1e18;
    }

    // Fallback if prediction confidence is too low
    return this.fallbackBridgeCost(sourceChain, targetChain, tokenUpdate);
  }

  private fallbackBridgeCost(sourceChain: string, targetChain: string, tokenUpdate: PriceUpdate): number {
    // Simplified bridge cost estimation as fallback
    const baseBridgeCost = 0.001; // $0.001 base cost

    // Chain-specific costs
    const chainMultipliers: {[chain: string]: number} = {
      'ethereum': 2.0,  // More expensive to/from Ethereum
      'bsc': 1.0,
      'arbitrum': 0.5,
      'base': 0.3,
      'polygon': 0.3,
      'optimism': 0.4
    };

    const sourceMultiplier = chainMultipliers[sourceChain] || 1.0;
    const targetMultiplier = chainMultipliers[targetChain] || 1.0;

    // Estimate cost based on token amount
    const estimatedAmount = this.extractTokenAmount(tokenUpdate);
    const bridgeCost = baseBridgeCost * sourceMultiplier * targetMultiplier * estimatedAmount;

    return bridgeCost;
  }

  private extractTokenAmount(tokenUpdate: PriceUpdate): number {
    // Extract estimated token amount from price update
    // This is a simplified estimation - in production would use actual amounts
    // FIX: PriceUpdate has 'price' property, not 'price0'/'price1'
    const price = tokenUpdate.price;
    return price > 0 ? 1.0 / price : 1.0; // Assume $1 worth of tokens
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

  private calculateConfidence(lowPrice: {update: PriceUpdate; price: number}, highPrice: {price: number}): number {
    // Base confidence on price difference and data freshness
    let confidence = Math.min(highPrice.price / lowPrice.price - 1, 0.5) * 2; // 0-1 scale

    // Reduce confidence for stale data
    const agePenalty = Math.max(0, (Date.now() - lowPrice.update.timestamp) / 60000); // 1 minute = 1.0 penalty
    confidence *= Math.max(0.1, 1 - agePenalty * 0.1);

    // ML prediction boost (placeholder)
    if (this.mlPredictor) {
      confidence *= 1.2; // Boost from ML prediction
      confidence = Math.min(confidence, 0.95); // Cap at 95%
    }

    return confidence;
  }

  private filterValidOpportunities(opportunities: CrossChainOpportunity[]): CrossChainOpportunity[] {
    return opportunities
      .filter(opp => opp.netProfit > 0)
      .filter(opp => opp.confidence > ARBITRAGE_CONFIG.confidenceThreshold)
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, 10); // Top 10 opportunities
  }

  private analyzeWhaleImpact(whaleTx: WhaleTransaction): void {
    // Analyze how whale transaction affects cross-chain opportunities
    // This could trigger immediate opportunity detection or adjust confidence scores

    this.logger.debug('Analyzing whale transaction impact', {
      chain: whaleTx.chain,
      usdValue: whaleTx.usdValue,
      direction: whaleTx.direction
    });
  }

  private async publishArbitrageOpportunity(opportunity: CrossChainOpportunity): Promise<void> {
    if (!this.streamsClient) return;

    const arbitrageOpp: ArbitrageOpportunity = {
      id: `cross-chain-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'cross-chain',
      buyDex: opportunity.sourceDex,
      sellDex: opportunity.targetDex,
      buyChain: opportunity.sourceChain,
      sellChain: opportunity.targetChain,
      tokenIn: opportunity.token.split('/')[0],
      tokenOut: opportunity.token.split('/')[1],
      amountIn: '1000000000000000000', // 1 token (placeholder)
      expectedProfit: opportunity.netProfit,
      profitPercentage: opportunity.percentageDiff / 100,
      gasEstimate: 0, // Cross-chain, gas estimated separately
      confidence: opportunity.confidence,
      timestamp: Date.now(),
      blockNumber: 0, // Cross-chain
      bridgeRequired: true,
      bridgeCost: opportunity.bridgeCost
    };

    try {
      // Publish to Redis Streams (ADR-002 compliant)
      await this.streamsClient.xadd(
        RedisStreamsClient.STREAMS.OPPORTUNITIES,
        arbitrageOpp
      );

      this.perfLogger.logArbitrageOpportunity(arbitrageOpp);

      // Cache opportunity to avoid duplicates
      this.opportunitiesCache.set(arbitrageOpp.id, opportunity);
    } catch (error) {
      this.logger.error('Failed to publish arbitrage opportunity', { error });
    }
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  private startHealthMonitoring(): void {
    this.healthMonitoringInterval = setInterval(async () => {
      try {
        const health = {
          service: 'cross-chain-detector',
          status: (this.stateManager.isRunning() ? 'healthy' : 'unhealthy') as 'healthy' | 'degraded' | 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now(),
          chainsMonitored: Object.keys(this.priceData).length,
          opportunitiesCache: this.opportunitiesCache.size,
          mlPredictorActive: !!this.mlPredictor
        };

        // Publish health to stream
        if (this.streamsClient) {
          await this.streamsClient.xadd(
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

  getChainsMonitored(): string[] {
    return Object.keys(this.priceData);
  }

  getOpportunitiesCount(): number {
    return this.opportunitiesCache.size;
  }
}
