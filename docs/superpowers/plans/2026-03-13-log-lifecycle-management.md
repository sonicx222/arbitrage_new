# Log Lifecycle Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement unified log file lifecycle management with 14-day retention, size-triggered compression (100 MB threshold), periodic maintenance, and R2 upload resilience across all 4 JSONL file producers.

**Architecture:** Extract a shared `LogFileManager` class in `shared/core/src/persistence/` that handles compress, purge, and size-monitoring for any directory of date-stamped JSONL files. `TradeLogger` delegates its existing `compressOldLogs()` to `LogFileManager` and gains retention + periodic scheduling. `R2Uploader` gets `.jsonl.gz` fallback to fix the compression-upload race condition. The lost-opportunity writer gets a size cap.

**Tech Stack:** Node.js `fs/promises`, `zlib.createGzip`, `stream/promises.pipeline`, Pino (ServiceLogger DI), Jest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `shared/core/src/persistence/log-file-manager.ts` | **Create** | Shared lifecycle: compress, purge, size-trigger, periodic timer, stats |
| `shared/core/__tests__/unit/persistence/log-file-manager.test.ts` | **Create** | Full test coverage for LogFileManager |
| `shared/core/src/persistence/trade-logger.ts` | **Modify** | Add `retentionDays`/`maxTotalSizeMB` config, delegate lifecycle to LogFileManager, add `startMaintenance()`/`stopMaintenance()` |
| `shared/core/__tests__/unit/persistence/trade-logger.test.ts` | **Modify** | Add compression + purge + maintenance tests |
| `shared/core/src/persistence/r2-uploader.ts` | **Modify** | `.jsonl.gz` fallback in `uploadPreviousDayLogs()` + `uploadDayLogs()` |
| `shared/core/__tests__/unit/persistence/r2-uploader.test.ts` | **Modify** | Test `.gz` fallback behavior |
| `shared/core/src/publishers/opportunity-publisher.ts` | **Modify** | Add 100 MB file size cap to `writeToLocalFallback()` |
| `shared/core/src/index.ts` | **Modify** | Export `LogFileManager` + new types |
| `shared/test-utils/src/mocks/core.mock.ts` | **Modify** | Add `startMaintenance`/`stopMaintenance` to TradeLogger mock, add LogFileManager mock |
| `services/execution-engine/src/engine.ts` | **Modify** | Pass new config from env vars, call `startMaintenance()`/`stopMaintenance()` |

---

## Chunk 1: LogFileManager Core

### Task 1: Create LogFileManager — types and purgeExpiredFiles()

**Files:**
- Create: `shared/core/src/persistence/log-file-manager.ts`
- Create: `shared/core/__tests__/unit/persistence/log-file-manager.test.ts`

- [ ] **Step 1: Write failing tests for purgeExpiredFiles()**

```typescript
// shared/core/__tests__/unit/persistence/log-file-manager.test.ts
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LogFileManager } from '../../../src/persistence/log-file-manager';
import type { LogFileManagerConfig } from '../../../src/persistence/log-file-manager';
import { RecordingLogger } from '../../../src/logging/testing-logger';

function makeDateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function createFile(dir: string, name: string, content = 'test'): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), content, 'utf8');
}

describe('LogFileManager', () => {
  let testDir: string;
  let logger: RecordingLogger;

  beforeEach(async () => {
    logger = new RecordingLogger();
    testDir = path.join(os.tmpdir(), `lfm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try { await fsp.rm(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('purgeExpiredFiles()', () => {
    it('should delete .jsonl.gz files older than retentionDays', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        logger,
      });

      // Create a .gz file dated 20 days ago
      await createFile(testDir, `trades-${makeDateStr(20)}.jsonl.gz`, 'old-gz');
      // Create a .gz file dated 5 days ago (within retention)
      await createFile(testDir, `trades-${makeDateStr(5)}.jsonl.gz`, 'recent-gz');

      const result = await mgr.purgeExpiredFiles();

      expect(result.purged).toBe(1);
      const files = await fsp.readdir(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain(makeDateStr(5));
    });

    it('should also delete uncompressed .jsonl files older than retentionDays', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        logger,
      });

      await createFile(testDir, `trades-${makeDateStr(16)}.jsonl`, 'stale-raw');

      const result = await mgr.purgeExpiredFiles();
      expect(result.purged).toBe(1);
      expect(await fsp.readdir(testDir)).toHaveLength(0);
    });

    it('should not delete files within retention period', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        logger,
      });

      await createFile(testDir, `trades-${makeDateStr(10)}.jsonl`, 'recent');
      await createFile(testDir, `trades-${makeDateStr(3)}.jsonl.gz`, 'recent-gz');

      const result = await mgr.purgeExpiredFiles();
      expect(result.purged).toBe(0);
      expect(await fsp.readdir(testDir)).toHaveLength(2);
    });

    it('should handle empty directory gracefully', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        logger,
      });

      const result = await mgr.purgeExpiredFiles();
      expect(result.purged).toBe(0);
    });

    it('should handle non-existent directory gracefully', async () => {
      const mgr = new LogFileManager({
        dir: path.join(testDir, 'nonexistent'),
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        logger,
      });

      const result = await mgr.purgeExpiredFiles();
      expect(result.purged).toBe(0);
    });

    it('should ignore files not matching the pattern', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        logger,
      });

      await createFile(testDir, 'random-file.txt', 'ignore-me');
      await createFile(testDir, `dlq-${makeDateStr(20)}.jsonl`, 'wrong-prefix');

      const result = await mgr.purgeExpiredFiles();
      expect(result.purged).toBe(0);
      expect(await fsp.readdir(testDir)).toHaveLength(2);
    });

    it('should work with dlq-fallback file patterns', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^dlq-fallback-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        logger,
      });

      await createFile(testDir, `dlq-fallback-${makeDateStr(20)}.jsonl`, 'old-dlq');
      await createFile(testDir, `dlq-fallback-${makeDateStr(5)}.jsonl`, 'recent-dlq');

      const result = await mgr.purgeExpiredFiles();
      expect(result.purged).toBe(1);
      expect(await fsp.readdir(testDir)).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: FAIL — `Cannot find module '../../../src/persistence/log-file-manager'`

