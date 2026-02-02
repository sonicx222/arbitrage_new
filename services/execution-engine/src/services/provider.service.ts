/**
 * Provider Service
 *
 * Manages RPC provider lifecycle including:
 * - Provider initialization for all configured chains
 * - Connectivity validation
 * - Health monitoring and automatic reconnection
 * - Wallet management
 *
 * Environment Variables (Fix 3.2):
 * - {CHAIN_NAME}_PRIVATE_KEY: Private key for wallet on each chain
 *   Chain name is uppercase (e.g., ETHEREUM_PRIVATE_KEY, ARBITRUM_PRIVATE_KEY)
 *   Required for transaction signing on the respective chain.
 *
 * @see engine.ts (parent service)
 */

import { ethers } from 'ethers';
import { CHAINS } from '@arbitrage/config';
import { getErrorMessage, NonceManager, BatchProvider, createBatchProvider } from '@arbitrage/core';
import type { ServiceStateManager, BatchProviderConfig } from '@arbitrage/core';
import type { Logger, ProviderHealth, ProviderService as IProviderService, ExecutionStats } from '../types';
import {
  PROVIDER_CONNECTIVITY_TIMEOUT_MS,
  PROVIDER_HEALTH_CHECK_TIMEOUT_MS,
  PROVIDER_RECONNECTION_TIMEOUT_MS,
} from '../types';

export interface ProviderServiceConfig {
  logger: Logger;
  stateManager: ServiceStateManager;
  nonceManager: NonceManager | null;
  stats: ExecutionStats;
  /**
   * Phase 3: Enable RPC request batching for optimized performance.
   * When enabled, BatchProvider instances are created for each chain.
   * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
   */
  enableBatching?: boolean;
  /**
   * Phase 3: Configuration for batch providers.
   */
  batchConfig?: BatchProviderConfig;
}

export class ProviderServiceImpl implements IProviderService {
  private readonly logger: Logger;
  private readonly stateManager: ServiceStateManager;
  private nonceManager: NonceManager | null;
  private readonly stats: ExecutionStats;

  private providers: Map<string, ethers.JsonRpcProvider> = new Map();
  private wallets: Map<string, ethers.Wallet> = new Map();
  private providerHealth: Map<string, ProviderHealth> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Phase 3: BatchProvider instances for RPC request batching.
   * One BatchProvider per chain, wrapping the underlying JsonRpcProvider.
   * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
   */
  private batchProviders: Map<string, BatchProvider> = new Map();
  private readonly enableBatching: boolean;
  private readonly batchConfig: BatchProviderConfig;

  // Callback for provider reconnection (allows engine to clear stale state)
  private onProviderReconnectCallback: ((chainName: string) => void) | null = null;

  /**
   * Fix 5.2: Guard to prevent concurrent health check iterations.
   * If health check takes longer than interval, skip the overlapping check.
   */
  private isCheckingHealth = false;

  /**
   * Fix 10.2: Cached healthy provider count for O(1) access.
   * Updated whenever provider health changes.
   */
  private cachedHealthyCount = 0;

  constructor(config: ProviderServiceConfig) {
    this.logger = config.logger;
    this.stateManager = config.stateManager;
    this.nonceManager = config.nonceManager;
    this.stats = config.stats;
    // Phase 3: Initialize batching configuration
    this.enableBatching = config.enableBatching ?? false;
    this.batchConfig = config.batchConfig ?? {
      maxBatchSize: 10,
      batchTimeoutMs: 10,
      enabled: true,
      maxQueueSize: 100,
    };
  }

  /**
   * Set callback for provider reconnection events.
   * Used by engine to clear stale gas baseline data.
   */
  onProviderReconnect(callback: (chainName: string) => void): void {
    this.onProviderReconnectCallback = callback;
  }

