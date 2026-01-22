/**
 * MEV Protection Configuration
 *
 * Flashbots, BloXroute, Fastlane, and L2 Sequencer settings.
 * Used by execution-engine for protected transaction submission.
 *
 * @see Phase 2: MEV Protection
 */

// =============================================================================
// MEV PROTECTION CONFIGURATION (Phase 2)
// Flashbots, BloXroute, Fastlane, and L2 Sequencer settings
// =============================================================================
export const MEV_CONFIG = {
  /** Enable MEV protection globally */
  enabled: process.env.MEV_PROTECTION_ENABLED === 'true',

  /** Flashbots auth signing key for Ethereum mainnet */
  flashbotsAuthKey: process.env.FLASHBOTS_AUTH_KEY,

  /** BloXroute auth header for BSC */
  bloxrouteAuthHeader: process.env.BLOXROUTE_AUTH_HEADER,

  /** Custom Flashbots relay URL (default: relay.flashbots.net) */
  flashbotsRelayUrl: process.env.FLASHBOTS_RELAY_URL || 'https://relay.flashbots.net',

  /** BloXroute MEV API URL */
  bloxrouteUrl: process.env.BLOXROUTE_URL || 'https://mev.api.blxrbdn.com',

  /** Polygon Fastlane RPC URL */
  fastlaneUrl: process.env.FASTLANE_URL || 'https://fastlane-rpc.polygon.technology',

  /** Submission timeout in milliseconds */
  submissionTimeoutMs: parseInt(process.env.MEV_SUBMISSION_TIMEOUT_MS || '30000'),

  /** Maximum retries for bundle submission */
  maxRetries: parseInt(process.env.MEV_MAX_RETRIES || '3'),

  /** Fallback to public mempool if protected submission fails */
  fallbackToPublic: process.env.MEV_FALLBACK_TO_PUBLIC !== 'false', // Default true

  /** Simulate bundles before submission (recommended) */
  simulateBeforeSubmit: process.env.MEV_SIMULATE_BEFORE_SUBMIT !== 'false', // Default true

  /** Chain-specific MEV settings */
  chainSettings: {
    ethereum: {
      enabled: true,
      strategy: 'flashbots' as const,
      priorityFeeGwei: 2.0,
      minProfitForProtection: 0.01, // 0.01 ETH minimum to use Flashbots
    },
    bsc: {
      enabled: true,
      strategy: 'bloxroute' as const,
      priorityFeeGwei: 3.0,
      minProfitForProtection: 0.05, // 0.05 BNB minimum
    },
    polygon: {
      enabled: true,
      strategy: 'fastlane' as const,
      priorityFeeGwei: 30.0,
      minProfitForProtection: 10, // 10 MATIC minimum
    },
    arbitrum: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001, // Very low threshold
    },
    optimism: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
    },
    base: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
    },
    zksync: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
    },
    linea: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
    },
    avalanche: {
      enabled: true,
      strategy: 'standard' as const,
      priorityFeeGwei: 25.0,
      minProfitForProtection: 1, // 1 AVAX minimum
    },
    fantom: {
      enabled: true,
      strategy: 'standard' as const,
      priorityFeeGwei: 100.0,
      minProfitForProtection: 50, // 50 FTM minimum
    },
    // S3.3.7-FIX: Added Solana MEV protection via Jito bundles
    solana: {
      enabled: true,
      strategy: 'jito' as const,  // Jito bundles for Solana MEV protection
      priorityFeeGwei: 0,         // Solana uses lamports, not gwei (handled by Solana executor)
      minProfitForProtection: 0.1, // 0.1 SOL minimum for Jito bundle submission
    },
  } as Record<string, {
    enabled: boolean;
    strategy: 'flashbots' | 'bloxroute' | 'fastlane' | 'sequencer' | 'standard' | 'jito';
    priorityFeeGwei: number;
    minProfitForProtection: number;
  }>,
};
