/**
 * Service Configuration
 *
 * Core service configs, flash loan providers, and multi-path quoter.
 *
 * @see P1-4: Flash loan provider configuration
 */

import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS } from './addresses';

// =============================================================================
// SERVICE CONFIGURATIONS
// =============================================================================

/**
 * Check if running in production environment.
 * Production is detected by NODE_ENV=production or common production indicators.
 */
export const isProduction = process.env.NODE_ENV === 'production' ||
  process.env.FLY_APP_NAME !== undefined ||  // Fly.io
  process.env.RAILWAY_ENVIRONMENT !== undefined ||  // Railway
  process.env.RENDER_SERVICE_NAME !== undefined ||  // Render
  process.env.KOYEB_SERVICE_NAME !== undefined;  // Koyeb

/**
 * Warn if using localhost defaults in production.
 * Only emits warning once per process.
 */
let productionConfigWarningEmitted = false;
function warnOnProductionDefault(configName: string, defaultValue: string): void {
  if (isProduction && !productionConfigWarningEmitted) {
    productionConfigWarningEmitted = true;
    console.warn(
      `[CONFIG WARNING] Using default ${configName} (${defaultValue}) in production!\n` +
      `Set ${configName.toUpperCase().replace(/\./g, '_')} environment variable for production deployment.`
    );
  }
}

// =============================================================================
// LOCALHOST DETECTION HELPER
// FIX: Comprehensive localhost detection including IPv6 and Docker patterns
// =============================================================================

/**
 * Check if a URL points to a localhost address.
 * Detects common localhost patterns including:
 * - localhost
 * - 127.0.0.1 (IPv4 loopback)
 * - ::1 (IPv6 loopback)
 * - 0.0.0.0 (bind all interfaces, often used as localhost)
 * - host.docker.internal (Docker Desktop host access)
 * - [::1] (bracketed IPv6)
 *
 * @param url - URL to check
 * @returns true if URL points to localhost
 */
export function isLocalhostUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return (
    lowered.includes('localhost') ||
    lowered.includes('127.0.0.1') ||
    lowered.includes('::1') ||
    lowered.includes('[::1]') ||
    lowered.includes('0.0.0.0') ||
    lowered.includes('host.docker.internal')
  );
}

// Validate Redis URL - warn if using localhost in production
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
if (isLocalhostUrl(redisUrl)) {
  warnOnProductionDefault('REDIS_URL', redisUrl);
}

export const SERVICE_CONFIGS = {
  redis: {
    url: redisUrl,
    password: process.env.REDIS_PASSWORD,
    /** Flag indicating if using production Redis (not localhost) */
    isProductionRedis: !isLocalhostUrl(redisUrl),
  },
  monitoring: {
    enabled: process.env.MONITORING_ENABLED === 'true',
    interval: parseInt(process.env.MONITORING_INTERVAL || '30000'),
    endpoints: (process.env.MONITORING_ENDPOINTS || '').split(',').filter(Boolean),
  },
  /** Indicates if configuration is suitable for production use */
  isProductionConfig: isProduction && !isLocalhostUrl(redisUrl),
};

/**
 * Validate that all required production configurations are set.
 * Call this at application startup in production to fail-fast.
 *
 * FIX: Enhanced validation to include:
 * - Comprehensive localhost detection (IPv6, Docker)
 * - RPC URL validation for at least one chain
 * - MEV provider key warnings
 *
 * @throws Error if required production configuration is missing
 */
