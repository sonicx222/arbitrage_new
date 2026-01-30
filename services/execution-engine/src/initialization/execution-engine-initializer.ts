/**
 * Execution Engine Initializer
 *
 * Facade for all initialization operations.
 * Provides a single entry point for engine startup.
 *
 * NOT part of hot path - called once during initialization.
 *
 * Initialization Order:
 * 1. MEV providers (async, depends on providerService)
 * 2. Risk management (sync, reads from config only - no providerService dependency)
 * 3. Bridge router (sync, depends on providerService)
 *
 * MEV and Risk can run in parallel since Risk doesn't depend on providers.
 * Bridge router runs after to ensure providers are fully initialized.
 *
 * @see ADR-017: MEV Protection Enhancement
 * @see ADR-021: Capital Risk Management
 */

import { initializeMevProviders } from './mev-initializer';
import { initializeRiskManagement } from './risk-management-initializer';
import { initializeBridgeRouter } from './bridge-router-initializer';
import type { ProviderServiceImpl } from '../services/provider.service';
import type {
  InitializationResult,
  InitializationLogger,
  InitializationConfig,
  MevInitializationResult,
  RiskManagementComponents,
  BridgeRouterInitializationResult,
} from './types';
import { AsyncMutex, getErrorMessage } from '@arbitrage/core';

/**
 * Module-level state for initialization tracking.
 * Protected by mutex to prevent concurrent initialization.
 */
const initializationMutex = new AsyncMutex();
let isInitialized = false;

/** Partial results stored in case of failure (for diagnostics) */
let lastPartialResults: {
  mev?: MevInitializationResult;
  risk?: RiskManagementComponents;
  bridgeRouter?: BridgeRouterInitializationResult;
} | null = null;

/**
 * Initialize all execution engine components.
 *
 * This is a ONE-TIME initialization called during service startup.
 * NOT part of the hot path.
 *
 * Uses mutex to prevent race conditions if called concurrently.
 * MEV providers initialize first (async), then risk management (sync),
 * then bridge router (sync).
 *
 * @param providerService - Initialized provider service
 * @param logger - Logger instance
 * @param config - Optional initialization configuration
 * @returns All initialized components with discriminated union result
 */
export async function initializeExecutionEngine(
  providerService: ProviderServiceImpl,
  logger: InitializationLogger,
  config?: InitializationConfig
): Promise<InitializationResult> {
  return initializationMutex.runExclusive(async () => {
    // Double-check after acquiring lock
    if (isInitialized) {
      logger.warn('Execution engine already initialized - skipping re-initialization');
      throw new Error('Execution engine already initialized');
    }

    const startTime = performance.now();
    lastPartialResults = {};

    try {
      logger.info('Starting execution engine initialization');

      // Step 1: Initialize MEV providers (async, network operations)
      // This is the only truly async operation
      const mev = await initializeMevProviders(providerService, logger);
      lastPartialResults.mev = mev;

      // Step 2: Initialize risk management (sync, config-only)
      // No need for Promise.resolve - it's synchronous
      const risk = initializeRiskManagement(logger, config);
      lastPartialResults.risk = risk;

      // Step 3: Initialize bridge router (sync, uses providers)
      const bridgeRouter = initializeBridgeRouter(providerService, logger);
      lastPartialResults.bridgeRouter = bridgeRouter;

      // Mark as initialized only after all components succeed
      isInitialized = true;

      const durationMs = performance.now() - startTime;

      // Log summary with timing
      logger.info('Execution engine initialization complete', {
        durationMs: Math.round(durationMs),
        mev: {
          success: mev.success,
          providersInitialized: mev.providersInitialized,
          failedChains: mev.failedChains,
        },
        risk: {
          success: risk.success,
          enabled: risk.enabled,
          componentStatus: risk.componentStatus,
        },
        bridgeRouter: {
          success: bridgeRouter.success,
          protocols: bridgeRouter.protocols,
          chains: bridgeRouter.chains,
        },
      });

      return {
        success: true,
        mev,
        risk,
        bridgeRouter,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const durationMs = performance.now() - startTime;

      logger.error('Execution engine initialization failed', {
        error: errorMessage,
        durationMs: Math.round(durationMs),
        partial: lastPartialResults,
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
        partial: lastPartialResults,
      };
    }
  });
}

/**
 * Reset initialization state.
 *
 * WARNING: This is intended for testing only. In production, services should
 * be stopped and restarted rather than reset.
 *
 * This resets:
 * - The isInitialized flag (allowing re-initialization)
 * - Clears partial results from any failed initialization
 *
 * Note: This does NOT clean up resources from initialized components.
 * Components like MEV providers, risk trackers, etc. may still hold state.
 * The caller is responsible for cleaning up those resources.
 *
 * @internal
 */
export function resetInitializationState(): void {
  isInitialized = false;
  lastPartialResults = null;
}

/**
 * Check if initialization is complete.
 *
 * @returns true if initializeExecutionEngine completed successfully
 */
export function isInitializationComplete(): boolean {
  return isInitialized;
}

/**
 * Get partial results from the last initialization attempt.
 * Useful for diagnostics when initialization fails partway through.
 *
 * @returns Partial results or null if no initialization attempted
 */
export function getLastPartialResults(): typeof lastPartialResults {
  return lastPartialResults;
}
