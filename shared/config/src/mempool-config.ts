/**
 * Mempool Detection Configuration
 *
 * Configuration for mempool monitoring via bloXroute BDN and other providers.
 * Used by the mempool-detector service for pre-block arbitrage detection.
 *
 * @see Phase 1: Mempool Detection Service (Implementation Plan v3.0)
 */

// =============================================================================
// MEMPOOL DETECTION CONFIGURATION
// =============================================================================

export const MEMPOOL_CONFIG = {
  /** Enable mempool detection globally */
  enabled: process.env.MEMPOOL_DETECTION_ENABLED === 'true',

  /** bloXroute BDN Configuration */
  bloxroute: {
    /** Authorization header for bloXroute API */
    authHeader: process.env.BLOXROUTE_AUTH_HEADER || '',
    /** bloXroute WebSocket endpoint */
    wsEndpoint: process.env.BLOXROUTE_WS_ENDPOINT || 'wss://eth.blxrbdn.com/ws',
    /** bloXroute BSC WebSocket endpoint */
    bscWsEndpoint: process.env.BLOXROUTE_BSC_WS_ENDPOINT || 'wss://bsc.blxrbdn.com/ws',
    /** Enable bloXroute feed */
    enabled: process.env.BLOXROUTE_ENABLED === 'true',
    /** Connection timeout in ms */
    connectionTimeout: parseInt(process.env.BLOXROUTE_CONNECTION_TIMEOUT || '10000', 10),
    /** Heartbeat interval in ms */
    heartbeatInterval: parseInt(process.env.BLOXROUTE_HEARTBEAT_INTERVAL || '30000', 10),
    /** Reconnect settings */
    reconnect: {
      /** Base reconnect interval in ms */
      interval: parseInt(process.env.BLOXROUTE_RECONNECT_INTERVAL || '1000', 10),
      /** Maximum reconnect attempts */
      maxAttempts: parseInt(process.env.BLOXROUTE_MAX_RECONNECT_ATTEMPTS || '10', 10),
      /** Backoff multiplier */
      backoffMultiplier: parseFloat(process.env.BLOXROUTE_BACKOFF_MULTIPLIER || '2.0'),
      /** Maximum delay in ms */
      maxDelay: parseInt(process.env.BLOXROUTE_MAX_RECONNECT_DELAY || '60000', 10),
    },
  },

  /** Service configuration */
  service: {
    /** Health check port */
    port: parseInt(process.env.MEMPOOL_DETECTOR_PORT || '3007', 10),
    /** Instance ID */
    instanceId: process.env.MEMPOOL_INSTANCE_ID || `mempool-detector-${Date.now()}`,
    /** Maximum pending transactions in buffer */
    maxBufferSize: parseInt(process.env.MEMPOOL_MAX_BUFFER_SIZE || '10000', 10),
    /** Processing batch size */
    batchSize: parseInt(process.env.MEMPOOL_BATCH_SIZE || '100', 10),
    /** Processing batch timeout in ms */
    batchTimeoutMs: parseInt(process.env.MEMPOOL_BATCH_TIMEOUT_MS || '50', 10),
  },

  /** Filtering configuration */
  filters: {
    /** Minimum swap size in USD to process */
    minSwapSizeUsd: parseInt(process.env.MEMPOOL_MIN_SWAP_SIZE_USD || '1000', 10),
    /** Filter for known arbitrage bot addresses (optional) */
    includeTraders: process.env.MEMPOOL_INCLUDE_TRADERS?.split(',').filter(Boolean) || [],
    /** Filter for specific router addresses (optional) */
    includeRouters: process.env.MEMPOOL_INCLUDE_ROUTERS?.split(',').filter(Boolean) || [],
  },

  /** Redis stream configuration */
  streams: {
    /** Stream name for pending opportunities */
    pendingOpportunities: process.env.MEMPOOL_PENDING_STREAM || 'stream:pending-opportunities',
    /** Consumer group name */
    consumerGroup: process.env.MEMPOOL_CONSUMER_GROUP || 'mempool-detector-group',
    /** Maximum stream length (approximate) */
    maxStreamLength: parseInt(process.env.MEMPOOL_MAX_STREAM_LENGTH || '100000', 10),
  },

  /** Chain-specific mempool settings */
  chainSettings: {
    ethereum: {
      enabled: true,
      feedType: 'bloxroute' as const,
      endpoint: process.env.BLOXROUTE_WS_ENDPOINT || 'wss://eth.blxrbdn.com/ws',
      /** Ethereum block time ~12s, check pending frequently */
      pollIntervalMs: 100,
      /** Expected latency for pending tx detection */
      expectedLatencyMs: 10,
    },
    bsc: {
      enabled: true,
      feedType: 'bloxroute' as const,
      endpoint: process.env.BLOXROUTE_BSC_WS_ENDPOINT || 'wss://bsc.blxrbdn.com/ws',
      /** BSC block time ~3s */
      pollIntervalMs: 50,
      expectedLatencyMs: 10,
    },
    polygon: {
      enabled: false, // bloXroute support TBD
      feedType: 'rpc' as const,
      endpoint: '', // Use standard RPC mempool subscription
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    arbitrum: {
      enabled: false, // L2 sequencer makes mempool less relevant
      feedType: 'rpc' as const,
      endpoint: '',
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    optimism: {
      enabled: false,
      feedType: 'rpc' as const,
      endpoint: '',
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    base: {
      enabled: false,
      feedType: 'rpc' as const,
      endpoint: '',
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    // FIX #26: Add missing chain settings (avalanche, fantom, zksync, linea, solana)
    avalanche: {
      enabled: false, // C-Chain mempool via RPC subscription
      feedType: 'rpc' as const,
      endpoint: '',
      /** Avalanche C-Chain block time ~2s */
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    fantom: {
      enabled: false, // Fantom mempool via RPC subscription
      feedType: 'rpc' as const,
      endpoint: '',
      /** Fantom block time ~1s */
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    zksync: {
      enabled: false, // zkSync Era sequencer makes mempool less useful
      feedType: 'rpc' as const,
      endpoint: '',
      /** zkSync Era block time ~1-5s */
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    linea: {
      enabled: false, // Linea sequencer-based
      feedType: 'rpc' as const,
      endpoint: '',
      /** Linea block time ~2-5s */
      pollIntervalMs: 50,
      expectedLatencyMs: 50,
    },
    solana: {
      enabled: false, // Solana requires different transaction handling
      feedType: 'rpc' as const,
      endpoint: '',
      /** Solana block time ~400ms */
      pollIntervalMs: 25,
      expectedLatencyMs: 10,
    },
  } as Record<string, {
    enabled: boolean;
    feedType: 'bloxroute' | 'rpc' | 'eden' | 'flashbots';
    endpoint: string;
    pollIntervalMs: number;
    expectedLatencyMs: number;
  }>,
};

// =============================================================================
// KNOWN ROUTER ADDRESSES
// =============================================================================

/**
 * Known DEX router addresses mapped to their types.
 * Used by the decoder registry to identify swap transactions.
 *
 * FIX 3.3: Added comprehensive L2 router configurations for
 * Polygon, Arbitrum, Optimism, and Base networks.
 *
 * Note: Addresses are stored in lowercase for consistent O(1) lookups.
 */
export const KNOWN_ROUTERS = {
  // Ethereum Mainnet (chainId: 1)
  ethereum: {
    // Uniswap V2
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': {
      type: 'uniswapV2' as const,
      name: 'Uniswap V2 Router',
    },
    // Uniswap V3
    '0xe592427a0aece92de3edee1f18e0157c05861564': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter',
    },
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter02',
    },
    // Uniswap Universal Router
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': {
      type: 'uniswapV3' as const,
      name: 'Uniswap Universal Router',
    },
    // SushiSwap
    '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': {
      type: 'sushiswap' as const,
      name: 'SushiSwap Router',
    },
    // 1inch
    '0x1111111254eeb25477b68fb85ed929f73a960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
    // Curve Router
    '0xf0d4c12a5768d806021f80a262b4d39d26c58b8d': {
      type: 'curve' as const,
      name: 'Curve Router',
    },
  },
  // BSC (chainId: 56)
  bsc: {
    // PancakeSwap V2
    '0x10ed43c718714eb63d5aa57b78b54704e256024e': {
      type: 'uniswapV2' as const, // Uses same interface
      name: 'PancakeSwap V2 Router',
    },
    // PancakeSwap V3
    '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': {
      type: 'uniswapV3' as const, // Uses same interface
      name: 'PancakeSwap V3 SmartRouter',
    },
    // SushiSwap
    '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': {
      type: 'sushiswap' as const,
      name: 'SushiSwap Router',
    },
    // 1inch
    '0x1111111254eeb25477b68fb85ed929f73a960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
  },
  // FIX 3.3: Polygon (chainId: 137)
  polygon: {
    // Uniswap V3
    '0xe592427a0aece92de3edee1f18e0157c05861564': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter',
    },
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter02',
    },
    // QuickSwap (V2 compatible)
    '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff': {
      type: 'uniswapV2' as const,
      name: 'QuickSwap Router',
    },
    // SushiSwap
    '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': {
      type: 'sushiswap' as const,
      name: 'SushiSwap Router',
    },
    // 1inch
    '0x1111111254eeb25477b68fb85ed929f73a960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
  },
  // FIX 3.3: Arbitrum (chainId: 42161)
  arbitrum: {
    // Uniswap V3
    '0xe592427a0aece92de3edee1f18e0157c05861564': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter',
    },
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter02',
    },
    // Uniswap Universal Router
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': {
      type: 'uniswapV3' as const,
      name: 'Uniswap Universal Router',
    },
    // SushiSwap
    '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': {
      type: 'sushiswap' as const,
      name: 'SushiSwap Router',
    },
    // Camelot (V2 compatible)
    '0xc873fecbd354f5a56e00e710b90ef4201db2448d': {
      type: 'uniswapV2' as const,
      name: 'Camelot Router',
    },
    // 1inch
    '0x1111111254eeb25477b68fb85ed929f73a960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
    // GMX
    '0xabc0000000000000000000000000000000000000': {
      type: 'uniswapV2' as const, // Placeholder
      name: 'GMX Router',
    },
  },
  // FIX 3.3: Optimism (chainId: 10)
  optimism: {
    // Uniswap V3
    '0xe592427a0aece92de3edee1f18e0157c05861564': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter',
    },
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter02',
    },
    // Uniswap Universal Router
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': {
      type: 'uniswapV3' as const,
      name: 'Uniswap Universal Router',
    },
    // Velodrome (V2 compatible)
    '0xa062ae8a9c5e11aaa026fc2670b0d65ccc8b2858': {
      type: 'uniswapV2' as const,
      name: 'Velodrome Router',
    },
    // 1inch
    '0x1111111254eeb25477b68fb85ed929f73a960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
  },
  // FIX 3.3: Base (chainId: 8453)
  base: {
    // Uniswap V3
    '0x2626664c2603336e57b271c5c0b26f421741e481': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter02',
    },
    // Uniswap Universal Router
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': {
      type: 'uniswapV3' as const,
      name: 'Uniswap Universal Router',
    },
    // BaseSwap (V2 compatible)
    '0x327df1e6de05895d2ab08513aadd9313fe505d86': {
      type: 'uniswapV2' as const,
      name: 'BaseSwap Router',
    },
    // Aerodrome (Velodrome fork)
    '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': {
      type: 'uniswapV2' as const,
      name: 'Aerodrome Router',
    },
    // SushiSwap
    '0x6bded42c6da8fbf0d2ba55b2fa120c5e0c8d7891': {
      type: 'sushiswap' as const,
      name: 'SushiSwap Router',
    },
  },
  // FIX 3.3: Avalanche (chainId: 43114)
  avalanche: {
    // Trader Joe (V2 compatible)
    '0x60ae616a2155ee3d9a68541ba4544862310933d4': {
      type: 'uniswapV2' as const,
      name: 'Trader Joe Router',
    },
    // Pangolin (V2 compatible)
    '0xe54ca86531e17ef3616d22ca28b0d458b6c89106': {
      type: 'uniswapV2' as const,
      name: 'Pangolin Router',
    },
    // SushiSwap
    '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': {
      type: 'sushiswap' as const,
      name: 'SushiSwap Router',
    },
    // 1inch
    '0x1111111254eeb25477b68fb85ed929f73a960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
  },
} as const;

