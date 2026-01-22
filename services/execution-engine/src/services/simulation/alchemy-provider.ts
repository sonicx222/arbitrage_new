/**
 * Alchemy Simulation Provider
 *
 * Implements transaction simulation using Alchemy's eth_call and
 * alchemy_simulateExecution endpoints. Provides an alternative to
 * Tenderly for transaction simulation.
 *
 * @see https://docs.alchemy.com/reference/eth-call
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
  CHAIN_IDS,
  SIMULATION_DEFAULTS,
  CircularBuffer,
} from './types';

// =============================================================================
// Alchemy Chain URLs
// =============================================================================

const ALCHEMY_CHAIN_URLS: Record<string, string> = {
  ethereum: 'eth-mainnet',
  goerli: 'eth-goerli',
  sepolia: 'eth-sepolia',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
};

// =============================================================================
// Alchemy Provider Implementation
// =============================================================================

/**
 * Alchemy simulation provider
 *
 * Uses Alchemy's JSON-RPC API for transaction simulation.
 * Falls back to eth_call for basic simulation.
 */
export class AlchemySimulationProvider implements ISimulationProvider {
  readonly type: SimulationProviderType = 'alchemy';
  readonly chain: string;

  private readonly config: SimulationProviderConfig;
  private readonly apiKey: string;
  private readonly baseUrl: string;
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
        throw new Error('Alchemy API key is required');
      }
    }

    this.apiKey = config.apiKey || '';
    this.baseUrl = config.apiUrl || this.buildBaseUrl(config.chain);
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
   * Simulate a transaction using Alchemy API
   */
  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    const startTime = Date.now();
    this.metrics.totalSimulations++;

    if (!this.isEnabled()) {
      return this.createErrorResult(startTime, 'Alchemy provider is disabled');
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
      const url = this.getApiUrl();

      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          const data = await response.json() as AlchemyJsonRpcResponse;
          if (data.result) {
            return { healthy: true, message: 'Alchemy API is reachable' };
          }
        }

        return {
          healthy: false,
          message: `Alchemy API returned ${response.status}: ${response.statusText}`,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Alchemy API: ${error instanceof Error ? error.message : String(error)}`,
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
    const url = this.getApiUrl();
    const body = this.buildRequestBody(request);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return this.createErrorResult(
          startTime,
          `Alchemy API error: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json() as AlchemyJsonRpcResponse;
      return this.parseSimulationResponse(data, startTime);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Build Alchemy simulation request body
   */
  private buildRequestBody(request: SimulationRequest): AlchemyJsonRpcRequest {
    const tx = request.transaction;

    const txParams: AlchemyTransactionParams = {
      from: tx.from as string,
      to: tx.to as string,
      data: (tx.data as string) || '0x',
    };

    if (tx.value) {
      txParams.value = '0x' + tx.value.toString(16);
    }

    if (tx.gasLimit) {
      txParams.gas = '0x' + Number(tx.gasLimit).toString(16);
    }

    const blockTag = request.blockNumber
      ? '0x' + request.blockNumber.toString(16)
      : 'latest';

    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [txParams, blockTag],
    };
  }

  /**
   * Parse Alchemy simulation response
   */
  private parseSimulationResponse(
    data: AlchemyJsonRpcResponse,
    startTime: number
  ): SimulationResult {
    // Check for JSON-RPC error (revert)
    if (data.error) {
      const revertReason = this.decodeRevertReason(data.error);
      return {
        success: true, // API call worked
        wouldRevert: true,
        revertReason,
        provider: 'alchemy',
        latencyMs: Date.now() - startTime,
      };
    }

    // Successful simulation
    return {
      success: true,
      wouldRevert: false,
      returnValue: data.result,
      provider: 'alchemy',
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Decode revert reason from error data
   */
  private decodeRevertReason(error: AlchemyJsonRpcError): string {
    // If there's error data, try to decode it
    if (error.data) {
      const data = error.data;

      // Error(string) selector: 0x08c379a0
      if (data.startsWith('0x08c379a0')) {
        try {
          const abiCoder = ethers.AbiCoder.defaultAbiCoder();
          const decoded = abiCoder.decode(['string'], '0x' + data.slice(10));
          return `Error: ${decoded[0]}`;
        } catch {
          // Fall through to raw data
        }
      }

      // Panic(uint256) selector: 0x4e487b71
      if (data.startsWith('0x4e487b71')) {
        try {
          const abiCoder = ethers.AbiCoder.defaultAbiCoder();
          const decoded = abiCoder.decode(['uint256'], '0x' + data.slice(10));
          const panicCode = Number(decoded[0]);
          return `Panic(${panicCode}): ${this.getPanicMessage(panicCode)}`;
        } catch {
          // Fall through to raw data
        }
      }

      // Return raw data if unable to decode
      return `Revert: ${data}`;
    }

    // Return error message if no data
    return error.message || 'execution reverted';
  }

  /**
   * Get human-readable panic message
   */
  private getPanicMessage(code: number): string {
    const panicMessages: Record<number, string> = {
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
    return panicMessages[code] || 'Unknown panic';
  }

  /**
   * Build base URL for Alchemy API
   */
  private buildBaseUrl(chain: string): string {
    const chainSlug = ALCHEMY_CHAIN_URLS[chain] || 'eth-mainnet';
    return `https://${chainSlug}.g.alchemy.com`;
  }

  /**
   * Get full API URL with key
   */
  private getApiUrl(): string {
    return `${this.baseUrl}/v2/${this.apiKey}`;
  }

  /**
   * Create error result
   */
  private createErrorResult(startTime: number, error: string): SimulationResult {
    return {
      success: false,
      wouldRevert: false,
      error,
      provider: 'alchemy',
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
// Alchemy API Types
// =============================================================================

interface AlchemyTransactionParams {
  from: string;
  to: string;
  data: string;
  value?: string;
  gas?: string;
}

interface AlchemyJsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface AlchemyJsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: string;
  error?: AlchemyJsonRpcError;
}

interface AlchemyJsonRpcError {
  code: number;
  message: string;
  data?: string;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an Alchemy simulation provider
 */
export function createAlchemyProvider(config: SimulationProviderConfig): AlchemySimulationProvider {
  return new AlchemySimulationProvider(config);
}
