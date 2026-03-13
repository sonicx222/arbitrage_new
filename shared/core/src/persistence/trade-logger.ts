/**
 * Persistent Trade Logger - Append-only JSONL with daily rotation.
 *
 * Logs trade execution results to disk for audit, analysis, and debugging.
 * Each log file contains one JSON object per line (JSONL format), rotated daily.
 *
 * Features:
 * - Append-only JSONL format (one JSON object per line)
 * - Daily file rotation (trades-YYYY-MM-DD.jsonl)
 * - Configurable output directory (default: ./data/trades/)
 * - Non-blocking async writes
 * - Graceful error handling (logs warning, never crashes execution engine)
 * - Constructor DI pattern with ServiceLogger for testability
 *
 * @custom:version 1.0.0
 * @see services/execution-engine/src/engine.ts - Primary consumer
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { ServiceLogger } from '../logging/types';
import type { ExecutionResult } from '@arbitrage/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import { getErrorMessage } from '../resilience/error-handling';
import { LogFileManager } from './log-file-manager';
// =============================================================================
// Types
// =============================================================================

/**
 * A single trade log entry written to the JSONL file.
 *
 * Combines fields from ExecutionResult and optional ArbitrageOpportunity
 * to create a self-contained audit record.
 */
export interface TradeLogEntry {
  /** Unix timestamp (ms) when the trade was logged */
  timestamp: number;
  /** Unique identifier for the opportunity */
  opportunityId: string;
  /** Arbitrage type (e.g., 'simple', 'triangular', 'cross-chain') */
  type?: string;
  /** Chain where the buy side executed */
  chain: string;
  /** DEX where the buy side executed */
  dex: string;
  /** Input token address */
  tokenIn?: string;
  /** Output token address */
  tokenOut?: string;
  /** Input amount as wei string */
  amountIn?: string;
  /** Expected profit from detection (pre-execution) */
  expectedProfit?: number;
  /** Actual profit realized from execution */
  actualProfit?: number;
  /** Gas units consumed */
  gasUsed?: number;
  /** Gas cost in native token units */
  gasCost?: number;
  /** On-chain transaction hash */
  transactionHash?: string;
  /** Whether the execution succeeded */
  success: boolean;
  /** Error message if execution failed */
  error?: string;
  /** Execution latency in milliseconds */
  latencyMs?: number;
  /** Whether MEV protection was used */
  usedMevProtection?: boolean;
  /** OpenTelemetry trace ID for cross-service correlation */
  traceId?: string;
  /** Swap route/path (e.g., token addresses in order) */
  route?: string[];
  /** Slippage tolerance used (decimal, e.g., 0.05 = 5%) */
  slippage?: number;
  /** Number of retry attempts before success/failure */
  retryCount?: number;
  /** Block number at which the opportunity was detected or executed */
  blockNumber?: number;
  /** Chain where the sell side executed (for cross-chain) */
  sellChain?: string;
  /** DEX where the sell side executed (for cross-chain) */
  sellDex?: string;
  /** P2 Fix O-6: Gas price in gwei (derived from gasCost/gasUsed) for gas economics reconstruction */
  gasPriceGwei?: number;
  /** P2 Fix O-6: Detection timestamp from pipeline for detection-to-execution latency measurement */
  detectionTimestamp?: number;
  /** P3-26: Flash loan provider used (e.g., 'aave-v3', 'balancer', 'syncswap') for provider-specific failure analysis */
  flashLoanProvider?: string;
  /** P3-26: Whether V3 adapter was used for swap routing */
  usedV3Adapter?: boolean;
}

/**
 * Configuration for the trade logger.
 */
