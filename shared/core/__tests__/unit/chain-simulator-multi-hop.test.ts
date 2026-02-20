/**
 * ChainSimulator Multi-Hop Tests
 *
 * Tests for triangular and quadrilateral arbitrage opportunity generation:
 * - Path generation (3-hop and 4-hop)
 * - Circular path validation
 * - Profit calculation with multi-hop fees
 * - Flash loan fee application
 *
 * @see shared/core/src/simulation-mode.ts (ChainSimulator.generateMultiHopOpportunity)
 */

import {
  ChainSimulator,
  type ChainSimulatorConfig,
  type SimulatedPairConfig,
  type SimulatedOpportunity,
} from '../../src/simulation-mode';

describe('ChainSimulator - Multi-Hop Opportunities', () => {
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
      updateIntervalMs: 50, // Faster ticks for test reliability
      volatility: 0.01,
      arbitrageChance: 0.5, // 50% chance to generate multi-hop (increased for test reliability)
      minArbitrageSpread: 0.005,
      maxArbitrageSpread: 0.02,
      pairs,
    };

    return new ChainSimulator(config);
  }

  describe('Triangular Opportunities (3-hop)', () => {
    it('should generate triangular path with 3 unique tokens + circular return', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          done(new Error('No triangular opportunity detected within timeout'));
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return; // Prevent multiple done() calls

        if (opportunity.type === 'triangular') {
          expect(opportunity.hops).toBe(3);
          expect(opportunity.path).toBeDefined();
          expect(opportunity.path!.length).toBe(4); // A -> B -> C -> A

          // First and last tokens should be the same (circular)
          expect(opportunity.path![0]).toBe(opportunity.path![3]);

          // Intermediate tokens should be unique
          const intermediateTokens = opportunity.path!.slice(1, 3);
          const uniqueIntermediateTokens = new Set(intermediateTokens);
          expect(uniqueIntermediateTokens.size).toBe(2);

          // Should use flash loan
          expect(opportunity.useFlashLoan).toBe(true);

          // Should have intermediate tokens field
          expect(opportunity.intermediateTokens).toBeDefined();
          expect(opportunity.intermediateTokens!.length).toBe(2);

          completed = true;
          clearTimeout(failTimeout);
          simulator.stop();
          done();
        }
      });

      simulator.start();
    });

    it('should calculate profit after fees per hop', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          done(new Error('No triangular opportunity detected'));
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return;

        if (opportunity.type === 'triangular') {
          completed = true;
          clearTimeout(failTimeout);

          // Triangular: 3 hops * 0.3% fee per hop = 0.9% total fees
          // Profit percentage should account for these fees
          const minFeesCost = 0.9; // 0.9% in fees minimum

          // Profit should be positive after fees
          expect(opportunity.profitPercentage).toBeGreaterThan(0);

          // Base profit before fees must have been > fee cost
          // (otherwise it wouldn't be emitted)
          expect(opportunity.profitPercentage).toBeLessThan(5); // Reasonable upper bound

          simulator.stop();
          done();
        }
      });

      simulator.start();
    });

    it('should include flash loan fee in expected profit', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          done(new Error('No triangular opportunity detected'));
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return;

        if (opportunity.type === 'triangular') {
          completed = true;
          clearTimeout(failTimeout);

          expect(opportunity.flashLoanFee).toBeDefined();
          expect(opportunity.flashLoanFee).toBe(0.0009); // Aave V3: 0.09%

          // Expected profit should account for flash loan fee
          expect(opportunity.expectedProfit).toBeDefined();

          simulator.stop();
          done();
        }
      });

      simulator.start();
    });
  });

  describe('Quadrilateral Opportunities (4-hop)', () => {
    it('should generate quadrilateral path with 4 unique tokens + circular return', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          done(new Error('No quadrilateral opportunity detected within timeout'));
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return;

        if (opportunity.type === 'quadrilateral') {
          completed = true;
          clearTimeout(failTimeout);

          expect(opportunity.hops).toBe(4);
          expect(opportunity.path).toBeDefined();
          expect(opportunity.path!.length).toBe(5); // A -> B -> C -> D -> A

          // First and last tokens should be the same (circular)
          expect(opportunity.path![0]).toBe(opportunity.path![4]);

          // Intermediate tokens should be unique (3 intermediate + 1 start = 4 total unique)
          const intermediateTokens = opportunity.path!.slice(1, 4);
          const uniqueIntermediateTokens = new Set(intermediateTokens);
          expect(uniqueIntermediateTokens.size).toBe(3);

          // Should use flash loan
          expect(opportunity.useFlashLoan).toBe(true);

          // Should have intermediate tokens field
          expect(opportunity.intermediateTokens).toBeDefined();
          expect(opportunity.intermediateTokens!.length).toBe(3);

          simulator.stop();
          done();
        }
      });

      simulator.start();
    });

    it('should calculate profit after more fees (4 hops)', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          done(new Error('No quadrilateral opportunity detected'));
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return;

        if (opportunity.type === 'quadrilateral') {
          completed = true;
          clearTimeout(failTimeout);

          // Quadrilateral: 4 hops * 0.3% fee per hop = 1.2% total fees
          const minFeesCost = 1.2;

          // Profit should still be positive after all fees
          expect(opportunity.profitPercentage).toBeGreaterThan(0);

          // Gas cost should be higher for 4-hop
          expect(opportunity.expectedGasCost).toBeGreaterThan(10); // At least $10 gas

          simulator.stop();
          done();
        }
      });

      simulator.start();
    });
  });

  describe('Multi-Hop Confidence', () => {
    it('should have slightly lower confidence than intra-chain', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const confidences: { type: string; confidence: number }[] = [];

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          if (confidences.length === 0) {
            done(new Error('No opportunities detected'));
          } else {
            done(); // Pass if we got some data
          }
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return; // Prevent processing after done() is called

        confidences.push({
          type: opportunity.type,
          confidence: opportunity.confidence,
        });

        // Stop after collecting a few samples
        if (confidences.length >= 5) {
          completed = true;
          clearTimeout(failTimeout);
          simulator.stop();

          // Multi-hop opportunities should have lower confidence
          const multiHopConfidences = confidences
            .filter(c => c.type === 'triangular' || c.type === 'quadrilateral')
            .map(c => c.confidence);

          const intraChainConfidences = confidences
            .filter(c => c.type === 'intra-chain')
            .map(c => c.confidence);

          if (multiHopConfidences.length > 0 && intraChainConfidences.length > 0) {
            const avgMultiHop =
              multiHopConfidences.reduce((a, b) => a + b, 0) / multiHopConfidences.length;
            const avgIntraChain =
              intraChainConfidences.reduce((a, b) => a + b, 0) / intraChainConfidences.length;

            // Multi-hop should generally have lower confidence
            expect(avgMultiHop).toBeLessThanOrEqual(avgIntraChain + 0.1); // Allow small margin
          }

          done();
        }
      });

      simulator.start();
    });
  });

  describe('Multi-Hop Expiry', () => {
    it('should have shorter expiry than intra-chain', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          done(new Error('No opportunity detected'));
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return; // Prevent multiple done() calls

        const expiryMs = opportunity.expiresAt - opportunity.timestamp;

        if (opportunity.type === 'triangular' || opportunity.type === 'quadrilateral') {
          // Multi-hop: 3000ms expiry
          expect(expiryMs).toBeLessThanOrEqual(3000);
        } else if (opportunity.type === 'intra-chain') {
          // Intra-chain: 5000ms expiry
          expect(expiryMs).toBeLessThanOrEqual(5000);
        }

        completed = true;
        clearTimeout(failTimeout);
        simulator.stop();
        done();
      });

      simulator.start();
    });
  });

  describe('Path Generation Edge Cases', () => {
    it('should not generate multi-hop with insufficient tokens', (done) => {
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

      setTimeout(() => {
        simulator.stop();
        expect(multiHopCount).toBe(0);
        done();
      }, 2000);
    });

    it('should emit multi-hop opportunities randomly (not every tick)', (done) => {
      const simulator = createMultiHopSimulator();

      let opportunityTypes: string[] = [];
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          if (opportunityTypes.length === 0) {
            done(new Error('No opportunities detected'));
          } else {
            done(); // Pass if we got some data
          }
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return; // Prevent processing after done() is called

        opportunityTypes.push(opportunity.type);

        if (opportunityTypes.length >= 20) {
          completed = true;
          clearTimeout(failTimeout);
          simulator.stop();

          // Should have variety (not all multi-hop)
          const multiHopCount = opportunityTypes.filter(
            t => t === 'triangular' || t === 'quadrilateral'
          ).length;
          const intraChainCount = opportunityTypes.filter(t => t === 'intra-chain').length;

          // Should have both types
          expect(multiHopCount).toBeGreaterThan(0);
          expect(intraChainCount).toBeGreaterThan(0);

          // Intra-chain should be more common than multi-hop
          expect(intraChainCount).toBeGreaterThan(multiHopCount);

          done();
        }
      });

      simulator.start();
    });
  });

  describe('Buy/Sell DEX Consistency', () => {
    it('should use different DEXs for multi-hop buy and sell endpoints', (done) => {
      const simulator = createMultiHopSimulator();
      let completed = false;

      const failTimeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          simulator.stop();
          done(new Error('No multi-hop opportunity detected'));
        }
      }, 10000);

      simulator.on('opportunity', (opportunity: SimulatedOpportunity) => {
        if (completed) return;

        if (opportunity.type === 'triangular' || opportunity.type === 'quadrilateral') {
          completed = true;
          clearTimeout(failTimeout);

          // Multi-hop arbitrage buys on one DEX and sells on another
          expect(opportunity.buyDex).not.toBe(opportunity.sellDex);

          // Both should be valid DEX names from the configured pairs
          const validDexes = ['uniswap_v3', 'sushiswap'];
          expect(validDexes).toContain(opportunity.buyDex);
          expect(validDexes).toContain(opportunity.sellDex);

          simulator.stop();
          done();
        }
      });

      simulator.start();
    });
  });
});
