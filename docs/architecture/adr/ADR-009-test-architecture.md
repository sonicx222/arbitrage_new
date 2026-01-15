# ADR-009: Modern Test Architecture

## Status
**Proposed** | 2026-01-15

## Context

The current test infrastructure has evolved organically, resulting in:

1. **Fragmented Organization**
   - Test files co-located with source in some packages (`shared/core/src/*.test.ts`)
   - Separate test folders in others (`tests/integration/`)
   - Inconsistent use of `__tests__/` directories
   - No clear separation between unit and integration tests

2. **Import Inconsistencies**
   - Mix of relative paths (`../../../shared/core/src/`)
   - Package aliases (`@arbitrage/core`)
   - Local relative imports (`./module`)
   - Risk of circular dependencies

3. **Duplicated Mock Infrastructure**
   - Redis mock implemented ~10 times across test files
   - Each implementation slightly different
   - No shared test factories
   - Manual test data creation in each file

4. **Global State Issues**
   - Singleton patterns cause test interference
   - Manual `resetXxxInstance()` calls scattered throughout
   - Environment variables not properly isolated between tests
   - No automatic cleanup

5. **Development Experience**
   - New tests require ~30 minutes to set up proper mocks
   - Debugging test failures is difficult due to state leakage
   - No clear guidance for test organization

## Decision

Implement a **unified test architecture** with:

### 1. Structured Directory Layout

```
project/
├── shared/
│   └── core/
│       ├── src/           # Source files only
│       └── __tests__/     # All tests
│           ├── unit/      # Fast, isolated unit tests
│           └── integration/
├── services/
│   └── [service]/
│       ├── src/
│       └── __tests__/
│           ├── unit/
│           └── integration/
└── tests/
    ├── integration/       # Cross-service integration
    ├── e2e/              # End-to-end scenarios
    └── performance/      # Benchmarks
```

### 2. Package-Based Imports

All cross-package imports use package aliases:

```typescript
// ✅ Good - Package alias
import { SwapEventFilter } from '@arbitrage/core';
import { createSwapEvent } from '@arbitrage/test-utils';

// ❌ Bad - Relative path across packages
import { SwapEventFilter } from '../../../shared/core/src/swap-event-filter';
```

### 3. Centralized Test Utilities

All test infrastructure lives in `@arbitrage/test-utils`:

```typescript
// Mocks
import { RedisMock, createRedisMock } from '@arbitrage/test-utils';

// Factories
import { swapEvent, createSwapBatch } from '@arbitrage/test-utils';

// Setup
import { setupTestEnv, resetAllSingletons } from '@arbitrage/test-utils';
```

### 4. Automatic Singleton Reset

Test setup automatically resets all singletons:

```typescript
// shared/test-utils/src/setup/jest-setup.ts
afterEach(async () => {
  await resetAllSingletons();
});
```

### 5. Builder Pattern for Test Data

```typescript
// Instead of manual object creation
const event = {
  pairAddress: '0x...',
  sender: '0x...',
  // ... 15 more fields
};

// Use builder pattern
const event = swapEvent()
  .onChain('bsc')
  .onDex('pancakeswap')
  .asWhale()
  .build();
```

### 6. Jest Project Configuration

```javascript
// jest.config.js
module.exports = {
  projects: [
    { displayName: 'unit', testMatch: ['**/__tests__/unit/**/*.test.ts'] },
    { displayName: 'integration', testMatch: ['**/__tests__/integration/**/*.test.ts', '**/tests/integration/**/*.test.ts'] },
    { displayName: 'e2e', testMatch: ['**/tests/e2e/**/*.test.ts'] }
  ]
};
```

## Rationale

### Why Separate Test Directories?

| Approach | Pros | Cons |
|----------|------|------|
| Co-located (`*.test.ts` next to source) | Easy to find | Mixed with production code |
| Separate `__tests__/` | Clean separation | Need to navigate directories |

**Decision**: Separate `__tests__/` because:
1. Production builds don't need to exclude test files
2. Clear visual separation in IDE
3. Standard practice in enterprise Node.js projects

### Why Package Aliases?

| Import Style | Risk | Maintainability |
|--------------|------|-----------------|
| Relative (`../../../`) | Circular deps, breaks on refactor | Poor |
| Package alias (`@arbitrage/core`) | None | Excellent |

**Decision**: Package aliases because:
1. Prevents circular dependency issues
2. Survives directory restructuring
3. Matches production import patterns

### Why Centralized Mocks?

| Approach | Consistency | Maintenance | Setup Time |
|----------|-------------|-------------|------------|
| Inline mocks per file | Poor | High | ~30 min |
| Shared mock library | Excellent | Low | ~5 min |

**Decision**: Centralized mocks because:
1. Single source of truth
2. Bug fixes apply everywhere
3. Faster test development

### Why Automatic Singleton Reset?

| Approach | Test Isolation | Developer Effort |
|----------|----------------|------------------|
| Manual reset calls | Varies | High |
| Automatic in afterEach | Guaranteed | None |

**Decision**: Automatic reset because:
1. Eliminates test interference
2. Developers can't forget
3. Consistent behavior across all tests

## Consequences

### Positive

1. **Faster Test Development**
   - New tests: ~30 min → ~5 min setup
   - Reusable factories and mocks

2. **Better Test Isolation**
   - Automatic singleton reset
   - Environment isolation
   - No test interference

3. **Improved Maintainability**
   - Single mock implementation
   - Clear organization
   - Consistent patterns

4. **CI/CD Optimization**
   - Run unit tests separately (fast)
   - Integration tests in parallel
   - Clear test categorization

### Negative

1. **Migration Effort**
   - ~58 test files to migrate
   - Estimated 8-12 days

2. **Learning Curve**
   - Team must learn new patterns
   - Documentation required

3. **Potential Test Breakage**
   - Import changes may break tests
   - Thorough verification needed

### Mitigations

1. **Incremental Migration**
   - Migrate in batches
   - Keep old tests working during transition

2. **Documentation**
   - [TEST_ARCHITECTURE.md](../../TEST_ARCHITECTURE.md)
   - [TEST_MIGRATION_PLAN.md](../../TEST_MIGRATION_PLAN.md)
   - Examples in each utility

3. **Verification**
   - Run full test suite after each batch
   - Compare coverage before/after

## Implementation Plan

See [TEST_MIGRATION_PLAN.md](../../TEST_MIGRATION_PLAN.md) for detailed implementation steps.

### Summary

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Infrastructure | 2 days | Base config, mocks, factories |
| 2. Test Utils | 2 days | Complete test-utils package |
| 3. Core Tests | 3 days | Migrate shared/core tests |
| 4. Service Tests | 2 days | Migrate service tests |
| 5. Integration | 2 days | Update integration tests |
| 6. Cleanup | 1 day | Remove old files, verify |

**Total: 8-12 days**

## Alternatives Considered

### Alternative 1: Keep Current Structure

- **Rejected because**: Growing technical debt, test isolation issues
- **Would reconsider if**: Major time constraints

### Alternative 2: Vitest Migration

- **Rejected because**: Jest works well, migration not worth disruption
- **Would reconsider if**: Starting new project

### Alternative 3: Monorepo Test Tools (Nx, Turborepo)

- **Rejected because**: Adds complexity, current scale doesn't require
- **Would reconsider if**: Significantly more packages added

## References

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- [TypeScript Path Mapping](https://www.typescriptlang.org/docs/handbook/module-resolution.html)

## Confidence Level

**85%** - High confidence based on:
- Standard patterns in enterprise Node.js projects
- Clear benefits for maintainability
- Incremental migration path reduces risk
- Team already familiar with Jest
