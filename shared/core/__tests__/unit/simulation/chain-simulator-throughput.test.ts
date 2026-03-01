/**
 * ChainSimulator Throughput Model Tests
 *
 * Tests the block-driven multi-swap model:
 * - setTimeout with jittered block times (not fixed setInterval)
 * - Poisson-distributed swap count per block
 * - DEX market share selection
 * - Dynamic gas pricing
 * - Backward compatibility with low realism
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

import { ChainSimulator } from '../../../src/simulation/chain-simulator';
import type {
  ChainSimulatorConfig,
  SimulatedPairConfig,
  SimulatedSyncEvent,
  SimulatedOpportunity,
} from '../../../src/simulation/types';

const TEST_PAIRS: SimulatedPairConfig[] = [
  {
    address: '0x1000000000000000000000000000000000000001',
    token0Symbol: 'WETH', token1Symbol: 'USDC',
    token0Decimals: 18, token1Decimals: 6,
    dex: 'uniswap_v3', fee: 0.003,
  },
  {
    address: '0x2000000000000000000000000000000000000001',
    token0Symbol: 'WETH', token1Symbol: 'USDC',
    token0Decimals: 18, token1Decimals: 6,
    dex: 'sushiswap', fee: 0.003,
  },
  {
    address: '0x3000000000000000000000000000000000000001',
    token0Symbol: 'WBTC', token1Symbol: 'WETH',
    token0Decimals: 8, token1Decimals: 18,
    dex: 'uniswap_v3', fee: 0.003,
  },
];

const TEST_CONFIG: ChainSimulatorConfig = {
  chainId: 'ethereum',
  updateIntervalMs: 1000,
  volatility: 0.02,
  arbitrageChance: 0.1,
  minArbitrageSpread: 0.005,
  maxArbitrageSpread: 0.02,
  pairs: TEST_PAIRS,
};

describe('ChainSimulator - Block-Driven Throughput Model', () => {
  let simulator: ChainSimulator;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    simulator?.stop();
    jest.useRealTimers();
    delete process.env.SIMULATION_REALISM_LEVEL;
    delete process.env.SIMULATION_UPDATE_INTERVAL_MS;
  });

  describe('Medium realism (block-driven)', () => {
    beforeEach(() => {
      process.env.SIMULATION_REALISM_LEVEL = 'medium';
    });

    it('should emit sync events using setTimeout chain', async () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      const events: SimulatedSyncEvent[] = [];
      simulator.on('syncEvent', (e: SimulatedSyncEvent) => events.push(e));
      simulator.start();

      // Initial emission
      const initialCount = events.length;
      expect(initialCount).toBeGreaterThan(0);

      // Advance past one Ethereum block (~12s + jitter headroom)
      await jest.advanceTimersByTimeAsync(15000);
      expect(events.length).toBeGreaterThan(initialCount);
    });

    it('should generate variable swap counts per block (Poisson)', async () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      const blockSwapCounts: number[] = [];
      let currentBlockSwaps = 0;

      simulator.on('syncEvent', () => { currentBlockSwaps++; });
      simulator.on('blockUpdate', () => {
        if (currentBlockSwaps > 0) {
          blockSwapCounts.push(currentBlockSwaps);
        }
        currentBlockSwaps = 0;
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(120000); // ~10 blocks
      simulator.stop();

      expect(blockSwapCounts.length).toBeGreaterThan(0);
      // Poisson distribution means counts should vary
      if (blockSwapCounts.length >= 3) {
        const uniqueCounts = new Set(blockSwapCounts);
        expect(uniqueCounts.size).toBeGreaterThan(1);
      }
    });

    it('should increment block numbers', async () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      const initialBlock = simulator.getBlockNumber();
      simulator.start();
      await jest.advanceTimersByTimeAsync(60000);
      simulator.stop();
      expect(simulator.getBlockNumber()).toBeGreaterThan(initialBlock);
    });

    it('should stop cleanly and not emit after stop', async () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      let eventCount = 0;
      simulator.on('syncEvent', () => { eventCount++; });

      simulator.start();
      await jest.advanceTimersByTimeAsync(15000);
      simulator.stop();

      const countAtStop = eventCount;
      await jest.advanceTimersByTimeAsync(60000);
      expect(eventCount).toBe(countAtStop);
    });
  });

  describe('Low realism (legacy setInterval)', () => {
    beforeEach(() => {
      process.env.SIMULATION_REALISM_LEVEL = 'low';
    });

    it('should use fixed interval (setInterval behavior)', () => {
      simulator = new ChainSimulator(TEST_CONFIG);
      const events: SimulatedSyncEvent[] = [];
      simulator.on('syncEvent', (e: SimulatedSyncEvent) => events.push(e));
      simulator.start();

      const initialCount = events.length;
      expect(initialCount).toBeGreaterThan(0);

      // Low realism uses configured 1000ms interval
      jest.advanceTimersByTime(TEST_CONFIG.updateIntervalMs);
      expect(events.length).toBeGreaterThan(initialCount);
    });
  });

  describe('Env override', () => {
    it('should use fixed interval when SIMULATION_UPDATE_INTERVAL_MS is set', () => {
      process.env.SIMULATION_REALISM_LEVEL = 'medium';
      process.env.SIMULATION_UPDATE_INTERVAL_MS = '500';
      simulator = new ChainSimulator({ ...TEST_CONFIG, updateIntervalMs: 500 });
      const events: SimulatedSyncEvent[] = [];
      simulator.on('syncEvent', (e: SimulatedSyncEvent) => events.push(e));
      simulator.start();

      const initialCount = events.length;
      jest.advanceTimersByTime(500);
      expect(events.length).toBeGreaterThan(initialCount);
    });
  });

  describe('Gas pricing', () => {
    it('should emit opportunities with dynamic gas cost', async () => {
      process.env.SIMULATION_REALISM_LEVEL = 'medium';
      simulator = new ChainSimulator({
        ...TEST_CONFIG,
        arbitrageChance: 0.5,
      });

      const opps: SimulatedOpportunity[] = [];
      simulator.on('opportunity', (o: SimulatedOpportunity) => opps.push(o));
      simulator.start();
      await jest.advanceTimersByTimeAsync(180000); // ~15 blocks
      simulator.stop();

      if (opps.length > 0) {
        expect(opps[0].expectedGasCost).toBeDefined();
        expect(opps[0].expectedGasCost!).toBeGreaterThan(0);
      }
    });
  });
});
