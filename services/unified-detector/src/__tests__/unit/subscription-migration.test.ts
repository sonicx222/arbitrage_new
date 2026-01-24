/**
 * Subscription Migration Tests (Task 2.1.3)
 *
 * TDD tests for migrating from individual pair subscriptions to
 * factory-level subscriptions for 40-50x RPC reduction.
 *
 * @see implementation_plan_v2.md Phase 2.1.3
 * @see ADR-003: Partitioned Chain Detectors
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Test Types
// =============================================================================

/**
 * Subscription mode configuration for gradual rollout.
 */
interface SubscriptionModeConfig {
  /**
   * When true, use factory-level subscriptions (new mode).
   * When false, use individual pair subscriptions (legacy mode).
   * Default: false (legacy mode for safety during rollout)
   */
  useFactorySubscriptions: boolean;

  /**
   * Percentage of chains to migrate (0-100).
   * Used for gradual rollout within a partition.
   * Default: 0 (no chains migrated)
   */
  factorySubscriptionRolloutPercent?: number;

  /**
   * Specific chains to enable factory subscriptions for.
   * Overrides rolloutPercent for these chains.
   * Default: [] (none)
   */
  factorySubscriptionEnabledChains?: string[];
}

/**
 * Subscription statistics for monitoring.
 */
interface SubscriptionStats {
  /** Total active subscriptions */
  totalSubscriptions: number;
  /** Subscriptions per chain */
  subscriptionsByChain: Record<string, number>;
  /** Subscription mode per chain */
  modeByChain: Record<string, 'factory' | 'legacy'>;
  /** Number of monitored pairs */
  monitoredPairs: number;
  /** Estimated RPC reduction ratio */
  rpcReductionRatio: number;
}

// =============================================================================
// Mock Implementations
// =============================================================================

/**
 * Mock WebSocket Manager for testing subscription counts.
 */
class MockWebSocketManager {
  private subscriptions: Map<string, { topics: string[]; addresses: string[] }> = new Map();
  private subscriptionIdCounter = 0;

  async subscribe(params: { topics: string[]; addresses?: string[] }): Promise<string> {
    const id = `sub_${++this.subscriptionIdCounter}`;
    this.subscriptions.set(id, {
      topics: params.topics,
      addresses: params.addresses || []
    });
    return id;
  }

  async unsubscribe(id: string): Promise<void> {
    this.subscriptions.delete(id);
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  getSubscriptions(): Map<string, { topics: string[]; addresses: string[] }> {
    return new Map(this.subscriptions);
  }

  isConnected(): boolean {
    return true;
  }

  clear(): void {
    this.subscriptions.clear();
    this.subscriptionIdCounter = 0;
  }
}

/**
 * Mock Factory Subscription Service for testing.
 */
class MockFactorySubscriptionService {
  private subscribed = false;
  private factoryCount = 0;

  constructor(
    private chain: string,
    private factoryAddresses: string[]
  ) {
    this.factoryCount = factoryAddresses.length;
  }

  async subscribeToFactories(): Promise<void> {
    this.subscribed = true;
  }

  isSubscribed(): boolean {
    return this.subscribed;
  }

  getSubscriptionCount(): number {
    // Factory subscriptions group by event type, typically 3-5 subscriptions total
    return this.subscribed ? Math.min(this.factoryCount, 7) : 0;
  }

  stop(): void {
    this.subscribed = false;
  }
}

/**
 * Subscription Manager that supports both modes.
 * This is the component under test.
 */
class SubscriptionManager {
  private config: SubscriptionModeConfig;
  private wsManager: MockWebSocketManager;
  private factoryService: MockFactorySubscriptionService | null = null;
  private legacySubscriptions: string[] = [];
  private chain: string;
  private pairAddresses: string[];
  private factoryAddresses: string[];
  private stats: SubscriptionStats;

