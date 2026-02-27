/**
 * Chain URL Builder
 *
 * Provides a centralized utility for building chain RPC and WebSocket URLs
 * with consistent environment variable resolution and fallback patterns.
 *
 * Updated to implement the 8-Provider Shield Architecture:
 * Priority: dRPC → OnFinality → Ankr → PublicNode → Infura → Alchemy → QuickNode → BlastAPI
 *
 * @see P2-CONFIG from refactoring-roadmap.md
 * @see docs/reports/RPC_DEEP_DIVE_ANALYSIS.md
 */

// Re-export provider configuration
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
  getTrafficAllocation,
  calculateProviderBudget,
  type ProviderConfig,
  type ProviderBudget
} from './provider-config';

/**
 * Configuration for building chain URLs
 */
export interface ChainUrlConfig {
  /** Chain name in uppercase (e.g., 'ETHEREUM', 'ARBITRUM') */
  chainEnvPrefix: string;
  /** Default RPC URL if env var not set */
  defaultRpcUrl: string;
  /** Default WebSocket URL if env var not set */
  defaultWsUrl: string;
  /** Fallback WebSocket URLs for resilience (S3.3) */
  wsFallbackUrls?: string[];
  /** Fallback RPC URLs for resilience */
  rpcFallbackUrls?: string[];
}

/**
 * Configuration for API key-based URL construction
 */
export interface ApiKeyUrlConfig {
  /** Environment variable name for the API key */
  apiKeyEnvVar: string;
  /** Template function to build RPC URL with API key */
  rpcUrlTemplate: (apiKey: string) => string;
  /** Template function to build WebSocket URL with API key */
  wsUrlTemplate: (apiKey: string) => string;
}

/**
 * Result of URL building
 */
export interface ChainUrls {
  rpcUrl: string;
  wsUrl: string;
  wsFallbackUrls: string[];
  rpcFallbackUrls: string[];
}

/**
 * Builds chain URLs with environment variable resolution.
 *
 * Resolution order:
 * 1. Explicit environment variable (e.g., ETHEREUM_RPC_URL)
 * 2. Default URL from config
 *
 * @param config - URL configuration for the chain
 * @returns Resolved URLs with fallbacks
 */
export function buildChainUrls(config: ChainUrlConfig): ChainUrls {
  const envPrefix = config.chainEnvPrefix.toUpperCase();

  return {
    rpcUrl: process.env[`${envPrefix}_RPC_URL`] || config.defaultRpcUrl,
    wsUrl: process.env[`${envPrefix}_WS_URL`] || config.defaultWsUrl,
    wsFallbackUrls: config.wsFallbackUrls || [],
    rpcFallbackUrls: config.rpcFallbackUrls || [],
  };
}

/**
 * Builds chain URLs with API key-based providers (e.g., Alchemy, Helius).
 *
 * Resolution order:
 * 1. Explicit environment variable (e.g., OPTIMISM_RPC_URL)
 * 2. API key-based URL if API key is set
 * 3. Default public URL
 *
 * @param config - Base URL configuration
 * @param apiKeyConfigs - Array of API key configurations, checked in order
 * @returns Resolved URLs with API key expansion
 */
export function buildChainUrlsWithApiKeys(
  config: ChainUrlConfig,
  apiKeyConfigs: ApiKeyUrlConfig[]
): ChainUrls {
  const envPrefix = config.chainEnvPrefix.toUpperCase();

  // Check explicit env vars first
  const explicitRpcUrl = process.env[`${envPrefix}_RPC_URL`];
  const explicitWsUrl = process.env[`${envPrefix}_WS_URL`];

  if (explicitRpcUrl && explicitWsUrl) {
    return {
      rpcUrl: explicitRpcUrl,
      wsUrl: explicitWsUrl,
      wsFallbackUrls: config.wsFallbackUrls || [],
      rpcFallbackUrls: config.rpcFallbackUrls || [],
    };
  }

  // Try API key providers in order
  for (const apiConfig of apiKeyConfigs) {
    const apiKey = process.env[apiConfig.apiKeyEnvVar];
    if (apiKey) {
      return {
        rpcUrl: explicitRpcUrl || apiConfig.rpcUrlTemplate(apiKey),
        wsUrl: explicitWsUrl || apiConfig.wsUrlTemplate(apiKey),
        wsFallbackUrls: config.wsFallbackUrls || [],
        rpcFallbackUrls: config.rpcFallbackUrls || [],
      };
    }
  }

  // Fall back to defaults
  return {
    rpcUrl: explicitRpcUrl || config.defaultRpcUrl,
    wsUrl: explicitWsUrl || config.defaultWsUrl,
    wsFallbackUrls: config.wsFallbackUrls || [],
    rpcFallbackUrls: config.rpcFallbackUrls || [],
  };
}

