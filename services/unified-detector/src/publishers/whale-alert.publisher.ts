/**
 * Whale Alert Publisher
 *
 * Handles whale detection alerts and swap event publishing.
 * Separates publishing logic from the hot-path detection code.
 *
 * Features:
 * - Whale alert publishing to Redis Streams
 * - Swap event publishing
 * - USD value estimation for swap events
 *
 * @see chain-instance.ts (parent)
 * @see ADR-003: Partitioned Chain Detectors
 */

import { WhaleAlert } from '@arbitrage/core/analytics';
import { RedisStreamsClient } from '@arbitrage/core/redis';
import { safeBigIntToDecimal } from '@arbitrage/core/utils';
import { SwapEvent, Token } from '@arbitrage/types';
import type { Logger } from '../types';
import { STABLECOIN_SYMBOLS_SET, DEFAULT_TOKEN_DECIMALS } from '../constants';

// =============================================================================
// Types
// =============================================================================

export interface WhaleAlertPublisherConfig {
  chainId: string;
  logger: Logger;
  streamsClient: RedisStreamsClient;
  tokens: Token[];
  simulationMode?: boolean;
}

export interface ExtendedPairInfo {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
}

// =============================================================================
// Whale Alert Publisher
// =============================================================================

export class WhaleAlertPublisher {
  private readonly logger: Logger;
  private readonly chainId: string;
  private readonly streamsClient: RedisStreamsClient;
  private readonly tokens: Token[];
  private readonly simulationMode: boolean;
  // PERF-OPT: O(1) token lookup by address (instead of O(N) array.find)
  private readonly tokensByAddress: Map<string, Token>;

  constructor(config: WhaleAlertPublisherConfig) {
    this.chainId = config.chainId;
    this.logger = config.logger;
    this.streamsClient = config.streamsClient;
    this.tokens = config.tokens;
    this.simulationMode = config.simulationMode ?? false;

    // PERF-OPT: Build O(1) token lookup map at construction time
    this.tokensByAddress = new Map();
    for (const token of this.tokens) {
      this.tokensByAddress.set(token.address.toLowerCase(), token);
    }
  }

  // ===========================================================================
  // Publishing Methods
  // ===========================================================================

  /**
   * Publish whale alert to Redis Streams for cross-chain detector consumption.
   */
  async publishWhaleAlert(alert: WhaleAlert): Promise<void> {
    try {
      const whaleTransaction = {
        transactionHash: alert.event.transactionHash || '',
        address: alert.event.sender || '',
        token: alert.pairAddress,
        amount: alert.usdValue,
        usdValue: alert.usdValue,
        direction: BigInt(alert.event.amount0In || '0') > 0n ? 'sell' : 'buy',
        dex: alert.dex,
        chain: this.chainId,
        timestamp: alert.timestamp,
        impact: 0,
        source: this.simulationMode ? 'simulation' as const : 'live' as const,
      };

      // ADR-002: Use xaddWithLimit to prevent unbounded stream growth
      // MAXLEN: 5,000 (configured in STREAM_MAX_LENGTHS)
      await this.streamsClient.xaddWithLimit(
        RedisStreamsClient.STREAMS.WHALE_ALERTS,
        whaleTransaction
      );

      this.logger.info('Whale alert published', {
        usdValue: alert.usdValue,
        dex: alert.dex,
        direction: whaleTransaction.direction
      });
    } catch (error) {
      this.logger.error('Whale alert publish failed', { error });
    }
  }

  /**
   * Publish swap event to Redis Streams.
   */
  async publishSwapEvent(event: SwapEvent): Promise<void> {
    try {
      // ADR-002: Use xaddWithLimit to prevent unbounded stream growth
      // MAXLEN: 50,000 (configured in STREAM_MAX_LENGTHS)
      await this.streamsClient.xaddWithLimit(
        RedisStreamsClient.STREAMS.SWAP_EVENTS,
        event
      );
    } catch (error) {
      this.logger.error('Failed to publish swap event', { error });
    }
  }

  // ===========================================================================
  // USD Value Estimation
  // ===========================================================================

  /**
   * Estimate USD value from a SwapEvent and pair info.
   * Convenience wrapper around estimateSwapUsdValue for cleaner API.
   *
   * @param swap - The swap event containing amounts
   * @param pair - Extended pair info with reserves
   * @returns Estimated USD value
   */
  estimateUsdValue(swap: SwapEvent, pair: ExtendedPairInfo): number {
    return this.estimateSwapUsdValue(
      pair,
      swap.amount0In,
      swap.amount1In,
      swap.amount0Out,
      swap.amount1Out
    );
  }

