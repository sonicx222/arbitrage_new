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

  /**
   * Enable MEV-Share for Ethereum (Task 1.1: MEV-Share Integration)
   *
   * When true: Uses MEV-Share endpoint to capture 50-90% of MEV value as rebates
   * When false: Uses standard Flashbots relay (no rebates)
   *
   * MEV-Share allows searchers to backrun transactions while sharing profits.
   * This provides value capture without sacrificing MEV protection.
   *
   * Default: false (opt-in experimental feature)
   * @see ADR-028: MEV-Share Integration
   * @see docs/architecture/adr/ADR-028-mev-share-integration.md
   */
  useMevShare: process.env.FEATURE_MEV_SHARE === 'true', // Opt-in feature flag

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
  fallbackToPublic: process.env.MEV_FALLBACK_TO_PUBLIC === 'true', // Default false -- public mempool exposes to sandwich attacks

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
    // Emerging L2s: All use sequencer ordering (L2 sequencer-based MEV)
    blast: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
    },
    scroll: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
    },
    mantle: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
    },
    mode: {
      enabled: true,
      strategy: 'sequencer' as const,
      priorityFeeGwei: 0.01,
      minProfitForProtection: 0.001,
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

  /**
   * Adaptive Risk Scoring Configuration (Task 3.2)
   *
   * Tracks sandwich attacks and dynamically adjusts MEV risk thresholds
   * based on historical attack patterns per chain + DEX.
   *
   * When enabled, the system:
   * - Records confirmed sandwich attacks to Redis
   * - Reduces thresholds by 30% after 5+ attacks in 24h
   * - Gradually decays back to defaults (10% per day)
   *
   * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Task 3.2
   */
  adaptiveRiskScoring: {
    /** Enable adaptive threshold adjustments (feature flag) */
    enabled: process.env.FEATURE_ADAPTIVE_RISK_SCORING === 'true',

    /** Attack count threshold to trigger adaptation (default: 5) */
    attackThreshold: parseInt(process.env.ADAPTIVE_ATTACK_THRESHOLD || '5'),

    /** Active window for counting attacks in hours (default: 24h) */
    activeWindowHours: parseInt(process.env.ADAPTIVE_ACTIVE_WINDOW_HOURS || '24'),

    /** Threshold reduction percentage when attacks detected (default: 30%) */
    reductionPercent: parseFloat(process.env.ADAPTIVE_REDUCTION_PERCENT || '0.30'),

    /** Decay rate per day when no attacks (default: 10% per day) */
    decayRatePerDay: parseFloat(process.env.ADAPTIVE_DECAY_RATE_PER_DAY || '0.10'),

    /** Maximum events to store (FIFO pruning, default: 10000) */
    maxEvents: parseInt(process.env.ADAPTIVE_MAX_EVENTS || '10000'),

    /** Event retention period in days (default: 7 days) */
    retentionDays: parseInt(process.env.ADAPTIVE_RETENTION_DAYS || '7'),
  },
};

// =============================================================================
// MEV Config Validation (SPRINT 3)
// =============================================================================

/**
 * Get chain settings in a format suitable for validateConfigSync from @arbitrage/core.
 * Use this to validate that MEV_CONFIG.chainSettings is synchronized with
 * MEV_RISK_DEFAULTS.chainBasePriorityFees in mev-risk-analyzer.ts.
 *
 * @example
 * ```typescript
 * import { validateConfigSync } from '@arbitrage/core/mev-protection';
 * import { getMevChainConfigForValidation } from '@arbitrage/config';
 *
 * const result = validateConfigSync(getMevChainConfigForValidation());
 * if (!result.valid) {
 *   console.warn('MEV config mismatch:', result.mismatches);
 * }
 * ```
 */
export function getMevChainConfigForValidation(): Array<{ chain: string; priorityFeeGwei: number }> {
  return Object.entries(MEV_CONFIG.chainSettings).map(([chain, settings]) => ({
    chain,
    priorityFeeGwei: settings.priorityFeeGwei,
  }));
}

/**
 * Expected priority fee values for each chain.
 * Use this for documentation and quick reference.
 *
 * IMPORTANT: These values MUST stay synchronized with:
 * - MEV_RISK_DEFAULTS.chainBasePriorityFees in shared/core/src/mev-protection/mev-risk-analyzer.ts
 *
 * To validate synchronization, call:
 * ```typescript
 * import { validateConfigSync } from '@arbitrage/core/mev-protection';
 * import { getMevChainConfigForValidation } from '@arbitrage/config';
 * const result = validateConfigSync(getMevChainConfigForValidation());
 * ```
 */
export const MEV_PRIORITY_FEE_SUMMARY = {
  ethereum: 2.0,
  bsc: 3.0,
  polygon: 30.0,
  arbitrum: 0.01,
  optimism: 0.01,
  base: 0.01,
  zksync: 0.01,
  linea: 0.01,
  blast: 0.01,
  scroll: 0.01,
  mantle: 0.01,
  mode: 0.01,
  avalanche: 25.0,
  fantom: 100.0,
  solana: 0,
} as const;
