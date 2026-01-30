/**
 * Anvil Fork Manager
 *
 * Manages a local Anvil fork for pending state simulation.
 * Anvil is a fast local Ethereum development node from Foundry.
 *
 * Features:
 * - Start/stop Anvil fork process
 * - Reset fork to specific block numbers
 * - Apply pending transactions to simulate state changes
 * - Query pool reserves after applying transactions
 * - Create/revert snapshots for rollback capability
 *
 * Environment Variables (Fix 3.2):
 * - ANVIL_PORT: Port for Anvil to listen on (default: 8546)
 *   Set to avoid port conflicts in containerized deployments.
 *   Example: ANVIL_PORT=8547
 *
 * @see Phase 2: Pending-State Simulation Engine (Implementation Plan v3.0)
 * @see Task 2.3.1: Anvil Fork Manager
 * @see https://book.getfoundry.sh/reference/anvil/
 */

import { spawn, ChildProcess } from 'child_process';
import { ethers } from 'ethers';
// Fix 6.2: Import shared error message utility for consistent error handling
// Fix 6.3: Import shared rolling average utility to eliminate duplication
import { CHAIN_IDS, getSimulationErrorMessage, updateRollingAverage } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * State of the Anvil fork process.
 */
export type AnvilForkState = 'stopped' | 'starting' | 'running' | 'error';

/**
 * Configuration for AnvilForkManager.
 */
export interface AnvilForkConfig {
  /** RPC URL to fork from (e.g., Alchemy, Infura mainnet) */
  rpcUrl: string;
  /** Chain identifier (e.g., 'ethereum', 'arbitrum') */
  chain: string;
  /** Port for Anvil to listen on (default: 8546 to avoid conflict with standard nodes) */
  port?: number;
  /** Block number to fork at (default: latest) */
  forkBlockNumber?: number;
  /** Path to Anvil executable (default: 'anvil' from PATH) */
  anvilPath?: string;
  /** Whether to auto-start on construction (default: false) */
  autoStart?: boolean;
  /** Memory limit for Anvil cache in MB (default: 500) */
  cacheSize?: number;
  /** Number of accounts to generate (default: 1) */
  accounts?: number;
}

/**
 * Result of applying a pending transaction.
 */
export interface PendingTxSimulationResult {
  /** Whether the transaction succeeded */
  success: boolean;
  /** Transaction hash if successful */
  txHash?: string;
  /** Revert reason if failed */
  revertReason?: string;
  /** Gas used by the transaction */
  gasUsed?: bigint;
  /** Simulation latency in milliseconds */
  latencyMs: number;
  /** Error message if simulation failed */
  error?: string;
}

/**
 * Information about the current fork state.
 */
export interface AnvilForkInfo {
  /** Local RPC URL (http://127.0.0.1:port) */
  rpcUrl: string;
  /** Current block number */
  blockNumber: number;
  /** Chain ID */
  chainId: number;
  /** Anvil port */
  port: number;
  /** Fork source URL */
  sourceUrl: string;
  /** Fork block number */
  forkBlockNumber?: number;
}

/**
 * Health status of the Anvil fork.
 */
export interface AnvilForkHealth {
  /** Whether the fork is healthy and responsive */
  healthy: boolean;
  /** Whether the Anvil process is running */
  processRunning: boolean;
  /** Last health check timestamp */
  lastCheck: number;
  /** Last error message if any */
  lastError?: string;
  /** Process PID */
  pid?: number;
}

/**
 * Metrics for Anvil fork operations.
 */
