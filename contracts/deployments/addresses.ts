/**
 * Flash Loan Contract Addresses
 *
 * This file contains deployed FlashLoanArbitrage contract addresses.
 *
 * ## Address Consolidation (Phase 2 Fix)
 *
 * Protocol addresses (Aave, PancakeSwap, Balancer, etc.) are imported from @arbitrage/config
 * to maintain a single source of truth. This file only defines deployed contract addresses.
 *
 * Usage:
 *   import { FLASH_LOAN_CONTRACT_ADDRESSES, AAVE_V3_POOL_ADDRESSES } from '@arbitrage/contracts/deployments';
 *
 * @see implementation_plan_v2.md Task 3.1.3
 */

import {
  AAVE_V3_POOLS,
  PANCAKESWAP_V3_FACTORIES,
  BALANCER_V2_VAULTS,
  SYNCSWAP_VAULTS,
} from '@arbitrage/config';

// =============================================================================
// Type-Safe Chain Identifiers (Phase 3 Fix)
// =============================================================================

/**
 * Testnet chain identifiers
 *
 * P1-006 FIX: Added 'baseSepolia' (referenced in deploy scripts but missing from type)
 */
export type TestnetChain = 'sepolia' | 'arbitrumSepolia' | 'baseSepolia' | 'zksync-testnet' | 'zksync-sepolia';

/**
 * EVM mainnet chain identifiers
 */
export type EVMMainnetChain =
  | 'ethereum'
  | 'polygon'
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'bsc'
  | 'avalanche'
  | 'fantom'
  | 'zksync'
  | 'zksync-mainnet'
  | 'linea';

/**
 * All supported chain identifiers
 */
export type SupportedChain = TestnetChain | EVMMainnetChain;

/**
 * Mainnet chains only (for production deployments)
 *
 * NOTE: Both 'zksync' and 'zksync-mainnet' are included as they're aliases
 * for the same network (zkSync Era Mainnet). Different contexts use different
 * names (internal config vs. Hardhat network names vs. explorers).
 */
export const MAINNET_CHAINS: readonly EVMMainnetChain[] = [
  'ethereum',
  'polygon',
  'arbitrum',
  'base',
  'optimism',
  'bsc',
  'avalanche',
  'fantom',
  'zksync',
  'zksync-mainnet',  // Alias for zksync (zkSync Era Mainnet)
  'linea',
] as const;

/**
 * Testnet chains only (for development/testing)
 *
 * NOTE: Both 'zksync-testnet' and 'zksync-sepolia' are included as they're
 * aliases for the same network (zkSync Era Sepolia testnet). Different contexts
 * use different names (Hardhat config vs. block explorers).
 *
 * P1-006 FIX: Added 'baseSepolia' - Base Sepolia testnet (L2 testnet)
 */
export const TESTNET_CHAINS: readonly TestnetChain[] = [
  'sepolia',
  'arbitrumSepolia',
  'baseSepolia',  // P1-006 FIX: Base Sepolia testnet
  'zksync-testnet',
  'zksync-sepolia',  // Alias for zksync-testnet (zkSync Era Sepolia)
] as const;

/**
 * Normalize chain name to canonical form.
 *
 * Handles various chain name aliases:
 * - 'zksync-mainnet' → 'zksync'
 * - 'zksync-sepolia' → 'zksync-testnet'
 *
 * **Why Normalization**: Different contexts use different names:
 * - Hardhat config: 'zksync-mainnet'
 * - Block explorers: 'zksync'
 * - Internal config: 'zksync'
 *
 * This ensures consistent address lookups regardless of input format.
 *
 * @param chain - Chain name (any variant)
 * @returns Canonical chain name
 */
export function normalizeChainName(chain: string): string {
  const aliases: Record<string, string> = {
    'zksync-mainnet': 'zksync',
    'zksync-sepolia': 'zksync-testnet',
  };
  return aliases[chain] || chain;
}

/**
 * Check if a chain is a testnet.
 * Handles chain name aliases automatically.
 *
 * @param chain - Chain name (accepts aliases like 'zksync-sepolia')
 */
export function isTestnet(chain: string): chain is TestnetChain {
  const normalized = normalizeChainName(chain);
  return (TESTNET_CHAINS as readonly string[]).includes(normalized);
}

