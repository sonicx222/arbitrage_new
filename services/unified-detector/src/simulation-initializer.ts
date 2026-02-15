/**
 * Simulation Initializer
 *
 * Extracted from chain-instance.ts to reduce file complexity.
 * Manages simulation lifecycle:
 * - Non-EVM simulation initialization (Solana, etc.)
 * - EVM simulation initialization (Ethereum, BSC, etc.)
 * - Pair building for simulation config
 * - Simulation callback bridging to parent state
 * - Simulated sync event processing
 *
 * Hot-path note:
 * - initializeNonEvmSimulation() is COLD path (called once during start())
 * - initializeEvmSimulation() is COLD path (called once during start())
 * - buildPairsForSimulation() is COLD path (called once during init)
 * - handleSimulatedSyncEvent() is WARM path (called during simulation, not production)
 *
 * @see chain-instance.ts (consumer)
 * @see simulation/chain.simulator.ts (ChainSimulationHandler implementation)
 */

import {
  PairActivityTracker,
  ReserveCache,
  stopAndNullify,
} from '@arbitrage/core';

import type {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
} from '@arbitrage/types';

import {
  ChainSimulationHandler,
  PairForSimulation,
  SimulationCallbacks,
} from './simulation';
import type { SnapshotManager } from './detection';
import type { ExtendedPair, Logger } from './types';
import {
  parseIntEnvVar,
  parseFloatEnvVar,
} from './types';
import {
  DEFAULT_SIMULATION_UPDATE_INTERVAL_MS,
  MIN_SIMULATION_UPDATE_INTERVAL_MS,
  MAX_SIMULATION_UPDATE_INTERVAL_MS,
  DEFAULT_SIMULATION_VOLATILITY,
  MIN_SIMULATION_VOLATILITY,
  MAX_SIMULATION_VOLATILITY,
} from './constants';

/**
 * Dependencies for SimulationInitializer construction.
 *
 * Uses getter functions for nullable services (may be null during shutdown)
 * and callbacks for parent state mutations (counters, events).
 */
export interface SimulationInitializerDeps {
  chainId: string;
  logger: Logger;
  dexes: Dex[];
  tokens: Token[];

  /** Shared reference to parent's pairs Map (populated by initializePairs) */
  pairs: Map<string, ExtendedPair>;
  /** Shared reference to parent's token-by-address lookup */
  tokensByAddress: Map<string, Token>;
  /** Shared reference to parent's pair-by-address lookup */
  pairsByAddress: Map<string, ExtendedPair>;

  activityTracker: PairActivityTracker;
  snapshotManager: SnapshotManager;

  /** Getter for nullable reserve cache (may not be initialized) */
  getReserveCache: () => ReserveCache | null;

  // Callbacks to parent for state mutation and event emission
  emit: (event: string, data: unknown) => void;
  emitPriceUpdate: (pair: ExtendedPair) => void;
  checkArbitrageOpportunity: (pair: ExtendedPair) => void;
  onOpportunityFound: () => void;
  onEventProcessed: () => void;
  onBlockUpdate: (blockNumber: number) => void;
}

/**
 * Manages simulation initialization and event handling.
 *
 * Performance Note:
 * - All initialization methods are COLD path (called once at startup)
 * - handleSimulatedSyncEvent is WARM path (simulation only, not production)
 * - No hot-path code paths exist in this module
 */
export class SimulationInitializer {
  private simulationHandler: ChainSimulationHandler | null = null;
  private readonly deps: SimulationInitializerDeps;

  constructor(deps: SimulationInitializerDeps) {
    this.deps = deps;
  }

  /**
   * Get the simulation handler for lifecycle management.
   * Used by parent's performStop() for cleanup.
   */
  getSimulationHandler(): ChainSimulationHandler | null {
    return this.simulationHandler;
  }

