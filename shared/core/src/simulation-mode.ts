/**
 * Simulation Mode Module
 *
 * Generates simulated price feeds and arbitrage opportunities for local testing
 * without requiring real blockchain connections.
 *
 * Usage:
 *   Set SIMULATION_MODE=true in environment variables
 *
 * Features:
 *   - Simulated price feeds with realistic volatility
 *   - Artificial arbitrage opportunities for testing
 *   - No external dependencies required
 */

import { EventEmitter } from 'events';
import { createLogger } from './logger';

const logger = createLogger('simulation-mode');

// =============================================================================
// Types
// =============================================================================

export interface SimulatedPriceUpdate {
  chain: string;
  dex: string;
  pairKey: string;
  token0: string;
  token1: string;
  price: number;
  price0: number;
  price1: number;
  liquidity: number;
  volume24h: number;
  timestamp: number;
  blockNumber: number;
  isSimulated: true;
}

export interface SimulationConfig {
  /** Base volatility (percentage per update) */
  volatility: number;
  /** Update interval in milliseconds */
  updateIntervalMs: number;
  /** Probability of creating an arbitrage opportunity (0-1) */
  arbitrageChance: number;
  /** Size of arbitrage spread when created */
  arbitrageSpread: number;
  /** Chains to simulate */
  chains: string[];
  /** Token pairs to simulate */
  pairs: string[][];
  /** DEXes per chain */
  dexesPerChain: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: SimulationConfig = {
  volatility: parseFloat(process.env.SIMULATION_VOLATILITY || '0.02'),
  updateIntervalMs: parseInt(process.env.SIMULATION_UPDATE_INTERVAL_MS || '1000', 10),
  arbitrageChance: 0.05, // 5% chance per update
  arbitrageSpread: 0.005, // 0.5% spread
  chains: ['ethereum', 'bsc', 'arbitrum', 'polygon', 'base'],
  pairs: [
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WBTC', 'WETH'],
    ['WBNB', 'BUSD'],
    ['MATIC', 'USDC']
  ],
  dexesPerChain: 2
};

// Base prices for tokens (in USD)
const BASE_PRICES: Record<string, number> = {
  WETH: 3200,
  WBTC: 65000,
  WBNB: 580,
  MATIC: 0.85,
  USDC: 1.0,
  USDT: 1.0,
  BUSD: 1.0,
  DAI: 1.0
};

// DEX names per chain
const DEXES: Record<string, string[]> = {
  ethereum: ['uniswap_v3', 'sushiswap'],
  bsc: ['pancakeswap', 'biswap'],
  arbitrum: ['uniswap_v3', 'camelot'],
  polygon: ['quickswap', 'uniswap_v3'],
  base: ['aerodrome', 'uniswap_v3'],
  optimism: ['velodrome', 'uniswap_v3'],
  avalanche: ['trader_joe', 'pangolin']
};

// =============================================================================
// Price Simulator
// =============================================================================

export class PriceSimulator extends EventEmitter {
  private config: SimulationConfig;
  private prices: Map<string, number> = new Map();
  private intervals: NodeJS.Timeout[] = [];
  private running = false;
  private blockNumbers: Map<string, number> = new Map();

  constructor(config: Partial<SimulationConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializePrices();
  }

