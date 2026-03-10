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
import { bpsToDecimal } from '@arbitrage/core/components';
import { validateFee } from '@arbitrage/core/utils';
import { isVaultModelDex, isEvmChain, getFactoriesForChain } from '@arbitrage/config';
import type { Dex, Token } from '@arbitrage/types';
import type { ExtendedPair } from './types';

// =============================================================================
// CREATE2 Init Code Hashes (fallback when factory config lacks initCodeHash)
// Sourced from shared/core/src/pair-discovery.ts INIT_CODE_HASHES
// =============================================================================
const INIT_CODE_HASH_FALLBACKS: Record<string, string> = {
  uniswap_v2: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
  sushiswap: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
  pancakeswap_v2: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5',
  quickswap: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
  spookyswap: '0xcdf2deca40a0bd56de8e3ce5c7df6727e5b1bf2ac96f283fa9c4b3e6b42ea9d2',
  spiritswap: '0xe242e798f6cee26a9cb0bbf24653bf066e5356ffeac160907fe2cc108e238617',
  trader_joe_v2: '0x0bbca9af0511ad1a1da383135cf3a8d2ac620e549ef9f6ae3a4c33c2fed0af91',
  pangolin: '0x40231f6b438bce0797c9ada29b718a87ea0a5cea3fe9a771abdd76bd41a3e545',
};

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
 * Generate a deterministic pair address using the CREATE2 formula.
 *
 * FIX RT-012/SM-009: Previously used a simplified keccak hash that did NOT match
 * real on-chain pair addresses. Now uses the correct CREATE2 formula:
 *   address = keccak256(0xff ++ factory ++ keccak256(token0 ++ token1) ++ initCodeHash)[12:]
 *
 * When initCodeHash is provided, tokens are sorted for deterministic ordering
 * (matching Uniswap V2 factory's CREATE2 behavior).
 *
 * @param factory - Factory contract address
 * @param token0 - First token address
 * @param token1 - Second token address
 * @param initCodeHash - Optional init code hash for CREATE2 computation
 * @returns Deterministic pair address
 */
export function generatePairAddress(
  factory: string,
  token0: string,
  token1: string,
  initCodeHash?: string
): string {
  if (initCodeHash) {
    // Correct CREATE2: sort tokens for deterministic ordering
    const [sortedToken0, sortedToken1] = token0.toLowerCase() < token1.toLowerCase()
      ? [token0, token1]
      : [token1, token0];

    const salt = ethers.keccak256(
      ethers.solidityPacked(['address', 'address'], [sortedToken0, sortedToken1])
    );
    const packed = ethers.solidityPacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', factory, salt, initCodeHash]
    );
    return '0x' + ethers.keccak256(packed).slice(26);
  }

  // Fallback: simplified hash (won't match real on-chain addresses)
  const hash = ethers.keccak256(
    ethers.solidityPacked(
      ['address', 'address', 'address'],
      [factory, token0, token1]
    )
  );
  return '0x' + hash.slice(26);
}

/**
 * Look up the init code hash for a DEX, first from factory registry, then from fallback map.
 *
 * @param dexName - DEX name (e.g., 'uniswap_v2', 'sushiswap')
 * @param factoryAddress - Factory contract address
 * @param chainId - Chain identifier
 * @returns Init code hash or undefined
 */
