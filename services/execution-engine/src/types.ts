/**
 * Execution Engine Types
 *
 * Shared types and interfaces for the execution engine modules.
 *
 * @see engine.ts (main service)
 */

import { ethers } from 'ethers';
import type {
  ServiceStateManager,
  PerformanceLogger,
  RedisStreamsClient,
  DistributedLockManager,
  NonceManager,
  MevProviderFactory,
  BridgeRouterFactory,
} from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';

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
    providerHealthCheckFailures: 0
  };
}

// =============================================================================
// Logger Interface (for DI)
// =============================================================================

export interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

// =============================================================================
// Provider Health
// =============================================================================

export interface ProviderHealth {
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
  lastError?: string;
}

// =============================================================================
// Simulation Configuration
// =============================================================================

export interface SimulationConfig {
  /** Enable simulation mode - bypasses blockchain transactions */
  enabled: boolean;
  /** Simulated success rate (0.0 - 1.0), default 0.85 */
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
// Timeouts
// =============================================================================

/** Execution timeout - must be less than lock TTL (60s) */
export const EXECUTION_TIMEOUT_MS = 55000;

/** Transaction timeout for blockchain operations */
export const TRANSACTION_TIMEOUT_MS = 50000;

/** Shutdown timeout for graceful cleanup */
export const SHUTDOWN_TIMEOUT_MS = 5000;

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
  stats: ExecutionStats;
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
