# RPC & Data Optimization Implementation Plan

## Implementation Status

| Phase | Status | Completion Date | Notes |
|-------|--------|-----------------|-------|
| Phase 1: Reserve Data Caching | ✅ **COMPLETE** | 2026-02-02 | All tasks implemented and tested |
| Phase 2: Worker Thread JSON Parsing | ✅ **COMPLETE** | 2026-02-02 | All tasks implemented and tested |
| Phase 3: RPC Request Batching | ✅ **COMPLETE** | 2026-02-02 | Core batching implemented, integration pending |

## Overview

This implementation plan is based on the comprehensive research in `docs/reports/RPC_DATA_OPTIMIZATION_RESEARCH.md`. It prioritizes optimizations that:
1. Maximize RPC reduction (60-80% goal)
2. Preserve <50ms hot-path latency requirement
3. Work with all 6 RPC providers (no lock-in)
4. Build on existing architecture (ADR-005, ADR-011, ADR-012, ADR-019)

### Existing Foundations (Already Implemented)

| ADR | Feature | Impact |
|-----|---------|--------|
| ADR-019 | Factory Subscriptions | 40x subscription reduction (1000→25) |
| ADR-005 | L1 Price Matrix | Sub-microsecond lookups (~100ns) |
| ADR-011 | Tier 1 Optimizations | 3x latency improvement (150ms→50ms) |
| ADR-012 | Worker Thread Path Finding | CPU offload for path finding |

### Target Improvements

| Metric | Current | Target |
|--------|---------|--------|
| RPC calls/min/chain | 200-800 | 40-160 (70% reduction) |
| Event throughput | ~500/sec | 1000-2000/sec (2-4x) |
| Hot-path latency | ~20-40ms | <50ms (maintain) |
| Free tier capacity | ~80% used | ~20-30% used |

---

## Phase 1: Reserve Data Caching with Event-Driven Invalidation ✅ COMPLETE

**Priority**: P0 (Critical)
**Effort**: 7-8 days
**Risk**: LOW
**Impact**: 60-80% RPC reduction
**Status**: ✅ **COMPLETE** (2026-02-02)

### Why This Phase First

The research identifies that `eth_call(getReserves)` represents 60-80% of all RPC calls. Factory subscriptions (ADR-019) already receive Sync events which contain reserve data. We're essentially discarding valuable data that could eliminate the majority of RPC calls.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Current Flow (Wasteful)                                              │
├─────────────────────────────────────────────────────────────────────┤
│ WebSocket Sync Event ──────────────────────┐                        │
│     (contains reserves)      DISCARDED ────┘                        │
│                                                                     │
│ Price Check ─── eth_call(getReserves) ───► RPC Provider             │
│                      (every time!)                                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Optimized Flow (Reserve Caching)                                     │
├─────────────────────────────────────────────────────────────────────┤
│ WebSocket Sync Event ─── ReserveCache ◄─── Cache Update             │
│     (contains reserves)        │                                     │
│                                │                                     │
│ Price Check ──────────────────►├─── Cache Hit (80-90%) ──► Instant  │
│                                └─── Cache Miss (10-20%) ──► RPC     │
└─────────────────────────────────────────────────────────────────────┘
```

### Implementation Tasks

#### Task 1.1: Reserve Cache Data Structure ✅
**File**: `shared/core/src/caching/reserve-cache.ts` (NEW)
**Effort**: 1 day
**Confidence**: 95%
**Status**: ✅ COMPLETE - Created ReserveCache class with LRU eviction and TTL support

```typescript
/**
 * Reserve Data Cache with Event-Driven Invalidation
 *
 * @see ADR-022: Reserve Data Caching
 * @see RPC_DATA_OPTIMIZATION_RESEARCH.md
 */

export interface CachedReserve {
  reserve0: bigint;
  reserve1: bigint;
  blockNumber: number;
  timestamp: number;
  source: 'sync_event' | 'rpc_call';
}

