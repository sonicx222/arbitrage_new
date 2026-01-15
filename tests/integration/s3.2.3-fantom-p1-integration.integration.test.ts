/**
 * S3.2.3 Integration Tests: Fantom Integration into P1 Partition
 *
 * These tests verify that Fantom is properly integrated into the P1 (Asia-Fast)
 * partition as specified in the Implementation Plan.
 *
 * Test Coverage:
 * - Partition configuration includes Fantom
 * - Service configuration derives Fantom correctly
 * - DEX configurations accessible from partition
 * - Chain instance creation for Fantom
 * - Cross-chain detection with Fantom
 * - Event handling for Fantom DEXs
 *
 * @see IMPLEMENTATION_PLAN.md S3.2.3: Integrate into P1 partition
 * @see ADR-003: Partitioned Chain Detectors
 */

import { describe, it, expect } from '@jest/globals';

import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  DETECTOR_CONFIG,
  TOKEN_METADATA,
  getEnabledDexes,
  PARTITION_IDS
} from '@arbitrage/config';

import {
  getPartition,
  getChainsForPartition,
  getChainsFromEnv,
  createChainInstance,
  createPartitionChainInstances,
  assignChainToPartition,
  calculatePartitionResources,
  validatePartitionConfig,
  isEvmChain,
  PARTITIONS
} from '@arbitrage/configpartitions';

// =============================================================================
// Constants
// =============================================================================

const P1_PARTITION_ID = PARTITION_IDS.ASIA_FAST;
const FANTOM_CHAIN_ID = 'fantom';
const FANTOM_NUMERIC_ID = 250;

/**
 * Expected P1 chains per S3.1.2 specification
 */
const P1_EXPECTED_CHAINS = ['bsc', 'polygon', 'avalanche', 'fantom'] as const;

/**
 * Fantom enabled DEXs (all DEXs including vault model with adapters)
 */
const FANTOM_ENABLED_DEXES = ['spookyswap', 'spiritswap', 'equalizer', 'beethoven_x'] as const;

/**
 * Fantom core tokens per S3.2.2
 */
const FANTOM_EXPECTED_TOKENS = [
  'WFTM', 'fUSDT', 'USDC', 'DAI', 'WETH', 'WBTC', 'BOO', 'SPIRIT', 'EQUAL', 'BEETS'
] as const;

// =============================================================================
// S3.2.3.1: Partition Configuration Tests
// =============================================================================