  private initializePrices(): void {
    // Initialize base prices for all pairs
    for (const [token0, token1] of this.config.pairs) {
      const price0 = BASE_PRICES[token0] || 1;
      const price1 = BASE_PRICES[token1] || 1;
      const pairPrice = price0 / price1;

      for (const chain of this.config.chains) {
        const dexes = DEXES[chain] || ['dex1', 'dex2'];
        for (const dex of dexes.slice(0, this.config.dexesPerChain)) {
          const key = `${chain}:${dex}:${token0}/${token1}`;
          // Add small random variation per DEX
          const variation = 1 + (Math.random() - 0.5) * 0.001;
          this.prices.set(key, pairPrice * variation);
        }
        // Initialize block numbers
        this.blockNumbers.set(chain, Math.floor(Date.now() / 1000));
      }
    }

    logger.info('Simulation prices initialized', {
      chains: this.config.chains.length,
      pairs: this.config.pairs.length,
      totalPrices: this.prices.size
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    logger.info('Starting price simulation', {
      updateInterval: this.config.updateIntervalMs,
      volatility: this.config.volatility
    });

    // Create update interval for each chain
    for (const chain of this.config.chains) {
      const interval = setInterval(() => {
        this.updateChainPrices(chain);
      }, this.config.updateIntervalMs);
      this.intervals.push(interval);
    }

    // Emit initial prices
    this.emitAllPrices();
  }

  stop(): void {
    this.running = false;
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
    logger.info('Price simulation stopped');
  }

  private updateChainPrices(chain: string): void {
    // Increment block number
    const currentBlock = this.blockNumbers.get(chain) || 0;
    this.blockNumbers.set(chain, currentBlock + 1);

    const dexes = DEXES[chain] || ['dex1', 'dex2'];
    const shouldCreateArbitrage = Math.random() < this.config.arbitrageChance;

    for (const [token0, token1] of this.config.pairs) {
      let arbitrageDex: string | null = null;
      if (shouldCreateArbitrage) {
        arbitrageDex = dexes[Math.floor(Math.random() * dexes.length)];
      }

      for (const dex of dexes.slice(0, this.config.dexesPerChain)) {
        const key = `${chain}:${dex}:${token0}/${token1}`;
        const currentPrice = this.prices.get(key) || 1;

        // Apply random walk with volatility
        let change = (Math.random() - 0.5) * 2 * this.config.volatility;

        // Create arbitrage opportunity
        if (arbitrageDex === dex && shouldCreateArbitrage) {
          change += this.config.arbitrageSpread * (Math.random() > 0.5 ? 1 : -1);
        }

        const newPrice = currentPrice * (1 + change);
        this.prices.set(key, newPrice);

        // Emit price update
        const update = this.createPriceUpdate(chain, dex, token0, token1, newPrice);
        this.emit('priceUpdate', update);
      }
    }
  }

  private emitAllPrices(): void {
    for (const [key, price] of this.prices) {
      const [chain, dex, pair] = key.split(':');
      const [token0, token1] = pair.split('/');
      const update = this.createPriceUpdate(chain, dex, token0, token1, price);
      this.emit('priceUpdate', update);
    }
  }

  private createPriceUpdate(
    chain: string,
    dex: string,
    token0: string,
    token1: string,
    price: number
  ): SimulatedPriceUpdate {
    const price0 = BASE_PRICES[token0] || 1;
    const price1 = BASE_PRICES[token1] || 1;

    return {
      chain,
      dex,
      pairKey: `${dex}_${token0}_${token1}`,
      token0,
      token1,
      price,
      price0: price0 * (1 + (Math.random() - 0.5) * 0.001),
      price1: price1 * (1 + (Math.random() - 0.5) * 0.001),
      liquidity: Math.random() * 10000000 + 100000,
      volume24h: Math.random() * 50000000 + 1000000,
      timestamp: Date.now(),
      blockNumber: this.blockNumbers.get(chain) || 0,
      isSimulated: true
    };
  }

  getPrice(chain: string, dex: string, token0: string, token1: string): number | undefined {
    const key = `${chain}:${dex}:${token0}/${token1}`;
    return this.prices.get(key);
  }

  getAllPrices(): Map<string, number> {
    return new Map(this.prices);
  }

  isRunning(): boolean {
    return this.running;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let simulatorInstance: PriceSimulator | null = null;

export function getSimulator(config?: Partial<SimulationConfig>): PriceSimulator {
  if (!simulatorInstance) {
    simulatorInstance = new PriceSimulator(config);
  }
  return simulatorInstance;
}

export function isSimulationMode(): boolean {
  return process.env.SIMULATION_MODE === 'true';
}

// =============================================================================
// Export
// =============================================================================

export { DEFAULT_CONFIG as SIMULATION_CONFIG };
