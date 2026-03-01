/**
 * ChainSimulator Multi-Hop Tests
 *
 * Tests for triangular and quadrilateral arbitrage opportunity generation:
 * - Path generation (3-hop and 4-hop)
 * - Circular path validation
 * - Profit calculation with multi-hop fees
 * - Flash loan fee application
 *
 * Uses fake timers + collected events instead of done() callbacks to avoid
 * stochastic 10-second timeouts. The simulator's setInterval is advanced
 * deterministically via jest.advanceTimersByTimeAsync().
 *
 * @see shared/core/src/simulation-mode.ts (ChainSimulator.generateMultiHopOpportunity)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  ChainSimulator,
  type ChainSimulatorConfig,
  type SimulatedPairConfig,
  type SimulatedOpportunity,
} from '../../src/simulation-mode';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a simulator with enough token pairs to generate multi-hop opportunities.
 */
function createMultiHopSimulator(): ChainSimulator {
  const pairs: SimulatedPairConfig[] = [
    // Uniswap pairs for multi-hop
    {
      address: '0x1000000000000000000000000000000000000001',
      token0Symbol: 'WETH',
      token1Symbol: 'USDC',
      token0Decimals: 18,
      token1Decimals: 6,
      dex: 'uniswap_v3',
      fee: 0.003,
    },
    {
      address: '0x1000000000000000000000000000000000000002',
      token0Symbol: 'WBTC',
      token1Symbol: 'WETH',
      token0Decimals: 8,
      token1Decimals: 18,
      dex: 'uniswap_v3',
      fee: 0.003,
    },
    {
      address: '0x1000000000000000000000000000000000000003',
      token0Symbol: 'LINK',
      token1Symbol: 'USDC',
      token0Decimals: 18,
      token1Decimals: 6,
      dex: 'uniswap_v3',
      fee: 0.003,
    },
    {
      address: '0x1000000000000000000000000000000000000004',
      token0Symbol: 'LINK',
      token1Symbol: 'WETH',
      token0Decimals: 18,
      token1Decimals: 18,
      dex: 'uniswap_v3',
      fee: 0.003,
    },
    // Sushiswap pairs for intra-chain arbitrage (same tokens, different DEX)
    {
      address: '0x2000000000000000000000000000000000000001',
      token0Symbol: 'WETH',
      token1Symbol: 'USDC',
      token0Decimals: 18,
      token1Decimals: 6,
      dex: 'sushiswap',
      fee: 0.003,
    },
    {
      address: '0x2000000000000000000000000000000000000002',
      token0Symbol: 'WBTC',
      token1Symbol: 'WETH',
      token0Decimals: 8,
      token1Decimals: 18,
      dex: 'sushiswap',
      fee: 0.003,
    },
  ];

  const config: ChainSimulatorConfig = {
    chainId: 'ethereum',
    updateIntervalMs: 50,
    volatility: 0.01,
    arbitrageChance: 0.5, // 50% chance per tick
    minArbitrageSpread: 0.005,
    maxArbitrageSpread: 0.02,
    pairs,
  };

  return new ChainSimulator(config);
}

/** Collect opportunities from simulator during a fake-timer advance. */
async function collectOpportunities(
  simulator: ChainSimulator,
  advanceMs: number
): Promise<SimulatedOpportunity[]> {
  const opportunities: SimulatedOpportunity[] = [];
  simulator.on('opportunity', (opp: SimulatedOpportunity) => opportunities.push(opp));
  simulator.start();
  await jest.advanceTimersByTimeAsync(advanceMs);
  simulator.stop();
  return opportunities;
}

// =============================================================================
// Tests
// =============================================================================

