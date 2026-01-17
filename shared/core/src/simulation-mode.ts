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
 *   - Reserve-based pair simulation (mimics real DEX Sync events)
 *   - Chain-specific simulators for detector integration
 *   - No external dependencies required
 *
 * @see ADR-003: Partitioned Chain Detectors
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
  // S3.1.2: All 11 chains across 4 partitions
  chains: [
    // P1 Asia-Fast
    'bsc', 'polygon', 'avalanche', 'fantom',
    // P2 L2-Turbo
    'arbitrum', 'optimism', 'base',
    // P3 High-Value
    'ethereum', 'zksync', 'linea',
    // P4 Solana-Native
    'solana'
  ],
  pairs: [
    // Common stablecoin pairs
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WBTC', 'WETH'],
    ['WBTC', 'USDC'],
    // Chain-specific pairs
    ['WBNB', 'BUSD'],
    ['WBNB', 'USDT'],
    ['MATIC', 'USDC'],
    ['AVAX', 'USDC'],
    ['FTM', 'USDC'],
    ['SOL', 'USDC'],
    // DeFi tokens
    ['LINK', 'WETH'],
    ['ARB', 'WETH'],
    ['OP', 'WETH']
  ],
  dexesPerChain: 2
};

// Base prices for tokens (in USD)
// S3.1.2: Extended for all 11 chains with their native and common tokens
const BASE_PRICES: Record<string, number> = {
  // Major assets
  WETH: 3200,
  ETH: 3200,      // BSC bridged ETH
  WBTC: 65000,
  BTCB: 65000,    // BSC wrapped BTC

  // Native tokens by chain
  WBNB: 580,      // BSC
  BNB: 580,
  MATIC: 0.85,    // Polygon
  WMATIC: 0.85,
  AVAX: 35,       // Avalanche
  WAVAX: 35,
  FTM: 0.45,      // Fantom
  WFTM: 0.45,
  SOL: 175,       // Solana

  // Stablecoins
  USDC: 1.0,
  USDT: 1.0,
  BUSD: 1.0,
  DAI: 1.0,
  FRAX: 1.0,

  // Governance tokens
  ARB: 1.15,      // Arbitrum
  OP: 2.50,       // Optimism
  UNI: 12.50,     // Uniswap

  // DeFi tokens
  LINK: 15.0,
  AAVE: 185,
  GMX: 30,

  // LST tokens
  wstETH: 3400,
  rETH: 3350,
  stETH: 3200,
  mSOL: 185,      // Marinade staked SOL

  // Chain-specific DEX tokens
  CAKE: 2.50,     // PancakeSwap
  JOE: 0.45,      // Trader Joe
  AERO: 1.20,     // Aerodrome
  VELO: 0.12,     // Velodrome

  // Solana tokens
  JUP: 0.85,      // Jupiter
  RAY: 4.50,      // Raydium
  ORCA: 3.20,     // Orca
  BONK: 0.000025,
  WIF: 2.50
};

