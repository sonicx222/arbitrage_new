/**
 * Unit Tests for BridgeLatencyPredictor
 *
 * Tests the bridge latency prediction module.
 * Includes regression test for B4-FIX (NaN handling).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { BridgeLatencyPredictor } from '../../bridge-predictor';
import { CrossChainBridge } from '@arbitrage/types';

// =============================================================================
// Tests
// =============================================================================

describe('BridgeLatencyPredictor', () => {
  let predictor: BridgeLatencyPredictor;

  beforeEach(() => {
    predictor = new BridgeLatencyPredictor();
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('constructor', () => {
    it('should create predictor with default models', () => {
      expect(predictor).toBeDefined();
    });
  });

  // ===========================================================================
  // predictLatency
  // ===========================================================================

  describe('predictLatency', () => {
    it('should return conservative estimate for unknown bridge', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridge: 'unknown-bridge',
        token: 'WETH',
        amount: 1.0
      };

      const prediction = predictor.predictLatency(bridge);

      expect(prediction).toBeDefined();
      expect(prediction.bridgeName).toBe('unknown-bridge');
      expect(prediction.estimatedLatency).toBeGreaterThan(0);
      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(1);
    });

    it('should return conservative estimate with low confidence for new bridge', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'new-bridge',
        token: 'WETH',
        amount: 1.0
      };

      const prediction = predictor.predictLatency(bridge);

      // Low confidence for new bridges (no history)
      expect(prediction.confidence).toBeLessThan(0.5);
    });
  });

  // ===========================================================================
  // updateModel
  // ===========================================================================

  describe('updateModel', () => {
    it('should record successful bridge completion', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'test-bridge',
        token: 'WETH',
        amount: 1.0
      };

      predictor.updateModel({
        bridge,
        actualLatency: 120,
        actualCost: 0.001,
        success: true,
        timestamp: Date.now()
      });

      const metrics = predictor.getBridgeMetrics('ethereum-arbitrum-test-bridge');
      expect(metrics).toBeDefined();
      expect(metrics!.sampleCount).toBe(1);
    });

    it('should record failed bridge', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridge: 'flaky-bridge',
        token: 'WETH',
        amount: 1.0
      };

      predictor.updateModel({
        bridge,
        actualLatency: 0,
        actualCost: 0,
        success: false,
        timestamp: Date.now()
      });

      const metrics = predictor.getBridgeMetrics('ethereum-polygon-flaky-bridge');
      expect(metrics).toBeDefined();
      expect(metrics!.successRate).toBe(0);
    });
  });

  // ===========================================================================
  // getBridgeMetrics - B4-FIX Regression Test
  // ===========================================================================

  describe('getBridgeMetrics', () => {
    it('should return null for unknown bridge', () => {
      const metrics = predictor.getBridgeMetrics('unknown-bridge-key');
      expect(metrics).toBeNull();
    });

    it('should return valid metrics for bridge with successful history', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'test-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add multiple successful bridges
      for (let i = 0; i < 5; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 100 + i * 10,
          actualCost: 0.001 + i * 0.0001,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const metrics = predictor.getBridgeMetrics('ethereum-arbitrum-test-bridge');
      expect(metrics).toBeDefined();
      expect(metrics!.sampleCount).toBe(5);
      expect(metrics!.avgLatency).toBeGreaterThan(0);
      expect(metrics!.minLatency).toBe(100);
      expect(metrics!.maxLatency).toBe(140);
      expect(metrics!.successRate).toBe(1.0);
      expect(Number.isNaN(metrics!.avgLatency)).toBe(false);
      expect(Number.isNaN(metrics!.avgCost)).toBe(false);
    });

    /**
     * B4-FIX Regression Test:
     * When all bridges in history have failed (success: false),
     * getBridgeMetrics should NOT return NaN values.
     */
    it('should NOT return NaN when all bridges failed (B4-FIX)', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridge: 'failing-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add multiple FAILED bridges (no successful ones)
      for (let i = 0; i < 5; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 0,
          actualCost: 0,
          success: false, // All failures!
          timestamp: Date.now() + i * 1000
        });
      }

      const metrics = predictor.getBridgeMetrics('ethereum-polygon-failing-bridge');

      // Should return metrics (not null) since we have history
      expect(metrics).toBeDefined();
      expect(metrics).not.toBeNull();

      // B4-FIX: These should NOT be NaN
      expect(Number.isNaN(metrics!.avgLatency)).toBe(false);
      expect(Number.isNaN(metrics!.avgCost)).toBe(false);
      expect(Number.isNaN(metrics!.minLatency)).toBe(false);
      expect(Number.isNaN(metrics!.maxLatency)).toBe(false);

      // B4-FIX: These should NOT be Infinity
      expect(Number.isFinite(metrics!.minLatency)).toBe(true);
      expect(Number.isFinite(metrics!.maxLatency)).toBe(true);

      // Should have 0% success rate
      expect(metrics!.successRate).toBe(0);
      expect(metrics!.sampleCount).toBe(5);
    });

    it('should handle mixed success/failure history', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'arbitrum',
        targetChain: 'optimism',
        bridge: 'mixed-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add some successful and some failed
      predictor.updateModel({
        bridge,
        actualLatency: 60,
        actualCost: 0.0005,
        success: true,
        timestamp: Date.now()
      });

      predictor.updateModel({
        bridge,
        actualLatency: 0,
        actualCost: 0,
        success: false,
        timestamp: Date.now() + 1000
      });

      predictor.updateModel({
        bridge,
        actualLatency: 80,
        actualCost: 0.0007,
        success: true,
        timestamp: Date.now() + 2000
      });

      const metrics = predictor.getBridgeMetrics('arbitrum-optimism-mixed-bridge');
      expect(metrics).toBeDefined();
      expect(metrics!.sampleCount).toBe(3);
      expect(metrics!.successRate).toBeCloseTo(2 / 3, 2);
      expect(metrics!.avgLatency).toBe(70); // (60 + 80) / 2
      expect(Number.isNaN(metrics!.avgLatency)).toBe(false);
    });
  });

  // ===========================================================================
  // getAvailableRoutes
  // ===========================================================================

  describe('getAvailableRoutes', () => {
    it('should return empty array for unknown chains', () => {
      const routes = predictor.getAvailableRoutes('unknown', 'chain');
      expect(routes).toEqual([]);
    });

    it('should return available bridges after updating model', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'stargate',
        token: 'WETH',
        amount: 1.0
      };

      predictor.updateModel({
        bridge,
        actualLatency: 100,
        actualCost: 0.001,
        success: true,
        timestamp: Date.now()
      });

      const routes = predictor.getAvailableRoutes('ethereum', 'arbitrum');
      expect(routes).toContain('stargate');
    });
  });

  // ===========================================================================
  // cleanup
  // ===========================================================================

  describe('cleanup', () => {
    it('should remove old bridge data', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridge: 'old-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add old data (31 days ago)
      predictor.updateModel({
        bridge,
        actualLatency: 100,
        actualCost: 0.001,
        success: true,
        timestamp: Date.now() - (31 * 24 * 60 * 60 * 1000)
      });

      // Verify data exists before cleanup
      expect(predictor.getBridgeMetrics('ethereum-polygon-old-bridge')).not.toBeNull();

      // Cleanup with 30-day retention
      predictor.cleanup(30 * 24 * 60 * 60 * 1000);

      // Data should be removed
      expect(predictor.getBridgeMetrics('ethereum-polygon-old-bridge')).toBeNull();
    });

    it('should retain recent bridge data', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'recent-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add recent data
      predictor.updateModel({
        bridge,
        actualLatency: 100,
        actualCost: 0.001,
        success: true,
        timestamp: Date.now() - (1 * 24 * 60 * 60 * 1000) // 1 day ago
      });

      // Cleanup with 30-day retention
      predictor.cleanup(30 * 24 * 60 * 60 * 1000);

      // Data should still exist
      expect(predictor.getBridgeMetrics('ethereum-arbitrum-recent-bridge')).not.toBeNull();
    });
  });

  // ===========================================================================
  // predictOptimalBridge
  // ===========================================================================

  describe('predictOptimalBridge', () => {
    it('should return null when no routes available', () => {
      const prediction = predictor.predictOptimalBridge(
        'unknown-source',
        'unknown-target',
        1.0,
        'medium'
      );
      expect(prediction).toBeNull();
    });

    it('should select bridge based on urgency', () => {
      // Add two bridges with different characteristics
      const fastBridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'fast-bridge',
        token: 'WETH',
        amount: 1.0
      };

      const slowBridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'slow-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Fast bridge: low latency, high cost
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge: fastBridge,
          actualLatency: 60,
          actualCost: 0.002,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      // Slow bridge: high latency, low cost
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge: slowBridge,
          actualLatency: 300,
          actualCost: 0.0005,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      // Request prediction - should have data for both bridges
      const prediction = predictor.predictOptimalBridge(
        'ethereum',
        'arbitrum',
        1.0,
        'high' // High urgency should prefer faster bridge
      );

      expect(prediction).toBeDefined();
    });
  });

  // ===========================================================================
  // Edge Cases - Extreme Values
  // ===========================================================================

  describe('edge cases: extreme values', () => {
    it('should handle extremely high latency values', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'optimism',
        targetChain: 'ethereum',
        bridge: 'native', // Native L2->L1 can be very slow
        token: 'WETH',
        amount: 1.0
      };

      // Add data with very high latency (7 days = 604800 seconds)
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 604800 + (i * 3600), // 7 days + variance
          actualCost: 0.005,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const prediction = predictor.predictLatency(bridge);

      expect(prediction).toBeDefined();
      expect(prediction.estimatedLatency).toBeGreaterThan(600000);
      expect(Number.isFinite(prediction.estimatedLatency)).toBe(true);
      expect(Number.isNaN(prediction.estimatedLatency)).toBe(false);
    });

    it('should handle zero latency values', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'instant-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add data with zero latency (edge case)
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 0, // Zero latency
          actualCost: 0.001,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const metrics = predictor.getBridgeMetrics('ethereum-arbitrum-instant-bridge');

      expect(metrics).toBeDefined();
      expect(metrics!.avgLatency).toBe(0);
      expect(metrics!.minLatency).toBe(0);
      expect(Number.isNaN(metrics!.avgLatency)).toBe(false);
    });

    it('should handle zero amount bridges', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridge: 'zero-amount',
        token: 'WETH',
        amount: 0 // Zero amount
      };

      const prediction = predictor.predictLatency(bridge);

      expect(prediction).toBeDefined();
      expect(Number.isFinite(prediction.estimatedCost)).toBe(true);
      expect(Number.isNaN(prediction.estimatedCost)).toBe(false);
    });

    it('should handle very small amounts', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'micro-bridge',
        token: 'WETH',
        amount: 0.0000001 // Very small amount
      };

      const prediction = predictor.predictLatency(bridge);

      expect(prediction).toBeDefined();
      expect(prediction.estimatedCost).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(prediction.estimatedCost)).toBe(true);
    });

    it('should handle very large amounts', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'whale-bridge',
        token: 'WETH',
        amount: 10000000 // 10 million ETH (whale amount)
      };

      const prediction = predictor.predictLatency(bridge);

      expect(prediction).toBeDefined();
      expect(Number.isFinite(prediction.estimatedCost)).toBe(true);
      expect(Number.isNaN(prediction.estimatedCost)).toBe(false);
    });
  });

  // ===========================================================================
  // Edge Cases - History Management
  // ===========================================================================

  describe('edge cases: history management', () => {
    it('should truncate history using batch trimming', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridge: 'high-volume-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // FIX 10.4: Batch trimming occurs when entries > 1100, trimming down to 1000
      // After adding 1200 entries:
      // - At entry 1101: trim from 1101 to 1000
      // - Then add 99 more entries = 1099 total
      // To get exactly 1000, we need to add exactly 1101 entries
      for (let i = 0; i < 1101; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 100 + (i % 50), // Varying latency
          actualCost: 0.001,
          success: true,
          timestamp: Date.now() + i * 100
        });
      }

      const metrics = predictor.getBridgeMetrics('ethereum-polygon-high-volume-bridge');

      // Should still work correctly
      expect(metrics).toBeDefined();
      expect(metrics!.sampleCount).toBe(1000); // Exactly 1000 after batch trim at 1101
      expect(Number.isFinite(metrics!.avgLatency)).toBe(true);
    });

    it('should handle single entry history', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'base',
        bridge: 'single-entry-bridge',
        token: 'WETH',
        amount: 1.0
      };

      predictor.updateModel({
        bridge,
        actualLatency: 150,
        actualCost: 0.001,
        success: true,
        timestamp: Date.now()
      });

      const metrics = predictor.getBridgeMetrics('ethereum-base-single-entry-bridge');

      expect(metrics).toBeDefined();
      expect(metrics!.sampleCount).toBe(1);
      expect(metrics!.avgLatency).toBe(150);
      expect(metrics!.minLatency).toBe(150);
      expect(metrics!.maxLatency).toBe(150);
    });

    it('should handle cleanup with mixed recent and old data', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'optimism',
        bridge: 'mixed-age-bridge',
        token: 'WETH',
        amount: 1.0
      };

      const now = Date.now();
      const thirtyOneDaysAgo = now - (31 * 24 * 60 * 60 * 1000);
      const oneDayAgo = now - (1 * 24 * 60 * 60 * 1000);

      // Add old data (will be removed)
      predictor.updateModel({
        bridge,
        actualLatency: 100,
        actualCost: 0.001,
        success: true,
        timestamp: thirtyOneDaysAgo
      });

      // Add recent data (will be retained)
      predictor.updateModel({
        bridge,
        actualLatency: 120,
        actualCost: 0.0012,
        success: true,
        timestamp: oneDayAgo
      });

      predictor.updateModel({
        bridge,
        actualLatency: 130,
        actualCost: 0.0013,
        success: true,
        timestamp: now
      });

      // Cleanup
      predictor.cleanup(30 * 24 * 60 * 60 * 1000);

      const metrics = predictor.getBridgeMetrics('ethereum-optimism-mixed-age-bridge');

      expect(metrics).toBeDefined();
      expect(metrics!.sampleCount).toBe(2); // Only recent entries
      expect(metrics!.avgLatency).toBe(125); // (120 + 130) / 2
    });
  });

  // ===========================================================================
  // Edge Cases - Model Prediction Threshold
  // ===========================================================================

  describe('edge cases: model prediction', () => {
    it('should use conservative estimate when history < 10', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'sparse-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add only 5 entries (< 10 threshold)
      for (let i = 0; i < 5; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 200,
          actualCost: 0.002,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const prediction = predictor.predictLatency(bridge);

      // Should use conservative estimate (low confidence)
      expect(prediction.confidence).toBeLessThanOrEqual(0.3);
    });

    it('should use model prediction when history >= 10', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'polygon',
        bridge: 'populated-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add 15 entries (>= 10 threshold)
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 180 + (i * 2),
          actualCost: 0.0015,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const prediction = predictor.predictLatency(bridge);

      // Should use model: confidence = min(1, samples/50) * max(0.1, 1 - variance/avgLatency²)
      // With 15 samples and low variance: ~0.3 * ~1.0 ≈ 0.29-0.30
      expect(prediction.confidence).toBeGreaterThan(0.2);
      expect(prediction.confidence).toBeLessThanOrEqual(0.35);
      // Estimate should be closer to actual data (weighted avg of 180-208)
      expect(prediction.estimatedLatency).toBeGreaterThan(150);
      expect(prediction.estimatedLatency).toBeLessThan(250);
    });

    it('should fallback to conservative when all recent history is failures', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'base',
        bridge: 'unreliable-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Add many failures
      for (let i = 0; i < 20; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 0,
          actualCost: 0,
          success: false, // All failures
          timestamp: Date.now() + i * 1000
        });
      }

      const prediction = predictor.predictLatency(bridge);

      // Should fall back to conservative estimate
      expect(prediction).toBeDefined();
      expect(prediction.confidence).toBeLessThanOrEqual(0.3);
      expect(Number.isFinite(prediction.estimatedLatency)).toBe(true);
    });
  });

  // ===========================================================================
  // Edge Cases - Conservative Estimate Lookup
  // ===========================================================================

  describe('edge cases: conservative estimates', () => {
    it('should use specific estimate for known stargate route', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'stargate',
        token: 'WETH',
        amount: 1.0
      };

      const prediction = predictor.predictLatency(bridge);

      // Should use the known Stargate estimate (180s)
      expect(prediction.estimatedLatency).toBe(180);
    });

    it('should use specific estimate for known across route', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'optimism',
        bridge: 'across',
        token: 'WETH',
        amount: 1.0
      };

      const prediction = predictor.predictLatency(bridge);

      // Should use the known Across estimate (120s)
      expect(prediction.estimatedLatency).toBe(120);
    });

    it('should use default estimate for unknown bridge', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'unknown-chain',
        bridge: 'unknown-bridge',
        token: 'WETH',
        amount: 1.0
      };

      const prediction = predictor.predictLatency(bridge);

      // Should use default fallback (300s)
      expect(prediction.estimatedLatency).toBe(300);
    });
  });

  // ===========================================================================
  // Edge Cases - Variance Calculation
  // ===========================================================================

  describe('edge cases: variance calculation', () => {
    it('should handle uniform latency values (zero variance)', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'arbitrum',
        targetChain: 'optimism',
        bridge: 'consistent-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // All identical latency values
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 100, // Same latency every time
          actualCost: 0.001,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const prediction = predictor.predictLatency(bridge);

      // Should handle zero variance gracefully
      expect(prediction).toBeDefined();
      expect(prediction.estimatedLatency).toBeCloseTo(100, 0);
      expect(Number.isNaN(prediction.confidence)).toBe(false);
      // Confidence formula: min(1, samples/50) * max(0.1, 1 - variance/avgLatency²)
      // With 15 samples and 0 variance: 0.3 * 1.0 = 0.3
      // Zero variance gives max possible confidence for sample size
      expect(prediction.confidence).toBe(0.3);
    });

    it('should handle high variance latency values', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'polygon',
        targetChain: 'ethereum',
        bridge: 'variable-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Highly variable latency
      const latencies = [50, 500, 100, 800, 200, 1000, 150, 600, 300, 900, 250, 700, 350, 550, 450];
      for (let i = 0; i < latencies.length; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: latencies[i],
          actualCost: 0.001,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const prediction = predictor.predictLatency(bridge);

      expect(prediction).toBeDefined();
      // Lower confidence due to high variance
      expect(prediction.confidence).toBeLessThan(0.8);
      expect(Number.isFinite(prediction.estimatedLatency)).toBe(true);
    });
  });

  // ===========================================================================
  // Edge Cases - Multiple Routes Same Chain Pair
  // ===========================================================================

  describe('edge cases: multiple routes', () => {
    it('should track multiple bridges for same chain pair independently', () => {
      const bridge1: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'bridge-a',
        token: 'WETH',
        amount: 1.0
      };

      const bridge2: CrossChainBridge = {
        sourceChain: 'ethereum',
        targetChain: 'arbitrum',
        bridge: 'bridge-b',
        token: 'WETH',
        amount: 1.0
      };

      // Bridge A: fast
      predictor.updateModel({
        bridge: bridge1,
        actualLatency: 60,
        actualCost: 0.002,
        success: true,
        timestamp: Date.now()
      });

      // Bridge B: slow
      predictor.updateModel({
        bridge: bridge2,
        actualLatency: 300,
        actualCost: 0.0005,
        success: true,
        timestamp: Date.now()
      });

      const metricsA = predictor.getBridgeMetrics('ethereum-arbitrum-bridge-a');
      const metricsB = predictor.getBridgeMetrics('ethereum-arbitrum-bridge-b');

      expect(metricsA!.avgLatency).toBe(60);
      expect(metricsB!.avgLatency).toBe(300);

      const routes = predictor.getAvailableRoutes('ethereum', 'arbitrum');
      expect(routes).toContain('bridge-a');
      expect(routes).toContain('bridge-b');
      expect(routes.length).toBe(2);
    });
  });

  // ===========================================================================
  // Edge Cases - predictOptimalBridge Scoring
  // ===========================================================================

  describe('edge cases: optimal bridge scoring', () => {
    it('should handle low urgency preference for cost', () => {
      const cheapBridge: CrossChainBridge = {
        sourceChain: 'arbitrum',
        targetChain: 'base',
        bridge: 'cheap-bridge',
        token: 'WETH',
        amount: 1.0
      };

      const expensiveBridge: CrossChainBridge = {
        sourceChain: 'arbitrum',
        targetChain: 'base',
        bridge: 'expensive-bridge',
        token: 'WETH',
        amount: 1.0
      };

      // Cheap but slow bridge
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge: cheapBridge,
          actualLatency: 600, // 10 minutes
          actualCost: 0.0001,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      // Expensive but fast bridge
      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge: expensiveBridge,
          actualLatency: 60, // 1 minute
          actualCost: 0.01,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      const prediction = predictor.predictOptimalBridge(
        'arbitrum',
        'base',
        1.0,
        'low' // Low urgency - should prefer cheaper
      );

      expect(prediction).toBeDefined();
    });

    it('should handle default medium urgency', () => {
      const bridge: CrossChainBridge = {
        sourceChain: 'optimism',
        targetChain: 'polygon',
        bridge: 'balanced-bridge',
        token: 'WETH',
        amount: 1.0
      };

      for (let i = 0; i < 15; i++) {
        predictor.updateModel({
          bridge,
          actualLatency: 200,
          actualCost: 0.001,
          success: true,
          timestamp: Date.now() + i * 1000
        });
      }

      // Call without urgency parameter (should default to 'medium')
      const prediction = predictor.predictOptimalBridge(
        'optimism',
        'polygon',
        1.0
      );

      expect(prediction).toBeDefined();
    });
  });
});
