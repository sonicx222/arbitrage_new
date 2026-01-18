/**
 * MEV Provider Factory
 *
 * Creates appropriate MEV protection providers based on chain configuration.
 * Manages provider lifecycle and provides a unified interface for the execution engine.
 */

import { ethers } from 'ethers';
import {
  IMevProvider,
  MevStrategy,
  MevProviderConfig,
  MevMetrics,
  CHAIN_MEV_STRATEGIES,
  MEV_DEFAULTS,
} from './types';
import { FlashbotsProvider, createFlashbotsProvider } from './flashbots-provider';
import { L2SequencerProvider, createL2SequencerProvider, isL2SequencerChain } from './l2-sequencer-provider';
import { StandardProvider, createStandardProvider } from './standard-provider';

// =============================================================================
// Factory Configuration
// =============================================================================

/**
 * Global MEV configuration
 */
export interface MevGlobalConfig {
  /** Enable MEV protection globally */
  enabled: boolean;
  /** Flashbots auth signing key */
  flashbotsAuthKey?: string;
  /** BloXroute auth header */
  bloxrouteAuthHeader?: string;
  /** Custom Flashbots relay URL */
  flashbotsRelayUrl?: string;
  /** Default submission timeout in ms */
  submissionTimeoutMs?: number;
  /** Maximum retries */
  maxRetries?: number;
  /** Fallback to public mempool on failure */
  fallbackToPublic?: boolean;
}

/**
 * Chain-specific wallet configuration
 */
export interface ChainWalletConfig {
  chain: string;
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
}

// =============================================================================
// MEV Provider Factory
// =============================================================================

/**
 * Factory for creating and managing MEV protection providers
 *
 * Usage:
 * ```typescript
 * const factory = new MevProviderFactory({
 *   enabled: true,
 *   flashbotsAuthKey: process.env.FLASHBOTS_AUTH_KEY,
 *   fallbackToPublic: true,
 * });
 *
 * // Create provider for a chain
 * const provider = factory.createProvider({
 *   chain: 'ethereum',
 *   provider: ethersProvider,
 *   wallet: signer,
 * });
 *
 * // Send protected transaction
 * const result = await provider.sendProtectedTransaction(tx);
 * ```
 */
export class MevProviderFactory {
  private readonly globalConfig: MevGlobalConfig;
  private readonly providers: Map<string, IMevProvider>;

  constructor(config: MevGlobalConfig) {
    this.globalConfig = {
      enabled: config.enabled,
      flashbotsAuthKey: config.flashbotsAuthKey,
      bloxrouteAuthHeader: config.bloxrouteAuthHeader,
      flashbotsRelayUrl: config.flashbotsRelayUrl || MEV_DEFAULTS.flashbotsRelayUrl,
      submissionTimeoutMs: config.submissionTimeoutMs || MEV_DEFAULTS.submissionTimeoutMs,
      maxRetries: config.maxRetries || MEV_DEFAULTS.maxRetries,
      fallbackToPublic: config.fallbackToPublic ?? MEV_DEFAULTS.fallbackToPublic,
    };

    this.providers = new Map();
  }

  /**
   * Create or get cached MEV provider for a chain
   */
  createProvider(chainConfig: ChainWalletConfig): IMevProvider {
    const { chain, provider, wallet } = chainConfig;

    // Check cache first
    if (this.providers.has(chain)) {
      return this.providers.get(chain)!;
    }

    // Build provider config
    const config: MevProviderConfig = {
      chain,
      provider,
      wallet,
      enabled: this.globalConfig.enabled,
      flashbotsAuthKey: this.globalConfig.flashbotsAuthKey,
      bloxrouteAuthHeader: this.globalConfig.bloxrouteAuthHeader,
      flashbotsRelayUrl: this.globalConfig.flashbotsRelayUrl,
      submissionTimeoutMs: this.globalConfig.submissionTimeoutMs,
      maxRetries: this.globalConfig.maxRetries,
      fallbackToPublic: this.globalConfig.fallbackToPublic,
    };

    // Create appropriate provider based on chain strategy
    let mevProvider: IMevProvider;
    const strategy = CHAIN_MEV_STRATEGIES[chain] || 'standard';

    switch (strategy) {
      case 'flashbots':
        mevProvider = createFlashbotsProvider(config);
        break;

      case 'sequencer':
        mevProvider = createL2SequencerProvider(config);
        break;

      case 'bloxroute':
      case 'fastlane':
      case 'standard':
      default:
        mevProvider = createStandardProvider(config);
        break;
    }

    // Cache provider
    this.providers.set(chain, mevProvider);

    return mevProvider;
  }

  /**
   * Get cached provider for a chain
   */
  getProvider(chain: string): IMevProvider | undefined {
    return this.providers.get(chain);
  }

  /**
   * Check if provider exists for chain
   */
  hasProvider(chain: string): boolean {
    return this.providers.has(chain);
  }

  /**
   * Get MEV strategy for a chain
   */
  getStrategy(chain: string): MevStrategy {
    return CHAIN_MEV_STRATEGIES[chain] || 'standard';
  }

