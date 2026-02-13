# ADR-014: Modular Detector Components

## Status
**Accepted**

## Date
2026-01-18

## Context

The `UnifiedChainDetector` class grew to 689 lines with multiple responsibilities:
1. Chain instance lifecycle management (start/stop chain detectors)
2. Health monitoring and cross-region health reporting
3. Metrics collection and logging
4. Event routing between chain instances and consumers
5. Graceful degradation management
6. State management

This monolithic structure made the code:
- Difficult to test individual responsibilities in isolation
- Hard to scan for bugs due to mixed concerns
- Challenging to maintain as features are added
- Prone to coupling issues between unrelated functionality

Similarly, `CrossChainDetectorService` (1103 lines) had 10+ responsibilities.

## Decision

Extract three focused modules from `UnifiedChainDetector`:

### 1. ChainInstanceManager
**Purpose**: Manage chain detector instance lifecycle

**Responsibilities**:
- Starting all configured chain instances in parallel
- Stopping chain instances with timeout protection
- Event forwarding from chain instances (priceUpdate, opportunity, error)
- Registering chain capabilities with degradation manager
- Providing chain stats and healthy chain lists

**Interface**:
```typescript
interface ChainInstanceManager extends EventEmitter {
  startAll(): Promise<StartResult>;
  stopAll(): Promise<void>;
  getHealthyChains(): string[];
  getStats(): Map<string, ChainStats>;
  getChains(): string[];
  getChainInstance(chainId: string): ChainDetectorInstance | undefined;
}
```

### 2. HealthReporter
**Purpose**: Handle health monitoring and cross-region health reporting

**Responsibilities**:
- Initialize cross-region health manager
- Start periodic health check intervals
- Publish health data to Redis Streams
- Forward failover events

**Interface**:
```typescript
interface HealthReporter extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCrossRegionHealth(): CrossRegionHealthManager | null;
}
```

### 3. MetricsCollector
**Purpose**: Periodic metrics collection and logging

**Responsibilities**:
- Start/stop metrics collection interval
- Log health metrics via PerformanceLogger
- State-aware collection (skip when service stopping)

**Interface**:
```typescript
interface MetricsCollector {
  start(): void;
  stop(): void;
}
```

## Rationale

### Factory Functions over Classes
Used factory functions instead of classes because:
1. Easier dependency injection (no constructor parameter coupling)
2. Better encapsulation (private state in closure)
3. Cleaner interface (return interface type, hide implementation)
4. Consistent with existing patterns in shared/core/src/components/

### EventEmitter Composition
Used EventEmitter composition (extends/implements) for:
1. Loose coupling between modules and consumers
2. Consistent with existing detector patterns
3. Easy event forwarding without tight coupling

### Timeout Protection
Added timeout protection for stop operations:
1. Prevents indefinite hangs during shutdown
2. Consistent with P1-8 FIX pattern in existing code
3. Configurable per deployment environment

### Gradual Migration Strategy
Rather than rewriting UnifiedChainDetector:
1. Created modules as standalone components
2. Exported modules from index.ts for use by new code
3. Existing UnifiedChainDetector continues working unchanged
4. Future refactoring can incrementally adopt modules

This "strangler fig" pattern minimizes risk while enabling clean new code.

## Consequences

### Positive
- Individual responsibilities can be unit tested in isolation
- Easier to scan for bugs in focused, single-purpose modules
- New features can compose modules rather than extend monolithic class
- Clearer separation of concerns improves maintainability
- Factory functions enable cleaner dependency injection in tests

### Negative
- Additional module files to navigate
- Some code duplication until UnifiedChainDetector is fully refactored
- Existing consumers must import from new locations (though re-exports help)

### Neutral
- No change to external API of UnifiedChainDetector
- No change to behavior or performance
- Test coverage increased (new unit tests for modules)

## Alternatives Considered

### 1. Full Rewrite of UnifiedChainDetector
**Rejected** because:
- High risk of introducing regressions
- Would require updating all consumers
- Time-consuming validation of equivalent behavior

### 2. Mixin-based Decomposition
**Rejected** because:
- TypeScript mixins have complex type interactions
- Harder to test than pure functions
- Less common pattern in codebase