/**
 * Check if a chain is a mainnet.
 * Handles chain name aliases automatically.
 *
 * @param chain - Chain name (accepts aliases like 'zksync-mainnet')
 */
export function isMainnet(chain: string): chain is EVMMainnetChain {
  const normalized = normalizeChainName(chain);
  return (MAINNET_CHAINS as readonly string[]).includes(normalized);
}

// =============================================================================
// Re-export Protocol Addresses (Single Source of Truth)
// =============================================================================

/**
 * Aave V3 Pool addresses by chain
 * Re-exported from @arbitrage/config for convenience.
 * @see https://docs.aave.com/developers/deployed-contracts/v3-mainnet
 */
export const AAVE_V3_POOL_ADDRESSES = AAVE_V3_POOLS;

// =============================================================================
// FlashLoanArbitrage Contract Addresses
// =============================================================================

/**
 * FlashLoanArbitrage contract addresses by chain.
 *
 * **MANUAL UPDATE REQUIRED**: After deploying contracts, manually update this file.
 * Deployment scripts save to registry.json but do NOT auto-update this TypeScript file.
 *
 * **Deployment Process**:
 * 1. Run: `npm run deploy:sepolia` (or target network)
 * 2. Script outputs: "Update: FLASH_LOAN_CONTRACT_ADDRESSES.sepolia = '0x...'"
 * 3. Manually copy address and uncomment/update the line below
 * 4. Commit updated file to version control
 *
 * **Future Enhancement**: Auto-generate this file from registry.json
 */
export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
};

// =============================================================================
// MultiPathQuoter Contract Addresses
// =============================================================================

/**
 * MultiPathQuoter contract addresses by chain.
 *
 * Batches getAmountsOut() calls for multiple swap paths in a single RPC call,
 * reducing latency from N sequential calls to 1 batched call.
 *
 * @see contracts/src/MultiPathQuoter.sol
 */
export const MULTI_PATH_QUOTER_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
};

// =============================================================================
// PancakeSwap V3 Flash Arbitrage Contract Addresses
// =============================================================================

/**
 * PancakeSwapFlashArbitrage contract addresses by chain.
 *
 * Flash loans via PancakeSwap V3 pools on BSC and other chains.
 * Key advantage: Access to PancakeSwap's massive BSC liquidity (larger than Aave V3).
 *
 * Deploy: `npx hardhat run scripts/deploy-pancakeswap.ts --network bsc`
 * @see contracts/src/PancakeSwapFlashArbitrage.sol
 */
export const PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
};

// =============================================================================
// Balancer V2 Flash Arbitrage Contract Addresses
// =============================================================================

/**
 * BalancerV2FlashArbitrage contract addresses by chain.
 *
 * Flash loans via Balancer V2 Vaults.
 * Key advantage: 0% flash loan fees (vs Aave V3's 0.09%), maximizing profit potential.
 *
 * Deploy: `npx hardhat run scripts/deploy-balancer.ts --network ethereum`
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */
export const BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
};

// =============================================================================
// SyncSwap Flash Arbitrage Contract Addresses
// =============================================================================

/**
 * SyncSwapFlashArbitrage contract addresses by network.
 *
 * Flash loans via SyncSwap Vaults on zkSync Era (EIP-3156 compliant).
 *
 * Deploy: `npx hardhat run scripts/deploy-syncswap.ts --network zksync`
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 */
export const SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
};

// =============================================================================
// Commit-Reveal MEV Protection Contract Addresses
// =============================================================================

/**
 * CommitRevealArbitrage contract addresses by chain.
 *
 * Two-step commit-reveal pattern for MEV protection (front-running, sandwich attacks).
 *
 * Deploy: `npx hardhat run scripts/deploy-commit-reveal.ts --network ethereum`
 * @see contracts/src/CommitRevealArbitrage.sol
 */
export const COMMIT_REVEAL_ARBITRAGE_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
};

// =============================================================================
// Approved DEX Routers
// =============================================================================

