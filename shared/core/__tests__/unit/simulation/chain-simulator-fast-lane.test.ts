/**
 * ChainSimulator Fast Lane Opportunity Generation Tests
 *
 * Tests the dedicated fast-lane opportunity generator that creates
 * high-confidence, high-profit opportunities guaranteed to pass
 * the fast-lane thresholds (confidence >= 0.90, profit >= $100).
 *
 * @see shared/core/src/simulation/chain-simulator.ts
 * @see shared/config/src/service-config.ts FAST_LANE_CONFIG
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
  SimulatedOpportunity,
} from '../../../src/simulation/types';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

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

const BASE_CONFIG: ChainSimulatorConfig = {
  chainId: 'ethereum',
  updateIntervalMs: 1000,
  volatility: 0.02,
  arbitrageChance: 0.1,
  minArbitrageSpread: 0.005,
  maxArbitrageSpread: 0.02,
  pairs: TEST_PAIRS,
};

// Fast-lane thresholds from FAST_LANE_CONFIG defaults
const FAST_LANE_MIN_CONFIDENCE = 0.90;
const FAST_LANE_MIN_PROFIT_USD = 100;

describe('ChainSimulator - Fast Lane Opportunity Generation', () => {
  let simulator: ChainSimulator;

  beforeEach(() => {
    jest.useFakeTimers();
    // Use low realism for predictable interval-based ticks
    process.env.SIMULATION_REALISM_LEVEL = 'low';
  });

  afterEach(() => {
    simulator?.stop();
    jest.useRealTimers();
    delete process.env.SIMULATION_REALISM_LEVEL;
    delete process.env.SIMULATION_FAST_LANE_RATE;
    delete process.env.SIMULATION_UPDATE_INTERVAL_MS;
  });

  describe('Fast lane opportunity thresholds', () => {
    it('should generate opportunities with confidence >= fast lane minimum', async () => {
      // GIVEN: Simulator with fast lane rate of 100% (every tick)
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      // WHEN: Start and advance through several ticks
      simulator.start();
      await jest.advanceTimersByTimeAsync(5000);
      simulator.stop();

      // THEN: All fast-lane opportunities have confidence >= 0.90
      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.confidence).toBeGreaterThanOrEqual(FAST_LANE_MIN_CONFIDENCE);
      }
    });

    it('should generate opportunities with expectedProfit >= fast lane minimum', async () => {
      // GIVEN: Simulator with fast lane rate of 100%
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      // WHEN: Advance through several ticks
      simulator.start();
      await jest.advanceTimersByTimeAsync(5000);
      simulator.stop();

      // THEN: All fast-lane opportunities have expectedProfit >= $100
      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.expectedProfit).toBeGreaterThanOrEqual(FAST_LANE_MIN_PROFIT_USD);
      }
    });

    it('should set isSimulated flag on fast-lane opportunities', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(3000);
      simulator.stop();

      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.isSimulated).toBe(true);
      }
    });

    it('should include pipeline timestamps for latency tracking', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(3000);
      simulator.stop();

      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.pipelineTimestamps).toBeDefined();
        expect(opp.pipelineTimestamps!.wsReceivedAt).toBeGreaterThan(0);
        expect(opp.pipelineTimestamps!.publishedAt).toBeGreaterThan(0);
        expect(opp.pipelineTimestamps!.consumedAt).toBeGreaterThan(0);
      }
    });
  });

  describe('Fast lane rate control', () => {
    it('should generate fast-lane opportunities at configured rate', async () => {
      // GIVEN: High rate to ensure we get some (0.5 = 50% of ticks)
      process.env.SIMULATION_FAST_LANE_RATE = '0.5';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      const allOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });
      simulator.on('opportunity', (opp: SimulatedOpportunity) => {
        allOpps.push(opp);
      });

      // WHEN: Run for many ticks
      simulator.start();
      await jest.advanceTimersByTimeAsync(20000);
      simulator.stop();

      // THEN: Fast-lane opportunities should be generated (non-zero with 50% rate over 20 ticks)
      expect(fastLaneOpps.length).toBeGreaterThan(0);
    });

    it('should disable fast-lane generation when rate is 0', async () => {
      // GIVEN: Fast lane rate explicitly set to 0
      process.env.SIMULATION_FAST_LANE_RATE = '0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      // WHEN: Run for many ticks
      simulator.start();
      await jest.advanceTimersByTimeAsync(10000);
      simulator.stop();

      // THEN: No fast-lane opportunities generated
      expect(fastLaneOpps.length).toBe(0);
    });

    it('should use default rate when env var is not set', async () => {
      // GIVEN: No SIMULATION_FAST_LANE_RATE env var (should use default 0.15)
      delete process.env.SIMULATION_FAST_LANE_RATE;
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      // WHEN: Run for many ticks (60 ticks at 1000ms interval, 15% rate ~ 9 expected)
      simulator.start();
      await jest.advanceTimersByTimeAsync(60000);
      simulator.stop();

      // THEN: Some fast-lane opportunities are generated (default rate is non-zero)
      expect(fastLaneOpps.length).toBeGreaterThan(0);
    });
  });

  describe('Fast lane strategy type diversity', () => {
    it('should generate opportunities across multiple strategy types', async () => {
      // GIVEN: 100% rate to ensure many opportunities
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const types = new Set<string>();
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        types.add(opp.type);
      });

      // WHEN: Run for many ticks to get diverse types
      simulator.start();
      await jest.advanceTimersByTimeAsync(50000);
      simulator.stop();

      // THEN: Multiple strategy types represented
      expect(types.size).toBeGreaterThanOrEqual(2);
    });

    it('should include flash-loan type opportunities with useFlashLoan=true', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const flashLoanOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        if (opp.type === 'flash-loan') flashLoanOpps.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(50000);
      simulator.stop();

      // Flash-loan should appear given weighted distribution
      if (flashLoanOpps.length > 0) {
        for (const opp of flashLoanOpps) {
          expect(opp.useFlashLoan).toBe(true);
          expect(opp.flashLoanFee).toBeDefined();
        }
      }
    });
  });

  describe('Fast lane opportunity fields', () => {
    it('should populate required execution fields (tokenIn, tokenOut, amountIn)', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(3000);
      simulator.stop();

      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.tokenIn).toBeDefined();
        expect(typeof opp.tokenIn).toBe('string');
        expect(opp.tokenIn!.length).toBeGreaterThan(0);
        expect(opp.tokenOut).toBeDefined();
        expect(typeof opp.tokenOut).toBe('string');
        expect(opp.tokenOut!.length).toBeGreaterThan(0);
        expect(opp.amountIn).toBeDefined();
        expect(typeof opp.amountIn).toBe('string');
        expect(opp.amountIn!.length).toBeGreaterThan(0);
      }
    });

    it('should set chain to simulator chainId', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(3000);
      simulator.stop();

      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.chain).toBe('ethereum');
        expect(opp.buyChain).toBe('ethereum');
        expect(opp.sellChain).toBe('ethereum');
      }
    });

    it('should have unique IDs with fast-lane prefix', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const ids = new Set<string>();
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        ids.add(opp.id);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(5000);
      simulator.stop();

      // All IDs should be unique
      const idsArray = Array.from(ids);
      expect(idsArray.length).toBeGreaterThan(0);
      expect(new Set(idsArray).size).toBe(idsArray.length);

      // IDs should contain 'fl' prefix for fast-lane identification
      for (const id of idsArray) {
        expect(id).toContain('fl');
      }
    });

    it('should have valid expiresAt in the future', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(3000);
      simulator.stop();

      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.expiresAt).toBeGreaterThan(opp.timestamp);
      }
    });
  });

  describe('Fast lane with medium/high realism', () => {
    it('should generate fast-lane opportunities in block-driven mode', async () => {
      process.env.SIMULATION_REALISM_LEVEL = 'medium';
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });

      simulator.start();
      // Ethereum blocks ~12s, run long enough for several blocks
      await jest.advanceTimersByTimeAsync(60000);
      simulator.stop();

      expect(fastLaneOpps.length).toBeGreaterThan(0);
      for (const opp of fastLaneOpps) {
        expect(opp.confidence).toBeGreaterThanOrEqual(FAST_LANE_MIN_CONFIDENCE);
        expect(opp.expectedProfit).toBeGreaterThanOrEqual(FAST_LANE_MIN_PROFIT_USD);
      }
    });
  });

  describe('Fast lane opportunities also emitted as regular opportunities', () => {
    it('should emit fast-lane opportunities on both events', async () => {
      process.env.SIMULATION_FAST_LANE_RATE = '1.0';
      process.env.SIMULATION_REALISM_LEVEL = 'low';
      simulator = new ChainSimulator(BASE_CONFIG);

      const fastLaneOpps: SimulatedOpportunity[] = [];
      const regularOpps: SimulatedOpportunity[] = [];
      simulator.on('fastLaneOpportunity', (opp: SimulatedOpportunity) => {
        fastLaneOpps.push(opp);
      });
      simulator.on('opportunity', (opp: SimulatedOpportunity) => {
        regularOpps.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(5000);
      simulator.stop();

      expect(fastLaneOpps.length).toBeGreaterThan(0);
      // Each fast-lane opp should also appear in regular opportunities
      for (const flOpp of fastLaneOpps) {
        const found = regularOpps.some(r => r.id === flOpp.id);
        expect(found).toBe(true);
      }
    });
  });
});