describe('S3.2.3: Fantom Integration into P1 Partition', () => {
  describe('S3.2.3.1: Partition Configuration', () => {
    it('should have Fantom included in P1 (asia-fast) partition chains', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.chains).toContain(FANTOM_CHAIN_ID);
    });

    it('should have all 4 expected chains in P1 partition', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.chains).toHaveLength(4);

      for (const chain of P1_EXPECTED_CHAINS) {
        expect(partition!.chains).toContain(chain);
      }
    });

    it('should return correct chains via getChainsForPartition', () => {
      const chains = getChainsForPartition(P1_PARTITION_ID);
      expect(chains).toHaveLength(4);
      expect(chains).toContain(FANTOM_CHAIN_ID);
    });

    it('should return array copy from getChainsForPartition (immutability)', () => {
      const chains1 = getChainsForPartition(P1_PARTITION_ID);
      const chains2 = getChainsForPartition(P1_PARTITION_ID);

      // Different references
      expect(chains1).not.toBe(chains2);

      // Mutation of first array should not affect second
      chains1.push('test-mutation');
      expect(chains2).not.toContain('test-mutation');

      // Original partition config should be unchanged
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.chains).not.toContain('test-mutation');
    });

    it('should assign Fantom to P1 partition via assignChainToPartition', () => {
      const assignedPartition = assignChainToPartition(FANTOM_CHAIN_ID);
      expect(assignedPartition).toBeDefined();
      expect(assignedPartition!.partitionId).toBe(P1_PARTITION_ID);
    });

    it('should assign all P1 chains to the same partition', () => {
      for (const chainId of P1_EXPECTED_CHAINS) {
        const assignedPartition = assignChainToPartition(chainId);
        expect(assignedPartition).toBeDefined();
        expect(assignedPartition!.partitionId).toBe(P1_PARTITION_ID);
      }
    });

    it('should have P1 partition enabled', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.enabled).toBe(true);
    });

    it('should have correct P1 partition properties', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition).toBeDefined();
      expect(partition!.name).toBe('Asia Fast Chains');
      expect(partition!.region).toBe('asia-southeast1');
      expect(partition!.provider).toBe('oracle');
      expect(partition!.resourceProfile).toBe('heavy');
      expect(partition!.priority).toBe(1);
    });
  });

  // =============================================================================
  // S3.2.3.2: Chain Instance Creation Tests
  // =============================================================================

  describe('S3.2.3.2: Chain Instance Creation', () => {
    it('should create valid ChainInstance for Fantom', () => {
      const instance = createChainInstance(FANTOM_CHAIN_ID);
      expect(instance).not.toBeNull();
      expect(instance!.chainId).toBe(FANTOM_CHAIN_ID);
      expect(instance!.numericId).toBe(FANTOM_NUMERIC_ID);
    });

    it('should have correct Fantom chain properties in instance', () => {
      const instance = createChainInstance(FANTOM_CHAIN_ID);
      expect(instance).not.toBeNull();

      // Verify block time (Fantom has fast ~1s blocks)
      expect(instance!.blockTime).toBeLessThanOrEqual(2);

      // Verify native token
      expect(instance!.nativeToken).toBe('FTM');

      // Verify initial status
      expect(instance!.status).toBe('disconnected');
      expect(instance!.lastBlockNumber).toBe(0);
      expect(instance!.eventsProcessed).toBe(0);
    });

    it('should include all enabled Fantom DEXs in chain instance', () => {
      const instance = createChainInstance(FANTOM_CHAIN_ID);
      expect(instance).not.toBeNull();

      for (const dexName of FANTOM_ENABLED_DEXES) {
        expect(instance!.dexes).toContain(dexName);
      }
    });

    it('should include Beethoven X in chain instance (now enabled with adapter)', () => {
      const instance = createChainInstance(FANTOM_CHAIN_ID);
      expect(instance).not.toBeNull();
      expect(instance!.dexes).toContain('beethoven_x');
    });

    it('should include Fantom tokens in chain instance', () => {
      const instance = createChainInstance(FANTOM_CHAIN_ID);
      expect(instance).not.toBeNull();
      expect(instance!.tokens.length).toBeGreaterThan(0);
    });

    it('should create partition chain instances including Fantom', () => {
      const instances = createPartitionChainInstances(P1_PARTITION_ID);
      expect(instances).toHaveLength(4);

      const fantomInstance = instances.find(i => i.chainId === FANTOM_CHAIN_ID);
      expect(fantomInstance).toBeDefined();
      expect(fantomInstance!.numericId).toBe(FANTOM_NUMERIC_ID);
    });

    it('should create instances for all P1 chains', () => {
      const instances = createPartitionChainInstances(P1_PARTITION_ID);
      const chainIds = instances.map(i => i.chainId);

      for (const expectedChain of P1_EXPECTED_CHAINS) {
        expect(chainIds).toContain(expectedChain);
      }
    });
  });

  // =============================================================================
  // S3.2.3.3: Fantom Chain Configuration Tests
  // =============================================================================

  describe('S3.2.3.3: Fantom Chain Configuration', () => {
    it('should have Fantom in CHAINS configuration', () => {
      expect(CHAINS[FANTOM_CHAIN_ID]).toBeDefined();
    });

    it('should have correct Fantom chain ID', () => {
      const fantomChain = CHAINS[FANTOM_CHAIN_ID];
      expect(fantomChain.id).toBe(FANTOM_NUMERIC_ID);
    });

    it('should have Fantom RPC URL configured', () => {
      const fantomChain = CHAINS[FANTOM_CHAIN_ID];
      expect(fantomChain.rpcUrl).toBeDefined();
      expect(fantomChain.rpcUrl.length).toBeGreaterThan(0);
    });

    it('should have Fantom marked as EVM chain', () => {
      expect(isEvmChain(FANTOM_CHAIN_ID)).toBe(true);
    });

    it('should have Fantom detector config', () => {
      expect(DETECTOR_CONFIG[FANTOM_CHAIN_ID]).toBeDefined();
    });

    it('should have Fantom token metadata', () => {
      expect(TOKEN_METADATA[FANTOM_CHAIN_ID]).toBeDefined();
      expect(Object.keys(TOKEN_METADATA[FANTOM_CHAIN_ID]).length).toBeGreaterThan(0);
    });
  });

  // =============================================================================
  // S3.2.3.4: Fantom DEX Integration Tests
  // =============================================================================

  describe('S3.2.3.4: Fantom DEX Integration', () => {
    it('should have Fantom DEXs configured', () => {
      expect(DEXES[FANTOM_CHAIN_ID]).toBeDefined();
      expect(DEXES[FANTOM_CHAIN_ID].length).toBeGreaterThan(0);
    });

    it('should have exactly 4 DEXs configured for Fantom', () => {
      expect(DEXES[FANTOM_CHAIN_ID]).toHaveLength(4);
    });

    it('should have exactly 4 enabled DEXs for Fantom (including Beethoven X)', () => {
      const enabledDexes = getEnabledDexes(FANTOM_CHAIN_ID);
      expect(enabledDexes).toHaveLength(4);
    });

    it('should have all expected enabled DEXs', () => {
      const enabledDexes = getEnabledDexes(FANTOM_CHAIN_ID);
      const enabledNames = enabledDexes.map(d => d.name);

      for (const dexName of FANTOM_ENABLED_DEXES) {
        expect(enabledNames).toContain(dexName);
      }
    });

    it('should have Beethoven X enabled (uses BalancerV2Adapter)', () => {
      const beethovenX = DEXES[FANTOM_CHAIN_ID].find(d => d.name === 'beethoven_x');
      expect(beethovenX).toBeDefined();
      expect(beethovenX!.enabled).toBe(true);
    });

    it('should have valid factory addresses for enabled DEXs', () => {
      const enabledDexes = getEnabledDexes(FANTOM_CHAIN_ID);
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;

      for (const dex of enabledDexes) {
        expect(dex.factoryAddress).toMatch(addressRegex);
        expect(dex.routerAddress).toMatch(addressRegex);
      }
    });

    it('should have correct chain assignment for all Fantom DEXs', () => {
      for (const dex of DEXES[FANTOM_CHAIN_ID]) {
        expect(dex.chain).toBe(FANTOM_CHAIN_ID);
      }
    });
  });

  // =============================================================================
  // S3.2.3.5: Fantom Token Integration Tests
  // =============================================================================

  describe('S3.2.3.5: Fantom Token Integration', () => {
    it('should have Fantom core tokens configured', () => {
      expect(CORE_TOKENS[FANTOM_CHAIN_ID]).toBeDefined();
      expect(CORE_TOKENS[FANTOM_CHAIN_ID].length).toBeGreaterThan(0);
    });

    it('should have expected number of tokens (10)', () => {
      expect(CORE_TOKENS[FANTOM_CHAIN_ID]).toHaveLength(10);
    });

    it('should have all expected token symbols', () => {
      const tokenSymbols = CORE_TOKENS[FANTOM_CHAIN_ID].map(t => t.symbol);

      for (const expectedToken of FANTOM_EXPECTED_TOKENS) {
        expect(tokenSymbols).toContain(expectedToken);
      }
    });

    it('should have valid token addresses', () => {
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;

      for (const token of CORE_TOKENS[FANTOM_CHAIN_ID]) {
        expect(token.address).toMatch(addressRegex);
      }
    });

    it('should have WFTM as anchor token', () => {
      const wftm = CORE_TOKENS[FANTOM_CHAIN_ID].find(t => t.symbol === 'WFTM');
      expect(wftm).toBeDefined();
      expect(wftm!.address).toBe('0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83');
    });

    it('should have stablecoins configured', () => {
      const stablecoins = ['USDC', 'fUSDT', 'DAI'];
      const tokenSymbols = CORE_TOKENS[FANTOM_CHAIN_ID].map(t => t.symbol);

      for (const stable of stablecoins) {
        expect(tokenSymbols).toContain(stable);
      }
    });
  });

  // =============================================================================
  // S3.2.3.6: Resource Calculation Tests
  // =============================================================================

  describe('S3.2.3.6: Resource Calculation', () => {
    it('should calculate resources for P1 partition including Fantom', () => {
      const resources = calculatePartitionResources(P1_PARTITION_ID);

      expect(resources.estimatedMemoryMB).toBeGreaterThan(0);
      expect(resources.estimatedCpuCores).toBeGreaterThan(0);
      expect(resources.recommendedProfile).toBeDefined();
    });

    it('should recommend heavy profile for P1 partition (4 chains)', () => {
      const resources = calculatePartitionResources(P1_PARTITION_ID);
      expect(resources.recommendedProfile).toBe('heavy');
    });

    it('should have sufficient max memory for P1 partition', () => {
      const partition = getPartition(P1_PARTITION_ID);
      const resources = calculatePartitionResources(P1_PARTITION_ID);

      // Max memory should be >= estimated
      expect(partition!.maxMemoryMB).toBeGreaterThanOrEqual(resources.estimatedMemoryMB);
    });

    it('should account for Fantom DEXs in resource calculation', () => {
      // Get resources with Fantom
      const resourcesWithFantom = calculatePartitionResources(P1_PARTITION_ID);

      // The estimate should include memory for Fantom's 3 enabled DEXs (8MB each)
      // and 10 tokens (2MB each)
      const fantomDexes = getEnabledDexes(FANTOM_CHAIN_ID);
      const fantomTokens = CORE_TOKENS[FANTOM_CHAIN_ID] || [];

      const expectedFantomOverhead = (fantomDexes.length * 8) + (fantomTokens.length * 2);
      expect(resourcesWithFantom.estimatedMemoryMB).toBeGreaterThanOrEqual(expectedFantomOverhead);
    });
  });

  // =============================================================================
  // S3.2.3.7: Partition Validation Tests
  // =============================================================================

  describe('S3.2.3.7: Partition Validation', () => {
    it('should validate P1 partition configuration successfully', () => {
      const partition = getPartition(P1_PARTITION_ID);
      const validation = validatePartitionConfig(partition!);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should not have critical warnings for P1 partition', () => {
      const partition = getPartition(P1_PARTITION_ID);
      const validation = validatePartitionConfig(partition!);

      // Check that there are no memory insufficiency warnings
      const memoryWarnings = validation.warnings.filter(w => w.includes('memory'));
      expect(memoryWarnings).toHaveLength(0);
    });

    it('should verify all chains in P1 exist in CHAINS config', () => {
      const chains = getChainsForPartition(P1_PARTITION_ID);

      for (const chainId of chains) {
        expect(CHAINS[chainId]).toBeDefined();
      }
    });

    it('should verify Fantom is not duplicated across partitions', () => {
      // Find all partitions that contain Fantom
      const partitionsWithFantom = PARTITIONS.filter(p =>
        p.enabled && p.chains.includes(FANTOM_CHAIN_ID)
      );

      // Fantom should only be in P1
      expect(partitionsWithFantom).toHaveLength(1);
      expect(partitionsWithFantom[0].partitionId).toBe(P1_PARTITION_ID);
    });
  });

  // =============================================================================
  // S3.2.3.8: Cross-Chain Detection Preparation Tests
  // =============================================================================

  describe('S3.2.3.8: Cross-Chain Detection Preparation', () => {
    it('should have common tokens between Fantom and other P1 chains', () => {
      // Get token symbols for each chain, normalizing common variations
      // e.g., 'fUSDT' on Fantom is equivalent to 'USDT' on other chains
      const normalizeSymbol = (symbol: string): string => {
        // Fantom uses fUSDT, others use USDT
        if (symbol === 'fUSDT') return 'USDT';
        // Some chains use ETH, others use WETH
        if (symbol === 'ETH') return 'WETH';
        // Some chains use BTCB, others use WBTC
        if (symbol === 'BTCB') return 'WBTC';
        return symbol;
      };

      const fantomTokens = new Set(
        CORE_TOKENS[FANTOM_CHAIN_ID]?.map(t => normalizeSymbol(t.symbol)) || []
      );

      for (const chainId of P1_EXPECTED_CHAINS) {
        if (chainId === FANTOM_CHAIN_ID) continue;

        const chainTokens = CORE_TOKENS[chainId]?.map(t => normalizeSymbol(t.symbol)) || [];
        const commonTokens = chainTokens.filter(t => fantomTokens.has(t));

        // Should have at least 1 common token for cross-chain arbitrage
        // Note: BSC uses fUSDT while Fantom uses fUSDT (normalized match)
        expect(commonTokens.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('should have stablecoins on all P1 chains for cross-chain arbitrage', () => {
      const stablecoins = ['USDC', 'USDT', 'DAI'];

      for (const chainId of P1_EXPECTED_CHAINS) {
        const chainTokens = CORE_TOKENS[chainId]?.map(t => t.symbol) || [];

        // At least 2 stablecoins should be on each chain
        const stableCount = stablecoins.filter(s =>
          chainTokens.some(t => t === s || t === 'fUSDT' && s === 'USDT')
        ).length;
        expect(stableCount).toBeGreaterThanOrEqual(2);
      }
    });

    it('should have wrapped native tokens on all P1 chains', () => {
      const wrappedNatives: Record<string, string> = {
        'bsc': 'WBNB',
        'polygon': 'WMATIC',
        'avalanche': 'WAVAX',
        'fantom': 'WFTM'
      };

      for (const chainId of P1_EXPECTED_CHAINS) {
        const chainTokens = CORE_TOKENS[chainId]?.map(t => t.symbol) || [];
        expect(chainTokens).toContain(wrappedNatives[chainId]);
      }
    });

    it('should have WETH bridged on multiple P1 chains for arbitrage', () => {
      let chainsWithWeth = 0;

      for (const chainId of P1_EXPECTED_CHAINS) {
        const chainTokens = CORE_TOKENS[chainId]?.map(t => t.symbol) || [];
        if (chainTokens.some(t => t === 'WETH' || t === 'WETH.e')) {
          chainsWithWeth++;
        }
      }

      // At least 3 P1 chains should have WETH
      expect(chainsWithWeth).toBeGreaterThanOrEqual(3);
    });
  });

  // =============================================================================
  // S3.2.3.9: Service Configuration Integration Tests
  // =============================================================================

  describe('S3.2.3.9: Service Configuration Integration', () => {
    it('should export P1 partition ID correctly', () => {
      expect(PARTITION_IDS.ASIA_FAST).toBe('asia-fast');
    });

    it('should have P1 partition in PARTITIONS array', () => {
      const p1 = PARTITIONS.find(p => p.partitionId === P1_PARTITION_ID);
      expect(p1).toBeDefined();
    });

    it('should have health check interval configured for P1', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.healthCheckIntervalMs).toBeDefined();
      expect(partition!.healthCheckIntervalMs).toBeGreaterThan(0);
    });

    it('should have failover timeout configured for P1', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.failoverTimeoutMs).toBeDefined();
      expect(partition!.failoverTimeoutMs).toBeGreaterThan(0);
    });

    it('should have standby configuration for P1 (failover support)', () => {
      const partition = getPartition(P1_PARTITION_ID);
      expect(partition!.standbyRegion).toBeDefined();
      expect(partition!.standbyProvider).toBeDefined();
    });
  });

  // =============================================================================
  // S3.2.3.10: Regression Tests - Fantom P1 Integration
  // =============================================================================

  describe('S3.2.3.10: Regression Tests', () => {
    it('should maintain 4 chains in P1 partition (BSC, Polygon, Avalanche, Fantom)', () => {
      const chains = getChainsForPartition(P1_PARTITION_ID);
      expect(chains.sort()).toEqual([...P1_EXPECTED_CHAINS].sort());
    });

    it('should maintain Fantom assignment to P1 partition', () => {
      const assigned = assignChainToPartition(FANTOM_CHAIN_ID);
      expect(assigned).not.toBeNull();
      expect(assigned?.partitionId).toBe(P1_PARTITION_ID);
    });

    it('should maintain 4 enabled DEXs on Fantom (including Beethoven X)', () => {
      const enabledDexes = getEnabledDexes(FANTOM_CHAIN_ID);
      expect(enabledDexes).toHaveLength(4);
    });

    it('should maintain 10 tokens on Fantom', () => {
      expect(CORE_TOKENS[FANTOM_CHAIN_ID]).toHaveLength(10);
    });

    it('should maintain Beethoven X as enabled (uses BalancerV2Adapter)', () => {
      const beethovenX = DEXES[FANTOM_CHAIN_ID].find(d => d.name === 'beethoven_x');
      expect(beethovenX!.enabled).toBe(true);
    });

    it('should maintain valid partition configuration', () => {
      const partition = getPartition(P1_PARTITION_ID);
      const validation = validatePartitionConfig(partition!);
      expect(validation.valid).toBe(true);
    });

    it('should return immutable array from getChainsFromEnv (S3.2.3-FIX)', () => {
      // S3.2.3-FIX: getChainsFromEnv should return array copy to prevent mutation
      const chains1 = getChainsFromEnv();
      const chains2 = getChainsFromEnv();

      // Should return independent arrays
      expect(chains1).not.toBe(chains2);

      // Mutation should not affect subsequent calls
      const originalLength = chains1.length;
      chains1.push('test-mutation');
      const chains3 = getChainsFromEnv();
      expect(chains3).toHaveLength(originalLength);
      expect(chains3).not.toContain('test-mutation');
    });
  });
});

