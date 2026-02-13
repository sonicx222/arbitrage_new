// Bridge Latency Prediction Engine
// Uses machine learning to predict cross-chain bridge times and costs

import { CircularBuffer } from '@arbitrage/core';
import { BridgeLatencyData, CrossChainBridge } from '@arbitrage/types';
// FIX #21: Import Logger type for DI instead of module-level createLogger
import { Logger } from './types';

// =============================================================================
// FIX #10: Centralized bridge route configuration
// Single source of truth for bridge latency/cost estimates
// =============================================================================

/**
 * Bridge route estimates used for both model initialization and conservative fallbacks.
 * Format: bridgeKey -> { latency (seconds), cost (ETH) }
 *
 * Bridge Key Format: `${sourceChain}-${targetChain}-${bridge}`
 *
 * Latency estimates based on typical bridge characteristics:
 * - Stargate/LayerZero: ~3 minutes for L2s, 3 minutes for L1->L2
 * - Across Protocol: ~2 minutes with relayer model
 * - Native bridges: Variable (L2→L1 can be 7 days due to fraud proof window)
 */
const BRIDGE_ROUTE_ESTIMATES: Record<string, { latency: number; cost: number }> = {
  // Stargate routes (common cross-chain bridge)
  'ethereum-arbitrum-stargate': { latency: 180, cost: 0.001 },
  'ethereum-optimism-stargate': { latency: 180, cost: 0.001 },
  'ethereum-polygon-stargate': { latency: 180, cost: 0.001 },
  'ethereum-base-stargate': { latency: 180, cost: 0.001 },
  'ethereum-bsc-stargate': { latency: 180, cost: 0.001 },
  'arbitrum-ethereum-stargate': { latency: 180, cost: 0.0005 },
  'arbitrum-optimism-stargate': { latency: 90, cost: 0.0003 },
  'arbitrum-base-stargate': { latency: 90, cost: 0.0003 },
  'optimism-arbitrum-stargate': { latency: 90, cost: 0.0003 },
  'optimism-base-stargate': { latency: 90, cost: 0.0003 },
  'base-arbitrum-stargate': { latency: 90, cost: 0.0003 },
  'base-optimism-stargate': { latency: 90, cost: 0.0003 },

  // Across Protocol routes (faster with relayer model)
  'ethereum-arbitrum-across': { latency: 120, cost: 0.002 },
  'ethereum-optimism-across': { latency: 120, cost: 0.002 },
  'ethereum-polygon-across': { latency: 120, cost: 0.002 },
  'ethereum-base-across': { latency: 120, cost: 0.002 },
  'arbitrum-ethereum-across': { latency: 120, cost: 0.001 },
  'arbitrum-optimism-across': { latency: 60, cost: 0.0005 },
  'optimism-arbitrum-across': { latency: 60, cost: 0.0005 },
  'base-arbitrum-across': { latency: 60, cost: 0.0005 },

  // Native bridges (L2→L1 is slow - 7 day fraud proof window)
  'arbitrum-ethereum-native': { latency: 604800, cost: 0.005 },
  'optimism-ethereum-native': { latency: 604800, cost: 0.005 },
  'base-ethereum-native': { latency: 604800, cost: 0.005 },

  // Phase 4: Connext routes (liquidity network + optimistic messaging)
  // Connext uses liquidity pools with relayers for fast settlement
  // Latency: 60-120s typical, Cost: ~0.03-0.05% fee
  // Research impact: +5-8% more cross-chain opportunities
  'ethereum-arbitrum-connext': { latency: 90, cost: 0.0006 },
  'ethereum-optimism-connext': { latency: 90, cost: 0.0006 },
  'ethereum-polygon-connext': { latency: 90, cost: 0.0006 },
  'ethereum-bsc-connext': { latency: 120, cost: 0.0008 },
  'ethereum-base-connext': { latency: 90, cost: 0.0006 },
  'arbitrum-ethereum-connext': { latency: 90, cost: 0.0004 },
  'arbitrum-optimism-connext': { latency: 60, cost: 0.0003 },
  'arbitrum-polygon-connext': { latency: 90, cost: 0.0004 },
  'arbitrum-base-connext': { latency: 60, cost: 0.0003 },
  'optimism-ethereum-connext': { latency: 90, cost: 0.0004 },
  'optimism-arbitrum-connext': { latency: 60, cost: 0.0003 },
  'optimism-polygon-connext': { latency: 90, cost: 0.0004 },
  'optimism-base-connext': { latency: 60, cost: 0.0003 },
  'polygon-ethereum-connext': { latency: 90, cost: 0.0004 },
  'polygon-arbitrum-connext': { latency: 90, cost: 0.0004 },
  'polygon-optimism-connext': { latency: 90, cost: 0.0004 },
  'base-ethereum-connext': { latency: 90, cost: 0.0004 },
  'base-arbitrum-connext': { latency: 60, cost: 0.0003 },
  'base-optimism-connext': { latency: 60, cost: 0.0003 },

  // Phase 3: Hyperlane routes (permissionless interoperability)
  // Hyperlane offers customizable security with ISM (Interchain Security Module)
  // Latency: 100-200s typical, Cost: ~0.05% fee
  'ethereum-arbitrum-hyperlane': { latency: 120, cost: 0.0008 },
  'ethereum-optimism-hyperlane': { latency: 120, cost: 0.0008 },
  'ethereum-polygon-hyperlane': { latency: 150, cost: 0.0008 },
  'ethereum-base-hyperlane': { latency: 120, cost: 0.0008 },
  'ethereum-avalanche-hyperlane': { latency: 180, cost: 0.0008 },
  'ethereum-bsc-hyperlane': { latency: 180, cost: 0.0008 },
  'arbitrum-ethereum-hyperlane': { latency: 120, cost: 0.0005 },
  'arbitrum-optimism-hyperlane': { latency: 90, cost: 0.0003 },
  'arbitrum-base-hyperlane': { latency: 90, cost: 0.0003 },
  'arbitrum-polygon-hyperlane': { latency: 120, cost: 0.0003 },
  'optimism-ethereum-hyperlane': { latency: 120, cost: 0.0005 },
  'optimism-arbitrum-hyperlane': { latency: 90, cost: 0.0003 },
  'optimism-base-hyperlane': { latency: 90, cost: 0.0003 },
  'base-ethereum-hyperlane': { latency: 120, cost: 0.0005 },
  'base-arbitrum-hyperlane': { latency: 90, cost: 0.0003 },
  'base-optimism-hyperlane': { latency: 90, cost: 0.0003 },
  'polygon-ethereum-hyperlane': { latency: 150, cost: 0.0005 },
  'polygon-arbitrum-hyperlane': { latency: 120, cost: 0.0003 },
};

