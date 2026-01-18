/**
 * Bridge Router Types
 *
 * Phase 3: Cross-Chain Execution Support
 *
 * Defines interfaces for cross-chain bridge operations supporting:
 * - Stargate (LayerZero) - Primary bridge for major chains
 * - Native bridges (Arbitrum, Optimism, Base)
 * - Future bridge integrations
 *
 * @see ADR-014: Cross-Chain Execution Design
 */

import { ethers } from 'ethers';

// =============================================================================
// Bridge Configuration
// =============================================================================

/**
 * Supported bridge protocols
 */
export type BridgeProtocol = 'stargate' | 'native' | 'hop' | 'across' | 'celer';

/**
 * Bridge transaction status
 */
export type BridgeStatus =
  | 'pending'      // Transaction submitted, awaiting source chain confirmation
  | 'bridging'     // Source confirmed, waiting for destination delivery
  | 'completed'    // Successfully delivered to destination
  | 'failed'       // Bridge failed (reverted, timeout, etc.)
  | 'refunded';    // Failed and refunded to source

/**
 * Chain configuration for bridge operations
 */
export interface BridgeChainConfig {
  chainId: number;
  name: string;
  /** LayerZero chain ID (different from EVM chain ID) */
  lzChainId?: number;
  /** Stargate pool IDs per token */
  stargatePoolIds?: Record<string, number>;
  /** Native bridge contract address */
  nativeBridgeAddress?: string;
  /** Average bridge time in seconds */
  avgBridgeTimeSeconds: number;
}

/**
 * Token configuration for bridge
 */
export interface BridgeTokenConfig {
  symbol: string;
  /** Token address per chain (chain name -> address) */
  addresses: Record<string, string>;
  /** Stargate pool ID per chain */
  stargatePoolIds?: Record<string, number>;
  /** Minimum bridge amount in token units */
  minAmount: string;
  /** Maximum bridge amount in token units */
  maxAmount: string;
}

// =============================================================================
// Bridge Request/Response Types
// =============================================================================

/**
 * Quote request for bridge operation
 */
export interface BridgeQuoteRequest {
  /** Source chain name (e.g., 'ethereum', 'arbitrum') */
  sourceChain: string;
  /** Destination chain name */
  destChain: string;
  /** Token symbol or address */
  token: string;
  /** Amount to bridge in wei */
  amount: string;
  /** Recipient address on destination (defaults to sender) */
  recipient?: string;
  /** Slippage tolerance (0-1, e.g., 0.005 for 0.5%) */
  slippage?: number;
}

/**
 * Quote response from bridge
 */
export interface BridgeQuote {
  /** Bridge protocol used */
  protocol: BridgeProtocol;
  /** Source chain */
  sourceChain: string;
  /** Destination chain */
  destChain: string;
  /** Token being bridged */
  token: string;
  /** Input amount in wei */
  amountIn: string;
  /** Expected output amount in wei (after fees) */
  amountOut: string;
  /** Bridge fee in wei */
  bridgeFee: string;
  /** LayerZero/native gas fee in wei */
  gasFee: string;
  /** Total cost (bridgeFee + gasFee) in wei */
  totalFee: string;
  /** Estimated delivery time in seconds */
  estimatedTimeSeconds: number;
  /** Quote expiry timestamp */
  expiresAt: number;
  /** Quote validity (true if route is available) */
  valid: boolean;
  /** Error message if not valid */
  error?: string;
}

/**
 * Bridge execution request
 */
export interface BridgeExecuteRequest {
  /** Quote to execute */
  quote: BridgeQuote;
  /** Wallet to execute from */
  wallet: ethers.Wallet;
  /** Provider for source chain */
  provider: ethers.Provider;
  /** Pre-allocated nonce (from NonceManager) */
  nonce?: number;
  /** Deadline timestamp (bridge fails if not initiated by this time) */
  deadline?: number;
}

/**
 * Bridge execution result
 */
export interface BridgeExecuteResult {
  /** Whether execution was initiated successfully */
  success: boolean;
  /** Source chain transaction hash */
  sourceTxHash?: string;
  /** Bridge tracking ID (for status monitoring) */
  bridgeId?: string;
  /** Error message if failed */
  error?: string;
  /** Gas used on source chain */
  gasUsed?: bigint;
}

/**
 * Bridge status check result
 */
export interface BridgeStatusResult {
  /** Current bridge status */
  status: BridgeStatus;
  /** Source chain transaction hash */
  sourceTxHash: string;
  /** Destination chain transaction hash (when completed) */
  destTxHash?: string;
  /** Amount received on destination (when completed) */
  amountReceived?: string;
  /** Timestamp of last status update */
  lastUpdated: number;
  /** Estimated completion time (if still pending/bridging) */
  estimatedCompletion?: number;
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Bridge Router Interface
// =============================================================================

/**
 * Interface for cross-chain bridge routers
 *
 * Implementations should:
 * - Support multiple token types
 * - Handle fee estimation accurately
 * - Provide reliable status tracking
 * - Implement timeout handling
 */
export interface IBridgeRouter {
  /** Bridge protocol name */
  readonly protocol: BridgeProtocol;

  /** Supported source chains */
  readonly supportedSourceChains: string[];

  /** Supported destination chains */
  readonly supportedDestChains: string[];

  /**
   * Get a quote for bridging tokens
   */
  quote(request: BridgeQuoteRequest): Promise<BridgeQuote>;

