/**
 * Simulated Price Generator Unit Tests
 *
 * Tests for Phase 3, Task 3.1 implementation.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  SimulatedPriceGenerator,
  createSimulatedPriceGenerator,
  generateSimplePriceSequence,
  generateArbitrageTestData,
  GeneratedPrice,
} from '@arbitrage/test-utils';

describe('SimulatedPriceGenerator', () => {
  let generator: SimulatedPriceGenerator;

  beforeEach(() => {
    generator = new SimulatedPriceGenerator();
  });

  describe('generatePriceSequence', () => {
    it('should generate correct number of prices', () => {
      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 50,
      });

      expect(prices.length).toBe(50);
    });

    it('should maintain prices around base price', () => {
      const basePrice = 2000;
      const prices = generator.generatePriceSequence({
        basePrice,
        volatility: 0.02,
        count: 100,
      });

      const avgPrice = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;

      // Average should be within range of base (Gaussian walk drifts without mean reversion)
      // Relaxed bounds: 100-step random walk can drift significantly
      expect(avgPrice).toBeGreaterThan(basePrice * 0.6);
      expect(avgPrice).toBeLessThan(basePrice * 1.4);
    });

    it('should include sequential indices', () => {
      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 10,
      });

      for (let i = 0; i < prices.length; i++) {
        expect(prices[i].index).toBe(i);
      }
    });

    it('should calculate change percentage from previous price', () => {
      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 10,
      });

      // First price should have 0% change
      expect(prices[0].changePercent).toBe(0);

      // Subsequent prices should have calculated change
      for (let i = 1; i < prices.length; i++) {
        const expectedChange = ((prices[i].price - prices[i - 1].price) / prices[i - 1].price) * 100;
        expect(prices[i].changePercent).toBeCloseTo(expectedChange, 5);
      }
    });

    it('should mark whale moves correctly', () => {
      // High whale chance for testing
      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 100,
        whaleChance: 0.5, // 50% chance
        whaleMagnitude: 0.05,
      });

      const whaleMoves = prices.filter((p) => p.isWhaleMove);

      // Should have some whale moves with 50% chance
      expect(whaleMoves.length).toBeGreaterThan(20);
    });

    it('should mark arbitrage points correctly', () => {
      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 100,
        arbitrageChance: 0.3, // 30% chance
        spreadPercent: 0.02,
      });

      const arbitragePoints = prices.filter((p) => p.isArbitragePoint);

      // Should have some arbitrage points with 30% chance
      expect(arbitragePoints.length).toBeGreaterThan(10);
    });

    it('should set correct DEX and chain', () => {
      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 5,
        dex: 'sushiswap',
        chain: 'arbitrum',
        pair: 'WETH/USDC',
      });

      for (const price of prices) {
        expect(price.dex).toBe('sushiswap');
        expect(price.chain).toBe('arbitrum');
        expect(price.pairKey).toBe('WETH/USDC');
      }
    });

    it('should generate timestamps with correct intervals', () => {
      const startTimestamp = Date.now();
      const intervalMs = 500;

      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 5,
        startTimestamp,
        intervalMs,
      });

      for (let i = 0; i < prices.length; i++) {
        expect(prices[i].timestamp).toBe(startTimestamp + i * intervalMs);
      }
    });

    it('should generate sequential block numbers', () => {
      const startBlock = 18500000;

      const prices = generator.generatePriceSequence({
        basePrice: 2000,
        volatility: 0.02,
        count: 5,
        startBlock,
      });

      for (let i = 0; i < prices.length; i++) {
        expect(prices[i].blockNumber).toBe(startBlock + i);
      }
    });

    it('should never generate negative prices', () => {
      // High volatility to test edge cases
      const prices = generator.generatePriceSequence({
        basePrice: 1, // Very low base
        volatility: 0.5, // 50% volatility
        count: 100,
      });

      for (const price of prices) {
        expect(price.price).toBeGreaterThan(0);
      }
    });
  });

  describe('generateMultiDexPrices', () => {
    it('should generate prices for all specified DEXs', () => {
      const result = generator.generateMultiDexPrices({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum' },
          { name: 'sushiswap', chain: 'ethereum' },
          { name: 'pancakeswap', chain: 'bsc' },
        ],
        basePrice: 2000,
        correlationFactor: 0.9,
        count: 10,
      });

      expect(result.size).toBe(3);
      expect(result.has('uniswap_v3')).toBe(true);
      expect(result.has('sushiswap')).toBe(true);
      expect(result.has('pancakeswap')).toBe(true);
    });

    it('should generate correct number of prices per DEX', () => {
      const count = 25;
      const result = generator.generateMultiDexPrices({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum' },
          { name: 'sushiswap', chain: 'ethereum' },
        ],
        basePrice: 2000,
        correlationFactor: 0.9,
        count,
      });

      expect(result.get('uniswap_v3')!.length).toBe(count);
      expect(result.get('sushiswap')!.length).toBe(count);
    });

    it('should maintain price correlation across DEXs', () => {
      const result = generator.generateMultiDexPrices({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum' },
          { name: 'sushiswap', chain: 'ethereum' },
        ],
        basePrice: 2000,
        correlationFactor: 0.99, // Very high correlation
        count: 100,
        volatility: 0.01,
      });

      const uniswapPrices = result.get('uniswap_v3')!;
      const sushiPrices = result.get('sushiswap')!;

      // Calculate average spread between DEXs
      let totalSpread = 0;
      for (let i = 0; i < uniswapPrices.length; i++) {
        const spread = Math.abs(uniswapPrices[i].price - sushiPrices[i].price) / uniswapPrices[i].price;
        totalSpread += spread;
      }
      const avgSpread = totalSpread / uniswapPrices.length;

      // With 99% correlation, spread should be small (< 2%)
      expect(avgSpread).toBeLessThan(0.02);
    });

    it('should create divergence at expected rate', () => {
      const result = generator.generateMultiDexPrices({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum' },
          { name: 'sushiswap', chain: 'ethereum' },
        ],
        basePrice: 2000,
        correlationFactor: 0.9,
        count: 100,
        divergenceChance: 0.3, // 30% chance
      });

      const sushiPrices = result.get('sushiswap')!;
      const divergentCount = sushiPrices.filter((p) => p.isArbitragePoint).length;

      // Should have roughly 30% divergent points (with variance)
      expect(divergentCount).toBeGreaterThan(10);
      expect(divergentCount).toBeLessThan(60);
    });

    it('should apply latency offset to timestamps', () => {
      const latencyOffset = 100;

      const result = generator.generateMultiDexPrices({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum', latencyOffset: 0 },
          { name: 'pancakeswap', chain: 'bsc', latencyOffset },
        ],
        basePrice: 2000,
        correlationFactor: 0.9,
        count: 5,
      });

      const uniswapPrices = result.get('uniswap_v3')!;
      const pancakePrices = result.get('pancakeswap')!;

      for (let i = 0; i < uniswapPrices.length; i++) {
        const timestampDiff = pancakePrices[i].timestamp - uniswapPrices[i].timestamp;
        expect(timestampDiff).toBe(latencyOffset);
      }
    });
  });

  describe('generateMultiDexSnapshots', () => {
    it('should generate snapshots with correct structure', () => {
      const snapshots = generator.generateMultiDexSnapshots({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum' },
          { name: 'sushiswap', chain: 'ethereum' },
        ],
        basePrice: 2000,
        correlationFactor: 0.9,
        count: 10,
      });

      expect(snapshots.length).toBe(10);

      for (const snapshot of snapshots) {
        expect(snapshot.timestamp).toBeGreaterThan(0);
        expect(snapshot.blockNumber).toBeGreaterThan(0);
        expect(snapshot.prices.size).toBe(2);
        expect(typeof snapshot.maxSpread).toBe('number');
        expect(typeof snapshot.hasArbitrage).toBe('boolean');
      }
    });

    it('should calculate max spread correctly', () => {
      // Force high divergence for testing
      const snapshots = generator.generateMultiDexSnapshots({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum' },
          { name: 'sushiswap', chain: 'ethereum' },
        ],
        basePrice: 2000,
        correlationFactor: 0.5, // Low correlation = high spread
        count: 50,
        divergenceChance: 0.5,
        divergenceMagnitude: 0.05,
      });

      // At least some snapshots should have noticeable spread
      const spreads = snapshots.map((s) => s.maxSpread);
      const maxSpread = Math.max(...spreads);

      expect(maxSpread).toBeGreaterThan(0);
    });

    it('should flag arbitrage opportunities correctly', () => {
      const snapshots = generator.generateMultiDexSnapshots({
        dexes: [
          { name: 'uniswap_v3', chain: 'ethereum' },
          { name: 'sushiswap', chain: 'ethereum' },
        ],
        basePrice: 2000,
        correlationFactor: 0.7,
        count: 100,
        divergenceChance: 0.3,
        divergenceMagnitude: 0.03, // 3% divergence should create >0.5% spread
      });

      // Some snapshots should have arbitrage
      const arbitrageSnapshots = snapshots.filter((s) => s.hasArbitrage);

      // With forced divergence, should have some arbitrage opportunities
      expect(arbitrageSnapshots.length).toBeGreaterThan(0);
    });
  });

  describe('generateWhaleSpike', () => {
    it('should generate pre-spike stable period', () => {
      const prices = generator.generateWhaleSpike({
        basePrice: 2000,
        spikeMagnitude: 0.1,
        recoverySteps: 5,
      });

      // First 5 prices should be stable (within 0.5% of base)
      for (let i = 0; i < 5; i++) {
        const deviation = Math.abs(prices[i].price - 2000) / 2000;
        expect(deviation).toBeLessThan(0.005);
      }
    });

    it('should generate spike with correct magnitude', () => {
      const basePrice = 2000;
      const spikeMagnitude = 0.1; // 10% spike

      const prices = generator.generateWhaleSpike({
        basePrice,
        spikeMagnitude,
        recoverySteps: 5,
      });

      // Spike is at index 5
      const spikePrice = prices[5].price;
      const expectedSpike = basePrice * (1 + spikeMagnitude);

      expect(spikePrice).toBeCloseTo(expectedSpike, 0);
    });

    it('should mark spike as whale move and arbitrage point', () => {
      const prices = generator.generateWhaleSpike({
        basePrice: 2000,
        spikeMagnitude: 0.1,
        recoverySteps: 5,
      });

      // Spike is at index 5
      expect(prices[5].isWhaleMove).toBe(true);
      expect(prices[5].isArbitragePoint).toBe(true);
    });

    it('should recover to base price after spike', () => {
      const basePrice = 2000;

      const prices = generator.generateWhaleSpike({
        basePrice,
        spikeMagnitude: 0.1,
        recoverySteps: 10,
      });

      // Last price should be near base (within noise)
      const lastPrice = prices[prices.length - 1].price;
      const deviation = Math.abs(lastPrice - basePrice) / basePrice;

      expect(deviation).toBeLessThan(0.02); // Within 2%
    });

    it('should have correct total length', () => {
      const recoverySteps = 10;

      const prices = generator.generateWhaleSpike({
        basePrice: 2000,
        spikeMagnitude: 0.1,
        recoverySteps,
      });

      // 5 pre-spike + 1 spike + recoverySteps
      expect(prices.length).toBe(5 + 1 + recoverySteps);
    });
  });

  describe('generateCrossChainArbitrage', () => {
    it('should generate prices for all chains', () => {
      const result = generator.generateCrossChainArbitrage({
        basePrice: 2000,
        spreadPercent: 0.02,
        chains: [
          { chain: 'ethereum', dex: 'uniswap_v3' },
          { chain: 'bsc', dex: 'pancakeswap' },
          { chain: 'arbitrum', dex: 'sushiswap' },
        ],
      });

      expect(result.size).toBe(3);
      expect(result.has('ethereum:uniswap_v3')).toBe(true);
      expect(result.has('bsc:pancakeswap')).toBe(true);
      expect(result.has('arbitrum:sushiswap')).toBe(true);
    });

    it('should set first chain at base price', () => {
      const basePrice = 2000;

      const result = generator.generateCrossChainArbitrage({
        basePrice,
        spreadPercent: 0.02,
        chains: [
          { chain: 'ethereum', dex: 'uniswap_v3' },
          { chain: 'bsc', dex: 'pancakeswap' },
        ],
      });

      const ethPrice = result.get('ethereum:uniswap_v3')!;
      expect(ethPrice.price).toBe(basePrice);
    });

    it('should create increasing spread across chains', () => {
      const basePrice = 2000;
      const spreadPercent = 0.02; // 2%

      const result = generator.generateCrossChainArbitrage({
        basePrice,
        spreadPercent,
        chains: [
          { chain: 'ethereum', dex: 'uniswap_v3' },
          { chain: 'bsc', dex: 'pancakeswap' },
          { chain: 'arbitrum', dex: 'sushiswap' },
        ],
      });

      const ethPrice = result.get('ethereum:uniswap_v3')!.price;
      const bscPrice = result.get('bsc:pancakeswap')!.price;
      const arbPrice = result.get('arbitrum:sushiswap')!.price;

      // Prices should increase
      expect(bscPrice).toBeGreaterThan(ethPrice);
      expect(arbPrice).toBeGreaterThan(bscPrice);

      // Spreads should match expected
      expect(bscPrice).toBeCloseTo(basePrice * (1 + spreadPercent), 2);
      expect(arbPrice).toBeCloseTo(basePrice * (1 + spreadPercent * 2), 2);
    });

    it('should mark non-first chains as arbitrage points', () => {
      const result = generator.generateCrossChainArbitrage({
        basePrice: 2000,
        spreadPercent: 0.02,
        chains: [
          { chain: 'ethereum', dex: 'uniswap_v3' },
          { chain: 'bsc', dex: 'pancakeswap' },
        ],
      });

      const ethPrice = result.get('ethereum:uniswap_v3')!;
      const bscPrice = result.get('bsc:pancakeswap')!;

      expect(ethPrice.isArbitragePoint).toBe(false);
      expect(bscPrice.isArbitragePoint).toBe(true);
    });
  });

  describe('Factory Functions', () => {
    describe('createSimulatedPriceGenerator', () => {
      it('should create generator instance', () => {
        const gen = createSimulatedPriceGenerator();
        expect(gen).toBeInstanceOf(SimulatedPriceGenerator);
      });

      it('should accept seed parameter', () => {
        const gen = createSimulatedPriceGenerator(12345);
        expect(gen).toBeInstanceOf(SimulatedPriceGenerator);
      });
    });

    describe('generateSimplePriceSequence', () => {
      it('should generate sequence with defaults', () => {
        const prices = generateSimplePriceSequence(2000, 10);

        expect(prices.length).toBe(10);
        expect(prices[0].price).toBeGreaterThan(0);
      });

      it('should accept optional overrides', () => {
        const prices = generateSimplePriceSequence(2000, 10, {
          dex: 'sushiswap',
          chain: 'arbitrum',
        });

        expect(prices[0].dex).toBe('sushiswap');
        expect(prices[0].chain).toBe('arbitrum');
      });
    });

    describe('generateArbitrageTestData', () => {
      it('should generate low and high price pair', () => {
        const { lowPrice, highPrice } = generateArbitrageTestData({
          basePrice: 2000,
          spreadPercent: 0.02,
        });

        expect(lowPrice.price).toBeLessThan(highPrice.price);
      });

      it('should create correct spread', () => {
        const basePrice = 2000;
        const spreadPercent = 0.05; // 5%

        const { lowPrice, highPrice } = generateArbitrageTestData({
          basePrice,
          spreadPercent,
        });

        const actualSpread = (highPrice.price - lowPrice.price) / lowPrice.price;
        expect(actualSpread).toBeCloseTo(spreadPercent, 5);
      });

      it('should use specified DEXs', () => {
        const { lowPrice, highPrice } = generateArbitrageTestData({
          basePrice: 2000,
          spreadPercent: 0.02,
          dex1: 'curve',
          dex2: 'balancer',
        });

        expect(lowPrice.dex).toBe('curve');
        expect(highPrice.dex).toBe('balancer');
      });

      it('should mark both as arbitrage points', () => {
        const { lowPrice, highPrice } = generateArbitrageTestData({
          basePrice: 2000,
          spreadPercent: 0.02,
        });

        expect(lowPrice.isArbitragePoint).toBe(true);
        expect(highPrice.isArbitragePoint).toBe(true);
      });
    });
  });
});
