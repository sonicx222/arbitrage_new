/**
 * Canonical Chain Identifiers
 *
 * Single source of truth for all chain IDs across the arbitrage system.
 * This prevents inconsistencies between modules (contracts, config, services).
 *
 * **Problem This Solves**:
 * - contracts/deployments/addresses.ts used 'arbitrumSepolia'
 * - shared/config/src/addresses.ts used 'arbitrum-sepolia'
 * - Different modules had different chain name conventions
 *
 * **Solution**: Define once, import everywhere.
 *
 * @see contracts/INTERFACE_DEEP_DIVE_ANALYSIS.md - Fix #4
 */

/**
 * Canonical chain identifiers (single source of truth)
 *
 * **Naming Convention**:
 * - Mainnet: lowercase, single word if possible (e.g., 'ethereum', 'polygon')
 * - Testnet: lowercase with kebab-case if multi-word (e.g., 'arbitrum-sepolia')
 * - L2s: use canonical name, not aliases (e.g., 'zksync' not 'zksync-mainnet')
 *
 * **Aliases**: Use CHAIN_ALIASES map for alternate names
 */
export type ChainId =
  // =========================================================================
  // EVM Mainnets
  // =========================================================================
  | 'ethereum' // Ethereum Mainnet (chain ID: 1)
  | 'polygon' // Polygon (chain ID: 137)
  | 'arbitrum' // Arbitrum One (chain ID: 42161)
  | 'base' // Base (chain ID: 8453)
  | 'optimism' // Optimism (chain ID: 10)
  | 'bsc' // BNB Smart Chain (chain ID: 56)
  | 'avalanche' // Avalanche C-Chain (chain ID: 43114)
  | 'fantom' // Fantom Opera (chain ID: 250)
  | 'zksync' // zkSync Era (chain ID: 324)
  | 'linea' // Linea (chain ID: 59144)
  | 'blast' // Blast (chain ID: 81457)
  | 'scroll' // Scroll (chain ID: 534352)
  | 'mantle' // Mantle (chain ID: 5000)
  | 'mode' // Mode (chain ID: 34443)
  // =========================================================================
  // Non-EVM
  // =========================================================================
  | 'solana' // Solana Mainnet
  // =========================================================================
  // Testnets
  // =========================================================================
  | 'sepolia' // Ethereum Sepolia (chain ID: 11155111)
  | 'arbitrum-sepolia' // Arbitrum Sepolia (chain ID: 421614)
  | 'base-sepolia' // Base Sepolia (chain ID: 84532)
  | 'zksync-sepolia' // zkSync Era Sepolia (chain ID: 300)
  | 'solana-devnet'; // Solana Devnet

/**
 * Chain aliases (alternate names for the same chain)
 *
 * Use this to handle different naming conventions from:
 * - Hardhat config files
 * - Block explorers
 * - Third-party APIs
 * - Legacy code
 *
 * @example
 * ```typescript
 * normalizeChainId('zksync-mainnet') // → 'zksync'
 * normalizeChainId('arbitrumSepolia') // → 'arbitrum-sepolia'
 * normalizeChainId('ethereum')        // → 'ethereum' (no change)
 * ```
 */
export const CHAIN_ALIASES: Readonly<Record<string, ChainId>> = {
  // zkSync aliases
  'zksync-mainnet': 'zksync',
  'zksync-testnet': 'zksync-sepolia',
  zkSync: 'zksync',

  // Camel case testnet variations (from Hardhat configs)
  arbitrumSepolia: 'arbitrum-sepolia',
  baseSepolia: 'base-sepolia',
  zkSyncSepolia: 'zksync-sepolia',

  // Common alternate names
  eth: 'ethereum',
  matic: 'polygon',
  arb: 'arbitrum',
  bnb: 'bsc',
  avax: 'avalanche',
  ftm: 'fantom',
  sol: 'solana',

  // New L2s
  mnt: 'mantle',

  // Legacy names
  binance: 'bsc',
  'binance-smart-chain': 'bsc',
} as const;

/** Pre-computed lowercase alias map for O(1) case-insensitive lookup */
const LOWERCASE_ALIASES: Readonly<Record<string, ChainId>> = Object.fromEntries(
  Object.entries(CHAIN_ALIASES).map(([k, v]) => [k.toLowerCase(), v])
) as Record<string, ChainId>;

/**
 * Normalize chain identifier to canonical form
 *
 * Converts any valid chain name (including aliases) to the canonical ChainId.
 *
 * @param chain - Chain identifier (any variant)
 * @returns Canonical ChainId
 * @throws Never throws - returns input if not recognized
 *
 * @example
 * ```typescript
 * normalizeChainId('zksync-mainnet') // → 'zksync'
 * normalizeChainId('arbitrumSepolia') // → 'arbitrum-sepolia'
 * normalizeChainId('ethereum')        // → 'ethereum'
 * normalizeChainId('unknown')         // → 'unknown' (passthrough)
 * ```
 */
