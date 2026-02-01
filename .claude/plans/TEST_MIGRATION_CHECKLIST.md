# Co-located Test Migration Checklist

**Status**: In Progress
**Phase**: 2 - Structure & Organization
**Date**: February 1, 2026

## Summary
- Total co-located tests found: **46 files**
- Tests to migrate: **46 files**
- Tests to keep as-is: **0 files**

## Migration Priority

### High Priority (Active Development Areas)
Services in active development that need immediate migration.

### Medium Priority (Stable Tests)
Stable modules with low change frequency.

### Low Priority (Deprecated Modules)
Modules scheduled for removal or rarely modified.

---

## Migration List

### Services - Coordinator (1 file, ~1 hour)

- [ ] `services/coordinator/src/leadership/leadership-election-service.test.ts` → `services/coordinator/__tests__/unit/leadership/`
  - Test type: Unit
  - Test count: TBD
  - Dependencies: None
  - Estimated effort: 0.5 hours
  - Priority: High

### Services - Execution Engine (28 files, ~14 hours)

#### API Tests (1 file)
- [ ] `services/execution-engine/src/api/circuit-breaker-api.test.ts` → `services/execution-engine/__tests__/unit/api/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

#### Consumer Tests (2 files)
- [ ] `services/execution-engine/src/consumers/opportunity.consumer.test.ts` → `services/execution-engine/__tests__/unit/consumers/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/consumers/validation.test.ts` → `services/execution-engine/__tests__/unit/consumers/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

#### Core Engine Tests (2 files)
- [ ] `services/execution-engine/src/engine.test.ts` → `services/execution-engine/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/initialization/initialization.test.ts` → `services/execution-engine/__tests__/unit/initialization/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

#### Risk Management Tests (1 file)
- [ ] `services/execution-engine/src/risk/risk-management-orchestrator.test.ts` → `services/execution-engine/__tests__/unit/risk/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

#### Service Tests (3 files)
- [ ] `services/execution-engine/src/services/circuit-breaker.test.ts` → `services/execution-engine/__tests__/unit/services/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/services/provider.service.test.ts` → `services/execution-engine/__tests__/unit/services/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/services/queue.service.test.ts` → `services/execution-engine/__tests__/unit/services/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

#### Simulation Service Tests (10 files)
- [ ] `services/execution-engine/src/services/simulation/alchemy-provider.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/anvil-manager.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/base-simulation-provider.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/hot-fork-synchronizer.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/local-provider.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/pending-state-simulator.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/simulation.service.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/services/simulation/simulation-metrics-collector.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/tenderly-provider.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/services/simulation/types.test.ts` → `services/execution-engine/__tests__/unit/services/simulation/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Low

#### Strategy Tests (9 files)
- [ ] `services/execution-engine/src/strategies/base.strategy.test.ts` → `services/execution-engine/__tests__/unit/strategies/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/strategies/cross-chain.strategy.test.ts` → `services/execution-engine/__tests__/unit/strategies/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/strategies/flash-loan.strategy.test.ts` → `services/execution-engine/__tests__/unit/strategies/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/strategies/flash-loan-providers/provider-factory.test.ts` → `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `services/execution-engine/src/strategies/flash-loan-providers/unsupported.provider.test.ts` → `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Low

- [ ] `services/execution-engine/src/strategies/intra-chain.strategy.test.ts` → `services/execution-engine/__tests__/unit/strategies/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/strategies/simulation.strategy.test.ts` → `services/execution-engine/__tests__/unit/strategies/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/execution-engine/src/strategies/strategy-factory.test.ts` → `services/execution-engine/__tests__/unit/strategies/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

### Services - Unified Detector (3 files, ~1.5 hours)

- [ ] `services/unified-detector/src/chain-instance.test.ts` → `services/unified-detector/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `services/unified-detector/src/integration.test.ts` → `services/unified-detector/__tests__/integration/`
  - Test type: Integration
  - Estimated effort: 0.5 hours
  - Priority: High
  - **Note**: This is an integration test, should go to __tests__/integration/

