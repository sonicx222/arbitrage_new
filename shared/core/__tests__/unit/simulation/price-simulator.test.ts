/**
 * PriceSimulator Unit Tests
 *
 * Tests for the simulation price feed generator with fake timers
 * to control setInterval-based price update cycles.
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

import {
  PriceSimulator,
  getSimulator,
  resetSimulatorInstance,
} from '../../../src/simulation/price-simulator';
import { DEXES, getTokenPrice } from '../../../src/simulation/constants';
import type { SimulatedPriceUpdate } from '../../../src/simulation/types';

// Minimal config for fast, deterministic tests
const TEST_CONFIG = {
  chains: ['bsc', 'ethereum'],
  pairs: [['WETH', 'USDC'] as string[]],
  dexesPerChain: 2,
  updateIntervalMs: 500,
  volatility: 0.02,
  arbitrageChance: 0,
  arbitrageSpread: 0.005,
};

describe('PriceSimulator', () => {
  let simulator: PriceSimulator;

  beforeEach(() => {
    jest.useFakeTimers();
    simulator = new PriceSimulator(TEST_CONFIG);
  });

  afterEach(() => {
    simulator.stop();
    resetSimulatorInstance();
    jest.useRealTimers();
  });

  // ===========================================================================
  // Constructor & Initialization
  // ===========================================================================

  describe('Constructor & Initialization', () => {
    it('should initialize prices for all chain/dex/pair combinations', () => {
      const allPrices = simulator.getAllPrices();

      // 2 chains x 2 dexes x 1 pair = 4 entries
      // bsc dexes (sliced to 2): pancakeswap_v3, pancakeswap_v2
      // ethereum dexes (sliced to 2): uniswap_v3, sushiswap
      expect(allPrices.size).toBe(4);

      const bscDexes = DEXES['bsc'].slice(0, TEST_CONFIG.dexesPerChain);
      const ethDexes = DEXES['ethereum'].slice(0, TEST_CONFIG.dexesPerChain);

      for (const dex of bscDexes) {
        const key = `bsc:${dex}:WETH/USDC`;
        expect(allPrices.has(key)).toBe(true);
        expect(allPrices.get(key)).toBeGreaterThan(0);
      }

      for (const dex of ethDexes) {
        const key = `ethereum:${dex}:WETH/USDC`;
        expect(allPrices.has(key)).toBe(true);
        expect(allPrices.get(key)).toBeGreaterThan(0);
      }
    });

    it('should apply small random variation per DEX (prices not exactly equal)', () => {
      // With random variation, it is statistically near-impossible for all 4
      // prices to be exactly the same floating-point number.
      const prices = [...simulator.getAllPrices().values()];
      const unique = new Set(prices);
      // At least 2 distinct values (overwhelmingly likely with 4 random variations)
      expect(unique.size).toBeGreaterThanOrEqual(2);
    });

    it('should initialize block numbers per chain', () => {
      // Start the simulator to verify block numbers are used
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();

      // Initial emission happens synchronously inside start()
      expect(handler).toHaveBeenCalled();
      const firstUpdate = handler.mock.calls[0][0] as SimulatedPriceUpdate;
      expect(firstUpdate.blockNumber).toBeGreaterThan(0);
    });

    it('should use default config values when no config provided', () => {
      const defaultSim = new PriceSimulator();
      const allPrices = defaultSim.getAllPrices();
      // DEFAULT_CONFIG has 11 chains, 13 pairs, 2 dexesPerChain
      // Total = 11 * 2 * 13 = 286
      expect(allPrices.size).toBe(286);
      defaultSim.stop();
    });
  });

  // ===========================================================================
  // start / stop lifecycle
  // ===========================================================================

  describe('start / stop lifecycle', () => {
    it('should set isRunning to true on start', () => {
      expect(simulator.isRunning()).toBe(false);
      simulator.start();
      expect(simulator.isRunning()).toBe(true);
    });

    it('should set isRunning to false on stop', () => {
      simulator.start();
      expect(simulator.isRunning()).toBe(true);
      simulator.stop();
      expect(simulator.isRunning()).toBe(false);
    });

    it('should not start twice (guard against double-start)', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);

      simulator.start();
      const countAfterFirstStart = handler.mock.calls.length;

      // Reset call count and start again
      handler.mockClear();
      simulator.start(); // should be a no-op

      // No additional initial emission on second start
      expect(handler).not.toHaveBeenCalled();
      expect(simulator.isRunning()).toBe(true);

      // Advance timers — should only fire one set of intervals (not doubled)
      handler.mockClear();
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs);

      // 2 chains * 2 dexes * 1 pair = 4 updates per interval tick
      expect(handler.mock.calls.length).toBe(4);
    });

    it('should emit initial prices on start', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);

      simulator.start();

      // emitAllPrices fires synchronously: 2 chains * 2 dexes * 1 pair = 4
      expect(handler.mock.calls.length).toBe(4);
    });

    it('should emit priceUpdate events at intervals', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();

      const initialCount = handler.mock.calls.length; // 4 from emitAllPrices

      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs);
      // Each chain fires: 2 dexes * 1 pair = 2 updates per chain, 2 chains = 4
      expect(handler.mock.calls.length).toBe(initialCount + 4);

      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs);
      expect(handler.mock.calls.length).toBe(initialCount + 8);
    });

    it('should stop emitting after stop() is called', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();

      const countAfterStart = handler.mock.calls.length;

      simulator.stop();
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs * 5);

      // No further events after stop
      expect(handler.mock.calls.length).toBe(countAfterStart);
    });
  });

  // ===========================================================================
  // Price updates
  // ===========================================================================

  describe('Price updates', () => {
    it('should emit priceUpdate events with correct structure (all fields present)', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();

      expect(handler).toHaveBeenCalled();
      const update = handler.mock.calls[0][0] as SimulatedPriceUpdate;

      // Verify all fields of SimulatedPriceUpdate
      expect(update).toHaveProperty('chain');
      expect(update).toHaveProperty('dex');
      expect(update).toHaveProperty('pairKey');
      expect(update).toHaveProperty('token0');
      expect(update).toHaveProperty('token1');
      expect(update).toHaveProperty('price');
      expect(update).toHaveProperty('price0');
      expect(update).toHaveProperty('price1');
      expect(update).toHaveProperty('liquidity');
      expect(update).toHaveProperty('volume24h');
      expect(update).toHaveProperty('timestamp');
      expect(update).toHaveProperty('blockNumber');
      expect(update).toHaveProperty('isSimulated');

      // Type checks
      expect(typeof update.chain).toBe('string');
      expect(typeof update.dex).toBe('string');
      expect(typeof update.pairKey).toBe('string');
      expect(typeof update.token0).toBe('string');
      expect(typeof update.token1).toBe('string');
      expect(typeof update.price).toBe('number');
      expect(typeof update.price0).toBe('number');
      expect(typeof update.price1).toBe('number');
      expect(typeof update.liquidity).toBe('number');
      expect(typeof update.volume24h).toBe('number');
      expect(typeof update.timestamp).toBe('number');
      expect(typeof update.blockNumber).toBe('number');
      expect(update.isSimulated).toBe(true);

      // Verify pairKey format: `${dex}_${token0}_${token1}`
      expect(update.pairKey).toBe(`${update.dex}_${update.token0}_${update.token1}`);

      // Verify reasonable ranges
      expect(update.liquidity).toBeGreaterThan(0);
      expect(update.volume24h).toBeGreaterThan(0);
      expect(update.price).toBeGreaterThan(0);
    });

    it('should update prices over time (prices change between intervals)', () => {
      simulator.start();

      // Capture prices before interval tick
      const pricesBefore = new Map(simulator.getAllPrices());

      // Advance past several intervals for high probability of change
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs * 10);

      const pricesAfter = simulator.getAllPrices();

      // With volatility = 0.02, after 10 updates it is virtually certain
      // that at least one price will have changed
      let anyChanged = false;
      for (const [key, priceBefore] of pricesBefore) {
        const priceAfter = pricesAfter.get(key);
        if (priceAfter !== priceBefore) {
          anyChanged = true;
          break;
        }
      }
      expect(anyChanged).toBe(true);
    });

    it('should increment block numbers on each update', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();

      // Get initial block number from first emission for a specific chain
      const initialUpdates = handler.mock.calls
        .map(call => call[0] as SimulatedPriceUpdate)
        .filter(u => u.chain === 'bsc');
      const initialBlock = initialUpdates[0].blockNumber;

      handler.mockClear();
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs);

      const afterFirstTick = handler.mock.calls
        .map(call => call[0] as SimulatedPriceUpdate)
        .filter(u => u.chain === 'bsc');
      expect(afterFirstTick[0].blockNumber).toBe(initialBlock + 1);

      handler.mockClear();
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs);

      const afterSecondTick = handler.mock.calls
        .map(call => call[0] as SimulatedPriceUpdate)
        .filter(u => u.chain === 'bsc');
      expect(afterSecondTick[0].blockNumber).toBe(initialBlock + 2);
    });

    it('should set isSimulated = true on all updates', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs * 3);

      for (const call of handler.mock.calls) {
        const update = call[0] as SimulatedPriceUpdate;
        expect(update.isSimulated).toBe(true);
      }
    });

    it('should emit updates with correct token pair information', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();

      for (const call of handler.mock.calls) {
        const update = call[0] as SimulatedPriceUpdate;
        expect(update.token0).toBe('WETH');
        expect(update.token1).toBe('USDC');
      }
    });

    it('should produce price0 and price1 close to base token prices', () => {
      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      simulator.on('priceUpdate', handler);
      simulator.start();

      const update = handler.mock.calls[0][0] as SimulatedPriceUpdate;
      const basePrice0 = getTokenPrice('WETH'); // 3200
      const basePrice1 = getTokenPrice('USDC'); // 1.0

      // price0 and price1 should be within 0.1% of base (variation is 0.05%)
      expect(update.price0).toBeGreaterThan(basePrice0 * 0.999);
      expect(update.price0).toBeLessThan(basePrice0 * 1.001);
      expect(update.price1).toBeGreaterThan(basePrice1 * 0.999);
      expect(update.price1).toBeLessThan(basePrice1 * 1.001);
    });
  });

  // ===========================================================================
  // getPrice / getAllPrices
  // ===========================================================================

  describe('getPrice / getAllPrices', () => {
    it('should return price for valid chain/dex/pair', () => {
      const bscDex = DEXES['bsc'][0]; // pancakeswap_v3
      const price = simulator.getPrice('bsc', bscDex, 'WETH', 'USDC');
      expect(price).toBeDefined();
      expect(typeof price).toBe('number');
      expect(price!).toBeGreaterThan(0);
    });

    it('should return undefined for unknown combination', () => {
      expect(simulator.getPrice('nonexistent', 'dex', 'A', 'B')).toBeUndefined();
      expect(simulator.getPrice('bsc', 'nonexistent_dex', 'WETH', 'USDC')).toBeUndefined();
      expect(simulator.getPrice('bsc', DEXES['bsc'][0], 'FAKE', 'TOKEN')).toBeUndefined();
    });

    it('getAllPrices should return a copy (not same reference)', () => {
      const prices1 = simulator.getAllPrices();
      const prices2 = simulator.getAllPrices();

      // Different references
      expect(prices1).not.toBe(prices2);

      // Same content
      expect(prices1.size).toBe(prices2.size);
      for (const [key, value] of prices1) {
        expect(prices2.get(key)).toBe(value);
      }
    });

    it('should reflect updated prices after interval ticks', () => {
      simulator.start();

      const bscDex = DEXES['bsc'][0];
      const priceBefore = simulator.getPrice('bsc', bscDex, 'WETH', 'USDC');

      // Advance many intervals to ensure price changes
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs * 20);

      const priceAfter = simulator.getPrice('bsc', bscDex, 'WETH', 'USDC');

      expect(priceBefore).toBeDefined();
      expect(priceAfter).toBeDefined();
      // With 20 ticks and 2% volatility, price should differ
      expect(priceAfter).not.toBe(priceBefore);
    });
  });

  // ===========================================================================
  // Singleton
  // ===========================================================================

  describe('Singleton', () => {
    it('getSimulator should return same instance on repeated calls', () => {
      const instance1 = getSimulator(TEST_CONFIG);
      const instance2 = getSimulator(TEST_CONFIG);
      expect(instance1).toBe(instance2);
    });

    it('resetSimulatorInstance should stop and null out the singleton', () => {
      const instance = getSimulator(TEST_CONFIG);
      instance.start();
      expect(instance.isRunning()).toBe(true);

      resetSimulatorInstance();

      // The old instance should be stopped
      expect(instance.isRunning()).toBe(false);
    });

    it('getSimulator after reset should create new instance', () => {
      const instance1 = getSimulator(TEST_CONFIG);
      resetSimulatorInstance();
      const instance2 = getSimulator(TEST_CONFIG);

      expect(instance2).not.toBe(instance1);
    });

    it('resetSimulatorInstance should be safe to call when no instance exists', () => {
      // Ensure no singleton exists
      resetSimulatorInstance();
      // Should not throw
      expect(() => resetSimulatorInstance()).not.toThrow();
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle config with single chain and single pair', () => {
      const minimalSim = new PriceSimulator({
        chains: ['ethereum'],
        pairs: [['WETH', 'USDC']],
        dexesPerChain: 1,
        updateIntervalMs: 100,
        volatility: 0.01,
        arbitrageChance: 0,
        arbitrageSpread: 0,
      });

      const prices = minimalSim.getAllPrices();
      // 1 chain * 1 dex * 1 pair = 1
      expect(prices.size).toBe(1);

      const handler = jest.fn<(update: SimulatedPriceUpdate) => void>();
      minimalSim.on('priceUpdate', handler);
      minimalSim.start();

      expect(handler.mock.calls.length).toBe(1);

      jest.advanceTimersByTime(100);
      expect(handler.mock.calls.length).toBe(2);

      minimalSim.stop();
    });

    it('should fall back to default dexes for unknown chain', () => {
      const customSim = new PriceSimulator({
        chains: ['unknown_chain'],
        pairs: [['WETH', 'USDC']],
        dexesPerChain: 2,
        updateIntervalMs: 100,
        volatility: 0.01,
        arbitrageChance: 0,
        arbitrageSpread: 0,
      });

      const prices = customSim.getAllPrices();
      // Falls back to ['dex1', 'dex2'], sliced to 2 = 2 entries
      expect(prices.size).toBe(2);

      const keys = [...prices.keys()];
      expect(keys).toContain('unknown_chain:dex1:WETH/USDC');
      expect(keys).toContain('unknown_chain:dex2:WETH/USDC');

      customSim.stop();
    });

    it('should handle dexesPerChain larger than available dexes', () => {
      const customSim = new PriceSimulator({
        chains: ['zksync'], // only 2 dexes: syncswap, mute
        pairs: [['WETH', 'USDC']],
        dexesPerChain: 10, // request more than available
        updateIntervalMs: 100,
        volatility: 0.01,
        arbitrageChance: 0,
        arbitrageSpread: 0,
      });

      const prices = customSim.getAllPrices();
      // slice(0, 10) on array of 2 yields 2
      expect(prices.size).toBe(2);

      customSim.stop();
    });

    it('should use getTokenPrice fallback for unknown tokens', () => {
      const customSim = new PriceSimulator({
        chains: ['bsc'],
        pairs: [['UNKNOWN_TOKEN', 'USDC']],
        dexesPerChain: 1,
        updateIntervalMs: 100,
        volatility: 0.01,
        arbitrageChance: 0,
        arbitrageSpread: 0,
      });

      // getTokenPrice('UNKNOWN_TOKEN') returns 1 (fallback)
      // getTokenPrice('USDC') returns 1.0
      // pairPrice = 1 / 1 = 1 (with small variation)
      const price = customSim.getPrice('bsc', DEXES['bsc'][0], 'UNKNOWN_TOKEN', 'USDC');
      expect(price).toBeDefined();
      // Should be close to 1.0
      expect(price!).toBeGreaterThan(0.99);
      expect(price!).toBeLessThan(1.01);

      customSim.stop();
    });

    it('should stop cleanly even when not started', () => {
      // stop() on a never-started simulator should not throw
      expect(() => simulator.stop()).not.toThrow();
      expect(simulator.isRunning()).toBe(false);
    });
  });
});
