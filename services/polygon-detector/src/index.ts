// Polygon Detector Service Entry Point
import { PolygonDetectorService } from './detector';
import { createLogger } from '../../../shared/core/src';

const logger = createLogger('polygon-detector');

async function main() {
  try {
    logger.info('Starting Polygon Detector Service');

    const detector = new PolygonDetectorService();
    await detector.start();

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

    logger.info('Polygon Detector Service is running');

  } catch (error) {
    logger.error('Failed to start Polygon Detector Service', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error in Polygon Detector Service:', error);
  process.exit(1);
});