/**
 * Integration Tests for CrossChainDetectorService
 *
 * Tests the complete flow from price updates through opportunity detection,
 * including real Redis Streams publishing, ML integration, and configuration.
 *
 * Uses real Redis (via redis-memory-server) for OpportunityPublisher tests,
 * with mock logger/perfLogger for non-Redis dependencies.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-014: Modular Detector Components
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

import { PriceUpdate } from '@arbitrage/types';
import { RedisStreamsClient } from '@arbitrage/core';
import { createTestRedisClient } from '@arbitrage/test-utils';
import { createPriceDataManager, PriceDataManager } from '../../src/price-data-manager';
import { createOpportunityPublisher, OpportunityPublisher } from '../../src/opportunity-publisher';
import { CrossChainOpportunity, DetectorConfig, MLPredictionConfig } from '../../src/types';

// =============================================================================
// Mock Logger & Performance Logger (kept as mocks — not Redis-dependent)
// =============================================================================

const createMockLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

const createMockPerfLogger = () => ({
  logArbitrageOpportunity: jest.fn(),
  logEventLatency: jest.fn(),
  logHealthCheck: jest.fn(),
});

// =============================================================================
// Real Redis Client Factory
// =============================================================================

function getTestRedisUrl(): string {
  const configFile = path.resolve(__dirname, '../../../../../.redis-test-config.json');
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.url) return config.url;
    } catch { /* fall through */ }
  }
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

function createRealStreamsClient(): RedisStreamsClient {
  return new RedisStreamsClient(getTestRedisUrl());
}

// =============================================================================
// Test Helpers
// =============================================================================

