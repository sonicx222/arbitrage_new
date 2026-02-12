/**
 * Service Configuration
 *
 * Service configs, flash loan providers, and bridge costs.
 *
 * @see P1-4: Flash loan provider configuration
 * @see P1-5: Bridge cost configuration
 */

import { AAVE_V3_POOLS, BALANCER_V2_VAULTS, COMMIT_REVEAL_CONTRACTS, hasCommitRevealContract, PANCAKESWAP_V3_FACTORIES, SYNCSWAP_VAULTS } from './addresses';

// =============================================================================
// FLASH LOAN CONSTANTS (Fix 1.1: Centralized constants)
// =============================================================================

/**
 * Aave V3 flash loan fee in basis points (0.09% = 9 bps)
 * Used by both FlashLoanStrategy and AaveV3FlashLoanProvider
 *
 * @see https://docs.aave.com/developers/guides/flash-loans
 */
export const AAVE_V3_FEE_BPS = 9;

/**
 * Basis points denominator (10000 = 100%)
 * Used for fee calculations: feeAmount = amount * feeBps / BPS_DENOMINATOR
 */
export const BPS_DENOMINATOR = 10000;

/**
 * Pre-computed BigInt versions for hot-path optimization
 * Avoids repeated BigInt conversion in performance-critical code
 *
 * FIX: Converted to lazy-loaded functions to avoid Jest BigInt serialization errors.
 * Jest workers serialize modules for communication, and JSON.stringify cannot serialize BigInt.
 * Functions are not serialized by Jest, so this avoids the "Do not know how to serialize a BigInt" error.
 */
export const getAaveV3FeeBpsBigInt = (): bigint => BigInt(AAVE_V3_FEE_BPS);
export const getBpsDenominatorBigInt = (): bigint => BigInt(BPS_DENOMINATOR);

/**
 * FlashLoanArbitrage contract ABI (minimal for execution)
 * Fix 9.2: Consolidated to single location for reuse
 *
 * ## Function Documentation
 *
 * ### executeArbitrage
 * Executes flash loan arbitrage with provided swap path.
 * Reverts if profit < minProfit or if any swap fails.
 *
 * ### calculateExpectedProfit (Fix 2.1: Enhanced documentation)
 * Returns `(uint256 expectedProfit, uint256 flashLoanFee)`:
 * - `expectedProfit`: Expected profit in asset units (0 if unprofitable or invalid path)
 * - `flashLoanFee`: Flash loan fee (0.09% of loan amount)
 *
 * **When `expectedProfit` returns 0, check these common causes:**
 * 1. Invalid swap path (tokenIn/tokenOut mismatch between steps)
 * 2. Router's getAmountsOut() call failed (pair doesn't exist, low liquidity)
 * 3. Final token doesn't match the starting asset (path doesn't loop back)
 * 4. Expected output is less than loan repayment amount (unprofitable)
 *
 * **Important distinction:**
 * - The function returns 0 for BOTH invalid paths AND valid-but-unprofitable paths
 * - To distinguish: a valid path with 0 profit means the swap would succeed but not be profitable
 * - An invalid path means the swap would revert on-chain
 *
 * @see contracts/src/FlashLoanArbitrage.sol
 */
export const FLASH_LOAN_ARBITRAGE_ABI: string[] = [
  'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
  'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function isApprovedRouter(address router) external view returns (bool)',
  'function POOL() external view returns (address)',
];

/**
 * ABI for BalancerV2FlashArbitrage contract.
 * Minimal ABI containing only the functions needed for flash loan execution.
 *
 * **Function signatures:**
 * - `executeArbitrage(asset, amount, swapPath, minProfit, deadline)`: Execute flash loan arbitrage
 * - `calculateExpectedProfit(asset, amount, swapPath)`: Simulate arbitrage and calculate profit
 * - `isApprovedRouter(router)`: Check if router is approved for swaps
 * - `VAULT()`: Get the Balancer V2 Vault address
 *
 * **Key differences from Aave V3:**
 * - Uses VAULT() instead of POOL()
 * - Flash loan fee is always 0 (Balancer V2 doesn't charge flash loan fees)
 * - Same swap execution logic and validation
 *
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */
export const BALANCER_V2_FLASH_ARBITRAGE_ABI: string[] = [
  'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
  'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function isApprovedRouter(address router) external view returns (bool)',
  'function VAULT() external view returns (address)',
];

/**
 * Balancer V2 flash loan fee (0 basis points = 0%)
 * Balancer V2 charges no fees for flash loans, unlike Aave V3's 0.09%.
 */
export const BALANCER_V2_FEE_BPS = 0;

/**
 * SyncSwap flash loan fee in basis points (0.3% = 30 bps)
 * Used by SyncSwapFlashLoanProvider for fee calculations.
 *
 * SyncSwap charges 0.3% flash loan fee (higher than Balancer's 0%, lower than Aave's 0.09%).
 * Fee is applied to surplus balance after flash loan repayment.
 *
 * @see https://syncswap.xyz/
 * @see docs/syncswap_api_dpcu.md
 */
export const SYNCSWAP_FEE_BPS = 30;

/**
 * Pre-computed BigInt version for hot-path optimization.
 *
 * FIX: Converted to lazy-loaded function to avoid Jest BigInt serialization errors.
 * Jest workers serialize modules for communication, and JSON.stringify cannot serialize BigInt.
 * Functions are not serialized by Jest, so this avoids the "Do not know how to serialize a BigInt" error.
 */
export const getSyncSwapFeeBpsBigInt = (): bigint => BigInt(SYNCSWAP_FEE_BPS);

