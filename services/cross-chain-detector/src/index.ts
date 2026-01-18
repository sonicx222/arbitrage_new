// Cross-Chain Detector Service Entry Point
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { CrossChainDetectorService } from './detector';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('cross-chain-detector');

// Health check port (default: 3004)
const HEALTH_CHECK_PORT = parseInt(process.env.HEALTH_CHECK_PORT || process.env.CROSS_CHAIN_DETECTOR_PORT || '3004', 10);

let healthServer: Server | null = null;

/**
 * Create and start HTTP health check server for the Cross-Chain Detector.
 */
function createHealthServer(detector: CrossChainDetectorService): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health' || req.url === '/healthz') {
      const isRunning = detector.isRunning();
      const statusCode = isRunning ? 200 : 503;
      const status = isRunning ? 'healthy' : 'unhealthy';

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'cross-chain-detector',
        status,
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        timestamp: Date.now()
      }));
    } else if (req.url === '/ready') {
      const ready = detector.isRunning();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'cross-chain-detector',
        ready
      }));
    } else if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'cross-chain-detector',
        description: 'Cross-Chain Arbitrage Detector Service',
        endpoints: ['/health', '/healthz', '/ready']
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
    logger.info('Starting Cross-Chain Detector Service', {
      healthCheckPort: HEALTH_CHECK_PORT
    });

    const detector = new CrossChainDetectorService();

    // Start health server first
    healthServer = createHealthServer(detector);

    await detector.start();

    const shutdown = async () => {
      logger.info('Shutting down gracefully');
      if (healthServer) {
        healthServer.close();
      }
      await detector.stop();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.info('Cross-Chain Detector Service is running');

  } catch (error) {
    logger.error('Failed to start Cross-Chain Detector Service', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error in Cross-Chain Detector Service:', error);
  process.exit(1);
});

// =============================================================================
// Module Exports (ADR-014: Modular Detector Components)
// =============================================================================

export { CrossChainDetectorService } from './detector';

// Stream consumption module
export {
  createStreamConsumer,
  StreamConsumer,
  StreamConsumerConfig,
  StreamConsumerEvents,
} from './stream-consumer';

// Price data management module
export {
  createPriceDataManager,
  PriceDataManager,
  PriceDataManagerConfig,
  PriceData,
} from './price-data-manager';

// Opportunity publishing module
export {
  createOpportunityPublisher,
  OpportunityPublisher,
  OpportunityPublisherConfig,
  CrossChainOpportunity,
} from './opportunity-publisher';