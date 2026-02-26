/**
 * OpenTelemetry Log Transport for Pino.
 *
 * Sends structured logs to an OTEL collector for centralized aggregation
 * using the OTLP/HTTP JSON protocol. This is a lightweight implementation
 * that does not depend on the full OTEL SDK — it uses native `fetch` for
 * log export.
 *
 * Features:
 * - Configurable via env vars: OTEL_EXPORTER_ENDPOINT, OTEL_SERVICE_NAME
 * - Graceful noop when OTEL is not configured
 * - Batched export with configurable flush interval
 * - Trace context injection (traceId, spanId) from log metadata
 * - Non-blocking: export failures are silently dropped (never disrupts logging)
 *
 * OTLP/HTTP JSON protocol reference:
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * @custom:version 1.0.0
 * @see ADR-002 for event pipeline architecture
 */

import { Writable } from 'stream';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the OTEL log transport.
 */
export interface OtelTransportConfig {
  /** OTEL collector endpoint (e.g., "http://localhost:4318") */
  endpoint: string;

  /** Service name for resource identification */
  serviceName: string;

  /** Maximum number of log records to batch before flushing */
  batchSize?: number;

  /** Maximum time (ms) to wait before flushing a partial batch */
  flushIntervalMs?: number;

  /** Request timeout in ms */
  requestTimeoutMs?: number;

  /** Additional resource attributes to include */
  resourceAttributes?: Record<string, string>;
}

/**
 * OTLP SeverityNumber mapping from Pino log levels.
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/#severity-fields
 */
const PINO_TO_OTEL_SEVERITY: Record<string, { severityNumber: number; severityText: string }> = {
  trace: { severityNumber: 1, severityText: 'TRACE' },
  debug: { severityNumber: 5, severityText: 'DEBUG' },
  info: { severityNumber: 9, severityText: 'INFO' },
  warn: { severityNumber: 13, severityText: 'WARN' },
  error: { severityNumber: 17, severityText: 'ERROR' },
  fatal: { severityNumber: 21, severityText: 'FATAL' },
};

/** Default severity for unknown levels */
const DEFAULT_SEVERITY = { severityNumber: 0, severityText: 'UNSPECIFIED' };

// =============================================================================
// OTLP Log Record Types (simplified for export)
// =============================================================================

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  traceId?: string;
  spanId?: string;
}

interface OtlpResourceLogs {
  resource: {
    attributes: Array<{ key: string; value: { stringValue: string } }>;
  };
  scopeLogs: Array<{
    scope: { name: string; version: string };
    logRecords: OtlpLogRecord[];
  }>;
}

interface OtlpExportRequest {
  resourceLogs: OtlpResourceLogs[];
}

// =============================================================================
// Transport Implementation
// =============================================================================

/**
 * Create an OpenTelemetry log transport stream for Pino.
 *
 * Returns a Writable stream that batches Pino log records and exports
 * them to an OTEL collector via OTLP/HTTP. If the endpoint is not
 * configured, returns a noop stream that discards all input.
 *
 * @param config - Transport configuration (or undefined for noop)
 * @returns Writable stream suitable for Pino's multistream
 *
 * @example
 * ```typescript
 * const transport = createOtelTransport({
 *   endpoint: 'http://localhost:4318',
 *   serviceName: 'coordinator',
 * });
 * ```
 */
export function createOtelTransport(config?: OtelTransportConfig): OtelTransportStream {
  return new OtelTransportStream(config);
}

/**
 * Resolve OTEL configuration from environment variables.
 *
 * @returns OtelTransportConfig if OTEL_EXPORTER_ENDPOINT is set, undefined otherwise
 */
