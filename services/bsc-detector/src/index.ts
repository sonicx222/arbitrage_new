// BSC Detector Service Entry Point
import { BSCDetectorService } from './detector';
import { createLogger } from '../../../shared/core/src';

const logger = createLogger('bsc-detector');

async function main() {
  try {
    logger.info('Starting BSC Detector Service');

    const detector = new BSCDetectorService();
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

    logger.info('BSC Detector Service is running');

  } catch (error) {
    logger.error('Failed to start BSC Detector Service', { error });
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  logger.error('Unhandled error in BSC Detector Service', { error });
  process.exit(1);
});