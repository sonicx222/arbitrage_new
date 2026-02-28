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
import { CrossRegionHealthManager, getCrossRegionHealthManager as defaultGetCrossRegionHealthManager, FailoverEvent } from '@arbitrage/core/monitoring';
import { RedisStreamsClient } from '@arbitrage/core/redis';
import { ServiceStateManager } from '@arbitrage/core/service-lifecycle';

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
      logger.info('Received failover event', { ...event });
      emitter.emit('failoverEvent', event);
    });
  }

  /**
   * Publish health data to Redis Streams.
   */
  async function publishHealth(health: PartitionHealth): Promise<void> {
    // Check state at publish time
    if (!stateManager.isRunning()) {
      logger.debug('Skipping health publish - service not running');
      return;
    }

    const serviceName = `unified-detector-${partitionId}`;

    try {
      // ADR-002: Use xaddWithLimit to prevent unbounded stream growth
      // MAXLEN: 1,000 (configured in STREAM_MAX_LENGTHS)
      await streamsClient.xaddWithLimit(RedisStreamsClient.STREAMS.HEALTH, {
        // FIX 6.3: Health field naming standardization
        // 'name' is the standard field per ServiceHealth interface
        // FIX 8.1: Removed deprecated 'service' field - coordinator now uses 'name' only
        name: serviceName,
        ...health,
        // Convert Map to object for serialization
        chainHealth: Object.fromEntries(health.chainHealth),
      });

      // FIX #6: Log successful health publishes at INFO level for visibility.
      // Previously, successful publishes were silent, making it impossible to
      // distinguish "publishing but not logged" from "not publishing at all".
      logger.info('Health check completed', {
        status: health.status,
        memoryUsage: health.memoryUsage,
        cpuUsage: health.cpuUsage,
        uptime: health.uptimeSeconds,
      });
    } catch (error) {
      logger.error('Failed to publish health', { error: (error as Error).message });
    }
  }

  /**
   * Start the health monitoring interval.
   * FIX Race 5.3: Improved concurrency guard with proper error handling
   * BUG-FIX: Added guard against duplicate interval creation on restart
   */
  function startHealthMonitoring(): void {
    // BUG-FIX: Clear any existing interval to prevent memory leak on restart
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    healthCheckInterval = setInterval(() => {
      // FIX B2: Skip if already checking health (prevents concurrent executions)
      // or if service is stopping
      if (isCheckingHealth || !stateManager.isRunning()) {
        return;
      }

      isCheckingHealth = true;

      // FIX Race 5.3: Wrap in async IIFE to properly catch all errors
      (async () => {
        try {
          const health = await getHealthData();
          await publishHealth(health);
        } catch (error) {
          logger.error('Health monitoring error', { error: (error as Error).message });
        } finally {
          // Always reset the guard, even on error
          isCheckingHealth = false;
        }
      })();
    }, healthCheckIntervalMs);

    // Initial health report (fire-and-forget with proper error handling)
    // FIX Race 5.3: Guard initialization moved inside the async operation
    // to prevent the flag being stuck if getHealthData throws synchronously
    (async () => {
      // Set guard at the start of async operation
      if (isCheckingHealth) {
        return; // Another check is already in progress
      }
      isCheckingHealth = true;

      try {
        const health = await getHealthData();
        if (stateManager.isRunning()) {
          await publishHealth(health);
        }
      } catch (error) {
        logger.error('Initial health report failed', { error: (error as Error).message });
      } finally {
        // CRITICAL: Always reset guard in finally to ensure it's always cleared
        isCheckingHealth = false;
      }
    })();
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