// DEX names per chain
// S3.1.2: All 11 chains with their primary DEXes
const DEXES: Record<string, string[]> = {
  // P1 Asia-Fast
  bsc: ['pancakeswap_v3', 'pancakeswap_v2', 'biswap'],
  polygon: ['quickswap_v3', 'uniswap_v3', 'sushiswap'],
  avalanche: ['trader_joe_v2', 'pangolin', 'sushiswap'],
  fantom: ['spookyswap', 'spiritswap', 'equalizer'],

  // P2 L2-Turbo
  arbitrum: ['uniswap_v3', 'camelot_v3', 'sushiswap'],
  optimism: ['velodrome', 'uniswap_v3', 'sushiswap'],
  base: ['aerodrome', 'uniswap_v3', 'baseswap'],

  // P3 High-Value
  ethereum: ['uniswap_v3', 'sushiswap'],
  zksync: ['syncswap', 'mute'],
  linea: ['syncswap', 'velocore'],

  // P4 Solana-Native
  solana: ['raydium', 'orca', 'meteora']
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

// =============================================================================
// Chain-Specific Simulator (for detector integration)
// =============================================================================

/**
 * Simulated Sync event that mimics real blockchain Sync events.
 * This is the format detectors expect from WebSocket subscriptions.
 */
export interface SimulatedSyncEvent {
  address: string;
  data: string;  // ABI-encoded reserve0, reserve1
  topics: string[];
  blockNumber: string;  // Hex string
  transactionHash: string;
  logIndex: string;
}

/**
 * Simulated arbitrage opportunity
 */
export interface SimulatedOpportunity {
  id: string;
  chain: string;
  buyDex: string;
  sellDex: string;
  tokenPair: string;
  buyPrice: number;
  sellPrice: number;
  profitPercentage: number;
  estimatedProfitUsd: number;
  confidence: number;
  timestamp: number;
  expiresAt: number;
  isSimulated: true;
}

/**
 * Configuration for chain-specific simulation
 */
export interface ChainSimulatorConfig {
  chainId: string;
  /** Update interval in milliseconds */
  updateIntervalMs: number;
  /** Base volatility (percentage per update) */
  volatility: number;
  /** Probability of creating an arbitrage opportunity (0-1) */
  arbitrageChance: number;
  /** Minimum spread for arbitrage (percentage) */
  minArbitrageSpread: number;
  /** Maximum spread for arbitrage (percentage) */
  maxArbitrageSpread: number;
  /** Pairs to simulate as [address, token0Symbol, token1Symbol, dex, fee][] */
  pairs: SimulatedPairConfig[];
}

export interface SimulatedPairConfig {
  address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  dex: string;
  fee: number;  // As percentage (0.003 = 0.3%)
}

/**
 * Chain-specific price simulator that generates realistic Sync events
 * for detector integration. Each chain detector gets its own simulator.
 *
 * Events emitted:
 * - 'syncEvent': SimulatedSyncEvent - Mimics real Sync events from DEX pairs
 * - 'opportunity': SimulatedOpportunity - When arbitrage is detected
 * - 'blockUpdate': { blockNumber: number } - New block notifications
 */
export class ChainSimulator extends EventEmitter {
  private config: ChainSimulatorConfig;
  private running = false;
  private interval: NodeJS.Timeout | null = null;
  private blockNumber: number;
  private reserves: Map<string, { reserve0: bigint; reserve1: bigint }> = new Map();
  private logger = createLogger('chain-simulator');
  private opportunityId = 0;

  constructor(config: ChainSimulatorConfig) {
    super();
    this.config = config;
    this.blockNumber = Math.floor(Date.now() / 1000);
    this.initializeReserves();
  }

  private initializeReserves(): void {
    for (const pair of this.config.pairs) {
      // Initialize with realistic reserve values based on token prices
      const basePrice0 = BASE_PRICES[pair.token0Symbol] || 1;
      const basePrice1 = BASE_PRICES[pair.token1Symbol] || 1;

      // Calculate reserves to achieve the correct price ratio
      // reserve0 / reserve1 = price1 / price0 (inverted because of AMM math)
      const reserve0Base = 1_000_000; // Base liquidity in token0 terms
      const reserve1Base = Math.floor(reserve0Base * (basePrice0 / basePrice1));

      // Scale to token decimals
      const reserve0 = BigInt(reserve0Base) * BigInt(10 ** pair.token0Decimals);
      const reserve1 = BigInt(reserve1Base) * BigInt(10 ** pair.token1Decimals);

      this.reserves.set(pair.address.toLowerCase(), { reserve0, reserve1 });
    }

    this.logger.info('Chain simulator reserves initialized', {
      chainId: this.config.chainId,
      pairs: this.config.pairs.length
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger.info('Starting chain simulator', {
      chainId: this.config.chainId,
      updateInterval: this.config.updateIntervalMs,
      pairs: this.config.pairs.length
    });

    // Start the simulation loop
    this.interval = setInterval(() => {
      this.simulateTick();
    }, this.config.updateIntervalMs);

    // Emit initial state
    this.emitAllSyncEvents();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.logger.info('Chain simulator stopped', { chainId: this.config.chainId });
  }

  private simulateTick(): void {
    // Increment block number
    this.blockNumber++;
    this.emit('blockUpdate', { blockNumber: this.blockNumber });

    // Decide if we should create an arbitrage opportunity this tick
    const shouldCreateArbitrage = Math.random() < this.config.arbitrageChance;
    let arbitragePairIndex = -1;
    let arbitrageDirection = 1;

    if (shouldCreateArbitrage && this.config.pairs.length >= 2) {
      // Pick a random pair to create spread
      arbitragePairIndex = Math.floor(Math.random() * this.config.pairs.length);
      arbitrageDirection = Math.random() > 0.5 ? 1 : -1;
    }

    // Update reserves for each pair
    for (let i = 0; i < this.config.pairs.length; i++) {
      const pair = this.config.pairs[i];
      const reserves = this.reserves.get(pair.address.toLowerCase());
      if (!reserves) continue;

      // Apply random volatility
      let priceChange = (Math.random() - 0.5) * 2 * this.config.volatility;

      // Add extra spread for arbitrage opportunity
      if (i === arbitragePairIndex) {
        const spread = this.config.minArbitrageSpread +
          Math.random() * (this.config.maxArbitrageSpread - this.config.minArbitrageSpread);
        priceChange += spread * arbitrageDirection;
      }

      // Update reserve1 to change the price (keeping reserve0 constant simulates a swap)
      const newReserve1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - priceChange)));
      reserves.reserve1 = newReserve1 > 0n ? newReserve1 : 1n;

      // Emit Sync event
      this.emitSyncEvent(pair, reserves.reserve0, reserves.reserve1);
    }

    // Detect and emit arbitrage opportunities
    if (shouldCreateArbitrage) {
      this.detectAndEmitOpportunities();
    }
  }

  private emitAllSyncEvents(): void {
    for (const pair of this.config.pairs) {
      const reserves = this.reserves.get(pair.address.toLowerCase());
      if (reserves) {
        this.emitSyncEvent(pair, reserves.reserve0, reserves.reserve1);
      }
    }
  }

  private emitSyncEvent(pair: SimulatedPairConfig, reserve0: bigint, reserve1: bigint): void {
    // Encode reserves as ABI data (matches real Sync event format)
    const data = this.encodeReserves(reserve0, reserve1);

    const syncEvent: SimulatedSyncEvent = {
      address: pair.address,
      data,
      topics: [
        '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1' // Sync topic
      ],
      blockNumber: '0x' + this.blockNumber.toString(16),
      transactionHash: '0x' + this.generateRandomHash(),
      logIndex: '0x0'
    };

    this.emit('syncEvent', syncEvent);
  }

  private encodeReserves(reserve0: bigint, reserve1: bigint): string {
    // Encode as 32-byte padded hex values (matches Solidity abi.encode)
    const r0Hex = reserve0.toString(16).padStart(64, '0');
    const r1Hex = reserve1.toString(16).padStart(64, '0');
    return '0x' + r0Hex + r1Hex;
  }

  private generateRandomHash(): string {
    const chars = '0123456789abcdef';
    let hash = '';
    for (let i = 0; i < 64; i++) {
      hash += chars[Math.floor(Math.random() * 16)];
    }
    return hash;
  }

  private detectAndEmitOpportunities(): void {
    // Group pairs by token pair (to find same-pair different-dex opportunities)
    const pairsByTokens = new Map<string, { pair: SimulatedPairConfig; price: number }[]>();

    for (const pair of this.config.pairs) {
      const tokenKey = `${pair.token0Symbol}/${pair.token1Symbol}`;
      const reserves = this.reserves.get(pair.address.toLowerCase());
      if (!reserves) continue;

      // Calculate price (token1 per token0)
      const price = Number(reserves.reserve1) / Number(reserves.reserve0);

      if (!pairsByTokens.has(tokenKey)) {
        pairsByTokens.set(tokenKey, []);
      }
      pairsByTokens.get(tokenKey)!.push({ pair, price });
    }

    // Find arbitrage opportunities
    for (const [tokenPair, pairs] of pairsByTokens) {
      if (pairs.length < 2) continue;

      // Find min and max prices
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      let buyPair: typeof pairs[0] | null = null;
      let sellPair: typeof pairs[0] | null = null;

      for (const p of pairs) {
        if (p.price < minPrice) {
          minPrice = p.price;
          buyPair = p;
        }
        if (p.price > maxPrice) {
          maxPrice = p.price;
          sellPair = p;
        }
      }

      if (!buyPair || !sellPair || buyPair === sellPair) continue;

      // Calculate profit percentage (accounting for fees)
      const totalFees = buyPair.pair.fee + sellPair.pair.fee;
      const grossProfit = (maxPrice - minPrice) / minPrice;
      const netProfit = grossProfit - totalFees;

      if (netProfit > 0.001) {  // Only emit if > 0.1% profit
        const opportunity: SimulatedOpportunity = {
          id: `sim-${this.config.chainId}-${++this.opportunityId}`,
          chain: this.config.chainId,
          buyDex: buyPair.pair.dex,
          sellDex: sellPair.pair.dex,
          tokenPair,
          buyPrice: minPrice,
          sellPrice: maxPrice,
          profitPercentage: netProfit * 100,
          estimatedProfitUsd: netProfit * 10000, // Assume $10k position
          confidence: 0.8 + Math.random() * 0.15,
          timestamp: Date.now(),
          expiresAt: Date.now() + 5000,  // 5 second expiry
          isSimulated: true
        };

        this.emit('opportunity', opportunity);
        this.logger.debug('Simulated arbitrage opportunity', {
          id: opportunity.id,
          profit: `${opportunity.profitPercentage.toFixed(2)}%`,
          buyDex: opportunity.buyDex,
          sellDex: opportunity.sellDex
        });
      }
    }
  }

  getBlockNumber(): number {
    return this.blockNumber;
  }

  isRunning(): boolean {
    return this.running;
  }

  getChainId(): string {
    return this.config.chainId;
  }
}