export function validateProductionConfig(): void {
  if (!isProduction) {
    return; // Skip validation in development
  }

  const missingConfigs: string[] = [];
  const warnings: string[] = [];

  // Redis URL validation - use comprehensive localhost check
  if (!process.env.REDIS_URL || isLocalhostUrl(process.env.REDIS_URL)) {
    missingConfigs.push('REDIS_URL (production Redis instance required - localhost not allowed)');
  }

  // Wallet credentials validation
  if (!process.env.WALLET_PRIVATE_KEY && !process.env.WALLET_MNEMONIC) {
    missingConfigs.push('WALLET_PRIVATE_KEY or WALLET_MNEMONIC (wallet credentials required for execution)');
  }

  // RPC URL validation - at least one chain should have a dedicated RPC URL set
  // Maps chain name to env var name for common chains
  const chainRpcEnvVars: Record<string, string> = {
    arbitrum: 'ARBITRUM_RPC_URL',
    bsc: 'BSC_RPC_URL',
    base: 'BASE_RPC_URL',
    polygon: 'POLYGON_RPC_URL',
    optimism: 'OPTIMISM_RPC_URL',
    ethereum: 'ETHEREUM_RPC_URL',
    avalanche: 'AVALANCHE_RPC_URL',
    fantom: 'FANTOM_RPC_URL',
    zksync: 'ZKSYNC_RPC_URL',
    linea: 'LINEA_RPC_URL',
    solana: 'SOLANA_RPC_URL',
  };

  // Check if at least one chain-specific RPC URL is configured
  const configuredChainRpcs = Object.entries(chainRpcEnvVars).filter(
    ([, envVar]) => process.env[envVar] && !isLocalhostUrl(process.env[envVar]!)
  );

  if (configuredChainRpcs.length === 0) {
    // Check for provider API keys as fallback (dRPC, Ankr, etc.)
    const hasProviderKeys = !!(
      process.env.DRPC_API_KEY ||
      process.env.ANKR_API_KEY ||
      process.env.INFURA_API_KEY ||
      process.env.ALCHEMY_API_KEY
    );

    if (!hasProviderKeys) {
      missingConfigs.push(
        'RPC Configuration: Either set chain-specific URLs (e.g., ARBITRUM_RPC_URL) ' +
        'or provider API keys (DRPC_API_KEY, ANKR_API_KEY, INFURA_API_KEY, or ALCHEMY_API_KEY)'
      );
    }
  }

  // MEV provider key warnings (optional but recommended for production)
  if (!process.env.FLASHBOTS_AUTH_KEY) {
    warnings.push('FLASHBOTS_AUTH_KEY not set - MEV protection on Ethereum will be limited');
  }

  // Solana-specific validation if Solana partition is enabled
  if (process.env.PARTITION_ID === 'solana-native') {
    if (!process.env.SOLANA_RPC_URL || isLocalhostUrl(process.env.SOLANA_RPC_URL)) {
      missingConfigs.push('SOLANA_RPC_URL (required for solana-native partition)');
    }
    // Check for premium Solana providers
    if (!process.env.HELIUS_API_KEY && !process.env.TRITON_API_KEY) {
      warnings.push('HELIUS_API_KEY or TRITON_API_KEY recommended for Solana production');
    }
  }

  // Log warnings
  if (warnings.length > 0) {
    console.warn('\n⚠️  Production configuration warnings:');
    warnings.forEach(w => console.warn(`  - ${w}`));
  }

  // Throw if critical configs are missing
  if (missingConfigs.length > 0) {
    throw new Error(
      `Production configuration validation failed!\n\n` +
      `Missing required configurations:\n` +
      missingConfigs.map(c => `  - ${c}`).join('\n') +
      `\n\nEither set the required environment variables or set NODE_ENV=development.`
    );
  }
}

// =============================================================================
// CHAIN EXECUTION SUPPORT (FIX: Issue 2.4)
// =============================================================================

/**
 * Chains that support execution (transaction submission).
 *
 * FIX (Issue 2.4): Explicitly defines which chains can execute trades.
 * This prevents execution attempts on detection-only chains like Solana.
 *
 * ## Chain Support Status:
 *
 * **EVM Chains (Execution Supported)**:
 * - ethereum, arbitrum, optimism, base, bsc, polygon
 * - avalanche, fantom, zksync, linea
 * - All use ethers.js for transaction submission
 * - Support flash loans, MEV protection, gas estimation
 *
 * **Solana (Detection Only)**:
 * - ✅ Opportunity detection supported (Partition 4)
 * - ❌ Execution NOT implemented (different transaction model)
 * - Requires: @solana/web3.js, SPL tokens, Jito bundles
 * - See: docs/architecture/ARCHITECTURE_V2.md Section 4.7
 *
 * @see isExecutionSupported() for validation helper
 * @see docs/architecture/ARCHITECTURE_V2.md Section 4.7
 */
export const SUPPORTED_EXECUTION_CHAINS = new Set([
  'ethereum',
  'arbitrum',
  'optimism',
  'base',
  'bsc',
  'polygon',
  'avalanche',
  'fantom',
  'zksync',
  'linea',
]);