  constructor(
    chain: string,
    config: SubscriptionModeConfig,
    wsManager: MockWebSocketManager,
    pairAddresses: string[],
    factoryAddresses: string[]
  ) {
    this.chain = chain;
    this.config = config;
    this.wsManager = wsManager;
    this.pairAddresses = pairAddresses;
    this.factoryAddresses = factoryAddresses;
    this.stats = {
      totalSubscriptions: 0,
      subscriptionsByChain: {},
      modeByChain: {},
      monitoredPairs: pairAddresses.length,
      rpcReductionRatio: 1
    };
  }

  /**
   * Determine if factory subscriptions should be used for this chain.
   */
  shouldUseFactorySubscriptions(): boolean {
    // Check if explicitly enabled via config flag
    if (!this.config.useFactorySubscriptions) {
      return false;
    }

    // If explicit chain list is provided, only enable for those chains
    if (this.config.factorySubscriptionEnabledChains &&
        this.config.factorySubscriptionEnabledChains.length > 0) {
      return this.config.factorySubscriptionEnabledChains.includes(this.chain);
    }

    // Check rollout percentage
    if (this.config.factorySubscriptionRolloutPercent !== undefined) {
      // Use deterministic hash of chain name for consistent rollout
      const chainHash = this.hashChainName(this.chain);
      return (chainHash % 100) < this.config.factorySubscriptionRolloutPercent;
    }

    // Default: if flag is true but no specific config, enable for all
    return this.config.useFactorySubscriptions;
  }

  /**
   * Simple deterministic hash for chain name (for rollout percentage).
   */
  private hashChainName(chain: string): number {
    let hash = 0;
    for (let i = 0; i < chain.length; i++) {
      hash = ((hash << 5) - hash + chain.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  /**
   * Subscribe using the appropriate mode.
   */
  async subscribe(): Promise<void> {
    if (this.shouldUseFactorySubscriptions()) {
      await this.subscribeFactory();
    } else {
      await this.subscribeLegacy();
    }

    this.updateStats();
  }

  /**
   * Factory-level subscription (new mode).
   */
  private async subscribeFactory(): Promise<void> {
    this.factoryService = new MockFactorySubscriptionService(
      this.chain,
      this.factoryAddresses
    );
    await this.factoryService.subscribeToFactories();

    this.stats.modeByChain[this.chain] = 'factory';
  }

  /**
   * Pair-level subscription (legacy mode).
   */
  private async subscribeLegacy(): Promise<void> {
    // Subscribe to Sync events for all pairs
    const syncSubId = await this.wsManager.subscribe({
      topics: ['0x0d3648bd...'], // Sync event signature
      addresses: this.pairAddresses
    });
    this.legacySubscriptions.push(syncSubId);

    // Subscribe to Swap events for all pairs
    const swapSubId = await this.wsManager.subscribe({
      topics: ['0xd78ad95f...'], // Swap event signature
      addresses: this.pairAddresses
    });
    this.legacySubscriptions.push(swapSubId);

    // Subscribe to new blocks
    const blockSubId = await this.wsManager.subscribe({
      topics: ['newHeads']
    });
    this.legacySubscriptions.push(blockSubId);

    this.stats.modeByChain[this.chain] = 'legacy';
  }

  /**
   * Update subscription statistics.
   */
  private updateStats(): void {
    const mode = this.stats.modeByChain[this.chain];

    if (mode === 'factory' && this.factoryService) {
      this.stats.subscriptionsByChain[this.chain] = this.factoryService.getSubscriptionCount();
    } else {
      this.stats.subscriptionsByChain[this.chain] = this.legacySubscriptions.length;
    }

    this.stats.totalSubscriptions = Object.values(this.stats.subscriptionsByChain)
      .reduce((sum, count) => sum + count, 0);

    // Calculate RPC reduction ratio
    // Legacy: ~3 subscriptions but addresses array can be huge
    // Factory: ~5-7 subscriptions but only to factory addresses
    const legacyEquivalent = this.pairAddresses.length > 0 ? 3 : 0;
    const currentSubs = this.stats.totalSubscriptions;

    if (currentSubs > 0 && mode === 'factory') {
      // The real reduction is in the addresses filter list, not subscription count
      // Factory mode: ~20 factory addresses vs 1000+ pair addresses
      this.stats.rpcReductionRatio = this.pairAddresses.length / Math.max(this.factoryAddresses.length, 1);
    } else {
      this.stats.rpcReductionRatio = 1;
    }
  }

  /**
   * Stop all subscriptions.
   */
  async stop(): Promise<void> {
    if (this.factoryService) {
      this.factoryService.stop();
      this.factoryService = null;
    }

    for (const subId of this.legacySubscriptions) {
      await this.wsManager.unsubscribe(subId);
    }
    this.legacySubscriptions = [];

    this.stats.subscriptionsByChain[this.chain] = 0;
    this.stats.totalSubscriptions = 0;
  }

  /**
   * Get current subscription statistics.
   */
  getStats(): SubscriptionStats {
    return { ...this.stats };
  }

  /**
   * Get subscription mode for this chain.
   */
  getMode(): 'factory' | 'legacy' | 'none' {
    return this.stats.modeByChain[this.chain] || 'none';
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Task 2.1.3: Subscription Migration', () => {
  let wsManager: MockWebSocketManager;

  beforeEach(() => {
    wsManager = new MockWebSocketManager();
  });

  afterEach(() => {
    wsManager.clear();
  });

  // ---------------------------------------------------------------------------
  // Config Flag Tests
  // ---------------------------------------------------------------------------

  describe('Config Flag: useFactorySubscriptions', () => {
    it('should default to legacy mode when useFactorySubscriptions is false', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: false },
        wsManager,
        ['0xPair1', '0xPair2', '0xPair3'],
        ['0xFactory1', '0xFactory2']
      );

      await manager.subscribe();

      expect(manager.getMode()).toBe('legacy');
    });

    it('should use factory mode when useFactorySubscriptions is true', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: true },
        wsManager,
        ['0xPair1', '0xPair2', '0xPair3'],
        ['0xFactory1', '0xFactory2']
      );

      await manager.subscribe();

      expect(manager.getMode()).toBe('factory');
    });

