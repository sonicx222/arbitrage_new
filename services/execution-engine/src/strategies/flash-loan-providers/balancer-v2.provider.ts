/**
 * Balancer V2 Flash Loan Provider
 *
 * Fully implemented provider for Balancer V2 flash loans.
 * Uses BalancerV2FlashArbitrage.sol contract for on-chain execution.
 *
 * Key advantages over other protocols:
 * - 0% flash loan fee (vs Aave V3's 0.09%)
 * - Single Vault per chain (no pool discovery needed)
 * - Massive liquidity across all Balancer pools
 *
 * Supported chains: ethereum, polygon, arbitrum, optimism, base, fantom (Beethoven X)
 *
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 * @see https://docs.balancer.fi/reference/contracts/flash-loans.html
 */

import { ethers } from 'ethers';
import {
  BALANCER_V2_FEE_BPS,
  getBpsDenominatorBigInt,
  BALANCER_V2_FLASH_ARBITRAGE_ABI,
} from '@arbitrage/config';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';
import { validateFlashLoanRequest } from './validation-utils';

// Alias for local readability
const BPS_DENOMINATOR = getBpsDenominatorBigInt();

/**
 * Cached ethers.Interface for hot-path optimization.
 * Creating Interface objects is expensive - cache at module level.
 */
const BALANCER_V2_INTERFACE = new ethers.Interface(BALANCER_V2_FLASH_ARBITRAGE_ABI);

/**
 * Default deadline for flash loan execution (5 minutes from now).
 * This protects against stale transactions being mined in poor market conditions.
 */
const DEFAULT_DEADLINE_SECONDS = 300;

/**
 * Balancer V2 Flash Loan Provider
 *
 * Fully implemented provider that integrates with the BalancerV2FlashArbitrage
 * smart contract for trustless on-chain execution with 0% flash loan fees.
 */
export class BalancerV2FlashLoanProvider implements IFlashLoanProvider {
  readonly protocol: FlashLoanProtocol = 'balancer_v2';
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
    this.poolAddress = config.poolAddress; // Balancer V2 Vault address
    this.contractAddress = config.contractAddress;
    this.approvedRouters = config.approvedRouters;
    this.approvedRoutersSet = new Set(config.approvedRouters.map(r => r.toLowerCase()));
    this.feeOverride = config.feeOverride;

    // Validate configuration
    if (!ethers.isAddress(config.contractAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid contract address for Balancer V2 provider on ${config.chain}`);
    }
    if (!ethers.isAddress(config.poolAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid vault address for Balancer V2 provider on ${config.chain}`);
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
      supportsMultiAsset: false, // MVP: Single-asset flash loans only
      maxLoanAmount: 0n, // Depends on Vault liquidity
      supportedTokens: [], // All tokens in Balancer pools are supported
      status: 'fully_supported',
    };
  }

  /**
   * Calculate flash loan fee for an amount
   *
   * Balancer V2 charges 0% flash loan fees.
   * This makes it the most cost-effective flash loan provider.
   *
   * @param amount - Loan amount in wei
   * @returns Fee information (always 0 for Balancer V2)
   */
  calculateFee(amount: bigint): FlashLoanFeeInfo {
    const feeBps = this.feeOverride ?? BALANCER_V2_FEE_BPS; // Always 0
    const feeAmount = (amount * BigInt(feeBps)) / BPS_DENOMINATOR; // Always 0n

    return {
      feeBps,
      feeAmount,
      protocol: this.protocol,
    };
  }

  /**
   * Build the transaction calldata for flash loan execution
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

    // Calculate deadline: current time + 5 minutes
    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS;

    return BALANCER_V2_INTERFACE.encodeFunctionData('executeArbitrage', [
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
    } catch {
      // Default gas estimate for flash loan arbitrage
      // Balancer V2 may use slightly more gas than Aave V3 due to Vault architecture
      return 550000n;
    }
  }

  /**
   * Validate a flash loan request before execution
   *
   * This validation logic is identical to Aave V3 provider since both
   * use the same swap execution mechanism. The only difference is the
   * flash loan protocol (Vault vs Pool).
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
