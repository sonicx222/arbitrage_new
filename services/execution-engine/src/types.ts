/**
 * Execution Engine Types
 *
 * Shared types and interfaces for the execution engine modules.
 *
 * @see engine.ts (main service)
 *
 * ## Phase 3 Type Consolidation Notes:
 *
 * Several types are now consolidated in @arbitrage/types and imported here:
 * - ExecutionResult: Canonical interface for execution results
 * - createErrorResult, createSuccessResult, createSkippedResult: Factory functions
 * - extractErrorCode: Error code extraction helper
 * - BaseHealth: Base health interface for consistency
 *
 * The local `const enum ExecutionErrorCode` is INTENTIONALLY kept here (not imported)
 * because it uses `const enum` for hot-path optimization (zero runtime overhead).
 * The shared version uses a regular `enum` which has runtime overhead.
 *
 * @see shared/types/execution.ts - Shared types (regular enum)
 * @see shared/types/common.ts - Common utility types
 */

import { ethers } from 'ethers';
import {
  createPinoLogger,
  type ILogger,
  type ServiceStateManager,
  type PerformanceLogger,
  type RedisStreamsClient,
  type DistributedLockManager,
  type NonceManager,
  type MevProviderFactory,
  type BridgeRouterFactory,
  type BatchProvider,
  type TradeLoggerConfig,
} from '@arbitrage/core';
// Fix 3.1: Import CHAINS from config to derive SUPPORTED_CHAINS dynamically
import { CHAINS } from '@arbitrage/config';
import type { ArbitrageOpportunity } from '@arbitrage/types';
// P0-FIX: Import canonical TimeoutError from @arbitrage/types (single source of truth)
import { TimeoutError, RedisStreams } from '@arbitrage/types';
// Phase 3: Import consolidated types from @arbitrage/types
import {
  ExecutionResult,
  createErrorResult,
  createSuccessResult,
  createSkippedResult,
  extractErrorCode,
  BaseHealth,
} from '@arbitrage/types';
import type { ISimulationService } from './services/simulation/types';
import type { ABTestingConfig } from './ab-testing/types';
// P3 Optimization: Import orderflow signal type for execution integration
import type { OrderflowSignal } from '@arbitrage/core';

// =============================================================================
// Re-exports for backward compatibility (Phase 3)
// =============================================================================
// These re-exports ensure existing imports from './types' continue to work
// after consolidation to @arbitrage/types.

export type { ExecutionResult };
export { createErrorResult, createSuccessResult, createSkippedResult, extractErrorCode };
export type { BaseHealth };

// =============================================================================
// Extended Opportunity Types (Finding 1.2 Fix)
// =============================================================================

/**
 * Finding 1.2 Fix: Extended ArbitrageOpportunity with N-hop swap path support.
 *
 * The base ArbitrageOpportunity type from @arbitrage/types doesn't include the
 * `hops` field used for multi-hop flash loan arbitrage. This extended type
 * provides proper typing for N-hop opportunities without type assertion hacks.
 *
 * Usage in FlashLoanStrategy:
 * ```typescript
 * function execute(opportunity: ArbitrageOpportunity | NHopArbitrageOpportunity, ctx: StrategyContext) {
 *   if (isNHopOpportunity(opportunity)) {
 *     // Type-safe access to opportunity.hops
 *     const steps = this.buildNHopSwapSteps(opportunity.hops);
 *   }
 * }
 * ```
 *
 * @see FlashLoanStrategy.buildNHopSwapSteps
 */
export interface SwapHop {
  /** Router address for this hop (optional - uses default DEX if not specified) */
  router?: string;
  /** DEX name for this hop (optional - for logging/metrics) */
  dex?: string;
  /** Output token address for this hop */
  tokenOut: string;
  /** Expected output amount in wei (optional - for validation) */
  expectedOutput?: string;
}

/**
 * ArbitrageOpportunity extended with N-hop path information.
 *
 * @see SwapHop for individual hop definition
 */
export interface NHopArbitrageOpportunity extends ArbitrageOpportunity {
  /**
   * Multi-hop swap path for complex arbitrage routes.
   *
   * Each hop defines: router -> tokenOut
   * The tokenIn for hop[n] is the tokenOut from hop[n-1] (or opportunity.tokenIn for hop[0]).
   *
   * Example 3-hop path: WETH -> USDC -> DAI -> WETH
   * ```
   * hops: [
   *   { tokenOut: USDC_ADDRESS, router: UNISWAP_ROUTER },
   *   { tokenOut: DAI_ADDRESS, router: SUSHISWAP_ROUTER },
   *   { tokenOut: WETH_ADDRESS, router: CURVE_ROUTER },
   * ]
   * ```
   */
  hops: SwapHop[];
}

/**
 * Type guard to check if opportunity has N-hop path.
 *
 * @param opportunity - The opportunity to check
 * @returns True if the opportunity has a valid hops array
 */
export function isNHopOpportunity(
  opportunity: ArbitrageOpportunity
): opportunity is NHopArbitrageOpportunity {
  return (
    'hops' in opportunity &&
    Array.isArray((opportunity as NHopArbitrageOpportunity).hops) &&
    (opportunity as NHopArbitrageOpportunity).hops.length > 0
  );
}

// Lazy-initialized logger for module-level utilities
let _typesLogger: ILogger | null = null;
function getTypesLogger(): ILogger {
  if (!_typesLogger) {
    _typesLogger = createPinoLogger('execution-engine-types');
  }
  return _typesLogger;
}

// =============================================================================
// Error Codes (Fix 9.3 & 6.1: Type-safe error codes)
// =============================================================================
// NOTE: ExecutionResult interface is now imported from @arbitrage/types and
// re-exported above for backward compatibility.

