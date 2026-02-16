/**
 * Simulated Price Generator
 *
 * Phase 3, Task 3.1: Generate realistic price data that mimics production patterns.
 *
 * Features:
 * - Normal distribution around base price (Gaussian random walk)
 * - Occasional large moves (whale activity simulation)
 * - Cross-DEX price divergence (arbitrage opportunities)
 * - Correlated multi-DEX prices with occasional divergence
 * - Configurable volatility and spread parameters
 *
 * @see docs/research/INTEGRATION_TEST_COVERAGE_REPORT.md Phase 3, Task 3.1
 */

import { PriceUpdate, createPriceUpdate } from '../factories/price-update.factory';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for generating a price sequence.
 */
export interface PriceSequenceConfig {
  /** Base price around which to generate variations */
  basePrice: number;
  /** Standard deviation as percentage (e.g., 0.02 = 2%) */
  volatility: number;
  /** Number of price points to generate */
  count: number;
  /** Probability of creating an arbitrage spread (0-1) */
  arbitrageChance?: number;
  /** Spread percentage when arbitrage occurs (e.g., 0.02 = 2%) */
  spreadPercent?: number;
  /** Probability of a whale move (0-1) */
  whaleChance?: number;
  /** Whale move magnitude as percentage */
  whaleMagnitude?: number;
  /** DEX name */
  dex?: string;
  /** Chain name */
  chain?: string;
  /** Token pair (e.g., "WETH/USDC") */
  pair?: string;
  /** Starting timestamp (defaults to now) */
  startTimestamp?: number;
  /** Time between price points in ms */
  intervalMs?: number;
  /** Starting block number */
  startBlock?: number;
}

/**
 * Configuration for generating correlated multi-DEX prices.
 */
export interface MultiDexPriceConfig {
  /** DEX configurations */
  dexes: Array<{
    name: string;
    chain: string;
    /** Base latency offset in ms (simulates slower DEXs) */
    latencyOffset?: number;
  }>;
  /** Base price for all DEXs */
  basePrice: number;
  /** How closely prices track (0-1, 1 = perfectly correlated) */
  correlationFactor: number;
  /** Number of price points per DEX */
  count: number;
  /** Individual DEX volatility */
  volatility?: number;
  /** Chance of creating divergence for arbitrage */
  divergenceChance?: number;
  /** Magnitude of divergence when it occurs */
  divergenceMagnitude?: number;
  /** Token pair */
  pair?: string;
  /** Time interval between updates */
  intervalMs?: number;
}

/**
 * Generated price with additional metadata.
 */
export interface GeneratedPrice extends PriceUpdate {
  /** Index in the sequence */
  index: number;
  /** Whether this is an arbitrage opportunity point */
  isArbitragePoint: boolean;
  /** Whether this is a whale movement */
  isWhaleMove: boolean;
  /** Price change from previous point as percentage */
  changePercent: number;
}

/**
 * Multi-DEX price snapshot at a point in time.
 */
export interface MultiDexSnapshot {
  timestamp: number;
  blockNumber: number;
  prices: Map<string, GeneratedPrice>;
  /** Maximum price spread across DEXs as percentage */
  maxSpread: number;
  /** Whether arbitrage opportunity exists at this point */
  hasArbitrage: boolean;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a random number from a normal distribution using Box-Muller transform.
 */
function gaussianRandom(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * stdDev;
}

/**
 * Calculate percentage change between two values.
 */
function percentChange(oldValue: number, newValue: number): number {
  return ((newValue - oldValue) / oldValue) * 100;
}

// =============================================================================
// SimulatedPriceGenerator Class
// =============================================================================

/**
 * Generates realistic price data for testing arbitrage detection systems.
 *
 * Usage:
 * ```typescript
 * const generator = new SimulatedPriceGenerator();
 *
 * // Generate a simple price sequence
 * const prices = generator.generatePriceSequence({
 *   basePrice: 2000,
 *   volatility: 0.02,
 *   count: 100,
 *   arbitrageChance: 0.1,
 *   spreadPercent: 0.02
 * });
 *
 * // Generate correlated multi-DEX prices
 * const multiDex = generator.generateMultiDexPrices({
 *   dexes: [
 *     { name: 'uniswap_v3', chain: 'ethereum' },
 *     { name: 'sushiswap', chain: 'ethereum' },
 *     { name: 'pancakeswap', chain: 'bsc' }
 *   ],
 *   basePrice: 2000,
 *   correlationFactor: 0.95,
 *   count: 50
 * });
 * ```
 */
export class SimulatedPriceGenerator {
  private seed: number;

