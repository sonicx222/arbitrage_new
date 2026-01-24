/**
 * Flash Loan Provider Types
 *
 * Defines the interface for flash loan providers, enabling support for
 * multiple protocols (Aave V3, PancakeSwap, SpookySwap, SyncSwap).
 *
 * Fix 1.1: Protocol adapter architecture to resolve the mismatch between
 * FLASH_LOAN_PROVIDERS config (which defines multiple protocols) and
 * FlashLoanStrategy (which only supported Aave V3).
 *
 * @see service-config.ts FLASH_LOAN_PROVIDERS
 * @see flash-loan.strategy.ts
 */

import { ethers } from 'ethers';

/**
 * Supported flash loan protocols
 */
export type FlashLoanProtocol =
  | 'aave_v3'
  | 'pancakeswap_v3'
  | 'spookyswap'
  | 'syncswap';

/**
 * Protocol support status
 */
export type ProtocolSupportStatus =
  | 'fully_supported'    // Full implementation with contract
  | 'partial_support'    // Provider exists but limited functionality
  | 'not_implemented';   // Placeholder only

/**
 * Flash loan request parameters
 */
export interface FlashLoanRequest {
  /** Asset to borrow */
  asset: string;
  /** Amount to borrow (in wei) */
  amount: bigint;
  /** Chain identifier */
  chain: string;
  /** Swap path for arbitrage execution */
  swapPath: FlashLoanSwapStep[];
  /** Minimum profit required (in asset units) */
  minProfit: bigint;
  /** Caller address (for validation) */
  initiator: string;
}

/**
 * Swap step in the arbitrage path
 */
export interface FlashLoanSwapStep {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountOutMin: bigint;
}

/**
 * Flash loan execution result
 */
export interface FlashLoanResult {
  success: boolean;
  transactionHash?: string;
  receipt?: ethers.TransactionReceipt;
  error?: string;
  gasUsed?: bigint;
  actualProfit?: bigint;
  /** Protocol used for execution */
  protocol: FlashLoanProtocol;
}

/**
 * Flash loan fee information
 */
export interface FlashLoanFeeInfo {
  /** Fee in basis points (100 = 1%) */
  feeBps: number;
  /** Fee amount for given loan amount (in wei) */
  feeAmount: bigint;
  /** Protocol name */
  protocol: FlashLoanProtocol;
}

/**
 * Provider capabilities
 */
export interface FlashLoanProviderCapabilities {
  /** Whether the provider supports multi-hop paths */
  supportsMultiHop: boolean;
  /** Whether the provider supports multiple assets in one loan */
  supportsMultiAsset: boolean;
  /** Maximum loan amount (0 = unlimited, depends on liquidity) */
  maxLoanAmount: bigint;
  /** Supported tokens (empty = all tokens supported) */
  supportedTokens: string[];
  /** Implementation status */
  status: ProtocolSupportStatus;
}

/**
 * Flash loan provider interface
 *
 * Each protocol implements this interface to provide consistent
 * flash loan functionality across different DeFi protocols.
 */
export interface IFlashLoanProvider {
  /** Protocol identifier */
  readonly protocol: FlashLoanProtocol;

  /** Chain this provider is configured for */
  readonly chain: string;

  /** Protocol pool/router address */
  readonly poolAddress: string;

  /**
   * Check if provider is available for use
   */
  isAvailable(): boolean;

  /**
   * Get provider capabilities
   */
  getCapabilities(): FlashLoanProviderCapabilities;

  /**
   * Calculate flash loan fee for an amount
   *
   * @param amount - Loan amount in wei
   * @returns Fee information
   */
  calculateFee(amount: bigint): FlashLoanFeeInfo;

  /**
   * Build the transaction calldata for flash loan execution
   *
   * @param request - Flash loan request parameters
   * @returns Encoded calldata for the transaction
   */
  buildCalldata(request: FlashLoanRequest): string;

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
  ): ethers.TransactionRequest;

  /**
   * Estimate gas for flash loan execution
   *
   * @param request - Flash loan request parameters
   * @param provider - JSON-RPC provider for estimation
   * @returns Estimated gas units
   */
  estimateGas(
    request: FlashLoanRequest,
    provider: ethers.JsonRpcProvider
  ): Promise<bigint>;

  /**
   * Validate a flash loan request before execution
   *
   * @param request - Flash loan request to validate
   * @returns Validation result with error message if invalid
   */
  validate(request: FlashLoanRequest): { valid: boolean; error?: string };
}

/**
 * Configuration for flash loan provider factory
 */
export interface FlashLoanProviderConfig {
  /** FlashLoanArbitrage contract addresses per chain (for Aave V3) */
  contractAddresses: Record<string, string>;
  /** Approved DEX routers per chain */
  approvedRouters: Record<string, string[]>;
  /** Custom fee overrides per chain (basis points) */
  feeOverrides?: Record<string, number>;
}
