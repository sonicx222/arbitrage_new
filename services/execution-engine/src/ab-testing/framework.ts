/**
 * A/B Testing Framework
 *
 * Main framework class that orchestrates experiment management, variant
 * assignment, and statistical analysis.
 *
 * Features:
 * - Traffic splitting with deterministic assignment
 * - Multiple concurrent experiments
 * - Statistical significance calculation (Z-test)
 * - Redis-backed metrics persistence
 *
 * @see FINAL_IMPLEMENTATION_PLAN.md Task 3: A/B Testing Framework
 */

import { clearIntervalSafe } from '@arbitrage/core/async';
import type { ServiceLogger } from '@arbitrage/core/logging';
import type { RedisClient } from '@arbitrage/core/redis';
import type {
  Experiment,
  ExperimentStatus,
  VariantAssignment,
  ABTestingConfig,
  ExperimentSummary,
  ABTestExecutionResult,
} from './types';
import { DEFAULT_AB_TESTING_CONFIG } from './types';
import { MetricsCollector, createMetricsCollector } from './metrics-collector';
import { calculateSignificance } from './statistical-analysis';
import type { ExecutionResult } from '../types';

// =============================================================================
// Experiment Storage Keys
// =============================================================================

function getExperimentKey(prefix: string, experimentId: string): string {
  return `${prefix}experiment:${experimentId}`;
}

/**
 * Fast FNV-1a hash for deterministic variant assignment.
 *
 * PERF OPTIMIZATION: Replaces MD5 (crypto.createHash) which is ~10x slower.
 * FNV-1a is a non-cryptographic hash that's fast and has good distribution.
 * For traffic splitting, we don't need cryptographic security.
 *
 * @param str - String to hash
 * @returns 32-bit hash value
 */
function fnv1aHash(str: string): number {
  let hash = 2166136261; // FNV offset basis for 32-bit
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // FNV prime for 32-bit: 16777619
    // Use Math.imul for proper 32-bit multiplication
    hash = Math.imul(hash, 16777619);
  }
  // Convert to unsigned 32-bit integer
  return hash >>> 0;
}

function getExperimentListKey(prefix: string): string {
  return `${prefix}experiments`;
}

// =============================================================================
// A/B Testing Framework Implementation
// =============================================================================

/**
 * A/B Testing Framework for comparing execution strategies.
 *
 * Usage:
 * ```typescript
 * const framework = new ABTestingFramework(redis, config);
 * await framework.start();
 *
 * // Create experiment
 * const experiment = await framework.createExperiment({
 *   name: 'Flash Loan vs Direct',
 *   control: 'direct',
 *   variant: 'flash-loan',
 *   trafficSplit: 0.1,
 * });
 *
 * // During execution
 * const assignment = framework.assignVariant(experiment.id, opportunityHash);
 * // ... execute with assigned strategy ...
 * await framework.recordResult(experiment.id, assignment, result);
 *
 * // Check results
 * const summary = await framework.getExperimentSummary(experiment.id);
 * if (summary.significance.significant) {
 *   console.log('Recommendation:', summary.significance.recommendation);
 * }
 * ```
 */
export class ABTestingFramework {
  private readonly redis: RedisClient;
  private readonly config: ABTestingConfig;
  private readonly metricsCollector: MetricsCollector;
  private readonly logger?: ServiceLogger;

  // In-memory cache of active experiments for hot path
  private readonly activeExperiments: Map<string, Experiment> = new Map();
  private experimentRefreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs = 60000; // Refresh every minute

  private started = false;

