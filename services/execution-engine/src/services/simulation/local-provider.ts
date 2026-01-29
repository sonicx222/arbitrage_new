/**
 * Local Simulation Provider
 *
 * Implements transaction simulation using eth_call on a local JSON-RPC provider.
 * This is the simplest simulation option, suitable for:
 * - Development and testing environments
 * - Local Anvil/Hardhat forks
 * - Fallback when external APIs are unavailable
 *
 * Limitations compared to Tenderly/Alchemy:
 * - No state changes or event logs in response
 * - No detailed revert reason decoding (depends on node)
 * - Cannot specify historical blocks on all nodes
 *
 * @see Phase 1.1: Transaction Simulation Integration
 */

import { ethers } from 'ethers';
import {
  SimulationProviderConfig,
  SimulationRequest,
  SimulationResult,
  SimulationProviderType,
  StateOverride,
  getSimulationErrorMessage,
  decodeRevertData as sharedDecodeRevertData,
  createCancellableTimeout,
} from './types';
import { BaseSimulationProvider } from './base-simulation-provider';

// =============================================================================
// Local Provider Implementation
// =============================================================================

/**
 * Local simulation provider using eth_call.
 *
 * Provides basic transaction simulation by calling eth_call on the configured
 * JSON-RPC provider. Works with any Ethereum-compatible node.
 *
 * Fix 1.2 & 4.2: Uses createCancellableTimeout to prevent timer leaks
 * and ensure consistent timeout behavior across all providers.
 *
 * @example
 * const provider = new LocalSimulationProvider({
 *   type: 'local',
 *   chain: 'ethereum',
 *   provider: new ethers.JsonRpcProvider('http://localhost:8545'),
 *   enabled: true,
 * });
 *
 * const result = await provider.simulate({
 *   chain: 'ethereum',
 *   transaction: { from, to, data },
 * });
 */
export class LocalSimulationProvider extends BaseSimulationProvider {
  readonly type: SimulationProviderType = 'local';

  /**
   * JSON-RPC provider for simulation calls.
   */
  private readonly provider: ethers.JsonRpcProvider;

  constructor(config: SimulationProviderConfig) {
    super(config);

    // Validate provider is available
    if (!config.provider) {
      throw new Error('LocalSimulationProvider requires a JsonRpcProvider');
    }

    this.provider = config.provider;
  }

  // ===========================================================================
  // BaseSimulationProvider Abstract Method Implementation
  // ===========================================================================

  /**
   * Execute simulation using eth_call.
   *
   * Fix 1.2 & 4.2: Refactored to use createCancellableTimeout which:
   * 1. Uses consistent timeout pattern across all providers
   * 2. Properly cleans up timers to prevent memory leaks
   * 3. Avoids AbortController event listener leaks
   *
   * Fix 7.2: Added state override support using JSON-RPC eth_call with state overrides.
   * Note: State overrides require the provider to support the extended eth_call format
   * (Geth, Erigon, Anvil, Hardhat). Not all nodes support this feature.
   */
  protected async executeSimulation(
    request: SimulationRequest,
    startTime: number
  ): Promise<SimulationResult> {
    // Fix 1.2 & 4.2: Use createCancellableTimeout for proper cleanup
    const { promise: timeoutPromise, cancel: cancelTimeout } = createCancellableTimeout<never>(
      this.timeoutMs,
      'Simulation timeout'
    );

    try {
      const tx = request.transaction;

      // Build eth_call request
      const callRequest: ethers.TransactionRequest = {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gasLimit,
        // In ethers v6, blockTag is specified in the transaction request
        blockTag: request.blockNumber ?? 'latest',
      };

      // Fix 7.2: Execute with state overrides if provided
      let result: string;
      if (request.stateOverrides && Object.keys(request.stateOverrides).length > 0) {
        result = await Promise.race([
          this.callWithStateOverrides(callRequest, request.stateOverrides),
          timeoutPromise,
        ]);
      } else {
        // Execute eth_call with timeout using Promise.race
        result = await Promise.race([this.provider.call(callRequest), timeoutPromise]);
      }

      // Successful call - transaction would not revert
      return {
        success: true,
        wouldRevert: false,
        returnValue: result,
        provider: 'local',
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      // Check if this is a revert (transaction would fail on-chain)
      const revertInfo = this.parseRevertError(error);
      if (revertInfo.isRevert) {
        return {
          success: true, // Simulation worked, but tx would revert
          wouldRevert: true,
          revertReason: revertInfo.reason,
          provider: 'local',
          latencyMs: Date.now() - startTime,
        };
      }

      // Non-revert error (network issue, timeout, etc.)
      return {
        success: false,
        wouldRevert: false,
        error: getSimulationErrorMessage(error),
        provider: 'local',
        latencyMs: Date.now() - startTime,
      };
    } finally {
      // Fix 4.2: Always cancel timeout to prevent timer leak
      cancelTimeout();
    }
  }

  /**
   * Perform health check by calling eth_blockNumber.
   *
   * Fix 1.2 & 4.2: Uses createCancellableTimeout for consistent timeout handling.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const { promise: timeoutPromise, cancel: cancelTimeout } = createCancellableTimeout<never>(
      this.timeoutMs,
      'Health check timeout'
    );

    try {
      const blockNumber = await Promise.race([this.provider.getBlockNumber(), timeoutPromise]);

      return {
        healthy: true,
        message: `Local provider healthy at block ${blockNumber}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Local provider unhealthy: ${getSimulationErrorMessage(error)}`,
      };
    } finally {
      // Fix 4.2: Always cancel timeout to prevent timer leak
      cancelTimeout();
    }
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Parse an error to determine if it's a revert and extract the reason.
   */
  private parseRevertError(error: unknown): { isRevert: boolean; reason?: string } {
    if (!(error instanceof Error)) {
      return { isRevert: false };
    }

    const message = error.message.toLowerCase();

    // Common revert indicators
    const revertIndicators = [
      'execution reverted',
      'revert',
      'transaction failed',
      'call exception',
      'out of gas',
      'insufficient funds',
    ];

    const isRevert = revertIndicators.some((indicator) => message.includes(indicator));

    if (!isRevert) {
      return { isRevert: false };
    }

    // Try to extract revert reason
    let reason = 'execution reverted';

    // Check for ethers CallException with revert data
    if ('data' in error && typeof (error as { data: unknown }).data === 'string') {
      const data = (error as { data: string }).data;
      reason = this.decodeRevertData(data) || reason;
    }

    // Check for reason in message
    const reasonMatch = error.message.match(/reason="([^"]+)"/);
    if (reasonMatch) {
      reason = reasonMatch[1];
    }

    // Check for revert string in message
    const revertMatch = error.message.match(/reverted with reason string '([^']+)'/);
    if (revertMatch) {
      reason = revertMatch[1];
    }

