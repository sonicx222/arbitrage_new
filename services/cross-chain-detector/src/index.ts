// Cross-Chain Detector Service Entry Point
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { CrossChainDetectorService } from './detector';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('cross-chain-detector');

// Health check port (default: 3006)
// NOTE: Changed from 3004 to 3006 to avoid conflict with partition-solana (which uses 3004)
// Port assignments: coordinator=3000, asia-fast=3001, l2-turbo=3002, high-value=3003, solana=3004, execution-engine=3005, cross-chain-detector=3006
const HEALTH_CHECK_PORT = parseInt(process.env.HEALTH_CHECK_PORT || process.env.CROSS_CHAIN_DETECTOR_PORT || '3006', 10);

let healthServer: Server | null = null;

/**
 * Create and start HTTP health check server for the Cross-Chain Detector.
 */
function createHealthServer(detector: CrossChainDetectorService): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
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
        endpoints: ['/health', '/ready']
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

    // FIX B5: Guard against double shutdown when user presses Ctrl+C multiple times
    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        logger.debug(`Already shutting down, ignoring ${signal}`);
        return;
      }
      isShuttingDown = true;

      logger.info(`Received ${signal}, shutting down gracefully`);

      try {
        // FIX B4: Properly await health server close
        if (healthServer) {
          await new Promise<void>((resolve) => {
            healthServer!.close(() => resolve());
          });
        }
        await detector.stop();
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : String(error)
        });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // FIX B4: Add unhandledRejection handler for better error visibility
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection in Cross-Chain Detector', { reason, promise });
    });

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

// Shared types (TYPE-CONSOLIDATION)
// FIX 2.2: Export all types from types.ts including previously missing ones
export {
  ModuleLogger,
  Logger,
  PriceData,
  CrossChainOpportunity,
  IndexedSnapshot,
  PricePoint,
  DetectorConfig,
  WhaleAnalysisConfig,
  MLPredictionConfig,
  // Token pair format utilities (INC-2 FIX: Standardized format handling)
  TOKEN_PAIR_INTERNAL_SEPARATOR,
  TOKEN_PAIR_DISPLAY_SEPARATOR,
  toDisplayTokenPair,
  toInternalTokenPair,
  normalizeToInternalFormat,
  // Phase 3: Pre-validation types
  PreValidationConfig,
  PreValidationSimulationCallback,
  PreValidationSimulationRequest,
  PreValidationSimulationResult,
} from './types';

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
} from './price-data-manager';

// Opportunity publishing module
export {
  createOpportunityPublisher,
  OpportunityPublisher,
  OpportunityPublisherConfig,
} from './opportunity-publisher';

// Bridge latency predictor
export { BridgeLatencyPredictor, BridgePrediction, BridgeMetrics } from './bridge-predictor';

// Bridge cost estimator module (ADR-014)
export {
  createBridgeCostEstimator,
  BridgeCostEstimator,
  BridgeCostEstimatorConfig,
  BridgeCostEstimate,
} from './bridge-cost-estimator';

// ML prediction manager module (ADR-014)
export {
  createMLPredictionManager,
  MLPredictionManager,
  MLPredictionManagerConfig,
} from './ml-prediction-manager';

// P2-2: Confidence calculator module
export {
  createConfidenceCalculator,
  ConfidenceCalculator,
  type ConfidenceCalculatorConfig,
  type ConfidenceCalculatorLogger,
  type WhaleActivitySummary,
  type MLPredictionPair,
  type PriceData as ConfidencePriceData,
  type MLConfidenceConfig,
  type WhaleConfidenceConfig,
  DEFAULT_CONFIDENCE_CONFIG,
} from './confidence-calculator';