/**
 * Pre-approved DEX router addresses by chain.
 *
 * These routers will be approved during contract deployment for use in arbitrage swaps.
 *
 * **Important**: Only V2-style routers (`swapExactTokensForTokens`) are currently supported.
 * Uniswap V3 uses a different interface (`exactInputSingle`) and requires a separate adapter.
 *
 * **Usage**:
 * ```typescript
 * import { APPROVED_ROUTERS, getApprovedRouters } from '@arbitrage/contracts/deployments';
 *
 * // Get routers for a chain
 * const ethRouters = getApprovedRouters('ethereum');
 * // ['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F']
 * ```
 *
 * @see https://docs.uniswap.org/contracts/v2/reference/smart-contracts/router-02
 */
export const APPROVED_ROUTERS: Record<string, string[]> = {
  // Testnets
  sepolia: [
    '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008', // Uniswap V2 Router
  ],
  arbitrumSepolia: [
    '0x101F443B4d1b059569D643917553c771E1b9663E', // Uniswap V2 Router
  ],

  // Mainnets
  // NOTE: Only V2-style routers (swapExactTokensForTokens) are supported.
  // Uniswap V3 uses a different interface (exactInputSingle) and requires a separate adapter.
  // See: https://docs.uniswap.org/contracts/v3/reference/periphery/interfaces/ISwapRouter
  ethereum: [
    '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
    '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap Router (V2-compatible)
    // NOTE: Uniswap V3 (0xE592427A0AEce92De3Edee1F18E0157C05861564) NOT supported - uses different interface
  ],
  arbitrum: [
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router (V2-compatible)
    '0xc873fEcbd354f5A56E00E710B90EF4201db2448d', // Camelot Router (V2-compatible)
    // NOTE: Uniswap V3 (0xE592427A0AEce92De3Edee1F18E0157C05861564) NOT supported - uses different interface
  ],
  base: [
    '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // BaseSwap Router (V2-compatible)
    '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb', // Aerodrome Router (V2-compatible)
    // NOTE: Uniswap V3 (0x2626664c2603336E57B271c5C0b26F421741e481) NOT supported - uses different interface
  ],
  bsc: [
    '0x10ED43C718714eb63d5aA57B78B54704E256024E', // PancakeSwap V2 Router
    '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8', // Biswap
  ],
  polygon: [
    '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', // QuickSwap Router
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router
  ],
  optimism: [
    '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2', // Velodrome Router (V2-compatible)
  ],
  avalanche: [
    '0x60aE616a2155Ee3d9A68541Ba4544862310933d4', // Trader Joe Router
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router
  ],
  fantom: [
    '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52', // SpookySwap Router
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router
  ],
  zksync: [
    '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295', // SyncSwap Router
  ],
  linea: [
    '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb', // Lynex Router
  ],
};

// =============================================================================
// Token Addresses (Common tokens for testing)
// =============================================================================

/**
 * Common token addresses by chain for testing and development.
 *
 * Includes wrapped native tokens (WETH, WMATIC, WAVAX, etc.) and major stablecoins
 * (USDC, USDT, DAI) across all supported chains.
 *
 * **Usage**:
 * ```typescript
 * import { TOKEN_ADDRESSES } from '@arbitrage/contracts/deployments';
 *
 * // Get USDC address on Ethereum
 * const usdcEth = TOKEN_ADDRESSES.ethereum.USDC;
 * // '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
 *
 * // Get WMATIC on Polygon
 * const wmatic = TOKEN_ADDRESSES.polygon.WMATIC;
 * ```
 *
 * **Note**: These are verified addresses from official protocol documentation.
 * Always verify against the latest chain explorers for production use.
 */
export const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  sepolia: {
    WETH: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    USDC: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
    DAI: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
  },
  arbitrumSepolia: {
    WETH: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    USDC: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
  ethereum: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedcdeCB5BAA7D3', // FIX 3.1.3-2: Corrected typo (was EescdeCB)
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  arbitrum: {
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  },
  polygon: {
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // Wrapped MATIC
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC (bridged)
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  },
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Native USDC
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  },
  optimism: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // USDC (bridged)
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  },
  bsc: {
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // Wrapped BNB
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    ETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  },
  avalanche: {
    WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // Wrapped AVAX
    USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Native USDC
    USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    DAI: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
    WETH: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
  },
  fantom: {
    WFTM: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', // Wrapped FTM
    USDC: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75',
    DAI: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E',
    WETH: '0x74b23882a30290451A17c44f4F05243b6b58C76d',
  },
  zksync: {
    WETH: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    USDC: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
    USDT: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C',
  },
  linea: {
    WETH: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
    USDC: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
    USDT: '0xA219439258ca9da29E9Cc4cE5596924745e12B93',
  },
};

