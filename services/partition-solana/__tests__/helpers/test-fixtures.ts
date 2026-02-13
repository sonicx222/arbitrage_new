/**
 * Shared Test Fixtures for Partition Solana Tests
 *
 * Consolidates duplicated mock creation helpers across test files.
 * Each factory function returns a well-typed mock with sensible defaults
 * and accepts partial overrides.
 *
 * @see services/partition-solana/src/types.ts - SolanaPoolInfo, InternalPoolInfo
 */

import { jest } from '@jest/globals';
import type { VersionedPoolStore } from '../../src/pool/versioned-pool-store';
import type {
  SolanaPoolInfo,
  InternalPoolInfo,
} from '../../src/types';

// =============================================================================
// Pool Fixtures
// =============================================================================

/**
 * Create a mock SolanaPoolInfo (external pool format, no normalized fields).
 * Used by arbitrage-detector.test.ts which operates on SolanaPoolInfo.
 */
export function createMockSolanaPool(overrides: Partial<SolanaPoolInfo> = {}): SolanaPoolInfo {
  return {
    address: `pool-${Math.random().toString(36).slice(2, 10)}`,
    programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    dex: 'raydium',
    token0: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
    token1: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    fee: 25,
    price: 100,
    ...overrides,
  };
}

/**
 * Create a mock InternalPoolInfo (internal pool format with normalized tokens and pairKey).
 * Used by detection module tests that operate on InternalPoolInfo.
 */
export function createMockInternalPool(overrides: Partial<InternalPoolInfo> = {}): InternalPoolInfo {
  return {
    address: 'pool-address-1',
    programId: 'program-1',
    dex: 'raydium',
    token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
    token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
    fee: 25,
    price: 100,
    lastUpdated: Date.now(),
    normalizedToken0: 'SOL',
    normalizedToken1: 'USDC',
    pairKey: 'SOL-USDC',
    ...overrides,
  };
}

// =============================================================================
// Pool Store Fixtures
// =============================================================================

/**
 * Create a mock VersionedPoolStore backed by a pair map.
 * Provides getPoolsForPair and getPairKeys.
 * Used by cross-chain-detector and intra-solana-detector tests.
 */
export function createMockPoolStore(pairMap: Map<string, InternalPoolInfo[]>): VersionedPoolStore {
  return {
    getPoolsForPair: jest.fn<(key: string) => InternalPoolInfo[]>().mockImplementation(
      (key: string) => pairMap.get(key) ?? []
    ),
    getPairKeys: jest.fn<() => string[]>().mockReturnValue(Array.from(pairMap.keys())),
  } as unknown as VersionedPoolStore;
}

/**
 * Create a mock VersionedPoolStore with poolsIterator support.
 * Used by triangular-detector tests that iterate all pools.
 */
export function createMockPoolStoreWithIterator(pools: InternalPoolInfo[]): VersionedPoolStore {
  return {
    poolsIterator: jest.fn<() => IterableIterator<InternalPoolInfo>>().mockReturnValue(pools[Symbol.iterator]()),
    getPairKeys: jest.fn<() => string[]>().mockReturnValue([]),
    getPoolsForPair: jest.fn<(key: string) => InternalPoolInfo[]>().mockReturnValue([]),
  } as unknown as VersionedPoolStore;
}
