/**
 * DAI Flash Mint Provider
 *
 * Flash minting creates DAI within a single transaction via MakerDAO's DssFlash module.
 * Unlike pool-based flash loans, this mints DAI directly (no liquidity constraints).
 *
 * Key characteristics:
 * - Fee: 0.01% (1 basis point) — lowest of any flash loan source
 * - No liquidity constraint (mints fresh DAI)
 * - Ethereum mainnet only (DAI's DssPause/flash module is Ethereum-only)
 * - EIP-3156 compliant interface
 *
 * Contract: 0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853 (DssFlash on Ethereum)
 *
 * @see https://docs.makerdao.com/smart-contract-modules/flash-mint-module
 */

import { ethers } from 'ethers';
import { getBpsDenominatorBigInt } from '@arbitrage/config';
import { getSwapDeadline } from '../base.strategy';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';
import { validateFlashLoanRequest, getProviderLogger } from './validation-utils';

/**
 * DAI Flash Mint fee: 1 basis point (0.01%)
 */
const DAI_FLASH_MINT_FEE_BPS = 1;

/**
 * DAI token address on Ethereum mainnet
 */
const DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

/**
 * DssFlash ABI - only the functions needed for flash minting.
 * EIP-3156 compliant: flashLoan(receiver, token, amount, data)
 */
const DSS_FLASH_ABI = [
  'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool)',
  'function maxFlashLoan(address token) external view returns (uint256)',
  'function flashFee(address token, uint256 amount) external view returns (uint256)',
];

/**
 * Cached ethers.Interface for hot-path optimization.
 */
const DSS_FLASH_INTERFACE = new ethers.Interface(DSS_FLASH_ABI);

/**
 * DAI Flash Mint Provider
 *
 * Implements flash minting via MakerDAO's DssFlash module.
 * Only supports DAI on Ethereum mainnet.
 */
export class DaiFlashMintProvider implements IFlashLoanProvider {
  readonly protocol: FlashLoanProtocol = 'dai_flash_mint';
  readonly chain: string;
  readonly poolAddress: string; // DssFlash contract address

  private readonly contractAddress: string;
  private readonly approvedRouters: string[];
  private readonly approvedRoutersSet: Set<string>;
  private readonly feeOverride?: number;

  constructor(config: {
    chain: string;
    poolAddress: string; // DssFlash address
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
      throw new Error(`[ERR_CONFIG] Invalid contract address for DAI Flash Mint provider on ${config.chain}`);
    }
    if (!ethers.isAddress(config.poolAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid DssFlash address for DAI Flash Mint provider on ${config.chain}`);
    }
  }

  /**
   * Check if provider is available for use.
   * Only available on Ethereum with a valid contract.
   */
  isAvailable(): boolean {
    if (this.contractAddress === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    return this.chain === 'ethereum';
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): FlashLoanProviderCapabilities {
    return {
      supportsMultiHop: true,
      supportsMultiAsset: false, // Only DAI can be flash minted
      maxLoanAmount: 0n, // Governed by MakerDAO debt ceiling (typically very high)
      supportedTokens: [DAI_ADDRESS],
      status: 'fully_supported',
    };
  }

  /**
   * Calculate flash loan fee for an amount.
   *
   * DAI flash mint fee: 1 bps (0.01%) — the lowest available.
   *
   * @param amount - Loan amount in wei
   * @returns Fee information
   */
  calculateFee(amount: bigint): FlashLoanFeeInfo {
    const feeBps = this.feeOverride ?? DAI_FLASH_MINT_FEE_BPS;
    const feeAmount = (amount * BigInt(feeBps)) / getBpsDenominatorBigInt();

    return {
      feeBps,
      feeAmount,
      protocol: this.protocol,
    };
  }

  /**
   * Build the transaction calldata for flash mint execution.
   *
   * Uses EIP-3156 flashLoan interface on DssFlash contract.
   * The receiver is the arbitrage contract which implements onFlashLoan callback.
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

    // Encode the outer flashLoan call to DssFlash
    return DSS_FLASH_INTERFACE.encodeFunctionData('flashLoan', [
      this.contractAddress, // receiver (arbitrage contract)
      request.asset,        // token (DAI)
      request.amount,       // amount
      innerData,            // data (swap path + minProfit + deadline)
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
      to: this.poolAddress, // Call goes to DssFlash directly
      data: this.buildCalldata(request),
      from,
    };
  }

  /**
   * Estimate gas for flash mint execution
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
        provider: 'dai-flash-mint', chain: this.chain, fallbackGas: 450000,
        error: (error as Error).message,
      });
      return 450000n;
    }
  }

  /**
   * Validate a flash loan request before execution.
   *
   * Additional DAI-specific checks:
   * - Asset must be DAI
   * - Chain must be ethereum
   */
  validate(request: FlashLoanRequest): { valid: boolean; error?: string } {
    // DAI-specific: only DAI can be flash minted
    if (request.asset.toLowerCase() !== DAI_ADDRESS.toLowerCase()) {
      return {
        valid: false,
        error: `[ERR_ASSET_NOT_DAI] DAI Flash Mint only supports DAI (${DAI_ADDRESS}), got: ${request.asset}`,
      };
    }

    // DAI-specific: only Ethereum mainnet
    if (request.chain !== 'ethereum') {
      return {
        valid: false,
        error: `[ERR_CHAIN_NOT_SUPPORTED] DAI Flash Mint is only available on Ethereum, got: ${request.chain}`,
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
   * Get the DssFlash contract address
   */
  getDssFlashAddress(): string {
    return this.poolAddress;
  }
}
