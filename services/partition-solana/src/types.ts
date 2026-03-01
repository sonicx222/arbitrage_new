/**
 * Solana Arbitrage Detection Types
 *
 * Shared type definitions for the Solana arbitrage detection modules:
 * - Pool and token types
 * - Detection opportunity types
 * - Configuration types
 * - Internal types for optimized processing
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

// =============================================================================
// Token Types
// =============================================================================

/**
 * Solana token info in a pool.
 */
export interface SolanaTokenInfo {
  /** Token mint address */
  mint: string;
  /** Token symbol (e.g., "SOL", "USDC") */
  symbol: string;
  /** Token decimals (e.g., 9 for SOL, 6 for USDC) */
  decimals: number;
}

// =============================================================================
// Pool Types
// =============================================================================

/**
 * Solana pool information.
 *
 * Compatible with SolanaPool from shared/core/src/solana/solana-detector.ts.
 *
 * Fee Documentation:
 * The `fee` field is in basis points (1 basis point = 0.01%).
 * Example: fee=25 means 0.25% trading fee.
 * Use bpsToDecimal(fee) to convert to decimal (25 → 0.0025).
 */
export interface SolanaPoolInfo {
  /** Pool program address */
  address: string;
  /** DEX program ID */
  programId: string;
  /** DEX name (e.g., "raydium", "orca") */
  dex: string;
  /** First token in the pair */
  token0: SolanaTokenInfo;
  /** Second token in the pair */
  token1: SolanaTokenInfo;
  /** Trading fee in basis points (e.g., 25 = 0.25%) */
  fee: number;
  /** Reserve amount for token0 */
  reserve0?: string;
  /** Reserve amount for token1 */
  reserve1?: string;
  /** Current price (token1/token0) */
  price?: number;
  /** Last slot when pool was updated */
  lastSlot?: number;
  /** Timestamp when price was last updated (ms since epoch) */
  lastUpdated?: number;
}

/**
 * Internal pool representation with pre-computed normalized tokens.
 * Performance optimization: Pre-normalize on pool add.
 */
export interface InternalPoolInfo extends SolanaPoolInfo {
  /** Pre-normalized token0 symbol */
  normalizedToken0: string;
  /** Pre-normalized token1 symbol */
  normalizedToken1: string;
  /** Pre-computed pair key for fast lookup */
  pairKey: string;
}

// =============================================================================
// Opportunity Types
// =============================================================================

/**
 * Solana arbitrage opportunity.
 *
 * Token Semantics:
 * - token0/token1: Normalized canonical symbols (e.g., 'SOL', 'USDC', 'WETH')
 * - buyPair/sellPair: Pool/pair addresses or identifiers
 */
export interface SolanaArbitrageOpportunity {
  /** Unique opportunity ID */
  id: string;
  /** Type of arbitrage */
  type: 'intra-solana' | 'triangular' | 'cross-chain';
  /** Chain identifier */
  chain: string;
  /** DEX to buy on */
  buyDex: string;
  /** DEX to sell on */
  sellDex: string;
  /** Pool/pair address for buy side */
  buyPair: string;
  /** Pool/pair address for sell side */
  sellPair: string;
  /** Normalized base token symbol */
  token0: string;
  /** Normalized quote token symbol */
  token1: string;
  /** P0-1 FIX: Token input identifier (mirrors token0 for downstream compatibility) */
  tokenIn?: string;
  /** P0-1 FIX: Token output identifier (mirrors token1 for downstream compatibility) */
  tokenOut?: string;
  /** Price on buy side */
  buyPrice: number;
  /** Price on sell side */
  sellPrice: number;
  /** Profit as percentage (e.g., 1.5 = 1.5%) */
  profitPercentage: number;
  /** Expected profit as decimal */
  expectedProfit: number;
  /** Net profit after gas costs (as decimal) */
  netProfitAfterGas?: number;
  /** Estimated gas cost as decimal fraction of trade */
  estimatedGasCost?: number;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detection timestamp (ms since epoch) */
  timestamp: number;
  /** Opportunity expiration time (ms since epoch) */
  expiresAt: number;
  /** Opportunity status */
  status: 'pending' | 'executing' | 'completed' | 'failed';