  /**
   * Initialize providers for all configured chains.
   */
  async initialize(): Promise<void> {
    for (const [chainName, chainConfig] of Object.entries(CHAINS)) {
      try {
        const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
        this.providers.set(chainName, provider);

        // Phase 3: Create BatchProvider if batching is enabled
        if (this.enableBatching) {
          const batchProvider = createBatchProvider(provider, this.batchConfig);
          this.batchProviders.set(chainName, batchProvider);
        }

        // Initialize health tracking for this provider
        // Note: Use direct set here since this is initial state (no previous health to compare)
        this.providerHealth.set(chainName, {
          healthy: false, // Will be verified in validateConnectivity
          lastCheck: 0,
          consecutiveFailures: 0
        });
      } catch (error) {
        this.logger.warn(`Failed to initialize provider for ${chainName}`, { error });
        // Note: Use direct set here since this is initial state
        this.providerHealth.set(chainName, {
          healthy: false,
          lastCheck: Date.now(),
          consecutiveFailures: 1,
          lastError: getErrorMessage(error)
        });
      }
    }
    this.logger.info('Initialized blockchain providers', {
      count: this.providers.size,
      batchingEnabled: this.enableBatching,
      batchProviderCount: this.batchProviders.size
    });
  }

  /**
   * Validate provider connectivity before starting.
   * Ensures RPC endpoints are actually reachable.
   */
  async validateConnectivity(): Promise<void> {
    const healthyProviders: string[] = [];
    const unhealthyProviders: string[] = [];

    for (const [chainName, provider] of this.providers) {
      try {
        // Quick connectivity check - get block number
        await Promise.race([
          provider.getBlockNumber(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Connectivity check timeout')), PROVIDER_CONNECTIVITY_TIMEOUT_MS)
          )
        ]);

        // Mark as healthy - Fix 10.2: Use helper to update cache
        this.updateProviderHealth(chainName, {
          healthy: true,
          lastCheck: Date.now(),
          consecutiveFailures: 0
        });
        healthyProviders.push(chainName);

        this.logger.debug(`Provider connectivity verified for ${chainName}`);
      } catch (error) {
        // Mark as unhealthy - Fix 10.2: Use helper to update cache
        const health = this.providerHealth.get(chainName) || {
          healthy: false,
          lastCheck: 0,
          consecutiveFailures: 0
        };
        this.updateProviderHealth(chainName, {
          ...health,
          healthy: false,
          lastCheck: Date.now(),
          consecutiveFailures: health.consecutiveFailures + 1,
          lastError: getErrorMessage(error)
        });
        unhealthyProviders.push(chainName);
        this.stats.providerHealthCheckFailures++;

        this.logger.warn(`Provider connectivity failed for ${chainName}`, {
          error: getErrorMessage(error)
        });
      }
    }

    this.logger.info('Provider connectivity validation complete', {
      healthy: healthyProviders,
      unhealthy: unhealthyProviders,
      healthyCount: healthyProviders.length,
      unhealthyCount: unhealthyProviders.length
    });

    // Don't fail startup if some providers are unhealthy - they may recover
    if (healthyProviders.length === 0 && this.providers.size > 0) {
      this.logger.warn('No providers are currently healthy - service may be limited');
    }
  }

