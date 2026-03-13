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

  // ===========================================================================
  // Compress (age-based)
  // ===========================================================================

  /**
   * Compress .jsonl files older than compressAfterDays to .jsonl.gz.
   * If a .gz already exists for a .jsonl file, deletes the stale .jsonl.
   * Skips files whose date >= cutoff (including today's file).
   */
  async compressOldFiles(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.compressAfterDays);
    cutoff.setHours(23, 59, 59, 999);

    let compressed = 0;
    const todayStr = new Date().toISOString().slice(0, 10);

    let files: string[];
    try {
      files = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    for (const file of files) {
      // Only process uncompressed files matching the pattern
      if (file.endsWith('.gz')) continue;
      const match = file.match(this.filePattern);
      if (!match) continue;

      const dateStr = match[1];
      // Never compress today's file — it's actively being written
      if (dateStr === todayStr) continue;
      const fileDate = new Date(dateStr + 'T00:00:00');
      if (isNaN(fileDate.getTime()) || fileDate >= cutoff) continue;

      const srcPath = path.join(this.dir, file);
      const gzPath = srcPath + '.gz';

      try {
        // If .gz already exists, just delete the stale original
        try {
          await fsp.access(gzPath);
          await fsp.unlink(srcPath);
          compressed++;
          continue;
        } catch {
          // .gz doesn't exist — proceed to compress
        }

        await pipeline(
          fs.createReadStream(srcPath),
          createGzip({ level: 6 }),
          fs.createWriteStream(gzPath),
        );
        await fsp.unlink(srcPath);
        compressed++;
      } catch (err) {
        this.logger.warn('Failed to compress log file', {
          file,
          error: getErrorMessage(err),
        });
        // Clean up partial .gz on failure
        try { await fsp.unlink(gzPath); } catch { /* ignore */ }
      }
    }

    if (compressed > 0) {
      this.logger.info('Compressed old log files', {
        dir: this.dir,
        compressed,
        cutoffDate: cutoff.toISOString().split('T')[0],
      });
    }

    return compressed;
  }

  // ===========================================================================
  // Compress (size-based)
  // ===========================================================================

  /**
   * Compress oldest uncompressed .jsonl files when total directory size
   * exceeds maxTotalSizeMB. Skips today's file (it's actively written).
   */
  async compressIfOversized(): Promise<number> {
    if (this.maxTotalSizeMB <= 0) return 0;

    const thresholdBytes = this.maxTotalSizeMB * 1024 * 1024;

    let files: string[];
    try {
      files = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    // Calculate total size
    let totalSize = 0;
    const uncompressedFiles: { file: string; date: string; size: number }[] = [];
    const todayStr = new Date().toISOString().slice(0, 10);

    for (const file of files) {
      const filePath = path.join(this.dir, file);
      try {
        const stat = await fsp.stat(filePath);
        totalSize += stat.size;

        // Collect uncompressed candidates (not today's file, not .gz)
        if (!file.endsWith('.gz')) {
          const match = file.match(this.filePattern);
          if (match && match[1] !== todayStr) {
            uncompressedFiles.push({ file, date: match[1], size: stat.size });
          }
        }
      } catch {
        // Skip files we can't stat
      }
    }

    if (totalSize <= thresholdBytes) return 0;

    // Sort by date ascending (oldest first)
    uncompressedFiles.sort((a, b) => a.date.localeCompare(b.date));

    let compressed = 0;
    for (const { file } of uncompressedFiles) {
      if (totalSize <= thresholdBytes) break;

      const srcPath = path.join(this.dir, file);
      const gzPath = srcPath + '.gz';

      try {
        const srcStat = await fsp.stat(srcPath);
        await pipeline(
          fs.createReadStream(srcPath),
          createGzip({ level: 6 }),
          fs.createWriteStream(gzPath),
        );
        const gzStat = await fsp.stat(gzPath);
        await fsp.unlink(srcPath);
        totalSize -= (srcStat.size - gzStat.size);
        compressed++;
      } catch (err) {
        this.logger.warn('Failed to size-compress log file', {
          file,
          error: getErrorMessage(err),
        });
        try { await fsp.unlink(gzPath); } catch { /* ignore */ }
      }
    }

    if (compressed > 0) {
      this.logger.info('Size-triggered log compression', {
        dir: this.dir,
        compressed,
        thresholdMB: this.maxTotalSizeMB,
        remainingSizeBytes: totalSize,
      });
    }

    return compressed;
  }

  // ===========================================================================
  // Stats
  // ===========================================================================

  /**
   * Get directory statistics for health checks and monitoring.
   */
  async getStats(): Promise<DirectoryStats> {
    const result: DirectoryStats = {
      totalSizeBytes: 0,
      fileCount: 0,
      oldestFileDate: null,
      newestFileDate: null,
      compressedCount: 0,
      uncompressedCount: 0,
    };

    let files: string[];
    try {
      files = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw err;
    }

    for (const file of files) {
      const baseName = file.endsWith('.gz') ? file.slice(0, -3) : file;
      const match = baseName.match(this.filePattern);
      if (!match) continue;

      const dateStr = match[1];
      const filePath = path.join(this.dir, file);

      try {
        const stat = await fsp.stat(filePath);
        result.totalSizeBytes += stat.size;
        result.fileCount++;

        if (file.endsWith('.gz')) {
          result.compressedCount++;
        } else {
          result.uncompressedCount++;
        }

        if (!result.oldestFileDate || dateStr < result.oldestFileDate) {
          result.oldestFileDate = dateStr;
        }
        if (!result.newestFileDate || dateStr > result.newestFileDate) {
          result.newestFileDate = dateStr;
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return result;
  }

  // ===========================================================================
  // Maintenance (combined)
  // ===========================================================================

  /**
   * Run full maintenance cycle: purge -> age-compress -> size-compress.
   * Purge runs first to free the most space before compression decisions.
   */
  async runMaintenance(): Promise<MaintenanceResult> {
    const { purged } = await this.purgeExpiredFiles();
    const compressed = await this.compressOldFiles();
    const sizeCompressed = await this.compressIfOversized();
    const stats = await this.getStats();

    return {
      purged,
      compressed,
      sizeCompressed,
      totalSizeBytes: stats.totalSizeBytes,
    };
  }

  // ===========================================================================
  // Periodic Scheduling
  // ===========================================================================

  /**
   * Start periodic background maintenance.
   * Timer is unref'd so it doesn't prevent process exit.
   * Safe to call multiple times (stops existing timer first).
   */
  startPeriodicMaintenance(intervalMs: number = DEFAULT_MAINTENANCE_INTERVAL_MS): void {
    this.stopPeriodicMaintenance();

    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance().catch((err) => {
        this.logger.warn('Periodic log maintenance failed', {
          dir: this.dir,
          error: getErrorMessage(err),
        });
      });
    }, intervalMs);

    // Unref so the timer doesn't prevent process exit
    if (this.maintenanceTimer && typeof this.maintenanceTimer === 'object' && 'unref' in this.maintenanceTimer) {
      this.maintenanceTimer.unref();
    }
  }

  /**
   * Stop periodic maintenance. Safe to call even if not started.
   */
  stopPeriodicMaintenance(): void {
    if (this.maintenanceTimer !== null) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }
}
