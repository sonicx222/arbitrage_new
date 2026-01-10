// BSC DEX Detector Service
import { ethers } from 'ethers';
import { BaseDetector } from '../../../shared/core/src';
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG, EVENT_CONFIG } from '../../../shared/config/src';
import {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
  Pair
} from '../../../shared/types/src';

export class BSCDetectorService extends BaseDetector {
  constructor() {
    super({
      chain: 'bsc',
      enabled: true,
      wsUrl: CHAINS.bsc.wsUrl,
      rpcUrl: CHAINS.bsc.rpcUrl,
      batchSize: 20,
      batchTimeout: 30,
      healthCheckInterval: 30000
    });
  }

  async start(): Promise<void> {
    try {
      this.logger.info('Starting BSC detector service');

      // Initialize Redis client
      await this.initializeRedis();

      // Initialize pairs
      await this.initializePairs();

      // Connect to WebSocket (inherited from BaseDetector)
      await this.connectWebSocket();

      // Subscribe to events (inherited from BaseDetector)
      await this.subscribeToEvents();

      this.isRunning = true;
      this.logger.info('BSC detector service started successfully');

      // Start health monitoring
      this.startHealthMonitoring();

    } catch (error) {
      this.logger.error('Failed to start BSC detector service', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping BSC detector service');
    this.isRunning = false;

    // Flush any remaining batched events
    if (this.eventBatcher) {
      this.eventBatcher.flushAll();
      this.eventBatcher.destroy();
      this.eventBatcher = null as any;
    }

    // Clean up Redis Streams batchers (ADR-002, S1.1.4)
    await this.cleanupStreamBatchers();

    // Disconnect WebSocket manager
    if (this.wsManager) {
      this.wsManager.disconnect();
    }

    // Disconnect Redis Streams client
    if (this.streamsClient) {
      await this.streamsClient.disconnect();
      this.streamsClient = null;
    }

    // Disconnect Redis
    if (this.redis) {
      await this.redis.disconnect();
      this.redis = null;
    }

    // Clear collections to prevent memory leaks
    this.pairs.clear();
    this.monitoredPairs.clear();
  }

  private async initializePairs(): Promise<void> {
    this.logger.info('Initializing BSC trading pairs');

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
                fee: dex.fee || 0.0025 // Default 0.25% fee
              };

              this.pairs.set(pairKey, pair);
              this.monitoredPairs.add(pairAddress);

              this.logger.debug(`Added pair: ${pairKey} at ${pairAddress}`);
            }
          } catch (error) {
            this.logger.warn(`Failed to initialize pair ${token0.symbol}-${token1.symbol} on ${dex.name}`, { error });
          }
        }
      }
    }

    this.logger.info(`Initialized ${this.pairs.size} trading pairs`);
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
      const blockNumber = parseInt(log.blockNumber, 16);

      // Update pair data
      (pair as any).reserve0 = reserve0;
      (pair as any).reserve1 = reserve1;
      (pair as any).blockNumber = blockNumber;
      (pair as any).lastUpdate = Date.now();

      // Calculate price
      const price = this.calculatePrice(pair);

      // Create price update
      const priceUpdate: PriceUpdate = {
        pairKey: `${pair.dex}_${pair.token0}_${pair.token1}`,
        dex: pair.dex,
        chain: 'bsc',
        token0: pair.token0,
        token1: pair.token1,
        price,
        reserve0,
        reserve1,
        blockNumber,
        timestamp: Date.now(),
        latency: 0
      };

      // Publish price update
      await this.publishPriceUpdate(priceUpdate);

      // Check for intra-DEX arbitrage
      await this.checkIntraDexArbitrage(pair);

    } catch (error) {
      this.logger.error('Failed to process sync event', { error, pair: pair.address });
    }
  }

  protected async processSwapEvent(log: any, pair: Pair): Promise<void> {
    try {
      // Only process significant trades (configurable threshold)
      const decodedData = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256', 'uint256', 'uint256', 'uint256'],
        log.data
      );

      const amount0In = decodedData[0].toString();
      const amount1In = decodedData[1].toString();
      const amount0Out = decodedData[2].toString();
      const amount1Out = decodedData[3].toString();

      // Calculate USD value (simplified - would need price oracle in production)
      const usdValue = await this.estimateUsdValue(pair, amount0In, amount1In, amount0Out, amount1Out);

      // Apply filtering based on configuration
      if (usdValue < EVENT_CONFIG.swapEvents.minAmountUSD) {
        // Apply sampling for small trades
        if (Math.random() > EVENT_CONFIG.swapEvents.samplingRate) {
          return; // Skip this event
        }
      }

      const swapEvent: SwapEvent = {
        pairAddress: pair.address,
        sender: '0x' + log.topics[1].slice(26), // Extract from topics
        recipient: '0x' + log.topics[2].slice(26),
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to: '0x' + log.topics[2].slice(26),
        blockNumber: parseInt(log.blockNumber, 16),
        transactionHash: log.transactionHash,
        timestamp: Date.now(),
        dex: pair.dex,
        chain: 'bsc',
        usdValue
      };

      // Publish swap event for analysis
      await this.publishSwapEvent(swapEvent);

      // Check for whale activity
      await this.checkWhaleActivity(swapEvent);

    } catch (error) {
      this.logger.error('Failed to process swap event', { error, pair: pair.address });
    }
  }

  private calculatePrice(pair: Pair): number {
    try {
      const reserve0 = parseFloat(pair.reserve0);
      const reserve1 = parseFloat(pair.reserve1);

      if (reserve0 === 0 || reserve1 === 0) return 0;

      // Price of token1 in terms of token0
      return reserve0 / reserve1;
    } catch (error) {
      this.logger.error('Failed to calculate price', { error, pair });
      return 0;
    }
  }

  protected async checkIntraDexArbitrage(pair: Pair): Promise<void> {
    // For now, just check basic triangular arbitrage within the same DEX
    // This will be enhanced with the WebAssembly engine later

    const opportunities: ArbitrageOpportunity[] = [];

    // Check if this price update creates arbitrage with existing pairs
    // This is a simplified version - full implementation in Phase 2

    if (opportunities.length > 0) {
      for (const opportunity of opportunities) {
        await this.publishArbitrageOpportunity(opportunity);
        this.perfLogger.logArbitrageOpportunity(opportunity);
      }
    }
  }

  protected async checkWhaleActivity(swapEvent: SwapEvent): Promise<void> {
    if (!swapEvent.usdValue || swapEvent.usdValue < 50000) return; // $50K threshold

    const whaleTransaction = {
      transactionHash: swapEvent.transactionHash,
      address: swapEvent.sender,
      token: swapEvent.amount0In > swapEvent.amount1In ? 'token0' : 'token1',
      amount: Math.max(parseFloat(swapEvent.amount0In), parseFloat(swapEvent.amount1In)),
      usdValue: swapEvent.usdValue,
      direction: swapEvent.amount0In > swapEvent.amount1In ? 'sell' : 'buy',
      dex: swapEvent.dex,
      chain: swapEvent.chain,
      timestamp: swapEvent.timestamp,
      impact: await this.calculatePriceImpact(swapEvent)
    };

    await this.publishWhaleTransaction(whaleTransaction);
  }

  private async estimateUsdValue(pair: Pair, amount0In: string, amount1In: string, amount0Out: string, amount1Out: string): Promise<number> {
    // Simplified USD estimation - would use price oracle in production
    // For now, assume BNB pairs have known USD values
    if (pair.token0.symbol === 'WBNB' || pair.token1.symbol === 'WBNB') {
      const bnbPrice = 300; // Approximate BNB price in USD
      const amount = Math.max(parseFloat(amount0In), parseFloat(amount1In), parseFloat(amount0Out), parseFloat(amount1Out));
      return (amount / 1e18) * bnbPrice;
    }
    return 0;
  }

  private async calculatePriceImpact(swapEvent: SwapEvent): Promise<number> {
    // Simplified price impact calculation
    // Would be more sophisticated in production
    return 0.02; // 2% default
  }



  async getHealth(): Promise<any> {
    const batcherStats = this.eventBatcher ? this.eventBatcher.getStats() : null;
    const wsStats = this.wsManager ? this.wsManager.getConnectionStats() : null;

    return {
      service: 'bsc-detector',
      status: (this.isRunning ? 'healthy' : 'unhealthy') as 'healthy' | 'degraded' | 'unhealthy',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().heapUsed,
      cpuUsage: 0, // Would need additional monitoring
      lastHeartbeat: Date.now(),
      pairs: this.pairs.size,
      websocket: wsStats,
      batcherStats
    };
  }

  private startHealthMonitoring(): void {
    setInterval(async () => {
      try {
        const health = await this.getHealth();
        await this.redis!.updateServiceHealth('bsc-detector', health);
        this.perfLogger.logHealthCheck('bsc-detector', health);

      } catch (error) {
        this.logger.error('Health monitoring failed', { error });
      }
    }, 30000); // Every 30 seconds
  }
}