/**
 * Canonical Contract Addresses
 *
 * P3-CONFIG: Single source of truth for all contract addresses.
 * Eliminates duplicate address definitions and prevents address drift.
 *
 * @see docs/refactoring-roadmap.md - P3-CONFIG: Create canonical address file
 *
 * ## Address Organization
 * - AAVE_V3_POOLS: Aave V3 Pool addresses by chain (flash loans)
 * - NATIVE_TOKENS: Wrapped native token addresses by chain
 * - STABLECOINS: Common stablecoin addresses by chain
 * - DEX_ROUTERS: DEX router addresses by chain
 * - BRIDGE_CONTRACTS: Bridge contract addresses
 *
 * ## Usage
 * ```typescript
 * import { AAVE_V3_POOLS, getNativeToken, getStablecoin } from '@arbitrage/config/addresses';
 *
 * const pool = AAVE_V3_POOLS.ethereum; // '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
 * const weth = getNativeToken('ethereum'); // '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
 * ```
 *
 * ## Sync Notes
 * Previously addresses were duplicated in:
 * - shared/config/src/service-config.ts (FLASH_LOAN_PROVIDERS)
 * - contracts/deployments/addresses.ts (AAVE_V3_POOL_ADDRESSES)
 *
 * This file is now the CANONICAL SOURCE. Other files should import from here.
 */

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * EVM chain identifiers supported by the system.
 */
export type EVMChainId =
  | 'ethereum'
  | 'polygon'
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'bsc'
  | 'avalanche'
  | 'fantom'
  | 'zksync'
  | 'linea';

/**
 * All chain identifiers including non-EVM.
 */
export type ChainId = EVMChainId | 'solana';

/**
 * Testnet chain identifiers.
 */
export type TestnetChainId =
  | 'sepolia'
  | 'arbitrumSepolia'
  | 'solana-devnet';

// =============================================================================
// Aave V3 Pool Addresses
// =============================================================================

/**
 * Aave V3 Pool addresses by chain.
 * Used for flash loan operations.
 *
 * @see https://docs.aave.com/developers/deployed-contracts/v3-mainnet
 */
export const AAVE_V3_POOLS: Readonly<Record<string, string>> = {
  // Mainnets
  ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  polygon: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  avalanche: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',

  // Testnets
  sepolia: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  arbitrumSepolia: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
} as const;

/**
 * Get Aave V3 Pool address for a chain.
 * @throws Error if chain not supported by Aave V3
 */
export function getAaveV3Pool(chain: string): string {
  const address = AAVE_V3_POOLS[chain];
  if (!address) {
    throw new Error(
      `Aave V3 Pool not available on chain: ${chain}. ` +
      `Supported chains: ${Object.keys(AAVE_V3_POOLS).join(', ')}`
    );
  }
  return address;
}

/**
 * Check if Aave V3 is available on a chain.
 */
export function hasAaveV3(chain: string): boolean {
  return chain in AAVE_V3_POOLS;
}

// =============================================================================
// Wrapped Native Token Addresses
// =============================================================================

/**
 * Wrapped native token addresses by chain.
 * WETH, WBNB, WMATIC, WAVAX, WFTM, SOL (wrapped), etc.
 */
export const NATIVE_TOKENS: Readonly<Record<string, string>> = {
  // EVM chains
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
  base: '0x4200000000000000000000000000000000000006', // WETH
  optimism: '0x4200000000000000000000000000000000000006', // WETH
  bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  avalanche: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
  fantom: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', // WFTM
  zksync: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // WETH
  linea: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', // WETH

  // Solana (Wrapped SOL)
  solana: 'So11111111111111111111111111111111111111112',

  // Testnets
  sepolia: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH
  arbitrumSepolia: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', // WETH
} as const;

/**
 * Get wrapped native token address for a chain.
 * @throws Error if chain not configured
 */
export function getNativeToken(chain: string): string {
  const address = NATIVE_TOKENS[chain];
  if (!address) {
    throw new Error(
      `Native token not configured for chain: ${chain}. ` +
      `Configured chains: ${Object.keys(NATIVE_TOKENS).join(', ')}`
    );
  }
  return address;
}

// =============================================================================
// Stablecoin Addresses
// =============================================================================

/**
 * Stablecoin addresses by chain.
 */
export const STABLECOINS: Readonly<Record<string, Record<string, string>>> = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedcdeCB5BAA7D3',
  },
  polygon: {
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Native USDC
    'USDC.e': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // Bridged USDC
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
  },
  arbitrum: {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Native USDC
    'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // Bridged USDC
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  },
  base: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Native USDC
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // Bridged USDC
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  },
  optimism: {
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Native USDC
    'USDC.e': '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // Bridged USDC
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  },
  bsc: {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
  },
  avalanche: {
    USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Native USDC
    'USDC.e': '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', // Bridged USDC
    USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', // Native USDT
    'USDT.e': '0xc7198437980c041c805A1EDcbA50c1Ce5db95118', // Bridged USDT
    DAI: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
  },
  fantom: {
    USDC: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75',
    fUSDT: '0x049d68029688eAbF473097a2fC38ef61633A3C7A',
    DAI: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E',
  },
  zksync: {
    USDC: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
    USDT: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C',
  },
  linea: {
    USDC: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
    USDT: '0xA219439258ca9da29E9Cc4cE5596924745e12B93',
    DAI: '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5',
  },
  solana: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
} as const;

/**
 * Get stablecoin address for a chain.
 * @param chain - Chain identifier
 * @param symbol - Stablecoin symbol (USDC, USDT, DAI, etc.)
 * @throws Error if stablecoin not available on chain
 */
