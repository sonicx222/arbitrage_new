/**
 * Execution Engine Initializer
 *
 * Facade for all initialization operations.
 * Provides a single entry point for engine startup.
 *
 * NOT part of hot path - called once during initialization.
 *
 * Initialization Order (sequential):
 * 1. MEV providers (async, depends on providerService)
 * 2. Risk management (sync, reads from config only - no providerService dependency)
 * 3. Bridge router (sync, depends on providerService)
 *
 * Note: While MEV and Risk could theoretically run in parallel (Risk doesn't
 * depend on providers), they run sequentially for simplicity and debuggability.
 * The total initialization time is dominated by MEV provider network calls,
 * so parallelizing with the fast sync Risk init provides negligible benefit.
 * Bridge router runs last to ensure providers are fully initialized.
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
 * Thread Safety Note (Fix 5.3):
 * =============================
 * In containerized environments (Docker, K8s), process restarts create fresh
 * module state, so the isInitialized flag is naturally reset. However, in
 * scenarios where the module is retained but the service is "soft restarted":
 * - The isInitialized flag remains true
 * - Calling initializeExecutionEngine() will throw
 * - This is INTENTIONAL to prevent double-initialization bugs
 *
 * If you need to re-initialize in tests, call resetInitializationState() first.
 * In production, prefer a full process restart over soft restart.
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