// Default estimate for unknown routes
const DEFAULT_BRIDGE_ESTIMATE = { latency: 300, cost: 0.0015 };

export interface BridgePrediction {
  bridgeName: string;
  estimatedLatency: number; // in seconds
  estimatedCost: number; // in wei
  confidence: number; // 0-1
  historicalAccuracy: number;
}

export interface BridgeMetrics {
  bridgeName: string;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  avgCost: number;
  successRate: number;
  sampleCount: number;
}

// P2-FIX 3.2: Max history size for CircularBuffer
const MAX_BRIDGE_HISTORY_SIZE = 1000;

/**
 * FIX #22: Typed prediction model structure.
 * Replaces `Map<string, any>` with a well-defined interface matching
 * the shape written by `updateStatisticalModel()` and `initializeModels()`.
 */
export interface BridgePredictionModel {
  latencyModel: {
    mean: number;
    stdDev: number;
    trend: number;
  };
  costModel: {
    baseCost: number;
    congestionMultiplier: number;
    amountMultiplier: number;
  };
}

export class BridgeLatencyPredictor {
  // P2-FIX 3.2: Use CircularBuffer for O(1) append instead of O(n) splice
  private bridgeHistory: Map<string, CircularBuffer<BridgeLatencyData>> = new Map();
  private predictionModel: Map<string, BridgePredictionModel> = new Map();
  private metricsCache: Map<string, BridgeMetrics> = new Map();

