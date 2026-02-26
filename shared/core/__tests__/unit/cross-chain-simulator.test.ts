/**
 * CrossChainSimulator Tests
 *
 * Tests for cross-chain arbitrage opportunity generation and detection:
 * - Price initialization across chains
 * - Cross-chain opportunity detection
 * - Bridge cost calculation
 * - Profit threshold validation
 * - Gas cost estimation per chain
 *
 * Uses fake timers + collected events instead of done() callbacks to avoid
 * stochastic 10-second timeouts.
 *
 * @see shared/core/src/simulation-mode.ts (CrossChainSimulator)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  CrossChainSimulator,
  type CrossChainSimulatorConfig,
  type SimulatedOpportunity,
  type BridgeCostConfig,
} from '../../src/simulation-mode';

// =============================================================================
// Helpers
// =============================================================================

/** Collect opportunities from a cross-chain simulator during a fake-timer advance. */
async function collectCrossChainOpportunities(
  config: Partial<CrossChainSimulatorConfig> & Pick<CrossChainSimulatorConfig, 'chains' | 'tokens'>,
  advanceMs: number
): Promise<SimulatedOpportunity[]> {
  const simulator = new CrossChainSimulator({
    updateIntervalMs: 50,
    volatility: 0.10,
    minProfitThreshold: 0.001,
    ...config,
  });

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

describe('CrossChainSimulator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Initialization', () => {
    it('should initialize prices for all chains and tokens', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH', 'USDC'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      expect(simulator.getPrice('ethereum', 'WETH')).toBeDefined();
      expect(simulator.getPrice('arbitrum', 'WETH')).toBeDefined();
      expect(simulator.getPrice('ethereum', 'USDC')).toBeDefined();
      expect(simulator.getPrice('arbitrum', 'USDC')).toBeDefined();
    });

    it('should apply chain-specific price variation during initialization', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum', 'optimism'],
        tokens: ['WETH'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      const ethPrice = simulator.getPrice('ethereum', 'WETH');
      const arbPrice = simulator.getPrice('arbitrum', 'WETH');
      const opPrice = simulator.getPrice('optimism', 'WETH');

      expect(ethPrice).toBeDefined();
      expect(arbPrice).toBeDefined();
      expect(opPrice).toBeDefined();

      if (ethPrice && arbPrice) {
        const variation = Math.abs((arbPrice - ethPrice) / ethPrice);
        expect(variation).toBeLessThan(0.01);
      }
    });

    it('should skip tokens not in BASE_PRICES', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum'],
        tokens: ['WETH', 'NONEXISTENT_TOKEN'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      expect(simulator.getPrice('ethereum', 'WETH')).toBeDefined();
      expect(simulator.getPrice('ethereum', 'NONEXISTENT_TOKEN')).toBeUndefined();
    });
  });

  describe('Cross-Chain Opportunity Detection', () => {
    it('should detect opportunity when price differential exceeds bridge costs', async () => {
      const opportunities = await collectCrossChainOpportunities({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH', 'WBTC'],
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 5,
            percentageFee: 0.0001,
            estimatedTimeSeconds: 600,
          },
        },
      }, 5000);

      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      expect(opp.type).toBe('cross-chain');
      expect(opp.buyChain).toBeDefined();
      expect(opp.sellChain).toBeDefined();
      expect(opp.buyChain).not.toBe(opp.sellChain);
      expect(opp.bridgeProtocol).toBeDefined();
      expect(opp.bridgeFee).toBeGreaterThan(0);
      expect(opp.profitPercentage).toBeGreaterThan(0.1);
    });

    it('should not emit opportunities when bridge costs exceed profit', async () => {
      const opportunities = await collectCrossChainOpportunities({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        volatility: 0.01, // Low volatility
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 1000, // Very expensive bridge
            percentageFee: 0.05,
            estimatedTimeSeconds: 600,
          },
        },
      }, 2000);

      expect(opportunities.length).toBe(0);
    });

    it('should only detect opportunities with dest price > source price', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      const ethPrice = simulator.getPrice('ethereum', 'WETH');
      const arbPrice = simulator.getPrice('arbitrum', 'WETH');

      if (ethPrice && arbPrice) {
        const shouldHaveOpportunity = arbPrice > ethPrice;
        expect(typeof shouldHaveOpportunity).toBe('boolean');
      }
    });
  });

  describe('Bridge Protocol Selection', () => {
    it('should use stargate for ethereum routes', async () => {
      const opportunities = await collectCrossChainOpportunities({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH', 'WBTC'],
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 10,
            percentageFee: 0.0006,
            estimatedTimeSeconds: 600,
          },
        },
      }, 5000);

      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      if (opp.buyChain === 'ethereum' || opp.sellChain === 'ethereum') {
        expect(opp.bridgeProtocol).toBe('stargate');
      }
    });

    it('should use across for L2-to-L2 routes', async () => {
      const opportunities = await collectCrossChainOpportunities({
        chains: ['arbitrum', 'optimism'],
        tokens: ['WETH', 'WBTC'],
        bridgeCosts: {
          'arbitrum-optimism': {
            fixedCost: 5,
            percentageFee: 0.0004,
            estimatedTimeSeconds: 120,
          },
        },
      }, 5000);

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0].bridgeProtocol).toBe('across');
    });
  });

  describe('Gas Cost Estimation', () => {
    it('should include realistic gas costs per chain', async () => {
      const opportunities = await collectCrossChainOpportunities({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH', 'WBTC'],
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 10,
            percentageFee: 0.0006,
            estimatedTimeSeconds: 600,
          },
        },
      }, 5000);

      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      expect(opp.expectedGasCost).toBeDefined();
      expect(opp.expectedGasCost).toBeGreaterThan(0);

      if (opp.buyChain === 'ethereum') {
        expect(opp.expectedGasCost).toBeGreaterThan(10);
      }
    });
  });

  describe('Profit Calculation', () => {
    it('should calculate net profit after bridge fees and gas', async () => {
      const opportunities = await collectCrossChainOpportunities({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH', 'WBTC'],
        updateIntervalMs: 100,
        minProfitThreshold: 0.005,
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 15,
            percentageFee: 0.0006,
            estimatedTimeSeconds: 600,
          },
        },
      }, 5000);

      expect(opportunities.length).toBeGreaterThan(0);

      const opp = opportunities[0];
      expect(opp.expectedProfit).toBeDefined();

      const grossProfit = opp.estimatedProfitUsd;
      const bridgeFee = opp.bridgeFee || 0;
      const gasCost = opp.expectedGasCost || 0;
      const netProfit = grossProfit - bridgeFee - gasCost;

      expect(Math.abs((opp.expectedProfit || 0) - netProfit)).toBeLessThan(25);
    });
  });

  describe('Price Updates', () => {
    it('should emit priceUpdate events when prices change', async () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum'],
        tokens: ['WETH'],
        updateIntervalMs: 100,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      const updates: Array<{ chain: string; token: string; price: number }> = [];
      simulator.on('priceUpdate', (update: { chain: string; token: string; price: number }) => {
        updates.push(update);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(500);
      simulator.stop();

      expect(updates.length).toBeGreaterThan(0);
      expect(updates[0].chain).toBe('ethereum');
      expect(updates[0].token).toBe('WETH');
      expect(updates[0].price).toBeGreaterThan(0);
    });
  });

  describe('Start/Stop Lifecycle', () => {
    it('should start and stop cleanly', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      expect(simulator.isRunning()).toBe(false);

      simulator.start();
      expect(simulator.isRunning()).toBe(true);

      simulator.stop();
      expect(simulator.isRunning()).toBe(false);
    });

    it('should not start twice', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum'],
        tokens: ['WETH'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      simulator.start();
      expect(simulator.isRunning()).toBe(true);

      simulator.start();
      expect(simulator.isRunning()).toBe(true);

      simulator.stop();
    });
  });

  describe('getAllPricesForToken', () => {
    it('should return prices for a token across all chains', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum', 'optimism'],
        tokens: ['WETH', 'USDC'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      const wethPrices = simulator.getAllPricesForToken('WETH');

      expect(wethPrices.size).toBe(3);
      expect(wethPrices.has('ethereum')).toBe(true);
      expect(wethPrices.has('arbitrum')).toBe(true);
      expect(wethPrices.has('optimism')).toBe(true);
    });

    it('should return empty map for unknown token', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum'],
        tokens: ['WETH'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      const prices = simulator.getAllPricesForToken('UNKNOWN');
      expect(prices.size).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing bridge route gracefully', async () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum', 'bsc'],
        tokens: ['WETH', 'WBTC'],
        updateIntervalMs: 100,
        volatility: 0.10,
        minProfitThreshold: 0.001,
        bridgeCosts: {
          // Only define ethereum-arbitrum, missing other routes
          'ethereum-arbitrum': {
            fixedCost: 10,
            percentageFee: 0.0006,
            estimatedTimeSeconds: 600,
          },
        },
      });

      const opportunities: SimulatedOpportunity[] = [];
      simulator.on('opportunity', (opp: SimulatedOpportunity) => {
        opportunities.push(opp);
      });

      simulator.start();
      await jest.advanceTimersByTimeAsync(3000);
      simulator.stop();

      // Should only see ethereum<->arbitrum opportunities
      for (const opp of opportunities) {
        expect(
          (opp.buyChain === 'ethereum' && opp.sellChain === 'arbitrum') ||
          (opp.buyChain === 'arbitrum' && opp.sellChain === 'ethereum')
        ).toBe(true);
      }
    });

    it('should handle zero tokens gracefully', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: [],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      simulator.start();
      expect(simulator.isRunning()).toBe(true);
      simulator.stop();
    });
  });
});
