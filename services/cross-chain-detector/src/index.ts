// Cross-Chain Detector Service Entry Point

// P3-1 FIX: Set max listeners before imports to prevent MaxListenersExceededWarning.
// Pino transports add process.on('exit') per logger, exceeding the default 10 limit.
process.setMaxListeners(25);

import { IncomingMessage, Server, ServerResponse } from 'http';
import { CrossChainDetectorService } from './detector';
import {
  createSimpleHealthServer,
  setupServiceShutdown,
  closeHealthServer,
  runServiceMain,
} from '@arbitrage/core/service-lifecycle';
import { createLogger } from '@arbitrage/core';
import { safeParseInt } from '@arbitrage/config';
import { getMetricsText } from './prometheus-metrics';

const logger = createLogger('cross-chain-detector');

// Health check port (default: 3006)
// NOTE: Changed from 3004 to 3006 to avoid conflict with partition-solana (which uses 3004)
// Port assignments: coordinator=3000, asia-fast=3001, l2-turbo=3002, high-value=3003, solana=3004, execution-engine=3005, cross-chain-detector=3006
// SA-060 FIX: Use safeParseInt to prevent NaN port causing server bind to random OS port
const HEALTH_CHECK_PORT = safeParseInt(process.env.HEALTH_CHECK_PORT || process.env.CROSS_CHAIN_DETECTOR_PORT, 3006);

// FIX ST-007: Grace period for readiness when no price data is flowing.
// After this many seconds, CC detector becomes "ready" even with 0 chains monitored,
// allowing it to report as degraded instead of blocking startup forever.
const READINESS_GRACE_PERIOD_S = safeParseInt(process.env.CC_READINESS_GRACE_PERIOD_S, 120);

let healthServer: Server | null = null;
let startedAt: number = 0;
let readinessGraceWarningLogged = false;

async function main() {
  try {
    logger.info('Starting Cross-Chain Detector Service', { port: HEALTH_CHECK_PORT });

    const detector = new CrossChainDetectorService();

    // Start health server first
    healthServer = createSimpleHealthServer({
      port: HEALTH_CHECK_PORT,
      serviceName: 'cross-chain-detector',
      logger,
      description: 'Cross-Chain Arbitrage Detector Service',
      // P2 Fix O-10: Health check includes Redis connectivity, chain count, and data freshness
      healthCheck: () => {
        const isRunning = detector.isRunning();
        const details = detector.getHealthDetails();

        // Degraded if running but Redis disconnected or no chains monitored
        const status = !isRunning ? 'unhealthy' :
                      (!details.redisConnected || details.chainsMonitored === 0) ? 'degraded' : 'healthy';

        return {
          status,
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          redisConnected: details.redisConnected,
          chainsMonitored: details.chainsMonitored,
          opportunitiesCache: details.opportunitiesCache,
          mlPredictorActive: details.mlPredictorActive,
          priceUpdatesConsumed: details.priceUpdatesConsumed,
        };
      },
      // ST-007 FIX: Require chainsMonitored > 0 OR grace period elapsed.
      // When partitions produce Sync events, chainsMonitored > 0 quickly.
      // When no events flow (e.g., low market activity), the grace period prevents
      // blocking readiness forever — the service becomes ready as degraded.
      readyCheck: () => {
        if (!detector.isRunning()) return false;
        const details = detector.getHealthDetails();
        if (!details.redisConnected) return false;

        if (details.chainsMonitored > 0) return true;

        // FIX ST-007: After grace period, become ready even with 0 chains
        const uptimeS = process.uptime();
        if (uptimeS >= READINESS_GRACE_PERIOD_S) {
          if (!readinessGraceWarningLogged) {
            readinessGraceWarningLogged = true;
            logger.warn('CC detector ready via grace period — no price data received', {
              uptimeS: Math.round(uptimeS),
              gracePeriodS: READINESS_GRACE_PERIOD_S,
              redisConnected: details.redisConnected,
              chainsMonitored: details.chainsMonitored,
            });
          }
          return true;
        }

        return false;
      },
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
        await detector.stop();
        await closeHealthServer(healthServer);
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