/**
 * Check if a chain supports execution (transaction submission).
 *
 * FIX (Issue 2.4): Validates chain before execution attempts.
 * Returns false for detection-only chains like Solana.
 *
 * @param chain - Chain identifier (e.g., 'ethereum', 'solana')
 * @returns true if chain supports execution, false otherwise
 *
 * @example
 * ```typescript
 * if (!isExecutionSupported('solana')) {
 *   throw new Error('Solana execution not implemented');
 * }
 * ```
 */
export function isExecutionSupported(chain: string): boolean {
  return SUPPORTED_EXECUTION_CHAINS.has(chain);
}

/**
 * Get list of supported execution chains.
 * @returns Array of chain identifiers that support execution
 */
export function getSupportedExecutionChains(): string[] {
  return Array.from(SUPPORTED_EXECUTION_CHAINS);
}

// =============================================================================
// FLASH LOAN PROVIDER CONFIGURATION (P1-4 fix)
// Moved from hardcoded values in execution-engine
// =============================================================================

/**
 * Flash loan provider configuration by chain.
 *
 * ## Fee Format Convention (M1 Fix)
 *
 * ALL fees in this config are in **basis points (bps)**:
 * - 1 bps = 0.01%
 * - 100 bps = 1%
 * - Example: fee: 25 = 25 bps = 0.25%
 *
 * **Protocol-Specific Internal Formats** (handled by providers):
 * - Aave V3: Uses bps directly (9 bps = 0.09%)
 * - PancakeSwap V3: Uses "fee tiers" = bps * 100 (2500 = 25 bps = 0.25%)
 * - Balancer V2: Uses bps directly (0 bps = 0%)
 *
 * Providers handle conversion internally - config always uses bps.
 *
 * ## Fix 3.1/9.2: Address Consolidation
 *
 * IMPORTANT: Aave V3 Pool addresses are also defined in:
 * - contracts/deployments/addresses.ts (AAVE_V3_POOL_ADDRESSES)
 *
 * The contracts/deployments/addresses.ts is the CANONICAL SOURCE for
 * Hardhat deployments. When adding/updating Aave addresses, update BOTH files.
 *
 * Future improvement: Extract shared addresses to a common JSON file that
 * both TypeScript and Solidity can consume.
 *
 * @see contracts/deployments/addresses.ts
 * @see https://docs.aave.com/developers/deployed-contracts/v3-mainnet
 */