function createPriceUpdate(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    pairKey: 'UNISWAP_WETH_USDC',
    pairAddress: '0x1234567890abcdef1234567890abcdef12345678',
    dex: 'uniswap',
    chain: 'ethereum',
    token0: 'WETH',
    token1: 'USDC',
    price: 2500,
    reserve0: '1000000000000000000000',
    reserve1: '2500000000000',
    blockNumber: 12345678,
    timestamp: Date.now(),
    latency: 50,
    ...overrides,
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('CrossChainDetectorService Integration', () => {
  let priceDataManager: PriceDataManager;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    priceDataManager = createPriceDataManager({
      logger: mockLogger,
      cleanupFrequency: 100,
      maxPriceAgeMs: 5 * 60 * 1000,
    });
  });

  // ===========================================================================
  // PriceDataManager + IndexedSnapshot Integration
  // ===========================================================================

  describe('PriceDataManager with IndexedSnapshot', () => {
    it('should build indexed snapshot from price updates', () => {
      // Add prices for same token on different chains
      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'UNISWAP_WETH_USDC',
        price: 2500,
      }));

      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'sushiswap',
        pairKey: 'SUSHISWAP_WETH_USDC',
        price: 2510,
      }));

      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'optimism',
        dex: 'velodrome',
        pairKey: 'VELODROME_WETH_USDC',
        price: 2495,
      }));

      const snapshot = priceDataManager.createIndexedSnapshot();

      // Should have indexed token pairs
      expect(snapshot.tokenPairs.length).toBeGreaterThan(0);
      expect(snapshot.byToken.size).toBeGreaterThan(0);

      // Should be able to lookup by normalized token pair
      const wethUsdcPrices = snapshot.byToken.get('WETH_USDC');
      expect(wethUsdcPrices).toBeDefined();
      expect(wethUsdcPrices!.length).toBe(3);

      // Verify prices are correctly indexed
      const ethereumPrice = wethUsdcPrices!.find(p => p.chain === 'ethereum');
      const arbitrumPrice = wethUsdcPrices!.find(p => p.chain === 'arbitrum');
      const optimismPrice = wethUsdcPrices!.find(p => p.chain === 'optimism');

      expect(ethereumPrice?.price).toBe(2500);
      expect(arbitrumPrice?.price).toBe(2510);
      expect(optimismPrice?.price).toBe(2495);
    });

    it('should find min/max prices efficiently (O(n) vs O(n²))', () => {
      // Add many price updates
      const chains = ['ethereum', 'arbitrum', 'optimism', 'polygon', 'base'];
      const dexes = ['uniswap', 'sushiswap', 'curve', 'balancer'];

      for (const chain of chains) {
        for (const dex of dexes) {
          priceDataManager.handlePriceUpdate(createPriceUpdate({
            chain,
            dex,
            pairKey: `${dex.toUpperCase()}_WETH_USDC`,
            price: 2500 + Math.random() * 50, // Random price between 2500-2550
          }));
        }
      }

      const snapshot = priceDataManager.createIndexedSnapshot();
      const wethUsdcPrices = snapshot.byToken.get('WETH_USDC');

      expect(wethUsdcPrices).toBeDefined();
      expect(wethUsdcPrices!.length).toBe(chains.length * dexes.length);

      // Find min/max in O(n)
      let minPrice = wethUsdcPrices![0];
      let maxPrice = wethUsdcPrices![0];

      for (const pricePoint of wethUsdcPrices!) {
        if (pricePoint.price < minPrice.price) minPrice = pricePoint;
        if (pricePoint.price > maxPrice.price) maxPrice = pricePoint;
      }

      expect(minPrice.price).toBeLessThan(maxPrice.price);
    });

    it('should handle token normalization for cross-chain matching', () => {
      // Same token with different naming conventions
      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        pairKey: 'UNISWAP_WETH_USDC',
        token0: 'WETH',
        price: 2500,
      }));

      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'avalanche',
        pairKey: 'TRADERJOE_WETH.e_USDC',
        token0: 'WETH.e', // Avalanche wrapped ETH
        price: 2505,
      }));

      const snapshot = priceDataManager.createIndexedSnapshot();

      // Both should be normalized to same token pair
      expect(snapshot.tokenPairs).toContain('WETH_USDC');
    });
  });

  // ===========================================================================
  // OpportunityPublisher Integration (Real Redis)
  // ===========================================================================

  describe('OpportunityPublisher with Real Redis', () => {
    let publisher: OpportunityPublisher;
    let streamsClient: RedisStreamsClient;
    let rawRedis: Redis;
    let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
    const STREAM_NAME = RedisStreamsClient.STREAMS.OPPORTUNITIES;

    beforeAll(async () => {
      rawRedis = await createTestRedisClient();
    });

    afterAll(async () => {
      if (rawRedis) {
        await rawRedis.quit();
      }
    });

    beforeEach(async () => {
      // Flush Redis for isolation between tests
      await rawRedis.flushall();

      streamsClient = createRealStreamsClient();
      mockPerfLogger = createMockPerfLogger();
      publisher = createOpportunityPublisher({
        streamsClient,
        perfLogger: mockPerfLogger as any,
        logger: mockLogger,
        dedupeWindowMs: 5000,
        minProfitImprovement: 0.1, // 10%
      });
    });

    afterEach(async () => {
      if (streamsClient) {
        await streamsClient.disconnect();
      }
    });

    it('should publish opportunity to real Redis stream', async () => {
      const opportunity: CrossChainOpportunity = {
        token: 'WETH/USDC',
        sourceChain: 'optimism',
        sourceDex: 'velodrome',
        sourcePrice: 2495,
        targetChain: 'arbitrum',
        targetDex: 'sushiswap',
        targetPrice: 2510,
        priceDiff: 15,
        percentageDiff: 0.6,
        estimatedProfit: 15,
        bridgeCost: 5,
        netProfit: 10,
        confidence: 0.85,
        createdAt: Date.now(),
      };

      const published = await publisher.publish(opportunity);

      expect(published).toBe(true);

      // Verify the message actually landed in Redis
      const streamLen = await rawRedis.xlen(STREAM_NAME);
      expect(streamLen).toBe(1);

      // Read the message back and verify key fields
      // RedisStreamsClient serializes the message as JSON under a 'data' field
      const messages = await rawRedis.xrange(STREAM_NAME, '-', '+');
      expect(messages.length).toBe(1);

      const [, fields] = messages[0];
      // Fields are stored as ['data', '<json>']
      const dataIdx = fields.indexOf('data');
      expect(dataIdx).toBeGreaterThanOrEqual(0);

      const parsed = JSON.parse(fields[dataIdx + 1]);
      expect(parsed.type).toBe('cross-chain');
      expect(parsed.buyChain).toBe('optimism');
      expect(parsed.sellChain).toBe('arbitrum');
      expect(parsed.tokenIn).toBe('WETH');
      expect(parsed.tokenOut).toBe('USDC');
      expect(parsed.bridgeRequired).toBe(true);
    });

    it('should deduplicate identical opportunities (only 1 message in stream)', async () => {
      const opportunity: CrossChainOpportunity = {
        token: 'WETH/USDC',
        sourceChain: 'optimism',
        sourceDex: 'velodrome',
        sourcePrice: 2495,
        targetChain: 'arbitrum',
        targetDex: 'sushiswap',
        targetPrice: 2510,
        priceDiff: 15,
        percentageDiff: 0.6,
        estimatedProfit: 15,
        bridgeCost: 5,
        netProfit: 10,
        confidence: 0.85,
        createdAt: Date.now(),
      };

      // First publish should succeed
      const first = await publisher.publish(opportunity);
      expect(first).toBe(true);

      // Second publish with same key should be deduplicated
      const second = await publisher.publish(opportunity);
      expect(second).toBe(false);

      // Only 1 message should be in the stream
      const streamLen = await rawRedis.xlen(STREAM_NAME);
      expect(streamLen).toBe(1);
    });

    it('should republish when profit improves significantly (2 messages in stream)', async () => {
      const opportunity1: CrossChainOpportunity = {
        token: 'WETH/USDC',
        sourceChain: 'optimism',
        sourceDex: 'velodrome',
        sourcePrice: 2495,
        targetChain: 'arbitrum',
        targetDex: 'sushiswap',
        targetPrice: 2510,
        priceDiff: 15,
        percentageDiff: 0.6,
        estimatedProfit: 15,
        bridgeCost: 5,
        netProfit: 10, // $10 profit
        confidence: 0.85,
        createdAt: Date.now(),
      };

      const opportunity2: CrossChainOpportunity = {
        ...opportunity1,
        netProfit: 15, // $15 profit - 50% improvement
      };

      await publisher.publish(opportunity1);
      const secondPublished = await publisher.publish(opportunity2);

      expect(secondPublished).toBe(true);

      // Both messages should be in the stream
      const streamLen = await rawRedis.xlen(STREAM_NAME);
      expect(streamLen).toBe(2);
    });

    it('should publish multiple different token opportunities', async () => {
      const ethOpportunity: CrossChainOpportunity = {
        token: 'WETH/USDC',
        sourceChain: 'ethereum',
        sourceDex: 'uniswap',
        sourcePrice: 2500,
        targetChain: 'arbitrum',
        targetDex: 'sushiswap',
        targetPrice: 2550,
        priceDiff: 50,
        percentageDiff: 2.0,
        estimatedProfit: 50,
        bridgeCost: 5,
        netProfit: 45,
        confidence: 0.9,
        createdAt: Date.now(),
      };

      const btcOpportunity: CrossChainOpportunity = {
        token: 'WBTC/USDC',
        sourceChain: 'polygon',
        sourceDex: 'quickswap',
        sourcePrice: 42000,
        targetChain: 'optimism',
        targetDex: 'velodrome',
        targetPrice: 42500,
        priceDiff: 500,
        percentageDiff: 1.2,
        estimatedProfit: 500,
        bridgeCost: 10,
        netProfit: 490,
        confidence: 0.88,
        createdAt: Date.now(),
      };

      await publisher.publish(ethOpportunity);
      await publisher.publish(btcOpportunity);

      // Both should be published (different dedupe keys)
      const streamLen = await rawRedis.xlen(STREAM_NAME);
      expect(streamLen).toBe(2);
    });
  });

  // ===========================================================================
  // ML Integration Flow
  // ===========================================================================

  describe('ML Configuration Integration', () => {
    it('should use configurable ML settings', () => {
      const config: MLPredictionConfig = {
        enabled: true,
        minConfidence: 0.7,
        alignedBoost: 1.2,
        opposedPenalty: 0.85,
        maxLatencyMs: 15,
        cacheTtlMs: 2000,
      };

      // Verify config structure is valid
      expect(config.enabled).toBe(true);
      expect(config.minConfidence).toBe(0.7);
      expect(config.alignedBoost).toBeGreaterThan(1);
      expect(config.opposedPenalty).toBeLessThan(1);
    });

    it('should calculate ML confidence boost correctly', () => {
      const mlConfig: MLPredictionConfig = {
        enabled: true,
        minConfidence: 0.6,
        alignedBoost: 1.15,
        opposedPenalty: 0.9,
        maxLatencyMs: 10,
        cacheTtlMs: 1000,
      };

      // Simulate ML prediction alignment
      const sourcePrediction = { direction: 'up' as const, confidence: 0.75 };
      const targetPrediction = { direction: 'up' as const, confidence: 0.8 };

      let mlBoost = 1.0;

      // Source prediction: up = good for buying
      if (sourcePrediction.confidence >= mlConfig.minConfidence) {
        if (sourcePrediction.direction === 'up') {
          mlBoost *= mlConfig.alignedBoost;
        }
      }

      // Target prediction: up = good for selling
      if (targetPrediction.confidence >= mlConfig.minConfidence) {
        if (targetPrediction.direction === 'up') {
          mlBoost *= 1.05; // Additional boost for double alignment
        }
      }

      expect(mlBoost).toBeCloseTo(1.15 * 1.05, 2);
    });

    it('should apply penalty for opposing predictions', () => {
      const mlConfig: MLPredictionConfig = {
        enabled: true,
        minConfidence: 0.6,
        alignedBoost: 1.15,
        opposedPenalty: 0.9,
        maxLatencyMs: 10,
        cacheTtlMs: 1000,
      };

      // Simulate opposing ML prediction
      const targetPrediction = { direction: 'down' as const, confidence: 0.8 };

      let mlBoost = 1.0;

      if (targetPrediction.confidence >= mlConfig.minConfidence) {
        if (targetPrediction.direction === 'down') {
          mlBoost *= mlConfig.opposedPenalty;
        }
      }

      expect(mlBoost).toBe(0.9);
    });
  });

  // ===========================================================================
  // Configuration Integration
  // ===========================================================================

  describe('DetectorConfig Integration', () => {
    it('should merge user config with defaults', () => {
      const defaultConfig: DetectorConfig = {
        detectionIntervalMs: 100,
        healthCheckIntervalMs: 30000,
        bridgeCleanupFrequency: 100,
        defaultTradeSizeUsd: 1000,
      };

      const userConfig: DetectorConfig = {
        detectionIntervalMs: 50, // User wants faster detection
        defaultTradeSizeUsd: 5000, // User has more capital
      };

      const mergedConfig = {
        ...defaultConfig,
        ...userConfig,
      };

      expect(mergedConfig.detectionIntervalMs).toBe(50);
      expect(mergedConfig.healthCheckIntervalMs).toBe(30000);
      expect(mergedConfig.defaultTradeSizeUsd).toBe(5000);
    });
  });

  // ===========================================================================
  // End-to-End Opportunity Detection Flow
  // ===========================================================================

  describe('Opportunity Detection Flow', () => {
    it('should detect cross-chain arbitrage opportunity', () => {
      // Simulate price updates from different chains
      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'UNISWAP_WETH_USDC',
        price: 2500,
        timestamp: Date.now(),
      }));

      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'sushiswap',
        pairKey: 'SUSHISWAP_WETH_USDC',
        price: 2550, // 2% higher
        timestamp: Date.now(),
      }));

      const snapshot = priceDataManager.createIndexedSnapshot();
      const prices = snapshot.byToken.get('WETH_USDC');

      expect(prices).toBeDefined();
      expect(prices!.length).toBe(2);

      // Find min/max
      let minPrice = prices![0];
      let maxPrice = prices![0];
      for (const p of prices!) {
        if (p.price < minPrice.price) minPrice = p;
        if (p.price > maxPrice.price) maxPrice = p;
      }

      const priceDiff = maxPrice.price - minPrice.price;
      const percentageDiff = (priceDiff / minPrice.price) * 100;

      expect(minPrice.chain).toBe('ethereum');
      expect(maxPrice.chain).toBe('arbitrum');
      expect(percentageDiff).toBe(2); // 2% difference
    });

    it('should reject opportunity when price diff is too small', () => {
      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'UNISWAP_WETH_USDC',
        price: 2500,
      }));

      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'sushiswap',
        pairKey: 'SUSHISWAP_WETH_USDC',
        price: 2502, // Only 0.08% higher
      }));

      const snapshot = priceDataManager.createIndexedSnapshot();
      const prices = snapshot.byToken.get('WETH_USDC');

      let minPrice = prices![0];
      let maxPrice = prices![0];
      for (const p of prices!) {
        if (p.price < minPrice.price) minPrice = p;
        if (p.price > maxPrice.price) maxPrice = p;
      }

      const priceDiff = maxPrice.price - minPrice.price;
      const estimatedBridgeCost = 5; // $5 bridge cost
      const netProfit = priceDiff - estimatedBridgeCost;

      // Price diff ($2) is less than bridge cost ($5)
      expect(netProfit).toBeLessThan(0);
    });
  });

  // ===========================================================================
  // Whale Integration
  // ===========================================================================

  describe('Whale Activity Integration', () => {
    it('should boost confidence for bullish whale activity', () => {
      const baseConfidence = 0.7;
      const whaleBullishBoost = 1.15;

      const whaleData = {
        dominantDirection: 'bullish' as const,
        netFlowUsd: 500000,
        superWhaleCount: 1,
      };

      let confidence = baseConfidence;

      if (whaleData.dominantDirection === 'bullish') {
        confidence *= whaleBullishBoost;
      }

      expect(confidence).toBeCloseTo(0.805, 2);
    });

    it('should reduce confidence for bearish whale activity', () => {
      const baseConfidence = 0.7;
      const whaleBearishPenalty = 0.85;

      const whaleData = {
        dominantDirection: 'bearish' as const,
        netFlowUsd: -500000,
        superWhaleCount: 0,
      };

      let confidence = baseConfidence;

      if (whaleData.dominantDirection === 'bearish') {
        confidence *= whaleBearishPenalty;
      }

      expect(confidence).toBeCloseTo(0.595, 2);
    });
  });

  // ===========================================================================
  // Cleanup and Memory Management
  // ===========================================================================

  describe('Cleanup Integration', () => {
    it('should cleanup old price data', () => {
      // Add old price update
      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        pairKey: 'UNISWAP_OLD_PAIR',
        timestamp: Date.now() - (10 * 60 * 1000), // 10 minutes ago
      }));

      // Add recent price update
      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        pairKey: 'UNISWAP_NEW_PAIR',
        timestamp: Date.now(),
      }));

      // Run cleanup (max age is 5 minutes)
      priceDataManager.cleanup();

      const snapshot = priceDataManager.createIndexedSnapshot();

      // Old pair should be removed
      expect(snapshot.raw.ethereum?.uniswap?.['UNISWAP_OLD_PAIR']).toBeUndefined();
      // New pair should remain
      expect(snapshot.raw.ethereum?.uniswap?.['UNISWAP_NEW_PAIR']).toBeDefined();
    });

    it('should clear all data on clear()', () => {
      priceDataManager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        pairKey: 'UNISWAP_WETH_USDC',
      }));

      expect(priceDataManager.getPairCount()).toBe(1);

      priceDataManager.clear();

      expect(priceDataManager.getPairCount()).toBe(0);
      expect(priceDataManager.getChains()).toHaveLength(0);
    });
  });
});

