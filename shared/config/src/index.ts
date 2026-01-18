/**
 * Shared Configuration for the Arbitrage System
 *
 * This is the main entry point that re-exports all configuration modules.
 * The configuration has been split into organized submodules for maintainability:
 *
 * - chains/: Blockchain configurations (11 chains)
 * - dexes/: DEX configurations (49 DEXes)
 * - tokens/: Token configurations (112 tokens)
 * - thresholds.ts: Performance and arbitrage thresholds
 * - mev-config.ts: MEV protection settings
 * - event-config.ts: Event monitoring settings
 * - detector-config.ts: Chain-specific detector settings
 * - service-config.ts: Service configs, flash loans, bridges
 * - cross-chain.ts: Cross-chain token normalization
 * - system-constants.ts: System-wide constants
 * - partitions.ts: Partition configurations (ADR-003)
 *
 * All exports are maintained for backward compatibility.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-008: Phase metrics and targets
 */

// Validate required environment variables at startup (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  if (!process.env.ETHEREUM_RPC_URL) {
    throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_RPC_URL environment variable is required');
  }
  if (!process.env.ETHEREUM_WS_URL) {
    throw new Error('CRITICAL CONFIG ERROR: ETHEREUM_WS_URL environment variable is required');
  }
}

// =============================================================================
// CHAIN CONFIGURATIONS
// =============================================================================
export { CHAINS } from './chains';

// =============================================================================
// DEX CONFIGURATIONS
// =============================================================================
export { DEXES, getEnabledDexes, dexFeeToPercentage, percentageToBasisPoints } from './dexes';

// =============================================================================
// TOKEN CONFIGURATIONS
// =============================================================================
export { CORE_TOKENS, TOKEN_METADATA } from './tokens';

// =============================================================================
// THRESHOLDS
// =============================================================================
export { PERFORMANCE_THRESHOLDS, ARBITRAGE_CONFIG, getMinProfitThreshold } from './thresholds';

// =============================================================================
// MEV CONFIGURATION
// =============================================================================
export { MEV_CONFIG } from './mev-config';

// =============================================================================
// EVENT CONFIGURATION
// =============================================================================
export { EVENT_CONFIG, EVENT_SIGNATURES } from './event-config';

// =============================================================================
// DETECTOR CONFIGURATION
// =============================================================================
export { DETECTOR_CONFIG, DetectorChainConfig } from './detector-config';

// =============================================================================
// SERVICE CONFIGURATION
// =============================================================================
export {
  SERVICE_CONFIGS,
  FLASH_LOAN_PROVIDERS,
  BRIDGE_COSTS,
  BridgeCostConfig,
  getBridgeCost,
  calculateBridgeCostUsd
} from './service-config';

// =============================================================================
// CROSS-CHAIN NORMALIZATION
// =============================================================================
export {
  CROSS_CHAIN_TOKEN_ALIASES,
  normalizeTokenForCrossChain,
  findCommonTokensBetweenChains,
  getChainSpecificTokenSymbol
} from './cross-chain';

// =============================================================================
// SYSTEM CONSTANTS
// =============================================================================
export { SYSTEM_CONSTANTS } from './system-constants';

// =============================================================================
// PARTITION CONFIGURATION (ADR-003)
// =============================================================================
export {
  PARTITION_CONFIG,
  PHASE_METRICS
} from './partition-config';

// =============================================================================
// PARTITION EXPORTS (ADR-003)
// =============================================================================
export * from './partitions';

// Named re-exports for ADR-003 compliance tests
export {
  PARTITIONS,
  PartitionConfig,
  PARTITION_IDS,
  PartitionId,
  getPartition,
  getPartitionFromEnv,
  assignChainToPartition
} from './partitions';
