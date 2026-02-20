/**
 * Performance and Arbitrage Thresholds
 *
 * Contains performance targets and arbitrage detection parameters.
 *
 * @see ADR-008: Phase metrics and targets
 */

// =============================================================================
// PERFORMANCE THRESHOLDS
// =============================================================================
export const PERFORMANCE_THRESHOLDS = {
  maxEventLatency: 50, // ms - target for Phase 3
  minCacheHitRate: 0.9, // 90%
  maxMemoryUsage: 400 * 1024 * 1024, // 400MB
  maxCpuUsage: 80, // %
  maxFalsePositiveRate: 0.05 // 5%
};

// =============================================================================
// ARBITRAGE DETECTION PARAMETERS
// =============================================================================
export const ARBITRAGE_CONFIG = {
  minProfitPercentage: 0.003, // 0.3%
  maxGasPrice: 50000000000, // 50 gwei
  confidenceThreshold: 0.75,
  maxTradeSize: '1000000000000000000', // 1 ETH equivalent
  triangularEnabled: true,
  crossChainEnabled: true,  // FIX: Enabled - cross-chain-detector service is implemented
  predictiveEnabled: false, // Enable in Phase 3
  // Additional config properties for opportunity calculation
  defaultAmount: 1000, // Default trade amount in USD
  estimatedGasCost: 5, // Estimated gas cost in USD
  opportunityTimeoutMs: 30000, // 30 seconds
  minProfitThreshold: 10, // Minimum $10 net profit
  minConfidenceThreshold: 0.7, // Minimum 70% confidence
  feePercentage: 0.003, // 0.3% DEX trading fee
  // P1-4 FIX: Configurable slippage tolerance (was hardcoded 0.9 = 10%)
  slippageTolerance: 0.05, // 5% slippage tolerance (minProfit = expectedProfit * (1 - slippageTolerance))
  // P1-5 FIX: Gas price spike protection - reject transactions if gas exceeds threshold
  gasPriceSpikeMultiplier: 2.0, // Max 2x above baseline gas price
  gasPriceBaselineWindowMs: 300000, // 5 minute window for baseline calculation
  gasPriceSpikeEnabled: true, // Enable/disable gas spike protection
  // Chain-specific minimum profits (due to gas costs)
  // S3.1.2: Added all 11 chains
  chainMinProfits: {
    // Original 6 chains
    ethereum: 0.005,   // 0.5% - higher due to gas
    arbitrum: 0.002,   // 0.2% - low gas
    optimism: 0.002,   // 0.2% - low gas
    base: 0.002,       // 0.2% - low gas
    polygon: 0.002,    // 0.2% - low gas
    bsc: 0.003,        // 0.3% - moderate gas
    // S3.1.2: New chains
    avalanche: 0.002,  // 0.2% - low gas (C-Chain)
    fantom: 0.002,     // 0.2% - very low gas
    zksync: 0.002,     // 0.2% - L2 gas pricing
    linea: 0.002,      // 0.2% - L2 gas pricing
    solana: 0.001      // 0.1% - minimal transaction fees
  } as Record<string, number>
};

// =============================================================================
// CHAIN-SPECIFIC OPPORTUNITY TIMEOUT
// Accounts for block time differences across chains
// =============================================================================

/**
 * Per-chain opportunity timeout in milliseconds.
 * Fast chains (sub-second blocks) need much shorter timeouts to prevent
 * executing stale opportunities. Ethereum with 12s blocks can tolerate longer windows.
 *
 * Values are derived from block times in BLOCK_TIMES_MS (chains/index.ts),
 * targeting approximately 2-5 blocks per chain for a reasonable staleness window.
 *
 * @see BLOCK_TIMES_MS in chains/index.ts — authoritative source of block times
 */
export const chainOpportunityTimeoutMs: Record<string, number> = {
  // L1 chains
  ethereum: 30000,   // 12s blocks — 30s is ~2.5 blocks
  bsc: 15000,        // 3s blocks — 15s is ~5 blocks
  // L2 fast chains (sub-second to 2s blocks)
  arbitrum: 2000,    // Sub-second blocks — opportunities expire fast
  optimism: 4000,    // 2s blocks
  base: 4000,        // 2s blocks
  zksync: 3000,      // ~1s blocks
  linea: 4000,       // ~2s blocks
  // Alt-L1 chains
  avalanche: 4000,   // 2s blocks
  fantom: 2000,      // 1s blocks
  polygon: 6000,     // 2s blocks, but higher variance
  // Non-EVM
  solana: 1000,      // ~400ms blocks — extremely fast
};

/**
 * Get opportunity timeout for a specific chain.
 * Uses chainOpportunityTimeoutMs with fallback to global opportunityTimeoutMs.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Timeout in milliseconds
 */
export function getOpportunityTimeoutMs(chainId: string): number {
  return chainOpportunityTimeoutMs[chainId.toLowerCase()] ?? ARBITRAGE_CONFIG.opportunityTimeoutMs;
}

// =============================================================================
// PROFIT THRESHOLD UTILITIES
// Single source of truth for chain-specific profit thresholds
// =============================================================================

/**
 * Get minimum profit threshold for a specific chain.
 * Uses ARBITRAGE_CONFIG.chainMinProfits with fallback to default 0.3%.
 *
 * This is the CANONICAL implementation - all other code should use this function.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Minimum profit threshold as decimal (e.g., 0.003 = 0.3%)
 */
export function getMinProfitThreshold(chainId: string): number {
  const chainMinProfits = ARBITRAGE_CONFIG.chainMinProfits;
  // Use ?? instead of || to correctly handle 0 min profit
  return chainMinProfits[chainId.toLowerCase()] ?? ARBITRAGE_CONFIG.minProfitPercentage;
}
