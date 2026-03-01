# CONFIG & DOC AUDITOR - Final Report

**Session**: Multi-Agent Monitoring Session
**Agent**: CONFIG_AUDITOR
**Timestamp**: 2026-03-01
**Duration**: ~10 minutes (static analysis phase)

## Executive Summary

Completed comprehensive static analysis of configuration, documentation, and code to identify drifts and inconsistencies across the multi-chain arbitrage system.

**Total Findings**: 20
- **Critical**: 0
- **High**: 4 (CA-001, CA-010, CA-013, CA-020)
- **Medium**: 7 (CA-002, CA-003, CA-005, CA-009, CA-012, CA-014, CA-018)
- **Low**: 5 (CA-004, CA-011, CA-015, CA-016)
- **Info**: 4 (CA-006, CA-007, CA-008, CA-017, CA-019)

## Key Findings by Category

### 1. ROGUE STREAMS (2 findings, HIGH/MEDIUM)
**Problem**: Code declares streams that never get created in Redis runtime.
- `CA-001 (HIGH)`: expert-self-healing-manager.ts declares stream:system-failures, stream:system-control, stream:system-scaling - none exist in Redis
- `CA-002 (MEDIUM)`: graceful-degradation.ts references stream:service-recovery - not in runtime

**Impact**: Publishes to non-existent streams result in silently lost messages. No consumers, no processing.

**Recommendation**: Either create these streams on-demand or remove dead code. Document lifecycle.

### 2. SCHEMA DRIFT (3 findings)
**Problem**: 21 streams declared in code, only 12 exist in Redis runtime. No lifecycle documentation.
- `CA-010 (HIGH)`: 3 system-* streams declared but never created
- `CA-019 (INFO)`: No indication which streams are pre-created vs on-demand
- `CA-003 (MEDIUM)`: No centralized stream schema documentation

**Impact**: Developers don't know which streams are active, their message formats, or creation lifecycle.

**Recommendation**: Create `docs/architecture/REDIS_STREAMS_SCHEMA.md` with full registry.

### 3. PORT CONFLICTS (2 findings, HIGH/MEDIUM)
**Problem**: Docker Compose partition services use inconsistent internal/external port mappings.
- `CA-013 (HIGH)`: All partitions map to internal port 3001 but external ports differ (3001-3006)
- `CA-014 (MEDIUM)`: HEALTH_CHECK_PORT=3001 for all containers doesn't match external ports

**Impact**: Partition services can't bind to their documented ports inside containers. Health checks may fail.

**Recommendation**: Either:
1. Set unique HEALTH_CHECK_PORT per service (3001, 3002, 3003, 3004, 3005, 3006), OR
2. Document that all containers use 3001 internally and only external mapping differs

### 4. DOCUMENTATION DRIFT (3 findings)
**Problem**: Critical architectural documentation is incomplete or stale.
- `CA-020 (HIGH)`: ADR-002 (Redis Streams decision doc) only documents 2 of 12 operational streams
- `CA-012 (MEDIUM)`: No centralized registry of producer/consumer mappings
- `CA-004 (LOW)`: RedisStreams constant declares 9 unused stream names

**Impact**: New developers can't understand system architecture. Operational debugging is difficult.

**Recommendation**: Update ADR-002 with complete stream table. Add lifecycle comments to constants.

### 5. ENV VAR MISMATCHES (3 findings)
**Problem**: 62% of env vars used in code are undocumented.
- `CA-009 (MEDIUM)`: 201 of 322 env vars missing from .env.example
- `CA-016 (LOW)`: 2 feature flags in .env.example but unused in code (FEATURE_AB_TESTING, FEATURE_COW_BACKRUN)
- `CA-014 (MEDIUM)`: Docker env vars don't match service port expectations

**Impact**: New deployments fail due to missing config. Onboarding is painful.

**Recommendation**: Audit all `process.env.*` references and add to .env.example with comments.

