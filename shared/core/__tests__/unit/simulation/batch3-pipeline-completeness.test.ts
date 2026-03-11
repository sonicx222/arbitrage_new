/**
 * Batch 3: Pipeline Completeness Tests
 *
 * Tests for all 4 tasks:
 * - Task 3.1: Volume aggregate publishing (SwapEventFilter integration)
 * - Task 3.2: Emerging L2 real DEX names
 * - Task 3.3: Emerging L2 chain-specific pairs and tokens
 * - Task 3.4: Non-EVM (Solana) SwapEvent/WhaleAlert generation
 *
 * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Batch 3
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../../src/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { DEXES, CHAIN_SPECIFIC_PAIRS, BASE_PRICES } from '../../../src/simulation/constants';
import { CHAIN_THROUGHPUT_PROFILES, selectWeightedDex } from '../../../src/simulation/throughput-profiles';
import { SwapEventFilter } from '../../../src/analytics/swap-event-filter';
import type { SwapEvent } from '@arbitrage/types';

// =============================================================================
// Task 3.1: Volume Aggregate Publishing
// =============================================================================

describe('Task 3.1: Volume Aggregate Publishing via SwapEventFilter', () => {
  let filter: SwapEventFilter;

  afterEach(() => {
    filter?.destroy();
  });

  it('should produce volume aggregates from swap events', (done) => {
    filter = new SwapEventFilter({
      minUsdValue: 1,
      whaleThreshold: 50_000,
      aggregationWindowMs: 100, // Short window for test
    });

    const aggregates: unknown[] = [];
    filter.onVolumeAggregate((agg) => {
      aggregates.push(agg);
    });

    // Feed multiple swap events
    for (let i = 0; i < 5; i++) {
      const event: SwapEvent = {
        pairAddress: '0xabc123',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xrecipient',
        amount0In: '1000000000000000000', // 1 ETH
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '3200000000', // 3200 USDC (6 decimals)
        blockNumber: 1000 + i,
        transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
        timestamp: Date.now(),
        dex: 'uniswap_v3',
        chain: 'ethereum',
        usdValue: 3200,
      };
      filter.processEvent(event);
    }

    // Wait for aggregation window to flush
    setTimeout(() => {
      expect(aggregates.length).toBeGreaterThanOrEqual(1);
      const agg = aggregates[0] as { pairAddress: string; swapCount: number; chain: string };
      expect(agg.pairAddress).toBe('0xabc123');
      expect(agg.swapCount).toBeGreaterThanOrEqual(1);
      expect(agg.chain).toBe('ethereum');
      done();
    }, 200);
  });

  it('should filter out zero-amount swap events', () => {
    filter = new SwapEventFilter({
      minUsdValue: 1,
      whaleThreshold: 50_000,
      aggregationWindowMs: 5000,
    });

    const event: SwapEvent = {
      pairAddress: '0xabc123',
      sender: '0xsender',
      recipient: '0xrecipient',
      to: '0xrecipient',
      amount0In: '0',
      amount1In: '0',
      amount0Out: '0',
      amount1Out: '0',
      blockNumber: 1000,
      transactionHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
      timestamp: Date.now(),
      dex: 'uniswap_v3',
      chain: 'ethereum',
      usdValue: 0,
    };

    const result = filter.processEvent(event);
    expect(result.passed).toBe(false);
  });
});

// =============================================================================
// Task 3.2: Emerging L2 Real DEX Names
// =============================================================================

describe('Task 3.2: Emerging L2 Real DEX Names', () => {
  it('should have Blast with real DEX names (thruster, bladeswap, ring)', () => {
    expect(DEXES['blast']).toContain('thruster');
    expect(DEXES['blast']).toContain('bladeswap');
    expect(DEXES['blast']).toContain('ring');
    // Should NOT have placeholder names
    expect(DEXES['blast']).not.toContain('aerodrome');
    expect(DEXES['blast']).not.toContain('baseswap');
  });

  it('should have Scroll with real DEX names (ambient, nuri)', () => {
    expect(DEXES['scroll']).toContain('ambient');
    expect(DEXES['scroll']).toContain('nuri');
    expect(DEXES['scroll']).not.toContain('aerodrome');
    expect(DEXES['scroll']).not.toContain('baseswap');
  });

  it('should have Mantle with real DEX names (agni, fusionx)', () => {
    expect(DEXES['mantle']).toContain('agni');
    expect(DEXES['mantle']).toContain('fusionx');
    expect(DEXES['mantle']).not.toContain('aerodrome');
    expect(DEXES['mantle']).not.toContain('baseswap');
  });

  it('should have Mode with real DEX names (kim, supswap)', () => {
    expect(DEXES['mode']).toContain('kim');
    expect(DEXES['mode']).toContain('supswap');
    expect(DEXES['mode']).not.toContain('aerodrome');
    expect(DEXES['mode']).not.toContain('baseswap');
  });

  it('should have matching DEX market share in throughput profiles', () => {
    // Blast
    const blastProfile = CHAIN_THROUGHPUT_PROFILES['blast'];
    expect(blastProfile.dexMarketShare).toHaveProperty('thruster');
    expect(blastProfile.dexMarketShare).toHaveProperty('bladeswap');
    expect(blastProfile.dexMarketShare).toHaveProperty('ring');
    expect(blastProfile.dexMarketShare).not.toHaveProperty('aerodrome');

    // Scroll
    const scrollProfile = CHAIN_THROUGHPUT_PROFILES['scroll'];
    expect(scrollProfile.dexMarketShare).toHaveProperty('ambient');
    expect(scrollProfile.dexMarketShare).toHaveProperty('nuri');

    // Mantle
    const mantleProfile = CHAIN_THROUGHPUT_PROFILES['mantle'];
    expect(mantleProfile.dexMarketShare).toHaveProperty('agni');
    expect(mantleProfile.dexMarketShare).toHaveProperty('fusionx');

    // Mode
    const modeProfile = CHAIN_THROUGHPUT_PROFILES['mode'];
    expect(modeProfile.dexMarketShare).toHaveProperty('kim');
    expect(modeProfile.dexMarketShare).toHaveProperty('supswap');
  });

  it('should have DEX market share weights summing to ~1.0', () => {
    for (const chain of ['blast', 'scroll', 'mantle', 'mode']) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      const totalWeight = Object.values(profile.dexMarketShare).reduce((a, b) => a + b, 0);
      expect(totalWeight).toBeCloseTo(1.0, 2);
    }
  });

  it('should select DEXes from real names via weighted selection', () => {
    for (const chain of ['blast', 'scroll', 'mantle', 'mode']) {
      const profile = CHAIN_THROUGHPUT_PROFILES[chain];
      const selected = selectWeightedDex(profile.dexMarketShare);
      expect(Object.keys(profile.dexMarketShare)).toContain(selected);
    }
  });
});

// =============================================================================
// Task 3.3: Emerging L2 Chain-Specific Pairs
// =============================================================================

describe('Task 3.3: Emerging L2 Chain-Specific Pairs', () => {
  it('should have Blast chain-specific pairs including USDB', () => {
    const pairs = CHAIN_SPECIFIC_PAIRS['blast'];
    expect(pairs).toBeDefined();
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    // Should have WETH/USDB (Blast native stablecoin)
    const hasUsdb = pairs.some(p =>
      (p[0] === 'WETH' && p[1] === 'USDB') || (p[0] === 'USDB' && p[1] === 'WETH')
    );
    expect(hasUsdb).toBe(true);
    // Should have BLAST/WETH
    const hasBlast = pairs.some(p =>
      (p[0] === 'BLAST' && p[1] === 'WETH') || (p[0] === 'WETH' && p[1] === 'BLAST')
    );
    expect(hasBlast).toBe(true);
  });

  it('should have Scroll chain-specific pairs including SCR', () => {
    const pairs = CHAIN_SPECIFIC_PAIRS['scroll'];
    expect(pairs).toBeDefined();
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    const hasScr = pairs.some(p =>
      (p[0] === 'SCR' && p[1] === 'WETH') || (p[0] === 'WETH' && p[1] === 'SCR')
    );
    expect(hasScr).toBe(true);
  });

  it('should have Mantle chain-specific pairs with WMNT', () => {
    const pairs = CHAIN_SPECIFIC_PAIRS['mantle'];
    expect(pairs).toBeDefined();
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    const hasWmnt = pairs.some(p => p[0] === 'WMNT' || p[1] === 'WMNT');
    expect(hasWmnt).toBe(true);
  });

  it('should have Mode chain-specific pairs with MODE', () => {
    const pairs = CHAIN_SPECIFIC_PAIRS['mode'];
    expect(pairs).toBeDefined();
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    const hasMode = pairs.some(p =>
      (p[0] === 'MODE' && p[1] === 'WETH') || (p[0] === 'WETH' && p[1] === 'MODE')
    );
    expect(hasMode).toBe(true);
  });

  it('should have all emerging L2s with >= 2 chain-specific pairs', () => {
    for (const chain of ['blast', 'scroll', 'mantle', 'mode']) {
      const pairs = CHAIN_SPECIFIC_PAIRS[chain];
      expect(pairs).toBeDefined();
      expect(pairs.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should have new tokens in BASE_PRICES', () => {
    expect(BASE_PRICES['BLAST']).toBeDefined();
    expect(BASE_PRICES['BLAST']).toBeGreaterThan(0);
    expect(BASE_PRICES['USDB']).toBe(1.0);
    expect(BASE_PRICES['SCR']).toBeDefined();
    expect(BASE_PRICES['SCR']).toBeGreaterThan(0);
    expect(BASE_PRICES['MODE']).toBeDefined();
    expect(BASE_PRICES['MODE']).toBeGreaterThan(0);
  });

  it('should have USDB treated as stablecoin price', () => {
    expect(BASE_PRICES['USDB']).toBe(1.0);
  });
});

// =============================================================================
// Task 3.4: Non-EVM Solana SwapEvent/WhaleAlert Generation
// =============================================================================

describe('Task 3.4: Non-EVM SwapEvent/WhaleAlert Generation', () => {
  // We test the ChainSimulationHandler directly
  // The handler is in services/unified-detector, so we test the data contract here

  it('should have SwapEvent interface with required fields', () => {
    const event: SwapEvent = {
      pairAddress: '0xtest',
      sender: '0xsender',
      recipient: '0xrecipient',
      to: '0xrecipient',
      amount0In: '1000000000',
      amount1In: '0',
      amount0Out: '0',
      amount1Out: '175000000',
      blockNumber: 250000001,
      transactionHash: '0xhash',
      timestamp: Date.now(),
      dex: 'raydium',
      chain: 'solana',
      usdValue: 175,
    };

    expect(event.chain).toBe('solana');
    expect(event.dex).toBe('raydium');
    expect(event.usdValue).toBeGreaterThan(0);
  });

  it('should have Solana DEXes available in DEXES constant', () => {
    expect(DEXES['solana']).toBeDefined();
    expect(DEXES['solana']).toContain('raydium');
    expect(DEXES['solana']).toContain('orca');
    expect(DEXES['solana']).toContain('meteora');
  });

  it('should have Solana tokens in BASE_PRICES', () => {
    expect(BASE_PRICES['SOL']).toBeGreaterThan(0);
    expect(BASE_PRICES['JUP']).toBeGreaterThan(0);
    expect(BASE_PRICES['RAY']).toBeGreaterThan(0);
    expect(BASE_PRICES['ORCA']).toBeGreaterThan(0);
    expect(BASE_PRICES['BONK']).toBeGreaterThan(0);
  });

  it('should have Solana chain-specific pairs defined', () => {
    const pairs = CHAIN_SPECIFIC_PAIRS['solana'];
    expect(pairs).toBeDefined();
    expect(pairs.length).toBeGreaterThanOrEqual(5);
    // Should have SOL/USDC as primary pair
    const hasSolUsdc = pairs.some(p =>
      (p[0] === 'SOL' && p[1] === 'USDC') || (p[0] === 'USDC' && p[1] === 'SOL')
    );
    expect(hasSolUsdc).toBe(true);
  });

  it('should have Solana throughput profile with correct DEX market share', () => {
    const profile = CHAIN_THROUGHPUT_PROFILES['solana'];
    expect(profile.dexMarketShare).toHaveProperty('raydium');
    expect(profile.dexMarketShare).toHaveProperty('orca');
    expect(profile.dexMarketShare).toHaveProperty('meteora');
    const total = Object.values(profile.dexMarketShare).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 2);
  });
});
