/**
 * HealthReporter - Health Monitoring and Reporting
 *
 * ARCH-REFACTOR: Extracted from UnifiedChainDetector to provide a single
 * responsibility module for health monitoring and publishing.
 *
 * Responsibilities:
 * - Cross-region health manager initialization
 * - Periodic health check intervals
 * - Publishing health data to Redis Streams
 * - Failover event handling
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - EventEmitter for failover event propagation
 * - State-aware publishing (skips when service stopping)
 */

import { EventEmitter } from 'events';
import {
  RedisStreamsClient,
  CrossRegionHealthManager,
  getCrossRegionHealthManager as defaultGetCrossRegionHealthManager,
  ServiceStateManager,
  FailoverEvent,
} from '@arbitrage/core';

import { PartitionConfig, PartitionHealth } from '@arbitrage/config';

import { Logger } from './types';

// =============================================================================
// Types
// =============================================================================

/** Function to get current health data */
export type GetHealthDataFn = () => Promise<PartitionHealth>;

/** Factory type for cross-region health manager */
export type GetCrossRegionHealthManagerFn = (config: {
  instanceId: string;
  regionId: string;
  serviceName: string;
  healthCheckIntervalMs: number;
  failoverTimeoutMs: number;
  canBecomeLeader: boolean;
  isStandby: boolean;
}) => CrossRegionHealthManager;

/** Configuration for HealthReporter */
export interface HealthReporterConfig {
  /** Partition ID */
  partitionId: string;

  /** Instance ID for this detector */
  instanceId: string;

  /** Region ID for cross-region health */
  regionId: string;

  /** Redis Streams client for publishing */
  streamsClient: RedisStreamsClient;

  /** State manager to check running state */
  stateManager: ServiceStateManager;

  /** Logger for output */
  logger: Logger;

  /** Function to get current health data */
  getHealthData: GetHealthDataFn;

  /** Whether to enable cross-region health manager */
  enableCrossRegionHealth?: boolean;

  /** Partition config (optional, for intervals) */
  partition?: PartitionConfig;

  /** Health check interval in ms */
  healthCheckIntervalMs?: number;

  /** Failover timeout in ms */
  failoverTimeoutMs?: number;

  /** Factory for cross-region health manager (for testing) */
  getCrossRegionHealthManager?: GetCrossRegionHealthManagerFn;
}

/** Public interface for HealthReporter */
export interface HealthReporter extends EventEmitter {
  /** Start health reporting */
  start(): Promise<void>;

  /** Stop health reporting */
  stop(): Promise<void>;

  /** Get cross-region health manager (if enabled) */
  getCrossRegionHealth(): CrossRegionHealthManager | null;
}

// =============================================================================
// Constants
// =============================================================================

/** Default health check interval */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30000;

/** Default failover timeout */
const DEFAULT_FAILOVER_TIMEOUT_MS = 60000;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a HealthReporter instance.
 *
 * @param config - Reporter configuration
 * @returns HealthReporter instance
 */
export function createHealthReporter(config: HealthReporterConfig): HealthReporter {
  const {
    partitionId,
    instanceId,
    regionId,
    streamsClient,
    stateManager,
    logger,
    getHealthData,
    enableCrossRegionHealth = false,
    partition,
    healthCheckIntervalMs = partition?.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    failoverTimeoutMs = partition?.failoverTimeoutMs ?? DEFAULT_FAILOVER_TIMEOUT_MS,
    getCrossRegionHealthManager = defaultGetCrossRegionHealthManager,
  } = config;

  const emitter = new EventEmitter() as HealthReporter;
  let crossRegionHealth: CrossRegionHealthManager | null = null;
  let healthCheckInterval: NodeJS.Timeout | null = null;
  let isCheckingHealth = false; // FIX B2: Concurrency guard

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Initialize cross-region health manager.
   */
  async function initializeCrossRegionHealth(): Promise<void> {
    crossRegionHealth = getCrossRegionHealthManager({
      instanceId,
      regionId,
      serviceName: `unified-detector-${partitionId}`,
      healthCheckIntervalMs,
      failoverTimeoutMs,
      canBecomeLeader: false, // Detectors don't lead, coordinator does
      isStandby: false,
    });

    await crossRegionHealth.start();

    // Listen for failover events and forward them
    crossRegionHealth.on('failoverEvent', (event: FailoverEvent) => {
      logger.info('Received failover event', event);
      emitter.emit('failoverEvent', event);
    });
  }

  /**
   * Publish health data to Redis Streams.
   */
  async function publishHealth(health: PartitionHealth): Promise<void> {
    // Check state at publish time
    if (!stateManager.isRunning()) {
      return;
    }

    const serviceName = `unified-detector-${partitionId}`;

    try {
      await streamsClient.xadd(RedisStreamsClient.STREAMS.HEALTH, {
        // Use both 'name' (preferred) and 'service' (legacy) for compatibility
        name: serviceName,
        service: serviceName,
        ...health,
        // Convert Map to object for serialization
        chainHealth: Object.fromEntries(health.chainHealth),
      });
    } catch (error) {
      logger.error('Failed to publish health', { error: (error as Error).message });
    }
  }

  /**
   * Start the health monitoring interval.
   */
  function startHealthMonitoring(): void {
    healthCheckInterval = setInterval(async () => {
      // FIX B2: Skip if already checking health (prevents concurrent executions)
      // or if service is stopping
      if (isCheckingHealth || !stateManager.isRunning()) {
        return;
      }

      isCheckingHealth = true;
      try {
        const health = await getHealthData();
        await publishHealth(health);
      } catch (error) {
        logger.error('Health monitoring error', { error: (error as Error).message });
      } finally {
        isCheckingHealth = false;
      }
    }, healthCheckIntervalMs);

    // Initial health report (fire-and-forget with proper error handling)
    getHealthData()
      .then((health) => {
        if (stateManager.isRunning()) {
          return publishHealth(health);
        }
      })
      .catch((error) =>
        logger.error('Initial health report failed', { error: (error as Error).message })
      );
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Start health reporting.
   */
  async function start(): Promise<void> {
    logger.info('Starting HealthReporter', {
      partitionId,
      enableCrossRegionHealth,
      healthCheckIntervalMs,
    });

    // Initialize cross-region health if enabled
    if (enableCrossRegionHealth) {
      await initializeCrossRegionHealth();
    }

    // Start health monitoring
    startHealthMonitoring();

    logger.info('HealthReporter started');
  }

  /**
   * Stop health reporting.
   */
  async function stop(): Promise<void> {
    logger.info('Stopping HealthReporter');

    // Clear health check interval
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    // Reset concurrency guard
    isCheckingHealth = false;

    // Stop cross-region health
    if (crossRegionHealth) {
      crossRegionHealth.removeAllListeners();
      await crossRegionHealth.stop();
      crossRegionHealth = null;
    }

    logger.info('HealthReporter stopped');
  }

  /**
   * Get cross-region health manager (if enabled).
   */
  function getCrossRegionHealthInstance(): CrossRegionHealthManager | null {
    return crossRegionHealth;
  }

  // ===========================================================================
  // Attach Methods to Emitter
  // ===========================================================================

  emitter.start = start;
  emitter.stop = stop;
  emitter.getCrossRegionHealth = getCrossRegionHealthInstance;

  return emitter;
}
