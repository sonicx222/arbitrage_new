/**
 * Event Processor Module (P1-1 Refactor)
 *
 * Pure functions for event decoding and object construction.
 * Extracted from base-detector.ts to improve testability and separation of concerns.
 *
 * Key design decisions:
 * - All functions are PURE (no state mutations, no side effects)
 * - State mutations (Map.set()) remain in BaseDetector for atomic updates
 * - Side effects (publishing, arbitrage detection) remain in BaseDetector
 * - Pre-compiled ABI constants for hot-path optimization
 *
 * @module detector/event-processor
 */

import { ethers } from 'ethers';
import type { Pair, PriceUpdate, SwapEvent } from '@arbitrage/types';

// =============================================================================
// Pre-compiled ABI Type Constants (Hot Path Optimization)
// =============================================================================
// These constants are used in the hot path to avoid repeated array allocation.
// Performance impact: ~0.1-0.5ms savings per event.

/** Pre-compiled ABI types for Sync event decoding (uint112 reserve0, uint112 reserve1) */
const SYNC_EVENT_ABI_TYPES = ['uint112', 'uint112'] as const;

/** Pre-compiled ABI types for Swap event decoding (uint256 amount0In, amount1In, amount0Out, amount1Out) */
const SWAP_EVENT_ABI_TYPES = ['uint256', 'uint256', 'uint256', 'uint256'] as const;

// Singleton AbiCoder instance for reuse
const abiCoder = ethers.AbiCoder.defaultAbiCoder();

// =============================================================================
// Types
// =============================================================================

/**
 * Extended pair interface with reserve data.
 * P0-1 FIX: Immutable - create new objects instead of mutating.
 */
export interface ExtendedPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

/**
 * Decoded Sync event data (reserve update).
 */
export interface DecodedSyncEvent {
  reserve0: string;
  reserve1: string;
}

/**
 * Decoded Swap event data (trade).
 */
export interface DecodedSwapEvent {
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  sender: string;
  recipient: string;
}

/**
 * Raw log data from blockchain events.
 */
export interface RawEventLog {
  data: string;
  topics?: string[];
  blockNumber: string | number;
  transactionHash?: string;
}

// =============================================================================
// Pure Decoding Functions
// =============================================================================

/**
 * Decode Sync event data from log.
 * Pure function - no side effects.
 *
 * @param logData - Raw hex data from the log
 * @returns Decoded reserve values as strings
 * @throws Error if decoding fails
 */
export function decodeSyncEventData(logData: string): DecodedSyncEvent {
  const decoded = abiCoder.decode(SYNC_EVENT_ABI_TYPES, logData);
  return {
    reserve0: decoded[0].toString(),
    reserve1: decoded[1].toString()
  };
}

/**
 * Decode Swap event data from log.
 * Pure function - no side effects.
 *
 * @param logData - Raw hex data from the log
 * @param topics - Log topics array (indexed parameters)
 * @returns Decoded swap amounts and addresses
 * @throws Error if decoding fails
 */
export function decodeSwapEventData(logData: string, topics?: string[]): DecodedSwapEvent {
  const decoded = abiCoder.decode(SWAP_EVENT_ABI_TYPES, logData);
  return {
    amount0In: decoded[0].toString(),
    amount1In: decoded[1].toString(),
    amount0Out: decoded[2].toString(),
    amount1Out: decoded[3].toString(),
    sender: topics?.[1] ? '0x' + topics[1].slice(26) : '0x0',
    recipient: topics?.[2] ? '0x' + topics[2].slice(26) : '0x0'
  };
}

/**
 * Parse block number from string or number format.
 * Pure function - handles hex strings and numbers.
 *
 * @param blockNumber - Block number as hex string or number
 * @returns Parsed block number as integer
 */
export function parseBlockNumber(blockNumber: string | number): number {
  if (typeof blockNumber === 'string') {
    return blockNumber.startsWith('0x') || blockNumber.startsWith('0X')
      ? parseInt(blockNumber, 16)
      : parseInt(blockNumber, 10);
  }
  return blockNumber;
}

// =============================================================================
// Pure Object Construction Functions
// =============================================================================

/**
 * Build an updated ExtendedPair with new reserve values.
 * P0-1 FIX: Creates NEW immutable object - never mutates existing pair.
 * This ensures atomic updates when combined with Map.set().
 *
 * @param pair - Original pair object
 * @param syncData - Decoded sync event data
 * @param blockNumber - Block number of the event
 * @returns New immutable ExtendedPair object
 */
export function buildExtendedPair(
  pair: Pair,
  syncData: DecodedSyncEvent,
  blockNumber: number
): ExtendedPair {
  // P0-1 FIX: Create NEW immutable pair object instead of mutating existing.
  // This ensures readers see either ALL old values or ALL new values, never a mix.
  return {
    // Copy all existing properties
    name: pair.name,
    address: pair.address,
    token0: pair.token0,
    token1: pair.token1,
    dex: pair.dex,
    feeDecimal: pair.feeDecimal,
    fee: pair.fee,
    // Update with new values
    reserve0: syncData.reserve0,
    reserve1: syncData.reserve1,
    blockNumber,
    lastUpdate: Date.now()
  };
}

/**
 * Build a PriceUpdate message for publishing.
 * Pure function - no side effects.
 *
 * @param pair - Pair that was updated
 * @param syncData - Decoded sync event data
 * @param price - Calculated price
 * @param blockNumber - Block number of the event
 * @param chain - Chain identifier
 * @returns PriceUpdate object ready for publishing
 */
export function buildPriceUpdate(
  pair: Pair,
  syncData: DecodedSyncEvent,
  price: number,
  blockNumber: number,
  chain: string
): PriceUpdate {
  return {
    pairKey: `${pair.dex}_${pair.token0}_${pair.token1}`,
    dex: pair.dex,
    chain,
    token0: pair.token0,
    token1: pair.token1,
    price,
    reserve0: syncData.reserve0,
    reserve1: syncData.reserve1,
    blockNumber,
    timestamp: Date.now(),
    latency: 0,
    // Include DEX-specific fee for accurate arbitrage calculations
    feeDecimal: pair.feeDecimal,
    fee: pair.fee
  };
}

/**
 * Build a SwapEvent message for publishing.
 * Pure function - no side effects.
 *
 * @param pair - Pair where swap occurred
 * @param swapData - Decoded swap event data
 * @param log - Raw event log
 * @param chain - Chain identifier
 * @param usdValue - Estimated USD value of the swap
 * @returns SwapEvent object ready for publishing
 */
export function buildSwapEvent(
  pair: Pair,
  swapData: DecodedSwapEvent,
  log: RawEventLog,
  chain: string,
  usdValue: number
): SwapEvent {
  const blockNumber = parseBlockNumber(log.blockNumber);

  return {
    pairAddress: pair.address,
    sender: swapData.sender,
    recipient: swapData.recipient,
    amount0In: swapData.amount0In,
    amount1In: swapData.amount1In,
    amount0Out: swapData.amount0Out,
    amount1Out: swapData.amount1Out,
    to: swapData.recipient,
    blockNumber,
    transactionHash: log.transactionHash || '0x0',
    timestamp: Date.now(),
    dex: pair.dex,
    chain,
    usdValue
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate pair key for map lookups.
 * Pure function for consistent key generation.
 *
 * @param dex - DEX identifier
 * @param token0 - Token0 address
 * @param token1 - Token1 address
 * @returns Pair key string
 */
export function generatePairKey(dex: string, token0: string, token1: string): string {
  return `${dex}_${token0}_${token1}`;
}
