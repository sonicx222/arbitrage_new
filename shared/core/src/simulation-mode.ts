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
import { clearIntervalSafe } from './lifecycle-utils';

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

/**
 * Get token price with case-insensitive lookup.
 *
 * Fix P3-005: Normalize token symbols to uppercase for consistent lookup.
 * This prevents failures when symbols come from external sources with different casing.
 */
function getTokenPrice(symbol: string): number {
  return BASE_PRICES[symbol.toUpperCase()] || 1;
}

// Base prices for tokens (in USD)
// S3.1.2: Extended for all 11 chains with their native and common tokens
// Enhancement S5: Added chain-specific governance, LST, and meme tokens
//
// Fix P3-005: All keys normalized to UPPERCASE for consistent lookup.
// Use getTokenPrice() helper for case-insensitive access.
const BASE_PRICES: Record<string, number> = {
  // Major assets
  'WETH': 3200,
  'ETH': 3200,      // BSC bridged ETH
  'WBTC': 65000,
  'BTCB': 65000,    // BSC wrapped BTC

  // Native tokens by chain
  'WBNB': 580,      // BSC
  'BNB': 580,
  'MATIC': 0.85,    // Polygon
  'WMATIC': 0.85,
  'AVAX': 35,       // Avalanche
  'WAVAX': 35,
  'FTM': 0.45,      // Fantom
  'WFTM': 0.45,
  'SOL': 175,       // Solana

  // Stablecoins
  'USDC': 1.0,
  'USDT': 1.0,
  'BUSD': 1.0,
  'DAI': 1.0,
  'FRAX': 1.0,
  'SUSD': 1.0,      // Synthetix USD (normalized)

  // Governance tokens
  'ARB': 1.15,      // Arbitrum
  'OP': 2.50,       // Optimism
  'UNI': 12.50,     // Uniswap

  // DeFi tokens
  'LINK': 15.0,
  'AAVE': 185,
  'GMX': 30,
  'CRV': 0.55,      // Curve
  'PENDLE': 4.50,   // Pendle Finance
  'MAGIC': 0.85,    // Treasure/Arbitrum

  // LST tokens (Liquid Staking) - normalized to uppercase
  'WSTETH': 3400,
  'RETH': 3350,
  'STETH': 3200,
  'CBETH': 3250,    // Coinbase staked ETH
  'MSOL': 185,      // Marinade staked SOL
  'JITOSOL': 190,   // Jito staked SOL
  'STMATIC': 0.90,  // Lido staked MATIC

  // Chain-specific DEX tokens
  'CAKE': 2.50,     // PancakeSwap
  'JOE': 0.45,      // Trader Joe
  'AERO': 1.20,     // Aerodrome
  'VELO': 0.12,     // Velodrome
  'QUICK': 0.045,   // QuickSwap
  'XVS': 8.50,      // Venus Protocol (BSC)

  // Meme tokens
  'PEPE': 0.000012,
  'SHIB': 0.000022,
  'DOGE': 0.12,

  // Solana tokens
  'JUP': 0.85,      // Jupiter
  'RAY': 4.50,      // Raydium
  'ORCA': 3.20,     // Orca
  'BONK': 0.000025,
  'WIF': 2.50,
  'JTO': 3.80,      // Jito governance
  'PYTH': 0.45,     // Pyth Network
  'MNDE': 0.12,     // Marinade governance
  'W': 0.35,        // Wormhole
  'BSOL': 180,      // BlazeStake SOL
};

/**
 * Chain-specific token pairs for more realistic simulation.
 * These supplement the common pairs with chain-native assets.
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S5
 */
