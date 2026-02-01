/**
 * Pair Initialization Service
 *
 * Handles trading pair discovery and initialization for detector services.
 * Extracted from base-detector.ts to reduce class size and improve testability.
 *
 * This module handles INITIALIZATION ONLY - not hot-path operations.
 * All pair discovery is performed once at startup.
 *
 * @see base-detector.ts - Original implementation
 * @see S2.2.5 - Pair Discovery and Caching
 */

import { ethers } from 'ethers';
import type { Dex, Token, Pair } from '../../../types/src';
import type { PairDiscoveryService } from '../pair-discovery';
import type { PairCacheService } from '../caching/pair-cache';
import type { ServiceLogger } from '../logging';
import type {
  PairInitializationConfig,
  PairInitializationResult,
  DiscoveredPairResult,
} from './types';
import { dexFeeToPercentage } from '../../../config/src';

/**
 * Initialize trading pairs for a detector.
 *
 * This is a ONE-TIME initialization function called at detector startup.
 * NOT part of the hot path.
 *
 * @param config - Pair initialization configuration
 * @returns Promise resolving to initialization results
 */
export async function initializePairs(
  config: PairInitializationConfig
): Promise<PairInitializationResult> {
  const { chain, logger, dexes, tokens, pairDiscoveryService, pairCacheService } = config;
  const startTime = Date.now();

  logger.info(`Initializing ${chain} trading pairs`, {
    dexCount: dexes.length,
    tokenCount: tokens.length,
  });

  const discoveredPairs: DiscoveredPairResult[] = [];
  const processedPairKeys = new Set<string>();
  let pairsFailed = 0;

  // Iterate over all DEX + token combinations
  for (const dex of dexes) {
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const token0 = tokens[i];
        const token1 = tokens[j];

        // Build pair name (with slash for display) and full key
        const pairName = `${token0.symbol}/${token1.symbol}`;
        const fullPairKey = `${dex.name}_${pairName}`;

        // Skip if pair already processed (same tokens on different DEX is OK)
        if (processedPairKeys.has(fullPairKey)) continue;

        try {
          const pairAddress = await resolvePairAddress(
            chain,
            dex,
            token0,
            token1,
            pairDiscoveryService,
            pairCacheService,
            logger
          );

          if (pairAddress && pairAddress !== ethers.ZeroAddress) {
            // Convert fee from basis points to percentage for pair storage
            // Config stores fees in basis points (30 = 0.30%), Pair uses percentage (0.003)
            const feePercentage = dexFeeToPercentage(dex.fee ?? 30);

            const pair: Pair = {
              name: pairName,
              address: pairAddress,
              token0: token0.address,
              token1: token1.address,
              dex: dex.name,
              fee: feePercentage,
            };

            discoveredPairs.push({
              pairKey: fullPairKey,
              pair,
              dex: dex.name,
            });

            processedPairKeys.add(fullPairKey);

            logger.debug(`Discovered pair: ${pair.name} on ${dex.name}`, {
              address: pairAddress,
              pairKey: fullPairKey,
            });
          }
        } catch (error) {
          pairsFailed++;
          logger.warn(`Failed to get pair address for ${token0.symbol}/${token1.symbol} on ${dex.name}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  const durationMs = Date.now() - startTime;

  logger.info(`Pair initialization complete for ${chain}`, {
    pairsDiscovered: discoveredPairs.length,
    pairsFailed,
    durationMs,
  });

  return {
    pairs: discoveredPairs,
    pairsDiscovered: discoveredPairs.length,
    pairsFailed,
    durationMs,
  };
}

/**
 * Resolve a pair address using cache-first strategy.
 *
 * 1. Check Redis cache for existing pair address
 * 2. On miss, query factory contract via PairDiscoveryService
 * 3. Cache the result for future lookups
 * 4. Return null if pair doesn't exist
 *
 * @param chain - Chain identifier
 * @param dex - DEX configuration
 * @param token0 - First token
 * @param token1 - Second token
 * @param pairDiscoveryService - Discovery service instance
 * @param pairCacheService - Cache service instance
 * @param logger - Logger instance
 * @returns Pair address or null if not found
 */
export async function resolvePairAddress(
  chain: string,
  dex: Dex,
  token0: Token,
  token1: Token,
  pairDiscoveryService: PairDiscoveryService | null | undefined,
  pairCacheService: PairCacheService | null | undefined,
  logger: ServiceLogger
): Promise<string | null> {
  try {
    // Step 1: Check cache first (fast path)
    if (pairCacheService) {
      const cacheResult = await pairCacheService.get(
        chain,
        dex.name,
        token0.address,
        token1.address
      );

      if (cacheResult.status === 'hit') {
        // Cache hit - return cached address
        if (pairDiscoveryService) {
          pairDiscoveryService.incrementCacheHits();
        }
        return cacheResult.data.address;
      }

      if (cacheResult.status === 'null') {
        // Pair was previously checked and doesn't exist
        return null;
      }
      // Cache miss - proceed to discovery
    }

    // Step 2: Try factory query via PairDiscoveryService
    if (pairDiscoveryService) {
      const discoveredPair = await pairDiscoveryService.discoverPair(
        chain,
        dex,
        token0,
        token1
      );

      if (discoveredPair) {
        // Step 3: Cache the discovered pair
        if (pairCacheService) {
          await pairCacheService.set(
            chain,
            dex.name,
            token0.address,
            token1.address,
            {
              address: discoveredPair.address,
              token0: discoveredPair.token0,
              token1: discoveredPair.token1,
              dex: dex.name,
              chain,
              factoryAddress: dex.factoryAddress,
              discoveredAt: discoveredPair.discoveredAt,
              lastVerified: Date.now(),
              discoveryMethod: discoveredPair.discoveryMethod,
            }
          );
        }
        return discoveredPair.address;
      }

      // Pair doesn't exist - cache the null result to avoid repeated queries
      if (pairCacheService) {
        await pairCacheService.setNull(
          chain,
          dex.name,
          token0.address,
          token1.address
        );
      }
      return null;
    }

    // Step 4: Fallback - services not available, return null
    logger.warn('Pair services not initialized, returning null', {
      dex: dex.name,
      token0: token0.symbol,
      token1: token1.symbol,
    });
    return null;
  } catch (error) {
    logger.error(`Error getting pair address for ${dex.name}`, {
      error: error instanceof Error ? error.message : String(error),
      token0: token0.symbol,
      token1: token1.symbol,
    });
    return null;
  }
}

/**
 * Create a normalized token pair key.
 * Used for consistent pair lookups across the codebase.
 *
 * @param token0 - First token address
 * @param token1 - Second token address
 * @returns Normalized key "tokenA_tokenB" where tokenA < tokenB (alphabetically)
 */
export function createTokenPairKey(token0: string, token1: string): string {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  // Sort alphabetically for consistent key
  return t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;
}

/**
 * Build a full pair key including DEX name.
 *
 * @param dexName - DEX name
 * @param pairName - Pair name (e.g., "WETH/USDC")
 * @returns Full pair key (e.g., "uniswap_v2_WETH/USDC")
 */
export function buildFullPairKey(dexName: string, pairName: string): string {
  return `${dexName}_${pairName}`;
}