// =============================================================================
// CHAIN ID UTILITIES (FIX 6.3, 9.2: Centralized chain ID handling)
// =============================================================================

/**
 * Chain name to numeric ID mapping.
 * Centralized source of truth for chain identification.
 */
export const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avalanche: 43114,
  fantom: 250,
  zksync: 324,
  linea: 59144,
  solana: 101,
  // Add aliases
  mainnet: 1,
  eth: 1,
  binance: 56,
  matic: 137,
  arb: 42161,
  op: 10,
  avax: 43114,
};

/**
 * Numeric chain ID to name mapping.
 */
export const CHAIN_ID_TO_NAME: Record<number, string> = {
  1: 'ethereum',
  56: 'bsc',
  137: 'polygon',
  42161: 'arbitrum',
  10: 'optimism',
  8453: 'base',
  43114: 'avalanche',
  250: 'fantom',
  324: 'zksync',
  59144: 'linea',
  101: 'solana',
};

/**
 * Resolve chain identifier to numeric chain ID.
 *
 * @param chainId - Chain name (string) or numeric ID
 * @param defaultChainId - Default chain ID if resolution fails (default: 1)
 * @returns Numeric chain ID
 */
export function resolveChainId(chainId: string | number, defaultChainId: number = 1): number {
  if (typeof chainId === 'number') {
    return chainId;
  }
  return CHAIN_NAME_TO_ID[chainId.toLowerCase()] ?? defaultChainId;
}

