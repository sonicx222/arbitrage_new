/**
 * CEX-DEX Spread Calculator
 *
 * Compares centralized exchange (Binance) prices against decentralized exchange
 * prices to identify spread-based arbitrage opportunities. Tracks spread
 * history and emits alerts when spreads exceed configurable thresholds.
 *
 * Spread calculation:
 *   spreadPct = ((dexPrice - cexPrice) / cexPrice) * 100
 *   Positive = DEX more expensive, Negative = DEX cheaper
 *
 * @module analytics
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';

const logger = createLogger('cex-dex-spread');

// =============================================================================
// Types
// =============================================================================

/**
 * Alert emitted when a spread exceeds the configured threshold.
 */
export interface SpreadAlert {
  /** Internal token ID (e.g., 'WBTC', 'WETH') */
  tokenId: string;
  /** Chain where the DEX price was observed */
  chain: string;
  /** Current CEX price (USD) */
  cexPrice: number;
  /** Current DEX price (USD) on the specified chain */
  dexPrice: number;
  /** Spread percentage: positive = DEX overpriced, negative = DEX underpriced */
  spreadPct: number;
  /** Timestamp of the alert (ms since epoch) */
  timestamp: number;
}

/**
 * Configuration for the spread calculator.
 */
export interface CexDexSpreadConfig {
  /** Absolute spread threshold to trigger alerts (default: 0.3 = 0.3%) */
  alertThresholdPct: number;
  /** Time window for spread history retention in ms (default: 300000 = 5 minutes) */
  historyWindowMs: number;
  /** Maximum number of token-chain pairs to track (default: 50) */
  maxTokens: number;
  /** Maximum age of CEX price before it's considered stale (default: 60000 = 60s) */
  maxCexPriceAgeMs: number;
}

/**
 * Single spread history data point.
 */
export interface SpreadHistoryPoint {
  spreadPct: number;
  timestamp: number;
}

// =============================================================================
// Internal Types
// =============================================================================

interface PriceEntry {
  price: number;
  timestamp: number;
}

interface TokenChainState {
  cexPrice: PriceEntry | null;
  dexPrice: PriceEntry | null;
  history: SpreadHistoryPoint[];
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: CexDexSpreadConfig = {
  alertThresholdPct: 0.3,
  historyWindowMs: 300_000, // 5 minutes
  maxTokens: 50,
  maxCexPriceAgeMs: 10_000, // 10 seconds -- crypto moves 0.5-1% in 60s, generating phantom alerts
};

// =============================================================================
// CexDexSpreadCalculator
// =============================================================================

/**
 * Compares CEX and DEX prices to identify spread-based opportunities.
 *
 * Emits:
 * - 'spread_alert' (SpreadAlert) - When |spread| exceeds threshold
 */
export class CexDexSpreadCalculator extends EventEmitter {
  private config: CexDexSpreadConfig;
  /** Map of "tokenId:chain" -> state */
  private state: Map<string, TokenChainState> = new Map();
  /** Reverse index: tokenId -> Set of "tokenId:chain" keys for O(1) CEX price fan-out */
  private tokenIndex: Map<string, Set<string>> = new Map();

  constructor(config?: Partial<CexDexSpreadConfig>) {
    super();
    this.setMaxListeners(20);
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('CexDexSpreadCalculator initialized', {
      alertThresholdPct: this.config.alertThresholdPct,
      historyWindowMs: this.config.historyWindowMs,
      maxTokens: this.config.maxTokens,
    });
  }

  /**
   * Update CEX price for a token.
   * CEX prices are global (not chain-specific), so this updates all
   * chain entries for the given token.
   *
   * @param tokenId - Internal token ID (e.g., 'WBTC')
   * @param price - USD price
   * @param timestamp - Price timestamp (ms since epoch)
   */
  updateCexPrice(tokenId: string, price: number, timestamp: number): void {
    const entry: PriceEntry = { price, timestamp };

    // Use tokenIndex for O(1) lookup instead of iterating all state entries
    const keys = this.tokenIndex.get(tokenId);
    if (!keys || keys.size === 0) {
      logger.debug('CEX price updated but no DEX chain entries exist yet', { tokenId, price });
      return;
    }

    for (const key of keys) {
      const pairState = this.state.get(key);
      if (pairState) {
        pairState.cexPrice = entry;
        this.checkAndEmitAlert(key, pairState);
      }
    }
  }

  /**
   * Update DEX price for a token on a specific chain.
   *
   * @param tokenId - Internal token ID (e.g., 'WBTC')
   * @param chain - Chain name (e.g., 'ethereum')
   * @param price - USD price on this chain's DEX
   * @param timestamp - Price timestamp (ms since epoch)
   */
  updateDexPrice(tokenId: string, chain: string, price: number, timestamp: number): void {
    const key = `${tokenId}:${chain}`;
    let pairState = this.state.get(key);

    if (!pairState) {
      // Enforce max tokens limit
      if (this.state.size >= this.config.maxTokens) {
        logger.warn('Max token-chain pairs reached, ignoring new pair', {
          key,
          max: this.config.maxTokens,
        });
        return;
      }

      pairState = {
        cexPrice: null,
        dexPrice: null,
        history: [],
      };
      this.state.set(key, pairState);

      // Maintain reverse index for O(1) CEX price fan-out
      let tokenKeys = this.tokenIndex.get(tokenId);
      if (!tokenKeys) {
        tokenKeys = new Set();
        this.tokenIndex.set(tokenId, tokenKeys);
      }
      tokenKeys.add(key);
    }

    pairState.dexPrice = { price, timestamp };
    this.checkAndEmitAlert(key, pairState);
  }

