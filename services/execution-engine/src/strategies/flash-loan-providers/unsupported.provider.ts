/**
 * Unsupported Flash Loan Provider
 *
 * Placeholder provider for protocols that are configured but not yet implemented.
 * This includes: PancakeSwap V3, SpookySwap, SyncSwap.
 *
 * Fix 1.1: These providers are documented in FLASH_LOAN_PROVIDERS config but
 * require different smart contracts and callback interfaces than Aave V3.
 *
 * Implementation Roadmap:
 * - PancakeSwap V3 (BSC): Requires PancakeSwap flash swap callback contract
 * - SpookySwap (Fantom): Requires Uniswap V2 style flash swap contract
 * - SyncSwap (zkSync, Linea): Requires SyncSwap-specific callback contract
 *
 * Each protocol has different:
 * - Callback function signatures
 * - Fee structures (paid upfront vs deducted from output)
 * - Transaction encoding requirements
 *
 * @see service-config.ts FLASH_LOAN_PROVIDERS
 */

import { ethers } from 'ethers';
// Fix 8.2: Use centralized constant for consistency with aave-v3.provider.ts
import { getBpsDenominatorBigInt } from '@arbitrage/config';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';

/**
 * Fee rates in basis points for each unsupported protocol
 */
const PROTOCOL_FEES: Record<string, number> = {
  pancakeswap_v3: 25,  // 0.25% flash swap fee
  spookyswap: 30,      // 0.30% flash swap fee
  syncswap: 30,        // 0.30% flash swap fee (variable)
};

// Fix 8.2: Use centralized constant, alias for local readability
const BPS_DENOMINATOR = getBpsDenominatorBigInt();

/**
 * Unsupported Flash Loan Provider
 *
 * Provides a consistent interface for unsupported protocols while
 * clearly indicating that execution is not available.
 *
 * Usage:
 * - Fee calculation works (for profitability estimation)
 * - Validation always fails with clear message
 * - Execution methods throw with implementation roadmap
 */
export class UnsupportedFlashLoanProvider implements IFlashLoanProvider {
  readonly protocol: FlashLoanProtocol;
  readonly chain: string;
  readonly poolAddress: string;

  private readonly feeBps: number;

  constructor(config: {
    protocol: FlashLoanProtocol;
    chain: string;
    poolAddress: string;
    feeBps?: number;
  }) {
    this.protocol = config.protocol;
    this.chain = config.chain;
    this.poolAddress = config.poolAddress;
    this.feeBps = config.feeBps ?? PROTOCOL_FEES[config.protocol] ?? 30;
  }

  /**
   * Always returns false - protocol not implemented
   */
  isAvailable(): boolean {
    return false;
  }

  /**
   * Get provider capabilities (indicates not implemented)
   */
  getCapabilities(): FlashLoanProviderCapabilities {
    return {
      supportsMultiHop: false,
      supportsMultiAsset: false,
      maxLoanAmount: 0n,
      supportedTokens: [],
      status: 'not_implemented',
    };
  }

  /**
   * Calculate fee for profitability estimation
   *
   * Note: Fee calculation works even for unsupported protocols
   * to allow accurate profitability filtering before execution.
   */
  calculateFee(amount: bigint): FlashLoanFeeInfo {
    const feeAmount = (amount * BigInt(this.feeBps)) / BPS_DENOMINATOR;

    return {
      feeBps: this.feeBps,
      feeAmount,
      protocol: this.protocol,
    };
  }

  /**
   * Build calldata - throws because protocol is not implemented
   */
  buildCalldata(_request: FlashLoanRequest): string {
    throw new Error(this.getNotImplementedMessage());
  }

  /**
   * Build transaction - throws because protocol is not implemented
   */
  buildTransaction(
    _request: FlashLoanRequest,
    _from: string
  ): ethers.TransactionRequest {
    throw new Error(this.getNotImplementedMessage());
  }

  /**
   * Estimate gas - throws because protocol is not implemented
   */
  async estimateGas(
    _request: FlashLoanRequest,
    _provider: ethers.JsonRpcProvider
  ): Promise<bigint> {
    throw new Error(this.getNotImplementedMessage());
  }

  /**
   * Validate request - always fails with clear message
   */
  validate(_request: FlashLoanRequest): { valid: boolean; error?: string } {
    return {
      valid: false,
      error: `[ERR_UNSUPPORTED_PROTOCOL] ${this.getNotImplementedMessage()}`,
    };
  }

  /**
   * Get detailed not-implemented message with roadmap
   */
  private getNotImplementedMessage(): string {
    const protocolInfo = this.getProtocolInfo();

    return [
      `Flash loan protocol '${this.protocol}' on chain '${this.chain}' is not yet implemented.`,
      '',
      'Technical Requirements:',
      ...protocolInfo.requirements.map(r => `  - ${r}`),
      '',
      'To implement:',
      `  1. Deploy ${protocolInfo.contractName} contract`,
      `  2. Implement ${this.protocol} callback interface`,
      `  3. Add provider implementation in flash-loan-providers/`,
      '',
      'Currently supported: Aave V3 (ethereum, polygon, arbitrum, base, optimism, avalanche)',
    ].join('\n');
  }

  /**
   * Get protocol-specific information
   */
  private getProtocolInfo(): { contractName: string; requirements: string[] } {
    switch (this.protocol) {
      case 'pancakeswap_v3':
        return {
          contractName: 'PancakeSwapFlashArbitrage',
          requirements: [
            'PancakeSwap V3 Pool flash callback (IPancakeV3FlashCallback)',
            'Different fee structure (0.25% paid from output)',
            'BSC-specific gas optimizations',
          ],
        };

      case 'spookyswap':
        return {
          contractName: 'SpookySwapFlashArbitrage',
          requirements: [
            'Uniswap V2 style flash swap (IUniswapV2Callee)',
            'SpookySwap pair contract interaction',
            'Fantom-specific gas handling',
          ],
        };

      case 'syncswap':
        return {
          contractName: 'SyncSwapFlashArbitrage',
          requirements: [
            'SyncSwap vault flash loan callback (ISyncSwapCallback)',
            'zkSync Era / Linea specific transaction encoding',
            'Variable fee structure based on pool',
          ],
        };

      default:
        return {
          contractName: 'FlashArbitrage',
          requirements: [
            'Protocol-specific callback interface',
            'Custom fee handling',
          ],
        };
    }
  }
}
