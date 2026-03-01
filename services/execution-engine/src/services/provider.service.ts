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
import { CHAINS, FEATURE_FLAGS } from '@arbitrage/config';
import { clearIntervalSafe } from '@arbitrage/core/async';
import { getErrorMessage } from '@arbitrage/core/resilience';
import {
  BatchProvider,
  createBatchProvider,
  getHttp2SessionPool,
  closeDefaultHttp2Pool,
} from '@arbitrage/core/rpc';
import { NonceManager } from '@arbitrage/core';
import type { BatchProviderConfig } from '@arbitrage/core/rpc';
import type { ServiceStateManager } from '@arbitrage/core/service-lifecycle';
import type { Logger, ProviderHealth, ProviderService as IProviderService, ExecutionStats } from '../types';
import {
  PROVIDER_CONNECTIVITY_TIMEOUT_MS,
  PROVIDER_HEALTH_CHECK_TIMEOUT_MS,
  PROVIDER_RECONNECTION_TIMEOUT_MS,
} from '../types';
import { createCancellableTimeout } from './simulation/types';
import { derivePerChainWallets } from './hd-wallet-manager';
import { createKmsSigner, type KmsSigner } from './kms-signer';

// =============================================================================
// HTTP/2 Provider Factory
// =============================================================================

/**
 * Create an ethers JsonRpcProvider with HTTP/2 support.
 *
 * Uses the shared Http2SessionPool from @arbitrage/core for managed connections
 * with idle cleanup, ping keep-alive, and connection timeouts.
 *
 * @param rpcUrl - RPC endpoint URL
 * @param useHttp2 - Whether to enable HTTP/2 (default: true for HTTPS URLs)
 * @returns Configured JsonRpcProvider
 */