/**
 * SyncSwapFlashArbitrage contract ABI (minimal for execution).
 * Supports EIP-3156 compliant flash loans with 0.3% fee.
 *
 * ## Function Documentation
 *
 * ### executeArbitrage
 * Executes flash loan arbitrage using EIP-3156 interface.
 * Initiates flash loan from SyncSwap Vault and executes multi-hop swaps.
 *
 * ### calculateExpectedProfit
 * Returns `(uint256 expectedProfit, uint256 flashLoanFee)`:
 * - `expectedProfit`: Expected profit in asset units (0 if unprofitable or invalid path)
 * - `flashLoanFee`: Flash loan fee (0.3% of loan amount)
 *
 * **When `expectedProfit` returns 0:**
 * 1. Invalid swap path (tokenIn/tokenOut mismatch)
 * 2. Router's getAmountsOut() call failed
 * 3. Final token doesn't match starting asset
 * 4. Expected output < loan repayment (unprofitable)
 *
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 * @see contracts/src/interfaces/ISyncSwapVault.sol
 */
export const SYNCSWAP_FLASH_ARBITRAGE_ABI: string[] = [
  'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
  'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function isApprovedRouter(address router) external view returns (bool)',
  'function VAULT() external view returns (address)',
];

// =============================================================================
// SERVICE CONFIGURATIONS
// =============================================================================

/**
 * Check if running in production environment.
 * Production is detected by NODE_ENV=production or common production indicators.
 */
const isProduction = process.env.NODE_ENV === 'production' ||
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

// =============================================================================
// FEATURE FLAGS (Task 1.2: Batched Quoting)
// =============================================================================

/**
 * Feature flags for opt-in functionality.
 *
 * These flags allow safe incremental rollout of new features:
 * - Start with flag OFF (default behavior maintained)
 * - Enable for specific services/chains to test
 * - Gradually roll out to 100% if metrics show improvement
 * - Instant rollback by setting flag to false
 *
 * @see ADR-029: Batched Quote Fetching
 */
export const FEATURE_FLAGS = {
  /**
   * Enable batched quote fetching via MultiPathQuoter contract.
   *
   * When enabled and contract is deployed:
   * - Uses single RPC call for N-hop arbitrage paths (latency: ~50ms)
   * - Falls back to sequential quotes if contract unavailable
   *
   * When disabled (default):
   * - Uses existing sequential quote fetching (latency: ~150ms)
   *
   * Impact: 75-83% latency reduction for profit calculation
   *
   * @default false (safe rollout - explicitly opt-in)
   */
  useBatchedQuoter: process.env.FEATURE_BATCHED_QUOTER === 'true',

  /**
   * Enable flash loan protocol aggregator (Task 2.3).
   *
   * When enabled (default):
   * - Dynamically selects best flash loan provider via weighted ranking
   * - Validates liquidity with on-chain checks (5-min cache)
   * - Tracks provider metrics (success rate, latency)
   * - Supports automatic fallback on provider failures
   *
   * When disabled:
   * - Uses hardcoded Aave V3 provider (backward compatible)
   * - Set FEATURE_FLASH_LOAN_AGGREGATOR=false to disable
   *
   * Impact:
   * - Better fee optimization (select lowest-fee provider)
   * - Prevents insufficient liquidity failures
   * - Improves reliability via fallback mechanisms
   *
   * @default true (production-ready - opt-out to disable)
   * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
   */
  useFlashLoanAggregator: process.env.FEATURE_FLASH_LOAN_AGGREGATOR !== 'false',

  /**
   * Enable commit-reveal MEV protection (Task 3.1).
   *
   * When enabled (default):
   * - Automatically activates for high-risk transactions (sandwichRiskScore >= 70)
   * - Two-phase execution: commit hash → wait 1 block → reveal and execute
   * - Prevents sandwich attacks by hiding transaction parameters
   * - Fallback to standard execution if commit-reveal fails
   *
   * When disabled:
   * - Uses only private mempool (Flashbots/Jito) for MEV protection
   * - Set FEATURE_COMMIT_REVEAL=false to disable
   *
   * Impact:
   * - Additional MEV protection layer when private mempools unavailable
   * - +1 block latency for high-risk transactions (acceptable trade-off)
   * - Reduces sandwich attack risk from ~80% to ~5%
   *
   * Activates for:
   * - IntraChainStrategy with HIGH/CRITICAL MEV risk
   * - CrossChainStrategy with HIGH/CRITICAL MEV risk
   * - NOT used for FlashLoanStrategy (incompatible with flash loans)
   *
   * @default true (production-ready - opt-out to disable)
   * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 3 Task 3.1
   */
  useCommitReveal: process.env.FEATURE_COMMIT_REVEAL !== 'false',

  /**
   * Enable Redis storage for commit-reveal parameters.
   *
   * When enabled:
   * - Stores reveal parameters in Redis for persistence
   * - Enables multi-process coordination (shared state)
   * - Survives service restarts (commitment data preserved)
   * - Requires Redis connection (REDIS_URL env var)
   *
   * When disabled (default):
   * - Uses in-memory storage only (single-process)
   * - Lost on service restart (commitments abandoned)
   * - No Redis dependency (simpler deployment)
   * - Set FEATURE_COMMIT_REVEAL_REDIS=true to enable
   *
   * Impact:
   * - Redis enabled: Better reliability, multi-process support
   * - In-memory only: Simpler deployment, single-process only
   *
   * @default false (safe rollout - explicitly opt-in for Redis)
   * @see services/execution-engine/src/services/commit-reveal.service.ts
   */
  useCommitRevealRedis: process.env.FEATURE_COMMIT_REVEAL_REDIS === 'true',
};