/**
 * Builds Solana URLs with Helius/Triton priority.
 *
 * Resolution order:
 * 1. Explicit SOLANA_RPC_URL / SOLANA_WS_URL
 * 2. Helius API key (if HELIUS_API_KEY set)
 * 3. Triton API key (if TRITON_API_KEY set)
 * 4. Public RPC fallback
 *
 * Fallback URLs are dynamically built to include Triton if available
 * but not used as primary.
 *
 * @param network - 'mainnet' | 'devnet'
 * @returns Resolved Solana URLs
 */
export function buildSolanaUrls(network: 'mainnet' | 'devnet' = 'mainnet'): ChainUrls {
  const isDevnet = network === 'devnet';
  const envPrefix = isDevnet ? 'SOLANA_DEVNET' : 'SOLANA';
  const networkPath = isDevnet ? 'devnet' : 'mainnet';

  const heliusKey = process.env.HELIUS_API_KEY;
  const tritonKey = process.env.TRITON_API_KEY;

  // Default public URLs
  const defaultRpcUrl = isDevnet
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com';
  const defaultWsUrl = isDevnet
    ? 'wss://api.devnet.solana.com'
    : 'wss://api.mainnet-beta.solana.com';

  // Check explicit env vars first
  const explicitRpcUrl = process.env[`${envPrefix}_RPC_URL`];
  const explicitWsUrl = process.env[`${envPrefix}_WS_URL`];

  // Determine primary URLs
  let rpcUrl: string;
  let wsUrl: string;

  if (explicitRpcUrl) {
    rpcUrl = explicitRpcUrl;
  } else if (heliusKey) {
    rpcUrl = `https://${networkPath}.helius-rpc.com/?api-key=${heliusKey}`;
  } else if (tritonKey) {
    rpcUrl = `https://solana-${networkPath}.triton.one/v1/${tritonKey}`;
  } else {
    rpcUrl = defaultRpcUrl;
  }

  if (explicitWsUrl) {
    wsUrl = explicitWsUrl;
  } else if (heliusKey) {
    wsUrl = `wss://${networkPath}.helius-rpc.com/?api-key=${heliusKey}`;
  } else if (tritonKey) {
    wsUrl = `wss://solana-${networkPath}.triton.one/v1/${tritonKey}`;
  } else {
    wsUrl = defaultWsUrl;
  }

  // Build fallback URLs - include Triton if available but not primary
  const wsFallbackUrls: string[] = [];
  const rpcFallbackUrls: string[] = [];

  // Add Triton as fallback if we have key but Helius is primary
  if (tritonKey && heliusKey) {
    wsFallbackUrls.push(`wss://solana-${networkPath}.triton.one/v1/${tritonKey}`);
    rpcFallbackUrls.push(`https://solana-${networkPath}.triton.one/v1/${tritonKey}`);
  }

  // Add standard public fallbacks
  if (isDevnet) {
    wsFallbackUrls.push('wss://solana-devnet.publicnode.com', defaultWsUrl);
    rpcFallbackUrls.push('https://solana-devnet.publicnode.com', defaultRpcUrl);
  } else {
    wsFallbackUrls.push('wss://solana.publicnode.com', defaultWsUrl);
    rpcFallbackUrls.push(
      'https://solana-mainnet.rpc.extrnode.com',
      'https://solana.publicnode.com',
      defaultRpcUrl,
      'https://solana-mainnet.g.alchemy.com/v2/demo'
    );
  }

  return { rpcUrl, wsUrl, wsFallbackUrls, rpcFallbackUrls };
}

// =============================================================================
// PRE-CONFIGURED URL BUILDERS FOR COMMON PATTERNS
// Updated for 6-Provider Shield Architecture
// =============================================================================

/**
 * Standard EVM chain fallback URL providers
 * Priority order: dRPC → OnFinality → Ankr → PublicNode → Infura → Alchemy → BlastAPI
 */
