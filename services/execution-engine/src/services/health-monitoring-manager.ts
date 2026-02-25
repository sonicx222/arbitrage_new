/**
 * Health Monitoring Manager
 *
 * Extracted from engine.ts as part of P0 refactoring to reduce God Class size.
 * Handles non-hot-path interval-based monitoring operations:
 * - Health check publishing (30s interval)
 * - Gas baseline cleanup (memory management)
 * - Stale pending message cleanup
 * - Lock conflict tracker cleanup
 *
 * Performance Note (Constraint Compliance):
 * - NOT on hot path - all operations run on intervals
 * - Dependencies injected via constructor (one-time cost)
 * - Maps passed by reference (gasBaselines, lastGasPrices) - no copies
 * - No abstraction added to processQueueItems() or execution path
 *
 * @see engine.ts (consumer)
 * @see REFACTORING_ANALYSIS.md P0
 */

import { clearIntervalSafe } from '@arbitrage/core/async';
import { RedisStreamsClient, type RedisClient } from '@arbitrage/core/redis';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { ServiceStateManager } from '@arbitrage/core/service-lifecycle';
import { type PerformanceLogger } from '@arbitrage/core';
import type { ServiceHealth } from '@arbitrage/types';
import type {
  Logger,
  ExecutionStats,
  ConsumerConfig,
  GasBaselineEntry,
} from '../types';
import { DEFAULT_CONSUMER_CONFIG } from '../types';
import type { LockConflictTracker } from './lock-conflict-tracker';
import type { QueueServiceImpl } from './queue.service';
import type { OpportunityConsumer } from '../consumers/opportunity.consumer';
import type { SimulationMetricsSnapshot } from './simulation/simulation-metrics-collector';

// =============================================================================
// Types
// =============================================================================

// GasBaselineEntry is now imported from ../types (unified definition)
export type { GasBaselineEntry } from '../types';

/**
 * Dependencies for HealthMonitoringManager.
 *
 * Design: Uses constructor injection with getters for nullable services.
 * - Direct references for immutable/long-lived objects (logger, Maps)
 * - Getter functions for services that may be null or change
 *
 * Performance: All dependencies injected once at construction.
 * No object creation or map copying in interval callbacks.
 */
export interface HealthMonitoringDependencies {
  /** Logger instance (direct reference - immutable) */
  logger: Logger;
  /** Performance logger (direct reference - immutable) */
  perfLogger: PerformanceLogger;
  /** State manager reference (direct - long-lived) */
  stateManager: ServiceStateManager;
  /** Execution stats (direct reference - same object mutated) */
  stats: ExecutionStats;
  /** Gas baselines map (BY REFERENCE - mutated in place) */
  gasBaselines: Map<string, GasBaselineEntry[]>;
  /** Lock conflict tracker (direct reference) */
  lockConflictTracker: LockConflictTracker;
  /** Consumer config for cleanup intervals */
  consumerConfig: Partial<ConsumerConfig> | undefined;

  // Getter functions for nullable/changing services
  /** Get Redis streams client (may be null during shutdown) */
  getStreamsClient: () => RedisStreamsClient | null;
  /** Get Redis client (may be null) */
  getRedis: () => RedisClient | null;
  /** Get queue service (may be null) */
  getQueueService: () => QueueServiceImpl | null;
  /** Get opportunity consumer (may be null) */
  getOpportunityConsumer: () => OpportunityConsumer | null;
  /** Get simulation metrics snapshot (may be null) */
  getSimulationMetricsSnapshot: () => SimulationMetricsSnapshot | null;
  /** Fix 4: Get strategy-specific metrics (backrun, uniswapx) */
  getStrategyMetrics?: () => Record<string, unknown>;
}

// =============================================================================
// Constants
// =============================================================================

/** Health check publishing interval (30 seconds) */
const HEALTH_CHECK_INTERVAL_MS = 30000;

/** Maximum age for gas baseline entries before cleanup (5 minutes) */
const GAS_BASELINE_MAX_AGE_MS = 5 * 60 * 1000;

