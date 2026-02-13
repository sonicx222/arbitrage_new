/**
 * Cross-Chain Detector Test Helpers
 *
 * Consolidated mock factories and test data builders for all
 * cross-chain-detector test files.
 *
 * @see FIX #30: Shared test helpers
 * @see FIX #16: Typed test mocks
 */

export {
  // Infrastructure mocks
  createMockRedisClient,
  createMockStreamsClient,
  createMockPriceOracle,
  createMockLogger,
  createMockPerfLogger,
  // Domain mocks
  createMockWhaleTracker,
  createMockStateManager,
  // Module mocks (ADR-014)
  createMockStreamConsumer,
  createMockPriceDataManager,
  createMockOpportunityPublisher,
  createMockBridgeCostEstimator,
  createMockMLPredictionManager,
} from './mock-factories';

export {
  createPriceUpdate,
  createPricePoint,
  createWhaleTransaction,
  createPendingSwapIntent,
  createCrossChainOpportunity,
} from './test-data-builders';