export function getStablecoin(chain: string, symbol: string): string {
  const chainStables = STABLECOINS[chain];
  if (!chainStables) {
    throw new Error(
      `No stablecoins configured for chain: ${chain}. ` +
      `Configured chains: ${Object.keys(STABLECOINS).join(', ')}`
    );
  }

  const address = chainStables[symbol];
  if (!address) {
    throw new Error(
      `Stablecoin ${symbol} not available on ${chain}. ` +
      `Available: ${Object.keys(chainStables).join(', ')}`
    );
  }

  return address;
}

/**
 * Get all stablecoins for a chain.
 */
export function getChainStablecoins(chain: string): Record<string, string> {
  return STABLECOINS[chain] || {};
}

// =============================================================================
// Common DEX Router Addresses
// =============================================================================

/**
 * DEX router addresses by chain.
 * Only includes V2-style routers that support swapExactTokensForTokens.
 */
export const DEX_ROUTERS: Readonly<Record<string, Record<string, string>>> = {
  ethereum: {
    uniswap_v2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    sushiswap: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  },
  polygon: {
    quickswap: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
    sushiswap: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  },
  arbitrum: {
    sushiswap: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    camelot: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
  },
  base: {
    baseswap: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
    aerodrome: '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb',
  },
  bsc: {
    pancakeswap_v2: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    biswap: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
  },
  avalanche: {
    trader_joe: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
    pangolin: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106',
  },
  fantom: {
    spookyswap: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',
    spiritswap: '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52',
  },
  zksync: {
    syncswap: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
    mute: '0x8B791913eB07C32779a16750e3868aA8495F5964',
  },
  linea: {
    syncswap: '0x80e38291e06339d10AAB483C65695D004dBD5C69',
    velocore: '0xf18ee42626F6a6A0FdE5C8F1ef9d61e98DE8Fd9e',
  },
} as const;

/**
 * Get DEX router address.
 * @param chain - Chain identifier
 * @param dex - DEX name
 * @throws Error if router not available
 */
export function getDexRouter(chain: string, dex: string): string {
  const chainRouters = DEX_ROUTERS[chain];
  if (!chainRouters) {
    throw new Error(
      `No DEX routers configured for chain: ${chain}`
    );
  }

  const address = chainRouters[dex];
  if (!address) {
    throw new Error(
      `Router for ${dex} not available on ${chain}. ` +
      `Available: ${Object.keys(chainRouters).join(', ')}`
    );
  }

  return address;
}

// =============================================================================
// Bridge Contract Addresses
// =============================================================================

/**
 * Bridge contract addresses.
 */
export const BRIDGE_CONTRACTS: Readonly<Record<string, Record<string, string>>> = {
  stargate: {
    ethereum: '0x8731d54E9D02c286767d56ac03e8037C07e01e98', // Stargate Router
    arbitrum: '0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614',
    optimism: '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',
    polygon: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
    bsc: '0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8',
    avalanche: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
    fantom: '0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6',
    base: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
  },
  across: {
    ethereum: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', // Across SpokePool
    arbitrum: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
    optimism: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
    polygon: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
    base: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
    zksync: '0xE0B015E54d54fc84a6cB9B666099c46adE9335FF',
    linea: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75',
  },
  wormhole: {
    ethereum: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B', // Wormhole Core Bridge
    solana: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
    arbitrum: '0xa5f208e072434bC67592E4C49C1B991BA79BCA46',
    base: '0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6',
  },
} as const;

/**
 * Get bridge contract address.
 * @param bridge - Bridge name (stargate, across, wormhole)
 * @param chain - Chain identifier
 * @throws Error if bridge not available on chain
 */
export function getBridgeContract(bridge: string, chain: string): string {
  const bridgeContracts = BRIDGE_CONTRACTS[bridge];
  if (!bridgeContracts) {
    throw new Error(
      `Bridge not configured: ${bridge}. ` +
      `Available bridges: ${Object.keys(BRIDGE_CONTRACTS).join(', ')}`
    );
  }

  const address = bridgeContracts[chain];
  if (!address) {
    throw new Error(
      `Bridge ${bridge} not available on ${chain}. ` +
      `Available chains: ${Object.keys(bridgeContracts).join(', ')}`
    );
  }

  return address;
}

// =============================================================================
// Solana Program IDs
// =============================================================================

/**
 * Solana program IDs for DEXs and protocols.
 */
export const SOLANA_PROGRAMS: Readonly<Record<string, string>> = {
  // DEXs
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  raydium_amm: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  raydium_clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  orca_whirlpool: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  meteora_dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  phoenix: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',

  // Infrastructure
  token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  associated_token: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system_program: '11111111111111111111111111111111',
} as const;

/**
 * Get Solana program ID.
 * @param program - Program name
 * @throws Error if program not configured
 */
export function getSolanaProgram(program: string): string {
  const programId = SOLANA_PROGRAMS[program];
  if (!programId) {
    throw new Error(
      `Solana program not configured: ${program}. ` +
      `Available: ${Object.keys(SOLANA_PROGRAMS).join(', ')}`
    );
  }
  return programId;
}

// =============================================================================
// Address Validation Utilities
// =============================================================================

/**
 * Validate Ethereum address format.
 */
export function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate Solana address format (base58, 32-44 chars).
 */
export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

/**
 * Normalize Ethereum address to checksum format.
 * Simple lowercase normalization (full checksum would require keccak256).
 */
export function normalizeAddress(address: string): string {
  if (!isValidEthereumAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }
  return address.toLowerCase();
}

/**
 * Compare two addresses (case-insensitive for Ethereum).
 */
export function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
