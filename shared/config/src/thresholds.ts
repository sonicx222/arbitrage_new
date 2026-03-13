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
  defaultAmount: 10000, // Default trade amount in USD (flash loans need $10k+ to cover gas)
  estimatedGasCost: (() => { const v = parseFloat(process.env.ESTIMATED_GAS_COST_USD ?? ''); return Number.isNaN(v) ? 15 : v; })(), // Env: ESTIMATED_GAS_COST_USD. Global fallback (mainnet-oriented). Use getEstimatedGasCostUsd() for per-chain values.
  opportunityTimeoutMs: 30000, // 30 seconds
  minProfitThreshold: 2, // Minimum $2 net profit (per-chain % thresholds in chainMinProfits are primary filter)
  minConfidenceThreshold: 0.7, // Minimum 70% confidence
  /** @deprecated Use FEE_CONSTANTS.DEFAULT from @arbitrage/core/utils/fee-utils instead */
  feePercentage: 0.003, // 0.3% DEX trading fee
  // P1-4 FIX: Configurable slippage tolerance (was hardcoded 0.9 = 10%)
  slippageTolerance: 0.01, // 1% slippage tolerance (minProfit = expectedProfit * (1 - slippageTolerance))
  // P1-5 FIX: Gas price spike protection - reject transactions if gas exceeds threshold
  gasPriceSpikeMultiplier: 2.0, // Global default max above baseline gas price (used when chain not in per-chain map)
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
    solana: 0.001,     // 0.1% - minimal transaction fees
    // Emerging L2s
    blast: 0.002,      // 0.2% - OP-stack L2
    scroll: 0.002,     // 0.2% - zkRollup L2
    mantle: 0.002,     // 0.2% - modular L2
    mode: 0.002        // 0.2% - OP-stack L2
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
  arbitrum: 2000,    // 0.25s blocks — 2s is ~8 blocks (conservative for sequencer delays)
  optimism: 4000,    // 2s blocks
  base: 4000,        // 2s blocks
  zksync: 3000,      // ~1s blocks
  linea: 4000,       // ~2s blocks
  // Emerging L2s
  blast: 4000,       // 2s blocks
  scroll: 6000,      // 3s blocks
  mantle: 4000,      // 2s blocks
  mode: 4000,        // 2s blocks
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
  const key = chainId.toLowerCase();
  return chainOpportunityTimeoutMs[key] ?? ARBITRAGE_CONFIG.opportunityTimeoutMs;
}

// =============================================================================
// CHAIN-SPECIFIC ESTIMATED GAS COST (USD)
// FIX M14: Global $15 default is 30-1500x overestimate for L2 chains.
// Fallback paths using the global filter out all L2 opportunities under $15 profit.
// Per-chain values reflect actual typical gas costs.
// =============================================================================

/**
 * Per-chain estimated gas cost in USD for opportunity profit calculations.
 *
 * Values are approximate median costs for a swap transaction on each chain.
 * These are used as deductions in absolute profit calculations:
 *   net_profit = gross_profit - estimatedGasCostUsd
 *
 * Override globally via ESTIMATED_GAS_COST_USD env var if needed.
 *
 * @see ARBITRAGE_CONFIG.estimatedGasCost — global fallback ($15 mainnet)
 */
export const chainEstimatedGasCostUsd: Record<string, number> = {
  // L1 chains — expensive
  ethereum: 15.0,    // Highly variable ($5-$50+), $15 is conservative median
  // Alt-L1 chains — moderate
  bsc: 0.30,         // ~$0.10-$0.50
  polygon: 0.05,     // ~$0.01-$0.10
  avalanche: 0.10,   // ~$0.05-$0.20
  fantom: 0.02,      // ~$0.01-$0.05
  // L2 chains — cheap
  arbitrum: 0.10,    // ~$0.05-$0.20
  optimism: 0.05,    // ~$0.02-$0.10
  base: 0.05,        // ~$0.02-$0.10
  zksync: 0.10,      // ~$0.05-$0.20
  linea: 0.10,       // ~$0.05-$0.20
  // Emerging L2s — cheap
  blast: 0.05,       // OP-stack L2
  scroll: 0.10,      // zkRollup L2
  mantle: 0.03,      // Modular L2 (EigenDA)
  mode: 0.05,        // OP-stack L2
  // Non-EVM
  solana: 0.005,     // ~$0.001-$0.01 (priority fees)
};