export function resolveOtelConfig(): OtelTransportConfig | undefined {
  const endpoint = process.env.OTEL_EXPORTER_ENDPOINT;
  if (!endpoint) {
    return undefined;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'arbitrage-service';
  const batchSize = parseInt(process.env.OTEL_BATCH_SIZE ?? '', 10);
  const flushIntervalMs = parseInt(process.env.OTEL_FLUSH_INTERVAL_MS ?? '', 10);

  return {
    endpoint,
    serviceName,
    batchSize: Number.isFinite(batchSize) ? batchSize : undefined,
    flushIntervalMs: Number.isFinite(flushIntervalMs) ? flushIntervalMs : undefined,
  };
}

/**
 * OpenTelemetry log transport stream for Pino.
 *
 * Implements Node.js Writable stream interface. Pino writes serialized
 * JSON log lines to this stream, which are batched and exported via
 * OTLP/HTTP.
 *
 * When no config is provided (OTEL not configured), operates as a
 * passthrough noop — all writes are acknowledged immediately.
 */
export class OtelTransportStream extends Writable {
  private readonly config: OtelTransportConfig | undefined;
  private readonly batch: OtlpLogRecord[] = [];
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly resourceAttributes: Array<{ key: string; value: { stringValue: string } }>;
  private _exportCount = 0;
  private _dropCount = 0;

  constructor(config?: OtelTransportConfig) {
    super({ objectMode: false });
    this.config = config;
    this.maxBatchSize = config?.batchSize ?? 50;
    this.flushIntervalMs = config?.flushIntervalMs ?? 5000;
    this.requestTimeoutMs = config?.requestTimeoutMs ?? 5000;

    // Build resource attributes
    this.resourceAttributes = [
      { key: 'service.name', value: { stringValue: config?.serviceName ?? 'unknown' } },
    ];

    if (config?.resourceAttributes) {
      for (const [key, val] of Object.entries(config.resourceAttributes)) {
        this.resourceAttributes.push({ key, value: { stringValue: val } });
      }
    }

    // Start periodic flush if configured
    if (this.config) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {
          // Silently ignore flush errors — logging should never disrupt the app
        });
      }, this.flushIntervalMs);

      // Unref the timer so it doesn't prevent process exit
      if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
        this.flushTimer.unref();
      }
    }
  }

  // ===========================================================================
  // Writable stream interface
  // ===========================================================================

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding, // eslint-disable-line no-undef
    callback: (error?: Error | null) => void,
  ): void {
    // Noop mode: discard immediately
    if (!this.config) {
      callback();
      return;
    }

    try {
      const line = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

      // Pino writes one JSON line per log entry
      const lines = line.split('\n').filter(l => l.trim().length > 0);

      for (const l of lines) {
        try {
          const parsed = JSON.parse(l) as Record<string, unknown>;
          const record = this.toOtlpLogRecord(parsed);
          this.batch.push(record);
        } catch {
          // Skip unparseable lines (e.g., pretty-printed output)
        }
      }

      // Flush if batch is full
      if (this.batch.length >= this.maxBatchSize) {
        this.flush().catch(() => {
          // Silently ignore — logging must not block
        });
      }
    } catch {
      // Never propagate errors from the transport
    }

    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    // Flush remaining records on stream close
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.flush()
      .catch(() => {
        // Silently ignore final flush errors
      })
      .finally(() => {
        callback();
      });
  }

  // ===========================================================================
  // OTLP Export
  // ===========================================================================

  /**
   * Flush the current batch to the OTEL collector.
   */
  async flush(): Promise<void> {
    if (this.batch.length === 0 || !this.config) {
      return;
    }

    // Drain the batch
    const records = this.batch.splice(0, this.batch.length);

    const payload: OtlpExportRequest = {
      resourceLogs: [
        {
          resource: {
            attributes: this.resourceAttributes,
          },
          scopeLogs: [
            {
              scope: { name: '@arbitrage/core', version: '1.0.0' },
              logRecords: records,
            },
          ],
        },
      ],
    };

    try {
      const url = `${this.config.endpoint}/v1/logs`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (response.ok) {
          this._exportCount += records.length;
        } else {
          this._dropCount += records.length;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      // Network errors, timeouts, etc. — silently drop
      this._dropCount += records.length;
    }
  }

  // ===========================================================================
  // Record Conversion
  // ===========================================================================

  /**
   * Convert a Pino JSON log object to an OTLP log record.
   */
  private toOtlpLogRecord(pinoLog: Record<string, unknown>): OtlpLogRecord {
    const level = typeof pinoLog.level === 'string'
      ? pinoLog.level
      : String(pinoLog.level ?? 'info');

    const severity = PINO_TO_OTEL_SEVERITY[level] ?? DEFAULT_SEVERITY;

    // Extract message
    const msg = typeof pinoLog.msg === 'string' ? pinoLog.msg : '';

    // Extract timestamp (Pino uses epoch ms in `time` field)
    const timeMs = typeof pinoLog.time === 'number'
      ? pinoLog.time
      : Date.now();

    // Convert to nanoseconds (OTLP spec)
    const timeUnixNano = String(BigInt(timeMs) * 1_000_000n);

    // Build attributes from remaining fields
    const attributes: Array<{ key: string; value: { stringValue: string } }> = [];

    // Reserved Pino fields to skip
    const SKIP_FIELDS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'name', 'v']);

    for (const [key, value] of Object.entries(pinoLog)) {
      if (SKIP_FIELDS.has(key)) continue;

      // Convert value to string for OTLP attribute
      const strValue = typeof value === 'string'
        ? value
        : typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : String(value ?? '');

      attributes.push({ key, value: { stringValue: strValue } });
    }

    // Build record
    const record: OtlpLogRecord = {
      timeUnixNano,
      severityNumber: severity.severityNumber,
      severityText: severity.severityText,
      body: { stringValue: msg },
      attributes,
    };

    // Inject trace context if present in log metadata
    const traceId = pinoLog.traceId;
    const spanId = pinoLog.spanId;

    if (typeof traceId === 'string' && /^[0-9a-f]{32}$/.test(traceId)) {
      record.traceId = traceId;
    }

    if (typeof spanId === 'string' && /^[0-9a-f]{16}$/.test(spanId)) {
      record.spanId = spanId;
    }

    return record;
  }

  // ===========================================================================
  // Stats (for testing and monitoring)
  // ===========================================================================

  /** Number of records successfully exported */
  get exportCount(): number {
    return this._exportCount;
  }

  /** Number of records dropped due to errors */
  get dropCount(): number {
    return this._dropCount;
  }

  /** Number of records currently in the batch buffer */
  get pendingCount(): number {
    return this.batch.length;
  }

  /** Whether the transport is in noop mode (no endpoint configured) */
  get isNoop(): boolean {
    return !this.config;
  }

  /**
   * Gracefully shut down the transport.
   * Flushes remaining records and stops the periodic timer.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
  }
}
