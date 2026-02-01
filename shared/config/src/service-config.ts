/**
 * Service Configuration
 *
 * Service configs, flash loan providers, and bridge costs.
 *
 * @see P1-4: Flash loan provider configuration
 * @see P1-5: Bridge cost configuration
 */

import { AAVE_V3_POOLS } from './addresses';

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
 */
export const AAVE_V3_FEE_BPS_BIGINT = BigInt(AAVE_V3_FEE_BPS);
export const BPS_DENOMINATOR_BIGINT = BigInt(BPS_DENOMINATOR);

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
  'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit) external',
  'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function isApprovedRouter(address router) external view returns (bool)',
  'function POOL() external view returns (address)',
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

// Validate Redis URL - warn if using localhost in production
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
if (redisUrl.includes('localhost') || redisUrl.includes('127.0.0.1')) {
  warnOnProductionDefault('REDIS_URL', redisUrl);
}

export const SERVICE_CONFIGS = {
  redis: {
    url: redisUrl,
    password: process.env.REDIS_PASSWORD,
    /** Flag indicating if using production Redis (not localhost) */
    isProductionRedis: !redisUrl.includes('localhost') && !redisUrl.includes('127.0.0.1'),
  },
  monitoring: {
    enabled: process.env.MONITORING_ENABLED === 'true',
    interval: parseInt(process.env.MONITORING_INTERVAL || '30000'),
    endpoints: (process.env.MONITORING_ENDPOINTS || '').split(',').filter(Boolean),
  },
  /** Indicates if configuration is suitable for production use */
  isProductionConfig: isProduction && !redisUrl.includes('localhost'),
};

/**
 * Validate that all required production configurations are set.
 * Call this at application startup in production to fail-fast.
 *
 * @throws Error if required production configuration is missing
 */