  constructor(redis: RedisClient, config: Partial<ABTestingConfig> = {}, logger?: ServiceLogger) {
    this.redis = redis;
    this.config = { ...DEFAULT_AB_TESTING_CONFIG, ...config };
    this.logger = logger;
    this.metricsCollector = createMetricsCollector(redis, this.config, logger);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the A/B testing framework.
   * Loads active experiments and starts refresh timer.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (!this.config.enabled) {
      this.started = true;
      return;
    }

    // Load active experiments
    await this.refreshActiveExperiments();

    // Start refresh timer
    this.experimentRefreshTimer = setInterval(() => {
      this.refreshActiveExperiments().catch((error) => {
        if (this.logger) {
          this.logger.error('Failed to refresh A/B experiments', { error: String(error) });
        }
      });
    }, this.refreshIntervalMs);

    this.started = true;
  }

  /**
   * Stop the A/B testing framework.
   * Flushes metrics and clears timers.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.experimentRefreshTimer = clearIntervalSafe(this.experimentRefreshTimer);

    await this.metricsCollector.stop();
    this.activeExperiments.clear();
    this.started = false;
  }

  // ===========================================================================
  // Experiment Management
  // ===========================================================================

  /**
   * Create a new experiment.
   *
   * @param params - Experiment parameters
   * @returns Created experiment
   */
  async createExperiment(params: {
    name: string;
    control: string;
    variant: string;
    trafficSplit?: number;
    minSampleSize?: number;
    description?: string;
    chainFilter?: string;
    dexFilter?: string;
    startImmediately?: boolean;
  }): Promise<Experiment> {
    const id = this.generateExperimentId(params.name);

    const experiment: Experiment = {
      id,
      name: params.name,
      control: params.control,
      variant: params.variant,
      trafficSplit: params.trafficSplit ?? this.config.defaultTrafficSplit,
      startDate: new Date(),
      minSampleSize: params.minSampleSize ?? this.config.defaultMinSampleSize,
      status: params.startImmediately !== false ? 'running' : 'draft',
      description: params.description,
      chainFilter: params.chainFilter,
      dexFilter: params.dexFilter,
    };

    // Save to Redis
    await this.saveExperiment(experiment);

    // Add to active experiments if running
    if (experiment.status === 'running') {
      this.activeExperiments.set(id, experiment);
    }

    return experiment;
  }

  /**
   * Get an experiment by ID.
   *
   * @param experimentId - The experiment ID
   * @returns The experiment or null if not found
   */
  async getExperiment(experimentId: string): Promise<Experiment | null> {
    // Check cache first
    const cached = this.activeExperiments.get(experimentId);
    if (cached) {
      return cached;
    }

    // Load from Redis
    return this.loadExperiment(experimentId);
  }

  /**
   * List all experiments.
   *
   * @param status - Optional filter by status
   * @returns List of experiments
   */
  async listExperiments(status?: ExperimentStatus): Promise<Experiment[]> {
    const ids = await this.getExperimentIds();
    const experiments = await Promise.all(
      ids.map((id) => this.loadExperiment(id))
    );

    const filtered = experiments.filter((e): e is Experiment => e !== null);

    if (status) {
      return filtered.filter((e) => e.status === status);
    }

    return filtered;
  }

  /**
   * Update experiment status.
   *
   * @param experimentId - The experiment ID
   * @param status - New status
   */
  async updateExperimentStatus(
    experimentId: string,
    status: ExperimentStatus
  ): Promise<void> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    experiment.status = status;

    if (status === 'completed' || status === 'cancelled') {
      experiment.endDate = new Date();
    }

    await this.saveExperiment(experiment);