export const FLASH_LOAN_PROVIDERS: Record<string, {
  address: string;
  protocol: string;
  fee: number;  // Basis points (bps): 100 bps = 1%
  approvedRouters?: string[];  // FIX M7: Optional list of approved router addresses per chain
}> = {
  // Aave V3 Pool addresses - https://docs.aave.com/developers/deployed-contracts
  // FIX 3.1.3-1: Corrected Ethereum Aave V3 Pool address (was 0x87870BcD2C4C2e84a8c3C3a3fcACc94666C0d6CF)
  // SYNC: Must match contracts/deployments/addresses.ts AAVE_V3_POOL_ADDRESSES
  ethereum: {
    address: AAVE_V3_POOLS.ethereum,
    protocol: 'aave_v3',
    fee: 9  // 0.09% flash loan fee
  },
  polygon: {
    address: AAVE_V3_POOLS.polygon,
    protocol: 'aave_v3',
    fee: 9
  },
  arbitrum: {
    address: AAVE_V3_POOLS.arbitrum,
    protocol: 'aave_v3',
    fee: 9
  },
  base: {
    address: AAVE_V3_POOLS.base,
    protocol: 'aave_v3',
    fee: 9
  },
  optimism: {
    address: AAVE_V3_POOLS.optimism,
    protocol: 'aave_v3',
    fee: 9
  },
  // BSC uses PancakeSwap V3 flash loans (no Aave V3)
  bsc: {
    address: PANCAKESWAP_V3_FACTORIES.bsc,  // PancakeSwap V3 Factory (for pool discovery)
    protocol: 'pancakeswap_v3',
    /**
     * M1 Fix: Fee format clarification
     * - Config format: 25 bps (basis points) = 0.25%
     * - Contract format: 2500 (hundredths of bip) = 0.25%
     * - Conversion: feeTier = feeBps * 100 (e.g., 25 bps → 2500)
     * - PancakeSwapV3FlashLoanProvider handles conversion internally
     */
    fee: 25  // 0.25% flash swap fee (in basis points)
  },
  // S3.2.1-FIX: Added Avalanche Aave V3 flash loan provider
  avalanche: {
    address: AAVE_V3_POOLS.avalanche,  // Aave V3 Pool on Avalanche
    protocol: 'aave_v3',
    fee: 9  // 0.09% flash loan fee
  },
  // Task 2.2: Fantom uses Beethoven X (Balancer V2 fork) for flash loans
  // Beethoven X provides 0% flash loan fees, much better than SpookySwap's 0.3%
  fantom: {
    address: BALANCER_V2_VAULTS.fantom,  // Beethoven X Vault (Balancer V2 fork)
    protocol: 'balancer_v2',
    fee: 0  // 0% flash loan fee (Balancer V2 advantage)
  },

  // ============================================================================
  // Task 2.2 TODO: Balancer V2 Configuration for Additional Chains
  // ============================================================================
  //
  // Balancer V2 is available on 5 additional chains with 0% flash loan fees
  // (vs Aave V3's 0.09% fee). To enable, uncomment the entries below AFTER:
  //
  // 1. Deploying BalancerV2FlashArbitrage.sol contract to each chain
  // 2. Updating contractAddresses config in execution-engine initialization
  // 3. Verifying contracts on block explorers
  // 4. Adding contract addresses to deployment tracking
  //
  // Vault addresses are confirmed from Balancer V2 documentation:
  // https://docs.balancer.fi/reference/contracts/deployment-addresses/mainnet.html
  //
  // When deploying, REPLACE the corresponding Aave V3 entries above with these
  // Balancer V2 entries to take advantage of 0% fees.
  //
  // Example deployment order: Ethereum → Polygon → Arbitrum → Optimism → Base
  //
  // /*
  // ethereum: {
  //   address: BALANCER_V2_VAULTS.ethereum,  // 0xBA12222222228d8Ba445958a75a0704d566BF2C8
  //   protocol: 'balancer_v2',
  //   fee: 0  // 0% flash loan fee (saves 0.09% vs Aave V3)
  // },
  // polygon: {
  //   address: BALANCER_V2_VAULTS.polygon,   // 0xBA12222222228d8Ba445958a75a0704d566BF2C8
  //   protocol: 'balancer_v2',
  //   fee: 0
  // },
  // arbitrum: {
  //   address: BALANCER_V2_VAULTS.arbitrum,  // 0xBA12222222228d8Ba445958a75a0704d566BF2C8
  //   protocol: 'balancer_v2',
  //   fee: 0
  // },
  // optimism: {
  //   address: BALANCER_V2_VAULTS.optimism,  // 0xBA12222222228d8Ba445958a75a0704d566BF2C8
  //   protocol: 'balancer_v2',
  //   fee: 0
  // },
  // base: {
  //   address: BALANCER_V2_VAULTS.base,      // 0xBA12222222228d8Ba445958a75a0704d566BF2C8
  //   protocol: 'balancer_v2',
  //   fee: 0
  // },
  // */
  //
  // Current status: Using Aave V3 for these chains (0.09% fee) until contracts deployed
  // ============================================================================
  // Task 3.4: zkSync Era - SyncSwap flash loans via Vault (EIP-3156)
  // FIXED: Now using Vault address (was incorrectly using Router address)
  zksync: {
    address: SYNCSWAP_VAULTS.zksync,  // SyncSwap Vault: 0x621425a1Ef6abE91058E9712575dcc4258F8d091
    protocol: 'syncswap',
    fee: 30  // 0.3% flash loan fee (30 bps)
  },
  // Task 3.4 (Future): Linea - SyncSwap flash loans via Vault (EIP-3156)
  // TODO: Add Linea Vault address when deploying SyncSwap support to Linea
  // linea: {
  //   address: SYNCSWAP_VAULTS.linea,  // SyncSwap Vault (TBD)
  //   protocol: 'syncswap',
  //   fee: 30  // 0.3% flash loan fee (30 bps)
  // },
  // FIX: Explicit Solana entry to prevent silent failures when iterating all chains
  // Solana uses Jupiter swap routes instead of traditional flash loans
  solana: {
    address: '',  // Not applicable - Solana uses different mechanism
    protocol: 'jupiter',  // Jupiter aggregator for Solana swaps
    fee: 0  // Jupiter has no flash loan fee (uses atomic swaps)
  }
};