  /**
   * Stop and clean up simulation handler.
   * Awaits async cleanup to ensure resources are released.
   */
  async stop(): Promise<void> {
    this.simulationHandler = await stopAndNullify(this.simulationHandler);
  }

  // ===========================================================================
  // Non-EVM Simulation (Solana, etc.)
  // ===========================================================================

  /**
   * Initialize non-EVM simulation via the extracted ChainSimulationHandler.
   * Replaces inline initializeNonEvmSimulation() for cleaner separation.
   */
  async initializeNonEvmSimulation(): Promise<void> {
    const { chainId, logger, dexes, tokens } = this.deps;

    // Create handler instance
    this.simulationHandler = new ChainSimulationHandler(chainId, logger);

    // Get configured DEXes and tokens
    const dexNames = dexes.map(d => d.name);
    const tokenSymbols = tokens.map(t => t.symbol);

    // FIX Config 3.1: Validate simulation env vars to prevent unsafe values (e.g., interval=1ms causing CPU overload)
    const updateIntervalMs = parseIntEnvVar(
      process.env.SIMULATION_UPDATE_INTERVAL_MS,
      DEFAULT_SIMULATION_UPDATE_INTERVAL_MS,
      MIN_SIMULATION_UPDATE_INTERVAL_MS,
      MAX_SIMULATION_UPDATE_INTERVAL_MS
    );
    const volatility = parseFloatEnvVar(
      process.env.SIMULATION_VOLATILITY,
      DEFAULT_SIMULATION_VOLATILITY,
      MIN_SIMULATION_VOLATILITY,
      MAX_SIMULATION_VOLATILITY
    );

    // Initialize via handler with callbacks
    await this.simulationHandler.initializeNonEvmSimulation(
      {
        chainId,
        dexes: dexNames,
        tokens: tokenSymbols,
        updateIntervalMs,
        volatility,
        logger,
      },
      this.createSimulationCallbacks()
    );
  }

  // ===========================================================================
  // EVM Simulation (Ethereum, BSC, etc.)
  // ===========================================================================

  /**
   * Initialize EVM simulation via the extracted ChainSimulationHandler.
   * Replaces inline initializeSimulation() for cleaner separation.
   */
  async initializeEvmSimulation(): Promise<void> {
    const { chainId, logger } = this.deps;

    // Create handler instance
    this.simulationHandler = new ChainSimulationHandler(chainId, logger);

    // Build pairs for simulation from initialized pairs
    const pairsForSimulation = this.buildPairsForSimulation();

    if (pairsForSimulation.length === 0) {
      logger.warn('No pairs available for simulation', { chainId });
      return;
    }

    // Initialize via handler with callbacks
    await this.simulationHandler.initializeEvmSimulation(
      pairsForSimulation,
      this.createSimulationCallbacks()
    );
  }

  // ===========================================================================
  // Helpers (COLD path — called once during init)
  // ===========================================================================

  /**
   * Build PairForSimulation array from initialized pairs.
   * Used by EVM simulation to configure the ChainSimulator.
   */
  private buildPairsForSimulation(): PairForSimulation[] {
    const { pairs, tokensByAddress } = this.deps;
    const pairsForSimulation: PairForSimulation[] = [];

    for (const [pairKey, pair] of pairs) {
      // Extract token symbols from pair key (format: dex_TOKEN0_TOKEN1)
      const parts = pairKey.split('_');
      if (parts.length < 3) continue;

      const token0Symbol = parts[1];
      const token1Symbol = parts[2];

      // PERF-OPT: Use O(1) Map lookup instead of O(N) array.find()
      const token0 = tokensByAddress.get(pair.token0.toLowerCase());
      const token1 = tokensByAddress.get(pair.token1.toLowerCase());

      pairsForSimulation.push({
        key: pairKey,
        address: pair.address,
        dex: pair.dex,
        token0Symbol,
        token1Symbol,
        token0Decimals: token0?.decimals ?? 18,
        token1Decimals: token1?.decimals ?? 18,
        fee: pair.fee ?? 0.003  // Default 0.3% fee
      });
    }

    return pairsForSimulation;
  }

