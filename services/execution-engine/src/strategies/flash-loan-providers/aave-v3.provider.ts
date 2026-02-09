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
  BPS_DENOMINATOR_BIGINT,
  FLASH_LOAN_ARBITRAGE_ABI,
} from '@arbitrage/config';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';

// Fix 1.1: Use centralized constant, alias for local readability
const BPS_DENOMINATOR = BPS_DENOMINATOR_BIGINT;

/**
 * Cached ethers.Interface for hot-path optimization.
 * Creating Interface objects is expensive - cache at module level.
 *
 * Fix 9.2: Uses centralized FLASH_LOAN_ARBITRAGE_ABI from @arbitrage/config.
 * @see service-config.ts for full ABI documentation
 */
const FLASH_LOAN_INTERFACE = new ethers.Interface(FLASH_LOAN_ARBITRAGE_ABI);

/**
 * Default deadline for flash loan execution (5 minutes from now).
 * This protects against stale transactions being mined in poor market conditions.
 * Matches industry standard used by Uniswap, Sushiswap, etc.
 */
const DEFAULT_DEADLINE_SECONDS = 300;

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
   * @param amount - Loan amount in wei
   * @returns Fee information
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

    // Calculate deadline: current time + 5 minutes
    // This protects against stale transactions (FlashLoanArbitrage.sol v1.2.0)
    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS;

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
    } catch {
      // Default gas estimate for flash loan arbitrage
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
    // Check chain matches
    if (request.chain !== this.chain) {
      return {
        valid: false,
        error: `[ERR_CHAIN_MISMATCH] Request chain '${request.chain}' does not match provider chain '${this.chain}'`,
      };
    }

    // Check asset is valid address
    if (!ethers.isAddress(request.asset)) {
      return {
        valid: false,
        error: '[ERR_INVALID_ASSET] Invalid asset address',
      };
    }

    // Check amount is non-zero
    if (request.amount === 0n) {
      return {
        valid: false,
        error: '[ERR_ZERO_AMOUNT] Flash loan amount cannot be zero',
      };
    }

    // Check swap path is not empty
    if (request.swapPath.length === 0) {
      return {
        valid: false,
        error: '[ERR_EMPTY_PATH] Swap path cannot be empty',
      };
    }

    // Check all routers in path are approved
    for (const step of request.swapPath) {
      if (!ethers.isAddress(step.router)) {
        return {
          valid: false,
          error: `[ERR_INVALID_ROUTER] Invalid router address: ${step.router}`,
        };
      }

      // Only validate against approved routers if the list is non-empty
      if (this.approvedRouters.length > 0) {
        const isApproved = this.approvedRouters.some(
          r => r.toLowerCase() === step.router.toLowerCase()
        );
        if (!isApproved) {
          return {
            valid: false,
            error: `[ERR_UNAPPROVED_ROUTER] Router not approved: ${step.router}`,
          };
        }
      }
    }

    // Check swap path forms a valid cycle (ends with same token as starts)
    const firstToken = request.swapPath[0].tokenIn;
    const lastToken = request.swapPath[request.swapPath.length - 1].tokenOut;
    if (firstToken.toLowerCase() !== lastToken.toLowerCase()) {
      return {
        valid: false,
        error: '[ERR_INVALID_CYCLE] Swap path must end with the same token it starts with',
      };
    }

    // Check first token matches asset
    if (firstToken.toLowerCase() !== request.asset.toLowerCase()) {
      return {
        valid: false,
        error: '[ERR_ASSET_MISMATCH] First swap token must match flash loan asset',
      };
    }

    return { valid: true };
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
}