### 3. Class Inheritance Hierarchy
**Rejected** because:
- "Composition over inheritance" principle
- Inheritance creates tight coupling
- Factory functions are more flexible

## CrossChainDetectorService Modules

Similarly, `CrossChainDetectorService` (1103 lines) was modularized with three focused modules:

### 4. StreamConsumer
**Purpose**: Handle Redis Streams consumption

**Responsibilities**:
- Consuming price update streams
- Consuming whale alert streams
- Consumer group management
- Message validation and acknowledgment
- Concurrency guard to prevent overlapping stream reads

**Interface**:
```typescript
interface StreamConsumer extends EventEmitter {
  createConsumerGroups(): Promise<void>;
  start(): void;
  stop(): void;
}
```

### 5. PriceDataManager
**Purpose**: Manage price data storage and cleanup

**Responsibilities**:
- Storing price updates in hierarchical structure (chain/dex/pair)
- Cleaning old price data to prevent memory bloat
- Creating atomic snapshots for thread-safe detection
- Tracking chains being monitored

**Interface**:
```typescript
interface PriceDataManager {
  handlePriceUpdate(update: PriceUpdate): void;
  createSnapshot(): PriceData;
  createIndexedSnapshot(): IndexedSnapshot;
  getChains(): string[];
  getPairCount(): number;
  cleanup(): void;
  clear(): void;
}
```

### 6. OpportunityPublisher
**Purpose**: Publish cross-chain opportunities with deduplication

**Responsibilities**:
- Publishing opportunities to Redis Streams
- Deduplication within configurable time window
- Cache management with TTL and size limits
- Converting cross-chain opportunities to ArbitrageOpportunity format

**Interface**:
```typescript
interface OpportunityPublisher {
  publish(opportunity: CrossChainOpportunity): Promise<boolean>;
  getCacheSize(): number;
  cleanup(): void;
  clear(): void;
}
```

## Implementation Details

### UnifiedChainDetector Files Created
- `services/unified-detector/src/chain-instance-manager.ts`
- `services/unified-detector/src/health-reporter.ts`
- `services/unified-detector/src/metrics-collector.ts`
- `services/unified-detector/src/__tests__/unit/chain-instance-manager.test.ts`
- `services/unified-detector/src/__tests__/unit/health-reporter.test.ts`
- `services/unified-detector/src/__tests__/unit/metrics-collector.test.ts`

### CrossChainDetectorService Files Created
- `services/cross-chain-detector/src/stream-consumer.ts`
- `services/cross-chain-detector/src/price-data-manager.ts`
- `services/cross-chain-detector/src/opportunity-publisher.ts`
- `services/cross-chain-detector/src/__tests__/unit/stream-consumer.test.ts`
- `services/cross-chain-detector/src/__tests__/unit/price-data-manager.test.ts`
- `services/cross-chain-detector/src/__tests__/unit/opportunity-publisher.test.ts`

### Files Modified
- `services/unified-detector/src/index.ts` - Added exports for new modules
- `services/unified-detector/src/unified-detector.ts` - Added imports (for future refactoring)
- `services/cross-chain-detector/src/index.ts` - Added exports for new modules
- `services/cross-chain-detector/src/detector.ts` - Added concurrency guards (B1/B2 fixes)

### Usage Example
```typescript
import {
  createChainInstanceManager,
  createHealthReporter,
  createMetricsCollector,
} from '@arbitrage/unified-detector';

// Create modules with dependency injection
const chainManager = createChainInstanceManager({
  chains: ['ethereum', 'polygon'],
  partitionId: 'asia-fast',
  streamsClient,
  perfLogger,
  chainInstanceFactory: (cfg) => new ChainDetectorInstance(cfg),
  logger,
  degradationManager,
});

const healthReporter = createHealthReporter({
  partitionId: 'asia-fast',
  instanceId: 'detector-1',
  regionId: 'asia-southeast1',
  streamsClient,
  stateManager,
  logger,
  getHealthData: () => calculateHealth(),
  enableCrossRegionHealth: true,
});

const metricsCollector = createMetricsCollector({
  partitionId: 'asia-fast',
  perfLogger,
  stateManager,
  logger,
  getStats: () => getDetectorStats(),
});

// Use modules
await chainManager.startAll();
await healthReporter.start();
metricsCollector.start();
```

