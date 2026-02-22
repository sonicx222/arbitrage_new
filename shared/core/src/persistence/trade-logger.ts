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
  /** Execution strategy used (e.g., 'intra-chain', 'flash-loan', 'cross-chain') */
  strategyUsed?: string;
  /** Number of retry attempts before success/failure */
  retryCount?: number;
  /** Block number at which the opportunity was detected or executed */
  blockNumber?: number;
  /** Chain where the sell side executed (for cross-chain) */
  sellChain?: string;
  /** DEX where the sell side executed (for cross-chain) */
  sellDex?: string;
}

/**
 * Configuration for the trade logger.
 */
export interface TradeLoggerConfig {
  /** Directory where trade log files are written (default: ./data/trades/) */
  outputDir: string;
  /** Whether trade logging is enabled (default: true) */
  enabled: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CONFIG: TradeLoggerConfig = {
  outputDir: './data/trades',
  enabled: true,
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
  private dirEnsured = false;

  constructor(config: Partial<TradeLoggerConfig> = {}, logger: ServiceLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
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
    } catch (error) {
      // Never crash the execution engine due to logging failures
      this.logger.warn('Failed to write trade log entry', {
        opportunityId: result.opportunityId,
        error: error instanceof Error ? error.message : String(error),
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
      await fsp.unlink(testFile);
      this.dirEnsured = true;
      this.logger.info('Trade log directory validated', { outputDir: this.config.outputDir });
    } catch (error) {
      const msg = `Trade log directory not writable: ${this.config.outputDir} — ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
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

    return {
      timestamp: result.timestamp ?? Date.now(),
      opportunityId: result.opportunityId,
      type: opportunity?.type,
      chain: result.chain,
      dex: result.dex,
      tokenIn: opportunity?.tokenIn,
      tokenOut: opportunity?.tokenOut,
      amountIn: opportunity?.amountIn,
      expectedProfit: opportunity?.expectedProfit,
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
      slippage: undefined, // Populated by caller if available
      strategyUsed: opportunity?.type,
      retryCount: undefined, // Populated by caller if available
      blockNumber: opportunity?.blockNumber,
      sellChain: opportunity?.sellChain,
      sellDex: opportunity?.sellDex,
    };
  }
}
