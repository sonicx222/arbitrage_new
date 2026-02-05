# Refactoring Implementation Plan

> **Generated:** 2026-02-04
> **Analysis Method:** Hybrid Top-Down/Bottom-Up with Sub-Agent Delegation
> **Total Codebase:** ~152K LOC across 9 services + 7 shared modules

---

## Executive Summary

This plan identifies **52 refactoring opportunities** across the arbitrage codebase, prioritized by impact, effort, and risk. The analysis found:

- **5 Critical God Classes** (1,800+ LOC each)
- **12 Long Methods** (>100 LOC each, 3 in hot-path)
- **3 Memory Leak Risks** (unbounded maps/caches)
- **8 Circular Dependency Risks**
- **~25% potential LOC reduction** through consolidation

### Key Constraints

> **HOT-PATH LATENCY TARGET: <50ms** (price-update -> detection -> execution)

The following modules are **latency-sensitive** and require extra scrutiny before refactoring:

| Module | Location | Latency Budget | Refactoring Constraint |
|--------|----------|----------------|------------------------|
| PriceMatrix | shared/core/src/caching/price-matrix.ts | <1ms | NO abstraction layers |
| Event Handlers | */handleWebSocketMessage, handleSyncEvent | <5ms | Benchmark before/after |
| Detection Loop | partitioned-detector, chain-instance | <10ms | Profile all extractions |
| Execution Engine | engine.ts:executeOpportunity | <20ms | NO extra function calls |

---

## Priority Matrix

| Priority | Impact | Effort | Risk | Count | Action |
|----------|--------|--------|------|-------|--------|
| **P0** | HIGH | LOW-MED | LOW | 8 | **Do immediately** (memory leaks, circular deps) |
| **P1** | HIGH | MEDIUM | MEDIUM | 12 | **Plan for next sprint** (god class decomposition) |
| **P2** | MEDIUM | LOW-MED | LOW | 18 | **Opportunistic** (code consolidation) |
| **P3** | LOW | LOW | LOW | 14 | **Tech debt backlog** |

---

## P0: Critical Issues (Fix Immediately)

### P0-1: Fix Unbounded `chainPrices` Map (Memory Leak)

**Location:** `shared/core/src/partitioned-detector.ts:183`

**Current State:**
```typescript
protected chainPrices: Map<string, Map<string, PricePoint>> = new Map();
// Structure: chainPrices[chain][pairKey] = {price, timestamp}
// No eviction policy -> grows unbounded
// 11 chains x 1000+ unique pairs x 8 bytes = 100MB+ over 24h
```

**Proposed Fix:**
```typescript
import { LRUCache } from './data-structures';

// Replace unbounded map with LRU cache per chain
protected chainPrices: Map<string, LRUCache<string, PricePoint>> = new Map();

// In constructor or init:
for (const chain of this.chains) {
  this.chainPrices.set(chain, new LRUCache<string, PricePoint>({ maxSize: 50000 }));
}
```

**Expected Improvement:**
- Memory: Bounded at ~50MB max
- Performance: O(1) access maintained

**Risk:** LOW
**Effort:** 0.5 days
**Test Impact:** Add memory growth test in partitioned-detector.test.ts

---

### P0-2: Fix Handler Accumulation in WebSocketManager

**Location:** `shared/core/src/websocket-manager.ts:808-845`

**Current State:**
```typescript
// Multiple handler sets without cleanup
private messageHandlers: Set<MessageHandler> = new Set();
private errorHandlers: Set<ErrorHandler> = new Set();
private connectionHandlers: Set<ConnectionHandler> = new Set();
// Handlers accumulate on reconnection without removeAllListeners()
```

**Proposed Fix:**
```typescript
private clearHandlers(): void {
  this.messageHandlers.clear();
  this.errorHandlers.clear();
  this.connectionHandlers.clear();
  this.eventHandlers.clear();
}

// Call before reconnection
async reconnect(): Promise<void> {
  this.clearHandlers();
  await this.connect();
}
```

**Risk:** LOW
**Effort:** 0.25 days
**Test Impact:** Add reconnection test verifying handler count

---

### P0-3: Remove Deprecated Legacy Health Polling

**Location:** `services/coordinator/src/coordinator.ts:1671-1690`

**Current State:**
```typescript
// DEPRECATED: Legacy health polling (75 lines)
// Marked for removal, still executing
if (this.config.enableLegacyHealthPolling) {
  // ... 20 lines of deprecated code
}
```

