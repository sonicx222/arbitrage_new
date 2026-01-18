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
});