export interface TradeLoggerConfig {
  /** Directory where trade log files are written (default: ./data/trades/) */
  outputDir: string;
  /** Whether trade logging is enabled (default: true) */
  enabled: boolean;
  /** Compress .jsonl files older than this many days (default: 3) */
  compressAfterDays: number;
  /** Delete all log files older than this many days (default: 14) */
  retentionDays: number;
  /** Compress oldest files when total size exceeds this (MB, 0=disabled, default: 100) */
  maxTotalSizeMB: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: TradeLoggerConfig = {
  outputDir: './data/trades',
  enabled: true,
  compressAfterDays: 3,
  retentionDays: 14,
  maxTotalSizeMB: 100,
};

// =============================================================================
// TradeLogger Class
// =============================================================================

/**
 * Persistent trade logger that writes execution results to daily JSONL files.
 *
 * Usage:
 * ```typescript
 * const logger = new TradeLogger({ outputDir: './data/trades', enabled: true }, appLogger);
 * await logger.logTrade(executionResult, opportunity);
 * await logger.close();
 * ```
 *
 * @see ExecutionResult - The primary data source (from execution engine)
 * @see ArbitrageOpportunity - Optional enrichment data (from detection)
 */
export class TradeLogger {
  private readonly config: TradeLoggerConfig;
  private readonly logger: ServiceLogger;
  private readonly fileManager: LogFileManager;
  private dirEnsured = false;
  // P3-009 FIX: Track write success/failure for health check observability.
  // Piggybacks on actual logTrade() calls — no periodic disk probes needed.
  private _writeSuccessCount = 0;
  private _writeFailureCount = 0;
  private _lastWriteError: string | null = null;
  private _lastSuccessfulWriteMs = 0;

