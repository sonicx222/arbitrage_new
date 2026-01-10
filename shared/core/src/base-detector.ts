// Base Detector Class
// Provides common functionality for all blockchain detectors

import { ethers } from 'ethers';
import WebSocket from 'ws';
import { RedisClient, getRedisClient, createLogger, getPerformanceLogger, PerformanceLogger } from './index';
import { CHAINS, DEXES, CORE_TOKENS, ARBITRAGE_CONFIG } from '../../config/src';
import {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
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

export abstract class BaseDetector {
  protected provider: ethers.JsonRpcProvider;
  protected wsProvider: WebSocket | null = null;
  protected redis: RedisClient | null = null;
  protected logger: any;
  protected perfLogger: PerformanceLogger;

  protected dexes: Dex[];
  protected tokens: Token[];
  protected pairs: Map<string, Pair> = new Map();
  protected monitoredPairs: Set<string> = new Set();
  protected isRunning = false;

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

    this.logger.info(`Initialized ${this.chain} detector`, {
      dexes: this.dexes.length,
      tokens: this.tokens.length,
      rpcUrl: config.rpcUrl || chainConfig.rpcUrl,
      wsUrl: config.wsUrl || chainConfig.wsUrl
    });
  }

  protected async initializeRedis(): Promise<void> {
    try {
      this.redis = await getRedisClient() as RedisClient;
      this.logger.debug('Redis client initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Redis client', { error });
      throw new Error('Redis initialization failed');
    }
  }

  // Abstract methods that must be implemented by subclasses
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract connectWebSocket(): Promise<void>;
  abstract subscribeToEvents(): Promise<void>;
  abstract getHealth(): Promise<any>;

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

  protected async publishPriceUpdate(update: PriceUpdate): Promise<void> {
    try {
      await this.redis.publish('price-update', update);
      this.logger.debug(`Published price update: ${update.pair} on ${update.dex}`);
    } catch (error) {
      this.logger.error('Failed to publish price update', { error, update });
    }
  }

  protected async publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    try {
      await this.redis.publish('arbitrage-opportunity', opportunity);
      this.logger.info(`Published arbitrage opportunity: ${opportunity.id}`, {
        profit: opportunity.estimatedProfit,
        confidence: opportunity.confidence
      });
    } catch (error) {
      this.logger.error('Failed to publish arbitrage opportunity', { error, opportunity });
    }
  }

  protected async publishSwapEvent(swapEvent: SwapEvent): Promise<void> {
    try {
      await this.redis.publish('swap-event', swapEvent);
      this.logger.debug(`Published swap event: ${swapEvent.pair} on ${swapEvent.dex}`);
    } catch (error) {
      this.logger.error('Failed to publish swap event', { error, swapEvent });
    }
  }

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

  protected getStats(): any {
    return {
      chain: this.chain,
      pairs: this.pairs.size,
      monitoredPairs: this.monitoredPairs.size,
      dexes: this.dexes.filter(d => d.enabled).length,
      tokens: this.tokens.length,
      isRunning: this.isRunning,
      config: this.config
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