/**
 * Flash Loan Aggregator Configuration (Task 2.3)
 *
 * Configuration for intelligent flash loan provider selection.
 * Read from environment variables with safe defaults.
 */
export const FLASH_LOAN_AGGREGATOR_CONFIG = {
  /**
   * Weighted scoring weights (must sum to 1.0)
   * Controls how providers are ranked
   */
  weights: {
    fees: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_FEES ?? '0.5'),
    liquidity: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_LIQUIDITY ?? '0.3'),
    reliability: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_RELIABILITY ?? '0.15'),
    latency: parseFloat(process.env.FLASH_LOAN_AGGREGATOR_WEIGHT_LATENCY ?? '0.05'),
  },

  /**
   * Maximum providers to rank per selection
   * Higher = more options but slower selection
   * @default 3
   */
  maxProvidersToRank: parseInt(process.env.FLASH_LOAN_AGGREGATOR_MAX_PROVIDERS ?? '3', 10),

  /**
   * Enable on-chain liquidity validation
   * When true, validates pool liquidity before execution
   * @default true (if aggregator enabled)
   */
  enableLiquidityValidation: process.env.FLASH_LOAN_AGGREGATOR_LIQUIDITY_VALIDATION !== 'false',

  /**
   * Liquidity check threshold in USD
   * Only check liquidity for opportunities above this value
   * @default 100000 ($100K)
   */
  liquidityCheckThresholdUsd: parseInt(process.env.FLASH_LOAN_AGGREGATOR_LIQUIDITY_THRESHOLD_USD ?? '100000', 10),
};

/**
 * Validation state to ensure validation runs only once per process.
 * Prevents duplicate warnings in test environments or when module is
 * imported multiple times.
 */
let _featureFlagValidationRun = false;

/**
 * Validate feature flag configuration and log warnings/info.
 *
 * FIX (Issue 2.3): This function now auto-runs on module load (deferred via setTimeout)
 * to catch misconfigurations early. Services can still call it explicitly with a custom
 * logger for better integration.
 *
 * Auto-run behavior:
 * - Runs automatically after module load (unless DISABLE_CONFIG_VALIDATION=true)
 * - Falls back to console logging if not called explicitly
 * - Validation guard prevents duplicate runs
 * - In production, exits process on critical errors
 *
 * Manual call benefits:
 * - Use proper logger instead of console
 * - Better integration with service logging
 * - Control timing of validation
 *
 * @param logger - Logger instance (optional - falls back to console if not provided)
 *
 * @example
 * ```typescript
 * // In service startup (e.g., execution-engine/src/index.ts)
 * import { validateFeatureFlags } from '@arbitrage/config';
 *
 * async function startService() {
 *   const logger = createLogger('execution-engine');
 *   validateFeatureFlags(logger); // Validate once at startup with custom logger
 *   // ... start service ...
 * }
 * ```
 */
