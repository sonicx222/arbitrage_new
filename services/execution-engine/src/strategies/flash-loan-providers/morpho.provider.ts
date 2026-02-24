/**
 * Morpho Blue Flash Loan Provider
 *
 * Morpho Blue provides zero-fee flash loans via EIP-3156 compliant interface.
 * Available on Ethereum and Base with the same deterministic contract address.
 *
 * Key characteristics:
 * - Fee: 0% (zero-fee) — the most cost-effective flash loan source
 * - EIP-3156 compliant interface (flashLoan callback: onFlashLoan)
 * - Available on Ethereum and Base
 * - Singleton contract per chain (CREATE2 deterministic address)
 *
 * Contract: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb (Ethereum + Base)
 *
 * @see https://docs.morpho.org/morpho/contracts/addresses
 * @see contracts/src/SyncSwapFlashArbitrage.sol (same EIP-3156 callback pattern)
 */

import { ethers } from 'ethers';
import { getSwapDeadline } from '../base.strategy';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';
import { validateFlashLoanRequest } from './validation-utils';

/**
 * Morpho Blue flash loan fee: 0 basis points (zero-fee)
 */
const MORPHO_FEE_BPS = 0;

/**
 * Chains that support Morpho Blue flash loans
 */
const MORPHO_SUPPORTED_CHAINS = new Set(['ethereum', 'base']);

/**
 * Morpho Blue ABI - only the functions needed for flash loans.
 * EIP-3156 compliant: flashLoan(receiver, token, amount, data)
 */
const MORPHO_FLASH_ABI = [
  'function flashLoan(address token, uint256 assets, bytes calldata data) external',
];

/**
 * Cached ethers.Interface for hot-path optimization.
 */
const MORPHO_FLASH_INTERFACE = new ethers.Interface(MORPHO_FLASH_ABI);

/**
 * Morpho Blue Flash Loan Provider
 *
 * Implements zero-fee flash loans via Morpho Blue's EIP-3156 interface.
 * Uses the same onFlashLoan callback pattern as SyncSwap.
 */
export class MorphoFlashLoanProvider implements IFlashLoanProvider {
  readonly protocol: FlashLoanProtocol = 'morpho';
  readonly chain: string;
  readonly poolAddress: string; // Morpho Blue contract address

  private readonly contractAddress: string;
  private readonly approvedRouters: string[];
  private readonly approvedRoutersSet: Set<string>;
  private readonly feeOverride?: number;

  constructor(config: {
    chain: string;
    poolAddress: string; // Morpho Blue address
    contractAddress: string; // Arbitrage contract address
    approvedRouters: string[];
    feeOverride?: number;
  }) {
    this.chain = config.chain;
    this.poolAddress = config.poolAddress;
    this.contractAddress = config.contractAddress;
    this.approvedRouters = config.approvedRouters;
    this.approvedRoutersSet = new Set(config.approvedRouters.map(r => r.toLowerCase()));
    this.feeOverride = config.feeOverride;

    if (!ethers.isAddress(config.contractAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid contract address for Morpho provider on ${config.chain}`);
    }
    if (!ethers.isAddress(config.poolAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid Morpho Blue address for provider on ${config.chain}`);
    }
  }

  /**
   * Check if provider is available for use.
   * Only available on Ethereum and Base with a valid contract.
   */
  isAvailable(): boolean {
    if (this.contractAddress === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    return MORPHO_SUPPORTED_CHAINS.has(this.chain);
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): FlashLoanProviderCapabilities {
    return {
      supportsMultiHop: true,
      supportsMultiAsset: false,
      maxLoanAmount: 0n, // Depends on Morpho Blue market liquidity
      supportedTokens: [], // Supports any token with Morpho Blue market liquidity
      status: 'fully_supported',
    };
  }

  /**
   * Calculate flash loan fee for an amount.
   *
   * Morpho Blue flash loan fee: 0 bps (zero-fee) — the lowest possible.
   *
   * @param amount - Loan amount in wei
   * @returns Fee information
   */
  calculateFee(amount: bigint): FlashLoanFeeInfo {
    const feeBps = this.feeOverride ?? MORPHO_FEE_BPS;
    // Zero fee: feeAmount is always 0n unless overridden
    const feeAmount = feeBps === 0 ? 0n : (amount * BigInt(feeBps)) / 10000n;

    return {
      feeBps,
      feeAmount,
      protocol: this.protocol,
    };
  }

  /**
   * Build the transaction calldata for Morpho flash loan execution.
   *
   * Morpho Blue uses: flashLoan(token, assets, data)
   * The receiver is msg.sender (arbitrage contract calls Morpho directly).
   * Morpho calls back onMorphoFlashLoan(assets, data) on the caller.
   *
   * @param request - Flash loan request parameters
   * @returns Encoded calldata for the transaction
   */
  buildCalldata(request: FlashLoanRequest): string {
    const swapPathTuples = request.swapPath.map(step => [
      step.router,
      step.tokenIn,
      step.tokenOut,
      step.amountOutMin,
    ]);

    const deadline = getSwapDeadline();

    // Encode the inner data that the onFlashLoan callback will decode
    const innerData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(address,address,address,uint256)[]', 'uint256', 'uint256'],
      [swapPathTuples, request.minProfit, deadline]
    );

    // Encode the outer flashLoan call to Morpho Blue
    return MORPHO_FLASH_INTERFACE.encodeFunctionData('flashLoan', [
      request.asset,    // token
      request.amount,   // assets
      innerData,        // data (swap path + minProfit + deadline)
    ]);
  }

  /**
   * Build the complete transaction request
   */
  buildTransaction(
    request: FlashLoanRequest,
    from: string
  ): ethers.TransactionRequest {
    return {
      to: this.poolAddress, // Call goes to Morpho Blue directly
      data: this.buildCalldata(request),
      from,
    };
  }

  /**
   * Estimate gas for Morpho flash loan execution
   */
  async estimateGas(
    request: FlashLoanRequest,
    provider: ethers.JsonRpcProvider
  ): Promise<bigint> {
    const tx = this.buildTransaction(request, request.initiator);

    try {
      return await provider.estimateGas(tx);
    } catch {
      // Default gas estimate for Morpho flash loan + multi-hop swaps
      return 400000n;
    }
  }

  /**
   * Validate a flash loan request before execution.
   *
   * Morpho-specific checks:
   * - Chain must be ethereum or base
   */
  validate(request: FlashLoanRequest): { valid: boolean; error?: string } {
    if (!MORPHO_SUPPORTED_CHAINS.has(request.chain)) {
      return {
        valid: false,
        error: `[ERR_CHAIN_NOT_SUPPORTED] Morpho Blue flash loans only available on ethereum and base, got: ${request.chain}`,
      };
    }

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
   * Get the Morpho Blue contract address
   */
  getMorphoBlueAddress(): string {
    return this.poolAddress;
  }
}