export function normalizeChainId(chain: string): ChainId {
  // Try exact match against canonical IDs first (O(1) Set lookup)
  if (isCanonicalChainId(chain)) {
    return chain;
  }

  // Case-insensitive lookup using pre-computed lowercase alias map
  const alias = LOWERCASE_ALIASES[chain.toLowerCase()];
  if (alias) {
    return alias;
  }

  // Return input if not recognized (avoid throwing for robustness)
  return chain as ChainId;
}

/** Module-level Set for O(1) testnet lookup */
const TESTNET_IDS: ReadonlySet<string> = new Set([
  'sepolia',
  'arbitrum-sepolia',
  'base-sepolia',
  'zksync-sepolia',
  'solana-devnet',
]);

/** Module-level static arrays to avoid per-call allocation */
const MAINNET_CHAINS: readonly MainnetChainId[] = [
  'ethereum', 'polygon', 'arbitrum', 'base', 'optimism',
  'bsc', 'avalanche', 'fantom', 'zksync', 'linea',
  'blast', 'scroll', 'mantle', 'mode', 'solana',
];
const TESTNET_CHAINS: readonly TestnetChainId[] = [
  'sepolia', 'arbitrum-sepolia', 'base-sepolia', 'zksync-sepolia', 'solana-devnet',
];
const EVM_CHAINS: readonly EVMChainId[] = [
  'ethereum', 'polygon', 'arbitrum', 'base', 'optimism',
  'bsc', 'avalanche', 'fantom', 'zksync', 'linea',
  'blast', 'scroll', 'mantle', 'mode',
  'sepolia', 'arbitrum-sepolia', 'base-sepolia', 'zksync-sepolia',
];
const ALL_CHAINS: readonly ChainId[] = [...MAINNET_CHAINS, ...TESTNET_CHAINS];

/** Module-level Set for O(1) canonical ID lookup (no per-call allocation) */
const CANONICAL_IDS: ReadonlySet<string> = new Set([
  // Mainnets
  'ethereum',
  'polygon',
  'arbitrum',
  'base',
  'optimism',
  'bsc',
  'avalanche',
  'fantom',
  'zksync',
  'linea',
  'blast',
  'scroll',
  'mantle',
  'mode',
  // Non-EVM
  'solana',
  // Testnets
  'sepolia',
  'arbitrum-sepolia',
  'base-sepolia',
  'zksync-sepolia',
  'solana-devnet',
]);

/**
 * Check if a string is a canonical chain ID (not an alias)
 *
 * @param chain - String to check
 * @returns true if canonical ChainId, false if alias or unknown
 */
export function isCanonicalChainId(chain: string): chain is ChainId {
  return CANONICAL_IDS.has(chain);
}

/**
 * EVM mainnet chain IDs only
 */
export type EVMMainnetChainId =
  | 'ethereum'
  | 'polygon'
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'bsc'
  | 'avalanche'
  | 'fantom'
  | 'zksync'
  | 'linea'
  | 'blast'
  | 'scroll'
  | 'mantle'
  | 'mode';

/**
 * Testnet chain IDs only
 */
export type TestnetChainId =
  | 'sepolia'
  | 'arbitrum-sepolia'
  | 'base-sepolia'
  | 'zksync-sepolia'
  | 'solana-devnet';

/**
 * Non-EVM chain IDs only
 */
export type NonEVMChainId = 'solana' | 'solana-devnet';

/**
 * All mainnet chain IDs (EVM + non-EVM)
 */
export type MainnetChainId = EVMMainnetChainId | 'solana';

/**
 * All EVM chain IDs (mainnet + testnet)
 */
export type EVMChainId = EVMMainnetChainId | Exclude<TestnetChainId, 'solana-devnet'>;

/**
 * Check if a chain is an EVM chain
 *
 * @param chain - Chain identifier (handles aliases)
 * @returns true if EVM chain, false for Solana
 */
export function isEVMChain(chain: string): chain is EVMChainId {
  const normalized = normalizeChainId(chain);
  return normalized !== 'solana' && normalized !== 'solana-devnet';
}

/**
 * Check if a chain is a testnet
 *
 * @param chain - Chain identifier (handles aliases)
 * @returns true if testnet, false if mainnet
 */
export function isTestnet(chain: string): chain is TestnetChainId {
  const normalized = normalizeChainId(chain);
  return TESTNET_IDS.has(normalized);
}

/**
 * Check if a chain is a mainnet
 *
 * @param chain - Chain identifier (handles aliases)
 * @returns true if mainnet, false if testnet
 */
export function isMainnet(chain: string): chain is MainnetChainId {
  return !isTestnet(chain) && isCanonicalChainId(normalizeChainId(chain));
}

/**
 * Get all mainnet chain IDs
 */
export function getMainnetChains(): readonly MainnetChainId[] {
  return MAINNET_CHAINS;
}

/**
 * Get all testnet chain IDs
 */
export function getTestnetChains(): readonly TestnetChainId[] {
  return TESTNET_CHAINS;
}

