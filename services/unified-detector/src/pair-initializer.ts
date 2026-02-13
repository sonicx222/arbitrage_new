/**
 * Pair Initializer
 *
 * Builds initial pair data structures from DEX × token combinations.
 * Extracted from chain-instance.ts for single-responsibility principle.
 *
 * This is a startup-only module (NOT in the hot path).
 * It creates the data structures that hot-path code uses for O(1) lookups.
 *
 * @module pair-initializer
 * @see Finding #8 in .agent-reports/unified-detector-deep-analysis.md
 * @see ADR-014 - Modular Detector Components
 */

import { ethers } from 'ethers';
import { bpsToDecimal } from '@arbitrage/core';
import type { Dex, Token } from '@arbitrage/types';
import { validateFee } from './types';
import type { ExtendedPair } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for pair initialization.
 */
export interface PairInitializerConfig {
  /** Chain identifier */
  chainId: string;
  /** Enabled DEXes for this chain */
  dexes: Dex[];
  /** Core tokens for this chain */
  tokens: Token[];
}

/**
 * Result of pair initialization.
 * Contains all data structures needed for pair tracking and arbitrage detection.
 */
export interface InitializedPairs {
  /** Map of pairKey → ExtendedPair (key format: "dex_token0Symbol_token1Symbol") */
  pairs: Map<string, ExtendedPair>;
  /** Map of lowercase address → ExtendedPair for O(1) event routing */
  pairsByAddress: Map<string, ExtendedPair>;
  /** Map of normalized token key → ExtendedPair[] for O(1) arbitrage matching */
  pairsByTokens: Map<string, ExtendedPair[]>;
  /** Cached array of all pair addresses for subscription use */
  pairAddressesCache: string[];
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Generate a deterministic pair address from factory and token addresses.
 * This is a simplified version — real implementation would use CREATE2.
 *
 * @param factory - Factory contract address
 * @param token0 - First token address
 * @param token1 - Second token address
 * @returns Deterministic pair address
 */
export function generatePairAddress(factory: string, token0: string, token1: string): string {
  const hash = ethers.keccak256(
    ethers.solidityPacked(
      ['address', 'address', 'address'],
      [factory, token0, token1]
    )
  );
  return '0x' + hash.slice(26);
}

/**
 * Initialize pairs from DEX × token combinations.
 *
 * Creates all pairwise combinations of tokens for each DEX and builds
 * indexed data structures for efficient lookup during event processing.
 *
 * @param config - Chain, DEXes, and tokens configuration
 * @param getTokenPairKey - Function to generate normalized token pair key for indexing.
 *   Passed as callback so chain-instance can provide its cached hot-path version.
 * @returns InitializedPairs with all data structures populated
 */
export function initializePairs(
  config: PairInitializerConfig,
  getTokenPairKey: (token0: string, token1: string) => string
): InitializedPairs {
  const pairs = new Map<string, ExtendedPair>();
  const pairsByAddress = new Map<string, ExtendedPair>();
  const pairsByTokens = new Map<string, ExtendedPair[]>();

  for (const dex of config.dexes) {
    for (let i = 0; i < config.tokens.length; i++) {
      for (let j = i + 1; j < config.tokens.length; j++) {
        const token0 = config.tokens[i];
        const token1 = config.tokens[j];

        // Generate a deterministic pair address (placeholder)
        const pairAddress = generatePairAddress(dex.factoryAddress, token0.address, token1.address);

        // Convert fee from basis points to percentage for pair storage
        // Config stores fees in basis points (30 = 0.30%), Pair uses percentage (0.003)
        // FIX (Issue 2.1): Migrate from deprecated dex.fee to dex.feeBps
        // Validate fee at source to catch config errors early
        const feePercentage = validateFee(bpsToDecimal(dex.feeBps ?? 30));

        // HOT-PATH OPT: Pre-compute pairKey once during initialization
        // This avoids per-event string allocation in emitPriceUpdate()
        const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
        // FIX Perf 10.2: Pre-compute chainPairKey for activity tracking
        // HOT-PATH OPT: Lowercase address once at creation to avoid per-event toLowerCase()
        const normalizedPairAddress = pairAddress.toLowerCase();
        const chainPairKey = `${config.chainId}:${normalizedPairAddress}`;

        // HOT-PATH OPT: Lowercase token addresses once at creation
        const normalizedToken0 = token0.address.toLowerCase();
        const normalizedToken1 = token1.address.toLowerCase();

        const pair: ExtendedPair = {
          address: normalizedPairAddress,
          dex: dex.name,
          token0: normalizedToken0,
          token1: normalizedToken1,
          fee: feePercentage,
          reserve0: '0',
          reserve1: '0',
          blockNumber: 0,
          lastUpdate: 0,
          pairKey,  // Cache for O(0) access in hot path
          chainPairKey,  // FIX Perf 10.2: Cache for O(0) activity tracking
        };

        pairs.set(pairKey, pair);
        pairsByAddress.set(normalizedPairAddress, pair);

        // P0-PERF FIX: Add to token-indexed lookup for O(1) arbitrage detection
        // Use already-normalized tokens to avoid redundant toLowerCase() in getTokenPairKey
        const tokenKey = getTokenPairKey(normalizedToken0, normalizedToken1);
        let pairsForTokens = pairsByTokens.get(tokenKey);
        if (!pairsForTokens) {
          pairsForTokens = [];
          pairsByTokens.set(tokenKey, pairsForTokens);
        }
        pairsForTokens.push(pair);
      }
    }
  }

  // P2-FIX 3.3: Build cached pair addresses array once after loading all pairs
  const pairAddressesCache = Array.from(pairsByAddress.keys());

  return { pairs, pairsByAddress, pairsByTokens, pairAddressesCache };
}
