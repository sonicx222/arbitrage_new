// Ethereum Detector Service Entry Point
import { EthereumDetectorService } from './detector';
import { createLogger } from '../../../shared/core/src';

const logger = createLogger('ethereum-detector');

async function main() {
  try {
    logger.info('Starting Ethereum Detector Service');

    const detector = new EthereumDetectorService();
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

    logger.info('Ethereum Detector Service is running');

  } catch (error) {
    logger.error('Failed to start Ethereum Detector Service', { error });
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  console.error('Unhandled error in Ethereum Detector Service:', error);
  process.exit(1);
});