/**
 * Standardized error codes for execution strategies.
 * Fix 9.3: Type-safe enum to ensure consistent error reporting.
 * Fix 6.1: All error codes now follow the [ERR_*] pattern.
 *
 * Usage:
 * ```typescript
 * return createErrorResult(id, ExecutionErrorCode.NO_CHAIN, chain, dex);
 * // Or with details:
 * return createErrorResult(id, `${ExecutionErrorCode.GAS_SPIKE} on ${chain}`, chain, dex);
 * ```
 */
/**
 * Refactor 9.4: const enum for hot-path optimization.
 *
 * Using `const enum` instead of regular `enum` provides:
 * 1. Zero runtime overhead - values are inlined at compile time
 * 2. Smaller bundle size - no enum object generated
 * 3. Better minification - strings are inlined directly
 *
 * Trade-off: Cannot iterate over enum values at runtime (e.g., Object.values()).
 * This is acceptable because error codes are only used for comparison, not iteration.
 *
 * Performance impact: Eliminates property lookup on every error creation.
 */
export const enum ExecutionErrorCode {
  // Chain/Provider errors
  NO_CHAIN = '[ERR_NO_CHAIN] No chain specified for opportunity',
  NO_WALLET = '[ERR_NO_WALLET] No wallet available for chain',
  NO_PROVIDER = '[ERR_NO_PROVIDER] No provider available for chain',
  NO_BRIDGE = '[ERR_NO_BRIDGE] Bridge router not initialized',
  NO_ROUTE = '[ERR_NO_ROUTE] No bridge route available',

  // Configuration errors
  CONFIG_ERROR = '[ERR_CONFIG] Configuration error',
  ZERO_ADDRESS = '[ERR_ZERO_ADDRESS] Zero address is invalid',

  // Validation errors
  INVALID_OPPORTUNITY = '[ERR_INVALID_OPPORTUNITY] Invalid opportunity format',
  CROSS_CHAIN_MISMATCH = '[ERR_CROSS_CHAIN] Strategy mismatch for cross-chain opportunity',
  SAME_CHAIN = '[ERR_SAME_CHAIN] Cross-chain arbitrage requires different chains',
  PRICE_VERIFICATION = '[ERR_PRICE_VERIFICATION] Price verification failed',

  // Transaction errors
  NONCE_ERROR = '[ERR_NONCE] Failed to get nonce',
  GAS_SPIKE = '[ERR_GAS_SPIKE] Gas price spike detected',
  APPROVAL_FAILED = '[ERR_APPROVAL] Token approval failed',
  SIMULATION_REVERT = '[ERR_SIMULATION_REVERT] Simulation predicted revert',

  // Bridge errors
  BRIDGE_QUOTE = '[ERR_BRIDGE_QUOTE] Bridge quote failed',
  BRIDGE_EXEC = '[ERR_BRIDGE_EXEC] Bridge execution failed',
  BRIDGE_FAILED = '[ERR_BRIDGE_FAILED] Bridge failed',
  BRIDGE_TIMEOUT = '[ERR_BRIDGE_TIMEOUT] Bridge timeout',
  QUOTE_EXPIRED = '[ERR_QUOTE_EXPIRED] Quote expired before execution',

  // Execution errors
  EXECUTION_ERROR = '[ERR_EXECUTION] Execution error',
  SELL_FAILED = '[ERR_SELL_FAILED] Sell transaction failed',
  HIGH_FEES = '[ERR_HIGH_FEES] Fees exceed expected profit',
  SHUTDOWN = '[ERR_SHUTDOWN] Execution interrupted by shutdown',

  // Flash loan errors
  NO_STRATEGY = '[ERR_NO_STRATEGY] Required strategy not registered',
  FLASH_LOAN_ERROR = '[ERR_FLASH_LOAN] Flash loan error',
  UNSUPPORTED_PROTOCOL = '[ERR_UNSUPPORTED_PROTOCOL] Protocol not implemented',

  // Risk management errors (Phase 3: Task 3.4.5)
  LOW_EV = '[ERR_LOW_EV] Expected value below threshold',
  POSITION_SIZE = '[ERR_POSITION_SIZE] Position size below minimum',
  DRAWDOWN_HALT = '[ERR_DRAWDOWN_HALT] Trading halted due to drawdown',
  DRAWDOWN_BLOCKED = '[ERR_DRAWDOWN_BLOCKED] Trade blocked by risk controls',

  // P1-FIX 2.2: Additional error codes for better diagnostics
  // These were identified as missing in the deep-dive analysis
  INSUFFICIENT_BALANCE = '[ERR_INSUFFICIENT_BALANCE] Insufficient token balance for execution',
  SLIPPAGE_EXCEEDED = '[ERR_SLIPPAGE_EXCEEDED] Actual slippage exceeded tolerance',
  LIQUIDITY_ERROR = '[ERR_LIQUIDITY] Insufficient liquidity in pool',
  DEADLINE_EXCEEDED = '[ERR_DEADLINE] Transaction deadline exceeded',
  INVALID_PATH = '[ERR_INVALID_PATH] Invalid or unprofitable swap path',
  REVERT_UNKNOWN = '[ERR_REVERT_UNKNOWN] Transaction reverted with unknown reason',
}

// =============================================================================
// ExecutionResult Factory Helpers
// =============================================================================
// NOTE: createErrorResult, createSuccessResult, and createSkippedResult are now
// imported from @arbitrage/types and re-exported above for backward compatibility.

/**
 * Fix 6.1: Format error code with optional details.
 *
 * Provides consistent error message formatting across all strategies.
 *
 * @param code - ExecutionErrorCode enum value
 * @param details - Optional additional details to append
 * @returns Formatted error string
 *
 * @example
 * formatExecutionError(ExecutionErrorCode.NO_WALLET, 'ethereum');
 * // Returns: "[ERR_NO_WALLET] No wallet available for chain: ethereum"
 *
 * @example
 * formatExecutionError(ExecutionErrorCode.PRICE_VERIFICATION);
 * // Returns: "[ERR_PRICE_VERIFICATION] Price verification failed"
 */
