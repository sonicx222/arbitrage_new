/**
 * Chain-Specific Simulator
 *
 * Generates simulated Sync events and arbitrage opportunities for detector integration.
 * Each chain detector gets its own ChainSimulator instance.
 *
 * @module simulation
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import { clearIntervalSafe } from '../async/lifecycle-utils';
import type {
  ChainSimulatorConfig,
  SimulatedPairConfig,
  SimulatedSyncEvent,
  SimulatedOpportunity,
  SimulatedOpportunityType,
} from './types';
import { DEFAULT_CONFIG, DEXES, getTokenPrice } from './constants';

// =============================================================================
// ChainSimulator
// =============================================================================

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
   */
  private calculatePositionSize(): number {
    const logMin = Math.log(this.minPositionSize);
    const logMax = Math.log(this.maxPositionSize);
    const logRandom = logMin + Math.random() * (logMax - logMin);
    const positionSize = Math.exp(logRandom);
    return Math.round(positionSize / 10) * 10;
  }

  private initializeReserves(): void {
    for (const pair of this.config.pairs) {
      const basePrice0 = getTokenPrice(pair.token0Symbol);
      const basePrice1 = getTokenPrice(pair.token1Symbol);

      const reserve0Base = 1_000_000;
      const reserve1Base = Math.floor(reserve0Base * (basePrice0 / basePrice1));

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

    this.interval = setInterval(() => {
      this.simulateTick();
    }, this.config.updateIntervalMs);

    this.emitAllSyncEvents();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.interval = clearIntervalSafe(this.interval);
    this.logger.info('Chain simulator stopped', { chainId: this.config.chainId });
  }

  private simulateTick(): void {
    this.blockNumber++;
    this.emit('blockUpdate', { blockNumber: this.blockNumber });

    const shouldCreateArbitrage = Math.random() < this.config.arbitrageChance;
    let arbitragePairIndex = -1;
    let arbitrageDirection = 1;

    if (shouldCreateArbitrage && this.config.pairs.length >= 2) {
      arbitragePairIndex = Math.floor(Math.random() * this.config.pairs.length);
      arbitrageDirection = Math.random() > 0.5 ? 1 : -1;
    }

    for (let i = 0; i < this.config.pairs.length; i++) {
      const pair = this.config.pairs[i];
      const reserves = this.reserves.get(pair.address.toLowerCase());
      if (!reserves) continue;

      let priceChange = (Math.random() - 0.5) * 2 * this.config.volatility;

      if (i === arbitragePairIndex) {
        const spread = this.config.minArbitrageSpread +
          Math.random() * (this.config.maxArbitrageSpread - this.config.minArbitrageSpread);
        priceChange += spread * arbitrageDirection;
      }

      const newReserve1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - priceChange)));
      reserves.reserve1 = newReserve1 > 0n ? newReserve1 : 1n;

      // FIX #22: Clamp reserve ratio to prevent unbounded drift.
      // FIX #22b: Tightened from 100:1 to 2:1.
      // P0-3 FIX: Normalize for token decimals before comparing ratios.
      // Previously, for cross-decimal pairs (e.g., WETH 18 / USDC 6), the raw
      // ratio was always ~10^12, triggering the clamp every tick and setting
      // reserve1 = reserve0 — a 10^12 distortion that produced billions of
      // percent profit in downstream detectors.
      const decimalDiff = pair.token0Decimals - pair.token1Decimals;
      const decimalFactor = 10 ** decimalDiff;
      const rawRatio = Number(reserves.reserve0) / Number(reserves.reserve1);
      const normalizedRatio = rawRatio / decimalFactor;
      const MAX_RATIO = 2;
      if (normalizedRatio > MAX_RATIO || normalizedRatio < 1 / MAX_RATIO) {
        // Reset to balanced state preserving correct decimal scaling
        reserves.reserve1 = BigInt(Math.floor(Number(reserves.reserve0) / decimalFactor));
      }

      this.emitSyncEvent(pair, reserves.reserve0, reserves.reserve1);
    }

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
    const data = this.encodeReserves(reserve0, reserve1);

    const syncEvent: SimulatedSyncEvent = {
      address: pair.address,
      data,
      topics: [
        '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'
      ],
      blockNumber: '0x' + this.blockNumber.toString(16),
      transactionHash: '0x' + this.generateRandomHash(),
      logIndex: '0x0'
    };

    this.emit('syncEvent', syncEvent);
  }

  private encodeReserves(reserve0: bigint, reserve1: bigint): string {
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
   */
  private detectAndEmitOpportunities(): void {
    const pairsByTokens = new Map<string, { pair: SimulatedPairConfig; price: number }[]>();

    for (const pair of this.config.pairs) {
      const tokenKey = `${pair.token0Symbol}/${pair.token1Symbol}`;
      const reserves = this.reserves.get(pair.address.toLowerCase());
      if (!reserves) continue;

      // P0-3 FIX: Normalize price for token decimals.
      // Raw reserve ratio differs by 10^(decimals0-decimals1) from the actual price.
      // For WETH(18)/USDC(6): raw = 3e-9, adjusted = 3000.
      const decimalFactor = 10 ** (pair.token0Decimals - pair.token1Decimals);
      const price = (Number(reserves.reserve1) / Number(reserves.reserve0)) * decimalFactor;

      if (!pairsByTokens.has(tokenKey)) {
        pairsByTokens.set(tokenKey, []);
      }
      pairsByTokens.get(tokenKey)!.push({ pair, price });
    }

    for (const [tokenPair, pairs] of pairsByTokens) {
      if (pairs.length < 2) continue;

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
      if (buyPair.pair.dex === sellPair.pair.dex) continue;

      const totalFees = buyPair.pair.fee + sellPair.pair.fee;
      const rawGrossProfit = (maxPrice - minPrice) / minPrice;
      // FIX #22: Clamp gross profit to realistic bounds (max 50%).
      const grossProfit = Math.min(rawGrossProfit, 0.5);
      const netProfit = grossProfit - totalFees;

      if (netProfit > 0.001) {
        const opportunity = this.createOpportunityWithType(
          tokenPair, buyPair, sellPair, minPrice, maxPrice, netProfit
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
    if (Math.random() < this.config.arbitrageChance) {
      this.generateMultiHopOpportunity();
    }
  }

  /**
   * Create an opportunity with appropriate type based on random distribution.
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
    const positionSize = this.calculatePositionSize();
    const estimatedProfitUsd = netProfit * positionSize;
    const estimatedGasCost = 5 + Math.random() * 15;

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

    if (rand < 0.70) {
      opportunity = {
        ...baseOpportunity,
        type: 'intra-chain',
        useFlashLoan: false,
      };
    } else {
      const flashLoanFee = 0.0009;
      opportunity = {
        ...baseOpportunity,
        type: 'flash-loan',
        useFlashLoan: true,
        flashLoanFee,
        expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
      };
    }

    this.validateOpportunityTypeConsistency(opportunity);
    return opportunity;
  }

  /**
   * Validate that opportunity type matches chain and DEX configuration.
   */
  private validateOpportunityTypeConsistency(opportunity: SimulatedOpportunity): void {
    if (opportunity.type === 'cross-chain') {
      if (opportunity.buyChain === opportunity.sellChain) {
        throw new Error(
          `[SIMULATION_ERROR] Cross-chain opportunity must have different buy/sell chains. ` +
          `Got: buyChain=${opportunity.buyChain}, sellChain=${opportunity.sellChain}`
        );
      }
    }

    if (opportunity.type === 'intra-chain') {
      if (opportunity.buyChain !== opportunity.sellChain) {
        throw new Error(
          `[SIMULATION_ERROR] Intra-chain opportunity must have same buy/sell chains. ` +
          `Got: buyChain=${opportunity.buyChain}, sellChain=${opportunity.sellChain}`
        );
      }
    }

    if (opportunity.type === 'triangular' || opportunity.type === 'quadrilateral') {
      if (!opportunity.useFlashLoan) {
        throw new Error(
          `[SIMULATION_ERROR] Multi-hop (${opportunity.type}) must use flash loan. ` +
          `Got: useFlashLoan=${opportunity.useFlashLoan}`
        );
      }
    }

    if (opportunity.type === 'triangular' || opportunity.type === 'quadrilateral') {
      if (!opportunity.path || opportunity.path.length === 0) {
        throw new Error(
          `[SIMULATION_ERROR] Multi-hop (${opportunity.type}) must have valid path. ` +
          `Got: path=${opportunity.path}`
        );
      }

      if (opportunity.path[0] !== opportunity.path[opportunity.path.length - 1]) {
        throw new Error(
          `[SIMULATION_ERROR] Multi-hop path must be circular (first === last token). ` +
          `Got: start=${opportunity.path[0]}, end=${opportunity.path[opportunity.path.length - 1]}`
        );
      }
    }

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
   */
  private generateMultiHopOpportunity(): void {
    const tokens = this.getAvailableTokens();
    if (tokens.length < 3) return;

    const hops = Math.random() < 0.7 ? 3 : 4;
    const type: SimulatedOpportunityType = hops === 3 ? 'triangular' : 'quadrilateral';

    const shuffled = [...tokens].sort(() => Math.random() - 0.5);
    const path = shuffled.slice(0, hops);
    path.push(path[0]);

    const baseProfit = 0.008 + Math.random() * 0.012;
    const feePerHop = 0.003;
    const totalFees = feePerHop * hops;
    const netProfit = baseProfit - totalFees;

    if (netProfit <= 0) return;

    const positionSize = this.calculatePositionSize();
    const estimatedProfitUsd = netProfit * positionSize;
    const estimatedGasCost = 10 + Math.random() * 30;
    const flashLoanFee = 0.0009;

    const uniqueDexes = Array.from(new Set(this.config.pairs.map(p => p.dex)));
    if (uniqueDexes.length < 2) {
      return;
    }
    const buyDex = uniqueDexes[0];
    const sellDex = uniqueDexes[1];

    const opportunity: SimulatedOpportunity = {
      id: `sim-${this.config.chainId}-${type}-${++this.opportunityId}`,
      type,
      chain: this.config.chainId,
      buyChain: this.config.chainId,
      sellChain: this.config.chainId,
      buyDex,
      sellDex,
      tokenPair: `${path[0]}/${path[1]}`,
      buyPrice: 1,
      sellPrice: 1 + netProfit,
      profitPercentage: netProfit * 100,
      estimatedProfitUsd,
      confidence: 0.75 + Math.random() * 0.15,
      timestamp: Date.now(),
      expiresAt: Date.now() + 3000,
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
      // W2-M2 FIX: Use DEFAULT_CONFIG values instead of divergent inline defaults
      updateIntervalMs: config?.updateIntervalMs ?? DEFAULT_CONFIG.updateIntervalMs,
      volatility: config?.volatility ?? DEFAULT_CONFIG.volatility,
      arbitrageChance: config?.arbitrageChance ?? 0.08,
      minArbitrageSpread: config?.minArbitrageSpread ?? 0.003,
      maxArbitrageSpread: config?.maxArbitrageSpread ?? 0.015
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