export function validateFeatureFlags(logger?: { warn: (msg: string, meta?: unknown) => void; info: (msg: string, meta?: unknown) => void; error?: (msg: string, meta?: unknown) => void }): void {
  // Run validation once per process
  if (_featureFlagValidationRun) {
    return;
  }
  _featureFlagValidationRun = true;

  // Validate batched quoter feature
  if (FEATURE_FLAGS.useBatchedQuoter) {
    const deployedChains = Object.keys(MULTI_PATH_QUOTER_ADDRESSES).filter((chain) =>
      hasMultiPathQuoter(chain)
    );

    if (deployedChains.length === 0) {
      const message =
        'FEATURE_BATCHED_QUOTER is enabled but no MultiPathQuoter contracts are deployed. ' +
        'Batched quoting will fall back to sequential quotes on all chains.';

      const details = {
        deployScript: 'npx hardhat run scripts/deploy-multi-path-quoter.ts --network <chain>',
        envVarsNeeded: 'MULTI_PATH_QUOTER_ETHEREUM, MULTI_PATH_QUOTER_ARBITRUM, etc.',
      };

      if (logger) {
        logger.warn(message, details);
      } else {
        console.warn(`⚠️  WARNING: ${message}`, details);
      }
    } else {
      const message = `Batched quoting enabled for chains: ${deployedChains.join(', ')}`;
      if (logger) {
        logger.info(message, { chains: deployedChains });
      } else {
        console.info(`✅ ${message}`);
      }
    }
  }

  // Validate flash loan aggregator feature (C3 fix)
  if (FEATURE_FLAGS.useFlashLoanAggregator) {
    const message = 'Flash Loan Protocol Aggregator enabled - will dynamically select optimal provider';
    if (logger) {
      logger.info(message, {
        weights: FLASH_LOAN_AGGREGATOR_CONFIG.weights,
        liquidityThreshold: FLASH_LOAN_AGGREGATOR_CONFIG.liquidityCheckThresholdUsd,
      });
    } else {
      console.info(`✅ ${message}`);
    }
  } else {
    const message =
      'Flash Loan Protocol Aggregator DISABLED - using hardcoded Aave V3 provider only. ' +
      'Set FEATURE_FLASH_LOAN_AGGREGATOR=true to enable dynamic provider selection.';
    if (logger) {
      logger.warn(message);
    } else {
      console.warn(`⚠️  WARNING: ${message}`);
    }
  }

  // Validate commit-reveal feature (Task 3.1)
  if (FEATURE_FLAGS.useCommitReveal) {
    const deployedChains = Object.keys(COMMIT_REVEAL_CONTRACTS).filter((chain) =>
      hasCommitRevealContract(chain)
    );

    if (deployedChains.length === 0) {
      const message =
        'FEATURE_COMMIT_REVEAL is enabled but no CommitRevealArbitrage contracts are deployed. ' +
        'Commit-reveal protection will be unavailable for high-risk transactions.';

      const details = {
        deployScript: 'npx hardhat run scripts/deploy-commit-reveal.ts --network <chain>',
        envVarsNeeded: 'COMMIT_REVEAL_CONTRACT_ETHEREUM, COMMIT_REVEAL_CONTRACT_ARBITRUM, etc.',
      };

      if (logger) {
        logger.warn(message, details);
      } else {
        console.warn(`⚠️  WARNING: ${message}`, details);
      }
    } else {
      const storageMode = FEATURE_FLAGS.useCommitRevealRedis ? 'Redis (persistent)' : 'In-memory (ephemeral)';
      const message = `Commit-reveal MEV protection enabled for chains: ${deployedChains.join(', ')} [Storage: ${storageMode}]`;
      if (logger) {
        logger.info(message, {
          chains: deployedChains,
          storageMode,
          redisEnabled: FEATURE_FLAGS.useCommitRevealRedis
        });
      } else {
        console.info(`✅ ${message}`);
      }
    }

    // Validate Redis configuration if Redis storage is enabled
    if (FEATURE_FLAGS.useCommitRevealRedis) {
      if (!process.env.REDIS_URL) {
        const message =
          'FEATURE_COMMIT_REVEAL_REDIS is enabled but REDIS_URL is not set. ' +
          'Commit-reveal will fall back to in-memory storage.';

        // In production, this is a critical error (multi-process coordination requires Redis)
        if (isProduction) {
          const error = new Error(
            `${message}\n\n` +
            `CRITICAL: In production with multi-process deployment, Redis is required for commit-reveal.\n` +
            `Either set REDIS_URL or disable Redis storage with FEATURE_COMMIT_REVEAL_REDIS=false.`
          );
          if (logger?.error) {
            logger.error(message, { fallbackMode: 'in-memory', severity: 'CRITICAL' });
          }
          throw error;
        }

        // In development, warn only
        if (logger) {
          logger.warn(message, { fallbackMode: 'in-memory' });
        } else {
          console.warn(`⚠️  WARNING: ${message}`);
        }
      }
    }
  } else {
    const message =
      'Commit-Reveal MEV Protection DISABLED - high-risk transactions will use only private mempools. ' +
      'Set FEATURE_COMMIT_REVEAL=true to enable commit-reveal protection as fallback.';
    if (logger) {
      logger.warn(message);
    } else {
      console.warn(`⚠️  WARNING: ${message}`);
    }
  }
}

// =============================================================================
// AUTO-VALIDATION ON MODULE LOAD (FIX: Issue 2.3)
// =============================================================================

/**
 * Auto-run validation on module load with opt-out.
 *
 * FIX (Issue 2.3): Automatically validate configuration on module load to catch
 * misconfigurations early. Services can still call validateFeatureFlags() explicitly
 * with a logger for better integration, but this ensures validation runs even if forgotten.
 *
 * Design:
 * - Uses setTimeout(0) to defer execution after module load completes
 * - Can be disabled via DISABLE_CONFIG_VALIDATION=true (for tests)
 * - Validation guard prevents duplicate runs
 * - Falls back to console logging if no explicit logger provided
 * - In production with critical errors, exits process to fail fast
 *
 * Why deferred (setTimeout):
 * - Avoids blocking module load
 * - Allows services to call validateFeatureFlags() first if they want
 * - Still catches forgotten calls before service actually starts
 *
 * @see validateFeatureFlags() for manual validation with custom logger
 */
if (process.env.DISABLE_CONFIG_VALIDATION !== 'true') {
  // Defer validation to allow services to call validateFeatureFlags() first
  setTimeout(() => {
    // If validation hasn't run yet, run it now with console fallback
    if (!_featureFlagValidationRun) {
      try {
        validateFeatureFlags(); // Will use console.log/warn
      } catch (error) {
        // Log critical validation errors
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('❌ CRITICAL CONFIGURATION ERROR:', errorMessage);

        // In production, fail fast to prevent running with invalid config
        if (process.env.NODE_ENV === 'production') {
          console.error('Exiting process due to configuration error in production mode');
          process.exit(1);
        }
      }
    }
  }, 0);
}

// =============================================================================
// BRIDGE COST CONFIGURATION (P1-5 FIX)
// =============================================================================

/**
 * P1-5 FIX: Bridge cost configuration to replace hardcoded multipliers.
 * Fees are in basis points (1 bp = 0.01%). Latency in seconds.
 *
 * Data sources:
 * - Stargate: https://stargate.finance/bridge (fees vary by route)
 * - Across: https://across.to/ (dynamic fees)
 * - LayerZero: https://layerzero.network/ (gas-dependent fees)
 *
 * Note: These are baseline estimates. Production should use real-time API data.
 */
export interface BridgeCostConfig {
  bridge: string;
  sourceChain: string;
  targetChain: string;
  /**
   * Fee in basis points (6 = 0.06%). Use bpsToDecimal() from @arbitrage/core to convert.
   * @example 6 bps = 0.06%, 4 bps = 0.04%, 0 bps = 0%
   */
  feeBps: number;
  /**
   * @deprecated Use `feeBps` instead. Will be removed in v2.0.0.
   * Legacy field: feePercentage where 0.06 means 0.06%
   */
  feePercentage?: number;
  minFeeUsd: number;      // Minimum fee in USD
  estimatedLatencySeconds: number;
  reliability: number;    // 0-1 scale
}

