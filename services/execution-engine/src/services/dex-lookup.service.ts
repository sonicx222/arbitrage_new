/**
 * DexLookupService - O(1) DEX Router Lookups
 *
 * Provides efficient Map-based lookups for DEX routers and configurations.
 * Eliminates O(n) array scanning in hot-path execution code.
 *
 * Performance:
 * - O(1) getRouterAddress() - Map-based chain+dex lookup
 * - O(1) getDexByRouter() - Map-based reverse router→dex lookup
 * - O(1) hasChain() - Map.has() check
 *
 * Cache Structure:
 * - routerCache: Map<chain, Map<dexName, routerAddress>>
 * - dexByRouterCache: Map<chain, Map<routerAddress, Dex>>
 * - dexCache: Map<chain, Map<dexName, Dex>>
 *
 * Refs: Task #4, Finding 9.1
 * @see services/execution-engine/src/strategies/flash-loan.strategy.ts - getDexRouter()
 */

import { DEXES } from '@arbitrage/config';
import { Dex } from '@arbitrage/types';

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

        // Normalize DEX name for case-insensitive lookups
        const normalizedName = dex.name.toLowerCase().trim();
        const normalizedRouter = dex.routerAddress.toLowerCase().trim();

        // Populate router cache
        chainRouterMap.set(normalizedName, dex.routerAddress);

        // Populate reverse router→dex cache
        chainDexByRouterMap.set(normalizedRouter, dex);

        // Populate dex cache
        chainDexMap.set(normalizedName, dex);
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
   * Get full Dex object by router address (reverse lookup).
   * O(1) Map-based lookup.
   *
   * @param chain - Chain identifier
   * @param routerAddress - Router contract address
   * @returns Full Dex object or undefined if not found
   *
   * @example
   * ```typescript
   * const dex = service.getDexByRouter('ethereum', '0xE592427A0AEce92De3Edee1F18E0157C05861564');
   * // { name: 'uniswap_v3', chain: 'ethereum', ... }
   * ```
   */
  public getDexByRouter(chain: string, routerAddress: string): Dex | undefined {
    const chainMap = this.dexByRouterCache.get(chain);
    if (!chainMap) {
      return undefined;
    }

    const normalizedRouter = routerAddress.toLowerCase().trim();
    return chainMap.get(normalizedRouter);
  }

  /**
   * Get full Dex object by DEX name.
   * O(1) Map-based lookup. Case-insensitive DEX name matching.
   *
   * @param chain - Chain identifier
   * @param dexName - DEX name (case-insensitive)
   * @returns Full Dex object or undefined if not found
   *
   * @example
   * ```typescript
   * const dex = service.getDex('ethereum', 'uniswap_v3');
   * // { name: 'uniswap_v3', chain: 'ethereum', routerAddress: '0x...', ... }
   * ```
   */
  public getDex(chain: string, dexName: string): Dex | undefined {
    const chainMap = this.dexCache.get(chain);
    if (!chainMap) {
      return undefined;
    }

    const normalizedName = dexName.toLowerCase().trim();
    return chainMap.get(normalizedName);
  }

  /**
   * Get all enabled DEX names for a chain.
   * O(n) where n = DEXes on chain (typically 2-9).
   *
   * @param chain - Chain identifier
   * @returns Array of DEX names (original casing from config)
   */
  public getDexNames(chain: string): string[] {
    const chainMap = this.dexCache.get(chain);
    if (!chainMap) {
      return [];
    }

    return Array.from(chainMap.values()).map((dex) => dex.name);
  }

  /**
   * Get all enabled DEXes for a chain.
   * O(n) where n = DEXes on chain (typically 2-9).
   *
   * @param chain - Chain identifier
   * @returns Array of Dex objects
   */
  public getDexes(chain: string): Dex[] {
    const chainMap = this.dexCache.get(chain);
    if (!chainMap) {
      return [];
    }

    return Array.from(chainMap.values());
  }

  /**
   * Get count of enabled DEXes on a chain.
   * O(1) Map.size property.
   *
   * @param chain - Chain identifier
   * @returns Count of enabled DEXes
   */
  public getDexCount(chain: string): number {
    const chainMap = this.dexCache.get(chain);
    return chainMap ? chainMap.size : 0;
  }
}
