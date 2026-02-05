// Shared types for the arbitrage detection system

// Fee branded types - single source of truth in @arbitrage/core/utils/fee-utils
// Re-exported here for convenience in type definitions
/** Fee in basis points (30 = 0.30%). Range: 0-10000 */
export type FeeBasisPoints = number & { readonly __brand: 'FeeBasisPoints' };
/** Fee as decimal (0.003 = 0.30%). Range: 0-1 */
export type FeeDecimal = number & { readonly __brand: 'FeeDecimal' };

export interface Chain {
  id: number;
  name: string;
  rpcUrl: string;
  wsUrl?: string;
  /** Fallback WebSocket URLs if primary fails */
  wsFallbackUrls?: string[];
  /** Fallback RPC URLs if primary fails */
  rpcFallbackUrls?: string[];
  blockTime: number;
  nativeToken: string;
  /** Whether this chain uses EVM (defaults to true) */
  isEVM?: boolean;
}

/**
 * S3.3.2: DEX type classification for different liquidity models.
 * - amm: Automated Market Maker (constant product, xy=k)
 * - clmm: Concentrated Liquidity Market Maker (Uniswap V3 style)
 * - dlmm: Dynamic Liquidity Market Maker (Meteora bin-based)
 * - orderbook: On-chain order book (Phoenix)
 * - pmm: Proactive Market Maker (oracle-based pricing)
 * - aggregator: Routes through other DEXs (Jupiter)
 */
export type DexType = 'amm' | 'clmm' | 'dlmm' | 'orderbook' | 'pmm' | 'aggregator';

export interface Dex {
  name: string;
  chain: string;
  factoryAddress: string;
  routerAddress: string;
  /**
   * Fee in basis points (30 = 0.30%). Use bpsToDecimal() from @arbitrage/core to convert.
   * @example 30 = 0.30%, 4 = 0.04%, 100 = 1.00%
   */
  feeBps: FeeBasisPoints;
  /**
   * @deprecated Use `feeBps` instead. Will be removed in v2.0.0.
   * Legacy field maintained for backward compatibility during migration.
   */
  fee?: number;
  enabled?: boolean; // Optional: defaults to true if not specified
  /** S3.3.2: DEX type classification (primarily for Solana non-factory DEXs) */
  type?: DexType;
}

export interface Token {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
}

// Base Pair interface for detector services (uses string references)
export interface Pair {
  name?: string;
  address: string;
  token0: string; // Token address
  token1: string; // Token address
  dex: string;    // DEX name
  /**
   * Fee as decimal (0.003 = 0.30%). Converted from Dex.feeBps at initialization.
   * @example 0.003 = 0.30%, 0.0004 = 0.04%, 0.01 = 1.00%
   */
  feeDecimal?: FeeDecimal;
  /**
   * @deprecated Use `feeDecimal` instead. Will be removed in v2.0.0.
   * Legacy field maintained for backward compatibility during migration.
   */
  fee?: number;
  reserve0?: string;
  reserve1?: string;
  blockNumber?: number;
  lastUpdate?: number;
}

