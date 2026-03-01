/**
 * Standby Manager
 *
 * Extracted from engine.ts (S6) to reduce God Class size.
 * Manages standby/activation lifecycle:
 * - Tracks activation state (isActivated, activationPromise)
 * - Handles standby-to-active transition (ADR-007)
 * - Initializes providers during activation
 *
 * Performance Note:
 * - NOT on hot path - activate() is a cold-path, one-time operation
 * - Engine holds direct reference (no service locator)
 * - Constructor DI pattern (one-time cost)
 *
 * @see engine.ts (consumer)
 * @see ADR-007: Failover Strategy
 */

import type { BridgeRouterFactory } from '@arbitrage/core/bridge-router';
import type { MevProviderFactory } from '@arbitrage/core/mev-protection';
import { RedisStreamsClient } from '@arbitrage/core/redis';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { ServiceStateManager } from '@arbitrage/core/service-lifecycle';
import { type NonceManager } from '@arbitrage/core';
import {
  initializeMevProviders,
  initializeBridgeRouter,
} from '../initialization';
import type { ProviderServiceImpl } from './provider.service';
import type { QueueServiceImpl } from './queue.service';
import type { ExecutionStrategyFactory } from '../strategies/strategy-factory';
import type { Logger, StandbyConfig } from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Dependencies for StandbyManager construction.
 *
 * Uses getter functions for nullable services that may change
 * during the engine lifecycle (e.g., streamsClient may disconnect).
 */
export interface StandbyManagerDeps {
  /** Logger instance (direct reference) */
  logger: Logger;
  /** State manager for lifecycle checks */
  stateManager: ServiceStateManager;
  /** Standby configuration */
  standbyConfig: StandbyConfig;
  /** Whether simulation mode is initially enabled */
  initialSimulationMode: boolean;

  // Getter functions for services that may be null or change
  getProviderService: () => ProviderServiceImpl | null;
  getQueueService: () => QueueServiceImpl | null;
  getStrategyFactory: () => ExecutionStrategyFactory | null;
  getStreamsClient: () => RedisStreamsClient | null;
  getNonceManager: () => NonceManager | null;

  // Callbacks to update engine state after activation
  onMevProviderFactoryUpdated: (factory: MevProviderFactory | null) => void;
  onBridgeRouterFactoryUpdated: (factory: BridgeRouterFactory | null) => void;
  onSimulationModeChanged: (isSimulationMode: boolean) => void;
}

// =============================================================================
// StandbyManager
// =============================================================================

/**
 * Manages standby-to-active lifecycle transitions.
 *
 * When the primary executor fails, the standby instance activates:
 * 1. Disables simulation mode (if configured)
 * 2. Resumes the paused queue
 * 3. Initializes real blockchain providers if not already done
 *
 * Uses Promise-based mutex to prevent race conditions in concurrent activation.
 */
export class StandbyManager {
  private isActivated = false;
  private activationPromise: Promise<boolean> | null = null;
  private providerInitPromise: Promise<void> | null = null;

  private readonly logger: Logger;
  private readonly stateManager: ServiceStateManager;
  private readonly standbyConfig: StandbyConfig;
  private isSimulationMode: boolean;

  // Getter functions for nullable services
  private readonly getProviderService: () => ProviderServiceImpl | null;
  private readonly getQueueService: () => QueueServiceImpl | null;
  private readonly getStrategyFactory: () => ExecutionStrategyFactory | null;
  private readonly getStreamsClient: () => RedisStreamsClient | null;
  private readonly getNonceManager: () => NonceManager | null;

  // Callbacks to engine
  private readonly onMevProviderFactoryUpdated: (factory: MevProviderFactory | null) => void;
  private readonly onBridgeRouterFactoryUpdated: (factory: BridgeRouterFactory | null) => void;
  private readonly onSimulationModeChanged: (isSimulationMode: boolean) => void;

