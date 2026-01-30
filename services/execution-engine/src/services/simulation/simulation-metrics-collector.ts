/**
 * SimulationMetricsCollector - Periodic Simulation Metrics Collection
 *
 * Phase 1.1.3: Add Metrics and Dashboards
 *
 * Responsibilities:
 * - Track simulation success rate
 * - Track simulation latency
 * - Track transactions skipped due to simulation failure
 * - Provide metrics snapshot for Grafana dashboards
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - State-aware collection (skips when service stopping)
 * - Graceful error handling
 *
 * @see implementation_plan_v2.md Task 1.1.3
 */

import type { PerformanceLogger, ServiceStateManager } from '@arbitrage/core';
import type { ExecutionStats, Logger } from '../../types';
import type { ISimulationService, SimulationProviderType } from './types';

// =============================================================================
// Constants
// =============================================================================

/** Default metrics collection interval (30 seconds) */
const DEFAULT_COLLECTION_INTERVAL_MS = 30000;

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for SimulationMetricsCollector
 */
export interface SimulationMetricsCollectorConfig {
  /** Logger instance */
  logger: Logger;

  /** Performance logger for metrics output */
  perfLogger: PerformanceLogger;

  /** Function to get current execution stats */
  getStats: () => ExecutionStats;

  /** Simulation service instance (may be null if not configured) */
  simulationService: ISimulationService | null;

  /** State manager to check running state */
  stateManager: ServiceStateManager;

  /** Metrics collection interval in ms (default: 30000) */
  collectionIntervalMs?: number;
}

/**
 * Snapshot of simulation metrics at a point in time
 */
export interface SimulationMetricsSnapshot {
  /** Total simulations performed */
  simulationsPerformed: number;

  /** Simulations skipped (below threshold, time-critical, no provider) */
  simulationsSkipped: number;

  /** Executions aborted due to simulation predicting revert */
  simulationPredictedReverts: number;

  /** Simulation service errors */
  simulationErrors: number;

  /** Simulation success rate (0-1) */
  simulationSuccessRate: number;

  /** Average simulation latency in ms */
  simulationAverageLatencyMs: number;

  /** Number of times fallback provider was used */
  fallbackUsed: number;

  /** Number of cache hits */
  cacheHits: number;

  /** Provider health status */
  providerHealth: Record<string, {
    healthy: boolean;
    successRate: number;
    averageLatencyMs: number;
  }>;

  /** Timestamp of snapshot */
  timestamp: number;
}

/**
 * Public interface for SimulationMetricsCollector
 */
export interface SimulationMetricsCollector {
  /** Start metrics collection */
  start(): void;

  /** Stop metrics collection */
  stop(): void;