export function formatExecutionError(
  code: ExecutionErrorCode,
  details?: string
): string {
  if (!details) {
    return code;
  }
  return `${code}: ${details}`;
}

// NOTE: extractErrorCode is now imported from @arbitrage/types and re-exported above.

// =============================================================================
// Flash Loan Parameters
// =============================================================================

export interface FlashLoanParams {
  token: string;
  amount: string;
  path: string[];
  minProfit: number;
  /**
   * CRITICAL-2 FIX: Minimum amount out after all swaps.
   * This is the slippage-protected output amount that MUST be received.
   * If the actual output is less, the transaction should revert.
   */
  minAmountOut: string;
}

// =============================================================================
// Queue Configuration
// =============================================================================

export interface QueueConfig {
  maxSize: number;        // Maximum queue size
  highWaterMark: number;  // Start rejecting at this level
  lowWaterMark: number;   // Resume accepting at this level
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxSize: 1000,
  highWaterMark: 800,
  lowWaterMark: 200
};

// =============================================================================
// Consumer Configuration (Fix 3.1: Configurable constants)
// =============================================================================

/**
 * Consumer configuration defaults.
 * These can be overridden via environment variables for production tuning.
 */
export interface ConsumerConfig {
  /** Number of messages to fetch per read (default: 10) */
  batchSize: number;
  /** Blocking read timeout in ms (default: 1000) */
  blockMs: number;
  /** Shutdown ACK timeout in ms (default: 5000) */
  shutdownAckTimeoutMs: number;
  /**
   * Maximum age for pending messages before cleanup.
   * Messages older than this are considered orphaned and ACKed to prevent Redis PEL growth.
   * Default: 10 minutes (600000ms) - well beyond normal execution timeout (55s).
   */
  pendingMessageMaxAgeMs: number;
  /**
   * Interval for stale pending message cleanup in health monitoring.
   * Set to 0 to disable automatic cleanup.
   * Default: 60000ms (1 minute)
   */
  stalePendingCleanupIntervalMs: number;
}

export const DEFAULT_CONSUMER_CONFIG: ConsumerConfig = {
  batchSize: parseEnvTimeout('CONSUMER_BATCH_SIZE', 10, 1, 100),
  blockMs: parseEnvTimeout('CONSUMER_BLOCK_MS', 1000, 100, 10000),
  shutdownAckTimeoutMs: parseEnvTimeout('CONSUMER_SHUTDOWN_ACK_TIMEOUT_MS', 5000, 1000, 30000),
  pendingMessageMaxAgeMs: parseEnvTimeout('CONSUMER_PENDING_MAX_AGE_MS', 10 * 60 * 1000, 60000, 3600000),
  stalePendingCleanupIntervalMs: parseEnvTimeout('CONSUMER_STALE_CLEANUP_INTERVAL_MS', 60000, 0, 300000),
};

// =============================================================================
// Stream Constants
// =============================================================================

/**
 * Dead Letter Queue stream name.
 * Messages that fail validation are moved here for analysis.
 * @see ARCHITECTURE_V2.md Section 5.3 (Message Channels)
 */
export const DLQ_STREAM = RedisStreams.DEAD_LETTER_QUEUE;

// =============================================================================
// Supported Chains (Fix BUG #3: Chain validation)
// =============================================================================

/**
 * Fix 3.1: Derive SUPPORTED_CHAINS from @arbitrage/config CHAINS.
 *
 * Previously, this was a hardcoded list that could drift from the config.
 * Now it's dynamically derived at module load time, ensuring consistency.
 *
 * The Set provides O(1) lookup for chain validation.
 *
 * @see shared/config/src/chains/index.ts (source of truth)
 */
export const SUPPORTED_CHAINS: Set<string> = new Set(Object.keys(CHAINS));

/**
 * Type representing supported chain identifiers.
 * Derived from CHAINS config keys for type safety.
 */
export type SupportedChain = keyof typeof CHAINS;

/**
 * Check if a chain identifier is supported.
 *
 * Fix 3.1: Now validates against dynamically derived SUPPORTED_CHAINS set.
 */
export function isSupportedChain(chain: string): chain is SupportedChain {
  return SUPPORTED_CHAINS.has(chain);
}

// =============================================================================
// Validation Error Codes (Fix 6.1: Consistent error handling)
// =============================================================================

/**
 * Validation error codes for opportunity consumer.
 * Provides structured error identification for debugging and metrics.
 */