export interface AnvilForkMetrics {
  /** Total simulations attempted */
  totalSimulations: number;
  /** Successful simulations */
  successfulSimulations: number;
  /** Failed simulations */
  failedSimulations: number;
  /** Average simulation latency in ms */
  averageLatencyMs: number;
  /** Total snapshots created */
  snapshotsCreated: number;
  /** Total snapshot reverts */
  snapshotReverts: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Fix 3.1 + 3.2: Anvil port configuration.
 * - Supports ANVIL_PORT environment variable for deployment flexibility
 * - Default changed from 8545 to 8546 to avoid conflict with standard Ethereum nodes
 */
const DEFAULT_PORT = parseInt(process.env.ANVIL_PORT || '8546', 10);
const DEFAULT_ANVIL_PATH = 'anvil';
const DEFAULT_CACHE_SIZE = 500;
const DEFAULT_ACCOUNTS = 1;
const DEFAULT_START_TIMEOUT_MS = 10000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/** UniswapV2 Pair getReserves function selector */
const GET_RESERVES_SELECTOR = '0x0902f1ac';

/** UniswapV2 getReserves return types */
const RESERVES_RETURN_TYPES = ['uint112', 'uint112', 'uint32'];

// =============================================================================
// AnvilForkManager Implementation
// =============================================================================

/**
 * Manages a local Anvil fork for pending state simulation.
 *
 * Usage:
 * ```typescript
 * const manager = new AnvilForkManager({
 *   rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY',
 *   chain: 'ethereum',
 * });
 *
 * await manager.startFork();
 *
 * // Apply a pending transaction
 * const result = await manager.applyPendingTx(signedTx);
 *
 * // Get pool reserves after the transaction
 * const [reserve0, reserve1] = await manager.getPoolReserves(poolAddress);
 *
 * await manager.shutdown();
 * ```
 */
/** Internal config type with required fields except forkBlockNumber which is optional */
type InternalAnvilConfig = Required<Omit<AnvilForkConfig, 'forkBlockNumber'>> & {
  forkBlockNumber?: number;
};

export class AnvilForkManager {
  private readonly config: InternalAnvilConfig;
  private state: AnvilForkState = 'stopped';
  private process: ChildProcess | null = null;
  private provider: ethers.JsonRpcProvider | null = null;
  private currentBlockNumber: number = 0;
  private chainId: number = 1;
  private metrics: AnvilForkMetrics;
  private health: AnvilForkHealth;
  private lastError: string | undefined;
  /** Promise for in-progress startup to handle concurrent calls */
  private startPromise: Promise<void> | null = null;