## References

- [ADR-003: Partitioned Chain Detectors](./ADR-003-partitioned-detectors.md)
- [ADR-007: Cross-Region Failover Strategy](./ADR-007-failover-strategy.md)
- [Modularization Enhancement Plan](./.claude/plans/modularization-enhancement-plan.md)

### CrossChainDetectorService Usage Example
```typescript
import {
  createStreamConsumer,
  createPriceDataManager,
  createOpportunityPublisher,
} from '@arbitrage/cross-chain-detector';

// Create modules with dependency injection
const streamConsumer = createStreamConsumer({
  instanceId: 'detector-1',
  streamsClient,
  stateManager,
  logger,
  consumerGroups: [
    { streamName: 'stream:price-updates', groupName: 'cross-chain-group', consumerName: 'consumer-1' },
  ],
});

const priceDataManager = createPriceDataManager({
  logger,
  cleanupFrequency: 100,
  maxPriceAgeMs: 5 * 60 * 1000,
});

const opportunityPublisher = createOpportunityPublisher({
  streamsClient,
  perfLogger,
  logger,
  dedupeWindowMs: 5000,
});

// Wire up event handling
streamConsumer.on('priceUpdate', (update) => {
  priceDataManager.handlePriceUpdate(update);
});

// Start consuming
await streamConsumer.createConsumerGroups();
streamConsumer.start();
```

## Phase 3 Enhancements

### 7. Shared Types Module (types.ts)
**Purpose**: Consolidate duplicate type definitions across modules

**Key Types**:
```typescript
// Logger interface for dependency injection
interface ModuleLogger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

// Price data storage structure
interface PriceData {
  [chain: string]: { [dex: string]: { [pairKey: string]: PriceUpdate } };
}

// Cross-chain opportunity with whale/ML fields
interface CrossChainOpportunity {
  // ... base fields ...
  whaleTriggered?: boolean;
  whaleTxHash?: string;
  whaleDirection?: 'bullish' | 'bearish' | 'neutral';
  mlConfidenceBoost?: number;
  mlSourceDirection?: 'up' | 'down' | 'sideways';
  mlTargetDirection?: 'up' | 'down' | 'sideways';
  mlSupported?: boolean;
}

// Indexed snapshot for O(1) token lookups
interface IndexedSnapshot {
  byToken: Map<string, PricePoint[]>;
  raw: PriceData;
  tokenPairs: string[];
  timestamp: number;
}

// Configuration types
interface DetectorConfig { /* ... */ }
interface WhaleAnalysisConfig { /* ... */ }
interface MLPredictionConfig { /* ... */ }
```

### 8. ML Prediction Integration
**Purpose**: Integrate LSTM price prediction into opportunity detection

**Features**:
- **Price History Caching**: Track recent prices per chain/pair for ML input
- **Prediction Caching**: Cache ML predictions with configurable TTL (default 1s)
- **Timeout Protection**: Skip ML predictions that exceed latency threshold (default 50ms)
- **Parallel Pre-fetching**: Fetch ML predictions for all token pairs before detection
- **Confidence Adjustment**: Boost confidence when ML predictions align with opportunity direction

**Configuration** (MLPredictionConfig):
```typescript
{
  enabled: boolean;        // Enable/disable ML (default: true)
  minConfidence: number;   // Minimum ML confidence to use (default: 0.6)
  alignedBoost: number;    // Confidence boost when aligned (default: 1.15)
  opposedPenalty: number;  // Confidence penalty when opposed (default: 0.9)
  maxLatencyMs: number;    // Skip if prediction takes longer (default: 50, FIX PERF-1)
  cacheTtlMs: number;      // Cache TTL in ms (default: 1000)
}
```

### 9. Performance Optimization: Token Pair Index (P1)
**Purpose**: Reduce O(n²) cross-chain iteration to O(n)

**Implementation**:
- `PriceDataManager.createIndexedSnapshot()` builds token pair index
- Index maps normalized token pairs to all price points
- Detection iterates token pairs once, comparing all price points per token
- Reduces complexity from O(chains² × dexes² × pairs²) to O(tokenPairs × pricesPerToken²)

### 10. Bridge Latency Predictor
**Purpose**: Predict cross-chain bridge times and costs using ML

