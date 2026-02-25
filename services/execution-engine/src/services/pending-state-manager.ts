/**
 * Pending State Simulation Manager
 *
 * Extracted from engine.ts to reduce file complexity.
 * Manages Phase 2 pending state simulation components:
 * - AnvilForkManager: Local Anvil fork for state simulation
 * - PendingStateSimulator: Simulates pending swaps on the fork
 * - HotForkSynchronizer: Keeps the fork in sync with mainnet
 *
 * NOT on hot path — initialization and shutdown only.
 * Simulator reference passed to strategies via buildStrategyContext().
 *
 * @see engine.ts (consumer)
 * @see implementation_plan_v3.md Phase 2
 */

import { getErrorMessage } from '@arbitrage/core/resilience';
import { ethers } from 'ethers';
import { AnvilForkManager, createAnvilForkManager } from './simulation/anvil-manager';
import { PendingStateSimulator, createPendingStateSimulator } from './simulation/pending-state-simulator';
import { HotForkSynchronizer, createHotForkSynchronizer } from './simulation/hot-fork-synchronizer';
import type { PendingStateEngineConfig, Logger } from '../types';

/**
 * Minimal interface for provider access during pending state init.
 */
export interface PendingStateProviderSource {
  getProvider(chain: string): ethers.JsonRpcProvider | undefined;
}

/**
 * Dependencies for PendingStateManager construction.
 */
export interface PendingStateManagerDeps {
  config: PendingStateEngineConfig;
  providerSource: PendingStateProviderSource;
  logger: Logger;
}

/**
 * Manages lifecycle of Phase 2 pending state simulation components.
 *
 * Performance Note:
 * - NOT on hot path — all operations are init/shutdown only
 * - Simulator is passed by reference to strategy context (no copies)
 * - Optional feature — safe to disable via config
 */
export class PendingStateManager {
  private anvilForkManager: AnvilForkManager | null = null;
  private pendingStateSimulator: PendingStateSimulator | null = null;
  private hotForkSynchronizer: HotForkSynchronizer | null = null;

  private readonly config: PendingStateEngineConfig;
  private readonly providerSource: PendingStateProviderSource;
  private readonly logger: Logger;

  constructor(deps: PendingStateManagerDeps) {
    this.config = deps.config;
    this.providerSource = deps.providerSource;
    this.logger = deps.logger;
  }

  /**
   * Initialize pending state simulation components.
   *
   * Creates and starts:
   * - AnvilForkManager: Local Anvil fork for state simulation
   * - PendingStateSimulator: Simulates pending swaps on the fork
   * - HotForkSynchronizer: Keeps the fork in sync with mainnet (if enabled)
   *
   * Cleans up partial initialization on failure.
   */
  async initialize(): Promise<void> {
    if (!this.config.rpcUrl) {
      this.logger.warn('Phase 2 pending state simulation skipped - no RPC URL configured', {
        hint: 'Set pendingStateConfig.rpcUrl to enable pending state simulation',
      });
      return;
    }

    try {
      this.logger.info('Initializing Phase 2 pending state simulation', {
        chain: this.config.chain,
        anvilPort: this.config.anvilPort,
        enableHotSync: this.config.enableHotSync,
        adaptiveSync: this.config.adaptiveSync,
      });

      // Create Anvil fork manager
      this.anvilForkManager = createAnvilForkManager({
        rpcUrl: this.config.rpcUrl,
        chain: this.config.chain ?? 'ethereum',
        port: this.config.anvilPort,
        autoStart: false, // We'll start manually to handle errors
      });

      // Start the fork if autoStartAnvil is enabled
      if (this.config.autoStartAnvil) {
        await this.anvilForkManager.startFork();
        this.logger.info('Anvil fork started', {
          port: this.config.anvilPort,
          state: this.anvilForkManager.getState(),
        });
      }

      // Create pending state simulator
      this.pendingStateSimulator = createPendingStateSimulator({
        anvilManager: this.anvilForkManager,
        timeoutMs: this.config.simulationTimeoutMs,
      });

      // Create hot fork synchronizer if enabled
      if (this.config.enableHotSync && this.anvilForkManager.getState() === 'running') {
        const sourceProvider = this.providerSource.getProvider(this.config.chain ?? 'ethereum');
        if (sourceProvider) {
          this.hotForkSynchronizer = createHotForkSynchronizer({
            anvilManager: this.anvilForkManager,
            sourceProvider,
            syncIntervalMs: this.config.syncIntervalMs,
            adaptiveSync: this.config.adaptiveSync,
            minSyncIntervalMs: this.config.minSyncIntervalMs,
            maxSyncIntervalMs: this.config.maxSyncIntervalMs,
            maxConsecutiveFailures: this.config.maxConsecutiveFailures,
            logger: {
              // Use structured component field instead of template literals
              error: (msg: string, meta?: Record<string, unknown>) => this.logger.error(msg, { component: 'HotForkSync', ...meta }),
              warn: (msg: string, meta?: Record<string, unknown>) => this.logger.warn(msg, { component: 'HotForkSync', ...meta }),
              info: (msg: string, meta?: Record<string, unknown>) => this.logger.info(msg, { component: 'HotForkSync', ...meta }),
              debug: (msg: string, meta?: Record<string, unknown>) => this.logger.debug(msg, { component: 'HotForkSync', ...meta }),
            },
          });

          await this.hotForkSynchronizer.start();
          this.logger.info('Hot fork synchronizer started', {
            syncIntervalMs: this.config.syncIntervalMs,
            adaptiveSync: this.config.adaptiveSync,
            minSyncIntervalMs: this.config.minSyncIntervalMs,
            maxSyncIntervalMs: this.config.maxSyncIntervalMs,
          });
        }
      }

      this.logger.info('Phase 2 pending state simulation initialized successfully');

    } catch (error) {
      this.logger.error('Failed to initialize Phase 2 pending state simulation', {
        error: getErrorMessage(error),
      });
      // Clean up partial initialization
      await this.shutdown();
    }
  }

  /**
   * Shutdown all pending state simulation components.
   * Safe to call multiple times (idempotent).
   */
  async shutdown(): Promise<void> {
    // Stop hot fork synchronizer
    if (this.hotForkSynchronizer) {
      try {
        await this.hotForkSynchronizer.stop();
      } catch (error) {
        this.logger.warn('Error stopping hot fork synchronizer', {
          error: getErrorMessage(error),
        });
      }
      this.hotForkSynchronizer = null;
    }

    // Shutdown Anvil fork
    if (this.anvilForkManager) {
      try {
        await this.anvilForkManager.shutdown();
      } catch (error) {
        this.logger.warn('Error shutting down Anvil fork', {
          error: getErrorMessage(error),
        });
      }
      this.anvilForkManager = null;
    }

    // Clear simulator reference
    this.pendingStateSimulator = null;
  }

  /** Get the pending state simulator for strategy context. */
  getSimulator(): PendingStateSimulator | null {
    return this.pendingStateSimulator;
  }

  /** Get the Anvil fork manager (for diagnostics). */
  getAnvilManager(): AnvilForkManager | null {
    return this.anvilForkManager;
  }

  /** Get the hot fork synchronizer (for diagnostics). */
  getSynchronizer(): HotForkSynchronizer | null {
    return this.hotForkSynchronizer;
  }
}

/**
 * Factory function for PendingStateManager.
 * Follows codebase convention of factory functions for DI.
 */
export function createPendingStateManager(
  deps: PendingStateManagerDeps,
): PendingStateManager {
  return new PendingStateManager(deps);
}