  /** Get current metrics snapshot */
  getSnapshot(): SimulationMetricsSnapshot;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a SimulationMetricsCollector instance.
 *
 * @param config - Collector configuration
 * @returns SimulationMetricsCollector instance
 */
export function createSimulationMetricsCollector(
  config: SimulationMetricsCollectorConfig
): SimulationMetricsCollector {
  const {
    logger,
    perfLogger,
    getStats,
    simulationService,
    stateManager,
    collectionIntervalMs = DEFAULT_COLLECTION_INTERVAL_MS,
  } = config;

  let collectionInterval: NodeJS.Timeout | null = null;
  /**
   * Internal stopped flag for this collector instance.
   *
   * Analysis Note (Finding 1.1): This variable IS used correctly:
   * - Set to false in start() to indicate collector is active
   * - Set to true in stop() to prevent double-stopping
   * - Checked in stop() to short-circuit if already stopped
   *
   * This is DISTINCT from stateManager.isRunning() which tracks the PARENT
   * service state. The `stopped` flag tracks THIS collector's state.
   */
  let stopped = false;

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Collect and log simulation metrics.
   */
  function collectMetrics(): void {
    // Skip collection if service is stopping
    if (!stateManager.isRunning()) {
      return;
    }

    try {
      const snapshot = getSnapshot();

      // Build provider health maps with single iteration (performance optimization)
      const providerHealthy: Record<string, boolean> = {};
      const providerSuccessRates: Record<string, number> = {};
      for (const [k, v] of Object.entries(snapshot.providerHealth)) {
        providerHealthy[k] = v.healthy;
        providerSuccessRates[k] = v.successRate;
      }

      // Log main metrics
      perfLogger.logMetrics({
        type: 'simulation_metrics',
        simulationsPerformed: snapshot.simulationsPerformed,
        simulationsSkipped: snapshot.simulationsSkipped,
        simulationPredictedReverts: snapshot.simulationPredictedReverts,
        simulationErrors: snapshot.simulationErrors,
        simulationSuccessRate: snapshot.simulationSuccessRate,
        simulationAverageLatencyMs: snapshot.simulationAverageLatencyMs,
        transactionsSkippedBySimulation: snapshot.simulationPredictedReverts,
        fallbackUsed: snapshot.fallbackUsed,
        cacheHits: snapshot.cacheHits,
        providerHealthy,
        providerSuccessRates,
        timestamp: snapshot.timestamp,
      });

      // Log latency as event latency for time-series tracking
      if (snapshot.simulationAverageLatencyMs > 0) {
        perfLogger.logEventLatency('simulation_average', snapshot.simulationAverageLatencyMs, {
          successRate: snapshot.simulationSuccessRate,
          totalSimulations: snapshot.simulationsPerformed,
        });
      }

      // Log health check for simulation service
      const healthyProviders = Object.values(snapshot.providerHealth).filter((p) => p.healthy).length;
      const totalProviders = Object.keys(snapshot.providerHealth).length;

      // Determine status: not_configured (no service), degraded (all providers unhealthy), healthy
      let status: 'healthy' | 'degraded' | 'not_configured';
      if (!simulationService) {
        status = 'not_configured';
      } else if (totalProviders === 0 || healthyProviders === 0) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }

      perfLogger.logHealthCheck('simulation-service', {
        status,
        simulationSuccessRate: snapshot.simulationSuccessRate,
        averageLatencyMs: snapshot.simulationAverageLatencyMs,
        healthyProviders,
        totalProviders,
        simulationsPerformed: snapshot.simulationsPerformed,
        simulationPredictedReverts: snapshot.simulationPredictedReverts,
      });

      logger.debug('Simulation metrics collected', {
        successRate: snapshot.simulationSuccessRate,
        avgLatency: snapshot.simulationAverageLatencyMs,
        performed: snapshot.simulationsPerformed,
        skipped: snapshot.simulationsSkipped,
      });
    } catch (error) {
      logger.error('Simulation metrics collection error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current metrics snapshot.
   */
  function getSnapshot(): SimulationMetricsSnapshot {
    const stats = getStats();

    // Default values when simulation service is not available
    let simulationSuccessRate = 0;
    let simulationAverageLatencyMs = 0;
    let fallbackUsed = 0;
    let cacheHits = 0;
    const providerHealth: Record<string, {
      healthy: boolean;
      successRate: number;
      averageLatencyMs: number;
    }> = {};

    // Get metrics from simulation service if available
    if (simulationService) {
      const aggregatedMetrics = simulationService.getAggregatedMetrics();

      // Calculate success rate
      if (aggregatedMetrics.totalSimulations > 0) {
        simulationSuccessRate =
          aggregatedMetrics.successfulSimulations / aggregatedMetrics.totalSimulations;
      }

      simulationAverageLatencyMs = aggregatedMetrics.averageLatencyMs;
      fallbackUsed = aggregatedMetrics.fallbackUsed;
      cacheHits = aggregatedMetrics.cacheHits;

      // Get provider health
      const healthMap = simulationService.getProvidersHealth();
      for (const [providerType, health] of healthMap) {
        providerHealth[providerType] = {
          healthy: health.healthy,
          successRate: health.successRate,
          averageLatencyMs: health.averageLatencyMs,
        };
      }
    }

    return {
      simulationsPerformed: stats.simulationsPerformed,
      simulationsSkipped: stats.simulationsSkipped,
      simulationPredictedReverts: stats.simulationPredictedReverts,
      simulationErrors: stats.simulationErrors,
      simulationSuccessRate,
      simulationAverageLatencyMs,
      fallbackUsed,
      cacheHits,
      providerHealth,
      timestamp: Date.now(),
    };
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Start metrics collection.
   */
  function start(): void {
    if (collectionInterval) {
      return; // Already started
    }

    logger.info('SimulationMetricsCollector started', {
      intervalMs: collectionIntervalMs,
      hasSimulationService: !!simulationService,
    });

    collectionInterval = setInterval(collectMetrics, collectionIntervalMs);
    stopped = false;
  }

  /**
   * Stop metrics collection.
   */
  function stop(): void {
    if (stopped) {
      return; // Already stopped
    }

    stopped = true;

    if (collectionInterval) {
      clearInterval(collectionInterval);
      collectionInterval = null;
    }

    logger.info('SimulationMetricsCollector stopped');
  }

  return {
    start,
    stop,
    getSnapshot,
  };
}
