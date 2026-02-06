# PriceMatrix L1 Cache Integration Plan

**Status**: Ready to Execute
**Created**: 2026-02-06
**Estimated Duration**: 4 weeks
**Estimated Effort**: 40-45 hours

---

## Executive Summary

This plan details the integration of PriceMatrix (SharedArrayBuffer-based L1 cache) into the production arbitrage system. All prerequisites are met - worker threads are active, SharedArrayBuffer infrastructure exists, and PriceMatrix is fully implemented and tested.

**Expected Improvements**:
- 5-10x faster hot-path latency
- 50,000x faster worker thread price access
- >95% L1 cache hit rate
- Zero Redis calls for same-partition prices

---

## Prerequisites ✅

| Requirement | Status | Evidence |
|------------|--------|----------|
| Worker threads implemented | ✅ Done | `shared/core/src/async/worker-pool.ts` |
| Worker threads in production | ✅ Active | `WebSocketManager.parseMessageInWorker()` |
| SharedArrayBuffer support | ✅ Done | `shared/core/src/caching/shared-memory-cache.ts` |
| PriceMatrix implemented | ✅ Done | 970 lines, 104 tests |
| Node.js 22+ | ✅ Done | `package.json` engine requirement |

**Conclusion**: All infrastructure ready, just needs integration.

---

## Implementation Phases

### Phase 1: Connect PriceMatrix to HierarchicalCache (Week 1)

**Goal**: Replace Map-based L1 with PriceMatrix in HierarchicalCache

| Task ID | Task | Effort | Dependencies |
|---------|------|--------|--------------|
| #11 | Replace L1 Map with PriceMatrix | 2h | None |
| #12 | Implement L1 get() using PriceMatrix | 3h | #11 |
| #13 | Implement L1 set() using PriceMatrix | 3h | #11 |
| #14 | Update helper methods | 2h | #12, #13 |
| #15 | Add integration tests | 4h | #14 |
| #16 | Benchmark performance | 3h | #15 |

**Total**: 17 hours (2-3 days)

**Success Criteria**:
- ✅ HierarchicalCache uses PriceMatrix for L1
- ✅ All existing tests pass
- ✅ New tests achieve >90% coverage
- ✅ L1 read latency <1μs

---

### Phase 2: Integrate HierarchicalCache into Services (Week 2)

**Goal**: Use HierarchicalCache in unified-detector for all price operations

| Task ID | Task | Effort | Dependencies |
|---------|------|--------|--------------|
| #17 | Add HierarchicalCache to ChainInstance | 1h | Phase 1 complete |
| #18 | Replace Redis writes with cache.set() | 2h | #17 |
| #19 | Replace price lookups with cache.get() | 3h | #17 |
| #20 | Add cache metrics and monitoring | 2h | #18, #19 |
| #21 | Add integration tests | 3h | #20 |

**Total**: 11 hours (2-3 days)

**Success Criteria**:
- ✅ Unified-detector uses HierarchicalCache
- ✅ L1 hit rate >95%
- ✅ Hot-path latency <50ms maintained
- ✅ Metrics visible in health endpoint

---

### Phase 3: Enable Worker Thread Access (Week 3)

**Goal**: Enable workers to read prices from PriceMatrix (zero-copy)

| Task ID | Task | Effort | Dependencies |
|---------|------|--------|--------------|
| #22 | Pass SharedArrayBuffer to workers | 2h | Phase 2 complete |
| #23 | Initialize PriceMatrix in workers | 3h | #22 |
| #24 | Update worker tasks to use PriceMatrix | 3h | #23 |
| #25 | Add worker integration tests | 4h | #24 |

**Total**: 12 hours (1-2 days)

**Success Criteria**:
- ✅ Workers access PriceMatrix via SharedArrayBuffer
- ✅ No message passing for price reads
- ✅ Worker task latency <5ms
- ✅ 50,000x faster than message passing

---

### Phase 4: Verification & Optimization (Week 4)

**Goal**: Validate production readiness and document

| Task ID | Task | Effort | Dependencies |
|---------|------|--------|--------------|
| #26 | Load testing (500 events/sec) | 4h | Phase 3 complete |
| #27 | Profile and optimize performance | 3h | #26 |
| #28 | Update ADR-005 with results | 2h | #27 |
| #29 | Document deployment requirements | 2h | #27 |

**Total**: 11 hours (2-3 days)

**Success Criteria**:
- ✅ 500 events/sec @ <50ms P95 latency
- ✅ L1 hit rate >95%
- ✅ Memory within budget (64MB L1)
- ✅ Documentation complete

---

## Task Dependencies (Gantt Chart)