/**
 * Get estimated gas cost in USD for a specific chain.
 * Uses chainEstimatedGasCostUsd with fallback to global ARBITRAGE_CONFIG.estimatedGasCost.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Estimated gas cost in USD
 */
export function getEstimatedGasCostUsd(chainId: string): number {
  const key = chainId.toLowerCase();
  return chainEstimatedGasCostUsd[key] ?? ARBITRAGE_CONFIG.estimatedGasCost;
}

// =============================================================================
// CHAIN-SPECIFIC SLIPPAGE TOLERANCE (M-13)
// ETH mainnet needs tighter slippage (higher gas = less room for error).
// L2s and Solana can tolerate wider slippage (low gas, fast blocks).
// =============================================================================

/**
 * Per-chain slippage tolerance overrides.
 * Falls back to ARBITRAGE_CONFIG.slippageTolerance (1%) if chain not listed.
 */
export const chainSlippageTolerance: Record<string, number> = {
  ethereum: 0.005,    // 0.5% — high gas, tighter slippage needed
  bsc: 0.01,          // 1.0% — moderate
  polygon: 0.01,      // 1.0% — standard
  avalanche: 0.01,    // 1.0% — standard
  fantom: 0.015,      // 1.5% — lower liquidity
  arbitrum: 0.01,     // 1.0% — fast confirmations
  optimism: 0.01,     // 1.0% — fast confirmations
  base: 0.01,         // 1.0% — fast confirmations
  zksync: 0.01,       // 1.0% — moderate liquidity
  linea: 0.015,       // 1.5% — lower liquidity
  blast: 0.015,       // 1.5% — lower liquidity
  scroll: 0.015,      // 1.5% — lower liquidity
  mantle: 0.02,       // 2.0% — low liquidity
  mode: 0.02,         // 2.0% — low liquidity
  solana: 0.02,       // 2.0% — fast blocks, wider tolerance ok
};

/**
 * Get slippage tolerance for a specific chain.
 * Uses chainSlippageTolerance with fallback to global ARBITRAGE_CONFIG.slippageTolerance.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Slippage tolerance as decimal (e.g., 0.01 = 1%)
 */
export function getSlippageTolerance(chainId: string): number {
  const key = chainId.toLowerCase();
  return chainSlippageTolerance[key] ?? ARBITRAGE_CONFIG.slippageTolerance;
}

// =============================================================================
// CHAIN-SPECIFIC GAS SPIKE MULTIPLIER
// Per-chain gas spike detection thresholds. Ethereum experiences 5-10x
// spikes during congestion, while L2s are much more stable.
// =============================================================================

/**
 * Per-chain gas spike multiplier thresholds.
 * Gas price is compared to EMA baseline; if current > baseline * multiplier, abort.
 *
 * Rationale for values:
 * - Ethereum 5x: Mainnet experiences 5-10x spikes during NFT mints, MEV wars
 * - BSC/Polygon/Avalanche/Fantom 3x: Alt-L1s can spike during congestion
 * - Arbitrum/Optimism/Base/zkSync/Linea 2x: L2s have more stable gas pricing
 * - Solana 1.5x: Uses priority fees (not EIP-1559 gas), less volatile than L1s
 *
 * NOTE: mantle/mode DEX factories RPC-validated 2026-03-08, added to partitions 2026-03-10.
 *
 * @see gas-price-optimizer.ts — consumer of these thresholds
 */
export const chainGasSpikeMultiplier: Record<string, number> = {
  ethereum: 5.0,
  bsc: 3.0,
  polygon: 3.0,
  avalanche: 3.0,
  fantom: 3.0,
  arbitrum: 2.0,
  optimism: 2.0,
  base: 2.0,
  zksync: 2.0,
  linea: 2.0,
  blast: 2.0,
  scroll: 2.0,
  mantle: 2.0,  // modular L2 (EigenDA), DEX factories RPC-validated 2026-03-08
  mode: 2.0,    // OP-stack L2, DEX factories RPC-validated 2026-03-08
  // P3-28 FIX: Solana uses priority fees (lamports/CU), not EIP-1559 gas.
  // Lower multiplier since fee spikes are less extreme than L1 gas wars.
  solana: 1.5,
};

/**
 * Get gas spike multiplier for a specific chain.
 * Uses chainGasSpikeMultiplier with fallback to global gasPriceSpikeMultiplier.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Spike multiplier (e.g., 5.0 means abort if gas > 5x baseline)
 */
