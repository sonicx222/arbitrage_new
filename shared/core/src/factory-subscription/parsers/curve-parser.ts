/**
 * Curve Parser
 *
 * Parses Curve pool creation events including PlainPoolDeployed and MetaPoolDeployed.
 * Curve pools can have 2-4 tokens and support both regular and meta pool types.
 *
 * @module factory-subscription/parsers/curve-parser
 */

import { PairCreatedEvent, type RawEventLog } from './types';
import {
  extractAddressFromDataWord,
  extractUint256FromDataWord,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  ZERO_ADDRESS,
} from './utils';

/**
 * Event signature for Curve PlainPoolDeployed events.
 * PlainPoolDeployed(address[4] coins, uint256 A, uint256 fee, address deployer, address pool)
 */
export const CURVE_PLAIN_POOL_SIGNATURE = '0xb8f6972d6e56d21c47621efd7f02fe68f07a17c999c42245b3abd300f34d61eb';

/**
 * Event signature for Curve MetaPoolDeployed events.
 * MetaPoolDeployed(address coin, address base_pool, uint256 A, uint256 fee, address deployer, address pool)
 */
export const CURVE_META_POOL_SIGNATURE = '0x01f31cd2abdec67d966a3f6d992026644a5765d127b8b35ae4dd240b2baa0b9f';

/**
 * Parse a Curve PlainPoolDeployed event log.
 *
 * Event: PlainPoolDeployed(address[4] coins, uint256 A, uint256 fee, address deployer, address pool)
 * Data layout:
 *   - coins[0-3]: 4 x 32-byte words (addresses padded to 32 bytes)
 *   - A: 32-byte word (amplification coefficient)
 *   - fee: 32-byte word
 *   - deployer: 32-byte word (address)
 *   - pool: 32-byte word (address)
 * Total: 8 words = 256 bytes of data
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseCurvePlainPoolDeployedEvent(log: RawEventLog): PairCreatedEvent | null {
  try {
    // Validate: need 1 topic (signature only, no indexed params) and 8 words of data
    // Data: 0x prefix (2) + 8 * 64 = 514 minimum
    const minDataLength = HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 8;
    if (!log?.topics || log.topics.length < 1 || !log.data || log.data.length < minDataLength) {
      return null;
    }

    // Extract all 4 coins
    const coins: string[] = [];
    for (let i = 0; i < 4; i++) {
      const coinAddress = extractAddressFromDataWord(log.data, i);
      if (coinAddress !== ZERO_ADDRESS) {
        coins.push(coinAddress);
      }
    }

    // Need at least 2 coins for a valid pool
    if (coins.length < 2) {
      return null;
    }

    // Extract amplification coefficient (A)
    const amplificationCoefficient = extractUint256FromDataWord(log.data, 4);

    // Extract fee (word 5)
    const fee = extractUint256FromDataWord(log.data, 5);

    // Pool address is word 7 (deployer is word 6)
    const pairAddress = extractAddressFromDataWord(log.data, 7);

    return {
      token0: coins[0],
      token1: coins[1],
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'curve',
      dexName: '',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      coins,
      amplificationCoefficient,
      fee,
      isMetaPool: false,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parse a Curve MetaPoolDeployed event log.
 *
 * Event: MetaPoolDeployed(address coin, address base_pool, uint256 A, uint256 fee, address deployer, address pool)
 * Data layout:
 *   - coin: 32-byte word (the new token)
 *   - base_pool: 32-byte word (the underlying pool, e.g., 3pool)
 *   - A: 32-byte word (amplification coefficient)
 *   - fee: 32-byte word
 *   - deployer: 32-byte word (address)
 *   - pool: 32-byte word (address)
 * Total: 6 words = 192 bytes of data
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseCurveMetaPoolDeployedEvent(log: RawEventLog): PairCreatedEvent | null {
  try {
    // Validate: need 1 topic (signature only, no indexed params) and 6 words of data
    // Data: 0x prefix (2) + 6 * 64 = 386 minimum
    const minDataLength = HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 6;
    if (!log?.topics || log.topics.length < 1 || !log.data || log.data.length < minDataLength) {
      return null;
    }

    // Extract coin (the new token)
    const coin = extractAddressFromDataWord(log.data, 0);
    if (coin === ZERO_ADDRESS) {
      return null;
    }

    // Extract base_pool address
    const basePool = extractAddressFromDataWord(log.data, 1);
    if (basePool === ZERO_ADDRESS) {
      return null;
    }

    // Extract amplification coefficient (A)
    const amplificationCoefficient = extractUint256FromDataWord(log.data, 2);

    // Extract fee (word 3)
    const fee = extractUint256FromDataWord(log.data, 3);

    // Pool address is word 5 (deployer is word 4)
    const pairAddress = extractAddressFromDataWord(log.data, 5);

    // For MetaPools, token0 is the new coin, token1 is the base pool address
    // The base pool typically represents the underlying tokens (e.g., 3pool = DAI/USDC/USDT)
    return {
      token0: coin,
      token1: basePool, // Base pool acts as a "virtual" token
      pairAddress,
      factoryAddress: log.address.toLowerCase(),
      factoryType: 'curve',
      dexName: '',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      coins: [coin], // Only the new coin is directly available
      amplificationCoefficient,
      fee,
      basePool,
      isMetaPool: true,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parse a Curve pool event, detecting whether it's a PlainPool or MetaPool.
 * Routes to the appropriate parser based on event signature.
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseCurvePoolCreatedEvent(log: RawEventLog): PairCreatedEvent | null {
  if (!log || !log.topics || log.topics.length < 1 || !log.data) {
    return null;
  }

  const signature = log.topics[0].toLowerCase();

  // Check if this is a MetaPoolDeployed event
  if (signature === CURVE_META_POOL_SIGNATURE.toLowerCase()) {
    return parseCurveMetaPoolDeployedEvent(log);
  }

  // Check if this is a PlainPoolDeployed event
  if (signature === CURVE_PLAIN_POOL_SIGNATURE.toLowerCase()) {
    return parseCurvePlainPoolDeployedEvent(log);
  }

  // Unknown signature - try to detect by data length as fallback
  const dataLength = log.data.length;
  const plainPoolMinLength = HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 8; // 514
  const metaPoolMinLength = HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 6;  // 386

  if (dataLength >= plainPoolMinLength) {
    return parseCurvePlainPoolDeployedEvent(log);
  } else if (dataLength >= metaPoolMinLength) {
    return parseCurveMetaPoolDeployedEvent(log);
  }

  return null;
}