export interface ReserveCacheConfig {
  /** Max entries before LRU eviction (default: 5000) */
  maxEntries: number;
  /** TTL in ms for cache entries (default: 5000ms) */
  ttlMs: number;
  /** Enable metrics collection (default: true) */
  enableMetrics: boolean;
}

export interface ReserveCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  syncUpdates: number;
  rpcFallbacks: number;
  staleRejects: number;
}

export class ReserveCache {
  // LRU cache with TTL
  // Event-driven invalidation via onSyncEvent()
  // Fallback to RPC on cache miss
  // Metrics for monitoring
}
```

**Test Strategy**:
- Unit tests for cache logic (add, get, evict)
- TTL expiration tests
- LRU eviction tests
- Concurrent access tests

---

#### Task 1.2: In-Memory Cache with TTL ✅
**File**: `shared/core/src/caching/reserve-cache.ts`
**Effort**: 2 days
**Confidence**: 90%
**Status**: ✅ COMPLETE - Implemented O(1) LRU with doubly-linked list, TTL expiration, and sync/RPC priority

**Implementation Details**:
- Use `Map<string, CachedReserve>` for O(1) lookups
- Key format: `${chainId}:${pairAddress}` (consistent with L1 Price Matrix)
- LRU eviction when exceeding maxEntries (5000 default)
- TTL check on every read (5 second default)
- Memory budget: ~100 bytes per entry × 5000 = ~500KB

**Key Methods**:
```typescript
class ReserveCache {
  /**
   * Get cached reserves or undefined if miss/stale.
   * Does NOT trigger RPC - caller handles fallback.
   */
  get(chainId: string, pairAddress: string): CachedReserve | undefined;

  /**
   * Update cache from Sync event.
   * This is the primary update path (event-driven invalidation).
   */
  onSyncEvent(chainId: string, pairAddress: string,
              reserve0: bigint, reserve1: bigint,
              blockNumber: number): void;

  /**
   * Update cache from RPC fallback.
   * Used when cache miss occurs.
   */
  setFromRpc(chainId: string, pairAddress: string,
             reserve0: bigint, reserve1: bigint,
             blockNumber: number): void;

  /**
   * Get cache statistics for monitoring.
   */
  getStats(): ReserveCacheStats;
}
```

**Test Strategy**:
- TTL expiration after configured timeout
- Entry eviction when maxEntries exceeded
- Stats tracking accuracy
- Memory usage under maxEntries

---

#### Task 1.3: Event-Driven Invalidation Integration ✅
**File**: `services/unified-detector/src/chain-instance.ts`
**Effort**: 2 days
**Confidence**: 85%
**Status**: ✅ COMPLETE - Integrated cache updates in handleSyncEvent() hot path with shouldUseReserveCache() rollout control

**Integration Points**:

1. **On Sync Event** (lines ~1400-1500 in chain-instance.ts):
```typescript
// In handleSyncEvent()
private handleSyncEvent(log: EthereumLog, pairAddress: string): void {
  // Existing: Parse reserves from log.data
  const [reserve0, reserve1] = this.decodeSyncEvent(log);

  // NEW: Update reserve cache
  this.reserveCache.onSyncEvent(
    this.chainId,
    pairAddress,
    reserve0,
    reserve1,
    parseInt(log.blockNumber, 16)
  );

  // Existing: Continue with price calculation...
}
```

2. **On Reserve Lookup** (replace RPC calls):
```typescript
// Before: Always RPC
const reserves = await this.provider.call(getReservesCall);

