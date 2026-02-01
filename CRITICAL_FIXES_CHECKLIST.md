# CRITICAL FIXES CHECKLIST
## Arbitrage Project - Production Readiness

**Goal**: Make system deployable
**Timeline**: 1-2 weeks
**Owner**: Development Team

---

## PHASE 1: BUILD BLOCKERS (Week 1 - Must Complete Before Deploy)

### P0-1: TypeScript Compilation Errors ⏱️ 2-4 hours
**File**: `services/unified-detector/src/chain-instance.ts`

- [ ] Fix PairSnapshot import conflict (line 84)
  - Remove local type definition OR use fully qualified import
  - Update all usages to reference correct type

- [ ] Fix ExtendedPair type incompatibility (line 1600)
  - Add required `fee` property OR make optional in type definition

- [ ] Fix bigint/string mismatch in snapshot-manager.ts (lines 190-191)
  - Convert bigint to string OR update type definition

**Verification**: `npm run typecheck` succeeds with 0 errors

---

### P0-2: Fix Failing Unit Tests ⏱️ 2-3 hours
**Files**: Multiple test files

#### Test #1: arbitrage-calculator
- [ ] File: `shared/core/src/arbitrage-calculator.ts:134`
- [ ] Change `return null;` to `return NaN;` for division by zero
- [ ] Verify test passes: `npm test arbitrage-calculator.test.ts`

#### Test #2: rate-limiter
- [ ] File: `shared/security/src/rate-limiter.ts`
- [ ] Change fail-closed to fail-open on Redis errors
- [ ] Add try/catch around Redis calls
- [ ] Return `{ exceeded: false, ... }` on Redis failure
- [ ] Add error logging
- [ ] Verify test passes: `npm test rate-limiter.test.ts`

#### Test #3: tf-backend
- [ ] Investigate TensorFlow initialization failure
- [ ] Option A: Fix TensorFlow dependencies
- [ ] Option B: Disable ML features if not critical
- [ ] Verify test passes OR skip if disabling: `npm test tf-backend.test.ts`

**Verification**: `npm run test:unit` shows 0 failures

---

### P0-3: Fix Jest Configuration ⏱️ 0.5 hours
**File**: `jest.config.js:99-132`

- [ ] Remove `testTimeout` from projects config (invalid property)
- [ ] Move timeout config to per-test level if needed
- [ ] Verify: `npm test` runs without warnings

**Verification**: No Jest validation warnings in output

---

### P1-4: Rate Limiter Fail-Open Fix ⏱️ 1 hour
**File**: `shared/security/src/rate-limiter.ts`

- [ ] Wrap all Redis calls in try/catch
- [ ] On error: return `{ exceeded: false, ... }` (fail-open)
- [ ] Add alert/log for monitoring team
- [ ] Add circuit breaker counter for Redis failures
- [ ] Update test to verify fail-open behavior

**Verification**: Test manually disconnects Redis, requests still succeed

---

### P1-5: Stream Consumption Validation ⏱️ 1-2 hours
**Files**:
- `services/coordinator/src/coordinator.ts`
- `services/execution-engine/src/consumers/opportunity.consumer.ts`

- [ ] Add startup health check for stream connectivity
- [ ] Validate coordinator publishes to same stream engine consumes from
- [ ] Add runtime assertion: `EXECUTION_REQUESTS` stream exists
- [ ] Log stream names on startup for verification
- [ ] Add test: coordinator → engine message flow

**Verification**: Service startup fails fast if stream config mismatched

---

### P1-6: Worker Pool Memory Leak ⏱️ 1 hour
**File**: `shared/core/src/async/worker-pool.ts:415-435`

- [ ] Wrap `removeAllListeners()` in try/catch
- [ ] Change `worker.on()` to `worker.once()` for cleanup
- [ ] Add test: restart worker 100 times, verify listener count stable
- [ ] Add memory profiling to integration tests

**Verification**: Memory usage stable after 1000 worker restarts

---

### P1-7: Silent Forwarding Failures ⏱️ 3-4 hours
**File**: `services/coordinator/src/coordinator.ts:1788-1803`

- [ ] Add retry queue for transient stream failures
- [ ] Add dead letter queue for permanent failures
- [ ] Throw error instead of silent return for critical paths
- [ ] Add metric: `opportunities_dropped_count`
- [ ] Add alert: trigger if > 5 opportunities dropped in 1 min
- [ ] Add test: Redis disconnection triggers retry, then DLQ

**Verification**: Opportunities retry 3x before moving to DLQ

---

## PHASE 2: HIGH PRIORITY (Week 2-3 - Before Staging Deploy)

