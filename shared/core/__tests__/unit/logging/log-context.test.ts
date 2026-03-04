/**
 * Unit tests for AsyncLocalStorage-based log context (log-context.ts)
 *
 * Tests cover:
 * - withLogContext / getLogContext core behavior
 * - Async boundary persistence
 * - Nested context shadowing
 * - Exception safety (no context leak on throw)
 * - Concurrency isolation (independent async chains)
 *
 * @see docs/reports/LOGGING_OPTIMIZATION_2026-03-04.md — Task 3
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { withLogContext, getLogContext, resetLogContext } from '../../../src/logging/log-context';
import type { TraceContext } from '../../../src/tracing/trace-context';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<TraceContext>): TraceContext {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    serviceName: 'test-service',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeChildCtx(parentSpanId: string): TraceContext {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'c'.repeat(16),
    parentSpanId,
    serviceName: 'child-service',
    timestamp: Date.now(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('getLogContext', () => {
  it('should return undefined when called outside any withLogContext', () => {
    expect(getLogContext()).toBeUndefined();
  });

  it('should return the active TraceContext when called inside withLogContext', () => {
    const ctx = makeCtx();
    let captured: TraceContext | undefined;

    withLogContext(ctx, () => {
      captured = getLogContext();
    });

    expect(captured).toBe(ctx);
  });

  it('should return undefined after withLogContext fn completes', () => {
    const ctx = makeCtx();
    withLogContext(ctx, () => { /* noop */ });
    expect(getLogContext()).toBeUndefined();
  });
});

describe('withLogContext', () => {
  it('should return the value returned by fn (sync)', () => {
    const ctx = makeCtx();
    const result = withLogContext(ctx, () => 42);
    expect(result).toBe(42);
  });

  it('should return the promise returned by async fn', async () => {
    const ctx = makeCtx();
    const result = await withLogContext(ctx, async () => 'async-value');
    expect(result).toBe('async-value');
  });

  it('should persist context across await boundaries', async () => {
    const ctx = makeCtx();
    let capturedBefore: TraceContext | undefined;
    let capturedAfter: TraceContext | undefined;

    await withLogContext(ctx, async () => {
      capturedBefore = getLogContext();
      await Promise.resolve(); // cross an async boundary
      capturedAfter = getLogContext();
    });

    expect(capturedBefore).toBe(ctx);
    expect(capturedAfter).toBe(ctx);
  });

  it('should persist context across multiple await boundaries', async () => {
    const ctx = makeCtx();
    const snapshots: (TraceContext | undefined)[] = [];

    await withLogContext(ctx, async () => {
      snapshots.push(getLogContext());
      await Promise.resolve();
      snapshots.push(getLogContext());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      snapshots.push(getLogContext());
    });

    expect(snapshots).toHaveLength(3);
    snapshots.forEach((s) => expect(s).toBe(ctx));
  });

  it('should shadow outer context with inner context when nested', () => {
    const outer = makeCtx({ traceId: 'o'.repeat(32) });
    const inner = makeChildCtx('b'.repeat(16));
    let capturedInner: TraceContext | undefined;
    let capturedAfterInner: TraceContext | undefined;

    withLogContext(outer, () => {
      withLogContext(inner, () => {
        capturedInner = getLogContext();
      });
      capturedAfterInner = getLogContext();
    });

    expect(capturedInner).toBe(inner);
    expect(capturedAfterInner).toBe(outer);
  });

  it('should restore context to undefined after nested withLogContext completes', () => {
    const ctx = makeCtx();
    withLogContext(ctx, () => { /* noop */ });
    expect(getLogContext()).toBeUndefined();
  });

  it('should NOT leak context when fn throws synchronously', () => {
    const ctx = makeCtx();

    expect(() => {
      withLogContext(ctx, () => {
        throw new Error('sync error');
      });
    }).toThrow('sync error');

    // Context must not be set after throw
    expect(getLogContext()).toBeUndefined();
  });

  it('should NOT leak context when fn rejects (async throw)', async () => {
    const ctx = makeCtx();

    await expect(
      withLogContext(ctx, async () => {
        await Promise.resolve();
        throw new Error('async error');
      })
    ).rejects.toThrow('async error');

    expect(getLogContext()).toBeUndefined();
  });
});

describe('withLogContext — concurrency isolation', () => {
  it('should isolate ALS contexts across independent concurrent async chains', async () => {
    const ctxA = makeCtx({ traceId: 'a'.repeat(32), spanId: 'a'.repeat(16) });
    const ctxB = makeCtx({ traceId: 'b'.repeat(32), spanId: 'b'.repeat(16) });

    const snapshots: { chain: string; ctx: TraceContext | undefined }[] = [];

    // Launch two interleaved async chains simultaneously
    await Promise.all([
      withLogContext(ctxA, async () => {
        snapshots.push({ chain: 'A-before', ctx: getLogContext() });
        await Promise.resolve();
        snapshots.push({ chain: 'A-after', ctx: getLogContext() });
      }),
      withLogContext(ctxB, async () => {
        snapshots.push({ chain: 'B-before', ctx: getLogContext() });
        await Promise.resolve();
        snapshots.push({ chain: 'B-after', ctx: getLogContext() });
      }),
    ]);

    const aSnaps = snapshots.filter((s) => s.chain.startsWith('A'));
    const bSnaps = snapshots.filter((s) => s.chain.startsWith('B'));

    aSnaps.forEach((s) => expect(s.ctx).toBe(ctxA));
    bSnaps.forEach((s) => expect(s.ctx).toBe(ctxB));
  });
});

describe('resetLogContext', () => {
  it('should be callable without error (test-symmetry export)', () => {
    expect(() => resetLogContext()).not.toThrow();
  });

  it('should not affect active ALS context (noop)', () => {
    const ctx = makeCtx();
    withLogContext(ctx, () => {
      resetLogContext();
      // Context should still be active after noop reset
      expect(getLogContext()).toBe(ctx);
    });
  });
});

describe('TraceContext field completeness', () => {
  it('should carry parentSpanId when present', () => {
    const ctx = makeChildCtx('p'.repeat(16));
    let captured: TraceContext | undefined;

    withLogContext(ctx, () => {
      captured = getLogContext();
    });

    expect(captured?.parentSpanId).toBe('p'.repeat(16));
  });

  it('should not have parentSpanId when root context', () => {
    const ctx = makeCtx(); // no parentSpanId
    let captured: TraceContext | undefined;

    withLogContext(ctx, () => {
      captured = getLogContext();
    });

    expect(captured?.parentSpanId).toBeUndefined();
  });
});
