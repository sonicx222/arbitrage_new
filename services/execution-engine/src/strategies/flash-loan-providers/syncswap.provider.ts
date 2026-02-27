/**
 * SyncSwap Flash Loan Provider (Task 3.4)
 *
 * Fully implemented provider for SyncSwap flash loans on zkSync Era.
 * Uses SyncSwapFlashArbitrage.sol contract for on-chain execution.
 *
 * Key characteristics:
 * - EIP-3156 compliant interface
 * - Single Vault per chain (no pool discovery needed)
 * - zkSync Era native (L2-optimized)
 *
 * Supported chains: zksync (Linea support planned for future)
 *
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 * @see contracts/src/interfaces/ISyncSwapVault.sol
 * @see docs/syncswap_api_dpcu.md
 */

import { ethers } from 'ethers';
import { getSwapDeadline } from '../base.strategy';
import {
  SYNCSWAP_FEE_BPS,
  getBpsDenominatorBigInt,
  SYNCSWAP_FLASH_ARBITRAGE_ABI,
} from '@arbitrage/config';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';
import { validateFlashLoanRequest, getProviderLogger } from './validation-utils';

/**
 * Cached ethers.Interface for hot-path optimization.
 * Creating Interface objects is expensive - cache at module level.
 */
const SYNCSWAP_INTERFACE = new ethers.Interface(SYNCSWAP_FLASH_ARBITRAGE_ABI);

// Deadline configuration centralized in base.strategy.ts via getSwapDeadline()

/**
 * SyncSwap Flash Loan Provider
 *
 * Implements the IFlashLoanProvider interface for SyncSwap's Vault-based
 * flash loan system with EIP-3156 compliance.
 *
 * ## Architecture
 * - **Vault-based**: Single Vault contract per chain (like Balancer V2)
 * - **EIP-3156**: Standards-compliant flash loan interface
 * - **Fee**: 0.3% (30 bps) flash loan fee
 * - **Chains**: zkSync Era (mainnet + testnet)
 *
 * ## Integration
 * ```typescript
 * const provider = new SyncSwapFlashLoanProvider({
 *   chain: 'zksync',
 *   poolAddress: '0x621425a1Ef6abE91058E9712575dcc4258F8d091',  // Vault
 *   contractAddress: '<deployed SyncSwapFlashArbitrage address>',
 *   approvedRouters: ['0x2da...', '0x8B7...'],  // SyncSwap Router, Mute, etc.
 * });
 * ```
 */
export class SyncSwapFlashLoanProvider implements IFlashLoanProvider {
  readonly protocol: FlashLoanProtocol = 'syncswap';
  readonly chain: string;
  readonly poolAddress: string; // Vault address

  private readonly contractAddress: string;
  private readonly approvedRouters: string[];
  /** Pre-computed Set for O(1) router validation (hot-path optimization) */
  private readonly approvedRoutersSet: Set<string>;
  private readonly feeOverride?: number;

  constructor(config: {
    chain: string;
    poolAddress: string; // Vault address
    contractAddress: string;
    approvedRouters: string[];
    feeOverride?: number;
  }) {
    this.chain = config.chain;
    this.poolAddress = config.poolAddress; // SyncSwap Vault address
    this.contractAddress = config.contractAddress;
    this.approvedRouters = config.approvedRouters;
    this.approvedRoutersSet = new Set(config.approvedRouters.map(r => r.toLowerCase()));
    this.feeOverride = config.feeOverride;

    // Validate configuration
    if (!ethers.isAddress(config.contractAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid contract address for SyncSwap provider on ${config.chain}`);
    }
    if (!ethers.isAddress(config.poolAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid vault address for SyncSwap provider on ${config.chain}`);
    }
  }

