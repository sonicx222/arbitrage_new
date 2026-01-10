/**
 * Arbitrum DEX Detector Service
 *
 * Monitors Arbitrum chain DEXes for arbitrage opportunities.
 * Extends BaseDetector for shared functionality including:
 * - Redis Streams integration (ADR-002, S1.1)
 * - Smart Swap Event Filter (S1.2)
 * - L1 Price Matrix support (S1.3)
 *
 * Optimized for Arbitrum's 250ms block time (Ultra-Fast Mode)
 *
 * @see IMPLEMENTATION_PLAN.md S2.2
 * @see shared/core/src/base-detector.ts
 */

import { ethers } from 'ethers';
import { BaseDetector } from '../../../shared/core/src/base-detector';
import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  ARBITRAGE_CONFIG,
  EVENT_CONFIG,
  TOKEN_METADATA,
  EVENT_SIGNATURES,
  DETECTOR_CONFIG
} from '../../../shared/config/src';
import type {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
  Pair
} from '../../../shared/types';

// =============================================================================
// Types
// =============================================================================

interface ArbitrumPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

interface ArbitrumDetectorConfig {
  chain: string;
  enabled: boolean;
  wsUrl: string | undefined;
  rpcUrl: string;
  batchSize: number;
  batchTimeout: number;
  healthCheckInterval: number;
}

// =============================================================================
// Arbitrum Detector Service
// =============================================================================

export class ArbitrumDetectorService extends BaseDetector {
  private readonly arbitrumConfig: ArbitrumDetectorConfig;
  private healthMonitoringInterval: NodeJS.Timeout | null = null;

  // O(1) pair lookup by address (performance optimization)
  private pairsByAddress: Map<string, Pair> = new Map();

  // Race condition protection
  private isStopping = false;

  // Cached token metadata for USD estimation
  private readonly tokenMetadata = TOKEN_METADATA.arbitrum;

  constructor() {
    const config: ArbitrumDetectorConfig = {
      chain: 'arbitrum',
      enabled: true,
      wsUrl: CHAINS.arbitrum?.wsUrl,
      rpcUrl: CHAINS.arbitrum?.rpcUrl || 'https://arb1.arbitrum.io/rpc',
      batchSize: 30, // Higher batch size for ultra-fast processing
      batchTimeout: 20, // Lower timeout for 250ms blocks
      healthCheckInterval: 15000 // More frequent health checks
    };

    super(config);
    this.arbitrumConfig = config;
  }

  // ===========================================================================
  // Configuration Getters
  // ===========================================================================

  getConfig(): ArbitrumDetectorConfig {
    return { ...this.arbitrumConfig };
  }

  getMinProfitThreshold(): number {
    return ARBITRAGE_CONFIG.chainMinProfits.arbitrum || 0.002; // 0.2%
  }

  getSupportedDexes(): string[] {
    return (DEXES.arbitrum || []).map(dex => dex.name);
  }

  getDexConfigs(): Dex[] {
    return DEXES.arbitrum || [];
  }

  getSupportedTokens(): Token[] {
    return CORE_TOKENS.arbitrum || [];
  }

