/**
 * RPC Provider Configuration - 6-Provider Shield Architecture
 *
 * Implements the optimized provider strategy from RPC_DEEP_DIVE_ANALYSIS.md:
 * - Combined Free Tier: ~540M CU/month + unlimited PublicNode
 * - Combined RPS: 210-375 requests/second
 * - Target: 24/7 uptime with $0/month cost
 *
 * Provider Priority Order (based on free tier capacity):
 * 1. dRPC       - 210M CU/30 days, 40-100 RPS (PRIMARY)
 * 2. Ankr       - 200M credits/month, 30 RPS (SECONDARY)
 * 3. PublicNode - Unlimited, ~100-200 RPS (OVERFLOW/BURST - NO KEY NEEDED)
 * 4. Infura     - 3M/day (~90M/month), 500 CU/s (DAILY RESET)
 * 5. Alchemy    - 30M CU/month, 25 RPS (QUALITY RESERVE)
 * 6. QuickNode  - 10M credits/month, 15 RPS (LAST RESORT)
 * 7. BlastAPI   - ~40M/month, 25 RPS (PUBLIC FALLBACK - NO KEY NEEDED)
 *
 * Thread Safety: This module is designed for single-threaded Node.js execution.
 * Budget tracking state is not thread-safe for worker thread access.
 *
 * @see docs/reports/RPC_DEEP_DIVE_ANALYSIS.md
 */

/**
 * Provider tier classification for priority routing
 */
export enum ProviderTier {
  /** Primary providers - handle 50% of traffic */
  PRIMARY = 1,
  /** Secondary providers - handle 30% of traffic */
  SECONDARY = 2,
  /** Tertiary providers - handle 15% of traffic */
  TERTIARY = 3,
  /** Last resort - handle 5% of traffic */
  LAST_RESORT = 4
}

/**
 * Provider configuration with capacity and routing info
 */
export interface ProviderConfig {
  name: string;
  tier: ProviderTier;
  /** Monthly capacity in compute units (approximate) */
  monthlyCapacityCU: number;
  /** Requests per second limit */
  rpsLimit: number;
  /** Whether an API key is required */
  requiresApiKey: boolean;
  /** Environment variable name for API key */
  apiKeyEnvVar?: string;
  /** WebSocket support */
  supportsWebSocket: boolean;
  /** Daily reset (like Infura) */
  dailyReset?: boolean;
}

/**
 * Provider configurations ordered by priority (highest first)
 */
export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  drpc: {
    name: 'dRPC',
    tier: ProviderTier.PRIMARY,
    monthlyCapacityCU: 210_000_000,
    rpsLimit: 100, // Dynamic 40-100 RPS
    requiresApiKey: true,
    apiKeyEnvVar: 'DRPC_API_KEY',
    supportsWebSocket: true
  },
  ankr: {
    name: 'Ankr',
    tier: ProviderTier.SECONDARY,
    monthlyCapacityCU: 200_000_000,
    rpsLimit: 30,
    requiresApiKey: true,
    apiKeyEnvVar: 'ANKR_API_KEY',
    supportsWebSocket: true
  },
  publicnode: {
    name: 'PublicNode',
    tier: ProviderTier.SECONDARY,
    monthlyCapacityCU: Infinity, // Unlimited (shared)
    rpsLimit: 200, // ~100-200 RPS per IP
    requiresApiKey: false,
    supportsWebSocket: true
  },
  infura: {
    name: 'Infura',
    tier: ProviderTier.TERTIARY,
    monthlyCapacityCU: 90_000_000, // 3M/day * 30
    rpsLimit: 50, // 500 credits/s, ~50 RPS for eth_call
    requiresApiKey: true,
    apiKeyEnvVar: 'INFURA_API_KEY',
    supportsWebSocket: true,
    dailyReset: true
  },
  alchemy: {
    name: 'Alchemy',
    tier: ProviderTier.TERTIARY,
    monthlyCapacityCU: 30_000_000,
    rpsLimit: 25,
    requiresApiKey: true,
    apiKeyEnvVar: 'ALCHEMY_API_KEY',
    supportsWebSocket: true
  },
  quicknode: {
    name: 'QuickNode',
    tier: ProviderTier.LAST_RESORT,
    monthlyCapacityCU: 10_000_000,
    rpsLimit: 15,
    requiresApiKey: true,
    apiKeyEnvVar: 'QUICKNODE_API_KEY',
    supportsWebSocket: true
  },
  blastapi: {
    name: 'BlastAPI',
    tier: ProviderTier.LAST_RESORT,
    monthlyCapacityCU: 40_000_000,
    rpsLimit: 25,
    requiresApiKey: false, // Public endpoints available
    supportsWebSocket: true
  }
};

/**
 * Chain-specific network names for provider URL construction
 */
