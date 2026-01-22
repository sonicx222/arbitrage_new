/**
 * Chain Configurations
 *
 * Contains all supported blockchain configurations including:
 * - T1: High arbitrage potential (Arbitrum, BSC, Base)
 * - T2: Mature ecosystems (Polygon, Optimism)
 * - T3: Selective opportunities (Ethereum)
 * - S3.1.2: New chains (Avalanche, Fantom, zkSync, Linea, Solana)
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import { Chain } from '../../../types';

// =============================================================================
// CHAIN CONFIGURATIONS - 11 Chains
// Priority: T1 (Arbitrum, BSC, Base), T2 (Polygon, Optimism), T3 (Ethereum)
// =============================================================================
export const CHAINS: Record<string, Chain> = {
  // T1: Highest arbitrage potential
  arbitrum: {
    id: 42161,
    name: 'Arbitrum',
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    wsUrl: process.env.ARBITRUM_WS_URL || 'wss://arb1.arbitrum.io/feed',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://arbitrum.publicnode.com',
      'wss://arbitrum-mainnet.public.blastapi.io',
      'wss://arb-mainnet.g.alchemy.com/v2/demo'
    ],
    rpcFallbackUrls: [
      'https://arbitrum.publicnode.com',
      'https://arbitrum-mainnet.public.blastapi.io',
      'https://arb1.croswap.com/rpc'
    ],
    blockTime: 0.25,
    nativeToken: 'ETH'
  },
  bsc: {
    id: 56,
    name: 'BSC',
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
    // FIX: Use more reliable publicnode.com as primary (nariox.org times out frequently)
    wsUrl: process.env.BSC_WS_URL || 'wss://bsc.publicnode.com',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://bsc-mainnet.public.blastapi.io',
      'wss://bsc-rpc.publicnode.com',
      'wss://bsc-ws-node.nariox.org:443'  // Moved to fallback - known to be unreliable
    ],
    rpcFallbackUrls: [
      'https://bsc-dataseed2.binance.org',
      'https://bsc-dataseed3.binance.org',
      'https://bsc.publicnode.com'
    ],
    blockTime: 3,
    nativeToken: 'BNB'
  },
  base: {
    id: 8453,
    name: 'Base',
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    wsUrl: process.env.BASE_WS_URL || 'wss://mainnet.base.org',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://base.publicnode.com',
      'wss://base-mainnet.public.blastapi.io'
    ],
    rpcFallbackUrls: [
      'https://base.publicnode.com',
      'https://base-mainnet.public.blastapi.io',
      'https://1rpc.io/base'
    ],
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // T2: High value, mature ecosystems
  polygon: {
    id: 137,
    name: 'Polygon',
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    wsUrl: process.env.POLYGON_WS_URL || 'wss://polygon-rpc.com',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://polygon-bor-rpc.publicnode.com',
      'wss://polygon-mainnet.public.blastapi.io'
    ],
    rpcFallbackUrls: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon-mainnet.public.blastapi.io',
      'https://polygon.llamarpc.com'
    ],
    blockTime: 2,
    nativeToken: 'MATIC'
  },
  optimism: {
    id: 10,
    name: 'Optimism',
    // FIX: Use public RPC as default when Alchemy key not configured (prevents malformed URL)
    rpcUrl: process.env.OPTIMISM_RPC_URL ||
      (process.env.ALCHEMY_OPTIMISM_KEY
        ? `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OPTIMISM_KEY}`
        : 'https://mainnet.optimism.io'),
    wsUrl: process.env.OPTIMISM_WS_URL ||
      (process.env.ALCHEMY_OPTIMISM_KEY
        ? `wss://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OPTIMISM_KEY}`
        : 'wss://optimism.publicnode.com'),
    wsFallbackUrls: [
      'wss://mainnet.optimism.io',
      'wss://optimism.publicnode.com',
      'wss://optimism-mainnet.public.blastapi.io'
    ],
    rpcFallbackUrls: [
      'https://mainnet.optimism.io',
      'https://optimism.publicnode.com',
      'https://optimism-mainnet.public.blastapi.io'
    ],
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // T3: Selective - only large opportunities
  ethereum: {
    id: 1,
    name: 'Ethereum',
    rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
    wsUrl: process.env.ETHEREUM_WS_URL || 'wss://eth.llamarpc.com',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://ethereum.publicnode.com',
      'wss://eth-mainnet.public.blastapi.io'
    ],
    rpcFallbackUrls: [
      'https://ethereum.publicnode.com',
      'https://eth-mainnet.public.blastapi.io',
      'https://1rpc.io/eth'
    ],
    blockTime: 12,
    nativeToken: 'ETH'
  },
  // =============================================================================
  // S3.1.2: New Chains for 4-Partition Architecture
  // =============================================================================
  // Asia-Fast expansion (P1)
  avalanche: {
    id: 43114,
    name: 'Avalanche C-Chain',
    rpcUrl: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
    wsUrl: process.env.AVALANCHE_WS_URL || 'wss://api.avax.network/ext/bc/C/ws',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://avalanche-c-chain.publicnode.com',
      'wss://avax-mainnet.public.blastapi.io/ext/bc/C/ws'
    ],
    rpcFallbackUrls: [
      'https://avalanche-c-chain.publicnode.com',
      'https://avax-mainnet.public.blastapi.io/ext/bc/C/rpc',
      'https://1rpc.io/avax/c'
    ],
    blockTime: 2,
    nativeToken: 'AVAX'
  },
  fantom: {
    id: 250,
    name: 'Fantom Opera',
    rpcUrl: process.env.FANTOM_RPC_URL || 'https://rpc.ftm.tools',
    // FIX: Use more reliable publicnode.com as primary (wsapi.fantom.network is unstable)
    wsUrl: process.env.FANTOM_WS_URL || 'wss://fantom.publicnode.com',
    // S3.3: WebSocket fallback URLs for resilience - expanded with more reliable providers
    wsFallbackUrls: [
      'wss://fantom-mainnet.public.blastapi.io',
      'wss://fantom.drpc.org',
      'wss://wsapi.fantom.network'  // Moved to fallback - known to be unreliable
    ],
    rpcFallbackUrls: [
      'https://fantom.publicnode.com',
      'https://fantom-mainnet.public.blastapi.io',
      'https://fantom.drpc.org',
      'https://1rpc.io/ftm'
    ],
    blockTime: 1,
    nativeToken: 'FTM'
  },
  // High-Value expansion (P3)
  zksync: {
    id: 324,
    name: 'zkSync Era',
    rpcUrl: process.env.ZKSYNC_RPC_URL || 'https://mainnet.era.zksync.io',
    wsUrl: process.env.ZKSYNC_WS_URL || 'wss://mainnet.era.zksync.io/ws',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://zksync.drpc.org',
      'wss://zksync-era.publicnode.com'
    ],
    rpcFallbackUrls: [
      'https://zksync.drpc.org',
      'https://zksync-era.publicnode.com',
      'https://1rpc.io/zksync2-era'
    ],
    blockTime: 1,
    nativeToken: 'ETH'
  },
  linea: {
    id: 59144,
    name: 'Linea',
    rpcUrl: process.env.LINEA_RPC_URL || 'https://rpc.linea.build',
    wsUrl: process.env.LINEA_WS_URL || 'wss://rpc.linea.build',
    // S3.3: WebSocket fallback URLs for resilience
    wsFallbackUrls: [
      'wss://linea.drpc.org'
    ],
    rpcFallbackUrls: [
      'https://linea.drpc.org',
      'https://1rpc.io/linea',
      'https://linea-mainnet.public.blastapi.io'
    ],
    blockTime: 2,
    nativeToken: 'ETH'
  },
  // Non-EVM chain (P4)
  // S3.3.7: Enhanced RPC configuration with Helius/Triton support
  // Priority order: 1. Explicit URL, 2. Helius, 3. Triton, 4. Public RPC
  solana: {
    id: 101, // Convention for Solana mainnet
    name: 'Solana',
    // Primary: Use explicit URL > Helius > Triton > Public RPC
    rpcUrl: process.env.SOLANA_RPC_URL ||
      (process.env.HELIUS_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : process.env.TRITON_API_KEY
          ? `https://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`
          : 'https://api.mainnet-beta.solana.com'),
    wsUrl: process.env.SOLANA_WS_URL ||
      (process.env.HELIUS_API_KEY
        ? `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : process.env.TRITON_API_KEY
          ? `wss://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`
          : 'wss://api.mainnet-beta.solana.com'),
    // S3.3.7: Prioritized fallback URLs (Triton > PublicNode > Public RPC)
    wsFallbackUrls: [
      // Triton fallback (if API key available and not already primary)
      ...(process.env.TRITON_API_KEY && !process.env.HELIUS_API_KEY
        ? [] // Already primary, no need as fallback
        : process.env.TRITON_API_KEY
          ? [`wss://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`]
          : []),
      'wss://solana.publicnode.com',
      'wss://api.mainnet-beta.solana.com'
    ],
    rpcFallbackUrls: [
      // Triton fallback (if API key available and not already primary)
      ...(process.env.TRITON_API_KEY && !process.env.HELIUS_API_KEY
        ? [] // Already primary, no need as fallback
        : process.env.TRITON_API_KEY
          ? [`https://solana-mainnet.triton.one/v1/${process.env.TRITON_API_KEY}`]
          : []),
      'https://solana-mainnet.rpc.extrnode.com',
      'https://solana.publicnode.com',
      'https://api.mainnet-beta.solana.com',
      'https://solana-mainnet.g.alchemy.com/v2/demo'
    ],
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
  'ethereum', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'
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
