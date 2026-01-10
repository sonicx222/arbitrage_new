// Base Detector Service Entry Point
import { BaseDetectorService } from './detector';
import { createLogger } from '../../../shared/core/src';

const logger = createLogger('base-detector');

async function main() {
  try {
    logger.info('Starting Base Detector Service (Coinbase Layer 2)');

    const detector = new BaseDetectorService();
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

    logger.info('Base Detector Service is running (Coinbase ecosystem optimized)');

  } catch (error) {
    logger.error('Failed to start Base Detector Service', { error });
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  console.error('Unhandled error in Base Detector Service:', error);
  process.exit(1);
});