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
 * Configuration for simulation service
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
 */
export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  goerli: 5,
  sepolia: 11155111,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  base: 8453,
  bsc: 56,
  avalanche: 43114,
};

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
 * Tenderly API configuration
 */
export const TENDERLY_CONFIG = {
  apiUrl: 'https://api.tenderly.co/api/v1',
  simulateEndpoint: '/account/{accountSlug}/project/{projectSlug}/simulate',
  freeMonthlyLimit: 500,
};

/**
 * Alchemy simulation configuration
 */
export const ALCHEMY_CONFIG = {
  simulateEndpoint: '/v2/{apiKey}/eth_call',
};

// =============================================================================
// Utilities
// =============================================================================

/**
 * Circular buffer for O(1) rolling window operations
 *
 * Used for tracking recent results in provider health scoring.
 * More efficient than array push/shift which is O(n).
 */
export class CircularBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  /**
   * Add an item to the buffer (O(1))
   */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Get all items in order from oldest to newest
   */
  toArray(): T[] {
    if (this.count === 0) return [];

    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;

    for (let i = 0; i < this.count; i++) {
      const index = (start + i) % this.capacity;
      result.push(this.buffer[index] as T);
    }

    return result;
  }

  /**
   * Get the number of items in the buffer
   */
  get length(): number {
    return this.count;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /**
   * Count items matching a predicate
   */
  countWhere(predicate: (item: T) => boolean): number {
    let matches = 0;
    const start = this.count < this.capacity ? 0 : this.head;

    for (let i = 0; i < this.count; i++) {
      const index = (start + i) % this.capacity;
      if (predicate(this.buffer[index] as T)) {
        matches++;
      }
    }

    return matches;
  }
}