export function validateProductionConfig(): void {
  if (!isProduction) {
    return; // Skip validation in development
  }

  const missingConfigs: string[] = [];

  if (!process.env.REDIS_URL || process.env.REDIS_URL.includes('localhost')) {
    missingConfigs.push('REDIS_URL (production Redis instance required)');
  }

  if (!process.env.WALLET_PRIVATE_KEY && !process.env.WALLET_MNEMONIC) {
    missingConfigs.push('WALLET_PRIVATE_KEY or WALLET_MNEMONIC (wallet credentials required for execution)');
  }

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
// FLASH LOAN PROVIDER CONFIGURATION (P1-4 fix)
// Moved from hardcoded values in execution-engine
// =============================================================================

/**
 * Flash loan provider configuration by chain.
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
  fee: number;  // Basis points (100 = 1%)
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
  // BSC uses Pancakeswap flash loans (no Aave V3)
  bsc: {
    address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',  // PancakeSwap V3 Router
    protocol: 'pancakeswap_v3',
    fee: 25  // 0.25% flash swap fee
  },
  // S3.2.1-FIX: Added Avalanche Aave V3 flash loan provider
  avalanche: {
    address: AAVE_V3_POOLS.avalanche,  // Aave V3 Pool on Avalanche
    protocol: 'aave_v3',
    fee: 9  // 0.09% flash loan fee
  },
  // S3.2.2-FIX: Fantom uses SpookySwap flash swaps (Aave V3 not deployed on Fantom)
  fantom: {
    address: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',  // SpookySwap Router
    protocol: 'spookyswap',
    fee: 30  // 0.3% flash swap fee
  },
  // S3.1.2-FIX: zkSync Era - SyncSwap provides flash swaps (no Aave V3 yet)
  zksync: {
    address: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',  // SyncSwap Router
    protocol: 'syncswap',
    fee: 30  // 0.3% flash swap fee
  },
  // S3.1.2-FIX: Linea - SyncSwap provides flash swaps (no Aave V3 yet)
  linea: {
    address: '0x80e38291e06339d10AAB483C65695D004dBD5C69',  // SyncSwap Router on Linea
    protocol: 'syncswap',
    fee: 30  // 0.3% flash swap fee
  },
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
  feePercentage: number;  // In percentage (e.g., 0.06 = 0.06%)
  minFeeUsd: number;      // Minimum fee in USD
  estimatedLatencySeconds: number;
  reliability: number;    // 0-1 scale
}

export const BRIDGE_COSTS: BridgeCostConfig[] = [
  // Stargate (LayerZero) - Good for stablecoins
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'bsc', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // Across Protocol - Fast with relayer model
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'arbitrum', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'optimism', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'polygon', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'base', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.04, minFeeUsd: 1, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'arbitrum', targetChain: 'optimism', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'optimism', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'base', targetChain: 'arbitrum', feePercentage: 0.03, minFeeUsd: 0.5, estimatedLatencySeconds: 60, reliability: 0.97 },

  // Native bridges (L2 -> L1 are slower)
  { bridge: 'native', sourceChain: 'arbitrum', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'optimism', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days
  { bridge: 'native', sourceChain: 'base', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 604800, reliability: 0.99 }, // 7 days

  // S3.2.1-FIX: Avalanche bridge routes (Stargate supports Avalanche)
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'avalanche', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'avalanche', targetChain: 'ethereum', feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'avalanche', targetChain: 'arbitrum', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'avalanche', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // S3.2.2-FIX: Fantom bridge routes (Stargate supports Fantom)
  { bridge: 'stargate', sourceChain: 'ethereum', targetChain: 'fantom', feePercentage: 0.06, minFeeUsd: 1, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'fantom', targetChain: 'ethereum', feePercentage: 0.06, minFeeUsd: 0.5, estimatedLatencySeconds: 180, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'fantom', targetChain: 'arbitrum', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },
  { bridge: 'stargate', sourceChain: 'arbitrum', targetChain: 'fantom', feePercentage: 0.04, minFeeUsd: 0.3, estimatedLatencySeconds: 90, reliability: 0.95 },

  // S3.1.2-FIX: zkSync bridge routes (native bridge + Across)
  { bridge: 'native', sourceChain: 'ethereum', targetChain: 'zksync', feePercentage: 0.0, minFeeUsd: 3, estimatedLatencySeconds: 900, reliability: 0.99 }, // ~15 min
  { bridge: 'native', sourceChain: 'zksync', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 86400, reliability: 0.99 }, // ~24 hours
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'zksync', feePercentage: 0.05, minFeeUsd: 2, estimatedLatencySeconds: 180, reliability: 0.96 },
  { bridge: 'across', sourceChain: 'zksync', targetChain: 'ethereum', feePercentage: 0.05, minFeeUsd: 2, estimatedLatencySeconds: 180, reliability: 0.96 },

  // S3.1.2-FIX: Linea bridge routes (native bridge + Across)
  { bridge: 'native', sourceChain: 'ethereum', targetChain: 'linea', feePercentage: 0.0, minFeeUsd: 3, estimatedLatencySeconds: 1200, reliability: 0.99 }, // ~20 min
  { bridge: 'native', sourceChain: 'linea', targetChain: 'ethereum', feePercentage: 0.0, minFeeUsd: 5, estimatedLatencySeconds: 28800, reliability: 0.99 }, // ~8 hours
  { bridge: 'across', sourceChain: 'ethereum', targetChain: 'linea', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },
  { bridge: 'across', sourceChain: 'linea', targetChain: 'ethereum', feePercentage: 0.04, minFeeUsd: 2, estimatedLatencySeconds: 120, reliability: 0.97 },

  // S3.3.7-FIX: Solana bridge routes (Wormhole is primary Solana ↔ EVM bridge)
  { bridge: 'wormhole', sourceChain: 'ethereum', targetChain: 'solana', feePercentage: 0.1, minFeeUsd: 5, estimatedLatencySeconds: 300, reliability: 0.92 },
  { bridge: 'wormhole', sourceChain: 'solana', targetChain: 'ethereum', feePercentage: 0.1, minFeeUsd: 5, estimatedLatencySeconds: 300, reliability: 0.92 },
  { bridge: 'wormhole', sourceChain: 'arbitrum', targetChain: 'solana', feePercentage: 0.08, minFeeUsd: 3, estimatedLatencySeconds: 240, reliability: 0.92 },
  { bridge: 'wormhole', sourceChain: 'solana', targetChain: 'arbitrum', feePercentage: 0.08, minFeeUsd: 3, estimatedLatencySeconds: 240, reliability: 0.92 },
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
  if (!currentBest || config.feePercentage < currentBest.feePercentage) {
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

  const percentageFee = amountUsd * (config.feePercentage / 100);
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