- [ ] **Step 3: Implement LogFileManager types + purgeExpiredFiles()**

```typescript
// shared/core/src/persistence/log-file-manager.ts
/**
 * Log File Lifecycle Manager
 *
 * Manages the lifecycle of date-stamped JSONL log files:
 * - Compress files older than `compressAfterDays` (.jsonl → .jsonl.gz)
 * - Purge files (compressed + uncompressed) older than `retentionDays`
 * - Compress oldest uncompressed files when total dir size > `maxTotalSizeMB`
 * - Periodic background maintenance via unref'd setInterval
 *
 * Works with any date-stamped JSONL files (trades, DLQ, lost-opportunities).
 * The `filePattern` regex must have a capture group for the YYYY-MM-DD date.
 *
 * @see trade-logger.ts — Primary consumer (trade log files)
 * @see services/execution-engine/src/engine.ts — Wiring point
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: All 7 purge tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/core/src/persistence/log-file-manager.ts shared/core/__tests__/unit/persistence/log-file-manager.test.ts
git commit -m "$(cat <<'EOF'
feat: add LogFileManager with purgeExpiredFiles() for log retention

Introduces a shared log file lifecycle manager that handles
date-stamped JSONL files (trades, DLQ, lost-opportunities).
First capability: purge files older than configurable retention
period (default 14 days). Supports both .jsonl and .jsonl.gz files.
EOF
)"
```

---

### Task 2: Add compressOldFiles() to LogFileManager

**Files:**
- Modify: `shared/core/src/persistence/log-file-manager.ts`
- Modify: `shared/core/__tests__/unit/persistence/log-file-manager.test.ts`

- [ ] **Step 1: Write failing tests for compressOldFiles()**

Add to the test file:

```typescript
  describe('compressOldFiles()', () => {
    it('should compress .jsonl files older than compressAfterDays', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        compressAfterDays: 1,
        logger,
      });

      const oldDate = makeDateStr(3);
      await createFile(testDir, `trades-${oldDate}.jsonl`, 'x'.repeat(1000));

      const compressed = await mgr.compressOldFiles();

      expect(compressed).toBe(1);
      const files = await fsp.readdir(testDir);
      expect(files).toEqual([`trades-${oldDate}.jsonl.gz`]);
    });

    it('should not compress today\'s file', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        compressAfterDays: 0,
        logger,
      });

      const today = makeDateStr(0);
      await createFile(testDir, `trades-${today}.jsonl`, 'today-data');

      const compressed = await mgr.compressOldFiles();

      // compressAfterDays=0 means today's file date >= cutoff (today), so skip
      expect(compressed).toBe(0);
      const files = await fsp.readdir(testDir);
      expect(files).toEqual([`trades-${today}.jsonl`]);
    });

    it('should delete stale .jsonl when .gz already exists', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        compressAfterDays: 1,
        logger,
      });

      const oldDate = makeDateStr(5);
      await createFile(testDir, `trades-${oldDate}.jsonl`, 'stale-original');
      await createFile(testDir, `trades-${oldDate}.jsonl.gz`, 'already-compressed');

      const compressed = await mgr.compressOldFiles();

      expect(compressed).toBe(1);
      const files = await fsp.readdir(testDir);
      // Only the .gz should remain
      expect(files).toEqual([`trades-${oldDate}.jsonl.gz`]);
    });

    it('should skip already-compressed files', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        compressAfterDays: 1,
        logger,
      });

      const oldDate = makeDateStr(5);
      await createFile(testDir, `trades-${oldDate}.jsonl.gz`, 'only-gz');

      const compressed = await mgr.compressOldFiles();
      // No .jsonl to compress
      expect(compressed).toBe(0);
    });

    it('should handle non-existent directory gracefully', async () => {
      const mgr = new LogFileManager({
        dir: path.join(testDir, 'nope'),
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        compressAfterDays: 1,
        logger,
      });

      const compressed = await mgr.compressOldFiles();
      expect(compressed).toBe(0);
    });

    it('should produce valid gzip output', async () => {
      const { createGunzip } = await import('zlib');
      const { pipeline: pipelinePromise } = await import('stream/promises');
      const { Writable } = await import('stream');

      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        compressAfterDays: 1,
        logger,
      });

      const oldDate = makeDateStr(3);
      const content = '{"line":1}\n{"line":2}\n';
      await createFile(testDir, `trades-${oldDate}.jsonl`, content);

      await mgr.compressOldFiles();

      // Decompress and verify
      const gzPath = path.join(testDir, `trades-${oldDate}.jsonl.gz`);
      const chunks: Buffer[] = [];
      await pipelinePromise(
        fs.createReadStream(gzPath),
        createGunzip(),
        new Writable({
          write(chunk, _enc, cb) { chunks.push(chunk as Buffer); cb(); },
        }),
      );
      expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
    });
  });
```

