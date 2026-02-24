/**
 * CoW Protocol Backrun Detector
 *
 * Analyzes CoW Protocol batch settlements to detect backrun opportunities.
 * When a settlement displaces DEX prices, a backrun trade in the opposite
 * direction can capture the price reversion for profit.
 *
 * ## How It Works
 *
 * 1. Receives settlement events from CowSettlementWatcher
 * 2. For each trade in the settlement, estimates the price impact on DEX pools
 * 3. If the estimated profit from backrunning exceeds the configured minimum,
 *    emits an ArbitrageOpportunity with type 'backrun'
 * 4. The opportunity is routed to BackrunStrategy for execution via Flashbots
 *
 * ## Price Impact Estimation
 *
 * Uses the constant-product AMM formula to estimate price displacement:
 *   priceImpact ≈ tradeSize / (2 * poolReserve)
 *
 * This is a conservative estimate. The actual impact depends on the specific
 * pool(s) used by the CoW solver, which we don't have visibility into.
 *
 * ## Feature Flag
 *
 * Requires FEATURE_COW_BACKRUN=true to be active in production.
 *
 * @see shared/core/src/feeds/cow-settlement-watcher.ts - Provides settlement events
 * @see services/execution-engine/src/strategies/backrun.strategy.ts - Executes backruns
 * @see Phase 4 Task 23: CoW backrun detector
 * @module detector
 */

import { EventEmitter } from 'events';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { CowSettlementWatcher, CowSettlement, CowTrade } from '../feeds/cow-settlement-watcher';
import { GPV2_SETTLEMENT_ADDRESS } from '../feeds/cow-settlement-watcher';
import { createLogger } from '../logger';

const logger = createLogger('cow-backrun-detector');

// =============================================================================
// Constants
// =============================================================================

/**
 * Default assumed pool reserve in USD for price impact estimation.
 * Used when actual pool reserves are unknown.
 * Conservative estimate: average Uniswap V2/V3 pool depth for major pairs.
 */
const DEFAULT_POOL_RESERVE_USD = 5_000_000;

/**
 * Approximate ETH price in USD for trade size estimation.
 * This is a rough approximation; real implementation would use a price oracle.
 */
const APPROXIMATE_ETH_PRICE_USD = 2500;

/**
 * Known stablecoin addresses on Ethereum mainnet (lowercase).
 * Used to estimate trade value in USD.
 */
const STABLECOIN_ADDRESSES = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x4fabb145d64652a948d72533023f6e7a623c7c53', // BUSD
]);

/**
 * WETH address on Ethereum mainnet (lowercase).
 */
const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the CoW backrun detector.
 */
export interface CowBackrunConfig {
  /** Minimum estimated profit in USD to generate opportunity (default: 10) */
  minProfitUsd: number;
  /** Maximum blocks after settlement to consider backrun viable (default: 2) */
  maxBlockDelay: number;
  /** Minimum trade size in USD to consider for backrun (default: 50000) */
  minTradeSize: number;
  /** Assumed pool reserve in USD for price impact estimation (default: 5,000,000) */
  poolReserveUsd?: number;
}

/**
 * Result of a price impact estimation.
 */
export interface PriceImpactEstimate {
  /** Estimated price impact as a percentage (0-100) */
  impactPct: number;
  /** Estimated profit in USD from backrunning this trade */
  estimatedProfitUsd: number;
}

// =============================================================================
// CowBackrunDetector
// =============================================================================

/**
 * Detects backrun opportunities from CoW Protocol batch settlements.
 *
 * Emits:
 * - 'opportunity' (ArbitrageOpportunity) - Backrun opportunity detected
 *
 * @example
 * ```typescript
 * const detector = new CowBackrunDetector({ minProfitUsd: 10, maxBlockDelay: 2, minTradeSize: 50000 });
 * detector.on('opportunity', (opp) => {
 *   console.log(`Backrun opportunity: ${opp.id}, profit: $${opp.expectedProfit}`);
 * });
 * detector.attachToWatcher(watcher);
 * ```
 */
