/**
 * Execution Engine Initialization Types
 *
 * Types for initialization modules extracted from engine.ts.
 * NOT part of hot path - used only at service startup.
 *
 * Design decisions:
 * - Uses ServiceLogger from @arbitrage/core for consistent logging interface
 * - All results use success/error discriminated unions for type-safe handling
 * - Helper functions provide consistent disabled/failed result creation
 *
 * @see ADR-021: Capital Risk Management
 */

import type {
  MevProviderFactory,
  DrawdownCircuitBreaker,
  EVCalculator,
  KellyPositionSizer,
  ExecutionProbabilityTracker,
  BridgeRouterFactory,
  ServiceLogger,
} from '@arbitrage/core';

/**
 * Logger interface for initialization operations.
 * Re-exports ServiceLogger from core for semantic clarity and consistency.
 */
export type InitializationLogger = ServiceLogger;

/**
 * Result from MEV provider initialization.
 * Includes success flag and detailed error information for diagnostics.
 *
 * Bug 4.4 Fix: Added skippedChains to track chains that were intentionally
 * skipped (no provider, disabled in config, etc.) vs chains that failed
 * to initialize. This aids debugging and operational visibility.
 */
export interface MevInitializationResult {
  /** The MEV provider factory, or null if disabled/failed */
  factory: MevProviderFactory | null;
  /** Number of providers successfully initialized */
  providersInitialized: number;
  /** Whether MEV initialization succeeded (at least partially) */
  success: boolean;
  /** Error message if initialization completely failed */
  error?: string;
  /** Chains that failed to initialize (for partial failures) */
  failedChains?: string[];
  /**
   * Bug 4.4 Fix: Chains that were intentionally skipped.
   * Reasons include: no provider/wallet available, not configured, disabled, or
   * requires incompatible provider (e.g., Jito for Solana).
   * Useful for debugging why certain chains don't have MEV protection.
   */
  skippedChains?: string[];
}

/**
 * Result from risk management initialization.
 *
 * Supports partial initialization - individual component failures don't disable
 * the entire risk management system. Each component has independent status tracking.
 */
export interface RiskManagementComponents {
  /** Drawdown circuit breaker instance */
  drawdownBreaker: DrawdownCircuitBreaker | null;
  /** Expected value calculator instance */
  evCalculator: EVCalculator | null;
  /** Kelly criterion position sizer instance */
  positionSizer: KellyPositionSizer | null;
  /** Execution probability tracker instance */
  probabilityTracker: ExecutionProbabilityTracker | null;
  /** Whether risk management is enabled (any component active) */
  enabled: boolean;
  /** Overall initialization success */
  success: boolean;
  /** Error message if initialization completely failed */
  error?: string;
  /** Component-level initialization status for diagnostics */
  componentStatus: {
    probabilityTracker: boolean;
    evCalculator: boolean;
    positionSizer: boolean;
    drawdownBreaker: boolean;
  };
}

/**
 * Result from bridge router initialization.
 */
export interface BridgeRouterInitializationResult {
  /** The bridge router factory, or null if initialization failed */
  factory: BridgeRouterFactory | null;
  /** List of protocols available */
  protocols: string[];
  /** List of chains with providers */
  chains: string[];
  /** Whether initialization succeeded */
  success: boolean;
  /** Error message if initialization failed */
  error?: string;
}

/**
 * Combined result from all initialization operations.
 * Uses discriminated union pattern for type-safe success/failure handling.
 */
export type InitializationResult =
  | InitializationSuccessResult
  | InitializationFailureResult;

/**
 * Successful initialization result with all components.
 */
export interface InitializationSuccessResult {
  /** Discriminant for type narrowing */
  success: true;
  /** MEV initialization result */
  mev: MevInitializationResult;
  /** Risk management components */
  risk: RiskManagementComponents;
  /** Bridge router initialization result */
  bridgeRouter: BridgeRouterInitializationResult;
}

/**
 * Failed initialization result with error details.
 */
export interface InitializationFailureResult {
  /** Discriminant for type narrowing */
  success: false;
  /** Error that caused initialization to fail */
  error: Error;
  /** Partial results from components that initialized before failure */
  partial?: {
    mev?: MevInitializationResult;
    risk?: RiskManagementComponents;
    bridgeRouter?: BridgeRouterInitializationResult;
  };
}

/**
 * Configuration for initialization with validation options.
 * Supports environment-specific settings and force-enable flags for testing.
 */
export interface InitializationConfig {
  /** Skip validation (useful for testing) */
  skipValidation?: boolean;
  /**
   * Force enable risk management even if config says disabled.
   * Useful for integration tests that need risk components active.
   */
  forceRiskManagement?: boolean;
  /**
   * Force enable MEV even if config says disabled.
   * Useful for testing MEV integration without changing environment.
   */
  forceMev?: boolean;
}

/**
 * Helper to create a disabled MEV result.
 */
export function createDisabledMevResult(): MevInitializationResult {
  return {
    factory: null,
    providersInitialized: 0,
    success: true, // Disabled by config is not a failure
  };
}

/**
 * Helper to create a disabled risk management result.
 */
export function createDisabledRiskResult(): RiskManagementComponents {
  return {
    drawdownBreaker: null,
    evCalculator: null,
    positionSizer: null,
    probabilityTracker: null,
    enabled: false,
    success: true, // Disabled by config is not a failure
    componentStatus: {
      probabilityTracker: false,
      evCalculator: false,
      positionSizer: false,
      drawdownBreaker: false,
    },
  };
}

/**
 * Helper to create a failed risk management result.
 */
export function createFailedRiskResult(
  error: string,
  partialComponents?: Partial<RiskManagementComponents>
): RiskManagementComponents {
  return {
    drawdownBreaker: partialComponents?.drawdownBreaker ?? null,
    evCalculator: partialComponents?.evCalculator ?? null,
    positionSizer: partialComponents?.positionSizer ?? null,
    probabilityTracker: partialComponents?.probabilityTracker ?? null,
    enabled: false,
    success: false,
    error,
    componentStatus: partialComponents?.componentStatus ?? {
      probabilityTracker: false,
      evCalculator: false,
      positionSizer: false,
      drawdownBreaker: false,
    },
  };
}

/**
 * Helper to create a disabled bridge router result.
 * Used when cross-chain functionality is explicitly disabled or not available.
 */
export function createDisabledBridgeResult(): BridgeRouterInitializationResult {
  return {
    factory: null,
    protocols: [],
    chains: [],
    success: true, // Disabled by design is not a failure
  };
}

/**
 * Helper to create a failed bridge router result.
 * @param error - Error message describing the failure
 */
export function createFailedBridgeResult(error: string): BridgeRouterInitializationResult {
  return {
    factory: null,
    protocols: [],
    chains: [],
    success: false,
    error,
  };
}
