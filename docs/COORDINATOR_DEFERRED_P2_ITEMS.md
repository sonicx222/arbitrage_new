# Coordinator Deep Analysis — Deferred P2 Items

**Source**: `docs/reports/DEEP_ANALYSIS_COORDINATOR_V2_2026-03-15.md`
**Date**: 2026-03-15
**Status**: Deferred — requires design decisions or complex redesign

---

## Redis Rate Limiter

### P2-9: INCR/PEXPIRE race condition in RedisRateLimitStore
- **File**: `services/coordinator/src/api/middleware/rate-limit-store.ts`
- **Issue**: Separate `INCR` + `PEXPIRE` commands create a window where the key could exist without a TTL if Redis crashes between the two calls, leading to a permanently incrementing counter that never resets.
- **Fix**: Replace with a Lua script that atomically increments and sets expiry, or use Redis `SET ... EX ... NX` + `INCR` pattern.
- **Complexity**: Medium — requires Lua script or Redis transaction redesign.
- **Risk if unfixed**: Rate limiter key persists forever on rare Redis crash timing. Low probability, medium impact.

### P2-11: Batch requests bypass per-endpoint rate limiter
- **File**: `services/coordinator/src/api/middleware/rate-limit-store.ts`
- **Issue**: A single HTTP request containing N operations counts as 1 hit against the rate limiter, not N. An attacker could bundle many operations into one request to bypass limits.
- **Fix**: Implement request-weight-based rate limiting (count operations per request, not requests).
- **Complexity**: Medium — requires API design decision on how to weight different request types.
- **Risk if unfixed**: Rate limiting is less effective for batch-style endpoints. Low severity for internal-only APIs.

### P2-26: Hardcoded rate limit configuration
- **File**: `services/coordinator/src/api/middleware/rate-limit-store.ts`
- **Issue**: Rate limit windows and max-hits are hardcoded rather than configurable via env vars or config.
- **Fix**: Extract to `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX_HITS` env vars with sensible defaults.
- **Complexity**: Low — straightforward config externalization.
- **Risk if unfixed**: Requires code change to adjust rate limits per environment. Low impact.

## Stream Processing

### P2-10: Startup grace period mismatch (120s vs 180s)
- **File**: `services/coordinator/src/coordinator.ts`
- **Issue**: Rate limiter startup grace is 120s but stream consumers take up to 180s to stabilize. During the 120-180s window, legitimate traffic could be rate-limited.
- **Fix**: Align grace periods or make configurable. Requires operational testing to determine correct value.
- **Complexity**: Low — but needs operational validation.
- **Risk if unfixed**: Brief window of false rate limiting during cold starts. Low impact.

### P2-12: XLEN starvation under backpressure
- **File**: `services/coordinator/src/streaming/stream-handlers.ts`
- **Issue**: Under heavy backpressure, `XLEN` polling can starve actual message processing because both compete for the same Redis connection.
- **Fix**: Use a dedicated Redis connection for monitoring commands, or implement adaptive polling that backs off under load.
- **Complexity**: High — requires consumer group architecture changes or connection pool separation.
- **Risk if unfixed**: Monitoring becomes unreliable under the exact conditions where it's most needed. Medium impact.

## API & Client

### P2-14: OpportunityClient has no health check
- **File**: `services/coordinator/src/streaming/opportunity-client.ts`
- **Issue**: The SSE client that forwards opportunities to the execution engine has no health check or circuit breaker. If the execution engine is down, the coordinator keeps sending into the void.
- **Fix**: Add health check ping + circuit breaker pattern to the opportunity client.
- **Complexity**: Medium — cross-service client design change.
- **Risk if unfixed**: Wasted resources sending to a dead endpoint. Opportunities are still persisted in Redis, so no data loss.

### P2-15: RATE_LIMIT_STORE env var undocumented
- **File**: `docs/CONFIGURATION.md`
- **Issue**: The `RATE_LIMIT_STORE` env var (selects memory vs Redis backing store) is not documented in the configuration reference.
- **Fix**: Add to `docs/CONFIGURATION.md` with description, valid values, and default.
- **Complexity**: Low.
- **Risk if unfixed**: Operators may not know Redis-backed rate limiting is available. Low impact.

## Error Handling

### P2-16: Silent catch blocks in SSE routes
- **File**: `services/coordinator/src/api/routes/sse.routes.ts`
- **Issue**: Several catch blocks swallow errors silently (empty catch or catch-and-ignore) in SSE event handlers.
- **Fix**: Add at minimum `logger.debug()` logging in catch blocks, or re-throw where appropriate.
- **Complexity**: Low — but requires decision on error handling philosophy (log vs propagate vs ignore for SSE disconnections).
- **Risk if unfixed**: Debugging SSE issues becomes harder. Low operational impact since SSE is best-effort.

## Mock & Test Completeness

### P2-20 (extended): Additional RedisStreamsClient mock gaps
- **File**: `services/coordinator/__tests__/unit/coordinator.test.ts`
- **Issue**: Beyond the 6 methods added in Fix #20, there are additional methods like `xinfo`, `xrange`, `xrevrange` that are not mocked.
- **Fix**: Add remaining mock methods as tests are written that exercise those paths.
- **Complexity**: Low per method, but diminishing returns — only add as needed.
- **Risk if unfixed**: Tests that exercise these paths would fail with "not a function". Low risk since no current tests call them.

### P2-23: Mock doesn't validate Redis stream message format
- **File**: `services/coordinator/__tests__/unit/coordinator.test.ts`
- **Issue**: Mock Redis streams return pre-parsed objects rather than the actual Redis wire format (arrays of arrays with string-encoded values).
- **Fix**: Create a `createRealisticStreamMessage()` helper that produces wire-format messages, ensuring type-guard functions are exercised end-to-end.
- **Complexity**: Medium — requires understanding Redis stream wire format and updating all stream-consuming tests.
- **Risk if unfixed**: Type-guard edge cases (string-encoded numbers/booleans) may not be caught by tests. Partially mitigated by dedicated type-guard unit tests.

### P2-25: Full sort() in admission shedding gate
- **File**: `services/coordinator/src/opportunities/opportunity-router.ts:1001`
- **Issue**: `Array.sort()` is O(n log n) when only top-K items are needed for admission. `findKLargest` exists in codebase with O(n log k) complexity.
- **Fix**: Replace `.sort().slice(0, limit)` with `findKLargest(candidates, limit, compareFn)`.
- **Complexity**: Low code change, but shed metric tracking (lines 1011-1024) needs scores of ALL candidates (not just admitted ones), requiring restructuring.
- **Risk if unfixed**: Negligible — typical batch size is ~200 items where sort vs partial-sort difference is microseconds. Not a hot-path bottleneck.