export const BRIDGE_COSTS: BridgeCostConfig[] = [
  // Stargate (LayerZero) - Good for stablecoins
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'arbitrum', feeBps: 6, feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'optimism', feeBps: 6, feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'polygon', feeBps: 6, feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'bsc', feeBps: 6, feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'base', feeBps: 6, feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'ethereum', feeBps: 6, feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'optimism', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'base', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // Across Protocol - Fast with relayer model
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'arbitrum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'optimism', feeBps: 4, feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'polygon', feeBps: 4, feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'base', feeBps: 4, feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'ethereum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'optimism', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'optimism', targetChain: 'arbitrum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'base', targetChain: 'arbitrum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },

  // Native bridges (L2 -> L1 are slower)
  { bridge: 'native', sourceChain: 'arbitrum', targetChain: 'ethereum', feeBps: 0, feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'optimism', targetChain: 'ethereum', feeBps: 0, feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'base', targetChain: 'ethereum', feeBps: 0, feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days

  // S3.2.1-FIX: Avalanche bridge routes (Stargate supports Avalanche)
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'avalanche', feeBps: 6, feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'avalanche', targetChain: 'ethereum', feeBps: 6, feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'avalanche', targetChain: 'arbitrum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'avalanche', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // S3.2.2-FIX: Fantom bridge routes (Stargate supports Fantom)
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'fantom', feeBps: 6, feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'fantom', targetChain: 'ethereum', feeBps: 6, feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'fantom', targetChain: 'arbitrum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'fantom', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // S3.1.2-FIX: zkSync bridge routes (native bridge + Across)
  { bridge: 'native', sourceChain: 'ethereum', targetChain: 'zksync', feeBps: 0, feePercentage: 0.0, minFeeUsd: 3, estimatedLatencySeconds: 900, reliability: 0.99 }, // ~15 min
  { bridge: 'native', sourceChain: 'zksync', targetChain: 'ethereum', feeBps: 0, feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 86400, reliability: 0.99 }, // ~24 hours
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'zksync', feeBps: 5, feePercentage: 0.05, minFeeUsd: 2, estimatedLatencySeconds: 180, reliability: 0.96 },
  { bridge: 'across', sourceChain: 'zksync', targetChain: 'ethereum', feeBps: 5, feePercentage: 0.05, minFeeUsd: 2, estimatedLatencySeconds: 180, reliability: 0.96 },

  // S3.1.2-FIX: Linea bridge routes (native bridge + Across)
  { bridge: 'native', sourceChain: 'ethereum', targetChain: 'linea', feeBps: 0, feePercentage: 0.0, minFeeUsd: 3, estimatedLatencySeconds: 1200, reliability: 0.99 }, // ~20 min
  { bridge: 'native', sourceChain: 'linea', targetChain: 'ethereum', feeBps: 0, feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 28800, reliability: 0.99 }, // ~8 hours
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'linea', feeBps: 4, feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'linea', targetChain: 'ethereum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },

  // S3.3.7-FIX: Solana bridge routes (Wormhole is primary Solana ↔ EVM bridge)
  { bridge: 'wormhole', sourceChain: 'ethereum', targetChain: 'solana', feeBps: 10, feePercentage: 0.1, minFeeUsd: 5, estimatedLatencySeconds: 300, reliability: 0.92 },
  { bridge: 'wormhole', sourceChain: 'solana', targetChain: 'ethereum', feeBps: 10, feePercentage: 0.1, minFeeUsd: 5, estimatedLatencySeconds: 300, reliability: 0.92 },
  { bridge: 'wormhole', sourceChain: 'arbitrum', targetChain: 'solana', feeBps: 8, feePercentage: 0.08, minFeeUsd: 3, estimatedLatencySeconds: 240, reliability: 0.92 },
  { bridge: 'wormhole', sourceChain: 'solana', targetChain: 'arbitrum', feeBps: 8, feePercentage: 0.08, minFeeUsd: 3, estimatedLatencySeconds: 240, reliability: 0.92 },

  // Phase 4: Connext bridge routes (liquidity network + optimistic messaging)
  // Data source: https://bridge.connext.network/ - 0.03-0.05% fee, 60-120s latency
  // Connext uses a hub-and-spoke model with liquidity pools and fast path for common routes
  // Research impact: +5-8% more cross-chain opportunities
  { bridge: 'connext', sourceChain: 'ethereum', targetChain: 'arbitrum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 1, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'ethereum', targetChain: 'optimism', feeBps: 3, feePercentage: 0.03, minFeeUsd: 1, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'ethereum', targetChain: 'polygon', feeBps: 3, feePercentage: 0.03, minFeeUsd: 1, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'ethereum', targetChain: 'bsc', feeBps: 4, feePercentage: 0.04, minFeeUsd: 1.5, estimatedLatencySeconds: 120, reliability: 0.95 },
  { bridge: 'connext', sourceChain: 'ethereum', targetChain: 'base', feeBps: 3, feePercentage: 0.03, minFeeUsd: 1, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'arbitrum', targetChain: 'ethereum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'arbitrum', targetChain: 'optimism', feeBps: 3, feePercentage: 0.025, minFeeUsd: 0.3, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'connext', sourceChain: 'arbitrum', targetChain: 'polygon', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'arbitrum', targetChain: 'base', feeBps: 3, feePercentage: 0.025, minFeeUsd: 0.3, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'connext', sourceChain: 'optimism', targetChain: 'ethereum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'optimism', targetChain: 'arbitrum', feeBps: 3, feePercentage: 0.025, minFeeUsd: 0.3, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'connext', sourceChain: 'optimism', targetChain: 'polygon', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'optimism', targetChain: 'base', feeBps: 3, feePercentage: 0.025, minFeeUsd: 0.3, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'connext', sourceChain: 'polygon', targetChain: 'ethereum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'polygon', targetChain: 'arbitrum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'polygon', targetChain: 'optimism', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'base', targetChain: 'ethereum', feeBps: 3, feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.96 },
  { bridge: 'connext', sourceChain: 'base', targetChain: 'arbitrum', feeBps: 3, feePercentage: 0.025, minFeeUsd: 0.3, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'connext', sourceChain: 'base', targetChain: 'optimism', feeBps: 3, feePercentage: 0.025, minFeeUsd: 0.3, estimatedLatencySeconds: 60, reliability: 0.97 },

  // Phase 3: Hyperlane bridge routes (permissionless interoperability)
  // Data source: https://www.hyperlane.xyz/ - 0.05% fee, 100-300s latency
  // Hyperlane supports interchain messaging with customizable security modules
  { bridge: 'hyperlane', sourceChain: 'ethereum', targetChain: 'arbitrum', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1.5, estimatedLatencySeconds: 120, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'ethereum', targetChain: 'optimism', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1.5, estimatedLatencySeconds: 120, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'ethereum', targetChain: 'polygon', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1.5, estimatedLatencySeconds: 150, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'ethereum', targetChain: 'base', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1.5, estimatedLatencySeconds: 120, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'ethereum', targetChain: 'avalanche', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1.5, estimatedLatencySeconds: 180, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'ethereum', targetChain: 'bsc', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1.5, estimatedLatencySeconds: 180, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'arbitrum', targetChain: 'ethereum', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'arbitrum', targetChain: 'optimism', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'arbitrum', targetChain: 'base', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'arbitrum', targetChain: 'polygon', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 120, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'optimism', targetChain: 'ethereum', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'optimism', targetChain: 'arbitrum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'optimism', targetChain: 'base', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'base', targetChain: 'ethereum', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'base', targetChain: 'arbitrum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'base', targetChain: 'optimism', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 90, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'polygon', targetChain: 'ethereum', feeBps: 5, feePercentage: 0.05, minFeeUsd: 1, estimatedLatencySeconds: 150, reliability: 0.94 },
  { bridge: 'hyperlane', sourceChain: 'polygon', targetChain: 'arbitrum', feeBps: 4, feePercentage: 0.04, minFeeUsd: 0.5, estimatedLatencySeconds: 120, reliability: 0.94 },
];

