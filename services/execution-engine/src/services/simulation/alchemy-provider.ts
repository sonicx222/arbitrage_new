/**
 * Alchemy Simulation Provider
 *
 * Implements transaction simulation using Alchemy's eth_call endpoint.
 * Provides an alternative to Tenderly for transaction simulation.
 *
 * Fix 7.3: Removed mention of alchemy_simulateExecution as it's not implemented.
 * The provider uses standard eth_call for simulation which is sufficient for
 * detecting reverts and validating transactions before execution.
 *
 * @see https://docs.alchemy.com/reference/eth-call
 * @see Phase 1.1: Transaction Simulation Integration in implementation plan
 */

// Fix 9.1: Removed unused ethers import - now using shared decodeRevertData
import {
  SimulationProviderConfig,
  SimulationRequest,
  SimulationResult,
  SimulationProviderType,
  CHAIN_IDS,
  decodeRevertData,
  isDeprecatedChain,
  getDeprecationWarning,
} from './types';
import { BaseSimulationProvider } from './base-simulation-provider';
import { getErrorMessage } from '@arbitrage/core';

// =============================================================================
// Alchemy Chain URLs
// =============================================================================

/**
 * Fix 4.3: Complete Alchemy chain URL mapping for all supported chains.
 * Missing chains would silently fallback to eth-mainnet causing incorrect simulations.
 *
 * @see CHAIN_IDS in types.ts for supported chains
 * @see https://docs.alchemy.com/reference/alchemy-api-quickstart for chain slugs
 */
const ALCHEMY_CHAIN_URLS: Record<string, string> = {
  ethereum: 'eth-mainnet',
  /** @deprecated Goerli testnet is deprecated. Use sepolia instead. */
  goerli: 'eth-goerli',
  sepolia: 'eth-sepolia',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  polygon: 'polygon-mainnet',
  base: 'base-mainnet',
  // Fix 4.3: Added missing chains
  bsc: 'bnb-mainnet',
  avalanche: 'avax-mainnet',
  fantom: 'fantom-mainnet',
  zksync: 'zksync-mainnet',
  linea: 'linea-mainnet',
};

// =============================================================================
// Alchemy Provider Implementation
// =============================================================================

/**
 * Alchemy simulation provider
 *
 * Uses Alchemy's JSON-RPC API for transaction simulation.
 * Falls back to eth_call for basic simulation.
 *
 * Fix 1.1 & 9.1: Now extends BaseSimulationProvider to eliminate ~150 lines
 * of duplicate code for metrics, health tracking, and success rate calculation.
 */
export class AlchemySimulationProvider extends BaseSimulationProvider {
  readonly type: SimulationProviderType = 'alchemy';

  private readonly apiKey: string;
  private readonly baseUrl: string;

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
        throw new Error('Alchemy API key is required');
      }
    }

    this.apiKey = config.apiKey || '';
    this.baseUrl = config.apiUrl || this.buildBaseUrl(config.chain);
  }

  // ===========================================================================
  // BaseSimulationProvider Abstract Method Implementation
  // ===========================================================================

  /**
   * Execute the actual simulation request using Alchemy API.
   *
   * Fix 9.1: Uses fetchWithTimeout helper for consistent timeout handling.
   */
  protected async executeSimulation(
    request: SimulationRequest,
    startTime: number
  ): Promise<SimulationResult> {
    const url = this.getApiUrl();
    const body = this.buildRequestBody(request);

    // Fix 9.1: Use fetchWithTimeout helper
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return this.createErrorResult(
        startTime,
        `Alchemy API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as AlchemyJsonRpcResponse;
    return this.parseSimulationResponse(data, startTime);
  }

  /**
   * Check connection/health of the provider
   *
   * Fix 9.1: Uses fetchWithTimeout helper for consistent timeout handling.
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

      // Fix 9.1: Use fetchWithTimeout helper
      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const data = (await response.json()) as AlchemyJsonRpcResponse;
        if (data.result) {
          return { healthy: true, message: 'Alchemy API is reachable' };
        }
      }

      return {
        healthy: false,
        message: `Alchemy API returned ${response.status}: ${response.statusText}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Alchemy API: ${getErrorMessage(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Build Alchemy simulation request body.
   *
   * Fix 7.3: Added stateOverrides support for Alchemy provider.
   * Uses the third parameter of eth_call for state overrides.
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

    const blockTag = request.blockNumber ? '0x' + request.blockNumber.toString(16) : 'latest';

    // Build params array
    const params: unknown[] = [txParams, blockTag];

    // Fix 7.3: Add state overrides if provided
    // Alchemy accepts state overrides as the third parameter to eth_call
    if (request.stateOverrides && Object.keys(request.stateOverrides).length > 0) {
      const stateOverrides = this.convertStateOverrides(request.stateOverrides);
      params.push(stateOverrides);
    }

    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params,
    };
  }

  /**
   * Convert state overrides to Alchemy's expected format.
   *
   * Fix 7.3: Implements state override conversion for Alchemy.
   * Format: { address: { balance, nonce, code, state, stateDiff } }
   */
  private convertStateOverrides(
    overrides: Record<
      string,
      { balance?: bigint; nonce?: number; code?: string; storage?: Record<string, string> }
    >
  ): Record<string, AlchemyStateOverride> {
    const result: Record<string, AlchemyStateOverride> = {};

    for (const [address, override] of Object.entries(overrides)) {
      result[address] = {};

      if (override.balance !== undefined) {
        result[address].balance = '0x' + override.balance.toString(16);
      }
      if (override.nonce !== undefined) {
        result[address].nonce = '0x' + override.nonce.toString(16);
      }
      if (override.code !== undefined) {
        result[address].code = override.code;
      }
      if (override.storage !== undefined) {
        // Alchemy uses 'state' for complete state replacement
        result[address].state = override.storage;
      }
    }

    return result;
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
   * Decode revert reason from error data.
   *
   * Fix 9.1: Now uses shared decodeRevertData utility from types.ts
   * to eliminate code duplication across providers.
   */
  private decodeRevertReason(error: AlchemyJsonRpcError): string {
    // If there's error data, try to decode it using shared utility
    if (error.data) {
      const decoded = decodeRevertData(error.data);
      if (decoded) {
        return decoded;
      }
      // Return raw data if unable to decode
      return `Revert: ${error.data}`;
    }

    // Return error message if no data
    return error.message || 'execution reverted';
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

/**
 * Fix 7.3: State override type for Alchemy eth_call.
 *
 * @see https://docs.alchemy.com/reference/eth-call
 */
interface AlchemyStateOverride {
  balance?: string;
  nonce?: string;
  code?: string;
  state?: Record<string, string>;
  stateDiff?: Record<string, string>;
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
export function createAlchemyProvider(
  config: SimulationProviderConfig
): AlchemySimulationProvider {
  return new AlchemySimulationProvider(config);
}