    return { isRevert: true, reason };
  }

  /**
   * Fix 7.2: Execute eth_call with state overrides.
   *
   * Uses the JSON-RPC eth_call extended format:
   * eth_call({ from, to, data, ... }, blockNumber, stateOverrides)
   *
   * State overrides format (Geth/Anvil/Hardhat compatible):
   * { [address]: { balance?, nonce?, code?, state? } }
   *
   * @param callRequest - Transaction request
   * @param stateOverrides - State overrides to apply
   * @returns Call result
   */
  private async callWithStateOverrides(
    callRequest: ethers.TransactionRequest,
    stateOverrides: Record<string, StateOverride>
  ): Promise<string> {
    // Convert to raw JSON-RPC format
    const txParams: Record<string, unknown> = {
      from: callRequest.from,
      to: callRequest.to,
      data: callRequest.data,
    };

    if (callRequest.value) {
      txParams.value = '0x' + BigInt(callRequest.value).toString(16);
    }
    if (callRequest.gasLimit) {
      txParams.gas = '0x' + BigInt(callRequest.gasLimit).toString(16);
    }

    // Convert state overrides to JSON-RPC format
    const rpcOverrides: Record<string, Record<string, unknown>> = {};
    for (const [address, override] of Object.entries(stateOverrides)) {
      rpcOverrides[address] = {};
      if (override.balance !== undefined) {
        rpcOverrides[address].balance = '0x' + override.balance.toString(16);
      }
      if (override.nonce !== undefined) {
        rpcOverrides[address].nonce = '0x' + override.nonce.toString(16);
      }
      if (override.code !== undefined) {
        rpcOverrides[address].code = override.code;
      }
      if (override.storage !== undefined) {
        rpcOverrides[address].state = override.storage;
      }
    }

    const blockTag = callRequest.blockTag === 'latest' ? 'latest' :
      typeof callRequest.blockTag === 'number' ? '0x' + callRequest.blockTag.toString(16) : 'latest';

    // Call eth_call with state overrides (third parameter)
    return await this.provider.send('eth_call', [txParams, blockTag, rpcOverrides]);
  }

  /**
   * Decode revert data to extract error message.
   *
   * Fix 9.1: Now uses shared decodeRevertData utility from types.ts
   * to eliminate code duplication across providers.
   */
  private decodeRevertData(data: string): string | undefined {
    return sharedDecodeRevertData(data);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a local simulation provider.
 *
 * @param config - Provider configuration with JsonRpcProvider
 * @returns LocalSimulationProvider instance
 *
 * @example
 * const provider = createLocalProvider({
 *   type: 'local',
 *   chain: 'ethereum',
 *   provider: new ethers.JsonRpcProvider('http://localhost:8545'),
 *   enabled: true,
 * });
 */
export function createLocalProvider(config: SimulationProviderConfig): LocalSimulationProvider {
  return new LocalSimulationProvider(config);
}