// =============================================================================
// BRIDGE COST LOOKUP CACHE (Performance Optimization)
// Pre-computed Map for O(1) lookups instead of O(n) filter operations
// FIX: Keys are pre-normalized to lowercase at build time for hot-path optimization
// =============================================================================
type BridgeCostKey = `${string}:${string}`; // sourceChain:targetChain (lowercase)
type BridgeCostKeyWithBridge = `${string}:${string}:${string}`; // sourceChain:targetChain:bridge (lowercase)

// Pre-computed map: route -> all bridge options for that route
const BRIDGE_COST_BY_ROUTE = new Map<BridgeCostKey, BridgeCostConfig[]>();
// Pre-computed map: route+bridge -> specific bridge config
const BRIDGE_COST_BY_ROUTE_AND_BRIDGE = new Map<BridgeCostKeyWithBridge, BridgeCostConfig>();
// Pre-computed map: route -> best (lowest fee) bridge option
const BEST_BRIDGE_BY_ROUTE = new Map<BridgeCostKey, BridgeCostConfig>();

// Initialize lookup maps at module load time (runs once)
// FIX: Pre-normalize all keys to lowercase to avoid per-lookup normalization
for (const config of BRIDGE_COSTS) {
  // Pre-normalize keys to lowercase (source data should already be lowercase, but this ensures consistency)
  const sourceNorm = config.sourceChain.toLowerCase();
  const targetNorm = config.targetChain.toLowerCase();
  const bridgeNorm = config.bridge.toLowerCase();

  const routeKey: BridgeCostKey = `${sourceNorm}:${targetNorm}`;
  const fullKey: BridgeCostKeyWithBridge = `${sourceNorm}:${targetNorm}:${bridgeNorm}`;

  // Build route -> options map
  const existing = BRIDGE_COST_BY_ROUTE.get(routeKey) || [];
  existing.push(config);
  BRIDGE_COST_BY_ROUTE.set(routeKey, existing);

  // Build route+bridge -> config map
  BRIDGE_COST_BY_ROUTE_AND_BRIDGE.set(fullKey, config);

  // Track best (lowest fee) bridge per route
  const currentBest = BEST_BRIDGE_BY_ROUTE.get(routeKey);
  if (!currentBest || config.feeBps < currentBest.feeBps) {
    BEST_BRIDGE_BY_ROUTE.set(routeKey, config);
  }
}

/**
 * P1-5 FIX: Get bridge cost for a specific route
 * Performance optimized with O(1) Map lookup instead of O(n) filter
 */
export function getBridgeCost(
  sourceChain: string,
  targetChain: string,
  bridge?: string
): BridgeCostConfig | undefined {
  const normalizedSource = sourceChain.toLowerCase();
  const normalizedTarget = targetChain.toLowerCase();
  const routeKey: BridgeCostKey = `${normalizedSource}:${normalizedTarget}`;

  if (bridge) {
    const fullKey: BridgeCostKeyWithBridge = `${normalizedSource}:${normalizedTarget}:${bridge.toLowerCase()}`;
    return BRIDGE_COST_BY_ROUTE_AND_BRIDGE.get(fullKey);
  }

  // Return pre-computed best bridge (lowest fee)
  return BEST_BRIDGE_BY_ROUTE.get(routeKey);
}