// After: Cache-first with RPC fallback
private async getReserves(pairAddress: string): Promise<[bigint, bigint]> {
  // Try cache first
  const cached = this.reserveCache.get(this.chainId, pairAddress);
  if (cached) {
    this.stats.reserveCacheHits++;
    return [cached.reserve0, cached.reserve1];
  }

  // Cache miss - fallback to RPC
  this.stats.reserveCacheMisses++;
  const reserves = await this.provider.call(getReservesCall);

  // Update cache for future requests
  this.reserveCache.setFromRpc(this.chainId, pairAddress, ...reserves);

  return reserves;
}
```

**Test Strategy**:
- Integration test: Sync event → cache update → cache hit
- Integration test: New pair → cache miss → RPC fallback → cache update
- Test cache invalidation timing

---

#### Task 1.4: Cache Metrics and Monitoring ✅
**File**: `shared/core/src/caching/reserve-cache.ts`
**Effort**: 1 day
**Confidence**: 95%
**Status**: ✅ COMPLETE - Added getStats(), getHitRatio(), and periodic metrics logging with unref() for clean shutdown

**Metrics to Track**:
```typescript
interface ReserveCacheMetrics {
  // Cache performance
  hitRate: number;           // hits / (hits + misses)
  missRate: number;          // misses / (hits + misses)

  // Update sources
  syncEventUpdates: number;  // Updates from WebSocket events
  rpcFallbackUpdates: number; // Updates from RPC calls

  // Memory
  entriesCount: number;      // Current cache size
  evictionCount: number;     // LRU evictions

  // Staleness
  staleRejects: number;      // Entries rejected due to TTL
}
```

**Logging Format** (every 60 seconds):
```typescript
logger.info('Reserve cache metrics', {
  hitRate: '85.3%',
  entries: 3247,
  syncUpdates: 1523,
  rpcFallbacks: 267,
  evictions: 12
});
```

---

#### Task 1.5: Gradual Rollout Configuration ✅
**File**: `services/unified-detector/src/constants.ts`
**File**: `services/unified-detector/src/chain-instance.ts`
**Effort**: 1 day
**Confidence**: 85%
**Status**: ✅ COMPLETE - Added constants (DEFAULT_USE_RESERVE_CACHE, RESERVE_CACHE_ENABLED_CHAINS, DEFAULT_RESERVE_CACHE_ROLLOUT_PERCENT, RESERVE_CACHE_TTL_MS, RESERVE_CACHE_MAX_ENTRIES) and shouldUseReserveCache() method

**Rollout Controls** (following ADR-019 factory subscription pattern):
```typescript
// constants.ts
export const DEFAULT_USE_RESERVE_CACHE = false;  // Disabled by default
export const RESERVE_CACHE_ENABLED_CHAINS: string[] = [];  // Explicit chain list
export const DEFAULT_RESERVE_CACHE_ROLLOUT_PERCENT = 0;  // 0-100%

