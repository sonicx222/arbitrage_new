/**
 * DexLookupService - O(1) DEX Router Lookups
 *
 * Provides efficient Map-based lookups for DEX routers and configurations.
 * Eliminates O(n) array scanning in hot-path execution code.
 *
 * Performance:
 * - O(1) getRouterAddress() - Map-based chain+dex lookup
 * - O(1) hasChain() - Map.has() check
 *
 * Cache Structure:
 * - routerCache: Map<chain, Map<dexName, routerAddress>>
 * - dexByRouterCache: Map<chain, Map<routerAddress, Dex>> (for future use)
 * - dexCache: Map<chain, Map<dexName, Dex>> (for future use)
 *
 * Refs: Task #7, Finding 9.1
 * @see services/execution-engine/src/strategies/flash-loan.strategy.ts - getDexRouter()
 */

import { DEXES } from '@arbitrage/config';
import { Dex } from '@arbitrage/types';

/**
 * V3 DEX router addresses by chain.
 *
 * These routers use ISwapRouter.exactInputSingle (Uniswap V3 interface) and
 * are separate from the V2-style routers in APPROVED_ROUTERS.
 *
 * This constant mirrors V3_APPROVED_ROUTERS in contracts/deployments/addresses.ts.
 * It is duplicated here to avoid cross-boundary imports (rootDir constraint).
 *
 * @see contracts/deployments/addresses.ts V3_APPROVED_ROUTERS
 */
const V3_ROUTER_ADDRESSES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bsc: {
    pancakeswap_v3: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  },
  polygon: {
    uniswap_v3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
  avalanche: {
    trader_joe_v2: '0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30',
  },
  arbitrum: {
    uniswap_v3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
  base: {
    uniswap_v3: '0x2626664c2603336E57B271c5C0b26F421741e481',
  },
  ethereum: {
    uniswap_v3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  },
};

/**
 * Pre-built Map for O(1) V3 router lookups.
 * Map<chain, Map<dexName (lowercase), routerAddress>>
 */
const V3_ROUTER_MAP: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  Object.entries(V3_ROUTER_ADDRESSES).map(([chain, dexRouters]) => [
    chain,
    new Map(
      Object.entries(dexRouters).map(([dex, addr]) => [dex.toLowerCase(), addr])
    ),
  ])
);

export class DexLookupService {
  /**
   * O(1) router address lookup by chain + DEX name.
   * Map<chain, Map<dexName, routerAddress>>
   */
  private readonly routerCache: Map<string, Map<string, string>>;

  /**
   * O(1) reverse lookup: router address → full Dex object.
   * Map<chain, Map<routerAddress, Dex>>
   */
  private readonly dexByRouterCache: Map<string, Map<string, Dex>>;

  /**
   * O(1) Dex object lookup by chain + DEX name.
   * Map<chain, Map<dexName, Dex>>
   */
  private readonly dexCache: Map<string, Map<string, Dex>>;

  constructor() {
    this.routerCache = new Map();
    this.dexByRouterCache = new Map();
    this.dexCache = new Map();
    this.initializeCaches();
  }

  /**
   * Initialize all caches from @arbitrage/config DEXES.
   * Normalizes DEX names to lowercase for case-insensitive lookups.
   * Runs once at construction.
   */
  private initializeCaches(): void {
    for (const [chain, dexes] of Object.entries(DEXES)) {
      const chainRouterMap = new Map<string, string>();
      const chainDexByRouterMap = new Map<string, Dex>();
      const chainDexMap = new Map<string, Dex>();

      for (const dex of dexes) {
        // Skip disabled DEXes
        if (dex.enabled === false) {
          continue;
        }

        // Validate DEX entry
        if (!dex.name || !dex.routerAddress) {
          throw new Error(`[DexLookupService] Invalid DEX config in chain ${chain}: missing name or routerAddress`);
        }

        // Normalize DEX name and router address for case-insensitive lookups
        const normalizedName = dex.name.toLowerCase().trim();
        const normalizedRouter = dex.routerAddress.toLowerCase().trim();

        // Create normalized Dex copy with lowercase router address
        // This ensures consistent casing across all lookup methods
        const normalizedDex: Dex = {
          ...dex,
          routerAddress: normalizedRouter
        };

        // Populate all caches with normalized data
        chainRouterMap.set(normalizedName, normalizedRouter);
        chainDexByRouterMap.set(normalizedRouter, normalizedDex);
        chainDexMap.set(normalizedName, normalizedDex);
      }

      this.routerCache.set(chain, chainRouterMap);
      this.dexByRouterCache.set(chain, chainDexByRouterMap);
      this.dexCache.set(chain, chainDexMap);
    }
  }