  constructor(config: AnvilForkConfig) {
    this.config = {
      rpcUrl: config.rpcUrl,
      chain: config.chain,
      port: config.port ?? DEFAULT_PORT,
      forkBlockNumber: config.forkBlockNumber,
      anvilPath: config.anvilPath ?? DEFAULT_ANVIL_PATH,
      autoStart: config.autoStart ?? false,
      cacheSize: config.cacheSize ?? DEFAULT_CACHE_SIZE,
      accounts: config.accounts ?? DEFAULT_ACCOUNTS,
    };

    this.chainId = CHAIN_IDS[config.chain] ?? 1;
    this.metrics = this.createEmptyMetrics();
    this.health = this.createInitialHealth();

    if (this.config.autoStart) {
      // Fix 4.3: Set state and startPromise synchronously to prevent race condition
      // where a concurrent caller could start another startFork before the promise is set
      this.state = 'starting';
      this.startPromise = this.doStartFork(DEFAULT_START_TIMEOUT_MS)
        .catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          this.state = 'error';
        })
        .finally(() => {
          this.startPromise = null;
        });
    }
  }

  // ===========================================================================
  // Public Methods - Lifecycle
  // ===========================================================================

  /**
   * Start the Anvil fork process.
   *
   * @param timeoutMs - Timeout for startup in milliseconds (default: 10000)
   * @throws Error if Anvil fails to start or times out
   */
  async startFork(timeoutMs: number = DEFAULT_START_TIMEOUT_MS): Promise<void> {
    // If already running, no-op
    if (this.state === 'running') {
      return;
    }

    // If starting, wait for current start to complete (handles concurrent calls)
    // Fix 4.3: This now properly handles autoStart race condition since startPromise
    // is set synchronously in constructor
    if (this.startPromise) {
      return this.startPromise;
    }

    this.state = 'starting';

    // Create and store the start promise so concurrent calls can await it
    this.startPromise = this.doStartFork(timeoutMs);

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Internal method to perform the actual fork startup.
   */
  private async doStartFork(timeoutMs: number): Promise<void> {
    try {
      await this.spawnAnvilProcess(timeoutMs);
      await this.initializeProvider();
      this.state = 'running';
      this.health.healthy = true;
      this.health.processRunning = true;
      this.health.lastCheck = Date.now();
    } catch (error) {
      this.state = 'error';
      // Fix 6.2: Use shared utility for consistent error handling
      this.lastError = getSimulationErrorMessage(error);
      this.health.healthy = false;
      this.health.lastError = this.lastError;
      throw error;
    }
  }

  /**
   * Shutdown the Anvil process and cleanup resources.
   *
   * @param timeoutMs - Timeout for graceful shutdown (default: 5000)
   */
  async shutdown(timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }

    // Cleanup provider
    if (this.provider) {
      this.provider = null;
    }

    // Kill process
    if (this.process) {
      await this.terminateProcess(timeoutMs);
      this.process = null;
    }

    this.state = 'stopped';
    this.health.healthy = false;
    this.health.processRunning = false;
    this.health.lastCheck = Date.now();
  }

  // ===========================================================================
  // Public Methods - Fork Operations
  // ===========================================================================

  /**
   * Reset the fork to a specific block number.
   *
   * @param blockNumber - Block number to reset to
   * @throws Error if fork is not running or reset fails
   */
  async resetToBlock(blockNumber: number): Promise<void> {
    this.ensureRunning();

    await this.provider!.send('anvil_reset', [
      {
        forking: {
          jsonRpcUrl: this.config.rpcUrl,
          blockNumber: blockNumber,
        },
      },
    ]);

    this.currentBlockNumber = await this.provider!.getBlockNumber();
  }

  /**
   * Apply a pending (signed) transaction to the fork.
   *
   * @param signedTx - Signed transaction hex string
   * @returns Simulation result with success status and gas used
   */
  async applyPendingTx(signedTx: string): Promise<PendingTxSimulationResult> {
    this.ensureRunning();

    const startTime = Date.now();
    this.metrics.totalSimulations++;

    try {
      // Send raw transaction
      const txHash = await this.provider!.send('eth_sendRawTransaction', [signedTx]);

      // Get receipt for gas used
      const receipt = await this.provider!.send('eth_getTransactionReceipt', [txHash]);

      const result: PendingTxSimulationResult = {
        success: true,
        txHash,
        gasUsed: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
        latencyMs: Date.now() - startTime,
      };

      this.metrics.successfulSimulations++;
      this.updateAverageLatency(result.latencyMs);

      return result;
    } catch (error) {
      // Fix 6.2: Use shared utility for consistent error handling
      const errorMessage = getSimulationErrorMessage(error);

      this.metrics.failedSimulations++;
      this.updateAverageLatency(Date.now() - startTime);

      return {
        success: false,
        revertReason: this.extractRevertReason(errorMessage),
        error: errorMessage,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get pool reserves for a UniswapV2-style pair.
   *
   * @param poolAddress - Address of the pair contract
   * @returns Tuple of [reserve0, reserve1] as bigint
   * @throws Error if fork is not running or call fails
   */
  async getPoolReserves(poolAddress: string): Promise<[bigint, bigint]> {
    this.ensureRunning();

    const result = await this.provider!.call({
      to: poolAddress,
      data: GET_RESERVES_SELECTOR,
    });

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(RESERVES_RETURN_TYPES, result);

    return [BigInt(decoded[0].toString()), BigInt(decoded[1].toString())];
  }

  // ===========================================================================
  // Public Methods - Snapshots
  // ===========================================================================

  /**
   * Create a snapshot of the current fork state.
   *
   * @returns Snapshot ID (hex string)
   * @throws Error if fork is not running
   */
  async createSnapshot(): Promise<string> {
    this.ensureRunning();

    const snapshotId = await this.provider!.send('evm_snapshot', []);
    this.metrics.snapshotsCreated++;

    return snapshotId;
  }

  /**
   * Revert to a previously created snapshot.
   *
   * @param snapshotId - Snapshot ID returned from createSnapshot
   * @throws Error if fork is not running or revert fails
   */
  async revertToSnapshot(snapshotId: string): Promise<void> {
    this.ensureRunning();

    await this.provider!.send('evm_revert', [snapshotId]);
    this.metrics.snapshotReverts++;
  }

  // ===========================================================================
  // Public Methods - Status & Metrics
  // ===========================================================================

  /**
   * Get the current state of the fork.
   */
  getState(): AnvilForkState {
    return this.state;
  }

  /**
   * Get information about the current fork.
   *
   * @throws Error if fork is not running
   */
  getForkInfo(): AnvilForkInfo {
    this.ensureRunning();

    return {
      rpcUrl: `http://127.0.0.1:${this.config.port}`,
      blockNumber: this.currentBlockNumber,
      chainId: this.chainId,
      port: this.config.port,
      sourceUrl: this.config.rpcUrl,
      forkBlockNumber: this.config.forkBlockNumber,
    };
  }

  /**
   * Get the ethers provider for the fork.
   *
   * @returns Provider if running, null otherwise
   */
  getProvider(): ethers.JsonRpcProvider | null {
    return this.provider;
  }

  /**
   * Get health status of the fork.
   */
  getHealth(): AnvilForkHealth {
    return {
      ...this.health,
      processRunning: this.process !== null && this.state === 'running',
    };
  }

  /**
   * Get metrics for fork operations.
   */
  getMetrics(): AnvilForkMetrics {
    return { ...this.metrics };
  }

  // ===========================================================================
  // Private Methods - Process Management
  // ===========================================================================

  /**
   * Spawn the Anvil process with configured arguments.
   */
  private async spawnAnvilProcess(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = this.buildAnvilArgs();

      const proc = spawn(this.config.anvilPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      this.process = proc;
      this.health.pid = proc.pid;

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill('SIGTERM');
          reject(new Error(`Anvil startup timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // Listen for ready message
      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        // Anvil outputs "Listening on 127.0.0.1:PORT" when ready
        if (stdout.includes('Listening on') && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn Anvil: ${error.message}`));
        }
      });

      proc.on('exit', (code) => {
        this.health.processRunning = false;
        this.health.healthy = false;

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Anvil exited with code ${code}: ${stderr}`));
        } else if (this.state === 'running') {
          // Unexpected exit while running
          this.state = 'error';
          this.lastError = `Anvil process exited unexpectedly with code ${code}`;
          this.health.lastError = this.lastError;
        }
      });
    });
  }

  /**
   * Build command line arguments for Anvil.
   */
  private buildAnvilArgs(): string[] {
    const args: string[] = [
      '--fork-url',
      this.config.rpcUrl,
      '--port',
      this.config.port.toString(),
      '--accounts',
      this.config.accounts.toString(),
      '--no-mining', // Don't auto-mine; we control tx execution
      '--silent', // Reduce log verbosity
    ];

    if (this.config.forkBlockNumber !== undefined) {
      args.push('--fork-block-number', this.config.forkBlockNumber.toString());
    }

    if (this.config.cacheSize) {
      args.push('--memory-limit', (this.config.cacheSize * 1024 * 1024).toString());
    }

    return args;
  }

  /**
   * Terminate the Anvil process gracefully.
   */
  private async terminateProcess(timeoutMs: number): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;

      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown fails
        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore kill errors
        }
        resolve();
      }, timeoutMs);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Clean up listeners
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners('error');

      // Send SIGTERM for graceful shutdown
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already dead
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  /**
   * Initialize the ethers provider for the local fork.
   */
  private async initializeProvider(): Promise<void> {
    const localUrl = `http://127.0.0.1:${this.config.port}`;
    this.provider = new ethers.JsonRpcProvider(localUrl);

    // Verify connection and get current block
    const network = await this.provider.getNetwork();
    this.chainId = Number(network.chainId);
    this.currentBlockNumber = await this.provider.getBlockNumber();
  }

  // ===========================================================================
  // Private Methods - Utilities
  // ===========================================================================

  /**
   * Ensure the fork is running before operations.
   */
  private ensureRunning(): void {
    if (this.state !== 'running' || !this.provider) {
      throw new Error('Anvil fork is not running');
    }
  }

  /**
   * Extract revert reason from error message.
   */
  private extractRevertReason(errorMessage: string): string {
    // Common patterns:
    // "execution reverted: REASON"
    // "VM Exception while processing transaction: revert REASON"
    const patterns = [
      /execution reverted:\s*(.+)/i,
      /revert\s*(.+)/i,
      /reason:\s*(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return errorMessage;
  }

  /**
   * Update rolling average latency.
   * Fix 6.3: Uses shared updateRollingAverage utility to eliminate duplication.
   */
  private updateAverageLatency(latencyMs: number): void {
    this.metrics.averageLatencyMs = updateRollingAverage(
      this.metrics.averageLatencyMs,
      latencyMs,
      this.metrics.totalSimulations
    );
    this.metrics.lastUpdated = Date.now();
  }

  /**
   * Create empty metrics object.
   */
  private createEmptyMetrics(): AnvilForkMetrics {
    return {
      totalSimulations: 0,
      successfulSimulations: 0,
      failedSimulations: 0,
      averageLatencyMs: 0,
      snapshotsCreated: 0,
      snapshotReverts: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Create initial health status.
   */
  private createInitialHealth(): AnvilForkHealth {
    return {
      healthy: false,
      processRunning: false,
      lastCheck: Date.now(),
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an AnvilForkManager instance.
 */
export function createAnvilForkManager(config: AnvilForkConfig): AnvilForkManager {
  return new AnvilForkManager(config);
}
