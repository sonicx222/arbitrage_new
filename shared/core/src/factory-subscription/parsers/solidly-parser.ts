/**
 * Solidly Parser
 *
 * Parses Solidly-style PairCreated events.
 * Used by Velodrome, Aerodrome, Equalizer, and other Solidly forks.
 * Supports both stable and volatile pair types.
 *
 * @module factory-subscription/parsers/solidly-parser
 */

import { PairCreatedEvent, type RawEventLog } from './types';
import {
  extractAddressFromTopic,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  SECOND_VALUE_START,
} from './utils';

/**
 * Parse a Solidly-style PairCreated event log.
 *
 * Event: PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
 * Data layout: [stable bool (32 bytes)] [pair address (32 bytes)] [pair index (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseSolidlyPairCreatedEvent(log: RawEventLog): PairCreatedEvent | null {
  try {
    // Validate: need 3 topics (signature + 2 indexed) and 3 words of data
    // Data: 0x prefix (2) + stable bool (64) + pair address (64) + index (64) = 194 minimum
    if (!log?.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 3) {
      return null;
    }

    // Token addresses are in indexed topics
    const token0 = extractAddressFromTopic(log.topics[1]);
    const token1 = extractAddressFromTopic(log.topics[2]);

    // stable (bool) is first word in data - non-zero means true
    const stableWord = log.data.slice(HEX_PREFIX_LENGTH, HEX_PREFIX_LENGTH + WORD_SIZE_HEX);
    const isStable = parseInt(stableWord, 16) !== 0;

    // Pair address is second 32-byte word in data (address is last 20 bytes)
    const pairAddress = ('0x' + log.data.slice(SECOND_VALUE_START, SECOND_VALUE_START + 40)).toLowerCase();

    return {
      token0,
      token1,
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'solidly',
      dexName: '',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      isStable,
    };
  } catch (error) {
    return null;
  }
}
