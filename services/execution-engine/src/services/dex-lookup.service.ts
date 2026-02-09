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
        chainRouterMap.set(normalizedName, normalizedRouter);

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
}
