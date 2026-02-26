/**
 * V3 Pool Parser
 *
 * Parses Uniswap V3-style PoolCreated events.
 * Used by Uniswap V3, Camelot V3, and other concentrated liquidity DEXes.
 *
 * @module factory-subscription/parsers/v3-pool-parser
 */

import { PairCreatedEvent, type RawEventLog } from './types';
import {
  extractAddressFromTopic,
  parseSignedInt24,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  SECOND_VALUE_START,
} from './utils';

/**
 * Parse a V3-style PoolCreated event log.
 *
 * Event: PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
 * Data layout: [tickSpacing int24 (32 bytes)] [pool address (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseV3PoolCreatedEvent(log: RawEventLog): PairCreatedEvent | null {
  try {
    // Validate: need 4 topics (signature + 3 indexed) and 2 words of data
    // Data: 0x prefix (2) + tickSpacing word (64) + pool address word (64) = 130 minimum
    if (!log?.topics || log.topics.length < 4 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 2) {
      return null;
    }

    // Token addresses and fee are in indexed topics
    const token0 = extractAddressFromTopic(log.topics[1]);
    const token1 = extractAddressFromTopic(log.topics[2]);
    const fee = parseInt(log.topics[3], 16);

    // tickSpacing (int24) is first word in data - needs signed int handling
    // The int24 is right-aligned in the 32-byte word, so we take the last 6 hex chars
    const tickSpacingHex = log.data.slice(HEX_PREFIX_LENGTH + WORD_SIZE_HEX - 6, HEX_PREFIX_LENGTH + WORD_SIZE_HEX);
    const tickSpacing = parseSignedInt24(tickSpacingHex);

    // Pool address is second 32-byte word in data (address is last 20 bytes)
    const pairAddress = ('0x' + log.data.slice(SECOND_VALUE_START, SECOND_VALUE_START + 40)).toLowerCase();

    return {
      token0,
      token1,
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'uniswap_v3',
      dexName: '',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      fee,
      tickSpacing,
    };
  } catch (error) {
    return null;
  }
}