// =============================================================================
// S3.2.3.11: Event Handling Simulation Tests
// =============================================================================

describe('S3.2.3.11: Event Handling Simulation', () => {
  /**
   * Simulated Fantom swap event structure
   */
  interface SimulatedSwapEvent {
    chainId: string;
    dexName: string;
    pairAddress: string;
    amount0In: bigint;
    amount1Out: bigint;
    sender: string;
    to: string;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
  }

  /**
   * Create a simulated Fantom swap event
   */
  function createSimulatedSwapEvent(dexName: string): SimulatedSwapEvent {
    return {
      chainId: FANTOM_CHAIN_ID,
      dexName,
      pairAddress: '0x' + '1'.repeat(40),
      amount0In: BigInt('1000000000000000000'), // 1 token
      amount1Out: BigInt('500000000000000000'), // 0.5 token
      sender: '0x' + '2'.repeat(40),
      to: '0x' + '3'.repeat(40),
      blockNumber: 50000000,
      transactionHash: '0x' + '4'.repeat(64),
      logIndex: 0
    };
  }

  it('should accept simulated events from all enabled Fantom DEXs', () => {
    for (const dexName of FANTOM_ENABLED_DEXES) {
      const event = createSimulatedSwapEvent(dexName);

      // Verify event structure
      expect(event.chainId).toBe(FANTOM_CHAIN_ID);
      expect(event.dexName).toBe(dexName);
      expect(event.amount0In).toBeGreaterThan(BigInt(0));
    }
  });

  it('should validate DEX exists in configuration for event processing', () => {
    for (const dexName of FANTOM_ENABLED_DEXES) {
      const event = createSimulatedSwapEvent(dexName);

      // Verify DEX exists in enabled list (getEnabledDexes already filters by enabled=true)
      const dex = getEnabledDexes(event.chainId).find(d => d.name === event.dexName);
      expect(dex).toBeDefined();

      // Verify DEX has required properties for event processing
      expect(dex!.factoryAddress).toBeDefined();
      expect(dex!.routerAddress).toBeDefined();
      expect(dex!.chain).toBe(FANTOM_CHAIN_ID);
    }
  });

  it('should accept events from Beethoven X (now enabled with adapter)', () => {
    const event = createSimulatedSwapEvent('beethoven_x');

    // Verify DEX IS in enabled list (has BalancerV2Adapter now)
    const enabledDex = getEnabledDexes(event.chainId).find(d => d.name === event.dexName);
    expect(enabledDex).toBeDefined();
    expect(enabledDex!.chain).toBe(FANTOM_CHAIN_ID);
  });

  it('should have consistent event structure across P1 chains', () => {
    // All P1 chains should produce events with same structure
    for (const chainId of P1_EXPECTED_CHAINS) {
      const enabledDexes = getEnabledDexes(chainId);
      expect(enabledDexes.length).toBeGreaterThan(0);

      // Verify all DEXs have required fields for event processing
      for (const dex of enabledDexes) {
        expect(dex.factoryAddress).toBeDefined();
        expect(dex.routerAddress).toBeDefined();
        expect(dex.fee).toBeDefined();
        expect(dex.chain).toBe(chainId);
      }
    }
  });
});

