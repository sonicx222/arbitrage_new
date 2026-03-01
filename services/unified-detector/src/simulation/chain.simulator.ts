/**
 * Chain Simulation Module
 *
 * Handles simulation mode for local development and testing.
 * Separates simulation logic from the hot-path detection code.
 *
 * Features:
 * - EVM chain simulation via ChainSimulator (generates Sync events)
 * - Non-EVM chain simulation (generates synthetic price updates)
 * - Configurable volatility and update intervals
 *
 * @see chain-instance.ts (parent)
 * @see ADR-003: Partitioned Chain Detectors
 */

import { clearIntervalSafe } from '@arbitrage/core/async';
import {
  ChainSimulator,
  getChainSimulator,
  stopChainSimulator,
  SimulatedPairConfig,
} from '@arbitrage/core/simulation';

import { ArbitrageOpportunity, PriceUpdate } from '@arbitrage/types';
import type { Logger } from '../types';

// =============================================================================
// Types
// =============================================================================

export interface SimulationConfig {
  chainId: string;
  updateIntervalMs: number;
  volatility: number;
  logger: Logger;
}

export interface NonEvmSimulationConfig {
  chainId: string;
  dexes: string[];
  tokens: string[];
  updateIntervalMs: number;
  volatility: number;
  logger: Logger;
}

export interface SimulationCallbacks {
  onPriceUpdate: (update: PriceUpdate) => void;
  onOpportunity: (opportunity: ArbitrageOpportunity) => void;
  onBlockUpdate: (blockNumber: number) => void;
  onEventProcessed: () => void;
  /**
   * BUG-1 FIX: Callback for raw sync events from EVM simulation.
   * Allows parent to process sync events through its own pair state management.
   * If not provided, sync events will only trigger block/event callbacks.
   */
  onSyncEvent?: (event: { address: string; reserve0: string; reserve1: string; blockNumber: number }) => void;
}

export interface PairForSimulation {
  key: string;
  address: string;
  dex: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  fee: number;
}

// =============================================================================
// Chain Simulation Handler
// =============================================================================

export class ChainSimulationHandler {
  private readonly logger: Logger;
  private readonly chainId: string;

  private chainSimulator: ChainSimulator | null = null;
  private nonEvmSimulationInterval: NodeJS.Timeout | null = null;

  private isStopping = false;
  private isRunning = false;

