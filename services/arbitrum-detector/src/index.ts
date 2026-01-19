// Arbitrum Detector Service Entry Point
import { ArbitrumDetectorService } from './detector';
import { createLogger } from '../../../shared/core/src';

const logger = createLogger('arbitrum-detector');

async function main() {
  try {
    logger.info('Starting Arbitrum Detector Service (Ultra-Fast Mode)');

    const detector = new ArbitrumDetectorService();
    await detector.start();

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      await detector.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully');
      await detector.stop();
      process.exit(0);
    });

    logger.info('Arbitrum Detector Service is running (250ms block time optimized)');

  } catch (error) {
    logger.error('Failed to start Arbitrum Detector Service', { error });
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  console.error('Unhandled error in Arbitrum Detector Service:', error);
  process.exit(1);
});