### 6. NAMING INCONSISTENCIES (3 findings)
**Problem**: Multiple parallel constant hierarchies for same values.
- `CA-017 (INFO)`: RedisStreams vs RedisStreamsClient.STREAMS both exist
- `CA-011 (LOW)`: stream:service-degradation vs stream:service-recovery (only first exists)
- `CA-005 (MEDIUM)`: execution-engine vs execution-engine-group consumer group mismatch

**Impact**: Code confusion, harder refactoring, potential bugs from wrong constant usage.

**Recommendation**: Standardize on RedisStreams from @arbitrage/types. Deprecate RedisStreamsClient.STREAMS.

### 7. CONFIG DRIFT (4 findings, all INFO/MEDIUM)
**Problem**: Hardcoded strings instead of constants, magic values.
- `CA-006, CA-007, CA-008 (INFO)`: Various files use string literals instead of RedisStreams constants
- `CA-018 (MEDIUM)`: JSDoc examples use hardcoded strings

**Impact**: Harder to refactor, typos possible, inconsistent naming.

**Recommendation**: Import and use RedisStreams constants everywhere. Update JSDoc.

## Discovered Streams vs Code Declarations

**Runtime (Redis) - 12 streams**:
1. stream:pending-opportunities
2. stream:system-failover
3. stream:opportunities
4. stream:swap-events
5. stream:service-degradation
6. stream:dead-letter-queue
7. stream:whale-alerts
8. stream:price-updates
9. stream:execution-results
10. stream:health
11. stream:volume-aggregates
12. stream:execution-requests

**Code Declares (21 streams)**:
- Above 12 PLUS:
- stream:service-health (not in runtime)
- stream:service-events (not in runtime)
- stream:coordinator-events (not in runtime)
- stream:health-alerts (not in runtime)
- stream:circuit-breaker (not in runtime)
- stream:fast-lane (not in runtime)
- stream:dlq-alerts (not in runtime)
- stream:forwarding-dlq (not in runtime)
- stream:service-recovery (not in runtime)
- stream:system-failures (not in runtime)
- stream:system-control (not in runtime)
- stream:system-scaling (not in runtime)
- stream:system-commands (not in runtime)

**Gap**: 13 streams declared but not created (55% declared streams are phantom)

## Consumer Groups Verified

| Stream | Consumer Groups | Consumers | Status |
|--------|----------------|-----------|--------|
| stream:pending-opportunities | cross-chain-detector-group (6), orderflow-pipeline (4) | 10 total | ✅ Active |
| stream:system-failover | failover-coordinator (8) | 8 | ✅ Active |
| stream:opportunities | coordinator-group (8) | 8 | ✅ Active (6 pending, 9822 lag) |
| stream:swap-events | coordinator-group (8) | 8 | ✅ Active |
| stream:service-degradation | - | 0 | ⚠️ No consumers |
| stream:dead-letter-queue | - | 0 | ⚠️ No consumers |
| stream:whale-alerts | coordinator-group (8), cross-chain-detector-group (6) | 14 total | ✅ Active |
| stream:price-updates | coordinator-group (8), cross-chain-detector-group (6) | 14 total | ✅ Active (50 pending) |
| stream:execution-results | coordinator-group (8) | 8 | ✅ Active |
| stream:health | coordinator-group (8) | 8 | ✅ Active (4 pending, 65 lag) |
| stream:volume-aggregates | coordinator-group (8) | 8 | ✅ Active |
| stream:execution-requests | execution-engine-group (7) | 7 | ✅ Active (2 pending) |

**Observations**:
- stream:service-degradation has NO consumers (messages published but never processed)
- stream:dead-letter-queue has NO consumers (DLQ messages accumulate indefinitely)
- Consumer group naming inconsistency: "execution-engine" vs "execution-engine-group" (CA-005)

## Environment Variable Analysis

**Total env vars used in code**: 322
**Documented in .env.example**: 121 (38%)
**Undocumented**: 201 (62%)

