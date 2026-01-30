/**
 * Bridge Router Initialization
 *
 * Extracted for single-responsibility principle and consistency with other initializers.
 * Handles cross-chain bridge router setup during service startup.
 *
 * NOT part of hot path - called once during initialization.
 *
 * @see ADR-007: Failover Strategy (cross-chain support)
 */

import {
  createBridgeRouterFactory,
  getErrorMessage,
} from '@arbitrage/core';
import type { ProviderServiceImpl } from '../services/provider.service';
import type { InitializationLogger, BridgeRouterInitializationResult } from './types';
import { createFailedBridgeResult } from './types';

// Re-export type for backward compatibility
export type { BridgeRouterInitializationResult } from './types';

/**
 * Initialize bridge router factory for cross-chain operations.
 *
 * @param providerService - Provider service with chain connections
 * @param logger - Logger instance
 * @returns Bridge router factory and initialization metadata
 */
export function initializeBridgeRouter(
  providerService: ProviderServiceImpl,
  logger: InitializationLogger
): BridgeRouterInitializationResult {
  const startTime = performance.now();

  try {
    const providers = providerService.getProviders();

    if (providers.size === 0) {
      // Use standardized error message format: component:reason
      const errorMsg = 'bridge-router:no_providers_available';
      logger.warn('No providers available for bridge router initialization', {
        error: errorMsg,
      });
      return createFailedBridgeResult(errorMsg);
    }

    const factory = createBridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers,
    });

    const protocols = factory.getAvailableProtocols();
    const chains = Array.from(providers.keys());
    const durationMs = performance.now() - startTime;

    logger.info('Bridge router initialized', {
      protocols,
      chainsWithProviders: chains,
      durationMs: Math.round(durationMs),
    });

    return {
      factory,
      protocols,
      chains,
      success: true,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const durationMs = performance.now() - startTime;

    // Use standardized error message format: component:error_details
    const standardizedError = `bridge-router:${errorMessage}`;
    logger.error('Failed to initialize bridge router', {
      error: standardizedError,
      durationMs: Math.round(durationMs),
    });

    return createFailedBridgeResult(standardizedError);
  }
}