**Features**:
- Statistical model updates from actual bridge completions
- Conservative estimates for new/unknown bridges
- Metrics caching for performance
- Optimal bridge selection based on urgency (low/medium/high)
- History management with 1000-entry cap and TTL cleanup

## Files Created/Modified (Phase 3)

### New Files
- `services/cross-chain-detector/src/types.ts` - Shared type definitions
- `services/cross-chain-detector/src/__tests__/integration/detector-integration.test.ts` - Integration tests

### Modified Files
- `services/cross-chain-detector/src/detector.ts`:
  - Added ML prediction caching and timeout protection
  - Added price history tracking
  - Updated confidence calculation with ML boost
  - Added DetectorConfig support
- `services/cross-chain-detector/src/price-data-manager.ts`:
  - Added `createIndexedSnapshot()` for O(1) token lookups
- `services/cross-chain-detector/src/bridge-predictor.ts`:
  - B4-FIX: Handle NaN when all bridges fail
  - WEIGHT-FIX: Correct exponential weighting (recent = higher)
  - KEY-FORMAT-FIX: Consistent bridge key format

## Test Coverage

| Component | Unit Tests | Integration Tests |
|-----------|------------|-------------------|
| StreamConsumer | 15 | - |
| PriceDataManager | 25 | - |
| OpportunityPublisher | 19 | - |
| BridgePredictor | 34 | - |
| BridgeCostEstimator | 19 | - |
| MLPredictionManager | 18 | - |
| Detector (main service) | 35+ | 19 |
| **Total** | **165+** | **19** |

*Note: Test counts updated 2026-01-20 to include circuit breaker, version counter, ETH price detection, and token normalization tests.*

### Regression Tests
- B1-FIX: Concurrent stream read prevention
- B2-FIX: Price guard in confidence calculation
- B4-FIX: NaN handling when all bridges fail
- WEIGHT-FIX: Exponential weight direction verification

## Future Considerations

### 11. ML Worker Thread Offloading (PERF-CONSIDERATION)

**Status**: Documented for future implementation if needed

**Problem**:
TensorFlow.js ML predictions run synchronously on the main Node.js event loop, which can block
opportunity detection when predictions take longer than expected. While the current implementation
mitigates this with timeout protection (50ms default), high-throughput scenarios may benefit from
true parallelism.

**Current Mitigation**:
```typescript
// MLPredictionManager uses Promise.race with timeout
const prediction = await Promise.race([
  mlPredictor.predictPrice(priceHistory, context),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), maxLatencyMs))
]);
```

**Benefits**: Simple, no additional complexity, graceful degradation (returns null on timeout)

**Limitation**: Prediction still blocks the event loop until timeout, consuming CPU time

**When to Consider Worker Threads**:
1. Detection interval < 50ms (high-frequency trading)
2. ML prediction consistently takes 30-50ms (saturating timeout)
3. Multiple price pairs need predictions simultaneously (CPU contention)
4. System CPU utilization > 70% during detection

**Worker Thread Implementation Guidance** (if needed):
```typescript
// worker-pool.ts
import { Worker } from 'worker_threads';

interface WorkerPool {
  predict(priceHistory: PriceHistory[], context: any): Promise<PredictionResult | null>;
  shutdown(): Promise<void>;
}

function createMLWorkerPool(config: { poolSize?: number; timeoutMs?: number }): WorkerPool {
  const poolSize = config.poolSize ?? 2; // Match CPU cores / 2
  const workers: Worker[] = [];

  // Initialize workers
  for (let i = 0; i < poolSize; i++) {
    workers.push(new Worker('./ml-worker.js'));
  }

  // Round-robin worker selection
  let nextWorker = 0;

  return {
    async predict(priceHistory, context) {
      const worker = workers[nextWorker++ % poolSize];

      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), config.timeoutMs ?? 50);

        worker.once('message', (result) => {
          clearTimeout(timeout);
          resolve(result);
        });

        worker.postMessage({ type: 'predict', priceHistory, context });
      });
    },

    async shutdown() {
      await Promise.all(workers.map(w => w.terminate()));
    }
  };
}

// ml-worker.js (separate file)
const { parentPort } = require('worker_threads');
const { getLSTMPredictor } = require('@arbitrage/ml');

const predictor = getLSTMPredictor();

parentPort.on('message', async (msg) => {
  if (msg.type === 'predict') {
    try {
      const result = await predictor.predictPrice(msg.priceHistory, msg.context);
      parentPort.postMessage(result);
    } catch (error) {
      parentPort.postMessage(null);
    }
  }
});
```

