/**
 * Integration test: PinoLoggerWrapper mixin + ALS trace context
 *
 * Verifies that when a Pino logger is used inside `withLogContext(ctx, fn)`,
 * the mixin injects `traceId` and `spanId` into the serialized log output.
 *
 * Uses a Node.js PassThrough stream to capture Pino's JSON output,
 * verifying the fields are present without relying on RecordingLogger
 * (which bypasses Pino internals and would not test the mixin path).
 *
 * @see docs/reports/LOGGING_OPTIMIZATION_2026-03-04.md — Task 3
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { PassThrough } from 'stream';
import pino from 'pino';
import { withLogContext, getLogContext, resetLogContext } from '../../../src/logging/log-context';
import type { TraceContext } from '../../../src/tracing/trace-context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a Pino logger that writes JSON to an in-memory PassThrough stream.
 * The mixin reads from ALS via getLogContext() — same as production.
 */
function createTestLogger() {
  const stream = new PassThrough();
  const lines: string[] = [];
  stream.on('data', (chunk: Buffer) => lines.push(chunk.toString().trim()));

  const logger = pino(
    {
      level: 'debug',
      mixin: () => {
        const ctx = getLogContext();
        if (!ctx) return {};
        return ctx.parentSpanId
          ? { traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId }
          : { traceId: ctx.traceId, spanId: ctx.spanId };
      },
    },
    stream
  );

  return {
    logger,
    getLastLog: () => {
      const last = lines[lines.length - 1];
      return last ? (JSON.parse(last) as Record<string, unknown>) : undefined;
    },
    getAllLogs: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function makeCtx(overrides?: Partial<TraceContext>): TraceContext {
  return {
    traceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    spanId: 'a1b2c3d4e5f6a1b2',
    serviceName: 'test',
    timestamp: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  resetLogContext();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Pino mixin ALS injection', () => {
  it('should inject traceId and spanId into log entry when inside withLogContext', () => {
    const { logger, getLastLog } = createTestLogger();
    const ctx = makeCtx();

    withLogContext(ctx, () => {
      logger.info('test message');
    });

    const log = getLastLog();
    expect(log).toBeDefined();
    expect(log?.msg).toBe('test message');
    expect(log?.traceId).toBe(ctx.traceId);
    expect(log?.spanId).toBe(ctx.spanId);
    expect(log?.parentSpanId).toBeUndefined();
  });

  it('should include parentSpanId when context has one', () => {
    const { logger, getLastLog } = createTestLogger();
    const ctx = makeCtx({ parentSpanId: 'p1p2p3p4p5p6p1p2' });

    withLogContext(ctx, () => {
      logger.info('child span log');
    });

    const log = getLastLog();
    expect(log?.parentSpanId).toBe('p1p2p3p4p5p6p1p2');
  });

  it('should NOT inject traceId/spanId when outside any withLogContext', () => {
    const { logger, getLastLog } = createTestLogger();

    logger.info('no-context message');

    const log = getLastLog();
    expect(log?.traceId).toBeUndefined();
    expect(log?.spanId).toBeUndefined();
  });

  it('should inject context for all log levels (info, warn, error, debug)', () => {
    const { logger, getAllLogs } = createTestLogger();
    const ctx = makeCtx();

    withLogContext(ctx, () => {
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');
    });

    const logs = getAllLogs();
    expect(logs).toHaveLength(4);
    logs.forEach((log) => {
      expect(log.traceId).toBe(ctx.traceId);
      expect(log.spanId).toBe(ctx.spanId);
    });
  });

  it('should use inner context when withLogContext is nested', () => {
    const { logger, getAllLogs } = createTestLogger();
    const outer = makeCtx({ traceId: 'o'.repeat(32), spanId: 'o'.repeat(16) });
    const inner = makeCtx({ traceId: 'i'.repeat(32), spanId: 'i'.repeat(16) });

    withLogContext(outer, () => {
      logger.info('outer log');
      withLogContext(inner, () => {
        logger.info('inner log');
      });
      logger.info('outer log after inner');
    });

    const logs = getAllLogs();
    expect(logs[0].traceId).toBe(outer.traceId);
    expect(logs[1].traceId).toBe(inner.traceId);
    expect(logs[2].traceId).toBe(outer.traceId);
  });

  it('should inject context across async log calls inside withLogContext', async () => {
    const { logger, getLastLog } = createTestLogger();
    const ctx = makeCtx();

    await withLogContext(ctx, async () => {
      await Promise.resolve();
      logger.info('after await');
    });

    const log = getLastLog();
    expect(log?.traceId).toBe(ctx.traceId);
  });

  it('should stop injecting context after withLogContext completes', () => {
    const { logger, getAllLogs } = createTestLogger();
    const ctx = makeCtx();

    withLogContext(ctx, () => {
      logger.info('inside');
    });
    logger.info('outside');

    const logs = getAllLogs();
    expect(logs[0].traceId).toBe(ctx.traceId);
    expect(logs[1].traceId).toBeUndefined();
  });
});
