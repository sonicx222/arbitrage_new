/**
 * Per-Chain Balance Monitor (Task 4.1)
 *
 * Periodically checks native token balances across configured wallets per chain.
 * Logs warnings when balance deviates from expected (post-trade drift detection).
 * Exposes balance state for health endpoints.
 *
 * This is a monitoring/alerting service only — no automated actions are taken.
 *
 * @see docs/reports/IMPLEMENTATION_PLAN.md - Wave 4, Task 4.1
 * @see services/execution-engine/src/engine.ts (integration point)
 */

import { ethers } from 'ethers';
import { clearIntervalSafe } from '@arbitrage/core/async';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { Logger } from '../types';

// =============================================================================
// Types
// =============================================================================

export interface ChainBalance {
  /** Chain identifier (e.g., 'ethereum', 'arbitrum') */
  chain: string;
  /** Wallet address being monitored */
  address: string;
  /** Native token balance in ETH (human-readable) */
  balanceEth: string;
  /** Native token balance in wei */
  balanceWei: string;
  /** Timestamp of last successful check */
  lastCheckedAt: number;
  /** Whether this check was successful */
  healthy: boolean;
  /** Error message if check failed */
  error?: string;
}

export interface BalanceSnapshot {
  /** Balances per chain */
  balances: Map<string, ChainBalance>;
  /** Timestamp of the snapshot */
  timestamp: number;
  /** Number of chains with healthy balance checks */
  healthyCount: number;
  /** Number of chains with failed balance checks */
  failedCount: number;
}

export interface BalanceMonitorConfig {
  /** How often to check balances (ms). Default: 60000 (1 min) */
  checkIntervalMs?: number;
  /** Minimum balance threshold in ETH — below this triggers a warning. Default: 0.01 */
  lowBalanceThresholdEth?: number;
  /** Whether to enable the monitor. Default: true */
  enabled?: boolean;
}

export interface BalanceMonitorDeps {
  logger: Logger;
  /** Returns active providers per chain */
  getProviders: () => Map<string, ethers.JsonRpcProvider>;
  /** Returns active wallets per chain */
  getWallets: () => Map<string, ethers.Wallet>;
  config?: BalanceMonitorConfig;
}

// =============================================================================
// Balance Monitor
// =============================================================================

export class BalanceMonitor {
  private readonly logger: Logger;
  private readonly getProviders: () => Map<string, ethers.JsonRpcProvider>;
  private readonly getWallets: () => Map<string, ethers.Wallet>;
  private readonly checkIntervalMs: number;
  private readonly lowBalanceThresholdEth: number;
  private readonly enabled: boolean;

  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly balances = new Map<string, ChainBalance>();
  /** Previous balances for drift detection */
  private readonly previousBalances = new Map<string, string>();

  constructor(deps: BalanceMonitorDeps) {
    this.logger = deps.logger;
    this.getProviders = deps.getProviders;
    this.getWallets = deps.getWallets;
    this.checkIntervalMs = deps.config?.checkIntervalMs ?? 60000;
    this.lowBalanceThresholdEth = deps.config?.lowBalanceThresholdEth ?? 0.01;
    this.enabled = deps.config?.enabled ?? true;
  }

  /**
   * Start periodic balance monitoring.
   * Runs an initial check immediately, then repeats at configured interval.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      this.logger.info('Balance monitor disabled');
      return;
    }

    this.logger.info('Starting per-chain balance monitor', {
      checkIntervalMs: this.checkIntervalMs,
      lowBalanceThresholdEth: this.lowBalanceThresholdEth,
    });

    // Initial check
    await this.checkAllBalances();

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.checkAllBalances().catch((error) => {
        this.logger.error('Balance check cycle failed', {
          error: getErrorMessage(error),
        });
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop the balance monitor and clean up intervals.
   */
  stop(): void {
    clearIntervalSafe(this.checkInterval);
    this.checkInterval = null;
    this.logger.info('Balance monitor stopped');
  }

  /**
   * Check balances across all configured chains.
   */
  async checkAllBalances(): Promise<void> {
    const providers = this.getProviders();
    const wallets = this.getWallets();

    // Query all chain balances in parallel
    const checks = Array.from(wallets.entries()).map(async ([chain, wallet]) => {
      const provider = providers.get(chain);
      if (!provider) {
        this.balances.set(chain, {
          chain,
          address: 'unknown',
          balanceEth: '0',
          balanceWei: '0',
          lastCheckedAt: Date.now(),
          healthy: false,
          error: 'No provider available',
        });
        return;
      }

      try {
        const address = await wallet.getAddress();
        const balance = await provider.getBalance(address);
        const balanceEth = ethers.formatEther(balance);

        const entry: ChainBalance = {
          chain,
          address,
          balanceEth,
          balanceWei: balance.toString(),
          lastCheckedAt: Date.now(),
          healthy: true,
        };

        this.balances.set(chain, entry);

        // Check for low balance
        const balanceFloat = parseFloat(balanceEth);
        if (balanceFloat < this.lowBalanceThresholdEth) {
          this.logger.warn('Low native token balance detected', {
            chain,
            address,
            balanceEth,
            threshold: this.lowBalanceThresholdEth,
          });
        }

        // Check for drift from previous balance
        const previousWei = this.previousBalances.get(chain);
        if (previousWei !== undefined && previousWei !== balance.toString()) {
          const prevEth = ethers.formatEther(BigInt(previousWei));
          const diff = balance - BigInt(previousWei);
          const diffEth = ethers.formatEther(diff < 0n ? -diff : diff);
          const direction = diff >= 0n ? 'increased' : 'decreased';

          this.logger.info('Balance change detected', {
            chain,
            address,
            previousBalanceEth: prevEth,
            currentBalanceEth: balanceEth,
            changeEth: `${direction} by ${diffEth}`,
          });
        }

        // Store for next comparison
        this.previousBalances.set(chain, balance.toString());

      } catch (error) {
        this.balances.set(chain, {
          chain,
          address: 'unknown',
          balanceEth: '0',
          balanceWei: '0',
          lastCheckedAt: Date.now(),
          healthy: false,
          error: getErrorMessage(error),
        });

        this.logger.warn('Failed to query balance', {
          chain,
          error: getErrorMessage(error),
        });
      }
    });

    await Promise.allSettled(checks);
  }

  /**
   * Get current balance snapshot for all monitored chains.
   * Used by health endpoints.
   */
  getSnapshot(): BalanceSnapshot {
    let healthyCount = 0;
    let failedCount = 0;

    for (const entry of this.balances.values()) {
      if (entry.healthy) {
        healthyCount++;
      } else {
        failedCount++;
      }
    }

    return {
      balances: new Map(this.balances),
      timestamp: Date.now(),
      healthyCount,
      failedCount,
    };
  }

  /**
   * Get balance for a specific chain.
   */
  getChainBalance(chain: string): ChainBalance | undefined {
    return this.balances.get(chain);
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createBalanceMonitor(deps: BalanceMonitorDeps): BalanceMonitor {
  return new BalanceMonitor(deps);
}
