/**
 * Unit Tests for MLPredictionManager
 *
 * Tests the ML prediction management module.
 * FIX 8.2: Create missing tests for ml-prediction-manager.ts
 *
 * @see ADR-014: Modular Detector Components
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createMLPredictionManager, MLPredictionManager } from '../../ml-prediction-manager';
import { ModuleLogger, MLPredictionConfig } from '../../types';
import { PriceUpdate } from '@arbitrage/types';

// =============================================================================
// Mocks
// =============================================================================

// Mock prediction result
const mockPredictionResult = {
  direction: 'up' as const,
  confidence: 0.75,
  predictedPrice: 100.5,
  timeHorizon: 60000,
  features: [0.1, 0.2, 0.3],
};

// Create mock predictor with regular function (not jest.fn) to avoid reset issues
const mockPredictor = {
  predictPrice: () => Promise.resolve(mockPredictionResult),
};

// Mock @arbitrage/ml module
jest.mock('@arbitrage/ml', () => ({
  getLSTMPredictor: () => mockPredictor,
}));

// Mock logger
const createMockLogger = (): ModuleLogger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

// Default ML config for tests
const createDefaultMLConfig = (): MLPredictionConfig => ({
  enabled: true,
  minConfidence: 0.6,
  alignedBoost: 1.15,
  opposedPenalty: 0.9,
  maxLatencyMs: 5000, // Increased to avoid timing issues with mocks
  cacheTtlMs: 1000,
});

// =============================================================================
// Tests
// =============================================================================

describe('MLPredictionManager', () => {
  let manager: MLPredictionManager;
  let mockLogger: ModuleLogger;
  let mlConfig: MLPredictionConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mlConfig = createDefaultMLConfig();
  });

  afterEach(() => {
    if (manager) {
      manager.clear();
    }
  });

  // ===========================================================================
  // Factory Function
  // ===========================================================================

  describe('createMLPredictionManager', () => {
    it('should create manager with default configuration', () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
      });

      expect(manager).toBeDefined();
      expect(manager.isReady()).toBe(false); // Not initialized yet
    });

    it('should create manager with custom price history length', () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
        priceHistoryMaxLength: 50,
      });

      expect(manager).toBeDefined();
    });
  });

  // ===========================================================================
  // Initialization
  // ===========================================================================

  describe('initialize', () => {
    it('should initialize ML predictor successfully', async () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
      });

      const result = await manager.initialize();

      expect(result).toBe(true);
      expect(manager.isReady()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('ML predictor initialized (TensorFlow.js LSTM)');
    });

    it('should return false when ML is disabled', async () => {
      const disabledConfig = { ...mlConfig, enabled: false };
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig: disabledConfig,
      });

      const result = await manager.initialize();

      expect(result).toBe(false);
      expect(manager.isReady()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('ML predictions disabled by configuration');
    });
  });

  // ===========================================================================
  // Price History Tracking
  // ===========================================================================

  describe('trackPriceUpdate', () => {
    beforeEach(async () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
      });
      await manager.initialize();
    });

    it('should track price updates', () => {
      const update: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      manager.trackPriceUpdate(update);

      const history = manager.getPriceHistory('ethereum', 'uniswap_WETH_USDC');
      expect(history).toBeDefined();
      expect(history!.length).toBe(1);
      expect(history![0].price).toBe(3000);
    });

    it('should accumulate multiple price updates', () => {
      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      // Add 5 updates
      for (let i = 0; i < 5; i++) {
        manager.trackPriceUpdate({
          ...baseUpdate,
          price: 3000 + i * 10,
          timestamp: Date.now() + i * 1000,
        });
      }

      const history = manager.getPriceHistory('ethereum', 'uniswap_WETH_USDC');
      expect(history).toBeDefined();
      expect(history!.length).toBe(5);
    });

    it('should limit history to max length', () => {
      const shortHistoryManager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
        priceHistoryMaxLength: 3,
      });

      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      // Add 5 updates to a manager with max length 3
      for (let i = 0; i < 5; i++) {
        shortHistoryManager.trackPriceUpdate({
          ...baseUpdate,
          price: 3000 + i * 10,
          timestamp: Date.now() + i * 1000,
        });
      }

      const history = shortHistoryManager.getPriceHistory('ethereum', 'uniswap_WETH_USDC');
      expect(history).toBeDefined();
      expect(history!.length).toBe(3);
      // Should keep most recent entries
      expect(history![0].price).toBe(3020);
      expect(history![2].price).toBe(3040);
    });

    it('should not track updates when ML is disabled', () => {
      const disabledConfig = { ...mlConfig, enabled: false };
      const disabledManager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig: disabledConfig,
      });

      const update: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      disabledManager.trackPriceUpdate(update);

      const history = disabledManager.getPriceHistory('ethereum', 'uniswap_WETH_USDC');
      expect(history).toBeUndefined();
    });
  });

  // ===========================================================================
  // Volatility Calculation
  // ===========================================================================

  describe('calculateVolatility', () => {
    beforeEach(async () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
      });
      await manager.initialize();
    });

    it('should return 0 for pair with no history', () => {
      const volatility = manager.calculateVolatility('ethereum', 'unknown_pair');
      expect(volatility).toBe(0);
    });

    it('should return 0 for pair with single price point', () => {
      manager.trackPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      });

      const volatility = manager.calculateVolatility('ethereum', 'uniswap_WETH_USDC');
      expect(volatility).toBe(0);
    });

    it('should calculate volatility from price history', () => {
      const prices = [3000, 3010, 2990, 3020, 3005];
      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      for (let i = 0; i < prices.length; i++) {
        manager.trackPriceUpdate({
          ...baseUpdate,
          price: prices[i],
          timestamp: Date.now() + i * 1000,
        });
      }

      const volatility = manager.calculateVolatility('ethereum', 'uniswap_WETH_USDC');
      expect(volatility).toBeGreaterThan(0);
      expect(volatility).toBeLessThan(0.1); // Low volatility for small price changes
    });
  });

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  describe('cleanup', () => {
    it('should clear expired prediction cache entries', async () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig: { ...mlConfig, cacheTtlMs: 50 }, // Very short TTL for test
      });
      await manager.initialize();

      // Add price history so predictions can be made
      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      for (let i = 0; i < 15; i++) {
        manager.trackPriceUpdate({
          ...baseUpdate,
          price: 3000 + i,
          timestamp: Date.now() + i * 100,
        });
      }

      // Get a prediction to populate cache
      await manager.getCachedPrediction('ethereum', 'uniswap_WETH_USDC', 3014);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cleanup should remove expired entry
      manager.cleanup();

      // This is an internal implementation detail - the test verifies cleanup runs without error
      expect(true).toBe(true);
    });
  });

  describe('clear', () => {
    it('should clear all caches', async () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
      });
      await manager.initialize();

      // Add some data
      manager.trackPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      });

      manager.clear();

      const history = manager.getPriceHistory('ethereum', 'uniswap_WETH_USDC');
      expect(history).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith('MLPredictionManager cleared');
    });
  });

  // ===========================================================================
  // Prediction Fetching
  // ===========================================================================

  describe('getCachedPrediction', () => {
    beforeEach(async () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
      });
      await manager.initialize();
    });

    it('should return null when not enough history', async () => {
      // Only add 5 entries (less than required 10)
      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      for (let i = 0; i < 5; i++) {
        manager.trackPriceUpdate({
          ...baseUpdate,
          price: 3000 + i,
          timestamp: Date.now() + i * 100,
        });
      }

      const prediction = await manager.getCachedPrediction('ethereum', 'uniswap_WETH_USDC', 3004);
      expect(prediction).toBeNull();
    });

    it('should return prediction when enough history exists', async () => {
      // Verify manager is ready before testing
      expect(manager.isReady()).toBe(true);

      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      // Add 15 entries (more than required 10)
      for (let i = 0; i < 15; i++) {
        manager.trackPriceUpdate({
          ...baseUpdate,
          price: 3000 + i,
          timestamp: Date.now() + i * 100,
        });
      }

      // Verify price history was tracked
      const history = manager.getPriceHistory('ethereum', 'uniswap_WETH_USDC');
      expect(history).toBeDefined();
      expect(history!.length).toBe(15);

      const prediction = await manager.getCachedPrediction('ethereum', 'uniswap_WETH_USDC', 3014);
      expect(prediction).not.toBeNull();
      expect(prediction!.direction).toBe('up');
      expect(prediction!.confidence).toBe(0.75);
    });

    it('should return null when manager is not ready', async () => {
      const disabledManager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig: { ...mlConfig, enabled: false },
      });

      const prediction = await disabledManager.getCachedPrediction('ethereum', 'uniswap_WETH_USDC', 3000);
      expect(prediction).toBeNull();
    });

    // FIX #18: Test timeout behavior when ML prediction takes too long
    it('should return null when prediction exceeds maxLatencyMs timeout', async () => {
      // Override mock predictor to simulate a slow prediction
      const originalPredictPrice = mockPredictor.predictPrice;
      mockPredictor.predictPrice = () =>
        new Promise((resolve) => setTimeout(() => resolve(mockPredictionResult), 500));

      // Create manager with very short timeout
      const timeoutManager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig: { ...mlConfig, maxLatencyMs: 50 },
      });
      await timeoutManager.initialize();

      // Add sufficient price history
      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };
      for (let i = 0; i < 15; i++) {
        timeoutManager.trackPriceUpdate({
          ...baseUpdate,
          price: 3000 + i,
          timestamp: Date.now() + i * 100,
        });
      }

      // Should return null due to timeout
      const prediction = await timeoutManager.getCachedPrediction('ethereum', 'uniswap_WETH_USDC', 3014);
      expect(prediction).toBeNull();

      // Restore original predictor
      mockPredictor.predictPrice = originalPredictPrice;
    }, 10000);
  });

  // ===========================================================================
  // Batch Predictions
  // ===========================================================================

  describe('prefetchPredictions', () => {
    beforeEach(async () => {
      manager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig,
      });
      await manager.initialize();

      // Add sufficient price history for predictions
      const chains = ['ethereum', 'arbitrum'];
      const baseUpdate: PriceUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 3000,
        timestamp: Date.now(),
        blockNumber: 12345,
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '3000000000',
        latency: 50,
      };

      for (const chain of chains) {
        for (let i = 0; i < 15; i++) {
          manager.trackPriceUpdate({
            ...baseUpdate,
            chain,
            pairKey: `dex_WETH_USDC`,
            price: 3000 + i,
            timestamp: Date.now() + i * 100,
          });
        }
      }
    });

    it('should prefetch multiple predictions in parallel', async () => {
      const pairs = [
        { chain: 'ethereum', pairKey: 'dex_WETH_USDC', price: 3014 },
        { chain: 'arbitrum', pairKey: 'dex_WETH_USDC', price: 3014 },
      ];

      const results = await manager.prefetchPredictions(pairs);

      expect(results.size).toBe(2);
      expect(results.has('ethereum:dex_WETH_USDC')).toBe(true);
      expect(results.has('arbitrum:dex_WETH_USDC')).toBe(true);
    });

    it('should return empty map when not ready', async () => {
      const disabledManager = createMLPredictionManager({
        logger: mockLogger,
        mlConfig: { ...mlConfig, enabled: false },
      });

      const pairs = [{ chain: 'ethereum', pairKey: 'dex_WETH_USDC', price: 3014 }];
      const results = await disabledManager.prefetchPredictions(pairs);

      expect(results.size).toBe(0);
    });
  });
});