**Proposed Fix:** Delete lines 1671-1690 entirely

**Expected Improvement:**
- LOC: -75 lines
- Runtime: Removes unnecessary interval

**Risk:** LOW (code already marked deprecated)
**Effort:** 0.25 days
**Test Impact:** Remove deprecated test paths

---

### P0-4: Consolidate Alert Cooldown Storage (3 locations -> 1)

**Locations:**
- `services/coordinator/src/health-monitor.ts:109` - alertCooldowns Map
- `services/coordinator/src/cooldown-manager.ts:56` - localCooldowns Map
- `services/coordinator/src/coordinator.ts:1797-1805` - delegation layer

**Current State:** Alert cooldowns stored in 3 places with inconsistent state if delegate unavailable.

**Proposed Fix:**
1. Remove `localCooldowns` from AlertCooldownManager
2. Always use HealthMonitor as single source of truth
3. Remove delegation complexity

**Expected Improvement:**
- LOC: -60 lines
- Complexity: Remove 2-layer delegation

**Risk:** MEDIUM (requires careful testing of alert flow)
**Effort:** 1 day
**Test Impact:** Consolidate alert tests

---

### P0-5: Fix Circular Import in base-detector.ts

**Location:** `shared/core/src/base-detector.ts:43`

**Current State:**
```typescript
import { /* 30+ items */ } from './index';
// base-detector.ts is exported from index.ts
// Creates potential circular dependency
```

**Proposed Fix:**
```typescript
// Import directly from source modules instead of barrel
import { RedisClient, getRedisClient } from './redis';
import { WebSocketManager } from './websocket-manager';
// ... explicit imports
```

**Risk:** LOW
**Effort:** 0.5 days
**Test Impact:** None (import path changes only)

---

### P0-6: Break index.ts Barrel Export Anti-Pattern

**Location:** `shared/core/src/index.ts` (1,634 lines)

**Current State:** Single barrel export file with 100+ exports creates tight coupling.

**Proposed Fix:** Split into logical entry points:
```
shared/core/src/
├── index.ts           (20 lines - core APIs only)
├── internal/index.ts  (testing utilities)
├── detectors/index.ts (detector classes)
├── caching/index.ts   (cache implementations)
└── redis/index.ts     (Redis clients)
```

**Expected Improvement:**
- Tree-shaking: Enabled
- Build time: Faster
- Circular dep risk: Reduced

**Risk:** MEDIUM (requires updating all imports)
**Effort:** 2 days
**Test Impact:** Update import paths in tests

---

### P0-7: Fix Pre-validation Budget Fields Scattered in Detector

**Location:** `services/cross-chain-detector/src/detector.ts:249-254`

**Current State:**
```typescript
private preValidationBudgetUsed = 0;
private preValidationBudgetResetTime = 0;
private preValidationSuccessCount = 0;
private preValidationFailCount = 0;
private simulationCallback: PreValidationSimulationCallback | null = null;
// 5 fields + 140 LOC for pre-validation in main detector
```

**Proposed Fix:** Extract `PreValidationOrchestrator` class

**Expected Improvement:**
- Fields: 35 -> 30 (-14%)
- LOC: 2148 -> 2008 (-7%)

**Risk:** LOW (cross-cutting concern extraction)
**Effort:** 1.5 days
**Test Impact:** Add PreValidationOrchestrator.test.ts

---

### P0-8: Fix Duplicate Cache State (ChainInstance + SnapshotManager)

**Location:** `services/unified-detector/src/chain-instance.ts:308-317`

**Current State:**
```typescript
// ChainInstance maintains:
snapshotCache, dexPoolCache, snapshotVersion, dexPoolCacheVersion

// SnapshotManager also maintains identical cache state
// Both must be invalidated in handleSyncEvent (line 1570)
```

**Proposed Fix:** Unify cache state in SnapshotManager only

**Expected Improvement:**
- Duplicated code: 4 lines -> 1 line
- ChainInstance: -20 lines

**Risk:** LOW
**Effort:** 0.5 days
**Test Impact:** None (internal implementation)

---

## P1: High-Priority Refactorings (Next Sprint)

### P1-1: Extract EventProcessor from base-detector.ts

**Location:** `shared/core/src/base-detector.ts:793-1000`

**Current State:** Event processing logic (Sync, Swap events) mixed with detector orchestration in 1,883-line class.