/**
 * Get chain name from numeric ID.
 *
 * @param chainId - Numeric chain ID
 * @returns Chain name or 'unknown'
 */
export function getChainName(chainId: number): string {
  return CHAIN_ID_TO_NAME[chainId] ?? 'unknown';
}

/**
 * Get known routers for a specific chain.
 *
 * @param chainId - Chain identifier (e.g., 'ethereum', 'bsc')
 * @returns Router registry for the chain, or empty object if not found
 */
export function getKnownRouters(chainId: string): Record<string, { type: string; name: string }> {
  const normalizedChain = chainId.toLowerCase();
  return (KNOWN_ROUTERS as Record<string, Record<string, { type: string; name: string }>>)[normalizedChain] || {};
}

/**
 * Check if a router address is known for a specific chain.
 *
 * @param chainId - Chain identifier
 * @param routerAddress - Router contract address
 * @returns Router info if known, undefined otherwise
 */
export function getRouterInfo(
  chainId: string,
  routerAddress: string
): { type: string; name: string } | undefined {
  const routers = getKnownRouters(chainId);
  return routers[routerAddress.toLowerCase()] || routers[routerAddress];
}

/**
 * Check if mempool detection is enabled for a specific chain.
 *
 * @param chainId - Chain identifier
 * @returns True if mempool detection is enabled for the chain
 */
