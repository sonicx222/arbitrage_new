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

import { CHAINS } from './chains';
import { getPartitionFromEnv } from './partitions';

// =============================================================================
// CHAIN-AWARE ENVIRONMENT VALIDATION
// =============================================================================

/**
 * Validates that required environment variables are set for enabled chains.
 * Only validates chains that are actually used in the current partition.
 *
 * Chain environment variables follow the pattern:
 * - {CHAIN_NAME}_RPC_URL (e.g., ETHEREUM_RPC_URL, ARBITRUM_RPC_URL)
 * - {CHAIN_NAME}_WS_URL (e.g., ETHEREUM_WS_URL, ARBITRUM_WS_URL)
 *
 * @param chainIds - Optional list of chain IDs to validate. If not provided,
 *                   validates chains from the current partition (PARTITION_ID env var).
 * @returns Array of missing environment variable names
 */
export function validateChainEnvironment(chainIds?: string[]): string[] {
  const missing: string[] = [];

  // Determine which chains to validate
  let chainsToValidate: string[];
  if (chainIds) {
    chainsToValidate = chainIds;
  } else {
    const partition = getPartitionFromEnv();
    chainsToValidate = partition ? [...partition.chains] : [];
  }

  for (const chainId of chainsToValidate) {
    const chain = CHAINS[chainId];
    if (!chain) continue;

    const envPrefix = chainId.toUpperCase();

    // Check RPC URL - required if chain config has placeholder
    if (chain.rpcUrl.includes('${') || chain.rpcUrl.includes('process.env')) {
      const rpcEnvVar = `${envPrefix}_RPC_URL`;
      if (!process.env[rpcEnvVar]) {
        missing.push(rpcEnvVar);
      }
    }

    // Check WS URL - required if chain config has placeholder
    if (chain.wsUrl && (chain.wsUrl.includes('${') || chain.wsUrl.includes('process.env'))) {
      const wsEnvVar = `${envPrefix}_WS_URL`;
      if (!process.env[wsEnvVar]) {
        missing.push(wsEnvVar);
      }
    }
  }

  return missing;
}

// Validate required environment variables at startup (skip in test environment)
// P0-3 FIX: Use partition-aware validation instead of hardcoding Ethereum requirement
// This allows non-Ethereum partitions (P1 Asia-Fast, P4 Solana-Native) to start independently
// P0-4 FIX: Enforce validation in production to prevent partial configuration issues
if (process.env.NODE_ENV !== 'test') {
  // Partition-aware validation: only require env vars for chains in the current partition
  const missingEnvVars = validateChainEnvironment();

  // Only fail if there are missing env vars AND we're in a partition deployment
  // (PARTITION_ID env var is set). Without PARTITION_ID, we assume legacy mode
  // which expects at least Ethereum to be configured.
  if (missingEnvVars.length > 0) {
    if (process.env.PARTITION_ID) {
      // Partition mode: fail only if partition chains are missing configs
      throw new Error(
        `CRITICAL CONFIG ERROR: Missing environment variables for partition ${process.env.PARTITION_ID}: ${missingEnvVars.join(', ')}`
      );
    } else if (process.env.NODE_ENV === 'production') {
      // P0-4 FIX: Production mode without PARTITION_ID - strict validation
      // In production, all chains must be properly configured to prevent silent failures
      throw new Error(
        `CRITICAL CONFIG ERROR (production): Missing environment variables: ${missingEnvVars.join(', ')}. ` +
        `Set PARTITION_ID for partition-aware deployment or configure all required chains.`
      );
    } else {
      // Development/staging mode: warn but only fail if Ethereum is missing (backward compatibility)
      if (!process.env.ETHEREUM_RPC_URL || !process.env.ETHEREUM_WS_URL) {
        console.warn(
          `WARNING: Missing chain environment variables: ${missingEnvVars.join(', ')}. ` +
          `Set PARTITION_ID for partition-aware validation or NODE_ENV=production for strict validation.`
        );
      }
    }
  }
}

// =============================================================================
// CHAIN CONFIGURATIONS
// =============================================================================
export {
  CHAINS,
  MAINNET_CHAIN_IDS,
  MainnetChainId,
  TESTNET_CHAINS,
  getAllChains
} from './chains';

// =============================================================================
// DEX CONFIGURATIONS
// =============================================================================
export { DEXES, getEnabledDexes, dexFeeToPercentage, percentageToBasisPoints } from './dexes';

// =============================================================================
// DEX FACTORY REGISTRY (Phase 2.1.1)
// =============================================================================
export {
  DEX_FACTORY_REGISTRY,
  FACTORY_ABIS,
  FactoryType,
  FactoryConfig,
  getFactoriesForChain,
  getFactoriesWithEventSupport,
  getFactoryByAddress,
  getFactoryType,
  getFactoryAbi,
  getAllFactoryAddresses,
  isUniswapV2Style,
  isUniswapV3Style,
  isAlgebraStyle,
  isSolidlyStyle,
  isVaultModelDex,
  getFactoriesByType,
  validateFactoryRegistry,
} from './dex-factories';

// =============================================================================
// TOKEN CONFIGURATIONS
// =============================================================================
export { CORE_TOKENS, TOKEN_METADATA, FALLBACK_TOKEN_PRICES } from './tokens';

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
  getAllBridgeOptions,
  calculateBridgeCostUsd
} from './service-config';

// =============================================================================
// CROSS-CHAIN NORMALIZATION
// =============================================================================
export {
  CROSS_CHAIN_TOKEN_ALIASES,
  normalizeTokenForCrossChain,
  findCommonTokensBetweenChains,
  preWarmCommonTokensCache,
  getChainSpecificTokenSymbol,
  // Refactored from detector.ts - chain-specific quote tokens
  DEFAULT_QUOTE_TOKENS,
  getDefaultQuoteToken
} from './cross-chain';

// =============================================================================
// SYSTEM CONSTANTS
// =============================================================================
export { SYSTEM_CONSTANTS } from './system-constants';

// =============================================================================
// PARTITION CONFIGURATION (ADR-003)
// =============================================================================
// All partition exports come from partitions.ts (single source of truth)
// This includes: PARTITIONS, PARTITION_CONFIG, PARTITION_IDS, PHASE_METRICS,
// PartitionConfig, PartitionId, and all partition functions
//
// NOTE: partition-config.ts is deprecated and no longer imported.
// It was a re-export wrapper that added confusion without value.
export * from './partitions';
