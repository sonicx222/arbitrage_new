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
// P0-5 FIX: Stricter validation in development to catch configuration issues early
// Issue 3.1 FIX: Consistent validation across all environments
if (process.env.NODE_ENV !== 'test') {
  // Partition-aware validation: only require env vars for chains in the current partition
  const missingEnvVars = validateChainEnvironment();

  // Determine validation strictness:
  // - STRICT_CONFIG_VALIDATION=true: Always fail on missing env vars (opt-in for CI/staging)
  // - STRICT_CONFIG_VALIDATION=false: Never fail, only warn (opt-out for local dev)
  // - Default: Strict in ALL environments when PARTITION_ID is set or any chains are missing
  // Issue 3.1 FIX: Development mode now fails consistently, not just for Ethereum
  const strictValidation = process.env.STRICT_CONFIG_VALIDATION;
  const forceStrict = strictValidation === 'true' || strictValidation === '1';
  const forceWarn = strictValidation === 'false' || strictValidation === '0';

  if (missingEnvVars.length > 0) {
    const errorContext = process.env.PARTITION_ID
      ? `partition ${process.env.PARTITION_ID}`
      : 'configured chains';

    if (forceWarn) {
      // Explicit opt-out - warn with detailed information
      console.warn(
        `CONFIG WARNING: Missing environment variables for ${errorContext}: ${missingEnvVars.join(', ')}. ` +
        `Validation bypassed via STRICT_CONFIG_VALIDATION=false. ` +
        `Chains with missing config will fail at runtime.`
      );
    } else if (process.env.PARTITION_ID || process.env.NODE_ENV === 'production' || forceStrict) {
      // Partition mode, production, or explicit strict mode: fail immediately
      throw new Error(
        `CRITICAL CONFIG ERROR: Missing environment variables for ${errorContext}: ${missingEnvVars.join(', ')}. ` +
        `Either configure the missing variables or set STRICT_CONFIG_VALIDATION=false to bypass (not recommended).`
      );
    } else {
      // Issue 3.1 FIX: Development mode - CONSISTENT strict behavior
      // ALL missing chain configs now fail, not just Ethereum
      // This prevents silent configuration issues that only surface at runtime
      // Rationale: Silent warnings led to developers starting services that would fail at runtime
      // when accessing chains other than Ethereum. Consistent failure ensures early detection.
      console.error(
        `\n${'='.repeat(80)}\n` +
        `CONFIG ERROR: Missing chain environment variables\n` +
        `${'='.repeat(80)}\n` +
        `Missing: ${missingEnvVars.join(', ')}\n\n` +
        `This error occurs because chain configuration is incomplete.\n` +
        `To fix this, choose one of the following options:\n\n` +
        `  1. Set the missing environment variables:\n` +
        `     ${missingEnvVars.map(v => `export ${v}="your_url_here"`).join('\n     ')}\n\n` +
        `  2. Set PARTITION_ID to only validate chains you're working with:\n` +
        `     export PARTITION_ID=asia-fast    # For BSC, Polygon, Avalanche, Fantom\n` +
        `     export PARTITION_ID=l2-turbo     # For Arbitrum, Optimism, Base\n` +
        `     export PARTITION_ID=high-value   # For Ethereum, zkSync, Linea\n` +
        `     export PARTITION_ID=solana-native # For Solana only\n\n` +
        `  3. Bypass validation (not recommended - will fail at runtime):\n` +
        `     export STRICT_CONFIG_VALIDATION=false\n` +
        `${'='.repeat(80)}\n`
      );

      // Issue 3.1 FIX: Fail for ANY missing chain config, not just Ethereum
      // This ensures consistent behavior and prevents runtime failures
      throw new Error(
        `CONFIG ERROR: Missing chain configuration for: ${missingEnvVars.join(', ')}. ` +
        `See error output above for resolution options. ` +
        `Set STRICT_CONFIG_VALIDATION=false to bypass (not recommended).`
      );
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
export {
  CORE_TOKENS,
  TOKEN_METADATA,
  FALLBACK_TOKEN_PRICES,
  FALLBACK_PRICES_LAST_UPDATED,
  FALLBACK_PRICES_STALENESS_WARNING_DAYS,
  checkFallbackPriceStaleness,
  getFallbackPriceAgeDays,
  NATIVE_TOKEN_PRICES,
  getNativeTokenPrice,
  // Issue 3.2 FIX: Native token price staleness tracking
  NATIVE_TOKEN_PRICE_METADATA,
  checkNativeTokenPriceStaleness,
  // Finding 7.1 FIX: Token decimals lookup for flash loan strategy
  getTokenDecimals,
  hasKnownDecimals
} from './tokens';

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
  calculateBridgeCostUsd,
  // Fix 1.1: Centralized flash loan constants
  AAVE_V3_FEE_BPS,
  BPS_DENOMINATOR,
  AAVE_V3_FEE_BPS_BIGINT,
  BPS_DENOMINATOR_BIGINT,
  // Fix 9.2: Consolidated ABI
  FLASH_LOAN_ARBITRAGE_ABI,
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