**Notable missing env vars**:
- AB_TESTING_* (4 vars)
- BALANCE_MONITOR_* (2 vars)
- BLOXROUTE_BACKOFF_MULTIPLIER
- EXECUTION_HYBRID_* (4 vars)
- JITO_* (multiple)
- KMS_* (multiple)
- NONCE_POOL_* (2 vars)
- OTEL_* (multiple)
- PRICE_BATCHER_*
- SHUTDOWN_DRAIN_TIMEOUT_MS
- STATE_TRANSITION_TIMEOUT_MS
- STREAM_SIGNING_KEY (mentioned in code comments but not .env.example header section)
- STRICT_CONFIG_VALIDATION
- TRADE_LOG_* (2 vars)
- WS_MAX_SLOW_RECOVERY_CYCLES

## Recommendations Priority

### P0 (Immediate - HIGH severity)
1. **CA-001**: Remove or implement stream:system-failures, stream:system-control, stream:system-scaling
2. **CA-010**: Document lifecycle for all 21 declared streams
3. **CA-013**: Fix Docker port mapping inconsistencies (blocks proper containerized deployment)
4. **CA-020**: Update ADR-002 with complete stream registry

### P1 (Short-term - MEDIUM severity)
5. **CA-003**: Create REDIS_STREAMS_SCHEMA.md with message formats
6. **CA-005**: Standardize consumer group names (execution-engine-group everywhere)
7. **CA-009**: Add missing 201 env vars to .env.example
8. **CA-012**: Create producer/consumer mapping documentation
9. **CA-014**: Fix Docker HEALTH_CHECK_PORT config
10. **CA-018**: Update JSDoc examples to use constants

### P2 (Maintenance - LOW/INFO severity)
11. **CA-002, CA-011**: Consolidate service-degradation/service-recovery naming
12. **CA-004, CA-016**: Clean up unused stream/feature flag declarations
13. **CA-006, CA-007, CA-008, CA-017**: Migrate to RedisStreams constants everywhere
14. **CA-015**: Verify peer dependency version alignment
15. **CA-019**: Add lifecycle JSDoc to stream constants

## Files Requiring Updates

**Critical**:
- `shared/core/src/resilience/expert-self-healing-manager.ts` - Remove phantom streams or implement
- `docker-compose.partitions.yml` - Fix port mappings
- `docs/architecture/adr/ADR-002-redis-streams.md` - Complete stream registry
- `.env.example` - Add 201 missing env vars

**High Priority**:
- `shared/types/src/events.ts` - Add lifecycle JSDoc comments
- `services/execution-engine/src/consumers/fast-lane.consumer.ts` - Fix group name
- `docs/architecture/REDIS_STREAMS_SCHEMA.md` - CREATE NEW FILE

**Maintenance**:
- `shared/core/src/monitoring/enhanced-health-monitor.ts` - Use RedisStreams constants
- `shared/core/src/monitoring/cross-region-health.ts` - Use RedisStreams constants
- `services/coordinator/src/coordinator.ts` - Use RedisStreams instead of RedisStreamsClient.STREAMS
- `shared/core/src/resilience/graceful-degradation.ts` - Fix service-recovery stream reference
- Multiple JSDoc comment updates

## Conclusion

The audit revealed significant drift between configuration, code, and runtime reality:
- **Stream declarations**: 55% of declared streams don't exist (13/24 are phantom)
- **Documentation**: Critical ADR-002 only documents 17% of operational streams (2/12)
- **Environment variables**: 62% of used vars are undocumented (201/322)
- **Port configuration**: Docker mappings don't match service expectations

**Root Cause**: Rapid feature development without corresponding documentation updates. Code evolves faster than config/docs.

**Impact**: Operational difficulty, onboarding friction, deployment failures, lost messages from non-existent streams.

**Next Steps**: Prioritize P0 items (stream lifecycle, Docker ports, ADR-002 update). Then systematic P1 env var documentation audit.

## Monitoring Notes

- **No new streams appeared** during audit (baseline 12 maintained)
- **Consumer groups stable** (same group names throughout session)
- **System running nominally** despite config drift issues
- **STOP signal**: Not received (completed full audit)

---

**Agent Status**: COMPLETE
**Findings Written**: `monitor-session/findings/config-auditor.jsonl` (20 entries)
**Summary**: This document
