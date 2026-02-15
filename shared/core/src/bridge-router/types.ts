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
 * @see shared/core/src/bridge-router/ for implementation
 */

import { ethers } from 'ethers';

// =============================================================================
// Bridge Configuration
// =============================================================================

/**
 * Supported bridge protocols.
 * @see shared/config/src/bridge-config.ts for route configuration, costs, and latencies
 */
export type BridgeProtocol = 'stargate' | 'stargate-v2' | 'native' | 'across' | 'wormhole' | 'connext' | 'hyperlane';

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
  /** Stargate V2 transfer mode: 'bus' (batched, cheaper) or 'taxi' (immediate) */
  transferMode?: 'bus' | 'taxi';
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
  /**
   * Total native gas cost in wei. Represents the LayerZero/relayer fee only.
   * bridgeFee is already deducted from amountOut and is denominated in the bridged
   * token, so it cannot be summed with this native-token value.
   * @deprecated Prefer using gasFee directly for clarity. totalFee === gasFee.
   */
  totalFee: string;
  /** Estimated delivery time in seconds */
  estimatedTimeSeconds: number;
  /** Quote expiry timestamp */
  expiresAt: number;
  /** Quote validity (true if route is available) */
  valid: boolean;
  /** Error message if not valid */
  error?: string;
  /** Destination address for bridged tokens. Defaults to sender if not specified. */
  recipient?: string;
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

  /**
   * Dispose resources held by the router (timers, connections, etc.).
   * Called during engine shutdown to prevent resource leaks.
   */
  dispose(): void;
}

/**
 * Per-bridge health metrics tracked by BridgeRouterFactory.
 * Updated on each healthCheckAll() call.
 */
export interface BridgeHealthMetrics {
  /** Total number of health checks performed */
  totalChecks: number;
  /** Number of successful (healthy) checks */
  successfulChecks: number;
  /** Number of failed (unhealthy) checks */
  failedChecks: number;
  /** Whether the last health check was healthy */
  lastHealthy: boolean;
  /** Timestamp of the last health check */
  lastCheckTime: number;
  /** Last health check message */
  lastMessage: string;
}

/**
 * Per-bridge execution metrics tracked by BridgeRouterFactory.
 * Updated via recordExecution() calls from bridge operation consumers.
 */
export interface BridgeExecutionMetrics {
  /** Total quote() attempts */
  quoteAttempts: number;
  /** Successful quote() calls (valid: true) */
  quoteSuccesses: number;
  /** Failed quote() calls (valid: false or exception) */
  quoteFailures: number;
  /** Total execute() attempts */
  executeAttempts: number;
  /** Successful execute() calls */
  executeSuccesses: number;
  /** Failed execute() calls */
  executeFailures: number;
  /** Cumulative latency in ms across all operations */
  totalLatencyMs: number;
  /** Timestamp of last recorded operation */
  lastExecutionTime: number;
}

/**
 * Pool liquidity alert emitted when pool balance crosses a threshold.
 * Used for V1 Stargate pool degradation monitoring.
 *
 * @see StargateRouter.checkPoolLiquidity() for alert trigger logic
 */
export interface PoolLiquidityAlert {
  /** Bridge protocol that detected low liquidity */
  protocol: BridgeProtocol;
  /** Chain where low liquidity was detected */
  chain: string;
  /** Token with low liquidity */
  token: string;
  /** Current balance in USD */
  balanceUsd: number;
  /** Threshold that was crossed (USD) */
  threshold: number;
  /** Alert severity: warning (< threshold) or critical (< threshold/10) */
  severity: 'warning' | 'critical';
  /** Alert timestamp (ms since epoch) */
  timestamp: number;
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
 * Stargate V1 LayerZero chain IDs.
 * Note: zkSync and Linea are NOT supported by Stargate V1.
 * Cross-chain opportunities involving these chains are detected
 * but cannot be bridged via Stargate. Use Across or native bridges instead.
 * @see shared/config/src/bridge-config.ts for alternative bridge routes
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
 * Average bridge times in seconds per route (Stargate/LayerZero).
 *
 * These values should be kept in sync with bridge-config.ts route latencies.
 * @see shared/config/src/bridge-config.ts
 */
export const BRIDGE_TIMES: Record<string, number> = {
  'ethereum-arbitrum': 180,    // ~3 minutes (Stargate via LayerZero)
  'ethereum-optimism': 180,    // ~3 minutes
  'ethereum-base': 180,        // ~3 minutes
  'ethereum-polygon': 180,     // ~3 minutes
  'arbitrum-ethereum': 180,    // ~3 minutes (Stargate, not native bridge)
  'arbitrum-optimism': 90,     // ~1.5 minutes (L2-to-L2)
  'arbitrum-base': 90,         // ~1.5 minutes (L2-to-L2)
  'optimism-ethereum': 180,    // ~3 minutes
  'optimism-arbitrum': 90,     // ~1.5 minutes (L2-to-L2)
  'base-ethereum': 180,        // ~3 minutes
  'base-arbitrum': 90,         // ~1.5 minutes (L2-to-L2)
  default: 180,                // 3 minutes default
};
