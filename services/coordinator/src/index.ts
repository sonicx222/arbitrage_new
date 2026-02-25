/**
 * Coordinator Service Entry Point & Public API
 *
 * This file serves dual purposes:
 * 1. Entry point: Bootstraps and runs the coordinator service
 * 2. Public API: Exports reusable utilities for other services
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

// P2-004 FIX: Export reusable utilities for other services
export { CoordinatorService } from './coordinator';

// Internal imports for bootstrapping
import { CoordinatorService } from './coordinator';
import {
  createLogger,
  getCrossRegionHealthManager,
  resetCrossRegionHealthManager,
  parseEnvInt,
  parseStandbyConfig,
  setupServiceShutdown,
  runServiceMain,
  getErrorMessage,
} from '@arbitrage/core';
import type { CrossRegionHealthConfig } from '@arbitrage/core';

const logger = createLogger('coordinator');

/**
 * Parse standby configuration from environment variables.
 * Returns configuration object for coordinator and cross-region health.
 *
 * Uses shared getCrossRegionEnvConfig for common cross-region fields (S-6).
 * Coordinator-specific fields (leader lock key, standby flags) are parsed here.
 *
 * FIX: Added validation for numeric env vars to catch misconfigurations early.
 */
function getStandbyConfigFromEnv() {
  const base = parseStandbyConfig('coordinator');
  const canBecomeLeader = process.env.CAN_BECOME_LEADER !== 'false'; // Default true
  const instanceRole = process.env.INSTANCE_ROLE || (base.isStandby ? 'standby' : 'primary');
  const leaderLockKey = process.env.LEADER_LOCK_KEY || 'coordinator:leader:lock';

  // Validate heartbeat is less than lock TTL (per ADR-007: should be ~1/3 of TTL)
  if (base.leaderHeartbeatIntervalMs >= base.leaderLockTtlMs) {
    throw new Error(
      `Invalid configuration: LEADER_HEARTBEAT_INTERVAL_MS (${base.leaderHeartbeatIntervalMs}) ` +
      `must be less than LEADER_LOCK_TTL_MS (${base.leaderLockTtlMs})`
    );
  }

  return { ...base, canBecomeLeader, instanceRole, leaderLockKey };
}

async function main() {
  try {
    const standbyConfig = getStandbyConfigFromEnv();
    // P2 FIX #20: Read COORDINATOR_PORT (per .env.example) with PORT fallback
    const portEnvName = process.env.COORDINATOR_PORT ? 'COORDINATOR_PORT' : 'PORT';
    const port = parseEnvInt(portEnvName, 3000, 1, 65535);

    logger.info(`Starting Coordinator Service on port ${port}`);
    logger.debug('Coordinator startup config', {
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

    // P2-4 FIX: Wrap async handler in try-catch to prevent unhandled rejection
    crossRegionManager.on('activateStandby', async (event: { failedRegion: string; timestamp: number }) => {
      try {
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
      } catch (error) {
        logger.error('Error during standby activation', {
          error: getErrorMessage(error),
          failedRegion: event.failedRegion
        });
      }
    });

    // Start coordinator service
    await coordinator.start(port);

    // Graceful shutdown with shared bootstrap utility
    setupServiceShutdown({
      logger,
      serviceName: 'Coordinator',
      onShutdown: async () => {
        // P1-2 FIX: Remove event listeners before destroying manager to prevent memory leak
        crossRegionManager.removeAllListeners();

        // Stop cross-region health manager
        await resetCrossRegionHealthManager();

        // Stop coordinator
        await coordinator.stop();
      },
    });

    logger.info(`Coordinator Service is running on port ${port}`);

  } catch (error) {
    logger.error('Failed to start Coordinator Service', { error });
    process.exit(1);
  }
}

runServiceMain({ main, serviceName: 'Coordinator Service', logger });