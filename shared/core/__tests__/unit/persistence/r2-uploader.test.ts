/**
 * Unit tests for R2Uploader - Cloudflare R2 trade log uploader.
 *
 * Tests cover:
 * - Upload succeeds with mocked fetch
 * - Upload fails gracefully on network error
 * - uploadPreviousDayLogs finds correct files
 * - S3v4 signature generation
 * - Disabled config skips upload
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  R2Uploader,
  getSignatureKey,
  signRequest,
} from '../../../src/persistence/r2-uploader';
import type { R2UploaderConfig, R2UploaderLogger } from '../../../src/persistence/r2-uploader';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockConfig(overrides: Partial<R2UploaderConfig> = {}): R2UploaderConfig {
  return {
    enabled: true,
    bucket: 'test-bucket',
    accountId: 'test-account-id',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    endpoint: 'https://test-account-id.r2.cloudflarestorage.com',
    prefix: 'trades/',
    ...overrides,
  };
}

function createMockLogger(): R2UploaderLogger & {
  calls: { level: string; msg: string; meta?: Record<string, unknown> }[];
} {
  const calls: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];
  return {
    calls,
    info(msg: string, meta?: Record<string, unknown>) {
      calls.push({ level: 'info', msg, meta });
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      calls.push({ level: 'warn', msg, meta });
    },
    error(msg: string, meta?: Record<string, unknown>) {
      calls.push({ level: 'error', msg, meta });
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('R2Uploader', () => {
  let testDir: string;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    mockLogger = createMockLogger();
    testDir = path.join(os.tmpdir(), `r2-uploader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(testDir, { recursive: true });

    // Save original fetch
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    // Restore original fetch
    globalThis.fetch = originalFetch;

    // Clean up test directory
    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ---------------------------------------------------------------------------
  // Disabled config
  // ---------------------------------------------------------------------------

  describe('disabled config', () => {
    it('should skip upload when disabled', async () => {
      const config = createMockConfig({ enabled: false });
      const uploader = new R2Uploader(config, mockLogger);

      const result = await uploader.uploadFile('/some/file.jsonl', 'trades/file.jsonl');

      expect(result).toBe(false);
      // No fetch calls should have been made
      expect(mockLogger.calls.filter(c => c.level === 'warn')).toHaveLength(0);
    });

    it('should skip uploadPreviousDayLogs when disabled', async () => {
      const config = createMockConfig({ enabled: false });
      const uploader = new R2Uploader(config, mockLogger);

      await uploader.uploadPreviousDayLogs(testDir);

      // No warnings or errors
      expect(mockLogger.calls.filter(c => c.level === 'warn')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Upload succeeds
  // ---------------------------------------------------------------------------

  describe('upload succeeds', () => {
    it('should upload file and return true on success', async () => {
      // Create a test file
      const testFile = path.join(testDir, 'trades-2026-02-23.jsonl');
      await fsp.writeFile(testFile, '{"trade":"data"}\n', 'utf8');

      // Mock fetch to return success
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      const result = await uploader.uploadFile(testFile, 'trades/trades-2026-02-23.jsonl');

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      // Verify the fetch call
      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[0]).toContain('test-bucket');
      expect(fetchCall[0]).toContain('trades/trades-2026-02-23.jsonl');
      expect(fetchCall[1].method).toBe('PUT');

      // Should have Authorization header
      expect(fetchCall[1].headers.Authorization).toMatch(/^AWS4-HMAC-SHA256/);

      // Should log success
      const infoLogs = mockLogger.calls.filter(c => c.level === 'info');
      expect(infoLogs.some(l => l.msg.includes('R2 upload succeeded'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Upload fails gracefully
  // ---------------------------------------------------------------------------

  describe('upload fails gracefully', () => {
    it('should return false and warn on HTTP error', async () => {
      const testFile = path.join(testDir, 'trades-2026-02-23.jsonl');
      await fsp.writeFile(testFile, '{"trade":"data"}\n', 'utf8');

      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: jest.fn().mockResolvedValue('Access denied'),
      });

      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      const result = await uploader.uploadFile(testFile, 'trades/trades-2026-02-23.jsonl');

      expect(result).toBe(false);
      const warnings = mockLogger.calls.filter(c => c.level === 'warn');
      expect(warnings.some(w => w.msg.includes('R2 upload failed with HTTP error'))).toBe(true);
    });

    it('should return false and warn on network error', async () => {
      const testFile = path.join(testDir, 'trades-2026-02-23.jsonl');
      await fsp.writeFile(testFile, '{"trade":"data"}\n', 'utf8');

      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      const result = await uploader.uploadFile(testFile, 'trades/trades-2026-02-23.jsonl');

      expect(result).toBe(false);
      const warnings = mockLogger.calls.filter(c => c.level === 'warn');
      expect(warnings.some(w => w.msg.includes('R2 upload failed'))).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      const result = await uploader.uploadFile('/nonexistent/file.jsonl', 'trades/file.jsonl');

      expect(result).toBe(false);
      const warnings = mockLogger.calls.filter(c => c.level === 'warn');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    });

    it('should never throw on upload failure', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('catastrophic failure'));

      const testFile = path.join(testDir, 'trades-2026-02-23.jsonl');
      await fsp.writeFile(testFile, '{"trade":"data"}\n', 'utf8');

      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      // Should not throw
      const result = await uploader.uploadFile(testFile, 'trades/trades-2026-02-23.jsonl');
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // uploadPreviousDayLogs
  // ---------------------------------------------------------------------------

  describe('uploadPreviousDayLogs', () => {
    it('should find and upload yesterday\'s log file', async () => {
      // Create yesterday's log file
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yyyy = yesterday.getFullYear();
      const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
      const dd = String(yesterday.getDate()).padStart(2, '0');
      const filename = `trades-${yyyy}-${mm}-${dd}.jsonl`;

      await fsp.writeFile(path.join(testDir, filename), '{"trade":"yesterday"}\n', 'utf8');

      // Also create today's file (should NOT be uploaded)
      const today = new Date();
      const todayFilename = `trades-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.jsonl`;
      await fsp.writeFile(path.join(testDir, todayFilename), '{"trade":"today"}\n', 'utf8');

      globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      await uploader.uploadPreviousDayLogs(testDir);

      // Should have called fetch once (yesterday's file only)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[0]).toContain(filename);
    });

    it('should log info when no files found for previous day', async () => {
      // Empty directory - no log files
      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      await uploader.uploadPreviousDayLogs(testDir);

      const infoLogs = mockLogger.calls.filter(c => c.level === 'info');
      expect(infoLogs.some(l => l.msg.includes('No trade logs found for previous day'))).toBe(true);
    });

    it('should not throw on directory read error', async () => {
      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      // Non-existent directory should not throw
      await uploader.uploadPreviousDayLogs('/nonexistent/directory');

      const warnings = mockLogger.calls.filter(c => c.level === 'warn');
      expect(warnings.some(w => w.msg.includes('Failed to upload previous day logs'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // uploadDayLogs
  // ---------------------------------------------------------------------------

  describe('uploadDayLogs', () => {
    it('should upload logs for a specific date', async () => {
      const testDate = new Date('2026-02-20T12:00:00Z');
      const filename = 'trades-2026-02-20.jsonl';

      await fsp.writeFile(path.join(testDir, filename), '{"trade":"specific-day"}\n', 'utf8');

      globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const config = createMockConfig();
      const uploader = new R2Uploader(config, mockLogger);

      await uploader.uploadDayLogs(testDir, testDate);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(fetchCall[0]).toContain('trades-2026-02-20.jsonl');
    });
  });
});

// =============================================================================
// S3v4 Signature Tests
// =============================================================================

describe('S3v4 Signature Helpers', () => {
  describe('getSignatureKey', () => {
    it('should produce a deterministic signing key', () => {
      const key1 = getSignatureKey('mySecret', '20260224', 'auto', 's3');
      const key2 = getSignatureKey('mySecret', '20260224', 'auto', 's3');

      expect(key1).toEqual(key2);
      expect(Buffer.isBuffer(key1)).toBe(true);
      expect(key1.length).toBe(32); // SHA-256 output is 32 bytes
    });

    it('should produce different keys for different secrets', () => {
      const key1 = getSignatureKey('secret1', '20260224', 'auto', 's3');
      const key2 = getSignatureKey('secret2', '20260224', 'auto', 's3');

      expect(key1).not.toEqual(key2);
    });

    it('should produce different keys for different dates', () => {
      const key1 = getSignatureKey('mySecret', '20260224', 'auto', 's3');
      const key2 = getSignatureKey('mySecret', '20260225', 'auto', 's3');

      expect(key1).not.toEqual(key2);
    });

    it('should produce different keys for different regions', () => {
      const key1 = getSignatureKey('mySecret', '20260224', 'auto', 's3');
      const key2 = getSignatureKey('mySecret', '20260224', 'us-east-1', 's3');

      expect(key1).not.toEqual(key2);
    });
  });

  describe('signRequest', () => {
    it('should produce an Authorization header starting with AWS4-HMAC-SHA256', () => {
      const auth = signRequest(
        'PUT',
        '/test-bucket/trades/test.jsonl',
        'test-account.r2.cloudflarestorage.com',
        {
          'host': 'test-account.r2.cloudflarestorage.com',
          'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'x-amz-date': '20260224T120000Z',
        },
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'test-access-key',
        'test-secret-key',
        'auto',
        '20260224',
        '20260224T120000Z',
      );

      expect(auth).toMatch(/^AWS4-HMAC-SHA256/);
      expect(auth).toContain('Credential=test-access-key/20260224/auto/s3/aws4_request');
      expect(auth).toContain('SignedHeaders=');
      expect(auth).toContain('Signature=');
    });

    it('should include all header keys in SignedHeaders', () => {
      const auth = signRequest(
        'PUT',
        '/bucket/key',
        'host.example.com',
        {
          'host': 'host.example.com',
          'x-amz-content-sha256': 'abc123',
          'x-amz-date': '20260224T120000Z',
          'content-type': 'application/json',
        },
        'abc123',
        'key-id',
        'secret-key',
        'auto',
        '20260224',
        '20260224T120000Z',
      );

      expect(auth).toContain('content-type');
      expect(auth).toContain('host');
      expect(auth).toContain('x-amz-content-sha256');
      expect(auth).toContain('x-amz-date');
    });

    it('should produce deterministic signatures', () => {
      const args: Parameters<typeof signRequest> = [
        'PUT',
        '/bucket/key',
        'host.example.com',
        {
          'host': 'host.example.com',
          'x-amz-content-sha256': 'deadbeef',
          'x-amz-date': '20260224T120000Z',
        },
        'deadbeef',
        'key-id',
        'secret-key',
        'auto',
        '20260224',
        '20260224T120000Z',
      ];

      const auth1 = signRequest(...args);
      const auth2 = signRequest(...args);

      expect(auth1).toBe(auth2);
    });
  });
});
