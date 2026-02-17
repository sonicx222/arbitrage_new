/**
 * Execution-related types
 *
 * Consolidated from services/execution-engine/src/types.ts
 * These types are used across multiple services.
 */

/**
 * Result of an execution attempt.
 * Used by execution-engine, coordinator, and monitoring.
 */
export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  transactionHash?: string;
  /**
   * Actual profit realized from the execution, in native token units.
   * Number type is intentional: post-execution profit is a monitoring metric
   * derived from on-chain events, always within safe integer range.
   */
  actualProfit?: number;
  /**
   * Gas units consumed by the transaction (not wei).
   * Number type is intentional: EVM gas limits are capped at 30M (block gas limit),
   * well within Number.MAX_SAFE_INTEGER. This is a post-execution metric from
   * transaction receipts, not a pre-execution estimate.
   * Contrast with ArbitrageOpportunity.gasEstimate (string) which is a pre-execution
   * wei estimate for BigInt calculations.
   */
  gasUsed?: number;
  /**
   * Estimated cost of gas in native token units (e.g., ETH).
   * Number type is intentional: this is a derived monitoring value
   * (gasUsed * gasPrice), used for profit/loss reporting.
   */
  gasCost?: number;
  error?: string;
  timestamp: number;
  chain: string;
  dex: string;
  /** Execution latency in milliseconds */
  latencyMs?: number;
  /** Whether MEV protection was used */
  usedMevProtection?: boolean;
}

/**
 * Standardized error codes for execution.
 * Provides consistent error reporting across services.
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

  // Risk management errors
  LOW_EV = '[ERR_LOW_EV] Expected value below threshold',
  POSITION_SIZE = '[ERR_POSITION_SIZE] Position size below minimum',
  DRAWDOWN_HALT = '[ERR_DRAWDOWN_HALT] Trading halted due to drawdown',
  DRAWDOWN_BLOCKED = '[ERR_DRAWDOWN_BLOCKED] Trade blocked by risk controls',
}

/**
 * Create a failed ExecutionResult.
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
 * Create a successful ExecutionResult.
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
    latencyMs?: number;
    usedMevProtection?: boolean;
  }
): ExecutionResult {
  return {
    opportunityId,
    success: true,
    transactionHash,
    actualProfit: options?.actualProfit,
    gasUsed: options?.gasUsed,
    gasCost: options?.gasCost,
    latencyMs: options?.latencyMs,
    usedMevProtection: options?.usedMevProtection,
    timestamp: Date.now(),
    chain,
    dex,
  };
}

/**
 * Create a skipped ExecutionResult (not executed due to risk controls).
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
 * Format error code with optional details.
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
 * Extract the error code identifier from a formatted error message.
 * @returns The error code identifier (e.g., "ERR_NO_WALLET") or null if not found
 */
export function extractErrorCode(errorMessage: string): string | null {
  const match = errorMessage.match(/\[ERR_([A-Z_]+)\]/);
  return match ? `ERR_${match[1]}` : null;
}