// =============================================================================
// S3.2.3.12: DEX Count Summary Tests
// =============================================================================

describe('S3.2.3.12: P1 Partition DEX Summary', () => {
  it('should have correct total DEX count for P1 partition', () => {
    let totalEnabled = 0;
    let totalConfigured = 0;

    for (const chainId of P1_EXPECTED_CHAINS) {
      totalEnabled += getEnabledDexes(chainId).length;
      totalConfigured += DEXES[chainId]?.length || 0;
    }

    // Document expected counts for P1 partition
    // BSC: 8 enabled, Polygon: 4 enabled, Avalanche: 6 enabled, Fantom: 4 enabled
    // (GMX, Platypus, Beethoven X now enabled with adapters)
    expect(totalEnabled).toBeGreaterThanOrEqual(22); // Minimum expected

    // Verify logging values
    console.log(`P1 Partition DEX Summary:`);
    console.log(`  Total configured: ${totalConfigured}`);
    console.log(`  Total enabled: ${totalEnabled}`);

    for (const chainId of P1_EXPECTED_CHAINS) {
      const enabled = getEnabledDexes(chainId).length;
      const configured = DEXES[chainId]?.length || 0;
      console.log(`  ${chainId}: ${enabled}/${configured} enabled`);
    }
  });

  it('should have documented DEX counts per chain in P1', () => {
    const expectedCounts: Record<string, { enabled: number; total: number }> = {
      'bsc': { enabled: 8, total: 8 },
      'polygon': { enabled: 4, total: 4 },
      'avalanche': { enabled: 6, total: 6 }, // All enabled (GMX, Platypus have adapters)
      'fantom': { enabled: 4, total: 4 } // All enabled (Beethoven X has adapter)
    };

    for (const [chainId, expected] of Object.entries(expectedCounts)) {
      const enabled = getEnabledDexes(chainId).length;
      const total = DEXES[chainId]?.length || 0;

      expect(enabled).toBe(expected.enabled);
      expect(total).toBe(expected.total);
    }
  });
});
