// A/B Testing Framework for Arbitrage Strategies
// Enables systematic comparison of different algorithms, models, and optimizations

import { createLogger } from './logger';
import { getRedisClient } from './redis';

const logger = createLogger('ab-testing');

export interface ExperimentConfig {
  id: string;
  name: string;
  description: string;
  variants: ExperimentVariant[];
  targetMetric: string;
  minimumSampleSize: number;
  confidenceLevel: number; // 0.95 = 95% confidence
  startTime?: number;
  endTime?: number;
  status: 'draft' | 'running' | 'completed' | 'stopped';
}

export interface ExperimentVariant {
  id: string;
  name: string;
  description: string;
  weight: number; // Traffic allocation (0-1)
  config: any; // Variant-specific configuration
}

export interface ExperimentResult {
  experimentId: string;
  variantId: string;
  metricName: string;
  value: number;
  timestamp: number;
  userId?: string;
  context?: any;
}

export interface StatisticalResult {
  experimentId: string;
  winner: string;
  confidence: number;
  improvement: number; // Percentage improvement
  statisticalSignificance: boolean;
  sampleSizes: { [variantId: string]: number };
  means: { [variantId: string]: number };
  pValue: number;
}

export class ABTestingFramework {
  private redis: any;
  private experiments: Map<string, ExperimentConfig> = new Map();
  private resultsBuffer: ExperimentResult[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private bufferLock = false;

  constructor() {
    this.redis = getRedisClient();
    this.startPeriodicFlush();
  }

  // Experiment Management
  async createExperiment(config: Omit<ExperimentConfig, 'status'>): Promise<string> {
    const experiment: ExperimentConfig = {
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

  async startExperiment(experimentId: string): Promise<void> {
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

  async stopExperiment(experimentId: string): Promise<void> {
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

  async getExperiment(experimentId: string): Promise<ExperimentConfig | null> {
    // Check local cache first
    if (this.experiments.has(experimentId)) {
      return this.experiments.get(experimentId)!;
    }

    // Load from Redis
    const data = await this.redis.get(`experiment:${experimentId}`);
    if (!data) return null;

    const experiment = JSON.parse(data);
    this.experiments.set(experimentId, experiment);
    return experiment;
  }

  // Variant Assignment
  async assignVariant(experimentId: string, userId?: string): Promise<ExperimentVariant | null> {
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
  recordResult(result: ExperimentResult): void {
    // Use a simple spin-lock for thread safety
    while (this.bufferLock) {
      // Wait for lock to be released
    }

    this.bufferLock = true;
    try {
      this.resultsBuffer.push(result);
    } finally {
      this.bufferLock = false;
    }

    // Immediate flush for critical metrics
    if (result.metricName === 'profit' || result.metricName === 'latency') {
      this.flushResults().catch(error => {
        logger.error('Failed to flush critical results', { error });
      });
    }
  }

  async recordBatchResults(results: ExperimentResult[]): Promise<void> {
    // Use a simple spin-lock for thread safety
    while (this.bufferLock) {
      // Wait for lock to be released
    }

    this.bufferLock = true;
    try {
      this.resultsBuffer.push(...results);
    } finally {
      this.bufferLock = false;
    }

    await this.flushResults();
  }

  // Statistical Analysis
  async analyzeExperiment(experimentId: string): Promise<StatisticalResult | null> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment) return null;

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
    const variantResults: { [variantId: string]: number[] } = {};
    for (const result of results) {
      if (!variantResults[result.variantId]) {
        variantResults[result.variantId] = [];
      }
      variantResults[result.variantId].push(result.value);
    }

    // Perform statistical analysis
    const statisticalResult = this.performStatisticalAnalysis(
      experimentId,
      variantResults,
      experiment.confidenceLevel
    );

    // Store analysis result
    await this.redis.set(
      `analysis:${experimentId}`,
      JSON.stringify({ ...statisticalResult, timestamp: Date.now() })
    );

    return statisticalResult;
  }

  // Real-time Analysis for Running Experiments
  async getRealtimeStats(experimentId: string): Promise<any> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment) return null;

    const results = await this.getExperimentResults(experimentId, experiment.targetMetric);

    // Calculate real-time statistics
    const stats: { [variantId: string]: any } = {};

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
  private validateExperiment(experiment: ExperimentConfig): void {
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

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) / 2147483647; // Normalize to 0-1
  }

  private seededRandom(seed: number): number {
    // Simple seeded random number generator
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  private async getExperimentResults(experimentId: string, metricName: string): Promise<ExperimentResult[]> {
    // Get results from Redis using SCAN to avoid blocking
    // P0 FIX: Use SCAN instead of KEYS to prevent blocking Redis server
    const pattern = `result:${experimentId}:${metricName}:*`;
    const keys: string[] = [];

    // Use SCAN iterator for non-blocking key retrieval
    let cursor = '0';
    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');

    const results: ExperimentResult[] = [];
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        results.push(JSON.parse(data));
      }
    }

    return results;
  }

  private performStatisticalAnalysis(
    experimentId: string,
    variantResults: { [variantId: string]: number[] },
    confidenceLevel: number
  ): StatisticalResult {
    const variants = Object.keys(variantResults);
    if (variants.length < 2) {
      throw new Error('Need at least 2 variants for analysis');
    }

    // Calculate means and sample sizes
    const means: { [variantId: string]: number } = {};
    const sampleSizes: { [variantId: string]: number } = {};

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

  private calculateMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private calculateStdDev(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => (v - mean) ** 2);
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / Math.max(values.length - 1, 1);
    return Math.sqrt(variance);
  }

  private calculateTStatistic(group1: number[], group2: number[]): number {
    if (group1.length === 0 || group2.length === 0) return 0;

    const mean1 = group1.reduce((a, b) => a + b, 0) / group1.length;
    const mean2 = group2.reduce((a, b) => a + b, 0) / group2.length;

    const var1 = this.calculateVariance(group1, mean1);
    const var2 = this.calculateVariance(group2, mean2);

    const denominator = group1.length + group2.length - 2;
    if (denominator <= 0) return 0;

    const pooledVariance = ((group1.length - 1) * var1 + (group2.length - 1) * var2) / denominator;

    const se = Math.sqrt(pooledVariance * (1/group1.length + 1/group2.length));
    if (se === 0) return 0;

    return (mean1 - mean2) / se;
  }

  private calculateVariance(values: number[], mean: number): number {
    const squaredDiffs = values.map(v => (v - mean) ** 2);
    return squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  }

  private approximatePValue(tStatistic: number, degreesOfFreedom: number): number {
    // Simplified p-value approximation using t-distribution
    // In production, would use proper statistical library
    const absT = Math.abs(tStatistic);

    if (degreesOfFreedom <= 0) return 1.0; // No statistical significance with invalid df

    if (degreesOfFreedom > 30) {
      // Approximate with normal distribution for large df
      return 2 * (1 - this.normalCDF(absT));
    }

    // Simplified approximation for small df
    const sqrtDf = Math.sqrt(degreesOfFreedom);
    if (sqrtDf === 0) return 1.0;

    return Math.max(0.001, Math.min(0.999, 1 / (1 + absT * sqrtDf)));
  }

  private normalCDF(x: number): number {
    // Abramowitz & Stegun approximation
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.sqrt(2.0);

    // Prevent division by zero
    const denominator = 1.0 + p * absX;
    if (denominator === 0) return sign > 0 ? 1.0 : 0.0;

    const t = 1.0 / denominator;
    const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return Math.max(0.0, Math.min(1.0, 0.5 * (1.0 + sign * erf)));
  }

  private async flushResults(): Promise<void> {
    if (this.resultsBuffer.length === 0 || this.isFlushing) return;

    // Acquire lock
    while (this.bufferLock) {
      // Wait for buffer lock to be released
    }

    this.isFlushing = true;
    this.bufferLock = true;

    let resultsToFlush: ExperimentResult[] = [];
    try {
      resultsToFlush = [...this.resultsBuffer];
      this.resultsBuffer.length = 0;
    } finally {
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
    } finally {
      this.isFlushing = false;
    }
  }

  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushResults().catch(error => {
        logger.error('Failed to flush A/B testing results', { error });
      });
    }, 30000); // Flush every 30 seconds
  }

  // Cleanup
  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flushResults(); // Final flush
  }
}

// Factory function
export function createABTestingFramework(): ABTestingFramework {
  return new ABTestingFramework();
}

// Default instance
let defaultABTesting: ABTestingFramework | null = null;

export function getABTestingFramework(): ABTestingFramework {
  if (!defaultABTesting) {
    defaultABTesting = new ABTestingFramework();
  }
  return defaultABTesting;
}

// Convenience functions for common use cases
export async function quickExperiment(
  experimentId: string,
  variants: { id: string; name: string; weight: number }[],
  userId?: string
): Promise<string> {
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