/**
 * Chain Configurations
 *
 * Contains all supported blockchain configurations including:
 * - T1: High arbitrage potential (Arbitrum, BSC, Base)
 * - T2: Mature ecosystems (Polygon, Optimism)
 * - T3: Selective opportunities (Ethereum)
 * - S3.1.2: New chains (Avalanche, Fantom, zkSync, Linea, Solana)
 *
 * Updated with 7-Provider Shield Architecture:
 * Priority: dRPC → OnFinality → Ankr → PublicNode → Infura → Alchemy → BlastAPI
 * Combined Free Tier: ~555M CU/month + unlimited PublicNode
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see docs/reports/RPC_DEEP_DIVE_ANALYSIS.md
 */

import { Chain } from '../../../types';

// =============================================================================
// 8-PROVIDER SHIELD: API KEY BASED URL BUILDERS
// Priority: dRPC (210M CU) → OnFinality (500K/day) → Ankr (200M) → PublicNode (unlimited) → Infura → Alchemy
// =============================================================================

const DRPC_KEY = process.env.DRPC_API_KEY;
const ONFINALITY_KEY = process.env.ONFINALITY_API_KEY;
const ANKR_KEY = process.env.ANKR_API_KEY;
const INFURA_KEY = process.env.INFURA_API_KEY;
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;

/** Build dRPC URL with API key (PRIMARY - 210M CU/month, 40-100 RPS) */
const drpc = (network: string, ws = false) =>
  DRPC_KEY
    ? `${ws ? 'wss' : 'https'}://lb.drpc.org/${ws ? 'ogws' : 'ogrpc'}?network=${network}&dkey=${DRPC_KEY}`
    : `${ws ? 'wss' : 'https'}://${network}.drpc.org`;

/** Build OnFinality URL with API key (SECONDARY - 500K daily reqs, BSC/Polygon/Avalanche/Fantom) */
const onfinality = (network: string, ws = false) =>
  ONFINALITY_KEY
    ? `${ws ? 'wss' : 'https'}://${network}.api.onfinality.io/${ws ? 'ws' : 'rpc'}?apikey=${ONFINALITY_KEY}`
    : null;

/** Build Ankr URL with API key (SECONDARY - 200M CU/month, 30 RPS) */
const ankr = (network: string, ws = false) =>
  ANKR_KEY
    ? `${ws ? 'wss' : 'https'}://rpc.ankr.com/${network}/${ANKR_KEY}`
    : `${ws ? 'wss' : 'https'}://rpc.ankr.com/${network}`;

/** Build PublicNode URL (OVERFLOW - Unlimited, ~100-200 RPS, NO KEY NEEDED) */
const publicNode = (network: string, ws = false) =>
  `${ws ? 'wss' : 'https'}://${network}.publicnode.com`;

/** Build Infura URL with API key (TERTIARY - 3M/day = ~90M/month) */
const infura = (network: string, ws = false) =>
  INFURA_KEY
    ? `${ws ? 'wss' : 'https'}://${network}.infura.io${ws ? '/ws' : ''}/v3/${INFURA_KEY}`
    : null;

/** Build Alchemy URL with API key (QUALITY RESERVE - 30M CU/month) */
const alchemy = (network: string, ws = false) =>
  ALCHEMY_KEY
    ? `${ws ? 'wss' : 'https'}://${network}-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
    : null;

/** Build BlastAPI URL (PUBLIC FALLBACK - no key needed) */
const blastapi = (network: string, ws = false) =>
  `${ws ? 'wss' : 'https'}://${network}-mainnet.public.blastapi.io`;

/** Helper to filter out null values and create fallback array */
const fallbacks = (...urls: (string | null)[]): string[] =>
  urls.filter((url): url is string => url !== null);

