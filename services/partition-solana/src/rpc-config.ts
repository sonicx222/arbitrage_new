/**
 * Solana RPC Provider Configuration
 *
 * Manages RPC endpoint selection for Solana mainnet and devnet.
 * Implements the documented priority in README.md (S3.3.7):
 * 1. Explicit URL (SOLANA_RPC_URL or SOLANA_DEVNET_RPC_URL)
 * 2. Helius (if HELIUS_API_KEY set) - 100K free credits/day
 * 3. Triton (if TRITON_API_KEY set) - 50K free credits/day
 * 4. PublicNode - Unlimited, rate-limited
 * 5. Solana Public - Unlimited, rate-limited (not used, see note below)
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.7
 */

// =============================================================================
// RPC Provider Endpoints
// =============================================================================

/**
 * RPC endpoint providers for Solana mainnet and devnet.
 * Provider selection implements the documented priority in README.md.
 */
export const SOLANA_RPC_PROVIDERS = {
  mainnet: {
    helius: (apiKey: string) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    triton: (apiKey: string) => `https://solana-mainnet.rpc.extrnode.com/${apiKey}`,
    publicNode: 'https://solana-mainnet.rpc.publicnode.com',
    solanaPublic: 'https://api.mainnet-beta.solana.com',
  },
  devnet: {
    helius: (apiKey: string) => `https://devnet.helius-rpc.com/?api-key=${apiKey}`,
    triton: (apiKey: string) => `https://solana-devnet.rpc.extrnode.com/${apiKey}`,
    publicNode: 'https://solana-devnet.rpc.publicnode.com',
    solanaPublic: 'https://api.devnet.solana.com',
  },
} as const;

// =============================================================================
// RPC Selection Types
// =============================================================================

export interface RpcSelection {
  url: string;
  provider: string;
  isPublicEndpoint: boolean;
}

// =============================================================================
// RPC Selection Functions
// =============================================================================

/**
 * Determines if we're running in devnet mode based on PARTITION_CHAINS.
 * Issue 2.2: Devnet support via PARTITION_CHAINS=solana-devnet
 */
export function isDevnetMode(): boolean {
  const chains = process.env.PARTITION_CHAINS?.split(',').map(c => c.trim().toLowerCase()) ?? [];
  return chains.includes('solana-devnet');
}

/**
 * Selects the appropriate Solana RPC URL based on documented priority.
 * Issue 2.1: RPC Provider Priority as documented in README.md S3.3.7
 * Issue 3.3: Production warning for public RPC endpoint
 *
 * Priority:
 * 1. Explicit URL (SOLANA_RPC_URL or SOLANA_DEVNET_RPC_URL)
 * 2. Helius (if HELIUS_API_KEY set) - Recommended for production
 * 3. Triton (if TRITON_API_KEY set) - Good alternative
 * 4. PublicNode - Unlimited but rate-limited
 * 5. Solana Public - Last resort, heavily rate-limited
 *
 * @returns Object with selected RPC URL, provider name, and whether it's a public endpoint
 */
export function selectSolanaRpcUrl(): RpcSelection {
  const devnet = isDevnetMode();
  const network = devnet ? 'devnet' : 'mainnet';
  const providers = SOLANA_RPC_PROVIDERS[network];

  // Priority 1: Explicit URL override
  const explicitUrl = devnet
    ? process.env.SOLANA_DEVNET_RPC_URL
    : process.env.SOLANA_RPC_URL;
  if (explicitUrl) {
    return { url: explicitUrl, provider: 'explicit', isPublicEndpoint: false };
  }

  // Priority 2: Helius (recommended)
  const heliusKey = process.env.HELIUS_API_KEY;
  if (heliusKey) {
    return { url: providers.helius(heliusKey), provider: 'helius', isPublicEndpoint: false };
  }

  // Priority 3: Triton
  const tritonKey = process.env.TRITON_API_KEY;
  if (tritonKey) {
    return { url: providers.triton(tritonKey), provider: 'triton', isPublicEndpoint: false };
  }

  // Priority 4: PublicNode (free, unlimited, rate-limited)
  // More reliable than Solana public, but still rate-limited
  // FIX: This was documented but not implemented - now added
  return { url: providers.publicNode, provider: 'publicnode', isPublicEndpoint: true };

  // NOTE: Priority 5 (Solana Public) is no longer used since PublicNode is generally more reliable.
  // If PublicNode is down, the service will fail to start with public endpoint in production,
  // which is the intended behavior (public endpoints shouldn't be used in production).
}

/**
 * Redact API keys from RPC URLs for safe logging/monitoring.
 * Handles Helius query-param style and Triton path-based API keys.
 */
export function redactRpcUrl(url: string): string {
  // Redact api-key query parameter (Helius: ?api-key=...)
  let redacted = url.replace(/api-key=[^&]+/, 'api-key=***REDACTED***');
  // Redact path-based API key (Triton: long hex segment in URL path)
  redacted = redacted.replace(/\/[a-f0-9]{20,}(\/|$)/, '/***REDACTED***$1');
  return redacted;
}
