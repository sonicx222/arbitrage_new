# Refactoring Analysis Report

**Generated**: 2026-02-01
**Scope**: Full codebase analysis using hybrid top-down/bottom-up methodology
**Target**: <50ms hot-path latency preservation

---

## Executive Summary

### Codebase Size
| Subsystem | LOC | God Classes | Extraction Candidates |
|-----------|-----|-------------|----------------------|
| services/coordinator | 2,400 | 1 | 310-400 LOC |
| services/execution-engine | 2,134 | 1 | 280 LOC |
| services/unified-detector | 2,045 | 1 | 150 LOC |
| shared/core | ~70,000 | 0 (well-organized) | 10,000+ LOC |
| shared/config | 3,030 | 0 | 775 LOC |
| **TOTAL** | ~80,000 | 3 | ~11,500 LOC |

### Key Findings

1. **Three god classes** identified with 6+ responsibilities each
2. **No circular dependencies** - proper layer separation maintained
3. **Hot-path code is protected** - pre-compiled constants in base-detector.ts
4. **538 LOC deprecated code** ready for removal (advanced-arbitrage-orchestrator.ts)
5. **775 LOC config duplication** via data clumps and missing abstractions
6. **Cross-cutting patterns** should be extracted to shared infrastructure

---

## 1. God Class Analysis

### 1.1 Coordinator Service (2,400 LOC)

**File**: [services/coordinator/src/coordinator.ts](services/coordinator/src/coordinator.ts)

**Responsibilities** (8 identified):
- Lifecycle management (150 LOC)
- Stream consumer orchestration (200 LOC)
- Message routing (350 LOC) - 6 handlers with identical pattern
- Opportunity processing (200 LOC)
- Leadership election (150 LOC)
- Health monitoring (200 LOC)
- Alert management (150 LOC)
- Cleanup operations (100 LOC)

**Critical Issue**: `resetStreamErrors()` called 11 times across all handlers (lines 1266, 1294, 1316, 1328, 1361, 1481, 1542, 1591, 1608, 1654)

**Oversized Methods**:
| Method | Lines | LOC | Issue |
|--------|-------|-----|-------|
| `start()` | 428-545 | 108 | Initialization god method |
| `handleOpportunityMessage()` | 1281-1366 | 86 | Parse + validate + route mixed |
| `startStreamConsumers()` | 1092-1169 | 78 | Handler registration mixed with setup |
| `forwardToExecutionEngine()` | 1745-1820 | 76 | Circuit breaker + serialization mixed |
| `startHealthMonitoring()` | 1849-1915 | 67 | Metrics + cleanup combined |

---

### 1.2 Execution Engine (2,134 LOC)

**File**: [services/execution-engine/src/engine.ts](services/execution-engine/src/engine.ts)

**Responsibilities** (6 identified):
- Lifecycle management (130 LOC)
- Execution processing (320 LOC)
- Health monitoring (80 LOC)
- Risk management (110 LOC)
- State management (40 LOC)
- Infrastructure coordination (400 LOC)

**Critical Issue**: `executeOpportunity()` is 244 LOC (lines 1324-1567) handling:
- Drawdown checks (lines 1354-1373)
- EV calculation (lines 1392-1418)
- Position sizing (lines 1422-1459)
- Strategy dispatch (lines 1463-1479)
- Risk recording (lines 1487-1519)

**Private Members**: 30 dependencies across 8 categories

---

### 1.3 Unified Detector Chain Instance (2,045 LOC)

**File**: [services/unified-detector/src/chain-instance.ts](services/unified-detector/src/chain-instance.ts)

**Responsibilities** (6 identified):
- Lifecycle management (206 LOC)
- Simulation mode (157 LOC)
- WebSocket management (123 LOC)
- Event subscription (184 LOC)
- Event handling (151 LOC) - **HOT PATH**
- Arbitrage detection (302 LOC)

