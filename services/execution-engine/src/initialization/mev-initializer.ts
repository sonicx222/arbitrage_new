/**
 * MEV Provider Initialization
 *
 * Extracted from engine.ts for single-responsibility principle.
 * Handles MEV protection provider setup during service startup.
 *
 * NOT part of hot path - called once during initialization.
 */

import {
  MevProviderFactory,
  MevGlobalConfig,
  getErrorMessage,
} from '@arbitrage/core';
import { MEV_CONFIG } from '@arbitrage/config';
import type { ProviderServiceImpl } from '../services/provider.service';
import type { MevInitializationResult, InitializationLogger } from './types';

/**
 * Initialize MEV protection providers for all configured chains.
 *
 * @param providerService - Provider service with chain connections
 * @param logger - Logger instance
 * @returns MEV factory and count of initialized providers
 */
export function initializeMevProviders(
  providerService: ProviderServiceImpl,
  logger: InitializationLogger
): MevInitializationResult {
  if (!MEV_CONFIG.enabled) {
    logger.info('MEV protection disabled by configuration');
    return { factory: null, providersInitialized: 0 };
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

  for (const chainName of providerService.getWallets().keys()) {
    const provider = providerService.getProvider(chainName);
    const wallet = providerService.getWallet(chainName);

    if (provider && wallet) {
      const chainSettings = MEV_CONFIG.chainSettings[chainName];
      if (chainSettings?.enabled !== false) {
        try {
          const mevProvider = factory.createProvider({
            chain: chainName,
            provider,
            wallet,
          });

          providersInitialized++;
          logger.info(`MEV provider initialized for ${chainName}`, {
            strategy: mevProvider.strategy,
            enabled: mevProvider.isEnabled(),
          });
        } catch (error) {
          logger.warn(`Failed to initialize MEV provider for ${chainName}`, {
            error: getErrorMessage(error),
          });
        }
      }
    }
  }

  logger.info('MEV protection initialization complete', {
    providersInitialized,
    globalEnabled: MEV_CONFIG.enabled,
  });

  return { factory, providersInitialized };
}