// =============================================================================
// Chain Simulator Factory
// =============================================================================

const chainSimulators = new Map<string, ChainSimulator>();

/**
 * Get or create a chain-specific simulator.
 * Used by ChainDetectorInstance when SIMULATION_MODE is enabled.
 */
export function getChainSimulator(
  chainId: string,
  pairs: SimulatedPairConfig[],
  config?: Partial<Omit<ChainSimulatorConfig, 'chainId' | 'pairs'>>
): ChainSimulator {
  const key = chainId.toLowerCase();

  if (!chainSimulators.has(key)) {
    const simulatorConfig: ChainSimulatorConfig = {
      chainId: key,
      pairs,
      updateIntervalMs: config?.updateIntervalMs ?? parseInt(process.env.SIMULATION_UPDATE_INTERVAL_MS || '1000', 10),
      volatility: config?.volatility ?? parseFloat(process.env.SIMULATION_VOLATILITY || '0.01'),
      arbitrageChance: config?.arbitrageChance ?? 0.08,  // 8% chance per tick
      minArbitrageSpread: config?.minArbitrageSpread ?? 0.003,  // 0.3%
      maxArbitrageSpread: config?.maxArbitrageSpread ?? 0.015   // 1.5%
    };

    chainSimulators.set(key, new ChainSimulator(simulatorConfig));
  }

  return chainSimulators.get(key)!;
}

/**
 * Stop and remove a chain simulator
 */
export function stopChainSimulator(chainId: string): void {
  const key = chainId.toLowerCase();
  const simulator = chainSimulators.get(key);
  if (simulator) {
    simulator.stop();
    chainSimulators.delete(key);
  }
}

/**
 * Stop all chain simulators
 */
export function stopAllChainSimulators(): void {
  for (const simulator of chainSimulators.values()) {
    simulator.stop();
  }
  chainSimulators.clear();
}

/**
 * Reset simulator singleton for testing
 */
export function resetSimulatorInstance(): void {
  if (simulatorInstance) {
    simulatorInstance.stop();
    simulatorInstance = null;
  }
  stopAllChainSimulators();
}