export const STANDARD_FALLBACK_PROVIDERS = {
  /**
   * dRPC - PRIMARY (210M CU/month, 40-100 RPS)
   * Highest capacity provider, use as primary for all chains
   */
  drpc: (chain: string, apiKey?: string) => {
    const key = apiKey || process.env.DRPC_API_KEY;
    if (key) {
      return {
        rpc: `https://lb.drpc.org/ogrpc?network=${chain}&dkey=${key}`,
        ws: `wss://lb.drpc.org/ogws?network=${chain}&dkey=${key}`,
      };
    }
    // Fallback to public (limited)
    return {
      rpc: `https://${chain}.drpc.org`,
      ws: `wss://${chain}.drpc.org`,
    };
  },

  /**
   * OnFinality - SECONDARY (500K daily reqs, enterprise-grade)
   * Excellent for BSC, Polygon, Avalanche, Fantom
   */
  onFinality: (chain: string, apiKey?: string) => {
    const key = apiKey || process.env.ONFINALITY_API_KEY;
    if (key) {
      return {
        rpc: `https://${chain}.api.onfinality.io/rpc?apikey=${key}`,
        ws: `wss://${chain}.api.onfinality.io/ws?apikey=${key}`,
      };
    }
    // Fallback to public (limited)
    return {
      rpc: `https://${chain}.api.onfinality.io/public`,
      ws: `wss://${chain}.api.onfinality.io/public-ws`,
    };
  },

  /**
   * Ankr - SECONDARY (200M credits/month, 30 RPS)
   * Third highest capacity, excellent chain coverage
   */
  ankr: (chain: string, apiKey?: string) => {
    const key = apiKey || process.env.ANKR_API_KEY;
    if (key) {
      return {
        rpc: `https://rpc.ankr.com/${chain}/${key}`,
        ws: `wss://rpc.ankr.com/${chain}/${key}`,
      };
    }
    // Fallback to public (rate limited)
    return {
      rpc: `https://rpc.ankr.com/${chain}`,
      ws: `wss://rpc.ankr.com/${chain}`,
    };
  },

  /**
   * PublicNode - OVERFLOW/BURST (Unlimited, ~100-200 RPS)
   * No API key required - instant fallback
   */
  publicNode: (chain: string) => ({
    rpc: `https://${chain}.publicnode.com`,
    ws: `wss://${chain}.publicnode.com`,
  }),

  /**
   * BlastAPI - PUBLIC FALLBACK
   * Free public endpoints, no key required
   */
  blastApi: (chain: string) => ({
    rpc: `https://${chain}-mainnet.public.blastapi.io`,
    ws: `wss://${chain}-mainnet.public.blastapi.io`,
  }),

  /**
   * 1RPC - PRIVACY-FOCUSED FALLBACK
   * Free, privacy-preserving, HTTP only
   */
  oneRpc: (chain: string) => ({
    rpc: `https://1rpc.io/${chain}`,
    // 1rpc doesn't provide WebSocket
  }),
} as const;

/**
 * Alchemy API key configuration generator
 */
export function createAlchemyConfig(network: string): ApiKeyUrlConfig {
  return {
    apiKeyEnvVar: `ALCHEMY_${network.toUpperCase()}_KEY`,
    rpcUrlTemplate: (key) => `https://${network}-mainnet.g.alchemy.com/v2/${key}`,
    wsUrlTemplate: (key) => `wss://${network}-mainnet.g.alchemy.com/v2/${key}`,
  };
}

/**
 * Infura API key configuration generator
 */
export function createInfuraConfig(network: string): ApiKeyUrlConfig {
  return {
    apiKeyEnvVar: 'INFURA_API_KEY',
    rpcUrlTemplate: (key) => `https://${network}.infura.io/v3/${key}`,
    wsUrlTemplate: (key) => `wss://${network}.infura.io/ws/v3/${key}`,
  };
}

/**
 * dRPC API key configuration generator (PRIMARY - 210M CU/month)
 * Uses load-balanced endpoint for best performance
 */
export function createDrpcConfig(network: string): ApiKeyUrlConfig {
  return {
    apiKeyEnvVar: 'DRPC_API_KEY',
    rpcUrlTemplate: (key) => `https://lb.drpc.org/ogrpc?network=${network}&dkey=${key}`,
    wsUrlTemplate: (key) => `wss://lb.drpc.org/ogws?network=${network}&dkey=${key}`,
  };
}