export enum ValidationErrorCode {
  EMPTY_MESSAGE = '[VAL_EMPTY] Message has no data',
  NOT_OBJECT = '[VAL_NOT_OBJECT] Message data is not an object',
  MISSING_ID = '[VAL_MISSING_ID] Missing or invalid id',
  MISSING_TYPE = '[VAL_MISSING_TYPE] Missing or invalid type',
  INVALID_TYPE = '[VAL_INVALID_TYPE] Unknown opportunity type',
  STREAM_INIT = '[VAL_STREAM_INIT] Stream initialization message (skipped)',
  MISSING_TOKEN_IN = '[VAL_MISSING_TOKEN_IN] Missing or invalid tokenIn',
  MISSING_TOKEN_OUT = '[VAL_MISSING_TOKEN_OUT] Missing or invalid tokenOut',
  MISSING_AMOUNT = '[VAL_MISSING_AMOUNT] Missing amountIn',
  INVALID_AMOUNT = '[VAL_INVALID_AMOUNT] Invalid amountIn format',
  ZERO_AMOUNT = '[VAL_ZERO_AMOUNT] amountIn must be positive',
  MISSING_BUY_CHAIN = '[VAL_MISSING_BUY_CHAIN] Cross-chain: missing buyChain',
  MISSING_SELL_CHAIN = '[VAL_MISSING_SELL_CHAIN] Cross-chain: missing sellChain',
  SAME_CHAIN = '[VAL_SAME_CHAIN] Cross-chain: buyChain equals sellChain',
  UNSUPPORTED_BUY_CHAIN = '[VAL_UNSUPPORTED_BUY_CHAIN] Cross-chain: unsupported buyChain',
  UNSUPPORTED_SELL_CHAIN = '[VAL_UNSUPPORTED_SELL_CHAIN] Cross-chain: unsupported sellChain',
  EXPIRED = '[VAL_EXPIRED] Opportunity has expired',
  INVALID_EXPIRES_AT = '[VAL_INVALID_EXPIRES_AT] Invalid expiresAt format (must be number)',
  LOW_CONFIDENCE = '[VAL_LOW_CONFIDENCE] Confidence below threshold',
  LOW_PROFIT = '[VAL_LOW_PROFIT] Expected profit below threshold',
  DUPLICATE = '[VAL_DUPLICATE] Already executing',
}

// =============================================================================
// Execution Statistics
// =============================================================================

export interface ExecutionStats {
  /** Total opportunities received from stream (before validation) */
  opportunitiesReceived: number;
  /** Opportunities that started execution (attempts, not completions) */
  executionAttempts: number;
  /** Opportunities rejected during validation (bad format, low profit, etc.) */
  opportunitiesRejected: number;
  /** Executions that completed successfully */
  successfulExecutions: number;
  /** Executions that failed after being attempted */
  failedExecutions: number;
  /** Opportunities rejected due to queue full/paused */
  queueRejects: number;
  /** Executions skipped due to another instance holding the lock */
  lockConflicts: number;
  /** Stale locks force-released due to crashed lock holder detection */
  staleLockRecoveries: number;
  /** Executions that timed out */
  executionTimeouts: number;
  /** Validation errors for incoming messages (malformed, invalid type, etc.) */
  validationErrors: number;
  /** Provider reconnection attempts */
  providerReconnections: number;
  /** Provider health check failures */
  providerHealthCheckFailures: number;
  // Simulation metrics (Phase 1.1.3)
  /** Simulations performed before execution */
  simulationsPerformed: number;
  /** Simulations skipped (below threshold, time-critical, no provider) */
  simulationsSkipped: number;
  /** Executions aborted due to simulation predicting revert */
  simulationPredictedReverts: number;
  /** Executions aborted because simulation revealed unprofitable trade (gas too high) */
  simulationProfitabilityRejections: number;
  /** Simulation service errors (proceeded with execution) */
  simulationErrors: number;
  // Circuit breaker metrics (Phase 1.3)
  /** Number of times circuit breaker has tripped */
  circuitBreakerTrips: number;
  /** Executions blocked due to circuit breaker being open */
  circuitBreakerBlocks: number;
  // Capital risk management metrics (Phase 3: Task 3.4.5)
  /** Trades skipped due to negative expected value */
  riskEVRejections: number;
  /** Trades skipped due to position sizing (below minimum or negative Kelly) */
  riskPositionSizeRejections: number;
  /** Trades blocked by drawdown circuit breaker (HALT state) */
  riskDrawdownBlocks: number;
  /** Trades executed while in CAUTION state (reduced sizing) */
  riskCautionCount: number;
  /**
   * Cumulative HALT state transitions (from DrawdownCircuitBreaker).
   * Updated via health monitoring from drawdown stats.
   * Use getDrawdownStats()?.haltCount for real-time value.
   */
  riskHaltCount: number;
}

export function createInitialStats(): ExecutionStats {
  return {
    opportunitiesReceived: 0,
    executionAttempts: 0,
    opportunitiesRejected: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    queueRejects: 0,
    lockConflicts: 0,
    staleLockRecoveries: 0,
    executionTimeouts: 0,
    validationErrors: 0,
    providerReconnections: 0,
    providerHealthCheckFailures: 0,
    // Simulation metrics
    simulationsPerformed: 0,
    simulationsSkipped: 0,
    simulationPredictedReverts: 0,
    simulationProfitabilityRejections: 0,
    simulationErrors: 0,
    // Circuit breaker metrics (Phase 1.3)
    circuitBreakerTrips: 0,
    circuitBreakerBlocks: 0,
    // Capital risk management metrics (Phase 3: Task 3.4.5)
    riskEVRejections: 0,
    riskPositionSizeRejections: 0,
    riskDrawdownBlocks: 0,
    riskCautionCount: 0,
    riskHaltCount: 0,
  };
}

// =============================================================================
// Logger Interface (for DI)
// =============================================================================

export interface Logger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Create a service logger with the specified name.
 *
 * Fix: Standardized logger factory function for consistent logger creation
 * across all execution engine services. Uses Pino for proper structured
 * logging with LOG_LEVEL environment variable support.
 *
 * @param name - Service name (e.g., 'circuit-breaker', 'queue-service')
 * @returns Logger instance compatible with the Logger interface
 *
 * @example
 * const logger = createServiceLogger('my-service');
 * logger.info('Service started', { version: '1.0.0' });
 */
export function createServiceLogger(name: string): Logger {
  return createPinoLogger(name);
}

/**
 * Cache of lazily-created loggers by name.
 * Prevents creating multiple logger instances for the same service.
 */
const loggerCache = new Map<string, Logger>();

