/**
 * Balancer V2 Parser
 *
 * Parses Balancer V2 pool registration events including PoolRegistered and TokensRegistered.
 * Balancer V2 uses a two-step registration process:
 * 1. PoolRegistered: Contains pool address and ID, but no token info
 * 2. TokensRegistered: Contains token addresses for the pool
 *
 * @module factory-subscription/parsers/balancer-v2-parser
 */

import { PairCreatedEvent, type RawEventLog } from './types';
import {
  extractAddressFromTopic,
  extractUint256FromDataWord,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  ADDRESS_PADDING_OFFSET,
  ZERO_ADDRESS,
} from './utils';

/**
 * Event signature for Balancer V2 TokensRegistered events.
 * TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)
 */
export const BALANCER_TOKENS_REGISTERED_SIGNATURE = '0xf5847d3f2197b16cdcd2098ec95d0905cd1abdaf415f07571c3b5a3e0be8d461';

/**
 * Parse a Balancer V2 PoolRegistered event log.
 *
 * Event: PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 specialization)
 * Topics:
 *   - topics[0]: Event signature
 *   - topics[1]: poolId (bytes32, contains pool address in first 20 bytes)
 *   - topics[2]: poolAddress (address)
 * Data:
 *   - specialization: uint8 (0=General, 1=MinimalSwap, 2=TwoToken)
 *
 * IMPORTANT: This event does NOT contain token addresses. Tokens must be fetched
 * separately via Vault.getPoolTokens(poolId) or by listening for TokensRegistered event.
 * The requiresTokenLookup flag will be set to true.
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseBalancerPoolRegisteredEvent(log: RawEventLog): PairCreatedEvent | null {
  try {
    // Validate: need 3 topics (signature + 2 indexed) and at least 1 word of data
    // Data: 0x prefix (2) + specialization word (64) = 66 minimum
    if (!log?.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX) {
      return null;
    }

    // poolId is in topics[1] - full bytes32
    const poolId = log.topics[1].toLowerCase();

    // poolAddress is in topics[2] (address padded to 32 bytes)
    const pairAddress = extractAddressFromTopic(log.topics[2]);

    // specialization is first word in data (uint8, right-aligned in 32-byte word)
    const specialization = parseInt(log.data.slice(log.data.length - 2), 16);

    // For Balancer V2, we don't have token addresses from PoolRegistered event
    // Set placeholder addresses that indicate lookup is required
    // The poolId contains the pool address in its first 20 bytes
    return {
      token0: ZERO_ADDRESS, // Tokens need to be fetched via Vault.getPoolTokens()
      token1: ZERO_ADDRESS, // Tokens need to be fetched via Vault.getPoolTokens()
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'balancer_v2',
      dexName: '',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      poolId,
      specialization,
      requiresTokenLookup: true,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parsed result from Balancer TokensRegistered event.
 */
export interface BalancerTokensRegisteredResult {
  /** Pool ID (bytes32 as hex string) */
  poolId: string;
  /** Token addresses in the pool */
  tokens: string[];
}

/**
 * Parse a Balancer V2 TokensRegistered event log.
 * This event contains the token addresses for a pool.
 *
 * Event: TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)
 * Topics:
 *   - topics[0]: Event signature
 *   - topics[1]: poolId (bytes32)
 * Data:
 *   - Dynamic array of tokens (offset + length + addresses)
 *   - Dynamic array of assetManagers (offset + length + addresses)
 *
 * @param log - The raw log data
 * @returns Partial event data with tokens or null if invalid
 */
export function parseBalancerTokensRegisteredEvent(log: RawEventLog): BalancerTokensRegisteredResult | null {
  try {
    // Validate: need 2 topics (signature + poolId indexed)
    if (!log?.topics || log.topics.length < 2 || !log.data) {
      return null;
    }

    // poolId is in topics[1]
    const poolId = log.topics[1].toLowerCase();

    // Data contains two dynamic arrays: tokens[] and assetManagers[]
    // Each dynamic array has: offset (32 bytes), then at that offset: length (32 bytes) + elements
    // For simplicity, we'll parse the tokens array

    // First word is offset to tokens array (should be 64 = 0x40, pointing to after both offsets)
    const tokensOffset = extractUint256FromDataWord(log.data, 0);

    // Calculate actual position in data (offset is in bytes, we're working with hex chars)
    // tokensOffset points to where the tokens array length is stored
    const tokensLengthPos = HEX_PREFIX_LENGTH + (tokensOffset / 32) * WORD_SIZE_HEX;
    const tokensLengthHex = log.data.slice(tokensLengthPos, tokensLengthPos + WORD_SIZE_HEX);
    const tokensLength = parseInt(tokensLengthHex, 16);

    if (tokensLength === 0 || tokensLength > 50) {
      // Invalid or unreasonable token count
      return null;
    }

    // Extract token addresses
    const tokens: string[] = [];
    const tokensDataStart = tokensLengthPos + WORD_SIZE_HEX;

    for (let i = 0; i < tokensLength; i++) {
      const tokenWordStart = tokensDataStart + i * WORD_SIZE_HEX + ADDRESS_PADDING_OFFSET;
      const tokenAddress = ('0x' + log.data.slice(tokenWordStart, tokenWordStart + 40)).toLowerCase();
      if (tokenAddress !== ZERO_ADDRESS) {
        tokens.push(tokenAddress);
      }
    }

    return { poolId, tokens };
  } catch (error) {
    return null;
  }
}
