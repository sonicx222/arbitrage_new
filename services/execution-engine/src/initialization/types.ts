/**
 * Execution Engine Initialization Types
 *
 * Types for initialization modules extracted from engine.ts.
 * NOT part of hot path - used only at service startup.
 */

import type {
  MevProviderFactory,
  DrawdownCircuitBreaker,
  EVCalculator,
  KellyPositionSizer,
  ExecutionProbabilityTracker,
  BridgeRouterFactory,
} from '@arbitrage/core';

/**
 * Result from MEV provider initialization.
 */
export interface MevInitializationResult {
  factory: MevProviderFactory | null;
  providersInitialized: number;
}

/**
 * Result from risk management initialization.
 */
export interface RiskManagementComponents {
  drawdownBreaker: DrawdownCircuitBreaker | null;
  evCalculator: EVCalculator | null;
  positionSizer: KellyPositionSizer | null;
  probabilityTracker: ExecutionProbabilityTracker | null;
  enabled: boolean;
}

/**
 * Combined result from all initialization operations.
 */
export interface InitializationResult {
  mev: MevInitializationResult;
  risk: RiskManagementComponents;
  bridgeRouterFactory: BridgeRouterFactory | null;
}

/**
 * Logger interface for initialization modules.
 */
export interface InitializationLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
}
