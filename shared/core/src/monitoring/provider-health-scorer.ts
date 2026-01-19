/**
 * Provider Health Scorer
 *
 * S3.3: Tracks health metrics for RPC providers and enables intelligent
 * fallback selection based on latency, reliability, and data freshness.
 *
 * Features:
 * - Track latency, success rate, and block freshness per provider
 * - Weighted scoring for intelligent provider selection
 * - Rolling windows for metrics to prevent stale data
 * - Singleton pattern for shared access across WebSocket managers
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import { createLogger, Logger } from '../logger';

/**
 * Health metrics for a single provider
 */
export interface ProviderHealthMetrics {
  /** Provider WebSocket/RPC URL */
  url: string;
  /** Chain identifier */
  chainId: string;

  // Latency tracking (rolling window)
  /** Average latency in ms */
  avgLatencyMs: number;
  /** 95th percentile latency in ms */
  p95LatencyMs: number;
  /** Recent latency samples */
  latencySamples: number[];

  // Reliability tracking
  /** Total successful operations */
  successCount: number;
  /** Total failed operations */
  failureCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Rate limit events encountered */
  rateLimitCount: number;
  /** Connection drop count */
  connectionDropCount: number;

  // Timing
  /** Timestamp of last successful operation */
  lastSuccessTime: number;
  /** Timestamp of last failure */
  lastFailureTime: number;
  /** Timestamp of last block received */
  lastBlockTime: number;

  // Block freshness
  /** Last block number seen */
  lastBlockNumber: number;
  /** Estimated blocks behind head */
  blocksBehind: number;

  // Computed scores (0-100)
  /** Latency score (lower latency = higher score) */
  latencyScore: number;
  /** Reliability score (higher success rate = higher score) */
  reliabilityScore: number;
  /** Freshness score (more recent blocks = higher score) */
  freshnessScore: number;
  /** Overall weighted score */
  overallScore: number;
}

/**
 * Configuration for the health scorer
 */
export interface ProviderHealthScorerConfig {
  /** Weight for latency in overall score (default: 0.3) */
  latencyWeight?: number;
  /** Weight for reliability in overall score (default: 0.4) */
  reliabilityWeight?: number;
  /** Weight for freshness in overall score (default: 0.3) */
  freshnessWeight?: number;

  // Thresholds
  /** Maximum acceptable latency in ms (default: 2000) */
  maxAcceptableLatencyMs?: number;
  /** Maximum acceptable block delay in ms (default: 30000) */
  maxAcceptableBlockDelayMs?: number;
  /** Minimum acceptable reliability (default: 0.95 = 95%) */
  minReliabilityPercent?: number;

  // Rolling window sizes
  /** Number of latency samples to keep (default: 100) */
  latencySampleWindow?: number;
  /** Window for reliability calculation (default: 1000) */
  reliabilityWindow?: number;

  // Decay settings
  /** How often to decay old metrics in ms (default: 60000) */
  decayIntervalMs?: number;
  /** Decay factor for old counts (default: 0.9) */
  decayFactor?: number;
}

/**
 * Provider Health Scorer - tracks and scores RPC provider health
 */
export class ProviderHealthScorer {
  private metrics: Map<string, ProviderHealthMetrics> = new Map();
  private config: Required<ProviderHealthScorerConfig>;
  private logger: Logger;
  private decayTimer: NodeJS.Timeout | null = null;

  constructor(config: ProviderHealthScorerConfig = {}) {
    this.config = {
      latencyWeight: config.latencyWeight ?? 0.3,
      reliabilityWeight: config.reliabilityWeight ?? 0.4,
      freshnessWeight: config.freshnessWeight ?? 0.3,
      maxAcceptableLatencyMs: config.maxAcceptableLatencyMs ?? 2000,
      maxAcceptableBlockDelayMs: config.maxAcceptableBlockDelayMs ?? 30000,
      minReliabilityPercent: config.minReliabilityPercent ?? 0.95,
      latencySampleWindow: config.latencySampleWindow ?? 100,
      reliabilityWindow: config.reliabilityWindow ?? 1000,
      decayIntervalMs: config.decayIntervalMs ?? 60000,
      decayFactor: config.decayFactor ?? 0.9
    };

    this.logger = createLogger('provider-health-scorer');

    // Start periodic decay
    this.startDecay();
  }