  /**
   * Check if a chain has DEX configurations.
   * O(1) Map.has() check.
   *
   * @param chain - Chain identifier (e.g., 'ethereum', 'arbitrum')
   * @returns true if chain has DEX configs
   */
  public hasChain(chain: string): boolean {
    return this.routerCache.has(chain);
  }

  /**
   * Get router address for a DEX on a chain.
   * O(1) Map-based lookup. Case-insensitive DEX name matching.
   *
   * @param chain - Chain identifier (e.g., 'ethereum', 'arbitrum')
   * @param dexName - DEX name (case-insensitive, e.g., 'uniswap_v3', 'UNISWAP_V3')
   * @returns Router address or undefined if not found
   *
   * @example
   * ```typescript
   * const router = service.getRouterAddress('ethereum', 'uniswap_v3');
   * // '0xE592427A0AEce92De3Edee1F18E0157C05861564'
   * ```
   */
  public getRouterAddress(chain: string, dexName: string): string | undefined {
    const chainMap = this.routerCache.get(chain);
    if (!chainMap) {
      return undefined;
    }

    const normalizedName = dexName.toLowerCase().trim();
    return chainMap.get(normalizedName);
  }

  /**
   * Get full DEX configuration by name.
   * O(1) lookup using Map cache.
   *
   * @param chain - Chain identifier
   * @param dexName - DEX name (case-insensitive)
   * @returns Full Dex config or undefined if not found
   */
  public getDexByName(chain: string, dexName: string): Dex | undefined {
    const chainDexCache = this.dexCache.get(chain);
    if (!chainDexCache) {
      return undefined;
    }

    const normalized = dexName.toLowerCase().trim();
    return chainDexCache.get(normalized);
  }

  /**
   * Reverse lookup: find DEX by router address.
   * O(1) lookup using Map cache.
   *
   * @param chain - Chain identifier
   * @param routerAddress - Router address (case-insensitive)
   * @returns Dex config or undefined if not found
   */
  public findDexByRouter(chain: string, routerAddress: string): Dex | undefined {
    const reverseMap = this.dexByRouterCache.get(chain);
    if (!reverseMap) {
      return undefined;
    }

    const normalized = routerAddress.toLowerCase();
    return reverseMap.get(normalized);
  }

  /**
   * Get all DEXes configured for a chain.
   * Returns cached array (read-only).
   *
   * @param chain - Chain identifier
   * @returns Array of DEX configs (empty if chain not found)
   */
  public getAllDexesForChain(chain: string): readonly Dex[] {
    const chainDexCache = this.dexCache.get(chain);
    if (!chainDexCache) {
      return [];
    }
    return Array.from(chainDexCache.values());
  }

  /**
   * Check if a router address is valid for a chain.
   *
   * @param chain - Chain identifier
   * @param routerAddress - Router address to validate
   * @returns True if router exists for this chain
   */
  public isValidRouter(chain: string, routerAddress: string): boolean {
    return this.findDexByRouter(chain, routerAddress) !== undefined;
  }

  /**
   * Get V3 router address for a DEX on a chain.
   * O(1) Map-based lookup. Case-insensitive DEX name matching.
   *
   * V3 routers use ISwapRouter.exactInputSingle and require separate
   * encoding via V3SwapAdapter.
   *
   * @param chain - Chain identifier (e.g., 'ethereum', 'arbitrum')
   * @param dexName - DEX name (case-insensitive, e.g., 'uniswap_v3')
   * @returns V3 router address or undefined if not configured
   *
   * @example
   * ```typescript
   * const router = service.getV3RouterAddress('ethereum', 'uniswap_v3');
   * // '0xE592427A0AEce92De3Edee1F18E0157C05861564'
   * ```
   *
   * @see contracts/deployments/addresses.ts V3_APPROVED_ROUTERS
   */
  public getV3RouterAddress(chain: string, dexName: string): string | undefined {
    const chainMap = V3_ROUTER_MAP.get(chain);
    if (!chainMap) {
      return undefined;
    }
    return chainMap.get(dexName.toLowerCase().trim());
  }
}