/**
 * Get all bridge options for a route (for comparison/display)
 * Performance optimized with O(1) Map lookup
 */
export function getAllBridgeOptions(
  sourceChain: string,
  targetChain: string
): BridgeCostConfig[] {
  const normalizedSource = sourceChain.toLowerCase();
  const normalizedTarget = targetChain.toLowerCase();
  const routeKey: BridgeCostKey = `${normalizedSource}:${normalizedTarget}`;

  return BRIDGE_COST_BY_ROUTE.get(routeKey) || [];
}

/**
 * P1-5 FIX: Calculate bridge cost for a given USD amount
 */
export function calculateBridgeCostUsd(
  sourceChain: string,
  targetChain: string,
  amountUsd: number,
  bridge?: string
): { fee: number; latency: number; bridge: string } | undefined {
  const config = getBridgeCost(sourceChain, targetChain, bridge);
  if (!config) return undefined;

  // Convert feeBps to decimal: 6 bps = 0.06% = 0.0006
  const percentageFee = amountUsd * (config.feeBps / 10000);
  const fee = Math.max(percentageFee, config.minFeeUsd);

  return {
    fee,
    latency: config.estimatedLatencySeconds,
    bridge: config.bridge
  };
}

// =============================================================================
// HOT-PATH OPTIMIZED FUNCTIONS (skip normalization for performance)
// Use these when you KNOW your input strings are already lowercase
// =============================================================================

/**
 * Fast-path version of getBridgeCost - skips toLowerCase() normalization.
 * Use when input strings are guaranteed to be lowercase (e.g., from CHAINS config).
 * @param sourceChain - Source chain (MUST be lowercase)
 * @param targetChain - Target chain (MUST be lowercase)
 * @param bridge - Optional bridge name (MUST be lowercase if provided)
 */
export function getBridgeCostFast(
  sourceChain: string,
  targetChain: string,
  bridge?: string
): BridgeCostConfig | undefined {
  const routeKey: BridgeCostKey = `${sourceChain}:${targetChain}`;

  if (bridge) {
    const fullKey: BridgeCostKeyWithBridge = `${sourceChain}:${targetChain}:${bridge}`;
    return BRIDGE_COST_BY_ROUTE_AND_BRIDGE.get(fullKey);
  }

  return BEST_BRIDGE_BY_ROUTE.get(routeKey);
}

/**
 * Fast-path version of getAllBridgeOptions - skips toLowerCase() normalization.
 * @param sourceChain - Source chain (MUST be lowercase)
 * @param targetChain - Target chain (MUST be lowercase)
 */
export function getAllBridgeOptionsFast(
  sourceChain: string,
  targetChain: string
): BridgeCostConfig[] {
  const routeKey: BridgeCostKey = `${sourceChain}:${targetChain}`;
  return BRIDGE_COST_BY_ROUTE.get(routeKey) || [];
}

// =============================================================================
// PHASE 3: DYNAMIC BRIDGE SELECTION ALGORITHM
// Multi-factor scoring considering latency, cost, and reliability
// =============================================================================

/**
 * Urgency level for bridge selection.
 * Affects weighting of latency vs cost in scoring.
 */
export type BridgeUrgency = 'low' | 'medium' | 'high';

/**
 * Result from dynamic bridge selection.
 */
export interface OptimalBridgeResult {
  config: BridgeCostConfig;
  score: number;
  normalizedLatency: number;
  normalizedCost: number;
  reliabilityScore: number;
}

/**
 * Phase 3: Urgency-based weight configuration for bridge scoring.
 *
 * - High urgency: Prioritize latency (time-sensitive arbitrage)
 * - Medium urgency: Balanced approach
 * - Low urgency: Prioritize cost savings
 */
const BRIDGE_SCORE_WEIGHTS: Record<BridgeUrgency, {
  latency: number;
  cost: number;
  reliability: number;
}> = {
  high: { latency: 0.6, cost: 0.2, reliability: 0.2 },
  medium: { latency: 0.35, cost: 0.4, reliability: 0.25 },
  low: { latency: 0.15, cost: 0.55, reliability: 0.3 },
};

/**
 * Maximum reasonable latency for normalization (1 hour).
 * Bridges slower than this are heavily penalized.
 */
const MAX_REASONABLE_LATENCY_SECONDS = 3600;

/**
 * Phase 3: Select optimal bridge using multi-factor scoring.
 *
 * Unlike `getBridgeCost()` which always returns lowest-fee bridge,
 * this function considers:
 * - Latency (weighted by urgency)
 * - Cost (fee percentage + minimum fee)
 * - Reliability (historical success rate)
 *
 * Research impact: +3-5% net profit per trade from better bridge selection.
 *
 * @param sourceChain - Source chain
 * @param targetChain - Target chain
 * @param tradeSizeUsd - Trade size in USD (affects cost calculation)
 * @param urgency - How time-sensitive the opportunity is
 * @returns Optimal bridge config with scoring details, or undefined if no routes
 */