// =============================================================================
// Address Validation and Optimization (Phase 4)
// =============================================================================

/**
 * Zero address constant (invalid contract address)
 * Used to filter out undeployed or invalid contract addresses
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Validate basic Ethereum address format (hex format and length).
 *
 * **NOTE**: This does NOT validate EIP-55 checksums (mixed case).
 * Function name changed from validateAddressChecksum to reflect actual behavior.
 *
 * **Checksum Validation**: Deferred to runtime by consumers using ethers.getAddress().
 * We avoid importing ethers here to keep this config module lightweight.
 *
 * **Usage**: Called at module load time for all defined addresses to fail fast
 * on invalid configuration rather than at transaction execution time.
 *
 * @param address - Ethereum address to validate
 * @param context - Context for error message (e.g., "FLASH_LOAN_CONTRACT_ADDRESSES.ethereum")
 * @throws Error if address doesn't match basic hex format (0x + 40 hex chars)
 */
function validateAddressFormat(address: string, context: string): void {
  // Basic validation: 0x prefix + exactly 40 hexadecimal characters
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      `[ERR_INVALID_ADDRESS] Invalid address format in ${context}.\n` +
      `Provided: ${address}\n` +
      `Expected: 0x followed by 40 hexadecimal characters (0-9, a-f, A-F)`
    );
  }

  // Zero address check (0x000...000 is not a valid contract address)
  if (address === ZERO_ADDRESS) {
    throw new Error(
      `[ERR_ZERO_ADDRESS] Zero address (0x000...000) is not a valid contract address in ${context}.\n` +
      `This typically indicates an undeployed or misconfigured contract.`
    );
  }
  // EIP-55 checksum validation requires ethers.getAddress() - not done here
}

/**
 * Validate all addresses in a Record at module load time.
 * Fails fast on invalid configuration rather than at runtime.
 *
 * @param addresses - Record of chain names to addresses
 * @param constantName - Name of the constant being validated (for error messages)
 */
function validateAddressRecord(addresses: Record<string, string>, constantName: string): void {
  Object.entries(addresses).forEach(([chain, address]) => {
    if (address) {
      validateAddressFormat(address, `${constantName}.${chain}`);
    }
  });
}

/**
 * Validate all router addresses for a chain at module load time.
 *
 * @param routersByChain - Record of chain names to router address arrays
 * @param constantName - Name of the constant being validated
 */
function validateRouterAddresses(routersByChain: Record<string, string[]>, constantName: string): void {
  Object.entries(routersByChain).forEach(([chain, routers]) => {
    routers.forEach((router, index) => {
      validateAddressFormat(router, `${constantName}.${chain}[${index}]`);
    });
  });
}

/**
 * Helper to check if an address is valid and deployed.
 * Filters out null, undefined, empty string, and zero address.
 *
 * @param addr - Address to validate
 * @returns true if address is valid and deployed
 */
function isValidDeployedAddress(addr: string | null | undefined): addr is string {
  return addr !== null && addr !== undefined && addr !== '' && addr !== ZERO_ADDRESS;
}

/**
 * Pre-validated Maps for O(1) lookups (optimization)
 * These are built at module load time for performance.
 *
 * Filter criteria:
 * - Excludes null, undefined, empty string
 * - Excludes zero address (0x000...000) which indicates undeployed contracts
 * - Only includes valid, non-zero addresses
 *
 * **Performance**: Maps have better characteristics than objects for hot-path lookups:
 * - Guaranteed O(1) access time
 * - No prototype chain traversal
 * - Better for frequent lookups (price updates, opportunity detection)
 */
const DEPLOYED_CONTRACTS_MAP = new Map(
  Object.entries(FLASH_LOAN_CONTRACT_ADDRESSES).filter(([_, addr]) => isValidDeployedAddress(addr))
);

const DEPLOYED_QUOTERS_MAP = new Map(
  Object.entries(MULTI_PATH_QUOTER_ADDRESSES).filter(([_, addr]) => isValidDeployedAddress(addr))
);

