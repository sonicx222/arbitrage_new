/**
 * Cross-Chain Arbitrage Detector
 *
 * Detects price differences between Solana and EVM chains.
 * Compares normalized token prices to find arbitrage opportunities.
 *
 * Features:
 * - Fee-aware profit calculation
 * - Bridge cost estimation
 * - Latency risk premium
 * - Configurable cost parameters
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import type { VersionedPoolStore } from '../pool/versioned-pool-store';
import type { OpportunityFactory } from '../opportunity-factory';
import type {
  SolanaArbitrageOpportunity,
  EvmPriceUpdate,
  CrossChainPriceComparison,
  SolanaArbitrageLogger,
} from '../types';
import {
  isValidPrice,
  isPriceStale,
  basisPointsToDecimal,
  meetsThreshold,
  getDefaultPrice,
  getEvmGasCostUsd,
  DEFAULT_DETECTION_CONFIG,
  CROSS_CHAIN_EXPIRY_MULTIPLIER,
  DEFAULT_SOL_PRICE_USD,
} from './base';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for cross-chain detection.
 */
export interface CrossChainDetectorConfig {
  /** Minimum profit threshold as decimal (e.g., 0.003 = 0.3%) */
  minProfitThreshold: number;
  /** Price staleness threshold in ms */
  priceStalenessMs: number;
  /** Default trade value in USD for gas estimation */
  defaultTradeValueUsd: number;
  /** Cross-chain cost configuration */
  crossChainCosts: {
    /** Bridge fee as decimal */
    bridgeFeeDefault: number;
    /** EVM gas cost in USD */
    evmGasCostUsd: number;
    /** Solana transaction cost in USD */
    solanaTxCostUsd: number;
    /** Latency risk premium as decimal */
    latencyRiskPremium: number;
  };
}

/**
 * Detection result with statistics.
 */
export interface CrossChainDetectionResult {
  /** Found opportunities */
  opportunities: SolanaArbitrageOpportunity[];
  /** Price comparisons made */
  comparisons: CrossChainPriceComparison[];
  /** Detection latency in ms */
  latencyMs: number;
}

/**
 * Token normalization function signature.
 */
export type TokenNormalizer = (symbol: string) => string;

// =============================================================================
// Price Comparison
// =============================================================================

/**
 * Compare Solana pool prices with EVM prices.
 *
 * @param evmPrices - EVM price updates
 * @param poolStore - Pool store with Solana pools
 * @param normalizeToken - Token normalization function
 * @param createPairKey - Pair key creation function
 * @param config - Detection configuration
 * @param logger - Optional logger
 * @returns Price comparisons
 */
export function compareCrossChainPrices(
  evmPrices: EvmPriceUpdate[],
  poolStore: VersionedPoolStore,
  normalizeToken: TokenNormalizer,
  createPairKey: (token0: string, token1: string) => string,
  config: CrossChainDetectorConfig,
  logger?: SolanaArbitrageLogger
): CrossChainPriceComparison[] {
  const comparisons: CrossChainPriceComparison[] = [];

  for (const evmPrice of evmPrices) {
    const evmToken0 = normalizeToken(evmPrice.token0);
    const evmToken1 = normalizeToken(evmPrice.token1);
    const evmPairKey = createPairKey(evmToken0, evmToken1);

    const allSolanaPools = poolStore.getPoolsForPair(evmPairKey);
    for (const solanaPool of allSolanaPools) {
      if (!isValidPrice(solanaPool.price) || isPriceStale(solanaPool, config.priceStalenessMs, logger)) continue;
      // Raw price difference - fees are applied in detection
      const priceDiff = ((evmPrice.price - solanaPool.price!) / solanaPool.price!) * 100;

      comparisons.push({
        token: solanaPool.normalizedToken0,
        quoteToken: solanaPool.normalizedToken1,
        solanaPrice: solanaPool.price!,
        solanaDex: solanaPool.dex,
        solanaPoolAddress: solanaPool.address,
        evmChain: evmPrice.chain,
        evmDex: evmPrice.dex,
        evmPrice: evmPrice.price,
        evmPairKey: evmPrice.pairKey,
        priceDifferencePercent: priceDiff,
        timestamp: Date.now(),
        solanaFee: solanaPool.fee,
        evmFee: evmPrice.fee,
      });
    }
  }

  return comparisons;
}