/** Maximum number of gas baseline entries per chain */
const GAS_BASELINE_MAX_ENTRIES_PER_CHAIN = 100;

// =============================================================================
// HealthMonitoringManager Class
// =============================================================================

/**
 * Manages health monitoring intervals for the execution engine.
 *
 * Responsibilities:
 * 1. Health check publishing to Redis streams
 * 2. Gas baseline cleanup (memory leak prevention)
 * 3. Stale pending message cleanup coordination
 * 4. Lock conflict tracking cleanup
 *
 * NOT responsible for (stays in engine.ts):
 * - Queue processing (hot path)
 * - Execution logic (hot path)
 * - Strategy selection (hot path)
 */
export class HealthMonitoringManager {
  private readonly deps: HealthMonitoringDependencies;

  // Interval handles
  private healthMonitoringInterval: NodeJS.Timeout | null = null;
  private stalePendingCleanupInterval: NodeJS.Timeout | null = null;

  // Concurrency guards to prevent overlapping async callbacks
  private isReporting = false;

  constructor(deps: HealthMonitoringDependencies) {
    this.deps = deps;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start all health monitoring intervals.
   * Called from engine.ts during service startup.
   */
  start(): void {
    this.startHealthMonitoringInterval();
    this.startStalePendingCleanupInterval();

    this.deps.logger.debug('Health monitoring manager started');
  }

  /**
   * Stop all health monitoring intervals.
   * Called from engine.ts during service shutdown.
   */
  stop(): void {
    this.clearIntervals();

    this.deps.logger.debug('Health monitoring manager stopped');
  }

  // ===========================================================================
  // Health Monitoring Interval
  // ===========================================================================

  /**
   * Start the main health monitoring interval.
   *
   * Performs every 30 seconds:
   * - Gas baseline cleanup (memory management)
   * - Lock conflict tracker cleanup
   * - Health data collection and publishing
   */
  private startHealthMonitoringInterval(): void {
    this.healthMonitoringInterval = setInterval(async () => {
      // Concurrency guard: skip if previous callback is still running (e.g., Redis pressure)
      if (this.isReporting) return;
      this.isReporting = true;

      try {
        // Cleanup operations (non-blocking, fast)
        this.cleanupGasBaselines();
        this.deps.lockConflictTracker.cleanup();

        // Collect and publish health data
        await this.collectAndPublishHealth();
      } catch (error) {
        this.deps.logger.error('Execution engine health monitoring failed', { error });
      } finally {
        this.isReporting = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Collect current health data and publish to Redis.
   */
  private async collectAndPublishHealth(): Promise<void> {
    const health: ServiceHealth = {
      name: 'execution-engine',
      status: this.deps.stateManager.isRunning() ? 'healthy' : 'unhealthy',
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().heapUsed,
      cpuUsage: 0,
      lastHeartbeat: Date.now(),
      error: undefined,
    };

    // Get optional metrics
    const simulationMetrics = this.deps.getSimulationMetricsSnapshot();
    const queueService = this.deps.getQueueService();
    const opportunityConsumer = this.deps.getOpportunityConsumer();
    const streamsClient = this.deps.getStreamsClient();
    const redis = this.deps.getRedis();

    // Publish to Redis Streams
    if (streamsClient) {
      await streamsClient.xadd(
        RedisStreamsClient.STREAMS.HEALTH,
        {
          ...health,
          queueSize: queueService?.size() ?? 0,
          queuePaused: queueService?.isPaused() ?? false,
          activeExecutions: opportunityConsumer?.getActiveCount() ?? 0,
          pendingMessages: opportunityConsumer?.getPendingCount() ?? 0,
          stats: this.deps.stats,
          simulationMetrics: simulationMetrics ?? null,
          strategyMetrics: this.deps.getStrategyMetrics?.() ?? null,
        }
      );
    }

    // Update Redis service health
    if (redis) {
      await redis.updateServiceHealth('execution-engine', health);
    }

    // Log health check
    this.deps.perfLogger.logHealthCheck('execution-engine', health);
  }

  // ===========================================================================
  // Gas Baseline Cleanup
  // ===========================================================================

  /**
   * Cleanup old gas baseline entries to prevent memory leak.
   *
   * Fix 4.2: Removes entries older than 5 minutes and limits to 100 entries per chain.
   *
   * Performance Note: Modifies Map in-place via reference (no copy).
   * The strategy layer may hold references to these arrays, so we
   * use array.length = 0 + push pattern to preserve references.
   */
  private cleanupGasBaselines(): void {
    const now = Date.now();

    for (const [chain, history] of this.deps.gasBaselines) {
      if (history.length === 0) continue;

      // Filter out entries older than MAX_AGE_MS
      const validEntries = history.filter(
        (entry) => now - entry.timestamp < GAS_BASELINE_MAX_AGE_MS
      );

      // Also limit to MAX_ENTRIES_PER_CHAIN (keep most recent)
      const trimmedEntries =
        validEntries.length > GAS_BASELINE_MAX_ENTRIES_PER_CHAIN
          ? validEntries.slice(-GAS_BASELINE_MAX_ENTRIES_PER_CHAIN)
          : validEntries;

      // Update in place to preserve references (strategies may hold reference to array)
      // This pattern is intentional - see FIX 10.2 (direct mutation for performance)
      history.length = 0;
      history.push(...trimmedEntries);
    }
  }

  // ===========================================================================
  // Stale Pending Cleanup
  // ===========================================================================

  /**
   * Start the stale pending message cleanup interval.
   *
   * Coordinates with OpportunityConsumer to cleanup orphaned pending messages.
   * Runs on configurable interval (default: 1 minute).
   */
  private startStalePendingCleanupInterval(): void {
    const cleanupIntervalMs =
      this.deps.consumerConfig?.stalePendingCleanupIntervalMs ??
      DEFAULT_CONSUMER_CONFIG.stalePendingCleanupIntervalMs;

    // Interval of 0 disables automatic cleanup
    if (cleanupIntervalMs <= 0) {
      this.deps.logger.debug('Stale pending message cleanup disabled (interval=0)');
      return;
    }

    this.stalePendingCleanupInterval = setInterval(async () => {
      // Guard: Don't run if service is shutting down
      if (!this.deps.stateManager.isRunning()) return;

      const opportunityConsumer = this.deps.getOpportunityConsumer();
      if (!opportunityConsumer) return;

      try {
        const cleanedCount = await opportunityConsumer.cleanupStalePendingMessages();
        // Re-check isRunning after async op (TOCTOU fix: service may have
        // transitioned to stopping during the await)
        if (!this.deps.stateManager.isRunning()) return;
        if (cleanedCount > 0) {
          this.deps.logger.info('Cleaned up stale pending messages', {
            cleanedCount,
            intervalMs: cleanupIntervalMs,
          });
        }
      } catch (error) {
        // Silently swallow errors during shutdown to avoid accessing torn-down resources
        if (!this.deps.stateManager.isRunning()) return;
        this.deps.logger.error('Failed to cleanup stale pending messages', {
          error: getErrorMessage(error),
        });
      }
    }, cleanupIntervalMs);

    this.deps.logger.debug('Stale pending message cleanup interval started', {
      intervalMs: cleanupIntervalMs,
    });
  }

  // ===========================================================================
  // Interval Management
  // ===========================================================================

  /**
   * Clear all monitoring intervals.
   * Called during stop() and for cleanup.
   */
  private clearIntervals(): void {
    this.healthMonitoringInterval = clearIntervalSafe(this.healthMonitoringInterval);
    this.stalePendingCleanupInterval = clearIntervalSafe(this.stalePendingCleanupInterval);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a HealthMonitoringManager instance.
 *
 * @param deps - Dependencies for the manager
 * @returns New HealthMonitoringManager instance
 */
export function createHealthMonitoringManager(
  deps: HealthMonitoringDependencies
): HealthMonitoringManager {
  return new HealthMonitoringManager(deps);
}