/**
 * Get or create a cached service logger.
 *
 * Use this when you need a logger in a static/module context where
 * creating a logger at construction time is not possible.
 *
 * @param name - Service name
 * @returns Cached logger instance
 *
 * @example
 * // In a module-level function:
 * function utilityFunction() {
 *   const logger = getServiceLogger('utility');
 *   logger.debug('Utility called');
 * }
 */
export function getServiceLogger(name: string): Logger {
  let logger = loggerCache.get(name);
  if (!logger) {
    logger = createServiceLogger(name);
    loggerCache.set(name, logger);
  }
  return logger;
}

// =============================================================================
// Provider Health
// =============================================================================
// NOTE: BaseHealth is now imported from @arbitrage/types and re-exported above.

/**
 * Provider health status.
 * Extends BaseHealth with provider-specific fields.
 */
export interface ProviderHealth extends BaseHealth {
  consecutiveFailures: number;
}

// =============================================================================
// Gas Baseline
// =============================================================================

/**
 * Gas baseline entry for tracking historical gas prices.
 * Used for spike detection and trend analysis.
 *
 * @see GasPriceOptimizer (gas-price-optimizer.ts) - spike detection
 * @see HealthMonitoringManager (health-monitoring-manager.ts) - baseline cleanup
 */
export interface GasBaselineEntry {
  price: bigint;
  timestamp: number;
}

// =============================================================================
// Simulation Configuration (DEV/TEST MODE - "Dry Run")
// =============================================================================

/**
 * Configuration for DEV simulation mode (SimulationStrategy).
 *
 * Doc 2.2: IMPORTANT NAMING CLARIFICATION
 * =======================================
 * This system has TWO different "simulation" concepts - do not confuse them:
 *
 * 1. **SimulationConfig** (THIS interface):
 *    - Purpose: "Dry run" mode for testing the execution engine
 *    - Location: types.ts (here) + SimulationStrategy
 *    - Usage: Development/testing without real blockchain transactions
 *    - Effect: No actual trades, no real money, mock results
 *    - Controlled by: `config.simulation.enabled = true`
 *
 * 2. **ISimulationService** (services/simulation/):
 *    - Purpose: Pre-flight transaction checks using Tenderly/Alchemy
 *    - Location: services/simulation/types.ts
 *    - Usage: Production - validate transactions BEFORE submitting
 *    - Effect: Real simulation, detects potential reverts
 *    - Controlled by: `MEV_CONFIG.simulateBeforeSubmit = true`
 *
 * Summary:
 * - SimulationConfig = Fake execution for testing
 * - ISimulationService = Real pre-flight checks for production safety
 *
 * @see SimulationStrategy (strategies/simulation.strategy.ts) - dry run strategy
 * @see services/simulation/ for actual pre-flight simulation service
 */
export interface SimulationConfig {
  /** Enable simulation mode - bypasses blockchain transactions (dev/test only) */
  enabled: boolean;
  /** Simulated success rate (0.0 - 1.0), default 0.85 - DEV MODE ONLY */
  successRate?: number;
  /** Simulated execution latency in ms, default 500 */
  executionLatencyMs?: number;
  /** Simulated gas used, default 200000 */
  gasUsed?: number;
  /** Simulated gas cost multiplier (0.0 - 1.0 of expected profit), default 0.1 */
  gasCostMultiplier?: number;
  /** Simulated profit variance (-0.5 to 0.5), randomly varies profit within this range */
  profitVariance?: number;
  /** Whether to log simulated executions, default true */
  logSimulatedExecutions?: boolean;
}

export type ResolvedSimulationConfig = Required<SimulationConfig>;

export function resolveSimulationConfig(config?: SimulationConfig): ResolvedSimulationConfig {
  return {
    enabled: config?.enabled ?? false,
    successRate: config?.successRate ?? 0.85,
    executionLatencyMs: config?.executionLatencyMs ?? 500,
    gasUsed: config?.gasUsed ?? 200000,
    gasCostMultiplier: config?.gasCostMultiplier ?? 0.1,
    profitVariance: config?.profitVariance ?? 0.2,
    logSimulatedExecutions: config?.logSimulatedExecutions ?? true
  };
}

// =============================================================================
// Circuit Breaker Configuration (Phase 1.3)
// =============================================================================

/**
 * Circuit breaker configuration for execution engine.
 *
 * The circuit breaker halts execution after consecutive failures to prevent
 * capital drain during systemic issues (network problems, liquidity events).
 *
 * @see implementation_plan_v2.md Task 1.3.1
 */
