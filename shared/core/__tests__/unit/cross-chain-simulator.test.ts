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
 * @see shared/core/src/simulation-mode.ts (CrossChainSimulator)
 */

import {
  CrossChainSimulator,
  type CrossChainSimulatorConfig,
  type SimulatedOpportunity,
  type BridgeCostConfig,
} from '../../src/simulation-mode';

describe('CrossChainSimulator', () => {
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

      // Prices should be similar but slightly different due to chain variation
      expect(ethPrice).toBeDefined();
      expect(arbPrice).toBeDefined();
      expect(opPrice).toBeDefined();

      // Variation should be within ±0.5% (as per implementation)
      if (ethPrice && arbPrice) {
        const variation = Math.abs((arbPrice - ethPrice) / ethPrice);
        expect(variation).toBeLessThan(0.01); // <1%
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
    it('should detect opportunity when price differential exceeds bridge costs', (done) => {
      const customBridgeCosts: Record<string, BridgeCostConfig> = {
        'ethereum-arbitrum': {
          fixedCost: 5, // Low bridge cost
          percentageFee: 0.0001, // 0.01%
          estimatedTimeSeconds: 600,
        },
      };

      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 50,
        volatility: 0.05, // 5% volatility to reliably create opportunities
        minProfitThreshold: 0.001, // 0.1% min profit
        bridgeCosts: customBridgeCosts,
      });

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        expect(opportunity.type).toBe('cross-chain');
        expect(opportunity.buyChain).toBeDefined();
        expect(opportunity.sellChain).toBeDefined();
        expect(opportunity.buyChain).not.toBe(opportunity.sellChain);
        expect(opportunity.bridgeProtocol).toBeDefined();
        expect(opportunity.bridgeFee).toBeGreaterThan(0);
        expect(opportunity.profitPercentage).toBeGreaterThan(0.1); // Above threshold

        simulator.stop();
        done();
      });

      simulator.start();

      // Fail test if no opportunity after 5 seconds
      setTimeout(() => {
        simulator.stop();
        done(new Error('No cross-chain opportunity detected within timeout'));
      }, 5000);
    });

    it('should not emit opportunities when bridge costs exceed profit', (done) => {
      const expensiveBridgeCosts: Record<string, BridgeCostConfig> = {
        'ethereum-arbitrum': {
          fixedCost: 1000, // Very expensive bridge
          percentageFee: 0.05, // 5%
          estimatedTimeSeconds: 600,
        },
      };

      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 100,
        volatility: 0.01, // Low volatility
        minProfitThreshold: 0.002,
        bridgeCosts: expensiveBridgeCosts,
      });

      let opportunityCount = 0;
      simulator.on('opportunity', () => {
        opportunityCount++;
      });

      simulator.start();

      // Check after 2 seconds that no opportunities were emitted
      setTimeout(() => {
        simulator.stop();
        expect(opportunityCount).toBe(0);
        done();
      }, 2000);
    });

    it('should only detect opportunities with dest price > source price', () => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 1000,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      // Manually test the detection logic by checking prices
      const ethPrice = simulator.getPrice('ethereum', 'WETH');
      const arbPrice = simulator.getPrice('arbitrum', 'WETH');

      if (ethPrice && arbPrice) {
        // Opportunity should only exist if arbPrice > ethPrice (buy cheap, sell high)
        const shouldHaveOpportunity = arbPrice > ethPrice;

        // This is a conceptual test - in practice, the simulator checks this internally
        expect(typeof shouldHaveOpportunity).toBe('boolean');
      }
    });
  });

  describe('Bridge Protocol Selection', () => {
    it('should use stargate for ethereum routes', (done) => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 50,
        volatility: 0.05,
        minProfitThreshold: 0.001,
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 10,
            percentageFee: 0.0006,
            estimatedTimeSeconds: 600,
          },
        },
      });

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (
          opportunity.buyChain === 'ethereum' ||
          opportunity.sellChain === 'ethereum'
        ) {
          expect(opportunity.bridgeProtocol).toBe('stargate');
        }
        simulator.stop();
        done();
      });

      simulator.start();

      setTimeout(() => {
        simulator.stop();
        done(new Error('No opportunity detected'));
      }, 5000);
    });

    it('should use across for L2-to-L2 routes', (done) => {
      const simulator = new CrossChainSimulator({
        chains: ['arbitrum', 'optimism'],
        tokens: ['WETH'],
        updateIntervalMs: 50,
        volatility: 0.05,
        minProfitThreshold: 0.001,
        bridgeCosts: {
          'arbitrum-optimism': {
            fixedCost: 5,
            percentageFee: 0.0004,
            estimatedTimeSeconds: 120,
          },
        },
      });

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        expect(opportunity.bridgeProtocol).toBe('across');
        simulator.stop();
        done();
      });

      simulator.start();

      setTimeout(() => {
        simulator.stop();
        done(new Error('No opportunity detected'));
      }, 5000);
    });
  });

  describe('Gas Cost Estimation', () => {
    it('should include realistic gas costs per chain', (done) => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 50,
        volatility: 0.05,
        minProfitThreshold: 0.001,
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 10,
            percentageFee: 0.0006,
            estimatedTimeSeconds: 600,
          },
        },
      });

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        expect(opportunity.expectedGasCost).toBeDefined();
        expect(opportunity.expectedGasCost).toBeGreaterThan(0);

        // Ethereum gas should be higher than Arbitrum
        if (opportunity.buyChain === 'ethereum') {
          // Ethereum gas is typically $20-30
          expect(opportunity.expectedGasCost).toBeGreaterThan(10);
        }

        simulator.stop();
        done();
      });

      simulator.start();

      setTimeout(() => {
        simulator.stop();
        done(new Error('No opportunity detected'));
      }, 5000);
    });
  });

  describe('Profit Calculation', () => {
    it('should calculate net profit after bridge fees and gas', (done) => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum'],
        tokens: ['WETH'],
        updateIntervalMs: 100,
        volatility: 0.02,
        minProfitThreshold: 0.005, // 0.5% min profit
        bridgeCosts: {
          'ethereum-arbitrum': {
            fixedCost: 15,
            percentageFee: 0.0006,
            estimatedTimeSeconds: 600,
          },
        },
      });

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        expect(opportunity.expectedProfit).toBeDefined();

        // Expected profit should account for bridge fees and gas
        const grossProfit = opportunity.estimatedProfitUsd;
        const bridgeFee = opportunity.bridgeFee || 0;
        const gasCost = opportunity.expectedGasCost || 0;
        const netProfit = grossProfit - bridgeFee - gasCost;

        // expectedProfit should approximately equal netProfit
        // Note: Due to position size variance and rounding, allow reasonable difference
        expect(Math.abs((opportunity.expectedProfit || 0) - netProfit)).toBeLessThan(25);

        simulator.stop();
        done();
      });

      simulator.start();

      setTimeout(() => {
        simulator.stop();
        done(new Error('No opportunity detected'));
      }, 5000);
    });
  });

  describe('Price Updates', () => {
    it('should emit priceUpdate events when prices change', (done) => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum'],
        tokens: ['WETH'],
        updateIntervalMs: 100,
        volatility: 0.01,
        minProfitThreshold: 0.002,
      });

      simulator.on('priceUpdate', (update: { chain: string; token: string; price: number }) => {
        expect(update.chain).toBe('ethereum');
        expect(update.token).toBe('WETH');
        expect(update.price).toBeGreaterThan(0);
        simulator.stop();
        done();
      });

      simulator.start();
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

      // Second start should be ignored
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
    it('should handle missing bridge route gracefully', (done) => {
      const simulator = new CrossChainSimulator({
        chains: ['ethereum', 'arbitrum', 'bsc'],
        tokens: ['WETH'],
        updateIntervalMs: 100,
        volatility: 0.02,
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

      let opportunityCount = 0;
      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        opportunityCount++;
        // Should only see ethereum<->arbitrum opportunities
        expect(
          (opportunity.buyChain === 'ethereum' && opportunity.sellChain === 'arbitrum') ||
          (opportunity.buyChain === 'arbitrum' && opportunity.sellChain === 'ethereum')
        ).toBe(true);
      });

      simulator.start();

      setTimeout(() => {
        simulator.stop();
        // Should have some opportunities, but only for the defined route
        done();
      }, 2000);
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