export const CHAIN_NETWORK_NAMES: Record<string, {
  drpc: string;
  ankr: string;
  publicnode: string;
  infura?: string;
  alchemy?: string;
  blastapi: string;
}> = {
  ethereum: {
    drpc: 'ethereum',
    ankr: 'eth',
    publicnode: 'ethereum-rpc',
    infura: 'mainnet',
    alchemy: 'eth',
    blastapi: 'eth'
  },
  arbitrum: {
    drpc: 'arbitrum',
    ankr: 'arbitrum',
    publicnode: 'arbitrum-one-rpc',
    infura: 'arbitrum-mainnet',
    alchemy: 'arb',
    blastapi: 'arbitrum'
  },
  bsc: {
    drpc: 'bsc',
    ankr: 'bsc',
    publicnode: 'bsc-rpc',
    // Infura doesn't support BSC
    // Alchemy doesn't support BSC
    blastapi: 'bsc'
  },
  base: {
    drpc: 'base',
    ankr: 'base',
    publicnode: 'base-rpc',
    // Infura doesn't support Base
    alchemy: 'base',
    blastapi: 'base'
  },
  polygon: {
    drpc: 'polygon',
    ankr: 'polygon',
    publicnode: 'polygon-bor-rpc',
    infura: 'polygon-mainnet',
    alchemy: 'polygon',
    blastapi: 'polygon'
  },
  optimism: {
    drpc: 'optimism',
    ankr: 'optimism',
    publicnode: 'optimism-rpc',
    infura: 'optimism-mainnet',
    alchemy: 'opt',
    blastapi: 'optimism'
  },
  avalanche: {
    drpc: 'avalanche-c',
    ankr: 'avalanche',
    publicnode: 'avalanche-c-chain-rpc',
    infura: 'avalanche-mainnet',
    alchemy: 'avax',
    blastapi: 'avax'
  },
  fantom: {
    drpc: 'fantom',
    ankr: 'fantom',
    publicnode: 'fantom-rpc',
    // Infura limited support
    alchemy: 'fantom',
    blastapi: 'fantom'
  },
  zksync: {
    drpc: 'zksync',
    ankr: 'zksync_era',
    publicnode: 'zksync-era-rpc',
    infura: 'zksync-mainnet',
    alchemy: 'zksync',
    blastapi: 'zksync'
  },
  linea: {
    drpc: 'linea',
    ankr: 'linea',
    publicnode: 'linea-rpc',
    infura: 'linea-mainnet',
    // Alchemy limited support
    blastapi: 'linea'
  },
  solana: {
    drpc: 'solana',
    ankr: 'solana',
    publicnode: 'solana-rpc',
    // Infura doesn't support Solana
    // Alchemy has limited Solana support
    blastapi: 'solana'
  }
};

/**
 * Build dRPC URL with API key
 */
export function buildDrpcUrl(network: string, apiKey: string, isWebSocket = false): string {
  const protocol = isWebSocket ? 'wss' : 'https';
  const path = isWebSocket ? 'ogws' : 'ogrpc';
  return `${protocol}://lb.drpc.org/${path}?network=${network}&dkey=${apiKey}`;
}

/**
 * Build Ankr URL with API key
 */
export function buildAnkrUrl(network: string, apiKey: string, isWebSocket = false): string {
  const protocol = isWebSocket ? 'wss' : 'https';
  return `${protocol}://rpc.ankr.com/${network}/${apiKey}`;
}

/**
 * Build PublicNode URL (no key needed)
 */
export function buildPublicNodeUrl(network: string, isWebSocket = false): string {
  const protocol = isWebSocket ? 'wss' : 'https';
  return `${protocol}://${network}.publicnode.com`;
}

/**
 * Build Infura URL with API key
 */
export function buildInfuraUrl(network: string, apiKey: string, isWebSocket = false): string {
  const protocol = isWebSocket ? 'wss' : 'https';
  const wsPath = isWebSocket ? '/ws' : '';
  return `${protocol}://${network}.infura.io${wsPath}/v3/${apiKey}`;
}

/**
 * Build Alchemy URL with API key
 */
export function buildAlchemyUrl(network: string, apiKey: string, isWebSocket = false): string {
  const protocol = isWebSocket ? 'wss' : 'https';
  return `${protocol}://${network}-mainnet.g.alchemy.com/v2/${apiKey}`;
}

/**
 * Build BlastAPI URL (public, no key needed)
 */
export function buildBlastApiUrl(network: string, isWebSocket = false): string {
  const protocol = isWebSocket ? 'wss' : 'https';
  return `${protocol}://${network}-mainnet.public.blastapi.io`;
}

/**
 * Get all provider URLs for a chain in priority order
 * Returns URLs based on available API keys, with fallbacks
 */
