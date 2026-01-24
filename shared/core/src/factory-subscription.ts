/**
 * Factory Subscription Service
 *
 * Task 2.1.2: Implement Factory Subscription
 * Enables factory-level event subscriptions for 40-50x RPC reduction.
 *
 * Instead of subscribing to each individual pair address, this service
 * subscribes to factory contracts to receive PairCreated events and
 * dynamically discover new pairs.
 *
 * @see implementation_plan_v2.md Phase 2.1.2
 * @see ARCHITECTURE_V2.md Section 3.2 (Factory Subscriptions)
 *
 * ARCHITECTURAL NOTES:
 * - Maverick (Base): Classified as uniswap_v3 but uses unique "boosted positions"
 * - GMX (Avalanche): Classified as balancer_v2 but uses Vault/GLP model
 * - Platypus (Avalanche): Classified as curve but uses "coverage ratio" model
 * These use standard event patterns but may need custom handling for pair initialization.
 */

import { ethers } from 'ethers';
import {
  getFactoriesForChain,
  getFactoriesWithEventSupport,
  getFactoryByAddress,
  FactoryType,
  FactoryConfig,
  getAllFactoryAddresses,
} from '../../config/src/dex-factories';
import { ServiceLogger } from './logging';
import { AsyncMutex } from './async/async-mutex';

// =============================================================================
// Constants for Hex Parsing
// =============================================================================

/** Offset for '0x' prefix in hex strings */
const HEX_PREFIX_LENGTH = 2;
/** Size of a 32-byte word in hex characters (64) */
const WORD_SIZE_HEX = 64;
/** Offset to extract address from 32-byte padded value (12 bytes padding = 24 hex chars) */
const ADDRESS_PADDING_OFFSET = 24;
/** Full offset including '0x' prefix for first address in data */
const FIRST_ADDRESS_START = HEX_PREFIX_LENGTH + ADDRESS_PADDING_OFFSET; // 26
/** Full offset including '0x' prefix for second value in data */
const SECOND_VALUE_START = HEX_PREFIX_LENGTH + WORD_SIZE_HEX + ADDRESS_PADDING_OFFSET; // 90

// =============================================================================
// Hex Parsing Utilities
// =============================================================================

/**
 * Extract an address from a 32-byte padded hex topic.
 * Topics are always 32 bytes (64 hex chars) with address in last 20 bytes.
 *
 * @param paddedHex - 32-byte hex string (with or without 0x prefix)
 * @returns Lowercase address with 0x prefix
 */
function extractAddressFromTopic(paddedHex: string): string {
  // Handle both 0x-prefixed and non-prefixed topics
  const offset = paddedHex.startsWith('0x') ? HEX_PREFIX_LENGTH + ADDRESS_PADDING_OFFSET : ADDRESS_PADDING_OFFSET;
  return ('0x' + paddedHex.slice(offset)).toLowerCase();
}

/**
 * Parse a signed int24 from a hex string using two's complement.
 * int24 range: -8388608 to 8388607
 *
 * @param hexValue - Hex string representing the int24
 * @returns Signed integer value
 */