**Proposed Extraction:**
```typescript
// New file: shared/core/src/event-processor.ts
export class EventProcessor {
  processSyncEvent(log: Log): ProcessedSyncEvent { /* pure function */ }
  processSwapEvent(log: Log): ProcessedSwapEvent { /* pure function */ }
  validateEvent(event: RawEvent): boolean { /* validation */ }
}
```

**Expected Improvement:**
- base-detector.ts: 1,883 -> 1,483 lines (-21%)
- Testability: Pure functions for event processing

**Risk:** MEDIUM (behavioral change possible)
**Effort:** 3 days
**Test Impact:** Add event-processor.test.ts, refactor base-detector.test.ts

**HOT-PATH IMPACT:** Medium - Must benchmark event processing latency

---

### P1-2: Extract ExecutionOrchestrator from engine.ts

**Location:** `services/execution-engine/src/engine.ts:1329-1553`

**Current State:** `executeOpportunity()` method is 224 lines combining:
- Risk assessment
- A/B testing assignment
- Strategy execution
- Outcome recording

**Proposed Extraction:**
```typescript
// New file: services/execution-engine/src/execution-orchestrator.ts
export class ExecutionOrchestrator {
  async execute(opportunity: Opportunity): Promise<ExecutionResult> {
    const risk = await this.assessRisk(opportunity);
    const variant = this.assignVariant(opportunity);
    const result = await this.executeStrategy(opportunity, variant);
    await this.recordOutcome(result);
    return result;
  }
}
```

**Expected Improvement:**
- engine.ts: 2,089 -> 1,900 lines (-9%)
- executeOpportunity: 224 -> 30 lines (-87%)

**Risk:** HIGH (hot-path, critical for execution)
**Effort:** 4 days
**Test Impact:** Extensive testing required

**HOT-PATH IMPACT:** HIGH - Must maintain <20ms execution latency

---

### P1-3: Extract TransactionSubmissionHandler from base.strategy.ts

**Location:** `services/execution-engine/src/strategies/base.strategy.ts:603-864`

**Current State:** `submitTransaction()` is 262 lines combining MEV logic, RBF retry, nonce management.

**Proposed Extraction:**
```typescript
export class TransactionSubmissionHandler {
  async submit(tx: PreparedTransaction): Promise<TransactionReceipt> {
    if (this.isMevEligible(tx)) {
      return this.submitViaMev(tx);
    }
    return this.submitWithRbf(tx);
  }
}
```

**Expected Improvement:**
- base.strategy.ts: 1,541 -> 1,390 lines (-10%)
- Clearer separation of MEV vs standard submission

**Risk:** HIGH (funds at risk if transaction handling broken)
**Effort:** 3 days
**Test Impact:** Add transaction-submission.test.ts

**HOT-PATH IMPACT:** HIGH - Transaction submission is latency-critical

---

### P1-4: Extract SubscriptionManager from chain-instance.ts

**Location:** `services/unified-detector/src/chain-instance.ts:319-341, 1114-1329`

**Current State:** 400+ lines of subscription management mixed with detection logic.

**Proposed Extraction:**
```typescript
export class SubscriptionManager {
  setupFactoryMode(wsManager: WebSocketManager): void { /* ... */ }
  setupLegacyMode(wsManager: WebSocketManager): void { /* ... */ }
  getStats(): SubscriptionStats { /* ... */ }
}
```

**Expected Improvement:**
- chain-instance.ts: 2,192 -> 2,000 lines (-9%)
- New module: SubscriptionManager (~400 lines)
- Net change: Better organized, more testable

**Risk:** MEDIUM (non-hot-path)
**Effort:** 3 days
**Test Impact:** Add subscription-manager.test.ts

---

### P1-5: Extract DetectionOrchestrator from chain-instance.ts

**Location:** `services/unified-detector/src/chain-instance.ts:1779-2121`

**Current State:** Arbitrage detection logic (simple, triangular, multi-leg) embedded in main class.

**Proposed Extraction:**
```typescript
export class DetectionOrchestrator {
  checkSimpleArbitrage(pair: ExtendedPair): ArbitrageOpportunity | null { /* ... */ }
  checkTriangularOpportunities(snapshot: IndexedSnapshot): Promise<ArbitrageOpportunity[]> { /* ... */ }
  checkMultiLegOpportunities(snapshot: IndexedSnapshot): Promise<ArbitrageOpportunity[]> { /* ... */ }
}
```