  /**
   * Estimate USD value of a swap for whale detection.
   * Uses stablecoin amounts directly or estimates via reserve ratios.
   *
   * P0 FIX: Uses safeBigIntToDecimal to prevent precision loss for
   * extremely large swap amounts (> 2^53 wei).
   */
  estimateSwapUsdValue(
    pair: ExtendedPairInfo,
    amount0In: string,
    amount1In: string,
    amount0Out: string,
    amount1Out: string
  ): number {
    try {
      const token0Symbol = this.getTokenSymbol(pair.token0);
      const token1Symbol = this.getTokenSymbol(pair.token1);
      const token0Decimals = this.getTokenDecimals(pair.token0);
      const token1Decimals = this.getTokenDecimals(pair.token1);

      // P0 FIX: Use safeBigIntToDecimal for precision-safe conversion
      // This function divides in BigInt space first, avoiding precision loss
      // for values > MAX_SAFE_INTEGER (2^53)
      const amt0In = safeBigIntToDecimal(amount0In, token0Decimals);
      const amt1In = safeBigIntToDecimal(amount1In, token1Decimals);
      const amt0Out = safeBigIntToDecimal(amount0Out, token0Decimals);
      const amt1Out = safeBigIntToDecimal(amount1Out, token1Decimals);

      // If any conversion returned null, the amount is astronomically large
      // (> 9 quadrillion tokens) - return 0 to indicate estimation failure
      if (amt0In === null || amt1In === null || amt0Out === null || amt1Out === null) {
        // FIX 11: Add context to help debug which amounts caused overflow
        this.logger.debug('USD value estimation skipped: amount too large for safe conversion', {
          pair: pair.address?.slice(0, 10),
          failedFields: [
            amt0In === null && 'amount0In',
            amt1In === null && 'amount1In',
            amt0Out === null && 'amount0Out',
            amt1Out === null && 'amount1Out',
          ].filter(Boolean),
        });
        return 0;
      }

      // If token0 is a stablecoin, use its amounts directly as USD
      if (this.isStablecoin(token0Symbol)) {
        return Math.max(amt0In, amt0Out);
      }

      // If token1 is a stablecoin, use its amounts directly as USD
      if (this.isStablecoin(token1Symbol)) {
        return Math.max(amt1In, amt1Out);
      }

      // Neither token is a stablecoin - estimate using reserve ratios
      // P0 FIX: Use safeBigIntToDecimal for reserves too
      const reserve0 = safeBigIntToDecimal(pair.reserve0, token0Decimals);
      const reserve1 = safeBigIntToDecimal(pair.reserve1, token1Decimals);

      // Guard against null (conversion failure) or zero reserves
      if (reserve0 === null || reserve1 === null || !reserve0 || !reserve1) {
        return 0;
      }

      // Estimate token values based on reserve ratio
      const token0MaxAmount = Math.max(amt0In, amt0Out);
      const token1MaxAmount = Math.max(amt1In, amt1Out);

      // Use the larger of the two estimates
      const estimate0 = token0MaxAmount * (reserve1 / reserve0);
      const estimate1 = token1MaxAmount * (reserve0 / reserve1);

      // Guard against NaN/Infinity results
      const maxEstimate = Math.max(estimate0, estimate1);
      return Number.isFinite(maxEstimate) ? maxEstimate : 0;
    } catch (error) {
      this.logger.debug('USD value estimation failed', { error: (error as Error).message });
      return 0;
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Get token symbol from address.
   */
  private getTokenSymbol(address: string): string {
    // PERF-OPT: O(1) lookup instead of O(N) array.find()
    const token = this.tokensByAddress.get(address.toLowerCase());
    return token?.symbol || address.slice(0, 8);
  }

  /**
   * Get token decimals for accurate amount conversion.
   */
  private getTokenDecimals(address: string): number {
    // PERF-OPT: O(1) lookup instead of O(N) array.find()
    const token = this.tokensByAddress.get(address.toLowerCase());
    return token?.decimals ?? DEFAULT_TOKEN_DECIMALS;
  }

  /**
   * Check if a token symbol represents a stablecoin.
   * FIX Refactor 9.3: Use centralized STABLECOIN_SYMBOLS constant
   * FIX #31: O(1) Set.has instead of O(9) Array.includes
   */
  private isStablecoin(symbol: string): boolean {
    return STABLECOIN_SYMBOLS_SET.has(symbol.toUpperCase());
  }
}