/**
 * Approved routers Map with frozen arrays for hot-path safety.
 * Arrays are frozen to prevent mutation, enabling safe return of references.
 */
const APPROVED_ROUTERS_MAP = new Map(
  Object.entries(APPROVED_ROUTERS)
    .filter(([_, routers]) => routers && routers.length > 0)
    .map(([chain, routers]) => [chain, Object.freeze([...routers])] as const)
);

/**
 * Aave V3 Pool addresses Map for consistent O(1) lookups.
 * Built from AAVE_V3_POOL_ADDRESSES object for performance consistency.
 */
const AAVE_POOL_MAP = new Map(
  Object.entries(AAVE_V3_POOL_ADDRESSES).filter(([_, addr]) => !!addr)
);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a chain has a deployed FlashLoanArbitrage contract.
 * Uses pre-built Map for O(1) lookup performance.
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * @param chain - Chain name (accepts aliases)
 */
export function hasDeployedContract(chain: string): boolean {
  const normalized = normalizeChainName(chain);
  return DEPLOYED_CONTRACTS_MAP.has(normalized);
}

/**
 * Get the FlashLoanArbitrage contract address for a chain.
 * Uses pre-built Map for O(1) lookup performance.
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * @param chain - Chain name (accepts aliases)
 * @throws Error if no contract is deployed
 */
export function getContractAddress(chain: string): string {
  const normalized = normalizeChainName(chain);
  const address = DEPLOYED_CONTRACTS_MAP.get(normalized);
  if (!address) {
    throw new Error(
      `[ERR_NO_CONTRACT] No FlashLoanArbitrage contract deployed for chain: ${chain} (normalized: ${normalized}). ` +
      `Run deployment script first: npm run deploy:${normalized}. ` +
      `Available chains: ${Array.from(DEPLOYED_CONTRACTS_MAP.keys()).join(', ') || 'none'}`
    );
  }
  return address;
}

/**
 * Get the Aave V3 Pool address for a chain.
 * Uses pre-built Map for O(1) lookup performance (consistent with other helpers).
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * @param chain - Chain name (accepts aliases)
 * @throws Error if chain not supported
 */
export function getAavePoolAddress(chain: string): string {
  const normalized = normalizeChainName(chain);
  const address = AAVE_POOL_MAP.get(normalized);
  if (!address) {
    throw new Error(
      `[ERR_NO_AAVE_POOL] Aave V3 Pool not configured for chain: ${chain} (normalized: ${normalized}). ` +
      `Supported chains: ${Array.from(AAVE_POOL_MAP.keys()).join(', ')}`
    );
  }
  return address;
}

/**
 * Get approved routers for a chain.
 * Uses pre-built Map for O(1) lookup performance.
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * **Hot-Path Optimization**: Returns frozen array (safe to cache reference).
 * Array is immutable, preventing accidental mutations in hot-path code.
 *
 * @param chain - Chain name (accepts aliases)
 * @returns Frozen readonly array of router addresses
 * @throws Error if chain not configured with approved routers
 */
export function getApprovedRouters(chain: string): readonly string[] {
  const normalized = normalizeChainName(chain);
  const routers = APPROVED_ROUTERS_MAP.get(normalized);
  if (!routers) {
    throw new Error(
      `[ERR_NO_ROUTERS] No approved routers configured for chain: ${chain} (normalized: ${normalized}). ` +
      `Supported chains: ${Array.from(APPROVED_ROUTERS_MAP.keys()).join(', ')}. ` +
      `This will cause [ERR_UNAPPROVED_ROUTER] failures during execution.`
    );
  }
  return routers;
}

/**
 * Check if a chain has approved routers configured.
 * Uses pre-built Map for O(1) lookup performance.
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * @param chain - Chain name (accepts aliases)
 */
export function hasApprovedRouters(chain: string): boolean {
  const normalized = normalizeChainName(chain);
  return APPROVED_ROUTERS_MAP.has(normalized);
}

/**
 * Check if a chain has a deployed MultiPathQuoter contract.
 * Uses pre-built Map for O(1) lookup performance.
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * @param chain - Chain name (accepts aliases)
 */
export function hasDeployedQuoter(chain: string): boolean {
  const normalized = normalizeChainName(chain);
  return DEPLOYED_QUOTERS_MAP.has(normalized);
}

