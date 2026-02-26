/**
 * V2 Pair Parser
 *
 * Parses Uniswap V2-style PairCreated events.
 * Used by Uniswap V2, SushiSwap, PancakeSwap, and other V2 forks.
 *
 * @module factory-subscription/parsers/v2-pair-parser
 */

import { PairCreatedEvent, type RawEventLog } from './types';
import {
  extractAddressFromTopic,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  FIRST_ADDRESS_START,
} from './utils';

/**
 * Parse a V2-style PairCreated event log.
 *
 * Event: PairCreated(address indexed token0, address indexed token1, address pair, uint)
 * Data layout: [pair address (32 bytes)] [pair index (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseV2PairCreatedEvent(log: RawEventLog): PairCreatedEvent | null {
  try {
    // Validate: need 3 topics (signature + 2 indexed) and at least 1 word of data
    // Data: 0x prefix (2) + pair address word (64) = 66 minimum
    if (!log?.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX) {
      return null;
    }

    // Token addresses are in indexed topics (padded to 32 bytes)
    const token0 = extractAddressFromTopic(log.topics[1]);
    const token1 = extractAddressFromTopic(log.topics[2]);

    // Pair address is first 32-byte word in data (address is last 20 bytes)
    const pairAddress = ('0x' + log.data.slice(FIRST_ADDRESS_START, FIRST_ADDRESS_START + 40)).toLowerCase();

    return {
      token0,
      token1,
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'uniswap_v2',
      dexName: '', // Filled in by service
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    };
  } catch (error) {
    return null;
  }
}
