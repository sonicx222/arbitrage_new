/**
 * Execution Engine Initialization Module
 *
 * Single source of truth for initialization operations.
 * NOT part of hot path - used only at service startup.
 *
 * This module provides:
 * - Main initializer facade (initializeExecutionEngine)
 * - Individual initializers for fine-grained control
 * - Type definitions and helper functions
 *
 * @see ADR-017: MEV Protection Enhancement
 * @see ADR-021: Capital Risk Management
 */

// Main initializer facade
export {
  initializeExecutionEngine,
  resetInitializationState,
  isInitializationComplete,
  getLastPartialResults,
} from './execution-engine-initializer';

// Individual initializers (for fine-grained control)
export { initializeMevProviders } from './mev-initializer';
export { initializeRiskManagement } from './risk-management-initializer';
export { initializeBridgeRouter } from './bridge-router-initializer';
// D2: Strategy initialization extracted from engine.ts
export { initializeAllStrategies } from './strategy-initializer';
export type { StrategyInitDeps, StrategyInitResult } from './strategy-initializer';

// Types
export type {
  MevInitializationResult,
  RiskManagementComponents,
  BridgeRouterInitializationResult,
  InitializationResult,
  InitializationSuccessResult,
  InitializationFailureResult,
  InitializationLogger,
  InitializationConfig,
} from './types';

// Helper functions for creating initialization results
export {
  createDisabledMevResult,
  createDisabledRiskResult,
  createFailedRiskResult,
  createDisabledBridgeResult,
  createFailedBridgeResult,
} from './types';