/**
 * Get all EVM chain IDs (mainnet + testnet)
 */
export function getEVMChains(): readonly EVMChainId[] {
  return EVM_CHAINS;
}

/**
 * Get all chain IDs (mainnet + testnet, EVM + non-EVM)
 */
export function getAllChains(): readonly ChainId[] {
  return ALL_CHAINS;
}

/**
 * Chain metadata for display and validation
 */
export interface ChainMetadata {
  /** Canonical chain ID */
  id: ChainId;

  /** Human-readable name */
  name: string;

  /** EVM chain ID (null for non-EVM) */
  chainId: number | null;

  /** Is this a testnet? */
  testnet: boolean;

  /** Is this an EVM chain? */
  evm: boolean;

  /** Common aliases */
  aliases: readonly string[];
}

/**
 * Chain metadata registry
 */
export const CHAIN_METADATA: Readonly<Record<ChainId, ChainMetadata>> = {
  // EVM Mainnets
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum Mainnet',
    chainId: 1,
    testnet: false,
    evm: true,
    aliases: ['eth'],
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    chainId: 137,
    testnet: false,
    evm: true,
    aliases: ['matic'],
  },
  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    testnet: false,
    evm: true,
    aliases: ['arb'],
  },
  base: {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    testnet: false,
    evm: true,
    aliases: [],
  },
  optimism: {
    id: 'optimism',
    name: 'Optimism',
    chainId: 10,
    testnet: false,
    evm: true,
    aliases: ['op'],
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    testnet: false,
    evm: true,
    aliases: ['bnb', 'binance', 'binance-smart-chain'],
  },
  avalanche: {
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    chainId: 43114,
    testnet: false,
    evm: true,
    aliases: ['avax'],
  },
  fantom: {
    id: 'fantom',
    name: 'Fantom Opera',
    chainId: 250,
    testnet: false,
    evm: true,
    aliases: ['ftm'],
  },
  zksync: {
    id: 'zksync',
    name: 'zkSync Era',
    chainId: 324,
    testnet: false,
    evm: true,
    aliases: ['zksync-mainnet', 'zkSync'],
  },
  linea: {
    id: 'linea',
    name: 'Linea',
    chainId: 59144,
    testnet: false,
    evm: true,
    aliases: [],
  },
  blast: {
    id: 'blast',
    name: 'Blast',
    chainId: 81457,
    testnet: false,
    evm: true,
    aliases: [],
  },
  scroll: {
    id: 'scroll',
    name: 'Scroll',
    chainId: 534352,
    testnet: false,
    evm: true,
    aliases: [],
  },
  mantle: {
    id: 'mantle',
    name: 'Mantle',
    chainId: 5000,
    testnet: false,
    evm: true,
    aliases: ['mnt'],
  },
  mode: {
    id: 'mode',
    name: 'Mode',
    chainId: 34443,
    testnet: false,
    evm: true,
    aliases: [],
  },

  // Non-EVM
  solana: {
    id: 'solana',
    name: 'Solana Mainnet',
    chainId: null,
    testnet: false,
    evm: false,
    aliases: ['sol'],
  },

  // Testnets
  sepolia: {
    id: 'sepolia',
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    testnet: true,
    evm: true,
    aliases: [],
  },
  'arbitrum-sepolia': {
    id: 'arbitrum-sepolia',
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    testnet: true,
    evm: true,
    aliases: ['arbitrumSepolia'],
  },
  'base-sepolia': {
    id: 'base-sepolia',
    name: 'Base Sepolia',
    chainId: 84532,
    testnet: true,
    evm: true,
    aliases: ['baseSepolia'],
  },
  'zksync-sepolia': {
    id: 'zksync-sepolia',
    name: 'zkSync Era Sepolia',
    chainId: 300,
    testnet: true,
    evm: true,
    aliases: ['zksync-testnet', 'zkSyncSepolia'],
  },
  'solana-devnet': {
    id: 'solana-devnet',
    name: 'Solana Devnet',
    chainId: null,
    testnet: true,
    evm: false,
    aliases: [],
  },
} as const;

/**
 * Get chain metadata
 *
 * @param chain - Chain identifier (handles aliases)
 * @returns Chain metadata or undefined if not found
 */
export function getChainMetadata(chain: string): ChainMetadata | undefined {
  const normalized = normalizeChainId(chain);
  return CHAIN_METADATA[normalized];
}

/**
 * Get human-readable chain name
 *
 * @param chain - Chain identifier (handles aliases)
 * @returns Human-readable name or original input if not found
 */
export function getChainName(chain: string): string {
  const metadata = getChainMetadata(chain);
  return metadata?.name ?? chain;
}

/**
 * Get EVM chain ID number
 *
 * @param chain - Chain identifier (handles aliases)
 * @returns EVM chain ID or null for non-EVM chains
 */
export function getEVMChainId(chain: string): number | null {
  const metadata = getChainMetadata(chain);
  return metadata?.chainId ?? null;
}