export interface CircuitBreakerConfig {
  /** Whether circuit breaker is enabled (default: true) */
  enabled?: boolean;
  /** Number of consecutive failures before tripping (default: 5) */
  failureThreshold?: number;
  /** Cooldown period in ms before attempting recovery (default: 5 minutes) */
  cooldownPeriodMs?: number;
  /** Max attempts in HALF_OPEN state before fully closing (default: 1) */
  halfOpenMaxAttempts?: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: Required<CircuitBreakerConfig> = {
  enabled: true,
  failureThreshold: 5,
  cooldownPeriodMs: 5 * 60 * 1000, // 5 minutes
  halfOpenMaxAttempts: 1,
};

// =============================================================================
// Engine Configuration
// =============================================================================

export interface ExecutionEngineConfig {
  queueConfig?: Partial<QueueConfig>;
  /** Optional logger for testing (defaults to createLogger) */
  logger?: Logger;
  /** Optional perf logger for testing */
  perfLogger?: PerformanceLogger;
  /** Optional state manager for testing */
  stateManager?: ServiceStateManager;
  /** Simulation mode configuration for local development/testing */
  simulationConfig?: SimulationConfig;
  /** Standby mode configuration (ADR-007) */
  standbyConfig?: StandbyConfig;
  /** Circuit breaker configuration (Phase 1.3) */
  circuitBreakerConfig?: CircuitBreakerConfig;
  /** Phase 2 pending state simulation configuration */
  pendingStateConfig?: PendingStateEngineConfig;
  /** Consumer configuration for opportunity stream processing */
  consumerConfig?: Partial<ConsumerConfig>;
  /** Task 3: A/B testing framework configuration */
  abTestingConfig?: Partial<ABTestingConfig>;
  /** O-6: Persistent trade logging configuration */
  tradeLoggerConfig?: Partial<TradeLoggerConfig>;
}

/**
 * Phase 2: Pending State Simulation Engine Configuration
 *
 * Enables local Anvil fork for simulating pending mempool transactions
 * to predict post-swap pool states before execution.
 *
 * @see implementation_plan_v3.md Phase 2
 * @see services/simulation/anvil-manager.ts
 * @see services/simulation/pending-state-simulator.ts
 * @see services/simulation/hot-fork-synchronizer.ts
 */
export interface PendingStateEngineConfig {
  /** Enable pending state simulation (default: false) */
  enabled: boolean;
  /** RPC URL to fork from (required if enabled) */
  rpcUrl?: string;
  /** Chain to simulate (e.g., 'ethereum', 'arbitrum') */
  chain?: string;
  /** Port for Anvil to listen on (default: 8546 to avoid conflict with 8545) */
  anvilPort?: number;
  /** Auto-start Anvil on engine start (default: true when enabled) */
  autoStartAnvil?: boolean;
  /** Enable hot fork synchronization (default: true when enabled) */
  enableHotSync?: boolean;
  /** Sync interval in ms for hot fork (default: 1000) */
  syncIntervalMs?: number;
  /** Enable adaptive sync interval (default: true) */
  adaptiveSync?: boolean;
  /** Minimum sync interval when adaptive sync is enabled (default: 200ms) */
  minSyncIntervalMs?: number;
  /** Maximum sync interval when adaptive sync is enabled (default: 5000ms) */
  maxSyncIntervalMs?: number;
  /** Maximum consecutive sync failures before pausing (default: 5) */
  maxConsecutiveFailures?: number;
  /** Timeout for pending state simulations in ms (default: 5000) */
  simulationTimeoutMs?: number;
}

/**
 * Standby configuration for executor failover (ADR-007)
 */
export interface StandbyConfig {
  /** Whether this instance starts as standby (default: false) */
  isStandby: boolean;
  /** Whether queue starts paused for standby mode (default: false) */
  queuePausedOnStart: boolean;
  /** Whether activation should disable simulation mode (default: true) */
  activationDisablesSimulation: boolean;
  /** Region identifier for this instance */
  regionId?: string;
}

// =============================================================================
// Timeouts (configurable via environment variables)
// =============================================================================

// =============================================================================
// Environment Variable Parsing with Validation (Fix 3.1)
// =============================================================================

/**
 * Parse and validate a numeric environment variable.
 * Fix 3.1: Adds bounds checking and NaN protection for production safety.
 *
 * @param envVar - Environment variable name
 * @param defaultValue - Default value if not set or invalid
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive)
 * @returns Validated numeric value
 */
function parseEnvTimeout(
  envVar: string,
  defaultValue: number,
  min: number = 100,
  max: number = 600000
): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);

  // Check for NaN (e.g., if someone sets EXECUTION_TIMEOUT_MS="abc")
  if (Number.isNaN(parsed)) {
    getTypesLogger().warn('Invalid timeout value (NaN)', {
      envVar,
      value: raw,
      default: defaultValue,
    });
    return defaultValue;
  }

  // Check bounds
  if (parsed < min) {
    getTypesLogger().warn('Timeout below minimum', {
      envVar,
      value: parsed,
      min,
      using: min,
    });
    return min;
  }

  if (parsed > max) {
    getTypesLogger().warn('Timeout above maximum', {
      envVar,
      value: parsed,
      max,
      using: max,
    });
    return max;
  }

  return parsed;
}

/**
 * Execution timeout - must be less than lock TTL (120s per-opportunity lock).
 * The distributed lock manager uses 60s default TTL, but withLock() in engine.ts
 * uses 120s for opportunity locks (2x execution timeout for safety margin).
 * Environment: EXECUTION_TIMEOUT_MS (default: 55000)
 * Valid range: 1000ms - 120000ms
 */
export const EXECUTION_TIMEOUT_MS = parseEnvTimeout(
  'EXECUTION_TIMEOUT_MS',
  55000,
  1000,
  120000
);

/**
 * Transaction timeout for blockchain operations.
 * Environment: TRANSACTION_TIMEOUT_MS (default: 50000)
 * Valid range: 1000ms - 120000ms
 */
export const TRANSACTION_TIMEOUT_MS = parseEnvTimeout(
  'TRANSACTION_TIMEOUT_MS',
  50000,
  1000,
  120000
);

/**
 * Shutdown timeout for graceful cleanup.
 * Environment: SHUTDOWN_TIMEOUT_MS (default: 5000)
 * Valid range: 1000ms - 30000ms
 */
export const SHUTDOWN_TIMEOUT_MS = parseEnvTimeout(
  'SHUTDOWN_TIMEOUT_MS',
  5000,
  1000,
  30000
);

/**
 * Provider connectivity check timeout (quick check).
 * Environment: PROVIDER_CONNECTIVITY_TIMEOUT_MS (default: 5000)
 * Valid range: 500ms - 30000ms
 */
export const PROVIDER_CONNECTIVITY_TIMEOUT_MS = parseEnvTimeout(
  'PROVIDER_CONNECTIVITY_TIMEOUT_MS',
  5000,
  500,
  30000
);

/**
 * Provider health check timeout (periodic check).
 * Environment: PROVIDER_HEALTH_CHECK_TIMEOUT_MS (default: 5000)
 * Valid range: 500ms - 30000ms
 */