  /**
   * Check if provider is available for use
   */
  isAvailable(): boolean {
    // Check for zero address which indicates misconfiguration
    if (this.contractAddress === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    return true;
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): FlashLoanProviderCapabilities {
    return {
      supportsMultiHop: true,
      supportsMultiAsset: false, // MVP: Single-asset EIP-3156 flash loans only
      maxLoanAmount: 0n, // Depends on Vault liquidity
      supportedTokens: [], // All tokens in SyncSwap pools are supported
      status: 'fully_supported',
    };
  }

  /**
   * Calculate flash loan fee for an amount
   *
   * SyncSwap charges 0.3% (30 basis points) flash loan fee.
   * Fee is calculated as: (amount * 0.003) or (amount * feeBps) / 10000
   *
   * The vault verifies after the loan that its balance increased by at least the fee amount.
   * This balance increase (the "surplus") is the vault's profit verification step, not the fee calculation base.
   *
   * @param amount - Loan amount in wei
   * @returns Fee information (30 bps = 0.3%)
   *
   * @example
   * ```typescript
   * const fee = provider.calculateFee(ethers.parseEther('1000'));
   * // Returns: { feeBps: 30, feeAmount: 3000000000000000000n, protocol: 'syncswap' }
   * // Fee amount: 3 ETH (0.3% of 1000 ETH)
   * // Borrower must repay: 1000 ETH + 3 ETH = 1003 ETH
   * ```
   */
  calculateFee(amount: bigint): FlashLoanFeeInfo {
    const feeBps = this.feeOverride ?? SYNCSWAP_FEE_BPS; // Default: 30 bps
    const feeAmount = (amount * BigInt(feeBps)) / getBpsDenominatorBigInt(); // 0.3% fee

    return {
      feeBps,
      feeAmount,
      protocol: this.protocol,
    };
  }

  /**
   * Build the transaction calldata for flash loan execution
   *
   * Encodes a call to `SyncSwapFlashArbitrage.executeArbitrage()` with:
   * - asset: Token to borrow
   * - amount: Loan amount
   * - swapPath: Multi-hop swap steps
   * - minProfit: Minimum acceptable profit
   * - deadline: Transaction expiry timestamp
   *
   * @param request - Flash loan request parameters
   * @returns Encoded calldata for the transaction
   */
  buildCalldata(request: FlashLoanRequest): string {
    // Convert SwapStep[] to tuple array format for ABI encoding
    const swapPathTuples = request.swapPath.map(step => [
      step.router,
      step.tokenIn,
      step.tokenOut,
      step.amountOutMin,
    ]);

    const deadline = getSwapDeadline();

    return SYNCSWAP_INTERFACE.encodeFunctionData('executeArbitrage', [
      request.asset,
      request.amount,
      swapPathTuples,
      request.minProfit,
      deadline,
    ]);
  }

  /**
   * Build the complete transaction request
   *
   * @param request - Flash loan request parameters
   * @param from - Sender address
   * @returns Transaction request ready for signing
   */
  buildTransaction(
    request: FlashLoanRequest,
    from: string
  ): ethers.TransactionRequest {
    return {
      to: this.contractAddress,
      data: this.buildCalldata(request),
      from,
    };
  }

  /**
   * Estimate gas for flash loan execution
   *
   * **zkSync Era Gas Considerations**:
   * - zkSync Era is an L2 with different gas model than Ethereum L1
   * - Flash loan + multi-hop swaps typically use 400k-600k gas
   * - Default estimate: 520k gas (conservative buffer)
   *
   * @param request - Flash loan request parameters
   * @param provider - JSON-RPC provider for estimation
   * @returns Estimated gas units
   */
  async estimateGas(
    request: FlashLoanRequest,
    provider: ethers.JsonRpcProvider
  ): Promise<bigint> {
    const tx = this.buildTransaction(request, request.initiator);

    try {
      return await provider.estimateGas(tx);
    } catch (error) {
      getProviderLogger().warn('estimateGas failed, using fallback (tx may revert)', {
        provider: 'syncswap', chain: this.chain, fallbackGas: 520000,
        error: (error as Error).message,
      });
      return 520000n;
    }
  }

  /**
   * Validate a flash loan request before execution
   *
   * Performs comprehensive validation:
   * 1. Chain match (must be 'zksync' or supported chain)
   * 2. Valid asset address
   * 3. Non-zero loan amount
   * 4. Non-empty swap path
   * 5. Approved routers only
   * 6. Valid cycle (starts and ends with same token)
   * 7. Asset matches first swap token
   *
   * @param request - Flash loan request to validate
   * @returns Validation result with error message if invalid
   */
  validate(request: FlashLoanRequest): { valid: boolean; error?: string } {
    return validateFlashLoanRequest(request, this.chain, this.approvedRoutersSet);
  }

  /**
   * Get the contract address for this provider
   */
  getContractAddress(): string {
    return this.contractAddress;
  }

  /**
   * Get the list of approved routers
   */
  getApprovedRouters(): string[] {
    return [...this.approvedRouters];
  }

  /**
   * Get the Vault address for this provider
   */
  getVaultAddress(): string {
    return this.poolAddress;
  }
}