/**
 * Check if a chain supports traditional flash loans.
 * Solana uses Jupiter atomic swaps instead of flash loans.
 */
export function supportsFlashLoan(chainId: string): boolean {
  const provider = FLASH_LOAN_PROVIDERS[chainId];
  return provider !== undefined && provider.address !== '';
}

// =============================================================================
// MULTI PATH QUOTER CONFIGURATION (Tier 2 Enhancement)
// Addresses for the MultiPathQuoter contract per chain
// Enables batched quote fetching for 50-200ms latency reduction
// =============================================================================

/**
 * MultiPathQuoter contract addresses per chain.
 *
 * @see contracts/src/MultiPathQuoter.sol
 * @see services/execution-engine/src/services/simulation/batch-quoter.service.ts
 *
 * ## Deployment Status
 * When deploying MultiPathQuoter to a new chain:
 * 1. Deploy the contract using: npx hardhat run scripts/deploy-quoter.ts --network <chain>
 * 2. Add the deployed address here
 * 3. The BatchQuoterService will automatically use batched quotes instead of sequential
 *
 * ## Performance Impact
 * - Without quoter: N sequential RPC calls (~50-200ms per call)
 * - With quoter: 1 batched RPC call (~50ms total)
 * - For 3-hop paths: 150-600ms → 50ms (3-12x improvement)
 *
 * ## Fallback Behavior
 * If quoter address is not configured for a chain, BatchQuoterService
 * automatically falls back to sequential getAmountsOut() calls.
 * This is safe but slower.
 */
export const MULTI_PATH_QUOTER_ADDRESSES: Record<string, string> = {
  // Primary chains - deploy quoter for maximum performance
  // TODO: Update these addresses after deploying MultiPathQuoter contract
  //
  // Deployment command:
  //   npx hardhat run scripts/deploy-multi-path-quoter.ts --network <chain>
  //
  // After deployment, update the address below:
  //   ethereum: '0x<deployed_address>',
  //
  // Or set via environment variables (recommended):
  //   MULTI_PATH_QUOTER_ETHEREUM=0x...
  //   MULTI_PATH_QUOTER_ARBITRUM=0x...
  //   MULTI_PATH_QUOTER_BASE=0x...

  // Mainnet deployments
  // ethereum: '',  // Not yet deployed - uses fallback
  // arbitrum: '',  // Not yet deployed - uses fallback
  // base: '',      // Not yet deployed - uses fallback
  // optimism: '',  // Not yet deployed - uses fallback
  // polygon: '',   // Not yet deployed - uses fallback
  // bsc: '',       // Not yet deployed - uses fallback
  // avalanche: '', // Not yet deployed - uses fallback
  // fantom: '',    // Not yet deployed - uses fallback

  // Note: zkSync and Linea require separate contract deployment due to
  // different EVM compatibility. See docs/deployment/l2-contracts.md

  // Testnet deployments (for development/testing)
  // sepolia: '',
  // arbitrum_sepolia: '',
  // base_sepolia: '',
};

/**
 * Check if MultiPathQuoter is deployed for a chain.
 * @param chainId - Chain identifier
 * @returns true if quoter is deployed and configured
 */
export function hasMultiPathQuoter(chainId: string): boolean {
  const address = MULTI_PATH_QUOTER_ADDRESSES[chainId.toLowerCase()];
  return address !== undefined && address !== '' && address !== '0x0000000000000000000000000000000000000000';
}

/**
 * Get MultiPathQuoter address for a chain.
 * @param chainId - Chain identifier
 * @returns Contract address or undefined if not deployed
 */
export function getMultiPathQuoterAddress(chainId: string): string | undefined {
  const address = MULTI_PATH_QUOTER_ADDRESSES[chainId.toLowerCase()];
  if (!address || address === '' || address === '0x0000000000000000000000000000000000000000') {
    return undefined;
  }
  return address;
}
