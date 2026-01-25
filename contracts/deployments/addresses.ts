/**
 * Flash Loan Contract Addresses
 *
 * This file contains deployed FlashLoanArbitrage contract addresses.
 *
 * ARCHITECTURE NOTE (FIX 3.1.3-4):
 * Aave V3 Pool addresses are also defined in:
 * - shared/config/src/service-config.ts (FLASH_LOAN_PROVIDERS)
 *
 * The service-config.ts is the SOURCE OF TRUTH for the TypeScript backend.
 * This file is for Hardhat deployment/testing and should stay in sync.
 * Consider a future refactoring to centralize all addresses.
 *
 * Usage:
 *   import { FLASH_LOAN_CONTRACT_ADDRESSES, AAVE_V3_POOL_ADDRESSES } from '@arbitrage/contracts/deployments';
 *
 * @see implementation_plan_v2.md Task 3.1.3
 */

// =============================================================================
// Aave V3 Pool Addresses
// =============================================================================

/**
 * Aave V3 Pool addresses by chain
 * @see https://docs.aave.com/developers/deployed-contracts/v3-mainnet
 */
export const AAVE_V3_POOL_ADDRESSES: Record<string, string> = {
  // Testnets
  sepolia: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  arbitrumSepolia: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',

  // Mainnets - synced with shared/config/src/service-config.ts FLASH_LOAN_PROVIDERS
  ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  polygon: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  avalanche: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  // Note: BSC, Fantom, zkSync, Linea use non-Aave protocols (see FLASH_LOAN_PROVIDERS)
};

// =============================================================================
// FlashLoanArbitrage Contract Addresses
// =============================================================================

/**
 * FlashLoanArbitrage contract addresses by chain.
 *
 * NOTE: These are placeholders. Update with actual deployed addresses after deployment.
 * Run `npm run deploy:sepolia` or `npm run deploy:arbitrum-sepolia` to deploy.
 */
export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = {
  // Testnets - update after deployment
  // sepolia: '0x...', // TODO: Deploy and update
  // arbitrumSepolia: '0x...', // TODO: Deploy and update

  // Mainnets - update after security audit and deployment
  // ethereum: '0x...', // TODO: Deploy after audit
  // arbitrum: '0x...', // TODO: Deploy after audit
};

// =============================================================================
// Approved DEX Routers
// =============================================================================

/**
 * Pre-approved DEX router addresses by chain.
 * These routers will be approved during contract deployment.
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
};

// =============================================================================
// Token Addresses (Common tokens for testing)
// =============================================================================

/**
 * Common token addresses by chain
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
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a chain has a deployed FlashLoanArbitrage contract
 */
export function hasDeployedContract(chain: string): boolean {
  return chain in FLASH_LOAN_CONTRACT_ADDRESSES &&
         FLASH_LOAN_CONTRACT_ADDRESSES[chain] !== undefined;
}

/**
 * Get the FlashLoanArbitrage contract address for a chain
 * @throws Error if no contract is deployed
 */
export function getContractAddress(chain: string): string {
  const address = FLASH_LOAN_CONTRACT_ADDRESSES[chain];
  if (!address) {
    throw new Error(
      `No FlashLoanArbitrage contract deployed for chain: ${chain}. ` +
      `Run deployment script first: npm run deploy:${chain}`
    );
  }
  return address;
}

/**
 * Get the Aave V3 Pool address for a chain
 * @throws Error if chain not supported
 */
export function getAavePoolAddress(chain: string): string {
  const address = AAVE_V3_POOL_ADDRESSES[chain];
  if (!address) {
    throw new Error(
      `Aave V3 Pool not configured for chain: ${chain}. ` +
      `Supported chains: ${Object.keys(AAVE_V3_POOL_ADDRESSES).join(', ')}`
    );
  }
  return address;
}

/**
 * Get approved routers for a chain
 */
export function getApprovedRouters(chain: string): string[] {
  return APPROVED_ROUTERS[chain] || [];
}
