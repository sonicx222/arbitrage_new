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
import { configManager } from './config-manager';
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
import { configManager } from './config-manager';

// =============================================================================
// CHAIN-AWARE ENVIRONMENT VALIDATION
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
  // ConfigManager is now the source of truth
  // This function registers dynamic chain rules and validates

  // Determine which chains to validate
  let chainsToValidate: string[];
  if (chainIds) {
    chainsToValidate = chainIds;
  } else {
    const partition = getPartitionFromEnv();
    chainsToValidate = partition ? [...partition.chains] : [];
  }

  const missing: string[] = [];

  for (const chainId of chainsToValidate) {
    const chain = CHAINS[chainId];
    if (!chain) continue;

    const envPrefix = chainId.toUpperCase();

    // Check RPC URL - required if chain config has placeholder
    if (chain.rpcUrl.includes('${') || chain.rpcUrl.includes('process.env')) {
      const rpcEnvVar = `${envPrefix}_RPC_URL`;

      // Register with ConfigManager
      configManager.addRule(rpcEnvVar, {
        required: true,
        validate: (v: string) => v.startsWith('http') || v.startsWith('ws'),
        errorMessage: `RPC URL required for ${chain.name} (${rpcEnvVar})`
      });

      // Maintain backward compatibility return
      if (!process.env[rpcEnvVar]) {
        missing.push(rpcEnvVar);
      }
    }

    // Check WS URL - required if chain config has placeholder
    if (chain.wsUrl && (chain.wsUrl.includes('${') || chain.wsUrl.includes('process.env'))) {
      const wsEnvVar = `${envPrefix}_WS_URL`;

      // Register with ConfigManager
      configManager.addRule(wsEnvVar, {
        required: true,
        validate: (v: string) => v.startsWith('ws') || v.startsWith('http'), // ws or http used
        errorMessage: `WebSocket URL required for ${chain.name} (${wsEnvVar})`
      });

      if (!process.env[wsEnvVar]) {
        missing.push(wsEnvVar);
      }
    }
  }

  return missing;
}

// Validate required environment variables at startup (skip in test environment)
// P0-3 FIX: Use partition-aware validation instead of hardcoding Ethereum requirement
// Issue 3.1 FIX: Standardized via ConfigManager
if (process.env.NODE_ENV !== 'test') {
  // Register dynamic chain rules
  validateChainEnvironment();

  try {
    // Validate all rules (including default ones from ConfigManager)
    configManager.validateOrThrow();
  } catch (error) {
    // If validation failed, verify if it was due to chains (for helpful message)
    // Note: ConfigManager already printed errors

    // Supplement with helpful resolution message if chain vars are missing
    const missingChainVars = validateChainEnvironment();
    if (missingChainVars.length > 0) {
      console.error(
        `\n${'='.repeat(80)}\n` +
        `CONFIG ERROR: Missing chain environment variables\n` +
        `${'='.repeat(80)}\n` +
        `Missing: ${missingChainVars.join(', ')}\n\n` +
        `Resolution Options:\n` +
        `  1. Set environment variables:\n` +
        `     ${missingChainVars.map(v => `export ${v}="<url>"`).join('\n     ')}\n` +
        `  2. Check PARTITION_ID matches your working chains.\n` +
        `  3. Bypass (NOT RECOMMENDED): export STRICT_CONFIG_VALIDATION=false\n` +
        `${'='.repeat(80)}\n`
      );
    }

    // Re-throw to stop process
    throw error;
  }
}

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
  // ConfigManager is now the source of truth
  // This function registers dynamic chain rules and validates

  // Determine which chains to validate
  let chainsToValidate: string[];
  if (chainIds) {
    chainsToValidate = chainIds;
  } else {
    const partition = getPartitionFromEnv();
    chainsToValidate = partition ? [...partition.chains] : [];
  }

  const missing: string[] = [];

  for (const chainId of chainsToValidate) {
    const chain = CHAINS[chainId];
    if (!chain) continue;

    const envPrefix = chainId.toUpperCase();

    // Check RPC URL - required if chain config has placeholder
    if (chain.rpcUrl.includes('${') || chain.rpcUrl.includes('process.env')) {
      const rpcEnvVar = `${envPrefix}_RPC_URL`;

      // Register with ConfigManager
      configManager.addRule(rpcEnvVar, {
        required: true,
        validate: (v: string) => v.startsWith('http') || v.startsWith('ws'),
        errorMessage: `RPC URL required for ${chain.name} (${rpcEnvVar})`
      });

      // Maintain backward compatibility return
      if (!process.env[rpcEnvVar]) {
        missing.push(rpcEnvVar);
      }
    }

    // Check WS URL - required if chain config has placeholder
    if (chain.wsUrl && (chain.wsUrl.includes('${') || chain.wsUrl.includes('process.env'))) {
      const wsEnvVar = `${envPrefix}_WS_URL`;

      // Register with ConfigManager
      configManager.addRule(wsEnvVar, {
        required: true,
        validate: (v: string) => v.startsWith('ws') || v.startsWith('http'), // ws or http used
        errorMessage: `WebSocket URL required for ${chain.name} (${wsEnvVar})`
      });

      if (!process.env[wsEnvVar]) {
        missing.push(wsEnvVar);
      }
    }
  }

  return missing;
}