export function getGasSpikeMultiplier(chainId: string): number {
  const key = chainId.toLowerCase();
  return chainGasSpikeMultiplier[key] ?? ARBITRAGE_CONFIG.gasPriceSpikeMultiplier;
}

// =============================================================================
// CHAIN-SPECIFIC CONFIDENCE maxAgeMs
// Per-chain maximum data age for confidence scoring.
// Faster chains need shorter windows because prices go stale faster.
// =============================================================================

/**
 * Per-chain maximum price data age for confidence scoring (milliseconds).
 * Based on block times: approximately 2-3 blocks worth of time per chain.
 *
 * Ethereum (12s blocks): 30s = ~2.5 blocks — data older than this is unreliable
 * BSC (3s blocks): 9s = ~3 blocks
 * L2s (sub-2s blocks): 4-6s = ~2-3 blocks
 * Solana (0.4s blocks): 2s = ~5 slots
 *
 * @see calculateConfidence in price-calculator.ts — consumer of these thresholds
 * @see BLOCK_TIMES_MS in chains/index.ts — authoritative source of block times
 */
export const chainConfidenceMaxAgeMs: Record<string, number> = {
  ethereum: 30000,   // 12s blocks — 30s is ~2.5 blocks
  bsc: 9000,         // 3s blocks — 9s is ~3 blocks
  polygon: 6000,     // 2s blocks — 6s is ~3 blocks
  avalanche: 6000,   // 2s blocks — 6s is ~3 blocks
  fantom: 3000,      // 1s blocks — 3s is ~3 blocks
  arbitrum: 4000,    // 0.25s blocks — 4s is ~16 blocks (conservative for sequencer delays)
  optimism: 6000,    // 2s blocks — 6s is ~3 blocks
  base: 6000,        // 2s blocks — 6s is ~3 blocks
  zksync: 3000,      // ~1s blocks — 3s is ~3 blocks
  linea: 6000,       // ~2s blocks — 6s is ~3 blocks
  blast: 6000,       // 2s blocks — 6s is ~3 blocks
  scroll: 9000,      // 3s blocks — 9s is ~3 blocks
  mantle: 6000,      // 2s blocks — 6s is ~3 blocks
  mode: 6000,        // 2s blocks — 6s is ~3 blocks
  // FIX L10: Increased from 2000ms. WebSocket delivery latency is 500-1500ms,
  // leaving only 500-1000ms of "fresh" window at 2s. 3s gives a safer margin.
  solana: 3000,      // ~400ms blocks — 3s is ~7.5 slots (accounts for WS delivery latency)
};

/** CD-012 FIX: Named constant for the global default confidence max age (ms).
 * Used when no chain-specific override is configured in chainConfidenceMaxAgeMs. */
const DEFAULT_CONFIDENCE_MAX_AGE_MS = 10000;

/**
 * Get confidence maxAgeMs for a specific chain.
 * Uses chainConfidenceMaxAgeMs with fallback to DEFAULT_CONFIDENCE_MAX_AGE_MS.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Maximum price data age in milliseconds
 */
export function getConfidenceMaxAgeMs(chainId: string): number {
  const key = chainId.toLowerCase();
  return chainConfidenceMaxAgeMs[key] ?? DEFAULT_CONFIDENCE_MAX_AGE_MS;
}

// =============================================================================
// CHAIN-SPECIFIC FINALITY BLOCKS
// Number of block confirmations required before considering a transaction final.
// Critical for cross-chain arbitrage: source chain tx must be final before
// the bridge can safely release funds on the destination chain.
// =============================================================================

/**
 * Per-chain finality block counts.
 * Values represent the number of block confirmations needed for practical finality.
 *
 * Ethereum: 2 epochs (~12.8 min) for Casper finality, but 12-15 blocks is standard for most bridges.
 * L2 rollups: Sequencer-confirmed in 1 block, but L1 finality takes longer (challenge period).
 *   For arbitrage purposes, sequencer confirmation (1 block) is sufficient since we trust the sequencer.
 * Solana: Optimistic confirmation at 2/3 validators (~32 slot confirmations).
 *
 * @see cross-chain.strategy.ts — consumer of these thresholds for bridge wait decisions
 */
