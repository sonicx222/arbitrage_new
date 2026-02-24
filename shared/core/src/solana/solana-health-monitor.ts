/**
 * Solana Health Monitor
 *
 * ARCH-REFACTOR: Extracted from solana-detector.ts
 * Periodic health checks, slot updates with mutex + timeout,
 * latency tracking via NumericRollingWindow.
 *
 * Owns: slotUpdateMutex, recentLatencies.
 * Reads: currentSlot from orchestrator via callback.
 * Writes: currentSlot on orchestrator via setCurrentSlot callback.
 *
 * @see ADR-014: Modular Detector Components
 */

import { NumericRollingWindow } from '../data-structures/numeric-rolling-window';
import { AsyncMutex } from '../async/async-mutex';
import { clearIntervalSafe } from '../async/lifecycle-utils';
import { withTimeout } from '../async/async-utils';
import type { Connection } from '@solana/web3.js';
import type {
  SolanaDetectorLogger,
  SolanaDetectorPerfLogger,
  SolanaDetectorRedisClient,
  ConnectionMetrics,
  SolanaDetectorHealth,
  SolanaLifecycleDeps,
} from './solana-types';

// =============================================================================
// Constants
// =============================================================================

const MAX_LATENCY_SAMPLES = 100;
const MAX_LATENCY_VALUE_MS = 30000;
const SLOT_UPDATE_TIMEOUT_MS = 10000;

// =============================================================================
// Public Interface
// =============================================================================

export interface SolanaHealthMonitor {
  getHealth(): Promise<SolanaDetectorHealth>;
  /** Get the average latency from rolling window. */
  getAvgLatency(): number;
  /** Start periodic health monitoring. */
  start(): void;
  /** Stop monitoring interval. */
  stop(): void;
  /** Clear latency data. */
  cleanup(): void;
}

export interface HealthMonitorConfig {
  healthCheckIntervalMs: number;
}

export interface HealthMonitorDeps {
  logger: SolanaDetectorLogger;
  perfLogger: SolanaDetectorPerfLogger;
  redis: SolanaDetectorRedisClient | null;
  getConnection: () => Connection;
  getConnectionMetrics: (avgLatencyMs: number) => ConnectionMetrics;
  getSubscriptionCount: () => number;
  getPoolCount: () => number;
  getStartTime: () => number;
  /** Read current slot from orchestrator. */
  getCurrentSlot: () => number;
  /** Write updated slot back to orchestrator. */
  setCurrentSlot: (slot: number) => void;
  lifecycle: SolanaLifecycleDeps;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Solana health monitor.
 *
 * @param config - Monitor configuration
 * @param deps - Dependencies
 * @returns SolanaHealthMonitor
 */
export function createSolanaHealthMonitor(
  config: HealthMonitorConfig,
  deps: HealthMonitorDeps
): SolanaHealthMonitor {
  const { logger, perfLogger, lifecycle } = deps;

  // Private state
  const recentLatencies = new NumericRollingWindow(MAX_LATENCY_SAMPLES);
  const slotUpdateMutex = new AsyncMutex();
  let healthCheckInterval: NodeJS.Timeout | null = null;

  async function updateCurrentSlot(): Promise<void> {
    const release = await slotUpdateMutex.acquire();
    try {
      const startTime = Date.now();
      const connection = deps.getConnection();

      const slot = await withTimeout(
        connection.getSlot(),
        SLOT_UPDATE_TIMEOUT_MS,
        'getSlot'
      );

      deps.setCurrentSlot(slot);

      let latency = Date.now() - startTime;

      if (latency > MAX_LATENCY_VALUE_MS) {
        logger.warn('Extreme latency detected, capping value', {
          actual: latency,
          capped: MAX_LATENCY_VALUE_MS
        });
        latency = MAX_LATENCY_VALUE_MS;
      }

      recentLatencies.push(latency);
    } catch (error) {
      logger.warn('Failed to update current slot', { error });
    } finally {
      release();
    }
  }

  function getAvgLatency(): number {
    return recentLatencies.average();
  }

  async function getHealth(): Promise<SolanaDetectorHealth> {
    const avgLatency = recentLatencies.average();
    const metrics = deps.getConnectionMetrics(avgLatency);

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (!lifecycle.isRunning()) {
      status = 'unhealthy';
    } else if (metrics.healthyConnections === 0) {
      status = 'unhealthy';
    } else if (metrics.healthyConnections < metrics.totalConnections) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    const startTime = deps.getStartTime();

    return {
      service: 'solana-detector',
      status,
      uptime: startTime > 0 ? (Date.now() - startTime) / 1000 : 0,
      memoryUsage: process.memoryUsage().heapUsed,
      lastHeartbeat: Date.now(),
      connections: metrics,
      subscriptions: deps.getSubscriptionCount(),
      pools: deps.getPoolCount(),
      slot: deps.getCurrentSlot()
    };
  }

  function start(): void {
    if (healthCheckInterval) return;

    healthCheckInterval = setInterval(async () => {
      if (!lifecycle.isRunning() || lifecycle.isStopping()) {
        healthCheckInterval = clearIntervalSafe(healthCheckInterval);
        return;
      }

      try {
        await updateCurrentSlot();

        // Re-check after async
        if (lifecycle.isStopping()) return;

        const health = await getHealth();

        // Re-check after async
        if (lifecycle.isStopping()) return;

        perfLogger.logHealthCheck('solana-detector', health as unknown as Record<string, unknown>);

        // Update Redis
        const redis = deps.redis;
        if (redis?.updateServiceHealth) {
          await redis.updateServiceHealth('solana-detector', {
            name: 'solana-detector',
            status: health.status,
            uptime: health.uptime,
            memoryUsage: health.memoryUsage,
            cpuUsage: 0,
            lastHeartbeat: health.lastHeartbeat,
            latency: health.connections.avgLatencyMs
          });
        }

      } catch (error) {
        if (!lifecycle.isStopping()) {
          logger.error('Health monitoring failed', { error });
        }
      }
    }, config.healthCheckIntervalMs);
  }

  function stop(): void {
    healthCheckInterval = clearIntervalSafe(healthCheckInterval);
  }

  function cleanup(): void {
    stop();
    recentLatencies.clear();
  }

  return {
    getHealth,
    getAvgLatency,
    start,
    stop,
    cleanup,
  };
}
