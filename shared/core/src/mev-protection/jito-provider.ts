/**
 * Jito MEV Protection Provider for Solana
 *
 * Implements MEV protection for Solana using Jito private bundles.
 * Bundles are sent directly to Jito Block Engine, bypassing the public mempool
 * to prevent sandwich attacks and other MEV extraction.
 *
 * Jito is the primary MEV solution for Solana, similar to Flashbots on Ethereum.
 *
 * @see https://jito-labs.gitbook.io/mev/
 * @see Phase 1.2: Enhanced MEV Protection in implementation plan
 */

import {
  ISolanaMevProvider,
  SolanaTransactionLike,
  MevStrategy,
  MevSubmissionResult,
  BundleSimulationResult,
  MevMetrics,
} from './types';
import { MevMetricsManager } from './metrics-manager';

// =============================================================================
// Jito Configuration
// =============================================================================

/**
 * Jito default configuration values
 */
export const JITO_DEFAULTS = {
  /** Jito Block Engine mainnet endpoint */
  mainnetEndpoint: 'https://mainnet.block-engine.jito.wtf/api/v1',
  /** Default tip in lamports (0.001 SOL = 1,000,000 lamports) */
  defaultTipLamports: 1_000_000,
  /** Status polling interval in ms */
  statusPollIntervalMs: 500,
  /** Status polling timeout in ms */
  statusPollTimeoutMs: 30_000,
  /** Maximum retries for bundle submission */
  maxRetries: 3,
  /** Submission timeout in ms */
  submissionTimeoutMs: 30_000,
  /** Whether to fallback to public mempool on failure */
  fallbackToPublic: true,
};

/**
 * Jito tip accounts — one will be randomly selected for each bundle.
 *
 * These are the official Jito tip payment addresses as of 2025.
 * Prefer using JitoProviderConfig.tipAccounts for configurability —
 * if Jito changes their tip accounts, the config path can be updated
 * without a code change.
 *
 * @deprecated Use JitoProviderConfig.tipAccounts for new integrations.
 */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVmkdzGzTRQKn5WcnXwZCA',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

// =============================================================================
// Jito Provider Configuration
// =============================================================================

/**
 * Configuration for Jito provider
 * Note: Solana uses different types than Ethereum (Connection instead of JsonRpcProvider)
 */
export interface JitoProviderConfig {
  /** Chain identifier (must be 'solana') */
  chain: string;
  /** Solana Connection object */
  connection: SolanaConnection;
  /** Solana Keypair for signing */
  keypair: SolanaKeypair;
  /** Whether MEV protection is enabled */
  enabled: boolean;
  /** Custom Jito endpoint URL */
  jitoEndpoint?: string;
  /** Tip amount in lamports */
  tipLamports?: number;
  /**
   * Custom tip accounts (optional)
   * CONFIG-FIX: Allows overriding hardcoded tip accounts without code changes.
   * If Jito changes their tip accounts, you can update via config.
   * Defaults to JITO_TIP_ACCOUNTS if not provided.
   */
  tipAccounts?: string[];
  /** Status polling interval in ms */
  statusPollIntervalMs?: number;
  /** Status polling timeout in ms */
  statusPollTimeoutMs?: number;
  /** Maximum retries */
  maxRetries?: number;
  /** Submission timeout in ms */
  submissionTimeoutMs?: number;
  /** Whether to fallback to standard submission on failure */
  fallbackToPublic?: boolean;
}

/**
 * Minimal Solana Connection interface
 * Defined here to avoid direct @solana/web3.js dependency
 */
export interface SolanaConnection {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getSlot(): Promise<number>;
  getSignatureStatus(signature: string): Promise<{
    value: { confirmationStatus: string; slot?: number } | null;
  }>;
  getBalance(publicKey: SolanaPublicKey): Promise<number>;
  sendRawTransaction(
    rawTransaction: Buffer | Uint8Array,
    options?: { skipPreflight?: boolean }
  ): Promise<string>;
}

/**
 * Minimal Solana Keypair interface
 */
export interface SolanaKeypair {
  publicKey: SolanaPublicKey;
  secretKey: Uint8Array;
}

/**
 * Minimal Solana PublicKey interface
 */
export interface SolanaPublicKey {
  toBase58(): string;
  toBuffer(): Buffer;
}

/**
 * Minimal Solana Transaction interface
 */
export interface SolanaTransaction {
  serialize(): Buffer;
  signatures: Array<{ signature: Buffer | null }>;
  recentBlockhash?: string;
}

// =============================================================================
// Jito Provider Implementation
// =============================================================================