// Full Pair interface with complete token/dex objects (for analysis)
export interface PairFull {
  address: string;
  token0: Token;
  token1: Token;
  dex: Dex;
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

export interface PriceUpdate {
  pairKey: string;
  pairAddress?: string; // Optional pair contract address
  dex: string;
  chain: string;
  token0: string;
  token1: string;
  price: number; // token1 per token0
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  timestamp: number;
  latency: number;
  /** Fee as decimal (0.003 = 0.30%) */
  feeDecimal?: FeeDecimal;
  /** @deprecated Use `feeDecimal` instead */
  fee?: number;
}

/**
 * Swap hop definition for N-hop flash loan execution.
 * Phase 5.1: Supports triangular and multi-leg arbitrage paths.
 *
 * @see services/execution-engine/src/types.ts for full implementation
 */
export interface SwapHop {
  /** DEX router address for this swap (optional if dex is provided) */
  router?: string;
  /** DEX name to resolve router from (used if router not specified) */
  dex?: string;
  /** Token to receive from this swap */
  tokenOut: string;
  /** Expected output amount for slippage calculation (optional) */
  expectedOutput?: string;
}

export interface ArbitrageOpportunity {
  id: string;
  type?: 'simple' | 'cross-dex' | 'triangular' | 'quadrilateral' | 'multi-leg' | 'cross-chain' | 'predictive' | 'intra-dex' | 'flash-loan';
  chain?: string;        // Single chain for same-chain arbitrage
  buyDex?: string;
  sellDex?: string;
  buyChain?: string;     // Optional for same-chain arbitrage
  sellChain?: string;
  buyPair?: string;      // Pair address for buy side
  sellPair?: string;     // Pair address for sell side
  token0?: string;       // Token addresses (alternative to tokenIn/tokenOut)
  token1?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  buyPrice?: number;     // Price on buy DEX
  sellPrice?: number;    // Price on sell DEX
  expectedProfit?: number;
  estimatedProfit?: number;
  profitPercentage?: number;
  gasEstimate?: string; // Wei as string for BigInt compatibility. Use parseGasEstimate() helper.
  confidence: number;
  timestamp: number;
  blockNumber?: number;
  expiresAt?: number;    // Opportunity expiration timestamp
  status?: 'pending' | 'executing' | 'completed' | 'failed' | 'expired';
  path?: string[];       // For triangular arbitrage
  bridgeRequired?: boolean;
  bridgeCost?: number;
  /** Flag to force flash loan execution (Task 3.1.2) */
  useFlashLoan?: boolean;
  /**
   * Phase 5.1: N-hop swap path for triangular/multi-leg arbitrage.
   * When present, FlashLoanStrategy uses buildNHopSwapSteps() for execution.
   * The path must start with tokenIn and end with the same token (for flash loan repayment).
   */
  hops?: SwapHop[];
  // Additional fields for base-detector compatibility
  sourceChain?: string;
  targetChain?: string;
  sourceDex?: string;
  targetDex?: string;
  tokenAddress?: string;
  amount?: number;
  priceDifference?: number;
  percentageDifference?: number;
  gasCost?: number;
  netProfit?: number;
}

export interface SwapEvent {
  pairAddress: string;
  sender: string;
  recipient: string;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  to: string;
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
  dex: string;
  chain: string;
  usdValue?: number;
}

export interface WhaleTransaction {
  transactionHash: string;
  address: string;
  token: string;
  amount: number;
  usdValue: number;
  direction: 'buy' | 'sell';
  dex: string;
  chain: string;
  timestamp: number;
  impact: number; // Price impact percentage
}

// =============================================================================
// Pending Transaction Types (Task 1.3.3: Integration with Existing Detection)
// =============================================================================

/**
 * Supported swap router types for pending transaction decoding.
 */
export type SwapRouterType =
  | 'uniswapV2'
  | 'uniswapV3'
  | 'sushiswap'
  | 'curve'
  | '1inch'
  | 'pancakeswap'
  | 'unknown';

/**
 * Pending swap intent extracted from mempool transactions.
 * Represents a user's swap intent before block inclusion.
 *
 * FIX 1.1: Type Design Decision - Two Versions Exist By Design:
 * - This shared type uses `string` for amount fields (amountIn, gasPrice, etc.)
 *   because JSON serialization doesn't support BigInt natively.
 * - The mempool-detector/src/types.ts has a local version using `bigint`
 *   for precise arithmetic during transaction processing.
 * - Use toSerializableIntent() in mempool-detector to convert between them.
 *
 * @see mempool-detector/src/types.ts - Internal bigint version
 * @see mempool-detector/src/index.ts - toSerializableIntent() conversion
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
  /** Input amount in wei (as string for JSON serialization) */
  amountIn: string;
  /** Expected minimum output amount in wei (as string for JSON serialization) */
  expectedAmountOut: string;
  /** Token path for multi-hop swaps */
  path: string[];
  /** Slippage tolerance as decimal (e.g., 0.005 = 0.5%) */
  slippageTolerance: number;
  /** Transaction deadline timestamp */
  deadline: number;
  /** Sender address */
  sender: string;
  /** Gas price in wei (as string for JSON serialization) */
  gasPrice: string;
  /** Max fee per gas (EIP-1559) */
  maxFeePerGas?: string;
  /** Max priority fee per gas (EIP-1559) */
  maxPriorityFeePerGas?: string;
  /** Transaction nonce */
  nonce: number;
  /** Chain ID */
  chainId: number;
  /** Timestamp when the pending tx was first seen */
  firstSeen: number;
}

/**
 * Pending opportunity message published to stream:pending-opportunities.
 * Contains the decoded swap intent and optional impact estimation.
 */
export interface PendingOpportunity {
  /** Message type discriminator */
  type: 'pending';
  /** Decoded swap intent from mempool transaction */
  intent: PendingSwapIntent;
  /** Estimated price impact of the pending swap (optional) */
  estimatedImpact?: number;
  /** Timestamp when opportunity was published */
  publishedAt: number;
}

export interface MessageEvent {
  type: string;
  data: any;
  timestamp: number;
  source: string;
  correlationId?: string;
}

/**
 * P3-2 FIX: Unified ServiceHealth interface
 * Consolidates definitions from shared/types and self-healing-manager.
 * Field naming standardized to 'name' instead of 'service'.
 */
export interface ServiceHealth {
  name: string;  // P3-2: Standardized field name (was 'service')
  status: 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'stopping';
  uptime: number;
  memoryUsage: number;
  cpuUsage: number;
  lastHeartbeat: number;
  latency?: number;  // P0-5 fix: Optional latency measurement in ms
  error?: string;
  // P3-2: Added from self-healing-manager for recovery tracking
  consecutiveFailures?: number;
  restartCount?: number;
}

export interface PerformanceMetrics {
  eventLatency: number;
  detectionLatency: number;
  cacheHitRate: number;
  opportunitiesDetected: number;
  opportunitiesExecuted: number;
  successRate: number;
  timestamp: number;
}