**HOT PATH METHODS**:
| Method | Lines | LOC | Latency Risk |
|--------|-------|-----|--------------|
| `handleSyncEvent()` | 1381-1436 | 55 | HIGH - per price update |
| `handleSwapEvent()` | 1439-1507 | 68 | HIGH - per swap event |
| `checkArbitrageOpportunity()` | 1609-1673 | 64 | HIGH - per check |

---

## 2. Cross-Cutting Patterns

### 2.1 Message Handler Pattern (Duplicated 6x)

**Locations**:
- coordinator.ts: lines 1220-1271, 1281-1366, 1446-1486, 1500-1547, 1559-1613, 1626-1659

**Pattern**:
```typescript
private async handle[Type]Message(message: StreamMessage): Promise<void> {
  try {
    const data = message.data as Record<string, unknown>;
    if (!data) return;

    // 1. PARSE (2-10 lines)
    // 2. VALIDATE (2-8 lines)
    // 3. UPDATE METRICS (2-4 lines)
    // 4. PERFORM ACTION (5-15 lines)
    // 5. RESET ERRORS (1 line) - APPEARS IN ALL 6!
    this.resetStreamErrors();
  } catch (error) {
    this.logger.error('Failed to handle...', { error, message });
  }
}
```

**Extraction Opportunity**: Create `HandlerPipeline` in shared/core
- Estimated coordinator reduction: 150-180 LOC
- Reusable by: execution-engine, detectors (3+ services)

---

### 2.2 Fee Validation Pattern (Duplicated 4x)

