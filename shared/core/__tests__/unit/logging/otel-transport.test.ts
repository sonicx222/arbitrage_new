/**
 * Unit tests for OtelTransportStream — OTLP/HTTP log export for Pino.
 *
 * Tests cover:
 * - Noop mode when no config is provided
 * - Log record conversion to OTLP format
 * - Severity mapping from Pino levels
 * - Trace context injection (traceId, spanId)
 * - Batch buffering and flush behavior
 * - Graceful error handling (never throws)
 * - Config resolution from environment variables
 * - Stream write interface compatibility
 * - Shutdown and cleanup
 */

import {
  OtelTransportStream,
  createOtelTransport,
  resolveOtelConfig,
} from '../../../src/logging/otel-transport';
import type { OtelTransportConfig } from '../../../src/logging/otel-transport';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestConfig(overrides: Partial<OtelTransportConfig> = {}): OtelTransportConfig {
  return {
    endpoint: 'http://localhost:4318',
    serviceName: 'test-service',
    batchSize: 5,
    flushIntervalMs: 60000, // Long interval so we control flushes manually
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

/**
 * Create a serialized Pino log line (JSON string).
 */
function pinoLogLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level: 'info',
    time: 1700000000000,
    msg: 'Test message',
    pid: 1234,
    hostname: 'test-host',
    name: 'test-service',
    service: 'test-service',
    ...overrides,
  }) + '\n';
}

// =============================================================================
// Noop Mode
// =============================================================================

describe('OtelTransportStream - noop mode', () => {
  it('should create a noop stream when no config is provided', () => {
    const transport = createOtelTransport();
    expect(transport.isNoop).toBe(true);
  });

  it('should create a noop stream when config is undefined', () => {
    const transport = new OtelTransportStream(undefined);
    expect(transport.isNoop).toBe(true);
  });

  it('should accept writes without error in noop mode', async () => {
    const transport = createOtelTransport();

    await new Promise<void>((resolve, reject) => {
      transport.write(pinoLogLine(), 'utf-8', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    expect(transport.pendingCount).toBe(0);
    expect(transport.exportCount).toBe(0);

    await new Promise<void>((resolve) => transport.end(resolve));
  });

  it('should report zero counts in noop mode', () => {
    const transport = createOtelTransport();
    expect(transport.exportCount).toBe(0);
    expect(transport.dropCount).toBe(0);
    expect(transport.pendingCount).toBe(0);
  });
});

// =============================================================================
// Active Mode (with config)
// =============================================================================

describe('OtelTransportStream - active mode', () => {
  let transport: OtelTransportStream;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    // Mock global fetch
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    transport = new OtelTransportStream(createTestConfig());
  });

  afterEach(async () => {
    await transport.shutdown();
    fetchMock.mockRestore();
  });

  it('should not be in noop mode when config is provided', () => {
    expect(transport.isNoop).toBe(false);
  });

  it('should buffer log records in the batch', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    expect(transport.pendingCount).toBe(1);
  });

  it('should auto-flush when batch is full', async () => {
    const config = createTestConfig({ batchSize: 2 });
    const smallBatchTransport = new OtelTransportStream(config);

    await new Promise<void>((resolve) => {
      smallBatchTransport.write(pinoLogLine({ msg: 'line1' }), 'utf-8', () => resolve());
    });
    await new Promise<void>((resolve) => {
      smallBatchTransport.write(pinoLogLine({ msg: 'line2' }), 'utf-8', () => resolve());
    });

    // Give flush a tick to complete
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalled();
    await smallBatchTransport.shutdown();
  });

  it('should flush remaining records on shutdown', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    expect(transport.pendingCount).toBe(1);

    await transport.shutdown();

    expect(transport.pendingCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should send to correct OTLP endpoint', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    await transport.flush();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4318/v1/logs',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('should include resource attributes in the payload', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);

    const resourceAttrs = body.resourceLogs[0].resource.attributes;
    expect(resourceAttrs).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'test-service' },
    });
  });

  it('should increment exportCount on successful export', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    await transport.flush();

    expect(transport.exportCount).toBe(1);
    expect(transport.dropCount).toBe(0);
  });

  it('should increment dropCount on failed export', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    await transport.flush();

    expect(transport.exportCount).toBe(0);
    expect(transport.dropCount).toBe(1);
  });

  it('should increment dropCount on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network unreachable'));

    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    await transport.flush();

    expect(transport.exportCount).toBe(0);
    expect(transport.dropCount).toBe(1);
  });

  it('should not throw on fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    // Should not throw
    await expect(transport.flush()).resolves.toBeUndefined();
  });
});

// =============================================================================
// OTLP Record Conversion
// =============================================================================

