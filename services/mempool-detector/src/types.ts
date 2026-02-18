/**
 * Mempool Detector Types
 *
 * Type definitions for pending transaction detection and decoding.
 * Used by the mempool detector service to process pending transactions
 * from bloXroute BDN and other mempool data providers.
 *
 * @see Phase 1: Mempool Detection Service (Implementation Plan v3.0)
 */

// =============================================================================
// PENDING TRANSACTION TYPES
// =============================================================================

/**
 * Supported swap router types.
 * Used to identify which decoder to use for transaction data.
 */
export type SwapRouterType =
  | 'uniswapV2'
  | 'uniswapV3'
  | 'sushiswap'
  | 'curve'
  | '1inch'
  | 'pancakeswap';

/**
 * Decoded pending swap intent extracted from a pending transaction.
 * Represents the user's intent before the transaction is included in a block.
 *
 * NOTE: This local type uses `bigint` for amount fields (amountIn, gasPrice, etc.)
 * for precise arithmetic operations during transaction processing.
 *
 * For Redis publishing/JSON serialization, use the shared @arbitrage/types PendingSwapIntent
 * which uses `string` for these fields. Use toSerializableIntent() in index.ts to convert.
 *
 * @see @arbitrage/types PendingSwapIntent - serializable version for cross-service communication
 * @see toSerializableIntent() - conversion function in index.ts
 */
export interface PendingSwapIntent {
  /** Transaction hash of the pending transaction */
  hash: string;
  /** Router contract address */
  router: string;
  /** Identified router/DEX type */
  type: SwapRouterType;
  /** Input token address */
  tokenIn: string;
  /** Output token address */
  tokenOut: string;
  /** Input amount in wei */
  amountIn: bigint;
  /** Expected minimum output amount in wei */
  expectedAmountOut: bigint;
  /** Token path for multi-hop swaps */
  path: string[];
  /** Slippage tolerance as decimal (e.g., 0.005 = 0.5%) */
  slippageTolerance: number;
  /** Transaction deadline timestamp */
  deadline: number;
  /** Sender address */
  sender: string;
  /** Gas price in wei */
  gasPrice: bigint;
  /** Max fee per gas (EIP-1559) */
  maxFeePerGas?: bigint;
  /** Max priority fee per gas (EIP-1559) */
  maxPriorityFeePerGas?: bigint;
  /** Transaction nonce */
  nonce: number;
  /** Chain ID */
  chainId: number;
  /** Timestamp when the pending tx was first seen */
  firstSeen: number;
  /**
   * Curve pool metadata for swaps where token addresses couldn't be resolved
   * from the pool index. Present only for Curve swaps with unresolved tokens.
   * Downstream systems can use this to resolve tokens via on-chain calls.
   */
  _curvePoolInfo?: {
    poolAddress: string;
    tokenInIndex: number;
    tokenOutIndex: number;
    tokensResolved: boolean;
  };
}

/**
 * Raw pending transaction from mempool data providers.
 * Contains the transaction data before decoding.
 */
export interface RawPendingTransaction {
  /** Transaction hash */
  hash: string;
  /** Transaction from address */
  from: string;
  /** Transaction to address (contract being called) */
  to: string;
  /** Transaction value in wei (hex) */
  value: string;
  /** Transaction input data (hex) */
  input: string;
  /** Gas limit (hex) */
  gas: string;
  /** Gas price in wei (hex) - legacy transactions */
  gasPrice?: string;
  /** Max fee per gas (hex) - EIP-1559 */
  maxFeePerGas?: string;
  /** Max priority fee per gas (hex) - EIP-1559 */
  maxPriorityFeePerGas?: string;
  /** Transaction nonce (hex) */
  nonce: string;
  /** Chain ID */
  chainId?: number;
  /** Access list for EIP-2930 transactions */
  accessList?: Array<{ address: string; storageKeys: string[] }>;
}

// =============================================================================
// BLOXROUTE FEED TYPES
// =============================================================================

/**
 * Configuration for bloXroute BDN connection.
 */
