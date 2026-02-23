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
import * as http2 from 'http2';
import { CHAINS } from '@arbitrage/config';
import { getErrorMessage, NonceManager, BatchProvider, createBatchProvider, clearIntervalSafe } from '@arbitrage/core';
import type { ServiceStateManager, BatchProviderConfig } from '@arbitrage/core';
import type { Logger, ProviderHealth, ProviderService as IProviderService, ExecutionStats } from '../types';
import {
  PROVIDER_CONNECTIVITY_TIMEOUT_MS,
  PROVIDER_HEALTH_CHECK_TIMEOUT_MS,
  PROVIDER_RECONNECTION_TIMEOUT_MS,
} from '../types';
import { createCancellableTimeout } from './simulation/types';
import { derivePerChainWallets } from './hd-wallet-manager';

// =============================================================================
// HTTP/2 Session Pool for RPC Providers
// =============================================================================

/**
 * Pool of HTTP/2 client sessions, keyed by origin (e.g., "https://eth-mainnet.alchemyapi.io").
 * Sessions are reused across multiple requests for connection multiplexing.
 * Falls back to HTTP/1.1 if HTTP/2 connection fails.
 */
const http2Sessions = new Map<string, http2.ClientHttp2Session>();

/**
 * Get or create an HTTP/2 session for a given origin.
 */
function getHttp2Session(origin: string): http2.ClientHttp2Session | null {
  let session = http2Sessions.get(origin);
  if (session && !session.closed && !session.destroyed) {
    return session;
  }

  try {
    session = http2.connect(origin);

    session.on('error', () => {
      http2Sessions.delete(origin);
    });

    session.on('close', () => {
      http2Sessions.delete(origin);
    });

    http2Sessions.set(origin, session);
    return session;
  } catch {
    return null;
  }
}

/**
 * Create a custom FetchRequest getUrlFunc that uses HTTP/2 for HTTPS endpoints.
 * Falls back to the default HTTP/1.1 transport for non-HTTPS or on error.
 *
 * @param defaultGetUrl - The default ethers.js getUrlFunc for fallback
 * @returns Custom getUrlFunc with HTTP/2 support
 */
function createHttp2GetUrlFunc(
  defaultGetUrl: ethers.FetchGetUrlFunc
): ethers.FetchGetUrlFunc {
  return async (req: ethers.FetchRequest, signal?: FetchCancelSignal): Promise<ethers.GetUrlResponse> => {
    const url = new URL(req.url);

    // Only use HTTP/2 for HTTPS endpoints
    if (url.protocol !== 'https:') {
      return defaultGetUrl(req, signal);
    }

    const origin = url.origin;
    const session = getHttp2Session(origin);

    // Fallback to HTTP/1.1 if session creation fails
    if (!session) {
      return defaultGetUrl(req, signal);
    }

    return new Promise<ethers.GetUrlResponse>((resolve, reject) => {
      const headers: http2.OutgoingHttpHeaders = {
        ':method': req.method || 'POST',
        ':path': url.pathname + url.search,
        'content-type': 'application/json',
      };

      // Copy request headers
      for (const [key, value] of req.headers) {
        headers[key.toLowerCase()] = value;
      }

      const stream = session.request(headers);

      let statusCode = 200;
      const responseChunks: Buffer[] = [];

      stream.on('response', (responseHeaders) => {
        statusCode = (responseHeaders[':status'] as number) ?? 200;
      });

      stream.on('data', (chunk: Buffer) => {
        responseChunks.push(chunk);
      });

      stream.on('end', () => {
        const body = Buffer.concat(responseChunks);
        resolve({
          statusCode,
          statusMessage: '',
          headers: {},
          body,
        });
      });

      stream.on('error', (err: Error) => {
        // On HTTP/2 error, fall back to default transport
        http2Sessions.delete(origin);
        defaultGetUrl(req, signal).then(resolve).catch(reject);
      });

      // Handle abort signal
      if (signal) {
        const onAbort = () => {
          stream.close();
          reject(new Error('Request aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Write request body
      const body = req.body;
      if (body) {
        stream.end(Buffer.from(body));
      } else {
        stream.end();
      }
    });
  };
}

/**
 * Interface for FetchCancelSignal — subset of AbortSignal used by ethers.
 */
interface FetchCancelSignal {
  addEventListener(event: string, handler: () => void, options?: { once?: boolean }): void;
}

/**
 * Create an ethers JsonRpcProvider with HTTP/2 support.
 * Wraps the provider's FetchRequest to use HTTP/2 multiplexing for HTTPS endpoints.
 *
 * @param rpcUrl - RPC endpoint URL
 * @param enableHttp2 - Whether to enable HTTP/2 (default: true for HTTPS URLs)
 * @returns Configured JsonRpcProvider
 */
export function createHttp2Provider(
  rpcUrl: string,
  enableHttp2 = true
): ethers.JsonRpcProvider {
  const fetchRequest = new ethers.FetchRequest(rpcUrl);

  if (enableHttp2 && rpcUrl.startsWith('https://')) {
    const defaultGetUrl = ethers.FetchRequest.createGetUrlFunc();
    fetchRequest.getUrlFunc = createHttp2GetUrlFunc(defaultGetUrl);
  }

  return new ethers.JsonRpcProvider(fetchRequest);
}

/**
 * Shut down all HTTP/2 sessions (for graceful shutdown).
 */
export function closeHttp2Sessions(): void {
  for (const [origin, session] of http2Sessions) {
    try {
      session.close();
    } catch {
      // Ignore close errors during shutdown
    }
  }
  http2Sessions.clear();
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
   */
  private chainPrivateKeys: Map<string, string> = new Map();

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
        const provider = this.enableHttp2
          ? createHttp2Provider(chainConfig.rpcUrl, true)
          : new ethers.JsonRpcProvider(chainConfig.rpcUrl);
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
      const newProvider = this.enableHttp2
        ? createHttp2Provider(chainConfig.rpcUrl, true)
        : new ethers.JsonRpcProvider(chainConfig.rpcUrl);

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

      this.logger.debug(`No wallet configured for ${chainName} (no private key or mnemonic)`);
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
    // Fix #9: Clear cached private keys on shutdown
    this.chainPrivateKeys.clear();
    // Fix 10.2: Reset cached count
    this.cachedHealthyCount = 0;
    // Close HTTP/2 sessions
    closeHttp2Sessions();
  }
}
