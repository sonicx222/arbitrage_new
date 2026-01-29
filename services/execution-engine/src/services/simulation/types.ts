/**
 * Transaction Simulation Types and Interfaces
 *
 * Provides abstractions for transaction simulation across different providers:
 * - Tenderly for comprehensive simulation (500 free/month)
 * - Alchemy for alternative simulation
 *
 * @see Phase 1.1: Transaction Simulation Integration in implementation plan
 */

import { ethers } from 'ethers';

// =============================================================================
// Types
// =============================================================================

/**
 * Simulation provider identifier
 */
export type SimulationProviderType = 'tenderly' | 'alchemy' | 'local';

/**
 * Result of a transaction simulation
 */
export interface SimulationResult {
  /** Whether simulation was successful (transaction would succeed) */
  success: boolean;
  /** Whether the transaction would revert */
  wouldRevert: boolean;
  /** Revert reason if transaction would revert */
  revertReason?: string;
  /** Estimated gas used */
  gasUsed?: bigint;
  /** Estimated gas price at simulation time */
  gasPrice?: bigint;
  /** Simulated output value (if applicable) */
  returnValue?: string;
  /** State changes that would occur */
  stateChanges?: StateChange[];
  /** Event logs that would be emitted */
  logs?: SimulationLog[];
  /** Error message if simulation failed (different from revert) */
  error?: string;
  /** Provider that performed the simulation */
  provider: SimulationProviderType;
  /** Time taken for simulation in ms */
  latencyMs: number;
  /** Block number used for simulation */
  blockNumber?: number;
}

/**
 * State change from simulation
 */
export interface StateChange {
  /** Contract address */
  address: string;
  /** Storage slot */
  slot?: string;
  /** Previous value */
  before: string;
  /** New value */
  after: string;
  /** Token symbol if ERC20 transfer */
  tokenSymbol?: string;
  /** Decoded change type */
  type?: 'balance' | 'allowance' | 'storage';
}

/**
 * Event log from simulation
 */
export interface SimulationLog {
  /** Contract address */
  address: string;
  /** Event topics */
  topics: string[];
  /** Event data */
  data: string;
  /** Decoded event name if available */
  eventName?: string;
  /** Decoded event args if available */
  decodedArgs?: Record<string, unknown>;
}

/**
 * Configuration for simulation request
 */
export interface SimulationRequest {
  /** Chain identifier (e.g., 'ethereum', 'arbitrum') */
  chain: string;
  /** Transaction to simulate */
  transaction: ethers.TransactionRequest;
  /** Optional: Block number to simulate at (default: latest) */
  blockNumber?: number;
  /** Optional: Override state for simulation */
  stateOverrides?: Record<string, StateOverride>;
  /** Optional: Whether to include state changes in result */
  includeStateChanges?: boolean;
  /** Optional: Whether to include logs in result */
  includeLogs?: boolean;
}

/**
 * State override for simulation
 */
export interface StateOverride {
  /** Balance override in wei */
  balance?: bigint;
  /** Nonce override */
  nonce?: number;
  /** Code override (bytecode) */
  code?: string;
  /** Storage override (slot -> value) */
  storage?: Record<string, string>;
}

/**
 * Configuration for simulation provider
 */
export interface SimulationProviderConfig {
  /** Provider type identifier */
  type: SimulationProviderType;
  /** Chain identifier */
  chain: string;
  /** JSON RPC provider for fallback/local simulation */
  provider: ethers.JsonRpcProvider;
  /** Whether this provider is enabled */
  enabled: boolean;
  /** API key for the simulation provider */
  apiKey?: string;
  /** API secret (for Tenderly) */
  apiSecret?: string;
  /** Account/project slug (for Tenderly) */
  accountSlug?: string;
  /** Project slug (for Tenderly) */
  projectSlug?: string;
  /** Custom API endpoint URL */
  apiUrl?: string;
  /** Timeout for simulation requests in ms */
  timeoutMs?: number;
}

/**
 * Health status for a simulation provider
 */