export interface BloXrouteFeedConfig {
  /** Authorization header for bloXroute API */
  authHeader: string;
  /** WebSocket endpoint URL */
  endpoint: string;
  /** Chains to monitor (e.g., ['ethereum', 'bsc']) */
  chains: string[];
  /** Optional: Filter for known arbitrage bot addresses */
  includeTraders?: string[];
  /** Optional: Filter for specific router addresses */
  includeRouters?: string[];
  /** Reconnection settings */
  reconnect?: {
    /** Base reconnect interval in ms (default: 1000) */
    interval?: number;
    /** Maximum reconnect attempts (default: 10) */
    maxAttempts?: number;
    /** Backoff multiplier (default: 2.0) */
    backoffMultiplier?: number;
    /** Maximum delay in ms (default: 60000) */
    maxDelay?: number;
  };
  /** Connection timeout in ms (default: 10000) */
  connectionTimeout?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
}

/**
 * bloXroute subscription message types.
 */
export type BloXrouteSubscriptionType =
  | 'pendingTxs'
  | 'newTxs'
  | 'bdnBlocks'
  | 'ethOnBlock';

/**
 * bloXroute WebSocket message format.
 */
export interface BloXrouteMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: {
    subscription?: string;
    result?: BloXroutePendingTx | BloXrouteBlock;
  };
  result?: string | number | boolean;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * bloXroute pending transaction notification format.
 */
export interface BloXroutePendingTx {
  txHash: string;
  txContents: {
    type?: string;
    chainId?: string;
    nonce: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    gas: string;
    to: string;
    value: string;
    input: string;
    from: string;
    accessList?: Array<{ address: string; storageKeys: string[] }>;
    v?: string;
    r?: string;
    s?: string;
  };
  localRegion?: boolean;
  time?: string;
  rawTx?: string;
}

/**
 * bloXroute block notification format.
 */
export interface BloXrouteBlock {
  hash: string;
  header: {
    parentHash: string;
    number: string;
    timestamp: string;
    gasLimit: string;
    gasUsed: string;
    baseFeePerGas?: string;
  };
  transactions?: string[];
}

// =============================================================================
// DECODER TYPES
// =============================================================================

/**
 * Known router addresses mapped to their types.
 */
export interface RouterRegistry {
  [address: string]: {
    type: SwapRouterType;
    name: string;
    chainId: number;
  };
}

/**
 * Swap decoder interface for implementing different DEX decoders.
 */
export interface SwapDecoder {
  /** Router type this decoder handles */
  type: SwapRouterType;
  /** Router name for logging */
  name: string;
  /** Supported chain IDs */
  supportedChains: number[];
  /**
   * Decode transaction input data to extract swap intent.
   * @param tx - Raw pending transaction
   * @returns Decoded swap intent or null if not decodable
   */
  decode(tx: RawPendingTransaction): PendingSwapIntent | null;
  /**
   * Check if this decoder can handle the given transaction.
   * @param tx - Raw pending transaction
   * @returns True if this decoder should attempt to decode the transaction
   */
  canDecode(tx: RawPendingTransaction): boolean;
}

// =============================================================================
// EVENT TYPES
// =============================================================================

/**
 * Handler for pending transaction events.
 */
export type PendingTxHandler = (tx: RawPendingTransaction) => void | Promise<void>;

/**
 * Handler for decoded swap intent events.
 */
export type SwapIntentHandler = (intent: PendingSwapIntent) => void | Promise<void>;

/**
 * Feed connection state.
 */
export type FeedConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * Feed health metrics.
 */
export interface FeedHealthMetrics {
  /** Current connection state */
  connectionState: FeedConnectionState;
  /** Timestamp of last received message */
  lastMessageTime: number;
  /** Total messages received since connection */
  messagesReceived: number;
  /** Total transactions processed */
  transactionsProcessed: number;
  /** Total successful transaction decodes */
  decodeSuccesses: number;
  /** Total failed transaction decode attempts */
  decodeFailures: number;
  /** Reconnection count */
  reconnectCount: number;
  /** Connection uptime in ms */
  uptime: number;
  /** Average message latency in ms */
  avgLatencyMs: number;
}

// =============================================================================
// SERVICE TYPES
// =============================================================================

/**
 * Mempool detector service configuration.
 */
