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
 */
export const KNOWN_ROUTERS = {
  // Ethereum Mainnet (chainId: 1)
  ethereum: {
    // Uniswap V2
    '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D': {
      type: 'uniswapV2' as const,
      name: 'Uniswap V2 Router',
    },
    // Uniswap V3
    '0xE592427A0AEce92De3Edee1F18E0157C05861564': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter',
    },
    '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45': {
      type: 'uniswapV3' as const,
      name: 'Uniswap V3 SwapRouter02',
    },
    // SushiSwap
    '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F': {
      type: 'sushiswap' as const,
      name: 'SushiSwap Router',
    },
    // 1inch
    '0x1111111254EEB25477B68fb85Ed929f73A960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
  },
  // BSC (chainId: 56)
  bsc: {
    // PancakeSwap V2
    '0x10ED43C718714eb63d5aA57B78B54704E256024E': {
      type: 'uniswapV2' as const, // Uses same interface
      name: 'PancakeSwap V2 Router',
    },
    // PancakeSwap V3
    '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4': {
      type: 'uniswapV3' as const, // Uses same interface
      name: 'PancakeSwap V3 SmartRouter',
    },
    // 1inch
    '0x1111111254EEB25477B68fb85Ed929f73A960582': {
      type: '1inch' as const,
      name: '1inch AggregatorV5',
    },
  },
} as const;

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
