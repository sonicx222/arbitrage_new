"use strict";
// Bridge Latency Prediction Engine
// Uses machine learning to predict cross-chain bridge times and costs
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeLatencyPredictor = void 0;
const src_1 = require("../../../shared/core/src");
const logger = (0, src_1.createLogger)('bridge-predictor');
class BridgeLatencyPredictor {
    constructor() {
        this.bridgeHistory = new Map();
        this.predictionModel = new Map(); // Simple statistical models
        this.metricsCache = new Map();
        this.initializeModels();
    }
    // Predict latency and cost for a cross-chain bridge
    predictLatency(bridge) {
        const bridgeKey = `${bridge.sourceChain}-${bridge.targetChain}-${bridge.bridge}`;
        const history = this.bridgeHistory.get(bridgeKey) || [];
        if (history.length < 10) {
            // Not enough data, use conservative estimates
            return this.getConservativeEstimate(bridge);
        }
        // Use statistical model for prediction
        const prediction = this.predictUsingModel(bridge, history);
        logger.debug(`Bridge prediction for ${bridgeKey}`, {
            estimatedLatency: prediction.estimatedLatency,
            estimatedCost: prediction.estimatedCost,
            confidence: prediction.confidence
        });
        return prediction;
    }
    // Update model with actual bridge completion data
    updateModel(actualResult) {
        const bridgeKey = `${actualResult.bridge.sourceChain}-${actualResult.bridge.targetChain}-${actualResult.bridge.bridge}`;
        if (!this.bridgeHistory.has(bridgeKey)) {
            this.bridgeHistory.set(bridgeKey, []);
        }
        const history = this.bridgeHistory.get(bridgeKey);
        const dataPoint = {
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
        history.push(dataPoint);
        // Keep only recent history (last 1000 transactions)
        if (history.length > 1000) {
            history.shift();
        }
        // Update statistical model
        this.updateStatisticalModel(bridgeKey, history);
        // Invalidate metrics cache
        this.metricsCache.delete(bridgeKey);
    }
    // Get bridge performance metrics
    getBridgeMetrics(bridgeKey) {
        if (this.metricsCache.has(bridgeKey)) {
            return this.metricsCache.get(bridgeKey);
        }
        const history = this.bridgeHistory.get(bridgeKey);
        if (!history || history.length === 0) {
            return null;
        }
        const successfulBridges = history.filter(h => h.success);
        const latencies = successfulBridges.map(h => h.latency);
        const costs = successfulBridges.map(h => h.cost);
        const metrics = {
            bridgeName: bridgeKey,
            avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
            minLatency: Math.min(...latencies),
            maxLatency: Math.max(...latencies),
            avgCost: costs.reduce((a, b) => a + b, 0) / costs.length,
            successRate: successfulBridges.length / history.length,
            sampleCount: history.length
        };
        this.metricsCache.set(bridgeKey, metrics);
        return metrics;
    }
    // Get all available bridge routes
    getAvailableRoutes(sourceChain, targetChain) {
        const routes = [];
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
    predictOptimalBridge(sourceChain, targetChain, amount, urgency = 'medium') {
        const availableBridges = this.getAvailableRoutes(sourceChain, targetChain);
        if (availableBridges.length === 0) {
            return null;
        }
        let bestPrediction = null;
        let bestScore = -1;
        for (const bridge of availableBridges) {
            const bridgeObj = {
                bridge,
                sourceChain,
                targetChain,
                token: 'ETH', // Default, should be parameterized
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
    initializeModels() {
        // Initialize with default statistical models for common bridges
        const commonBridges = [
            'arbitrum-mainnet',
            'polygon-mainnet',
            'optimism-mainnet',
            'base-mainnet'
        ];
        for (const bridge of commonBridges) {
            this.predictionModel.set(bridge, {
                latencyModel: {
                    mean: 300, // 5 minutes default
                    stdDev: 120, // 2 minutes variance
                    trend: 0.001 // Slight upward trend
                },
                costModel: {
                    baseCost: 0.001, // 0.001 ETH base
                    congestionMultiplier: 1.5,
                    amountMultiplier: 0.0001
                }
            });
        }
    }
    predictUsingModel(bridge, history) {
        const bridgeKey = `${bridge.sourceChain}-${bridge.targetChain}-${bridge.bridge}`;
        // Simple exponential moving average prediction
        const recentHistory = history.slice(-50); // Last 50 transactions
        const successfulRecent = recentHistory.filter(h => h.success);
        if (successfulRecent.length === 0) {
            return this.getConservativeEstimate(bridge);
        }
        // Calculate weighted average latency (more recent = higher weight)
        let weightedLatency = 0;
        let totalWeight = 0;
        for (let i = 0; i < successfulRecent.length; i++) {
            const weight = Math.exp(i / successfulRecent.length); // Exponential weighting
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
    getConservativeEstimate(bridge) {
        // Conservative estimates when we don't have enough data
        const estimates = {
            'arbitrum-mainnet': { latency: 600, cost: 0.002 },
            'polygon-mainnet': { latency: 180, cost: 0.001 },
            'optimism-mainnet': { latency: 300, cost: 0.0015 },
            'base-mainnet': { latency: 60, cost: 0.0005 }
        };
        const bridgeKey = `${bridge.sourceChain}-${bridge.targetChain}-${bridge.bridge}`;
        const estimate = estimates[bridgeKey] ||
            { latency: 300, cost: 0.0015 };
        return {
            bridgeName: bridge.bridge,
            estimatedLatency: estimate.latency,
            estimatedCost: estimate.cost * bridge.amount * 1e18,
            confidence: 0.3, // Low confidence
            historicalAccuracy: 0.0
        };
    }
    updateStatisticalModel(bridgeKey, history) {
        const successfulHistory = history.filter(h => h.success);
        if (successfulHistory.length < 5)
            return;
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
    calculateVariance(values, mean) {
        const squaredDiffs = values.map(val => (val - mean) ** 2);
        return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    }
    calculateTrend(history) {
        if (history.length < 2)
            return 0;
        // Simple linear regression: y = mx + b
        const n = history.length;
        const sumX = history.reduce((sum, h, i) => sum + i, 0);
        const sumY = history.reduce((sum, h) => sum + h.latency, 0);
        const sumXY = history.reduce((sum, h, i) => sum + i * h.latency, 0);
        const sumXX = history.reduce((sum, h, i) => sum + i * i, 0);
        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        return slope;
    }
    calculateHistoricalAccuracy(history) {
        if (history.length < 2)
            return 0;
        // Calculate prediction accuracy based on recent performance
        let totalError = 0;
        let count = 0;
        for (let i = 10; i < history.length; i++) {
            const recentHistory = history.slice(0, i);
            const predictedLatency = recentHistory.reduce((sum, h) => sum + h.latency, 0) / recentHistory.length;
            const actualLatency = history[i].latency;
            const error = Math.abs(predictedLatency - actualLatency) / actualLatency;
            totalError += error;
            count++;
        }
        return count > 0 ? Math.max(0, 1 - totalError / count) : 0;
    }
    estimateCongestion(timestamp) {
        // Simple congestion estimation based on time of day
        // More sophisticated implementation would use on-chain data
        const hour = new Date(timestamp).getUTCHours();
        // Higher congestion during peak hours (12-18 UTC)
        if (hour >= 12 && hour <= 18) {
            return 0.7; // 70% congestion
        }
        else if (hour >= 6 && hour <= 23) {
            return 0.4; // 40% congestion
        }
        else {
            return 0.1; // 10% congestion (off-peak)
        }
    }
    estimateGasPrice(timestamp) {
        // Simple gas price estimation
        // In production, this would integrate with gas price oracles
        const congestion = this.estimateCongestion(timestamp);
        const baseGasPrice = 20; // 20 gwei base
        return baseGasPrice * (1 + congestion * 2);
    }
    // Cleanup old data
    cleanup(maxAge = 30 * 24 * 60 * 60 * 1000) {
        const cutoffTime = Date.now() - maxAge;
        for (const [bridgeKey, history] of this.bridgeHistory.entries()) {
            const filteredHistory = history.filter(h => h.timestamp > cutoffTime);
            this.bridgeHistory.set(bridgeKey, filteredHistory);
            if (filteredHistory.length === 0) {
                this.bridgeHistory.delete(bridgeKey);
                this.predictionModel.delete(bridgeKey);
                this.metricsCache.delete(bridgeKey);
            }
        }
        logger.info('Bridge predictor cleanup completed', {
            remainingBridges: this.bridgeHistory.size
        });
    }
}
exports.BridgeLatencyPredictor = BridgeLatencyPredictor;
//# sourceMappingURL=bridge-predictor.js.map