/**
 * OnFinality API key configuration generator (SECONDARY - 500K daily reqs)
 * Supports BSC, Polygon, Avalanche, Fantom
 */
export function createOnFinalityConfig(network: string): ApiKeyUrlConfig {
  return {
    apiKeyEnvVar: 'ONFINALITY_API_KEY',
    rpcUrlTemplate: (key) => `https://${network}.api.onfinality.io/rpc?apikey=${key}`,
    wsUrlTemplate: (key) => `wss://${network}.api.onfinality.io/ws?apikey=${key}`,
  };
}

/**
 * Ankr API key configuration generator (SECONDARY - 200M credits/month)
 */
export function createAnkrConfig(network: string): ApiKeyUrlConfig {
  return {
    apiKeyEnvVar: 'ANKR_API_KEY',
    rpcUrlTemplate: (key) => `https://rpc.ankr.com/${network}/${key}`,
    wsUrlTemplate: (key) => `wss://rpc.ankr.com/${network}/${key}`,
  };
}

/**
 * Build chain URLs with the optimized 6-Provider Shield priority order.
 *
 * Resolution order:
 * 1. Explicit environment variable (e.g., ETHEREUM_RPC_URL)
 * 2. dRPC (highest capacity - 210M CU/month)
 * 3. Ankr (second highest - 200M credits/month)
 * 4. Infura (if supported for chain)
 * 5. Alchemy (if supported for chain)
 * 6. Default public URL
 *
 * @param config - Base URL configuration
 * @param chainName - Chain name for provider lookup
 * @returns Resolved URLs with optimized provider priority
 */
export function buildChainUrlsOptimized(
  config: ChainUrlConfig,
  chainName: string
): ChainUrls {
  const envPrefix = config.chainEnvPrefix.toUpperCase();

  // Check explicit env vars first
  const explicitRpcUrl = process.env[`${envPrefix}_RPC_URL`];
  const explicitWsUrl = process.env[`${envPrefix}_WS_URL`];

  if (explicitRpcUrl && explicitWsUrl) {
    return {
      rpcUrl: explicitRpcUrl,
      wsUrl: explicitWsUrl,
      wsFallbackUrls: config.wsFallbackUrls || [],
      rpcFallbackUrls: config.rpcFallbackUrls || [],
    };
  }

  // Priority order: dRPC → OnFinality → Ankr → Infura → Alchemy → default
  const apiKeyConfigs: ApiKeyUrlConfig[] = [
    createDrpcConfig(chainName),
  ];

  // OnFinality supports BSC, Polygon, Avalanche, Fantom
  const chainToOnFinality: Record<string, string> = {
    bsc: 'bsc',
    polygon: 'polygon',
    avalanche: 'avalanche',
    fantom: 'fantom',
  };
  const onFinalityNetwork = chainToOnFinality[chainName.toLowerCase()];
  if (onFinalityNetwork) {
    apiKeyConfigs.push(createOnFinalityConfig(onFinalityNetwork));
  }

  apiKeyConfigs.push(createAnkrConfig(chainName));

  // Map chain names to provider network names for Infura/Alchemy
  const chainToInfura: Record<string, string> = {
    ethereum: 'mainnet',
    arbitrum: 'arbitrum-mainnet',
    polygon: 'polygon-mainnet',
    optimism: 'optimism-mainnet',
    avalanche: 'avalanche-mainnet',
    linea: 'linea-mainnet',
    zksync: 'zksync-mainnet',
  };

  const chainToAlchemy: Record<string, string> = {
    ethereum: 'eth',
    arbitrum: 'arb',
    polygon: 'polygon',
    optimism: 'opt',
    base: 'base',
    avalanche: 'avax',
    fantom: 'fantom',
    zksync: 'zksync',
  };

  const infuraNetwork = chainToInfura[chainName.toLowerCase()];
  if (infuraNetwork) {
    apiKeyConfigs.push(createInfuraConfig(infuraNetwork));
  }

  const alchemyNetwork = chainToAlchemy[chainName.toLowerCase()];
  if (alchemyNetwork) {
    apiKeyConfigs.push(createAlchemyConfig(alchemyNetwork));
  }

  return buildChainUrlsWithApiKeys(config, apiKeyConfigs);
}