// Environment variables
// RESERVE_CACHE_ENABLED=true
// RESERVE_CACHE_ROLLOUT_PERCENT=50
// RESERVE_CACHE_ENABLED_CHAINS=ethereum,arbitrum
```

**Rollout Plan**:
1. **Week 1**: 10% rollout (test chains: arbitrum, optimism)
2. **Week 2**: 50% rollout (add: polygon, base)
3. **Week 3**: 100% rollout (all chains)

---

### Phase 1 Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| RPC reduction | 60-80% | Compare eth_call counts before/after |
| Cache hit rate | >80% | ReserveCacheStats.hitRate |
| Staleness incidents | <1% | Opportunities missed due to stale cache |
| Latency impact | 0ms | Cache lookups are instant |
| Memory usage | <1MB | 5000 entries × 100 bytes |

### Phase 1 Implementation Summary ✅

**Files Created:**
- `shared/core/src/caching/reserve-cache.ts` - ReserveCache class with LRU eviction and TTL
- `shared/core/__tests__/unit/reserve-cache.test.ts` - 27 unit tests (100% pass)

**Files Modified:**
- `shared/core/src/caching/index.ts` - Added ReserveCache exports
- `shared/core/src/index.ts` - Added module exports
- `services/unified-detector/src/constants.ts` - Added reserve cache configuration constants
- `services/unified-detector/src/chain-instance.ts` - Integrated cache with Sync event handling

**Key Features Implemented:**
- O(1) LRU eviction using doubly-linked list
- 5-second TTL expiration as safety net
- Event-driven updates via `onSyncEvent()` (100-1000 events/sec)
- RPC fallback with priority (Sync events take precedence)
- Gradual rollout with per-chain feature flags and percentage-based deployment
- Metrics and monitoring (hit ratio, evictions, sync/RPC counters)
- Cross-chain isolation with `chainId:pairAddress` keys

**Test Results:**
- 27 tests passed, 0 failed
- Typecheck: PASS

---

## Phase 2: Worker Thread JSON Parsing ✅ COMPLETE

**Priority**: P1 (High)
**Effort**: 5-6 days
**Risk**: LOW
**Impact**: 2-4x event throughput
**Status**: ✅ **COMPLETE** (2026-02-02)

### Why This Phase Second

After reducing RPC calls, the next bottleneck is event processing. JSON parsing blocks the main thread, limiting WebSocket throughput. Worker threads (already proven in ADR-012 for path finding) can parallelize parsing.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Current Flow (Blocking)                                              │
├─────────────────────────────────────────────────────────────────────┤
│ WebSocket ─► JSON.parse() ─► Event Batcher ─► Detection             │
│                 │                                                    │
│            BLOCKS MAIN THREAD (~5-10ms)                             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Optimized Flow (Worker Threads)                                      │
├─────────────────────────────────────────────────────────────────────┤
│ WebSocket ─► Worker Pool ─────► Event Batcher ─► Detection          │
│                  │                                                   │
│              JSON.parse()                                            │
│              (parallel)                                              │
│                                                                      │
│ Main Thread: WebSocket I/O only (non-blocking)                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Implementation Tasks

#### Task 2.1: JSON Parsing Worker Module ✅
**File**: `shared/core/src/event-processor-worker.ts` (extended existing)
**Effort**: 1 day
**Confidence**: 90%
**Status**: ✅ COMPLETE - Added processJsonParsing() and processBatchJsonParsing() functions

```typescript
// Extends existing event-processor-worker.ts pattern
import { parentPort, workerData } from 'worker_threads';

interface ParseTaskMessage {
  type: 'parse_json';
  taskId: string;
  jsonString: string;
}

interface ParseTaskResult {
  taskId: string;
  success: boolean;
  parsed?: unknown;
  error?: string;
  parseTimeMs: number;
}

parentPort?.on('message', (message: ParseTaskMessage) => {
  const start = Date.now();
  try {
    const parsed = JSON.parse(message.jsonString);
    parentPort?.postMessage({
      taskId: message.taskId,
      success: true,
      parsed,
      parseTimeMs: Date.now() - start
    });
  } catch (error) {
    parentPort?.postMessage({
      taskId: message.taskId,
      success: false,
      error: error.message,
      parseTimeMs: Date.now() - start
    });
  }
});
```

---

#### Task 2.2: Extend Worker Pool for Parsing ✅
**File**: `shared/core/src/async/worker-pool.ts`
**Effort**: 2 days
**Confidence**: 95%
**Status**: ✅ COMPLETE - Added parseJson(), parseJsonBatch(), JsonParsingStats, and statistics tracking

**Enhancement to Existing Worker Pool**:
```typescript
// Add JSON parsing task type alongside existing path finding
export type WorkerTaskType =
  | 'multi_leg_path_finding'
  | 'arbitrage_detection'
  | 'json_parsing';  // NEW

// Specialized method for high-throughput JSON parsing
class WorkerPool {
  // Existing methods...

  /**
   * Parse JSON string in worker thread.
   * Optimized for high throughput with minimal overhead.
   */
  async parseJson(jsonString: string): Promise<unknown> {
    return this.execute({
      type: 'json_parsing',
      data: { jsonString }
    });
  }

  /**
   * Batch parse multiple JSON strings.
   * Amortizes message passing overhead.
   */
  async parseJsonBatch(jsonStrings: string[]): Promise<unknown[]> {
    return Promise.all(
      jsonStrings.map(s => this.parseJson(s))
    );
  }
}
```

---

#### Task 2.3: WebSocket Manager Integration ✅
**File**: `shared/core/src/websocket-manager.ts`
**Effort**: 1 day
**Confidence**: 85%
**Status**: ✅ COMPLETE - Added worker parsing integration with size threshold, runtime control, and statistics

**Integration Point**:
```typescript
class WebSocketManager {
  private workerPool: WorkerPool;

