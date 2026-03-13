/**
 * Log File Lifecycle Manager
 *
 * Manages the lifecycle of date-stamped JSONL log files:
 * - Compress files older than `compressAfterDays` (.jsonl -> .jsonl.gz)
 * - Purge files (compressed + uncompressed) older than `retentionDays`
 * - Compress oldest uncompressed files when total dir size > `maxTotalSizeMB`
 * - Periodic background maintenance via unref'd setInterval
 *
 * Works with any date-stamped JSONL files (trades, DLQ, lost-opportunities).
 * The `filePattern` regex must have a capture group for the YYYY-MM-DD date.
 *
 * @see trade-logger.ts - Primary consumer (trade log files)
 * @see services/execution-engine/src/engine.ts - Wiring point
 */

import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import type { ServiceLogger } from '../logging/types';
import { getErrorMessage } from '../resilience/error-handling';

// =============================================================================
// Types
// =============================================================================

export interface LogFileManagerConfig {
  /** Directory containing the log files */
  dir: string;
  /** Regex matching log filenames. Must capture YYYY-MM-DD date in group 1. */
  filePattern: RegExp;
  /** Compress .jsonl files older than this many days (default: 1) */
  compressAfterDays?: number;
  /** Delete all files older than this many days (default: 14) */
  retentionDays?: number;
  /** Compress oldest files when total dir size exceeds this (MB). 0 = disabled. (default: 100) */
  maxTotalSizeMB?: number;
  /** Logger for status messages */
  logger: ServiceLogger;
}

export interface MaintenanceResult {
  purged: number;
  compressed: number;
  sizeCompressed: number;
  totalSizeBytes: number;
}

export interface DirectoryStats {
  totalSizeBytes: number;
  fileCount: number;
  oldestFileDate: string | null;
  newestFileDate: string | null;
  compressedCount: number;
  uncompressedCount: number;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_COMPRESS_AFTER_DAYS = 1;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_TOTAL_SIZE_MB = 100;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// =============================================================================
// LogFileManager
// =============================================================================

export class LogFileManager {
  private readonly dir: string;
  private readonly filePattern: RegExp;
  private readonly compressAfterDays: number;
  private readonly retentionDays: number;
  private readonly maxTotalSizeMB: number;
  private readonly logger: ServiceLogger;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: LogFileManagerConfig) {
    this.dir = config.dir;
    this.filePattern = config.filePattern;
    this.compressAfterDays = config.compressAfterDays ?? DEFAULT_COMPRESS_AFTER_DAYS;
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxTotalSizeMB = config.maxTotalSizeMB ?? DEFAULT_MAX_TOTAL_SIZE_MB;
    this.logger = config.logger;
  }

  // ===========================================================================
  // Purge
  // ===========================================================================

  /**
   * Delete .jsonl and .jsonl.gz files older than retentionDays.
   */
  async purgeExpiredFiles(): Promise<{ purged: number; freedBytes: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    cutoff.setHours(0, 0, 0, 0);

    let purged = 0;
    let freedBytes = 0;

    let files: string[];
    try {
      files = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { purged, freedBytes };
      throw err;
    }

    for (const file of files) {
      // Match both .jsonl and .jsonl.gz variants
      const baseName = file.endsWith('.gz') ? file.slice(0, -3) : file;
      const match = baseName.match(this.filePattern);
      if (!match) continue;

      const dateStr = match[1];
      const fileDate = new Date(dateStr + 'T00:00:00');
      if (isNaN(fileDate.getTime()) || fileDate >= cutoff) continue;

      const filePath = path.join(this.dir, file);
      try {
        const stat = await fsp.stat(filePath);
        await fsp.unlink(filePath);
        freedBytes += stat.size;
        purged++;
      } catch (err) {
        this.logger.warn('Failed to purge expired log file', {
          file,
          error: getErrorMessage(err),
        });
      }
    }

    if (purged > 0) {
      this.logger.info('Purged expired log files', {
        dir: this.dir,
        purged,
        freedBytes,
        cutoffDate: cutoff.toISOString().split('T')[0],
      });
    }

    return { purged, freedBytes };
  }
}
