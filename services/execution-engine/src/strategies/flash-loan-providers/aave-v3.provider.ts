/**
 * Aave V3 Flash Loan Provider
 *
 * Fully implemented provider for Aave V3 flash loans.
 * Uses FlashLoanArbitrage.sol contract for on-chain execution.
 *
 * Supported chains: ethereum, polygon, arbitrum, base, optimism, avalanche
 *
 * @see contracts/src/FlashLoanArbitrage.sol
 * @see https://docs.aave.com/developers/guides/flash-loans
 */

import { ethers } from 'ethers';
// Fix 1.1 & 9.2: Import centralized constants and ABI
import {
  AAVE_V3_FEE_BPS,
  getBpsDenominatorBigInt,
  FLASH_LOAN_ARBITRAGE_ABI,
} from '@arbitrage/config';
import { getSwapDeadline } from '../base.strategy';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';
import { validateFlashLoanRequest, getProviderLogger } from './validation-utils';

// Fix 1.1: Use centralized constant, alias for local readability
const BPS_DENOMINATOR = getBpsDenominatorBigInt();

/**
 * Cached ethers.Interface for hot-path optimization.
 * Creating Interface objects is expensive - cache at module level.
 *
 * Fix 9.2: Uses centralized FLASH_LOAN_ARBITRAGE_ABI from @arbitrage/config.
 * @see service-config.ts for full ABI documentation
 */
const FLASH_LOAN_INTERFACE = new ethers.Interface(FLASH_LOAN_ARBITRAGE_ABI);

// Deadline configuration centralized in base.strategy.ts via getSwapDeadline()

/**
 * Aave V3 Flash Loan Provider
 *
 * Fully implemented provider that integrates with the FlashLoanArbitrage
 * smart contract for trustless on-chain execution.
 */
export class AaveV3FlashLoanProvider implements IFlashLoanProvider {
  readonly protocol: FlashLoanProtocol = 'aave_v3';
  readonly chain: string;
  readonly poolAddress: string;

  private readonly contractAddress: string;
  private readonly approvedRouters: string[];
  /** Pre-computed Set for O(1) router validation (hot-path optimization) */
  private readonly approvedRoutersSet: Set<string>;
  private readonly feeOverride?: number;

  constructor(config: {
    chain: string;
    poolAddress: string;
    contractAddress: string;
    approvedRouters: string[];
    feeOverride?: number;
  }) {
    this.chain = config.chain;
    this.poolAddress = config.poolAddress;
    this.contractAddress = config.contractAddress;
    this.approvedRouters = config.approvedRouters;
    this.approvedRoutersSet = new Set(config.approvedRouters.map(r => r.toLowerCase()));
    this.feeOverride = config.feeOverride;

    // Validate configuration
    if (!ethers.isAddress(config.contractAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid contract address for Aave V3 provider on ${config.chain}`);
    }
    if (!ethers.isAddress(config.poolAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid pool address for Aave V3 provider on ${config.chain}`);
    }
  }

  /**
   * Check if provider is available for use
   */
  isAvailable(): boolean {
    // Fix 3.1: Check for zero address which indicates misconfiguration
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
      supportsMultiAsset: false, // FlashLoanArbitrage uses flashLoanSimple
      maxLoanAmount: 0n, // Depends on pool liquidity
      supportedTokens: [], // All tokens supported in Aave pools
      status: 'fully_supported',
    };
  }

  /**
   * Calculate flash loan fee for an amount
   *
   * Fee format: Basis points (1 bps = 0.01%)
   * - Aave V3: 9 bps = 0.09% (industry standard)
   * - Config file: Must use integer basis points, NOT decimal percentages
   * - See @arbitrage/config AAVE_V3_FEE_BPS for centralized constant
   *
   * @param amount - Loan amount in wei
   * @returns Fee information with feeBps in basis points format
   * @see shared/config/src/service-config.ts Fee format documentation
   */
  calculateFee(amount: bigint): FlashLoanFeeInfo {
    const feeBps = this.feeOverride ?? AAVE_V3_FEE_BPS;
    const feeAmount = (amount * BigInt(feeBps)) / BPS_DENOMINATOR;

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

    const deadline = getSwapDeadline();

    return FLASH_LOAN_INTERFACE.encodeFunctionData('executeArbitrage', [
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
    } catch (error) {
      // estimateGas failure usually indicates the tx would revert on-chain
      getProviderLogger().warn('estimateGas failed, using fallback (tx may revert)', {
        provider: 'aave-v3', chain: this.chain, fallbackGas: 500000,
        error: (error as Error).message,
      });
      return 500000n;
    }
  }

  /**
   * Validate a flash loan request before execution
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
   * Get the pool address for this provider
   */
  getPoolAddress(): string {
    return this.poolAddress;
  }
}