// =============================================================================
// CHAIN CONFIGURATIONS - 15 Chains
// Priority: T1 (Arbitrum, BSC, Base), T2 (Polygon, Optimism), T3 (Ethereum)
// S3.1.2: New chains (Avalanche, Fantom, zkSync, Linea, Solana)
// Emerging L2s: Blast, Scroll, Mantle, Mode
// Updated with 7-Provider Shield: dRPC → OnFinality → Ankr → PublicNode → Infura → Alchemy → BlastAPI
// =============================================================================
export const CHAINS: Record<string, Chain> = {
  // T1: Highest arbitrage potential
  arbitrum: {
    id: 42161,
    name: 'Arbitrum',
    // Primary: dRPC (210M CU/month) > Ankr > PublicNode > Official
    rpcUrl: process.env.ARBITRUM_RPC_URL || drpc('arbitrum') || 'https://arb1.arbitrum.io/rpc',
    wsUrl: process.env.ARBITRUM_WS_URL || drpc('arbitrum', true) || 'wss://arb1.arbitrum.io/feed',
    // 7-Provider Shield fallbacks in priority order
    wsFallbackUrls: fallbacks(
      ankr('arbitrum', true),
      publicNode('arbitrum-one-rpc', true),
      infura('arbitrum-mainnet', true),
      alchemy('arb', true),
      blastapi('arbitrum', true),
      'wss://arb1.arbitrum.io/feed'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('arbitrum'),
      publicNode('arbitrum-one-rpc'),
      infura('arbitrum-mainnet'),
      alchemy('arb'),
      blastapi('arbitrum'),
      'https://arb1.arbitrum.io/rpc',
      'https://1rpc.io/arb'
    ),
    blockTime: 0.25,
    nativeToken: 'ETH'
  },
  bsc: {
    id: 56,
    name: 'BSC',
    // Primary: dRPC > OnFinality > Ankr > PublicNode (Infura/Alchemy don't support BSC)
    rpcUrl: process.env.BSC_RPC_URL || drpc('bsc') || 'https://bsc-dataseed1.binance.org',
    wsUrl: process.env.BSC_WS_URL || drpc('bsc', true) || publicNode('bsc-rpc', true),
    // 7-Provider Shield fallbacks (BSC: OnFinality, Ankr, PublicNode, BlastAPI)
    wsFallbackUrls: fallbacks(
      onfinality('bsc', true),
      ankr('bsc', true),
      publicNode('bsc-rpc', true),
      blastapi('bsc', true),
      'wss://bsc-ws-node.nariox.org:443'
    ),
    rpcFallbackUrls: fallbacks(
      onfinality('bsc'),
      ankr('bsc'),
      publicNode('bsc-rpc'),
      blastapi('bsc'),
      'https://bsc-dataseed1.binance.org',
      'https://bsc-dataseed2.binance.org',
      'https://1rpc.io/bnb'
    ),
    blockTime: 3,
    nativeToken: 'BNB'
  },
  base: {
    id: 8453,
    name: 'Base',
    // Primary: dRPC > Ankr > PublicNode > Alchemy (Infura doesn't support Base)
    rpcUrl: process.env.BASE_RPC_URL || drpc('base') || 'https://mainnet.base.org',
    wsUrl: process.env.BASE_WS_URL || drpc('base', true) || publicNode('base-rpc', true),
    // 7-Provider Shield fallbacks
    wsFallbackUrls: fallbacks(
      ankr('base', true),
      publicNode('base-rpc', true),
      alchemy('base', true),
      blastapi('base', true),
      'wss://mainnet.base.org'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('base'),
      publicNode('base-rpc'),
      alchemy('base'),
      blastapi('base'),
      'https://mainnet.base.org',
      'https://1rpc.io/base'
    ),
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // T2: High value, mature ecosystems
  polygon: {
    id: 137,
    name: 'Polygon',
    // Primary: dRPC > OnFinality > Ankr > PublicNode > Infura > Alchemy
    rpcUrl: process.env.POLYGON_RPC_URL || drpc('polygon') || 'https://polygon-rpc.com',
    wsUrl: process.env.POLYGON_WS_URL || drpc('polygon', true) || publicNode('polygon-bor-rpc', true),
    // 7-Provider Shield fallbacks
    wsFallbackUrls: fallbacks(
      onfinality('polygon', true),
      ankr('polygon', true),
      publicNode('polygon-bor-rpc', true),
      infura('polygon-mainnet', true),
      alchemy('polygon', true),
      blastapi('polygon', true),
      'wss://polygon-rpc.com'
    ),
    rpcFallbackUrls: fallbacks(
      onfinality('polygon'),
      ankr('polygon'),
      publicNode('polygon-bor-rpc'),
      infura('polygon-mainnet'),
      alchemy('polygon'),
      blastapi('polygon'),
      'https://polygon-rpc.com',
      'https://1rpc.io/matic'
    ),
    blockTime: 2,
    nativeToken: 'MATIC'
  },
  optimism: {
    id: 10,
    name: 'Optimism',
    // Primary: dRPC > Ankr > PublicNode > Infura > Alchemy
    rpcUrl: process.env.OPTIMISM_RPC_URL || drpc('optimism') || 'https://mainnet.optimism.io',
    wsUrl: process.env.OPTIMISM_WS_URL || drpc('optimism', true) || publicNode('optimism-rpc', true),
    // 7-Provider Shield fallbacks
    wsFallbackUrls: fallbacks(
      ankr('optimism', true),
      publicNode('optimism-rpc', true),
      infura('optimism-mainnet', true),
      alchemy('opt', true),
      blastapi('optimism', true),
      'wss://mainnet.optimism.io'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('optimism'),
      publicNode('optimism-rpc'),
      infura('optimism-mainnet'),
      alchemy('opt'),
      blastapi('optimism'),
      'https://mainnet.optimism.io',
      'https://1rpc.io/op'
    ),
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // T3: Selective - only large opportunities
  ethereum: {
    id: 1,
    name: 'Ethereum',
    // Primary: dRPC > Ankr > PublicNode > Infura > Alchemy (full provider support)
    rpcUrl: process.env.ETHEREUM_RPC_URL || drpc('ethereum') || 'https://eth.llamarpc.com',
    wsUrl: process.env.ETHEREUM_WS_URL || drpc('ethereum', true) || publicNode('ethereum-rpc', true),
    // 7-Provider Shield fallbacks - Ethereum has best provider coverage
    wsFallbackUrls: fallbacks(
      ankr('eth', true),
      publicNode('ethereum-rpc', true),
      infura('mainnet', true),
      alchemy('eth', true),
      blastapi('eth', true),
      'wss://eth.llamarpc.com'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('eth'),
      publicNode('ethereum-rpc'),
      infura('mainnet'),
      alchemy('eth'),
      blastapi('eth'),
      'https://eth.llamarpc.com',
      'https://1rpc.io/eth'
    ),
    blockTime: 12,
    nativeToken: 'ETH'
  },
  // =============================================================================
  // S3.1.2: New Chains for 4-Partition Architecture
  // Updated with 7-Provider Shield fallback strategy
  // =============================================================================
  // Asia-Fast expansion (P1)
  avalanche: {
    id: 43114,
    name: 'Avalanche C-Chain',
    // Primary: dRPC > OnFinality > Ankr > PublicNode > Infura > Alchemy
    rpcUrl: process.env.AVALANCHE_RPC_URL || drpc('avalanche-c') || 'https://api.avax.network/ext/bc/C/rpc',
    wsUrl: process.env.AVALANCHE_WS_URL || drpc('avalanche-c', true) || publicNode('avalanche-c-chain-rpc', true),
    // 7-Provider Shield fallbacks
    wsFallbackUrls: fallbacks(
      onfinality('avalanche', true),
      ankr('avalanche', true),
      publicNode('avalanche-c-chain-rpc', true),
      infura('avalanche-mainnet', true),
      alchemy('avax', true),
      blastapi('avax', true),
      'wss://api.avax.network/ext/bc/C/ws'
    ),
    rpcFallbackUrls: fallbacks(
      onfinality('avalanche'),
      ankr('avalanche'),
      publicNode('avalanche-c-chain-rpc'),
      infura('avalanche-mainnet'),
      alchemy('avax'),
      blastapi('avax'),
      'https://api.avax.network/ext/bc/C/rpc',
      'https://1rpc.io/avax/c'
    ),
    blockTime: 2,
    nativeToken: 'AVAX'
  },
  fantom: {
    id: 250,
    name: 'Fantom Opera',
    // Primary: dRPC > OnFinality > Ankr > PublicNode > Alchemy (limited Infura support)
    rpcUrl: process.env.FANTOM_RPC_URL || drpc('fantom') || 'https://rpc.ftm.tools',
    wsUrl: process.env.FANTOM_WS_URL || drpc('fantom', true) || publicNode('fantom-rpc', true),
    // 7-Provider Shield fallbacks
    wsFallbackUrls: fallbacks(
      onfinality('fantom', true),
      ankr('fantom', true),
      publicNode('fantom-rpc', true),
      alchemy('fantom', true),
      blastapi('fantom', true),
      'wss://wsapi.fantom.network'
    ),
    rpcFallbackUrls: fallbacks(
      onfinality('fantom'),
      ankr('fantom'),
      publicNode('fantom-rpc'),
      alchemy('fantom'),
      blastapi('fantom'),
      'https://rpc.ftm.tools',
      'https://1rpc.io/ftm'
    ),
    blockTime: 1,
    nativeToken: 'FTM'
  },
  // High-Value expansion (P3)
  zksync: {
    id: 324,
    name: 'zkSync Era',
    // Primary: dRPC > Ankr > PublicNode > Infura > Alchemy
    rpcUrl: process.env.ZKSYNC_RPC_URL || drpc('zksync') || 'https://mainnet.era.zksync.io',
    wsUrl: process.env.ZKSYNC_WS_URL || drpc('zksync', true) || publicNode('zksync-era-rpc', true),
    // 7-Provider Shield fallbacks
    wsFallbackUrls: fallbacks(
      ankr('zksync_era', true),
      publicNode('zksync-era-rpc', true),
      infura('zksync-mainnet', true),
      alchemy('zksync', true),
      blastapi('zksync', true),
      'wss://mainnet.era.zksync.io/ws'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('zksync_era'),
      publicNode('zksync-era-rpc'),
      infura('zksync-mainnet'),
      alchemy('zksync'),
      blastapi('zksync'),
      'https://mainnet.era.zksync.io',
      'https://1rpc.io/zksync2-era'
    ),
    blockTime: 1,
    nativeToken: 'ETH'
  },
  linea: {
    id: 59144,
    name: 'Linea',
    // Primary: dRPC > Ankr > PublicNode > Infura (Alchemy limited support)
    rpcUrl: process.env.LINEA_RPC_URL || drpc('linea') || 'https://rpc.linea.build',
    wsUrl: process.env.LINEA_WS_URL || drpc('linea', true) || publicNode('linea-rpc', true),
    // 7-Provider Shield fallbacks
    wsFallbackUrls: fallbacks(
      ankr('linea', true),
      publicNode('linea-rpc', true),
      infura('linea-mainnet', true),
      blastapi('linea', true),
      'wss://rpc.linea.build'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('linea'),
      publicNode('linea-rpc'),
      infura('linea-mainnet'),
      blastapi('linea'),
      'https://rpc.linea.build',
      'https://1rpc.io/linea'
    ),
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // =============================================================================
  // Emerging L2s: Blast, Scroll, Mantle, Mode
  // Fast-growing L2 chains added for expanded arbitrage surface
  // =============================================================================
  blast: {
    id: 81457,
    name: 'Blast',
    // Primary: dRPC > Ankr > chain-native RPC
    rpcUrl: process.env.BLAST_RPC_URL || drpc('blast') || 'https://rpc.blast.io',
    wsUrl: process.env.BLAST_WS_URL || drpc('blast', true) || 'wss://rpc.blast.io',
    // Fallbacks
    wsFallbackUrls: fallbacks(
      ankr('blast', true),
      publicNode('blast-rpc', true),
      'wss://rpc.blast.io'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('blast'),
      publicNode('blast-rpc'),
      'https://rpc.blast.io',
      'https://1rpc.io/blast'
    ),
    blockTime: 2,
    nativeToken: 'ETH'
  },
  scroll: {
    id: 534352,
    name: 'Scroll',
    // Primary: dRPC > Ankr > chain-native RPC
    rpcUrl: process.env.SCROLL_RPC_URL || drpc('scroll') || 'https://rpc.scroll.io',
    wsUrl: process.env.SCROLL_WS_URL || drpc('scroll', true) || 'wss://rpc.scroll.io',
    // Fallbacks
    wsFallbackUrls: fallbacks(
      ankr('scroll', true),
      publicNode('scroll-rpc', true),
      'wss://rpc.scroll.io'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('scroll'),
      publicNode('scroll-rpc'),
      'https://rpc.scroll.io',
      'https://1rpc.io/scroll'
    ),
    blockTime: 3,
    nativeToken: 'ETH'
  },
  mantle: {
    id: 5000,
    name: 'Mantle',
    // Primary: dRPC > Ankr > chain-native RPC
    rpcUrl: process.env.MANTLE_RPC_URL || drpc('mantle') || 'https://rpc.mantle.xyz',
    wsUrl: process.env.MANTLE_WS_URL || drpc('mantle', true) || 'wss://rpc.mantle.xyz',
    // Fallbacks
    wsFallbackUrls: fallbacks(
      ankr('mantle', true),
      publicNode('mantle-rpc', true),
      'wss://rpc.mantle.xyz'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('mantle'),
      publicNode('mantle-rpc'),
      'https://rpc.mantle.xyz',
      'https://1rpc.io/mantle'
    ),
    blockTime: 2,
    nativeToken: 'MNT'
  },
  mode: {
    id: 34443,
    name: 'Mode',
    // Primary: dRPC > Ankr > chain-native RPC
    rpcUrl: process.env.MODE_RPC_URL || drpc('mode') || 'https://mainnet.mode.network',
    wsUrl: process.env.MODE_WS_URL || drpc('mode', true) || 'wss://mainnet.mode.network',
    // Fallbacks
    wsFallbackUrls: fallbacks(
      ankr('mode', true),
      publicNode('mode-rpc', true),
      'wss://mainnet.mode.network'
    ),
    rpcFallbackUrls: fallbacks(
      ankr('mode'),
      publicNode('mode-rpc'),
      'https://mainnet.mode.network',
      'https://1rpc.io/mode'
    ),
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // Non-EVM chain (P4)
  // Solana: Helius > Triton > dRPC > Ankr > PublicNode > Public RPC
  // Note: Helius/Triton are premium Solana-specific providers
  solana: {
    id: 101, // Convention for Solana mainnet
    name: 'Solana',
    // Primary: Helius > Triton > dRPC > Ankr > PublicNode > Public RPC
    rpcUrl: process.env.SOLANA_RPC_URL ||
      (process.env.HELIUS_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : process.env.TRITON_API_KEY
          ? `https://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`
          : drpc('solana') || 'https://api.mainnet-beta.solana.com'),
    wsUrl: process.env.SOLANA_WS_URL ||
      (process.env.HELIUS_API_KEY
        ? `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : process.env.TRITON_API_KEY
          ? `wss://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`
          : drpc('solana', true) || publicNode('solana-rpc', true)),
    // 7-Provider Shield + Solana-specific fallbacks
    wsFallbackUrls: fallbacks(
      // Triton as fallback if Helius is primary
      process.env.TRITON_API_KEY && process.env.HELIUS_API_KEY
        ? `wss://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`
        : null,
      // Add dRPC/Ankr if not already primary
      !process.env.HELIUS_API_KEY && !process.env.TRITON_API_KEY ? null : drpc('solana', true),
      ankr('solana', true),
      publicNode('solana-rpc', true),
      'wss://api.mainnet-beta.solana.com'
    ),
    rpcFallbackUrls: fallbacks(
      // Triton as fallback if Helius is primary
      process.env.TRITON_API_KEY && process.env.HELIUS_API_KEY
        ? `https://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`
        : null,
      !process.env.HELIUS_API_KEY && !process.env.TRITON_API_KEY ? null : drpc('solana'),
      ankr('solana'),
      publicNode('solana-rpc'),
      'https://solana-mainnet.rpc.extrnode.com',
      'https://api.mainnet-beta.solana.com'
    ),
    blockTime: 0.4,
    nativeToken: 'SOL',
    isEVM: false
  }
};

// =============================================================================
// MAINNET CHAIN IDS
// List of production mainnet chain identifiers for filtering
// =============================================================================
export const MAINNET_CHAIN_IDS = [
  'arbitrum', 'bsc', 'base', 'polygon', 'optimism',
  'ethereum', 'avalanche', 'fantom', 'zksync', 'linea',
  'blast', 'scroll', 'mantle', 'mode', 'solana'
] as const;

export type MainnetChainId = typeof MAINNET_CHAIN_IDS[number];

// =============================================================================
// TESTNET CHAINS
// Separated from production CHAINS to prevent test/prod data mixing
// Import from here for testing purposes only
// =============================================================================
export const TESTNET_CHAINS: Record<string, Chain> = {
  // S3.3.7: Solana Devnet for testing
  // Priority order: 1. Explicit URL, 2. Helius, 3. Triton, 4. Public RPC
  'solana-devnet': {
    id: 102, // Convention for Solana devnet
    name: 'Solana Devnet',
    rpcUrl: process.env.SOLANA_DEVNET_RPC_URL ||
      (process.env.HELIUS_API_KEY
        ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : process.env.TRITON_API_KEY
          ? `https://solana-devnet.triton.one/v1/${process.env.TRITON_API_KEY}`
          : 'https://api.devnet.solana.com'),
    wsUrl: process.env.SOLANA_DEVNET_WS_URL ||
      (process.env.HELIUS_API_KEY
        ? `wss://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : process.env.TRITON_API_KEY
          ? `wss://solana-devnet.triton.one/v1/${process.env.TRITON_API_KEY}`
          : 'wss://api.devnet.solana.com'),
    wsFallbackUrls: [
      // Triton fallback (if API key available and not already primary)
      ...(process.env.TRITON_API_KEY && !process.env.HELIUS_API_KEY
        ? []
        : process.env.TRITON_API_KEY
          ? [`wss://solana-devnet.triton.one/v1/${process.env.TRITON_API_KEY}`]
          : []),
      'wss://solana-devnet.publicnode.com',
      'wss://api.devnet.solana.com'
    ],
    rpcFallbackUrls: [
      // Triton fallback (if API key available and not already primary)
      ...(process.env.TRITON_API_KEY && !process.env.HELIUS_API_KEY
        ? []
        : process.env.TRITON_API_KEY
          ? [`https://solana-devnet.triton.one/v1/${process.env.TRITON_API_KEY}`]
          : []),
      'https://solana-devnet.publicnode.com',
      'https://api.devnet.solana.com'
    ],
    blockTime: 0.4,
    nativeToken: 'SOL',
    isEVM: false
  }
};

/**
 * Get all chains including testnets.
 * Use this only for test environments or when explicitly needing testnet access.
 */
export function getAllChains(): Record<string, Chain> {
  return { ...CHAINS, ...TESTNET_CHAINS };
}

// =============================================================================
// CHAIN URL BUILDER (P2-CONFIG)
// Utility for building chain URLs with consistent env var resolution
// =============================================================================
export {
  buildChainUrls,
  buildChainUrlsWithApiKeys,
  buildSolanaUrls,
  createAlchemyConfig,
  createInfuraConfig,
  createDrpcConfig,
  createAnkrConfig,
  createOnFinalityConfig,
  STANDARD_FALLBACK_PROVIDERS,
  ChainUrlConfig,
  ApiKeyUrlConfig,
  ChainUrls,
} from './chain-url-builder';

// =============================================================================
// 7-PROVIDER SHIELD CONFIGURATION
// Provider configs and utilities for RPC management
// =============================================================================
export {
  PROVIDER_CONFIGS,
  CHAIN_NETWORK_NAMES,
  ProviderTier,
  buildDrpcUrl,
  buildAnkrUrl,
  buildPublicNodeUrl,
  buildOnFinalityUrl,
  buildInfuraUrl,
  buildAlchemyUrl,
  buildBlastApiUrl,
  getProviderUrlsForChain,
  getTimeBasedProviderOrder,
  calculateProviderBudget,
  type ProviderConfig,
  type ProviderBudget,
} from './provider-config';

// =============================================================================
// BLOCK TIME UTILITIES (Consolidated from price-calculator.ts)
// Single source of truth for chain block times
// =============================================================================

/**
 * Pre-computed block times in milliseconds for O(1) lookup.
 * Derived from CHAINS config blockTime (in seconds) * 1000.
 *
 * Used by:
 * - price-calculator.ts for data freshness/staleness scoring
 * - websocket-manager.ts for connection health
 * - base-detector.ts for event timing
 */
export const BLOCK_TIMES_MS: Readonly<Record<string, number>> = Object.freeze(
  Object.entries(CHAINS).reduce((acc, [chain, config]) => {
    acc[chain] = Math.round(config.blockTime * 1000);
    return acc;
  }, {} as Record<string, number>)
);

// Cache for normalized chain names to avoid toLowerCase() in hot path
const normalizedChainCache = new Map<string, string>();

/**
 * Get block time for a chain in milliseconds.
 * Defaults to Ethereum block time (12000ms) for unknown chains.
 *
 * Performance optimized:
 * - Uses pre-computed BLOCK_TIMES_MS for O(1) lookup
 * - Caches normalized chain names to avoid string allocation in hot path
 *
 * @param chain - Chain name (case-insensitive)
 * @returns Block time in milliseconds
 */
export function getBlockTimeMs(chain: string): number {
  // Fast path: direct lookup for already lowercase chains
  const direct = BLOCK_TIMES_MS[chain];
  if (direct !== undefined) {
    return direct;
  }

  // Check cache before creating new lowercase string
  let normalized = normalizedChainCache.get(chain);
  if (!normalized) {
    normalized = chain.toLowerCase();
    // Limit cache size to prevent memory leak from malicious input
    if (normalizedChainCache.size < 100) {
      normalizedChainCache.set(chain, normalized);
    }
  }

  return BLOCK_TIMES_MS[normalized] ?? 12000; // Default to Ethereum block time
}

/**
 * Get block time for a chain in seconds.
 * Convenience wrapper around getBlockTimeMs.
 *
 * @param chain - Chain name (case-insensitive)
 * @returns Block time in seconds
 */
export function getBlockTimeSec(chain: string): number {
  return getBlockTimeMs(chain) / 1000;
}