Note: add `import * as fs from 'fs';` to the test file imports.

- [ ] **Step 2: Run test to verify failures**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: FAIL — `mgr.compressOldFiles is not a function`

- [ ] **Step 3: Implement compressOldFiles()**

Add to `LogFileManager` class in `log-file-manager.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/core/src/persistence/log-file-manager.ts shared/core/__tests__/unit/persistence/log-file-manager.test.ts
git commit -m "$(cat <<'EOF'
feat: add compressOldFiles() to LogFileManager

Age-based gzip compression for .jsonl files older than
compressAfterDays. Handles stale-original dedup (deletes
.jsonl when .gz exists). Streaming compression via pipeline.
EOF
)"
```

---

### Task 3: Add compressIfOversized() + getStats() + runMaintenance()

**Files:**
- Modify: `shared/core/src/persistence/log-file-manager.ts`
- Modify: `shared/core/__tests__/unit/persistence/log-file-manager.test.ts`

- [ ] **Step 1: Write failing tests for size-based compression and maintenance**

Add to the test file:

```typescript
  describe('compressIfOversized()', () => {
    it('should compress oldest uncompressed files when total size exceeds threshold', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        maxTotalSizeMB: 0.001, // ~1KB threshold for testing
        compressAfterDays: 999, // Don't age-compress — isolate size trigger
        logger,
      });

      // Create files: older one should be compressed first
      const old = makeDateStr(5);
      const recent = makeDateStr(1);
      await createFile(testDir, `trades-${old}.jsonl`, 'x'.repeat(600));
      await createFile(testDir, `trades-${recent}.jsonl`, 'y'.repeat(600));

      const compressed = await mgr.compressIfOversized();

      expect(compressed).toBeGreaterThanOrEqual(1);
      const files = await fsp.readdir(testDir);
      // The oldest file should be compressed
      expect(files).toContain(`trades-${old}.jsonl.gz`);
    });

    it('should not compress when under threshold', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        maxTotalSizeMB: 100,
        logger,
      });

      await createFile(testDir, `trades-${makeDateStr(3)}.jsonl`, 'small');

      const compressed = await mgr.compressIfOversized();
      expect(compressed).toBe(0);
    });

    it('should not compress today\'s file even when oversized', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        maxTotalSizeMB: 0.0001, // tiny threshold
        logger,
      });

      const today = makeDateStr(0);
      await createFile(testDir, `trades-${today}.jsonl`, 'x'.repeat(1000));

      const compressed = await mgr.compressIfOversized();
      expect(compressed).toBe(0);
    });

    it('should be disabled when maxTotalSizeMB is 0', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        maxTotalSizeMB: 0,
        logger,
      });

      await createFile(testDir, `trades-${makeDateStr(3)}.jsonl`, 'x'.repeat(10000));

      const compressed = await mgr.compressIfOversized();
      expect(compressed).toBe(0);
    });
  });

  describe('getStats()', () => {
    it('should return correct directory stats', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        logger,
      });

      await createFile(testDir, `trades-${makeDateStr(10)}.jsonl.gz`, 'compressed');
      await createFile(testDir, `trades-${makeDateStr(3)}.jsonl`, 'uncompressed');
      await createFile(testDir, `trades-${makeDateStr(1)}.jsonl`, 'recent');

      const stats = await mgr.getStats();

      expect(stats.fileCount).toBe(3);
      expect(stats.compressedCount).toBe(1);
      expect(stats.uncompressedCount).toBe(2);
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
      expect(stats.oldestFileDate).toBe(makeDateStr(10));
      expect(stats.newestFileDate).toBe(makeDateStr(1));
    });

    it('should handle empty directory', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        logger,
      });

      const stats = await mgr.getStats();
      expect(stats.fileCount).toBe(0);
      expect(stats.oldestFileDate).toBeNull();
    });
  });

  describe('runMaintenance()', () => {
    it('should run purge then compress in order', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        compressAfterDays: 1,
        maxTotalSizeMB: 0, // disable size-based
        logger,
      });

      // Expired file (should be purged)
      await createFile(testDir, `trades-${makeDateStr(20)}.jsonl.gz`, 'expired');
      // Old file (should be compressed)
      await createFile(testDir, `trades-${makeDateStr(3)}.jsonl`, 'old-data');
      // Today's file (should be untouched)
      await createFile(testDir, `trades-${makeDateStr(0)}.jsonl`, 'today');

      const result = await mgr.runMaintenance();

      expect(result.purged).toBe(1);
      expect(result.compressed).toBe(1);
      const files = await fsp.readdir(testDir);
      expect(files).toHaveLength(2); // today.jsonl + old.jsonl.gz
    });
  });
```

