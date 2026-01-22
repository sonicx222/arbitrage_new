/**
 * Provider Service
 *
 * Manages RPC provider lifecycle including:
 * - Provider initialization for all configured chains
 * - Connectivity validation
 * - Health monitoring and automatic reconnection
 * - Wallet management
 *
 * @see engine.ts (parent service)
 */

import { ethers } from 'ethers';
import { CHAINS } from '@arbitrage/config';
import { getErrorMessage, NonceManager } from '@arbitrage/core';
import type { ServiceStateManager } from '@arbitrage/core';
import type { Logger, ProviderHealth, ProviderService as IProviderService, ExecutionStats } from '../types';

export interface ProviderServiceConfig {
  logger: Logger;
  stateManager: ServiceStateManager;
  nonceManager: NonceManager | null;
  stats: ExecutionStats;
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

  // Callback for provider reconnection (allows engine to clear stale state)
  private onProviderReconnectCallback: ((chainName: string) => void) | null = null;

  constructor(config: ProviderServiceConfig) {
    this.logger = config.logger;
    this.stateManager = config.stateManager;
    this.nonceManager = config.nonceManager;
    this.stats = config.stats;
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

        // Initialize health tracking for this provider
        this.providerHealth.set(chainName, {
          healthy: false, // Will be verified in validateConnectivity
          lastCheck: 0,
          consecutiveFailures: 0
        });
      } catch (error) {
        this.logger.warn(`Failed to initialize provider for ${chainName}`, { error });
        this.providerHealth.set(chainName, {
          healthy: false,
          lastCheck: Date.now(),
          consecutiveFailures: 1,
          lastError: getErrorMessage(error)
        });
      }
    }
    this.logger.info('Initialized blockchain providers', {
      count: this.providers.size
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
            setTimeout(() => reject(new Error('Connectivity check timeout')), 5000)
          )
        ]);

        // Mark as healthy
        this.providerHealth.set(chainName, {
          healthy: true,
          lastCheck: Date.now(),
          consecutiveFailures: 0
        });
        healthyProviders.push(chainName);

        this.logger.debug(`Provider connectivity verified for ${chainName}`);
      } catch (error) {
        // Mark as unhealthy
        const health = this.providerHealth.get(chainName) || {
          healthy: false,
          lastCheck: 0,
          consecutiveFailures: 0
        };
        this.providerHealth.set(chainName, {
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
   */
  startHealthChecks(): void {
    // Check provider health every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      // Early exit if not running
      if (!this.stateManager.isRunning()) return;

      for (const [chainName, provider] of this.providers) {
        // Check state before each provider check to abort early during shutdown
        if (!this.stateManager.isRunning()) {
          this.logger.debug('Aborting provider health checks - service stopping');
          return;
        }
        await this.checkAndReconnectProvider(chainName, provider);
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
          setTimeout(() => reject(new Error('Health check timeout')), 5000)
        )
      ]);

      // Update health status
      if (!health.healthy) {
        // Provider recovered
        this.logger.info(`Provider recovered for ${chainName}`, {
          previousFailures: health.consecutiveFailures
        });
      }

      this.providerHealth.set(chainName, {
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0
      });
    } catch (error) {
      // Provider unhealthy - attempt reconnection
      const newFailures = health.consecutiveFailures + 1;
      this.providerHealth.set(chainName, {
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
          setTimeout(() => reject(new Error('Reconnection timeout')), 10000)
        )
      ]);

      // Replace old provider
      this.providers.set(chainName, newProvider);
      this.providerHealth.set(chainName, {
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

  getHealthMap(): Map<string, ProviderHealth> {
    return new Map(this.providerHealth);
  }

  getHealthyCount(): number {
    let count = 0;
    for (const health of this.providerHealth.values()) {
      if (health.healthy) count++;
    }
    return count;
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
  clear(): void {
    this.stopHealthChecks();
    this.providers.clear();
    this.wallets.clear();
    this.providerHealth.clear();
  }
}