  /**
   * Create simulation callbacks that update instance state.
   * These callbacks bridge the ChainSimulationHandler to the parent's state.
   */
  private createSimulationCallbacks(): SimulationCallbacks {
    const deps = this.deps;

    return {
      onPriceUpdate: (update: PriceUpdate) => {
        deps.emit('priceUpdate', update);
      },

      onOpportunity: (opportunity: ArbitrageOpportunity) => {
        deps.onOpportunityFound();
        deps.emit('opportunity', opportunity);
        deps.logger.debug('Simulated opportunity detected', {
          id: opportunity.id,
          profit: `${(opportunity.profitPercentage ?? 0).toFixed(2)}%`
        });
      },

      onBlockUpdate: (blockNumber: number) => {
        deps.onBlockUpdate(blockNumber);
      },

      onEventProcessed: () => {
        deps.onEventProcessed();
      },

      // EVM simulation: Handle sync events through pair state management
      onSyncEvent: (event) => {
        this.handleSimulatedSyncEvent(event);
      }
    };
  }

  // ===========================================================================
  // Sync Event Processing (WARM path — simulation only, not production)
  // ===========================================================================

  /**
   * Handle simulated Sync events from the ChainSimulationHandler.
   * Aligned with production handleSyncEvent() to ensure consistent behavior:
   * eventsProcessed, BigInt reserves, reserveCache, activityTracker, checkArbitrageOpportunity.
   */
  private handleSimulatedSyncEvent(event: { address: string; reserve0: string; reserve1: string; blockNumber: number }): void {
    const { chainId, logger, pairsByAddress, activityTracker, snapshotManager, getReserveCache } = this.deps;
    const pairAddress = event.address.toLowerCase();
    const pair = pairsByAddress.get(pairAddress);

    if (!pair) {
      return; // Unknown pair, skip
    }

    try {
      const { reserve0, reserve1, blockNumber } = event;

      // P1-FIX: Parse BigInt reserves BEFORE recording activity (matches production order)
      const reserve0BigInt = BigInt(reserve0);
      const reserve1BigInt = BigInt(reserve1);

      // P1-FIX: Update reserve cache (matches production handleSyncEvent)
      const reserveCache = getReserveCache();
      if (reserveCache) {
        reserveCache.onSyncEvent(chainId, pairAddress, reserve0, reserve1, blockNumber);
      }

      // P1-FIX: Record activity AFTER successful parsing (matches production order)
      activityTracker.recordUpdate(pair.chainPairKey ?? `${chainId}:${pairAddress}`);

      // Update pair reserves with BigInt values (matches production direct property assignment)
      pair.reserve0 = reserve0;
      pair.reserve1 = reserve1;
      pair.reserve0BigInt = reserve0BigInt;
      pair.reserve1BigInt = reserve1BigInt;
      pair.blockNumber = blockNumber;
      pair.lastUpdate = Date.now();

      // R3 Refactor: Delegate cache invalidation to SnapshotManager
      // SnapshotManager handles version tracking and cache management internally
      snapshotManager.invalidateCache();

      // Note: eventsProcessed is incremented by onEventProcessed callback
      // (called from ChainSimulationHandler.handleSimulatedSyncEvent before onSyncEvent)

      // Calculate and emit price update
      this.deps.emitPriceUpdate(pair);

      // P1-FIX: Check for arbitrage opportunities AFTER reserves are fully updated (matches production)
      this.deps.checkArbitrageOpportunity(pair);

    } catch (error) {
      logger.error('Error processing simulated sync event', { error, pairAddress });
    }
  }
}

/**
 * Factory function for SimulationInitializer.
 * Follows codebase convention of factory functions for DI.
 */
export function createSimulationInitializer(
  deps: SimulationInitializerDeps,
): SimulationInitializer {
  return new SimulationInitializer(deps);
}
