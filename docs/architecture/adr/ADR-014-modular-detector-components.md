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

## Implementation Details

### Files Created
- `services/unified-detector/src/chain-instance-manager.ts`
- `services/unified-detector/src/health-reporter.ts`
- `services/unified-detector/src/metrics-collector.ts`
- `services/unified-detector/src/__tests__/unit/chain-instance-manager.test.ts`
- `services/unified-detector/src/__tests__/unit/health-reporter.test.ts`
- `services/unified-detector/src/__tests__/unit/metrics-collector.test.ts`

### Files Modified
- `services/unified-detector/src/index.ts` - Added exports for new modules
- `services/unified-detector/src/unified-detector.ts` - Added imports (for future refactoring)

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

## Confidence Level
92% - High confidence because:
- Follows established patterns in codebase (factory functions, EventEmitter)
- Low risk approach (modules alongside existing code)
- All tests passing (159 tests for unified-detector)
- TypeScript types provide compile-time safety
