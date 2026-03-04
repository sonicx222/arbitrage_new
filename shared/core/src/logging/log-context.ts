/**
 * AsyncLocalStorage-based Log Context
 *
 * Provides automatic trace context propagation for Pino log entries.
 * When code runs inside `withLogContext(ctx, fn)`, the `mixin` function
 * in PinoLoggerWrapper reads the context via `getLogContext()` and injects
 * `traceId`/`spanId` into every log entry — no manual passing required.
 *
 * ALS overhead: ~1-3μs per `getStore()` call (negligible vs 300-800μs Pino call).
 * Pino does not call mixin for filtered-out log levels — hot-path safe.
 *
 * @see docs/reports/LOGGING_OPTIMIZATION_2026-03-04.md — Task 3
 * @see ADR-002: Redis Streams trace propagation
 * @see ADR-015: Pino logger (mixin injection point)
 * @module logging/log-context
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Minimal log context shape required by the Pino mixin.
 *
 * Intentionally does NOT include all TraceContext fields (serviceName, timestamp)
 * to keep the logging package decoupled from the tracing package.
 * A full TraceContext satisfies this interface structurally.
 *
 * Used at queue-boundary re-entry sites where only traceId/spanId are available
 * (e.g., execution-pipeline.ts restoring context from opportunity._traceId).
 */
export interface LogContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

// Module-level singleton — intentional (standard ALS pattern)
const logContextStore = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with `ctx` as the active log context.
 *
 * All Pino log calls made inside `fn` (including across `await` boundaries)
 * will automatically include `traceId`, `spanId`, and `parentSpanId` (if set).
 *
 * Contexts are automatically cleaned up when `fn` completes or throws.
 * Nested calls shadow the outer context for the duration of the inner `fn`.
 *
 * Accepts any object with `traceId` + `spanId` — a full TraceContext works too.
 *
 * @param ctx   - Context to bind for the duration of `fn`
 * @param fn    - Synchronous or async function to run within the context
 * @returns     The return value (or Promise) of `fn`
 *
 * @example
 * ```typescript
 * const traceCtx = extractContext(message) ?? createTraceContext('coordinator');
 * await withLogContext(traceCtx, async () => {
 *   // All log calls here automatically include traceId + spanId
 *   logger.info('Processing opportunity', { opportunityId });
 * });
 * ```
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return logContextStore.run(ctx, fn);
}

/**
 * Get the currently active log context, or `undefined` if outside any context.
 *
 * Called by the PinoLoggerWrapper `mixin` on every log call.
 * Returns `undefined` during startup, test code using RecordingLogger,
 * or any code path not wrapped in `withLogContext`.
 *
 * @returns Active LogContext or undefined
 */
export function getLogContext(): LogContext | undefined {
  return logContextStore.getStore();
}

/**
 * No-op reset for test symmetry with `resetLoggerCache()`.
 *
 * ALS contexts are automatically GC'd when async chains complete —
 * no explicit cleanup is needed. This function exists only for
 * consistent teardown patterns in test `afterEach()` blocks.
 */
export function resetLogContext(): void {
  // Intentional noop — ALS auto-cleans when async chains complete.
  // Provided for API symmetry with resetLoggerCache() in tests.
}