export const chainFinalityBlocks: Record<string, number> = {
  // L1 chains — slow finality
  ethereum: 15,     // ~3 min at 12s blocks; Casper finality is 2 epochs but 15 blocks is standard bridge threshold
  bsc: 15,          // ~45s at 3s blocks; PoSA finality
  polygon: 128,     // ~4.3 min at 2s blocks; Heimdall checkpoint finality
  avalanche: 1,     // Sub-second finality (Snowman consensus)
  fantom: 1,        // Instant finality (Lachesis aBFT consensus)
  // L2 rollups — sequencer-confirmed fast, L1 finality slow
  // For arbitrage: use sequencer confirmation (1 block) since we trust the L2 sequencer
  arbitrum: 1,      // Sequencer confirmation immediate; L1 finality ~7 days (fraud proof)
  optimism: 1,      // Sequencer confirmation immediate; L1 finality ~7 days (fault proof)
  base: 1,          // Sequencer confirmation immediate (OP-stack)
  zksync: 1,        // Sequencer confirmation; L1 finality via ZK proof (~1-3 hours)
  linea: 1,         // Sequencer confirmation; L1 finality via ZK proof
  blast: 1,         // OP-stack L2
  scroll: 1,        // zkRollup L2
  mantle: 1,        // Modular L2 (EigenDA)
  mode: 1,          // OP-stack L2
  // Non-EVM
  solana: 32,       // ~12.8s at 400ms slots; optimistic confirmation
};

/** Default finality blocks for chains not in the map */
const DEFAULT_FINALITY_BLOCKS = 15;

/**
 * Get finality block count for a specific chain.
 * Uses chainFinalityBlocks with fallback to DEFAULT_FINALITY_BLOCKS.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Number of blocks to wait for finality
 */
export function getFinalityBlocks(chainId: string): number {
  const key = chainId.toLowerCase();
  return chainFinalityBlocks[key] ?? DEFAULT_FINALITY_BLOCKS;
}

// =============================================================================
// CHAIN-SPECIFIC SWAP DEADLINE (P2-09)
// L2s have sub-second blocks — a 300s deadline is 1200 blocks on Arbitrum,
// excessively generous and increases MEV exposure window.
// =============================================================================

/**
 * Per-chain swap deadline in seconds.
 * Shorter deadlines on fast L2s reduce MEV exposure.
 * Flash loan transactions are atomic (same block) so deadline is less critical,
 * but non-flash-loan intra-chain swaps benefit from tighter windows.
 *
 * @see base.strategy.ts getSwapDeadline() — consumer of these thresholds
 */
export const chainSwapDeadlineSeconds: Record<string, number> = {
  // L1 chains — slower blocks, longer deadlines
  ethereum: 300,     // 12s blocks — 25 blocks
  bsc: 120,          // 3s blocks — 40 blocks
  polygon: 120,      // 2s blocks — 60 blocks
  avalanche: 60,     // 2s blocks — 30 blocks (sub-second finality)
  fantom: 60,        // 1s blocks — 60 blocks (instant finality)
  // L2 chains — fast blocks, tighter deadlines to reduce MEV window
  arbitrum: 30,      // 0.25s blocks — 120 blocks
  optimism: 60,      // 2s blocks — 30 blocks
  base: 60,          // 2s blocks — 30 blocks
  zksync: 60,        // ~1s blocks — 60 blocks
  linea: 60,         // ~2s blocks — 30 blocks
  blast: 60,         // 2s blocks — 30 blocks
  scroll: 60,        // 3s blocks — 20 blocks
  mantle: 60,        // 2s blocks — 30 blocks
  mode: 60,          // 2s blocks — 30 blocks
  // Solana: Not applicable (uses slot-based expiry, not Unix deadline)
};

/** Default swap deadline for chains not in the map */
const DEFAULT_SWAP_DEADLINE_SECONDS = 300;

/**
 * Get swap deadline in seconds for a specific chain.
 *
 * @param chainId - Chain identifier (case-insensitive)
 * @returns Swap deadline in seconds
 */
export function getSwapDeadlineSeconds(chainId: string): number {
  const key = chainId.toLowerCase();
  return chainSwapDeadlineSeconds[key] ?? DEFAULT_SWAP_DEADLINE_SECONDS;
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
  const key = chainId.toLowerCase();
  // Use ?? instead of || to correctly handle 0 min profit
  return chainMinProfits[key] ?? ARBITRAGE_CONFIG.minProfitPercentage;
}
