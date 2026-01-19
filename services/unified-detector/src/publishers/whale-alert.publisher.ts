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

import { RedisStreamsClient, WhaleAlert } from '@arbitrage/core';
import { SwapEvent, Token } from '@arbitrage/types';
import type { Logger } from '../types';

// =============================================================================
// Types
// =============================================================================

export interface WhaleAlertPublisherConfig {
  chainId: string;
  logger: Logger;
  streamsClient: RedisStreamsClient;
  tokens: Token[];
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

  constructor(config: WhaleAlertPublisherConfig) {
    this.chainId = config.chainId;
    this.logger = config.logger;
    this.streamsClient = config.streamsClient;
    this.tokens = config.tokens;
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
        impact: 0
      };

      await this.streamsClient.xadd(
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
      await this.streamsClient.xadd(
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
   * Estimate USD value of a swap for whale detection.
   * Uses stablecoin amounts directly or estimates via reserve ratios.
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

      // Convert amounts to human-readable numbers
      const amt0In = Number(BigInt(amount0In)) / Math.pow(10, token0Decimals);
      const amt1In = Number(BigInt(amount1In)) / Math.pow(10, token1Decimals);
      const amt0Out = Number(BigInt(amount0Out)) / Math.pow(10, token0Decimals);
      const amt1Out = Number(BigInt(amount1Out)) / Math.pow(10, token1Decimals);

      // If token0 is a stablecoin, use its amounts directly as USD
      if (this.isStablecoin(token0Symbol)) {
        return Math.max(amt0In, amt0Out);
      }

      // If token1 is a stablecoin, use its amounts directly as USD
      if (this.isStablecoin(token1Symbol)) {
        return Math.max(amt1In, amt1Out);
      }

      // Neither token is a stablecoin - estimate using reserve ratios
      const reserve0 = Number(BigInt(pair.reserve0)) / Math.pow(10, token0Decimals);
      const reserve1 = Number(BigInt(pair.reserve1)) / Math.pow(10, token1Decimals);

      if (reserve0 > 0 && reserve1 > 0) {
        // Estimate token values based on reserve ratio
        const token0MaxAmount = Math.max(amt0In, amt0Out);
        const token1MaxAmount = Math.max(amt1In, amt1Out);

        // Use the larger of the two estimates
        const estimate0 = token0MaxAmount * (reserve1 / reserve0);
        const estimate1 = token1MaxAmount * (reserve0 / reserve1);

        return Math.max(estimate0, estimate1);
      }

      // Fallback: return 0 if we can't estimate
      return 0;
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
    const token = this.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    return token?.symbol || address.slice(0, 8);
  }

  /**
   * Get token decimals for accurate amount conversion.
   */
  private getTokenDecimals(address: string): number {
    const token = this.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    return token?.decimals ?? 18; // Default to 18 decimals
  }

  /**
   * Check if a token symbol represents a stablecoin.
   */
  private isStablecoin(symbol: string): boolean {
    const stableSymbols = ['USDT', 'USDC', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP', 'UST', 'MIM'];
    return stableSymbols.includes(symbol.toUpperCase());
  }
}
