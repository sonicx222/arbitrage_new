/**
 * Chain-Specific Simulator
 *
 * Generates simulated Sync events and arbitrage opportunities for detector integration.
 * Each chain detector gets its own ChainSimulator instance.
 *
 * Reworked 2026-03-01 for realistic simulation:
 * - Block-time-aligned intervals per chain (uses BLOCK_TIMES_MS from config)
 * - Activity-weighted pair selection (not all pairs every tick)
 * - Market regime model (quiet/normal/burst) with Markov transitions
 * - Full strategy coverage (all 13 ArbitrageOpportunity.type values)
 * - SIMULATION_REALISM_LEVEL env var (low/medium/high)
 *
 * @module simulation
 * @see docs/reports/SIMULATION_REWORK_RESEARCH_2026-03-01.md
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import { clearIntervalSafe } from '../async/lifecycle-utils';
import { getBlockTimeMs, getOpportunityTimeoutMs } from '@arbitrage/config';
import type {
  ChainSimulatorConfig,
  SimulatedPairConfig,
  SimulatedSyncEvent,
  SimulatedOpportunity,
  SimulatedOpportunityType,
  MarketRegime,
  ChainThroughputProfile,
  SampledGasPrice,
} from './types';
import {
  DEFAULT_CONFIG,
  DEXES,
  getTokenPrice,
  PAIR_ACTIVITY_TIERS,
  DEFAULT_PAIR_ACTIVITY,
  REGIME_CONFIGS,
  transitionRegime,
  selectWeightedStrategyType,
} from './constants';
import { getSimulationRealismLevel } from './mode-utils';
import { gaussianRandom, poissonRandom, weightedRandomSelect } from './math-utils';
import { CHAIN_THROUGHPUT_PROFILES, getNativeTokenPrice, selectWeightedDex } from './throughput-profiles';

// =============================================================================
// Simulation TTL
// =============================================================================

/**
 * Simulated opportunities get chain-specific TTLs multiplied by this factor.
 * Production timeouts are tuned for real pipeline latency; simulation adds
 * headroom so opportunities survive the coordinator's XREADGROUP cycle.
 */
const SIMULATION_TTL_MULTIPLIER = 3;

/**
 * Compute expiresAt for a simulated opportunity.
 *
 * @param chainId - Chain identifier (e.g. 'bsc', 'arbitrum')
 * @param strategyTtlMs - Optional strategy-specific TTL override (e.g. 2000 for backrun)
 * @returns Absolute timestamp (Date.now() + ttl)
 */