  /**
   * Start periodic provider health checks for reconnection.
   *
   * Fix 5.2: Added guard to prevent concurrent health check iterations.
   * If a health check cycle takes longer than 30 seconds (e.g., slow RPCs,
   * reconnection attempts), skip the overlapping check to prevent state corruption.
   */
  startHealthChecks(): void {
    // Check provider health every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      // Early exit if not running
      if (!this.stateManager.isRunning()) return;

      // Fix 5.2: Skip if previous health check is still running
      if (this.isCheckingHealth) {
        this.logger.debug('Skipping health check - previous check still in progress');
        return;
      }

      this.isCheckingHealth = true;
      try {
        for (const [chainName, provider] of this.providers) {
          // Check state before each provider check to abort early during shutdown
          if (!this.stateManager.isRunning()) {
            this.logger.debug('Aborting provider health checks - service stopping');
            return;
          }
          await this.checkAndReconnectProvider(chainName, provider);
        }
      } finally {
        this.isCheckingHealth = false;
      }
    }, 30000);
  }

  /**
   * Stop health monitoring.
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check provider health and attempt reconnection if needed.
   */
  private async checkAndReconnectProvider(
    chainName: string,
    provider: ethers.JsonRpcProvider
  ): Promise<void> {
    const health = this.providerHealth.get(chainName);
    if (!health) return;

    try {
      // Quick health check
      await Promise.race([
        provider.getBlockNumber(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timeout')), PROVIDER_HEALTH_CHECK_TIMEOUT_MS)
        )
      ]);

      // Update health status
      if (!health.healthy) {
        // Provider recovered
        this.logger.info(`Provider recovered for ${chainName}`, {
          previousFailures: health.consecutiveFailures
        });
      }

      // Fix 10.2: Use helper to update cache
      this.updateProviderHealth(chainName, {
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0
      });
    } catch (error) {
      // Provider unhealthy - attempt reconnection
      const newFailures = health.consecutiveFailures + 1;
      // Fix 10.2: Use helper to update cache
      this.updateProviderHealth(chainName, {
        healthy: false,
        lastCheck: Date.now(),
        consecutiveFailures: newFailures,
        lastError: getErrorMessage(error)
      });
      this.stats.providerHealthCheckFailures++;

      this.logger.warn(`Provider health check failed for ${chainName}`, {
        consecutiveFailures: newFailures,
        error: getErrorMessage(error)
      });

      // Attempt reconnection after 3 consecutive failures
      if (newFailures >= 3) {
        await this.attemptProviderReconnection(chainName);
      }
    }
  }

  /**
   * Attempt to reconnect a failed provider.
   */
  private async attemptProviderReconnection(chainName: string): Promise<void> {
    const chainConfig = CHAINS[chainName];
    if (!chainConfig) return;

    try {
      this.logger.info(`Attempting provider reconnection for ${chainName}`);

      // Create new provider instance
      const newProvider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);

      // Verify connectivity
      await Promise.race([
        newProvider.getBlockNumber(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Reconnection timeout')), PROVIDER_RECONNECTION_TIMEOUT_MS)
        )
      ]);

      // Replace old provider
      this.providers.set(chainName, newProvider);

      // Phase 3: Recreate BatchProvider if batching is enabled
      if (this.enableBatching) {
        // Shutdown old batch provider if exists
        const oldBatchProvider = this.batchProviders.get(chainName);
        if (oldBatchProvider) {
          await oldBatchProvider.shutdown();
        }
        // Create new batch provider with new provider
        const newBatchProvider = createBatchProvider(newProvider, this.batchConfig);
        this.batchProviders.set(chainName, newBatchProvider);
      }

      // Fix 10.2: Use helper to update cache
      this.updateProviderHealth(chainName, {
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0
      });
      this.stats.providerReconnections++;

      // Update wallet if exists
      const privateKey = process.env[`${chainName.toUpperCase()}_PRIVATE_KEY`];
      if (privateKey && this.wallets.has(chainName)) {
        const wallet = new ethers.Wallet(privateKey, newProvider);
        this.wallets.set(chainName, wallet);

        // Re-register wallet with NonceManager after provider reconnection
        if (this.nonceManager) {
          await this.nonceManager.resetChain(chainName);
          this.nonceManager.registerWallet(chainName, wallet);
        }
      }

      // Notify engine to clear stale state (e.g., gas baselines)
      if (this.onProviderReconnectCallback) {
        this.onProviderReconnectCallback(chainName);
      }

      this.logger.info(`Provider reconnection successful for ${chainName}`);
    } catch (error) {
      this.logger.error(`Provider reconnection failed for ${chainName}`, {
        error: getErrorMessage(error)
      });
    }
  }

  /**
   * Initialize wallets for all chains with configured private keys.
   */
  initializeWallets(): void {
    for (const chainName of Object.keys(CHAINS)) {
      const privateKey = process.env[`${chainName.toUpperCase()}_PRIVATE_KEY`];

      // Skip if no private key configured
      if (!privateKey) {
        this.logger.debug(`No private key configured for ${chainName}`);
        continue;
      }

      // Validate private key format before attempting wallet creation
      // Valid format: 64 hex chars (without 0x) or 66 chars (with 0x prefix)
      const keyWithoutPrefix = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
      if (!/^[0-9a-fA-F]{64}$/.test(keyWithoutPrefix)) {
        this.logger.error(`Invalid private key format for ${chainName}`, {
          hint: 'Private key must be 64 hex characters (or 66 with 0x prefix)',
          envVar: `${chainName.toUpperCase()}_PRIVATE_KEY`,
          keyLength: privateKey.length,
        });
        continue;
      }

      const provider = this.providers.get(chainName);
      if (provider) {
        try {
          const wallet = new ethers.Wallet(privateKey, provider);
          this.wallets.set(chainName, wallet);

          // Register wallet with nonce manager for atomic nonce allocation
          if (this.nonceManager) {
            this.nonceManager.registerWallet(chainName, wallet);
          }

          this.logger.info(`Initialized wallet for ${chainName}`, {
            address: wallet.address
          });
        } catch (error) {
          this.logger.error(`Failed to initialize wallet for ${chainName}`, { error });
        }
      }
    }
  }

  // ==========================================================================
  // Public Getters
  // ==========================================================================

  getProvider(chain: string): ethers.JsonRpcProvider | undefined {
    return this.providers.get(chain);
  }

  getProviders(): Map<string, ethers.JsonRpcProvider> {
    return this.providers;
  }

  /**
   * Phase 3: Get BatchProvider for a specific chain.
   * Returns undefined if batching is disabled or chain not found.
   * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
   */
  getBatchProvider(chain: string): BatchProvider | undefined {
    return this.batchProviders.get(chain);
  }

  /**
   * Phase 3: Get all BatchProvider instances.
   * Returns empty map if batching is disabled.
   * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
   */
  getBatchProviders(): Map<string, BatchProvider> {
    return this.batchProviders;
  }

  /**
   * Phase 3: Check if batching is enabled.
   */
  isBatchingEnabled(): boolean {
    return this.enableBatching;
  }

  getHealthMap(): Map<string, ProviderHealth> {
    return new Map(this.providerHealth);
  }

  /**
   * Get count of healthy providers.
   *
   * Fix 10.2: Returns cached count for O(1) access instead of O(n) iteration.
   * Cache is updated automatically via updateProviderHealth().
   */
  getHealthyCount(): number {
    return this.cachedHealthyCount;
  }

  /**
   * Fix 10.2: Update provider health and recalculate cached healthy count.
   * This ensures the count stays in sync with health changes.
   */
  private updateProviderHealth(chainName: string, health: ProviderHealth): void {
    const previousHealth = this.providerHealth.get(chainName);
    const wasHealthy = previousHealth?.healthy ?? false;
    const isNowHealthy = health.healthy;

    this.providerHealth.set(chainName, health);

    // Update cached count based on health transition
    if (!wasHealthy && isNowHealthy) {
      this.cachedHealthyCount++;
    } else if (wasHealthy && !isNowHealthy) {
      this.cachedHealthyCount--;
    }
  }

  registerWallet(chain: string, wallet: ethers.Wallet): void {
    this.wallets.set(chain, wallet);
  }

  getWallet(chain: string): ethers.Wallet | undefined {
    return this.wallets.get(chain);
  }

  getWallets(): Map<string, ethers.Wallet> {
    return this.wallets;
  }

  /**
   * Set nonce manager reference (for post-initialization injection).
   */
  setNonceManager(nonceManager: NonceManager | null): void {
    this.nonceManager = nonceManager;
  }

  /**
   * Clear all state (for shutdown).
   */
  async clear(): Promise<void> {
    this.stopHealthChecks();

    // Phase 3: Shutdown all batch providers before clearing
    if (this.enableBatching) {
      const shutdownPromises = Array.from(this.batchProviders.values()).map(
        (bp) => bp.shutdown().catch((err) => {
          this.logger.warn('Error shutting down batch provider', { error: getErrorMessage(err) });
        })
      );
      await Promise.all(shutdownPromises);
      this.batchProviders.clear();
    }

    this.providers.clear();
    this.wallets.clear();
    this.providerHealth.clear();
    // Fix 10.2: Reset cached count
    this.cachedHealthyCount = 0;
  }
}
