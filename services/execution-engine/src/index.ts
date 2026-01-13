// Execution Engine Service Entry Point
import { ExecutionEngineService } from './engine';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('execution-engine');

async function main() {
  try {
    logger.info('Starting Execution Engine Service');

    const engine = new ExecutionEngineService();
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