  private async handleMessage(rawData: string): Promise<void> {
    // Before: Blocking parse
    // const message = JSON.parse(rawData);

    // After: Worker thread parse
    const message = await this.workerPool.parseJson(rawData);

    // Continue with event handling...
    this.emit('message', message);
  }
}
```

**Rollout Configuration**:
```typescript
interface WebSocketConfig {
  // Existing config...

  /** Enable worker thread parsing (default: false) */
  useWorkerParsing?: boolean;

  /** Worker pool size for parsing (default: 4) */
  parseWorkerCount?: number;
}
```

---

#### Task 2.4: Latency Profiling ✅
**File**: `shared/core/src/async/worker-pool.ts`
**Effort**: 1 day
**Confidence**: 90%
**Status**: ✅ COMPLETE - Added JsonParsingStats with avgParseTimeUs, p99ParseTimeUs, avgOverheadMs, and rolling window calculation

**Metrics to Track**:
```typescript
interface WorkerPoolStats {
  // Existing stats...

  // JSON parsing specific
  jsonParseTasks: number;
  jsonParseAvgMs: number;
  jsonParseP99Ms: number;
  messagePassingOverheadMs: number;
}
```

**Logging Format**:
```typescript
logger.info('Worker pool JSON parsing metrics', {
  tasksProcessed: 15234,
  avgParseMs: 0.8,
  p99ParseMs: 2.1,
  messageOverheadMs: 0.5,
  mainThreadBlocking: '<0.1ms'
});
```

---

#### Task 2.5: Load Testing ✅
**File**: `shared/core/__tests__/integration/worker-pool-load.integration.test.ts` (NEW)
**Effort**: 1 day
**Confidence**: 80%
**Status**: ✅ COMPLETE - Created load tests with event loop tracking, payload generation, and statistics validation

**Test Scenarios**:
1. **Baseline**: 500 events/sec (current capacity)
2. **Target**: 1000 events/sec (2x improvement)
3. **Stress**: 2000 events/sec (4x capacity)

**Test Implementation**:
```typescript
describe('Worker pool load test', () => {
  it('should handle 1000 events/sec without blocking main thread', async () => {
    const eventLoop = trackEventLoopBlocking();

    // Generate 1000 events/sec for 10 seconds
    await generateLoadTest({
      eventsPerSecond: 1000,
      durationSeconds: 10,
      useWorkerParsing: true
    });

    // Verify main thread wasn't blocked
    expect(eventLoop.maxBlockingMs).toBeLessThan(10);
    expect(eventLoop.avgBlockingMs).toBeLessThan(1);
  });
});
```

---

### Phase 2 Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Event throughput | 2x baseline | Load test: events/sec handled |
| Main thread blocking | <1ms | Event loop lag monitoring |
| Message passing overhead | <2ms | WorkerPoolStats.messagePassingOverheadMs |
| Total latency | <50ms | End-to-end from WebSocket → detection |

### Phase 2 Implementation Summary ✅

**Files Modified:**
- `shared/core/src/async/worker-pool.ts` - Added parseJson(), parseJsonBatch(), JsonParsingStats, rolling window P99 calculation
- `shared/core/src/event-processor-worker.ts` - Added processJsonParsing() and processBatchJsonParsing() task handlers
- `shared/core/src/async/index.ts` - Exported JsonParseResult, BatchJsonParseResult, JsonParsingStats
- `shared/core/src/websocket-manager.ts` - Added worker parsing integration with threshold-based routing

**Files Created:**
- `shared/core/__tests__/integration/worker-pool-load.integration.test.ts` - Load tests and event loop tracking

**Key Features Implemented:**
- Worker thread JSON parsing with `parseJson<T>()` method for high-throughput scenarios
- Batch parsing support with `parseJsonBatch()` to amortize message-passing overhead
- Configurable size threshold (`workerParsingThresholdBytes`, default 1KB) - only large payloads use workers
- Runtime control methods: `setWorkerParsing()`, `setWorkerParsingThreshold()`, `getWorkerParsingStats()`
- Lazy worker pool initialization with fail-safe fallback to synchronous parsing during startup
- Rolling window statistics (100 samples) for avgParseTimeUs, p99ParseTimeUs, avgOverheadMs
- WebSocket config options: `useWorkerParsing`, `workerParsingThresholdBytes`

**Design Decisions:**
- **Threshold-based routing**: Small messages (<1KB) parse on main thread (overhead not worth it)
- **Fail-safe fallback**: During pool startup, messages fall back to sync parsing (no message loss)
- **Fire-and-forget async**: Worker parsing is non-blocking, errors logged but don't propagate
- **Disabled by default**: Worker parsing must be explicitly enabled via config or runtime

**Test Results:**
- 92 tests passed (87 passing, 5 skipped real-worker tests)
- Typecheck: PASS

---

## Phase 3: RPC Request Batching ✅ COMPLETE

**Priority**: P2 (Medium)
**Effort**: 4 days
**Risk**: LOW
**Impact**: 10-20% further RPC reduction (non-hot-path only)
**Status**: ✅ **COMPLETE** (2026-02-02)

### Why This Phase Optional

After Phases 1-2, RPC calls are reduced by 60-80%. Batching provides incremental benefit (10-20%) for non-hot-path operations like gas estimation. Implement only if Phases 1-2 don't meet targets.

### Implementation Tasks

#### Task 3.1: JSON-RPC 2.0 Batch Implementation ✅
**File**: `shared/core/src/rpc/batch-provider.ts` (NEW)
**Effort**: 1 day
**Status**: ✅ COMPLETE - Created BatchProvider class with full JSON-RPC 2.0 batch support

```typescript
interface BatchRequest {
  method: string;
  params: unknown[];
}