export const PROVIDER_HEALTH_CHECK_TIMEOUT_MS = parseEnvTimeout(
  'PROVIDER_HEALTH_CHECK_TIMEOUT_MS',
  5000,
  500,
  30000
);

/**
 * Provider reconnection timeout (longer for new connection establishment).
 * Environment: PROVIDER_RECONNECTION_TIMEOUT_MS (default: 10000)
 * Valid range: 1000ms - 60000ms
 */
export const PROVIDER_RECONNECTION_TIMEOUT_MS = parseEnvTimeout(
  'PROVIDER_RECONNECTION_TIMEOUT_MS',
  10000,
  1000,
  60000
);

// =============================================================================
// Timeout Utility
// =============================================================================

// P0-FIX: TimeoutError now imported from @arbitrage/types (canonical source)
// Re-export for backward compatibility with code importing from this module
export { TimeoutError };

/**
 * Wrap a promise with a timeout.
 * Uses cancellable timeout pattern to prevent timer leaks.
 *
 * @param operation - Function that returns a promise to execute
 * @param operationName - Name of the operation for error messages
 * @param timeoutMs - Timeout in milliseconds (defaults to TRANSACTION_TIMEOUT_MS)
 * @returns The result of the operation or throws TimeoutError
 *
 * @example
 * const result = await withTimeout(
 *   () => wallet.sendTransaction(tx),
 *   'sendTransaction',
 *   30000
 * );
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  operationName: string,
  timeoutMs: number = TRANSACTION_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new TimeoutError(operationName, timeoutMs));
      }
    }, timeoutMs);

    operation()
      .then((result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolve(result);
        }
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          reject(error);
        }
      });
  });
}

// =============================================================================
// Strategy Context
// =============================================================================

/**
 * Context provided to execution strategies.
 * Contains all dependencies needed for transaction execution.
 */
export interface StrategyContext {
  logger: Logger;
  perfLogger: PerformanceLogger;
  providers: Map<string, ethers.JsonRpcProvider>;
  wallets: Map<string, ethers.Wallet>;
  providerHealth: Map<string, ProviderHealth>;
  nonceManager: NonceManager | null;
  mevProviderFactory: MevProviderFactory | null;
  bridgeRouterFactory: BridgeRouterFactory | null;
  stateManager: ServiceStateManager;
  gasBaselines: Map<string, { price: bigint; timestamp: number }[]>;
  /**
   * FIX 10.1: Pre-computed last gas prices for O(1) hot path access.
   * Updated atomically when gas baseline is updated.
   * Optional to allow gradual adoption - strategies guard against undefined.
   */
  lastGasPrices?: Map<string, bigint>;
  stats: ExecutionStats;
  /** Simulation service for pre-flight transaction validation (Phase 1.1) */
  simulationService?: ISimulationService;
  /**
   * Phase 2: Pending state simulator for mempool-aware execution.
   * Enables strategies to simulate pending transactions and predict
   * post-swap pool states before execution.
   */
  pendingStateSimulator?: import('./services/simulation/pending-state-simulator').PendingStateSimulator;
  /**
   * Phase 3: RPC batch providers for optimized request batching.
   * Reduces HTTP overhead by combining multiple RPC calls into single requests.
   * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
   */
  batchProviders?: Map<string, BatchProvider>;
  /**
   * P3 Optimization: Orderflow signal for execution priority adjustment.
   * Contains direction, confidence, whale impact, and volatility signals.
   * Used to adjust execution urgency based on market sentiment.
   * @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization P3
   */
  orderflowSignal?: OrderflowSignal;
}

/**
 * Interface for execution strategies.
 * Each strategy handles a specific type of arbitrage execution.
 */
export interface ExecutionStrategy {
  /** Execute the opportunity and return result */
  execute(opportunity: ArbitrageOpportunity, ctx: StrategyContext): Promise<ExecutionResult>;
}

// =============================================================================
// Queue Service Interface
// =============================================================================

export interface QueueService {
  /** Add opportunity to queue if possible */
  enqueue(opportunity: ArbitrageOpportunity): boolean;
  /** Get next opportunity from queue */
  dequeue(): ArbitrageOpportunity | undefined;
  /** Check if queue can accept more items */
  canEnqueue(): boolean;
  /** Get current queue size */
  size(): number;
  /** Check if queue is paused (backpressure or manual) */
  isPaused(): boolean;
  /** Clear the queue */
  clear(): void;
  /** Set pause state change callback */
  onPauseStateChange(callback: (isPaused: boolean) => void): void;
  /** Set callback for when item becomes available (enables event-driven processing) */
  onItemAvailable(callback: () => void): void;
  /** Manually pause the queue (for standby mode - ADR-007) */
  pause(): void;
  /** Resume a manually paused queue (for standby activation - ADR-007) */
  resume(): void;
  /** Check if queue is manually paused (standby mode) */
  isManuallyPaused(): boolean;
}

// =============================================================================
// Provider Service Interface
// =============================================================================

export interface ProviderService {
  /** Initialize all providers */
  initialize(): Promise<void>;
  /** Validate provider connectivity */
  validateConnectivity(): Promise<void>;
  /** Start health monitoring */
  startHealthChecks(): void;
  /** Stop health monitoring */
  stopHealthChecks(): void;
  /** Get provider for chain */
  getProvider(chain: string): ethers.JsonRpcProvider | undefined;
  /** Get all providers */
  getProviders(): Map<string, ethers.JsonRpcProvider>;
  /** Get provider health map */
  getHealthMap(): Map<string, ProviderHealth>;
  /** Get count of healthy providers */
  getHealthyCount(): number;
  /** Register wallet for chain */
  registerWallet(chain: string, wallet: ethers.Wallet): void;
  /** Get wallet for chain */
  getWallet(chain: string): ethers.Wallet | undefined;
  /** Get all wallets */
  getWallets(): Map<string, ethers.Wallet>;
  /** Clear all state and shutdown (Phase 3: async for batch provider cleanup) */
  clear(): Promise<void>;
  /** Phase 3: Get batch provider for chain */
  getBatchProvider(chain: string): BatchProvider | undefined;
  /** Phase 3: Get all batch providers */
  getBatchProviders(): Map<string, BatchProvider>;
  /** Phase 3: Check if batching is enabled */
  isBatchingEnabled(): boolean;
}