  getPairCount(): number {
    return this.pairs.size;
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  async start(): Promise<void> {
    // Wait for any pending stop operation to complete (race condition fix)
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
      this.logger.info('Starting Arbitrum detector service (Ultra-Fast Mode - 250ms blocks)');

      // Initialize Redis client
      await this.initializeRedis();

      // Initialize pairs from DEX factories
      await this.initializePairs();

      // Connect to WebSocket for real-time events
      await this.connectWebSocket();

      // Subscribe to Sync and Swap events
      await this.subscribeToEvents();

      this.isRunning = true;
      this.logger.info('Arbitrum detector service started successfully', {
        pairs: this.pairs.size,
        dexes: this.dexes.length,
        tokens: this.tokens.length,
        ultraFastMode: true
      });

      // Start health monitoring
      this.startHealthMonitoring();

    } catch (error) {
      this.logger.error('Failed to start Arbitrum detector service', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Guard against double stop
    if (this.isStopping || !this.isRunning) {
      this.logger.debug('Service is already stopped or stopping');
      if (this.stopPromise) {
        return this.stopPromise;
      }
      return;
    }

    this.isStopping = true;
    this.logger.info('Stopping Arbitrum detector service');
    this.isRunning = false;

    this.stopPromise = this.performCleanup();
    await this.stopPromise;
  }

  private async performCleanup(): Promise<void> {
    try {
      // Stop health monitoring first to prevent racing
      if (this.healthMonitoringInterval) {
        clearInterval(this.healthMonitoringInterval);
        this.healthMonitoringInterval = null;
      }

      // Flush any remaining batched events
      if (this.eventBatcher) {
        try {
          this.eventBatcher.flushAll();
          this.eventBatcher.destroy();
        } catch (error) {
          this.logger.warn('Error flushing event batcher', { error });
        }
        this.eventBatcher = null as any;
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
      this.monitoredPairs.clear();

      this.logger.info('Arbitrum detector service stopped');
    } finally {
      this.isStopping = false;
      this.stopPromise = null;
    }
  }

  // ===========================================================================
  // Pair Initialization
  // ===========================================================================

  protected async initializePairs(): Promise<void> {
    this.logger.info('Initializing Arbitrum trading pairs (Ultra-Fast Configuration)');

    for (const dex of this.dexes) {
      for (let i = 0; i < this.tokens.length; i++) {
        for (let j = i + 1; j < this.tokens.length; j++) {
          const token0 = this.tokens[i];
          const token1 = this.tokens[j];

          try {
            // Get pair address from DEX factory
            const factoryContract = new ethers.Contract(
              dex.factoryAddress,
              ['function getPair(address,address) view returns (address)'],
              this.provider
            );

            const pairAddress = await factoryContract.getPair(token0.address, token1.address);

            if (pairAddress !== ethers.ZeroAddress) {
              const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
              const pair: Pair = {
                name: `${token0.symbol}/${token1.symbol}`,
                address: pairAddress,
                token0: token0.address,
                token1: token1.address,
                dex: dex.name,
                fee: dex.fee || 30 // Default 0.30% fee
              };

              this.pairs.set(pairKey, pair);
              this.pairsByAddress.set(pairAddress.toLowerCase(), pair);
              this.monitoredPairs.add(pairAddress.toLowerCase());

              this.logger.debug(`Added pair: ${pairKey} at ${pairAddress}`);
            }
          } catch (error) {
            this.logger.warn(`Failed to initialize pair ${token0.symbol}-${token1.symbol} on ${dex.name}`, { error });
          }
        }
      }
    }

    this.logger.info(`Initialized ${this.pairs.size} trading pairs on Arbitrum`);
  }

  // ===========================================================================
  // Event Processing
  // ===========================================================================

  /**
   * Process a log event (public for testing)
   */
  async processLogEvent(log: any): Promise<void> {
    // Guard against processing during shutdown
    if (!this.isRunning || this.isStopping) {
      return;
    }

    try {
      // Find the pair for this log - O(1) lookup
      const pairAddress = log.address?.toLowerCase();
      if (!pairAddress || !this.monitoredPairs.has(pairAddress)) {
        return;
      }

      // O(1) pair lookup instead of O(n) iteration
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

      // Update pair data
      const arbitrumPair = pair as ArbitrumPair;
      arbitrumPair.reserve0 = reserve0;
      arbitrumPair.reserve1 = reserve1;
      arbitrumPair.blockNumber = blockNumber;
      arbitrumPair.lastUpdate = Date.now();

      // Calculate price
      const price = this.calculatePrice(arbitrumPair);

      // Create price update
      const priceUpdate: PriceUpdate = {
        pairKey: `${pair.dex}_${pair.token0}_${pair.token1}`,
        dex: pair.dex,
        chain: 'arbitrum',
        token0: pair.token0,
        token1: pair.token1,
        price,
        reserve0,
        reserve1,
        blockNumber,
        timestamp: Date.now(),
        latency: 0
      };

      // Publish price update (uses Redis Streams batching from BaseDetector)
      await this.publishPriceUpdate(priceUpdate);

      // Check for intra-DEX arbitrage
      await this.checkIntraDexArbitrage(pair);

    } catch (error) {
      this.logger.error('Failed to process sync event', { error, pair: pair.address });
    }
  }

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
        // Apply sampling for small trades (1% pass through)
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
        chain: 'arbitrum',
        usdValue
      };

      // Publish swap event (uses Smart Swap Event Filter from BaseDetector)
      await this.publishSwapEvent(swapEvent);

      // Check for whale activity
      await this.checkWhaleActivity(swapEvent);

    } catch (error) {
      this.logger.error('Failed to process swap event', { error, pair: pair.address });
    }
  }

  // ===========================================================================
  // Price Calculation
  // ===========================================================================