function getSimulationExpiresAt(chainId: string, strategyTtlMs?: number): number {
  const baseTtl = strategyTtlMs ?? getOpportunityTimeoutMs(chainId);
  return Date.now() + baseTtl * SIMULATION_TTL_MULTIPLIER;
}

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
  private blockTimeout: NodeJS.Timeout | null = null;
  private currentGasPrice: SampledGasPrice = { baseFee: 0, priorityFee: 0, gasCostUsd: 5 };
  private blockNumber: number;
  private reserves: Map<string, { reserve0: bigint; reserve1: bigint }> = new Map();
  private logger = createLogger('chain-simulator');
  private opportunityId = 0;

  /**
   * Fix P3-004: Configurable position size range for realistic opportunity sizing.
   */
  private readonly minPositionSize: number;
  private readonly maxPositionSize: number;

  /**
   * Market regime state for high-realism simulation.
   * Transitions via Markov chain each tick.
   */
  private currentRegime: MarketRegime = 'normal';

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

    const realismLevel = getSimulationRealismLevel();
    const hasExplicitInterval = !!process.env.SIMULATION_UPDATE_INTERVAL_MS;

    // Low realism or explicit interval: keep legacy setInterval behavior
    if (realismLevel === 'low' || hasExplicitInterval) {
      const effectiveInterval = this.getEffectiveInterval(realismLevel);
      this.logger.info('Starting chain simulator (legacy interval)', {
        chainId: this.config.chainId,
        updateInterval: effectiveInterval,
        realismLevel,
        pairs: this.config.pairs.length,
      });
      this.interval = setInterval(() => {
        this.simulateTick();
      }, effectiveInterval);
    } else {
      // Medium/high: block-driven multi-swap model
      this.logger.info('Starting chain simulator (block-driven)', {
        chainId: this.config.chainId,
        realismLevel,
        pairs: this.config.pairs.length,
        profile: CHAIN_THROUGHPUT_PROFILES[this.config.chainId] ? 'found' : 'fallback',
      });
      this.scheduleNextBlock();
    }

    this.emitAllSyncEvents();
  }

  /**
   * Determine effective update interval based on realism level.
   * - low: Use configured interval (flat 1000ms default)
   * - medium/high: Use real block time from chain config
   *
   * SIMULATION_UPDATE_INTERVAL_MS env var overrides everything.
   */
  private getEffectiveInterval(realismLevel: string): number {
    // Explicit env var override always wins
    if (process.env.SIMULATION_UPDATE_INTERVAL_MS) {
      return this.config.updateIntervalMs;
    }

    if (realismLevel === 'low') {
      return this.config.updateIntervalMs;
    }

    // medium/high: use real block time
    const blockTimeMs = getBlockTimeMs(this.config.chainId);
    // Clamp: min 100ms (prevent CPU overload), max 15000ms (don't freeze)
    return Math.max(100, Math.min(blockTimeMs, 15000));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.interval = clearIntervalSafe(this.interval);
    if (this.blockTimeout) {
      clearTimeout(this.blockTimeout);
      this.blockTimeout = null;
    }
    this.logger.info('Chain simulator stopped', { chainId: this.config.chainId });
  }

  private simulateTick(): void {
    this.blockNumber++;
    this.emit('blockUpdate', { blockNumber: this.blockNumber });

    const realismLevel = getSimulationRealismLevel();

    // Transition market regime (high realism only)
    if (realismLevel === 'high') {
      this.currentRegime = transitionRegime(this.currentRegime);
    }

    const regimeConfig = realismLevel === 'high'
      ? REGIME_CONFIGS[this.currentRegime]
      : REGIME_CONFIGS['normal']; // medium uses normal multipliers

    const effectiveArbChance = this.config.arbitrageChance * regimeConfig.arbChanceMultiplier;
    const effectiveVolatility = this.config.volatility * regimeConfig.volatilityMultiplier;

    const shouldCreateArbitrage = Math.random() < effectiveArbChance;
    let arbitragePairIndex = -1;
    let arbitrageDirection = 1;

    if (shouldCreateArbitrage && this.config.pairs.length >= 2) {
      arbitragePairIndex = Math.floor(Math.random() * this.config.pairs.length);
      arbitrageDirection = Math.random() > 0.5 ? 1 : -1;
    }

    const useActivityTiers = realismLevel !== 'low';

    for (let i = 0; i < this.config.pairs.length; i++) {
      const pair = this.config.pairs[i];
      const reserves = this.reserves.get(pair.address.toLowerCase());
      if (!reserves) continue;

      // Activity-tier filtering: skip pairs that don't trade this block
      if (useActivityTiers) {
        const pairKey = `${pair.token0Symbol}/${pair.token1Symbol}`;
        const baseActivity = PAIR_ACTIVITY_TIERS[pairKey] ?? DEFAULT_PAIR_ACTIVITY;
        const effectiveActivity = Math.min(baseActivity * regimeConfig.pairActivityMultiplier, 1.0);

        // Always allow the arbitrage pair through
        if (i !== arbitragePairIndex && Math.random() > effectiveActivity) {
          continue;
        }
      }

      let priceChange = (Math.random() - 0.5) * 2 * effectiveVolatility;

      if (i === arbitragePairIndex) {
        const spread = this.config.minArbitrageSpread +
          Math.random() * (this.config.maxArbitrageSpread - this.config.minArbitrageSpread);
        priceChange += spread * arbitrageDirection;
      }

      const newReserve1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - priceChange)));
      reserves.reserve1 = newReserve1 > 0n ? newReserve1 : 1n;

      // FIX #22: Clamp reserve ratio to prevent unbounded drift.
      // P0-3 FIX: Normalize for token decimals before comparing ratios.
      const decimalDiff = pair.token0Decimals - pair.token1Decimals;
      const decimalFactor = 10 ** decimalDiff;
      const rawRatio = Number(reserves.reserve0) / Number(reserves.reserve1);
      const normalizedRatio = rawRatio / decimalFactor;
      const MAX_RATIO = 2;
      if (normalizedRatio > MAX_RATIO || normalizedRatio < 1 / MAX_RATIO) {
        reserves.reserve1 = BigInt(Math.floor(Number(reserves.reserve0) / decimalFactor));
      }

      this.emitSyncEvent(pair, reserves.reserve0, reserves.reserve1);
    }

    if (shouldCreateArbitrage) {
      this.detectAndEmitOpportunities();
    }
  }

  // =============================================================================
  // Block-Driven Multi-Swap Model (medium/high realism)
  // =============================================================================

  /**
   * Schedule the next block using setTimeout with Gaussian jitter.
   * Replaces setInterval for medium/high realism to simulate
   * real block time variance and occasional missed slots.
   */
  private scheduleNextBlock(): void {
    if (!this.running) return;

    const profile = CHAIN_THROUGHPUT_PROFILES[this.config.chainId];
    if (!profile) {
      // Fallback for unknown chains: fixed interval
      this.blockTimeout = setTimeout(() => {
        this.simulateTick();
        this.scheduleNextBlock();
      }, this.config.updateIntervalMs);
      return;
    }

    // Missed slot check (e.g. Ethereum ~1%)
    const isMissedSlot = Math.random() < profile.slotMissRate;
    const baseDelay = isMissedSlot ? profile.blockTimeMs * 2 : profile.blockTimeMs;

    // Gaussian jitter
    const jitter = gaussianRandom() * profile.blockTimeJitterMs;
    const delay = Math.max(50, Math.round(baseDelay + jitter));

    this.blockTimeout = setTimeout(() => {
      this.simulateBlock(profile);
      this.scheduleNextBlock();
    }, delay);
  }

  /**
   * Simulate one block with Poisson-distributed swap events.
   * Each swap independently selects a DEX and pair, matching
   * real chain throughput patterns.
   */
  private simulateBlock(profile: ChainThroughputProfile): void {
    this.blockNumber++;
    this.emit('blockUpdate', { blockNumber: this.blockNumber });

    const realismLevel = getSimulationRealismLevel();

    // Regime transition (high realism only)
    if (realismLevel === 'high') {
      this.currentRegime = transitionRegime(this.currentRegime);
    }

    const regimeConfig = realismLevel === 'high'
      ? REGIME_CONFIGS[this.currentRegime]
      : REGIME_CONFIGS['normal'];

    // Sample gas price for this block
    this.currentGasPrice = this.sampleGasPrice(profile);

    // Poisson-distributed swap count
    const avgSwaps = profile.dexSwapsPerBlock * regimeConfig.pairActivityMultiplier;
    const swapCount = poissonRandom(avgSwaps);

    // Generate individual swap events
    for (let i = 0; i < swapCount; i++) {
      const dex = selectWeightedDex(profile.dexMarketShare);
      const pair = this.selectSwapPair(dex);
      if (pair) {
        this.executeSwap(pair);
      }
    }

    // Opportunity detection
    const effectiveArbChance = this.config.arbitrageChance * regimeConfig.arbChanceMultiplier;
    if (Math.random() < effectiveArbChance) {
      this.detectAndEmitOpportunities();
    }

    // Multi-hop opportunities (same as existing)
    if (Math.random() < this.config.arbitrageChance) {
      this.generateMultiHopOpportunity();
    }
  }

  /**
   * Sample gas price for a block using the chain's gas model.
   * Base fee spikes during burst regime via burstMultiplier.
   */
  private sampleGasPrice(profile: ChainThroughputProfile): SampledGasPrice {
    const gas = profile.gasModel;
    const burstMult = this.currentRegime === 'burst' ? gas.burstMultiplier : 1.0;

    const baseFee = Math.max(0, gaussianRandom(gas.baseFeeAvg * burstMult, gas.baseFeeStdDev));
    const priorityFee = Math.max(0, gaussianRandom(gas.priorityFeeAvg, gas.priorityFeeStdDev));

    const nativePrice = getNativeTokenPrice(this.config.chainId);
    const isSolana = this.config.chainId === 'solana';
    // Solana: lamports/CU * CU * SOL_price / 1e12 (lamports to SOL)
    // EVM: gwei * gas * ETH_price / 1e9 (gwei to ETH)
    const gasCostUsd = isSolana
      ? ((baseFee + priorityFee) * gas.swapGasUnits * nativePrice) / 1e12
      : ((baseFee + priorityFee) * gas.swapGasUnits * nativePrice) / 1e9;

    return { baseFee, priorityFee, gasCostUsd };
  }

  /**
   * Select a pair for a swap event, weighted by activity tier.
   * If no pairs match the selected DEX, falls back to any pair.
   */
  private selectSwapPair(dex: string): SimulatedPairConfig | null {
    if (this.config.pairs.length === 0) return null;

    const dexPairs = this.config.pairs.filter(p => p.dex === dex);
    const candidates = dexPairs.length > 0 ? dexPairs : this.config.pairs;

    const weights = candidates.map(p => {
      const key = `${p.token0Symbol}/${p.token1Symbol}`;
      return PAIR_ACTIVITY_TIERS[key] ?? DEFAULT_PAIR_ACTIVITY;
    });

    return weightedRandomSelect(candidates, weights);
  }

  /**
   * Execute a single simulated swap: apply random-walk price change
   * to pair reserves and emit a syncEvent.
   */
  private executeSwap(pair: SimulatedPairConfig): void {
    const reserves = this.reserves.get(pair.address.toLowerCase());
    if (!reserves) return;

    const realismLevel = getSimulationRealismLevel();
    const regimeConfig = realismLevel === 'high'
      ? REGIME_CONFIGS[this.currentRegime]
      : REGIME_CONFIGS['normal'];

    const effectiveVolatility = this.config.volatility * regimeConfig.volatilityMultiplier;
    const priceChange = (Math.random() - 0.5) * 2 * effectiveVolatility;

    const newReserve1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - priceChange)));
    reserves.reserve1 = newReserve1 > 0n ? newReserve1 : 1n;

    // Clamp reserve ratio (from existing code)
    const decimalDiff = pair.token0Decimals - pair.token1Decimals;
    const decimalFactor = 10 ** decimalDiff;
    const rawRatio = Number(reserves.reserve0) / Number(reserves.reserve1);
    const normalizedRatio = rawRatio / decimalFactor;
    const MAX_RATIO = 2;
    if (normalizedRatio > MAX_RATIO || normalizedRatio < 1 / MAX_RATIO) {
      reserves.reserve1 = BigInt(Math.floor(Number(reserves.reserve0) / decimalFactor));
    }

    this.emitSyncEvent(pair, reserves.reserve0, reserves.reserve1);
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

  // =============================================================================
  // Strategy-Typed Opportunity Generators
  // =============================================================================

  /**
   * Create an opportunity with type selected via weighted distribution.
   * Covers all 13 strategy types defined in ArbitrageOpportunity.type.
   *
   * In 'low' realism mode, falls back to legacy 70/30 cross-dex/flash-loan split.
   */
  private createOpportunityWithType(
    tokenPair: string,
    buyPair: { pair: SimulatedPairConfig; price: number },
    sellPair: { pair: SimulatedPairConfig; price: number },
    minPrice: number,
    maxPrice: number,
    netProfit: number
  ): SimulatedOpportunity {
    const positionSize = this.calculatePositionSize();
    const estimatedProfitUsd = netProfit * positionSize;
    const estimatedGasCost = this.currentGasPrice.gasCostUsd > 0
      ? this.currentGasPrice.gasCostUsd * (0.8 + Math.random() * 0.4) // +-20% variance
      : 5 + Math.random() * 15; // fallback for low realism

    const now = Date.now();
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
      timestamp: now,
      expiresAt: getSimulationExpiresAt(this.config.chainId),
      isSimulated: true as const,
      expectedGasCost: estimatedGasCost,
      expectedProfit: estimatedProfitUsd - estimatedGasCost,
      // RT-007 FIX: Synthetic pipeline timestamps so LatencyTracker records
      // samples during simulation mode (exercises the same code path as live).
      pipelineTimestamps: {
        wsReceivedAt: now - 8,
        publishedAt: now - 5,
        consumedAt: now - 2,
      },
    };

    const realismLevel = getSimulationRealismLevel();

    // Low realism: legacy 70/30 split (cross-dex / flash-loan)
    if (realismLevel === 'low') {
      if (Math.random() < 0.70) {
        return { ...baseOpportunity, type: 'cross-dex', useFlashLoan: false };
      }
      const flashLoanFee = 0.0009;
      return {
        ...baseOpportunity,
        type: 'flash-loan',
        useFlashLoan: true,
        flashLoanFee,
        expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
      };
    }

    // Medium/high: weighted strategy selection
    const selectedType = selectWeightedStrategyType();
    return this.buildTypedOpportunity(selectedType, baseOpportunity, estimatedProfitUsd, estimatedGasCost);
  }

  /**
   * Build an opportunity with the selected strategy type and correct fields.
   */
  private buildTypedOpportunity(
    type: SimulatedOpportunityType,
    base: {
      id: string; chain: string; buyChain: string; sellChain: string;
      buyDex: string; sellDex: string; tokenPair: string;
      buyPrice: number; sellPrice: number; profitPercentage: number;
      estimatedProfitUsd: number; confidence: number; timestamp: number;
      expiresAt: number; isSimulated: true; expectedGasCost: number;
      expectedProfit: number;
    },
    estimatedProfitUsd: number,
    estimatedGasCost: number,
  ): SimulatedOpportunity {
    const flashLoanFee = 0.0009;

    switch (type) {
      // --- No-flash-loan types ---
      case 'simple':
      case 'cross-dex':
      case 'intra-dex':
        return { ...base, type, useFlashLoan: false };

      // --- Flash-loan type ---
      case 'flash-loan':
        return {
          ...base,
          type: 'flash-loan',
          useFlashLoan: true,
          flashLoanFee,
          expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
        };

      // --- Multi-hop types (handled via generateMultiHopOpportunity, emit basic here) ---
      case 'triangular':
      case 'quadrilateral':
      case 'multi-leg':
        // These get generated with paths in generateMultiHopOpportunity().
        // When selected here, emit as flash-loan since multi-hop requires capital.
        return {
          ...base,
          type: 'flash-loan',
          useFlashLoan: true,
          flashLoanFee,
          expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
        };

      // --- Backrun (MEV-Share) ---
      case 'backrun':
        return {
          ...base,
          id: `sim-${base.chain}-backrun-${base.id.split('-').pop()}`,
          type: 'backrun',
          useFlashLoan: false,
          confidence: 0.65 + Math.random() * 0.2, // Lower confidence for MEV
          expiresAt: getSimulationExpiresAt(base.chain, 2000), // Fast expiry
        };

      // --- UniswapX Dutch auction fill ---
      case 'uniswapx':
        return {
          ...base,
          id: `sim-${base.chain}-uniswapx-${base.id.split('-').pop()}`,
          type: 'uniswapx',
          useFlashLoan: false,
          confidence: 0.70 + Math.random() * 0.15,
          expiresAt: getSimulationExpiresAt(base.chain, 10000), // Dutch auctions have longer windows
        };

      // --- Statistical (mean-reversion) ---
      case 'statistical':
        return {
          ...base,
          id: `sim-${base.chain}-stat-${base.id.split('-').pop()}`,
          type: 'statistical',
          useFlashLoan: true,
          flashLoanFee,
          confidence: 0.60 + Math.random() * 0.2, // Statistical models have varying confidence
          expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
        };

      // --- Predictive (ML-based) ---
      case 'predictive':
        return {
          ...base,
          id: `sim-${base.chain}-pred-${base.id.split('-').pop()}`,
          type: 'predictive',
          useFlashLoan: false,
          confidence: 0.55 + Math.random() * 0.15, // ML predictions are lower confidence
          expiresAt: getSimulationExpiresAt(base.chain, 15000), // Predictions have longer time horizon
        };

      // --- Solana-specific ---
      case 'solana':
        return {
          ...base,
          type: 'solana',
          useFlashLoan: false,
          expiresAt: getSimulationExpiresAt(base.chain, 1000), // Fast Solana block times
        };

      // --- Cross-chain (shouldn't hit here often, mostly from CrossChainSimulator) ---
      case 'cross-chain':
        return { ...base, type: 'cross-dex', useFlashLoan: false };

      default:
        return { ...base, type: 'cross-dex', useFlashLoan: false };
    }
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

    // Single-chain types must have same buy/sell chains
    const singleChainTypes: SimulatedOpportunityType[] = [
      'simple', 'cross-dex', 'intra-dex', 'flash-loan',
      'triangular', 'quadrilateral', 'multi-leg',
      'backrun', 'uniswapx', 'statistical', 'predictive', 'solana',
    ];
    if (singleChainTypes.includes(opportunity.type)) {
      if (opportunity.buyChain !== opportunity.sellChain) {
        throw new Error(
          `[SIMULATION_ERROR] ${opportunity.type} opportunity must have same buy/sell chains. ` +
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
      expiresAt: getSimulationExpiresAt(this.config.chainId, 3000),
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

  getCurrentRegime(): MarketRegime {
    return this.currentRegime;
  }
}

// =============================================================================
// Chain Simulator Factory
// =============================================================================

const chainSimulators = new Map<string, ChainSimulator>();

/**
 * Get or create a chain-specific simulator.
 * Used by ChainDetectorInstance when SIMULATION_MODE is enabled.
 *
 * Uses real block time from chain config for medium/high realism levels.
 * Falls back to DEFAULT_CONFIG.updateIntervalMs for low realism or env override.
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
