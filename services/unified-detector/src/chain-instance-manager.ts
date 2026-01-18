/**
 * ChainInstanceManager - Chain Instance Lifecycle Management
 *
 * ARCH-REFACTOR: Extracted from UnifiedChainDetector to provide a single
 * responsibility module for managing chain detector instance lifecycle.
 *
 * Responsibilities:
 * - Starting/stopping chain detector instances
 * - Event forwarding from chain instances
 * - Error handling and degradation triggering
 * - Chain capability registration
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - EventEmitter for loose coupling
 * - Timeout protection for stop operations
 * - Graceful partial failure handling
 */

import { EventEmitter } from 'events';
import {
  PerformanceLogger,
  RedisStreamsClient,
  GracefulDegradationManager,
} from '@arbitrage/core';

import { CHAINS } from '@arbitrage/config';

import { ChainDetectorInstance } from './chain-instance';
import { ChainStats } from './unified-detector';
import { Logger } from './types';

// =============================================================================
// Types
// =============================================================================

/** Factory type for creating chain detector instances */
export type ChainInstanceFactory = (config: {
  chainId: string;
  partitionId: string;
  streamsClient: RedisStreamsClient;
  perfLogger: PerformanceLogger;
}) => ChainDetectorInstance;

/** Configuration for ChainInstanceManager */
export interface ChainInstanceManagerConfig {
  /** Chain IDs to manage */
  chains: string[];

  /** Partition ID for this detector */
  partitionId: string;

  /** Redis Streams client for publishing */
  streamsClient: RedisStreamsClient;

  /** Performance logger */
  perfLogger: PerformanceLogger;

  /** Factory for creating chain instances */
  chainInstanceFactory: ChainInstanceFactory;

  /** Logger for output */
  logger: Logger;

  /** Optional degradation manager for triggering failures */
  degradationManager?: GracefulDegradationManager;

  /** Timeout for stopping individual chains (ms) */
  stopTimeoutMs?: number;

  /** Optional chain validator (for testing) */
  chainValidator?: (chainId: string) => boolean;
}

/** Result of starting all chain instances */
export interface StartResult {
  /** Whether at least one chain started successfully */
  success: boolean;

  /** Number of chains that started successfully */
  chainsStarted: number;

  /** Number of chains that failed to start */
  chainsFailed: number;

  /** List of successfully started chain IDs */
  startedChains: string[];

  /** List of failed chain IDs */
  failedChains: string[];
}

/** Public interface for ChainInstanceManager */
export interface ChainInstanceManager extends EventEmitter {
  /** Start all configured chain instances */
  startAll(): Promise<StartResult>;

  /** Stop all running chain instances (FIX I2: renamed from stopAll for consistency) */
  stop(): Promise<void>;

  /** @deprecated Use stop() instead */
  stopAll(): Promise<void>;

  /** Get list of currently healthy (connected) chain IDs */
  getHealthyChains(): string[];

  /** Get stats for all chain instances */
  getStats(): Map<string, ChainStats>;

  /** Get all managed chain IDs */
  getChains(): string[];

  /** Get a specific chain instance */
  getChainInstance(chainId: string): ChainDetectorInstance | undefined;
}

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for stopping individual chains */
const DEFAULT_STOP_TIMEOUT_MS = 30000;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a ChainInstanceManager instance.
 *
 * @param config - Manager configuration
 * @returns ChainInstanceManager instance
 */