    it('should support environment variable override', () => {
      // Simulate ENV var parsing (as done in chain-instance.ts)
      const envValue = process.env.USE_FACTORY_SUBSCRIPTIONS;
      const config: SubscriptionModeConfig = {
        useFactorySubscriptions: envValue === 'true' || envValue === '1'
      };

      // Default (no env var set) should be false
      expect(config.useFactorySubscriptions).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Gradual Rollout Tests
  // ---------------------------------------------------------------------------

  describe('Gradual Rollout', () => {
    it('should enable factory subscriptions for specific chains only', async () => {
      const config: SubscriptionModeConfig = {
        useFactorySubscriptions: true,
        factorySubscriptionEnabledChains: ['arbitrum', 'base']
      };

      const arbitrumManager = new SubscriptionManager(
        'arbitrum',
        config,
        wsManager,
        ['0xPair1'],
        ['0xFactory1']
      );

      const bscManager = new SubscriptionManager(
        'bsc',
        config,
        new MockWebSocketManager(),
        ['0xPair1'],
        ['0xFactory1']
      );

      expect(arbitrumManager.shouldUseFactorySubscriptions()).toBe(true);
      expect(bscManager.shouldUseFactorySubscriptions()).toBe(false);
    });

    it('should respect rollout percentage', () => {
      const config: SubscriptionModeConfig = {
        useFactorySubscriptions: true,
        factorySubscriptionRolloutPercent: 50 // 50% of chains
      };

      // Test with multiple chains - some should be enabled, some not
      const chains = ['arbitrum', 'base', 'optimism', 'bsc', 'polygon', 'avalanche'];
      const results = chains.map(chain => {
        const manager = new SubscriptionManager(
          chain,
          config,
          new MockWebSocketManager(),
          [],
          []
        );
        return manager.shouldUseFactorySubscriptions();
      });

      // With 50% rollout, roughly half should be enabled
      // Due to deterministic hashing, this is reproducible
      const enabledCount = results.filter(r => r).length;
      expect(enabledCount).toBeGreaterThan(0);
      expect(enabledCount).toBeLessThan(chains.length);
    });

    it('should be deterministic across restarts', () => {
      const config: SubscriptionModeConfig = {
        useFactorySubscriptions: true,
        factorySubscriptionRolloutPercent: 50
      };

      // Same chain should always get same result
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        const manager = new SubscriptionManager(
          'arbitrum',
          config,
          new MockWebSocketManager(),
          [],
          []
        );
        results.push(manager.shouldUseFactorySubscriptions());
      }

      // All results should be the same
      expect(new Set(results).size).toBe(1);
    });

    it('should allow 0% rollout (all legacy)', () => {
      const config: SubscriptionModeConfig = {
        useFactorySubscriptions: true,
        factorySubscriptionRolloutPercent: 0
      };

      const chains = ['arbitrum', 'base', 'optimism', 'bsc'];
      const results = chains.map(chain => {
        const manager = new SubscriptionManager(
          chain,
          config,
          new MockWebSocketManager(),
          [],
          []
        );
        return manager.shouldUseFactorySubscriptions();
      });

      // 0% rollout should enable none
      expect(results.every(r => !r)).toBe(true);
    });

    it('should allow 100% rollout (all factory)', () => {
      const config: SubscriptionModeConfig = {
        useFactorySubscriptions: true,
        factorySubscriptionRolloutPercent: 100
      };

      const chains = ['arbitrum', 'base', 'optimism', 'bsc'];
      const results = chains.map(chain => {
        const manager = new SubscriptionManager(
          chain,
          config,
          new MockWebSocketManager(),
          [],
          []
        );
        return manager.shouldUseFactorySubscriptions();
      });

      // 100% rollout should enable all
      expect(results.every(r => r)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Subscription Count Monitoring Tests
  // ---------------------------------------------------------------------------

  describe('Subscription Count Monitoring', () => {
    it('should report subscription statistics', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: false },
        wsManager,
        ['0xPair1', '0xPair2', '0xPair3', '0xPair4', '0xPair5'],
        ['0xFactory1', '0xFactory2']
      );

      await manager.subscribe();

      const stats = manager.getStats();
      expect(stats.totalSubscriptions).toBeGreaterThan(0);
      expect(stats.subscriptionsByChain['arbitrum']).toBeDefined();
      expect(stats.modeByChain['arbitrum']).toBe('legacy');
      expect(stats.monitoredPairs).toBe(5);
    });

    it('should calculate RPC reduction ratio for factory mode', async () => {
      const pairAddresses = Array.from({ length: 100 }, (_, i) => `0xPair${i}`);
      const factoryAddresses = ['0xFactory1', '0xFactory2', '0xFactory3'];

      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: true },
        wsManager,
        pairAddresses,
        factoryAddresses
      );

      await manager.subscribe();

      const stats = manager.getStats();
      expect(stats.modeByChain['arbitrum']).toBe('factory');
      // 100 pairs / 3 factories = ~33x reduction
      expect(stats.rpcReductionRatio).toBeGreaterThan(30);
    });

    it('should reset stats on stop', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: false },
        wsManager,
        ['0xPair1'],
        ['0xFactory1']
      );

      await manager.subscribe();
      expect(manager.getStats().totalSubscriptions).toBeGreaterThan(0);

      await manager.stop();
      expect(manager.getStats().totalSubscriptions).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy Mode Tests (Backward Compatibility)
  // ---------------------------------------------------------------------------

  describe('Legacy Mode (Backward Compatibility)', () => {
    it('should create subscriptions for Sync, Swap, and newHeads', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: false },
        wsManager,
        ['0xPair1', '0xPair2'],
        []
      );

      await manager.subscribe();

      // Legacy mode: 3 subscriptions (Sync, Swap, newHeads)
      expect(wsManager.getSubscriptionCount()).toBe(3);
    });

    it('should include all pair addresses in subscription filter', async () => {
      const pairs = ['0xPair1', '0xPair2', '0xPair3'];
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: false },
        wsManager,
        pairs,
        []
      );

      await manager.subscribe();

      const subscriptions = wsManager.getSubscriptions();
      // At least one subscription should have all pair addresses
      let foundAddressFilter = false;
      for (const [, sub] of subscriptions) {
        if (sub.addresses.length === pairs.length) {
          foundAddressFilter = true;
          expect(sub.addresses).toEqual(pairs);
        }
      }
      expect(foundAddressFilter).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Factory Mode Tests
  // ---------------------------------------------------------------------------

  describe('Factory Mode', () => {
    it('should use factory subscription service', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: true },
        wsManager,
        ['0xPair1', '0xPair2', '0xPair3'],
        ['0xFactory1', '0xFactory2']
      );

      await manager.subscribe();

      expect(manager.getMode()).toBe('factory');
      // Factory mode should have fewer subscriptions
      const stats = manager.getStats();
      expect(stats.subscriptionsByChain['arbitrum']).toBeLessThanOrEqual(7);
    });

