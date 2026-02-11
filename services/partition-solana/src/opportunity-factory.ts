/**
 * Opportunity Factory
 *
 * Factory for creating arbitrage opportunities with consistent IDs and timestamps.
 *
 * Features:
 * - Fast ID generation without Math.random() in hot path
 * - Consistent opportunity structure across all types
 * - Configurable expiry times
 * - Cross-chain expiry multiplier support
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import type {
  InternalPoolInfo,
  SolanaArbitrageOpportunity,
  TriangularPath,
  CrossChainPriceComparison,
} from './types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Confidence scores for different arbitrage types.
 *
 * These values represent the estimated reliability of the arbitrage opportunity:
 * - INTRA_SOLANA (0.85): Highest confidence - same chain, fast execution
 * - TRIANGULAR (0.75): Medium confidence - multiple hops increase slippage risk
 * - CROSS_CHAIN (0.6): Lower confidence - bridge delays, price volatility
 */
export const CONFIDENCE_SCORES = {
  INTRA_SOLANA: 0.85,
  TRIANGULAR: 0.75,
  CROSS_CHAIN: 0.6,
} as const;

// =============================================================================
// ID Generator
// =============================================================================

/**
 * Fast ID generator using counter instead of Math.random().
 *
 * Uses process.pid and timestamp for uniqueness across instances.
 * Counter increments provide ordering within a single instance.
 */
export class IdGenerator {
  private counter = 0;
  private readonly prefix: string;

  /**
   * Create a new IdGenerator.
   *
   * @param prefix - Optional custom prefix (defaults to pid-timestamp)
   */
  constructor(prefix?: string) {
    // Use process.pid and timestamp for uniqueness across instances
    this.prefix = prefix || `${process.pid}-${Date.now().toString(36)}`;
  }

  /**
   * Generate the next ID.
   *
   * @param type - Type identifier (e.g., "arb", "tri", "xchain")
   * @returns Unique ID string
   */
  next(type: string): string {
    return `sol-${type}-${this.prefix}-${(++this.counter).toString(36)}`;
  }

  /**
   * Get the current counter value (for debugging).
   */
  getCounter(): number {
    return this.counter;
  }
}

// =============================================================================
// Opportunity Factory
// =============================================================================

/**
 * Factory for creating arbitrage opportunities.
 *
 * Centralizes opportunity creation to ensure consistent structure
 * and reduce code duplication in detection modules.
 */
export class OpportunityFactory {
  private readonly idGen: IdGenerator;
  private readonly chainId: string;
  private readonly expiryMs: number;

  /**
   * Create a new OpportunityFactory.
   *
   * @param chainId - Chain identifier (e.g., "solana", "solana-devnet")
   * @param expiryMs - Default opportunity expiry time in milliseconds
   */
  constructor(chainId: string, expiryMs: number) {
    this.idGen = new IdGenerator();
    this.chainId = chainId;
    this.expiryMs = expiryMs;
  }

  /**
   * Create an intra-Solana arbitrage opportunity.
   *
   * @param buyPool - Pool to buy from (lower price)
   * @param sellPool - Pool to sell to (higher price)
   * @param netProfit - Net profit as decimal (after fees)
   * @param gasCost - Estimated gas cost as decimal
   * @returns Arbitrage opportunity
   */
  createIntraSolana(
    buyPool: InternalPoolInfo,
    sellPool: InternalPoolInfo,
    netProfit: number,
    gasCost: number
  ): SolanaArbitrageOpportunity {
    const timestamp = Date.now();
    return {
      id: this.idGen.next('arb'),
      type: 'intra-solana',
      chain: this.chainId,
      buyDex: buyPool.dex,
      sellDex: sellPool.dex,
      buyPair: buyPool.address,
      sellPair: sellPool.address,
      token0: buyPool.normalizedToken0,
      token1: buyPool.normalizedToken1,
      buyPrice: buyPool.price!,
      sellPrice: sellPool.price!,
      profitPercentage: netProfit * 100,
      expectedProfit: netProfit,
      estimatedGasCost: gasCost,
      netProfitAfterGas: netProfit - gasCost,
      confidence: CONFIDENCE_SCORES.INTRA_SOLANA,
      timestamp,
      expiresAt: timestamp + this.expiryMs,
      status: 'pending',
    };
  }