    // Update cache
    if (status === 'running') {
      this.activeExperiments.set(experimentId, experiment);
    } else {
      this.activeExperiments.delete(experimentId);
    }
  }

  // ===========================================================================
  // Variant Assignment (Hot Path)
  // ===========================================================================

  /**
   * Assign a variant for an opportunity.
   *
   * This is a HOT PATH method - must be O(1) and allocation-free.
   * Uses deterministic hashing for consistent assignment.
   *
   * @param experimentId - The experiment ID
   * @param opportunityHash - Hash of the opportunity (used for deterministic assignment)
   * @returns Assigned variant or null if experiment not active
   */
  assignVariant(
    experimentId: string,
    opportunityHash: string
  ): VariantAssignment | null {
    if (!this.config.enabled) {
      return null;
    }

    // Check cached active experiments (O(1) lookup)
    const experiment = this.activeExperiments.get(experimentId);
    if (!experiment || experiment.status !== 'running') {
      return null;
    }

    // Deterministic assignment based on opportunity hash
    return this.deterministicAssign(opportunityHash, experiment.trafficSplit);
  }

  /**
   * Get variant assignment for an opportunity across all active experiments.
   *
   * @param opportunityHash - Hash of the opportunity
   * @param chain - Optional chain filter
   * @param dex - Optional DEX filter
   * @returns Map of experimentId -> variant assignment
   */
  assignAllVariants(
    opportunityHash: string,
    chain?: string,
    dex?: string
  ): Map<string, VariantAssignment> {
    const assignments = new Map<string, VariantAssignment>();

    if (!this.config.enabled) {
      return assignments;
    }

    for (const [id, experiment] of this.activeExperiments) {
      // Check filters
      if (experiment.chainFilter && experiment.chainFilter !== chain) {
        continue;
      }
      if (experiment.dexFilter && experiment.dexFilter !== dex) {
        continue;
      }

      const variant = this.deterministicAssign(
        opportunityHash,
        experiment.trafficSplit
      );
      assignments.set(id, variant);
    }

    return assignments;
  }

  // ===========================================================================
  // Result Recording
  // ===========================================================================

  /**
   * Record an execution result for an experiment.
   *
   * @param experimentId - The experiment ID
   * @param variant - The variant that was used
   * @param result - The execution result
   * @param latencyMs - Execution latency in milliseconds
   * @param mevFrontrunDetected - Whether MEV frontrun was detected
   */
  async recordResult(
    experimentId: string,
    variant: VariantAssignment,
    result: ExecutionResult,
    latencyMs: number,
    mevFrontrunDetected: boolean = false
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const abResult: ABTestExecutionResult = {
      result,
      experimentId,
      variant,
      timestamp: Date.now(),
      latencyMs,
      mevFrontrunDetected,
    };

    await this.metricsCollector.recordResult(abResult);
  }

  // ===========================================================================
  // Analysis
  // ===========================================================================

  /**
   * Get experiment summary with metrics and significance analysis.
   *
   * @param experimentId - The experiment ID
   * @returns Experiment summary or null if not found
   */
  async getExperimentSummary(experimentId: string): Promise<ExperimentSummary | null> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment) {
      return null;
    }

    const { control: controlMetrics, variant: variantMetrics } =
      await this.metricsCollector.getExperimentMetrics(experimentId);

    if (!controlMetrics || !variantMetrics) {
      // Not enough data yet
      const emptyMetrics = {
        experimentId,
        variant: 'control' as const,
        successCount: 0,
        failureCount: 0,
        totalProfitWei: '0',
        totalGasCostWei: '0',
        totalLatencyMs: 0,
        mevFrontrunCount: 0,
        successRate: 0,
        avgProfitWei: '0',
        avgGasCostWei: '0',
        avgLatencyMs: 0,
        mevFrontrunRate: 0,
        sampleSize: 0,
      };

      return {
        experiment,
        controlMetrics: controlMetrics || { ...emptyMetrics, variant: 'control' },
        variantMetrics: variantMetrics || { ...emptyMetrics, variant: 'variant' },
        significance: {
          pValue: 1,
          significant: false,
          zScore: 0,
          confidenceInterval: { lower: 0, upper: 0 },
          effectSize: 0,
          recommendation: 'continue_testing',
          sampleSizeWarning: 'No data collected yet',
        },
        runtimeHours: 0,
        readyForConclusion: false,
      };
    }

    // Calculate significance
    const significance = calculateSignificance(
      controlMetrics,
      variantMetrics,
      this.config.significanceThreshold,
      experiment.minSampleSize
    );

    // Calculate runtime
    const startTime = experiment.startDate.getTime();
    const endTime = experiment.endDate?.getTime() || Date.now();
    const runtimeHours = (endTime - startTime) / (1000 * 60 * 60);

    // Check if ready for conclusion
    const hasEnoughData =
      controlMetrics.sampleSize >= experiment.minSampleSize &&
      variantMetrics.sampleSize >= experiment.minSampleSize;
    const readyForConclusion = hasEnoughData && significance.significant;

    return {
      experiment,
      controlMetrics,
      variantMetrics,
      significance,
      runtimeHours,
      readyForConclusion,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Deterministic variant assignment using hash.
   * Ensures same opportunity always gets same variant.
   *
   * PERF OPTIMIZATION: Uses fast FNV-1a hash instead of MD5.
   * On hot path, this saves ~10x overhead per call.
   */
  private deterministicAssign(
    opportunityHash: string,
    trafficSplit: number
  ): VariantAssignment {
    // Create deterministic hash value between 0 and 1
    // FNV-1a returns 32-bit unsigned int, divide by 2^32 for 0.0-1.0 range
    const hash = fnv1aHash(opportunityHash);
    const hashValue = hash / 4294967296; // 0.0 - 1.0

    // Assign to variant if hash < trafficSplit
    return hashValue < trafficSplit ? 'variant' : 'control';
  }

  private generateExperimentId(name: string): string {
    const timestamp = Date.now().toString(36);
    const sanitizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `${sanitizedName}-${timestamp}`;
  }

  private async saveExperiment(experiment: Experiment): Promise<void> {
    const key = getExperimentKey(this.config.redisKeyPrefix, experiment.id);
    const listKey = getExperimentListKey(this.config.redisKeyPrefix);

    // Serialize dates
    const serialized = {
      ...experiment,
      startDate: experiment.startDate.toISOString(),
      endDate: experiment.endDate?.toISOString(),
    };

    await Promise.all([
      this.redis.set(key, serialized),
      this.redis.sadd(listKey, experiment.id),
    ]);
  }

  private async loadExperiment(experimentId: string): Promise<Experiment | null> {
    const key = getExperimentKey(this.config.redisKeyPrefix, experimentId);
    const data = await this.redis.get(key);

    if (!data || typeof data !== 'object') {
      return null;
    }

    const raw = data as Record<string, unknown>;

    // Deserialize dates
    return {
      ...raw,
      startDate: new Date(raw.startDate as string),
      endDate: raw.endDate ? new Date(raw.endDate as string) : undefined,
    } as Experiment;
  }

  private async getExperimentIds(): Promise<string[]> {
    const listKey = getExperimentListKey(this.config.redisKeyPrefix);
    const members = await this.redis.smembers(listKey);
    return members || [];
  }

  /**
   * Refresh the in-memory cache of active experiments.
   *
   * RACE CONDITION FIX: Builds new map first, then swaps atomically.
   * This prevents readers from seeing an empty cache during refresh.
   */
  private async refreshActiveExperiments(): Promise<void> {
    const experiments = await this.listExperiments('running');

    // Build new map first (no clear + loop pattern)
    // Then do atomic swap via clear + immediate repopulate
    // The JS event loop ensures this runs to completion without interleaving
    const newCache = new Map<string, Experiment>();
    for (const experiment of experiments) {
      newCache.set(experiment.id, experiment);
    }

    // Atomic swap: clear and copy in single synchronous operation
    this.activeExperiments.clear();
    for (const [id, exp] of newCache) {
      this.activeExperiments.set(id, exp);
    }
  }
}

/**
 * Factory function to create an A/B testing framework.
 *
 * @param redis - Redis client instance
 * @param config - Optional configuration overrides
 * @returns ABTestingFramework instance
 */
export function createABTestingFramework(
  redis: RedisClient,
  config?: Partial<ABTestingConfig>,
  logger?: ServiceLogger
): ABTestingFramework {
  return new ABTestingFramework(redis, config, logger);
}