// Validate required environment variables at startup (skip in test environment)
// P0-3 FIX: Use partition-aware validation instead of hardcoding Ethereum requirement
// Issue 3.1 FIX: Standardized via ConfigManager
if (process.env.NODE_ENV !== 'test') {
  // Register dynamic chain rules
  validateChainEnvironment();

  try {
    // Validate all rules (including default ones from ConfigManager)
    configManager.validateOrThrow();
  } catch (error) {
    // If validation failed, verify if it was due to chains (for helpful message)
    // Note: ConfigManager already printed errors

    // Supplement with helpful resolution message if chain vars are missing
    const missingChainVars = validateChainEnvironment();
    if (missingChainVars.length > 0) {
      console.error(
        `\n${'='.repeat(80)}\n` +
        `CONFIG ERROR: Missing chain environment variables\n` +
        `${'='.repeat(80)}\n` +
        `Missing: ${missingChainVars.join(', ')}\n\n` +
        `Resolution Options:\n` +
        `  1. Set environment variables:\n` +
        `     ${missingChainVars.map(v => `export ${v}="<url>"`).join('\n     ')}\n` +
        `  2. Check PARTITION_ID matches your working chains.\n` +
        `  3. Bypass (NOT RECOMMENDED): export STRICT_CONFIG_VALIDATION=false\n` +
        `${'='.repeat(80)}\n`
      );
    }

    // Re-throw to stop process
    throw error;
  }
}

// =============================================================================
// CHAIN CONFIGURATIONS
// CHAIN CONFIGURATIONS
// =============================================================================
export {
  CHAINS,
  MAINNET_CHAIN_IDS,
  MainnetChainId,
  TESTNET_CHAINS,
  getAllChains,
  // 6-Provider Shield exports
  PROVIDER_CONFIGS,
  CHAIN_NETWORK_NAMES,
  ProviderTier,
  getProviderUrlsForChain,
  getTimeBasedProviderOrder,
  getTrafficAllocation,
  calculateProviderBudget,
  type ProviderConfig,
  type ProviderBudget,
} from './chains';

// =============================================================================
// DEX CONFIGURATIONS
// =============================================================================
export { DEXES, getEnabledDexes, dexFeeToPercentage, percentageToBasisPoints } from './dexes';

// =============================================================================
// DEX FACTORY REGISTRY (Phase 2.1.1)
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
// THRESHOLDS
// =============================================================================
export { PERFORMANCE_THRESHOLDS, ARBITRAGE_CONFIG, getMinProfitThreshold } from './thresholds';
export { PERFORMANCE_THRESHOLDS, ARBITRAGE_CONFIG, getMinProfitThreshold } from './thresholds';

// =============================================================================
// MEV CONFIGURATION
// MEV CONFIGURATION
// =============================================================================
export { MEV_CONFIG } from './mev-config';
export { MEV_CONFIG } from './mev-config';

// =============================================================================
// EVENT CONFIGURATION
// EVENT CONFIGURATION
// =============================================================================
export { EVENT_CONFIG, EVENT_SIGNATURES } from './event-config';
export { EVENT_CONFIG, EVENT_SIGNATURES } from './event-config';

// =============================================================================
// DETECTOR CONFIGURATION
// DETECTOR CONFIGURATION
// =============================================================================
export { DETECTOR_CONFIG, DetectorChainConfig } from './detector-config';
export { DETECTOR_CONFIG, DetectorChainConfig } from './detector-config';

