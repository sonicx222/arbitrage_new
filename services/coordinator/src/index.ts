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
 * FIX: Helper to parse and validate numeric environment variables.
 * Throws descriptive error if value is invalid or out of range.
 */
function parseEnvInt(
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a valid integer`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${parsed} is out of range [${min}, ${max}]`);
  }
  return parsed;
}

/**
 * Parse standby configuration from environment variables.
 * Returns configuration object for coordinator and cross-region health.
 *
 * FIX: Added validation for numeric env vars to catch misconfigurations early.
 */
function getStandbyConfigFromEnv() {
  const isStandby = process.env.IS_STANDBY === 'true';
  const canBecomeLeader = process.env.CAN_BECOME_LEADER !== 'false'; // Default true
  const regionId = process.env.REGION_ID || 'us-east1';
  const instanceRole = process.env.INSTANCE_ROLE || (isStandby ? 'standby' : 'primary');
  const serviceName = process.env.SERVICE_NAME || 'coordinator';

  // Leader election settings with validation
  const leaderLockKey = process.env.LEADER_LOCK_KEY || 'coordinator:leader:lock';
  const leaderLockTtlMs = parseEnvInt('LEADER_LOCK_TTL_MS', 30000, 5000, 300000);
  const leaderHeartbeatIntervalMs = parseEnvInt('LEADER_HEARTBEAT_INTERVAL_MS', 10000, 1000, 60000);

  // Health check settings with validation
  const healthCheckIntervalMs = parseEnvInt('HEALTH_CHECK_INTERVAL_MS', 10000, 1000, 60000);
  const failoverThreshold = parseEnvInt('FAILOVER_THRESHOLD', 3, 1, 10);
  const failoverTimeoutMs = parseEnvInt('FAILOVER_TIMEOUT_MS', 60000, 10000, 300000);

  // Validate heartbeat is less than lock TTL (per ADR-007: should be ~1/3 of TTL)
  if (leaderHeartbeatIntervalMs >= leaderLockTtlMs) {
    throw new Error(
      `Invalid configuration: LEADER_HEARTBEAT_INTERVAL_MS (${leaderHeartbeatIntervalMs}) ` +
      `must be less than LEADER_LOCK_TTL_MS (${leaderLockTtlMs})`
    );
  }

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
    // FIX: Validate PORT env var
    const port = parseEnvInt('PORT', 3000, 1, 65535);

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

    // FIX: Add explicit types for event handlers to satisfy strict TypeScript
    interface LeaderChangeEvent {
      type: string;
      targetRegion: string;
      sourceRegion: string;
    }

    interface FailoverEvent {
      sourceRegion: string;
      targetRegion: string;
      services?: string[];
      durationMs?: number;
    }

    // Wire up failover events
    crossRegionManager.on('leaderChange', (event: LeaderChangeEvent) => {
      logger.info('Leader change event received', {
        type: event.type,
        targetRegion: event.targetRegion,
        sourceRegion: event.sourceRegion
      });
    });

    crossRegionManager.on('failoverStarted', (event: FailoverEvent) => {
      logger.warn('Failover started', {
        sourceRegion: event.sourceRegion,
        targetRegion: event.targetRegion,
        services: event.services
      });
    });

    crossRegionManager.on('failoverCompleted', (event: FailoverEvent) => {
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