/**
 * MEV Provider Initialization
 *
 * Extracted from engine.ts for single-responsibility principle.
 * Handles MEV protection provider setup during service startup.
 *
 * NOT part of hot path - called once during initialization.
 *
 * ADR-017 Compliance:
 * - Uses createProviderAsync for proper async initialization with internal mutex
 * - Verifies providers are cached in factory after creation
 * - Supports per-chain strategy configuration (flashbots, bloxroute, fastlane, etc.)
 * - Handles partial failures gracefully (some chains may fail, others succeed)
 *
 * @see ADR-017: MEV Protection Enhancement
 */

import {
  MevProviderFactory,
  MevGlobalConfig,
  getErrorMessage,
} from '@arbitrage/core';
import { MEV_CONFIG } from '@arbitrage/config';
import type { ProviderServiceImpl } from '../services/provider.service';
import type { MevInitializationResult, InitializationLogger } from './types';
import { createDisabledMevResult } from './types';

/**
 * Timeout for individual provider initialization (prevents hanging).
 *
 * Doc 2.3: This timeout is intentionally NOT externally configurable.
 * Rationale:
 * - 30s is generous for any MEV provider initialization (network + auth)
 * - In competitive arbitrage, if provider takes >30s, it's likely broken
 * - Allowing external config risks users setting dangerously high values
 *   that would delay startup without benefit
 * - If this needs adjustment, it should be a code change with review
 */
const PROVIDER_INIT_TIMEOUT_MS = 30_000;

/**
 * Initialize MEV protection providers for all configured chains.
 *
 * Async to support createProviderAsync for proper mutex handling per ADR-017.
 * Returns detailed error information when initialization fails.
 *
 * @param providerService - Provider service with chain connections
 * @param logger - Logger instance
 * @returns MEV factory, count of initialized providers, and status information
 */
export async function initializeMevProviders(
  providerService: ProviderServiceImpl,
  logger: InitializationLogger
): Promise<MevInitializationResult> {
  const startTime = performance.now();

  if (!MEV_CONFIG.enabled) {
    logger.info('MEV protection disabled by configuration');
    return createDisabledMevResult();
  }

  const mevGlobalConfig: MevGlobalConfig = {
    enabled: MEV_CONFIG.enabled,
    flashbotsAuthKey: MEV_CONFIG.flashbotsAuthKey,
    bloxrouteAuthHeader: MEV_CONFIG.bloxrouteAuthHeader,
    flashbotsRelayUrl: MEV_CONFIG.flashbotsRelayUrl,
    submissionTimeoutMs: MEV_CONFIG.submissionTimeoutMs,
    maxRetries: MEV_CONFIG.maxRetries,
    fallbackToPublic: MEV_CONFIG.fallbackToPublic,
  };

  const factory = new MevProviderFactory(mevGlobalConfig);
  let providersInitialized = 0;
  const failedChains: string[] = [];
  const skippedChains: string[] = [];

  // Get chain names once (avoids creating iterator on each access)
  const chainNames = Array.from(providerService.getWallets().keys());

  // Initialize each chain's MEV provider with timeout protection
  const initPromises = chainNames.map(async (chainName) => {
    const provider = providerService.getProvider(chainName);
    const wallet = providerService.getWallet(chainName);

    // Skip if no provider or wallet available
    if (!provider || !wallet) {
      // Use info level for expected skips (consistent with other initializers)
      logger.info(`Skipping MEV provider for ${chainName}: no provider or wallet available`);
      return { chainName, success: false, skipped: true, reason: 'no_provider_or_wallet' };
    }

    const chainSettings = MEV_CONFIG.chainSettings[chainName];

    // Explicitly handle unconfigured chains
    if (!chainSettings) {
      logger.info(`Skipping MEV provider for ${chainName}: chain not in MEV_CONFIG.chainSettings`);
      return { chainName, success: false, skipped: true, reason: 'unconfigured' };
    }

    // Skip if explicitly disabled in config
    if (chainSettings.enabled === false) {
      logger.info(`Skipping MEV provider for ${chainName}: disabled in config`);
      return { chainName, success: false, skipped: true, reason: 'disabled' };
    }

    // Skip Solana - it requires JitoProvider with different types
    if (chainSettings.strategy === 'jito') {
      logger.info(`Skipping MEV provider for ${chainName}: requires JitoProvider (not EVM compatible)`);
      return { chainName, success: false, skipped: true, reason: 'jito_not_supported' };
    }

    try {
      // Initialize with timeout to prevent hanging on unresponsive providers
      const mevProvider = await Promise.race([
        factory.createProviderAsync({
          chain: chainName,
          provider,
          wallet,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`MEV provider initialization timeout after ${PROVIDER_INIT_TIMEOUT_MS}ms`)),
            PROVIDER_INIT_TIMEOUT_MS
          )
        ),
      ]);

      // Verify provider is stored in factory cache (ADR-017 compliance)
      const cachedProvider = factory.getProvider(chainName);
      if (!cachedProvider) {
        // Use standardized error format: component:chain:reason
        const errorMsg = `mev:${chainName}:provider_not_cached`;
        logger.warn(`MEV provider created but not cached for ${chainName}`, { error: errorMsg });
        return { chainName, success: false, skipped: false, error: errorMsg };
      }

      logger.info(`MEV provider initialized for ${chainName}`, {
        strategy: mevProvider.strategy,
        enabled: mevProvider.isEnabled(),
      });

      return { chainName, success: true, skipped: false };
    } catch (error) {
      // Use standardized error format: component:chain:error_details
      const errorDetails = getErrorMessage(error);
      const standardizedError = `mev:${chainName}:${errorDetails}`;
      logger.warn(`Failed to initialize MEV provider for ${chainName}`, {
        error: standardizedError,
      });
      return { chainName, success: false, skipped: false, error: standardizedError };
    }
  });

  // Wait for all initialization attempts to complete
  const results = await Promise.all(initPromises);

  // Count successes and collect failures
  for (const result of results) {
    if (result.success) {
      providersInitialized++;
    } else if (result.skipped) {
      skippedChains.push(result.chainName);
    } else {
      failedChains.push(result.chainName);
    }
  }

  const durationMs = performance.now() - startTime;

  // Warn if no providers initialized but some were attempted
  const attemptedCount = results.filter(r => !r.skipped).length;
  if (providersInitialized === 0 && attemptedCount > 0) {
    // Use standardized error format
    const errorMsg = `mev:all_providers_failed:${attemptedCount}_attempted`;
    logger.warn('MEV protection enabled but no providers initialized successfully', {
      error: errorMsg,
      attemptedChains: attemptedCount,
      failedChains,
      durationMs: Math.round(durationMs),
    });

    return {
      factory,
      providersInitialized: 0,
      success: false,
      error: errorMsg,
      failedChains,
    };
  }

  logger.info('MEV protection initialization complete', {
    providersInitialized,
    globalEnabled: MEV_CONFIG.enabled,
    skippedChains: skippedChains.length > 0 ? skippedChains : undefined,
    failedChains: failedChains.length > 0 ? failedChains : undefined,
    durationMs: Math.round(durationMs),
  });

  // Bug 4.4 Fix: Include skippedChains in result for debugging visibility
  return {
    factory,
    providersInitialized,
    success: true,
    failedChains: failedChains.length > 0 ? failedChains : undefined,
    skippedChains: skippedChains.length > 0 ? skippedChains : undefined,
  };
}