**Expected Improvement:**
- chain-instance.ts: 2,192 -> 1,900 lines (-13%)

**Risk:** MEDIUM (detection is hot-path adjacent)
**Effort:** 2 days
**Test Impact:** Add detection-orchestrator.test.ts

**HOT-PATH IMPACT:** Medium - Throttle logic must be preserved exactly

---

### P1-6: Extract BridgePollingOrchestrator from cross-chain.strategy.ts

**Location:** `services/execution-engine/src/strategies/cross-chain.strategy.ts`

**Current State:** Bridge status polling with timeouts, retries, and recovery state mixed with execution logic.

**Proposed Extraction:**
```typescript
export class BridgePollingOrchestrator {
  async pollUntilComplete(bridgeId: string, timeout: number): Promise<BridgeStatus> { /* ... */ }
  async recoverPendingBridges(): Promise<void> { /* ... */ }
}
```

**Expected Improvement:**
- cross-chain.strategy.ts: -200-250 lines
- Independent testing of polling logic

**Risk:** HIGH (funds-at-risk if bridge recovery broken)
**Effort:** 3 days
**Test Impact:** Comprehensive bridge polling tests

---

### P1-7: Extract WhaleAnalyzer from cross-chain-detector

**Location:** `services/cross-chain-detector/src/detector.ts:1642-1845`

**Current State:** 200+ lines of whale transaction analysis embedded in detector.

**Proposed Extraction:**
```typescript
export class WhaleAnalyzer {
  analyzeTransaction(tx: WhaleTransaction): Promise<CrossChainOpportunity[]> { /* ... */ }
  getActivitySummary(token: string, chain: string): WhaleActivitySummary { /* ... */ }
}
```

**Expected Improvement:**
- detector.ts: 2,148 -> 2,018 lines (-6%)
- 2 fields removed from detector

**Risk:** LOW (non-hot-path)
**Effort:** 2 days
**Test Impact:** Add whale-analyzer.test.ts

---

### P1-8: Use Existing LeadershipElectionService

**Location:** `services/coordinator/src/coordinator.ts:686-791`

**Current State:** Leadership election implemented inline (106 lines) despite LeadershipElectionService existing.

**Proposed Fix:** Replace inline code with service instantiation

**Expected Improvement:**
- coordinator.ts: 2,008 -> 1,902 lines (-5%)
- Single source of truth for leadership

**Risk:** MEDIUM
**Effort:** 1 day
**Test Impact:** Verify leadership tests still pass

---

### P1-9: Standardize Subsystem Lifecycle Interface

**Location:** `services/coordinator/src/coordinator.ts:463-499`

**Current State:** StreamConsumerManager, OpportunityRouter, HealthMonitor have inconsistent lifecycle APIs.

**Proposed Fix:**
```typescript
interface Subsystem {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
}
```

**Expected Improvement:**
- Simplified start()/stop() methods
- -30-40 lines in coordinator

**Risk:** LOW
**Effort:** 2 days
**Test Impact:** Update subsystem mocks

---

### P1-10: Extract PeriodicTaskManager from cross-chain-detector

**Location:** `services/cross-chain-detector/src/detector.ts:221-231, 515-533`

**Current State:** 6 interval/guard fields and 4 methods for periodic task management.

**Proposed Extraction:**
```typescript
export class PeriodicTaskManager {
  startDetectionCycle(handler: () => Promise<void>): void { /* ... */ }
  startHealthCycle(handler: () => Promise<void>): void { /* ... */ }
  stopAll(): Promise<void> { /* ... */ }
}
```

**Expected Improvement:**
- detector.ts: -50 lines, -6 fields
- Centralized interval lifecycle

**Risk:** LOW
**Effort:** 1.5 days
**Test Impact:** Add periodic-task-manager.test.ts

---

### P1-11: Extract WebSocketConnectionManager from websocket-manager.ts

**Location:** `shared/core/src/websocket-manager.ts:200-400`

**Current State:** Connection lifecycle (connect/disconnect/reconnect) mixed with message handling.

**Proposed Extraction:**
```typescript
export class WebSocketConnectionManager {
  async connect(url: string): Promise<WebSocket> { /* ... */ }
  async reconnectWithBackoff(): Promise<void> { /* ... */ }
  disconnect(): void { /* ... */ }
}
```

