// Execution Engine Service Entry Point
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { ExecutionEngineService, SimulationConfig } from './engine';
import { createLogger } from '@arbitrage/core';

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
 * Create and start HTTP health check server for the Execution Engine.
 */
function createHealthServer(engine: ExecutionEngineService): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' || req.url === '/healthz') {
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
        totalExecuted: stats.opportunitiesExecuted,
        successRate: stats.opportunitiesExecuted > 0
          ? (stats.successfulExecutions / stats.opportunitiesExecuted * 100).toFixed(2) + '%'
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
        endpoints: ['/health', '/healthz', '/ready', '/stats']
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

    logger.info('Starting Execution Engine Service', {
      simulationMode: simulationConfig?.enabled ?? false,
      healthCheckPort: HEALTH_CHECK_PORT
    });

    const engine = new ExecutionEngineService({
      simulationConfig
    });

    // Start health server first
    healthServer = createHealthServer(engine);

    await engine.start();

    const shutdown = async () => {
      logger.info('Shutting down gracefully');
      if (healthServer) {
        healthServer.close();
      }
      await engine.stop();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.info('Execution Engine Service is running');

  } catch (error) {
    logger.error('Failed to start Execution Engine Service', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error in Execution Engine Service:', error);
  process.exit(1);
});