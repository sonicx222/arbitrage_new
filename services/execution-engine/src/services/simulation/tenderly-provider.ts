/**
 * Tenderly Simulation Provider
 *
 * Implements transaction simulation using the Tenderly Simulation API.
 * Tenderly provides 25,000 free simulations per month (Fix 2.1: corrected from 500),
 * making it suitable for pre-flight transaction validation.
 *
 * @see https://docs.tenderly.co/simulations-and-forks/simulation-api
 * @see Phase 1.1: Transaction Simulation Integration in implementation plan
 */

import {
  SimulationProviderConfig,
  SimulationProviderHealth,
  SimulationRequest,
  SimulationResult,
  SimulationProviderType,
  StateChange,
  SimulationLog,
  CHAIN_IDS,
  SIMULATION_DEFAULTS,
  TENDERLY_CONFIG,
  isDeprecatedChain,
  getDeprecationWarning,
} from './types';
import { BaseSimulationProvider } from './base-simulation-provider';
import { getErrorMessage } from '@arbitrage/core/resilience';

// =============================================================================
// Tenderly Provider Implementation
// =============================================================================

/**
 * Tenderly simulation provider
 *
 * Uses Tenderly's Simulation API to validate transactions before submission.
 * Provides detailed simulation results including state changes and logs.
 *
 * Fix 1.1 & 9.1: Now extends BaseSimulationProvider to eliminate ~150 lines
 * of duplicate code for metrics, health tracking, and success rate calculation.
 */
export class TenderlyProvider extends BaseSimulationProvider {
  readonly type: SimulationProviderType = 'tenderly';

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly accountSlug: string;
  private readonly projectSlug: string;

  // Rate limit tracking (Tenderly free tier: 25,000 simulations/month)
  private requestsUsedThisMonth = 0;
  private rateLimitResetDate: Date;
  private readonly monthlyRequestLimit: number;

  constructor(config: SimulationProviderConfig) {
    super(config);

    // Fix 7.1: Warn about deprecated chains
    // Fix 6.1: Use logger instead of console.warn
    if (isDeprecatedChain(config.chain)) {
      const warning = getDeprecationWarning(config.chain);
      if (warning) {
        this.logger.warn('Deprecated chain detected', {
          chain: config.chain,
          warning,
        });
      }
    }

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

    // Initialize rate limit tracking
    this.monthlyRequestLimit = TENDERLY_CONFIG.freeMonthlyLimit;
    this.rateLimitResetDate = this.getNextMonthStart();
  }

  // ===========================================================================
  // BaseSimulationProvider Abstract Method Implementation
  // ===========================================================================

  /**
   * Execute the actual simulation request using Tenderly API.
   *
   * Fix 2.1: Rate limit counter is incremented here for ALL API requests,
   * regardless of success or failure. Tenderly counts all requests toward
   * the monthly limit.
   *
   * Fix DOC 2.1: Check rate limit exhaustion BEFORE making the request.
   * If exhausted, return an error immediately instead of wasting API calls.
   */
  protected async executeSimulation(
    request: SimulationRequest,
    startTime: number
  ): Promise<SimulationResult> {
    // Fix DOC 2.1: Check if rate limit is exhausted before making request
    if (!this.isWithinRateLimit()) {
      return this.createErrorResult(
        startTime,
        `Tenderly rate limit exhausted (${this.requestsUsedThisMonth}/${this.monthlyRequestLimit} requests used this month). ` +
          `Limit resets on ${this.rateLimitResetDate.toISOString()}`
      );
    }

    const chainId = this.getChainId(request.chain);
    const body = this.buildRequestBody(request, chainId);

    const url = `${this.apiUrl}/account/${this.accountSlug}/project/${this.projectSlug}/simulate`;

    // Fix 2.1: Increment rate limit counter BEFORE the request
    // because Tenderly counts all API calls toward the limit
    this.incrementRateLimitCounter();

    // Fix 9.1: Use fetchWithTimeout helper for consistent timeout handling
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return this.createErrorResult(
        startTime,
        `Tenderly API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as TenderlySimulationResponse;
    return this.parseSimulationResponse(data, startTime);
  }

  /**
   * Check connection/health of the provider
   *
   * Fix 9.1: Uses fetchWithTimeout helper for consistent timeout handling.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const url = `${this.apiUrl}/account/${this.accountSlug}/project/${this.projectSlug}`;

      // Fix 9.1: Use fetchWithTimeout helper
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (response.ok) {
        return { healthy: true, message: 'Tenderly API is reachable' };
      }

      return {
        healthy: false,
        message: `Tenderly API returned ${response.status}: ${response.statusText}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Tenderly API: ${getErrorMessage(error)}`,
      };
    }
  }

  // ===========================================================================
  // Override: Include rate limit info in health
  // ===========================================================================

  /**
   * Get current health status including rate limit information.
   * Overrides base implementation to add Tenderly-specific rate limit data.
   */
  override getHealth(): SimulationProviderHealth {
    // Check if we need to reset the rate limit counter
    this.checkRateLimitReset();

    return {
      ...super.getHealth(),
      // Include rate limit information
      requestsUsed: this.requestsUsedThisMonth,
      requestLimit: this.monthlyRequestLimit,
    };
  }

  // ===========================================================================
  // Rate Limit Methods (Tenderly-specific)
  // ===========================================================================

  /**
   * Check if the rate limit has been exceeded.
   * Returns true if more requests can be made this month.
   */
  isWithinRateLimit(): boolean {
    this.checkRateLimitReset();
    return this.requestsUsedThisMonth < this.monthlyRequestLimit;
  }

  /**
   * Get the remaining requests available this month.
   */
  getRemainingRequests(): number {
    this.checkRateLimitReset();
    return Math.max(0, this.monthlyRequestLimit - this.requestsUsedThisMonth);
  }

  /**
   * Get rate limit usage as a percentage (0-100).
   */
  getRateLimitUsagePercent(): number {
    this.checkRateLimitReset();
    return (this.requestsUsedThisMonth / this.monthlyRequestLimit) * 100;
  }

  /**
   * Reset rate limit tracking (for testing or manual reset).
   */
  resetRateLimit(): void {
    this.requestsUsedThisMonth = 0;
    this.rateLimitResetDate = this.getNextMonthStart();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

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
      input: (tx.data as string) || '0x',
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
      result.revertReason =
        simulation.error_message || txInfo?.call_trace?.error || 'Unknown revert';
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
   * Convert state overrides to Tenderly format.
   * Fix 7.3: Tenderly already supports state overrides, this method converts
   * our internal format to Tenderly's expected format.
   */
  private convertStateOverrides(
    overrides: Record<
      string,
      { balance?: bigint; nonce?: number; code?: string; storage?: Record<string, string> }
    >
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
   * Increment the rate limit counter.
   *
   * Fix 2.1: Called for ALL API requests (not just successes).
   * Tenderly counts all requests toward the monthly limit.
   */
  private incrementRateLimitCounter(): void {
    this.checkRateLimitReset();
    this.requestsUsedThisMonth++;
  }

  /**
   * Check if the rate limit counter should be reset (new month).
   */
  private checkRateLimitReset(): void {
    const now = new Date();
    if (now >= this.rateLimitResetDate) {
      this.requestsUsedThisMonth = 0;
      this.rateLimitResetDate = this.getNextMonthStart();
    }
  }

  /**
   * Get the start of the next month (UTC).
   */
  private getNextMonthStart(): Date {
    const now = new Date();
    // Get first day of next month at midnight UTC
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
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