  constructor(deps: StandbyManagerDeps) {
    this.logger = deps.logger;
    this.stateManager = deps.stateManager;
    this.standbyConfig = deps.standbyConfig;
    this.isSimulationMode = deps.initialSimulationMode;
    this.getProviderService = deps.getProviderService;
    this.getQueueService = deps.getQueueService;
    this.getStrategyFactory = deps.getStrategyFactory;
    this.getStreamsClient = deps.getStreamsClient;
    this.getNonceManager = deps.getNonceManager;
    this.onMevProviderFactoryUpdated = deps.onMevProviderFactoryUpdated;
    this.onBridgeRouterFactoryUpdated = deps.onBridgeRouterFactoryUpdated;
    this.onSimulationModeChanged = deps.onSimulationModeChanged;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Activate a standby executor to become the active executor.
   * This is called when the primary executor fails and this standby takes over.
   *
   * Activation:
   * 1. Disables simulation mode (if configured)
   * 2. Resumes the paused queue
   * 3. Initializes real blockchain providers if not already done
   *
   * Uses Promise-based mutex to prevent race conditions in concurrent activation.
   *
   * @returns Promise<boolean> - true if activation succeeded
   */
  async activate(): Promise<boolean> {
    // Check if already activated
    if (this.isActivated) {
      this.logger.warn('Executor already activated, skipping');
      return true;
    }

    // Atomic mutex: if activation is in progress, wait for it to complete
    if (this.activationPromise) {
      this.logger.warn('Activation already in progress, waiting for completion');
      return this.activationPromise;
    }

    if (!this.stateManager.isRunning()) {
      this.logger.error('Cannot activate - executor not running');
      return false;
    }

    // Create the activation promise atomically - this is the mutex
    this.activationPromise = this.performActivation();

    try {
      return await this.activationPromise;
    } catch (error) {
      this.logger.error('Unexpected error during activation', {
        error: getErrorMessage(error)
      });
      return false;
    } finally {
      this.activationPromise = null;
    }
  }

  getIsStandby(): boolean {
    return this.standbyConfig.isStandby;
  }

  getIsActivated(): boolean {
    return this.isActivated;
  }

  getStandbyConfig(): Readonly<StandbyConfig> {
    return this.standbyConfig;
  }

  // ===========================================================================
  // Internal Activation Logic
  // ===========================================================================

  /**
   * Internal activation logic, separated for mutex pattern.
   */
  private async performActivation(): Promise<boolean> {
    const queueService = this.getQueueService();

    this.logger.warn('ACTIVATING STANDBY EXECUTOR', {
      previousSimulationMode: this.isSimulationMode,
      queuePaused: queueService?.isPaused() ?? false,
      regionId: this.standbyConfig.regionId
    });

    try {
      // Step 1: Disable simulation mode if configured
      if (this.standbyConfig.activationDisablesSimulation && this.isSimulationMode) {
        this.isSimulationMode = false;
        // Notify engine of simulation mode change
        this.onSimulationModeChanged(false);
        // Sync strategy factory with new simulation mode state
        this.getStrategyFactory()?.setSimulationMode(false);
        this.logger.warn('SIMULATION MODE DISABLED - Real transactions will now execute');

        // Initialize real blockchain providers if not already done
        const providerService = this.getProviderService();
        if (providerService && !providerService.getHealthyCount()) {
          // If initialization is already in progress, wait for it
          if (this.providerInitPromise) {
            this.logger.info('Provider initialization already in progress, waiting...');
            await this.providerInitPromise;
          } else {
            // Start initialization and store promise for other callers to await
            this.providerInitPromise = this.initializeProviders();
            try {
              await this.providerInitPromise;
            } finally {
              this.providerInitPromise = null;
            }
          }
        }
      }

      // Step 2: Resume the queue
      const currentQueueService = this.getQueueService();
      if (currentQueueService?.isManuallyPaused()) {
        currentQueueService.resume();
        this.logger.info('Queue resumed - now processing opportunities');
      }

      // Mark as activated
      this.isActivated = true;

      const providerService = this.getProviderService();
      this.logger.warn('STANDBY EXECUTOR ACTIVATED SUCCESSFULLY', {
        simulationMode: this.isSimulationMode,
        queuePaused: this.getQueueService()?.isPaused() ?? false,
        healthyProviders: providerService?.getHealthyCount() ?? 0
      });

      // Publish activation event to stream
      const streamsClient = this.getStreamsClient();
      if (streamsClient) {
        await streamsClient.xaddWithLimit(RedisStreamsClient.STREAMS.HEALTH, {
          name: 'execution-engine',
          service: 'execution-engine',
          status: 'healthy',
          event: 'standby_activated',
          regionId: this.standbyConfig.regionId,
          simulationMode: this.isSimulationMode,
          timestamp: Date.now()
        });
      }

      return true;

    } catch (error) {
      this.logger.error('Failed to activate standby executor', {
        error: getErrorMessage(error)
      });
      return false;
    }
  }

  /**
   * Extracted provider initialization logic for promise-based mutex pattern.
   * Called by performActivation when providers need to be initialized.
   *
   * Uses initialization module instead of duplicate private methods.
   */
  private async initializeProviders(): Promise<void> {
    const providerService = this.getProviderService();
    if (!providerService) {
      throw new Error('Provider service not initialized');
    }

    this.logger.info('Initializing blockchain providers for real execution');
    await providerService.initialize();
    providerService.initializeWallets();

    // Initialize MEV protection using module
    const mevResult = await initializeMevProviders(providerService, this.logger);
    this.onMevProviderFactoryUpdated(mevResult.factory);
    if (!mevResult.success && mevResult.error) {
      this.logger.warn('MEV initialization had issues', { error: mevResult.error });
    }

    // Initialize bridge router using module
    const bridgeResult = initializeBridgeRouter(providerService, this.logger);
    this.onBridgeRouterFactoryUpdated(bridgeResult.factory);
    if (!bridgeResult.success && bridgeResult.error) {
      this.logger.warn('Bridge router initialization had issues', { error: bridgeResult.error });
    }

    // Start nonce manager
    const nonceManager = this.getNonceManager();
    if (nonceManager) {
      nonceManager.start();
    }

    // Validate and start health monitoring
    await providerService.validateConnectivity();
    providerService.startHealthChecks();

    this.logger.info('Blockchain providers initialized successfully');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a StandbyManager instance.
 *
 * @param deps - Dependencies for the manager
 * @returns StandbyManager instance
 */
export function createStandbyManager(deps: StandbyManagerDeps): StandbyManager {
  return new StandbyManager(deps);
}