export function isMempoolEnabledForChain(chainId: string): boolean {
  const normalizedChain = chainId.toLowerCase();
  const chainConfig = MEMPOOL_CONFIG.chainSettings[normalizedChain];
  return MEMPOOL_CONFIG.enabled && chainConfig?.enabled === true;
}

/**
 * Get the feed configuration for a specific chain.
 *
 * @param chainId - Chain identifier
 * @returns Chain-specific mempool configuration or undefined
 */
export function getChainMempoolConfig(chainId: string): {
  enabled: boolean;
  feedType: string;
  endpoint: string;
  pollIntervalMs: number;
  expectedLatencyMs: number;
} | undefined {
  const normalizedChain = chainId.toLowerCase();
  return MEMPOOL_CONFIG.chainSettings[normalizedChain];
}

/**
 * Get all chains with mempool detection enabled.
 *
 * @returns Array of chain IDs with mempool detection enabled
 */
export function getEnabledMempoolChains(): string[] {
  if (!MEMPOOL_CONFIG.enabled) {
    return [];
  }

  return Object.entries(MEMPOOL_CONFIG.chainSettings)
    .filter(([, config]) => config.enabled)
    .map(([chainId]) => chainId);
}

// =============================================================================
// CURVE POOL TOKEN CONFIGURATION
// =============================================================================

/**
 * Known Curve pool configurations.
 * Maps pool addresses to their token addresses by index.
 *
 * Format: chainId -> poolAddress (lowercase) -> [token0, token1, ...]
 */
export const CURVE_POOL_TOKENS: Record<number, Record<string, string[]>> = {
  // Ethereum Mainnet (chainId: 1)
  1: {
    // 3pool (DAI, USDC, USDT)
    '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7': [
      '0x6B175474E89094C44Da98b954EeadCDeBc5C5e818', // DAI
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    ],
    // sUSD pool (DAI, USDC, USDT, sUSD)
    '0xa5407eae9ba41422680e2e00537571bcc53efbfd': [
      '0x6B175474E89094C44Da98b954EeadCDeBc5C5e818', // DAI
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      '0x57Ab1ec28D129707052df4dF418D58a2D46d5f51', // sUSD
    ],
    // stETH pool (ETH, stETH)
    '0xdc24316b9ae028f1497c275eb9192a3ea0f67022': [
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // ETH
      '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', // stETH
    ],
    // Tricrypto2 (USDT, WBTC, WETH)
    '0xd51a44d3fae010294c616388b506acda1bfaae46': [
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    ],
    // FRAX/USDC
    '0xdcef968d416a41cdac0ed8702fac8128a64241a2': [
      '0x853d955aCEf822Db058eb8505911ED77F175b99e', // FRAX
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    ],
    // crvUSD/USDC
    '0x4dece678ceceb27446b35c672dc7d61f30bad69e': [
      '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', // crvUSD
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    ],
  },
  // Arbitrum (chainId: 42161)
  42161: {
    // 2pool (USDC, USDT)
    '0x7f90122bf0700f9e7e1f688fe926940e8839f353': [
      '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // USDC
      '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
    ],
  },
  // Polygon (chainId: 137)
  137: {
    // aave pool (DAI, USDC, USDT)
    '0x445fe580ef8d70ff569ab36e80c647af338db351': [
      '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', // DAI
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC
      '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
    ],
  },
};

/**
 * Get Curve pool token configuration for a specific pool.
 *
 * @param chainId - Chain ID
 * @param poolAddress - Pool contract address
 * @returns Array of token addresses or undefined if pool not configured
 */
export function getCurvePoolTokens(chainId: number, poolAddress: string): string[] | undefined {
  const chainPools = CURVE_POOL_TOKENS[chainId];
  if (!chainPools) return undefined;
  return chainPools[poolAddress.toLowerCase()];
}
