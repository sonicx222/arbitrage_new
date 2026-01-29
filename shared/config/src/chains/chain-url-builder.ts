/**
 * Chain URL Builder
 *
 * Provides a centralized utility for building chain RPC and WebSocket URLs
 * with consistent environment variable resolution and fallback patterns.
 *
 * This reduces code duplication across chain configurations and provides
 * a single point of maintenance for URL construction logic.
 *
 * @see P2-CONFIG from refactoring-roadmap.md
 */

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
// =============================================================================

/**
 * Standard EVM chain fallback URL providers
 */
export const STANDARD_FALLBACK_PROVIDERS = {
  publicNode: (chain: string) => ({
    rpc: `https://${chain}.publicnode.com`,
    ws: `wss://${chain}.publicnode.com`,
  }),
  blastApi: (chain: string) => ({
    rpc: `https://${chain}-mainnet.public.blastapi.io`,
    ws: `wss://${chain}-mainnet.public.blastapi.io`,
  }),
  drpc: (chain: string) => ({
    rpc: `https://${chain}.drpc.org`,
    ws: `wss://${chain}.drpc.org`,
  }),
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
