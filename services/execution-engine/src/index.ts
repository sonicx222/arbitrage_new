// Execution Engine Service Entry Point
import { ExecutionEngineService, SimulationConfig } from './engine';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('execution-engine');

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

async function main() {
  try {
    const simulationConfig = getSimulationConfigFromEnv();

    logger.info('Starting Execution Engine Service', {
      simulationMode: simulationConfig?.enabled ?? false
    });

    const engine = new ExecutionEngineService({
      simulationConfig
    });
    await engine.start();

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      await engine.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully');
      await engine.stop();
      process.exit(0);
    });

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