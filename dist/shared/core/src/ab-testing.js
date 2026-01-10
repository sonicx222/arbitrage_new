"use strict";
// A/B Testing Framework for Arbitrage Strategies
// Enables systematic comparison of different algorithms, models, and optimizations
Object.defineProperty(exports, "__esModule", { value: true });
exports.ABTestingFramework = void 0;
exports.createABTestingFramework = createABTestingFramework;
exports.getABTestingFramework = getABTestingFramework;
exports.quickExperiment = quickExperiment;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const logger = (0, logger_1.createLogger)('ab-testing');
class ABTestingFramework {
    constructor() {
        this.experiments = new Map();
        this.resultsBuffer = [];
        this.flushInterval = null;
        this.isFlushing = false;
        this.bufferLock = false;
        this.redis = (0, redis_1.getRedisClient)();
        this.startPeriodicFlush();
    }
    // Experiment Management
    async createExperiment(config) {
        const experiment = {
            ...config,
            status: 'draft'
        };
        // Validate experiment configuration
        this.validateExperiment(experiment);
        // Store in Redis
        await this.redis.set(`experiment:${experiment.id}`, JSON.stringify(experiment));
        this.experiments.set(experiment.id, experiment);
        logger.info('Created A/B experiment', {
            id: experiment.id,
            name: experiment.name,
            variants: experiment.variants.length
        });
        return experiment.id;
    }
    async startExperiment(experimentId) {
        const experiment = await this.getExperiment(experimentId);
        if (!experiment) {
            throw new Error(`Experiment ${experimentId} not found`);
        }
        if (experiment.status !== 'draft') {
            throw new Error(`Experiment ${experimentId} is already ${experiment.status}`);
        }
        experiment.status = 'running';
        experiment.startTime = Date.now();
        await this.redis.set(`experiment:${experimentId}`, JSON.stringify(experiment));
        this.experiments.set(experimentId, experiment);
        logger.info('Started A/B experiment', { id: experimentId });
    }
    async stopExperiment(experimentId) {
        const experiment = await this.getExperiment(experimentId);
        if (!experiment) {
            throw new Error(`Experiment ${experimentId} not found`);
        }
        experiment.status = 'stopped';
        experiment.endTime = Date.now();
        await this.redis.set(`experiment:${experimentId}`, JSON.stringify(experiment));
        this.experiments.set(experimentId, experiment);
        logger.info('Stopped A/B experiment', { id: experimentId });
    }
    async getExperiment(experimentId) {
        // Check local cache first
        if (this.experiments.has(experimentId)) {
            return this.experiments.get(experimentId);
        }
        // Load from Redis
        const data = await this.redis.get(`experiment:${experimentId}`);
        if (!data)
            return null;
        const experiment = JSON.parse(data);
        this.experiments.set(experimentId, experiment);
        return experiment;
    }
    // Variant Assignment
    async assignVariant(experimentId, userId) {
        const experiment = await this.getExperiment(experimentId);
        if (!experiment || experiment.status !== 'running') {
            return null;
        }
        // Use userId for consistent assignment, fallback to random
        const seed = userId ? this.hashString(userId + experimentId) : Math.random();
        const randomValue = this.seededRandom(seed);
        let cumulativeWeight = 0;
        for (const variant of experiment.variants) {
            cumulativeWeight += variant.weight;
            if (randomValue <= cumulativeWeight) {
                return variant;
            }
        }
        // Fallback to first variant
        return experiment.variants[0];
    }
    // Result Tracking
    recordResult(result) {
        // Use a simple spin-lock for thread safety
        while (this.bufferLock) {
            // Wait for lock to be released
        }
        this.bufferLock = true;
        try {
            this.resultsBuffer.push(result);
        }
        finally {
            this.bufferLock = false;
        }
        // Immediate flush for critical metrics
        if (result.metricName === 'profit' || result.metricName === 'latency') {
            this.flushResults().catch(error => {
                logger.error('Failed to flush critical results', { error });
            });
        }
    }
    async recordBatchResults(results) {
        // Use a simple spin-lock for thread safety
        while (this.bufferLock) {
            // Wait for lock to be released
        }
        this.bufferLock = true;
        try {
            this.resultsBuffer.push(...results);
        }
        finally {
            this.bufferLock = false;
        }
        await this.flushResults();
    }
    // Statistical Analysis
    async analyzeExperiment(experimentId) {
        const experiment = await this.getExperiment(experimentId);
        if (!experiment)
            return null;
        // Get all results for this experiment
        const results = await this.getExperimentResults(experimentId, experiment.targetMetric);
        if (results.length < experiment.minimumSampleSize) {
            logger.debug('Insufficient sample size for analysis', {
                experimentId,
                currentSize: results.length,
                requiredSize: experiment.minimumSampleSize
            });
            return null;
        }
        // Group results by variant
        const variantResults = {};
        for (const result of results) {
            if (!variantResults[result.variantId]) {
                variantResults[result.variantId] = [];
            }
            variantResults[result.variantId].push(result.value);
        }
        // Perform statistical analysis
        const statisticalResult = this.performStatisticalAnalysis(experimentId, variantResults, experiment.confidenceLevel);
        // Store analysis result
        await this.redis.set(`analysis:${experimentId}`, JSON.stringify({ ...statisticalResult, timestamp: Date.now() }));
        return statisticalResult;
    }
    // Real-time Analysis for Running Experiments
    async getRealtimeStats(experimentId) {
        const experiment = await this.getExperiment(experimentId);
        if (!experiment)
            return null;
        const results = await this.getExperimentResults(experimentId, experiment.targetMetric);
        // Calculate real-time statistics
        const stats = {};
        for (const variant of experiment.variants) {
            const variantResults = results.filter(r => r.variantId === variant.id);
            const values = variantResults.map(r => r.value);
            if (values.length > 0) {
                stats[variant.id] = {
                    sampleSize: values.length,
                    mean: values.reduce((a, b) => a + b, 0) / values.length,
                    median: this.calculateMedian(values),
                    stdDev: this.calculateStdDev(values),
                    min: Math.min(...values),
                    max: Math.max(...values),
                    lastUpdated: Math.max(...variantResults.map(r => r.timestamp))
                };
            }
        }
        return {
            experimentId,
            status: experiment.status,
            variants: stats,
            totalSamples: results.length,
            startTime: experiment.startTime
        };
    }
    // Utility Methods
    validateExperiment(experiment) {
        if (!experiment.id || !experiment.name) {
            throw new Error('Experiment must have id and name');
        }
        if (!experiment.variants || experiment.variants.length < 2) {
            throw new Error('Experiment must have at least 2 variants');
        }
        const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
        if (Math.abs(totalWeight - 1.0) > 0.001) {
            throw new Error('Variant weights must sum to 1.0');
        }
        if (!experiment.targetMetric) {
            throw new Error('Experiment must specify target metric');
        }
    }
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash) / 2147483647; // Normalize to 0-1
    }
    seededRandom(seed) {
        // Simple seeded random number generator
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }
    async getExperimentResults(experimentId, metricName) {
        // Get results from Redis (simplified - in production would use proper indexing)
        const pattern = `result:${experimentId}:${metricName}:*`;
        const keys = await this.redis.keys(pattern);
        const results = [];
        for (const key of keys) {
            const data = await this.redis.get(key);
            if (data) {
                results.push(JSON.parse(data));
            }
        }
        return results;
    }
    performStatisticalAnalysis(experimentId, variantResults, confidenceLevel) {
        const variants = Object.keys(variantResults);
        if (variants.length < 2) {
            throw new Error('Need at least 2 variants for analysis');
        }
        // Calculate means and sample sizes
        const means = {};
        const sampleSizes = {};
        for (const variantId of variants) {
            const values = variantResults[variantId];
            means[variantId] = values.reduce((a, b) => a + b, 0) / values.length;
            sampleSizes[variantId] = values.length;
        }
        // Assume first variant is control, find best performer
        const controlVariant = variants[0];
        let bestVariant = controlVariant;
        let bestImprovement = 0;
        for (let i = 1; i < variants.length; i++) {
            const variantId = variants[i];
            const improvement = (means[variantId] - means[controlVariant]) / Math.abs(means[controlVariant]);
            if (improvement > bestImprovement) {
                bestVariant = variantId;
                bestImprovement = improvement;
            }
        }
        // Simplified statistical significance test (t-test approximation)
        const controlValues = variantResults[controlVariant];
        const bestValues = variantResults[bestVariant];
        const tStatistic = this.calculateTStatistic(controlValues, bestValues);
        const degreesOfFreedom = controlValues.length + bestValues.length - 2;
        const pValue = this.approximatePValue(tStatistic, degreesOfFreedom);
        const statisticalSignificance = pValue < (1 - confidenceLevel);
        return {
            experimentId,
            winner: bestVariant,
            confidence: confidenceLevel,
            improvement: bestImprovement * 100, // Convert to percentage
            statisticalSignificance,
            sampleSizes,
            means,
            pValue
        };
    }
    calculateMedian(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
    }
    calculateStdDev(values) {
        if (values.length === 0)
            return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const squaredDiffs = values.map(v => (v - mean) ** 2);
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / Math.max(values.length - 1, 1);
        return Math.sqrt(variance);
    }
    calculateTStatistic(group1, group2) {
        if (group1.length === 0 || group2.length === 0)
            return 0;
        const mean1 = group1.reduce((a, b) => a + b, 0) / group1.length;
        const mean2 = group2.reduce((a, b) => a + b, 0) / group2.length;
        const var1 = this.calculateVariance(group1, mean1);
        const var2 = this.calculateVariance(group2, mean2);
        const denominator = group1.length + group2.length - 2;
        if (denominator <= 0)
            return 0;
        const pooledVariance = ((group1.length - 1) * var1 + (group2.length - 1) * var2) / denominator;
        const se = Math.sqrt(pooledVariance * (1 / group1.length + 1 / group2.length));
        if (se === 0)
            return 0;
        return (mean1 - mean2) / se;
    }
    calculateVariance(values, mean) {
        const squaredDiffs = values.map(v => (v - mean) ** 2);
        return squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
    }
    approximatePValue(tStatistic, degreesOfFreedom) {
        // Simplified p-value approximation using t-distribution
        // In production, would use proper statistical library
        const absT = Math.abs(tStatistic);
        if (degreesOfFreedom <= 0)
            return 1.0; // No statistical significance with invalid df
        if (degreesOfFreedom > 30) {
            // Approximate with normal distribution for large df
            return 2 * (1 - this.normalCDF(absT));
        }
        // Simplified approximation for small df
        const sqrtDf = Math.sqrt(degreesOfFreedom);
        if (sqrtDf === 0)
            return 1.0;
        return Math.max(0.001, Math.min(0.999, 1 / (1 + absT * sqrtDf)));
    }
    normalCDF(x) {
        // Abramowitz & Stegun approximation
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const p = 0.3275911;
        const sign = x < 0 ? -1 : 1;
        const absX = Math.abs(x) / Math.sqrt(2.0);
        // Prevent division by zero
        const denominator = 1.0 + p * absX;
        if (denominator === 0)
            return sign > 0 ? 1.0 : 0.0;
        const t = 1.0 / denominator;
        const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
        return Math.max(0.0, Math.min(1.0, 0.5 * (1.0 + sign * erf)));
    }
    async flushResults() {
        if (this.resultsBuffer.length === 0 || this.isFlushing)
            return;
        // Acquire lock
        while (this.bufferLock) {
            // Wait for buffer lock to be released
        }
        this.isFlushing = true;
        this.bufferLock = true;
        let resultsToFlush = [];
        try {
            resultsToFlush = [...this.resultsBuffer];
            this.resultsBuffer.length = 0;
        }
        finally {
            this.bufferLock = false;
        }
        try {
            // Store results in Redis
            const pipeline = this.redis.pipeline();
            for (const result of resultsToFlush) {
                const key = `result:${result.experimentId}:${result.metricName}:${result.variantId}:${Date.now()}`;
                pipeline.setex(key, 86400 * 30, JSON.stringify(result)); // 30 days TTL
            }
            await pipeline.exec();
            logger.debug('Flushed A/B testing results', { count: resultsToFlush.length });
        }
        finally {
            this.isFlushing = false;
        }
    }
    startPeriodicFlush() {
        this.flushInterval = setInterval(() => {
            this.flushResults().catch(error => {
                logger.error('Failed to flush A/B testing results', { error });
            });
        }, 30000); // Flush every 30 seconds
    }
    // Cleanup
    destroy() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }
        this.flushResults(); // Final flush
    }
}
exports.ABTestingFramework = ABTestingFramework;
// Factory function
function createABTestingFramework() {
    return new ABTestingFramework();
}
// Default instance
let defaultABTesting = null;
function getABTestingFramework() {
    if (!defaultABTesting) {
        defaultABTesting = new ABTestingFramework();
    }
    return defaultABTesting;
}
// Convenience functions for common use cases
async function quickExperiment(experimentId, variants, userId) {
    const framework = getABTestingFramework();
    await framework.createExperiment({
        id: experimentId,
        name: `Quick Experiment ${experimentId}`,
        description: 'Auto-generated experiment',
        variants: variants.map(v => ({
            id: v.id,
            name: v.name,
            description: v.name,
            weight: v.weight,
            config: {}
        })),
        targetMetric: 'conversion',
        minimumSampleSize: 1000,
        confidenceLevel: 0.95
    });
    await framework.startExperiment(experimentId);
    const assignedVariant = await framework.assignVariant(experimentId, userId);
    return assignedVariant?.id || variants[0].id;
}
//# sourceMappingURL=ab-testing.js.map