describe('OtelTransportStream - OTLP record format', () => {
  let transport: OtelTransportStream;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    transport = new OtelTransportStream(createTestConfig());
  });

  afterEach(async () => {
    await transport.shutdown();
    fetchMock.mockRestore();
  });

  it('should map Pino log levels to OTLP severity', async () => {
    const levels = [
      { pino: 'trace', otelNum: 1, otelText: 'TRACE' },
      { pino: 'debug', otelNum: 5, otelText: 'DEBUG' },
      { pino: 'info', otelNum: 9, otelText: 'INFO' },
      { pino: 'warn', otelNum: 13, otelText: 'WARN' },
      { pino: 'error', otelNum: 17, otelText: 'ERROR' },
      { pino: 'fatal', otelNum: 21, otelText: 'FATAL' },
    ];

    for (const { pino, otelNum, otelText } of levels) {
      const singleTransport = new OtelTransportStream(createTestConfig());

      await new Promise<void>((resolve) => {
        singleTransport.write(pinoLogLine({ level: pino }), 'utf-8', () => resolve());
      });

      await singleTransport.flush();

      const callArgs = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      const body = JSON.parse(callArgs[1].body);
      const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];

      expect(record.severityNumber).toBe(otelNum);
      expect(record.severityText).toBe(otelText);

      await singleTransport.shutdown();
    }
  });

  it('should set the log message as body.stringValue', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine({ msg: 'Hello OTEL' }), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(record.body.stringValue).toBe('Hello OTEL');
  });

  it('should convert timestamp to nanoseconds', async () => {
    const timeMs = 1700000000000;

    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine({ time: timeMs }), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(record.timeUnixNano).toBe(String(BigInt(timeMs) * 1_000_000n));
  });

  it('should include custom fields as attributes', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine({
        requestId: 'req-123',
        chain: 'ethereum',
      }), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrMap = new Map(
      record.attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
    );

    expect(attrMap.get('requestId')).toBe('req-123');
    expect(attrMap.get('chain')).toBe('ethereum');
  });

  it('should skip reserved Pino fields from attributes', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrKeys = record.attributes.map((a: { key: string }) => a.key);

    expect(attrKeys).not.toContain('level');
    expect(attrKeys).not.toContain('time');
    expect(attrKeys).not.toContain('msg');
    expect(attrKeys).not.toContain('pid');
    expect(attrKeys).not.toContain('hostname');
    expect(attrKeys).not.toContain('v');
  });

  it('should inject traceId when present in log metadata', async () => {
    const traceId = 'a'.repeat(32);

    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine({ traceId }), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(record.traceId).toBe(traceId);
  });

  it('should inject spanId when present in log metadata', async () => {
    const spanId = 'b'.repeat(16);

    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine({ spanId }), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(record.spanId).toBe(spanId);
  });

  it('should not inject traceId/spanId when format is invalid', async () => {
    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine({
        traceId: 'not-a-valid-trace',
        spanId: 'short',
      }), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];

    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });

  it('should handle non-JSON input gracefully', async () => {
    await new Promise<void>((resolve, reject) => {
      transport.write('not valid json\n', 'utf-8', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    expect(transport.pendingCount).toBe(0);
  });

  it('should handle multiple JSON lines in a single write', async () => {
    const multiLine = pinoLogLine({ msg: 'line1' }) + pinoLogLine({ msg: 'line2' });

    await new Promise<void>((resolve) => {
      transport.write(multiLine, 'utf-8', () => resolve());
    });

    expect(transport.pendingCount).toBe(2);
  });
});

// =============================================================================
// resolveOtelConfig
// =============================================================================

describe('resolveOtelConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return undefined when OTEL_EXPORTER_ENDPOINT is not set', () => {
    delete process.env.OTEL_EXPORTER_ENDPOINT;
    expect(resolveOtelConfig()).toBeUndefined();
  });

  it('should return config when OTEL_EXPORTER_ENDPOINT is set', () => {
    process.env.OTEL_EXPORTER_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_SERVICE_NAME = 'my-service';

    const config = resolveOtelConfig();

    expect(config).toBeDefined();
    expect(config!.endpoint).toBe('http://collector:4318');
    expect(config!.serviceName).toBe('my-service');
  });

  it('should use default service name when OTEL_SERVICE_NAME is not set', () => {
    process.env.OTEL_EXPORTER_ENDPOINT = 'http://collector:4318';
    delete process.env.OTEL_SERVICE_NAME;

    const config = resolveOtelConfig();

    expect(config!.serviceName).toBe('arbitrage-service');
  });

  it('should parse OTEL_BATCH_SIZE', () => {
    process.env.OTEL_EXPORTER_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_BATCH_SIZE = '100';

    const config = resolveOtelConfig();

    expect(config!.batchSize).toBe(100);
  });

  it('should parse OTEL_FLUSH_INTERVAL_MS', () => {
    process.env.OTEL_EXPORTER_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_FLUSH_INTERVAL_MS = '10000';

    const config = resolveOtelConfig();

    expect(config!.flushIntervalMs).toBe(10000);
  });

  it('should use undefined for invalid numeric env vars', () => {
    process.env.OTEL_EXPORTER_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_BATCH_SIZE = 'not-a-number';
    process.env.OTEL_FLUSH_INTERVAL_MS = '';

    const config = resolveOtelConfig();

    expect(config!.batchSize).toBeUndefined();
    expect(config!.flushIntervalMs).toBeUndefined();
  });
});

// =============================================================================
// Resource Attributes
// =============================================================================

describe('OtelTransportStream - resource attributes', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('should include custom resource attributes', async () => {
    const transport = new OtelTransportStream(createTestConfig({
      resourceAttributes: {
        'deployment.environment': 'staging',
        'service.version': '2.0.0',
      },
    }));

    await new Promise<void>((resolve) => {
      transport.write(pinoLogLine(), 'utf-8', () => resolve());
    });

    await transport.flush();

    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    const attrs = body.resourceLogs[0].resource.attributes;

    expect(attrs).toContainEqual({
      key: 'deployment.environment',
      value: { stringValue: 'staging' },
    });
    expect(attrs).toContainEqual({
      key: 'service.version',
      value: { stringValue: '2.0.0' },
    });

    await transport.shutdown();
  });
});
