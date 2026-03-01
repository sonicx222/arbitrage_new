/**
 * Price Simulator
 *
 * Generates simulated price feeds with realistic volatility for local testing.
 *
 * @module simulation
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import { getBlockTimeMs } from '@arbitrage/config';
import type { SimulationConfig, SimulatedPriceUpdate } from './types';
import { DEFAULT_CONFIG, DEXES, getTokenPrice } from './constants';
import { getSimulationRealismLevel } from './mode-utils';

const logger = createLogger('simulation-mode');

// =============================================================================
// PriceSimulator
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
      const price0 = getTokenPrice(token0);
      const price1 = getTokenPrice(token1);
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

    const realismLevel = getSimulationRealismLevel();
    const hasExplicitInterval = !!process.env.SIMULATION_UPDATE_INTERVAL_MS;

    logger.info('Starting price simulation', {
      realismLevel,
      volatility: this.config.volatility
    });

    // Create update interval for each chain
    // medium/high realism: use real block time per chain
    // low realism or explicit env override: use flat configured interval
    for (const chain of this.config.chains) {
      let intervalMs: number;
      if (hasExplicitInterval || realismLevel === 'low') {
        intervalMs = this.config.updateIntervalMs;
      } else {
        intervalMs = Math.max(100, Math.min(getBlockTimeMs(chain), 15000));
      }

      const interval = setInterval(() => {
        this.updateChainPrices(chain);
      }, intervalMs);
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
    const currentBlock = this.blockNumbers.get(chain) ?? 0;
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
    const price0 = getTokenPrice(token0);
    const price1 = getTokenPrice(token1);

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
      blockNumber: this.blockNumbers.get(chain) ?? 0,
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

/**
 * Reset simulator singleton for testing
 */
export function resetSimulatorInstance(): void {
  if (simulatorInstance) {
    simulatorInstance.stop();
    simulatorInstance = null;
  }
}