function getInitCodeHashForDex(dexName: string, factoryAddress: string, chainId: string): string | undefined {
  // 1. Try factory registry (most accurate — per-chain, per-factory)
  const factories = getFactoriesForChain(chainId);
  const factoryConfig = factories.find(
    f => f.address.toLowerCase() === factoryAddress.toLowerCase()
  );
  if (factoryConfig?.initCodeHash) {
    return factoryConfig.initCodeHash;
  }

  // 2. Try exact name match in fallback map
  const nameLower = dexName.toLowerCase();
  if (INIT_CODE_HASH_FALLBACKS[nameLower]) {
    return INIT_CODE_HASH_FALLBACKS[nameLower];
  }

  // 3. Try fuzzy match (e.g., 'sushiswap_v2' → 'sushiswap')
  for (const [key, hash] of Object.entries(INIT_CODE_HASH_FALLBACKS)) {
    if (nameLower.includes(key.replace('_', ''))) {
      return hash;
    }
  }

  // 4. Default: Uniswap V2 hash for V2-style DEXes
  // Most V2 forks use the same init code hash as Uniswap V2
  return INIT_CODE_HASH_FALLBACKS.uniswap_v2;
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

  // CRIT-1 FIX: Non-EVM chains (Solana) use base58 addresses that fail ethers.solidityPacked
  // validation. generatePairAddress() is EVM-only (CREATE2 address derivation).
  // Solana pair discovery uses program account subscriptions via SolanaArbitrageDetector instead.
  if (!isEvmChain(config.chainId)) {
    return { pairs, pairsByAddress, pairsByTokens, pairAddressesCache: [] };
  }

  for (const dex of config.dexes) {
    // P0-1: Skip vault-model DEXes (Balancer V2, GMX, Platypus, Beethoven X).
    // These DEXes don't use factory-based pair addresses — generatePairAddress()
    // produces fake addresses that never match on-chain events.
    // Vault-model pairs are discovered via adapter in initializeAdapterPairs().
    if (isVaultModelDex(dex.name)) {
      continue;
    }

    // FIX RT-012: Look up init code hash for correct CREATE2 address computation
    const initCodeHash = getInitCodeHashForDex(dex.name, dex.factoryAddress, config.chainId);

    for (let i = 0; i < config.tokens.length; i++) {
      for (let j = i + 1; j < config.tokens.length; j++) {
        const token0 = config.tokens[i];
        const token1 = config.tokens[j];

        // FIX RT-012: Generate correct CREATE2 pair address using init code hash
        const pairAddress = generatePairAddress(dex.factoryAddress, token0.address, token1.address, initCodeHash);

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

/**
 * P0-1: Initialize pairs for vault-model DEXes using adapter-based pool discovery.
 *
 * Vault-model DEXes (Balancer V2, GMX, Platypus, Beethoven X) don't follow
 * the factory pattern, so generatePairAddress() produces fake addresses.
 * This function uses the adapter registry to discover real pool addresses.
 *
 * @param config - Chain, DEXes, and tokens configuration
 * @param initializedPairs - Existing InitializedPairs to merge into
 * @param getTokenPairKey - Token key generation function
 * @param logger - Logger instance (optional, for diagnostic output)
 */
export async function initializeAdapterPairs(
  config: PairInitializerConfig,
  initializedPairs: InitializedPairs,
  getTokenPairKey: (token0: string, token1: string) => string,
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  // Lazy import to avoid circular dependency at module load time
  const { getAdapterRegistry } = await import('@arbitrage/core/dex-adapters');
  const registry = getAdapterRegistry();

  const vaultDexes = config.dexes.filter(dex => isVaultModelDex(dex.name));
  if (vaultDexes.length === 0) return;

  let discoveredCount = 0;

  for (const dex of vaultDexes) {
    const adapter = registry.getAdapter(dex.name, config.chainId);
    if (!adapter) {
      logger?.warn('No adapter registered for vault-model DEX, skipping pool discovery', {
        dex: dex.name,
        chainId: config.chainId,
      });
      continue;
    }

    const feePercentage = validateFee(bpsToDecimal(dex.feeBps ?? 30));

    // Discover pools for all token pair combinations
    for (let i = 0; i < config.tokens.length; i++) {
      for (let j = i + 1; j < config.tokens.length; j++) {
        const token0 = config.tokens[i];
        const token1 = config.tokens[j];

        try {
          const pools = await adapter.discoverPools(token0.address, token1.address);

          for (const pool of pools) {
            const normalizedPoolAddress = pool.address.toLowerCase();

            // Skip if this address is already registered (e.g., from factory events)
            if (initializedPairs.pairsByAddress.has(normalizedPoolAddress)) continue;

            const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}_${normalizedPoolAddress.slice(0, 10)}`;
            const chainPairKey = `${config.chainId}:${normalizedPoolAddress}`;
            const normalizedToken0 = token0.address.toLowerCase();
            const normalizedToken1 = token1.address.toLowerCase();

            const pair: ExtendedPair = {
              address: normalizedPoolAddress,
              dex: dex.name,
              token0: normalizedToken0,
              token1: normalizedToken1,
              fee: feePercentage,
              reserve0: '0',
              reserve1: '0',
              blockNumber: 0,
              lastUpdate: 0,
              pairKey,
              chainPairKey,
            };

            initializedPairs.pairs.set(pairKey, pair);
            initializedPairs.pairsByAddress.set(normalizedPoolAddress, pair);

            const tokenKey = getTokenPairKey(normalizedToken0, normalizedToken1);
            let pairsForTokens = initializedPairs.pairsByTokens.get(tokenKey);
            if (!pairsForTokens) {
              pairsForTokens = [];
              initializedPairs.pairsByTokens.set(tokenKey, pairsForTokens);
            }
            pairsForTokens.push(pair);

            // Add to address cache for subscriptions
            initializedPairs.pairAddressesCache.push(normalizedPoolAddress);

            discoveredCount++;
          }
        } catch (error) {
          logger?.warn('Failed to discover pools via adapter', {
            dex: dex.name,
            token0: token0.symbol,
            token1: token1.symbol,
            error: (error as Error).message,
          });
        }
      }
    }
  }

  if (discoveredCount > 0) {
    logger?.info('Discovered vault-model DEX pools via adapters', {
      chainId: config.chainId,
      discoveredPools: discoveredCount,
      vaultDexes: vaultDexes.map(d => d.name),
    });
  }
}