  // Cross-chain specific fields
  /** Source chain for cross-chain */
  sourceChain?: string;
  /** Target chain for cross-chain */
  targetChain?: string;
  /** Direction of cross-chain trade */
  direction?: 'buy-solana-sell-evm' | 'buy-evm-sell-solana';
  /** Base token for cross-chain */
  token?: string;
  /** Quote token for cross-chain */
  quoteToken?: string;

  // Triangular specific fields
  /** Path steps for triangular */
  path?: TriangularPathStep[];
  /** Estimated output amount */
  estimatedOutput?: number;
}

// =============================================================================
// Triangular Path Types
// =============================================================================

/**
 * Step in a triangular arbitrage path.
 *
 * Fee Format Note:
 * The `fee` field is in DECIMAL format (not basis points), as it's already
 * converted via bpsToDecimal() when building the adjacency graph.
 * - 0.003 = 0.3% (typical AMM fee)
 * - 0.0025 = 0.25% (Raydium default)
 */
export interface TriangularPathStep {
  /** Token received at this step */
  token: string;
  /** Pool address */
  pool: string;
  /** DEX name */
  dex: string;
  /** Effective price at this step */
  price: number;
  /** Fee in DECIMAL format (0.003 = 0.3%) */
  fee: number;
}

/**
 * Complete triangular arbitrage path.
 */
export interface TriangularPath {
  /** Steps in the path */
  steps: TriangularPathStep[];
  /** Input token */
  inputToken: string;
  /** Output token (should equal inputToken for closed loop) */
  outputToken: string;
  /** Profit percentage */
  profitPercentage: number;
  /** Estimated output amount */
  estimatedOutput: number;
}

// =============================================================================
// Cross-Chain Types
// =============================================================================

/**
 * EVM price update for cross-chain comparison.
 * Emitted by UnifiedChainDetector.
 */
export interface EvmPriceUpdate {
  /** Pair key identifier */
  pairKey: string;
  /** Chain name */
  chain: string;
  /** DEX name */
  dex: string;
  /** First token symbol */
  token0: string;
  /** Second token symbol */
  token1: string;
  /** Price (token1/token0) */
  price: number;
  /** Reserve for token0 */
  reserve0: string;
  /** Reserve for token1 */
  reserve1: string;
  /** Block number */
  blockNumber: number;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Detection latency in ms */
  latency: number;
  /** Pool fee in basis points */
  fee?: number;
}

/**
 * Generic price update from UnifiedChainDetector.
 */
export interface UnifiedPriceUpdate {
  /** Chain name */
  chain: string;
  /** DEX name */
  dex: string;
  /** Pair key identifier */
  pairKey: string;
  /** First token symbol */
  token0: string;
  /** Second token symbol */
  token1: string;
  /** Price (token1/token0) */
  price: number;
  /** Reserve for token0 */
  reserve0: string;
  /** Reserve for token1 */
  reserve1: string;
  /** Block number */
  blockNumber: number;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Detection latency in ms */
  latency: number;
  /** Pool fee in basis points */
  fee?: number;
}

/**
 * Cross-chain price comparison result.
 */
export interface CrossChainPriceComparison {
  /** Token being compared */
  token: string;
  /** Quote token */
  quoteToken: string;
  /** Price on Solana */
  solanaPrice: number;
  /** DEX on Solana */
  solanaDex: string;
  /** Pool address on Solana */
  solanaPoolAddress: string;
  /** EVM chain name */
  evmChain: string;
  /** DEX on EVM */
  evmDex: string;
  /** Price on EVM */
  evmPrice: number;
  /** Pair key on EVM */
  evmPairKey: string;
  /** Price difference percentage */
  priceDifferencePercent: number;
  /** Comparison timestamp */
  timestamp: number;
  /** Solana pool fee in basis points */
  solanaFee?: number;
  /** EVM pool fee in basis points */
  evmFee?: number;
}

// =============================================================================
// Priority Fee Types
// =============================================================================

/**
 * Priority fee estimation result.
 */