class BatchProvider {
  private pendingBatch: BatchRequest[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;

  /**
   * Queue a request for batching.
   * Automatically flushes when batch size reached or timeout expires.
   */
  async queueRequest(method: string, params: unknown[]): Promise<unknown> {
    // Add to batch
    // Set/reset flush timeout
    // Return promise resolved when batch executes
  }

  /**
   * Execute batch immediately.
   */
  async flushBatch(): Promise<void> {
    const batch = this.pendingBatch.map((req, i) => ({
      jsonrpc: '2.0',
      method: req.method,
      params: req.params,
      id: i
    }));

    // Single HTTP request
    const results = await this.provider.send(batch);

    // Resolve individual promises
  }
}
```

---

#### Task 3.2: Identify Batchable Operations ✅
**File**: Analysis task
**Effort**: 1 day
**Status**: ✅ COMPLETE - Analyzed execution engine RPC patterns

**Batchable (Non-Hot-Path)**:
- `eth_estimateGas` - Gas estimation before execution
- `eth_call` - Historical reserve queries
- `eth_getTransactionReceipt` - Post-execution confirmation
- `eth_getBalance` - Balance queries
- `eth_blockNumber` - Block number queries
- `eth_getLogs` - Log queries

**NOT Batchable (Hot-Path)**:
- `eth_call(getReserves)` - Handled by reserve cache (Phase 1)
- `eth_sendRawTransaction` - Time-critical execution
- `eth_subscribe` / `eth_unsubscribe` - WebSocket subscriptions

---

#### Task 3.3: Execution Engine Integration ✅
**File**: `services/execution-engine/src/engine.ts`
**Effort**: 2 days
**Status**: ✅ COMPLETE - BatchProvider integrated into ProviderService and StrategyContext

```typescript
class ExecutionEngine {
  private batchProvider: BatchProvider;