function createHttp2Provider(
  rpcUrl: string,
  useHttp2 = true,
  numericChainId?: number
): ethers.JsonRpcProvider {
  const fetchRequest = new ethers.FetchRequest(rpcUrl);

  if (useHttp2 && rpcUrl.startsWith('https://')) {
    const pool = getHttp2SessionPool();
    const defaultGetUrl = ethers.FetchRequest.createGetUrlFunc();
    fetchRequest.getUrlFunc = pool.createEthersGetUrlFunc(defaultGetUrl) as ethers.FetchGetUrlFunc;
  }

  // P1 Fix LW-012: Use staticNetwork to prevent ethers' infinite network detection retry loop
  const network = numericChainId ? ethers.Network.from(numericChainId) : undefined;
  return new ethers.JsonRpcProvider(fetchRequest, network, { staticNetwork: !!network });
}

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
  /**
   * Enable HTTP/2 multiplexing for HTTPS RPC endpoints.
   * Reduces head-of-line blocking and saves 2-5ms on batch calls.
   * Default: true
   */
  enableHttp2?: boolean;
  /**
   * P2-17: Health check interval in milliseconds.
   * Controls how often provider connectivity is verified.
   * Default: 30000 (30 seconds)
   */
  healthCheckIntervalMs?: number;
  /**
   * P2-18: Consecutive failure threshold before reconnection attempt.
   * After this many consecutive health check failures, the provider
   * will be replaced with a new connection.
   * Default: 3
   */
  reconnectionFailureThreshold?: number;
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
  private readonly enableHttp2: boolean;
  // P2-17: Configurable health check interval
  private readonly healthCheckIntervalMs: number;
  // P2-18: Configurable reconnection failure threshold
  private readonly reconnectionFailureThreshold: number;

  // Callback for provider reconnection (allows engine to clear stale state)
  private onProviderReconnectCallback: ((chainName: string) => void) | null = null;

  /**
   * Fix #9: Cached private keys for wallet reconnection.
   * Populated during initializeWallets() so reconnection logic does not
   * depend on process.env (keys may be rotated or cleaned from env).
   *
   * SECURITY NOTE: JS strings are immutable and cannot be reliably zeroed from
   * memory. The Map is cleared on shutdown (clear()) but GC timing is non-deterministic.
   * For production deployments with real funds, use KMS signers (FEATURE_KMS_SIGNING=true)
   * which keep private keys in hardware security modules and never expose them to the process.
   */
  private chainPrivateKeys: Map<string, string> = new Map();

  /**
   * Phase 2 Item 27: KMS signers for chains configured with KMS keys.
   * KMS signers implement ethers.AbstractSigner (key never leaves HSM).
   * Only populated when FEATURE_KMS_SIGNING=true.
   */
  private kmsSigners: Map<string, KmsSigner> = new Map();

  /**
   * FIX 11: Collect KMS address resolution promises so callers can await
   * them before processing the first opportunity. Without this, the
   * NonceManager registration was fire-and-forget and might not be ready.
   */
  private kmsRegistrationPromises: Promise<void>[] = [];

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
    this.enableHttp2 = config.enableHttp2 ?? true;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 30000;
    this.reconnectionFailureThreshold = config.reconnectionFailureThreshold ?? 3;
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
        const network = chainConfig.id ? ethers.Network.from(chainConfig.id) : undefined;
        const provider = this.enableHttp2
          ? createHttp2Provider(chainConfig.rpcUrl, true, chainConfig.id)
          : new ethers.JsonRpcProvider(chainConfig.rpcUrl, network, { staticNetwork: !!network });
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
        // P1 FIX: Use cancellable timeout to prevent timer leak on success
        const { promise: connectivityTimeout, cancel: cancelConnectivity } = createCancellableTimeout(
          PROVIDER_CONNECTIVITY_TIMEOUT_MS, 'Connectivity check timeout'
        );
        try {
          await Promise.race([provider.getBlockNumber(), connectivityTimeout]);
        } finally {
          cancelConnectivity();
        }

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
        // R2 Optimization: Parallel health checks for 3-4x faster health check cycles
        // Previous sequential approach: 3 providers × 2ms = 6ms minimum
        // Parallel approach: max(2ms, 2ms, 2ms) = 2ms
        // @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization R2

        // Check if service is stopping before starting any checks
        if (!this.stateManager.isRunning()) {
          this.logger.debug('Aborting provider health checks - service stopping');
          return;
        }

        // Run all health checks in parallel with error isolation
        const healthCheckPromises = Array.from(this.providers.entries()).map(
          ([chainName, provider]) =>
            this.checkAndReconnectProvider(chainName, provider)
              .catch((err) => {
                // Error isolation: one provider failure doesn't affect others
                this.logger.warn(`Health check error for ${chainName}`, {
                  error: getErrorMessage(err)
                });
              })
        );

        await Promise.all(healthCheckPromises);
      } finally {
        this.isCheckingHealth = false;
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop health monitoring.
   */
  stopHealthChecks(): void {
    this.healthCheckInterval = clearIntervalSafe(this.healthCheckInterval);
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
      // P1 FIX: Use cancellable timeout to prevent timer leak on success
      const { promise: healthTimeout, cancel: cancelHealth } = createCancellableTimeout(
        PROVIDER_HEALTH_CHECK_TIMEOUT_MS, 'Health check timeout'
      );
      try {
        await Promise.race([provider.getBlockNumber(), healthTimeout]);
      } finally {
        cancelHealth();
      }

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

      // P2-18: Attempt reconnection after configurable consecutive failures
      if (newFailures >= this.reconnectionFailureThreshold) {
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

      // Create new provider instance (with HTTP/2 if enabled)
      const network = chainConfig.id ? ethers.Network.from(chainConfig.id) : undefined;
      const newProvider = this.enableHttp2
        ? createHttp2Provider(chainConfig.rpcUrl, true, chainConfig.id)
        : new ethers.JsonRpcProvider(chainConfig.rpcUrl, network, { staticNetwork: !!network });

      // Verify connectivity
      // P1 FIX: Use cancellable timeout to prevent timer leak on success
      const { promise: reconnectTimeout, cancel: cancelReconnect } = createCancellableTimeout(
        PROVIDER_RECONNECTION_TIMEOUT_MS, 'Reconnection timeout'
      );
      try {
        await Promise.race([newProvider.getBlockNumber(), reconnectTimeout]);
      } finally {
        cancelReconnect();
      }

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

      // Update wallet if exists (reconnect with new provider)
      const existingWallet = this.wallets.get(chainName);
      if (existingWallet) {
        // Fix #9: Use cached private key instead of re-reading process.env.
        // Keys are cached in initializeWallets() for both per-chain and HD-derived wallets.
        const cachedKey = this.chainPrivateKeys.get(chainName);
        let reconnectedWallet: ethers.Wallet;
        if (cachedKey) {
          // Recreate wallet from cached private key with new provider
          reconnectedWallet = new ethers.Wallet(cachedKey, newProvider);
        } else {
          // Fallback: reconnect existing wallet to new provider
          // Fix 12: Removed redundant cast — Wallet.connect() returns Wallet in ethers v6
          reconnectedWallet = existingWallet.connect(newProvider);
        }
        this.wallets.set(chainName, reconnectedWallet);

        // Re-register wallet with NonceManager after provider reconnection
        if (this.nonceManager) {
          await this.nonceManager.resetChain(chainName);
          this.nonceManager.registerWallet(chainName, reconnectedWallet);
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
   * Initialize wallets for all chains.
   *
   * Wallet sources (in priority order):
   * 1. Per-chain private key: `{CHAIN}_PRIVATE_KEY` env var (overrides HD derivation)
   * 2. HD derivation: `WALLET_MNEMONIC` env var (BIP-44: m/44'/60'/0'/0/{chainIndex})
   *
   * Per-chain private keys always take precedence over HD-derived wallets.
   * Solana requires an explicit private key (non-EVM, HD path differs).
   *
   * @see Phase 0 Item 4: Per-chain HD wallets (BIP-44 derivation)
   */
  initializeWallets(): void {
    // Phase 0 Item 4: Derive HD wallets from mnemonic if available
    const mnemonic = process.env.WALLET_MNEMONIC;
    let hdWallets = new Map<string, ethers.HDNodeWallet>();
    if (mnemonic) {
      try {
        hdWallets = derivePerChainWallets(
          { mnemonic, passphrase: process.env.WALLET_MNEMONIC_PASSPHRASE },
          Object.keys(CHAINS),
          this.logger,
        );
        this.logger.info(`HD wallet derivation complete`, {
          chainsWithHDWallets: hdWallets.size,
        });
      } catch (error) {
        this.logger.error('HD wallet derivation failed — falling back to per-chain private keys only', {
          error: getErrorMessage(error),
        });
      }
    }

    for (const chainName of Object.keys(CHAINS)) {
      const privateKey = process.env[`${chainName.toUpperCase()}_PRIVATE_KEY`];

      // Source 1: Explicit per-chain private key (highest priority)
      if (privateKey) {
        // Validate private key format before attempting wallet creation
        // Valid format: 64 hex chars (without 0x) or 66 chars (with 0x prefix)
        const keyWithoutPrefix = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        if (!/^[0-9a-fA-F]{64}$/.test(keyWithoutPrefix)) {
          this.logger.error(`Invalid private key format for ${chainName}`, {
            hint: 'Private key must be 64 hex characters (or 66 with 0x prefix)',
            envVar: `${chainName.toUpperCase()}_PRIVATE_KEY`,
            hasHexPrefix: privateKey.startsWith('0x'),
          });
          continue;
        }

        const provider = this.providers.get(chainName);
        if (provider) {
          try {
            const wallet = new ethers.Wallet(privateKey, provider);
            this.wallets.set(chainName, wallet);
            // Fix #9: Cache validated private key for reconnection
            this.chainPrivateKeys.set(chainName, privateKey);
            if (this.nonceManager) {
              this.nonceManager.registerWallet(chainName, wallet);
            }
            this.logger.info(`Initialized wallet for ${chainName}`, {
              address: wallet.address,
              source: 'private-key',
            });
          } catch (error) {
            this.logger.error(`Failed to initialize wallet for ${chainName}`, { error });
          }
        }
        continue;
      }

      // Source 2: HD-derived wallet from mnemonic
      const hdWallet = hdWallets.get(chainName);
      if (hdWallet) {
        const provider = this.providers.get(chainName);
        if (provider) {
          try {
            // Create a standard Wallet from the HD-derived private key.
            // ethers.Wallet and HDNodeWallet are separate types — extract
            // the private key to construct a Wallet compatible with the
            // Map<string, ethers.Wallet> interface.
            const wallet = new ethers.Wallet(hdWallet.privateKey, provider);
            this.wallets.set(chainName, wallet);
            // Fix #9: Cache HD-derived private key for reconnection
            this.chainPrivateKeys.set(chainName, hdWallet.privateKey);
            if (this.nonceManager) {
              this.nonceManager.registerWallet(chainName, wallet);
            }
            this.logger.info(`Initialized wallet for ${chainName}`, {
              address: wallet.address,
              source: 'hd-derivation',
              path: hdWallet.path,
            });
          } catch (error) {
            this.logger.error(`Failed to initialize HD-derived wallet for ${chainName}`, { error });
          }
        }
        continue;
      }

      // Source 3: KMS signer (when FEATURE_KMS_SIGNING=true)
      if (FEATURE_FLAGS.useKmsSigning) {
        const provider = this.providers.get(chainName);
        if (provider) {
          const kmsSigner = createKmsSigner(chainName, provider, this.logger);
          if (kmsSigner) {
            // KMS signers are stored separately — they implement AbstractSigner
            // but not ethers.Wallet. The engine uses getAddress() which works for both.
            this.kmsSigners.set(chainName, kmsSigner);
            // Fix #18: Register KMS signer with NonceManager using address+provider
            // to prevent nonce conflicts between KMS and wallet transactions.
            // FIX 11: Collect promise so callers can await KMS registration completion
            // before processing the first opportunity.
            if (this.nonceManager) {
              const nm = this.nonceManager;
              const registrationPromise = kmsSigner.getAddress().then(addr => {
                nm.registerSigner(chainName, addr, provider);
                this.logger.debug(`Registered KMS signer with NonceManager for ${chainName}`, { address: addr.slice(0, 10) + '...' });
              }).catch(err => {
                this.logger.warn(`Failed to register KMS signer with NonceManager for ${chainName}`, { error: err });
              });
              this.kmsRegistrationPromises.push(registrationPromise);
            }
            this.logger.info(`Initialized KMS signer for ${chainName}`, {
              keyId: process.env[`KMS_KEY_ID_${chainName.toUpperCase()}`] ?? process.env.KMS_KEY_ID ?? 'unknown',
              source: 'kms',
            });
            continue;
          }
        }
      }

      this.logger.debug(`No wallet configured for ${chainName} (no private key, mnemonic, or KMS key)`);
    }
  }

  /**
   * FIX 11: Await all KMS address resolution promises.
   * Call this after initializeWallets() to ensure NonceManager registrations
   * are complete before processing the first opportunity.
   */
  async waitForKmsRegistrations(): Promise<void> {
    if (this.kmsRegistrationPromises.length > 0) {
      await Promise.allSettled(this.kmsRegistrationPromises);
      this.kmsRegistrationPromises = [];
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
   * Phase 2 Item 27: Get KMS signer for a specific chain.
   * Returns undefined if KMS is not configured for that chain.
   */
  getKmsSigner(chain: string): KmsSigner | undefined {
    return this.kmsSigners.get(chain);
  }

  /**
   * Phase 2 Item 27: Get all KMS signer instances.
   * Returns empty map if KMS signing is disabled.
   */
  getKmsSigners(): Map<string, KmsSigner> {
    return this.kmsSigners;
  }

  /**
   * Get the effective signer for a chain (Wallet or KMS signer).
   * Prefers Wallet if available, falls back to KMS signer.
   */
  getEffectiveSigner(chain: string): ethers.Wallet | KmsSigner | undefined {
    return this.wallets.get(chain) ?? this.kmsSigners.get(chain);
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
    // Fix #9: Clear cached private keys on shutdown
    this.chainPrivateKeys.clear();
    // Phase 2 Item 27: Drain queued KMS sign operations, then clear signers
    for (const signer of this.kmsSigners.values()) {
      signer.drain();
    }
    this.kmsSigners.clear();
    // Fix 10.2: Reset cached count
    this.cachedHealthyCount = 0;
    // Close HTTP/2 sessions (fire-and-forget during sync clear)
    closeDefaultHttp2Pool().catch(() => {});
  }
}