export function getProviderUrlsForChain(
  chainId: string,
  isWebSocket = false
): { primary: string; fallbacks: string[] } {
  const networkNames = CHAIN_NETWORK_NAMES[chainId.toLowerCase()];
  if (!networkNames) {
    throw new Error(`Unknown chain: ${chainId}`);
  }

  const urls: string[] = [];

  // 1. dRPC (PRIMARY) - 210M CU/month
  const drpcKey = process.env.DRPC_API_KEY;
  if (drpcKey) {
    urls.push(buildDrpcUrl(networkNames.drpc, drpcKey, isWebSocket));
  }

  // 2. Ankr (SECONDARY) - 200M CU/month
  const ankrKey = process.env.ANKR_API_KEY;
  if (ankrKey) {
    urls.push(buildAnkrUrl(networkNames.ankr, ankrKey, isWebSocket));
  }

  // 3. PublicNode (OVERFLOW) - Unlimited, no key needed
  urls.push(buildPublicNodeUrl(networkNames.publicnode, isWebSocket));

  // 4. Infura (TERTIARY) - 3M/day
  const infuraKey = process.env.INFURA_API_KEY;
  if (infuraKey && networkNames.infura) {
    urls.push(buildInfuraUrl(networkNames.infura, infuraKey, isWebSocket));
  }

  // 5. Alchemy (TERTIARY) - 30M CU/month
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (alchemyKey && networkNames.alchemy) {
    urls.push(buildAlchemyUrl(networkNames.alchemy, alchemyKey, isWebSocket));
  }

  // 6. BlastAPI (LAST RESORT) - public fallback
  urls.push(buildBlastApiUrl(networkNames.blastapi, isWebSocket));

  // Return primary (first) and fallbacks (rest)
  return {
    primary: urls[0],
    fallbacks: urls.slice(1)
  };
}

/**
 * Get provider priority order based on current time of day (UTC).
 * Implements time-based load distribution from RPC_DEEP_DIVE_ANALYSIS.md.
 *
 * Strategy:
 * - Early UTC (00:00-08:00): Infura primary (fresh daily allocation)
 * - Mid-day UTC (08:00-20:00): dRPC primary (highest capacity)
 * - Late UTC (20:00-24:00): Ankr/PublicNode (absorb Infura overflow)
 *
 * @returns Provider names in priority order
 */
export function getTimeBasedProviderOrder(): string[] {
  const hour = new Date().getUTCHours();

  if (hour < 8) {
    // Early UTC: Use Infura first (fresh daily allocation)
    return ['infura', 'drpc', 'ankr', 'publicnode', 'alchemy', 'quicknode', 'blastapi'];
  } else if (hour < 20) {
    // Mid-day: Use dRPC primary (highest capacity)
    return ['drpc', 'ankr', 'publicnode', 'infura', 'alchemy', 'quicknode', 'blastapi'];
  } else {
    // Late UTC: Spread across Ankr/PublicNode to preserve Infura for next day
    return ['ankr', 'publicnode', 'drpc', 'alchemy', 'infura', 'quicknode', 'blastapi'];
  }
}

/**
 * Calculate recommended traffic allocation percentage per provider tier
 */
export function getTrafficAllocation(): Record<ProviderTier, number> {
  return {
    [ProviderTier.PRIMARY]: 50,
    [ProviderTier.SECONDARY]: 30,
    [ProviderTier.TERTIARY]: 15,
    [ProviderTier.LAST_RESORT]: 5
  };
}

/**
 * Estimate remaining monthly capacity based on usage
 * Used for proactive throttling before hitting limits
 */
export interface ProviderBudget {
  provider: string;
  monthlyLimit: number;
  used: number;
  remaining: number;
  percentUsed: number;
  estimatedDaysRemaining: number;
  shouldThrottle: boolean;
}

/**
 * Calculate provider budget status
 *
 * @param provider - Provider name
 * @param usedCU - Compute units used this month
 * @param dayOfMonth - Current day of month (1-31)
 */
export function calculateProviderBudget(
  provider: string,
  usedCU: number,
  dayOfMonth: number
): ProviderBudget {
  const config = PROVIDER_CONFIGS[provider.toLowerCase()];
  if (!config) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const monthlyLimit = config.monthlyCapacityCU;

  // Handle unlimited providers (e.g., PublicNode with Infinity capacity)
  // These providers should never be throttled based on CU usage
  if (!Number.isFinite(monthlyLimit)) {
    return {
      provider: config.name,
      monthlyLimit,
      used: usedCU,
      remaining: Infinity,
      percentUsed: 0,
      estimatedDaysRemaining: Infinity,
      shouldThrottle: false
    };
  }

  const remaining = monthlyLimit - usedCU;
  const percentUsed = (usedCU / monthlyLimit) * 100;

  // Estimate daily usage rate (guard against dayOfMonth being 0)
  const safeDayOfMonth = Math.max(1, dayOfMonth);
  const dailyUsage = usedCU / safeDayOfMonth;
  const daysInMonth = 30;
  const daysRemaining = daysInMonth - safeDayOfMonth;
  const estimatedDaysRemaining = dailyUsage > 0
    ? remaining / dailyUsage
    : daysRemaining;

  // Throttle if >80% used and not enough days remaining
  const shouldThrottle = percentUsed > 80 || estimatedDaysRemaining < daysRemaining;

  return {
    provider: config.name,
    monthlyLimit,
    used: usedCU,
    remaining,
    percentUsed,
    estimatedDaysRemaining,
    shouldThrottle
  };
}