export interface MempoolDetectorConfig {
  /** Service instance ID */
  instanceId: string;
  /** bloXroute feed configuration */
  bloxroute?: BloXrouteFeedConfig;
  /** Chains to monitor */
  chains: string[];
  /** Health check port */
  healthCheckPort: number;
  /** Redis stream name for publishing opportunities */
  opportunityStream?: string;
  /**
   * Minimum swap size in USD to process.
   *
   * @reserved Currently accepted and validated but NOT used for filtering.
   * The mempool-detector publishes all decoded swaps; USD-based filtering
   * is deferred to downstream consumers (cross-chain-detector) which have
   * access to price oracles. This field is reserved for future use if a
   * lightweight price cache is added to the mempool-detector.
   */
  minSwapSizeUsd?: number;
  /** Maximum pending transactions to buffer */
  maxBufferSize?: number;
  /** Processing batch size */
  batchSize?: number;
  /** Processing batch timeout in ms */
  batchTimeoutMs?: number;
}

/**
 * Mempool detector service health status.
 */
export interface MempoolDetectorHealth {
  /** Service instance ID */
  instanceId: string;
  /** Service status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Active feeds and their health */
  feeds: {
    [feedName: string]: FeedHealthMetrics;
  };
  /** Total pending transactions in buffer */
  bufferSize: number;
  /** Processing statistics */
  stats: {
    /** Total transactions received */
    txReceived: number;
    /** Total transactions decoded */
    txDecoded: number;
    /** Total opportunities published */
    opportunitiesPublished: number;
    /** Processing latency P50 in ms */
    latencyP50: number;
    /** Processing latency P99 in ms */
    latencyP99: number;
  };
  /** Uptime in ms */
  uptime: number;
  /** Last health check timestamp */
  timestamp: number;
}

// =============================================================================
// ERROR TYPES (FIX 6.1, 9.5: Improved error discrimination)
// =============================================================================

/**
 * Decode result status for distinguishing different decode outcomes.
 * FIX 6.1: Better error handling consistency.
 */
export type DecodeResultStatus =
  | 'success' // Successfully decoded swap
  | 'not_swap' // Valid transaction but not a swap (expected)
  | 'unsupported_selector' // Swap selector not supported
  | 'unsupported_router' // Router not recognized
  | 'decode_error' // Error during decoding
  | 'invalid_input'; // Input data too short or malformed

/**
 * Result of a decode attempt with status and optional error info.
 * FIX 6.1: Allows distinguishing between "not a swap" and actual errors.
 */
export interface DecodeResult {
  status: DecodeResultStatus;
  intent?: PendingSwapIntent;
  error?: {
    message: string;
    code?: string;
    selector?: string;
    router?: string;
  };
}

/**
 * Create a successful decode result.
 */
export function createDecodeSuccess(intent: PendingSwapIntent): DecodeResult {
  return { status: 'success', intent };
}

/**
 * Create a "not a swap" result (expected for most transactions).
 */
export function createNotSwapResult(selector?: string): DecodeResult {
  return {
    status: selector ? 'unsupported_selector' : 'not_swap',
    error: selector ? { message: 'Unknown swap selector', selector } : undefined,
  };
}

/**
 * Create a decode error result.
 */
export function createDecodeError(message: string, code?: string): DecodeResult {
  return {
    status: 'decode_error',
    error: { message, code },
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default mempool detector port.
 */
export const DEFAULT_MEMPOOL_DETECTOR_PORT = 3008;

/**
 * Default Redis stream name for pending opportunities.
 *
 * FIX 9.2: This constant should match RedisStreamsClient.STREAMS.PENDING_OPPORTUNITIES
 * from @arbitrage/core. We keep a local constant here to avoid circular dependencies
 * in type definition files. The canonical source is redis-streams.ts.
 *
 * @see RedisStreamsClient.STREAMS.PENDING_OPPORTUNITIES - Canonical source
 */
export const DEFAULT_PENDING_OPPORTUNITIES_STREAM = 'stream:pending-opportunities';

/**
 * Maximum pending transaction buffer size.
 */
export const DEFAULT_MAX_BUFFER_SIZE = 10000;

/**
 * Default minimum swap size in USD.
 */
export const DEFAULT_MIN_SWAP_SIZE_USD = 1000;

/**
 * Default batch processing size.
 */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Default batch processing timeout in ms.
 */
export const DEFAULT_BATCH_TIMEOUT_MS = 50;