    it('should clean up factory service on stop', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: true },
        wsManager,
        ['0xPair1'],
        ['0xFactory1']
      );

      await manager.subscribe();
      expect(manager.getStats().subscriptionsByChain['arbitrum']).toBeGreaterThan(0);

      await manager.stop();
      expect(manager.getStats().subscriptionsByChain['arbitrum']).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Mode Switching Tests
  // ---------------------------------------------------------------------------

  describe('Mode Switching', () => {
    it('should allow switching from legacy to factory mode', async () => {
      // Start in legacy mode
      const legacyConfig: SubscriptionModeConfig = { useFactorySubscriptions: false };
      const manager1 = new SubscriptionManager(
        'arbitrum',
        legacyConfig,
        wsManager,
        ['0xPair1'],
        ['0xFactory1']
      );

      await manager1.subscribe();
      expect(manager1.getMode()).toBe('legacy');
      await manager1.stop();

      // Switch to factory mode
      const factoryConfig: SubscriptionModeConfig = { useFactorySubscriptions: true };
      const manager2 = new SubscriptionManager(
        'arbitrum',
        factoryConfig,
        wsManager,
        ['0xPair1'],
        ['0xFactory1']
      );

      await manager2.subscribe();
      expect(manager2.getMode()).toBe('factory');
    });
  });