// =============================================================================
// Bridge Types (Refactor 9.3)
// =============================================================================

/**
 * Refactor 9.3: Result type for bridge polling.
 *
 * Provides a typed result for the polling operation that clearly indicates
 * success/failure and associated data. Moved from cross-chain.strategy.ts
 * for reusability.
 */
export interface BridgePollingResult {
  /** Whether the bridge transfer completed */
  completed: boolean;
  /** Amount received on destination chain (in wei string) */
  amountReceived?: string;
  /** Destination chain transaction hash */
  destTxHash?: string;
  /** Error information if polling failed */
  error?: {
    code: ExecutionErrorCode;
    message: string;
    sourceTxHash: string;
  };
}

/**
 * FIX 3.1: Bridge Recovery State
 *
 * Persisted to Redis before bridge execution to enable recovery if shutdown
 * occurs during bridge polling. This is a funds-at-risk scenario where:
 * - Source chain: Transaction confirmed (funds sent to bridge)
 * - Bridge: Tokens in transit (processing)
 * - Destination: No action taken yet
 *
 * On engine restart, pending bridge states are loaded and polling resumes.
 *
 * @see CrossChainStrategy.persistBridgeRecoveryState
 * @see CrossChainStrategy.recoverPendingBridges
 */
export interface BridgeRecoveryState {
  /** Unique opportunity identifier */
  opportunityId: string;
  /** Bridge transaction ID (from bridge router) */
  bridgeId: string;
  /** Source chain transaction hash */
  sourceTxHash: string;
  /** Source chain identifier */
  sourceChain: string;
  /** Destination chain identifier */
  destChain: string;
  /** Token being bridged (e.g., 'USDC') */
  bridgeToken: string;
  /** Amount bridged (in wei string) */
  bridgeAmount: string;
  /** DEX to use for sell on destination */
  sellDex: string;
  /** Expected profit at time of bridge initiation */
  expectedProfit: number;
  /** Original tokenIn (for sell reversal) */
  tokenIn: string;
  /** Original tokenOut (= bridgeToken for sell) */
  tokenOut: string;
  /** Timestamp when bridge was initiated */
  initiatedAt: number;
  /** Bridge protocol (e.g., 'stargate', 'layerzero') */
  bridgeProtocol: string;
  /** Current status: 'pending' | 'bridging' | 'recovered' | 'failed' */
  status: 'pending' | 'bridging' | 'recovered' | 'failed';
  /** Last status check timestamp */
  lastCheckAt?: number;
  /** Error message if status is 'failed' */
  errorMessage?: string;
}

/** Redis key prefix for bridge recovery state */
export const BRIDGE_RECOVERY_KEY_PREFIX = 'bridge:recovery:';

/** Maximum time to wait for a bridge before considering it failed (24 hours) */
export const BRIDGE_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// P3 Optimization: Orderflow-Adjusted Execution Priority
// =============================================================================

/**
 * P3 Optimization: Calculate execution priority with orderflow signal adjustment.
 *
 * Adjusts the base expected profit priority using orderflow signals:
 * - Direction alignment: +20% boost if orderflow confirms trade direction
 * - Whale impact: -20% if high whale activity detected (front-run risk)
 * - Confidence scaling: Adjustments scaled by orderflow confidence
 *
 * @param baseProfit - Base expected profit (used as base priority)
 * @param orderflowSignal - Optional orderflow signal for adjustment
 * @param tradeDirection - Trade direction ('buy' or 'sell')
 * @returns Adjusted priority value
 *
 * @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization P3
 */
export function calculateOrderflowAdjustedPriority(
  baseProfit: number,
  orderflowSignal: OrderflowSignal | undefined,
  tradeDirection: 'buy' | 'sell'
): number {
  // Start with base profit as priority
  let priority = baseProfit;

  // If no orderflow signal, return base priority
  if (!orderflowSignal) {
    return priority;
  }

  // Check direction alignment
  const isAligned = (
    (tradeDirection === 'buy' && orderflowSignal.direction === 'bullish') ||
    (tradeDirection === 'sell' && orderflowSignal.direction === 'bearish')
  );

  // Apply orderflow adjustments scaled by confidence
  if (isAligned) {
    // Boost priority if orderflow aligns with trade direction
    // Max +20% boost at 100% confidence
    priority *= (1 + orderflowSignal.confidence * 0.2);
  } else if (orderflowSignal.direction !== 'neutral') {
    // Slight penalty if orderflow opposes trade direction
    // Max -10% penalty at 100% confidence
    priority *= (1 - orderflowSignal.confidence * 0.1);
  }

  // Reduce priority if whale activity detected (front-run risk)
  // High whale impact (>0.7) triggers -20% reduction
  if (orderflowSignal.whaleImpact > 0.7) {
    priority *= 0.8;
  } else if (orderflowSignal.whaleImpact > 0.5) {
    // Moderate whale impact triggers -10% reduction
    priority *= 0.9;
  }

  // High volatility increases uncertainty - slight reduction
  if (orderflowSignal.expectedVolatility > 0.5) {
    priority *= (1 - orderflowSignal.expectedVolatility * 0.1);
  }

  return Math.max(0, priority);
}
