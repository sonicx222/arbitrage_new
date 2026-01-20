/**
 * Coordinator Service Entry Point
 *
 * Reads standby configuration from environment variables and initializes
 * the coordinator service with proper failover settings (ADR-007).
 *
 * Environment Variables:
 * - IS_STANDBY: Whether this instance is a standby (default: false)
 * - CAN_BECOME_LEADER: Whether this instance can acquire leadership (default: true)
 * - REGION_ID: Region identifier for this instance (default: 'us-east1')
 * - INSTANCE_ROLE: Role identifier ('primary' | 'standby')
 * - LEADER_LOCK_KEY: Redis key for leader lock (default: 'coordinator:leader:lock')
 * - LEADER_LOCK_TTL_MS: Lock TTL in ms (default: 30000)
 * - LEADER_HEARTBEAT_INTERVAL_MS: Heartbeat interval in ms (default: 10000)
 *
 * @see ADR-007: Cross-Region Failover Strategy
 */
import { CoordinatorService } from './coordinator';
import {
  createLogger,
  getCrossRegionHealthManager,
  resetCrossRegionHealthManager
} from '@arbitrage/core';
import type { CrossRegionHealthConfig } from '@arbitrage/core';

const logger = createLogger('coordinator');

/**
 * Parse standby configuration from environment variables.
 * Returns configuration object for coordinator and cross-region health.
 */
function getStandbyConfigFromEnv() {
  const isStandby = process.env.IS_STANDBY === 'true';
  const canBecomeLeader = process.env.CAN_BECOME_LEADER !== 'false'; // Default true
  const regionId = process.env.REGION_ID || 'us-east1';
  const instanceRole = process.env.INSTANCE_ROLE || (isStandby ? 'standby' : 'primary');
  const serviceName = process.env.SERVICE_NAME || 'coordinator';

  // Leader election settings
  const leaderLockKey = process.env.LEADER_LOCK_KEY || 'coordinator:leader:lock';
  const leaderLockTtlMs = parseInt(process.env.LEADER_LOCK_TTL_MS || '30000', 10);
  const leaderHeartbeatIntervalMs = parseInt(process.env.LEADER_HEARTBEAT_INTERVAL_MS || '10000', 10);

  // Health check settings
  const healthCheckIntervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '10000', 10);
  const failoverThreshold = parseInt(process.env.FAILOVER_THRESHOLD || '3', 10);
  const failoverTimeoutMs = parseInt(process.env.FAILOVER_TIMEOUT_MS || '60000', 10);

  return {
    isStandby,
    canBecomeLeader,
    regionId,
    instanceRole,
    serviceName,
    leaderLockKey,
    leaderLockTtlMs,
    leaderHeartbeatIntervalMs,
    healthCheckIntervalMs,
    failoverThreshold,
    failoverTimeoutMs
  };
}

async function main() {
  try {
    const standbyConfig = getStandbyConfigFromEnv();
    const port = parseInt(process.env.PORT || '3000', 10);

    logger.info('Starting Coordinator Service', {
      isStandby: standbyConfig.isStandby,
      canBecomeLeader: standbyConfig.canBecomeLeader,
      regionId: standbyConfig.regionId,
      instanceRole: standbyConfig.instanceRole,
      port
    });

    // Generate unique instance ID
    const instanceId = `coordinator-${standbyConfig.regionId}-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    // Initialize CrossRegionHealthManager for cross-region failover (ADR-007)
    const crossRegionConfig: CrossRegionHealthConfig = {
      instanceId,
      regionId: standbyConfig.regionId,
      serviceName: standbyConfig.serviceName,
      healthCheckIntervalMs: standbyConfig.healthCheckIntervalMs,
      failoverThreshold: standbyConfig.failoverThreshold,
      failoverTimeoutMs: standbyConfig.failoverTimeoutMs,
      leaderHeartbeatIntervalMs: standbyConfig.leaderHeartbeatIntervalMs,
      leaderLockTtlMs: standbyConfig.leaderLockTtlMs,
      canBecomeLeader: standbyConfig.canBecomeLeader,
      isStandby: standbyConfig.isStandby
    };

    // Initialize cross-region health manager (singleton)
    const crossRegionManager = getCrossRegionHealthManager(crossRegionConfig);

    // Create coordinator with standby-aware config
    const coordinator = new CoordinatorService({
      port,
      leaderElection: {
        lockKey: standbyConfig.leaderLockKey,
        lockTtlMs: standbyConfig.leaderLockTtlMs,
        heartbeatIntervalMs: standbyConfig.leaderHeartbeatIntervalMs,
        instanceId
      },
      // Pass standby config to coordinator
      isStandby: standbyConfig.isStandby,
      canBecomeLeader: standbyConfig.canBecomeLeader,
      regionId: standbyConfig.regionId
    });

    // Start cross-region health manager
    await crossRegionManager.start();

    // Wire up failover events
    crossRegionManager.on('leaderChange', (event) => {
      logger.info('Leader change event received', {
        type: event.type,
        targetRegion: event.targetRegion,
        sourceRegion: event.sourceRegion
      });
    });

    crossRegionManager.on('failoverStarted', (event) => {
      logger.warn('Failover started', {
        sourceRegion: event.sourceRegion,
        targetRegion: event.targetRegion,
        services: event.services
      });
    });

    crossRegionManager.on('failoverCompleted', (event) => {
      logger.info('Failover completed', {
        sourceRegion: event.sourceRegion,
        targetRegion: event.targetRegion,
        durationMs: event.durationMs
      });
    });

    crossRegionManager.on('activateStandby', async (event: { failedRegion: string; timestamp: number }) => {
      logger.warn('Standby activation triggered - becoming active', {
        failedRegion: event.failedRegion
      });
      // Activate the coordinator to become leader
      const activated = await coordinator.activateStandby();
      if (activated) {
        logger.info('Coordinator successfully activated as leader');
      } else {
        logger.error('Failed to activate coordinator as leader');
      }
    });

    // Start coordinator service
    await coordinator.start(port);

    // Graceful shutdown handler
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);

      // Stop cross-region health manager
      await resetCrossRegionHealthManager();

      // Stop coordinator
      await coordinator.stop();

      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('Coordinator Service is running', {
      port,
      isStandby: standbyConfig.isStandby,
      canBecomeLeader: standbyConfig.canBecomeLeader,
      regionId: standbyConfig.regionId,
      instanceId
    });

  } catch (error) {
    logger.error('Failed to start Coordinator Service', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error in Coordinator Service:', error);
  process.exit(1);
});