describe('ChainSimulator - Multi-Hop Opportunities', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Use low realism for predictable test behavior (flat interval, legacy type split)
    process.env.SIMULATION_REALISM_LEVEL = 'low';
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.SIMULATION_REALISM_LEVEL;
  });

  describe('Triangular Opportunities (3-hop)', () => {
    it('should generate triangular path with 3 unique tokens + circular return', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 5000);
      const triangular = opportunities.filter(o => o.type === 'triangular');

      expect(triangular.length).toBeGreaterThan(0);

      const opp = triangular[0];
      expect(opp.hops).toBe(3);
      expect(opp.path).toBeDefined();
      expect(opp.path!.length).toBe(4); // A -> B -> C -> A

      // First and last tokens should be the same (circular)
      expect(opp.path![0]).toBe(opp.path![3]);

      // Intermediate tokens should be unique
      const intermediateTokens = opp.path!.slice(1, 3);
      const uniqueIntermediateTokens = new Set(intermediateTokens);
      expect(uniqueIntermediateTokens.size).toBe(2);

      // Should use flash loan
      expect(opp.useFlashLoan).toBe(true);

      // Should have intermediate tokens field
      expect(opp.intermediateTokens).toBeDefined();
      expect(opp.intermediateTokens!.length).toBe(2);
    });

    it('should calculate profit after fees per hop', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 5000);
      const triangular = opportunities.filter(o => o.type === 'triangular');

      expect(triangular.length).toBeGreaterThan(0);

      const opp = triangular[0];
      // Profit should be positive after fees
      expect(opp.profitPercentage).toBeGreaterThan(0);
      // Reasonable upper bound
      expect(opp.profitPercentage).toBeLessThan(5);
    });

    it('should include flash loan fee in expected profit', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 5000);
      const triangular = opportunities.filter(o => o.type === 'triangular');

      expect(triangular.length).toBeGreaterThan(0);

      const opp = triangular[0];
      expect(opp.flashLoanFee).toBeDefined();
      expect(opp.flashLoanFee).toBe(0.0009); // Aave V3: 0.09%
      expect(opp.expectedProfit).toBeDefined();
    });
  });

  describe('Quadrilateral Opportunities (4-hop)', () => {
    it('should generate quadrilateral path with 4 unique tokens + circular return', async () => {
      // Advance longer for 4-hop (less common: 30% of multi-hop events)
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 10000);
      const quadrilateral = opportunities.filter(o => o.type === 'quadrilateral');

      expect(quadrilateral.length).toBeGreaterThan(0);

      const opp = quadrilateral[0];
      expect(opp.hops).toBe(4);
      expect(opp.path).toBeDefined();
      expect(opp.path!.length).toBe(5); // A -> B -> C -> D -> A

      // First and last tokens should be the same (circular)
      expect(opp.path![0]).toBe(opp.path![4]);

      // Intermediate tokens should be unique (3 intermediate)
      const intermediateTokens = opp.path!.slice(1, 4);
      const uniqueIntermediateTokens = new Set(intermediateTokens);
      expect(uniqueIntermediateTokens.size).toBe(3);

      // Should use flash loan
      expect(opp.useFlashLoan).toBe(true);

      // Should have intermediate tokens field
      expect(opp.intermediateTokens).toBeDefined();
      expect(opp.intermediateTokens!.length).toBe(3);
    });

    it('should calculate profit after more fees (4 hops)', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 10000);
      const quadrilateral = opportunities.filter(o => o.type === 'quadrilateral');

      expect(quadrilateral.length).toBeGreaterThan(0);

      const opp = quadrilateral[0];
      // Profit should still be positive after all fees
      expect(opp.profitPercentage).toBeGreaterThan(0);
      // Gas cost should be higher for 4-hop
      expect(opp.expectedGasCost).toBeGreaterThan(10);
    });
  });

  describe('Multi-Hop Confidence', () => {
    it('should have slightly lower confidence than intra-chain', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 5000);

      const multiHopConfidences = opportunities
        .filter(c => c.type === 'triangular' || c.type === 'quadrilateral')
        .map(c => c.confidence);

      const basicConfidences = opportunities
        .filter(c => c.type !== 'triangular' && c.type !== 'quadrilateral')
        .map(c => c.confidence);

      if (multiHopConfidences.length > 0 && basicConfidences.length > 0) {
        const avgMultiHop =
          multiHopConfidences.reduce((a, b) => a + b, 0) / multiHopConfidences.length;
        const avgBasic =
          basicConfidences.reduce((a, b) => a + b, 0) / basicConfidences.length;

        // Multi-hop should generally have lower confidence
        expect(avgMultiHop).toBeLessThanOrEqual(avgBasic + 0.1);
      }
    });
  });

  describe('Multi-Hop Expiry', () => {
    it('should have shorter expiry than intra-chain', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 5000);

      for (const opp of opportunities) {
        const expiryMs = opp.expiresAt - opp.timestamp;

        if (opp.type === 'triangular' || opp.type === 'quadrilateral') {
          // Multi-hop strategy TTL (3000ms) × SIMULATION_TTL_MULTIPLIER (3) = 9000ms
          expect(expiryMs).toBeLessThanOrEqual(9000);
        } else if (opp.type !== 'triangular' && opp.type !== 'quadrilateral') {
          // Chain-specific TTL (ethereum: 30000ms) × SIMULATION_TTL_MULTIPLIER (3) = 90000ms
          expect(expiryMs).toBeLessThanOrEqual(90000);
        }
      }
    });
  });

  describe('Path Generation Edge Cases', () => {
    it('should not generate multi-hop with insufficient tokens', async () => {
      // Only 2 unique tokens - cannot make triangular (needs 3)
      const pairs: SimulatedPairConfig[] = [
        {
          address: '0x1000000000000000000000000000000000000001',
          token0Symbol: 'WETH',
          token1Symbol: 'USDC',
          token0Decimals: 18,
          token1Decimals: 6,
          dex: 'uniswap_v3',
          fee: 0.003,
        },
      ];

      const simulator = new ChainSimulator({
        chainId: 'ethereum',
        updateIntervalMs: 100,
        volatility: 0.01,
        arbitrageChance: 0.15,
        minArbitrageSpread: 0.005,
        maxArbitrageSpread: 0.02,
        pairs,
      });

      let multiHopCount = 0;
      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (opportunity.type === 'triangular' || opportunity.type === 'quadrilateral') {
          multiHopCount++;
        }
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(2000);
      simulator.stop();

      expect(multiHopCount).toBe(0);
    });

    it('should emit multi-hop opportunities randomly (not every tick)', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 5000);

      const multiHopCount = opportunities.filter(
        o => o.type === 'triangular' || o.type === 'quadrilateral'
      ).length;
      const basicCount = opportunities.filter(
        o => o.type !== 'triangular' && o.type !== 'quadrilateral'
      ).length;

      // Should have both types
      expect(multiHopCount).toBeGreaterThan(0);
      expect(basicCount).toBeGreaterThan(0);

      // Basic types should be more common than multi-hop
      expect(basicCount).toBeGreaterThan(multiHopCount);
    });
  });

  describe('Buy/Sell DEX Consistency', () => {
    it('should use different DEXs for multi-hop buy and sell endpoints', async () => {
      const opportunities = await collectOpportunities(createMultiHopSimulator(), 5000);
      const multiHop = opportunities.filter(
        o => o.type === 'triangular' || o.type === 'quadrilateral'
      );

      expect(multiHop.length).toBeGreaterThan(0);

      const opp = multiHop[0];
      // Multi-hop arbitrage buys on one DEX and sells on another
      expect(opp.buyDex).not.toBe(opp.sellDex);

      // Both should be valid DEX names from the configured pairs
      const validDexes = ['uniswap_v3', 'sushiswap'];
      expect(validDexes).toContain(opp.buyDex);
      expect(validDexes).toContain(opp.sellDex);
    });
  });
});