  /**
   * Get the current spread for a token on a chain.
   *
   * @returns Spread percentage, or undefined if either price is missing
   */
  getSpread(tokenId: string, chain: string): number | undefined {
    const key = `${tokenId}:${chain}`;
    const pairState = this.state.get(key);

    if (!pairState?.cexPrice || !pairState?.dexPrice) {
      return undefined;
    }

    return this.calculateSpread(pairState.cexPrice.price, pairState.dexPrice.price);
  }

  /**
   * Get all current spreads that exceed the alert threshold.
   */
  getActiveAlerts(): SpreadAlert[] {
    const alerts: SpreadAlert[] = [];
    const now = Date.now();

    for (const [key, pairState] of this.state) {
      if (!pairState.cexPrice || !pairState.dexPrice) {
        continue;
      }

      const spreadPct = this.calculateSpread(
        pairState.cexPrice.price,
        pairState.dexPrice.price
      );

      if (Math.abs(spreadPct) > this.config.alertThresholdPct) {
        const [tokenId, chain] = key.split(':');
        alerts.push({
          tokenId,
          chain,
          cexPrice: pairState.cexPrice.price,
          dexPrice: pairState.dexPrice.price,
          spreadPct,
          timestamp: now,
        });
      }
    }

    return alerts;
  }

  /**
   * Get spread history for a token-chain pair.
   * Returns entries within the configured history window.
   *
   * @param tokenId - Internal token ID
   * @param chain - Chain name
   * @returns Array of spread history points, newest last
   */
  getSpreadHistory(
    tokenId: string,
    chain: string
  ): SpreadHistoryPoint[] {
    const key = `${tokenId}:${chain}`;
    const pairState = this.state.get(key);

    if (!pairState) {
      return [];
    }

    const cutoff = Date.now() - this.config.historyWindowMs;
    return pairState.history.filter(h => h.timestamp >= cutoff);
  }

  /**
   * Reset all tracked data.
   */
  reset(): void {
    this.state.clear();
    this.tokenIndex.clear();
    logger.info('CexDexSpreadCalculator reset');
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Calculate spread percentage.
   * spreadPct = ((dexPrice - cexPrice) / cexPrice) * 100
   */
  private calculateSpread(cexPrice: number, dexPrice: number): number {
    if (cexPrice === 0) {
      return 0;
    }
    return ((dexPrice - cexPrice) / cexPrice) * 100;
  }

  /**
   * Check if current spread exceeds threshold and emit alert.
   * Also records the spread in history.
   */
  private checkAndEmitAlert(key: string, pairState: TokenChainState): void {
    if (!pairState.cexPrice || !pairState.dexPrice) {
      return;
    }

    const now = Date.now();

    // Reject stale CEX prices (e.g., Binance WebSocket disconnected)
    if (now - pairState.cexPrice.timestamp > this.config.maxCexPriceAgeMs) {
      logger.debug('Skipping spread check: stale CEX price', {
        key,
        cexPriceAge: now - pairState.cexPrice.timestamp,
        maxAge: this.config.maxCexPriceAgeMs,
      });
      return;
    }

    const spreadPct = this.calculateSpread(
      pairState.cexPrice.price,
      pairState.dexPrice.price
    );

    // Record in history
    pairState.history.push({ spreadPct, timestamp: now });

    // Trim old history entries (amortized cleanup).
    // History is chronological, so find the first entry within the window
    // and splice from the front — avoids allocating a new array via filter().
    if (pairState.history.length > 500) {
      const cutoff = now - this.config.historyWindowMs;
      let trimCount = 0;
      while (trimCount < pairState.history.length && pairState.history[trimCount].timestamp < cutoff) {
        trimCount++;
      }
      if (trimCount > 0) {
        pairState.history.splice(0, trimCount);
      }
    }

    // Check threshold
    if (Math.abs(spreadPct) > this.config.alertThresholdPct) {
      const [tokenId, chain] = key.split(':');
      const alert: SpreadAlert = {
        tokenId,
        chain,
        cexPrice: pairState.cexPrice.price,
        dexPrice: pairState.dexPrice.price,
        spreadPct,
        timestamp: now,
      };

      logger.info('Spread alert triggered', {
        tokenId,
        chain,
        spreadPct: spreadPct.toFixed(4),
        cexPrice: pairState.cexPrice.price,
        dexPrice: pairState.dexPrice.price,
      });

      this.emit('spread_alert', alert);
    }
  }
}