export class CowBackrunDetector extends EventEmitter {
  private readonly poolReserveUsd: number;
  private settlementHandler: ((settlement: CowSettlement) => void) | null = null;

  constructor(private readonly config: CowBackrunConfig) {
    super();
    this.poolReserveUsd = config.poolReserveUsd ?? DEFAULT_POOL_RESERVE_USD;
  }

  /**
   * Process a settlement and generate backrun opportunities.
   *
   * For each trade in the settlement:
   * 1. Estimate the trade size in USD
   * 2. Filter out small trades (below minTradeSize)
   * 3. Estimate price impact on affected DEX pools
   * 4. If profit > minProfitUsd, generate an ArbitrageOpportunity
   *
   * @param settlement - CoW settlement to analyze
   * @returns Array of backrun opportunities generated
   */
  processSettlement(settlement: CowSettlement): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    if (settlement.trades.length === 0) {
      return opportunities;
    }

    logger.debug('Processing CoW settlement', {
      txHash: settlement.txHash,
      tradeCount: settlement.trades.length,
      solver: settlement.solver,
    });

    for (let index = 0; index < settlement.trades.length; index++) {
      const trade = settlement.trades[index];
      const { impactPct, estimatedProfitUsd } = this.estimatePriceImpact(trade);

      // Estimate trade size for filtering
      const tradeSizeUsd = this.estimateTradeValueUsd(trade);

      if (tradeSizeUsd < this.config.minTradeSize) {
        logger.debug('Skipping small trade', {
          txHash: settlement.txHash,
          index,
          tradeSizeUsd,
          minTradeSize: this.config.minTradeSize,
        });
        continue;
      }

      if (estimatedProfitUsd < this.config.minProfitUsd) {
        logger.debug('Skipping low-profit trade', {
          txHash: settlement.txHash,
          index,
          estimatedProfitUsd,
          minProfitUsd: this.config.minProfitUsd,
        });
        continue;
      }

      const opportunity: ArbitrageOpportunity = {
        id: `cow-backrun-${settlement.txHash}-${index}`,
        type: 'backrun',
        chain: 'ethereum',
        // Backrun = reverse the settlement direction:
        // Buy what the settlement sold (now cheaper), sell what it bought (now more expensive)
        tokenIn: trade.buyToken,
        tokenOut: trade.sellToken,
        confidence: 0.6, // Moderate confidence for settlement-based backruns
        timestamp: Date.now(),
        expectedProfit: estimatedProfitUsd,
        blockNumber: settlement.blockNumber,
        backrunTarget: {
          txHash: settlement.txHash,
          routerAddress: GPV2_SETTLEMENT_ADDRESS,
          // The settlement sold sellToken, so the backrun direction is 'sell'
          // (we sell the token that became more expensive)
          swapDirection: 'sell',
          source: 'cow_protocol',
          estimatedSwapSize: tradeSizeUsd.toFixed(2),
        },
      };

      opportunities.push(opportunity);

      logger.info('CoW backrun opportunity detected', {
        id: opportunity.id,
        txHash: settlement.txHash,
        impactPct: impactPct.toFixed(4),
        estimatedProfitUsd: estimatedProfitUsd.toFixed(2),
        tradeSizeUsd: tradeSizeUsd.toFixed(2),
        tokenIn: trade.buyToken,
        tokenOut: trade.sellToken,
      });
    }

