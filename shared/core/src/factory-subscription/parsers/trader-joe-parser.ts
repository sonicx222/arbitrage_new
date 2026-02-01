/**
 * Trader Joe Parser
 *
 * Parses Trader Joe LBPairCreated events.
 * Used by Trader Joe's Liquidity Book AMM on Avalanche and Arbitrum.
 * Uses binStep parameter for discretized liquidity (similar to tick spacing).
 *
 * @module factory-subscription/parsers/trader-joe-parser
 */

import { PairCreatedEvent } from './types';
import {
  extractAddressFromTopic,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  FIRST_ADDRESS_START,
} from './utils';

/**
 * Parse a Trader Joe LBPairCreated event log.
 *
 * Event: LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)
 * Data layout: [LBPair address (32 bytes)] [pid (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseTraderJoePairCreatedEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 4 topics (signature + 3 indexed) and 2 words of data
    // Data: 0x prefix (2) + LBPair address word (64) + pid word (64) = 130 minimum
    if (!log?.topics || log.topics.length < 4 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 2) {
      return null;
    }

    // Token addresses and binStep are in indexed topics
    const token0 = extractAddressFromTopic(log.topics[1]);
    const token1 = extractAddressFromTopic(log.topics[2]);
    const binStep = parseInt(log.topics[3], 16);

    // LBPair address is first 32-byte word in data (address is last 20 bytes)
    const pairAddress = ('0x' + log.data.slice(FIRST_ADDRESS_START, FIRST_ADDRESS_START + 40)).toLowerCase();

    return {
      token0,
      token1,
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'trader_joe',
      dexName: '',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      binStep,
    };
  } catch (error) {
    return null;
  }
}