- [ ] **Step 2: Run test to verify failures**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: FAIL — methods not found

- [ ] **Step 3: Implement compressIfOversized(), getStats(), runMaintenance()**

Add these methods to `LogFileManager` class:

```typescript
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
   * Run full maintenance cycle: purge → age-compress → size-compress.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/core/src/persistence/log-file-manager.ts shared/core/__tests__/unit/persistence/log-file-manager.test.ts
git commit -m "$(cat <<'EOF'
feat: add size-triggered compression, stats, and maintenance to LogFileManager

compressIfOversized() compresses oldest files when total dir size
exceeds threshold. getStats() returns file counts and sizes for
health endpoints. runMaintenance() orchestrates purge → compress
→ size-compress in the correct order.
EOF
)"
```

---

### Task 4: Add periodic maintenance scheduling

**Files:**
- Modify: `shared/core/src/persistence/log-file-manager.ts`
- Modify: `shared/core/__tests__/unit/persistence/log-file-manager.test.ts`

- [ ] **Step 1: Write failing tests for startPeriodicMaintenance/stopPeriodicMaintenance**

Add to the test file:

```typescript
  describe('periodic maintenance', () => {
    it('should run maintenance on the timer interval', async () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        retentionDays: 14,
        compressAfterDays: 1,
        logger,
      });

      // Create a file that will be compressed by maintenance
      await createFile(testDir, `trades-${makeDateStr(3)}.jsonl`, 'data');

      // Start with a very short interval for testing
      mgr.startPeriodicMaintenance(50);

      // Wait for the timer to fire
      await new Promise(resolve => setTimeout(resolve, 120));

      mgr.stopPeriodicMaintenance();

      const files = await fsp.readdir(testDir);
      expect(files).toContain(`trades-${makeDateStr(3)}.jsonl.gz`);
    });

    it('should be safe to call stop without start', () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        logger,
      });

      // Should not throw
      mgr.stopPeriodicMaintenance();
    });

    it('should be safe to call start twice', () => {
      const mgr = new LogFileManager({
        dir: testDir,
        filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
        logger,
      });

      mgr.startPeriodicMaintenance(60000);
      mgr.startPeriodicMaintenance(60000); // Should not create duplicate timers
      mgr.stopPeriodicMaintenance();
    });
  });
```

- [ ] **Step 2: Run test to verify failures**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: FAIL — methods not found

- [ ] **Step 3: Implement periodic scheduling**

Add to `LogFileManager` class:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/core/src/persistence/log-file-manager.ts shared/core/__tests__/unit/persistence/log-file-manager.test.ts
git commit -m "$(cat <<'EOF'
feat: add periodic background maintenance to LogFileManager