export interface SimulationProviderHealth {
  /** Whether provider is currently healthy */
  healthy: boolean;
  /** Last health check timestamp */
  lastCheck: number;
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** Last error message */
  lastError?: string;
  /** Average latency in ms (rolling average) */
  averageLatencyMs: number;
  /** Success rate (0-1) over recent requests */
  successRate: number;
  /** Number of requests used (for rate limiting) */
  requestsUsed?: number;
  /** Rate limit cap */
  requestLimit?: number;
}

/**
 * Simulation provider metrics
 */
export interface SimulationMetrics {
  /** Total simulations attempted */
  totalSimulations: number;
  /** Successful simulations */
  successfulSimulations: number;
  /** Failed simulations (provider errors) */
  failedSimulations: number;
  /** Simulations that predicted revert */
  predictedReverts: number;
  /** Average latency in ms */
  averageLatencyMs: number;
  /** Fallback usage count */
  fallbackUsed: number;
  /** Cache hits (if caching enabled) */
  cacheHits: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Interface for simulation providers
 *
 * Implementations handle provider-specific simulation APIs:
 * - TenderlyProvider: Tenderly Simulation API
 * - AlchemySimulationProvider: Alchemy Transact API
 * - LocalProvider: eth_call based simulation (limited)
 */
export interface ISimulationProvider {
  /**
   * Get the provider type
   */
  readonly type: SimulationProviderType;

  /**
   * Get the chain this provider is configured for
   */
  readonly chain: string;

  /**
   * Check if the provider is available and enabled
   */
  isEnabled(): boolean;

  /**
   * Simulate a transaction
   *
   * @param request - Simulation request with transaction details
   * @returns Simulation result with success/failure and details
   */
  simulate(request: SimulationRequest): Promise<SimulationResult>;

  /**
   * Get current health status
   */
  getHealth(): SimulationProviderHealth;

  /**
   * Get current metrics
   */
  getMetrics(): SimulationMetrics;

  /**
   * Reset metrics
   */
  resetMetrics(): void;

  /**
   * Check connection/health of the provider
   */
  healthCheck(): Promise<{ healthy: boolean; message: string }>;
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * Configuration for simulation service.
 *
 * Fix 10.4: Added healthCheckIntervalMs for configurable health check frequency.
 */
export interface SimulationServiceConfig {
  /** Minimum profit threshold for simulation (skip small trades) */
  minProfitForSimulation?: number;
  /** Whether to bypass simulation for time-critical opportunities */
  bypassForTimeCritical?: boolean;
  /** Time threshold in ms to consider opportunity time-critical */
  timeCriticalThresholdMs?: number;
  /** Provider priority order */
  providerPriority?: SimulationProviderType[];
  /** Whether to use fallback on primary failure */
  useFallback?: boolean;
  /** Cache TTL in ms for identical simulations */
  cacheTtlMs?: number;
  /**
   * Fix 10.4: Health check interval in ms for provider health monitoring.
   * Lower values detect degradation faster but increase overhead.
   * For hot-path arbitrage, 15-30 seconds is recommended.
   * Default: 60000 (60 seconds)
   */
  healthCheckIntervalMs?: number;
}

/**
 * Interface for simulation service
 *
 * Manages multiple simulation providers with:
 * - Health scoring and automatic failover
 * - Provider priority and selection
 * - Metrics aggregation
 */
export interface ISimulationService {
  /**
   * Initialize the service with providers
   */
  initialize(): Promise<void>;

  /**
   * Simulate a transaction using the best available provider
   *
   * @param request - Simulation request
   * @returns Simulation result
   */
  simulate(request: SimulationRequest): Promise<SimulationResult>;

  /**
   * Check if simulation should be performed for an opportunity
   *
   * @param expectedProfit - Expected profit in ETH
   * @param opportunityAge - Age of opportunity in ms
   * @returns Whether to simulate
   */
  shouldSimulate(expectedProfit: number, opportunityAge: number): boolean;

  /**
   * Get aggregated metrics across all providers
   */
  getAggregatedMetrics(): SimulationMetrics;