```
Week 1: Phase 1 - HierarchicalCache Integration
├─ #11 [██] Replace L1 Map with PriceMatrix (2h)
├─ #12 [███] Implement get() (3h) → depends on #11
├─ #13 [███] Implement set() (3h) → depends on #11
├─ #14 [██] Update helpers (2h) → depends on #12, #13
├─ #15 [████] Add tests (4h) → depends on #14
└─ #16 [███] Benchmark (3h) → depends on #15

Week 2: Phase 2 - Service Integration
├─ #17 [█] Add to ChainInstance (1h) → depends on Phase 1
├─ #18 [██] Replace writes (2h) → depends on #17
├─ #19 [███] Replace reads (3h) → depends on #17
├─ #20 [██] Add metrics (2h) → depends on #18, #19
└─ #21 [███] Integration tests (3h) → depends on #20

Week 3: Phase 3 - Worker Thread Access
├─ #22 [██] Pass SharedArrayBuffer (2h) → depends on Phase 2
├─ #23 [███] Init in workers (3h) → depends on #22
├─ #24 [███] Update worker tasks (3h) → depends on #23
└─ #25 [████] Worker tests (4h) → depends on #24

Week 4: Phase 4 - Validation & Documentation
├─ #26 [████] Load testing (4h) → depends on Phase 3
├─ #27 [███] Profile & optimize (3h) → depends on #26
├─ #28 [██] Update ADR-005 (2h) → depends on #27
└─ #29 [██] Document deployment (2h) → depends on #27
```

**Critical Path**: #11 → #12 → #14 → #15 → #17 → #19 → #21 → #24 → #26 → #27

---

## Risk Management

### High Priority Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SharedArrayBuffer unavailable | Low | High | Automatic fallback to ArrayBuffer |
| Performance regression | Low | High | Extensive benchmarking, rollback plan |
| L1 cache thrashing | Medium | Medium | Tune cache size, monitor metrics |
| Worker thread overhead | Low | Medium | Already verified in tests |

### Mitigation Details

**Risk 1: SharedArrayBuffer Not Available**
- **Mitigation**: PriceMatrix has fallback to ArrayBuffer (already implemented)
- **Detection**: Runtime check in constructor
- **Impact**: Workers won't share buffer, but single-thread performance still improved

**Risk 2: Performance Regression**
- **Mitigation**:
  - Run hot-path.performance.test.ts before/after
  - Feature flag to disable L1 if issues
  - Staged rollout (dev → staging → production)
- **Rollback**: Revert HierarchicalCache to Map-based L1

**Risk 3: L1 Cache Thrashing**
- **Mitigation**:
  - Monitor L1 eviction rate
  - Increase L1 size if needed (64MB → 128MB)
  - Tune working set based on actual pairs
- **Detection**: High eviction count in metrics

---

## Success Metrics

### Performance Targets (ADR-005)

| Metric | Target | Baseline | How to Measure |
|--------|--------|----------|----------------|
| L1 read latency | <1μs | 500ns (Map) | Phase 1.6 benchmark |
| L1 hit rate | >95% | N/A | Phase 2.5 integration test |
| Worker read latency | <5ms | 20ms | Phase 3.4 integration test |
| Hot-path latency | <50ms | 50ms | Phase 4.1 load test |
| Events/sec | 500+ | ~300 | Phase 4.1 load test |

### Quality Targets

| Metric | Target | How to Verify |
|--------|--------|---------------|
| Test coverage | >90% | Jest coverage report |
| Type safety | 0 errors | `npm run typecheck` |
| Integration tests | All pass | Phase 1.5, 2.5, 3.4 |
| Load tests | All pass | Phase 4.1 |

---

## Rollout Strategy

### Development
1. Complete Phase 1-4 in feature branch
2. All tests pass locally
3. Code review with focus on hot-path changes

### Staging
1. Deploy to staging environment
2. Run load tests (Phase 4.1)
3. Monitor for 24 hours
4. Verify metrics match expectations

### Production
1. Feature flag: `PRICE_MATRIX_L1_ENABLED=true`
2. Gradual rollout:
   - 10% traffic for 1 hour
   - 50% traffic for 4 hours
   - 100% traffic if metrics good
3. Monitor:
   - L1 hit rate (target >95%)
   - P95 latency (target <50ms)
   - Error rate (target 0%)
   - Memory usage (target <64MB L1)

### Rollback Plan
1. Set `PRICE_MATRIX_L1_ENABLED=false`
2. Restart services
3. HierarchicalCache falls back to Map-based L1
4. Zero downtime rollback

---

## Next Steps

To begin Phase 1:

```bash
# 1. Create feature branch
git checkout -b feature/pricematrix-integration

# 2. Start with Task #11
# File: shared/core/src/caching/hierarchical-cache.ts
# See task description for details

# 3. Run tests frequently
npm test -- hierarchical-cache

# 4. Commit after each task completes
git commit -m "feat: Task #11 - Replace L1 Map with PriceMatrix"
```

---

## Questions & Support

**Technical Questions**:
- PriceMatrix implementation: `shared/core/src/caching/price-matrix.ts`
- HierarchicalCache: `shared/core/src/caching/hierarchical-cache.ts`
- Worker pool: `shared/core/src/async/worker-pool.ts`

**Architecture Questions**:
- ADR-005: `docs/architecture/adr/ADR-005-hierarchical-cache.md`
- ADR-022: `docs/architecture/adr/ADR-022-hot-path-memory-optimization.md`

**Performance Requirements**:
- ARCHITECTURE_V2.md: Section 5 (Data Flow)
- Hot-path requirement: <50ms end-to-end

---

## Conclusion

This integration plan provides a structured, low-risk approach to completing the PriceMatrix L1 cache integration. All infrastructure is in place, and the plan breaks work into manageable tasks with clear acceptance criteria.

**Estimated Timeline**: 4 weeks
**Estimated Effort**: 40-45 hours
**Risk Level**: Low (with mitigations)
**Value**: Very High (5-10x performance improvement)

**Recommendation**: ✅ **PROCEED WITH INTEGRATION**
