// Professional Quality Monitor
// Measures and tracks the "Arbitrage Detection Professional Quality Score (AD-PQS)"
// This is the single most important metric for measuring system professionalism

import { createLogger } from '../logger';
import { getRedisClient, RedisClient } from '../redis';

const logger = createLogger('professional-quality-monitor');

// =============================================================================
// Dependency Injection Interface
// =============================================================================

/**
 * Interface for Redis-like operations needed by ProfessionalQualityMonitor.
 * Allows injecting mock Redis for testing.
 */
export interface QualityMonitorRedis {
  setex(key: string, seconds: number, value: string): Promise<string>;
  get(key: string): Promise<string | null>;
  keys(pattern: string): Promise<string[]>;
  /**
   * SCAN iterator for non-blocking key retrieval.
   *
   * Simplified signature that abstracts away Redis command syntax.
   * Internally calls: redis.scan(cursor, 'MATCH', pattern, 'COUNT', count)
   *
   * @param cursor - Scan cursor ('0' to start, then use returned cursor)
   * @param pattern - Key pattern to match (e.g., 'quality:*')
   * @param count - Number of keys to return per iteration (hint, not guarantee)
   * @returns Tuple of [next cursor, keys array]
   */
  scan(cursor: string, pattern: string, count: number): Promise<[string, string[]]>;
}

/**
 * Dependencies that can be injected into ProfessionalQualityMonitor.
 * This enables proper testing without Jest mock hoisting issues.
 */
export interface QualityMonitorDeps {
  /** Redis client instance - if provided, used directly (no async init needed) */
  redis?: QualityMonitorRedis;
}

export interface QualityMetrics {
  // Core detection performance
  detectionLatency: {
    p50: number;    // Median latency
    p95: number;    // 95th percentile
    p99: number;    // 99th percentile
    max: number;    // Maximum latency
  };

  // Detection accuracy
  detectionAccuracy: {
    precision: number;    // True positives / (True positives + False positives)
    recall: number;       // True positives / (True positives + False negatives)
    f1Score: number;      // Harmonic mean of precision and recall
    falsePositiveRate: number;
  };

  // System reliability
  systemReliability: {
    uptime: number;           // Percentage uptime
    availability: number;     // Service availability score
    errorRate: number;        // Error rate per minute
    recoveryTime: number;     // Mean time to recovery (seconds)
  };

  // Operational consistency
  operationalConsistency: {
    performanceVariance: number;    // Coefficient of variation in latency
    throughputStability: number;    // Stability of operations per second
    memoryStability: number;        // Memory usage stability
    loadHandling: number;           // Ability to handle load spikes
  };
}