  protected calculatePrice(pair: ArbitrumPair | { reserve0: string; reserve1: string; token0: string; token1: string }): number {
    try {
      // Guard against undefined reserves (pair not yet initialized via Sync event)
      if (!pair.reserve0 || !pair.reserve1) return 0;

      const reserve0 = parseFloat(pair.reserve0);
      const reserve1 = parseFloat(pair.reserve1);

      // Guard against zero or NaN reserves
      if (reserve0 === 0 || reserve1 === 0 || isNaN(reserve0) || isNaN(reserve1)) return 0;

      // Price of token1 in terms of token0
      return reserve0 / reserve1;
    } catch (error) {
      this.logger.error('Failed to calculate price', { error });
      return 0;
    }
  }

  /**
   * Test helper for price calculation
   */
  testCalculatePrice(pair: { reserve0: string; reserve1: string; token0: string; token1: string }): number {
    return this.calculatePrice(pair);
  }

  // ===========================================================================
  // USD Value Estimation (Fixed: uses config, handles both tokens correctly)
  // ===========================================================================

  protected async estimateUsdValue(
    pair: Pair,
    amount0In: string,
    amount1In: string,
    amount0Out: string,
    amount1Out: string
  ): Promise<number> {
    const ethPrice = 2500; // TODO: Fetch from price oracle in Phase 2
    const token0Lower = pair.token0.toLowerCase();
    const token1Lower = pair.token1.toLowerCase();
    const wethLower = this.tokenMetadata.weth.toLowerCase();

    // Check if either token is WETH
    if (token0Lower === wethLower || token1Lower === wethLower) {
      const isToken0Weth = token0Lower === wethLower;
      const amount = isToken0Weth
        ? Math.max(parseFloat(amount0In), parseFloat(amount0Out))
        : Math.max(parseFloat(amount1In), parseFloat(amount1Out));
      return (amount / 1e18) * ethPrice;
    }

    // Check if either token is a stablecoin
    for (const stable of this.tokenMetadata.stablecoins) {
      const stableLower = stable.address.toLowerCase();

      if (token0Lower === stableLower) {
        const stableAmount = Math.max(parseFloat(amount0In), parseFloat(amount0Out));
        return stableAmount / Math.pow(10, stable.decimals);
      }

      if (token1Lower === stableLower) {
        const stableAmount = Math.max(parseFloat(amount1In), parseFloat(amount1Out));
        return stableAmount / Math.pow(10, stable.decimals);
      }
    }

    return 0;
  }

  /**
   * Test helper for USD value estimation
   */
  async testEstimateUsdValue(
    pair: { token0: string; token1: string },
    amount0In: string,
    amount1In: string,
    amount0Out: string,
    amount1Out: string
  ): Promise<number> {
    return this.estimateUsdValue(pair as Pair, amount0In, amount1In, amount0Out, amount1Out);
  }

  // ===========================================================================
  // Arbitrage Detection
  // ===========================================================================

  protected async checkIntraDexArbitrage(pair: Pair): Promise<void> {
    // Guard against processing during shutdown
    if (!this.isRunning || this.isStopping) {
      return;
    }

    const opportunities: ArbitrageOpportunity[] = [];

    // Create snapshot of current pair for thread-safe comparison (race condition fix)
    const currentSnapshot = this.createPairSnapshot(pair);
    if (!currentSnapshot) return;

    const [token0, token1] = [currentSnapshot.token0.toLowerCase(), currentSnapshot.token1.toLowerCase()];
    const currentPrice = this.calculatePriceFromSnapshot(currentSnapshot);

    if (currentPrice === 0) return;

    // Create snapshots of ALL pairs atomically to avoid reading mutating reserves
    // This fixes the race condition where reserves change during iteration
    const pairsSnapshots = this.createPairsSnapshot();

    for (const [key, otherSnapshot] of pairsSnapshots) {
      if (otherSnapshot.address === currentSnapshot.address) continue;
      if (otherSnapshot.dex === currentSnapshot.dex) continue;

      const otherToken0 = otherSnapshot.token0.toLowerCase();
      const otherToken1 = otherSnapshot.token1.toLowerCase();

      // Check if same token pair (in either order)
      const sameOrder = otherToken0 === token0 && otherToken1 === token1;
      const reverseOrder = otherToken0 === token1 && otherToken1 === token0;

      if (sameOrder || reverseOrder) {
        // Use snapshot price calculation (thread-safe)
        let otherPrice = this.calculatePriceFromSnapshot(otherSnapshot);
        if (otherPrice === 0) continue;

        // Adjust price for reverse order pairs
        if (reverseOrder && otherPrice !== 0) {
          otherPrice = 1 / otherPrice;
        }

        // Calculate price difference percentage
        const priceDiff = Math.abs(currentPrice - otherPrice) / Math.min(currentPrice, otherPrice);

        if (priceDiff >= this.getMinProfitThreshold()) {
          // Use config-driven values for chain-specific settings
          const chainConfig = DETECTOR_CONFIG.arbitrum;
          const opportunity: ArbitrageOpportunity = {
            id: `${currentSnapshot.address}-${otherSnapshot.address}-${Date.now()}`,
            type: 'simple',
            chain: 'arbitrum',
            buyDex: currentPrice < otherPrice ? currentSnapshot.dex : otherSnapshot.dex,
            sellDex: currentPrice < otherPrice ? otherSnapshot.dex : currentSnapshot.dex,
            buyPair: currentPrice < otherPrice ? currentSnapshot.address : otherSnapshot.address,
            sellPair: currentPrice < otherPrice ? otherSnapshot.address : currentSnapshot.address,
            token0: currentSnapshot.token0,
            token1: currentSnapshot.token1,
            buyPrice: Math.min(currentPrice, otherPrice),
            sellPrice: Math.max(currentPrice, otherPrice),
            profitPercentage: priceDiff * 100,
            estimatedProfit: 0, // Would calculate based on trade size
            confidence: chainConfig.confidence,
            timestamp: Date.now(),
            expiresAt: Date.now() + chainConfig.expiryMs,
            gasEstimate: chainConfig.gasEstimate,
            status: 'pending'
          };

          opportunities.push(opportunity);
        }
      }
    }

    // Publish opportunities
    for (const opportunity of opportunities) {
      await this.publishArbitrageOpportunity(opportunity);
      this.perfLogger.logArbitrageOpportunity(opportunity);
    }
  }

