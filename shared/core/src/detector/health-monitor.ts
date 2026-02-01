/**
 * Detector Health Monitor
 *
 * Manages health monitoring for blockchain detectors:
 * - Health status reporting
 * - Periodic health checks with Redis updates
 * - Graceful shutdown handling
 *
 * @see R5 - Base Detector Completion
 * @see MIGRATION_PLAN.md
 */

import type { ServiceLogger } from '../logging';

/**
 * Configuration for health monitoring
 */
export interface HealthMonitorConfig {
  /** Service name for health reporting */
  serviceName: string;
  /** Chain identifier */
  chain: string;
  /** Health check interval in milliseconds (default: 30000) */
  healthCheckInterval?: number;
}

/**
 * Health status from detector.
 * This is a flexible type since different detectors return different shapes.
 */
export interface DetectorHealthStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memoryUsage: number;
  cpuUsage: number;
  lastHeartbeat: number;
  pairs: number;
  websocket: any;
  batcherStats: any;
  chain: string;
  dexCount: number;
  tokenCount: number;
  factorySubscription: any;
}

/**
 * Redis client interface for health monitoring.
 * Minimal interface to avoid import cycles.
 */
export interface HealthMonitorRedis {
  updateServiceHealth(serviceName: string, health: any): Promise<void>;
}

/**
 * Performance logger interface for health monitoring.
 * Minimal interface - only needs logHealthCheck method.
 */
export interface HealthMonitorPerfLogger {
  logHealthCheck(serviceName: string, health: any): void;
}

/**
 * Dependencies for health monitoring
 */
export interface HealthMonitorDeps {
  logger: ServiceLogger;
  perfLogger: HealthMonitorPerfLogger;
  redis: HealthMonitorRedis | null;
  /** Callback to get current health status from detector */
  getHealth: () => Promise<any>;
  /** Callback to check if detector is running */
  isRunning: () => boolean;
  /** Callback to check if detector is stopping */
  isStopping: () => boolean;
}

/**
 * Detector Health Monitor
 *
 * Manages periodic health monitoring and reporting for blockchain detectors.
 */
export class DetectorHealthMonitor {
  private readonly config: Required<HealthMonitorConfig>;
  private readonly deps: HealthMonitorDeps;
  private healthMonitoringInterval: NodeJS.Timeout | null = null;

  constructor(config: HealthMonitorConfig, deps: HealthMonitorDeps) {
    this.config = {
      serviceName: config.serviceName,
      chain: config.chain,
      healthCheckInterval: config.healthCheckInterval ?? 30000,
    };
    this.deps = deps;
  }

  /**
   * Start health monitoring interval.
   * Self-clears interval when stopping to prevent memory leak.
   */
  start(): void {
    if (this.healthMonitoringInterval) {
      return; // Already started
    }

    this.healthMonitoringInterval = setInterval(async () => {
      // Self-clear when stopping to prevent wasted cycles and memory leak
      if (this.deps.isStopping() || !this.deps.isRunning()) {
        this.stop();
        return;
      }

      try {
        const health = await this.deps.getHealth();

        // Re-check shutdown state after async operation
        if (this.deps.isStopping() || !this.deps.isRunning()) {
          return;
        }

        // Update Redis with health status
        const redis = this.deps.redis;
        if (redis) {
          await redis.updateServiceHealth(this.config.serviceName, health);
        }

        // Final check before logging
        if (!this.deps.isStopping()) {
          this.deps.perfLogger.logHealthCheck(this.config.serviceName, health);
        }
      } catch (error) {
        // Only log error if not stopping (errors during shutdown are expected)
        if (!this.deps.isStopping()) {
          this.deps.logger.error('Health monitoring failed', { error });
        }
      }
    }, this.config.healthCheckInterval);

    this.deps.logger.debug('Health monitoring started', {
      service: this.config.serviceName,
      interval: this.config.healthCheckInterval,
    });
  }

  /**
   * Stop health monitoring interval.
   */
  stop(): void {
    if (this.healthMonitoringInterval) {
      clearInterval(this.healthMonitoringInterval);
      this.healthMonitoringInterval = null;
      this.deps.logger.debug('Health monitoring stopped', {
        service: this.config.serviceName,
      });
    }
  }

  /**
   * Check if health monitoring is active.
   */
  isActive(): boolean {
    return this.healthMonitoringInterval !== null;
  }
}

/**
 * Create a detector health monitor instance.
 *
 * @param config - Health monitor configuration
 * @param deps - Dependencies for health monitoring
 * @returns DetectorHealthMonitor instance
 */
export function createDetectorHealthMonitor(
  config: HealthMonitorConfig,
  deps: HealthMonitorDeps
): DetectorHealthMonitor {
  return new DetectorHealthMonitor(config, deps);
}