  /**
   * Get health status of all providers
   */
  getProvidersHealth(): Map<SimulationProviderType, SimulationProviderHealth>;

  /**
   * Stop the service and cleanup
   */
  stop(): void;
}

// =============================================================================
// Chain Configuration
// =============================================================================

/**
 * Chain ID mapping for simulation providers
 *
 * Note: Goerli testnet has been deprecated as of January 2024.
 * Use Sepolia for Ethereum testnet simulation.
 */
export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  /** @deprecated Goerli testnet is deprecated. Use sepolia instead. */
  goerli: 5,
  sepolia: 11155111,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  base: 8453,
  bsc: 56,
  avalanche: 43114,
  zksync: 324,
  linea: 59144,
  fantom: 250,
};

/**
 * Fix 6.3: WETH (Wrapped Native Token) address mapping per chain.
 * Used for detecting ETH-out swaps across different chains.
 */
export const WETH_ADDRESSES: Record<number, string> = {
  // Ethereum Mainnet
  1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  // Goerli (deprecated)
  5: '0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6',
  // Sepolia
  11155111: '0x7b79995e5f793a07bc00c21412e50ecae098e7f9',
  // Arbitrum One
  42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  // Optimism
  10: '0x4200000000000000000000000000000000000006',
  // Polygon (WMATIC)
  137: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  // Base
  8453: '0x4200000000000000000000000000000000000006',
  // BNB Chain (WBNB)
  56: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  // Avalanche (WAVAX)
  43114: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
  // zkSync Era
  324: '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91',
  // Linea
  59144: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
  // Fantom (WFTM)
  250: '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83',
};

/**
 * Get WETH address for a chain ID.
 * Returns lowercase address or undefined if chain not supported.
 */
export function getWethAddress(chainId: number): string | undefined {
  return WETH_ADDRESSES[chainId]?.toLowerCase();
}

/**
 * Check if an address is the WETH address for a given chain.
 */
export function isWethAddress(address: string, chainId: number): boolean {
  const wethAddress = getWethAddress(chainId);
  return wethAddress !== undefined && address.toLowerCase() === wethAddress;
}

/**
 * Fix 6.1: Standardized error message extraction.
 * Replaces inconsistent `error instanceof Error ? error.message : String(error)` patterns.
 */
export function getSimulationErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Default configuration values
 */
export const SIMULATION_DEFAULTS = {
  timeoutMs: 5000,
  minProfitForSimulation: 50, // $50 minimum
  timeCriticalThresholdMs: 2000,
  cacheTtlMs: 5000,
  maxConsecutiveFailures: 3,
  healthCheckIntervalMs: 60000,
  providerPriority: ['tenderly', 'alchemy', 'local'] as SimulationProviderType[],
};

/**
 * Tenderly API configuration.
 *
 * Fix 2.2: Updated freeMonthlyLimit to 25000 (correct value from Tenderly docs).
 * The previous value of 500 was outdated.
 *
 * @see https://docs.tenderly.co/account/pricing
 */
export const TENDERLY_CONFIG = {
  apiUrl: 'https://api.tenderly.co/api/v1',
  simulateEndpoint: '/account/{accountSlug}/project/{projectSlug}/simulate',
  freeMonthlyLimit: 25000, // Fix 2.2: Correct value (was 500)
};

/**
 * Alchemy simulation configuration
 */
export const ALCHEMY_CONFIG = {
  simulateEndpoint: '/v2/{apiKey}/eth_call',
};

// =============================================================================
// Re-export CircularBuffer from @arbitrage/core
// =============================================================================

/**
 * CircularBuffer is now consolidated in @arbitrage/core.
 * Re-exported here for backwards compatibility with existing imports.
 *
 * Note: Use `pushOverwrite()` for rolling window behavior (overwrites oldest)
 * and `push()` for FIFO queue behavior (returns false when full).
 *
 * @see @arbitrage/core CircularBuffer
 */
export { CircularBuffer, createRollingWindow } from '@arbitrage/core';

// =============================================================================
// Shared Utilities (Fix 9.1-9.2)
// =============================================================================

/**
 * Fix 9.1: Create a cancellable timeout promise.
 * Use this instead of duplicating timeout logic across classes.
 *
 * @example
 * const { promise, cancel } = createCancellableTimeout<MyResult>(5000, 'Operation timeout');
 * try {
 *   const result = await Promise.race([myOperation(), promise]);
 *   return result;
 * } finally {
 *   cancel(); // Always cancel to prevent timer leak
 * }
 */
export function createCancellableTimeout<T = never>(
  ms: number,
  message: string
): { promise: Promise<T>; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  const cancel = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  return { promise, cancel };
}

/**
 * Fix 9.2: Update rolling average for metrics.
 * Consolidates the duplicated averaging logic found in multiple classes.
 *
 * @param currentAverage - Current average value
 * @param newValue - New value to incorporate
 * @param totalCount - Total number of samples (including new value)
 * @returns Updated average
 */
export function updateRollingAverage(
  currentAverage: number,
  newValue: number,
  totalCount: number
): number {
  if (totalCount <= 0) return newValue;
  if (totalCount === 1) return newValue;
  return (currentAverage * (totalCount - 1) + newValue) / totalCount;
}

/**
 * Fix 9.2: Shared panic message decoding for Solidity Panic(uint256) errors.
 * Previously duplicated in AlchemySimulationProvider and LocalSimulationProvider.
 *
 * @see https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require
 */
export const PANIC_MESSAGES: Record<number, string> = {
  0x00: 'Generic compiler panic',
  0x01: 'Assertion failed',
  0x11: 'Arithmetic overflow/underflow',
  0x12: 'Division by zero',
  0x21: 'Invalid enum value',
  0x22: 'Invalid storage access',
  0x31: 'Empty array pop',
  0x32: 'Array out of bounds',
  0x41: 'Memory allocation overflow',
  0x51: 'Zero initialized variable',
};

/**
 * Get human-readable panic message for Solidity Panic(uint256) codes.
 *
 * @param code - Panic code (uint256)
 * @returns Human-readable message
 */
export function getPanicMessage(code: number): string {
  return PANIC_MESSAGES[code] || `Unknown panic (code: 0x${code.toString(16)})`;
}

/**
 * Decode revert data to extract error message.
 * Handles Error(string) and Panic(uint256) selectors.
 *
 * @param data - Hex-encoded revert data
 * @returns Decoded error message or undefined if unknown format
 */
export function decodeRevertData(data: string): string | undefined {
  // Lazy import to avoid circular deps at module load time
  const { ethers } = require('ethers');

  try {
    // Error(string) selector: 0x08c379a0
    if (data.startsWith('0x08c379a0') && data.length > 10) {
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const decoded = abiCoder.decode(['string'], '0x' + data.slice(10));
      return `Error: ${decoded[0]}`;
    }

    // Panic(uint256) selector: 0x4e487b71
    if (data.startsWith('0x4e487b71') && data.length > 10) {
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const decoded = abiCoder.decode(['uint256'], '0x' + data.slice(10));
      const panicCode = Number(decoded[0]);
      return `Panic(${panicCode}): ${getPanicMessage(panicCode)}`;
    }

    // Custom error (unknown selector)
    if (data.startsWith('0x') && data.length > 10) {
      return `Custom error: ${data.slice(0, 10)}...`;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fix 7.1: Check if a chain is deprecated and log a warning.
 * Returns true if the chain is deprecated.
 */
export function isDeprecatedChain(chain: string): boolean {
  const deprecatedChains = ['goerli'];
  return deprecatedChains.includes(chain.toLowerCase());
}

/**
 * Get deprecation warning message for a chain.
 */
export function getDeprecationWarning(chain: string): string | undefined {
  const warnings: Record<string, string> = {
    goerli: 'Goerli testnet is deprecated. Use Sepolia for testnet simulation.',
  };
  return warnings[chain.toLowerCase()];
}
