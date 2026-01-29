/**
 * Execution Engine Initializer
 *
 * Facade for all initialization operations.
 * Provides a single entry point for engine startup.
 *
 * NOT part of hot path - called once during initialization.
 */

import { initializeMevProviders } from './mev-initializer';
import { initializeRiskManagement } from './risk-management-initializer';
import type { ProviderServiceImpl } from '../services/provider.service';
import type {
  InitializationResult,
  MevInitializationResult,
  RiskManagementComponents,
  InitializationLogger,
} from './types';
import {
  BridgeRouterFactory,
  createBridgeRouterFactory,
  getErrorMessage,
} from '@arbitrage/core';

/**
 * Initialize all execution engine components.
 *
 * This is a ONE-TIME initialization called during service startup.
 * NOT part of the hot path.
 *
 * @param providerService - Initialized provider service
 * @param logger - Logger instance
 * @returns All initialized components
 */
export async function initializeExecutionEngine(
  providerService: ProviderServiceImpl,
  logger: InitializationLogger
): Promise<InitializationResult> {
  // Initialize MEV providers
  const mev = initializeMevProviders(providerService, logger);

  // Initialize risk management
  const risk = initializeRiskManagement(logger);

  // Initialize bridge router
  let bridgeRouterFactory: BridgeRouterFactory | null = null;
  try {
    bridgeRouterFactory = createBridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: providerService.getProviders(),
    });

    logger.info('Bridge router initialized', {
      protocols: bridgeRouterFactory.getAvailableProtocols(),
      chainsWithProviders: Array.from(providerService.getProviders().keys()),
    });
  } catch (error) {
    logger.error('Failed to initialize bridge router', {
      error: getErrorMessage(error),
    });
  }

  return { mev, risk, bridgeRouterFactory };
}

// Re-export types for consumers
export type { MevInitializationResult, RiskManagementComponents, InitializationResult };
