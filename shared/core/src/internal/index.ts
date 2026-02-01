/**
 * Internal Exports
 *
 * R8: Public API Surface Reduction
 *
 * This module contains internal implementation details that are NOT part of the
 * public API. These exports are provided for:
 * - Testing (reset functions, mock utilities)
 * - Advanced use cases requiring low-level access
 * - Internal service communication
 *
 * WARNING: These exports may change between minor versions without notice.
 * Use at your own risk. Prefer the public API from '@arbitrage/core'.
 *
 * @module internal
 * @internal
 */

// =============================================================================
// TESTING UTILITIES
// Mock loggers and factories for unit testing without jest.mock()
// =============================================================================

export {
  RecordingLogger,
  RecordingPerformanceLogger,
  NullLogger,
  createMockLoggerFactory,
} from '../logging';

// =============================================================================
// SINGLETON RESET FUNCTIONS
// Used for test cleanup - call in afterEach() to reset global state
// =============================================================================

// Core services
export { resetRedisInstance } from '../redis';
export { resetRedisStreamsInstance } from '../redis-streams';
export { resetServiceRegistry } from '../async/service-registry';
export { resetDistributedLockManager } from '../distributed-lock';

// Caching services
export { resetPriceMatrix } from '../caching/price-matrix';
export { resetPairCacheService } from '../caching/pair-cache';
export { resetCacheCoherencyManager } from '../caching/cache-coherency-manager';
export { resetGasPriceCache } from '../caching/gas-price-cache';

// Analytics services
export { resetPriceOracle } from '../analytics/price-oracle';
export { resetSwapEventFilter } from '../analytics/swap-event-filter';
export { resetWhaleActivityTracker } from '../analytics/whale-activity-tracker';
export { resetLiquidityDepthAnalyzer } from '../analytics/liquidity-depth-analyzer';
export { resetPriceMomentumTracker } from '../analytics/price-momentum';
export { resetMLOpportunityScorer } from '../analytics/ml-opportunity-scorer';
export { resetPairActivityTracker } from '../analytics/pair-activity-tracker';

// Monitoring services
export { resetProviderHealthScorer } from '../monitoring/provider-health-scorer';
export { resetCrossRegionHealthManager } from '../monitoring/cross-region-health';
export { resetStreamHealthMonitor } from '../monitoring/stream-health-monitor';

// Path finding services
export { resetMultiLegPathFinder } from '../multi-leg-path-finder';

// Pair discovery
export { resetPairDiscoveryService } from '../pair-discovery';

// Logging
export { resetLoggerCache, resetPerformanceLoggerCache } from '../logging';

// Event processing
export { resetDefaultEventBatcher } from '../event-batcher';

// DEX adapters
export { resetAdapterRegistry } from '../dex-adapters';

// Solana
export { resetSolanaSwapParser } from '../solana/solana-swap-parser';

// Simulation
export { resetSimulatorInstance, stopChainSimulator, stopAllChainSimulators } from '../simulation-mode';

// Nonce management
export { resetNonceManager } from '../nonce-manager';

// Performance monitoring
export { resetHotPathMonitor } from '../performance-monitor';

// Risk management
export {
  resetExecutionProbabilityTracker,
  resetEVCalculator,
  resetKellyPositionSizer,
  resetDrawdownCircuitBreaker,
} from '../risk';

// =============================================================================
// ABI CONSTANTS
// Contract ABIs for direct interaction - prefer high-level adapters
// =============================================================================

export {
  BALANCER_VAULT_ABI,
  GMX_VAULT_ABI,
  GMX_READER_ABI,
  PLATYPUS_POOL_ABI,
} from '../dex-adapters';

// =============================================================================
// ADDRESS CONSTANTS
// Contract addresses - prefer adapter registry for address resolution
// =============================================================================

export {
  BALANCER_VAULT_ADDRESSES,
  GMX_ADDRESSES,
  PLATYPUS_ADDRESSES,
  SUBGRAPH_URLS,
} from '../dex-adapters';

export {
  STARGATE_CHAIN_IDS,
  STARGATE_POOL_IDS,
  STARGATE_ROUTER_ADDRESSES,
} from '../bridge-router';

// =============================================================================
// SOLANA LAYOUT CONSTANTS
// Binary layouts for Solana account parsing
// =============================================================================

export {
  RAYDIUM_AMM_LAYOUT,
  RAYDIUM_CLMM_LAYOUT,
  ORCA_WHIRLPOOL_LAYOUT,
  SOLANA_DEX_PROGRAMS as SOLANA_PRICE_FEED_PROGRAMS,
} from '../solana/solana-price-feed';

export {
  SOLANA_DEX_PROGRAM_IDS,
  PROGRAM_ID_TO_DEX,
  SWAP_DISCRIMINATORS,
  DISABLED_DEXES,
} from '../solana/solana-swap-parser';

// =============================================================================
// FACTORY EVENT SIGNATURES
// Low-level event signatures for custom event parsing
// =============================================================================

export {
  getFactoryEventSignature,
  parseV2PairCreatedEvent,
  parseV3PoolCreatedEvent,
  parseSolidlyPairCreatedEvent,
  parseAlgebraPoolCreatedEvent,
  parseTraderJoePairCreatedEvent,
  FactoryEventSignatures,
  AdditionalEventSignatures,
} from '../factory-subscription';

// =============================================================================
// RESULT UTILITIES (Internal pattern)
// =============================================================================

export {
  success as adapterSuccess,
  failure as adapterFailure,
} from '../dex-adapters';

// =============================================================================
// LOW-LEVEL SERVICE ACCESS
// Direct singleton getters - prefer DI pattern for new code
// =============================================================================

export { getWorkerPool } from '../async/worker-pool';
export { getDefaultEventBatcher } from '../event-batcher';
export { getHierarchicalCache } from '../caching/hierarchical-cache';
export { getSharedMemoryCache } from '../caching/shared-memory-cache';
export { getCacheCoherencyManager } from '../caching/cache-coherency-manager';
export { getCircuitBreakerRegistry } from '../resilience/circuit-breaker';
export { getGracefulDegradationManager, triggerDegradation, isFeatureEnabled, getCapabilityFallback } from '../resilience/graceful-degradation';
export { getDeadLetterQueue, enqueueFailedOperation } from '../resilience/dead-letter-queue';
export { getSelfHealingManager, registerServiceForSelfHealing } from '../resilience/self-healing-manager';
export { getExpertSelfHealingManager } from '../resilience/expert-self-healing-manager';
export { getErrorRecoveryOrchestrator, recoverFromError, withErrorRecovery } from '../resilience/error-recovery';
export { getEnhancedHealthMonitor, recordHealthMetric, getCurrentSystemHealth } from '../monitoring/enhanced-health-monitor';

// =============================================================================
// DEPRECATION UTILITIES
// For internal migration tooling
// =============================================================================

export {
  createDeprecationWarning,
  isDeprecatedPattern,
  getMigrationRecommendation,
  warnIfDeprecated,
} from '../partition-router';
