/**
 * Feeds Module
 *
 * External price feed integrations:
 * - BinanceWebSocketClient: Real-time trade stream from Binance
 * - CexPriceNormalizer: Maps Binance symbols to internal token IDs
 * - CowSettlementWatcher: Monitors CoW Protocol batch settlements on Ethereum
 * - DataGapBackfiller: Fills missed blockchain events via eth_getLogs after reconnection
 *
 * @module feeds
 */

// Binance WebSocket Client
export {
  BinanceWebSocketClient,
} from './binance-ws-client';
export type {
  BinanceTradeEvent,
  BinanceWsConfig,
} from './binance-ws-client';

// CoW Protocol Settlement Watcher
export {
  CowSettlementWatcher,
  GPV2_SETTLEMENT_ADDRESS,
} from './cow-settlement-watcher';
export type {
  CowTrade,
  CowSettlement,
  CowWatcherConfig,
} from './cow-settlement-watcher';

// CEX Price Normalizer
export {
  CexPriceNormalizer,
} from './cex-price-normalizer';
export type {
  NormalizedCexPrice,
  TokenMapping,
  CexNormalizerConfig,
} from './cex-price-normalizer';

// Data Gap Backfiller (C3 fix)
export {
  DataGapBackfiller,
} from './data-gap-backfiller';
export type {
  DataGapEvent,
  EthLog,
  DataGapSource,
  DataGapBackfillerConfig,
  BackfillStats,
  DataGapBackfillerLogger,
} from './data-gap-backfiller';
