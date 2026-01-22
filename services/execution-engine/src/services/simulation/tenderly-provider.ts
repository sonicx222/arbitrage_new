/**
 * Tenderly Simulation Provider
 *
 * Implements transaction simulation using the Tenderly Simulation API.
 * Tenderly provides 500 free simulations per month, making it suitable
 * for pre-flight transaction validation.
 *
 * @see https://docs.tenderly.co/simulations-and-forks/simulation-api
 * @see Phase 1.1: Transaction Simulation Integration in implementation plan
 */

import { ethers } from 'ethers';
import {
  ISimulationProvider,
  SimulationProviderConfig,
  SimulationProviderHealth,
  SimulationMetrics,
  SimulationRequest,
  SimulationResult,
  SimulationProviderType,
  StateChange,
  SimulationLog,
  CHAIN_IDS,
  SIMULATION_DEFAULTS,
  TENDERLY_CONFIG,
  CircularBuffer,
} from './types';

// =============================================================================
// Tenderly Provider Implementation
// =============================================================================

/**
 * Tenderly simulation provider
 *
 * Uses Tenderly's Simulation API to validate transactions before submission.
 * Provides detailed simulation results including state changes and logs.
 */
export class TenderlyProvider implements ISimulationProvider {
  readonly type: SimulationProviderType = 'tenderly';
  readonly chain: string;

  private readonly config: SimulationProviderConfig;
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly accountSlug: string;
  private readonly projectSlug: string;
  private readonly timeoutMs: number;

  private metrics: SimulationMetrics;
  private health: SimulationProviderHealth;

  // Rolling window for success rate calculation (O(1) circular buffer)
  private readonly recentResults = new CircularBuffer<boolean>(100);

  constructor(config: SimulationProviderConfig) {
    this.config = config;
    this.chain = config.chain;

    // Validate required fields when enabled
    if (config.enabled) {
      if (!config.apiKey) {
        throw new Error('Tenderly API key is required');
      }
      if (!config.accountSlug) {
        throw new Error('Tenderly account slug is required');
      }
      if (!config.projectSlug) {
        throw new Error('Tenderly project slug is required');
      }
    }

    this.apiKey = config.apiKey || '';
    this.accountSlug = config.accountSlug || '';
    this.projectSlug = config.projectSlug || '';
    this.apiUrl = config.apiUrl || TENDERLY_CONFIG.apiUrl;
    this.timeoutMs = config.timeoutMs || SIMULATION_DEFAULTS.timeoutMs;

    this.metrics = this.createEmptyMetrics();
    this.health = this.createInitialHealth();
  }

  /**
   * Check if provider is available and enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Simulate a transaction using Tenderly API
   */
  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    const startTime = Date.now();
    this.metrics.totalSimulations++;

    if (!this.isEnabled()) {
      return this.createErrorResult(startTime, 'Tenderly provider is disabled');
    }

    try {
      const result = await this.executeSimulation(request, startTime);

      // Update health and metrics based on result
      if (result.success) {
        this.recordSuccess(startTime);
        if (result.wouldRevert) {
          this.metrics.predictedReverts++;
        }
      } else {
        this.recordFailure(result.error);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.recordFailure(errorMessage);
      return this.createErrorResult(startTime, errorMessage);
    }
  }

  /**
   * Get current health status
   */
  getHealth(): SimulationProviderHealth {
    return { ...this.health };
  }

