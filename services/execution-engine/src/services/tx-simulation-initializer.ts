/**
 * Transaction Simulation Service Initializer
 *
 * Extracted from engine.ts to reduce file complexity.
 * Initializes Tenderly and/or Alchemy simulation providers
 * from environment variable configuration.
 *
 * NOT on hot path — called once during engine startup.
 *
 * @see engine.ts (consumer)
 * @see services/simulation/ (provider implementations)
 */

import { getErrorMessage } from '@arbitrage/core';
import { ethers } from 'ethers';
import type { ISimulationService, ISimulationProvider } from './simulation/types';
import { SimulationService } from './simulation/simulation.service';
import { createTenderlyProvider } from './simulation/tenderly-provider';
import { createAlchemyProvider } from './simulation/alchemy-provider';
import type { Logger } from '../types';

/**
 * Minimal interface for provider access during simulation service init.
 * Uses interface instead of concrete ProviderServiceImpl to allow testing.
 */
export interface SimulationProviderSource {
  getProviders(): Map<string, ethers.JsonRpcProvider>;
  getProvider(chain: string): ethers.JsonRpcProvider | undefined;
}

/**
 * Initialize the transaction simulation service from environment configuration.
 *
 * Initializes simulation providers in priority order:
 * 1. Tenderly (if TENDERLY_API_KEY + TENDERLY_ACCOUNT_SLUG + TENDERLY_PROJECT_SLUG set)
 * 2. Alchemy fallback (if ALCHEMY_API_KEY set and no Tenderly providers)
 *
 * @param providerSource - Source for configured chain providers
 * @param logger - Logger instance
 * @returns Initialized simulation service, or null if no providers configured
 */
export function initializeTxSimulationService(
  providerSource: SimulationProviderSource,
  logger: Logger,
): ISimulationService | null {
  const providers: ISimulationProvider[] = [];
  const configuredChains = Array.from(providerSource.getProviders().keys());

  // Initialize Tenderly provider if configured
  const tenderlyApiKey = process.env.TENDERLY_API_KEY;
  const tenderlyAccountSlug = process.env.TENDERLY_ACCOUNT_SLUG;
  const tenderlyProjectSlug = process.env.TENDERLY_PROJECT_SLUG;

  if (tenderlyApiKey && tenderlyAccountSlug && tenderlyProjectSlug) {
    try {
      // Create Tenderly provider for each chain
      for (const chain of configuredChains) {
        const provider = providerSource.getProvider(chain);
        if (provider) {
          const tenderlyProvider = createTenderlyProvider({
            type: 'tenderly',
            chain,
            provider,
            enabled: true,
            apiKey: tenderlyApiKey,
            accountSlug: tenderlyAccountSlug,
            projectSlug: tenderlyProjectSlug,
          });
          providers.push(tenderlyProvider);
          logger.debug('Tenderly provider initialized', { chain });
        }
      }
    } catch (error) {
      logger.warn('Failed to initialize Tenderly provider', {
        error: getErrorMessage(error),
      });
    }
  }

  // Initialize Alchemy provider if configured (fallback)
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;
  if (alchemyApiKey && providers.length === 0) {
    try {
      for (const chain of configuredChains) {
        const provider = providerSource.getProvider(chain);
        if (provider) {
          const alchemyProvider = createAlchemyProvider({
            type: 'alchemy',
            chain,
            provider,
            enabled: true,
            apiKey: alchemyApiKey,
          });
          providers.push(alchemyProvider);
          logger.debug('Alchemy provider initialized', { chain });
        }
      }
    } catch (error) {
      logger.warn('Failed to initialize Alchemy provider', {
        error: getErrorMessage(error),
      });
    }
  }

  if (providers.length === 0) {
    logger.info('Transaction simulation service not initialized - no providers configured', {
      hint: 'Set TENDERLY_API_KEY/TENDERLY_ACCOUNT_SLUG/TENDERLY_PROJECT_SLUG or ALCHEMY_API_KEY',
    });
    return null;
  }

  // Read config from environment with defaults
  const minProfitForSimulation = parseInt(process.env.SIMULATION_MIN_PROFIT || '50', 10);
  const timeCriticalThresholdMs = parseInt(process.env.SIMULATION_TIME_CRITICAL_MS || '2000', 10);

  const service = new SimulationService({
    providers,
    logger,
    config: {
      minProfitForSimulation,
      bypassForTimeCritical: true,
      timeCriticalThresholdMs,
      useFallback: true,
    },
  });

  logger.info('Transaction simulation service initialized', {
    providerCount: providers.length,
    chains: configuredChains,
    minProfitForSimulation,
    timeCriticalThresholdMs,
  });

  return service;
}