  constructor(chainId: string, logger: Logger) {
    this.chainId = chainId;
    this.logger = logger;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Initialize EVM chain simulation.
   * Creates simulated pairs and starts generating Sync events.
   */
  async initializeEvmSimulation(
    pairs: PairForSimulation[],
    callbacks: SimulationCallbacks
  ): Promise<void> {
    // BUGFIX: Prevent duplicate simulators if called without stop()
    // This would cause memory leaks and duplicate event processing
    if (this.chainSimulator || this.nonEvmSimulationInterval) {
      this.stop();
    }

    this.logger.info('Initializing EVM simulation mode', {
      chainId: this.chainId,
      pairs: pairs.length
    });

    // Build simulated pair configs
    const simulatedPairs: SimulatedPairConfig[] = pairs.map(pair => ({
      address: pair.address,
      token0Symbol: pair.token0Symbol,
      token1Symbol: pair.token1Symbol,
      token0Decimals: pair.token0Decimals,
      token1Decimals: pair.token1Decimals,
      dex: pair.dex,
      fee: pair.fee
    }));

    if (simulatedPairs.length === 0) {
      this.logger.warn('No pairs available for simulation', { chainId: this.chainId });
      return;
    }

    // Get or create the chain simulator
    this.chainSimulator = getChainSimulator(this.chainId, simulatedPairs);
    this.isRunning = true;

    // Set up event handlers
    this.chainSimulator.on('syncEvent', (event) => {
      if (this.isStopping || !this.isRunning) return;
      this.handleSimulatedSyncEvent(event, callbacks);
    });

    this.chainSimulator.on('blockUpdate', (data) => {
      if (this.isStopping || !this.isRunning) return;
      callbacks.onBlockUpdate(data.blockNumber);
    });

    this.chainSimulator.on('opportunity', (opportunity) => {
      if (this.isStopping || !this.isRunning) return;
      callbacks.onOpportunity(opportunity);
    });

    // Start the simulator
    this.chainSimulator.start();

    this.logger.info('EVM simulation mode initialized', {
      chainId: this.chainId,
      simulatedPairs: simulatedPairs.length
    });
  }

  /**
   * Initialize non-EVM chain simulation (e.g., Solana).
   * Generates periodic synthetic price updates without EVM-specific events.
   */
  async initializeNonEvmSimulation(
    config: NonEvmSimulationConfig,
    callbacks: SimulationCallbacks
  ): Promise<void> {
    // BUGFIX: Prevent duplicate intervals if called without stop()
    // This would cause memory leaks and duplicate event processing
    if (this.chainSimulator || this.nonEvmSimulationInterval) {
      this.stop();
    }

    this.logger.info('Initializing non-EVM simulation mode', {
      chainId: this.chainId
    });

    const { dexes, tokens, updateIntervalMs, volatility } = config;

    // Use defaults if not configured
    const effectiveTokens = tokens.length > 0 ? tokens : ['SOL', 'USDC', 'RAY', 'JUP'];
    const effectiveDexes = dexes.length > 0 ? dexes : ['raydium', 'orca'];

    let slotNumber = 250000000; // Starting slot for Solana-like chains
    this.isRunning = true;

    this.nonEvmSimulationInterval = setInterval(() => {
      if (this.isStopping || !this.isRunning) {
        return;
      }

      slotNumber++;
      callbacks.onBlockUpdate(slotNumber);

      // Generate synthetic price updates for token pairs across DEXes
      for (let i = 0; i < effectiveTokens.length; i++) {
        for (let j = i + 1; j < effectiveTokens.length; j++) {
          const token0 = effectiveTokens[i];
          const token1 = effectiveTokens[j];

          // Generate price with some volatility
          const basePrice = this.getBaseTokenPrice(token0) / this.getBaseTokenPrice(token1);
          const priceVariation = 1 + (Math.random() * 2 - 1) * volatility;
          const price = basePrice * priceVariation;

          // Emit price update for each DEX
          for (const dex of effectiveDexes) {
            const dexPriceVariation = 1 + (Math.random() * 2 - 1) * 0.005; // Small DEX-to-DEX variation
            const dexPrice = price * dexPriceVariation;

            const priceUpdate: PriceUpdate = {
              chain: this.chainId,
              dex,
              pairKey: `${dex}_${token0}_${token1}`,
              token0,
              token1,
              price: dexPrice,
              reserve0: '0', // Non-EVM chains may not have reserve-based AMMs
              reserve1: '0',
              blockNumber: slotNumber,
              timestamp: Date.now(),
              latency: 0
            };

            callbacks.onPriceUpdate(priceUpdate);
            callbacks.onEventProcessed();
          }

          // Occasionally detect arbitrage opportunity
          if (effectiveDexes.length >= 2 && Math.random() < 0.03) { // 3% chance
            const dex1 = effectiveDexes[0];
            const dex2 = effectiveDexes[1];
            const priceDiff = 0.003 + Math.random() * 0.007; // 0.3% to 1% profit

            // CRITICAL FIX: Calculate tokenIn/tokenOut/amountIn required by execution engine
            // For simulation, use 1 token as trade size (1e9 lamports for Solana)
            const simulatedAmountIn = '1000000000'; // 1 SOL in lamports
            const simulatedAmountInNum = 1.0; // 1 token for calculation
            // CRITICAL FIX: expectedProfit must be ABSOLUTE value (not percentage) per engine.ts
            const expectedProfitAbsolute = simulatedAmountInNum * priceDiff;

            const opportunity: ArbitrageOpportunity = {
              id: `${this.chainId}-sim-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              type: this.chainId === 'solana' ? 'solana' : 'simple',
              chain: this.chainId,
              buyDex: dex1,
              sellDex: dex2,
              buyPair: `${dex1}_${token0}_${token1}`,
              sellPair: `${dex2}_${token0}_${token1}`,
              token0,
              token1,
              // CRITICAL FIX: Add tokenIn/tokenOut/amountIn required by execution engine
              tokenIn: token0,
              tokenOut: token1,
              amountIn: simulatedAmountIn,
              buyPrice: price * (1 - priceDiff / 2),
              sellPrice: price * (1 + priceDiff / 2),
              profitPercentage: priceDiff * 100,
              // CRITICAL FIX: expectedProfit as ABSOLUTE value (required by engine.ts)
              expectedProfit: expectedProfitAbsolute,
              confidence: 0.85,
              timestamp: Date.now(),
              expiresAt: Date.now() + 1000, // Fast expiry for Solana
              status: 'pending'
            };

            callbacks.onOpportunity(opportunity);
          }
        }
      }
    }, updateIntervalMs);

    this.logger.info('Non-EVM simulation initialized', {
      chainId: this.chainId,
      dexes: effectiveDexes,
      tokens: effectiveTokens,
      updateIntervalMs
    });
  }

  /**
   * Stop all simulation activities.
   * FIX Inconsistency 6.1: Made async for consistency with other modules.
   */
  async stop(): Promise<void> {
    this.isStopping = true;
    this.isRunning = false;

    // Stop non-EVM simulation interval
    this.nonEvmSimulationInterval = clearIntervalSafe(this.nonEvmSimulationInterval);

    // Stop chain simulator
    if (this.chainSimulator) {
      this.chainSimulator.removeAllListeners();
      this.chainSimulator.stop();
      this.chainSimulator = null;
      stopChainSimulator(this.chainId);
    }

    this.isStopping = false;
    this.logger.info('Simulation stopped', { chainId: this.chainId });
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  /**
   * Handle simulated Sync events from the ChainSimulator.
   * Decodes reserves and triggers price update callbacks.
   *
   * BUG-1 FIX: Now properly emits sync events via onSyncEvent callback
   * so the parent can process them through its pair state management.
   */
  private handleSimulatedSyncEvent(
    event: { address: string; data: string; blockNumber: string },
    callbacks: SimulationCallbacks
  ): void {
    try {
      // Decode reserves from the simulated data
      // Data format: 0x + 64 hex chars for reserve0 + 64 hex chars for reserve1
      const data = event.data.slice(2); // Remove '0x'
      const reserve0Hex = data.slice(0, 64);
      const reserve1Hex = data.slice(64, 128);

      const reserve0 = BigInt('0x' + reserve0Hex).toString();
      const reserve1 = BigInt('0x' + reserve1Hex).toString();
      const blockNumber = parseInt(event.blockNumber, 16);

      callbacks.onBlockUpdate(blockNumber);
      callbacks.onEventProcessed();

      // BUG-1 FIX: Emit sync event via callback if provided
      // This allows parent to process through its own pair state management
      if (callbacks.onSyncEvent) {
        callbacks.onSyncEvent({
          address: event.address,
          reserve0,
          reserve1,
          blockNumber
        });
      }

    } catch (error) {
      this.logger.error('Error processing simulated sync event', {
        error: (error as Error).message,
        address: event.address
      });
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Get base token price for simulation (in USD).
   * Note: Keep in sync with BASE_PRICES in shared/core/src/simulation-mode.ts
   */
  private getBaseTokenPrice(symbol: string): number {
    const basePrices: Record<string, number> = {
      // Solana-specific tokens
      SOL: 175, USDC: 1, USDT: 1, RAY: 4.5, JUP: 0.85, ORCA: 3.2,
      BONK: 0.000025, WIF: 2.5, mSOL: 185, JitoSOL: 180,
      // Common cross-chain tokens (for non-EVM chains that may support bridged assets)
      WETH: 3200, WBTC: 65000, LINK: 15, ARB: 1.15, OP: 2.5
    };
    return basePrices[symbol.toUpperCase()] ?? 1;
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  isActive(): boolean {
    return this.isRunning;
  }
}