  // ===========================================================================
  // Whale Detection
  // ===========================================================================

  protected async checkWhaleActivity(swapEvent: SwapEvent): Promise<void> {
    // Use config-driven whale threshold (chain-specific)
    const whaleThreshold = DETECTOR_CONFIG.arbitrum.whaleThreshold;
    if (!swapEvent.usdValue || swapEvent.usdValue < whaleThreshold) {
      return;
    }

    // Fix: Compare numbers, not strings
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

  protected async calculatePriceImpact(swapEvent: SwapEvent): Promise<number> {
    // Get the pair to access reserves
    const pair = this.pairsByAddress.get(swapEvent.pairAddress.toLowerCase()) as ArbitrumPair;

    if (!pair || !pair.reserve0 || !pair.reserve1) {
      return 0.02; // Default 2% if reserves not available
    }

    // Calculate impact based on trade size vs reserves
    const reserve0 = parseFloat(pair.reserve0);
    const reserve1 = parseFloat(pair.reserve1);
    const tradeAmount = Math.max(
      parseFloat(swapEvent.amount0In),
      parseFloat(swapEvent.amount1In),
      parseFloat(swapEvent.amount0Out),
      parseFloat(swapEvent.amount1Out)
    );

    // Simple impact calculation: trade_size / reserve
    // Real implementation would use AMM formula
    const relevantReserve = parseFloat(swapEvent.amount0In) > 0 ? reserve0 : reserve1;
    if (relevantReserve === 0) return 0.02;

    return Math.min(tradeAmount / relevantReserve, 0.5); // Cap at 50%
  }

  // ===========================================================================
  // Health Monitoring
  // ===========================================================================

  async getHealth(): Promise<any> {
    const batcherStats = this.eventBatcher ? this.eventBatcher.getStats() : null;
    const wsStats = this.wsManager ? this.wsManager.getConnectionStats() : null;

    return {
      service: 'arbitrum-detector',
      status: (this.isRunning && !this.isStopping ? 'healthy' : 'unhealthy') as 'healthy' | 'degraded' | 'unhealthy',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().heapUsed,
      cpuUsage: 0, // Would need additional monitoring
      lastHeartbeat: Date.now(),
      pairs: this.pairs.size,
      websocket: wsStats,
      batcherStats,
      chain: 'arbitrum',
      dexCount: this.dexes.length,
      tokenCount: this.tokens.length,
      ultraFastMode: true
    };
  }

  private startHealthMonitoring(): void {
    this.healthMonitoringInterval = setInterval(async () => {
      // Guard against running during shutdown
      if (!this.isRunning || this.isStopping) {
        return;
      }

      try {
        const health = await this.getHealth();

        if (this.redis) {
          await this.redis.updateServiceHealth('arbitrum-detector', health);
        }

        this.perfLogger.logHealthCheck('arbitrum-detector', health);

      } catch (error) {
        this.logger.error('Health monitoring failed', { error });
      }
    }, this.arbitrumConfig.healthCheckInterval);
  }
}