export interface PriorityFeeEstimate {
  /** Base fee in lamports */
  baseFee: number;
  /** Priority fee in lamports */
  priorityFee: number;
  /** Total fee (base + priority) in lamports */
  totalFee: number;
  /** Compute units for the transaction */
  computeUnits: number;
  /** Priority fee rate in microLamports per CU */
  microLamportsPerCu: number;
}

/**
 * Priority fee estimation request.
 */
export interface PriorityFeeRequest {
  /** Expected compute units */
  computeUnits: number;
  /** Urgency level */
  urgency: 'low' | 'medium' | 'high';
}

// =============================================================================
// Statistics Types
// =============================================================================

/**
 * Arbitrage detection statistics.
 */
export interface SolanaArbitrageStats {
  /** Total detections run */
  totalDetections: number;
  /** Intra-Solana opportunities found */
  intraSolanaOpportunities: number;
  /** Triangular opportunities found */
  triangularOpportunities: number;
  /** Cross-chain opportunities found */
  crossChainOpportunities: number;
  /** Number of pools being tracked */
  poolsTracked: number;
  /** Last detection timestamp */
  lastDetectionTime: number;
  /** Pools skipped due to stale prices */
  stalePoolsSkipped: number;
  /** Average detection latency in ms */
  avgDetectionLatencyMs: number;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Logger interface for arbitrage detection.
 */
export interface SolanaArbitrageLogger {
  info: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Configuration for SolanaArbitrageDetector.
 */
export interface SolanaArbitrageConfig {
  /** Solana RPC endpoint URL (for logging only) */
  rpcUrl?: string;
  /** Chain identifier (default: 'solana') */
  chainId?: string;
  /** Minimum profit threshold in percentage points (default: 0.3) */
  minProfitThreshold?: number;
  /** Priority fee multiplier (default: 1.0) */
  priorityFeeMultiplier?: number;
  /** Base priority fee in lamports (default: 10000) */
  basePriorityFeeLamports?: number;
  /** Enable cross-chain detection (default: true) */
  crossChainEnabled?: boolean;
  /** Enable triangular detection (default: true) */
  triangularEnabled?: boolean;
  /** Maximum depth for triangular paths (default: 3) */
  maxTriangularDepth?: number;
  /** Opportunity expiry time in ms (default: 1000) */
  opportunityExpiryMs?: number;
  /** Price staleness threshold in ms (default: 5000) */
  priceStalenessMs?: number;
  /** Default trade value in USD for gas estimation (default: 1000) */
  defaultTradeValueUsd?: number;
  /** Whether to normalize liquid staking tokens (default: true) */
  normalizeLiquidStaking?: boolean;
  /** Cross-chain cost configuration */
  crossChainCosts?: {
    /** Bridge fee as decimal (default: 0.001 = 0.1%) */
    bridgeFeeDefault?: number;
    /** EVM gas cost in USD (default: 15) */
    evmGasCostUsd?: number;
    /** Solana transaction cost in USD (default: 0.01) */
    solanaTxCostUsd?: number;
    /** Latency risk premium as decimal (default: 0.002 = 0.2%) */
    latencyRiskPremium?: number;
  };
}

/**
 * Redis Streams client interface for opportunity publishing.
 */
export interface SolanaArbitrageStreamsClient {
  xadd(stream: string, data: Record<string, string>): Promise<string | null>;
}

/**
 * Dependencies for SolanaArbitrageDetector.
 */
export interface SolanaArbitrageDeps {
  /** Optional logger instance */
  logger?: SolanaArbitrageLogger;
  /** Optional Redis Streams client */
  streamsClient?: SolanaArbitrageStreamsClient;
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Handler for pool update events.
 */
export type PoolUpdateHandler = (update: UnifiedPriceUpdate | SolanaPoolInfo) => void;

/**
 * Handler for pool removal events.
 */
export type PoolRemovedHandler = (address: string) => void;

/**
 * Union type for detector event handlers.
 */
export type DetectorEventHandler = PoolUpdateHandler | PoolRemovedHandler;

/**
 * Stored listener reference for cleanup.
 */
export interface DetectorListenerRef {
  /** Event name */
  event: string;
  /** Handler function */
  handler: DetectorEventHandler;
}