function parseSignedInt24(hexValue: string): number {
  const value = parseInt(hexValue, 16);
  // int24 is 24 bits, sign bit is at position 23 (counting from 0)
  const INT24_MAX = 0x7FFFFF; // 8388607
  const INT24_SIGN_BIT = 0x800000; // 8388608

  if (value > INT24_MAX) {
    // Negative number - convert from two's complement
    return value - (INT24_SIGN_BIT * 2); // Subtract 2^24
  }
  return value;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for factory subscription service.
 */
export interface FactorySubscriptionConfig {
  /** Chain identifier (e.g., 'arbitrum', 'bsc') */
  chain: string;
  /** Whether factory subscriptions are enabled */
  enabled: boolean;
  /** Optional: Custom factory addresses to monitor (overrides registry) */
  customFactories?: string[];
}

/**
 * Parsed PairCreated event data.
 * Extended to support all factory types including Curve and Balancer V2.
 */
export interface PairCreatedEvent {
  /** Token 0 address (first non-zero coin for Curve) */
  token0: string;
  /** Token 1 address (second non-zero coin for Curve) */
  token1: string;
  /** Created pair/pool address */
  pairAddress: string;
  /** Factory address that emitted the event */
  factoryAddress: string;
  /** Factory type for ABI selection */
  factoryType: FactoryType;
  /** DEX name from factory config */
  dexName: string;
  /** Block number where pair was created */
  blockNumber: number;
  /** Transaction hash */
  transactionHash: string;
  /** Optional: Fee tier (V3-style) in basis points */
  fee?: number;
  /** Optional: Stable pair flag (Solidly-style) */
  isStable?: boolean;
  /** Optional: Tick spacing (V3-style) */
  tickSpacing?: number;
  /** Optional: Bin step (Trader Joe) */
  binStep?: number;
  /** Optional: Pool ID for Balancer V2 (bytes32 as hex string) */
  poolId?: string;
  /** Optional: Balancer V2 pool specialization (0=General, 1=MinimalSwap, 2=TwoToken) */
  specialization?: number;
  /** Optional: All coins in the pool (Curve multi-asset pools) */
  coins?: string[];
  /** Optional: Amplification coefficient (Curve) */
  amplificationCoefficient?: number;
  /** Optional: Base pool address (Curve MetaPool) */
  basePool?: string;
  /** Optional: Whether this is a MetaPool (Curve) */
  isMetaPool?: boolean;
  /** Optional: Flag indicating tokens need async lookup (Balancer V2) */
  requiresTokenLookup?: boolean;
}

/**
 * Statistics for factory subscription service.
 */
export interface FactorySubscriptionStats {
  /** Chain being monitored */
  chain: string;
  /** Number of factories subscribed to */
  factoriesSubscribed: number;
  /** Total pairs created since service started */
  pairsCreated: number;
  /** Events by factory type */
  eventsByType: Partial<Record<FactoryType, number>>;
  /** Whether service is currently subscribed */
  isSubscribed: boolean;
  /** Service start time */
  startedAt: number | null;
}

/**
 * Logger interface for DI.
 * P0-FIX: Now uses the consolidated ServiceLogger type from logging module.
 * @deprecated Use ServiceLogger from './logging' directly instead.
 */
export type FactorySubscriptionLogger = ServiceLogger;

/**
 * WebSocket manager interface for DI.
 * P0-FIX: Extended to match WebSocketManager subscribe signature.
 * The subscribe method accepts additional optional properties for
 * event type categorization and callback registration.
 *
 * NOTE: This interface is intentionally flexible to support both
 * the actual WebSocketManager class and mock implementations in tests.
 */
export interface FactoryWebSocketManager {
  subscribe: (params: {
    method: string;
    params: any[];
    type?: string;      // Optional: subscription type for categorization
    topics?: string[];  // Optional: event topics for filtering
    callback?: (data: any) => void;  // Optional: per-subscription callback
  }) => number | void;
  unsubscribe?: (subscriptionId: string) => void;  // Only string for compatibility
  isConnected(): boolean;  // Method signature (not private access)
}

/**
 * Dependencies for factory subscription service.
 */
export interface FactorySubscriptionDeps {
  logger?: ServiceLogger;
  wsManager?: FactoryWebSocketManager;
}

/**
 * Callback type for pair created events.
 */
export type PairCreatedCallback = (event: PairCreatedEvent) => void;

// =============================================================================
// Event Signatures
// =============================================================================

/**
 * Pre-computed event signatures for factory events.
 * These are keccak256 hashes of the event signatures.
 *
 * PERFORMANCE: Pre-computed at build time instead of runtime ethers.id() calls.
 * Saves ~10ms per import and avoids crypto computation on module load.
 */
export const FactoryEventSignatures: Record<FactoryType, string> = {
  // PairCreated(address indexed token0, address indexed token1, address pair, uint)
  uniswap_v2: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',

  // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
  uniswap_v3: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',

  // PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
  solidly: '0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9',

  // Curve uses PlainPoolDeployed (primary) and MetaPoolDeployed (secondary)
  // PlainPoolDeployed(address[4] coins, uint256 A, uint256 fee, address deployer, address pool)
  curve: '0xb8f6972d6e56d21c47621efd7f02fe68f07a17c999c42245b3abd300f34d61eb',

  // PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 specialization)
  balancer_v2: '0x3c13bc30b8e878c53fd2a36b679409c073afd75950be43d8858768e956fbc20e',

  // Pool(address indexed token0, address indexed token1, address pool)
  algebra: '0x91ccaa7a278130b65168c3a0c8d3bcae84cf5e43704342bd3ec0b59e59c036db',

  // LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)
  trader_joe: '0x2c8d104b27c6b7f4492017a6f5cf3803043688934ebcaa6a03540beeaf976aff',
};

/**
 * Additional event signatures for DEXes that emit multiple event types.
 * Used when a single factory type can emit different pool creation events.
 */
export const AdditionalEventSignatures = {
  // MetaPoolDeployed(address coin, address base_pool, uint256 A, uint256 fee, address deployer, address pool)
  curve_metapool: '0x01f31cd2abdec67d966a3f6d992026644a5765d127b8b35ae4dd240b2baa0b9f',

  // TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)
  // Used to get token addresses for Balancer V2 pools after PoolRegistered
  balancer_tokens_registered: '0xf5847d3f2197b16cdcd2098ec95d0905cd1abdaf415f07571c3b5a3e0be8d461',
} as const;

/**
 * Get the event signature for a factory type.
 *
 * @param factoryType - The factory type
 * @returns The keccak256 event signature hash
 * @throws Error if factory type is not supported
 */
export function getFactoryEventSignature(factoryType: FactoryType): string {
  const signature = FactoryEventSignatures[factoryType];
  if (!signature) {
    throw new Error(`Unsupported factory type: ${factoryType}`);
  }
  return signature;
}

// =============================================================================
// Event Parsing Functions
// =============================================================================

/**
 * Parse a V2-style PairCreated event log.
 *
 * Event: PairCreated(address indexed token0, address indexed token1, address pair, uint)
 * Data layout: [pair address (32 bytes)] [pair index (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseV2PairCreatedEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 3 topics (signature + 2 indexed) and at least 1 word of data
    // Data: 0x prefix (2) + pair address word (64) = 66 minimum
    if (!log.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX) {
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

/**
 * Parse a V3-style PoolCreated event log.
 *
 * Event: PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
 * Data layout: [tickSpacing int24 (32 bytes)] [pool address (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseV3PoolCreatedEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 4 topics (signature + 3 indexed) and 2 words of data
    // Data: 0x prefix (2) + tickSpacing word (64) + pool address word (64) = 130 minimum
    if (!log.topics || log.topics.length < 4 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 2) {
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

/**
 * Parse a Solidly-style PairCreated event log.
 *
 * Event: PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
 * Data layout: [stable bool (32 bytes)] [pair address (32 bytes)] [pair index (32 bytes)]
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseSolidlyPairCreatedEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 3 topics (signature + 2 indexed) and 3 words of data
    // Data: 0x prefix (2) + stable bool (64) + pair address (64) + index (64) = 194 minimum
    if (!log.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 3) {
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
    if (!log.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX) {
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
    if (!log.topics || log.topics.length < 4 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 2) {
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

/**
 * Zero address constant for comparison.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Extract an address from a 32-byte padded hex data word at a specific offset.
 *
 * @param data - The hex data string (with 0x prefix)
 * @param wordIndex - The word index (0-based, each word is 32 bytes)
 * @returns Lowercase address with 0x prefix
 */
function extractAddressFromDataWord(data: string, wordIndex: number): string {
  const startOffset = HEX_PREFIX_LENGTH + (wordIndex * WORD_SIZE_HEX) + ADDRESS_PADDING_OFFSET;
  return ('0x' + data.slice(startOffset, startOffset + 40)).toLowerCase();
}

/**
 * Extract a uint256 value from data at a specific word index as bigint.
 * Use this when you need full precision for large values (pool IDs, reserves, etc.).
 *
 * P1-4 FIX: Added bigint version for full precision support.
 *
 * @param data - The hex data string (with 0x prefix)
 * @param wordIndex - The word index (0-based, each word is 32 bytes)
 * @returns The uint256 as a bigint (full precision)
 */
function extractBigIntFromDataWord(data: string, wordIndex: number): bigint {
  const startOffset = HEX_PREFIX_LENGTH + (wordIndex * WORD_SIZE_HEX);
  const hexValue = data.slice(startOffset, startOffset + WORD_SIZE_HEX);
  return BigInt('0x' + hexValue);
}

/**
 * Extract a uint256 value from data at a specific word index as number.
 *
 * P1-4 FIX: Now returns -1 as sentinel value when overflow occurs, allowing callers
 * to detect and handle the overflow case. Use extractBigIntFromDataWord() when
 * full precision is required.
 *
 * @param data - The hex data string (with 0x prefix)
 * @param wordIndex - The word index (0-based, each word is 32 bytes)
 * @returns The uint256 as a number, or -1 if the value exceeds Number.MAX_SAFE_INTEGER
 */
function extractUint256FromDataWord(data: string, wordIndex: number): number {
  const bigValue = extractBigIntFromDataWord(data, wordIndex);
  if (bigValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    // P1-4 FIX: Return -1 sentinel instead of silently truncating to MAX_SAFE_INTEGER
    // This allows callers to detect overflow and use bigint version if needed
    return -1;
  }
  return Number(bigValue);
}

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
export function parseCurvePlainPoolDeployedEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 1 topic (signature only, no indexed params) and 8 words of data
    // Data: 0x prefix (2) + 8 * 64 = 514 minimum
    const minDataLength = HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 8;
    if (!log.topics || log.topics.length < 1 || !log.data || log.data.length < minDataLength) {
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
export function parseCurveMetaPoolDeployedEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 1 topic (signature only, no indexed params) and 6 words of data
    // Data: 0x prefix (2) + 6 * 64 = 386 minimum
    const minDataLength = HEX_PREFIX_LENGTH + WORD_SIZE_HEX * 6;
    if (!log.topics || log.topics.length < 1 || !log.data || log.data.length < minDataLength) {
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
 * Routes to the appropriate parser based on data length.
 *
 * @param log - The raw log data
 * @returns Parsed event data or null if invalid
 */
export function parseCurvePoolCreatedEvent(log: any): PairCreatedEvent | null {
  if (!log || !log.topics || log.topics.length < 1 || !log.data) {
    return null;
  }

  const signature = log.topics[0].toLowerCase();

  // Check if this is a MetaPoolDeployed event
  if (signature === AdditionalEventSignatures.curve_metapool.toLowerCase()) {
    return parseCurveMetaPoolDeployedEvent(log);
  }

  // Check if this is a PlainPoolDeployed event
  if (signature === FactoryEventSignatures.curve.toLowerCase()) {
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
export function parseBalancerPoolRegisteredEvent(log: any): PairCreatedEvent | null {
  try {
    // Validate: need 3 topics (signature + 2 indexed) and at least 1 word of data
    // Data: 0x prefix (2) + specialization word (64) = 66 minimum
    if (!log.topics || log.topics.length < 3 || !log.data || log.data.length < HEX_PREFIX_LENGTH + WORD_SIZE_HEX) {
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
export function parseBalancerTokensRegisteredEvent(log: any): { poolId: string; tokens: string[] } | null {
  try {
    // Validate: need 2 topics (signature + poolId indexed)
    if (!log.topics || log.topics.length < 2 || !log.data) {
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

// =============================================================================
// Factory Subscription Service
// =============================================================================

/**
 * Factory Subscription Service
 *
 * Manages factory-level event subscriptions for dynamic pair discovery.
 * Reduces RPC subscriptions by 40-50x compared to individual pair subscriptions.
 */
export class FactorySubscriptionService {
  private config: FactorySubscriptionConfig;
  private logger: ServiceLogger;
  private wsManager: FactoryWebSocketManager | null;

  // Factory lookup maps (pre-computed for O(1) lookup)
  private factoryByAddress: Map<string, FactoryConfig> = new Map();
  private factoriesByType: Map<FactoryType, FactoryConfig[]> = new Map();

  // Subscription state
  private subscribed = false;
  // P0-9 FIX: Use AsyncMutex for truly atomic subscription guard
  // Replaces boolean flag which has TOCTOU race condition window
  private subscribeMutex = new AsyncMutex();
  private subscriptionIds: string[] = [];

  // Event callbacks
  private pairCreatedCallbacks: PairCreatedCallback[] = [];

  // P1-1 FIX: Pending Balancer pools awaiting token data from TokensRegistered events
  // Key: poolId (bytes32 as hex string), Value: partial PairCreatedEvent
  private pendingBalancerPools: Map<string, PairCreatedEvent> = new Map();

  // P1-1 FIX: TTL for pending pools (30 seconds) - cleanup stale entries
  private readonly PENDING_POOL_TTL_MS = 30000;

  // Stats
  private stats: FactorySubscriptionStats;

  constructor(config: FactorySubscriptionConfig, deps?: FactorySubscriptionDeps) {
    this.config = config;
    this.logger = deps?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    this.wsManager = deps?.wsManager ?? null;

    // Initialize stats
    this.stats = {
      chain: config.chain,
      factoriesSubscribed: 0,
      pairsCreated: 0,
      eventsByType: {},
      isSubscribed: false,
      startedAt: null,
    };

    // Build factory lookup maps
    this.buildFactoryMaps();
  }

  /**
   * Build factory lookup maps for O(1) access.
   * Uses customFactories from config if provided, otherwise uses registry.
   *
   * ARCHITECTURAL NOTE: Uses getFactoriesWithEventSupport() to filter out DEXes that:
   * - Use adapter-based pool discovery (GMX, Platypus)
   * - Have non-standard event signatures (Maverick)
   *
   * Curve and Balancer V2 are now fully supported with native event parsing.
   */
  private buildFactoryMaps(): void {
    // Get only factories that support standard factory events
    let factories = getFactoriesWithEventSupport(this.config.chain);

    // If customFactories is provided, filter to only those addresses
    if (this.config.customFactories && this.config.customFactories.length > 0) {
      const customSet = new Set(this.config.customFactories.map(addr => addr.toLowerCase()));
      factories = factories.filter(f => customSet.has(f.address.toLowerCase()));

      this.logger.debug('Using custom factory filter', {
        requested: this.config.customFactories.length,
        matched: factories.length,
      });
    }

    for (const factory of factories) {
      // Index by address (lowercase for case-insensitive lookup)
      this.factoryByAddress.set(factory.address.toLowerCase(), factory);

      // Index by type
      const typeFactories = this.factoriesByType.get(factory.type) || [];
      typeFactories.push(factory);
      this.factoriesByType.set(factory.type, typeFactories);
    }

    this.logger.debug(`Built factory maps for ${this.config.chain}`, {
      factoryCount: factories.length,
      types: Array.from(this.factoriesByType.keys()),
    });
  }

  /**
   * Get the chain being monitored.
   */
  getChain(): string {
    return this.config.chain;
  }

  /**
   * Get all factory addresses for the chain (lowercase).
   * Returns customFactories if configured, otherwise all factories from registry.
   */
  getFactoryAddresses(): string[] {
    // Return addresses from the built map (respects customFactories filter)
    return Array.from(this.factoryByAddress.keys());
  }

  /**
   * Get factory configuration by address.
   */
  getFactoryConfig(address: string): FactoryConfig | undefined {
    return this.factoryByAddress.get(address.toLowerCase());
  }

  /**
   * Check if service is subscribed to factories.
   */
  isSubscribed(): boolean {
    return this.subscribed;
  }

  /**
   * Get current subscription count.
   */
  getSubscriptionCount(): number {
    return this.subscriptionIds.length;
  }

  /**
   * Get service statistics.
   */
  getStats(): FactorySubscriptionStats {
    return {
      ...this.stats,
      isSubscribed: this.subscribed,
    };
  }

  /**
   * Register a callback for PairCreated events.
   */
  onPairCreated(callback: PairCreatedCallback): void {
    this.pairCreatedCallbacks.push(callback);
  }

  /**
   * Subscribe to all factories for the chain.
   *
   * Groups factories by event signature type to minimize subscriptions.
   * Each factory type (V2, V3, Solidly, etc.) uses a different event signature.
   *
   * P0-9 FIX: Use AsyncMutex for truly atomic subscription guard.
   * The previous boolean flag had a TOCTOU race condition window where
   * multiple concurrent callers could pass the check before any sets the flag.
   */
  async subscribeToFactories(): Promise<void> {
    // P0-9 FIX: Use tryAcquire for non-blocking atomic check
    // If mutex is already held, another caller is subscribing
    const release = this.subscribeMutex.tryAcquire();
    if (!release) {
      this.logger.debug('Subscription already in progress');
      return;
    }

    try {
      // Check if already subscribed (while holding mutex)
      if (this.subscribed) {
        this.logger.debug('Already subscribed');
        return;
      }

      if (!this.config.enabled) {
        this.logger.info('Factory subscriptions disabled');
        return;
      }

      // BUG FIX: Use factoryByAddress map which respects customFactories filter
      // Previously used getFactoriesForChain() which ignored the customFactories config
      const factories = Array.from(this.factoryByAddress.values());
      if (factories.length === 0) {
        this.logger.warn(`No factories found for chain ${this.config.chain}`);
        return;
      }

      // Group factories by type for efficient subscriptions
      const subscriptionGroups = new Map<string, { addresses: string[]; type: FactoryType }>();

      for (const factory of factories) {
        const signature = getFactoryEventSignature(factory.type);
        const existing = subscriptionGroups.get(signature);

        if (existing) {
          existing.addresses.push(factory.address.toLowerCase());
        } else {
          subscriptionGroups.set(signature, {
            addresses: [factory.address.toLowerCase()],
            type: factory.type,
          });
        }
      }

      // Subscribe to each group
      let subscriptionCount = 0;
      for (const [signature, group] of subscriptionGroups) {
        try {
          if (this.wsManager) {
            this.wsManager.subscribe({
              method: 'eth_subscribe',
              params: [
                'logs',
                {
                  topics: [signature],
                  address: group.addresses,
                },
              ],
            });

            this.subscriptionIds.push(`${group.type}_${subscriptionCount}`);
            subscriptionCount++;

            this.logger.info(`Subscribed to ${group.type} factory events`, {
              signature: signature.slice(0, 10) + '...',
              factoryCount: group.addresses.length,
            });
          }
        } catch (error) {
          this.logger.error(`Failed to subscribe to ${group.type} factories`, { error });
        }
      }

      this.subscribed = true;
      this.stats.factoriesSubscribed = factories.length;
      this.stats.startedAt = Date.now();

      this.logger.info(`Factory subscriptions active for ${this.config.chain}`, {
        factories: factories.length,
        subscriptionGroups: subscriptionGroups.size,
      });
    } finally {
      // Always release mutex, even on error or early return
      release();
    }
  }

  /**
   * Handle a factory event log.
   *
   * Routes the event to the appropriate parser based on factory address,
   * then emits the parsed PairCreated event to callbacks.
   *
   * P1-1 FIX: Added support for Balancer V2 two-step pool registration:
   * 1. PoolRegistered event → stored in pending map (no tokens)
   * 2. TokensRegistered event → merged with pending pool → emit complete event
   */
  handleFactoryEvent(log: any): void {
    if (!this.subscribed) {
      return;
    }

    try {
      const factoryAddress = log.address?.toLowerCase();
      if (!factoryAddress) {
        return;
      }

      // P1-1 FIX: Check for Balancer TokensRegistered event first
      // TokensRegistered is emitted by Vault (same address as factory for Balancer)
      const eventTopic = log.topics?.[0]?.toLowerCase();
      if (eventTopic === AdditionalEventSignatures.balancer_tokens_registered.toLowerCase()) {
        this.handleBalancerTokensRegistered(log);
        return;
      }

      // O(1) factory lookup
      const factory = this.factoryByAddress.get(factoryAddress);
      if (!factory) {
        this.logger.debug('Received event from unknown factory', { address: factoryAddress });
        return;
      }

      // Parse event based on factory type
      const event = this.parseFactoryEvent(log, factory);
      if (!event) {
        this.logger.debug('Failed to parse factory event', {
          factory: factory.dexName,
          type: factory.type,
        });
        return;
      }

      // Enrich event with DEX name
      event.dexName = factory.dexName;

      // P1-1 FIX: Handle Balancer V2 pools that need token lookup
      if (event.requiresTokenLookup && event.poolId) {
        this.storePendingBalancerPool(event);
        return; // Don't emit yet, wait for TokensRegistered
      }

      // Update stats
      this.stats.pairsCreated++;
      this.stats.eventsByType[factory.type] = (this.stats.eventsByType[factory.type] || 0) + 1;

      // Emit to callbacks
      this.emitPairCreatedEvent(event);
    } catch (error) {
      this.logger.error('Failed to handle factory event', { error });
    }
  }

  /**
   * P1-1 FIX: Store a pending Balancer pool awaiting token data.
   * Sets a TTL cleanup timeout to prevent memory leaks.
   */
  private storePendingBalancerPool(event: PairCreatedEvent): void {
    const poolId = event.poolId!;

    this.pendingBalancerPools.set(poolId, event);

    this.logger.debug('Stored pending Balancer pool', {
      poolId: poolId.slice(0, 18) + '...',
      pool: event.pairAddress,
      dex: event.dexName,
    });

    // Set TTL cleanup to prevent memory leaks
    setTimeout(() => {
      if (this.pendingBalancerPools.has(poolId)) {
        this.logger.warn('Pending Balancer pool expired without token data', {
          poolId: poolId.slice(0, 18) + '...',
          pool: event.pairAddress,
        });
        this.pendingBalancerPools.delete(poolId);
      }
    }, this.PENDING_POOL_TTL_MS);
  }

  /**
   * P1-1 FIX: Handle Balancer TokensRegistered event.
   * Merges token addresses with pending pool and emits complete event.
   */
  private handleBalancerTokensRegistered(log: any): void {
    const tokenData = parseBalancerTokensRegisteredEvent(log);
    if (!tokenData || tokenData.tokens.length < 2) {
      this.logger.debug('Invalid TokensRegistered event', { log: log?.address });
      return;
    }

    const pendingPool = this.pendingBalancerPools.get(tokenData.poolId);
    if (!pendingPool) {
      this.logger.debug('TokensRegistered for unknown pool', {
        poolId: tokenData.poolId.slice(0, 18) + '...',
      });
      return;
    }

    // Remove from pending
    this.pendingBalancerPools.delete(tokenData.poolId);

    // Merge token data into the event
    const completeEvent: PairCreatedEvent = {
      ...pendingPool,
      token0: tokenData.tokens[0],
      token1: tokenData.tokens[1],
      coins: tokenData.tokens.length > 2 ? tokenData.tokens : undefined,
      requiresTokenLookup: false, // Mark as complete
    };

    // Update stats
    this.stats.pairsCreated++;
    this.stats.eventsByType['balancer_v2'] = (this.stats.eventsByType['balancer_v2'] || 0) + 1;

    // Emit complete event
    this.emitPairCreatedEvent(completeEvent);

    this.logger.debug('Completed Balancer pool registration', {
      poolId: tokenData.poolId.slice(0, 18) + '...',
      pool: completeEvent.pairAddress,
      tokens: tokenData.tokens.length,
    });
  }

  /**
   * P1-1 FIX: Emit a PairCreated event to all registered callbacks.
   */
  private emitPairCreatedEvent(event: PairCreatedEvent): void {
    for (const callback of this.pairCreatedCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.logger.error('Error in PairCreated callback', { error });
      }
    }

    this.logger.debug('Processed factory event', {
      dex: event.dexName,
      pair: event.pairAddress,
      tokens: `${event.token0.slice(0, 10)}.../${event.token1.slice(0, 10)}...`,
    });
  }

  /**
   * Parse a factory event based on factory type.
   * Uses exhaustive switch to ensure all factory types are handled.
   */
  private parseFactoryEvent(log: any, factory: FactoryConfig): PairCreatedEvent | null {
    const factoryType: FactoryType = factory.type;

    switch (factoryType) {
      case 'uniswap_v2':
        return parseV2PairCreatedEvent(log);
      case 'uniswap_v3':
        return parseV3PoolCreatedEvent(log);
      case 'solidly':
        return parseSolidlyPairCreatedEvent(log);
      case 'algebra':
        return parseAlgebraPoolCreatedEvent(log);
      case 'trader_joe':
        return parseTraderJoePairCreatedEvent(log);
      case 'curve':
        // Curve uses PlainPoolDeployed/MetaPoolDeployed events
        // Supports multi-coin pools (2-4 tokens)
        return parseCurvePoolCreatedEvent(log);
      case 'balancer_v2':
        // Balancer uses PoolRegistered event with poolId
        // Note: Tokens need to be fetched separately via Vault.getPoolTokens(poolId)
        // or by listening for TokensRegistered event
        return parseBalancerPoolRegisteredEvent(log);
      default: {
        // Exhaustive check - TypeScript will error if a FactoryType case is missing
        const _exhaustiveCheck: never = factoryType;
        this.logger.error(`Unknown factory type: ${_exhaustiveCheck}`);
        return null;
      }
    }
  }

  /**
   * Stop the service and unsubscribe from all factories.
   * P1-1 FIX: Also clears pending Balancer pools to prevent memory leaks.
   */
  stop(): void {
    this.subscribed = false;
    this.subscriptionIds = [];
    this.pairCreatedCallbacks = [];

    // P1-1 FIX: Clear pending Balancer pools
    this.pendingBalancerPools.clear();

    this.logger.info(`Factory subscription service stopped for ${this.config.chain}`);
  }
}

/**
 * Create a factory subscription service instance.
 */
export function createFactorySubscriptionService(
  config: FactorySubscriptionConfig,
  deps?: FactorySubscriptionDeps
): FactorySubscriptionService {
  return new FactorySubscriptionService(config, deps);
}