// =============================================================================
// SERVICE CONFIGURATION
// SERVICE CONFIGURATION
// =============================================================================
export {
  SERVICE_CONFIGS,
  FLASH_LOAN_PROVIDERS,
  supportsFlashLoan,
  BRIDGE_COSTS,
  BridgeCostConfig,
  getBridgeCost,
  getAllBridgeOptions,
  calculateBridgeCostUsd,
  // Hot-path optimized versions (skip toLowerCase normalization)
  getBridgeCostFast,
  getAllBridgeOptionsFast,
  // Fix 1.1: Centralized flash loan constants
  AAVE_V3_FEE_BPS,
  BPS_DENOMINATOR,
  AAVE_V3_FEE_BPS_BIGINT,
  BPS_DENOMINATOR_BIGINT,
  // Fix 9.2: Consolidated ABI
  FLASH_LOAN_ARBITRAGE_ABI,
} from './service-config';
export {
  SERVICE_CONFIGS,
  FLASH_LOAN_PROVIDERS,
  supportsFlashLoan,
  BRIDGE_COSTS,
  BridgeCostConfig,
  getBridgeCost,
  getAllBridgeOptions,
  calculateBridgeCostUsd,
  // Hot-path optimized versions (skip toLowerCase normalization)
  getBridgeCostFast,
  getAllBridgeOptionsFast,
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
// SYSTEM CONSTANTS
// =============================================================================
export { SYSTEM_CONSTANTS } from './system-constants';
export { SYSTEM_CONSTANTS } from './system-constants';

// =============================================================================
// PARTITION CONFIGURATION (ADR-003)
// PARTITION CONFIGURATION (ADR-003)
// =============================================================================
// All partition exports come from partitions.ts (single source of truth)
// This includes: PARTITIONS, PARTITION_CONFIG, PARTITION_IDS, PHASE_METRICS,
// PartitionConfig, PartitionId, and all partition functions
//
// NOTE: partition-config.ts is deprecated and no longer imported.
// It was a re-export wrapper that added confusion without value.
export * from './partitions';

// =============================================================================
// CONFIG MANAGER (Task 2.1)
// =============================================================================
export {
  ConfigManager,
  configManager,
  resetConfigManager,
  ValidationRule,
  ValidationResult
} from './config-manager';
// All partition exports come from partitions.ts (single source of truth)
// This includes: PARTITIONS, PARTITION_CONFIG, PARTITION_IDS, PHASE_METRICS,
// PartitionConfig, PartitionId, and all partition functions
//
// NOTE: partition-config.ts is deprecated and no longer imported.
// It was a re-export wrapper that added confusion without value.
export * from './partitions';

// =============================================================================
// CONFIG MANAGER (Task 2.1)
// =============================================================================
export {
  ConfigManager,
  configManager,
  resetConfigManager,
  ValidationRule,
  ValidationResult
} from './config-manager';

// =============================================================================
// MEMPOOL CONFIGURATION (Phase 1: Mempool Detection Service)
// MEMPOOL CONFIGURATION (Phase 1: Mempool Detection Service)
// =============================================================================
export {
  MEMPOOL_CONFIG,
  KNOWN_ROUTERS,
  getKnownRouters,
  getRouterInfo,
  isMempoolEnabledForChain,
  getChainMempoolConfig,
  getEnabledMempoolChains,
  // Curve pool token configuration (Task 1.3.2)
  CURVE_POOL_TOKENS,
  getCurvePoolTokens,
  // FIX 6.3, 9.2: Centralized chain ID utilities
  CHAIN_NAME_TO_ID,
  CHAIN_ID_TO_NAME,
  resolveChainId,
  getChainName,
} from './mempool-config';
export {
  MEMPOOL_CONFIG,
  KNOWN_ROUTERS,
  getKnownRouters,
  getRouterInfo,
  isMempoolEnabledForChain,
  getChainMempoolConfig,
  getEnabledMempoolChains,
  // Curve pool token configuration (Task 1.3.2)
  CURVE_POOL_TOKENS,
  getCurvePoolTokens,
  // FIX 6.3, 9.2: Centralized chain ID utilities
  CHAIN_NAME_TO_ID,
  CHAIN_ID_TO_NAME,
  resolveChainId,
  getChainName,
} from './mempool-config';

// =============================================================================
// RISK CONFIGURATION (Phase 3: Capital & Risk Controls)
// RISK CONFIGURATION (Phase 3: Capital & Risk Controls)
// =============================================================================
export {
  RISK_CONFIG,
  getRiskConfigWithCapital,
  validateRiskConfig,
} from './risk-config';
export {
  RISK_CONFIG,
  getRiskConfigWithCapital,
  validateRiskConfig,
} from './risk-config';

// =============================================================================
// CANONICAL ADDRESSES (P3-CONFIG)
// Single source of truth for all contract addresses
// CANONICAL ADDRESSES (P3-CONFIG)
// Single source of truth for all contract addresses
// =============================================================================
export {
  // Aave V3 pools
  AAVE_V3_POOLS,
  getAaveV3Pool,
  hasAaveV3,
  // Native tokens
  NATIVE_TOKENS,
  getNativeToken,
  // Stablecoins
  STABLECOINS,
  getStablecoin,
  getChainStablecoins,
  // DEX routers
  DEX_ROUTERS,
  getDexRouter,
  // Bridge contracts
  BRIDGE_CONTRACTS,
  getBridgeContract,
  // Solana programs
  SOLANA_PROGRAMS,
  getSolanaProgram,
  // Validation utilities
  isValidEthereumAddress,
  isValidSolanaAddress,
  normalizeAddress,
  addressesEqual,
  // Type exports
  EVMChainId,
  ChainId,
  TestnetChainId,
} from './addresses';
export {
  // Aave V3 pools
  AAVE_V3_POOLS,
  getAaveV3Pool,
  hasAaveV3,
  // Native tokens
  NATIVE_TOKENS,
  getNativeToken,
  // Stablecoins
  STABLECOINS,
  getStablecoin,
  getChainStablecoins,
  // DEX routers
  DEX_ROUTERS,
  getDexRouter,
  // Bridge contracts
  BRIDGE_CONTRACTS,
  getBridgeContract,
  // Solana programs
  SOLANA_PROGRAMS,
  getSolanaProgram,
  // Validation utilities
  isValidEthereumAddress,
  isValidSolanaAddress,
  normalizeAddress,
  addressesEqual,
  // Type exports
  EVMChainId,
  ChainId,
  TestnetChainId,
} from './addresses';

// =============================================================================
// ZOD SCHEMA VALIDATION (P3-CONFIG)
// Runtime validation for config objects
// ZOD SCHEMA VALIDATION (P3-CONFIG)
// Runtime validation for config objects
// =============================================================================
export {
  // Primitive schemas
  EthereumAddressSchema,
  SolanaAddressSchema,
  BasisPointsSchema,
  PercentageDecimalSchema,
  // Config schemas
  ChainSchema,
  ChainRegistrySchema,
  DexSchema,
  DexTypeSchema,
  FactoryConfigSchema,
  FactoryTypeSchema,
  FactoryRegistrySchema,
  TokenSchema,
  FlashLoanProviderSchema,
  FlashLoanProvidersSchema,
  BridgeCostConfigSchema,
  BridgeCostsSchema,
  ServiceConfigSchema,
  // Validation helpers
  validateWithDetails,
  validateOrThrow,
  createValidator,
  validateChain,
  validateDex,
  validateFactory,
  validateFlashLoanProvider,
  validateBridgeCost,
  // Registry validators
  validateChainRegistry,
  validateFactoryRegistry as validateFactoryRegistrySchema,
  validateFlashLoanProviders,
  validateBridgeCosts,
  // Re-export zod for custom schema creation
  z,
} from './schemas';
  // Primitive schemas
  EthereumAddressSchema,
  SolanaAddressSchema,
  BasisPointsSchema,
  PercentageDecimalSchema,
  // Config schemas
  ChainSchema,
  ChainRegistrySchema,
  DexSchema,
  DexTypeSchema,
  FactoryConfigSchema,
  FactoryTypeSchema,
  FactoryRegistrySchema,
  TokenSchema,
  FlashLoanProviderSchema,
  FlashLoanProvidersSchema,
  BridgeCostConfigSchema,
  BridgeCostsSchema,
  ServiceConfigSchema,
  // Validation helpers
  validateWithDetails,
  validateOrThrow,
  createValidator,
  validateChain,
  validateDex,
  validateFactory,
  validateFlashLoanProvider,
  validateBridgeCost,
  // Registry validators
  validateChainRegistry,
  validateFactoryRegistry as validateFactoryRegistrySchema,
  validateFlashLoanProviders,
  validateBridgeCosts,
  // Re-export zod for custom schema creation
  z,
} from './schemas';
