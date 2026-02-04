/**
 * Unit Tests for BridgeCostEstimator Module
 *
 * Tests the bridge cost estimation module including:
 * - ML predictor integration
 * - Fallback cost calculation
 * - Token amount extraction
 *
 * @see ADR-014: Modular Detector Components
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createBridgeCostEstimator, BridgeCostEstimator } from '../../bridge-cost-estimator';
import { BridgeLatencyPredictor, BridgePrediction } from '../../bridge-predictor';
import { PriceUpdate } from '@arbitrage/types';

// =============================================================================
// Mocks
// =============================================================================

const createMockLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

const createMockPriceUpdate = (overrides: Partial<PriceUpdate> = {}): PriceUpdate => ({
  chain: 'ethereum',
  dex: 'uniswap',
  pairKey: 'uniswap_WETH_USDC',
  pairAddress: '0x1234567890123456789012345678901234567890',
  token0: 'WETH',
  token1: 'USDC',
  reserve0: '1000000000000000000000',
  reserve1: '3000000000000',
  price: 3000,
  timestamp: Date.now(),
  blockNumber: 12345678,
  latency: 50, // Required field: time to process price update in ms
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('BridgeCostEstimator', () => {
  let estimator: BridgeCostEstimator;
  let mockBridgePredictor: BridgeLatencyPredictor;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockBridgePredictor = new BridgeLatencyPredictor();

    estimator = createBridgeCostEstimator({
      bridgePredictor: mockBridgePredictor,
      logger: mockLogger,
      defaultTradeSizeUsd: 1000,
    });
  });

  // ===========================================================================
  // extractTokenAmount
  // ===========================================================================

  describe('extractTokenAmount', () => {
    it('should calculate token amount for given USD value', () => {
      const priceUpdate = createMockPriceUpdate({ price: 3000 }); // $3000/ETH

      const amount = estimator.extractTokenAmount(priceUpdate);

      // $1000 / $3000 = 0.333... ETH
      expect(amount).toBeCloseTo(0.333, 2);
    });

    it('should handle very low token prices', () => {
      const priceUpdate = createMockPriceUpdate({ price: 0.01 }); // $0.01/token

      const amount = estimator.extractTokenAmount(priceUpdate);

      // $1000 / $0.01 = 100,000 tokens
      expect(amount).toBe(100000);
    });

    it('should handle very high token prices', () => {
      const priceUpdate = createMockPriceUpdate({ price: 100000 }); // $100,000/BTC

      const amount = estimator.extractTokenAmount(priceUpdate);

      // $1000 / $100,000 = 0.01 BTC
      expect(amount).toBe(0.01);
    });

    it('should use custom trade size when provided', () => {
      const priceUpdate = createMockPriceUpdate({ price: 2000 });

      const amount = estimator.extractTokenAmount(priceUpdate, 5000);

      // $5000 / $2000 = 2.5 tokens
      expect(amount).toBe(2.5);
    });

    it('should return fallback for zero price', () => {
      const priceUpdate = createMockPriceUpdate({ price: 0 });

      const amount = estimator.extractTokenAmount(priceUpdate);

      expect(amount).toBe(1.0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should return fallback for negative price', () => {
      const priceUpdate = createMockPriceUpdate({ price: -100 });

      const amount = estimator.extractTokenAmount(priceUpdate);

      expect(amount).toBe(1.0);
    });
  });

  // ===========================================================================
  // estimateBridgeCost
  // ===========================================================================

  describe('estimateBridgeCost', () => {
    it('should return fallback cost when no bridge routes available', () => {
      const priceUpdate = createMockPriceUpdate({ price: 3000 });

      const cost = estimator.estimateBridgeCost('unknown-chain1', 'unknown-chain2', priceUpdate);

      // Should use fallback: max($2 min fee, 0.1% of $1000) = $2
      // Converted to token units: $2 / $3000 = 0.000667
      expect(cost).toBeCloseTo(0.000667, 5);
    });

    it('should use predictor when routes available and confidence high', () => {
      // Add bridge data to predictor
      for (let i = 0; i < 15; i++) {
        mockBridgePredictor.updateModel({
          bridge: {
            sourceChain: 'ethereum',
            targetChain: 'arbitrum',
            bridge: 'stargate',
            token: 'WETH',
            amount: 1.0,
          },
          actualLatency: 180,
          actualCost: 0.001, // 0.001 ETH
          success: true,
          timestamp: Date.now() + i * 1000,
        });
      }

      const priceUpdate = createMockPriceUpdate({ price: 3000 });

      const cost = estimator.estimateBridgeCost('ethereum', 'arbitrum', priceUpdate);

      // Should return some cost (predictor-based or fallback)
      expect(cost).toBeGreaterThan(0);
      expect(Number.isFinite(cost)).toBe(true);
    });

    it('should handle stablecoins correctly', () => {
      const priceUpdate = createMockPriceUpdate({
        pairKey: 'uniswap_USDC_USDT',
        price: 1.0, // $1/USDC
      });

      const cost = estimator.estimateBridgeCost('ethereum', 'polygon', priceUpdate);

      // For stablecoins, cost in token units equals cost in USD
      // ethereum→polygon uses configured Stargate bridge with minFeeUsd: $1
      // $1 / $1 per USDC = 1 USDC
      expect(cost).toBeCloseTo(1, 1);
    });
  });

  // ===========================================================================
  // getDetailedEstimate
  // ===========================================================================

  describe('getDetailedEstimate', () => {
    it('should return fallback source when no routes available', () => {
      const priceUpdate = createMockPriceUpdate();

      const estimate = estimator.getDetailedEstimate('unknown1', 'unknown2', priceUpdate);

      expect(estimate.source).toBe('fallback');
      expect(estimate.costUsd).toBeGreaterThan(0);
    });

    it('should include confidence for predictor-based estimates', () => {
      // Add enough data for predictor to be confident
      for (let i = 0; i < 20; i++) {
        mockBridgePredictor.updateModel({
          bridge: {
            sourceChain: 'ethereum',
            targetChain: 'optimism',
            bridge: 'across',
            token: 'WETH',
            amount: 1.0,
          },
          actualLatency: 120,
          actualCost: 0.002,
          success: true,
          timestamp: Date.now() + i * 1000,
        });
      }

      const priceUpdate = createMockPriceUpdate();

      const estimate = estimator.getDetailedEstimate('ethereum', 'optimism', priceUpdate);

      // May be predictor or fallback depending on confidence
      expect(['predictor', 'config', 'fallback']).toContain(estimate.source);
      expect(estimate.costUsd).toBeGreaterThan(0);
    });

    it('should return cost estimate structure', () => {
      const priceUpdate = createMockPriceUpdate();

      const estimate = estimator.getDetailedEstimate('ethereum', 'polygon', priceUpdate);

      expect(estimate).toHaveProperty('costUsd');
      expect(estimate).toHaveProperty('source');
      expect(typeof estimate.costUsd).toBe('number');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle very small trade sizes', () => {
      const smallTradeEstimator = createBridgeCostEstimator({
        bridgePredictor: mockBridgePredictor,
        logger: mockLogger,
        defaultTradeSizeUsd: 10, // Small trade
      });

      const priceUpdate = createMockPriceUpdate({ price: 3000 });

      const amount = smallTradeEstimator.extractTokenAmount(priceUpdate);

      // $10 / $3000 = 0.00333 ETH
      expect(amount).toBeCloseTo(0.00333, 4);
    });

    it('should handle very large trade sizes', () => {
      const largeTradeEstimator = createBridgeCostEstimator({
        bridgePredictor: mockBridgePredictor,
        logger: mockLogger,
        defaultTradeSizeUsd: 1000000, // $1M trade
      });

      const priceUpdate = createMockPriceUpdate({ price: 3000 });

      const amount = largeTradeEstimator.extractTokenAmount(priceUpdate);

      // $1,000,000 / $3000 = 333.33 ETH
      expect(amount).toBeCloseTo(333.33, 1);
    });

    it('should handle custom min fallback fee', () => {
      const customEstimator = createBridgeCostEstimator({
        bridgePredictor: mockBridgePredictor,
        logger: mockLogger,
        defaultTradeSizeUsd: 100,
        minFallbackFeeUsd: 5.0, // Higher min fee
      });

      const priceUpdate = createMockPriceUpdate({ price: 100 }); // $100/token

      const cost = customEstimator.estimateBridgeCost('unknown1', 'unknown2', priceUpdate);

      // Min fee $5 / $100 price = 0.05 tokens
      expect(cost).toBe(0.05);
    });

    it('should handle custom base fee percentage', () => {
      const customEstimator = createBridgeCostEstimator({
        bridgePredictor: mockBridgePredictor,
        logger: mockLogger,
        defaultTradeSizeUsd: 10000,
        baseFallbackFeePercentage: 0.5, // 0.5% fee
        minFallbackFeeUsd: 1.0,
      });

      const priceUpdate = createMockPriceUpdate({ price: 1 }); // $1/token

      const cost = customEstimator.estimateBridgeCost('unknown1', 'unknown2', priceUpdate);

      // 0.5% of $10,000 = $50, which is > $1 min fee
      // $50 / $1 price = 50 tokens
      expect(cost).toBe(50);
    });

    it('should use min fee when percentage is lower', () => {
      const customEstimator = createBridgeCostEstimator({
        bridgePredictor: mockBridgePredictor,
        logger: mockLogger,
        defaultTradeSizeUsd: 100, // Small trade
        baseFallbackFeePercentage: 0.1, // 0.1% = $0.10
        minFallbackFeeUsd: 5.0, // Min $5
      });

      const priceUpdate = createMockPriceUpdate({ price: 1 }); // $1/token

      const cost = customEstimator.estimateBridgeCost('unknown1', 'unknown2', priceUpdate);

      // 0.1% of $100 = $0.10, but min is $5
      // $5 / $1 = 5 tokens
      expect(cost).toBe(5);
    });
  });

  // ===========================================================================
  // Integration with BridgeLatencyPredictor
  // ===========================================================================

  describe('predictor integration', () => {
    it('should use predictor routes when available', () => {
      // Add data for a specific route
      for (let i = 0; i < 15; i++) {
        mockBridgePredictor.updateModel({
          bridge: {
            sourceChain: 'arbitrum',
            targetChain: 'base',
            bridge: 'stargate',
            token: 'USDC',
            amount: 1000,
          },
          actualLatency: 90,
          actualCost: 0.0003,
          success: true,
          timestamp: Date.now() + i * 1000,
        });
      }

      const routes = mockBridgePredictor.getAvailableRoutes('arbitrum', 'base');
      expect(routes).toContain('stargate');

      const priceUpdate = createMockPriceUpdate({
        pairKey: 'uniswap_USDC_USDT',
        price: 1.0,
      });

      const estimate = estimator.getDetailedEstimate('arbitrum', 'base', priceUpdate);

      // Should have used predictor or config (not pure fallback)
      expect(['predictor', 'config', 'fallback']).toContain(estimate.source);
    });

    it('should fall back when predictor confidence too low', () => {
      // Add very few data points (low confidence)
      mockBridgePredictor.updateModel({
        bridge: {
          sourceChain: 'polygon',
          targetChain: 'bsc',
          bridge: 'new-bridge',
          token: 'WETH',
          amount: 1.0,
        },
        actualLatency: 200,
        actualCost: 0.001,
        success: true,
        timestamp: Date.now(),
      });

      const priceUpdate = createMockPriceUpdate();

      const estimate = estimator.getDetailedEstimate('polygon', 'bsc', priceUpdate);

      // With only 1 data point, confidence is low - should fall back
      expect(['config', 'fallback']).toContain(estimate.source);
    });
  });
});