export function createChainInstanceManager(
  config: ChainInstanceManagerConfig
): ChainInstanceManager {
  const {
    chains,
    partitionId,
    streamsClient,
    perfLogger,
    chainInstanceFactory,
    logger,
    degradationManager,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    chainValidator = (chainId) => !!CHAINS[chainId as keyof typeof CHAINS],
  } = config;

  const emitter = new EventEmitter() as ChainInstanceManager;
  const chainInstances = new Map<string, ChainDetectorInstance>();

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Handle error from a chain instance.
   * Logs error, triggers degradation, and emits event.
   */
  function handleChainError(chainId: string, error: Error): void {
    logger.error(`Chain error: ${chainId}`, { error: error.message });

    // Trigger degradation if manager is configured
    if (degradationManager) {
      degradationManager.triggerDegradation(
        `unified-detector-${partitionId}`,
        `chain_${chainId}_failure`,
        error
      );
    }

    emitter.emit('chainError', { chainId, error });
  }

  /**
   * Register chain capabilities with the degradation manager.
   * Each chain is a non-required capability - service can continue with partial coverage.
   */
  function registerChainCapabilities(): void {
    if (!degradationManager || chains.length === 0) {
      return;
    }

    const serviceName = `unified-detector-${partitionId}`;
    const capabilities = chains
      .filter(chainValidator)
      .map((chainId) => ({
        name: `chain_${chainId}_failure`,
        required: false,
        degradationLevel: 'partial',
      }));

    degradationManager.registerCapabilities(serviceName, capabilities);
    logger.info('Registered chain capabilities for graceful degradation', {
      serviceName,
      chainCount: capabilities.length,
      chains: chains.filter(chainValidator),
    });
  }

  /**
   * Set up event handlers for a chain instance.
   * Forwards events to the manager's emitter.
   */
  function setupChainEventHandlers(chainId: string, instance: ChainDetectorInstance): void {
    instance.on('priceUpdate', (update) => {
      emitter.emit('priceUpdate', update);
    });

    instance.on('opportunity', (opp) => {
      emitter.emit('opportunity', opp);
    });

    instance.on('error', (error) => {
      handleChainError(chainId, error);
    });

    instance.on('statusChange', (status) => {
      logger.info(`Chain ${chainId} status changed to ${status}`);
      emitter.emit('statusChange', { chainId, status });
    });
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Start all configured chain instances.
   * Chains are started in parallel; failures don't block other chains.
   */
  async function startAll(): Promise<StartResult> {
    const startedChains: string[] = [];
    const failedChains: string[] = [];
    const startPromises: Promise<void>[] = [];

    // Register capabilities before starting chains
    registerChainCapabilities();

    for (const chainId of chains) {
      // Validate chain exists in configuration
      if (!chainValidator(chainId)) {
        logger.warn(`Chain ${chainId} not found in configuration, skipping`, { chainId });
        continue;
      }

      const instance = chainInstanceFactory({
        chainId,
        partitionId,
        streamsClient,
        perfLogger,
      });

      // Set up event handlers
      setupChainEventHandlers(chainId, instance);

      chainInstances.set(chainId, instance);

      // Start instance in parallel
      const startPromise = instance
        .start()
        .then(() => {
          if (instance.isConnected()) {
            startedChains.push(chainId);
          } else {
            // FIX B1: Remove instance that started but failed to connect
            chainInstances.delete(chainId);
            failedChains.push(chainId);
          }
        })
        .catch((error) => {
          // FIX B1: Remove failed instance from map to prevent stale entries
          chainInstances.delete(chainId);
          logger.error(`Failed to start chain instance: ${chainId}`, {
            error: (error as Error).message,
          });
          failedChains.push(chainId);
          handleChainError(chainId, error);
        });

      startPromises.push(startPromise);
    }

    // Wait for all chains to start (or fail gracefully)
    await Promise.allSettled(startPromises);

    logger.info('Chain instances started', {
      requested: chains.filter(chainValidator).length,
      successful: startedChains.length,
      failed: failedChains.length,
      chains: startedChains,
    });

    return {
      success: startedChains.length > 0,
      chainsStarted: startedChains.length,
      chainsFailed: failedChains.length,
      startedChains,
      failedChains,
    };
  }

  /**
   * Stop all running chain instances.
   * Uses timeout protection to prevent indefinite hangs.
   * FIX I2: Renamed from stopAll() for consistency with other modules.
   */
  async function stop(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    // Take snapshot to avoid iterator issues during modification
    const instancesSnapshot = Array.from(chainInstances.entries());

    for (const [chainId, instance] of instancesSnapshot) {
      // Remove listeners before stopping to prevent memory leak
      instance.removeAllListeners();

      // Wrap stop() with timeout to prevent indefinite hangs
      const stopWithTimeout = Promise.race([
        instance.stop(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Chain ${chainId} stop timeout after ${stopTimeoutMs}ms`)),
            stopTimeoutMs
          )
        ),
      ]).catch((error) => {
        logger.error(`Error stopping chain instance: ${chainId}`, {
          error: (error as Error).message,
        });
      });

      stopPromises.push(stopWithTimeout);
    }

    await Promise.allSettled(stopPromises);
    chainInstances.clear();

    logger.info('All chain instances stopped', {
      chainsStopped: instancesSnapshot.length,
    });
  }

  /**
   * Get list of currently healthy (connected) chain IDs.
   */
  function getHealthyChains(): string[] {
    // Take snapshot to avoid iterator issues
    const instancesSnapshot = Array.from(chainInstances.entries());
    const healthyChains: string[] = [];

    for (const [chainId, instance] of instancesSnapshot) {
      const stats = instance.getStats();
      if (stats.status === 'connected') {
        healthyChains.push(chainId);
      }
    }

    return healthyChains;
  }

  /**
   * Get stats for all chain instances.
   */
  function getStats(): Map<string, ChainStats> {
    // Take snapshot to avoid iterator issues
    const instancesSnapshot = Array.from(chainInstances.entries());
    const stats = new Map<string, ChainStats>();

    for (const [chainId, instance] of instancesSnapshot) {
      stats.set(chainId, instance.getStats());
    }

    return stats;
  }

  /**
   * Get all managed chain IDs.
   */
  function getChains(): string[] {
    return Array.from(chainInstances.keys());
  }

  /**
   * Get a specific chain instance.
   */
  function getChainInstance(chainId: string): ChainDetectorInstance | undefined {
    return chainInstances.get(chainId);
  }

  // ===========================================================================
  // Attach Methods to Emitter
  // ===========================================================================

  emitter.startAll = startAll;
  emitter.stop = stop;
  emitter.stopAll = stop; // @deprecated alias for backward compatibility
  emitter.getHealthyChains = getHealthyChains;
  emitter.getStats = getStats;
  emitter.getChains = getChains;
  emitter.getChainInstance = getChainInstance;

  return emitter;
}
