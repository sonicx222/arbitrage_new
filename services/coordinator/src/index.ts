// Coordinator Service Entry Point
import { CoordinatorService } from './coordinator';
import { createLogger } from '../../../shared/core/src';

const logger = createLogger('coordinator');

async function main() {
  try {
    logger.info('Starting Coordinator Service');

    const coordinator = new CoordinatorService();
    const port = parseInt(process.env.PORT || '3000');
    await coordinator.start(port);

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      await coordinator.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully');
      await coordinator.stop();
      process.exit(0);
    });

    logger.info(`Coordinator Service is running on port ${port}`);

  } catch (error) {
    logger.error('Failed to start Coordinator Service', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error in Coordinator Service:', error);
  process.exit(1);
});