startPeriodicMaintenance() runs purge + compress cycle on
configurable interval (default 6h). Timer is unref'd to not
prevent process exit. Safe to call multiple times.
EOF
)"
```

---

## Chunk 2: TradeLogger Refactor + R2 Fix + Wiring

### Task 5: Refactor TradeLogger to delegate lifecycle to LogFileManager

**Files:**
- Modify: `shared/core/src/persistence/trade-logger.ts`
- Modify: `shared/core/__tests__/unit/persistence/trade-logger.test.ts`

- [ ] **Step 1: Write failing tests for new TradeLogger config and maintenance methods**

Add a new `describe` block to the existing `trade-logger.test.ts`:

```typescript
  // ---------------------------------------------------------------------------
  // Lifecycle management (via LogFileManager)
  // ---------------------------------------------------------------------------

  describe('lifecycle management', () => {
    it('should accept retentionDays and maxTotalSizeMB config', () => {
      const tradeLogger = new TradeLogger({
        outputDir: testDir,
        enabled: true,
        retentionDays: 7,
        maxTotalSizeMB: 50,
      }, logger);

      // No error means config was accepted
      expect(tradeLogger.isEnabled()).toBe(true);
    });

    it('should compress old files via compressOldLogs()', async () => {
      const tradeLogger = new TradeLogger({
        outputDir: testDir,
        enabled: true,
        compressAfterDays: 1,
      }, logger);

      // Create an old file
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 3);
      const dateStr = oldDate.toISOString().slice(0, 10);
      await fsp.mkdir(testDir, { recursive: true });
      await fsp.writeFile(path.join(testDir, `trades-${dateStr}.jsonl`), 'data\n');

      const compressed = await tradeLogger.compressOldLogs();
      expect(compressed).toBe(1);
      const files = await fsp.readdir(testDir);
      expect(files).toContain(`trades-${dateStr}.jsonl.gz`);
    });

    it('should purge expired files via purgeExpiredLogs()', async () => {
      const tradeLogger = new TradeLogger({
        outputDir: testDir,
        enabled: true,
        retentionDays: 14,
      }, logger);

      // Create an expired .gz file
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 20);
      const dateStr = oldDate.toISOString().slice(0, 10);
      await fsp.mkdir(testDir, { recursive: true });
      await fsp.writeFile(path.join(testDir, `trades-${dateStr}.jsonl.gz`), 'old');

      const result = await tradeLogger.purgeExpiredLogs();
      expect(result.purged).toBe(1);
      expect(await fsp.readdir(testDir)).toHaveLength(0);
    });

    it('should start and stop periodic maintenance', async () => {
      const tradeLogger = new TradeLogger({
        outputDir: testDir,
        enabled: true,
        compressAfterDays: 1,
      }, logger);

      // Create old file
      const dateStr = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      await fsp.mkdir(testDir, { recursive: true });
      await fsp.writeFile(path.join(testDir, `trades-${dateStr}.jsonl`), 'data\n');

      tradeLogger.startMaintenance(50);
      await new Promise(resolve => setTimeout(resolve, 120));
      tradeLogger.stopMaintenance();

      const files = await fsp.readdir(testDir);
      expect(files).toContain(`trades-${dateStr}.jsonl.gz`);
    });

    it('close() should stop maintenance', async () => {
      const tradeLogger = new TradeLogger({
        outputDir: testDir,
        enabled: true,
      }, logger);

      tradeLogger.startMaintenance(60000);
      await tradeLogger.close();

      // Verify no errors — close stops the timer cleanly
      expect(logger.getLogs('error')).toHaveLength(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify failures**

Run: `npx jest shared/core/__tests__/unit/persistence/trade-logger.test.ts --no-coverage`
Expected: FAIL — `retentionDays` not recognized, `purgeExpiredLogs` not a function, etc.

- [ ] **Step 3: Refactor TradeLogger to use LogFileManager**

Modify `trade-logger.ts`:

1. Add `retentionDays` and `maxTotalSizeMB` to `TradeLoggerConfig` interface
2. Add defaults to `DEFAULT_CONFIG`
3. Create internal `LogFileManager` instance in constructor
4. Delegate `compressOldLogs()` to `LogFileManager.compressOldFiles()`
5. Add `purgeExpiredLogs()` method
6. Add `startMaintenance()` / `stopMaintenance()` methods
7. Update `close()` to call `stopMaintenance()`
8. Remove the old compression implementation (replaced by LogFileManager)

Changes to `TradeLoggerConfig`:

```typescript
export interface TradeLoggerConfig {
  outputDir: string;
  enabled: boolean;
  compressAfterDays: number;
  /** Delete all log files older than this many days (default: 14) */
  retentionDays: number;
  /** Compress oldest files when total size exceeds this (MB, 0=disabled, default: 100) */
  maxTotalSizeMB: number;
}
```

Update `DEFAULT_CONFIG`:

```typescript
const DEFAULT_CONFIG: TradeLoggerConfig = {
  outputDir: './data/trades',
  enabled: true,
  compressAfterDays: 3,
  retentionDays: 14,
  maxTotalSizeMB: 100,
};
```

Add `LogFileManager` import and usage:

```typescript
import { LogFileManager } from './log-file-manager';
```

In the constructor, after `this.config = ...`:

```typescript
    this.fileManager = new LogFileManager({
      dir: this.config.outputDir,
      filePattern: /^trades-(\d{4}-\d{2}-\d{2})\.jsonl$/,
      compressAfterDays: this.config.compressAfterDays,
      retentionDays: this.config.retentionDays,
      maxTotalSizeMB: this.config.maxTotalSizeMB,
      logger,
    });
```

Add the field: `private readonly fileManager: LogFileManager;`

Replace the body of `compressOldLogs()`:

```typescript
  async compressOldLogs(): Promise<number> {
    if (!this.config.enabled) return 0;
    return this.fileManager.compressOldFiles();
  }
```

Add new methods:

```typescript
  async purgeExpiredLogs(): Promise<{ purged: number; freedBytes: number }> {
    if (!this.config.enabled) return { purged: 0, freedBytes: 0 };
    return this.fileManager.purgeExpiredFiles();
  }

  startMaintenance(intervalMs?: number): void {
    if (!this.config.enabled) return;
    this.fileManager.startPeriodicMaintenance(intervalMs);
  }

  stopMaintenance(): void {
    this.fileManager.stopPeriodicMaintenance();
  }
```

Update `close()`:

```typescript
  async close(): Promise<void> {
    this.stopMaintenance();
    this.dirEnsured = false;
    this.logger.debug('Trade logger closed');
  }
```

Remove the old `compressOldLogs()` implementation body (the imports for `fs`, `createGzip`, `pipeline` can be removed from trade-logger.ts since they are now only in log-file-manager.ts).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest shared/core/__tests__/unit/persistence/trade-logger.test.ts --no-coverage`
Expected: All tests PASS (old + new)

- [ ] **Step 5: Commit**

```bash
git add shared/core/src/persistence/trade-logger.ts shared/core/__tests__/unit/persistence/trade-logger.test.ts
git commit -m "$(cat <<'EOF'
refactor: delegate TradeLogger lifecycle to LogFileManager

TradeLogger now delegates compression, purging, and periodic
maintenance to LogFileManager. Adds retentionDays (default 14)
and maxTotalSizeMB (default 100) to config. close() stops
the maintenance timer. Old inline compression logic removed.
EOF
)"
```

---

### Task 6: Fix R2 uploader compression race condition (C-1)

**Files:**
- Modify: `shared/core/src/persistence/r2-uploader.ts`
- Modify: `shared/core/__tests__/unit/persistence/r2-uploader.test.ts`

- [ ] **Step 1: Write failing test for .gz fallback**

Add a test to the existing `r2-uploader.test.ts` (in the `uploadPreviousDayLogs` describe block):

```typescript
    it('should fall back to .jsonl.gz when .jsonl not found', async () => {
      const mockLogger = createMockLogger();
      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      // Create only a .gz file (simulating post-compression state)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

      await fsp.mkdir(testDir, { recursive: true });
      await fsp.writeFile(path.join(testDir, `trades-${dateStr}.jsonl.gz`), 'gz-content');

      // Mock fetch to succeed
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      try {
        await uploader.uploadPreviousDayLogs(testDir);

        // Should have uploaded the .gz file
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const callArgs = (globalThis.fetch as jest.Mock).mock.calls[0];
        expect(callArgs[0]).toContain(`trades-${dateStr}.jsonl.gz`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
```

Note: you'll need `let testDir: string;` and temp directory setup/teardown in the test file if not already present. Check the existing test structure first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest shared/core/__tests__/unit/persistence/r2-uploader.test.ts --no-coverage -t "fall back to .jsonl.gz"`
Expected: FAIL — R2 uploader logs "No trade logs found" and doesn't attempt upload

- [ ] **Step 3: Modify uploadPreviousDayLogs() and uploadDayLogs() to check for .gz fallback**

In `r2-uploader.ts`, modify `uploadPreviousDayLogs()`:

Replace the file matching logic (lines 297-305):

```typescript
      const pattern = `trades-${dateStr}.jsonl`;
      const gzPattern = `trades-${dateStr}.jsonl.gz`;

      const files = await readdir(tradeLogDir);
      let matchingFiles = files.filter(f => f === pattern);

      // C-1 FIX: Fall back to .jsonl.gz when .jsonl not found (post-compression)
      if (matchingFiles.length === 0) {
        matchingFiles = files.filter(f => f === gzPattern);
      }

      if (matchingFiles.length === 0) {
        this.logger.info('No trade logs found for previous day', { date: dateStr, dir: tradeLogDir });
        return;
      }
```

Apply the same pattern to `uploadDayLogs()` (lines 339-342):

```typescript
      const pattern = `trades-${dateStr}.jsonl`;
      const gzPattern = `trades-${dateStr}.jsonl.gz`;

      const files = await readdir(tradeLogDir);
      let matchingFiles = files.filter(f => f === pattern);

      // C-1 FIX: Fall back to .jsonl.gz
      if (matchingFiles.length === 0) {
        matchingFiles = files.filter(f => f === gzPattern);
      }
```

In `uploadFile()`, set the correct content-type for `.gz` files. After `const body = await readFile(localPath);` (line 205):

```typescript
      const isGz = localPath.endsWith('.gz');
```

Update the headers block:

```typescript
      const headers: Record<string, string> = {
        'host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'content-length': String(body.length),
        'content-type': isGz ? 'application/gzip' : 'application/x-ndjson',
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest shared/core/__tests__/unit/persistence/r2-uploader.test.ts --no-coverage`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add shared/core/src/persistence/r2-uploader.ts shared/core/__tests__/unit/persistence/r2-uploader.test.ts
git commit -m "$(cat <<'EOF'
fix: R2 uploader falls back to .jsonl.gz when .jsonl not found

Fixes race condition where compressOldLogs() deletes .jsonl before
R2's daily upload runs. Now checks for .jsonl.gz fallback and sets
correct Content-Type (application/gzip) for compressed uploads.
EOF
)"
```

---

### Task 7: Add size limit to lost-opportunity writer (H-3)

**Files:**
- Modify: `shared/core/src/publishers/opportunity-publisher.ts`

- [ ] **Step 1: Add size limit constant and stat check**

In `opportunity-publisher.ts`, add a constant near the top of the class:

```typescript
  /** Maximum fallback file size per day (100MB) — matches DLQ fallback pattern */
  private static readonly MAX_FALLBACK_FILE_BYTES = 100 * 1024 * 1024;
```

Modify `writeToLocalFallback()` at `opportunity-publisher.ts:257`. Replace the fire-and-forget chain:

```typescript
    fsp.mkdir(dir, { recursive: true })
      .then(() => fsp.stat(filePath).catch(() => null))
      .then((fileStat) => {
        if (fileStat && fileStat.size >= OpportunityPublisher.MAX_FALLBACK_FILE_BYTES) {
          this.logger.warn('Lost opportunity fallback file size limit reached', {
            filePath,
            sizeBytes: fileStat.size,
            limitBytes: OpportunityPublisher.MAX_FALLBACK_FILE_BYTES,
            opportunityId: opportunity.id,
          });
          return;
        }
        return fsp.appendFile(filePath, line, 'utf8');
      })
      .then(() => {
        this.logger.info('Lost opportunity written to local JSONL fallback', {
          opportunityId: opportunity.id,
          filePath,
        });
      })
      .catch((fsError) => {
        this.logger.error('All fallback paths exhausted — opportunity permanently lost', {
          opportunityId: opportunity.id,
          error: (fsError as Error).message,
        });
      });
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit --project shared/core/tsconfig.json`
Expected: Clean (0 errors)

- [ ] **Step 3: Commit**

```bash
git add shared/core/src/publishers/opportunity-publisher.ts
git commit -m "$(cat <<'EOF'
fix: add 100MB size limit to lost-opportunity fallback writer

Matches the DLQ fallback pattern in stream-consumer-manager.ts
and opportunity-router.ts. Prevents unbounded disk growth when
Redis is down for extended periods.
EOF
)"
```

---

### Task 8: Wire maintenance into execution engine + export from core

**Files:**
- Modify: `services/execution-engine/src/engine.ts`
- Modify: `shared/core/src/index.ts`
- Modify: `shared/test-utils/src/mocks/core.mock.ts`

- [ ] **Step 1: Update core barrel export**

In `shared/core/src/index.ts`, after the TradeLogger exports (line ~1984), add:

```typescript
export { LogFileManager } from './persistence/log-file-manager';
export type { LogFileManagerConfig, MaintenanceResult, DirectoryStats } from './persistence/log-file-manager';
```

- [ ] **Step 2: Update test-utils mock**

In `shared/test-utils/src/mocks/core.mock.ts`, update the `TradeLogger` mock to include new methods:

```typescript
    TradeLogger: jest.fn().mockImplementation(() => ({
      logTrade: jest.fn(),
      close: jest.fn(),
      validateLogDir: jest.fn().mockResolvedValue(undefined),
      compressOldLogs: jest.fn().mockResolvedValue(0),
      purgeExpiredLogs: jest.fn().mockResolvedValue({ purged: 0, freedBytes: 0 }),
      startMaintenance: jest.fn(),
      stopMaintenance: jest.fn(),
      getWriteHealth: jest.fn().mockReturnValue({ writeSuccessCount: 0, writeFailureCount: 0, lastWriteError: null, lastSuccessfulWriteMs: 0 }),
    })),
```

Add a LogFileManager mock nearby:

```typescript
    LogFileManager: jest.fn().mockImplementation(() => ({
      purgeExpiredFiles: jest.fn().mockResolvedValue({ purged: 0, freedBytes: 0 }),
      compressOldFiles: jest.fn().mockResolvedValue(0),
      compressIfOversized: jest.fn().mockResolvedValue(0),
      runMaintenance: jest.fn().mockResolvedValue({ purged: 0, compressed: 0, sizeCompressed: 0, totalSizeBytes: 0 }),
      getStats: jest.fn().mockResolvedValue({ totalSizeBytes: 0, fileCount: 0, oldestFileDate: null, newestFileDate: null, compressedCount: 0, uncompressedCount: 0 }),
      startPeriodicMaintenance: jest.fn(),
      stopPeriodicMaintenance: jest.fn(),
    })),
```

- [ ] **Step 3: Wire env vars and maintenance into engine.ts**

In `engine.ts`, modify the TradeLogger constructor call at lines 431-437. Add env var parsing:

```typescript
    // O-6: Initialize persistent trade logger
    const tradeLogEnabled = process.env.TRADE_LOG_ENABLED !== 'false';
    const tradeLogDir = process.env.TRADE_LOG_DIR ?? './data/trades';
    const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS ?? '', 10);
    const maxTotalSizeMB = parseInt(process.env.LOG_MAX_TOTAL_SIZE_MB ?? '', 10);
    const compressAfterDays = parseInt(process.env.LOG_COMPRESS_AFTER_DAYS ?? '', 10);
    this.tradeLogger = new TradeLogger(
      {
        enabled: config.tradeLoggerConfig?.enabled ?? tradeLogEnabled,
        outputDir: config.tradeLoggerConfig?.outputDir ?? tradeLogDir,
        ...(Number.isFinite(retentionDays) ? { retentionDays } : {}),
        ...(Number.isFinite(maxTotalSizeMB) ? { maxTotalSizeMB } : {}),
        ...(Number.isFinite(compressAfterDays) ? { compressAfterDays } : {}),
      },
      this.logger,
    );
```

At lines 634-643, replace the startup compression block:

```typescript
      // Validate trade log directory and start lifecycle maintenance
      if (this.tradeLogger) {
        await this.tradeLogger.validateLogDir();
        // Run initial maintenance (compress old + purge expired) then start periodic timer
        this.tradeLogger.compressOldLogs().catch((err: unknown) => {
          this.logger.warn('Trade log compression failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        const maintenanceHours = parseInt(process.env.LOG_MAINTENANCE_INTERVAL_HOURS ?? '', 10);
        const maintenanceMs = Number.isFinite(maintenanceHours)
          ? maintenanceHours * 60 * 60 * 1000
          : undefined; // Uses LogFileManager's 6h default
        this.tradeLogger.startMaintenance(maintenanceMs);
      }
```

At lines 935-939 (shutdown), `close()` already calls `stopMaintenance()` — no change needed.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Clean (0 errors)

- [ ] **Step 5: Run existing engine lifecycle tests**

Run: `npx jest services/execution-engine/__tests__/unit/engine-lifecycle.test.ts --no-coverage`
Expected: PASS (mock already covers `compressOldLogs`, new methods are added to mock)

- [ ] **Step 6: Commit**

```bash
git add shared/core/src/index.ts shared/test-utils/src/mocks/core.mock.ts services/execution-engine/src/engine.ts
git commit -m "$(cat <<'EOF'
feat: wire log lifecycle management into execution engine

- Export LogFileManager from @arbitrage/core
- Engine reads LOG_RETENTION_DAYS, LOG_MAX_TOTAL_SIZE_MB,
  LOG_COMPRESS_AFTER_DAYS, LOG_MAINTENANCE_INTERVAL_HOURS env vars
- Starts periodic maintenance after validateLogDir()
- close() stops maintenance timer via TradeLogger.stopMaintenance()
- Updated test-utils mock with new TradeLogger methods
EOF
)"
```

---

### Task 9: Remove duplicate `strategyUsed` field (L-2)

**Files:**
- Modify: `shared/core/src/persistence/trade-logger.ts`

- [ ] **Step 1: Remove `strategyUsed` from TradeLogEntry and buildEntry()**

In `trade-logger.ts`:

Remove `strategyUsed` from the `TradeLogEntry` interface (line 80-81):
```typescript
  // REMOVE these lines:
  /** Execution strategy used (e.g., 'intra-chain', 'flash-loan', 'cross-chain') */
  strategyUsed?: string;
```

Remove the assignment in `buildEntry()` (line 419):
```typescript
  // REMOVE this line:
  strategyUsed: opportunity?.type,
```

- [ ] **Step 2: Run typecheck to verify no downstream consumers depend on it**

Run: `npm run typecheck`
Expected: Clean — no external code reads `strategyUsed` (it was only written, never consumed)

- [ ] **Step 3: Commit**

```bash
git add shared/core/src/persistence/trade-logger.ts
git commit -m "$(cat <<'EOF'
fix: remove duplicate strategyUsed field from TradeLogEntry

strategyUsed always contained the same value as type field.
Saves ~11 bytes/entry (~1.5 MB/day at peak volume).
EOF
)"
```

---

### Task 10: Final typecheck + full test run

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 2: Run LogFileManager tests**

Run: `npx jest shared/core/__tests__/unit/persistence/log-file-manager.test.ts --no-coverage`
Expected: All PASS

- [ ] **Step 3: Run TradeLogger tests**

Run: `npx jest shared/core/__tests__/unit/persistence/trade-logger.test.ts --no-coverage`
Expected: All PASS

- [ ] **Step 4: Run R2 uploader tests**

Run: `npx jest shared/core/__tests__/unit/persistence/r2-uploader.test.ts --no-coverage`
Expected: All PASS

- [ ] **Step 5: Run execution engine lifecycle tests**

Run: `npx jest services/execution-engine/__tests__/unit/engine-lifecycle.test.ts --no-coverage`
Expected: All PASS

- [ ] **Step 6: Run full unit test suite**

Run: `npm run test:unit`
Expected: All pass, no regressions