  /**
   * Get all registered providers
   */
  getAllProviders(): Map<string, IMevProvider> {
    return new Map(this.providers);
  }

  /**
   * Get aggregated metrics across all providers
   */
  getAggregatedMetrics(): {
    global: MevMetrics;
    byChain: Record<string, MevMetrics>;
  } {
    const byChain: Record<string, MevMetrics> = {};
    const global: MevMetrics = {
      totalSubmissions: 0,
      successfulSubmissions: 0,
      failedSubmissions: 0,
      fallbackSubmissions: 0,
      averageLatencyMs: 0,
      bundlesIncluded: 0,
      bundlesReverted: 0,
      lastUpdated: 0,
    };

    let totalLatency = 0;
    let latencyCount = 0;

    for (const [chain, provider] of this.providers) {
      const metrics = provider.getMetrics();
      byChain[chain] = metrics;

      global.totalSubmissions += metrics.totalSubmissions;
      global.successfulSubmissions += metrics.successfulSubmissions;
      global.failedSubmissions += metrics.failedSubmissions;
      global.fallbackSubmissions += metrics.fallbackSubmissions;
      global.bundlesIncluded += metrics.bundlesIncluded;
      global.bundlesReverted += metrics.bundlesReverted;

      if (metrics.averageLatencyMs > 0) {
        totalLatency += metrics.averageLatencyMs * metrics.successfulSubmissions;
        latencyCount += metrics.successfulSubmissions;
      }

      if (metrics.lastUpdated > global.lastUpdated) {
        global.lastUpdated = metrics.lastUpdated;
      }
    }

    if (latencyCount > 0) {
      global.averageLatencyMs = totalLatency / latencyCount;
    }

    return { global, byChain };
  }

  /**
   * Reset metrics for all providers
   */
  resetAllMetrics(): void {
    for (const provider of this.providers.values()) {
      provider.resetMetrics();
    }
  }

  /**
   * Run health checks on all providers
   */
  async healthCheckAll(): Promise<Record<string, { healthy: boolean; message: string }>> {
    const results: Record<string, { healthy: boolean; message: string }> = {};

    const checks = Array.from(this.providers.entries()).map(
      async ([chain, provider]) => {
        try {
          results[chain] = await provider.healthCheck();
        } catch (error) {
          results[chain] = {
            healthy: false,
            message: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    );

    await Promise.all(checks);

    return results;
  }

  /**
   * Check if MEV protection is enabled globally
   */
  isEnabled(): boolean {
    return this.globalConfig.enabled;
  }

  /**
   * Enable or disable MEV protection globally
   */
  setEnabled(enabled: boolean): void {
    this.globalConfig.enabled = enabled;
  }

  /**
   * Clear provider cache (useful for testing or reconfiguration)
   */
  clearProviders(): void {
    this.providers.clear();
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a simple MEV provider for a single chain
 */
export function createMevProvider(
  chain: string,
  provider: ethers.JsonRpcProvider,
  wallet: ethers.Wallet,
  options?: {
    enabled?: boolean;
    flashbotsAuthKey?: string;
    bloxrouteAuthHeader?: string;
    fallbackToPublic?: boolean;
  }
): IMevProvider {
  const config: MevProviderConfig = {
    chain,
    provider,
    wallet,
    enabled: options?.enabled ?? true,
    flashbotsAuthKey: options?.flashbotsAuthKey,
    bloxrouteAuthHeader: options?.bloxrouteAuthHeader,
    fallbackToPublic: options?.fallbackToPublic ?? true,
    submissionTimeoutMs: MEV_DEFAULTS.submissionTimeoutMs,
    maxRetries: MEV_DEFAULTS.maxRetries,
  };

  const strategy = CHAIN_MEV_STRATEGIES[chain] || 'standard';

  switch (strategy) {
    case 'flashbots':
      return createFlashbotsProvider(config);
    case 'sequencer':
      return createL2SequencerProvider(config);
    default:
      return createStandardProvider(config);
  }
}

/**
 * Check if a chain has MEV protection available
 */
export function hasMevProtection(chain: string): boolean {
  const strategy = CHAIN_MEV_STRATEGIES[chain];
  // All strategies except 'standard' provide some level of MEV protection
  return strategy !== undefined && strategy !== 'standard';
}

/**
 * Get recommended priority fee for a chain
 */
export function getRecommendedPriorityFee(chain: string): number {
  const strategy = CHAIN_MEV_STRATEGIES[chain];

  switch (strategy) {
    case 'flashbots':
      // Ethereum mainnet: higher priority for better inclusion
      return 2.0;
    case 'bloxroute':
      // BSC: moderate priority
      return 3.0;
    case 'fastlane':
      // Polygon: moderate priority
      return 30.0;
    case 'sequencer':
      // L2s: low priority (cheap gas)
      return 0.01;
    default:
      // Standard: depends on chain
      return 1.0;
  }
}

// =============================================================================
// Re-exports
// =============================================================================

export { FlashbotsProvider } from './flashbots-provider';
export { L2SequencerProvider, isL2SequencerChain, getL2ChainConfig } from './l2-sequencer-provider';
export { StandardProvider } from './standard-provider';
export * from './types';