  constructor(seed?: number) {
    this.seed = seed ?? Date.now();
  }

  /**
   * Generate a sequence of price updates with realistic patterns.
   *
   * Features:
   * - Gaussian random walk around base price
   * - Occasional large whale movements
   * - Configurable volatility
   * - Arbitrage opportunity injection
   */
  generatePriceSequence(config: PriceSequenceConfig): GeneratedPrice[] {
    const {
      basePrice,
      volatility,
      count,
      arbitrageChance = 0,
      spreadPercent = 0.02,
      whaleChance = 0.01,
      whaleMagnitude = 0.05,
      dex = 'uniswap_v3',
      chain = 'ethereum',
      pair = 'WETH/USDC',
      startTimestamp = Date.now(),
      intervalMs = 1000,
      startBlock = 18500000,
    } = config;

    const prices: GeneratedPrice[] = [];
    let currentPrice = basePrice;

    for (let i = 0; i < count; i++) {
      const isWhaleMove = Math.random() < whaleChance;
      const isArbitragePoint = Math.random() < arbitrageChance;

      // Calculate price movement
      let priceChange: number;

      if (isWhaleMove) {
        // Large directional move (whale activity)
        const direction = Math.random() > 0.5 ? 1 : -1;
        priceChange = currentPrice * whaleMagnitude * direction;
      } else {
        // Normal volatility (Gaussian random walk)
        const stdDev = currentPrice * volatility;
        priceChange = gaussianRandom(0, stdDev);
      }

      // Apply arbitrage spread if this is an arbitrage point
      if (isArbitragePoint) {
        const spreadDirection = Math.random() > 0.5 ? 1 : -1;
        priceChange += currentPrice * spreadPercent * spreadDirection;
      }

      const previousPrice = currentPrice;
      currentPrice = Math.max(0.01, currentPrice + priceChange); // Prevent negative prices

      const priceUpdate = createPriceUpdate({
        dex,
        chain,
        pairKey: pair,
        price: currentPrice,
        timestamp: startTimestamp + i * intervalMs,
        blockNumber: startBlock + i,
      });

      prices.push({
        ...priceUpdate,
        index: i,
        isArbitragePoint,
        isWhaleMove,
        changePercent: i === 0 ? 0 : percentChange(previousPrice, currentPrice),
      });
    }

    return prices;
  }

  /**
   * Generate correlated prices across multiple DEXs.
   *
   * Features:
   * - Base price shared across DEXs (with correlation factor)
   * - Individual DEX noise for realism
   * - Configurable divergence for arbitrage testing
   * - Latency simulation for cross-chain scenarios
   */
  generateMultiDexPrices(config: MultiDexPriceConfig): Map<string, GeneratedPrice[]> {
    const {
      dexes,
      basePrice,
      correlationFactor,
      count,
      volatility = 0.01,
      divergenceChance = 0.05,
      divergenceMagnitude = 0.02,
      pair = 'WETH/USDC',
      intervalMs = 1000,
    } = config;

    const result = new Map<string, GeneratedPrice[]>();
    const startTimestamp = Date.now();
    const startBlock = 18500000;

    // Generate base price sequence (shared market movement)
    const basePrices: number[] = [];
    let currentBase = basePrice;

    for (let i = 0; i < count; i++) {
      const baseChange = gaussianRandom(0, currentBase * volatility);
      currentBase = Math.max(0.01, currentBase + baseChange);
      basePrices.push(currentBase);
    }

    // Generate prices for each DEX with correlation
    for (const dexConfig of dexes) {
      const dexPrices: GeneratedPrice[] = [];
      let previousPrice = basePrice;

      for (let i = 0; i < count; i++) {
        // Correlated base price
        const correlatedPrice = basePrices[i];

        // Individual DEX noise (uncorrelated component)
        const uncorrelatedNoise = gaussianRandom(0, correlatedPrice * volatility * 0.5);

        // Apply correlation factor
        // price = correlationFactor * base + (1 - correlationFactor) * (base + noise)
        let dexPrice = correlationFactor * correlatedPrice +
          (1 - correlationFactor) * (correlatedPrice + uncorrelatedNoise);

        // Check for divergence (arbitrage opportunity)
        const isDivergent = Math.random() < divergenceChance;
        if (isDivergent) {
          const divergenceDirection = Math.random() > 0.5 ? 1 : -1;
          dexPrice *= (1 + divergenceMagnitude * divergenceDirection);
        }

        dexPrice = Math.max(0.01, dexPrice);

        const timestamp = startTimestamp + i * intervalMs + (dexConfig.latencyOffset ?? 0);

        const priceUpdate = createPriceUpdate({
          dex: dexConfig.name,
          chain: dexConfig.chain,
          pairKey: pair,
          price: dexPrice,
          timestamp,
          blockNumber: startBlock + i,
        });

        dexPrices.push({
          ...priceUpdate,
          index: i,
          isArbitragePoint: isDivergent,
          isWhaleMove: false,
          changePercent: i === 0 ? 0 : percentChange(previousPrice, dexPrice),
        });

        previousPrice = dexPrice;
      }

      result.set(dexConfig.name, dexPrices);
    }

    return result;
  }

