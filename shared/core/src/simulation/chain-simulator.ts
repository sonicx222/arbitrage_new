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
 * - Always uses block-driven model with regime transitions
 *
 * @module simulation
 * @see docs/reports/SIMULATION_REWORK_RESEARCH_2026-03-01.md
 */

import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger';
import type { SwapEvent } from '@arbitrage/types';
import type { WhaleAlert } from '../analytics/swap-event-filter';
import { clearIntervalSafe } from '../async/lifecycle-utils';
import { getBlockTimeMs, getOpportunityTimeoutMs, FLASH_LOAN_PROVIDERS } from '@arbitrage/config';
import { FEE_CONSTANTS, bpsToDecimal } from '../utils/fee-utils';
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
  DEFAULT_FAST_LANE_RATE,
  selectFastLaneStrategyType,
  getCorrelatedTokens,
  PEGGED_PAIRS,
} from './constants';
import type { PeggedPairConfig } from './constants';
import { FAST_LANE_CONFIG } from '@arbitrage/config';
import { gaussianRandom, poissonRandom, weightedRandomSelect } from './math-utils';
import { CHAIN_THROUGHPUT_PROFILES, getNativeTokenPrice, selectWeightedDex } from './throughput-profiles';
import { getSimulationRealismLevel } from './mode-utils';

// =============================================================================
// Simulation TTL
// =============================================================================

/**
 * Simulated opportunities get chain-specific TTLs multiplied by this factor.
 * Production timeouts are tuned for real pipeline latency; simulation adds
 * headroom so opportunities survive the coordinator's XREADGROUP cycle.
 */
const SIMULATION_TTL_MULTIPLIER = 3;

/** Default fraction of simulated swaps that are whale-sized. Overridden by SIMULATION_WHALE_RATE. */
const DEFAULT_WHALE_RATE = 0.05;

/**
 * Default USD threshold above which a swap emits a 'whaleAlert' event.
 * Matches EVENT_CONFIG.swapEvents.whaleThreshold. Overridden by SIMULATION_WHALE_THRESHOLD_USD.
 */
const DEFAULT_WHALE_THRESHOLD_USD = 50_000;

// =============================================================================
// Per-DEX Fee Tiers (Task 0.4)
// =============================================================================

/**
 * V3 DEX fee tier weights for pair-type-based selection.
 * Blue-chip/stablecoin pairs mostly use 0.05% (500), others 0.3% (3000).
 */
const V3_FEE_TIERS = [0.0001, 0.0005, 0.003, 0.01]; // 0.01%, 0.05%, 0.3%, 1%

/** Stablecoin symbols for fee tier selection */
const STABLECOINS = new Set(['USDC', 'USDT', 'BUSD', 'DAI', 'FRAX', 'SUSD', 'USDB']);

/** Blue-chip token symbols that typically trade at low fee tiers */
const BLUE_CHIPS = new Set(['WETH', 'ETH', 'WBTC', 'BTCB', 'SOL', 'WBNB', 'BNB']);

// =============================================================================
// Batch 2: Gas & Fee Constants (Tasks 2.1, 2.3, 2.5)
// =============================================================================

/**
 * Pool TVL per side in USD for slippage calculation (Task 2.5).
 * Matches the TARGET_SIDE_USD used in initializeReserves().
 */
const POOL_SIDE_USD = 10_000_000;

/**
 * Task 2.3: Hourly gas multiplier (UTC).
 * Peak: 1.5x during 14-17 UTC (EU/US overlap).
 * Trough: 0.5x during 3-5 UTC (global off-peak).
 *
 * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Task 2.3
 */
export const HOURLY_GAS_MULTIPLIER: readonly number[] = [
  // 0-5 UTC: off-peak
  0.6, 0.55, 0.5, 0.5, 0.5, 0.55,
  // 6-11 UTC: Asia evening / Europe morning ramp-up
  0.7, 0.8, 0.9, 1.0, 1.1, 1.2,
  // 12-17 UTC: Europe/US overlap — peak
  1.3, 1.4, 1.5, 1.5, 1.4, 1.3,
  // 18-23 UTC: US afternoon / evening wind-down
  1.2, 1.1, 1.0, 0.9, 0.8, 0.7,
];

/**
 * Get the realistic DEX fee for a given DEX and token pair.
 * V3 DEXes: fee tier depends on pair type (stablecoin pairs → 0.01%, blue-chip → 0.05%, others → 0.3%).
 * V2 DEXes: fixed 0.3%.
 */
function getDexFee(dexName: string, token0Symbol: string, token1Symbol: string): number {
  const isV3 = dexName.includes('_v3') || dexName === 'syncswap' || dexName === 'aerodrome';

  if (!isV3) {
    return FEE_CONSTANTS.DEFAULT; // 0.3% for V2 DEXes
  }

  const isStableStable = STABLECOINS.has(token0Symbol.toUpperCase()) && STABLECOINS.has(token1Symbol.toUpperCase());
  const hasBluechip = BLUE_CHIPS.has(token0Symbol.toUpperCase()) || BLUE_CHIPS.has(token1Symbol.toUpperCase());
  const hasStable = STABLECOINS.has(token0Symbol.toUpperCase()) || STABLECOINS.has(token1Symbol.toUpperCase());

  if (isStableStable) return V3_FEE_TIERS[0]; // 0.01%
  if (hasBluechip && hasStable) return V3_FEE_TIERS[1]; // 0.05%
  if (hasBluechip) return V3_FEE_TIERS[2]; // 0.3%
  return V3_FEE_TIERS[2]; // 0.3% default for V3
}

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
// SM-009 FIX: Token address + amount helpers for execution validation
// =============================================================================

/**
 * Get token address from pair config, falling back to a deterministic mock
 * address derived from the symbol. The execution engine validation only
 * checks `typeof tokenIn === 'string' && tokenIn !== ''`, so any non-empty
 * address works in simulation mode.
 */
function getTokenAddress(pair: SimulatedPairConfig, isToken0: boolean): string {
  if (isToken0 && pair.token0Address) return pair.token0Address;
  if (!isToken0 && pair.token1Address) return pair.token1Address;
  // Deterministic mock: 0x + hex-encoded symbol, zero-padded to 40 chars
  const symbol = isToken0 ? pair.token0Symbol : pair.token1Symbol;
  const hex = Buffer.from(symbol.toUpperCase()).toString('hex');
  return '0x' + hex.padStart(40, '0');
}