**Expected Improvement:**
- websocket-manager.ts: 1,663 -> 1,400 lines (-16%)
- Testable connection logic

**Risk:** MEDIUM (connection handling is critical)
**Effort:** 2 days
**Test Impact:** Add connection-manager.test.ts

---

### P1-12: Extract MessageParser from websocket-manager.ts

**Location:** `shared/core/src/websocket-manager.ts:892-950`

**Current State:** JSON parsing logic with worker thread coordination embedded in WebSocketManager.

**Proposed Extraction:**
```typescript
export class MessageParser {
  parseInMainThread(data: string): ParsedMessage { /* ... */ }
  async parseInWorker(data: string): Promise<ParsedMessage> { /* ... */ }
}
```

**Expected Improvement:**
- Cleaner separation of parsing strategies
- Testable parsing logic

**Risk:** LOW (parsing is not latency-critical)
**Effort:** 1 day
**Test Impact:** Add message-parser.test.ts

---

## P2: Medium-Priority Refactorings (Opportunistic)

### P2-1: Consolidate Validation Functions in dex-factories.ts

**Location:** `shared/config/src/dex-factories.ts:732-782, 970-1009, 1024-1075`

**Current State:** 3 validation functions with ~120 lines of duplicated logic.

**Proposed Fix:** Single composable validator

**Expected Improvement:** -90 lines (75% reduction in validation code)
**Risk:** LOW | **Effort:** 1 day

---

### P2-2: Extract ConfidenceCalculator from cross-chain-detector

**Location:** `services/cross-chain-detector/src/detector.ts:1517-1621`

**Current State:** 104-line method mixing price validation, age penalty, ML adjustments, whale adjustments.

**Proposed Fix:** Composite confidence calculator with pluggable signals

**Expected Improvement:** -100 lines, better testability
**Risk:** LOW | **Effort:** 1.5 days

---

### P2-3: Extract PairRegistry from base-detector.ts

**Location:** `shared/core/src/base-detector.ts:174-196, 427-460`

**Current State:** 7 pair-related fields and methods in base detector.

**Proposed Fix:** `PairRegistry` class for pair state management

**Expected Improvement:** Thread-safe pair access, domain language
**Risk:** LOW | **Effort:** 2 days

---

### P2-4: Create FactoryReference Type (Data Clump)

**Location:** `shared/config/src/dex-factories.ts:825-852`

**Current State:** (chain, address) parameter pair repeated in 7+ functions.

**Proposed Fix:** `type FactoryReference = { chain: string; address: string }`

**Expected Improvement:** Eliminates 14+ parameter pairs
**Risk:** LOW | **Effort:** 0.5 days

---

### P2-5: Extract RedisConnectionPool from redis.ts

**Location:** `shared/core/src/redis.ts:151-153`

**Current State:** 3 Redis clients (client, pubClient, subClient) as separate fields.

**Proposed Fix:** `RedisConnectionPool` class

**Expected Improvement:** Reusable connection pooling, cleaner lifecycle
**Risk:** MEDIUM | **Effort:** 2 days

---

### P2-6: Extract InitializationSequencer from engine.ts

**Location:** `services/execution-engine/src/engine.ts:346-574`

**Current State:** 228-line `start()` method with sequential initialization.

**Proposed Fix:** `InitializationSequencer` with phase management

**Expected Improvement:** Clearer initialization flow, better error handling
**Risk:** MEDIUM | **Effort:** 2 days

---

### P2-7: Extract HybridModeSimulator from base.strategy.ts

**Location:** `services/execution-engine/src/strategies/base.strategy.ts:1174-1316`

**Current State:** Hybrid mode logic scattered across 3 methods.

**Proposed Fix:** `HybridModeSimulator` class

**Expected Improvement:** Test hybrid vs real execution separately
**Risk:** LOW | **Effort:** 1 day

---

### P2-8: Extract FlashLoanFeeCalculator from flash-loan.strategy.ts

**Location:** `services/execution-engine/src/strategies/flash-loan.strategy.ts`

**Current State:** Fee calculation logic mixed with execution.

**Proposed Fix:** `FlashLoanFeeCalculator` class

**Expected Improvement:** Precise fee testing
**Risk:** LOW | **Effort:** 1 day

---

### P2-9: Split types.ts into Modules

**Location:** `services/execution-engine/src/types.ts` (1,220 lines)

**Current State:** Types, configs, error codes, factory functions in one file.