  /**
   * Generate snapshots of multi-DEX prices at each time point.
   * Useful for testing arbitrage detection across DEXs.
   */
  generateMultiDexSnapshots(config: MultiDexPriceConfig): MultiDexSnapshot[] {
    const multiDexPrices = this.generateMultiDexPrices(config);
    const snapshots: MultiDexSnapshot[] = [];
    const { count } = config;

    // Get list of DEX names
    const dexNames = Array.from(multiDexPrices.keys());

    for (let i = 0; i < count; i++) {
      const priceMap = new Map<string, GeneratedPrice>();
      let minPrice = Infinity;
      let maxPrice = -Infinity;

      for (const dexName of dexNames) {
        const dexPrices = multiDexPrices.get(dexName)!;
        const price = dexPrices[i];
        priceMap.set(dexName, price);

        if (price.price < minPrice) minPrice = price.price;
        if (price.price > maxPrice) maxPrice = price.price;
      }

      const maxSpread = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : 0;
      const hasArbitrage = maxSpread > 0.5; // >0.5% spread considered arbitrage

      // Get first price for timestamp/block (guaranteed to exist since dexNames is non-empty)
      const firstPrice = priceMap.values().next().value as GeneratedPrice;

      snapshots.push({
        timestamp: firstPrice.timestamp,
        blockNumber: firstPrice.blockNumber,
        prices: priceMap,
        maxSpread,
        hasArbitrage,
      });
    }

    return snapshots;
  }

  /**
   * Generate a price spike scenario for testing whale detection.
   */
  generateWhaleSpike(config: {
    basePrice: number;
    spikeMagnitude: number;
    recoverySteps: number;
    dex?: string;
    chain?: string;
    pair?: string;
  }): GeneratedPrice[] {
    const {
      basePrice,
      spikeMagnitude,
      recoverySteps,
      dex = 'uniswap_v3',
      chain = 'ethereum',
      pair = 'WETH/USDC',
    } = config;

    const prices: GeneratedPrice[] = [];
    const startTimestamp = Date.now();
    const startBlock = 18500000;

    // Pre-spike stable period (5 points)
    for (let i = 0; i < 5; i++) {
      const noise = gaussianRandom(0, basePrice * 0.001);
      const price = basePrice + noise;

      prices.push({
        ...createPriceUpdate({
          dex, chain, pairKey: pair,
          price: price,
          timestamp: startTimestamp + i * 1000,
          blockNumber: startBlock + i,
        }),
        index: i,
        isArbitragePoint: false,
        isWhaleMove: false,
        changePercent: i === 0 ? 0 : percentChange(prices[i - 1].price, price),
      });
    }

    // Spike point
    const spikePrice = basePrice * (1 + spikeMagnitude);
    prices.push({
      ...createPriceUpdate({
        dex, chain, pairKey: pair,
        price: spikePrice,
        timestamp: startTimestamp + 5 * 1000,
        blockNumber: startBlock + 5,
      }),
      index: 5,
      isArbitragePoint: true,
      isWhaleMove: true,
      changePercent: percentChange(prices[4].price, spikePrice),
    });

    // Recovery period
    let currentPrice = spikePrice;
    const recoveryTarget = basePrice;
    const recoveryStep = (spikePrice - recoveryTarget) / recoverySteps;

    for (let i = 0; i < recoverySteps; i++) {
      currentPrice -= recoveryStep;
      const noise = gaussianRandom(0, basePrice * 0.002);
      const price = currentPrice + noise;

      prices.push({
        ...createPriceUpdate({
          dex, chain, pairKey: pair,
          price: price,
          timestamp: startTimestamp + (6 + i) * 1000,
          blockNumber: startBlock + 6 + i,
        }),
        index: 6 + i,
        isArbitragePoint: false,
        isWhaleMove: false,
        changePercent: percentChange(prices[5 + i].price, price),
      });
    }

    return prices;
  }

