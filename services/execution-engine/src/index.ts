/**
 * Execution Engine Service Entry Point
 *
 * Reads standby configuration from environment variables and initializes
 * the execution engine with proper failover settings (ADR-007).
 *
 * Environment Variables:
 * - IS_STANDBY: Whether this instance is a standby (default: false)
 * - QUEUE_PAUSED_ON_START: Whether queue starts paused (default: false)
 * - REGION_ID: Region identifier for this instance (default: 'us-east1')
 * - EXECUTION_SIMULATION_MODE: Whether simulation mode is enabled
 *
 * @see ADR-007: Cross-Region Failover Strategy
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { ExecutionEngineService, SimulationConfig } from './engine';
import {
  createLogger,
  getCrossRegionHealthManager,
  resetCrossRegionHealthManager
} from '@arbitrage/core';
import type { CrossRegionHealthConfig } from '@arbitrage/core';

const logger = createLogger('execution-engine');

// Health check port (default: 3005)
const HEALTH_CHECK_PORT = parseInt(process.env.HEALTH_CHECK_PORT || process.env.EXECUTION_ENGINE_PORT || '3005', 10);

let healthServer: Server | null = null;

/**
 * Parse simulation configuration from environment variables.
 * Returns undefined if simulation is not enabled.
 */
function getSimulationConfigFromEnv(): SimulationConfig | undefined {
  const enabled = process.env.EXECUTION_SIMULATION_MODE === 'true';

  if (!enabled) {
    return undefined;
  }

  return {
    enabled: true,
    successRate: parseFloat(process.env.EXECUTION_SIMULATION_SUCCESS_RATE || '0.85'),
    executionLatencyMs: parseInt(process.env.EXECUTION_SIMULATION_LATENCY_MS || '500', 10),
    gasUsed: parseInt(process.env.EXECUTION_SIMULATION_GAS_USED || '200000', 10),
    gasCostMultiplier: parseFloat(process.env.EXECUTION_SIMULATION_GAS_COST_MULTIPLIER || '0.1'),
    profitVariance: parseFloat(process.env.EXECUTION_SIMULATION_PROFIT_VARIANCE || '0.2'),
    logSimulatedExecutions: process.env.EXECUTION_SIMULATION_LOG !== 'false'
  };
}

/**
 * Parse standby configuration from environment variables (ADR-007).
 */
function getStandbyConfigFromEnv() {
  const isStandby = process.env.IS_STANDBY === 'true';
  const queuePausedOnStart = process.env.QUEUE_PAUSED_ON_START === 'true';
  const regionId = process.env.REGION_ID || 'us-east1';
  const serviceName = process.env.SERVICE_NAME || 'execution-engine';

  // Health check settings for cross-region monitoring
  const healthCheckIntervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '10000', 10);
  const failoverThreshold = parseInt(process.env.FAILOVER_THRESHOLD || '3', 10);
  const failoverTimeoutMs = parseInt(process.env.FAILOVER_TIMEOUT_MS || '60000', 10);
  const leaderHeartbeatIntervalMs = parseInt(process.env.LEADER_HEARTBEAT_INTERVAL_MS || '10000', 10);
  const leaderLockTtlMs = parseInt(process.env.LEADER_LOCK_TTL_MS || '30000', 10);

  return {
    isStandby,
    queuePausedOnStart,
    regionId,
    serviceName,
    healthCheckIntervalMs,
    failoverThreshold,
    failoverTimeoutMs,
    leaderHeartbeatIntervalMs,
    leaderLockTtlMs
  };
}

/**
 * Create and start HTTP health check server for the Execution Engine.
 */
