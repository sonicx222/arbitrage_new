/**
 * Detector Module
 *
 * Exports for detector initialization services.
 * Extracted from base-detector.ts for single-responsibility principle.
 *
 * @see ADR-002: Redis Streams Architecture
 * @see MIGRATION_PLAN.md
 * @see R5 - Base Detector Completion
 */

// =============================================================================
// Connection Manager (Phase 1)
// =============================================================================

export {
  initializeDetectorConnections,
  disconnectDetectorConnections,
} from './detector-connection-manager';

// =============================================================================
// Pair Initialization Service (Phase 1.5)
// =============================================================================

export {
  initializePairs,
  resolvePairAddress,
  createTokenPairKey,
  buildFullPairKey,
} from './pair-initialization-service';

// =============================================================================
// Health Monitor (R5)
// =============================================================================

export {
  DetectorHealthMonitor,
  createDetectorHealthMonitor,
} from './health-monitor';

export type {
  HealthMonitorConfig,
  DetectorHealthStatus,
  HealthMonitorDeps,
  HealthMonitorRedis,
  HealthMonitorPerfLogger,
} from './health-monitor';

// =============================================================================
// Factory Integration (R5)
// =============================================================================

export {
  FactoryIntegrationService,
  createFactoryIntegrationService,
} from './factory-integration';

export type {
  FactoryIntegrationConfig,
  FactoryIntegrationHandlers,
  FactoryIntegrationDeps,
  FactoryIntegrationResult,
} from './factory-integration';

// =============================================================================
// Types
// =============================================================================

// Connection manager types
export type {
  DetectorConnectionConfig,
  DetectorConnectionResources,
  EventFilterHandlers,
} from './types';

// Pair initialization types
export type {
  PairInitializationConfig,
  PairInitializationResult,
  DiscoveredPairResult,
  PairAddressResolver,
} from './types';

// Constants
export {
  DEFAULT_BATCHER_CONFIG,
  DEFAULT_SWAP_FILTER_CONFIG,
} from './types';
