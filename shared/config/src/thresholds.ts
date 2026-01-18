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
  crossChainEnabled: false, // Enable in Phase 2
  predictiveEnabled: false, // Enable in Phase 3
  // Additional config properties for opportunity calculation
  defaultAmount: 1000, // Default trade amount in USD
  estimatedGasCost: 5, // Estimated gas cost in USD
  opportunityTimeoutMs: 30000, // 30 seconds
  minProfitThreshold: 10, // Minimum $10 net profit
  minConfidenceThreshold: 0.7, // Minimum 70% confidence
  feePercentage: 0.003, // 0.3% DEX trading fee
  // P1-4 FIX: Configurable slippage tolerance (was hardcoded 0.9 = 10%)
  slippageTolerance: 0.10, // 10% slippage tolerance (minProfit = expectedProfit * (1 - slippageTolerance))
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
