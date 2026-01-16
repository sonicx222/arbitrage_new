# ADR-012: Worker Thread Multi-Leg Path Finding

## Status

**Accepted** - 2026-01-16

## Context

The Multi-Leg Path Finder (`multi-leg-path-finder.ts`) uses a DFS (Depth-First Search) algorithm to discover arbitrage opportunities with 5-7 token paths. While effective, this computation has several characteristics that make it problematic for the main Node.js event loop:

1. **CPU-Intensive**: Worst-case complexity of O(15^7) recursive calls for maximum branching
2. **Event Loop Blocking**: No `setImmediate()` yields between iterations
3. **WebSocket Impact**: Heavy computation can delay heartbeats and event processing
4. **Unpredictable Duration**: Processing time varies significantly based on pool graph density

### Observed Issues

- Event loop latency spikes during multi-leg detection
- WebSocket connection staleness during heavy path finding
- Potential missed opportunities on fast-moving chains (Arbitrum, Base)

### Existing Infrastructure

The codebase already has a worker thread infrastructure:
- `shared/core/src/worker-pool.ts`: `EventProcessingWorkerPool` class with priority queue, task timeout, and worker lifecycle management
- `shared/core/src/event-processor-worker.ts`: Worker thread message handler

## Decision

Offload Multi-Leg Path Finding to worker threads using the existing `EventProcessingWorkerPool` infrastructure.

### Implementation

#### 1. New Task Type Registration

**Files Modified**:
- `worker-pool.ts` (lines 512-514)
- `event-processor-worker.ts` (lines 217-219)

Added `multi_leg_path_finding` task type to both worker implementations:

```typescript
case 'multi_leg_path_finding':
  result = await processMultiLegPathFinding(taskData);
  break;
```

#### 2. Task Processing Function

**Files Modified**:
- `worker-pool.ts` (lines 598-629)
- `event-processor-worker.ts` (lines 154-184)

```typescript
async function processMultiLegPathFinding(data: any): Promise<any> {
  const { chain, pools, baseTokens, targetPathLength, config } = data;

  const { MultiLegPathFinder } = await import('./multi-leg-path-finder');
  const pathFinder = new MultiLegPathFinder(config || {});

  const opportunities = await pathFinder.findMultiLegOpportunities(
    chain, pools, baseTokens, targetPathLength
  );

  return { opportunities, stats: { pathsExplored, processingTimeMs } };
}
```

#### 3. Async Method in MultiLegPathFinder

**File Modified**: `multi-leg-path-finder.ts` (lines 845-910)

Added `findMultiLegOpportunitiesAsync()` method that:
1. Lazy-loads worker pool to avoid circular dependencies
2. Falls back to synchronous execution if worker pool unhealthy
3. Updates local stats from worker results
4. Handles task errors gracefully with fallback

```typescript
async findMultiLegOpportunitiesAsync(
  chain: string,
  pools: DexPool[],
  baseTokens: string[],
  targetPathLength: number,
  workerPool?: any
): Promise<MultiLegOpportunity[]>
```

### Task Data Format

```typescript
{
  id: `multi_leg_${chain}_${timestamp}_${random}`,
  type: 'multi_leg_path_finding',
  data: {
    chain: string,
    pools: DexPool[],
    baseTokens: string[],
    targetPathLength: number,
    config: MultiLegPathConfig
  },
  priority: 5,
  timeout: config.timeoutMs + 1000
}
```

### Fallback Strategy

If worker pool is unavailable (not started, unhealthy, or errors), the async method automatically falls back to synchronous execution:

1. **Pool Not Healthy**: Immediate fallback with warning log
2. **Task Failure**: Fallback with warning log
3. **Task Exception**: Fallback with error log

This ensures detection continues even during infrastructure issues.

## Rationale

### Why Worker Threads (Not Process Fork)?

| Factor | Worker Thread | Child Process |
|--------|--------------|---------------|
| Memory sharing | SharedArrayBuffer possible | Copy-on-write |
| Startup time | ~5ms | ~50ms |
| Communication | Message passing (fast) | IPC (slower) |
| Module caching | Shared | Separate |

### Why Not Rust/WASM Yet?

Per analysis in `detector_analysis.md.resolved`:
1. Worker Thread optimization hasn't been tried yet
2. Should measure actual bottleneck before adding language complexity
3. Node.js with Worker Threads may be "good enough" for current scale
4. **Trigger for Rust**: PathFinder >500ms even with Worker Threads

### Why Existing Worker Pool?

1. **Already Tested**: Pool has 9+ passing tests for core functionality
2. **Features**: Priority queue, timeout handling, worker restart on crash
3. **No New Dependencies**: Reuses existing `worker_threads` infrastructure
4. **Consistent Pattern**: Same architecture as other parallel tasks

## Consequences

### Positive

- **Event Loop Protection**: DFS execution isolated from main thread
- **WebSocket Stability**: Heartbeats and event processing continue during computation
- **Graceful Degradation**: Falls back to sync if workers unavailable
- **Scalable**: Can adjust `poolSize` based on available CPU cores
- **Stats Preservation**: Worker results update singleton stats for monitoring

### Negative

- **Serialization Overhead**: `DexPool[]` must be serialized for worker transfer (~1-5ms for 100 pools)
- **Memory Duplication**: Each worker has its own copy of pool data
- **Complexity**: Dynamic import pattern required to avoid circular dependencies

### Mitigations

1. **Serialization**: Only serialize when using async method; sync path unaffected
2. **Memory**: Workers share code cache; only data is duplicated
3. **Complexity**: Encapsulated in `findMultiLegOpportunitiesAsync()`; existing sync API unchanged

## Testing

### New Test File

`shared/core/__tests__/unit/multi-leg-worker.test.ts` (10 tests)

Covers:
- Task type registration
- Error handling
- Result parity with synchronous method
- Data serialization
- Priority support
- Timeout handling
- Batch processing

### Regression Tests

`shared/core/__tests__/unit/tier3-optimizations.test.ts` (25 tests)

All existing Multi-Leg Path Finding tests continue to pass.

## Alternatives Considered

### Alternative 1: setImmediate() Yielding

Add `await new Promise(setImmediate)` in DFS loop.

**Rejected because**:
- Still blocks between yields
- Adds latency to path finding
- Doesn't isolate CPU-intensive work

### Alternative 2: New Worker Pool

Create dedicated `PathFindingWorkerPool` class.

**Rejected because**:
- Code duplication with existing pool
- More surface area to maintain
- Existing pool already tested

### Alternative 3: WASM Module

Move DFS to WebAssembly.

**Rejected because**:
- Premature optimization
- Adds build complexity
- Should try Worker Threads first

## References

- `detector_analysis.md.resolved`: External analysis recommending Worker Threads
- `shared/core/src/worker-pool.ts`: Existing worker pool implementation
- `shared/core/__tests__/unit/worker-pool.test.ts`: Worker pool tests
- ADR-006: Free Hosting (constrains solution to $0/month)

## Confidence Level

**95%** - Very high confidence based on:
- Reuses existing, tested infrastructure
- Follows established patterns in codebase
- Has fallback mechanism for reliability
- All tests pass (35 tests: 10 new + 25 existing)
