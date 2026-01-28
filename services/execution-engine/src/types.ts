/**
 * Execution Engine Types
 *
 * Shared types and interfaces for the execution engine modules.
 *
 * @see engine.ts (main service)
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
} from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { ISimulationService } from './services/simulation/types';

// Lazy-initialized logger for module-level utilities
let _typesLogger: ILogger | null = null;
function getTypesLogger(): ILogger {
  if (!_typesLogger) {
    _typesLogger = createPinoLogger('execution-engine-types');
  }
  return _typesLogger;
}

// =============================================================================
// Execution Result
// =============================================================================

export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  transactionHash?: string;
  actualProfit?: number;
  gasUsed?: number;
  gasCost?: number;
  error?: string;
  timestamp: number;
  chain: string;
  dex: string;
}

// =============================================================================
// Error Codes (Fix 9.3 & 6.1: Type-safe error codes)
// =============================================================================

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
export enum ExecutionErrorCode {
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
}

// =============================================================================
// ExecutionResult Factory Helpers
// =============================================================================

/**
 * Create a failed ExecutionResult.
 * Consolidates error result creation pattern used across strategies.
 *
 * @param error - Error message. Prefer using ExecutionErrorCode enum for consistency.
 */
export function createErrorResult(
  opportunityId: string,
  error: string,
  chain: string,
  dex: string,
  transactionHash?: string
): ExecutionResult {
  return {
    opportunityId,
    success: false,
    error,
    timestamp: Date.now(),
    chain,
    dex,
    transactionHash,
  };
}

/**
 * Create a skipped ExecutionResult (not executed due to risk controls).
 * Used when opportunity is rejected before execution attempt.
 */
export function createSkippedResult(
  opportunityId: string,
  reason: string,
  chain: string,
  dex: string
): ExecutionResult {
  return {
    opportunityId,
    success: false,
    error: reason,
    timestamp: Date.now(),
    chain,
    dex,
  };
}

/**
 * Create a successful ExecutionResult.
 * Consolidates success result creation pattern used across strategies.
 */
export function createSuccessResult(
  opportunityId: string,
  transactionHash: string,
  chain: string,
  dex: string,
  options?: {
    actualProfit?: number;
    gasUsed?: number;
    gasCost?: number;
  }
): ExecutionResult {
  return {
    opportunityId,
    success: true,
    transactionHash,
    timestamp: Date.now(),
    chain,
    dex,
    actualProfit: options?.actualProfit,
    gasUsed: options?.gasUsed,
    gasCost: options?.gasCost,
  };
}

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

/**
 * Fix 6.1: Extract the error code identifier from a formatted error message.
 *
 * Useful for categorizing errors in logs and metrics.
 *
 * @param errorMessage - Full error message
 * @returns The error code identifier (e.g., "ERR_NO_WALLET") or null if not found
 */
export function extractErrorCode(errorMessage: string): string | null {
  const match = errorMessage.match(/\[ERR_([A-Z_]+)\]/);
  return match ? `ERR_${match[1]}` : null;
}

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
  /** Executions that timed out */
  executionTimeouts: number;
  /** Errors during message processing (parse errors, etc.) */
  messageProcessingErrors: number;
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
    executionTimeouts: 0,
    messageProcessingErrors: 0,
    providerReconnections: 0,
    providerHealthCheckFailures: 0,
    // Simulation metrics
    simulationsPerformed: 0,
    simulationsSkipped: 0,
    simulationPredictedReverts: 0,
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

// =============================================================================
// Base Health Interface (Fix 9.2)
// =============================================================================

/**
 * Fix 9.2: Base health interface for consistency across all health types.
 *
 * All health-related interfaces should extend this base interface to ensure
 * they have a consistent core set of fields. This makes it easier to aggregate
 * health status across the system.
 *
 * @example
 * interface ServiceHealth extends BaseHealth {
 *   activeConnections: number;
 *   queueSize: number;
 * }
 */
export interface BaseHealth {
  /** Whether the component is healthy */
  healthy: boolean;
  /** Last health check timestamp */
  lastCheck: number;
  /** Last error message if any */
  lastError?: string;
}

// =============================================================================
// Provider Health
// =============================================================================

/**
 * Provider health status.
 * Extends BaseHealth with provider-specific fields.
 */
export interface ProviderHealth extends BaseHealth {
  consecutiveFailures: number;
}

// =============================================================================
// Simulation Configuration (DEV/TEST MODE)
// =============================================================================

/**
 * Configuration for DEV simulation mode (SimulationStrategy).
 *
 * Fix 2.2: This is NOT the transaction simulation service (Tenderly/Alchemy).
 * This controls the "dry run" mode where the engine simulates execution
 * without actually submitting blockchain transactions. Used for testing
 * and development purposes.
 *
 * @see SimulationStrategy (strategies/simulation.strategy.ts)
 * @see services/simulation/ for actual transaction simulation (pre-flight checks)
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

/**
 * Error thrown when an operation times out.
 */
export class TimeoutError extends Error {
  constructor(operationName: string, timeoutMs: number) {
    super(`Operation "${operationName}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

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
}