export const CHAIN_SPECIFIC_PAIRS: Record<string, string[][]> = {
  ethereum: [
    ['stETH', 'WETH'], ['rETH', 'WETH'], ['cbETH', 'WETH'],
    ['wstETH', 'WETH'], ['PEPE', 'WETH'], ['SHIB', 'WETH'],
    ['CRV', 'WETH'], ['AAVE', 'WETH'],
  ],
  arbitrum: [
    ['ARB', 'WETH'], ['ARB', 'USDC'], ['GMX', 'WETH'],
    ['MAGIC', 'WETH'], ['PENDLE', 'WETH'],
  ],
  optimism: [
    ['OP', 'WETH'], ['OP', 'USDC'], ['VELO', 'WETH'],
    ['sUSD', 'USDC'],
  ],
  base: [
    ['AERO', 'WETH'], ['cbETH', 'WETH'], ['AERO', 'USDC'],
  ],
  bsc: [
    ['CAKE', 'WBNB'], ['XVS', 'WBNB'], ['CAKE', 'BUSD'],
    ['BTCB', 'WBNB'],
  ],
  polygon: [
    ['stMATIC', 'WMATIC'], ['QUICK', 'WMATIC'], ['QUICK', 'USDC'],
  ],
  avalanche: [
    ['JOE', 'WAVAX'], ['JOE', 'USDC'],
  ],
  fantom: [
    ['WFTM', 'USDC'], ['WFTM', 'DAI'],
  ],
  zksync: [
    ['WETH', 'USDC'],
  ],
  linea: [
    ['WETH', 'USDC'],
  ],
  solana: [
    ['SOL', 'USDC'], ['JUP', 'SOL'], ['RAY', 'SOL'],
    ['ORCA', 'SOL'], ['BONK', 'SOL'], ['WIF', 'SOL'],
    ['JTO', 'SOL'], ['PYTH', 'SOL'], ['mSOL', 'SOL'],
    ['jitoSOL', 'SOL'], ['MNDE', 'SOL'], ['W', 'SOL'],
    ['BSOL', 'SOL'],
  ],
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

export function isSimulationMode(): boolean {
  return process.env.SIMULATION_MODE === 'true';
}

/**
 * Check if execution simulation mode is enabled.
 * This mode simulates transaction execution (dry-run) without real blockchain transactions.
 */
export function isExecutionSimulationMode(): boolean {
  return process.env.EXECUTION_SIMULATION_MODE === 'true';
}

/**
 * Check if hybrid execution mode is enabled.
 *
 * Hybrid mode enables:
 * - Real strategy selection logic (not SimulationStrategy override)
 * - Real pre-execution validation and checks
 * - Mocked transaction submission (no real blockchain transactions)
 *
 * This allows testing the full execution pipeline including strategy routing
 * for all opportunity types (intra-chain, cross-chain, flash-loan, triangular,
 * quadrilateral) without making actual transactions.
 *
 * Set via: EXECUTION_HYBRID_MODE=true
 *
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S4
 */
export function isHybridExecutionMode(): boolean {
  return process.env.EXECUTION_HYBRID_MODE === 'true';
}

/**
 * Get simulation mode summary for logging/debugging.
 */
export function getSimulationModeSummary(): {
  simulationMode: boolean;
  executionSimulation: boolean;
  hybridMode: boolean;
  effectiveMode: 'production' | 'simulation' | 'hybrid';
} {
  const simulationMode = isSimulationMode();
  const executionSimulation = isExecutionSimulationMode();
  const hybridMode = isHybridExecutionMode();

  let effectiveMode: 'production' | 'simulation' | 'hybrid' = 'production';
  if (hybridMode) {
    effectiveMode = 'hybrid';
  } else if (simulationMode || executionSimulation) {
    effectiveMode = 'simulation';
  }

  return {
    simulationMode,
    executionSimulation,
    hybridMode,
    effectiveMode,
  };
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
 * Opportunity type for strategy routing.
 * Matches StrategyType in execution-engine for proper routing tests.
 */
export type SimulatedOpportunityType =
  | 'intra-chain'
  | 'cross-chain'
  | 'flash-loan'
  | 'triangular'
  | 'quadrilateral';

/**
 * Bridge protocol for cross-chain opportunities.
 */
export type SimulatedBridgeProtocol = 'stargate' | 'across' | 'native';

/**
 * Simulated arbitrage opportunity.
 *
 * Enhanced to support all execution strategy types:
 * - intra-chain: Same chain, different DEXes
 * - cross-chain: Different chains, bridge required
 * - flash-loan: Uses flash loan for capital-free execution
 * - triangular: 3-hop arbitrage (A -> B -> C -> A)
 * - quadrilateral: 4-hop arbitrage (A -> B -> C -> D -> A)
 *
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md
 */
export interface SimulatedOpportunity {
  id: string;

  // =========================================================================
  // Strategy Routing Fields (NEW - for comprehensive testing)
  // =========================================================================

  /** Opportunity type for strategy routing */
  type: SimulatedOpportunityType;

  /** Source chain (buyChain) - for cross-chain, same as chain for intra-chain */
  buyChain: string;

  /** Destination chain (sellChain) - for cross-chain, same as chain for intra-chain */
  sellChain: string;

  /** Whether to use flash loan for execution */
  useFlashLoan: boolean;

  /** Bridge protocol for cross-chain opportunities */
  bridgeProtocol?: SimulatedBridgeProtocol;

  // =========================================================================
  // Multi-Hop Fields (for triangular/quadrilateral)
  // =========================================================================

  /** Number of hops for multi-hop arbitrage (3 for triangular, 4 for quadrilateral) */
  hops?: number;

  /** Token path for multi-hop (e.g., ['WETH', 'USDC', 'WBTC', 'WETH']) */
  path?: string[];

  /** Intermediate tokens (tokens between start and end) */
  intermediateTokens?: string[];

  // =========================================================================
  // Original Fields (preserved for backward compatibility)
  // =========================================================================

  /** Primary chain (for intra-chain, same as buyChain/sellChain) */
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

  // =========================================================================
  // Execution Hints (optional, for realistic testing)
  // =========================================================================

  /** Expected gas cost in USD */
  expectedGasCost?: number;

  /** Expected profit after gas (for validation) */
  expectedProfit?: number;

  /** Flash loan fee percentage (for flash-loan type) */
  flashLoanFee?: number;

  /** Bridge fee in USD (for cross-chain type) */
  bridgeFee?: number;
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
  /** Minimum position size in USD (default: 1000) */
  minPositionSize?: number;
  /** Maximum position size in USD (default: 50000) */
  maxPositionSize?: number;
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

  /**
   * Fix P3-004: Configurable position size range for realistic opportunity sizing.
   */
  private readonly minPositionSize: number;
  private readonly maxPositionSize: number;

  constructor(config: ChainSimulatorConfig) {
    super();
    this.config = config;
    this.blockNumber = Math.floor(Date.now() / 1000);
    this.minPositionSize = config.minPositionSize ?? 1000;
    this.maxPositionSize = config.maxPositionSize ?? 50000;
    this.initializeReserves();
  }

  /**
   * Calculate a realistic position size using log-normal distribution.
   *
   * Fix P3-004: Vary position sizes to simulate realistic market conditions.
   * Uses log-normal distribution to create more small/medium opportunities
   * with occasional large ones.
   */
  private calculatePositionSize(): number {
    // Log-normal distribution for realistic position sizing
    const logMin = Math.log(this.minPositionSize);
    const logMax = Math.log(this.maxPositionSize);
    const logRandom = logMin + Math.random() * (logMax - logMin);
    const positionSize = Math.exp(logRandom);

    // Round to nearest $10 for cleaner numbers
    return Math.round(positionSize / 10) * 10;
  }

  private initializeReserves(): void {
    for (const pair of this.config.pairs) {
      // Initialize with realistic reserve values based on token prices
      const basePrice0 = getTokenPrice(pair.token0Symbol);
      const basePrice1 = getTokenPrice(pair.token1Symbol);

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

    this.interval = clearIntervalSafe(this.interval);

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

      // FIX #22: Clamp reserve ratio to prevent unbounded drift.
      // Without this, reserves drift over time causing price ratios like 1:1,000,000
      // which produce absurd profit percentages. Real AMM pools maintain bounded ratios.
      // FIX #22b: Tightened from 100:1 to 2:1. Each pair's ratio is independent, so
      // two DEXes for the same token can diverge in opposite directions. At 100:1, the
      // worst cross-DEX spread is 100 vs 0.01 = 10000x, producing trillions-% profits.
      // At 2:1, worst case is 2.0 vs 0.5 = 4x = 300%, which is realistic for simulated data.
      const ratio = Number(reserves.reserve0) / Number(reserves.reserve1);
      const MAX_RATIO = 2; // Max 2:1 price ratio — keeps cross-DEX spreads realistic
      if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO) {
        // Reset reserve1 to bring ratio back to initial range
        reserves.reserve1 = reserves.reserve0;
      }

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

  /**
   * Detect and emit arbitrage opportunities with varied types.
   *
   * Enhancement: Now generates different opportunity types:
   * - 70%: intra-chain (same chain, different DEXes)
   * - 15%: flash-loan (uses flash loan for capital-free execution)
   * - 10%: triangular (3-hop circular arbitrage)
   * - 5%: quadrilateral (4-hop circular arbitrage)
   *
   * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md
   */
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
      const rawGrossProfit = (maxPrice - minPrice) / minPrice;
      // FIX #22: Clamp gross profit to realistic bounds (max 50%).
      // Unbounded reserve drift causes price ratios to diverge astronomically,
      // producing absurd profits like 35,357,931,307%. Real DEX arbitrage
      // opportunities rarely exceed 5-10%.
      const grossProfit = Math.min(rawGrossProfit, 0.5);
      const netProfit = grossProfit - totalFees;

      if (netProfit > 0.001) {  // Only emit if > 0.1% profit
        // Determine opportunity type based on random distribution
        const opportunity = this.createOpportunityWithType(
          tokenPair,
          buyPair,
          sellPair,
          minPrice,
          maxPrice,
          netProfit
        );

        this.emit('opportunity', opportunity);
        this.logger.debug('Simulated arbitrage opportunity', {
          id: opportunity.id,
          type: opportunity.type,
          profit: `${opportunity.profitPercentage.toFixed(2)}%`,
          buyDex: opportunity.buyDex,
          sellDex: opportunity.sellDex,
          useFlashLoan: opportunity.useFlashLoan,
        });
      }
    }

    // Occasionally generate multi-hop opportunities
    // Fix: Use config.arbitrageChance instead of hardcoded 0.15 for test configurability
    if (Math.random() < this.config.arbitrageChance) {
      this.generateMultiHopOpportunity();
    }
  }

  /**
   * Create an opportunity with appropriate type based on random distribution.
   *
   * Distribution:
   * - 70%: intra-chain
   * - 30%: flash-loan (intra-chain but uses flash loan)
   *
   * Fix P2-003: Validate that opportunity type matches chain configuration.
   */
  private createOpportunityWithType(
    tokenPair: string,
    buyPair: { pair: SimulatedPairConfig; price: number },
    sellPair: { pair: SimulatedPairConfig; price: number },
    minPrice: number,
    maxPrice: number,
    netProfit: number
  ): SimulatedOpportunity {
    const rand = Math.random();
    // Fix P3-004: Use dynamic position sizing instead of hardcoded $10k
    const positionSize = this.calculatePositionSize();
    const estimatedProfitUsd = netProfit * positionSize;
    const estimatedGasCost = 5 + Math.random() * 15; // $5-20 gas

    // Base opportunity fields
    const baseOpportunity = {
      id: `sim-${this.config.chainId}-${++this.opportunityId}`,
      chain: this.config.chainId,
      buyChain: this.config.chainId,
      sellChain: this.config.chainId,
      buyDex: buyPair.pair.dex,
      sellDex: sellPair.pair.dex,
      tokenPair,
      buyPrice: minPrice,
      sellPrice: maxPrice,
      profitPercentage: netProfit * 100,
      estimatedProfitUsd,
      confidence: 0.8 + Math.random() * 0.15,
      timestamp: Date.now(),
      expiresAt: Date.now() + 5000,
      isSimulated: true as const,
      expectedGasCost: estimatedGasCost,
      expectedProfit: estimatedProfitUsd - estimatedGasCost,
    };

    let opportunity: SimulatedOpportunity;

    // 70% intra-chain (standard)
    if (rand < 0.70) {
      opportunity = {
        ...baseOpportunity,
        type: 'intra-chain',
        useFlashLoan: false,
      };
    } else {
      // 30% flash-loan (uses flash loan for capital-free execution)
      const flashLoanFee = 0.0009; // Aave V3 fee: 0.09%
      opportunity = {
        ...baseOpportunity,
        type: 'flash-loan',
        useFlashLoan: true,
        flashLoanFee,
        expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
      };
    }

    // Fix P2-003: Validate opportunity type consistency
    this.validateOpportunityTypeConsistency(opportunity);

    return opportunity;
  }

  /**
   * Validate that opportunity type matches chain and DEX configuration.
   *
   * Fix P2-003: Prevent inconsistent opportunities (e.g., cross-chain type with same chains).
   */
  private validateOpportunityTypeConsistency(opportunity: SimulatedOpportunity): void {
    // Validation 1: Cross-chain must have different chains
    if (opportunity.type === 'cross-chain') {
      if (opportunity.buyChain === opportunity.sellChain) {
        throw new Error(
          `[SIMULATION_ERROR] Cross-chain opportunity must have different buy/sell chains. ` +
          `Got: buyChain=${opportunity.buyChain}, sellChain=${opportunity.sellChain}`
        );
      }
    }

    // Validation 2: Intra-chain must have same chain
    if (opportunity.type === 'intra-chain') {
      if (opportunity.buyChain !== opportunity.sellChain) {
        throw new Error(
          `[SIMULATION_ERROR] Intra-chain opportunity must have same buy/sell chains. ` +
          `Got: buyChain=${opportunity.buyChain}, sellChain=${opportunity.sellChain}`
        );
      }
    }

    // Validation 3: Multi-hop must use flash loan
    if (opportunity.type === 'triangular' || opportunity.type === 'quadrilateral') {
      if (!opportunity.useFlashLoan) {
        throw new Error(
          `[SIMULATION_ERROR] Multi-hop (${opportunity.type}) must use flash loan. ` +
          `Got: useFlashLoan=${opportunity.useFlashLoan}`
        );
      }
    }

    // Validation 4: Multi-hop must have path
    if (opportunity.type === 'triangular' || opportunity.type === 'quadrilateral') {
      if (!opportunity.path || opportunity.path.length === 0) {
        throw new Error(
          `[SIMULATION_ERROR] Multi-hop (${opportunity.type}) must have valid path. ` +
          `Got: path=${opportunity.path}`
        );
      }

      // Validate circular path (first === last)
      if (opportunity.path[0] !== opportunity.path[opportunity.path.length - 1]) {
        throw new Error(
          `[SIMULATION_ERROR] Multi-hop path must be circular (first === last token). ` +
          `Got: start=${opportunity.path[0]}, end=${opportunity.path[opportunity.path.length - 1]}`
        );
      }
    }

    // Validation 5: Flash-loan type must have useFlashLoan=true
    if (opportunity.type === 'flash-loan') {
      if (!opportunity.useFlashLoan) {
        throw new Error(
          `[SIMULATION_ERROR] Flash-loan opportunity must have useFlashLoan=true. ` +
          `Got: useFlashLoan=${opportunity.useFlashLoan}`
        );
      }
    }
  }

  /**
   * Generate multi-hop (triangular/quadrilateral) opportunities.
   *
   * These are more complex opportunities that test the flash loan strategy
   * with multi-hop swap paths.
   *
   * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S3
   */
  private generateMultiHopOpportunity(): void {
    // Need at least 3 different tokens for triangular
    const tokens = this.getAvailableTokens();
    if (tokens.length < 3) return;

    // Randomly choose triangular (3-hop) or quadrilateral (4-hop)
    const hops = Math.random() < 0.7 ? 3 : 4;
    const type: SimulatedOpportunityType = hops === 3 ? 'triangular' : 'quadrilateral';

    // Select random tokens for the path
    const shuffled = [...tokens].sort(() => Math.random() - 0.5);
    const path = shuffled.slice(0, hops);
    path.push(path[0]); // Complete the cycle

    // Simulate profit (simplified - in reality would calculate from reserves)
    // Fix: Multi-hop opportunities need higher base profit to cover cumulative fees
    // 3-hop: totalFees = 0.9%, baseProfit = [0.8%, 2.0%] → netProfit = [0%, 1.1%]
    // 4-hop: totalFees = 1.2%, baseProfit = [0.8%, 2.0%] → netProfit = [0%, 0.8%]
    const baseProfit = 0.008 + Math.random() * 0.012; // 0.8% - 2% profit
    const feePerHop = 0.003; // 0.3% per hop
    const totalFees = feePerHop * hops;
    const netProfit = baseProfit - totalFees;

    if (netProfit <= 0) return; // Not profitable after fees

    // Fix P3-004: Use dynamic position sizing for multi-hop opportunities
    const positionSize = this.calculatePositionSize();
    const estimatedProfitUsd = netProfit * positionSize;
    const estimatedGasCost = 10 + Math.random() * 30; // Higher gas for multi-hop
    const flashLoanFee = 0.0009;

    const opportunity: SimulatedOpportunity = {
      id: `sim-${this.config.chainId}-${type}-${++this.opportunityId}`,
      type,
      chain: this.config.chainId,
      buyChain: this.config.chainId,
      sellChain: this.config.chainId,
      buyDex: this.config.pairs[0]?.dex || 'unknown',
      sellDex: this.config.pairs[0]?.dex || 'unknown',
      tokenPair: `${path[0]}/${path[1]}`,
      buyPrice: 1,
      sellPrice: 1 + netProfit,
      profitPercentage: netProfit * 100,
      estimatedProfitUsd,
      confidence: 0.75 + Math.random() * 0.15, // Slightly lower confidence for multi-hop
      timestamp: Date.now(),
      expiresAt: Date.now() + 3000, // Shorter expiry for complex opportunities
      isSimulated: true,
      useFlashLoan: true,
      hops,
      path,
      intermediateTokens: path.slice(1, -1),
      expectedGasCost: estimatedGasCost,
      expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
      flashLoanFee,
    };

    this.emit('opportunity', opportunity);
    this.logger.debug('Simulated multi-hop opportunity', {
      id: opportunity.id,
      type: opportunity.type,
      hops: opportunity.hops,
      path: opportunity.path,
      profit: `${opportunity.profitPercentage.toFixed(2)}%`,
    });
  }

  /**
   * Get list of unique tokens available for multi-hop paths.
   */
  private getAvailableTokens(): string[] {
    const tokens = new Set<string>();
    for (const pair of this.config.pairs) {
      tokens.add(pair.token0Symbol);
      tokens.add(pair.token1Symbol);
    }
    return Array.from(tokens);
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

// =============================================================================
// Cross-Chain Simulator (Solution S2)
// =============================================================================

/**
 * Bridge cost configuration for cross-chain opportunities.
 * Costs are in USD and include protocol fees + typical gas.
 */
export interface BridgeCostConfig {
  /** Fixed cost in USD */
  fixedCost: number;
  /** Percentage fee (0.001 = 0.1%) */
  percentageFee: number;
  /** Estimated bridge time in seconds */
  estimatedTimeSeconds: number;
}

/**
 * Default bridge costs per route.
 * Format: 'sourceChain-destChain' -> costs
 */
const DEFAULT_BRIDGE_COSTS: Record<string, BridgeCostConfig> = {
  // Stargate routes (L1 <-> L2)
  'ethereum-arbitrum': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-optimism': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-base': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-polygon': { fixedCost: 20, percentageFee: 0.0006, estimatedTimeSeconds: 1200 },
  'ethereum-avalanche': { fixedCost: 25, percentageFee: 0.0008, estimatedTimeSeconds: 900 },
  'ethereum-bsc': { fixedCost: 20, percentageFee: 0.0006, estimatedTimeSeconds: 900 },

  // L2 <-> L2 routes (faster, cheaper)
  'arbitrum-optimism': { fixedCost: 5, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'arbitrum-base': { fixedCost: 4, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'optimism-base': { fixedCost: 3, percentageFee: 0.0003, estimatedTimeSeconds: 60 },
  'optimism-arbitrum': { fixedCost: 5, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'base-arbitrum': { fixedCost: 4, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'base-optimism': { fixedCost: 3, percentageFee: 0.0003, estimatedTimeSeconds: 60 },

  // Asia chains
  'bsc-polygon': { fixedCost: 8, percentageFee: 0.0005, estimatedTimeSeconds: 300 },
  'polygon-bsc': { fixedCost: 8, percentageFee: 0.0005, estimatedTimeSeconds: 300 },
  'avalanche-bsc': { fixedCost: 10, percentageFee: 0.0005, estimatedTimeSeconds: 300 },
  'avalanche-polygon': { fixedCost: 10, percentageFee: 0.0005, estimatedTimeSeconds: 300 },
};

/**
 * Configuration for CrossChainSimulator
 */
export interface CrossChainSimulatorConfig {
  /** Chains to simulate cross-chain opportunities between */
  chains: string[];
  /** Update interval in milliseconds */
  updateIntervalMs: number;
  /** Base volatility (percentage per update) */
  volatility: number;
  /** Minimum profit threshold after bridge costs (percentage) */
  minProfitThreshold: number;
  /** Tokens to track across chains */
  tokens: string[];
  /** Custom bridge costs (optional) */
  bridgeCosts?: Record<string, BridgeCostConfig>;
}

/**
 * Cross-chain price differential simulator.
 *
 * Maintains price state across multiple chains and detects arbitrage
 * opportunities when price differentials exceed bridge costs.
 *
 * Events emitted:
 * - 'opportunity': SimulatedOpportunity - Cross-chain arbitrage opportunity
 * - 'priceUpdate': { chain, token, price } - Price change notification
 *
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S2
 */
export class CrossChainSimulator extends EventEmitter {
  private config: CrossChainSimulatorConfig;
  private running = false;
  private interval: NodeJS.Timeout | null = null;
  private logger = createLogger('cross-chain-simulator');
  private opportunityId = 0;

  /**
   * Price state per chain per token.
   * Map<chain, Map<token, priceUsd>>
   */
  private chainPrices: Map<string, Map<string, number>> = new Map();

  /**
   * Bridge costs between chain pairs.
   * Map<'sourceChain-destChain', BridgeCostConfig>
   */
  private bridgeCosts: Map<string, BridgeCostConfig>;

  constructor(config: CrossChainSimulatorConfig) {
    super();
    this.config = {
      ...config,
      minProfitThreshold: config.minProfitThreshold ?? 0.002, // Default 0.2%
    };
    this.bridgeCosts = new Map(
      Object.entries(config.bridgeCosts ?? DEFAULT_BRIDGE_COSTS)
    );
    this.initializePrices();
  }

  /**
   * Initialize price state for all chains and tokens.
   * Adds small per-chain variation to create potential opportunities.
   */
  private initializePrices(): void {
    for (const chain of this.config.chains) {
      const chainPriceMap = new Map<string, number>();

      for (const token of this.config.tokens) {
        const basePrice = getTokenPrice(token);
        if (basePrice === 1 && !BASE_PRICES[token.toUpperCase()]) {
          // Token not in BASE_PRICES, skip it
          continue;
        }

        // Add chain-specific variation (±0.5%)
        const variation = 1 + (Math.random() - 0.5) * 0.01;
        chainPriceMap.set(token, basePrice * variation);
      }

      this.chainPrices.set(chain, chainPriceMap);
    }

    this.logger.info('Cross-chain simulator prices initialized', {
      chains: this.config.chains.length,
      tokens: this.config.tokens.length,
      bridgeRoutes: this.bridgeCosts.size,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger.info('Starting cross-chain simulator', {
      chains: this.config.chains,
      updateInterval: this.config.updateIntervalMs,
      minProfitThreshold: `${this.config.minProfitThreshold * 100}%`,
    });

    this.interval = setInterval(() => {
      this.simulateTick();
    }, this.config.updateIntervalMs);

    // Initial opportunity check
    this.detectAllCrossChainOpportunities();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.interval = clearIntervalSafe(this.interval);

    this.logger.info('Cross-chain simulator stopped');
  }

  /**
   * Simulate price updates across all chains.
   */
  private simulateTick(): void {
    // Update prices for each chain
    for (const chain of this.config.chains) {
      const chainPrices = this.chainPrices.get(chain);
      if (!chainPrices) continue;

      for (const token of this.config.tokens) {
        const currentPrice = chainPrices.get(token);
        if (!currentPrice) continue;

        // Apply random walk with volatility
        const change = (Math.random() - 0.5) * 2 * this.config.volatility;
        const newPrice = currentPrice * (1 + change);
        chainPrices.set(token, newPrice);

        this.emit('priceUpdate', { chain, token, price: newPrice });
      }
    }

    // Detect cross-chain opportunities
    this.detectAllCrossChainOpportunities();
  }

  /**
   * Check all chain pairs for cross-chain arbitrage opportunities.
   */
  private detectAllCrossChainOpportunities(): void {
    for (let i = 0; i < this.config.chains.length; i++) {
      for (let j = 0; j < this.config.chains.length; j++) {
        if (i === j) continue;

        const sourceChain = this.config.chains[i];
        const destChain = this.config.chains[j];

        for (const token of this.config.tokens) {
          const opportunity = this.detectCrossChainOpportunity(
            token,
            sourceChain,
            destChain
          );

          if (opportunity) {
            this.emit('opportunity', opportunity);
            this.logger.debug('Simulated cross-chain opportunity', {
              id: opportunity.id,
              token,
              buyChain: opportunity.buyChain,
              sellChain: opportunity.sellChain,
              profit: `${opportunity.profitPercentage.toFixed(2)}%`,
            });
          }
        }
      }
    }
  }

  /**
   * Detect cross-chain opportunity for a specific token between two chains.
   *
   * Fix P2-002: Use careful floating-point handling to avoid precision loss.
   * Bridge fees are calculated with explicit rounding to 2 decimal places.
   */
  private detectCrossChainOpportunity(
    token: string,
    sourceChain: string,
    destChain: string
  ): SimulatedOpportunity | null {
    const sourcePrice = this.chainPrices.get(sourceChain)?.get(token);
    const destPrice = this.chainPrices.get(destChain)?.get(token);

    if (!sourcePrice || !destPrice) return null;

    // Check if dest price is higher (we buy on source, sell on dest)
    if (destPrice <= sourcePrice) return null;

    // Get bridge costs
    const bridgeKey = `${sourceChain}-${destChain}`;
    const bridgeCost = this.bridgeCosts.get(bridgeKey);

    if (!bridgeCost) {
      // No bridge route available
      return null;
    }

    // Validate bridge fee percentage (must be decimal, not basis points)
    if (bridgeCost.percentageFee > 1.0) {
      this.logger.warn('Bridge percentage fee appears to be in basis points, not decimal', {
        route: bridgeKey,
        percentageFee: bridgeCost.percentageFee,
        expectedRange: '0.0001 to 0.1 (0.01% to 10%)',
      });
    }

    // Calculate profit
    const grossProfitUsd = destPrice - sourcePrice;
    const positionSize = 10000; // Assume $10k position
    const grossProfitTotal = (grossProfitUsd / sourcePrice) * positionSize;

    // Calculate bridge costs with rounding to avoid floating-point precision loss
    // Fixed cost + (position * percentage fee)
    const percentageFeeUsd = positionSize * bridgeCost.percentageFee;
    const bridgeFeeUsd = Math.round((bridgeCost.fixedCost + percentageFeeUsd) * 100) / 100;

    // Net profit (rounded to 2 decimals)
    const netProfitUsd = Math.round((grossProfitTotal - bridgeFeeUsd) * 100) / 100;
    const netProfitPercentage = netProfitUsd / positionSize;

    // Only emit if profitable above threshold
    if (netProfitPercentage < this.config.minProfitThreshold) {
      return null;
    }

    // Determine bridge protocol
    const bridgeProtocol: SimulatedBridgeProtocol =
      sourceChain === 'ethereum' || destChain === 'ethereum'
        ? 'stargate'
        : 'across';

    // Estimate gas cost (source chain swap + bridge + dest chain swap)
    const estimatedGasCost = this.estimateGasCost(sourceChain, destChain);

    return {
      id: `sim-xchain-${++this.opportunityId}`,
      type: 'cross-chain',
      chain: sourceChain, // Primary chain for compatibility
      buyChain: sourceChain,
      sellChain: destChain,
      buyDex: DEXES[sourceChain]?.[0] || 'dex',
      sellDex: DEXES[destChain]?.[0] || 'dex',
      tokenPair: `${token}/USDC`,
      buyPrice: sourcePrice,
      sellPrice: destPrice,
      profitPercentage: netProfitPercentage * 100,
      estimatedProfitUsd: netProfitUsd,
      confidence: 0.7 + Math.random() * 0.15, // Lower confidence for cross-chain
      timestamp: Date.now(),
      expiresAt: Date.now() + bridgeCost.estimatedTimeSeconds * 1000,
      isSimulated: true,
      useFlashLoan: false, // Cross-chain typically doesn't use flash loans
      bridgeProtocol,
      bridgeFee: bridgeFeeUsd,
      expectedGasCost: estimatedGasCost,
      expectedProfit: netProfitUsd - estimatedGasCost,
    };
  }

  /**
   * Estimate gas cost for cross-chain execution.
   */
  private estimateGasCost(sourceChain: string, destChain: string): number {
    // Base gas costs per chain (in USD)
    const chainGasCosts: Record<string, number> = {
      ethereum: 25,
      arbitrum: 1.5,
      optimism: 1.0,
      base: 0.5,
      polygon: 0.3,
      bsc: 0.5,
      avalanche: 2.0,
      fantom: 0.2,
      zksync: 1.0,
      linea: 0.8,
      solana: 0.01,
    };

    const sourceGas = chainGasCosts[sourceChain] || 5;
    const destGas = chainGasCosts[destChain] || 5;

    // Total: source swap + bridge tx + dest swap
    return sourceGas + destGas + 2; // Extra $2 for bridge tx
  }

  /**
   * Get current price for a token on a specific chain.
   */
  getPrice(chain: string, token: string): number | undefined {
    return this.chainPrices.get(chain)?.get(token);
  }

  /**
   * Get all prices for a token across all chains.
   */
  getAllPricesForToken(token: string): Map<string, number> {
    const prices = new Map<string, number>();
    for (const [chain, chainPrices] of this.chainPrices) {
      const price = chainPrices.get(token);
      if (price) {
        prices.set(chain, price);
      }
    }
    return prices;
  }

  isRunning(): boolean {
    return this.running;
  }
}

// =============================================================================
// Cross-Chain Simulator Factory
// =============================================================================

let crossChainSimulatorInstance: CrossChainSimulator | null = null;

/**
 * Get or create the cross-chain simulator singleton.
 */
export function getCrossChainSimulator(
  config?: Partial<CrossChainSimulatorConfig>
): CrossChainSimulator {
  if (!crossChainSimulatorInstance) {
    const defaultConfig: CrossChainSimulatorConfig = {
      chains: ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche'],
      updateIntervalMs: parseInt(process.env.SIMULATION_UPDATE_INTERVAL_MS || '2000', 10),
      volatility: parseFloat(process.env.SIMULATION_VOLATILITY || '0.015'),
      minProfitThreshold: 0.002, // 0.2%
      tokens: ['WETH', 'WBTC', 'USDC', 'USDT', 'LINK', 'UNI', 'AAVE'],
    };

    crossChainSimulatorInstance = new CrossChainSimulator({
      ...defaultConfig,
      ...config,
    });
  }

  return crossChainSimulatorInstance;
}

/**
 * Stop and reset the cross-chain simulator.
 */
export function stopCrossChainSimulator(): void {
  if (crossChainSimulatorInstance) {
    crossChainSimulatorInstance.stop();
    crossChainSimulatorInstance = null;
  }
}