/**
 * Jito provider for Solana MEV protection
 *
 * Uses Jito Block Engine to submit private transaction bundles that are
 * included atomically without being visible in the public mempool.
 */
export class JitoProvider implements ISolanaMevProvider {
  readonly chain = 'solana';
  readonly strategy: MevStrategy = 'jito';

  private readonly config: JitoProviderConfig;
  private readonly jitoEndpoint: string;
  private readonly tipLamports: number;
  /**
   * CONFIG-FIX: Configurable tip accounts with fallback to defaults.
   * Allows updating tip accounts without code changes if Jito modifies them.
   */
  private readonly tipAccounts: string[];

  /**
   * REFACTOR: Metrics management delegated to MevMetricsManager
   * to share code with BaseMevProvider and ensure consistent behavior.
   */
  private readonly metricsManager: MevMetricsManager;

  constructor(config: JitoProviderConfig) {
    if (config.chain !== 'solana') {
      throw new Error('JitoProvider is only for Solana');
    }

    this.config = config;
    this.jitoEndpoint = config.jitoEndpoint || JITO_DEFAULTS.mainnetEndpoint;
    this.tipLamports = config.tipLamports ?? JITO_DEFAULTS.defaultTipLamports;
    // CONFIG-FIX: Use custom tip accounts if provided, otherwise use defaults
    this.tipAccounts = config.tipAccounts && config.tipAccounts.length > 0
      ? config.tipAccounts
      : JITO_TIP_ACCOUNTS;
    this.metricsManager = new MevMetricsManager();
  }

  /**
   * Dispose of provider resources.
   * Resets metrics state.
   */
  dispose(): void {
    this.metricsManager.resetMetrics();
  }