**Integration Points** (if implementing):
1. Replace `getLSTMPredictor()` calls with worker pool in `MLPredictionManager.initialize()`
2. Update `getCachedPrediction()` to use worker pool's `predict()` method
3. Add `shutdown()` call in `CrossChainDetectorService.stop()`
4. Add pool size and timeout to `MLPredictionConfig`

**Recommended Testing**:
1. Benchmark prediction latency before/after worker threads
2. Verify graceful degradation when workers are busy
3. Test worker crash recovery
4. Load test with 1000+ predictions/second

**Decision**: Defer implementation until benchmarks show event loop blocking is impacting detection accuracy. Current timeout-based approach provides adequate performance for 100ms detection intervals.

## Implementation Status (Updated 2026-02-13)

### Actual Module Structure

The CrossChainDetectorService has been decomposed into 10 source files (11 including types):

| Module | Lines | Purpose |
|--------|-------|---------|
| `detector.ts` | 2069 | Main service: lifecycle, detection loop, whale/pending analysis |
| `stream-consumer.ts` | 514 | Redis Streams consumption with consumer groups |
| `types.ts` | 485 | Shared type definitions (CrossChainOpportunity, DetectorConfig, etc.) |
| `ml-prediction-manager.ts` | 477 | ML prediction caching, timeout, and pre-fetching |
| `price-data-manager.ts` | 464 | Price storage, cleanup, indexed snapshots |
| `bridge-predictor.ts` | 561 | Bridge latency prediction using statistical models |
| `confidence-calculator.ts` | 349 | Composite confidence: price diff + age + ML + whale signals |
| `opportunity-publisher.ts` | 339 | Publish opportunities to Redis with deduplication |
| `pre-validation-orchestrator.ts` | 322 | Pre-validation pipeline (gas, liquidity, bridge) |
| `bridge-cost-estimator.ts` | 314 | Bridge cost estimation with ETH price tracking |
| `index.ts` | 149 | Re-exports for package consumers |

### Module Initialization Flow

```
CrossChainDetectorService.start()
  ├── Initialize Redis clients (redis, streamsClient)
  ├── Initialize PriceOracle
  ├── initializeModules()
  │   ├── createPriceDataManager({ logger, cleanupFrequency: 100, maxPriceAgeMs: 5min })
  │   ├── createOpportunityPublisher({ streamsClient, dedupeWindowMs: 5000 })
  │   ├── createBridgeCostEstimator({ logger })
  │   ├── createMLPredictionManager({ logger, mlConfig })
  │   ├── createStreamConsumer({ streamsClient, stateManager, consumerGroups })
  │   ├── PreValidationOrchestrator({ bridgeCostEstimator, logger })
  │   └── createConfidenceCalculator({ mlConfig, whaleConfig })
  ├── Wire event handlers (StreamConsumer events → detector methods)
  ├── startStreamConsumer()
  ├── startOpportunityDetection()  (periodic timer)
  ├── startHealthMonitoring()       (periodic timer)
  └── startEthPriceRefresh()        (periodic timer)
```

### Event Flow

```
Redis Streams
  ├── stream:price-updates → StreamConsumer → 'priceUpdate' event
  │     ├── PriceDataManager.handlePriceUpdate()
  │     ├── MLPredictionManager.trackPriceUpdate()
  │     └── maybeUpdateEthPrice() → BridgeCostEstimator.updateEthPrice()
  │
  ├── stream:whale-alerts → StreamConsumer → 'whaleTransaction' event
  │     └── detector.analyzeWhaleImpact()
  │           └── detector.detectWhaleInducedOpportunities()
  │                 └── OpportunityPublisher.publish()
  │
  └── stream:pending-opportunities → StreamConsumer → 'pendingSwap' event
        └── detector.analyzePendingOpportunity()
              └── OpportunityPublisher.publish()

Detection Cycle (every 100ms production / 200ms dev):
  1. PriceDataManager.createIndexedSnapshot()  (cached if unchanged)
  2. MLPredictionManager.prefetchPredictions()  (batch with timeout)
  3. findArbitrageInPrices()
  │   ├── Stale price rejection (maxPriceAgeMs, default 30s)
  │   ├── PreValidationOrchestrator.preValidate() (gas, liquidity, bridge)
  │   ├── ConfidenceCalculator.calculate() (base + age + ML + whale)
  │   └── BridgeCostEstimator.getDetailedEstimate()
  4. OpportunityPublisher.publish()  (with deduplication)
```