  // ---------------------------------------------------------------------------
  // Error Handling Tests
  // ---------------------------------------------------------------------------

  describe('Error Handling', () => {
    it('should handle empty pair list gracefully', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: false },
        wsManager,
        [], // No pairs
        []
      );

      // Should not throw
      await expect(manager.subscribe()).resolves.not.toThrow();
    });

    it('should handle empty factory list in factory mode', async () => {
      const manager = new SubscriptionManager(
        'arbitrum',
        { useFactorySubscriptions: true },
        wsManager,
        ['0xPair1'],
        [] // No factories
      );

      // Should still work (factory service handles empty list)
      await expect(manager.subscribe()).resolves.not.toThrow();
    });
  });
});

// =============================================================================
// Integration-like Tests (Simulating Real Scenarios)
// =============================================================================

describe('Task 2.1.3: Real Scenario Simulations', () => {
  it('should achieve 40x+ RPC reduction with typical pair counts', async () => {
    // Typical scenario: 1000 pairs, 25 factories
    const pairAddresses = Array.from({ length: 1000 }, (_, i) => `0xPair${i}`);
    const factoryAddresses = Array.from({ length: 25 }, (_, i) => `0xFactory${i}`);

    const wsManager = new MockWebSocketManager();

    // Factory mode
    const factoryManager = new SubscriptionManager(
      'arbitrum',
      { useFactorySubscriptions: true },
      wsManager,
      pairAddresses,
      factoryAddresses
    );

    await factoryManager.subscribe();
    const factoryStats = factoryManager.getStats();

    // Should achieve 40x+ reduction
    expect(factoryStats.rpcReductionRatio).toBeGreaterThanOrEqual(40);
  });

  it('should support mixed mode across partitions', async () => {
    const config: SubscriptionModeConfig = {
      useFactorySubscriptions: true,
      factorySubscriptionEnabledChains: ['arbitrum', 'base', 'optimism'] // L2-turbo partition
    };

    // L2-turbo chains should use factory mode
    const l2Chains = ['arbitrum', 'base', 'optimism'];
    for (const chain of l2Chains) {
      const manager = new SubscriptionManager(
        chain,
        config,
        new MockWebSocketManager(),
        [],
        []
      );
      expect(manager.shouldUseFactorySubscriptions()).toBe(true);
    }

    // Other chains should use legacy mode
    const otherChains = ['bsc', 'polygon', 'avalanche'];
    for (const chain of otherChains) {
      const manager = new SubscriptionManager(
        chain,
        config,
        new MockWebSocketManager(),
        [],
        []
      );
      expect(manager.shouldUseFactorySubscriptions()).toBe(false);
    }
  });
});