**Proposed Split:**
- `config/index.ts` (300 lines)
- `errors/index.ts` (100 lines)
- `types.ts` (820 lines)

**Risk:** LOW | **Effort:** 1 day

---

### P2-10 through P2-18: Additional Consolidations

| ID | Description | Location | Effort |
|----|-------------|----------|--------|
| P2-10 | Consolidate message handler duplication | coordinator.ts:999-1440 | 2d |
| P2-11 | Extract IntervalManager | coordinator.ts:654-680 | 1d |
| P2-12 | Extract AlertingSubsystem | coordinator.ts | 1d |
| P2-13 | Move simulation-mode.ts to test fixtures | shared/core/src | 2d |
| P2-14 | Extract CrossChainPriceTracker | partitioned-detector.ts | 2d |
| P2-15 | Create type-check factory function | dex-factories.ts:872-914 | 0.5d |
| P2-16 | Unify cross-file config validation | shared/config/src | 2d |
| P2-17 | Extract SimulationMetricsAnalyzer | pending-state-simulator.ts | 1d |
| P2-18 | Create DetectionPipeline abstraction | cross-chain-detector | 2d |

---

## P3: Low-Priority (Tech Debt Backlog)

| ID | Description | Location | Effort |
|----|-------------|----------|--------|
| P3-1 | Remove duplicate config instance fields | coordinator.ts:353-356 | 0.25d |
| P3-2 | Add inverse mapping (DEX -> factories) | dex-factories.ts | 1d |
| P3-3 | Standardize lookup performance | dex-factories.ts | 1d |
| P3-4 | Extract TokenAllowanceManager | base.strategy.ts:1027-1117 | 1d |
| P3-5 | Extract NHopSwapPathBuilder | flash-loan.strategy.ts | 1d |
| P3-6 | Create EventHandlerPipeline | chain-instance.ts:1474-1505 | 1d |
| P3-7 | Extract SimulationAdapter | chain-instance.ts | 2d |
| P3-8 | Nested config objects | ChainInstanceConfig | 0.5d |
| P3-9 | Move ETH price refresh to BridgeCostEstimator | detector.ts:687-764 | 1d |
| P3-10 | Add schema validation for DEX_FACTORY_REGISTRY | dex-factories.ts | 1d |
| P3-11 | Extract RedisCommandTracker | redis.ts | 1d |
| P3-12 | Extract RedisValidator | redis.ts:272-299 | 0.5d |
| P3-13 | Create LatencyMetricsCollector | partitioned-detector.ts | 1d |
| P3-14 | Extract ChainHealthAggregator | partitioned-detector.ts | 1d |

---

## Implementation Roadmap

### Phase 1: Critical Fixes (Week 1-2)
**Target: P0-1 through P0-8**

| Week | Day | Task | Owner | Deliverable |
|------|-----|------|-------|-------------|
| 1 | 1-2 | P0-1: Fix chainPrices memory leak | - | LRU cache implementation |
| 1 | 2 | P0-2: Fix handler accumulation | - | clearHandlers() method |
| 1 | 3 | P0-3: Remove deprecated health polling | - | -75 LOC |
| 1 | 3-4 | P0-4: Consolidate alert cooldowns | - | Single source of truth |
| 1 | 5 | P0-5: Fix circular import | - | Explicit imports |
| 2 | 1-2 | P0-6: Split index.ts barrel | - | Logical entry points |
| 2 | 3-4 | P0-7: Extract PreValidationOrchestrator | - | New module |
| 2 | 5 | P0-8: Fix duplicate cache state | - | Unified in SnapshotManager |

**Phase 1 Metrics:**
- LOC Reduction: ~300 lines
- Memory Safety: 3 leaks fixed
- Circular Deps: 2 risks eliminated

---

### Phase 2: God Class Decomposition (Week 3-6)
**Target: P1-1 through P1-6**

| Week | Task | LOC Impact | Risk |
|------|------|------------|------|
| 3 | P1-1: Extract EventProcessor | -400 | MEDIUM |
| 3-4 | P1-2: Extract ExecutionOrchestrator | -190 | HIGH |
| 4 | P1-3: Extract TransactionSubmissionHandler | -150 | HIGH |
| 5 | P1-4: Extract SubscriptionManager | 0 (reorganize) | MEDIUM |
| 5-6 | P1-5: Extract DetectionOrchestrator | -290 | MEDIUM |
| 6 | P1-6: Extract BridgePollingOrchestrator | -250 | HIGH |

