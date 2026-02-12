// Cross-Chain Detector Service Entry Point
import { Server } from 'http';
import { CrossChainDetectorService } from './detector';
import {
  createLogger,
  createSimpleHealthServer,
  setupServiceShutdown,
  closeHealthServer,
  runServiceMain,
} from '@arbitrage/core';

const logger = createLogger('cross-chain-detector');

// Health check port (default: 3006)
// NOTE: Changed from 3004 to 3006 to avoid conflict with partition-solana (which uses 3004)
// Port assignments: coordinator=3000, asia-fast=3001, l2-turbo=3002, high-value=3003, solana=3004, execution-engine=3005, cross-chain-detector=3006
const HEALTH_CHECK_PORT = parseInt(process.env.HEALTH_CHECK_PORT || process.env.CROSS_CHAIN_DETECTOR_PORT || '3006', 10);

let healthServer: Server | null = null;

async function main() {
  try {
    logger.info('Starting Cross-Chain Detector Service', {
      healthCheckPort: HEALTH_CHECK_PORT
    });

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