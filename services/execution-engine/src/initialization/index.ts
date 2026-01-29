/**
 * Execution Engine Initialization Module
 *
 * Exports for initialization operations extracted from engine.ts.
 * NOT part of hot path - used only at service startup.
 */

// Main initializer facade
export {
  initializeExecutionEngine,
} from './execution-engine-initializer';

// Individual initializers (for fine-grained control)
export { initializeMevProviders } from './mev-initializer';
export { initializeRiskManagement } from './risk-management-initializer';

// Types
export type {
  MevInitializationResult,
  RiskManagementComponents,
  InitializationResult,
  InitializationLogger,
} from './types';