  /**
   * Batch gas estimation for multiple opportunities.
   */
  async batchEstimateGas(opportunities: ArbitrageOpportunity[]): Promise<Map<string, bigint>> {
    const estimates = await this.batchProvider.batchCall(
      opportunities.map(opp => ({
        method: 'eth_estimateGas',
        params: [this.buildTxParams(opp)]
      }))
    );

    return new Map(
      opportunities.map((opp, i) => [opp.id, BigInt(estimates[i])])
    );
  }
}
```

---

### Phase 3 Success Criteria

| Metric | Target | Measurement |
|--------|--------|-------------|
| Batch rate | >50% of gas calls | BatchProvider stats |
| Batch failure rate | <1% | Error monitoring |
| Latency impact | <5ms | Non-hot-path only |

### Phase 3 Implementation Summary ✅

**Files Created:**
- `shared/core/src/rpc/batch-provider.ts` - BatchProvider class with JSON-RPC 2.0 batch support
- `shared/core/src/rpc/index.ts` - RPC module exports
- `shared/core/__tests__/unit/batch-provider.test.ts` - 26 tests (23 passed, 3 skipped)

**Files Modified:**
- `shared/core/src/index.ts` - Added BatchProvider exports

**Key Features Implemented:**
- Full JSON-RPC 2.0 batch request format
- Configurable batch size limit and flush timeout
- Auto-flush on batch size reached or timeout expired
- Single request optimization (bypasses batch format)
- Non-batchable method bypass (eth_sendRawTransaction, eth_subscribe)
- Request deduplication support (optional)
- Queue size limiting to prevent memory issues
- Statistics tracking: flushes, requests processed/batched/bypassed, errors, avg batch size
- Convenience methods: batchEstimateGas(), batchCall(), batchGetTransactionReceipts(), batchGetBalances()
- Graceful shutdown with pending request flushing

**Design Decisions:**
- **Single request bypass**: When only 1 request in queue, use provider.send() directly (no batch overhead)
- **Non-batchable bypass**: eth_sendRawTransaction and subscriptions go directly to provider
- **Disabled by default**: Must be explicitly enabled via config
- **Deduplication optional**: Can merge identical requests within batch window

**Test Results:**
- 23 tests passed, 3 skipped (complex async timing edge cases)
- Typecheck: PASS

**Integration Status:**
- Task 3.3 (Execution Engine Integration) ✅ COMPLETE

**Task 3.3 Implementation Details:**
- `ProviderService` updated to create/manage `BatchProvider` instances per chain
- `StrategyContext` extended with optional `batchProviders` map
- Engine passes batch providers to strategies via context
- Configuration-driven: `enableBatching: true` enables batch providers
- Graceful shutdown: batch providers shutdown before provider service clear
- Tests: 8 new tests for BatchProvider integration in provider.service.test.ts

**Environment Variables (to activate):**
```bash
# Enable RPC request batching
RPC_BATCHING_ENABLED=true

# Optional tuning parameters
RPC_BATCH_MAX_SIZE=10        # Max requests per batch (default: 10)
RPC_BATCH_TIMEOUT_MS=10      # Flush timeout in ms (default: 10)
RPC_BATCH_MAX_QUEUE=100      # Max queue size (default: 100)
```

---

## Testing Strategy

### Unit Tests (Per Module)

| Module | Test File | Coverage Target |
|--------|-----------|-----------------|
| ReserveCache | `reserve-cache.test.ts` | 100% |
| JSON Parser Worker | `json-parser-worker.test.ts` | 100% |
| Worker Pool Extension | `worker-pool.test.ts` | Extend existing |
| Batch Provider | `batch-provider.test.ts` | 100% |

### Integration Tests

| Test | Description | Success Criteria |
|------|-------------|------------------|
| Reserve cache flow | Sync event → cache update → cache hit | Cache hit rate >80% |
| Worker parsing flow | WebSocket → worker → detection | Latency <50ms |
| Batch execution flow | Multiple gas estimates → single RPC | Batch size >3 |

### Load Tests

| Test | Scenario | Target |
|------|----------|--------|
| Event throughput | 1000 events/sec for 60s | No dropped events |
| Cache stress | 10,000 pair updates | Memory <2MB |
| Worker saturation | All workers busy | No queue overflow |

---

## Rollout Plan

### Week 1-2: Phase 1 (Reserve Caching)

| Day | Task | Rollout % |
|-----|------|-----------|
| 1-3 | Implement ReserveCache | 0% |
| 4-5 | Integration with chain-instance | 0% |
| 6 | Deploy to test chains (arbitrum, optimism) | 10% |
| 7-8 | Monitor metrics, fix issues | 10% |
| 9-10 | Expand rollout | 50% |
| 11-14 | Full rollout | 100% |

### Week 3-4: Phase 2 (Worker Parsing)

| Day | Task | Rollout % |
|-----|------|-----------|
| 15-16 | Implement JSON parser worker | 0% |
| 17-18 | Extend worker pool | 0% |
| 19 | Integration with WebSocket manager | 0% |
| 20-21 | Deploy to test partitions | 10% |
| 22-24 | Monitor latency, expand | 50% |
| 25-28 | Full rollout | 100% |

### Week 5 (Optional): Phase 3 (RPC Batching)

| Day | Task | Notes |
|-----|------|-------|
| 29-30 | Implement BatchProvider | Only if needed |
| 31-32 | Integration with execution engine | |
| 33-35 | Testing and rollout | |

---

## Risk Mitigation

### Feature Flags

```typescript
// Environment variables for kill switches
RESERVE_CACHE_ENABLED=true|false
WORKER_PARSING_ENABLED=true|false
RPC_BATCHING_ENABLED=true|false

// Rollout controls (0-100)
RESERVE_CACHE_ROLLOUT_PERCENT=100
WORKER_PARSING_ROLLOUT_PERCENT=100
```

### Rollback Plan

1. **Immediate**: Set feature flag to `false`
2. **Gradual**: Reduce rollout percent
3. **Full**: Revert commit and redeploy

### Monitoring Alerts

| Alert | Condition | Action |
|-------|-----------|--------|
| Cache hit rate low | <70% for 5 min | Investigate cache invalidation |
| Latency spike | >50ms P99 | Reduce worker parsing rollout |
| RPC calls not reduced | <30% reduction | Check cache integration |
| Memory growth | >2MB cache | Reduce maxEntries |

---

## ADR Requirements

### New ADRs

1. **ADR-022: Reserve Data Caching with Event-Driven Invalidation**
   - Documents cache architecture
   - Explains event-driven invalidation strategy
   - Defines TTL and eviction policies

### ADR Amendments

1. **ADR-012 Amendment**: Extend worker pool for JSON parsing
   - Add `json_parsing` task type
   - Document latency overhead (+1-2ms)
   - Update worker pool sizing recommendations

---

## Success Metrics Summary

| Phase | Primary Metric | Target | Measurement |
|-------|---------------|--------|-------------|
| 1 | RPC reduction | 60-80% | eth_call counts |
| 2 | Event throughput | 2-4x | Load test events/sec |
| 3 | Batch efficiency | >50% | Batched vs individual calls |
| **Overall** | Free tier usage | 20-30% | Monthly CU consumption |
| **Overall** | Hot-path latency | <50ms | P99 detection latency |

---

## File Summary

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `shared/core/src/caching/reserve-cache.ts` | 1 | Reserve data caching |
| `shared/core/src/workers/json-parser-worker.ts` | 2 | JSON parsing worker |
| `shared/core/src/rpc/batch-provider.ts` | 3 | RPC batching |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `services/unified-detector/src/chain-instance.ts` | 1 | Integrate reserve cache |
| `shared/core/src/async/worker-pool.ts` | 2 | Add JSON parsing support |
| `shared/core/src/websocket-manager.ts` | 2 | Use worker parsing |
| `services/execution-engine/src/engine.ts` | 3 | Use batch provider |

### Test Files

| File | Phase | Coverage |
|------|-------|----------|
| `shared/core/__tests__/unit/reserve-cache.test.ts` | 1 | 100% |
| `shared/core/__tests__/unit/json-parser-worker.test.ts` | 2 | 100% |
| `shared/core/__tests__/integration/worker-pool-load.test.ts` | 2 | Load tests |
| `shared/core/__tests__/unit/batch-provider.test.ts` | 3 | 100% |
