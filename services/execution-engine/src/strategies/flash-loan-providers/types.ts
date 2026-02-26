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
 *
 * Imported from @arbitrage/types (canonical source of truth).
 */
import type { FlashLoanProtocol } from '@arbitrage/types';
export type { FlashLoanProtocol } from '@arbitrage/types';

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
  /**
   * Optional pool address for protocols that require runtime pool selection
   * (e.g., PancakeSwap V3 with multiple fee tiers)
   * @optional
   */
  poolAddress?: string;
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
 *
 * I8 Enhancement: Fee format documentation for cross-module clarity.
 *
 * Fee Format: Basis Points (bps)
 * - 1 bps = 0.01% (one hundredth of a percent)
 * - 100 bps = 1%
 * - Examples:
 *   * Aave V3: 9 bps = 0.09%
 *   * PancakeSwap V3 (1% tier): 100 bps = 1%
 *   * Uniswap V3 (0.3% tier): 30 bps = 0.3%
 *
 * Configuration Files:
 * - service-config.ts: Use integer basis points (9, not 0.09)
 * - Smart contracts: Use basis points with BPS_DENOMINATOR = 10000
 *
 * @see shared/config/src/service-config.ts Centralized fee constants
 * @see contracts/src/ Smart contract fee implementations
 */
export interface FlashLoanFeeInfo {
  /** Fee in basis points (100 = 1%). Always integer, never decimal. */
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

  /**
   * Get the contract address for this provider
   */
  getContractAddress(): string;

  /**
   * Get a copy of the approved router addresses
   */
  getApprovedRouters(): string[];
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
  /**
   * Protocol overrides per chain (takes precedence over FLASH_LOAN_PROVIDERS).
   * Used to prefer cheaper protocols (e.g., Balancer V2 at 0% over Aave V3 at 0.09%)
   * when the corresponding contract is deployed.
   */
  providerOverrides?: Record<string, { address: string; protocol: string; fee: number }>;
}