  /**
   * Create a triangular arbitrage opportunity.
   *
   * @param path - Complete triangular path
   * @returns Arbitrage opportunity
   */
  createTriangular(path: TriangularPath): SolanaArbitrageOpportunity {
    const timestamp = Date.now();
    return {
      id: this.idGen.next('tri'),
      type: 'triangular',
      chain: this.chainId,
      buyDex: path.steps[0]?.dex || 'unknown',
      sellDex: path.steps[path.steps.length - 1]?.dex || 'unknown',
      buyPair: path.steps[0]?.pool || '',
      sellPair: path.steps[path.steps.length - 1]?.pool || '',
      token0: path.inputToken,
      token1: path.outputToken,
      buyPrice: path.steps[0]?.price ?? 0,
      sellPrice: path.steps[path.steps.length - 1]?.price ?? 0,
      profitPercentage: path.profitPercentage,
      expectedProfit: path.profitPercentage / 100,
      estimatedOutput: path.estimatedOutput,
      path: path.steps,
      confidence: CONFIDENCE_SCORES.TRIANGULAR,
      timestamp,
      expiresAt: timestamp + this.expiryMs,
      status: 'pending',
    };
  }

  /**
   * Create a cross-chain arbitrage opportunity.
   *
   * @param comparison - Price comparison result
   * @param direction - Trade direction
   * @param profit - Net profit as decimal
   * @param crossChainExpiryMultiplier - Multiplier for expiry time
   * @returns Arbitrage opportunity
   */
  createCrossChain(
    comparison: CrossChainPriceComparison,
    direction: 'buy-solana-sell-evm' | 'buy-evm-sell-solana',
    profit: number,
    crossChainExpiryMultiplier: number
  ): SolanaArbitrageOpportunity {
    const timestamp = Date.now();
    const buyPair = direction === 'buy-solana-sell-evm'
      ? comparison.solanaPoolAddress
      : comparison.evmPairKey;
    const sellPair = direction === 'buy-solana-sell-evm'
      ? comparison.evmPairKey
      : comparison.solanaPoolAddress;

    return {
      id: this.idGen.next('xchain'),
      type: 'cross-chain',
      chain: this.chainId,
      sourceChain: this.chainId,
      targetChain: comparison.evmChain,
      direction,
      buyDex: direction === 'buy-solana-sell-evm' ? comparison.solanaDex : comparison.evmDex,
      sellDex: direction === 'buy-solana-sell-evm' ? comparison.evmDex : comparison.solanaDex,
      buyPair,
      sellPair,
      token0: comparison.token,
      token1: comparison.quoteToken,
      token: comparison.token,
      quoteToken: comparison.quoteToken,
      buyPrice: direction === 'buy-solana-sell-evm' ? comparison.solanaPrice : comparison.evmPrice,
      sellPrice: direction === 'buy-solana-sell-evm' ? comparison.evmPrice : comparison.solanaPrice,
      profitPercentage: profit * 100,
      expectedProfit: profit,
      confidence: CONFIDENCE_SCORES.CROSS_CHAIN,
      timestamp,
      expiresAt: timestamp + this.expiryMs * crossChainExpiryMultiplier,
      status: 'pending',
    };
  }

  /**
   * Get the chain ID for this factory.
   */
  getChainId(): string {
    return this.chainId;
  }

  /**
   * Get the default expiry time.
   */
  getExpiryMs(): number {
    return this.expiryMs;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an opportunity factory for the specified chain.
 *
 * @param chainId - Chain identifier
 * @param expiryMs - Opportunity expiry time in milliseconds
 * @returns New OpportunityFactory instance
 */
export function createOpportunityFactory(chainId: string, expiryMs: number): OpportunityFactory {
  return new OpportunityFactory(chainId, expiryMs);
}