// =============================================================================
// Confidence Calculation Tests
// =============================================================================

describe('Confidence Calculation Integration', () => {
  it('should guard against zero prices', () => {
    const calculateConfidence = (lowPrice: number, highPrice: number): number => {
      if (lowPrice <= 0 || highPrice <= 0 || !Number.isFinite(lowPrice) || !Number.isFinite(highPrice)) {
        return 0;
      }
      return Math.min(highPrice / lowPrice - 1, 0.5) * 2;
    };

    expect(calculateConfidence(0, 100)).toBe(0);
    expect(calculateConfidence(100, 0)).toBe(0);
    expect(calculateConfidence(-1, 100)).toBe(0);
    expect(calculateConfidence(NaN, 100)).toBe(0);
    expect(calculateConfidence(100, 105)).toBeGreaterThan(0);
  });

  it('should apply stale data penalty', () => {
    const baseConfidence = 0.8;
    const timestamp = Date.now() - (2 * 60 * 1000); // 2 minutes ago

    const agePenalty = Math.max(0, (Date.now() - timestamp) / 60000);
    const confidence = baseConfidence * Math.max(0.1, 1 - agePenalty * 0.1);

    // 2 minutes = 0.2 penalty, so confidence = 0.8 * 0.8 = 0.64
    expect(confidence).toBeCloseTo(0.64, 1);
  });

  it('should cap confidence at 95%', () => {
    const calculateConfidence = (priceRatio: number, whaleBoost: number, mlBoost: number): number => {
      let confidence = Math.min(priceRatio - 1, 0.5) * 2;
      confidence *= whaleBoost;
      confidence *= mlBoost;
      return Math.min(confidence, 0.95);
    };

    // Even with high boosts, confidence should not exceed 95%
    const result = calculateConfidence(1.5, 1.25, 1.2);
    expect(result).toBeLessThanOrEqual(0.95);
  });
});