  /**
   * Check if MEV protection is available and enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Send a transaction with Jito MEV protection
   */
  async sendProtectedTransaction(
    tx: SolanaTransactionLike,
    options?: {
      tipLamports?: number;
      simulate?: boolean;
    }
  ): Promise<MevSubmissionResult> {
    const startTime = Date.now();

    // METRICS-FIX: Check enabled BEFORE incrementing totalSubmissions.
    // When disabled, return immediately without affecting metrics.
    // This ensures totalSubmissions = successfulSubmissions + failedSubmissions + fallbackSubmissions.
    if (!this.isEnabled()) {
      return {
        success: false,
        error: 'Jito MEV protection is disabled',
        strategy: 'jito',
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    }

    await this.metricsManager.increment('totalSubmissions');

    // PERFORMANCE-FIX: Serialize transaction once at the top, outside try block.
    // This ensures we can use the serialized version in the catch block,
    // avoiding re-serialization (which is expensive for Solana transactions).
    let serializedTx: Buffer | Uint8Array;
    try {
      serializedTx = tx.serialize();
    } catch (serializeError) {
      // Serialization failed - cannot proceed with any submission
      await this.metricsManager.increment('failedSubmissions');
      return {
        success: false,
        error: `Transaction serialization failed: ${serializeError instanceof Error ? serializeError.message : String(serializeError)}`,
        strategy: 'jito',
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    }

    try {
      // Get tip amount
      const tipAmount = options?.tipLamports ?? this.tipLamports;

      const base64Tx = Buffer.from(serializedTx).toString('base64');

      // Optionally simulate before submission (enabled by default for safety)
      if (options?.simulate !== false) {
        // PERFORMANCE-FIX: Use pre-serialized base64 to avoid double serialization
        const simResult = await this.simulateTransactionFromBase64(base64Tx);
        if (!simResult.success) {
          await this.metricsManager.increment('bundlesReverted');
          return this.fallbackToPublicWithSerialized(
            serializedTx,
            startTime,
            `Simulation failed: ${simResult.error}`
          );
        }
      }

      // Submit bundle to Jito
      const bundleResult = await this.submitBundle([base64Tx], tipAmount);

      if (bundleResult.success && bundleResult.bundleId) {
        // Wait for bundle inclusion
        const inclusion = await this.waitForBundleInclusion(bundleResult.bundleId);

        if (inclusion.included) {
          // PERF: Single mutex acquisition instead of 3 separate awaits
          await this.metricsManager.batchUpdate({
            successfulSubmissions: 1,
            bundlesIncluded: 1,
          }, startTime);

          return {
            success: true,
            transactionHash: inclusion.signature,
            bundleHash: bundleResult.bundleId,
            blockNumber: inclusion.slot,
            strategy: 'jito',
            latencyMs: Date.now() - startTime,
            usedFallback: false,
          };
        }

        // Bundle not included - use pre-serialized tx for performance
        return this.fallbackToPublicWithSerialized(
          serializedTx,
          startTime,
          'Bundle not included in time'
        );
      }

      // Bundle submission failed - use pre-serialized tx for performance
      return this.fallbackToPublicWithSerialized(
        serializedTx,
        startTime,
        bundleResult.error || 'Bundle submission failed'
      );
    } catch (error) {
      // Note: Don't increment failedSubmissions here - fallbackToPublicWithSerialized handles it
      // to avoid double-counting when fallback is disabled
      const errorMessage = error instanceof Error ? error.message : String(error);
      // PERFORMANCE-FIX: Use pre-serialized transaction (serializedTx is now always available)
      return this.fallbackToPublicWithSerialized(serializedTx, startTime, errorMessage);
    }
  }

  /**
   * Simulate a transaction without submitting
   *
   * This is the public API that accepts a SolanaTransaction.
   * Internally serializes and delegates to simulateTransactionFromBase64.
   */
  async simulateTransaction(
    tx: SolanaTransactionLike
  ): Promise<BundleSimulationResult> {
    try {
      const serializedTx = tx.serialize();
      const base64Tx = Buffer.from(serializedTx).toString('base64');
      return this.simulateTransactionFromBase64(base64Tx);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Simulate a transaction from pre-serialized base64 string
   *
   * PERFORMANCE-OPTIMIZATION: Use this when you already have the serialized
   * transaction to avoid redundant serialization on the hot path.
   */
  async simulateTransactionFromBase64(
    base64Tx: string
  ): Promise<BundleSimulationResult> {
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateBundle',
        params: [[base64Tx]],
      };

      const response = await this.sendJitoRequest(body);

      if (response.error) {
        return {
          success: false,
          error: response.error.message || 'Simulation failed',
        };
      }

      const result = response.result?.value;

      if (result?.err) {
        return {
          success: false,
          error: JSON.stringify(result.err),
        };
      }

      return {
        success: true,
        gasUsed: BigInt(result?.unitsConsumed ?? 0),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get current metrics
   * Delegates to MevMetricsManager for thread-safe access.
   */
  getMetrics(): MevMetrics {
    return this.metricsManager.getMetrics();
  }

  /**
   * Reset metrics
   * Delegates to MevMetricsManager.
   */
  resetMetrics(): void {
    this.metricsManager.resetMetrics();
  }

  /**
   * Check health of Jito Block Engine connection
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTipAccounts',
        params: [],
      };

      const response = await fetch(`${this.jitoEndpoint}/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return { healthy: true, message: 'Jito Block Engine is healthy' };
      }

      return {
        healthy: false,
        message: `Jito API returned status ${response.status}: ${response.statusText}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Jito Block Engine: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Submit bundle to Jito Block Engine
   */
  private async submitBundle(
    base64Transactions: string[],
    tipLamports: number
  ): Promise<{ success: boolean; bundleId?: string; error?: string }> {
    const maxRetries = this.config.maxRetries ?? JITO_DEFAULTS.maxRetries;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Select random tip account from configured accounts
        const tipAccount = this.tipAccounts[
          Math.floor(Math.random() * this.tipAccounts.length)
        ];

        const body = {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [
            base64Transactions,
            {
              tip: tipLamports,
              tipAccount,
            },
          ],
        };

        const response = await this.sendJitoRequest(body);

        if (response.error) {
          if (attempt < maxRetries - 1) continue;
          return {
            success: false,
            error: response.error.message || 'Bundle submission failed',
          };
        }

        const bundleId = response.result;
        if (!bundleId) {
          if (attempt < maxRetries - 1) continue;
          return {
            success: false,
            error: 'No bundle ID returned',
          };
        }

        return {
          success: true,
          bundleId,
        };
      } catch (error) {
        if (attempt < maxRetries - 1) continue;
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      success: false,
      error: `Bundle submission failed after ${maxRetries} attempts`,
    };
  }

  /**
   * Wait for bundle inclusion in a slot
   *
   * PERF: Uses exponential backoff starting from configured interval,
   * doubling up to 4s max. This reduces RPC load while maintaining
   * responsiveness for fast confirmations.
   */
  private async waitForBundleInclusion(
    bundleId: string
  ): Promise<{ included: boolean; signature?: string; slot?: number }> {
    const basePollInterval =
      this.config.statusPollIntervalMs ?? JITO_DEFAULTS.statusPollIntervalMs;
    const timeout =
      this.config.statusPollTimeoutMs ?? JITO_DEFAULTS.statusPollTimeoutMs;
    const startTime = Date.now();

    // PERF: Exponential backoff - start aggressive, back off over time
    let currentInterval = basePollInterval;
    const maxInterval = Math.max(4000, basePollInterval * 8); // Cap at 4s or 8x base

    while (Date.now() - startTime < timeout) {
      try {
        const body = {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        };

        const response = await this.sendJitoRequest(body);

        if (response.result?.value?.[0]) {
          const status = response.result.value[0];

          if (status.status === 'Landed') {
            return {
              included: true,
              slot: status.landed_slot,
              signature: status.transactions?.[0],
            };
          }

          if (status.status === 'Failed') {
            await this.metricsManager.increment('bundlesReverted');
            return {
              included: false,
            };
          }

          // Status is 'Pending' or 'Processing', continue polling
        }

        await this.sleep(currentInterval);
        // Exponential backoff: double interval, but cap at maxInterval
        currentInterval = Math.min(currentInterval * 2, maxInterval);
      } catch {
        // Continue polling on errors
        await this.sleep(currentInterval);
        currentInterval = Math.min(currentInterval * 2, maxInterval);
      }
    }

    return { included: false };
  }

  /**
   * Send request to Jito API
   */
  private async sendJitoRequest(body: object): Promise<any> {
    const timeout =
      this.config.submissionTimeoutMs ?? JITO_DEFAULTS.submissionTimeoutMs;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.jitoEndpoint}/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Fallback to standard Solana transaction submission (with pre-serialized tx)
   * Optimization: Avoids re-serialization when we already have the serialized data
   */
  private async fallbackToPublicWithSerialized(
    serializedTx: Buffer | Uint8Array,
    startTime: number,
    reason: string
  ): Promise<MevSubmissionResult> {
    const fallbackEnabled =
      this.config.fallbackToPublic ?? JITO_DEFAULTS.fallbackToPublic;

    if (!fallbackEnabled) {
      await this.metricsManager.increment('failedSubmissions');
      return {
        success: false,
        error: `Jito submission failed: ${reason}. Fallback disabled.`,
        strategy: 'jito',
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    }

    try {
      await this.metricsManager.increment('fallbackSubmissions');

      // Submit directly to Solana RPC (use pre-serialized tx)
      const signature = await this.config.connection.sendRawTransaction(
        serializedTx,
        { skipPreflight: false }
      );

      // Wait for confirmation
      const confirmation = await this.waitForConfirmation(signature);

      if (confirmation.confirmed) {
        // PERF: Single mutex acquisition instead of 2 separate awaits
        await this.metricsManager.batchUpdate({
          successfulSubmissions: 1,
        }, startTime);

        return {
          success: true,
          transactionHash: signature,
          blockNumber: confirmation.slot,
          strategy: 'jito',
          latencyMs: Date.now() - startTime,
          usedFallback: true,
        };
      }

      await this.metricsManager.increment('failedSubmissions');
      return {
        success: false,
        error: `Jito failed: ${reason}. Fallback transaction not confirmed.`,
        strategy: 'jito',
        latencyMs: Date.now() - startTime,
        usedFallback: true,
      };
    } catch (error) {
      await this.metricsManager.increment('failedSubmissions');
      return {
        success: false,
        error: `Jito and fallback both failed. Original: ${reason}. Fallback: ${error instanceof Error ? error.message : String(error)}`,
        strategy: 'jito',
        latencyMs: Date.now() - startTime,
        usedFallback: true,
      };
    }
  }

  /**
   * Wait for transaction confirmation on Solana
   */
  private async waitForConfirmation(
    signature: string
  ): Promise<{ confirmed: boolean; slot?: number }> {
    const timeout =
      this.config.statusPollTimeoutMs ?? JITO_DEFAULTS.statusPollTimeoutMs;
    const pollInterval =
      this.config.statusPollIntervalMs ?? JITO_DEFAULTS.statusPollIntervalMs;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const status = await this.config.connection.getSignatureStatus(signature);

        if (status.value) {
          const confirmationStatus = status.value.confirmationStatus;
          if (
            confirmationStatus === 'confirmed' ||
            confirmationStatus === 'finalized'
          ) {
            return {
              confirmed: true,
              slot: status.value.slot,
            };
          }
        }

        await this.sleep(pollInterval);
      } catch {
        await this.sleep(pollInterval);
      }
    }

    return { confirmed: false };
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Jito provider for Solana
 */
export function createJitoProvider(config: JitoProviderConfig): JitoProvider {
  return new JitoProvider(config);
}