  /**
   * Get current metrics
   */
  getMetrics(): SimulationMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
    this.recentResults.clear();
  }

  /**
   * Check connection/health of the provider
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const url = `${this.apiUrl}/account/${this.accountSlug}/project/${this.projectSlug}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: this.getHeaders(),
          signal: controller.signal,
        });

        if (response.ok) {
          return { healthy: true, message: 'Tenderly API is reachable' };
        }

        return {
          healthy: false,
          message: `Tenderly API returned ${response.status}: ${response.statusText}`,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Tenderly API: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Execute the actual simulation request
   */
  private async executeSimulation(
    request: SimulationRequest,
    startTime: number
  ): Promise<SimulationResult> {
    const chainId = this.getChainId(request.chain);
    const body = this.buildRequestBody(request, chainId);

    const url = `${this.apiUrl}/account/${this.accountSlug}/project/${this.projectSlug}/simulate`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return this.createErrorResult(
          startTime,
          `Tenderly API error: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json() as TenderlySimulationResponse;
      return this.parseSimulationResponse(data, startTime);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Build Tenderly simulation request body
   */
  private buildRequestBody(
    request: SimulationRequest,
    chainId: string
  ): TenderlySimulationRequest {
    const tx = request.transaction;

    const body: TenderlySimulationRequest = {
      network_id: chainId,
      from: tx.from as string,
      to: tx.to as string,
      input: tx.data as string || '0x',
      value: tx.value ? tx.value.toString() : '0',
      gas: tx.gasLimit ? Number(tx.gasLimit) : 8000000,
      save: false,
      save_if_fails: false,
      simulation_type: 'quick',
    };

    // Add optional fields
    if (request.blockNumber) {
      body.block_number = request.blockNumber;
    }

    if (request.stateOverrides) {
      body.state_objects = this.convertStateOverrides(request.stateOverrides);
    }

    return body;
  }

  /**
   * Parse Tenderly simulation response
   */
  private parseSimulationResponse(
    data: TenderlySimulationResponse,
    startTime: number
  ): SimulationResult {
    const simulation = data.simulation;
    const txInfo = data.transaction?.transaction_info;

    const result: SimulationResult = {
      success: true,
      wouldRevert: !simulation.status,
      provider: 'tenderly',
      latencyMs: Date.now() - startTime,
    };

    // Gas information
    if (simulation.gas_used) {
      result.gasUsed = BigInt(simulation.gas_used);
    }

    // Block number
    if (simulation.block_number) {
      result.blockNumber = simulation.block_number;
    }

    // Revert reason
    if (!simulation.status) {
      result.revertReason = simulation.error_message || txInfo?.call_trace?.error || 'Unknown revert';
    }

    // Return value
    if (txInfo?.call_trace?.output) {
      result.returnValue = txInfo.call_trace.output;
    }

    // State changes
    if (txInfo?.state_diff) {
      result.stateChanges = this.parseStateChanges(txInfo.state_diff);
    }

    // Logs
    if (txInfo?.logs) {
      result.logs = this.parseLogs(txInfo.logs);
    }

    return result;
  }

  /**
   * Parse state changes from Tenderly response
   */
  private parseStateChanges(stateDiff: TenderlyStateDiff[]): StateChange[] {
    return stateDiff.map((diff) => ({
      address: diff.address,
      before: diff.original,
      after: diff.dirty,
      type: 'storage' as const,
    }));
  }

  /**
   * Parse logs from Tenderly response
   */
  private parseLogs(logs: TenderlyLog[]): SimulationLog[] {
    return logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
    }));
  }

  /**
   * Convert state overrides to Tenderly format
   */
  private convertStateOverrides(
    overrides: Record<string, { balance?: bigint; nonce?: number; code?: string; storage?: Record<string, string> }>
  ): Record<string, TenderlyStateObject> {
    const result: Record<string, TenderlyStateObject> = {};

    for (const [address, override] of Object.entries(overrides)) {
      result[address] = {};

      if (override.balance !== undefined) {
        result[address].balance = override.balance.toString();
      }
      if (override.nonce !== undefined) {
        result[address].nonce = override.nonce;
      }
      if (override.code !== undefined) {
        result[address].code = override.code;
      }
      if (override.storage !== undefined) {
        result[address].storage = override.storage;
      }
    }

    return result;
  }

  /**
   * Get chain ID for the request chain
   */
  private getChainId(chain: string): string {
    const chainId = CHAIN_IDS[chain];
    return chainId ? chainId.toString() : '1';
  }

  /**
   * Get headers for Tenderly API requests
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Access-Key': this.apiKey,
    };
  }

  /**
   * Create error result
   */
  private createErrorResult(startTime: number, error: string): SimulationResult {
    return {
      success: false,
      wouldRevert: false,
      error,
      provider: 'tenderly',
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): SimulationMetrics {
    return {
      totalSimulations: 0,
      successfulSimulations: 0,
      failedSimulations: 0,
      predictedReverts: 0,
      averageLatencyMs: 0,
      fallbackUsed: 0,
      cacheHits: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Create initial health status
   */
  private createInitialHealth(): SimulationProviderHealth {
    return {
      healthy: true,
      lastCheck: Date.now(),
      consecutiveFailures: 0,
      averageLatencyMs: 0,
      successRate: 1.0,
    };
  }

  /**
   * Record successful simulation
   */
  private recordSuccess(startTime: number): void {
    const latency = Date.now() - startTime;

    this.metrics.successfulSimulations++;
    this.updateAverageLatency(latency);

    this.health.consecutiveFailures = 0;
    this.health.healthy = true;
    this.health.lastCheck = Date.now();

    this.recentResults.push(true);
    this.updateSuccessRate();
  }

  /**
   * Record failed simulation
   */
  private recordFailure(error?: string): void {
    this.metrics.failedSimulations++;

    this.health.consecutiveFailures++;
    this.health.lastError = error;
    this.health.lastCheck = Date.now();

    if (this.health.consecutiveFailures >= SIMULATION_DEFAULTS.maxConsecutiveFailures) {
      this.health.healthy = false;
    }

    this.recentResults.push(false);
    this.updateSuccessRate();
  }

  /**
   * Update average latency (rolling average)
   */
  private updateAverageLatency(latency: number): void {
    const total = this.metrics.successfulSimulations;
    if (total === 1) {
      this.metrics.averageLatencyMs = latency;
      this.health.averageLatencyMs = latency;
    } else {
      this.metrics.averageLatencyMs =
        (this.metrics.averageLatencyMs * (total - 1) + latency) / total;
      this.health.averageLatencyMs = this.metrics.averageLatencyMs;
    }
    this.metrics.lastUpdated = Date.now();
  }

  /**
   * Update success rate from recent results
   */
  private updateSuccessRate(): void {
    if (this.recentResults.length === 0) {
      this.health.successRate = 1.0;
      return;
    }

    const successes = this.recentResults.countWhere((r) => r);
    this.health.successRate = successes / this.recentResults.length;
  }
}

// =============================================================================
// Tenderly API Types
// =============================================================================

interface TenderlySimulationRequest {
  network_id: string;
  from: string;
  to: string;
  input: string;
  value: string;
  gas: number;
  save: boolean;
  save_if_fails: boolean;
  simulation_type: 'full' | 'quick';
  block_number?: number;
  state_objects?: Record<string, TenderlyStateObject>;
}

interface TenderlyStateObject {
  balance?: string;
  nonce?: number;
  code?: string;
  storage?: Record<string, string>;
}

interface TenderlySimulationResponse {
  simulation: {
    status: boolean;
    gas_used?: number;
    block_number?: number;
    error_message?: string;
  };
  transaction?: {
    transaction_info?: {
      call_trace?: {
        output?: string;
        error?: string;
      };
      state_diff?: TenderlyStateDiff[];
      logs?: TenderlyLog[];
    };
  };
}

interface TenderlyStateDiff {
  address: string;
  original: string;
  dirty: string;
}

interface TenderlyLog {
  address: string;
  topics: string[];
  data: string;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Tenderly simulation provider
 */
export function createTenderlyProvider(config: SimulationProviderConfig): TenderlyProvider {
  return new TenderlyProvider(config);
}