### Configuration Cascade

```
ARBITRAGE_CONFIG (global)
  └── CrossChainDetectorService constructor
        ├── DetectorConfig (merged with defaults)
        │   ├── detectionIntervalMs: 100 (prod) / 200 (dev)
        │   ├── healthCheckIntervalMs: 10000
        │   ├── maxPriceAgeMs: 30000 (hard staleness rejection)
        │   ├── minProfitabilityBps: 50
        │   └── crossChainEnabled: true
        ├── MLPredictionConfig → MLPredictionManager
        │   ├── enabled: true, minConfidence: 0.6
        │   ├── alignedBoost: 1.15, opposedPenalty: 0.9
        │   └── maxLatencyMs: 50, cacheTtlMs: 1000
        ├── WhaleAnalysisConfig → ConfidenceCalculator
        │   ├── whaleBullishBoost: 1.15, whaleBearishPenalty: 0.85
        │   └── superWhaleBoost: 1.25, significantFlowThresholdUsd: 100000
        └── PriceDataManagerConfig
            ├── cleanupFrequency: 100
            └── maxPriceAgeMs: 300000 (5 minutes, data cleanup)
```

### Module Error Handling

| Module | Error Strategy |
|--------|---------------|
| StreamConsumer | Logged + stream reading continues (resilient) |
| PriceDataManager | try/catch per update, logged, processing continues |
| OpportunityPublisher | Failed publishes logged, detection continues |
| MLPredictionManager | Timeout returns null, cache miss returns null, detection uses base confidence |
| BridgeCostEstimator | Failed estimates return conservative defaults |
| ConfidenceCalculator | Invalid prices return 0 (stateless, no side effects) |
| PreValidationOrchestrator | Validation failures skip opportunity (logged) |

### Remaining Decomposition Work

- **WhaleOpportunityDetector**: `analyzeWhaleImpact()` + `detectWhaleInducedOpportunities()` remain in detector.ts (~200 lines)
- **PendingOpportunityAnalyzer**: `analyzePendingOpportunity()` remains in detector.ts (~180 lines)
- These are the last two significant responsibilities in the main detector class beyond lifecycle management and the detection loop itself

### Test Coverage (Updated 2026-02-13)

| Component | Unit Tests | Integration Tests | Test File |
|-----------|------------|-------------------|-----------|
| StreamConsumer | 15 | - | stream-consumer.test.ts |
| PriceDataManager | 25 | - | price-data-manager.test.ts |
| OpportunityPublisher | 19 | - | opportunity-publisher.test.ts |
| BridgePredictor | 34 | - | bridge-predictor.test.ts |
| BridgeCostEstimator | 26 | - | bridge-cost-estimator.test.ts |
| MLPredictionManager | 19 | - | ml-prediction-manager.test.ts |
| ConfidenceCalculator | 43 | - | confidence-calculator.test.ts |
| Detector (lifecycle) | 28 | - | detector-lifecycle.test.ts |
| Detector (main) | 35+ | - | detector.test.ts |
| Detector (pending) | 10 | - | pending-opportunity.test.ts |
| Integration | - | 19 | detector-integration.integration.test.ts |
| **Total** | **250+** | **19** | **11 test files** |

## Confidence Level
95% - Very high confidence because:
- Follows established patterns in codebase (factory functions, EventEmitter)
- Low risk approach (modules alongside existing code)
- All tests passing (407 tests across 12 suites as of 2026-02-13)
- TypeScript types provide compile-time safety
- Bug fixes (B1/B2/B4) verified with regression tests
- ML integration has timeout protection to prevent latency impact
- Performance optimization (P1) reduces detection complexity
- Worker thread consideration documented for future scaling needs