**Phase 2 Metrics:**
- LOC Reduction: ~1,280 lines (in god classes)
- New Modules: 6
- Test Coverage: +100 new tests

**HOT-PATH VALIDATION REQUIRED:**
- P1-1: Benchmark event processing (target: <5ms)
- P1-2: Benchmark execution (target: <20ms)
- P1-3: Benchmark transaction submission
- P1-5: Benchmark detection loop

---

### Phase 3: Structural Improvements (Week 7-8)
**Target: P1-7 through P1-12**

| Week | Task | LOC Impact |
|------|------|------------|
| 7 | P1-7: Extract WhaleAnalyzer | -130 |
| 7 | P1-8: Use LeadershipElectionService | -106 |
| 7 | P1-9: Standardize Subsystem Lifecycle | -40 |
| 8 | P1-10: Extract PeriodicTaskManager | -50 |
| 8 | P1-11: Extract WebSocketConnectionManager | -260 |
| 8 | P1-12: Extract MessageParser | -60 |

**Phase 3 Metrics:**
- LOC Reduction: ~650 lines
- New Modules: 5
- Interface Standardization: 3 subsystems

---

### Phase 4: Consolidation (Week 9-10)
**Target: P2-1 through P2-9**

| Week | Tasks | LOC Impact |
|------|-------|------------|
| 9 | P2-1 through P2-4 | -250 |
| 10 | P2-5 through P2-9 | -200 |

**Phase 4 Metrics:**
- LOC Reduction: ~450 lines
- Code Duplication: -40%

---

## Verification Checklist

### Before Each Refactoring:

- [ ] Read existing tests for the module
- [ ] Identify hot-path code paths
- [ ] Create benchmark baseline (if hot-path)
- [ ] Verify no circular dependencies will be introduced
- [ ] Check for intentional patterns (ADRs, comments)

### After Each Refactoring:

- [ ] All existing tests pass
- [ ] New module has tests with >80% coverage
- [ ] Hot-path latency within 5% of baseline
- [ ] No memory growth in 1-hour test
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)

---

## Summary Metrics

### Before Refactoring

| File | LOC | Fields | Methods |
|------|-----|--------|---------|
| chain-instance.ts | 2,192 | 87 | 43 |
| cross-chain-detector.ts | 2,148 | 35 | 40+ |
| engine.ts | 2,089 | 25+ | 40+ |
| coordinator.ts | 2,008 | 25 | 35+ |
| base-detector.ts | 1,883 | 82 | 35+ |
| websocket-manager.ts | 1,663 | 54 | 30+ |
| **Total God Classes** | **12,000+** | **308+** | **220+** |

### After Full Refactoring (Target)

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| God Classes (>1000 LOC) | 6 | 0 | -100% |
| Total LOC (god classes) | 12,000 | 7,500 | -38% |
| New Focused Modules | 0 | 20+ | - |
| Average Class Size | 2,000 | 400 | -80% |
| Memory Leak Risks | 3 | 0 | -100% |
| Circular Dep Risks | 8 | 0 | -100% |

---

## Risk Mitigation

### Hot-Path Changes (HIGH RISK)

For any refactoring touching:
- `handleWebSocketMessage()`
- `handleSyncEvent()`
- `executeOpportunity()`
- `submitTransaction()`

**Required Process:**
1. Create performance benchmark before change
2. Make change in feature branch
3. Run benchmark (must be within 5% of baseline)
4. Run 24-hour integration test
5. Gradual rollout with monitoring

### Memory-Critical Changes (MEDIUM RISK)

For any refactoring touching:
- `chainPrices` map
- `pairsByTokens` map
- Handler registration

**Required Process:**
1. Add memory growth assertion test
2. Run 1-hour stress test before merge
3. Monitor memory in staging for 24h

---

## Appendix: ADR References

- **ADR-002:** Redis Streams Required (no Pub/Sub)
- **ADR-003:** Partitioned Chain Detectors
- **ADR-005:** SharedArrayBuffer for hot-path
- **ADR-007:** Leadership Election
- **ADR-012:** Worker Threads for Parallel Processing
- **ADR-014:** Cross-Chain Detector Modularization
- **ADR-015:** Pino Logger Migration

---

*Document generated by Claude Opus 4.5 refactoring analysis*