  constructor(config: Partial<TradeLoggerConfig> = {}, logger: ServiceLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    this.fileManager = new LogFileManager({
      dir: this.config.outputDir,
      filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
      compressAfterDays: this.config.compressAfterDays,
      retentionDays: this.config.retentionDays,
      maxTotalSizeMB: this.config.maxTotalSizeMB,
      logger,
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Log a trade execution result to the current day's JSONL file.
   *
   * Combines data from the ExecutionResult (always available) with optional
   * ArbitrageOpportunity context (enrichment from detection phase).
   *
   * This method never throws -- write errors are logged as warnings.
   *
   * @param result - The execution result from the engine
   * @param opportunity - Optional opportunity context for enrichment
   */
  async logTrade(result: ExecutionResult, opportunity?: ArbitrageOpportunity): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const entry = this.buildEntry(result, opportunity);
      const filePath = this.getLogPath();

      // Ensure the output directory exists (once per process)
      if (!this.dirEnsured) {
        await fsp.mkdir(this.config.outputDir, { recursive: true });
        this.dirEnsured = true;
      }

      const line = JSON.stringify(entry) + '\n';
      await fsp.appendFile(filePath, line, 'utf8');
      this._writeSuccessCount++;
      this._lastSuccessfulWriteMs = Date.now();
    } catch (error) {
      this._writeFailureCount++;
      this._lastWriteError = getErrorMessage(error);
      // Never crash the execution engine due to logging failures
      this.logger.warn('Failed to write trade log entry', {
        opportunityId: result.opportunityId,
        error: this._lastWriteError,
      });
    }
  }

  /**
   * Get the log file path for a given date.
   *
   * File naming convention: trades-YYYY-MM-DD.jsonl
   *
   * @param date - The date for the log file (defaults to current date)
   * @returns Absolute path to the log file
   */
  getLogPath(date?: Date): string {
    const d = date ?? new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const filename = `trades-${yyyy}-${mm}-${dd}.jsonl`;
    return path.join(this.config.outputDir, filename);
  }

  /**
   * Close the trade logger.
   *
   * Currently a no-op since we use appendFile (no persistent file handle),
   * but provided for interface completeness and future extensibility.
   */
  async close(): Promise<void> {
    this.stopMaintenance();
    this.dirEnsured = false;
    this.logger.debug('Trade logger closed');
  }

  /**
   * Whether the trade logger is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * P3-009 FIX: Get disk write health status for inclusion in health checks.
   * Returns counters and last error — callers can use writeFailureCount > 0
   * with lastSuccessfulWriteMs to detect disk-full or permission issues.
   */
  getWriteHealth(): {
    writeSuccessCount: number;
    writeFailureCount: number;
    lastWriteError: string | null;
    lastSuccessfulWriteMs: number;
  } {
    return {
      writeSuccessCount: this._writeSuccessCount,
      writeFailureCount: this._writeFailureCount,
      lastWriteError: this._lastWriteError,
      lastSuccessfulWriteMs: this._lastSuccessfulWriteMs,
    };
  }

  /**
   * Validate that the trade log directory is writable.
   *
   * Performs a write+read+delete cycle to verify the output directory is
   * accessible. Should be called during service startup to fail fast
   * rather than silently losing trade data in production.
   *
   * @throws Error if the directory is not writable
   */
  async validateLogDir(): Promise<void> {
    if (!this.config.enabled) return;

    const testFile = path.join(this.config.outputDir, '.write-test');
    try {
      await fsp.mkdir(this.config.outputDir, { recursive: true });
      await fsp.writeFile(testFile, 'ok', 'utf8');
      const content = await fsp.readFile(testFile, 'utf8');
      if (content !== 'ok') {
        throw new Error('Read-back verification failed');
      }
      try {
        await fsp.unlink(testFile);
      } catch (unlinkErr) {
        // Ignore ENOENT — file may have been cleaned up by OS security tools
        // (e.g. Windows Defender) between writeFile and unlink.
        // We already verified the write succeeded via readFile, so the dir IS writable.
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
      this.dirEnsured = true;
      this.logger.info('Trade log directory validated', { outputDir: this.config.outputDir });
    } catch (error) {
      const msg = `Trade log directory not writable: ${this.config.outputDir} — ${getErrorMessage(error)}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }

  /**
   * Compress old trade log files (.jsonl -> .jsonl.gz) to reclaim disk space.
   * Delegates to LogFileManager.compressOldFiles().
   *
   * @returns Number of files compressed
   */
  async compressOldLogs(): Promise<number> {
    if (!this.config.enabled) return 0;
    return this.fileManager.compressOldFiles();
  }

  /**
   * Purge expired trade log files (older than retentionDays).
   * Delegates to LogFileManager.purgeExpiredFiles().
   */
  async purgeExpiredLogs(): Promise<{ purged: number; freedBytes: number }> {
    if (!this.config.enabled) return { purged: 0, freedBytes: 0 };
    return this.fileManager.purgeExpiredFiles();
  }

  /**
   * Start periodic background maintenance (purge + compress cycle).
   * Timer is unref'd so it doesn't prevent process exit.
   */
  startMaintenance(intervalMs?: number): void {
    if (!this.config.enabled) return;
    this.fileManager.startPeriodicMaintenance(intervalMs);
  }

  /**
   * Stop periodic maintenance. Safe to call even if not started.
   */
  stopMaintenance(): void {
    this.fileManager.stopPeriodicMaintenance();
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Build a TradeLogEntry by merging ExecutionResult fields with optional
   * ArbitrageOpportunity enrichment.
   */
  private buildEntry(result: ExecutionResult, opportunity?: ArbitrageOpportunity): TradeLogEntry {
    // Extract traceId from opportunity metadata if available (set by trace context propagation)
    const traceId = (opportunity as unknown as Record<string, unknown> | undefined)?._traceId as string | undefined;

    // P1-8: Calculate effective slippage from expected vs actual profit.
    // This gives the realized slippage which is what matters for post-mortem analysis.
    // @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P1-8
    const expectedProfit = opportunity?.expectedProfit;
    const slippage = (expectedProfit != null && expectedProfit > 0 && result.actualProfit != null)
      ? (expectedProfit - result.actualProfit) / expectedProfit
      : undefined;

    // P1-8: Extract retry/delivery count from opportunity metadata if present.
    // Consumer layer sets _deliveryCount on redelivered messages from PEL.
    const retryCount = (opportunity as unknown as Record<string, unknown> | undefined)?._deliveryCount as number | undefined;

    // P2 Fix O-6: Derive gas price in gwei from gasCost (native units) and gasUsed
    const gasPriceGwei = (result.gasCost != null && result.gasUsed != null && result.gasUsed > 0)
      ? (result.gasCost / result.gasUsed) * 1e9
      : undefined;

    // P2 Fix O-6: Extract detection timestamp for detection-to-execution latency
    const detectionTimestamp = opportunity?.pipelineTimestamps?.detectedAt;

    return {
      timestamp: result.timestamp ?? Date.now(),
      opportunityId: result.opportunityId,
      type: opportunity?.type,
      chain: result.chain,
      dex: result.dex,
      tokenIn: opportunity?.tokenIn,
      tokenOut: opportunity?.tokenOut,
      amountIn: opportunity?.amountIn,
      expectedProfit,
      actualProfit: result.actualProfit,
      gasUsed: result.gasUsed,
      gasCost: result.gasCost,
      transactionHash: result.transactionHash,
      success: result.success,
      error: result.error,
      latencyMs: result.latencyMs,
      usedMevProtection: result.usedMevProtection,
      traceId,
      route: opportunity?.path,
      slippage,
      retryCount,
      blockNumber: opportunity?.blockNumber,
      sellChain: opportunity?.sellChain,
      sellDex: opportunity?.sellDex,
      gasPriceGwei,
      detectionTimestamp,
    };
  }
}