    return opportunities;
  }

  /**
   * Wire up to a CowSettlementWatcher instance.
   * Subscribes to 'settlement' events and processes them.
   *
   * @param watcher - CowSettlementWatcher to subscribe to
   */
  attachToWatcher(watcher: CowSettlementWatcher): void {
    this.detachFromWatcher(watcher);

    this.settlementHandler = (settlement: CowSettlement) => {
      const opportunities = this.processSettlement(settlement);
      for (const opp of opportunities) {
        this.emit('opportunity', opp);
      }
    };

    watcher.on('settlement', this.settlementHandler);

    logger.info('Attached to CowSettlementWatcher');
  }

  /**
   * Detach from a CowSettlementWatcher instance.
   * Removes the settlement event subscription.
   *
   * @param watcher - CowSettlementWatcher to unsubscribe from
   */
  detachFromWatcher(watcher: CowSettlementWatcher): void {
    if (this.settlementHandler) {
      watcher.removeListener('settlement', this.settlementHandler);
      this.settlementHandler = null;

      logger.info('Detached from CowSettlementWatcher');
    }
  }

  /**
   * Estimate the price impact of a trade on DEX pools.
   *
   * Uses the constant-product AMM formula:
   *   priceImpact ≈ tradeSize / (2 * poolReserve)
   *
   * The estimated profit from backrunning is approximately:
   *   profit ≈ priceImpact * tradeSize / 2
   *
   * This captures the triangular relationship: a larger trade creates more
   * displacement, and the backrun captures a fraction of that displacement.
   *
   * @param trade - CoW trade to estimate impact for
   * @returns Price impact percentage and estimated profit in USD
   */
  estimatePriceImpact(trade: CowTrade): PriceImpactEstimate {
    const tradeSizeUsd = this.estimateTradeValueUsd(trade);

    // Constant-product price impact: Δp/p ≈ Δx / (2R)
    // where Δx is trade size and R is pool reserve
    const impactPct = (tradeSizeUsd / (2 * this.poolReserveUsd)) * 100;

    // Estimated profit from capturing the displacement:
    // profit ≈ impactPct/100 * tradeSizeUsd / 2
    // Simplified: profit ≈ tradeSizeUsd^2 / (4 * poolReserve)
    const estimatedProfitUsd = (tradeSizeUsd * tradeSizeUsd) / (4 * this.poolReserveUsd);

    return { impactPct, estimatedProfitUsd };
  }

  /**
   * Estimate the USD value of a trade based on token addresses and amounts.
   *
   * Uses heuristics:
   * - If either token is a stablecoin, use its amount directly
   * - If either token is WETH, use approximate ETH price
   * - Otherwise, use a conservative default estimate
   *
   * @param trade - CoW trade to estimate value for
   * @returns Estimated trade value in USD
   */
  private estimateTradeValueUsd(trade: CowTrade): number {
    const sellTokenLower = trade.sellToken.toLowerCase();
    const buyTokenLower = trade.buyToken.toLowerCase();

    // If sell token is a stablecoin, use sellAmount (6 or 18 decimals)
    if (STABLECOIN_ADDRESSES.has(sellTokenLower)) {
      return this.stablecoinToUsd(trade.sellAmount, sellTokenLower);
    }

    // If buy token is a stablecoin, use buyAmount
    if (STABLECOIN_ADDRESSES.has(buyTokenLower)) {
      return this.stablecoinToUsd(trade.buyAmount, buyTokenLower);
    }

    // If sell token is WETH, estimate from ETH price
    if (sellTokenLower === WETH_ADDRESS) {
      return this.wethToUsd(trade.sellAmount);
    }

    // If buy token is WETH, estimate from ETH price
    if (buyTokenLower === WETH_ADDRESS) {
      return this.wethToUsd(trade.buyAmount);
    }

    // Unknown tokens: use a conservative minimum estimate
    // Assume 18 decimals and $1 per token as a floor
    return Number(trade.sellAmount) / 1e18;
  }

  /**
   * Convert stablecoin amount to USD.
   * Handles both 6-decimal (USDC, USDT) and 18-decimal (DAI, BUSD) stablecoins.
   */
  private stablecoinToUsd(amount: bigint, tokenAddress: string): number {
    // USDC and USDT use 6 decimals
    const sixDecimalStables = new Set([
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    ]);

    if (sixDecimalStables.has(tokenAddress)) {
      return Number(amount) / 1e6;
    }

    // DAI, BUSD use 18 decimals
    return Number(amount) / 1e18;
  }

  /**
   * Convert WETH amount to approximate USD value.
   */
  private wethToUsd(amount: bigint): number {
    return (Number(amount) / 1e18) * APPROXIMATE_ETH_PRICE_USD;
  }
}
