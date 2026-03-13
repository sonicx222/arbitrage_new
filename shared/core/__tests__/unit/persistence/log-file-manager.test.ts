import * as fsp from 'fs/promises';
import * as fs from 'fs';
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

      await createFile(testDir, `trades-${makeDateStr(20)}.jsonl.gz`, 'old-gz');
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