### P1-12: Private Key Management ⏱️ 4-6 hours

- [ ] Verify `.env` in `.gitignore`
- [ ] Run: `git log --all --source -- .env` to check git history
- [ ] Remove any committed keys from history (BFG Repo-Cleaner)
- [ ] Set up AWS Secrets Manager OR HashiCorp Vault
- [ ] Update deployment scripts to fetch keys from secrets manager
- [ ] Update documentation: remove `.env.example` key placeholders
- [ ] Rotate all keys as precaution

**Verification**: No private keys in git history or .env files

---

### P2-9: Centralize Configuration ⏱️ 8-12 hours

- [ ] Create single config schema with Zod
- [ ] Consolidate `.env`, `docker-compose.yml`, hardcoded values
- [ ] Move chain configs to single source
- [ ] Add validation: fail fast on startup if config invalid
- [ ] Add config documentation generator
- [ ] Update all services to use centralized config

**Verification**: Single command shows all config values

---

### P2-11: Remove Deprecated Calculator ⏱️ 2-3 hours

- [ ] Grep for all `arbitrage-calculator` imports
- [ ] Migrate to `components/price-calculator`
- [ ] Remove `shared/core/src/arbitrage-calculator.ts`
- [ ] Remove deprecation warnings (hot path fix)
- [ ] Update tests

**Verification**: No console.warn in production logs

---

## PHASE 3: ONGOING (Month 2+)

### P2-8: Extract God Objects ⏱️ 8-12 hours per file

**Coordinator** (2,444 lines → 4-6 files):
- [ ] Extract `StreamConsumer` class
- [ ] Extract `LeaderElection` class
- [ ] Extract `HealthMonitor` class
- [ ] Extract `AlertManager` class
- [ ] Keep core coordinator < 500 lines

**Execution Engine** (2,134 lines):
- [ ] Extract `TransactionBuilder` class
- [ ] Extract `GasEstimator` class
- [ ] Extract `NonceManager` class
- [ ] Keep core engine < 500 lines

**Chain Instance** (2,240 lines):
- [ ] Already started extraction to `detection/` folder
- [ ] Complete extraction
- [ ] Keep core < 500 lines

**Verification**: No files > 1000 lines

---

### P2-10: Enable TypeScript Strict Mode ⏱️ 16-20 hours

- [ ] Add `"strict": true` to `tsconfig.json`
- [ ] Fix all compilation errors (likely 500+)
- [ ] Remove all `: any` types (50+ instances)
- [ ] Add proper type guards
- [ ] Add type tests for critical interfaces

**Verification**: `npm run typecheck` with strict mode succeeds

---

### P2-14: Integration Tests ⏱️ 12-16 hours

- [ ] Add test: Detector → Coordinator → Engine flow
- [ ] Add test: Circuit breaker failover
- [ ] Add test: Leader election under load
- [ ] Add test: Redis disconnection recovery
- [ ] Add test: Stream consumer group state
- [ ] Add test: End-to-end arbitrage detection + execution

**Verification**: Integration test suite covers critical paths

---

## VERIFICATION COMMANDS

After completing each phase:

```bash
# Build verification
npm run build
npm run typecheck

# Test verification
npm run test:unit
npm run test:integration
npm run test:e2e

# Linting
npm run lint

# Security audit
npm audit
npm audit fix

# Deployment readiness
docker-compose -f infrastructure/docker/docker-compose.local.yml up --build
# Verify all services start and pass health checks
```

---

## SUCCESS CRITERIA

### Phase 1 Complete ✅
- [ ] All builds succeed (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] No Jest warnings
- [ ] System can run locally via Docker Compose

### Phase 2 Complete ✅
- [ ] Secrets in secrets manager (not .env)
- [ ] Configuration centralized
- [ ] No deprecated code warnings

### Phase 3 Complete ✅
- [ ] TypeScript strict mode enabled
- [ ] 80%+ test coverage
- [ ] All files < 1000 lines
- [ ] Integration tests cover critical paths

---

## EMERGENCY BYPASS (Not Recommended)

If you MUST deploy before all fixes:

1. ✅ **MUST FIX** (P0-1, P0-2, P0-3): System won't run otherwise
2. ✅ **MUST FIX** (P1-4): Rate limiter DOS vulnerability
3. ⚠️ **High Risk** to skip P1-5, P1-6, P1-7
4. ⚠️ **Security Risk** to skip P1-12

**Not recommended**: Deploy without Phase 1 complete = guaranteed failures

---

**Last Updated**: February 1, 2026
**Track Progress**: Check off items as completed
**Estimated Total Time**: 40-60 hours (1-2 weeks full-time)
