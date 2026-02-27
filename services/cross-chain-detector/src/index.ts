// Cross-Chain Detector Service Entry Point
import { IncomingMessage, Server, ServerResponse } from 'http';
import { CrossChainDetectorService } from './detector';
import {
  createSimpleHealthServer,
  setupServiceShutdown,
  closeHealthServer,
  runServiceMain,
} from '@arbitrage/core/service-lifecycle';
import { createLogger } from '@arbitrage/core';
import { getMetricsText } from './prometheus-metrics';

const logger = createLogger('cross-chain-detector');

// Health check port (default: 3006)
// NOTE: Changed from 3004 to 3006 to avoid conflict with partition-solana (which uses 3004)
// Port assignments: coordinator=3000, asia-fast=3001, l2-turbo=3002, high-value=3003, solana=3004, execution-engine=3005, cross-chain-detector=3006
const HEALTH_CHECK_PORT = parseInt(process.env.HEALTH_CHECK_PORT || process.env.CROSS_CHAIN_DETECTOR_PORT || '3006', 10);

let healthServer: Server | null = null;

async function main() {
  try {
    logger.info(`Starting Cross-Chain Detector Service on port ${HEALTH_CHECK_PORT}`);

    const detector = new CrossChainDetectorService();

    // Start health server first
    healthServer = createSimpleHealthServer({
      port: HEALTH_CHECK_PORT,
      serviceName: 'cross-chain-detector',
      logger,
      description: 'Cross-Chain Arbitrage Detector Service',
      healthCheck: () => {
        const isRunning = detector.isRunning();
        return {
          status: isRunning ? 'healthy' : 'unhealthy',
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        };
      },
      readyCheck: () => detector.isRunning(),
      additionalRoutes: {
        '/metrics': async (_req: IncomingMessage, res: ServerResponse) => {
          const text = await getMetricsText();
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(text);
        },
      },
    });

    await detector.start();

    setupServiceShutdown({
      logger,
      serviceName: 'Cross-Chain Detector',
      onShutdown: async () => {
        await closeHealthServer(healthServer);
        await detector.stop();
      },
    });

    logger.info('Cross-Chain Detector Service is running');

  } catch (error) {
    logger.error('Failed to start Cross-Chain Detector Service', { error });
    process.exit(1);
  }
}

runServiceMain({ main, serviceName: 'Cross-Chain Detector Service', logger });

// Module exports — separated into exports.ts to prevent auto-execution on import.
// @see exports.ts for the full list of exports
export * from './exports';