/**
 * Calculate raw amountIn string from USD position size.
 * Returns all-digit string in smallest denomination (e.g. wei for 18-decimal tokens).
 */
function calculateRawAmountIn(
  positionSizeUsd: number,
  tokenSymbol: string,
  decimals: number,
): string {
  const tokenPrice = getTokenPrice(tokenSymbol) || 1;
  const tokenAmount = positionSizeUsd / tokenPrice;
  // Use safe integer range (8 decimal precision), pad remaining zeros
  const precision = Math.min(decimals, 8);
  const scaledAmount = Math.floor(tokenAmount * (10 ** precision));
  if (scaledAmount <= 0) return '1' + '0'.repeat(decimals); // fallback: 1 token
  return decimals > precision
    ? scaledAmount.toString() + '0'.repeat(decimals - precision)
    : scaledAmount.toString();
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
 * - 'swapEvent': SwapEvent - Individual swap data (medium/high realism only)
 * - 'whaleAlert': WhaleAlert - Large swap notifications (>= whaleThreshold, medium/high realism only)
 *
 * @see docs/reports/SIMULATED_WHALE_SWAP_EVENTS_RESEARCH_2026-03-06.md — Phase 1 Tasks 1-3
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

  // P2 Fix OPT-005: Pre-index pairs by DEX to avoid O(N) filter on every swap.
  // Built once at construction, avoids ~1000 array copies/sec under burst regime.
  private pairsByDex: Map<string, SimulatedPairConfig[]> = new Map();

  /**
   * Fix P3-004: Configurable position size range for realistic opportunity sizing.
   */
  private readonly minPositionSize: number;
  private readonly maxPositionSize: number;

  /**
   * Fast-lane opportunity generation rate (0-1).
   * Read from SIMULATION_FAST_LANE_RATE env var, config, or DEFAULT_FAST_LANE_RATE.
   */
  private readonly fastLaneRate: number;
  private fastLaneOpportunityId = 0;

  // ===========================================================================
  // Phase 1: Whale Simulation Fields (Tasks 1-3)
  // ===========================================================================

  /** Fraction of simulated swaps that are whale-sized. Read from SIMULATION_WHALE_RATE. */
  private readonly whaleRate: number;

  /** USD threshold above which a swap emits a 'whaleAlert' event. */
  private readonly whaleThresholdUsd: number;

  /**
   * Deterministic wallet pool: 100 normal wallets + 10 whale wallets.
   * Addresses are derived via sha256(sim-wallet-{chainId}-{i}) so they are
   * unique per chain but stable across simulator restarts.
   */
  private readonly walletPool: string[];

  /**
   * First 10 entries of walletPool reserved for whale transactions.
   * Reusing a small set enables WhaleActivityTracker pattern detection.
   */
  private readonly whaleWallets: string[];

  /**
   * Market regime state for high-realism simulation.
   * Transitions via Markov chain each tick.
   */
  private currentRegime: MarketRegime = 'normal';

  // --- Batch 2: EIP-1559 base fee tracking (Task 2.1) ---
  /** Running EIP-1559 base fee, adjusted per block. 0 = not yet initialized. */
  private eip1559BaseFee: number = 0;
  /** Swap count of the previous block, used for EIP-1559 utilization calculation. */
  private lastBlockSwapCount: number = 0;

  constructor(config: ChainSimulatorConfig) {
    super();
    this.config = config;
    this.blockNumber = Math.floor(Date.now() / 1000);
    this.minPositionSize = config.minPositionSize ?? 1000;
    this.maxPositionSize = config.maxPositionSize ?? 50000;
    const envRate = process.env.SIMULATION_FAST_LANE_RATE;
    this.fastLaneRate = envRate !== undefined ? parseFloat(envRate) : (config.fastLaneRate ?? DEFAULT_FAST_LANE_RATE);

    // Phase 1 whale simulation init
    const envWhaleRate = process.env.SIMULATION_WHALE_RATE;
    this.whaleRate = envWhaleRate !== undefined ? parseFloat(envWhaleRate) : DEFAULT_WHALE_RATE;
    const envWhaleThreshold = process.env.SIMULATION_WHALE_THRESHOLD_USD;
    this.whaleThresholdUsd = envWhaleThreshold !== undefined
      ? parseFloat(envWhaleThreshold)
      : DEFAULT_WHALE_THRESHOLD_USD;

    // Build 100-wallet pool; first 10 are the whale sub-pool
    this.walletPool = this.buildWalletPool(110);
    this.whaleWallets = this.walletPool.slice(0, 10);

    this.initializeReserves();
    this.buildDexIndex();
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

  private buildDexIndex(): void {
    this.pairsByDex.clear();
    for (const pair of this.config.pairs) {
      let bucket = this.pairsByDex.get(pair.dex);
      if (!bucket) {
        bucket = [];
        this.pairsByDex.set(pair.dex, bucket);
      }
      bucket.push(pair);
    }
  }

  private initializeReserves(): void {
    // Target ~$10M per side of pool (20M total TVL).
    // This produces realistic price impact: a $50K trade moves price ~0.5%,
    // while a $500K whale trade moves price ~5%.
    const TARGET_SIDE_USD = 10_000_000;

    for (const pair of this.config.pairs) {
      const basePrice0 = getTokenPrice(pair.token0Symbol);
      const basePrice1 = getTokenPrice(pair.token1Symbol);

      // Scale reserves so each side holds ~$10M of value
      const reserve0Base = Math.floor(TARGET_SIDE_USD / basePrice0);
      const reserve1Base = Math.floor(TARGET_SIDE_USD / basePrice1);

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

    const hasExplicitInterval = !!process.env.SIMULATION_UPDATE_INTERVAL_MS;

    if (hasExplicitInterval) {
      // Explicit interval override: use flat setInterval (for benchmarking/testing)
      this.logger.info('Starting chain simulator (explicit interval override)', {
        chainId: this.config.chainId,
        updateInterval: this.config.updateIntervalMs,
        pairs: this.config.pairs.length,
      });
      this.interval = setInterval(() => {
        this.simulateTick();
      }, this.config.updateIntervalMs);
    } else {
      // Block-driven multi-swap model (default)
      this.logger.info('Starting chain simulator (block-driven)', {
        chainId: this.config.chainId,
        pairs: this.config.pairs.length,
        profile: CHAIN_THROUGHPUT_PROFILES[this.config.chainId] ? 'found' : 'fallback',
      });
      this.scheduleNextBlock();
    }

    this.emitAllSyncEvents();
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

    // Transition market regime
    this.currentRegime = transitionRegime(this.currentRegime);
    const regimeConfig = REGIME_CONFIGS[this.currentRegime];

    const effectiveArbChance = this.config.arbitrageChance * regimeConfig.arbChanceMultiplier;
    const effectiveVolatility = this.config.volatility * regimeConfig.volatilityMultiplier;

    const shouldCreateArbitrage = Math.random() < effectiveArbChance;
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

      // Activity-tier filtering: skip pairs that don't trade this block
      const pairKey = `${pair.token0Symbol}/${pair.token1Symbol}`;
      const baseActivity = PAIR_ACTIVITY_TIERS[pairKey] ?? DEFAULT_PAIR_ACTIVITY;
      const effectiveActivity = Math.min(baseActivity * regimeConfig.pairActivityMultiplier, 1.0);

      // Always allow the arbitrage pair through
      if (i !== arbitragePairIndex && Math.random() > effectiveActivity) {
        continue;
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

    // Fast-lane opportunity generation (independent from regular arb detection)
    this.tryGenerateFastLaneOpportunity();
  }

  // =============================================================================
  // Block-Driven Multi-Swap Model
  // =============================================================================

  /**
   * Schedule the next block using setTimeout with Gaussian jitter.
   * Uses setTimeout with jitter to simulate
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

    // Transition market regime
    this.currentRegime = transitionRegime(this.currentRegime);
    const regimeConfig = REGIME_CONFIGS[this.currentRegime];

    // Task 2.1: Adjust EIP-1559 baseFee based on previous block's utilization
    this.adjustEip1559BaseFee(profile, this.lastBlockSwapCount);

    // Sample gas price for this block (uses EIP-1559 tracked baseFee)
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

    // Task 2.1: Save swap count for next block's EIP-1559 adjustment
    this.lastBlockSwapCount = swapCount;

    // Opportunity detection
    const effectiveArbChance = this.config.arbitrageChance * regimeConfig.arbChanceMultiplier;
    if (Math.random() < effectiveArbChance) {
      this.detectAndEmitOpportunities();
    }

    // Multi-hop opportunities (same as existing)
    if (Math.random() < this.config.arbitrageChance) {
      this.generateMultiHopOpportunity();
    }

    // Fast-lane opportunity generation (independent from regular arb detection)
    this.tryGenerateFastLaneOpportunity();
  }

  /**
   * Sample gas price for a block using the chain's gas model.
   *
   * Batch 2 enhancements:
   * - Task 2.1: EIP-1559 tracked baseFee replaces static baseFeeAvg
   * - Task 2.2: L1 data fee added for rollup chains
   * - Task 2.3: Time-of-day hourly multiplier applied to baseFee
   *
   * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Tasks 2.1-2.3
   */
  private sampleGasPrice(profile: ChainThroughputProfile): SampledGasPrice {
    const gas = profile.gasModel;
    const burstMult = this.currentRegime === 'burst' ? gas.burstMultiplier : 1.0;

    // Task 2.1: Use EIP-1559 tracked baseFee instead of static average
    const eip1559Base = this.eip1559BaseFee > 0 ? this.eip1559BaseFee : gas.baseFeeAvg;

    // Task 2.3: Time-of-day multiplier (UTC hour index)
    const hourlyMult = HOURLY_GAS_MULTIPLIER[new Date().getUTCHours()];

    const baseFee = Math.max(0, gaussianRandom(eip1559Base * burstMult * hourlyMult, gas.baseFeeStdDev));
    const priorityFee = Math.max(0, gaussianRandom(gas.priorityFeeAvg, gas.priorityFeeStdDev));

    const nativePrice = getNativeTokenPrice(this.config.chainId);
    const isSolana = this.config.chainId === 'solana';
    // Solana: lamports/CU * CU * SOL_price / 1e12 (lamports to SOL)
    // EVM: gwei * gas * ETH_price / 1e9 (gwei to ETH)
    let gasCostUsd = isSolana
      ? ((baseFee + priorityFee) * gas.swapGasUnits * nativePrice) / 1e12
      : ((baseFee + priorityFee) * gas.swapGasUnits * nativePrice) / 1e9;

    // Task 2.2: L1 data fee for rollup chains
    // L1 data posting cost is always priced in ETH regardless of native token
    if (gas.l1BaseFeeGwei && gas.l1FeeScalar && gas.txDataBytes) {
      const ethPrice = getTokenPrice('WETH');
      const l1DataFeeGwei = gas.txDataBytes * gas.l1BaseFeeGwei * gas.l1FeeScalar;
      const l1DataFeeUsd = (l1DataFeeGwei * ethPrice) / 1e9;
      gasCostUsd += l1DataFeeUsd;
    }

    return { baseFee, priorityFee, gasCostUsd };
  }

  /**
   * Task 2.1: Adjust EIP-1559 base fee based on block utilization.
   *
   * Real EIP-1559 adjusts baseFee by up to ±12.5% per block:
   * - If block is >100% utilized: baseFee increases (up to +12.5% at 200% full)
   * - If block is <100% utilized: baseFee decreases (up to -12.5% at 0% full)
   *
   * baseFee_next = baseFee * (1 + (utilization - 1) / 8)
   * Clamped to [baseFeeAvg * 0.1, baseFeeAvg * 20].
   *
   * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Task 2.1
   */
  private adjustEip1559BaseFee(profile: ChainThroughputProfile, previousBlockSwaps: number): void {
    const gas = profile.gasModel;
    if (this.eip1559BaseFee === 0) {
      this.eip1559BaseFee = gas.baseFeeAvg;
    }
    const targetSwaps = profile.dexSwapsPerBlock;
    if (targetSwaps <= 0) return;

    const utilization = previousBlockSwaps / targetSwaps;
    // EIP-1559: ±12.5% max adjustment per block
    const change = (utilization - 1) / 8;
    this.eip1559BaseFee *= (1 + change);

    // Clamp to reasonable range
    this.eip1559BaseFee = Math.max(
      gas.baseFeeAvg * 0.1,
      Math.min(this.eip1559BaseFee, gas.baseFeeAvg * 20),
    );
  }

  /**
   * Select a pair for a swap event, weighted by activity tier.
   * If no pairs match the selected DEX, falls back to any pair.
   */
  private selectSwapPair(dex: string): SimulatedPairConfig | null {
    if (this.config.pairs.length === 0) return null;

    // P2 Fix OPT-005: Use pre-indexed map instead of O(N) filter per swap
    const dexPairs = this.pairsByDex.get(dex);
    const candidates = dexPairs && dexPairs.length > 0 ? dexPairs : this.config.pairs;

    const weights = candidates.map(p => {
      const key = `${p.token0Symbol}/${p.token1Symbol}`;
      return PAIR_ACTIVITY_TIERS[key] ?? DEFAULT_PAIR_ACTIVITY;
    });

    return weightedRandomSelect(candidates, weights);
  }

  /**
   * Execute a single simulated swap on a pair.
   * Updates reserves using constant-product AMM formula, applies correlation
   * propagation and mean-reversion for pegged pairs, emits SwapEvent and
   * optionally WhaleAlert for large trades.
   *
   * Batch 1 enhancements:
   * - Task 1.3: Constant-product AMM (x+dx)(y-dy)=xy for price impact
   * - Task 1.2: Correlation propagation to related tokens
   * - Task 1.4: Ornstein-Uhlenbeck mean-reversion for pegged pairs
   *
   * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Tasks 1.2-1.4
   */
  private executeSwap(pair: SimulatedPairConfig): void {
    const reserves = this.reserves.get(pair.address.toLowerCase());
    if (!reserves) return;

    const regimeConfig = REGIME_CONFIGS[this.currentRegime];

    // --- Task 1.3: Constant-product AMM price impact ---
    // Sample trade size first — it determines the price impact
    const isWhale = Math.random() < this.whaleRate;
    const profile = CHAIN_THROUGHPUT_PROFILES[this.config.chainId];
    const tradeSize = this.sampleTradeSize(profile, isWhale);

    // Determine swap direction: 50/50 buy vs sell token0
    const buyToken0 = Math.random() < 0.5;

    // Convert trade size (USD) to token amount in smallest units
    const inSymbol = buyToken0 ? pair.token1Symbol : pair.token0Symbol;
    const inDecimals = buyToken0 ? pair.token1Decimals : pair.token0Decimals;
    const inPrice = getTokenPrice(inSymbol);
    const inTokenAmount = tradeSize / inPrice;
    const dxRaw = BigInt(Math.floor(inTokenAmount * (10 ** inDecimals)));

    // Constant-product: (x + dx)(y - dy) = x * y
    // dy = y * dx / (x + dx)
    const x = buyToken0 ? reserves.reserve1 : reserves.reserve0;
    const y = buyToken0 ? reserves.reserve0 : reserves.reserve1;

    const effectiveVolatility = this.config.volatility * regimeConfig.volatilityMultiplier;

    // Pegged pairs simulate concentrated liquidity — attenuate AMM impact + noise
    const pairKey = `${pair.token0Symbol}/${pair.token1Symbol}`;
    const isPegged = PEGGED_PAIRS[pairKey] !== undefined;
    const ammScale = isPegged ? 0.1 : 1.0;

    if (x > 0n && y > 0n && dxRaw > 0n) {
      // For pegged pairs, scale down the input to simulate concentrated liquidity depth
      const scaledDx = isPegged ? (dxRaw / 10n || 1n) : dxRaw;
      const dy = (y * scaledDx) / (x + scaledDx);
      if (dy > 0n && dy < y) {
        if (buyToken0) {
          reserves.reserve1 = reserves.reserve1 + scaledDx;
          reserves.reserve0 = reserves.reserve0 - dy;
        } else {
          reserves.reserve0 = reserves.reserve0 + scaledDx;
          reserves.reserve1 = reserves.reserve1 - dy;
        }
      } else {
        const fallbackChange = (Math.random() - 0.5) * 2 * effectiveVolatility * ammScale;
        const newR1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - fallbackChange)));
        reserves.reserve1 = newR1 > 0n ? newR1 : 1n;
      }
    } else {
      const fallbackChange = (Math.random() - 0.5) * 2 * effectiveVolatility * ammScale;
      const newR1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - fallbackChange)));
      reserves.reserve1 = newR1 > 0n ? newR1 : 1n;
    }

    // Add regime-dependent noise (attenuated for pegged pairs)
    const noiseScale = isPegged ? 0.05 : 0.3;
    const noise = (Math.random() - 0.5) * 2 * effectiveVolatility * noiseScale;
    if (noise !== 0) {
      const adjustedReserve1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - noise)));
      reserves.reserve1 = adjustedReserve1 > 0n ? adjustedReserve1 : 1n;
    }

    // --- Task 1.4: Ornstein-Uhlenbeck mean-reversion for pegged pairs ---
    this.applyMeanReversion(pair, reserves);

    // Safety: ensure both reserves are always positive
    if (reserves.reserve0 <= 0n) reserves.reserve0 = 1n;
    if (reserves.reserve1 <= 0n) reserves.reserve1 = 1n;

    // Clamp reserve ratio to prevent unbounded drift
    const decimalDiff = pair.token0Decimals - pair.token1Decimals;
    const decimalFactor = 10 ** decimalDiff;
    const rawRatio = Number(reserves.reserve0) / Number(reserves.reserve1);
    const normalizedRatio = rawRatio / decimalFactor;
    const MAX_RATIO = 2;
    if (normalizedRatio > MAX_RATIO || normalizedRatio < 1 / MAX_RATIO) {
      const clamped = BigInt(Math.floor(Number(reserves.reserve0) / decimalFactor));
      reserves.reserve1 = clamped > 0n ? clamped : 1n;
    }

    // Calculate actual price change for SwapEvent direction inference
    const priceBefore = buyToken0
      ? Number(x) / (Number(y) || 1)
      : (Number(y) || 1) / Number(x);
    const priceAfter = Number(reserves.reserve1) / (Number(reserves.reserve0) || 1);
    const priceChange = priceBefore > 0 ? (priceAfter - priceBefore) / priceBefore : 0;

    // Emit SwapEvent
    const wallet = this.selectWallet(isWhale);
    const swapEvent = this.buildSwapEvent(pair, priceChange, tradeSize, wallet);
    this.emit('swapEvent', swapEvent);

    // Emit WhaleAlert for large trades
    if (tradeSize >= this.whaleThresholdUsd) {
      const whaleAlert: WhaleAlert = {
        event: swapEvent,
        usdValue: tradeSize,
        timestamp: swapEvent.timestamp,
        chain: this.config.chainId,
        dex: pair.dex,
        pairAddress: pair.address,
      };
      this.emit('whaleAlert', whaleAlert);
    }

    // --- Task 1.2: Propagate correlated price move to related pairs ---
    this.propagateCorrelation(pair, priceChange);

    this.emitSyncEvent(pair, reserves.reserve0, reserves.reserve1);
  }

  // ===========================================================================
  // Batch 1: Mean-Reversion (Task 1.4)
  // ===========================================================================

  /**
   * Apply Ornstein-Uhlenbeck mean-reversion for pegged pairs.
   *
   * The OU process: dX = theta * (mu - X) * dt + sigma * dW
   * where X is the current price ratio, mu is the target ratio,
   * theta is the reversion speed, sigma is the peg volatility.
   */
  private applyMeanReversion(
    pair: SimulatedPairConfig,
    reserves: { reserve0: bigint; reserve1: bigint },
  ): void {
    const pairKey = `${pair.token0Symbol}/${pair.token1Symbol}`;
    const pegConfig = PEGGED_PAIRS[pairKey];
    if (!pegConfig) return;

    const decimalFactor = 10 ** (pair.token0Decimals - pair.token1Decimals);
    const currentRatio = (Number(reserves.reserve1) / Number(reserves.reserve0)) * decimalFactor;
    if (!Number.isFinite(currentRatio) || currentRatio <= 0) return;

    // OU step: theta * (mu - X) + sigma * dW
    const drift = pegConfig.meanReversionSpeed * (pegConfig.targetRatio - currentRatio);
    const diffusion = pegConfig.pegVolatility * gaussianRandom();
    const adjustment = drift + diffusion;

    // Apply adjustment to reserve1
    const factor = 1 + adjustment / currentRatio;
    const clampedFactor = Math.max(0.5, Math.min(2.0, factor));
    const newReserve1 = BigInt(Math.floor(Number(reserves.reserve1) * clampedFactor));
    reserves.reserve1 = newReserve1 > 0n ? newReserve1 : 1n;
  }

  // ===========================================================================
  // Batch 1: Correlation Propagation (Task 1.2)
  // ===========================================================================

  /**
   * Propagate a price change to all correlated pairs.
   *
   * When WETH/USDC moves, stETH/USDC, rETH/USDC, etc. co-move
   * proportionally based on the correlation coefficient.
   *
   * Propagated change: correlation * priceChange + (1-correlation) * noise
   */
  private propagateCorrelation(sourcePair: SimulatedPairConfig, priceChange: number): void {
    if (Math.abs(priceChange) < 0.0001) return;

    const token0Correlated = getCorrelatedTokens(sourcePair.token0Symbol);
    const token1Correlated = getCorrelatedTokens(sourcePair.token1Symbol);

    if (token0Correlated.length === 0 && token1Correlated.length === 0) return;

    const correlatedSymbols = new Map<string, number>();
    for (const [sym, corr] of token0Correlated) correlatedSymbols.set(sym, corr);
    for (const [sym, corr] of token1Correlated) correlatedSymbols.set(sym, corr);

    for (const pair of this.config.pairs) {
      if (pair.address === sourcePair.address) continue;

      const corr0 = correlatedSymbols.get(pair.token0Symbol.toUpperCase());
      const corr1 = correlatedSymbols.get(pair.token1Symbol.toUpperCase());
      const correlation = corr0 ?? corr1;
      if (correlation === undefined) continue;

      const reserves = this.reserves.get(pair.address.toLowerCase());
      if (!reserves) continue;

      const noise = (1 - correlation) * (Math.random() - 0.5) * 0.002;
      const propagatedChange = correlation * priceChange + noise;

      const newReserve1 = BigInt(Math.floor(Number(reserves.reserve1) * (1 - propagatedChange)));
      reserves.reserve1 = newReserve1 > 0n ? newReserve1 : 1n;
    }
  }

  // ===========================================================================
  // Phase 1: Whale Simulation Methods (Tasks 1-2)
  // ===========================================================================

  /**
   * Build a deterministic wallet address pool using sha256.
   * Each address is unique per chainId, preventing cross-chain address collisions.
   * Produces 40-char lowercase hex strings prefixed with '0x'.
   *
   * @see docs/reports/SIMULATED_WHALE_SWAP_EVENTS_RESEARCH_2026-03-06.md — Task 2
   */
  private buildWalletPool(count: number): string[] {
    return Array.from({ length: count }, (_, i) =>
      '0x' + createHash('sha256')
        .update(`sim-wallet-${this.config.chainId}-${i}`)
        .digest('hex')
        .slice(0, 40)
    );
  }

  /**
   * Select a wallet address for a simulated swap.
   * Whale wallets (first 10 of the pool) are reused repeatedly to produce
   * the repeat-transaction patterns that WhaleActivityTracker needs.
   */
  private selectWallet(isWhale: boolean): string {
    const pool = isWhale ? this.whaleWallets : this.walletPool;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Sample a trade size in USD using log-normal distribution within the
   * chain's configured trade size range. Whale trades use 2-10x the max
   * normal size to guarantee they exceed the whale threshold.
   *
   * @see docs/reports/SIMULATED_WHALE_SWAP_EVENTS_RESEARCH_2026-03-06.md — Section 5.4
   */
  private sampleTradeSize(profile: ChainThroughputProfile | undefined, isWhale: boolean): number {
    const [min, max] = profile?.tradeSizeRange ?? [1000, 50_000];
    if (isWhale) {
      // Whale trades: 2-10x the max normal trade size
      return max * (2 + Math.random() * 8);
    }
    // Log-normal distribution for realistic normal trade sizes
    const logMin = Math.log(min);
    const logMax = Math.log(max);
    const logMean = (logMin + logMax) / 2;
    const logStd = (logMax - logMin) / 4;
    const size = Math.exp(gaussianRandom(logMean, logStd));
    return Math.max(min, Math.min(size, max * 1.5)); // Soft cap at 150% of max
  }

  /**
   * Build a SwapEvent from a simulated pair swap.
   * Direction is inferred from priceChange sign:
   *   priceChange >= 0 → reserve1 decreased → token0 flowed IN, token1 flowed OUT (sell token0)
   *   priceChange <  0 → reserve1 increased → token1 flowed IN, token0 flowed OUT (buy token0)
   */
  private buildSwapEvent(
    pair: SimulatedPairConfig,
    priceChange: number,
    tradeSize: number,
    wallet: string,
  ): SwapEvent {
    // token0 is "in" when reserve1 decreased (priceChange >= 0)
    const tokenInIsToken0 = priceChange >= 0;
    const inSymbol = tokenInIsToken0 ? pair.token0Symbol : pair.token1Symbol;
    const outSymbol = tokenInIsToken0 ? pair.token1Symbol : pair.token0Symbol;
    const inDecimals = tokenInIsToken0 ? pair.token0Decimals : pair.token1Decimals;
    const outDecimals = tokenInIsToken0 ? pair.token1Decimals : pair.token0Decimals;

    const inAmount = calculateRawAmountIn(tradeSize, inSymbol, inDecimals);
    const outAmount = calculateRawAmountIn(tradeSize, outSymbol, outDecimals);

    return {
      pairAddress: pair.address,
      sender: wallet,
      recipient: wallet,
      to: wallet,
      amount0In: tokenInIsToken0 ? inAmount : '0',
      amount1In: tokenInIsToken0 ? '0' : inAmount,
      amount0Out: tokenInIsToken0 ? '0' : outAmount,
      amount1Out: tokenInIsToken0 ? outAmount : '0',
      blockNumber: this.blockNumber,
      transactionHash: '0x' + this.generateRandomHash(),
      timestamp: Date.now(),
      dex: pair.dex,
      chain: this.config.chainId,
      usdValue: tradeSize,
    };
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
   * Uses weighted strategy selection across all 13 types.
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

    // Task 2.5: Slippage deduction — effective slippage ≈ P / (2 * L)
    const poolTvlUsd = 2 * POOL_SIDE_USD;
    const slippageFraction = positionSize / poolTvlUsd;
    const slippageCostUsd = positionSize * slippageFraction;
    const estimatedProfitUsd = netProfit * positionSize - slippageCostUsd;

    const estimatedGasCost = this.currentGasPrice.gasCostUsd > 0
      ? this.currentGasPrice.gasCostUsd * (0.8 + Math.random() * 0.4) // +-20% variance
      : 5 + Math.random() * 15; // fallback when gas price not sampled

    const now = Date.now();
    const baseOpportunity = {
      id: `sim-${this.config.chainId}-${++this.opportunityId}`,
      chain: this.config.chainId,
      buyChain: this.config.chainId,
      sellChain: this.config.chainId,
      buyDex: buyPair.pair.dex,
      sellDex: sellPair.pair.dex,
      tokenPair,
      // SM-009 FIX: Populate execution-required token fields
      tokenIn: getTokenAddress(buyPair.pair, true),
      tokenOut: getTokenAddress(buyPair.pair, false),
      amountIn: calculateRawAmountIn(
        positionSize,
        buyPair.pair.token0Symbol,
        buyPair.pair.token0Decimals,
      ),
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

    // Weighted strategy selection across all 13 types
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
      tokenIn: string; tokenOut: string; amountIn: string;
      buyPrice: number; sellPrice: number; profitPercentage: number;
      estimatedProfitUsd: number; confidence: number; timestamp: number;
      expiresAt: number; isSimulated: true; expectedGasCost: number;
      expectedProfit: number;
    },
    estimatedProfitUsd: number,
    estimatedGasCost: number,
  ): SimulatedOpportunity {
    const flashLoanFee = bpsToDecimal(FLASH_LOAN_PROVIDERS[this.config.chainId]?.feeBps ?? 5);

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

      // --- Multi-hop types: generate path/hops/intermediateTokens for factory routing ---
      case 'triangular':
      case 'quadrilateral': {
        const hops = type === 'triangular' ? 3 : 4;
        const tokens = this.getAvailableTokens();
        const shuffled = [...tokens].sort(() => Math.random() - 0.5);
        const pathTokens = shuffled.slice(0, Math.min(hops, tokens.length));
        // Pad if not enough unique tokens (fallback to simpler path)
        while (pathTokens.length < hops) pathTokens.push(pathTokens[pathTokens.length - 1]);
        pathTokens.push(pathTokens[0]); // circular return
        return {
          ...base,
          type,
          useFlashLoan: true,
          flashLoanFee,
          hops,
          path: pathTokens,
          intermediateTokens: pathTokens.slice(1, -1),
          expiresAt: getSimulationExpiresAt(this.config.chainId, 3000),
          expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
        };
      }

      // --- Multi-leg: useFlashLoan=true routes to flash-loan strategy in factory ---
      case 'multi-leg':
        return {
          ...base,
          type: 'multi-leg',
          useFlashLoan: true,
          flashLoanFee,
          expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
        };

      // --- Backrun (MEV-Share): populate backrunTarget so BackrunStrategy can process ---
      case 'backrun':
        return {
          ...base,
          id: `sim-${base.chain}-backrun-${base.id.split('-').pop()}`,
          type: 'backrun',
          useFlashLoan: false,
          confidence: 0.65 + Math.random() * 0.2,
          expiresAt: getSimulationExpiresAt(base.chain, 2000),
          backrunTarget: {
            txHash: `0x${createHash('sha256').update(`sim-backrun-${Date.now()}-${Math.random()}`).digest('hex')}`,
            routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
            swapDirection: (Math.random() > 0.5 ? 'buy' : 'sell') as 'buy' | 'sell',
            source: 'mev-share',
            estimatedSwapSize: String(Math.floor(Math.random() * 100000 + 1000)),
          },
        };

      // --- UniswapX Dutch auction: populate uniswapxOrder so UniswapXFillerStrategy can process ---
      case 'uniswapx': {
        const nowSec = Math.floor(Date.now() / 1000);
        return {
          ...base,
          id: `sim-${base.chain}-uniswapx-${base.id.split('-').pop()}`,
          type: 'uniswapx',
          useFlashLoan: false,
          confidence: 0.70 + Math.random() * 0.15,
          expiresAt: getSimulationExpiresAt(base.chain, 10000),
          uniswapxOrder: {
            encodedOrder: `0x${'ab'.repeat(32)}`,
            signature: `0x${'cd'.repeat(65)}`,
            reactorAddress: '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4',
            chainId: 1,
            decayStartTime: nowSec,
            decayEndTime: nowSec + 60,
            inputToken: base.tokenIn ?? `0x${'00'.repeat(20)}`,
            inputAmount: base.amountIn ?? '1000000000000000000',
            outputToken: base.tokenOut ?? `0x${'00'.repeat(20)}`,
            outputStartAmount: String(Math.floor(estimatedProfitUsd * 1.1 * 1e6)),
            outputEndAmount: String(Math.floor(estimatedProfitUsd * 0.95 * 1e6)),
            nonce: String(Math.floor(Math.random() * 1e12)),
            deadline: nowSec + 120,
            swapper: `0x${'ef'.repeat(20)}`,
            orderHash: `0x${createHash('sha256').update(`sim-uniswapx-${Date.now()}`).digest('hex')}`,
          },
        };
      }

      // --- Statistical (mean-reversion) ---
      case 'statistical':
        return {
          ...base,
          id: `sim-${base.chain}-stat-${base.id.split('-').pop()}`,
          type: 'statistical',
          useFlashLoan: true,
          flashLoanFee,
          confidence: 0.60 + Math.random() * 0.2,
          expectedProfit: estimatedProfitUsd * (1 - flashLoanFee) - estimatedGasCost,
        };

      // --- Predictive (ML-based): routes to intra-chain strategy in factory ---
      case 'predictive':
        return {
          ...base,
          id: `sim-${base.chain}-pred-${base.id.split('-').pop()}`,
          type: 'predictive',
          useFlashLoan: false,
          confidence: 0.55 + Math.random() * 0.15,
          expiresAt: getSimulationExpiresAt(base.chain, 15000),
        };

      // --- Solana-specific ---
      case 'solana':
        return {
          ...base,
          type: 'solana',
          useFlashLoan: false,
          expiresAt: getSimulationExpiresAt(base.chain, 1000),
        };

      // --- Cross-chain: set different sellChain so factory routes to CrossChainStrategy ---
      case 'cross-chain': {
        const partnerChains = DEFAULT_CONFIG.chains.filter(c => c !== this.config.chainId);
        const sellChain = partnerChains[Math.floor(Math.random() * partnerChains.length)] ?? 'arbitrum';
        const sellDex = (DEXES[sellChain] ?? DEXES['ethereum'])[0];
        return {
          ...base,
          type: 'cross-chain',
          sellChain,
          sellDex,
          useFlashLoan: false,
          bridgeRequired: true,
        };
      }

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

    // Per-chain multi-hop base profit from config (set by factory from profitProfile)
    const [mhMin, mhMax] = this.config.multiHopBaseProfit ?? [0.008, 0.020];
    const baseProfit = mhMin + Math.random() * (mhMax - mhMin);
    // Use per-DEX fee tiers for realistic fee estimation
    const representativePair = this.config.pairs[0];
    const feePerHop = representativePair
      ? getDexFee(representativePair.dex, representativePair.token0Symbol, representativePair.token1Symbol)
      : FEE_CONSTANTS.DEFAULT;
    const totalFees = feePerHop * hops;
    const netProfit = baseProfit - totalFees;

    if (netProfit <= 0) return;

    const positionSize = this.calculatePositionSize();
    const estimatedProfitUsd = netProfit * positionSize;
    // Use per-chain gas cost (with hop multiplier) instead of hardcoded $10-$40
    const singleHopGas = this.currentGasPrice.gasCostUsd > 0
      ? this.currentGasPrice.gasCostUsd * (0.8 + Math.random() * 0.4)
      : 5 + Math.random() * 15;
    const estimatedGasCost = singleHopGas * hops;
    const flashLoanFee = bpsToDecimal(FLASH_LOAN_PROVIDERS[this.config.chainId]?.feeBps ?? 5);

    const uniqueDexes = Array.from(new Set(this.config.pairs.map(p => p.dex)));
    if (uniqueDexes.length < 2) {
      return;
    }
    const buyDex = uniqueDexes[0];
    const sellDex = uniqueDexes[1];

    // SM-009 FIX: Find pair configs for first token in path to populate tokenIn/tokenOut
    const firstToken = path[0];
    const firstPair = this.config.pairs.find(
      p => p.token0Symbol === firstToken || p.token1Symbol === firstToken
    );
    const tokenInAddress = firstPair
      ? getTokenAddress(firstPair, firstPair.token0Symbol === firstToken)
      : '0x' + Buffer.from(firstToken.toUpperCase()).toString('hex').padStart(40, '0');
    const lastToken = path[path.length - 2]; // second-to-last (last === first for circular)
    const lastPair = this.config.pairs.find(
      p => p.token0Symbol === lastToken || p.token1Symbol === lastToken
    );
    const tokenOutAddress = lastPair
      ? getTokenAddress(lastPair, lastPair.token0Symbol === lastToken)
      : '0x' + Buffer.from(lastToken.toUpperCase()).toString('hex').padStart(40, '0');
    const firstDecimals = firstPair
      ? (firstPair.token0Symbol === firstToken ? firstPair.token0Decimals : firstPair.token1Decimals)
      : 18;

    const opportunity: SimulatedOpportunity = {
      id: `sim-${this.config.chainId}-${type}-${++this.opportunityId}`,
      type,
      chain: this.config.chainId,
      buyChain: this.config.chainId,
      sellChain: this.config.chainId,
      buyDex,
      sellDex,
      tokenPair: `${path[0]}/${path[1]}`,
      // SM-009 FIX: Populate execution-required token fields
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      amountIn: calculateRawAmountIn(positionSize, firstToken, firstDecimals),
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

  // =============================================================================
  // Fast Lane Opportunity Generator
  // =============================================================================

  /**
   * Try to generate a fast-lane-eligible opportunity based on the configured rate.
   * Called once per tick/block. Generates opportunities guaranteed to pass
   * FAST_LANE_CONFIG thresholds (confidence >= minConfidence, profit >= minProfitUsd).
   *
   * Opportunities are emitted on both 'fastLaneOpportunity' and 'opportunity' events
   * so they flow through the normal pipeline AND are identifiable as fast-lane candidates.
   */
  private tryGenerateFastLaneOpportunity(): void {
    if (this.fastLaneRate <= 0) return;
    if (this.config.pairs.length < 2) return;
    if (Math.random() >= this.fastLaneRate) return;

    this.generateFastLaneOpportunity();
  }

  private generateFastLaneOpportunity(): void {
    // Pick a random pair for buy/sell
    const buyIdx = Math.floor(Math.random() * this.config.pairs.length);
    let sellIdx = Math.floor(Math.random() * this.config.pairs.length);
    // Ensure different DEXes
    if (this.config.pairs[buyIdx].dex === this.config.pairs[sellIdx].dex) {
      // Find a pair with a different DEX
      for (let i = 0; i < this.config.pairs.length; i++) {
        if (this.config.pairs[i].dex !== this.config.pairs[buyIdx].dex) {
          sellIdx = i;
          break;
        }
      }
    }

    const buyPair = this.config.pairs[buyIdx];
    const sellPair = this.config.pairs[sellIdx];

    const selectedType = selectFastLaneStrategyType();
    const flashLoanFee = bpsToDecimal(FLASH_LOAN_PROVIDERS[this.config.chainId]?.feeBps ?? 5);

    // Confidence: uniform in [minConfidence, 0.99] — always above fast-lane threshold
    const minConf = FAST_LANE_CONFIG.minConfidence;
    const confidence = minConf + Math.random() * (0.99 - minConf);

    // Position size: higher range for fast-lane to ensure profit threshold
    const minProfitUsd = FAST_LANE_CONFIG.minProfitUsd;
    // Per-chain fast-lane spread from config (set by factory from profitProfile)
    const [flMin, flMax] = this.config.fastLaneSpreadRange ?? [0.01, 0.05];
    const netProfitPct = flMin + Math.random() * (flMax - flMin);
    // Position size: ensure expectedProfit >= minProfitUsd after gas
    // expectedProfit = positionSize * netProfitPct * (1 - flashLoanFee) - gasCost
    // Solve for positionSize: (minProfitUsd + gasCost) / (netProfitPct * (1 - flashLoanFee))
    const estimatedGasCost = this.currentGasPrice.gasCostUsd > 0
      ? this.currentGasPrice.gasCostUsd * (0.8 + Math.random() * 0.4)
      : 5 + Math.random() * 15;
    const useFlashLoan = selectedType === 'flash-loan' || selectedType === 'triangular'
      || selectedType === 'multi-leg' || selectedType === 'statistical';
    const feeMultiplier = useFlashLoan ? (1 - flashLoanFee) : 1;
    const minPositionSize = (minProfitUsd + estimatedGasCost + 50) / (netProfitPct * feeMultiplier);
    const positionSize = Math.max(minPositionSize, 5000 + Math.random() * 50000);

    const estimatedProfitUsd = netProfitPct * positionSize;
    const expectedProfit = estimatedProfitUsd * feeMultiplier - estimatedGasCost;

    const now = Date.now();
    const tokenPair = `${buyPair.token0Symbol}/${buyPair.token1Symbol}`;
    const basePrice = getTokenPrice(buyPair.token0Symbol) / getTokenPrice(buyPair.token1Symbol);

    const opportunity: SimulatedOpportunity = {
      id: `sim-${this.config.chainId}-fl-${++this.fastLaneOpportunityId}`,
      type: selectedType,
      chain: this.config.chainId,
      buyChain: this.config.chainId,
      sellChain: this.config.chainId,
      buyDex: buyPair.dex,
      sellDex: sellPair.dex,
      tokenPair,
      tokenIn: getTokenAddress(buyPair, true),
      tokenOut: getTokenAddress(buyPair, false),
      amountIn: calculateRawAmountIn(positionSize, buyPair.token0Symbol, buyPair.token0Decimals),
      buyPrice: basePrice,
      sellPrice: basePrice * (1 + netProfitPct),
      profitPercentage: netProfitPct * 100,
      estimatedProfitUsd,
      confidence,
      timestamp: now,
      expiresAt: getSimulationExpiresAt(
        this.config.chainId,
        // Multi-hop types use shorter strategy-specific TTL (matches generateMultiHopOpportunity)
        (selectedType === 'triangular' || selectedType === 'multi-leg') ? 3000 : undefined,
      ),
      isSimulated: true,
      useFlashLoan,
      expectedGasCost: estimatedGasCost,
      expectedProfit,
      pipelineTimestamps: {
        wsReceivedAt: now - 8,
        publishedAt: now - 5,
        consumedAt: now - 2,
      },
      ...(useFlashLoan ? { flashLoanFee } : {}),
    };

    // Emit on both events — 'opportunity' for normal pipeline, 'fastLaneOpportunity' for identification
    this.emit('opportunity', opportunity);
    this.emit('fastLaneOpportunity', opportunity);
    this.logger.debug('Simulated fast-lane opportunity', {
      id: opportunity.id,
      type: opportunity.type,
      confidence: confidence.toFixed(3),
      expectedProfit: expectedProfit.toFixed(2),
    });
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
    // Read per-chain profit profile from throughput profiles (calibrated to real data)
    const profile = CHAIN_THROUGHPUT_PROFILES[key];
    const pp = profile?.profitProfile;

    const simulatorConfig: ChainSimulatorConfig = {
      chainId: key,
      pairs,
      updateIntervalMs: config?.updateIntervalMs ?? DEFAULT_CONFIG.updateIntervalMs,
      volatility: config?.volatility ?? DEFAULT_CONFIG.volatility,
      arbitrageChance: config?.arbitrageChance ?? 0.08,
      minArbitrageSpread: config?.minArbitrageSpread ?? pp?.minArbitrageSpread ?? 0.003,
      maxArbitrageSpread: config?.maxArbitrageSpread ?? pp?.maxArbitrageSpread ?? 0.015,
      minPositionSize: pp?.minPositionSizeUsd,
      maxPositionSize: pp?.maxPositionSizeUsd,
      fastLaneSpreadRange: pp?.fastLaneSpreadRange,
      multiHopBaseProfit: pp?.multiHopBaseProfit,
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