/**
 * Get the MultiPathQuoter contract address for a chain (throws if not deployed).
 * Uses pre-built Map for O(1) lookup performance.
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * **Error Handling Pattern**: This function throws if quoter is not deployed.
 * Use hasDeployedQuoter() to check availability first, or use tryGetQuoterAddress()
 * for optional behavior.
 *
 * @param chain - Chain identifier (accepts aliases)
 * @returns The contract address
 * @throws Error if MultiPathQuoter not deployed on this chain
 */
export function getQuoterAddress(chain: string): string {
  const normalized = normalizeChainName(chain);
  const address = DEPLOYED_QUOTERS_MAP.get(normalized);
  if (!address) {
    throw new Error(
      `[ERR_NO_QUOTER] MultiPathQuoter contract not deployed for chain: ${chain} (normalized: ${normalized}). ` +
      `Run deployment script first: npm run deploy:multi-path-quoter --network ${normalized}. ` +
      `Available chains: ${Array.from(DEPLOYED_QUOTERS_MAP.keys()).join(', ') || 'none'}`
    );
  }
  return address;
}

/**
 * Try to get the MultiPathQuoter contract address for a chain (returns undefined if not deployed).
 * Uses pre-built Map for O(1) lookup performance.
 * Handles chain name aliases (e.g., 'zksync-mainnet' → 'zksync').
 *
 * **Error Handling Pattern**: This function returns undefined for optional/graceful fallback.
 * Use getQuoterAddress() if quoter is required.
 *
 * @param chain - Chain identifier (accepts aliases)
 * @returns The contract address or undefined if not deployed
 */
export function tryGetQuoterAddress(chain: string): string | undefined {
  const normalized = normalizeChainName(chain);
  return DEPLOYED_QUOTERS_MAP.get(normalized);
}

// =============================================================================
// Module-Load Validation (Fail Fast)
// =============================================================================

/**
 * Validate all address constants at module load time.
 * Fails fast on invalid configuration rather than at transaction execution time.
 *
 * **When to Skip**: Only in test environments where addresses may be mocked.
 * **Why Fail Fast**: Invalid addresses discovered at startup vs. during trade execution
 * saves gas and prevents missed arbitrage opportunities.
 */
if (process.env.NODE_ENV !== 'test') {
  try {
    // Validate all contract address constants
    validateAddressRecord(FLASH_LOAN_CONTRACT_ADDRESSES, 'FLASH_LOAN_CONTRACT_ADDRESSES');
    validateAddressRecord(MULTI_PATH_QUOTER_ADDRESSES, 'MULTI_PATH_QUOTER_ADDRESSES');
    validateAddressRecord(PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES, 'PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES');
    validateAddressRecord(BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES, 'BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES');
    validateAddressRecord(SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES, 'SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES');
    validateAddressRecord(COMMIT_REVEAL_ARBITRAGE_ADDRESSES, 'COMMIT_REVEAL_ARBITRAGE_ADDRESSES');

    // Validate router addresses
    validateRouterAddresses(APPROVED_ROUTERS, 'APPROVED_ROUTERS');

    // Validate token addresses
    Object.entries(TOKEN_ADDRESSES).forEach(([chain, tokens]) => {
      Object.entries(tokens).forEach(([symbol, address]) => {
        validateAddressFormat(address, `TOKEN_ADDRESSES.${chain}.${symbol}`);
      });
    });

    // Success: All addresses valid
    // Note: We don't log success to avoid noise, but validation has run
  } catch (error) {
    // Fail loudly on invalid addresses
    console.error('\n' + '='.repeat(80));
    console.error('❌ CRITICAL: Invalid address configuration detected');
    console.error('='.repeat(80));
    console.error('');
    console.error('File: contracts/deployments/addresses.ts');
    console.error('');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    console.error('');
    console.error('Resolution:');
    console.error('  1. Check the address in contracts/deployments/addresses.ts');
    console.error('  2. Ensure it matches format: 0x followed by 40 hex characters');
    console.error('  3. Verify it\'s not the zero address (0x000...000)');
    console.error('  4. Re-deploy contract if address is incorrect');
    console.error('='.repeat(80));
    console.error('');

    // Re-throw to stop process (don't start with invalid config)
    throw error;
  }
}