**Locations**:
- [services/unified-detector/src/chain-instance.ts:1978](services/unified-detector/src/chain-instance.ts#L1978)
- [services/unified-detector/src/detection/simple-arbitrage-detector.ts:196](services/unified-detector/src/detection/simple-arbitrage-detector.ts#L196)
- [services/unified-detector/src/detection/snapshot-manager.ts:218](services/unified-detector/src/detection/snapshot-manager.ts#L218)
- [services/unified-detector/src/types.ts:311](services/unified-detector/src/types.ts#L311) (centralized version exists!)

**Issue**: FIX 9.3 created centralized `validateFee()` at types.ts:311, but 3 classes still have private implementations.

**Action**: Replace private `validateFee()` methods with centralized import.

---

### 2.3 Cleanup/TTL Pattern (Duplicated across services)

**Coordinator cleanup methods**:
- `cleanupExpiredOpportunities()` - lines 1372-1421 (49 LOC)
- `cleanupActivePairs()` - lines 1665-1687 (22 LOC)
- `cleanupAlertCooldowns()` - lines 2188-2208 (20 LOC)

**Execution engine cleanup**:
- `cleanupGasBaselines()` - lines 1691-1711 (21 LOC)
- `cleanupStaleLockConflictTracking()` - lines 1259-1291 (33 LOC)

**Extraction Opportunity**: Create `TTLCleaner` in shared/core
- Estimated reduction: 60-80 LOC per service
- Total: 120+ LOC coordinator + 50+ LOC execution-engine

---

## 3. Hot-Path Protection Zone

### CRITICAL: DO NOT ABSTRACT

| Component | Location | Impact |
|-----------|----------|--------|
| `SYNC_EVENT_ABI_TYPES` | [base-detector.ts:85](shared/core/src/base-detector.ts#L85) | 0.1-0.5ms/event |
| `SWAP_EVENT_ABI_TYPES` | [base-detector.ts:88](shared/core/src/base-detector.ts#L88) | 0.1-0.5ms/event |
| PriceMatrix O(1) lookup | [price-matrix.ts](shared/core/src/caching/price-matrix.ts) | 0.05-0.2ms |
| NumericRollingWindow | [numeric-rolling-window.ts](shared/core/src/data-structures/numeric-rolling-window.ts) | 0.01-0.05ms |

**Rationale**: Pre-compiled constants eliminate runtime parsing. Any abstraction would add 0.5ms+ latency per 100k events.

---

## 4. Deprecated Code for Removal

### 4.1 Advanced Arbitrage Orchestrator (538 LOC)

**File**: [shared/core/src/advanced-arbitrage-orchestrator.ts](shared/core/src/advanced-arbitrage-orchestrator.ts)

**Status**: Marked deprecated in index.ts exports
**Action**: Verify no imports, remove file
**Effort**: 1 day

### 4.2 Other Candidates (Audit Required)

| File | LOC | Status |
|------|-----|--------|
| ab-testing.ts | ~563 | Audit usage |
| advanced-statistical-arbitrage.ts | ~465 | Audit usage |
| predictive-warmer.ts | ~332 | Matrix cache removed |

---

## 5. Shared/Config Data Clumps

### 5.1 DEX Factory Registry (300 LOC reducible)

**File**: [shared/config/src/dex-factories.ts:348-692](shared/config/src/dex-factories.ts#L348-L692)

**Issue**: 44 factory configurations repeat same 7-parameter structure:
```typescript
{
  address: '0x...',
  dexName: string,
  type: FactoryType,
  chain: string,         // REDUNDANT - duplicates registry key
  initCodeHash?: string,
  hasFeeTiers?: boolean,
  supportsFactoryEvents?: boolean
}
```

**Extraction**: Create `FactoryConfig` builder function

### 5.2 Chain URL Construction (200 LOC reducible)

**File**: [shared/config/src/chains/index.ts:73-388](shared/config/src/chains/index.ts#L73-L388)

**Issue**: 22 RPC/WS URL constructions (11 chains × 2) repeat identical pattern:
```typescript
rpcUrl: process.env.CHAIN_RPC_URL || drpc('chain-name') || 'https://...',
wsUrl: process.env.CHAIN_WS_URL || drpc('chain-name', true) || 'wss://...',
rpcFallbackUrls: fallbacks(ankr(...), publicNode(...), infura(...), ...),
wsFallbackUrls: fallbacks(ankr(..., true), publicNode(..., true), ...),
```

**Extraction**: Create `ChainUrlConfig` interface and builder

### 5.3 Validation Duplication (80 LOC reducible)

**File**: [shared/config/src/dex-factories.ts](shared/config/src/dex-factories.ts)

**Issue**: 3 validator functions with 75% overlap:
- `validateFactoryRegistryAtLoad()` - lines 732-782
- `validateFactoryRegistry()` - lines 970-1009
- `validateFactoryRegistryAtLoadTime()` - lines 1024-1072

---

## 6. Prioritized Refactoring Roadmap

### Phase 1: Foundation (Week 1-2) - LOW RISK, HIGH IMPACT

| Task | Files | LOC Reduction | Latency Risk | Priority |
|------|-------|---------------|--------------|----------|
| Remove deprecated orchestrator | shared/core | -538 | None | P0 |
| Consolidate fee validation | unified-detector | -30 | None | P0 |
| Extract handler adapter (coordinator) | coordinator | -150 | None | P1 |
| Unify error tracking | coordinator + streaming | -80 | Low | P1 |
| Remove opportunity duplication | coordinator | -80 | None | P1 |

**Total Phase 1**: ~880 LOC reduction, 0-2ms latency impact

---

### Phase 2: Structural Improvements (Week 3-4) - MEDIUM RISK

| Task | Files | LOC Reduction | Latency Risk | Priority |
|------|-------|---------------|--------------|----------|
| Extract LockConflictTracker | execution-engine | -84 | None | P1 |
| Extract RiskManagementOrchestrator | execution-engine | -110 | None | P1 |
| Extract GasBaselineManager | execution-engine | -84 | **Improves** | P1 |
| Extract EventProcessor (chain-instance) | unified-detector | -120 | Low | P1 |
| Consolidate config validation | shared/config | -80 | None | P2 |

**Total Phase 2**: ~480 LOC reduction + latency improvement

---

### Phase 3: Major Extractions (Week 5-8) - HIGHER RISK

| Task | Files | LOC Reduction | Latency Risk | Priority |
|------|-------|---------------|--------------|----------|
| Extract @arbitrage/analytics package | shared/core | -6,500 | None | P2 |
| Consolidate path-finding algorithms | shared/core | -400 | None | P2 |
| Extract Solana to partition-solana | shared/core | -2,100 | None | P2 |
| Refactor factory registry builder | shared/config | -300 | None | P2 |
| Refactor chain URL builder | shared/config | -200 | None | P2 |

**Total Phase 3**: ~9,500 LOC reduction

---

### Phase 4: Strategic Refactoring (Quarterly)

| Task | Impact | Effort | Priority |
|------|--------|--------|----------|
| Split FlashLoanStrategy into router + strategy | -900 LOC | 8h | P3 |
| Split CrossChainStrategy into orchestrator + strategy | -1,000 LOC | 8h | P3 |
| Complete leadership extraction (coordinator) | -100 LOC | High | P3 |
| Unify ChainConfig interface (types) | Architectural | Medium | P3 |

---

## 7. Impact Summary

### Total LOC Reduction Potential

| Phase | LOC | % of Total | Risk |
|-------|-----|------------|------|
| Phase 1 | ~880 | 1.1% | Low |
| Phase 2 | ~480 | 0.6% | Medium |
| Phase 3 | ~9,500 | 12% | Medium-High |
| Phase 4 | ~2,000 | 2.5% | High |
| **TOTAL** | ~12,860 | **16%** | Phased |

### Latency Impact

| Phase | Hot-Path Impact |
|-------|-----------------|
| Phase 1 | +0ms (no hot-path changes) |
| Phase 2 | **-0.1ms** (GasBaselineManager improves O(1) guarantee) |
| Phase 3 | +0ms (analytics not on hot path) |
| Phase 4 | +0ms (strategies not on hot path) |

### Test Impact

| Phase | Test Changes |
|-------|--------------|
| Phase 1 | Update imports only |
| Phase 2 | Add isolated unit tests for extracted classes |
| Phase 3 | Create new package test suites |
| Phase 4 | Refactor strategy tests |

---

## 8. Validation Checklist

### Before Each Refactoring

- [ ] Verify pattern exists (grep confirmed)
- [ ] Check if intentional (ADR, comments, performance)
- [ ] Confirm tests pass before and after
- [ ] Measure latency for hot-path code

### Anti-Patterns to Avoid

1. **Never abstract hot-path constants** (SYNC_EVENT_ABI_TYPES, etc.)
2. **Never add abstraction layers** to price-matrix, detector, execution-engine hot paths
3. **Always use existing centralized utilities** (validateFee at types.ts:311)
4. **Prefer incremental extraction** over "big bang" rewrites

---

## 9. Quick Reference: File Locations

### God Classes
- [coordinator.ts](services/coordinator/src/coordinator.ts) - 2,400 LOC
- [engine.ts](services/execution-engine/src/engine.ts) - 2,134 LOC
- [chain-instance.ts](services/unified-detector/src/chain-instance.ts) - 2,045 LOC

### Deprecated (Remove)
- [advanced-arbitrage-orchestrator.ts](shared/core/src/advanced-arbitrage-orchestrator.ts) - 538 LOC

### Data Clumps
- [dex-factories.ts](shared/config/src/dex-factories.ts) - lines 348-692
- [chains/index.ts](shared/config/src/chains/index.ts) - lines 73-388

### Hot-Path Protected
- [base-detector.ts:85-88](shared/core/src/base-detector.ts#L85-L88)
- [price-matrix.ts](shared/core/src/caching/price-matrix.ts)

---

## Appendix: Subsystem Analysis Agent IDs

For detailed subsystem analysis, resume these agents:

| Subsystem | Agent ID | Status |
|-----------|----------|--------|
| Coordinator | a64d8a8 | Complete |
| Execution Engine | af5fa4d | Complete |
| Shared/Core | ae8625a | Complete |
| Unified Detector | a1f88f9 | Complete |
| Shared/Config | ad6cc21 | Complete |