  // FIX #21: DI logger instead of module-level createLogger
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.initializeModels();
  }

  // Predict latency and cost for a cross-chain bridge
  predictLatency(bridge: CrossChainBridge): BridgePrediction {
    const bridgeKey = `${bridge.sourceChain}-${bridge.targetChain}-${bridge.bridge}`;
    const historyBuffer = this.bridgeHistory.get(bridgeKey);

    // P2-FIX 3.2: Use CircularBuffer size property
    if (!historyBuffer || historyBuffer.size < 10) {
      // Not enough data, use conservative estimates
      return this.getConservativeEstimate(bridge);
    }

    // Use statistical model for prediction
    // NOTE: Per-prediction debug logging removed - fires during opportunity evaluation
    // P2-FIX 3.2: Convert to array for model prediction
    return this.predictUsingModel(bridge, historyBuffer.toArray());
  }

  // Update model with actual bridge completion data
  updateModel(actualResult: {
    bridge: CrossChainBridge;
    actualLatency: number;
    actualCost: number;
    success: boolean;
    timestamp: number;
  }): void {
    const bridgeKey = `${actualResult.bridge.sourceChain}-${actualResult.bridge.targetChain}-${actualResult.bridge.bridge}`;

    // P2-FIX 3.2: Create CircularBuffer if not exists
    if (!this.bridgeHistory.has(bridgeKey)) {
      this.bridgeHistory.set(bridgeKey, new CircularBuffer<BridgeLatencyData>(MAX_BRIDGE_HISTORY_SIZE));
    }

    const historyBuffer = this.bridgeHistory.get(bridgeKey)!;
    const dataPoint: BridgeLatencyData = {
      bridge: actualResult.bridge.bridge,
      sourceChain: actualResult.bridge.sourceChain,
      targetChain: actualResult.bridge.targetChain,
      token: actualResult.bridge.token,
      amount: actualResult.bridge.amount,
      latency: actualResult.actualLatency,
      cost: actualResult.actualCost,
      success: actualResult.success,
      timestamp: actualResult.timestamp,
      congestionLevel: this.estimateCongestion(actualResult.timestamp),
      gasPrice: this.estimateGasPrice(actualResult.timestamp)
    };

    // P2-FIX 3.2: O(1) push with auto-eviction of oldest when full (replaces O(n) splice)
    historyBuffer.pushOverwrite(dataPoint);

    // Update statistical model
    // P2-FIX 3.2: Convert to array for model update
    this.updateStatisticalModel(bridgeKey, historyBuffer.toArray());

    // Invalidate metrics cache
    this.metricsCache.delete(bridgeKey);
  }

  // Get bridge performance metrics
  // P2-FIX 3.2: Updated to work with CircularBuffer
  getBridgeMetrics(bridgeKey: string): BridgeMetrics | null {
    if (this.metricsCache.has(bridgeKey)) {
      return this.metricsCache.get(bridgeKey)!;
    }

    const historyBuffer = this.bridgeHistory.get(bridgeKey);
    // P2-FIX 3.2: Use CircularBuffer's size property
    if (!historyBuffer || historyBuffer.size === 0) {
      return null;
    }

    // P2-FIX 3.2: CircularBuffer has filter() method
    const successfulBridges = historyBuffer.filter(h => h.success);
    const latencies = successfulBridges.map(h => h.latency);
    const costs = successfulBridges.map(h => h.cost);

    const totalSize = historyBuffer.size;

    // B4-FIX: Handle case where all bridges failed (no successful bridges)
    // Return null if we have no successful bridges to calculate metrics from
    if (latencies.length === 0) {
      // Return partial metrics showing 0% success rate but no latency/cost data
      const failureMetrics: BridgeMetrics = {
        bridgeName: bridgeKey,
        avgLatency: 0,
        minLatency: 0,
        maxLatency: 0,
        avgCost: 0,
        successRate: 0,
        sampleCount: totalSize
      };
      this.metricsCache.set(bridgeKey, failureMetrics);
      return failureMetrics;
    }

    // FIX #10: Use reduce instead of Math.min/max spread to prevent RangeError
    // when latencies array exceeds ~65K entries (stack overflow on spread args)
    const metrics: BridgeMetrics = {
      bridgeName: bridgeKey,
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      minLatency: latencies.reduce((a, b) => a < b ? a : b, Infinity),
      maxLatency: latencies.reduce((a, b) => a > b ? a : b, -Infinity),
      avgCost: costs.reduce((a, b) => a + b, 0) / costs.length,
      successRate: successfulBridges.length / totalSize,
      sampleCount: totalSize
    };

    this.metricsCache.set(bridgeKey, metrics);
    return metrics;
  }

  // Get all available bridge routes
  getAvailableRoutes(sourceChain: string, targetChain: string): string[] {
    const routes: string[] = [];
    const prefix = `${sourceChain}-${targetChain}-`;

    for (const bridgeKey of this.bridgeHistory.keys()) {
      if (bridgeKey.startsWith(prefix)) {
        const bridge = bridgeKey.replace(prefix, '');
        routes.push(bridge);
      }
    }

    return routes;
  }

  // Predict optimal bridge for given conditions
  // FIX: Added token parameter instead of hardcoded 'ETH'
  predictOptimalBridge(
    sourceChain: string,
    targetChain: string,
    amount: number,
    urgency: 'low' | 'medium' | 'high' = 'medium',
    token: string = 'ETH' // FIX: Parameterized token with sensible default
  ): BridgePrediction | null {
    const availableBridges = this.getAvailableRoutes(sourceChain, targetChain);

    if (availableBridges.length === 0) {
      return null;
    }

    let bestPrediction: BridgePrediction | null = null;
    let bestScore = -1;

    for (const bridge of availableBridges) {
      const bridgeObj: CrossChainBridge = {
        bridge,
        sourceChain,
        targetChain,
        token, // FIX: Use parameterized token
        amount
      };

      const prediction = this.predictLatency(bridgeObj);

      // Score based on latency, cost, and confidence
      // Adjust weights based on urgency
      const latencyWeight = urgency === 'high' ? 0.6 : urgency === 'medium' ? 0.4 : 0.2;
      const costWeight = 0.3;
      const confidenceWeight = 0.1;

      // Normalize latency (lower is better)
      const maxReasonableLatency = 3600; // 1 hour
      const normalizedLatency = Math.max(0, 1 - (prediction.estimatedLatency / maxReasonableLatency));

      // Normalize cost (lower is better, but relative to amount)
      const costRatio = prediction.estimatedCost / (amount * 1e18); // Assume 1 ETH worth
      const normalizedCost = Math.max(0, 1 - costRatio);

      const score = (latencyWeight * normalizedLatency) +
                   (costWeight * normalizedCost) +
                   (confidenceWeight * prediction.confidence);

      if (score > bestScore) {
        bestScore = score;
        bestPrediction = prediction;
      }
    }

    return bestPrediction;
  }

  private initializeModels(): void {
    // FIX #10: Use centralized BRIDGE_ROUTE_ESTIMATES for initialization
    // This ensures consistency between model initialization and fallback estimates
    for (const [bridgeRoute, estimate] of Object.entries(BRIDGE_ROUTE_ESTIMATES)) {
      this.predictionModel.set(bridgeRoute, {
        latencyModel: {
          mean: estimate.latency,
          stdDev: estimate.latency * 0.4, // 40% variance
          trend: 0.001 // Slight upward trend
        },
        costModel: {
          baseCost: estimate.cost,
          congestionMultiplier: 1.5,
          amountMultiplier: 0.0001
        }
      });
    }
  }

  private predictUsingModel(bridge: CrossChainBridge, history: BridgeLatencyData[]): BridgePrediction {
    const bridgeKey = `${bridge.sourceChain}-${bridge.targetChain}-${bridge.bridge}`;

    // Simple exponential moving average prediction
    const recentHistory = history.slice(-50); // Last 50 transactions
    const successfulRecent = recentHistory.filter(h => h.success);

    if (successfulRecent.length === 0) {
      return this.getConservativeEstimate(bridge);
    }

    // Calculate weighted average latency (more recent = higher weight)
    // WEIGHT-FIX: Reverse index so that more recent entries (higher index) get higher weight
    let weightedLatency = 0;
    let totalWeight = 0;
    const len = successfulRecent.length;

    for (let i = 0; i < len; i++) {
      // i=0 (oldest) gets lowest weight, i=len-1 (newest) gets highest weight
      const weight = Math.exp(i / len); // Exponential weighting: e^0 to e^1
      weightedLatency += successfulRecent[i].latency * weight;
      totalWeight += weight;
    }

    const avgLatency = weightedLatency / totalWeight;

    // Estimate cost based on amount and congestion
    const congestionLevel = this.estimateCongestion(Date.now());
    const baseCost = 0.001 * bridge.amount; // 0.1% of amount
    const congestionCost = baseCost * (1 + congestionLevel * 0.5);
    const estimatedCost = congestionCost * 1e18; // Convert to wei

    // Calculate confidence based on sample size and variance
    const latencies = successfulRecent.map(h => h.latency);
    const variance = this.calculateVariance(latencies, avgLatency);
    const confidence = Math.min(1.0, successfulRecent.length / 50.0) *
                      Math.max(0.1, 1.0 - (variance / (avgLatency * avgLatency)));

    return {
      bridgeName: bridge.bridge,
      estimatedLatency: avgLatency,
      estimatedCost,
      confidence,
      historicalAccuracy: this.calculateHistoricalAccuracy(successfulRecent)
    };
  }

  private getConservativeEstimate(bridge: CrossChainBridge): BridgePrediction {
    // FIX #10: Use centralized BRIDGE_ROUTE_ESTIMATES instead of duplicating data
    // Conservative estimates when we don't have enough historical data
    const bridgeKey = `${bridge.sourceChain}-${bridge.targetChain}-${bridge.bridge}`;
    const estimate = BRIDGE_ROUTE_ESTIMATES[bridgeKey] || DEFAULT_BRIDGE_ESTIMATE;

    return {
      bridgeName: bridge.bridge,
      estimatedLatency: estimate.latency,
      estimatedCost: estimate.cost * bridge.amount * 1e18,
      confidence: 0.3, // Low confidence for conservative estimates
      historicalAccuracy: 0.0
    };
  }

  private updateStatisticalModel(bridgeKey: string, history: BridgeLatencyData[]): void {
    const successfulHistory = history.filter(h => h.success);

    if (successfulHistory.length < 5) return;

    // Update latency model
    const latencies = successfulHistory.map(h => h.latency);
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const variance = this.calculateVariance(latencies, mean);
    const stdDev = Math.sqrt(variance);

    // Detect trend (linear regression on timestamps)
    const trend = this.calculateTrend(successfulHistory);

    const model = {
      latencyModel: {
        mean,
        stdDev,
        trend
      },
      costModel: {
        baseCost: successfulHistory.reduce((sum, h) => sum + h.cost, 0) / successfulHistory.length,
        congestionMultiplier: 1.2,
        amountMultiplier: 0.00005
      }
    };

    this.predictionModel.set(bridgeKey, model);
  }

  private calculateVariance(values: number[], mean: number): number {
    const squaredDiffs = values.map(val => (val - mean) ** 2);
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateTrend(history: BridgeLatencyData[]): number {
    if (history.length < 2) return 0;

    // Simple linear regression: y = mx + b
    const n = history.length;
    const sumX = history.reduce((sum, h, i) => sum + i, 0);
    const sumY = history.reduce((sum, h) => sum + h.latency, 0);
    const sumXY = history.reduce((sum, h, i) => sum + i * h.latency, 0);
    const sumXX = history.reduce((sum, h, i) => sum + i * i, 0);

    // FIX 4.1: Guard against division by zero when denominator is zero
    const denominator = n * sumXX - sumX * sumX;
    if (denominator === 0 || !Number.isFinite(denominator)) {
      return 0;
    }

    const slope = (n * sumXY - sumX * sumY) / denominator;
    return Number.isFinite(slope) ? slope : 0;
  }

  // FIX #21: O(n²) → O(n) using running sum accumulator instead of slice+reduce per iteration
  private calculateHistoricalAccuracy(history: BridgeLatencyData[]): number {
    if (history.length < 2) return 0;

    // Calculate prediction accuracy based on recent performance
    let totalError = 0;
    let count = 0;

    // Pre-compute running sum for indices 0..9 (the initial window before we start predicting)
    let runningSum = 0;
    const startIndex = Math.min(10, history.length);
    for (let j = 0; j < startIndex; j++) {
      runningSum += history[j].latency;
    }

    for (let i = 10; i < history.length; i++) {
      // runningSum contains sum of history[0..i-1], runningCount = i
      const predictedLatency = runningSum / i;
      const actualLatency = history[i].latency;

      const error = Math.abs(predictedLatency - actualLatency) / actualLatency;
      totalError += error;
      count++;

      // Update running sum to include history[i] for next iteration
      runningSum += history[i].latency;
    }

    return count > 0 ? Math.max(0, 1 - totalError / count) : 0;
  }

  private estimateCongestion(timestamp: number): number {
    // Simple congestion estimation based on time of day
    // More sophisticated implementation would use on-chain data
    const hour = new Date(timestamp).getUTCHours();

    // Higher congestion during peak hours (12-18 UTC)
    if (hour >= 12 && hour <= 18) {
      return 0.7; // 70% congestion
    } else if (hour >= 6 && hour <= 23) {
      return 0.4; // 40% congestion
    } else {
      return 0.1; // 10% congestion (off-peak)
    }
  }

  private estimateGasPrice(timestamp: number): number {
    // Simple gas price estimation
    // In production, this would integrate with gas price oracles
    const congestion = this.estimateCongestion(timestamp);
    const baseGasPrice = 20; // 20 gwei base

    return baseGasPrice * (1 + congestion * 2);
  }

  // Cleanup old data
  // P2-FIX 3.2: Updated to work with CircularBuffer
  cleanup(maxAge: number = 30 * 24 * 60 * 60 * 1000): void { // 30 days
    const cutoffTime = Date.now() - maxAge;

    for (const [bridgeKey, historyBuffer] of this.bridgeHistory.entries()) {
      // P2-FIX 3.2: CircularBuffer.filter() returns an array
      const filteredData = historyBuffer.filter(h => h.timestamp > cutoffTime);

      if (filteredData.length === 0) {
        // No recent data - remove the bridge entirely
        this.bridgeHistory.delete(bridgeKey);
        this.predictionModel.delete(bridgeKey);
        this.metricsCache.delete(bridgeKey);
      } else if (filteredData.length < historyBuffer.size) {
        // Some old data removed - create new buffer with filtered data
        const newBuffer = new CircularBuffer<BridgeLatencyData>(MAX_BRIDGE_HISTORY_SIZE);
        for (const dataPoint of filteredData) {
          newBuffer.pushOverwrite(dataPoint);
        }
        this.bridgeHistory.set(bridgeKey, newBuffer);
        // Invalidate caches since data changed
        this.metricsCache.delete(bridgeKey);
      }
      // If filteredData.length === historyBuffer.size, no cleanup needed
    }

    this.logger.info('Bridge predictor cleanup completed', {
      remainingBridges: this.bridgeHistory.size
    });
  }
}