export interface PredictionResult {
  type: 'price' | 'pattern' | 'orderbook' | 'crosschain';
  direction: number; // -1 (down), 0 (neutral), 1 (up)
  confidence: number; // 0-1
  magnitude?: number;
  timeHorizon: number; // milliseconds
  timestamp: number;
}

export interface MLModelMetrics {
  modelName: string;
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  trainingTime: number;
  lastRetrained: number;
}

// Configuration types
export interface ServiceConfig {
  name: string;
  version: string;
  environment: 'development' | 'staging' | 'production';
  chains: Chain[];
  dexes: Dex[];
  tokens: Token[];
  redis: {
    url: string;
    password?: string;
  };
  monitoring: {
    enabled: boolean;
    interval: number;
    endpoints: string[];
  };
}

export interface DetectorConfig extends ServiceConfig {
  batchSize: number;
  batchTimeout: number;
  eventFilters: {
    minUsdValue: number;
    samplingRate: number;
  };
  cache: {
    ttl: number;
    maxSize: number;
  };
}

export interface ExecutionConfig extends ServiceConfig {
  wallet: {
    encryptedKey: string;
    address: string;
  };
  gas: {
    maxGasPrice: number;
    priorityFee: number;
  };
  mev: {
    enabled: boolean;
    flashbotsUrl?: string;
  };
}

// =============================================================================
// Error Types (SPRINT 3 CONSOLIDATION)
// =============================================================================
// CANONICAL error type definitions for the arbitrage system.
// All new code should import from @arbitrage/types.
//
// Legacy locations (maintained for backward compatibility):
// - shared/core/src/domain-models.ts (ArbitrageError) - re-exports from here
// - shared/core/src/resilience/error-handling.ts (ArbitrageError) - re-exports from here
// - shared/core/src/async/async-utils.ts (TimeoutError) - use local version for async-specific features
// - services/execution-engine/src/types.ts (TimeoutError) - execution-specific version
//
// Migration:
// - OLD: import { ArbitrageError } from '@arbitrage/core'
// - NEW: import { ArbitrageError, TimeoutError } from '@arbitrage/types'
// =============================================================================

/**
 * Base error class for arbitrage system errors.
 * Use this for errors that need to be caught and handled specifically.
 *
 * @example
 * ```typescript
 * throw new ArbitrageError(
 *   'Failed to connect to DEX',
 *   'DEX_CONNECTION_ERROR',
 *   'execution-engine',
 *   true // retryable
 * );
 * ```
 */
export class ArbitrageError extends Error {
  constructor(
    message: string,
    public code: string,
    public service: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'ArbitrageError';
    // Ensure instanceof works correctly across module boundaries
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Network-related errors (connection failures, timeouts, etc.)
 * These are generally retryable.
 */
export class NetworkError extends ArbitrageError {
  constructor(message: string, service: string) {
    super(message, 'NETWORK_ERROR', service, true);
    this.name = 'NetworkError';
  }
}

/**
 * Validation errors for invalid input data.
 * These are not retryable without fixing the input.
 */
export class ValidationError extends ArbitrageError {
  constructor(message: string, service: string, public field: string) {
    super(message, 'VALIDATION_ERROR', service, false);
    this.name = 'ValidationError';
  }
}

/**
 * Timeout error for async operations that exceed their time limit.
 * CANONICAL definition - use this for new code.
 *
 * @example
 * ```typescript
 * throw new TimeoutError('Bridge polling', 60000, 'cross-chain.strategy');
 * ```
 */
export class TimeoutError extends Error {
  constructor(
    /** What operation timed out */
    public readonly operation: string,
    /** The timeout duration in milliseconds */
    public readonly timeoutMs: number,
    /** Optional service name for context */
    public readonly service?: string
  ) {
    super(`Timeout: ${operation} exceeded ${timeoutMs}ms${service ? ` in ${service}` : ''}`);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Cross-chain bridge types
export interface CrossChainBridge {
  bridge: string;
  sourceChain: string;
  targetChain: string;
  token: string;
  amount: number;
  estimatedLatency?: number;
  estimatedCost?: number;
}

export interface BridgeLatencyData {
  bridge: string;
  sourceChain: string;
  targetChain: string;
  token: string;
  amount: number;
  latency: number; // in seconds
  cost: number; // in wei
  success: boolean;
  timestamp: number;
  congestionLevel: number;
  gasPrice: number;
}

// =============================================================================
// Execution Types (consolidated from services/execution-engine)
// =============================================================================

export * from './execution';

// =============================================================================
// Common Types (consolidated from scattered definitions)
// =============================================================================

export * from './common';

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse gas estimate from various input types to bigint.
 * Handles string, number, bigint, and undefined inputs safely.
 *
 * @param value - The gas estimate value to parse
 * @returns The gas estimate as a bigint (0n if undefined or invalid)
 */
export function parseGasEstimate(value: string | number | bigint | undefined): bigint {
  if (value === undefined || value === null) {
    return 0n;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return BigInt(Math.floor(value));
  }
  // string case
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

// =============================================================================
// Test Support Types
// =============================================================================

export * from './test-support';
