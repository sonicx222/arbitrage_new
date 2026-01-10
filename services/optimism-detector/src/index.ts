/**
 * Optimism Detector Service Entry Point
 *
 * Main entry point for the Optimism DEX detector service.
 * Monitors Optimism chain DEXes (Uniswap V3, Velodrome, SushiSwap) for arbitrage opportunities.
 *
 * @see IMPLEMENTATION_PLAN.md S2.1.1
 */

import { OptimismDetectorService } from './detector';
import { createLogger } from '../../../shared/core/src';

const logger = createLogger('optimism-detector');

async function main(): Promise<void> {
  logger.info('Starting Optimism Detector Service');

  const detector = new OptimismDetectorService();

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await detector.stop();
      logger.info('Optimism Detector Service stopped successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    shutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason, promise: String(promise) });
  });

  try {
    await detector.start();
    logger.info('Optimism Detector Service is running', {
      chain: 'optimism',
      chainId: 10
    });
  } catch (error) {
    logger.error('Failed to start Optimism Detector Service', { error });
    process.exit(1);
  }
}

// Run the service
main().catch((error) => {
  logger.error('Fatal error in Optimism Detector Service', { error });
  process.exit(1);
});

// Export for programmatic usage
export { OptimismDetectorService } from './detector';
