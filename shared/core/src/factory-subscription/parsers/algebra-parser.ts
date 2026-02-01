/**
 * Algebra Parser
 *
 * Parses Algebra-style Pool events.
 * Used by Algebra DEX (e.g., Camelot on Arbitrum).
 * Algebra uses dynamic fees with no fee tier parameter.
 *
 * @module factory-subscription/parsers/algebra-parser
 */

import { PairCreatedEvent } from './types';
import {
  extractAddressFromTopic,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  FIRST_ADDRESS_START,
} from './utils';

/**
 * Parse an Algebra-style Pool event log.
 *
 * Event: Pool(address indexed token0, address indexed token1, address pool)
 * Data layout: [pool address (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseAlgebraPoolCreatedEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 3 topics (signature + 2 indexed) and 1 word of data
    // Data: 0x prefix (2) + pool address word (64) = 66 minimum
    if (!log?.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX) {
      return null;
    }

    // Token addresses are in indexed topics
    const token0 = extractAddressFromTopic(log.topics[1]);
    const token1 = extractAddressFromTopic(log.topics[2]);

    // Pool address is first 32-byte word in data (address is last 20 bytes)
    const pairAddress = ('0x' + log.data.slice(FIRST_ADDRESS_START, FIRST_ADDRESS_START + 40)).toLowerCase();

    return {
      token0,
      token1,
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'algebra',
      dexName: '',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    };
  } catch (error) {
    return null;
  }
}