export function selectOptimalBridge(
  sourceChain: string,
  targetChain: string,
  tradeSizeUsd: number = 1000,
  urgency: BridgeUrgency = 'medium'
): OptimalBridgeResult | undefined {
  const options = getAllBridgeOptions(sourceChain, targetChain);

  if (options.length === 0) {
    return undefined;
  }

  // If only one option, return it directly
  if (options.length === 1) {
    const config = options[0];
    return {
      config,
      score: 1.0,
      // FIX P3-001: Clamp to [0,1] range - native bridges can have latency > MAX_REASONABLE_LATENCY
      normalizedLatency: Math.max(0, 1.0 - (config.estimatedLatencySeconds / MAX_REASONABLE_LATENCY_SECONDS)),
      normalizedCost: 1.0, // Best by default
      reliabilityScore: config.reliability,
    };
  }

  const weights = BRIDGE_SCORE_WEIGHTS[urgency];
  let bestResult: OptimalBridgeResult | undefined;
  let bestScore = -1;

  // Find min/max values for normalization
  let minLatency = Infinity;
  let maxLatency = 0;
  let minCost = Infinity;
  let maxCost = 0;

  // Calculate actual costs for each bridge (feeBps / 10000 to get decimal)
  const bridgeCosts = options.map(opt => {
    const percentageFee = tradeSizeUsd * (opt.feeBps / 10000);
    return Math.max(percentageFee, opt.minFeeUsd);
  });

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const cost = bridgeCosts[i];

    minLatency = Math.min(minLatency, opt.estimatedLatencySeconds);
    maxLatency = Math.max(maxLatency, opt.estimatedLatencySeconds);
    minCost = Math.min(minCost, cost);
    maxCost = Math.max(maxCost, cost);
  }

  // Score each bridge option
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const cost = bridgeCosts[i];

    // Normalize latency (lower is better, 0-1 scale, capped at max reasonable)
    // normalizedLatency = 1.0 means instant, 0.0 means >= MAX_REASONABLE_LATENCY
    const cappedLatency = Math.min(opt.estimatedLatencySeconds, MAX_REASONABLE_LATENCY_SECONDS);
    let normalizedLatency: number;
    if (maxLatency === minLatency) {
      normalizedLatency = 1.0;
    } else {
      // Invert so lower latency = higher score
      normalizedLatency = 1.0 - ((cappedLatency - minLatency) / (maxLatency - minLatency));
    }

    // Normalize cost (lower is better, 0-1 scale)
    let normalizedCost: number;
    if (maxCost === minCost) {
      normalizedCost = 1.0;
    } else {
      // Invert so lower cost = higher score
      normalizedCost = 1.0 - ((cost - minCost) / (maxCost - minCost));
    }

    // Reliability is already 0-1 scale
    const reliabilityScore = opt.reliability;

    // Calculate weighted score
    const score = (
      weights.latency * normalizedLatency +
      weights.cost * normalizedCost +
      weights.reliability * reliabilityScore
    );

    if (score > bestScore) {
      bestScore = score;
      bestResult = {
        config: opt,
        score,
        normalizedLatency,
        normalizedCost,
        reliabilityScore,
      };
    }
  }

  return bestResult;
}

/**
 * Phase 3: Fast-path version of selectOptimalBridge.
 * Skips toLowerCase() normalization - use when inputs are guaranteed lowercase.
 */
export function selectOptimalBridgeFast(
  sourceChain: string,
  targetChain: string,
  tradeSizeUsd: number = 1000,
  urgency: BridgeUrgency = 'medium'
): OptimalBridgeResult | undefined {
  const options = getAllBridgeOptionsFast(sourceChain, targetChain);

  if (options.length === 0) {
    return undefined;
  }

  // If only one option, return it directly
  if (options.length === 1) {
    const config = options[0];
    return {
      config,
      score: 1.0,
      // FIX P3-001: Clamp to [0,1] range - native bridges can have latency > MAX_REASONABLE_LATENCY
      normalizedLatency: Math.max(0, 1.0 - (config.estimatedLatencySeconds / MAX_REASONABLE_LATENCY_SECONDS)),
      normalizedCost: 1.0,
      reliabilityScore: config.reliability,
    };
  }

  const weights = BRIDGE_SCORE_WEIGHTS[urgency];
  let bestResult: OptimalBridgeResult | undefined;
  let bestScore = -1;

  // Pre-compute costs and find ranges
  const bridgeCosts: number[] = [];
  let minLatency = Infinity;
  let maxLatency = 0;
  let minCost = Infinity;
  let maxCost = 0;

  for (const opt of options) {
    const percentageFee = tradeSizeUsd * (opt.feeBps / 10000);
    const cost = Math.max(percentageFee, opt.minFeeUsd);
    bridgeCosts.push(cost);

    minLatency = Math.min(minLatency, opt.estimatedLatencySeconds);
    maxLatency = Math.max(maxLatency, opt.estimatedLatencySeconds);
    minCost = Math.min(minCost, cost);
    maxCost = Math.max(maxCost, cost);
  }

  // Score each option
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const cost = bridgeCosts[i];

    const cappedLatency = Math.min(opt.estimatedLatencySeconds, MAX_REASONABLE_LATENCY_SECONDS);
    const normalizedLatency = maxLatency === minLatency
      ? 1.0
      : 1.0 - ((cappedLatency - minLatency) / (maxLatency - minLatency));

    const normalizedCost = maxCost === minCost
      ? 1.0
      : 1.0 - ((cost - minCost) / (maxCost - minCost));

    const reliabilityScore = opt.reliability;

    const score = (
      weights.latency * normalizedLatency +
      weights.cost * normalizedCost +
      weights.reliability * reliabilityScore
    );

    if (score > bestScore) {
      bestScore = score;
      bestResult = {
        config: opt,
        score,
        normalizedLatency,
        normalizedCost,
        reliabilityScore,
      };
    }
  }

  return bestResult;
}