/**
 * Estimate cross-chain gas costs as a percentage of trade value.
 *
 * When evmChain is provided, uses per-chain gas cost estimates
 * (e.g., Arbitrum ~$0.10 vs Ethereum ~$15) instead of the flat default.
 *
 * @param config - Detection configuration
 * @param evmChain - Optional EVM chain name for chain-specific gas cost
 * @returns Gas cost as decimal
 */
export function estimateCrossChainGasCostPercent(config: CrossChainDetectorConfig, evmChain?: string): number {
  const evmGasCost = evmChain
    ? getEvmGasCostUsd(evmChain, config.crossChainCosts.evmGasCostUsd)
    : config.crossChainCosts.evmGasCostUsd;
  const solanaTxCost = config.crossChainCosts.solanaTxCostUsd;
  const totalGasCostUsd = evmGasCost + solanaTxCost;
  return totalGasCostUsd / config.defaultTradeValueUsd;
}

// =============================================================================
// Main Detection Function
// =============================================================================

/**
 * Detect cross-chain arbitrage opportunities.
 *
 * @param evmPrices - EVM price updates
 * @param poolStore - Pool store with Solana pools
 * @param opportunityFactory - Factory for creating opportunities
 * @param normalizeToken - Token normalization function
 * @param createPairKey - Pair key creation function
 * @param config - Detection configuration
 * @param logger - Optional logger
 * @returns Detection result with opportunities
 */
export function detectCrossChainArbitrage(
  evmPrices: EvmPriceUpdate[],
  poolStore: VersionedPoolStore,
  opportunityFactory: OpportunityFactory,
  normalizeToken: TokenNormalizer,
  createPairKey: (token0: string, token1: string) => string,
  config: CrossChainDetectorConfig,
  logger?: SolanaArbitrageLogger
): CrossChainDetectionResult {
  const startTime = Date.now();
  const opportunities: SolanaArbitrageOpportunity[] = [];
  const thresholdDecimal = config.minProfitThreshold / 100;

  // Get price comparisons
  const comparisons = compareCrossChainPrices(
    evmPrices,
    poolStore,
    normalizeToken,
    createPairKey,
    config,
    logger
  );

  for (const comparison of comparisons) {
    // Calculate net profit after accounting for all costs
    const solanaFeeDecimal = comparison.solanaFee !== undefined
      ? basisPointsToDecimal(comparison.solanaFee)
      : 0.003; // Default 0.3%
    const evmFeeDecimal = comparison.evmFee !== undefined
      ? basisPointsToDecimal(comparison.evmFee)
      : 0.003; // Default 0.3%

    // Total costs:
    // 1. Trading fees on both chains
    const tradingFees = solanaFeeDecimal + evmFeeDecimal;

    // 2. Bridge fee
    const bridgeFee = config.crossChainCosts.bridgeFeeDefault;

    // 3. Gas costs as percentage of trade value (per-chain: Fix #21)
    const gasCostPercent = estimateCrossChainGasCostPercent(config, comparison.evmChain);

    // 4. Latency risk premium
    const latencyRisk = config.crossChainCosts.latencyRiskPremium;

    // Total costs
    const totalCosts = tradingFees + bridgeFee + gasCostPercent + latencyRisk;

    const grossDiff = Math.abs(comparison.priceDifferencePercent) / 100;
    const netProfit = grossDiff - totalCosts;

    if (!meetsThreshold(netProfit, thresholdDecimal)) {
      continue;
    }

    const direction = comparison.solanaPrice < comparison.evmPrice
      ? 'buy-solana-sell-evm'
      : 'buy-evm-sell-solana';

    const opportunity = opportunityFactory.createCrossChain(
      comparison,
      direction,
      netProfit,
      CROSS_CHAIN_EXPIRY_MULTIPLIER
    );

    // Add estimated gas cost for transparency
    opportunity.estimatedGasCost = gasCostPercent;

    opportunities.push(opportunity);
  }

  return {
    opportunities,
    comparisons,
    latencyMs: Date.now() - startTime,
  };
}

// =============================================================================
// Default Configuration Helper
// =============================================================================

/**
 * Get default cross-chain costs configuration.
 *
 * @returns Default costs configuration
 */
export function getDefaultCrossChainCosts(): CrossChainDetectorConfig['crossChainCosts'] {
  return { ...DEFAULT_DETECTION_CONFIG.crossChainCosts };
}