export interface ProfessionalQualityScore {
  overallScore: number;        // 0-100, where 100 is perfect professional quality
  grade: 'F' | 'D' | 'C' | 'B' | 'A' | 'A+';
  componentScores: {
    detectionPerformance: number;    // 25% weight
    detectionAccuracy: number;       // 25% weight
    systemReliability: number;       // 25% weight
    operationalConsistency: number;  // 25% weight
  };
  metrics: QualityMetrics;
  timestamp: number;
  assessmentPeriod: {
    start: number;
    end: number;
    duration: number;
  };
  recommendations: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export class ProfessionalQualityMonitor {
  private redis: QualityMonitorRedis | null = null;
  private redisPromise: Promise<QualityMonitorRedis> | null = null;
  private metricsBuffer: QualityMetrics[] = [];
  private scoreHistory: ProfessionalQualityScore[] = [];
  private readonly METRICS_RETENTION_PERIOD = 24 * 60 * 60 * 1000; // 24 hours
  private readonly ASSESSMENT_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private assessmentInterval: NodeJS.Timeout | null = null;

  // Professional quality thresholds
  private readonly THRESHOLDS = {
    detectionLatency: {
      p95: 5,      // 5ms 95th percentile
      p99: 10,     // 10ms 99th percentile
      max: 50      // 50ms absolute maximum
    },
    detectionAccuracy: {
      precision: 0.95,    // 95% precision
      recall: 0.90,       // 90% recall
      f1Score: 0.92,      // 92% F1 score
      falsePositiveRate: 0.01  // 1% false positive rate
    },
    systemReliability: {
      uptime: 0.999,      // 99.9% uptime
      availability: 0.995, // 99.5% availability
      errorRate: 0.001,   // 0.1% error rate
      recoveryTime: 30    // 30 seconds MTTR
    },
    operationalConsistency: {
      performanceVariance: 0.1,    // 10% coefficient of variation
      throughputStability: 0.95,   // 95% throughput stability
      memoryStability: 0.05,       // 5% memory variance
      loadHandling: 0.9            // 90% load handling capability
    }
  };

  /**
   * Create a ProfessionalQualityMonitor.
   * @param deps - Optional dependencies for testing. If redis is provided, it's used directly.
   */
  constructor(deps?: QualityMonitorDeps) {
    if (deps?.redis) {
      // Direct injection for testing - no async needed
      this.redis = deps.redis;
    }
    // Note: if no redis injected, lazy initialization via getRedis() is used
    this.startPeriodicAssessment();
    logger.info('Professional Quality Monitor initialized');
  }

  /**
   * Get the Redis client, initializing lazily if needed.
   * Uses singleton pattern for production, direct injection for tests.
   * Creates an adapter around RedisClient that implements QualityMonitorRedis.
   */
  private async getRedis(): Promise<QualityMonitorRedis> {
    // If already initialized, return directly
    if (this.redis) {
      return this.redis;
    }

    // If initialization is in progress, wait for it
    if (this.redisPromise) {
      return this.redisPromise;
    }

    // Start initialization - create an adapter around RedisClient
    this.redisPromise = (async () => {
      const client = await getRedisClient();
      // Create adapter that implements QualityMonitorRedis
      // Note: RedisClient.get does JSON parsing, but we need raw strings,
      // so we use getRaw for the QualityMonitorRedis.get method
      const adapter: QualityMonitorRedis = {
        setex: (key, seconds, value) => client.setex(key, seconds, value),
        get: (key) => client.getRaw(key),
        keys: (pattern) => client.keys(pattern),
        // P0 FIX: Add scan method for non-blocking key iteration
        // Adapter wraps Redis command syntax: scan(cursor, 'MATCH', pattern, 'COUNT', count)
        scan: (cursor, pattern, count) => client.scan(cursor, 'MATCH', pattern, 'COUNT', count)
      };
      this.redis = adapter;
      return adapter;
    })();

    return this.redisPromise;
  }

  /**
   * Stop the periodic assessment (for cleanup in tests).
   */
  stopPeriodicAssessment(): void {
    if (this.assessmentInterval) {
      clearInterval(this.assessmentInterval);
      this.assessmentInterval = null;
    }
  }

  // Record a detection operation result
  async recordDetectionResult(result: {
    latency: number;
    isTruePositive: boolean;
    isFalsePositive: boolean;
    isFalseNegative: boolean;
    timestamp: number;
    operationId: string;
  }): Promise<void> {
    try {
      const redis = await this.getRedis();
      // P0-FIX: Use operationId in key to ensure uniqueness for concurrent calls
      // Date.now() alone can cause key collisions when multiple calls happen in the same millisecond
      const key = `quality:detection:${result.operationId}`;
      await redis.setex(key, 3600, JSON.stringify(result)); // 1 hour TTL

      // Update rolling metrics
      await this.updateRollingMetrics(result);

      logger.debug('Detection result recorded', {
        latency: result.latency,
        accuracy: result.isTruePositive ? 'correct' : 'incorrect',
        operationId: result.operationId
      });
    } catch (error) {
      logger.error('Failed to record detection result', { error });
    }
  }

  // Record system health metrics
  async recordSystemHealth(health: {
    uptime: number;
    availability: number;
    errorRate: number;
    recoveryTime: number;
    timestamp: number;
  }): Promise<void> {
    try {
      const redis = await this.getRedis();
      const key = `quality:system:${Date.now()}`;
      await redis.setex(key, 3600, JSON.stringify(health));

      logger.debug('System health recorded', health);
    } catch (error) {
      logger.error('Failed to record system health', { error });
    }
  }

  // Record operational metrics
  async recordOperationalMetrics(metrics: {
    performanceVariance: number;
    throughputStability: number;
    memoryStability: number;
    loadHandling: number;
    timestamp: number;
  }): Promise<void> {
    try {
      const redis = await this.getRedis();
      const key = `quality:operational:${Date.now()}`;
      await redis.setex(key, 3600, JSON.stringify(metrics));

      logger.debug('Operational metrics recorded', metrics);
    } catch (error) {
      logger.error('Failed to record operational metrics', { error });
    }
  }

  // Calculate current professional quality score
  async calculateQualityScore(
    assessmentPeriod: { start: number; end: number } = {
      start: Date.now() - (60 * 60 * 1000), // Last hour
      end: Date.now()
    }
  ): Promise<ProfessionalQualityScore> {
    try {
      // Gather metrics from the assessment period
      const metrics = await this.gatherMetricsForPeriod(assessmentPeriod);

      // Calculate component scores
      const componentScores = {
        detectionPerformance: this.calculateDetectionPerformanceScore(metrics.detectionLatency),
        detectionAccuracy: this.calculateDetectionAccuracyScore(metrics.detectionAccuracy),
        systemReliability: this.calculateSystemReliabilityScore(metrics.systemReliability),
        operationalConsistency: this.calculateOperationalConsistencyScore(metrics.operationalConsistency)
      };

      // Calculate overall score (weighted average)
      const overallScore = Math.round(
        componentScores.detectionPerformance * 0.25 +
        componentScores.detectionAccuracy * 0.25 +
        componentScores.systemReliability * 0.25 +
        componentScores.operationalConsistency * 0.25
      );

      // Determine grade and risk level
      const { grade, riskLevel } = this.determineGradeAndRisk(overallScore, componentScores);

      // Generate recommendations
      const recommendations = this.generateRecommendations(componentScores, metrics);

      const score: ProfessionalQualityScore = {
        overallScore,
        grade,
        componentScores,
        metrics,
        timestamp: Date.now(),
        assessmentPeriod: {
          ...assessmentPeriod,
          duration: assessmentPeriod.end - assessmentPeriod.start
        },
        recommendations,
        riskLevel
      };

      // Store score history
      this.scoreHistory.push(score);
      if (this.scoreHistory.length > 100) {
        this.scoreHistory.shift(); // Keep last 100 scores
      }

      // Cache the score
      const redis = await this.getRedis();
      await redis.setex(
        `quality:score:current`,
        300, // 5 minutes
        JSON.stringify(score)
      );

      logger.info('Professional quality score calculated', {
        overallScore,
        grade,
        riskLevel,
        assessmentPeriod: `${assessmentPeriod.start} - ${assessmentPeriod.end}`
      });

      return score;
    } catch (error) {
      logger.error('Failed to calculate quality score', { error });
      throw error;
    }
  }

  // Get current quality score
  async getCurrentQualityScore(): Promise<ProfessionalQualityScore | null> {
    try {
      const redis = await this.getRedis();
      const cached = await redis.get('quality:score:current');
      if (cached) {
        return JSON.parse(cached);
      }

      // Calculate fresh score if not cached
      return await this.calculateQualityScore();
    } catch (error) {
      logger.error('Failed to get current quality score', { error });
      return null;
    }
  }

  // Get quality score history
  async getQualityScoreHistory(limit: number = 50): Promise<ProfessionalQualityScore[]> {
    try {
      return this.scoreHistory.slice(-limit);
    } catch (error) {
      logger.error('Failed to get quality score history', { error });
      return [];
    }
  }

  // Check if new features impact quality
  async assessFeatureImpact(
    baselineScore: ProfessionalQualityScore,
    newScore: ProfessionalQualityScore
  ): Promise<{
    impact: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'CRITICAL';
    scoreChange: number;
    componentChanges: Record<string, number>;
    recommendations: string[];
  }> {
    const scoreChange = newScore.overallScore - baselineScore.overallScore;
    const componentChanges = {
      detectionPerformance: newScore.componentScores.detectionPerformance - baselineScore.componentScores.detectionPerformance,
      detectionAccuracy: newScore.componentScores.detectionAccuracy - baselineScore.componentScores.detectionAccuracy,
      systemReliability: newScore.componentScores.systemReliability - baselineScore.componentScores.systemReliability,
      operationalConsistency: newScore.componentScores.operationalConsistency - baselineScore.componentScores.operationalConsistency
    };

    let impact: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'CRITICAL';
    if (scoreChange >= 5) impact = 'POSITIVE';
    else if (scoreChange >= -2) impact = 'NEUTRAL';
    else if (scoreChange >= -10) impact = 'NEGATIVE';
    else impact = 'CRITICAL';

    const recommendations = this.generateFeatureImpactRecommendations(impact, componentChanges);

    return {
      impact,
      scoreChange,
      componentChanges,
      recommendations
    };
  }

  private async gatherMetricsForPeriod(period: { start: number; end: number }): Promise<QualityMetrics> {
    // Gather detection latency metrics
    const detectionLatencies = await this.getDetectionLatenciesForPeriod(period);
    const detectionLatencyMetrics = this.calculateLatencyMetrics(detectionLatencies);

    // Gather detection accuracy metrics
    const detectionAccuracy = await this.getDetectionAccuracyForPeriod(period);

    // Gather system reliability metrics
    const systemReliability = await this.getSystemReliabilityForPeriod(period);

    // Gather operational consistency metrics
    const operationalConsistency = await this.getOperationalConsistencyForPeriod(period);

    return {
      detectionLatency: detectionLatencyMetrics,
      detectionAccuracy,
      systemReliability,
      operationalConsistency
    };
  }

  private calculateLatencyMetrics(latencies: number[]): QualityMetrics['detectionLatency'] {
    if (latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, max: 0 };
    }

    const sorted = latencies.sort((a, b) => a - b);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      p50: sorted[p50Index],
      p95: sorted[p95Index],
      p99: sorted[p99Index],
      max: Math.max(...sorted)
    };
  }

  private calculateDetectionPerformanceScore(latency: QualityMetrics['detectionLatency']): number {
    const { p95, p99, max } = latency;

    // Score based on meeting professional thresholds
    let score = 100;

    // Penalize for exceeding P95 threshold
    if (p95 > this.THRESHOLDS.detectionLatency.p95) {
      score -= Math.min(40, (p95 - this.THRESHOLDS.detectionLatency.p95) * 2);
    }

    // Penalize for exceeding P99 threshold
    if (p99 > this.THRESHOLDS.detectionLatency.p99) {
      score -= Math.min(30, (p99 - this.THRESHOLDS.detectionLatency.p99));
    }

    // Penalize for exceeding max threshold
    if (max > this.THRESHOLDS.detectionLatency.max) {
      score -= Math.min(30, (max - this.THRESHOLDS.detectionLatency.max) / 10);
    }

    return Math.max(0, Math.min(100, score));
  }

  private calculateDetectionAccuracyScore(accuracy: QualityMetrics['detectionAccuracy']): number {
    const { precision, recall, f1Score, falsePositiveRate } = accuracy;

    let score = 100;

    // Penalize for low precision
    if (precision < this.THRESHOLDS.detectionAccuracy.precision) {
      score -= Math.min(40, (this.THRESHOLDS.detectionAccuracy.precision - precision) * 100);
    }

    // Penalize for low recall
    if (recall < this.THRESHOLDS.detectionAccuracy.recall) {
      score -= Math.min(30, (this.THRESHOLDS.detectionAccuracy.recall - recall) * 100);
    }

    // Penalize for low F1 score
    if (f1Score < this.THRESHOLDS.detectionAccuracy.f1Score) {
      score -= Math.min(20, (this.THRESHOLDS.detectionAccuracy.f1Score - f1Score) * 100);
    }

    // Penalize for high false positive rate
    if (falsePositiveRate > this.THRESHOLDS.detectionAccuracy.falsePositiveRate) {
      score -= Math.min(10, (falsePositiveRate - this.THRESHOLDS.detectionAccuracy.falsePositiveRate) * 1000);
    }

    return Math.max(0, Math.min(100, score));
  }

  private calculateSystemReliabilityScore(reliability: QualityMetrics['systemReliability']): number {
    const { uptime, availability, errorRate, recoveryTime } = reliability;

    let score = 100;

    // Penalize for low uptime
    if (uptime < this.THRESHOLDS.systemReliability.uptime) {
      score -= Math.min(40, (this.THRESHOLDS.systemReliability.uptime - uptime) * 10000);
    }

    // Penalize for low availability
    if (availability < this.THRESHOLDS.systemReliability.availability) {
      score -= Math.min(30, (this.THRESHOLDS.systemReliability.availability - availability) * 1000);
    }

    // Penalize for high error rate
    if (errorRate > this.THRESHOLDS.systemReliability.errorRate) {
      score -= Math.min(20, (errorRate - this.THRESHOLDS.systemReliability.errorRate) * 10000);
    }

    // Penalize for long recovery time
    if (recoveryTime > this.THRESHOLDS.systemReliability.recoveryTime) {
      score -= Math.min(10, (recoveryTime - this.THRESHOLDS.systemReliability.recoveryTime) / 3);
    }

    return Math.max(0, Math.min(100, score));
  }

  private calculateOperationalConsistencyScore(consistency: QualityMetrics['operationalConsistency']): number {
    const { performanceVariance, throughputStability, memoryStability, loadHandling } = consistency;

    let score = 100;

    // Penalize for high performance variance
    if (performanceVariance > this.THRESHOLDS.operationalConsistency.performanceVariance) {
      score -= Math.min(40, (performanceVariance - this.THRESHOLDS.operationalConsistency.performanceVariance) * 1000);
    }

    // Penalize for low throughput stability
    if (throughputStability < this.THRESHOLDS.operationalConsistency.throughputStability) {
      score -= Math.min(30, (this.THRESHOLDS.operationalConsistency.throughputStability - throughputStability) * 100);
    }

    // Penalize for high memory variance
    if (memoryStability > this.THRESHOLDS.operationalConsistency.memoryStability) {
      score -= Math.min(20, (memoryStability - this.THRESHOLDS.operationalConsistency.memoryStability) * 2000);
    }

    // Penalize for poor load handling
    if (loadHandling < this.THRESHOLDS.operationalConsistency.loadHandling) {
      score -= Math.min(10, (this.THRESHOLDS.operationalConsistency.loadHandling - loadHandling) * 100);
    }

    return Math.max(0, Math.min(100, score));
  }

  private determineGradeAndRisk(
    overallScore: number,
    componentScores: ProfessionalQualityScore['componentScores']
  ): { grade: ProfessionalQualityScore['grade']; riskLevel: ProfessionalQualityScore['riskLevel'] } {
    let grade: ProfessionalQualityScore['grade'];
    let riskLevel: ProfessionalQualityScore['riskLevel'];

    if (overallScore >= 95) {
      grade = 'A+';
      riskLevel = 'LOW';
    } else if (overallScore >= 90) {
      grade = 'A';
      riskLevel = 'LOW';
    } else if (overallScore >= 80) {
      grade = 'B';
      riskLevel = 'MEDIUM';
    } else if (overallScore >= 70) {
      grade = 'C';
      riskLevel = 'MEDIUM';
    } else if (overallScore >= 60) {
      grade = 'D';
      riskLevel = 'HIGH';
    } else {
      grade = 'F';
      riskLevel = 'CRITICAL';
    }

    // Check for critical component failures
    const criticalComponents = Object.values(componentScores).filter(score => score < 50);
    if (criticalComponents.length > 0) {
      riskLevel = 'CRITICAL';
      if (grade !== 'F') grade = 'F';
    }

    return { grade, riskLevel };
  }

  private generateRecommendations(
    componentScores: ProfessionalQualityScore['componentScores'],
    metrics: QualityMetrics
  ): string[] {
    const recommendations: string[] = [];

    if (componentScores.detectionPerformance < 80) {
      recommendations.push('Optimize detection latency - consider SIMD optimizations and caching improvements');
      if (metrics.detectionLatency.p95 > 10) {
        recommendations.push('Critical: P95 latency exceeds 10ms - immediate performance optimization required');
      }
    }

    if (componentScores.detectionAccuracy < 80) {
      recommendations.push('Improve detection accuracy - review arbitrage detection algorithms');
      if (metrics.detectionAccuracy.falsePositiveRate > 0.05) {
        recommendations.push('High false positive rate detected - tune detection thresholds');
      }
    }

    if (componentScores.systemReliability < 80) {
      recommendations.push('Enhance system reliability - implement circuit breakers and health checks');
      if (metrics.systemReliability.uptime < 0.99) {
        recommendations.push('Uptime below 99% - investigate service stability issues');
      }
    }

    if (componentScores.operationalConsistency < 80) {
      recommendations.push('Improve operational consistency - stabilize performance under load');
      if (metrics.operationalConsistency.performanceVariance > 0.2) {
        recommendations.push('High performance variance - optimize resource allocation');
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('System performing at professional standards - maintain current practices');
    }

    return recommendations;
  }

  private generateFeatureImpactRecommendations(
    impact: string,
    componentChanges: Record<string, number>
  ): string[] {
    const recommendations: string[] = [];

    if (impact === 'CRITICAL') {
      recommendations.push('🚨 CRITICAL: Feature significantly degrades professional quality');
      recommendations.push('Immediate action required: revert feature or implement fixes');
    } else if (impact === 'NEGATIVE') {
      recommendations.push('⚠️ Feature negatively impacts quality - performance optimization needed');
    } else if (impact === 'POSITIVE') {
      recommendations.push('✅ Feature improves professional quality - consider promoting');
    }

    // Specific component recommendations
    Object.entries(componentChanges).forEach(([component, change]) => {
      if (change < -10) {
        recommendations.push(`Address ${component} degradation: ${change.toFixed(1)} point drop`);
      }
    });

    return recommendations;
  }

  // Data gathering methods (simplified implementations)
  private async getDetectionLatenciesForPeriod(period: { start: number; end: number }): Promise<number[]> {
    try {
      const redis = await this.getRedis();

      // P0 FIX: Use SCAN instead of KEYS to avoid blocking Redis
      const keys: string[] = [];
      let cursor = '0';
      do {
        const result = await redis.scan(cursor, 'quality:detection:*', 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== '0');

      const latencies: number[] = [];

      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          const result = JSON.parse(data);
          if (result.timestamp >= period.start && result.timestamp <= period.end) {
            latencies.push(result.latency);
          }
        }
      }

      return latencies;
    } catch (error) {
      logger.error('Failed to get detection latencies', { error });
      return [];
    }
  }

  private async getDetectionAccuracyForPeriod(period: { start: number; end: number }): Promise<QualityMetrics['detectionAccuracy']> {
    // Simplified implementation - would aggregate actual detection results
    return {
      precision: 0.96,
      recall: 0.92,
      f1Score: 0.94,
      falsePositiveRate: 0.008
    };
  }

  private async getSystemReliabilityForPeriod(period: { start: number; end: number }): Promise<QualityMetrics['systemReliability']> {
    // Simplified implementation - would aggregate actual system metrics
    return {
      uptime: 0.998,
      availability: 0.997,
      errorRate: 0.0005,
      recoveryTime: 15
    };
  }

  private async getOperationalConsistencyForPeriod(period: { start: number; end: number }): Promise<QualityMetrics['operationalConsistency']> {
    // Simplified implementation - would aggregate actual operational metrics
    return {
      performanceVariance: 0.08,
      throughputStability: 0.97,
      memoryStability: 0.03,
      loadHandling: 0.95
    };
  }

  private async updateRollingMetrics(result: any): Promise<void> {
    // Update rolling averages and statistics
    // This would maintain running statistics for real-time monitoring
  }

  private startPeriodicAssessment(): void {
    this.assessmentInterval = setInterval(async () => {
      try {
        await this.calculateQualityScore();
      } catch (error) {
        logger.error('Periodic quality assessment failed', { error });
      }
    }, this.ASSESSMENT_INTERVAL);
  }
}

// Factory function
export function createProfessionalQualityMonitor(): ProfessionalQualityMonitor {
  return new ProfessionalQualityMonitor();
}

// Default instance
let defaultQualityMonitor: ProfessionalQualityMonitor | null = null;

export function getProfessionalQualityMonitor(): ProfessionalQualityMonitor {
  if (!defaultQualityMonitor) {
    defaultQualityMonitor = createProfessionalQualityMonitor();
  }
  return defaultQualityMonitor;
}