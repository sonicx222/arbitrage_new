/**
 * Adapter Registry
 *
 * Central registry for managing vault-model and pool-model DEX adapters.
 * Provides adapter lookup by DEX name and chain, and integration with
 * the pair discovery system.
 *
 * Usage:
 * ```typescript
 * const registry = getAdapterRegistry();
 * registry.register(new BalancerV2Adapter(config));
 *
 * const adapter = registry.getAdapter('balancer_v2', 'arbitrum');
 * const pools = await adapter.discoverPools(tokenA, tokenB);
 * ```
 *
 * @see ADR-003: Partitioned Detector Strategy
 */

import { createLogger, Logger } from '../logger';
import {
  DexAdapter,
  AdapterKey,
  DiscoveredPool,
} from './types';

// =============================================================================
// Types
// =============================================================================

interface Dex {
  name: string;
  chain: string;
  factoryAddress: string;
  routerAddress: string;
  fee: number;
  enabled?: boolean;
}

interface Token {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
}

// =============================================================================
// Implementation
// =============================================================================

export class AdapterRegistry {
  private adapters: Map<AdapterKey, DexAdapter> = new Map();
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger('adapter-registry');
  }

  /**
   * Generate a consistent key for adapter lookup
   */
  private makeKey(dexName: string, chain: string): AdapterKey {
    return `${dexName.toLowerCase()}:${chain.toLowerCase()}` as AdapterKey;
  }

  /**
   * Register an adapter.
   * FIX P1-5: Awaits destroy() of any replaced adapter to prevent resource leaks
   * and race conditions between old adapter cleanup and new adapter usage.
   */
  async register(adapter: DexAdapter): Promise<void> {
    const key = this.makeKey(adapter.name, adapter.chain);

    // Destroy existing adapter if present — await to prevent race conditions
    const existing = this.adapters.get(key);
    if (existing) {
      this.logger.info(`Replacing existing adapter: ${key}`);
      try {
        await existing.destroy();
      } catch (err) {
        this.logger.warn('Error destroying replaced adapter', { key, error: err });
      }
    }

    this.adapters.set(key, adapter);
    this.logger.info(`Registered adapter: ${key}`, {
      type: adapter.type,
      address: adapter.primaryAddress,
    });
  }

  /**
   * Get an adapter by DEX name and chain
   */
  getAdapter(dexName: string, chain: string): DexAdapter | null {
    const key = this.makeKey(dexName, chain);
    return this.adapters.get(key) || null;
  }

  /**
   * Get an adapter for a Dex config object
   */
  getAdapterForDex(dex: Dex): DexAdapter | null {
    return this.getAdapter(dex.name, dex.chain);
  }

  /**
   * List all registered adapters
   */
  listAdapters(): DexAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * List adapters for a specific chain.
   * PERF-003 FIX: Uses iterator-based filtering to avoid copying entire Map to array.
   */
  listAdaptersByChain(chain: string): DexAdapter[] {
    const chainLower = chain.toLowerCase();
    const result: DexAdapter[] = [];
    for (const adapter of this.adapters.values()) {
      if (adapter.chain.toLowerCase() === chainLower) {
        result.push(adapter);
      }
    }
    return result;
  }

  /**
   * Unregister an adapter.
   * FIX P1-5: Awaits destroy() to ensure proper resource cleanup before removal.
   */
  async unregister(dexName: string, chain: string): Promise<void> {
    const key = this.makeKey(dexName, chain);
    const adapter = this.adapters.get(key);

    if (adapter) {
      try {
        await adapter.destroy();
      } catch (err) {
        this.logger.warn('Error destroying unregistered adapter', { key, error: err });
      }
      this.adapters.delete(key);
      this.logger.info(`Unregistered adapter: ${key}`);
    }
  }

  /**
   * Destroy all adapters and clear registry
   */
  async destroyAll(): Promise<void> {
    this.logger.info('Destroying all adapters');

    const destroyPromises = Array.from(this.adapters.values()).map((adapter) =>
      adapter.destroy().catch((err) => {
        this.logger.warn('Error destroying adapter', {
          name: adapter.name,
          chain: adapter.chain,
          error: err,
        });
      })
    );

    await Promise.all(destroyPromises);
    this.adapters.clear();

    this.logger.info('All adapters destroyed');
  }

  /**
   * Discover pools for a token pair using the appropriate adapter
   *
   * Integration point for PairDiscoveryService to use vault-model adapters.
   */
  async discoverPair(
    chain: string,
    dex: Dex,
    token0: Token,
    token1: Token
  ): Promise<DiscoveredPool[]> {
    const adapter = this.getAdapterForDex(dex);

    if (!adapter) {
      this.logger.debug('No adapter for DEX', { dex: dex.name, chain });
      return [];
    }

    try {
      return await adapter.discoverPools(token0.address, token1.address);
    } catch (error) {
      this.logger.error('Adapter pool discovery failed', {
        dex: dex.name,
        chain,
        error,
      });
      return [];
    }
  }

  /**
   * Check health of all adapters in parallel
   */
  async checkHealth(): Promise<Map<AdapterKey, boolean>> {
    const entries = Array.from(this.adapters.entries());

    const settled = await Promise.allSettled(
      entries.map(async ([key, adapter]) => {
        const healthy = await adapter.isHealthy();
        return [key, healthy] as const;
      })
    );

    const results = new Map<AdapterKey, boolean>();
    for (let i = 0; i < settled.length; i++) {
      const entry = settled[i];
      if (entry.status === 'fulfilled') {
        results.set(entry.value[0], entry.value[1]);
      } else {
        results.set(entries[i][0], false);
      }
    }

    return results;
  }
}

// =============================================================================
// Singleton
// =============================================================================

let registryInstance: AdapterRegistry | null = null;

/**
 * Get the singleton adapter registry instance
 */
export function getAdapterRegistry(): AdapterRegistry {
  if (!registryInstance) {
    registryInstance = new AdapterRegistry();
  }
  return registryInstance;
}

/**
 * Reset the singleton (for testing)
 */
export async function resetAdapterRegistry(): Promise<void> {
  if (registryInstance) {
    await registryInstance.destroyAll();
    registryInstance = null;
  }
}
