/**
 * Test Factories Index
 *
 * Centralized exports for all test factories.
 */

export {
  createSwapEvent,
  createSwapEvents,
  SwapEventBuilder,
  swapEvent,
  resetSwapEventFactory,
  getSwapEventCounter,
  createEthereumSwap,
  createBscSwap,
  createWhaleSwap,
  createDustSwap,
  createZeroAmountSwap,
  createSwapBatch
} from './swap-event.factory';

export type { SwapEvent, SwapEventOverrides } from './swap-event.factory';

export {
  createPriceUpdate,
  PriceUpdateBuilder,
  priceUpdate,
  resetPriceUpdateFactory,
  createEthUsdcPrice,
  createBnbBusdPrice,
  createArbitragePricePair
} from './price-update.factory';

export type { PriceUpdate, PriceUpdateOverrides } from './price-update.factory';

// Bridge Quote Factory
export {
  createBridgeQuote,
  createBridgeQuotes,
  BridgeQuoteBuilder,
  bridgeQuote,
  resetBridgeQuoteFactory,
  getBridgeQuoteCounter,
  createEthToArbQuote,
  createL2ToL2Quote,
  createExpiredQuote,
  createHighFeeQuote
} from './bridge-quote.factory';

export type { BridgeQuote, BridgeQuoteOverrides } from './bridge-quote.factory';

// Stream Message Factory
export {
  createStreamMessage,
  createStreamMessages,
  createRawStreamMessage,
  createRawStreamMessages,
  StreamMessageBuilder,
  streamMessage,
  resetStreamMessageFactory,
  getStreamMessageCounter,
  createPriceUpdateMessage,
  createSwapEventMessage,
  createArbitrageOpportunityMessage,
  createWhaleAlertMessage,
  createHealthUpdateMessage,
  createMessageBatch
} from './stream-message.factory';

export type {
  StreamMessage,
  RawStreamMessage,
  StreamMessageOverrides
} from './stream-message.factory';
