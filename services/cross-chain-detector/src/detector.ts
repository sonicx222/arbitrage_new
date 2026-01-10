// Cross-Chain Arbitrage Detector Service
import { getRedisClient, RedisClient, createLogger, getPerformanceLogger, PerformanceLogger } from '../../../shared/core/src';
import { ARBITRAGE_CONFIG } from '../../../shared/config/src';
import {
  PriceUpdate,
  ArbitrageOpportunity,
  MessageEvent,
  WhaleTransaction,
  CrossChainBridge
} from '../../../shared/types/src';
import { BridgeLatencyPredictor } from './bridge-predictor';

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

export class CrossChainDetectorService {
  private redis = getRedisClient();
  private logger = createLogger('cross-chain-detector');
  private perfLogger: PerformanceLogger;
  private priceData: PriceData = {};
  private opportunitiesCache: Map<string, CrossChainOpportunity> = new Map();
  private isRunning = false;
  private bridgePredictor: BridgeLatencyPredictor;

  constructor() {
    this.perfLogger = getPerformanceLogger('cross-chain-detector');
    this.bridgePredictor = new BridgeLatencyPredictor();
  }

  async start(): Promise<void> {
      this.logger.info('Starting detector service');

      // Initialize Redis client
      await this.initializeRedis();

      // Initialize pairs
      this.logger.info('Starting Cross-Chain Detector Service');

      // Subscribe to price updates from all detectors
      await this.subscribeToPriceUpdates();
      await this.subscribeToWhaleTransactions();

      // Initialize ML predictor (placeholder for Phase 3)
      await this.initializeMLPredictor();

      this.isRunning = true;
      this.logger.info('Cross-Chain Detector Service started successfully');

      // Start opportunity detection loop
      this.startOpportunityDetection();

      // Start health monitoring
      this.startHealthMonitoring();

    } catch (error) {
      this.logger.error('Failed to start Cross-Chain Detector Service', { error });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Cross-Chain Detector Service');
    this.isRunning = false;
    await this.redis!.disconnect();
  }

  private async subscribeToPriceUpdates(): Promise<void> {
    await this.redis!.subscribe('price-updates', (message: MessageEvent) => {
      this.handlePriceUpdate(message);
    });
    this.logger.info('Subscribed to price updates from all chains');
  }

  private async subscribeToWhaleTransactions(): Promise<void> {
    await this.redis!.subscribe('whale-transactions', (message: MessageEvent) => {
      this.handleWhaleTransaction(message);
    });
    this.logger.info('Subscribed to whale transactions');
  }

  private async initializeMLPredictor(): Promise<void> {
    // Placeholder for ML predictor initialization
    // Will be implemented in Phase 3 with TensorFlow.js
    this.mlPredictor = {
      predictPriceMovement: async () => ({ direction: 0, confidence: 0.5 }),
      predictOpportunity: async () => ({ confidence: 0.5, expectedProfit: 0 })
    };
    this.logger.info('ML predictor initialized (placeholder)');
  }

  private handlePriceUpdate(message: MessageEvent): void {
      const update: PriceUpdate = message.data;

      // Update price data structure
      if (!this.priceData[update.chain]) {
        this.priceData[update.chain] = {};
      }
      if (!this.priceData[update.chain][update.dex]) {
        this.priceData[update.chain][update.dex] = {};
      }

      this.priceData[update.chain][update.dex][update.pairKey] = update;

      // Clean old price data (keep last 5 minutes)
      this.cleanOldPriceData();

      this.logger.debug(`Updated price data: ${update.chain}/${update.dex}/${update.pairKey} = ${update.price}`);

    } catch (error) {
      this.logger.error('Failed to handle price update', { error, message });
    }
  }

  private handleWhaleTransaction(message: MessageEvent): void {
      const whaleTx: WhaleTransaction = message.data;

      // Analyze whale transaction for cross-chain implications
      this.analyzeWhaleImpact(whaleTx);

    } catch (error) {
      this.logger.error('Failed to handle whale transaction', { error, message });
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

  private startOpportunityDetection(): void {
    // Run opportunity detection every 100ms for real-time analysis
    setInterval(() => {
      if (this.isRunning) {
        this.detectCrossChainOpportunities();
      }
    }, 100);
  }

  private detectCrossChainOpportunities(): void {
    const startTime = performance.now();

      const opportunities: CrossChainOpportunity[] = [];

      // Get all unique token pairs across chains
      const tokenPairs = this.getAllTokenPairs();

      for (const tokenPair of tokenPairs) {
        const chainPrices = this.getPricesForTokenPair(tokenPair);

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

  private getAllTokenPairs(): string[] {
    const tokenPairs = new Set<string>();

    for (const chain of Object.keys(this.priceData)) {
      for (const dex of Object.keys(this.priceData[chain])) {
        for (const pairKey of Object.keys(this.priceData[chain][dex])) {
          // Extract token pair from pairKey (format: DEX_TOKEN1_TOKEN2)
          const tokens = pairKey.split('_').slice(1).join('_');
          tokenPairs.add(tokens);
        }
      }
    }

    return Array.from(tokenPairs);
  }

  private getPricesForTokenPair(tokenPair: string): Array<{chain: string, dex: string, price: number, update: PriceUpdate}> {
    const prices: Array<{chain: string, dex: string, price: number, update: PriceUpdate}> = [];

    for (const chain of Object.keys(this.priceData)) {
      for (const dex of Object.keys(this.priceData[chain])) {
        for (const pairKey of Object.keys(this.priceData[chain][dex])) {
          const tokens = pairKey.split('_').slice(1).join('_');
          if (tokens === tokenPair) {
            const update = this.priceData[chain][dex][pairKey];
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
    return `${parts[2]}/${parts[3]}`;
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
      'polygon': 0.3
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
    const price = (tokenUpdate.price0 + tokenUpdate.price1) / 2;
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

  private calculateConfidence(lowPrice: any, highPrice: any): number {
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

  private publishArbitrageOpportunity(opportunity: CrossChainOpportunity): void {
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

    const message: MessageEvent = {
      type: 'arbitrage-opportunity',
      data: arbitrageOpp,
      timestamp: Date.now(),
      source: 'cross-chain-detector'
    };

    this.redis.publish('arbitrage-opportunities', message);
    this.perfLogger.logArbitrageOpportunity(arbitrageOpp);

    // Cache opportunity to avoid duplicates
    this.opportunitiesCache.set(arbitrageOpp.id, opportunity);
  }

  private startHealthMonitoring(): void {
    setInterval(async () => {
        const health = {
          service: 'cross-chain-detector',
          status: (this.isRunning ? 'healthy' : 'unhealthy') as 'healthy' | 'degraded' | 'unhealthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
          cpuUsage: 0,
          lastHeartbeat: Date.now(),
          chainsMonitored: Object.keys(this.priceData).length,
          opportunitiesCache: this.opportunitiesCache.size,
          mlPredictorActive: !!this.mlPredictor
        };

        await this.redis!.updateServiceHealth('cross-chain-detector', health);
        this.perfLogger.logHealthCheck('cross-chain-detector', health);

      } catch (error) {
        this.logger.error('Cross-chain health monitoring failed', { error });
      }
    }, 30000);
  }
}