- [ ] `services/unified-detector/src/unified-detector.test.ts` → `services/unified-detector/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

### Shared - Config (8 files, ~4 hours)

- [ ] `shared/config/src/chains/chain-url-builder.test.ts` → `shared/config/__tests__/unit/chains/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `shared/config/src/config-manager.test.ts` → `shared/config/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `shared/config/src/config-modules.test.ts` → `shared/config/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `shared/config/src/cross-chain.test.ts` → `shared/config/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `shared/config/src/dex-expansion.test.ts` → `shared/config/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `shared/config/src/dex-factories.test.ts` → `shared/config/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `shared/config/src/partitions.test.ts` → `shared/config/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `shared/config/src/websocket-resilience.test.ts` → `shared/config/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

### Shared - Core (5 files, ~2.5 hours)

- [ ] `shared/core/src/components/price-calculator.test.ts` → `shared/core/__tests__/unit/components/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `shared/core/src/factory-subscription.test.ts` → `shared/core/__tests__/unit/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Medium

- [ ] `shared/core/src/risk/drawdown-circuit-breaker.test.ts` → `shared/core/__tests__/unit/risk/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `shared/core/src/risk/ev-calculator.test.ts` → `shared/core/__tests__/unit/risk/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `shared/core/src/risk/execution-probability-tracker.test.ts` → `shared/core/__tests__/unit/risk/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

- [ ] `shared/core/src/risk/position-sizer.test.ts` → `shared/core/__tests__/unit/risk/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: High

### Shared - Test Utils (1 file, ~0.5 hours)

- [ ] `shared/test-utils/src/helpers/timer-helpers.test.ts` → `shared/test-utils/__tests__/unit/helpers/`
  - Test type: Unit
  - Estimated effort: 0.5 hours
  - Priority: Low
  - **Note**: Tests for test utilities themselves

---

## Migration Statistics by Module

| Module | Files | Estimated Hours |
|--------|-------|-----------------|
| services/coordinator | 1 | 0.5 |
| services/execution-engine | 28 | 14.0 |
| services/unified-detector | 3 | 1.5 |
| shared/config | 8 | 4.0 |
| shared/core | 5 | 2.5 |
| shared/test-utils | 1 | 0.5 |
| **Total** | **46** | **23.0** |

---

## Test Type Breakdown

| Test Type | Count |
|-----------|-------|
| Unit | 45 |
| Integration | 1 |
| **Total** | **46** |

---

## Tests to Keep As-Is (With Justification)

None - all tests should migrate to __tests__/ directories per ADR-009.

---

## Migration Notes

### General Guidelines
1. Use `git mv` to preserve file history
2. Update import paths after migration (from `./` to `../../src/` or use package aliases)
3. Test after each migration to ensure no breakage
4. Group migrations by module for easier review

### Import Path Updates
Most tests will need import path updates:
```typescript
// Before (co-located in src/)
import { SomeClass } from './some-file';

// After (in __tests__/unit/)
import { SomeClass } from '../../src/some-file';
// Or use package alias (preferred):
import { SomeClass } from '@arbitrage/module-name';
```

### Directory Creation
Before migration, ensure target directories exist:
```bash
mkdir -p services/execution-engine/__tests__/unit/services/simulation
mkdir -p services/execution-engine/__tests__/unit/strategies/flash-loan-providers
mkdir -p shared/config/__tests__/unit/chains
mkdir -p shared/core/__tests__/unit/components
mkdir -p shared/core/__tests__/unit/risk
```

---

## Post-Migration Verification

After all migrations complete:

1. **Verify no co-located tests remain**:
   ```bash
   find . -path "*/src/*.test.ts" -not -path "*/node_modules/*" -not -path "*/__tests__/*"
   # Should output nothing
   ```

2. **Run all tests**:
   ```bash
   npm test
   ```

3. **Check coverage**:
   ```bash
   npm test -- --coverage
   ```

4. **Update .gitignore** (optional but recommended):
   ```bash
   echo "**/src/*.test.ts" >> .gitignore
   echo "**/src/*.spec.ts" >> .gitignore
   ```

---

**Status**: Ready for P1-1.2 (migration execution)
**Next Step**: Begin migrating tests using this checklist as guide