  /**
   * Execute a bridge transaction
   */
  execute(request: BridgeExecuteRequest): Promise<BridgeExecuteResult>;

  /**
   * Check status of a bridge operation
   */
  getStatus(bridgeId: string): Promise<BridgeStatusResult>;

  /**
   * Check if a route is supported
   */
  isRouteSupported(sourceChain: string, destChain: string, token: string): boolean;

  /**
   * Get estimated bridge time for a route
   */
  getEstimatedTime(sourceChain: string, destChain: string): number;

  /**
   * Health check for the bridge service
   */
  healthCheck(): Promise<{ healthy: boolean; message: string }>;
}

// =============================================================================
// Cross-Chain Execution Types
// =============================================================================

/**
 * Cross-chain arbitrage execution plan
 */
export interface CrossChainExecutionPlan {
  /** Unique plan ID */
  id: string;
  /** Buy side details */
  buy: {
    chain: string;
    dex: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    expectedAmountOut: string;
  };
  /** Bridge details */
  bridge: {
    protocol: BridgeProtocol;
    sourceChain: string;
    destChain: string;
    token: string;
    amount: string;
    quote: BridgeQuote;
  };
  /** Sell side details */
  sell: {
    chain: string;
    dex: string;
    tokenIn: string;
    tokenOut: string;
    expectedAmountIn: string;
    expectedAmountOut: string;
  };
  /** Total expected profit after all fees */
  expectedProfit: string;
  /** Plan creation timestamp */
  createdAt: number;
  /** Plan expiry timestamp */
  expiresAt: number;
}

/**
 * Cross-chain execution result
 */
export interface CrossChainExecutionResult {
  /** Plan that was executed */
  planId: string;
  /** Overall success */
  success: boolean;
  /** Buy side result */
  buyResult?: {
    txHash: string;
    amountOut: string;
    gasUsed: bigint;
  };
  /** Bridge result */
  bridgeResult?: {
    bridgeId: string;
    sourceTxHash: string;
    destTxHash?: string;
    amountReceived?: string;
  };
  /** Sell side result */
  sellResult?: {
    txHash: string;
    amountOut: string;
    gasUsed: bigint;
  };
  /** Actual profit realized */
  actualProfit?: string;
  /** Total gas cost across all chains */
  totalGasCost?: string;
  /** Error message if failed */
  error?: string;
  /** Stage where failure occurred */
  failedStage?: 'buy' | 'bridge' | 'sell';
  /** Total execution time in ms */
  executionTimeMs: number;
}

// =============================================================================
// Configuration Constants
// =============================================================================

/**
 * Default bridge configuration
 */
export const BRIDGE_DEFAULTS = {
  /** Default slippage tolerance (0.5%) */
  slippage: 0.005,
  /** Quote validity period (5 minutes) */
  quoteValidityMs: 5 * 60 * 1000,
  /** Maximum bridge wait time (15 minutes) */
  maxBridgeWaitMs: 15 * 60 * 1000,
  /** Status poll interval (10 seconds) */
  statusPollIntervalMs: 10 * 1000,
  /** Maximum retries for status checks */
  maxStatusRetries: 90, // 15 minutes at 10s intervals
};

/**
 * Stargate chain IDs (LayerZero format)
 */
export const STARGATE_CHAIN_IDS: Record<string, number> = {
  ethereum: 101,
  bsc: 102,
  avalanche: 106,
  polygon: 109,
  arbitrum: 110,
  optimism: 111,
  fantom: 112,
  base: 184,
};

/**
 * Stargate pool IDs for common tokens
 */
export const STARGATE_POOL_IDS: Record<string, Record<string, number>> = {
  USDC: {
    ethereum: 1,
    bsc: 1,
    avalanche: 1,
    polygon: 1,
    arbitrum: 1,
    optimism: 1,
    fantom: 1,
    base: 1,
  },
  USDT: {
    ethereum: 2,
    bsc: 2,
    avalanche: 2,
    polygon: 2,
    arbitrum: 2,
    optimism: 2,
    fantom: 2,
  },
  ETH: {
    ethereum: 13,
    arbitrum: 13,
    optimism: 13,
    base: 13,
  },
};

/**
 * Stargate router contract addresses
 */
export const STARGATE_ROUTER_ADDRESSES: Record<string, string> = {
  ethereum: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',
  bsc: '0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8',
  avalanche: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
  polygon: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
  arbitrum: '0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614',
  optimism: '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',
  fantom: '0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6',
  base: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
};

/**
 * Average bridge times in seconds per route
 */
export const BRIDGE_TIMES: Record<string, number> = {
  'ethereum-arbitrum': 600,    // ~10 minutes
  'ethereum-optimism': 300,    // ~5 minutes
  'ethereum-base': 300,        // ~5 minutes
  'ethereum-polygon': 180,     // ~3 minutes
  'arbitrum-ethereum': 600,    // ~10 minutes (includes challenge period)
  'arbitrum-optimism': 120,    // ~2 minutes
  'arbitrum-base': 120,        // ~2 minutes
  'optimism-ethereum': 600,    // ~10 minutes
  'optimism-arbitrum': 120,    // ~2 minutes
  'base-ethereum': 600,        // ~10 minutes
  'base-arbitrum': 120,        // ~2 minutes
  default: 300,                // 5 minutes default
};