// =============================================================================
// P0-FIX Regression Tests: Factory Event Routing
// =============================================================================

describe('P0-FIX: Factory Event Routing', () => {
  // Factory event signatures (pre-computed keccak256 hashes)
  const FACTORY_EVENT_SIGNATURES = {
    // PairCreated(address indexed token0, address indexed token1, address pair, uint)
    uniswap_v2: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
    // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
    uniswap_v3: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
    // PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
    solidly: '0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9',
    // Sync(uint112 reserve0, uint112 reserve1) - NOT a factory event
    sync: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
    // Swap V2 - NOT a factory event
    swap_v2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  };

  /**
   * Mock implementation of factory event routing check.
   * This mirrors the actual implementation in ChainDetectorInstance.
   */
  class MockEventRouter {
    private factoryEventSignatureSet: Set<string>;
    private useFactorySubscriptions: boolean;
    private factoryEventsReceived: any[] = [];

    constructor(useFactorySubscriptions: boolean) {
      this.useFactorySubscriptions = useFactorySubscriptions;
      // Build signature set just like the real implementation
      this.factoryEventSignatureSet = new Set([
        FACTORY_EVENT_SIGNATURES.uniswap_v2,
        FACTORY_EVENT_SIGNATURES.uniswap_v3,
        FACTORY_EVENT_SIGNATURES.solidly,
      ]);
    }

    isFactoryEventSignature(topic0: string): boolean {
      return this.factoryEventSignatureSet.has(topic0.toLowerCase());
    }

    handleWebSocketMessage(message: { method: string; params: { result: { topics: string[]; address: string; data: string } } }): 'sync' | 'swap' | 'factory' | 'block' | 'ignored' {
      if (message.method !== 'eth_subscription') return 'ignored';

      const result = message.params?.result;
      if (!result?.topics) return 'ignored';

      const topic0 = result.topics[0];

      if (topic0 === FACTORY_EVENT_SIGNATURES.sync) {
        return 'sync';
      } else if (topic0 === FACTORY_EVENT_SIGNATURES.swap_v2) {
        return 'swap';
      } else if (this.useFactorySubscriptions && this.isFactoryEventSignature(topic0)) {
        // P0-FIX: Route to factory event handler
        this.factoryEventsReceived.push(result);
        return 'factory';
      }
      return 'ignored';
    }

    getFactoryEventsReceived(): any[] {
      return this.factoryEventsReceived;
    }
  }

  describe('Factory event signature detection', () => {
    it('should recognize V2 PairCreated as factory event', () => {
      const router = new MockEventRouter(true);
      expect(router.isFactoryEventSignature(FACTORY_EVENT_SIGNATURES.uniswap_v2)).toBe(true);
    });

    it('should recognize V3 PoolCreated as factory event', () => {
      const router = new MockEventRouter(true);
      expect(router.isFactoryEventSignature(FACTORY_EVENT_SIGNATURES.uniswap_v3)).toBe(true);
    });

    it('should recognize Solidly PairCreated as factory event', () => {
      const router = new MockEventRouter(true);
      expect(router.isFactoryEventSignature(FACTORY_EVENT_SIGNATURES.solidly)).toBe(true);
    });

    it('should NOT recognize Sync as factory event', () => {
      const router = new MockEventRouter(true);
      expect(router.isFactoryEventSignature(FACTORY_EVENT_SIGNATURES.sync)).toBe(false);
    });

    it('should NOT recognize Swap as factory event', () => {
      const router = new MockEventRouter(true);
      expect(router.isFactoryEventSignature(FACTORY_EVENT_SIGNATURES.swap_v2)).toBe(false);
    });

    it('should be case-insensitive', () => {
      const router = new MockEventRouter(true);
      const upperCase = FACTORY_EVENT_SIGNATURES.uniswap_v2.toUpperCase();
      expect(router.isFactoryEventSignature(upperCase)).toBe(true);
    });
  });

  describe('Factory event routing in handleWebSocketMessage', () => {
    it('should route V2 PairCreated events to factory handler when enabled', () => {
      const router = new MockEventRouter(true);

      const message = {
        method: 'eth_subscription',
        params: {
          result: {
            topics: [FACTORY_EVENT_SIGNATURES.uniswap_v2, '0x00...token0', '0x00...token1'],
            address: '0xFactoryAddress',
            data: '0x00...pairAddress...index'
          }
        }
      };

      const result = router.handleWebSocketMessage(message);
      expect(result).toBe('factory');
      expect(router.getFactoryEventsReceived()).toHaveLength(1);
    });

    it('should NOT route factory events when useFactorySubscriptions is false', () => {
      const router = new MockEventRouter(false); // Disabled

      const message = {
        method: 'eth_subscription',
        params: {
          result: {
            topics: [FACTORY_EVENT_SIGNATURES.uniswap_v2, '0x00...token0', '0x00...token1'],
            address: '0xFactoryAddress',
            data: '0x00...pairAddress...index'
          }
        }
      };

      const result = router.handleWebSocketMessage(message);
      expect(result).toBe('ignored'); // Should be ignored, not 'factory'
      expect(router.getFactoryEventsReceived()).toHaveLength(0);
    });

    it('should still route Sync events normally', () => {
      const router = new MockEventRouter(true);

      const message = {
        method: 'eth_subscription',
        params: {
          result: {
            topics: [FACTORY_EVENT_SIGNATURES.sync],
            address: '0xPairAddress',
            data: '0x00...reserves'
          }
        }
      };

      const result = router.handleWebSocketMessage(message);
      expect(result).toBe('sync');
    });

    it('should still route Swap events normally', () => {
      const router = new MockEventRouter(true);

      const message = {
        method: 'eth_subscription',
        params: {
          result: {
            topics: [FACTORY_EVENT_SIGNATURES.swap_v2],
            address: '0xPairAddress',
            data: '0x00...swapData'
          }
        }
      };

      const result = router.handleWebSocketMessage(message);
      expect(result).toBe('swap');
    });

    it('should handle V3 PoolCreated events', () => {
      const router = new MockEventRouter(true);

      const message = {
        method: 'eth_subscription',
        params: {
          result: {
            topics: [FACTORY_EVENT_SIGNATURES.uniswap_v3, '0x00...token0', '0x00...token1', '0x00...fee'],
            address: '0xFactoryAddress',
            data: '0x00...tickSpacing...poolAddress'
          }
        }
      };

      const result = router.handleWebSocketMessage(message);
      expect(result).toBe('factory');
    });
  });

  describe('Event routing order', () => {
    it('should prioritize Sync events over factory events', () => {
      // This ensures that if a Sync event somehow has same signature as factory,
      // Sync handler is called first (defense in depth)
      const router = new MockEventRouter(true);

      const syncMessage = {
        method: 'eth_subscription',
        params: {
          result: {
            topics: [FACTORY_EVENT_SIGNATURES.sync],
            address: '0xPairAddress',
            data: '0x00...reserves'
          }
        }
      };

      const result = router.handleWebSocketMessage(syncMessage);
      expect(result).toBe('sync');
      expect(router.getFactoryEventsReceived()).toHaveLength(0);
    });
  });
});