  /**
   * Generate cross-chain arbitrage scenario with price divergence.
   */
  generateCrossChainArbitrage(config: {
    basePrice: number;
    spreadPercent: number;
    chains: Array<{ chain: string; dex: string }>;
    pair?: string;
  }): Map<string, GeneratedPrice> {
    const {
      basePrice,
      spreadPercent,
      chains,
      pair = 'WETH/USDC',
    } = config;

    const result = new Map<string, GeneratedPrice>();
    const timestamp = Date.now();
    const blockNumber = 18500000;

    // First chain gets base price
    const firstChain = chains[0];
    result.set(`${firstChain.chain}:${firstChain.dex}`, {
      ...createPriceUpdate({
        dex: firstChain.dex,
        chain: firstChain.chain,
        pairKey: pair,
        price: basePrice,
        timestamp,
        blockNumber,
      }),
      index: 0,
      isArbitragePoint: false,
      isWhaleMove: false,
      changePercent: 0,
    });

    // Other chains get increasing spread
    for (let i = 1; i < chains.length; i++) {
      const chainConfig = chains[i];
      const priceOffset = basePrice * spreadPercent * i;
      const price = basePrice + priceOffset;

      result.set(`${chainConfig.chain}:${chainConfig.dex}`, {
        ...createPriceUpdate({
          dex: chainConfig.dex,
          chain: chainConfig.chain,
          pairKey: pair,
          price: price,
          timestamp: timestamp + (i * 50), // Slight timestamp offset
          blockNumber,
        }),
        index: i,
        isArbitragePoint: true,
        isWhaleMove: false,
        changePercent: percentChange(basePrice, price),
      });
    }

    return result;
  }

  /**
   * Reset the generator seed.
   */
  resetSeed(seed?: number): void {
    this.seed = seed ?? Date.now();
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new SimulatedPriceGenerator instance.
 */
export function createSimulatedPriceGenerator(seed?: number): SimulatedPriceGenerator {
  return new SimulatedPriceGenerator(seed);
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Generate a simple price sequence with defaults.
 */
export function generateSimplePriceSequence(
  basePrice: number,
  count: number,
  options: Partial<PriceSequenceConfig> = {}
): GeneratedPrice[] {
  const generator = new SimulatedPriceGenerator();
  return generator.generatePriceSequence({
    basePrice,
    count,
    volatility: 0.02,
    ...options,
  });
}

/**
 * Generate arbitrage test data with guaranteed spread.
 */
export function generateArbitrageTestData(config: {
  basePrice: number;
  spreadPercent: number;
  dex1?: string;
  dex2?: string;
  chain?: string;
}): { lowPrice: GeneratedPrice; highPrice: GeneratedPrice } {
  const {
    basePrice,
    spreadPercent,
    dex1 = 'uniswap_v3',
    dex2 = 'sushiswap',
    chain = 'ethereum',
  } = config;

  const timestamp = Date.now();
  const blockNumber = 18500000;

  const lowPrice: GeneratedPrice = {
    ...createPriceUpdate({
      dex: dex1,
      chain,
      price: basePrice,
      timestamp,
      blockNumber,
    }),
    index: 0,
    isArbitragePoint: true,
    isWhaleMove: false,
    changePercent: 0,
  };

  const highPriceValue = basePrice * (1 + spreadPercent);
  const highPrice: GeneratedPrice = {
    ...createPriceUpdate({
      dex: dex2,
      chain,
      price: highPriceValue,
      timestamp,
      blockNumber,
    }),
    index: 1,
    isArbitragePoint: true,
    isWhaleMove: false,
    changePercent: spreadPercent * 100,
  };

  return { lowPrice, highPrice };
}
