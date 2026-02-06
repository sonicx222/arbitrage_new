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
  CHAIN_MEV_FALLBACK_STRATEGIES,
  MEV_DEFAULTS,
} from './types';
import { FlashbotsProvider, createFlashbotsProvider } from './flashbots-provider';
import { L2SequencerProvider, createL2SequencerProvider, isL2SequencerChain } from './l2-sequencer-provider';
import { StandardProvider, createStandardProvider } from './standard-provider';
import { AsyncMutex } from '../async/async-mutex';
import { createLogger } from '../logger';

const logger = createLogger('mev-provider-factory');

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
  /**
   * Enable MEV-Share for Ethereum (rebate capture).
   * Controlled via FEATURE_MEV_SHARE environment variable.
   * Default: true (MEV-Share enabled for value capture)
   */
  useMevShare?: boolean;
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
  // Mutex for thread-safe provider creation (prevents duplicate providers during concurrent calls)
  private readonly providerMutex = new AsyncMutex();
  // Track pending provider creation to prevent race conditions in createProvider (sync path)
  private readonly pendingCreations: Map<string, Promise<IMevProvider>> = new Map();

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
   * Create or get cached MEV provider for a chain (EVM only)
   *
   * NOTE: This factory only supports EVM chains. For Solana, use JitoProvider directly:
   * ```typescript
   * import { createJitoProvider } from './jito-provider';
   * const jitoProvider = createJitoProvider({ chain: 'solana', connection, keypair, enabled: true });
   * ```
   *
   * Thread-safe: Provider constructors are synchronous, and JavaScript's single-threaded
   * execution model ensures atomic creation within synchronous code blocks.
   *
   * IMPORTANT: For concurrent async contexts, prefer createProviderAsync() which uses
   * mutex-based locking for guaranteed thread safety.
   */
  createProvider(chainConfig: ChainWalletConfig): IMevProvider {
    const { chain } = chainConfig;

    // Fast path: check cache (safe - Map.get is atomic in JS)
    const cached = this.providers.get(chain);
    if (cached) {
      return cached;
    }

    // Synchronous creation - atomic in JS single-threaded execution
    // The entire create-and-cache sequence runs without yielding to event loop
    return this.createAndCacheProviderAtomic(chainConfig);
  }

  /**
   * Async version of createProvider for contexts that can await
   *
   * RACE-CONDITION-FIX: Uses mutex to prevent duplicate provider creation when
   * multiple async operations concurrently try to create providers for the same chain.
   * This is the recommended method for use in async code paths.
   *
   * RACE-FIX-V2: Check-and-set pendingCreations atomically (in same sync block)
   * to prevent multiple promises being created for the same chain.
   */
  async createProviderAsync(chainConfig: ChainWalletConfig): Promise<IMevProvider> {
    const { chain } = chainConfig;

    // Fast path: check cache without lock
    const cached = this.providers.get(chain);
    if (cached) {
      return cached;
    }

    // RACE-FIX-V2: Check AND set pendingCreations atomically (same sync block).
    // This prevents the race where multiple callers both see pending as null
    // and both create separate promises.
    let pending = this.pendingCreations.get(chain);
    if (!pending) {
      // Create and register the promise in the same sync block (before any await)
      pending = this.createProviderAsyncInternal(chainConfig);
      this.pendingCreations.set(chain, pending);
    }

    return pending;
  }

  /**
   * Internal async provider creation with mutex protection and cleanup
   */
  private async createProviderAsyncInternal(chainConfig: ChainWalletConfig): Promise<IMevProvider> {
    const { chain } = chainConfig;

    try {
      // Use mutex to prevent duplicate creation
      return await this.providerMutex.runExclusive(async () => {
        // Double-check after acquiring lock
        const existing = this.providers.get(chain);
        if (existing) {
          return existing;
        }

        return this.createAndCacheProviderAtomic(chainConfig);
      });
    } finally {
      // Clean up pending creation tracker
      this.pendingCreations.delete(chain);
    }
  }

  /**
   * Atomic provider creation and caching
   *
   * This method is synchronous and runs atomically in JavaScript's single-threaded
   * execution model. The entire sequence (create provider -> cache it) completes
   * before any other code can run.
   */
  private createAndCacheProviderAtomic(chainConfig: ChainWalletConfig): IMevProvider {
    const { chain } = chainConfig;

    // Final check before creation (handles edge case where provider was cached
    // between our initial check and this call)
    const existing = this.providers.get(chain);
    if (existing) {
      return existing;
    }

    // Create and cache - this entire block is atomic in JS
    const provider = this.createProviderInstance(chainConfig);
    this.providers.set(chain, provider);

    return provider;
  }

  /**
   * Internal: Create provider instance without caching
   *
   * This is a pure factory method - caching is handled by the caller.
   * Separated to keep the atomic caching logic isolated.
   */
  private createProviderInstance(chainConfig: ChainWalletConfig): IMevProvider {
    const { chain, provider, wallet } = chainConfig;

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
      useMevShare: this.globalConfig.useMevShare,
    };

    // Create appropriate provider based on chain strategy
    const strategy = CHAIN_MEV_STRATEGIES[chain] || 'standard';

    switch (strategy) {
      case 'flashbots': {
        // Default to MEV-Share for value capture (50-90% rebates)
        const useMevShare = config.useMevShare !== false;

        if (useMevShare && chain === 'ethereum') {
          const { createMevShareProvider } = require('./mev-share-provider');
          return createMevShareProvider(config);
        }
        return createFlashbotsProvider(config);
      }

      case 'sequencer':
        return createL2SequencerProvider(config);

      case 'jito':
        // Jito is for Solana which uses different types (SolanaConnection, SolanaKeypair)
        // Cannot be created through this EVM factory
        throw new Error(
          `Chain "${chain}" uses Jito MEV protection which requires Solana-specific types. ` +
          `Use JitoProvider directly: createJitoProvider({ chain: 'solana', connection, keypair, enabled: true })`
        );

      case 'bloxroute':
      case 'fastlane':
      case 'standard':
      default:
        return createStandardProvider(config);
    }
  }

  /**
   * Get cached provider for a chain
   */
  getProvider(chain: string): IMevProvider | undefined {
    return this.providers.get(chain);
  }

  /**
   * Phase 4: Get ordered list of MEV providers for a chain (primary + fallbacks).
   *
   * Returns providers in fallback order:
   * 1. Primary provider (chain's default MEV strategy)
   * 2. Fallback providers (if configured and different from primary)
   *
   * Use this for implementing retry logic with provider fallback.
   * Research impact: +2-3% execution success rate.
   *
   * @param chainConfig - Chain wallet configuration for provider creation
   * @returns Array of providers in fallback order (may be empty if none available)
   */
  getProviderFallbackChain(chainConfig: ChainWalletConfig): IMevProvider[] {
    const { chain } = chainConfig;
    const providers: IMevProvider[] = [];
    const seenStrategies = new Set<MevStrategy>();

    // Get fallback strategies for this chain
    const strategies = CHAIN_MEV_FALLBACK_STRATEGIES[chain] || ['standard'];

    for (const strategy of strategies) {
      // Skip if we already have a provider for this strategy
      if (seenStrategies.has(strategy)) continue;
      seenStrategies.add(strategy);

      // Skip Jito for EVM factory (Solana uses different types)
      if (strategy === 'jito') continue;

      try {
        // Create provider for this strategy
        const provider = this.createProviderForStrategy(chainConfig, strategy);
        if (provider) {
          providers.push(provider);
        }
      } catch (error) {
        // Phase 4 FIX: Log the error - don't silently swallow
        // This is expected for chains without certain strategies configured
        logger.debug('Failed to create MEV provider for fallback strategy', {
          chain,
          strategy,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return providers;
  }

  /**
   * Phase 4: Create a provider for a specific MEV strategy.
   * Used internally by getProviderFallbackChain.
   *
   * @param chainConfig - Chain wallet configuration
   * @param strategy - MEV strategy to use
   * @returns Provider instance or undefined if strategy not applicable
   */
  private createProviderForStrategy(
    chainConfig: ChainWalletConfig,
    strategy: MevStrategy
  ): IMevProvider | undefined {
    const { chain, provider, wallet } = chainConfig;

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

    switch (strategy) {
      case 'flashbots':
        // Only valid for Ethereum mainnet
        if (chain === 'ethereum' || chain === 'goerli' || chain === 'sepolia') {
          return createFlashbotsProvider(config);
        }
        return undefined;

      case 'sequencer':
        // Only valid for L2 chains
        if (isL2SequencerChain(chain)) {
          return createL2SequencerProvider(config);
        }
        return undefined;

      case 'jito':
        // Jito requires Solana-specific types, not supported in EVM factory
        return undefined;

      case 'bloxroute':
      case 'fastlane':
      case 'standard':
      default:
        return createStandardProvider(config);
    }
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
      mevShareRebatesReceived: 0,
      totalRebateWei: 0n,
      averageRebatePercent: 0,
      lastUpdated: 0,
    };

    let totalLatency = 0;
    let latencyCount = 0;
    let totalRebatePercent = 0;
    let rebateCount = 0;

    for (const [chain, provider] of this.providers) {
      const metrics = provider.getMetrics();
      byChain[chain] = metrics;

      global.totalSubmissions += metrics.totalSubmissions;
      global.successfulSubmissions += metrics.successfulSubmissions;
      global.failedSubmissions += metrics.failedSubmissions;
      global.fallbackSubmissions += metrics.fallbackSubmissions;
      global.bundlesIncluded += metrics.bundlesIncluded;
      global.bundlesReverted += metrics.bundlesReverted;
      global.mevShareRebatesReceived += metrics.mevShareRebatesReceived;
      global.totalRebateWei += metrics.totalRebateWei;

      if (metrics.averageLatencyMs > 0) {
        totalLatency += metrics.averageLatencyMs * metrics.successfulSubmissions;
        latencyCount += metrics.successfulSubmissions;
      }

      if (metrics.averageRebatePercent > 0) {
        totalRebatePercent += metrics.averageRebatePercent * metrics.mevShareRebatesReceived;
        rebateCount += metrics.mevShareRebatesReceived;
      }

      if (metrics.lastUpdated > global.lastUpdated) {
        global.lastUpdated = metrics.lastUpdated;
      }
    }

    if (latencyCount > 0) {
      global.averageLatencyMs = totalLatency / latencyCount;
    }

    if (rebateCount > 0) {
      global.averageRebatePercent = totalRebatePercent / rebateCount;
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
 * Create a simple MEV provider for a single chain (EVM only)
 *
 * NOTE: For Solana, use createJitoProvider directly:
 * ```typescript
 * import { createJitoProvider } from './jito-provider';
 * const jitoProvider = createJitoProvider({ chain: 'solana', connection, keypair, enabled: true });
 * ```
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
    case 'jito':
      // Jito is for Solana which uses different types (SolanaConnection, SolanaKeypair)
      throw new Error(
        `Chain "${chain}" uses Jito MEV protection which requires Solana-specific types. ` +
        `Use createJitoProvider() directly with SolanaConnection and SolanaKeypair.`
      );
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
 * Chain-specific priority fees in gwei
 *
 * CONFIG-SYNC: These values are kept in sync with:
 * - MEV_CONFIG.chainSettings in shared/config/src/mev-config.ts
 * - chainBasePriorityFees in mev-risk-analyzer.ts
 *
 * If you update these values, update the other locations too.
 */
const CHAIN_PRIORITY_FEES: Record<string, number> = {
  // Ethereum/Flashbots
  ethereum: 2.0,
  // BSC/BloXroute
  bsc: 3.0,
  // Polygon/Fastlane
  polygon: 30.0,
  // L2s/Sequencer (cheap gas)
  arbitrum: 0.01,
  optimism: 0.01,
  base: 0.01,
  zksync: 0.01,
  linea: 0.01,
  // Standard chains
  avalanche: 25.0,
  fantom: 100.0,
  // Solana uses lamports, not gwei
  solana: 0,
};

/**
 * Get recommended priority fee for a chain
 *
 * Note: Solana/Jito uses lamports for tips, not gwei. Use JitoProvider directly
 * with tipLamports for Solana MEV protection.
 *
 * CONFIG-FIX: Now uses chain-specific lookup instead of strategy-based defaults,
 * ensuring consistency with MEV_CONFIG and mev-risk-analyzer.
 */
export function getRecommendedPriorityFee(chain: string): number {
  // Check chain-specific fee first
  const chainFee = CHAIN_PRIORITY_FEES[chain];
  if (chainFee !== undefined) {
    return chainFee;
  }

  // Fallback based on strategy for unknown chains
  const strategy = CHAIN_MEV_STRATEGIES[chain];
  switch (strategy) {
    case 'flashbots':
      return 2.0;
    case 'bloxroute':
      return 3.0;
    case 'fastlane':
      return 30.0;
    case 'sequencer':
      return 0.01;
    case 'jito':
      return 0;
    default:
      return 1.0; // Default for unknown standard chains
  }
}

// =============================================================================
// Re-exports
// =============================================================================

export { BaseMevProvider } from './base-provider';
export { FlashbotsProvider } from './flashbots-provider';
export { L2SequencerProvider, isL2SequencerChain, getL2ChainConfig } from './l2-sequencer-provider';
export { StandardProvider } from './standard-provider';
export * from './types';
