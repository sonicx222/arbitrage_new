/**
 * DEX Configurations
 *
 * Contains all DEX configurations per chain including:
 * - Factory and router addresses
 * - Fee structures
 * - Priority classifications: [C] Critical, [H] High, [M] Medium
 *
 * Total: 78 DEXes across 15 chains (57 EVM + 7 Solana + 14 Emerging L2s)
 *
 * Split into per-chain files under ./chains/ for maintainability.
 * This file aggregates them and provides lookup helpers.
 *
 * @see S2.2.1: Arbitrum DEX expansion (6->9)
 * @see S2.2.2: Base DEX expansion (5->7)
 * @see S2.2.3: BSC DEX expansion (5->8)
 * @see S3.1.2: New chain DEXes
 */

import { Dex } from '../../../types';

// Per-chain DEX imports
import { ARBITRUM_DEXES } from './chains/arbitrum';
import { AVALANCHE_DEXES } from './chains/avalanche';
import { BASE_DEXES } from './chains/base';
import { BLAST_DEXES } from './chains/blast';
import { BSC_DEXES } from './chains/bsc';
import { ETHEREUM_DEXES } from './chains/ethereum';
import { FANTOM_DEXES } from './chains/fantom';
import { LINEA_DEXES } from './chains/linea';
import { MANTLE_DEXES } from './chains/mantle';
import { MODE_DEXES } from './chains/mode';
import { OPTIMISM_DEXES } from './chains/optimism';
import { POLYGON_DEXES } from './chains/polygon';
import { SCROLL_DEXES } from './chains/scroll';
import { SOLANA_DEXES } from './chains/solana';
import { ZKSYNC_DEXES } from './chains/zksync';

// =============================================================================
// DEX REGISTRY — 78 DEXs across 15 chains
// =============================================================================
export const DEXES: Record<string, Dex[]> = {
  arbitrum: ARBITRUM_DEXES,
  bsc: BSC_DEXES,
  base: BASE_DEXES,
  polygon: POLYGON_DEXES,
  optimism: OPTIMISM_DEXES,
  ethereum: ETHEREUM_DEXES,
  avalanche: AVALANCHE_DEXES,
  fantom: FANTOM_DEXES,
  zksync: ZKSYNC_DEXES,
  linea: LINEA_DEXES,
  blast: BLAST_DEXES,
  scroll: SCROLL_DEXES,
  mantle: MANTLE_DEXES,
  mode: MODE_DEXES,
  solana: SOLANA_DEXES,
};

// =============================================================================
// DEX HELPER FUNCTIONS
// Standardize DEX access patterns across the codebase
// =============================================================================

/**
 * PERFORMANCE FIX: Pre-computed enabled DEXes cache.
 * Computed once at module load instead of filtering on every getEnabledDexes() call.
 * This is a hot-path optimization for arbitrage detection.
 */
const ENABLED_DEXES_CACHE: Record<string, Dex[]> = Object.fromEntries(
  Object.entries(DEXES).map(([chainId, dexes]) => [
    chainId,
    dexes.filter(dex => dex.enabled !== false)
  ])
);

/**
 * Get enabled DEXs for a chain.
 * Returns pre-computed filtered list (enabled !== false).
 * Uses cached result for performance in hot-path code.
 *
 * @param chainId - The chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of enabled Dex objects for the chain (read-only reference)
 */
export function getEnabledDexes(chainId: string): Dex[] {
  return ENABLED_DEXES_CACHE[chainId] || [];
}

/**
 * PERFORMANCE FIX: Pre-computed verified DEXes cache.
 * Filters out DEXes with `verified: false` (unverified/stub addresses).
 * Computed once at module load instead of filtering on every call.
 */
const VERIFIED_DEXES_CACHE: Record<string, Dex[]> = Object.fromEntries(
  Object.entries(DEXES).map(([chainId, dexes]) => [
    chainId,
    dexes.filter(dex => dex.enabled !== false && dex.verified !== false)
  ])
);

/**
 * Get verified and enabled DEXs for a chain.
 * Excludes DEXes with unverified addresses (verified === false).
 * Uses cached result for performance in hot-path code.
 *
 * @param chainId - The chain identifier (e.g., 'arbitrum', 'bsc')
 * @returns Array of verified, enabled Dex objects for the chain
 */
export function getVerifiedDexes(chainId: string): Dex[] {
  return VERIFIED_DEXES_CACHE[chainId] || [];
}

// Deprecated dexFeeToPercentage and percentageToBasisPoints removed in A6 refactoring.
// Use bpsToDecimal and decimalToBps from '@arbitrage/core' instead.
