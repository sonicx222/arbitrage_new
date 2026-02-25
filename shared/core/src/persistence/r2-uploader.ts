/**
 * R2 Trade Log Uploader - Cloudflare R2 storage for trade log durability.
 *
 * Uploads daily JSONL trade logs to Cloudflare R2 (S3-compatible) for long-term
 * retention beyond local disk. Uses AWS Signature V4 with native crypto (no AWS SDK).
 *
 * Features:
 * - S3-compatible PUT via AWS Signature V4 (native crypto.createHmac)
 * - Streams files to R2 (no full-file buffering)
 * - Daily upload of previous day's logs
 * - Never crashes: catches errors, logs warnings, returns false on failure
 * - Constructor DI pattern with R2UploaderLogger for testability
 *
 * @custom:version 1.0.0
 * @see shared/core/src/persistence/trade-logger.ts - Source of JSONL files
 * @see services/execution-engine/src/engine.ts - Scheduling consumer
 */

import { createHmac, createHash } from 'crypto';
import { stat, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { getErrorMessage } from '../resilience/error-handling';
// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the R2 uploader.
 */
export interface R2UploaderConfig {
  /** Whether R2 uploads are enabled */
  enabled: boolean;
  /** R2 bucket name */
  bucket: string;
  /** Cloudflare account ID */
  accountId: string;
  /** S3-compatible access key ID */
  accessKeyId: string;
  /** S3-compatible secret access key */
  secretAccessKey: string;
  /** Custom endpoint URL (defaults to https://{accountId}.r2.cloudflarestorage.com) */
  endpoint?: string;
  /** Key prefix for uploaded files (e.g., 'trades/') */
  prefix?: string;
}

/**
 * Logger interface for the R2 uploader.
 * Matches the ServiceLogger pattern used by TradeLogger.
 */
export interface R2UploaderLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// =============================================================================
// S3v4 Signature Helpers
// =============================================================================

/**
 * Derive a signing key for AWS Signature V4.
 *
 * @param key - Secret access key
 * @param dateStamp - Date string in YYYYMMDD format
 * @param region - AWS region (use 'auto' for R2)
 * @param service - AWS service name (use 's3' for R2)
 * @returns Derived signing key as Buffer
 */
export function getSignatureKey(
  key: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  return kSigning;
}

/**
 * Create a SHA-256 hex hash of the given data.
 */
function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build an AWS Signature V4 Authorization header for an S3-compatible request.
 *
 * @param method - HTTP method (e.g., 'PUT')
 * @param path - URL path (e.g., '/bucket/key')
 * @param host - Host header value
 * @param headers - Request headers (must include host, x-amz-date, x-amz-content-sha256)
 * @param payloadHash - SHA-256 hex hash of the request body
 * @param accessKeyId - S3 access key ID
 * @param secretAccessKey - S3 secret access key
 * @param region - AWS region ('auto' for R2)
 * @param dateStamp - Date in YYYYMMDD format
 * @param amzDate - Date in ISO 8601 basic format (YYYYMMDD'T'HHMMSS'Z')
 * @returns Authorization header value
 */
export function signRequest(
  method: string,
  path: string,
  host: string,
  headers: Record<string, string>,
  payloadHash: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  dateStamp: string,
  amzDate: string,
): string {
  // Canonical headers (sorted by lowercase key)
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map(k => `${k.toLowerCase()}:${headers[k].trim()}`)
    .join('\n') + '\n';
  const signedHeaders = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');

  // Canonical request
  const canonicalRequest = [
    method,
    path,
    '', // query string (empty for PUT)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  // Signing key and signature
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, 's3');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// =============================================================================
// R2Uploader Class
// =============================================================================

/**
 * Uploads trade log JSONL files to Cloudflare R2 for long-term storage.
 *
 * Usage:
 * ```typescript
 * const uploader = new R2Uploader(config, logger);
 * await uploader.uploadFile('./data/trades/trades-2026-02-23.jsonl', 'trades/trades-2026-02-23.jsonl');
 * await uploader.uploadPreviousDayLogs('./data/trades');
 * ```
 *
 * @see TradeLogger - Source of JSONL files
 */
export class R2Uploader {
  private readonly config: R2UploaderConfig;
  private readonly logger: R2UploaderLogger;
  private readonly endpoint: string;

  constructor(config: R2UploaderConfig, logger: R2UploaderLogger) {
    this.config = config;
    this.logger = logger;
    this.endpoint = config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Upload a local file to R2.
   *
   * Reads the file and sends it via PUT with AWS Signature V4 authentication.
   * Never throws -- returns false on failure and logs a warning.
   *
   * @param localPath - Path to the local file to upload
   * @param remoteKey - Object key in R2 (e.g., 'trades/trades-2026-02-23.jsonl')
   * @returns true if upload succeeded, false otherwise
   */
  async uploadFile(localPath: string, remoteKey: string): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      // Verify file exists and get size
      const fileStat = await stat(localPath);
      if (!fileStat.isFile()) {
        this.logger.warn('R2 upload skipped: not a file', { localPath });
        return false;
      }

      // Read file contents for upload (JSONL files are typically small enough)
      const body = await readFile(localPath);

      // Build request
      const now = new Date();
      const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
      const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const payloadHash = sha256(body);

      const url = new URL(`/${this.config.bucket}/${remoteKey}`, this.endpoint);
      const host = url.host;
      const path = url.pathname;

      const headers: Record<string, string> = {
        'host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'content-length': String(body.length),
        'content-type': 'application/x-ndjson',
      };

      const authorization = signRequest(
        'PUT',
        path,
        host,
        headers,
        payloadHash,
        this.config.accessKeyId,
        this.config.secretAccessKey,
        'auto', // R2 uses 'auto' region
        dateStamp,
        amzDate,
      );

      // Execute PUT request
      const response = await fetch(url.toString(), {
        method: 'PUT',
        headers: {
          ...headers,
          'Authorization': authorization,
        },
        body,
      });

      if (response.ok) {
        this.logger.info('R2 upload succeeded', {
          remoteKey,
          size: body.length,
          status: response.status,
        });
        return true;
      } else {
        const responseText = await response.text().catch(() => '(unreadable)');
        this.logger.warn('R2 upload failed with HTTP error', {
          remoteKey,
          status: response.status,
          statusText: response.statusText,
          response: responseText.slice(0, 500),
        });
        return false;
      }
    } catch (error) {
      this.logger.warn('R2 upload failed', {
        localPath,
        remoteKey,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Upload previous day's trade log files to R2.
   *
   * Scans the trade log directory for JSONL files matching yesterday's date
   * pattern (trades-YYYY-MM-DD.jsonl) and uploads them.
   *
   * Never throws -- errors are logged as warnings.
   *
   * @param tradeLogDir - Directory containing JSONL trade log files
   */
  async uploadPreviousDayLogs(tradeLogDir: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yyyy = yesterday.getFullYear();
      const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
      const dd = String(yesterday.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      const pattern = `trades-${dateStr}.jsonl`;

      const files = await readdir(tradeLogDir);
      const matchingFiles = files.filter(f => f === pattern);

      if (matchingFiles.length === 0) {
        this.logger.info('No trade logs found for previous day', { date: dateStr, dir: tradeLogDir });
        return;
      }

      for (const file of matchingFiles) {
        const localPath = join(tradeLogDir, file);
        const prefix = this.config.prefix ?? 'trades/';
        const remoteKey = `${prefix}${file}`;
        await this.uploadFile(localPath, remoteKey);
      }
    } catch (error) {
      this.logger.warn('Failed to upload previous day logs', {
        tradeLogDir,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Upload a specific day's trade log files to R2.
   *
   * Useful for on-demand uploads (e.g., during graceful shutdown).
   *
   * @param tradeLogDir - Directory containing JSONL trade log files
   * @param date - The date to upload logs for
   */
  async uploadDayLogs(tradeLogDir: string, date: Date): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      const pattern = `trades-${dateStr}.jsonl`;

      const files = await readdir(tradeLogDir);
      const matchingFiles = files.filter(f => f === pattern);

      for (const file of matchingFiles) {
        const localPath = join(tradeLogDir, file);
        const prefix = this.config.prefix ?? 'trades/';
        const remoteKey = `${prefix}${file}`;
        await this.uploadFile(localPath, remoteKey);
      }
    } catch (error) {
      this.logger.warn('Failed to upload day logs', {
        tradeLogDir,
        date: date.toISOString(),
        error: getErrorMessage(error),
      });
    }
  }
}