function createHealthServer(engine: ExecutionEngineService): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      const isRunning = engine.isRunning();
      const stats = engine.getStats();
      const healthyProviders = engine.getHealthyProvidersCount();
      const isSimulation = engine.getIsSimulationMode();

      // Degraded if no healthy providers (unless in simulation mode)
      const status = !isRunning ? 'unhealthy' :
                    (healthyProviders === 0 && !isSimulation) ? 'degraded' : 'healthy';
      const statusCode = status === 'unhealthy' ? 503 : 200;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'execution-engine',
        status,
        simulationMode: isSimulation,
        healthyProviders,
        queueSize: engine.getQueueSize(),
        activeExecutions: engine.getActiveExecutionsCount(),
        executionAttempts: stats.executionAttempts,
        successRate: stats.executionAttempts > 0
          ? (stats.successfulExecutions / stats.executionAttempts * 100).toFixed(2) + '%'
          : 'N/A',
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        timestamp: Date.now()
      }));
    } else if (req.url === '/ready') {
      const ready = engine.isRunning();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'execution-engine',
        ready,
        simulationMode: engine.getIsSimulationMode()
      }));
    } else if (req.url === '/stats') {
      const stats = engine.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'execution-engine',
        stats
      }));
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'execution-engine',
        description: 'Arbitrage Execution Engine Service',
        simulationMode: engine.getIsSimulationMode(),
        endpoints: ['/health', '/ready', '/stats']
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(HEALTH_CHECK_PORT, () => {
    logger.info(`Health server listening on port ${HEALTH_CHECK_PORT}`);
  });

  return server;
}

async function main() {
  try {
    const simulationConfig = getSimulationConfigFromEnv();
    const standbyConfig = getStandbyConfigFromEnv();

    logger.info('Starting Execution Engine Service', {
      simulationMode: simulationConfig?.enabled ?? false,
      isStandby: standbyConfig.isStandby,
      queuePausedOnStart: standbyConfig.queuePausedOnStart,
      regionId: standbyConfig.regionId,
      healthCheckPort: HEALTH_CHECK_PORT
    });

    // Generate unique instance ID
    const instanceId = `execution-engine-${standbyConfig.regionId}-${process.env.HOSTNAME || 'local'}-${Date.now()}`;

    const engine = new ExecutionEngineService({
      simulationConfig,
      standbyConfig: {
        isStandby: standbyConfig.isStandby,
        queuePausedOnStart: standbyConfig.queuePausedOnStart,
        activationDisablesSimulation: true, // Default behavior for standby activation
        regionId: standbyConfig.regionId
      }
    });

    // Initialize CrossRegionHealthManager for cross-region failover (ADR-007)
    // NOTE: Executor only initializes CrossRegionHealthManager when running as standby,
    // unlike Coordinator which always initializes it (coordinator participates in leader
    // election regardless of standby status). This design choice avoids unnecessary
    // overhead for primary executors while ensuring coordinators can always failover.
    let crossRegionManager: ReturnType<typeof getCrossRegionHealthManager> | null = null;
    if (standbyConfig.isStandby) {
      const crossRegionConfig: CrossRegionHealthConfig = {
        instanceId,
        regionId: standbyConfig.regionId,
        serviceName: standbyConfig.serviceName,
        healthCheckIntervalMs: standbyConfig.healthCheckIntervalMs,
        failoverThreshold: standbyConfig.failoverThreshold,
        failoverTimeoutMs: standbyConfig.failoverTimeoutMs,
        leaderHeartbeatIntervalMs: standbyConfig.leaderHeartbeatIntervalMs,
        leaderLockTtlMs: standbyConfig.leaderLockTtlMs,
        canBecomeLeader: true, // Standby executor can become leader on failover
        isStandby: standbyConfig.isStandby
      };

      crossRegionManager = getCrossRegionHealthManager(crossRegionConfig);

      // Wire up failover events
      crossRegionManager.on('activateStandby', async (event: { failedRegion: string; timestamp: number }) => {
        logger.warn('Standby activation triggered by CrossRegionHealthManager', {
          failedRegion: event.failedRegion
        });
        const activated = await engine.activate();
        if (activated) {
          logger.info('Executor successfully activated');
        } else {
          logger.error('Failed to activate executor');
        }
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

      // Start cross-region health manager
      await crossRegionManager.start();
      logger.info('CrossRegionHealthManager started for standby executor');
    }

    // Start health server first
    healthServer = createHealthServer(engine);

    await engine.start();

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);

      // Stop cross-region health manager if running
      if (crossRegionManager) {
        await resetCrossRegionHealthManager();
      }

      if (healthServer) {
        healthServer.close();
      }
      await engine.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('Execution Engine Service is running', {
      isStandby: standbyConfig.isStandby,
      simulationMode: engine.getIsSimulationMode(),
      queuePaused: engine.isQueuePaused(),
      regionId: standbyConfig.regionId,
      instanceId
    });

  } catch (error) {
    logger.error('Failed to start Execution Engine Service', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error in Execution Engine Service:', error);
  process.exit(1);
});