  /**
   * Get or create metrics for a provider
   */
  private getOrCreateMetrics(url: string, chainId: string): ProviderHealthMetrics {
    const key = this.makeKey(url, chainId);
    let metrics = this.metrics.get(key);

    if (!metrics) {
      metrics = this.createEmptyMetrics(url, chainId);
      this.metrics.set(key, metrics);
    }

    return metrics;
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(url: string, chainId: string): ProviderHealthMetrics {
    return {
      url,
      chainId,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      latencySamples: [],
      successCount: 0,
      failureCount: 0,
      successRate: 1.0, // Assume healthy until proven otherwise
      rateLimitCount: 0,
      connectionDropCount: 0,
      lastSuccessTime: 0,
      lastFailureTime: 0,
      lastBlockTime: 0,
      lastBlockNumber: 0,
      blocksBehind: 0,
      latencyScore: 100,
      reliabilityScore: 100,
      freshnessScore: 100,
      overallScore: 100
    };
  }

  /**
   * Make a unique key for provider metrics
   */
  private makeKey(url: string, chainId: string): string {
    return `${chainId}:${url}`;
  }

  /**
   * Record a successful operation with latency
   */
  recordSuccess(url: string, chainId: string, latencyMs: number): void {
    const metrics = this.getOrCreateMetrics(url, chainId);

    // Update success tracking
    metrics.successCount++;
    metrics.lastSuccessTime = Date.now();

    // Update latency tracking
    metrics.latencySamples.push(latencyMs);
    if (metrics.latencySamples.length > this.config.latencySampleWindow) {
      metrics.latencySamples.shift();
    }

    // Recalculate latency stats
    this.updateLatencyStats(metrics);

    // Recalculate scores
    this.updateScores(metrics);
  }

  /**
   * Record a failed operation
   */
  recordFailure(url: string, chainId: string, errorType: string): void {
    const metrics = this.getOrCreateMetrics(url, chainId);

    metrics.failureCount++;
    metrics.lastFailureTime = Date.now();

    if (errorType === 'rate_limit') {
      metrics.rateLimitCount++;
    } else if (errorType === 'connection_drop') {
      metrics.connectionDropCount++;
    }

    // Recalculate scores
    this.updateScores(metrics);

    this.logger.debug('Recorded failure', {
      url,
      chainId,
      errorType,
      successRate: metrics.successRate
    });
  }

  /**
   * Record a rate limit event
   */
  recordRateLimit(url: string, chainId: string): void {
    this.recordFailure(url, chainId, 'rate_limit');
  }

  /**
   * Record a connection drop
   */
  recordConnectionDrop(url: string, chainId: string): void {
    this.recordFailure(url, chainId, 'connection_drop');
  }

  /**
   * Record a block number received
   */
  recordBlock(url: string, chainId: string, blockNumber: number): void {
    const metrics = this.getOrCreateMetrics(url, chainId);

    metrics.lastBlockNumber = blockNumber;
    metrics.lastBlockTime = Date.now();

    // Calculate blocks behind (compare to best known for this chain)
    const bestBlock = this.getBestBlockForChain(chainId);
    metrics.blocksBehind = Math.max(0, bestBlock - blockNumber);

    // Recalculate scores
    this.updateScores(metrics);
  }

  /**
   * Get the best (highest) block number known for a chain
   */
  private getBestBlockForChain(chainId: string): number {
    let bestBlock = 0;

    for (const [key, metrics] of this.metrics) {
      if (metrics.chainId === chainId && metrics.lastBlockNumber > bestBlock) {
        bestBlock = metrics.lastBlockNumber;
      }
    }

    return bestBlock;
  }

  /**
   * Update latency statistics from samples
   */
  private updateLatencyStats(metrics: ProviderHealthMetrics): void {
    const samples = metrics.latencySamples;
    if (samples.length === 0) return;

    // Calculate average
    const sum = samples.reduce((a, b) => a + b, 0);
    metrics.avgLatencyMs = sum / samples.length;

    // Calculate P95
    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    metrics.p95LatencyMs = sorted[p95Index] || metrics.avgLatencyMs;
  }

  /**
   * Update all scores for a provider
   */
  private updateScores(metrics: ProviderHealthMetrics): void {
    // Calculate success rate
    const totalOps = metrics.successCount + metrics.failureCount;
    metrics.successRate = totalOps > 0
      ? metrics.successCount / totalOps
      : 1.0;

    // Latency score (100 = 0ms, 0 = maxAcceptableLatencyMs+)
    const latencyRatio = metrics.avgLatencyMs / this.config.maxAcceptableLatencyMs;
    metrics.latencyScore = Math.max(0, Math.min(100, (1 - latencyRatio) * 100));

    // Reliability score (based on success rate)
    metrics.reliabilityScore = metrics.successRate * 100;

    // Freshness score (based on time since last block and blocks behind)
    const timeSinceBlock = metrics.lastBlockTime > 0
      ? Date.now() - metrics.lastBlockTime
      : this.config.maxAcceptableBlockDelayMs;
    const freshnessRatio = Math.min(1, timeSinceBlock / this.config.maxAcceptableBlockDelayMs);
    const blockPenalty = Math.min(50, metrics.blocksBehind * 10); // Lose 10 points per block behind
    metrics.freshnessScore = Math.max(0, (1 - freshnessRatio) * 100 - blockPenalty);

    // Overall weighted score
    metrics.overallScore =
      metrics.latencyScore * this.config.latencyWeight +
      metrics.reliabilityScore * this.config.reliabilityWeight +
      metrics.freshnessScore * this.config.freshnessWeight;
  }

  /**
   * Get health score for a specific provider
   */
  getHealthScore(url: string, chainId: string): number {
    const key = this.makeKey(url, chainId);
    const metrics = this.metrics.get(key);
    return metrics?.overallScore ?? 50; // Default to neutral score
  }

  /**
   * Get full metrics for a provider
   */
  getMetrics(url: string, chainId: string): ProviderHealthMetrics | null {
    const key = this.makeKey(url, chainId);
    const metrics = this.metrics.get(key);
    return metrics ? { ...metrics } : null;
  }

  /**
   * Get all metrics for a chain
   */
  getChainMetrics(chainId: string): ProviderHealthMetrics[] {
    const result: ProviderHealthMetrics[] = [];

    for (const metrics of this.metrics.values()) {
      if (metrics.chainId === chainId) {
        result.push({ ...metrics });
      }
    }

    return result.sort((a, b) => b.overallScore - a.overallScore);
  }

  /**
   * Select the best provider from a list of candidates
   */
  selectBestProvider(chainId: string, candidates: string[]): string {
    if (candidates.length === 0) {
      throw new Error('No candidate providers provided');
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    let bestUrl = candidates[0];
    let bestScore = this.getHealthScore(candidates[0], chainId);

    for (let i = 1; i < candidates.length; i++) {
      const url = candidates[i];
      const score = this.getHealthScore(url, chainId);

      if (score > bestScore) {
        bestScore = score;
        bestUrl = url;
      }
    }

    this.logger.debug('Selected best provider', {
      chainId,
      selectedUrl: bestUrl,
      score: bestScore,
      candidateCount: candidates.length
    });

    return bestUrl;
  }

  /**
   * Check if a provider meets minimum health requirements
   */
  isProviderHealthy(url: string, chainId: string): boolean {
    const metrics = this.getMetrics(url, chainId);
    if (!metrics) return true; // Unknown providers are assumed healthy

    return (
      metrics.successRate >= this.config.minReliabilityPercent &&
      metrics.avgLatencyMs <= this.config.maxAcceptableLatencyMs
    );
  }

  /**
   * Get providers sorted by health score (best first)
   */
  getRankedProviders(chainId: string, urls: string[]): string[] {
    return [...urls].sort((a, b) => {
      const scoreA = this.getHealthScore(a, chainId);
      const scoreB = this.getHealthScore(b, chainId);
      return scoreB - scoreA;
    });
  }

  /**
   * Start periodic decay of old metrics
   */
  private startDecay(): void {
    this.stopDecay();

    this.decayTimer = setInterval(() => {
      this.decayMetrics();
    }, this.config.decayIntervalMs);
  }

  /**
   * Stop periodic decay
   */
  private stopDecay(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
  }

  /**
   * Apply decay to metrics to prevent stale data from dominating
   */
  private decayMetrics(): void {
    const decayFactor = this.config.decayFactor;

    for (const metrics of this.metrics.values()) {
      // Decay counts towards zero
      metrics.successCount = Math.floor(metrics.successCount * decayFactor);
      metrics.failureCount = Math.floor(metrics.failureCount * decayFactor);
      metrics.rateLimitCount = Math.floor(metrics.rateLimitCount * decayFactor);
      metrics.connectionDropCount = Math.floor(metrics.connectionDropCount * decayFactor);

      // Recalculate scores after decay
      this.updateScores(metrics);
    }
  }

  /**
   * Clear all metrics (for testing or reset)
   */
  clear(): void {
    this.metrics.clear();
  }

  /**
   * Shutdown the scorer
   */
  shutdown(): void {
    this.stopDecay();
    this.clear();
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalProviders: number;
    providersByChain: Record<string, number>;
    avgOverallScore: number;
    unhealthyProviders: number;
  } {
    const chainCounts: Record<string, number> = {};
    let totalScore = 0;
    let unhealthyCount = 0;

    for (const metrics of this.metrics.values()) {
      chainCounts[metrics.chainId] = (chainCounts[metrics.chainId] || 0) + 1;
      totalScore += metrics.overallScore;

      if (!this.isProviderHealthy(metrics.url, metrics.chainId)) {
        unhealthyCount++;
      }
    }

    return {
      totalProviders: this.metrics.size,
      providersByChain: chainCounts,
      avgOverallScore: this.metrics.size > 0 ? totalScore / this.metrics.size : 100,
      unhealthyProviders: unhealthyCount
    };
  }
}

// Singleton instance
let healthScorerInstance: ProviderHealthScorer | null = null;

/**
 * Get the singleton health scorer instance
 */
export function getProviderHealthScorer(): ProviderHealthScorer {
  if (!healthScorerInstance) {
    healthScorerInstance = new ProviderHealthScorer();
  }
  return healthScorerInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetProviderHealthScorer(): void {
  if (healthScorerInstance) {
    healthScorerInstance.shutdown();
    healthScorerInstance = null;
  }
}
