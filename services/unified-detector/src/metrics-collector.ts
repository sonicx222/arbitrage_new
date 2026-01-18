/**
 * MetricsCollector - Periodic Metrics Collection
 *
 * ARCH-REFACTOR: Extracted from UnifiedChainDetector to provide a single
 * responsibility module for metrics collection and logging.
 *
 * Responsibilities:
 * - Periodic metrics collection at configurable intervals
 * - Logging health metrics via PerformanceLogger
 * - State-aware collection (skips when service stopping)
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - Simple start/stop lifecycle
 * - Error-resilient collection
 */

import { PerformanceLogger, ServiceStateManager } from '@arbitrage/core';

import { UnifiedDetectorStats } from './unified-detector';
import { Logger } from './types';

// =============================================================================
// Types
// =============================================================================

/** Function to get current stats */
export type GetStatsFn = () => UnifiedDetectorStats;

/** Configuration for MetricsCollector */
export interface MetricsCollectorConfig {
  /** Partition ID */
  partitionId: string;

  /** Performance logger */
  perfLogger: PerformanceLogger;

  /** State manager to check running state */
  stateManager: ServiceStateManager;

  /** Logger for output */
  logger: Logger;

  /** Function to get current stats */
  getStats: GetStatsFn;

  /** Metrics collection interval in ms */
  metricsIntervalMs?: number;
}

/** Public interface for MetricsCollector */
export interface MetricsCollector {
  /** Start metrics collection */
  start(): void;

  /** Stop metrics collection (async for consistency with other modules) */
  stop(): Promise<void>;
}

// =============================================================================
// Constants
// =============================================================================

/** Default metrics collection interval (60 seconds) */
const DEFAULT_METRICS_INTERVAL_MS = 60000;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a MetricsCollector instance.
 *
 * @param config - Collector configuration
 * @returns MetricsCollector instance
 */
export function createMetricsCollector(config: MetricsCollectorConfig): MetricsCollector {
  const {
    partitionId,
    perfLogger,
    stateManager,
    logger,
    getStats,
    metricsIntervalMs = DEFAULT_METRICS_INTERVAL_MS,
  } = config;

  let metricsInterval: NodeJS.Timeout | null = null;

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Collect and log metrics.
   */
  function collectMetrics(): void {
    // Skip collection if service is stopping
    if (!stateManager.isRunning()) {
      return;
    }

    try {
      const stats = getStats();

      perfLogger.logHealthCheck(`unified-detector-${partitionId}`, {
        status: 'healthy',
        uptime: stats.uptimeSeconds,
        memoryUsage: stats.memoryUsageMB * 1024 * 1024, // Convert MB to bytes
        chainsMonitored: stats.chains.length,
        eventsProcessed: stats.totalEventsProcessed,
        opportunitiesFound: stats.totalOpportunitiesFound,
      });
    } catch (error) {
      logger.error('Metrics collection error', { error: (error as Error).message });
    }
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Start metrics collection.
   */
  function start(): void {
    logger.info('Starting MetricsCollector', {
      partitionId,
      intervalMs: metricsIntervalMs,
    });

    metricsInterval = setInterval(collectMetrics, metricsIntervalMs);

    logger.info('MetricsCollector started');
  }

  /**
   * Stop metrics collection.
   * FIX I1: Made async for consistency with other modules.
   */
  async function stop(): Promise<void> {
    logger.info('Stopping MetricsCollector');

    if (metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }

    logger.info('MetricsCollector stopped');
  }

  return {
    start,
    stop,
  };
}
