/**
 * Factory Event Parsers
 *
 * Centralized exports for all DEX factory event parsers.
 * Each parser handles a specific factory type's pool creation events.
 *
 * @module factory-subscription/parsers
 */

// =============================================================================
// Types
// =============================================================================

export { PairCreatedEvent, RawEventLog } from './types';

// =============================================================================
// Utilities
// =============================================================================

export {
  // Constants
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  ADDRESS_PADDING_OFFSET,
  FIRST_ADDRESS_START,
  SECOND_VALUE_START,
  ZERO_ADDRESS,
  // Functions
  extractAddressFromTopic,
  extractAddressFromDataWord,
  extractBigIntFromDataWord,
  extractUint256FromDataWord,
  parseSignedInt24,
  validateLogStructure,
} from './utils';

// =============================================================================
// V2 Parser (Uniswap V2, SushiSwap, PancakeSwap forks)
// =============================================================================

export { parseV2PairCreatedEvent } from './v2-pair-parser';

// =============================================================================
// V3 Parser (Uniswap V3, Camelot V3, concentrated liquidity)
// =============================================================================

export { parseV3PoolCreatedEvent } from './v3-pool-parser';

// =============================================================================
// Solidly Parser (Velodrome, Aerodrome, stable/volatile pairs)
// =============================================================================

export { parseSolidlyPairCreatedEvent } from './solidly-parser';

// =============================================================================
// Algebra Parser (Dynamic fee DEXes)
// =============================================================================

export { parseAlgebraPoolCreatedEvent } from './algebra-parser';

// =============================================================================
// Trader Joe Parser (Liquidity Book AMM)
// =============================================================================

export { parseTraderJoePairCreatedEvent } from './trader-joe-parser';

// =============================================================================
// Curve Parser (PlainPool, MetaPool, multi-asset)
// =============================================================================

export {
  CURVE_PLAIN_POOL_SIGNATURE,
  CURVE_META_POOL_SIGNATURE,
  parseCurvePlainPoolDeployedEvent,
  parseCurveMetaPoolDeployedEvent,
  parseCurvePoolCreatedEvent,
} from './curve-parser';

// =============================================================================
// Balancer V2 Parser (Pool registration with separate token events)
// =============================================================================

export {
  BALANCER_TOKENS_REGISTERED_SIGNATURE,
  parseBalancerPoolRegisteredEvent,
  parseBalancerTokensRegisteredEvent,
  BalancerTokensRegisteredResult,
} from './balancer-v2-parser';
