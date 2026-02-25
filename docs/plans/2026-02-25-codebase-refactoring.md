# Codebase Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce code duplication, consolidate scattered type definitions, clean up the public API surface, and safely decompose large files — all while preserving the <50ms hot-path latency target.

**Architecture:** Incremental refactoring organized into 5 groups (A-E) with explicit dependency graph. Groups A and B are fully SAFE (performance-guardian approved, zero hot-path impact). Group C is a long-running barrel migration. Group D contains CONDITIONAL refactorings requiring benchmarks. Group E covers performance optimizations from the hot-path audit.

**Tech Stack:** TypeScript, Node.js, Jest, ESLint, `@arbitrage/*` path aliases

**Source Analysis:** Based on 4-agent team analysis (structural-analyst, code-quality-analyst, performance-guardian, migration-planner) covering 162K LOC, 415 test files, 12,761 tests.

---

## Dependency Graph

```
GROUP A (all independent, run in parallel):
  A1: Logger consolidation
  A2: getErrorMessage adoption
  A3: Error result helper
  A4: Env parsing consolidation
  A5: Internal export leak fix
  A6: Deprecated code removal
  A7: Deadline constant consolidation

GROUP B (independent of each other, run in parallel after or alongside A):
  B1: Cross-chain service/library split
  B2: Failover bootstrap extraction
  B3: Import path deduplication (unified-detector types.ts)
  B4: CLAUDE.md documentation fix

GROUP C (long-running, start after A5):
  C1: Sub-entry point migration ──depends──> A5 (internal export fix)
  C2: ESLint rule enforcement ──depends──> C1

GROUP D (CONDITIONAL, requires benchmarks, start after A+B):
  D1: WebSocket cold-path extraction ──depends──> A2 (uses getErrorMessage)
  D2: Execution engine decomposition ──depends──> A3, A4 (strategy helpers)
  D3: Long strategy method splits ──depends──> A3, A7 (error helper + deadline)

GROUP E (performance optimization, independent of A-D):
  E1: Object.entries → for...in in estimateSize
  E2: EventBatcher sort optimization
```

### Parallelism Summary

| Can run in parallel | Must be sequential |
|--------------------|--------------------|
| A1, A2, A3, A4, A5, A6, A7 (all 7) | C1 after A5 |
| B1, B2, B3, B4 (all 4) | C2 after C1 |
| B-group alongside A-group | D1/D2/D3 after relevant A-tasks |
| E1, E2 (both, anytime) | D2 needs benchmarks |

---

## Performance Safety Legend

Each task is annotated:

- **SAFE** — Zero hot-path impact. Performance-guardian approved unconditionally.
- **CONDITIONAL** — Touches hot-path-adjacent code. Specific conditions and benchmarks required.
- **HOT-PATH: NONE / INDIRECT / DIRECT** — Proximity to the <50ms detection/execution path.

---

## GROUP A: Independent Quick Wins (All Parallelizable)

All tasks in Group A are independent of each other and can be executed in any order or simultaneously by separate agents.

---

### Task A1: Logger Interface Consolidation

**Performance:** SAFE | HOT-PATH: NONE (type-only change, zero runtime impact)

**Files:**
- Modify: `services/coordinator/src/leadership/leadership-election-service.ts:25-30` — remove local `Logger` interface
- Modify: `services/coordinator/src/api/types.ts:152-157` — remove local `Logger` interface
- Modify: `services/coordinator/src/standby-activation-manager.ts:24-29` — remove local `Logger` interface
- Modify: `services/cross-chain-detector/src/whale-analyzer.ts:44-49` — remove local `Logger` interface
- Modify: `services/unified-detector/src/types.ts:32-37` — remove local `Logger` interface
- Modify: `services/execution-engine/src/types.ts:517-522` — remove local `Logger` interface
- Modify: `shared/core/src/redis/distributed-lock.ts:34-39` — remove local `Logger` interface
- Reference: `shared/types/src/common.ts:11-16` — canonical `ILogger` (DO NOT modify)
- Reference: `shared/core/src/logger.ts:22-27` — backward-compat `Logger` with `any` meta (DO NOT modify)

**Context:** 10+ separate Logger/ILogger definitions exist across the codebase. The canonical minimal interface is `ILogger` in `shared/types/src/common.ts:11` with 4 methods (info, error, warn, debug). Service-local interfaces are structurally identical but use slightly different meta parameter types (`object` vs `Record<string, unknown>`).

**Important:** The `ILogger` from `@arbitrage/types` uses `Record<string, unknown>` meta. The service-local versions use `object` meta. Since `Record<string, unknown>` is assignable to `object`, this is a safe replacement. The backward-compat `Logger` in `shared/core/src/logger.ts` has `any` meta and additional methods (fatal, trace) — leave it alone per code conventions.

**Step 1: Write verification test**

Create `shared/types/__tests__/logger-compat.test.ts`:

```typescript
import type { ILogger } from '@arbitrage/types';

// Verify ILogger is structurally compatible with all usage patterns
describe('ILogger compatibility', () => {
  it('should accept Record<string, unknown> metadata', () => {
    const logger: ILogger = {
      info: (msg: string, meta?: Record<string, unknown>) => {},
      error: (msg: string, meta?: Record<string, unknown>) => {},
      warn: (msg: string, meta?: Record<string, unknown>) => {},
      debug: (msg: string, meta?: Record<string, unknown>) => {},
    };
    // Should compile without errors
    logger.info('test', { key: 'value' });
    logger.error('test', { count: 42 });
    expect(logger).toBeDefined();
  });

  it('should accept plain object metadata', () => {
    const logger: ILogger = {
      info: (msg: string, meta?: Record<string, unknown>) => {},
      error: (msg: string, meta?: Record<string, unknown>) => {},
      warn: (msg: string, meta?: Record<string, unknown>) => {},
      debug: (msg: string, meta?: Record<string, unknown>) => {},
    };
    const meta: object = { foo: 'bar' };
    // Record<string, unknown> accepts object values
    logger.info('test', meta as Record<string, unknown>);
    expect(logger).toBeDefined();
  });
});
```

**Step 2: Run test to verify it passes**

```bash
npx jest shared/types/__tests__/logger-compat.test.ts --no-coverage
```

Expected: PASS

**Step 3: Replace each service-local Logger with ILogger import**

For each file listed above, replace the local `interface Logger { ... }` block with:

```typescript
import type { ILogger } from '@arbitrage/types';
```

Then replace all usages of `Logger` with `ILogger` in that file. Example for `leadership-election-service.ts`:

Before (lines 25-30):
```typescript
interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
```

After:
```typescript
import type { ILogger } from '@arbitrage/types';
```

And change constructor/field types from `Logger` to `ILogger`.

**Note for files using `object` meta type** (api/types.ts, standby-activation-manager.ts, unified-detector/types.ts, distributed-lock.ts): These use `meta?: object` instead of `meta?: Record<string, unknown>`. Since `ILogger` uses `Record<string, unknown>` and `object` is a supertype of `Record<string, unknown>`, the existing call sites will compile without changes. However, if any call site passes a plain `{}` literal, TypeScript may narrow differently. Verify with typecheck.

**Note for `execution-engine/src/types.ts:517`:** This `Logger` is `export`ed and may have consumers. Grep for imports:
```bash
# Check who imports Logger from execution-engine types
npx grep -r "import.*Logger.*from.*types" services/execution-engine/src/
```
If consumers exist, keep the re-export: `export type { ILogger as Logger } from '@arbitrage/types';`

**Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS with zero new errors

**Step 5: Run affected tests**

```bash
npx jest --testPathPattern="leadership-election|standby-activation|whale-analyzer|distributed-lock" --no-coverage
```

Expected: All PASS

**Step 6: Commit**

```bash
git add shared/types/__tests__/logger-compat.test.ts
git add services/coordinator/src/leadership/leadership-election-service.ts
git add services/coordinator/src/api/types.ts
git add services/coordinator/src/standby-activation-manager.ts
git add services/cross-chain-detector/src/whale-analyzer.ts
git add services/unified-detector/src/types.ts
git add services/execution-engine/src/types.ts
git add shared/core/src/redis/distributed-lock.ts
git commit -m "refactor: consolidate 8 duplicate Logger interfaces to ILogger from @arbitrage/types"
```

---

### Task A2: Adopt getErrorMessage() (149 inline occurrences)

**Performance:** SAFE | HOT-PATH: NONE (error paths only, never in happy path)

**Files:**
- Reference: `shared/core/src/resilience/error-handling.ts:425` — canonical `getErrorMessage()` (DO NOT modify)
- Modify: ~69 files across `services/` and `shared/` containing the inline pattern

**Context:** The pattern `error instanceof Error ? error.message : String(error)` appears 149 times across 69 files. The shared utility `getErrorMessage(error)` at `shared/core/src/resilience/error-handling.ts:425` does exactly this but is only used in 13 files.

**Step 1: Identify all occurrences**

```bash
# Find all inline error extraction patterns
npx grep -rn "error instanceof Error ? error\.message : String(error)" services/ shared/ --include="*.ts" | grep -v node_modules | grep -v __tests__
```

**Step 2: For each file, add import and replace pattern**

Add to imports (if not already present):
```typescript
import { getErrorMessage } from '@arbitrage/core';
```

Replace each occurrence:
```typescript
// Before:
error instanceof Error ? error.message : String(error)

// After:
getErrorMessage(error)
```

For files that also extract `.stack`:
```typescript
// Before:
const message = error instanceof Error ? error.message : String(error);
const stack = error instanceof Error ? error.stack : undefined;

// After:
const message = getErrorMessage(error);
const stack = error instanceof Error ? (error as Error).stack : undefined;
```

**Important:** Files in `shared/core/src/resilience/` that DEFINE `getErrorMessage` should NOT import it from themselves. Skip those files.

**Important:** Files in `shared/config/`, `shared/types/`, or `shared/constants/` should NOT import from `@arbitrage/core` (wrong dependency direction). For those files, keep the inline pattern.

**Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

**Step 4: Run full test suite**

```bash
npm test -- --no-coverage
```

Expected: All existing tests PASS (behavioral equivalent)

**Step 5: Commit in batches**

Do this per-package to keep commits reviewable:
```bash
# Batch 1: shared/core
git add shared/core/src/
git commit -m "refactor: replace inline error extraction with getErrorMessage in shared/core"

# Batch 2: services/execution-engine
git add services/execution-engine/src/
git commit -m "refactor: replace inline error extraction with getErrorMessage in execution-engine"

# Batch 3: remaining services
git add services/
git commit -m "refactor: replace inline error extraction with getErrorMessage in services"
```

---

### Task A3: Error Result Helper Extraction

**Performance:** SAFE | HOT-PATH: NONE (error paths only)

**Files:**
- Modify: `services/execution-engine/src/strategies/base.strategy.ts` — add helper method
- Modify: `services/execution-engine/src/strategies/intra-chain.strategy.ts` — 19 call sites
- Modify: `services/execution-engine/src/strategies/cross-chain.strategy.ts` — 19 call sites
- Modify: `services/execution-engine/src/strategies/flash-loan.strategy.ts` — 17 call sites
- Test: `services/execution-engine/__tests__/unit/strategies/`

**Context:** `createErrorResult()` is imported from `@arbitrage/types` (defined at `shared/types/src/execution.ts:103`). Its signature is `createErrorResult(opportunityId, error, chain, dex, txHash?)`. Every error return in strategies manually passes `chain` and `opportunity.buyDex || 'unknown'`, creating a data clump.

**Step 1: Write failing test**

Create `services/execution-engine/__tests__/unit/strategies/error-helper.test.ts`:

```typescript
import { BaseExecutionStrategy } from '../../../src/strategies/base.strategy';
import type { ArbitrageOpportunity } from '@arbitrage/types';

describe('createOpportunityError helper', () => {
  it('should create error result from opportunity', () => {
    // Access the static helper directly
    const opportunity = {
      id: 'opp-123',
      buyDex: 'uniswap-v3',
      chain: 'ethereum',
    } as ArbitrageOpportunity;

    const result = BaseExecutionStrategy.createOpportunityError(
      opportunity,
      '[ERR_GAS_SPIKE] Gas price exceeded threshold',
      'ethereum'
    );

    expect(result.opportunityId).toBe('opp-123');
    expect(result.success).toBe(false);
    expect(result.error).toBe('[ERR_GAS_SPIKE] Gas price exceeded threshold');
    expect(result.chain).toBe('ethereum');
    expect(result.dex).toBe('uniswap-v3');
  });

  it('should default dex to unknown when buyDex is undefined', () => {
    const opportunity = {
      id: 'opp-456',
      chain: 'bsc',
    } as ArbitrageOpportunity;

    const result = BaseExecutionStrategy.createOpportunityError(
      opportunity,
      '[ERR_NO_CHAIN] Chain not configured',
      'bsc'
    );

    expect(result.dex).toBe('unknown');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx jest services/execution-engine/__tests__/unit/strategies/error-helper.test.ts --no-coverage
```

Expected: FAIL — `BaseExecutionStrategy.createOpportunityError is not a function`

**Step 3: Add helper to BaseExecutionStrategy**

In `services/execution-engine/src/strategies/base.strategy.ts`, add:

```typescript
import { createErrorResult } from '../types';
import type { ArbitrageOpportunity, ExecutionResult } from '@arbitrage/types';

// Add as a static method on the class:
  /**
   * Create a standardized error result from an opportunity.
   * Consolidates the repeated pattern of extracting chain/dex from opportunity objects.
   */
  static createOpportunityError(
    opportunity: ArbitrageOpportunity,
    error: string,
    chain: string,
    transactionHash?: string
  ): ExecutionResult {
    return createErrorResult(
      opportunity.id,
      error,
      chain,
      opportunity.buyDex || 'unknown',
      transactionHash
    );
  }
```

**Step 4: Run test to verify it passes**

```bash
npx jest services/execution-engine/__tests__/unit/strategies/error-helper.test.ts --no-coverage
```

Expected: PASS

**Step 5: Replace call sites in strategy files**

In each strategy file, replace:
```typescript
// Before:
return createErrorResult(
  opportunity.id,
  formatExecutionError(ExecutionErrorCode.GAS_SPIKE, 'details'),
  chain,
  opportunity.buyDex || 'unknown'
);

// After:
return BaseExecutionStrategy.createOpportunityError(
  opportunity,
  formatExecutionError(ExecutionErrorCode.GAS_SPIKE, 'details'),
  chain
);
```

**Step 6: Run strategy tests**

```bash
npx jest --testPathPattern="strategies" --no-coverage
```

Expected: All PASS

**Step 7: Commit**

```bash
git add services/execution-engine/src/strategies/base.strategy.ts
git add services/execution-engine/src/strategies/intra-chain.strategy.ts
git add services/execution-engine/src/strategies/cross-chain.strategy.ts
git add services/execution-engine/src/strategies/flash-loan.strategy.ts
git add services/execution-engine/__tests__/unit/strategies/error-helper.test.ts
git commit -m "refactor: extract createOpportunityError helper, replacing 55 duplicate call sites"
```

---

### Task A4: Env Var Parsing Consolidation

**Performance:** SAFE | HOT-PATH: NONE (startup-only code)

**Files:**
- Reference: `shared/config/src/utils/env-parsing.ts` — `safeParseInt`, `safeParseFloat` (value-based, DO NOT modify)
- Reference: `shared/core/src/utils/env-utils.ts:46` — `parseEnvInt` (name-based, throwing — keep as canonical)
- Reference: `shared/core/src/utils/env-utils.ts:94` — `parseEnvIntSafe` (name-based, safe — keep as canonical)
- Modify: `services/execution-engine/src/engine.ts:477` — remove inline `parseEnvInt` closure
- Modify: `services/execution-engine/src/engine.ts:1112` — remove inline `parseNumericEnv` closure
- Modify: `services/execution-engine/src/strategies/base.strategy.ts:148` — remove `parseValidatedEnvInt`

**Context:** 6 implementations of "parse env var as integer." Two canonical versions exist in shared packages. Three inline copies exist in engine.ts and base.strategy.ts.

**Step 1: Verify inline closures in engine.ts**

```bash
# Find the inline parseEnvInt/parseNumericEnv closures
npx grep -n "const parseEnvInt\|const parseNumericEnv\|function parseValidatedEnvInt" services/execution-engine/src/engine.ts services/execution-engine/src/strategies/base.strategy.ts
```

**Step 2: Replace inline closures with imports**

In `engine.ts`, replace the inline closures with imports from `@arbitrage/core`:

```typescript
// Already imported at the top of engine.ts (verify):
import { parseEnvInt, parseEnvIntSafe } from '@arbitrage/core';
```

Then remove the inline closure definitions and update call sites:
- `parseEnvInt('NAME', default)` → use the imported `parseEnvInt('NAME', default)` from core
- `parseNumericEnv('NAME', default)` → use `parseEnvIntSafe('NAME', default)` from core

In `base.strategy.ts`, remove the module-level `parseValidatedEnvInt` function and replace with:
```typescript
import { parseEnvInt } from '@arbitrage/core';
```

**Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

**Step 4: Run engine tests**

```bash
npx jest --testPathPattern="engine|base.strategy" --no-coverage
```

Expected: All PASS

**Step 5: Commit**

```bash
git add services/execution-engine/src/engine.ts
git add services/execution-engine/src/strategies/base.strategy.ts
git commit -m "refactor: replace 3 inline env parsing functions with shared parseEnvInt from @arbitrage/core"
```

---

### Task A5: Remove Internal Export Leak

**Performance:** SAFE | HOT-PATH: NONE (build-time only)

**Files:**
- Modify: `shared/core/src/index.ts:2053` — remove `export * from './internal'`
- Modify: ~20 test files that import internal symbols from `@arbitrage/core` (redirect to `@arbitrage/core/internal`)

**Context:** Line 2053 of `shared/core/src/index.ts` is `export * from './internal'`, which leaks ~80 internal symbols (reset functions, ABI constants, deprecation utilities) into the public API surface. The internal module explicitly warns these may change between minor versions.

**Step 1: Find all consumers of internal symbols via the barrel**

```bash
# Find files importing known internal-only symbols from @arbitrage/core
npx grep -rn "from '@arbitrage/core'" --include="*.ts" | grep -v node_modules | grep -E "reset|Recording|getWorkerPool|Null" > /tmp/internal-consumers.txt
```

**Step 2: Remove the star re-export**

In `shared/core/src/index.ts`, delete line 2053:
```typescript
// DELETE THIS LINE:
export * from './internal';
```

**Step 3: Run typecheck to find breakages**

```bash
npm run typecheck 2>&1 | head -100
```

Expected: TypeScript errors for files importing internal symbols from `@arbitrage/core`

**Step 4: Fix each broken import**

For each error, change:
```typescript
// Before:
import { resetRedisInstance, RecordingLogger } from '@arbitrage/core';

// After:
import { resetRedisInstance, RecordingLogger } from '@arbitrage/core/internal';
```

**Step 5: Run typecheck again**

```bash
npm run typecheck
```

Expected: PASS

**Step 6: Run full test suite**

```bash
npm test -- --no-coverage
```

Expected: All PASS

**Step 7: Commit**

```bash
git add shared/core/src/index.ts
git add -A  # All the import path fixes
git commit -m "refactor: remove export * from internal, redirect 20 test files to @arbitrage/core/internal"
```

---

### Task A6: Deprecated Code Removal

**Performance:** SAFE | HOT-PATH: INDIRECT (deprecated wrappers just call new functions)

**Files:**
- Modify: `shared/core/src/utils/fee-utils.ts:149-299` — remove 8 deprecated exports
- Modify: `shared/core/src/components/price-calculator.ts:106-115` — remove deprecated `BLOCK_TIMES_MS` and `getBlockTimeMs`
- Test: `shared/core/__tests__/unit/fee-utils.test.ts`

**Step 1: Audit consumers of deprecated symbols**

```bash
# Check for any imports of deprecated fee utilities
npx grep -rn "UNISWAP_V2_FEE\|UNISWAP_V3_LOW_FEE\|UNISWAP_V3_MED_FEE\|UNISWAP_V3_HIGH_FEE\|DEFAULT_DEX_FEE\|dexFeeToPercentage\|percentageToDexFee\|dexFeeToMultiplier\|v3TierToFee\|percentageToFee" --include="*.ts" services/ shared/ | grep -v node_modules | grep -v __tests__ | grep -v "fee-utils.ts"
```

**Step 2: If consumers exist, update them first**

Replace each usage with the recommended replacement documented in the `@deprecated` JSDoc.

**Step 3: Remove deprecated code from fee-utils.ts**

Delete lines 149-299 containing the deprecated functions and constants.

**Step 4: Update fee-utils.test.ts**

Remove test cases for deprecated functions. Keep tests for current functions only.

**Step 5: Repeat for price-calculator.ts deprecated exports**

```bash
npx grep -rn "BLOCK_TIMES_MS\|getBlockTimeMs" --include="*.ts" services/ shared/ | grep -v node_modules | grep -v __tests__ | grep -v "price-calculator.ts"
```

**Step 6: Run typecheck and tests**

```bash
npm run typecheck
npx jest --testPathPattern="fee-utils|price-calculator" --no-coverage
```

Expected: PASS

**Step 7: Commit**

```bash
git add shared/core/src/utils/fee-utils.ts
git add shared/core/src/components/price-calculator.ts
git add shared/core/__tests__/
git commit -m "refactor: remove 10 deprecated fee/timing utilities after consumer migration"
```

---

### Task A7: Deadline Constant Consolidation

**Performance:** SAFE | HOT-PATH: NONE (transaction preparation, dominated by RPC calls)

**Files:**
- Modify: `services/execution-engine/src/strategies/base.strategy.ts` — add constant + helper
- Modify: `services/execution-engine/src/strategies/intra-chain.strategy.ts` — use helper
- Modify: `services/execution-engine/src/strategies/flash-loan.strategy.ts` — use helper
- Modify: `services/execution-engine/src/strategies/cross-chain.strategy.ts` — use helper

**Step 1: Find all deadline occurrences**

```bash
npx grep -rn "Math.floor(Date.now" services/execution-engine/src/strategies/ --include="*.ts" | grep -v __tests__
```

**Step 2: Add constant and helper to base.strategy.ts**

```typescript
/** Default transaction deadline offset in seconds (5 minutes) */
protected static readonly DEADLINE_OFFSET_SECONDS = 300;

/** Get current transaction deadline (now + 5 minutes, in Unix seconds) */
protected getCurrentDeadline(): number {
  return Math.floor(Date.now() / 1000) + BaseExecutionStrategy.DEADLINE_OFFSET_SECONDS;
}
```

**Step 3: Replace all inline calculations**

```typescript
// Before:
deadline: Math.floor(Date.now() / 1000) + 300,

// After:
deadline: this.getCurrentDeadline(),
```

**Step 4: Run strategy tests**

```bash
npx jest --testPathPattern="strategies" --no-coverage
```

Expected: All PASS

**Step 5: Commit**

```bash
git add services/execution-engine/src/strategies/
git commit -m "refactor: consolidate 4 hardcoded deadline calculations to getCurrentDeadline() helper"
```

---

## GROUP B: Structural Cleanup (All Parallelizable, Independent of Group A)

---

### Task B1: Cross-Chain-Detector Service/Library Separation

**Performance:** SAFE | HOT-PATH: NONE

**Files:**
- Create: `services/cross-chain-detector/src/exports.ts` — all library exports
- Modify: `services/cross-chain-detector/src/index.ts:65-251` — remove exports, keep service bootstrap
- Modify: `services/cross-chain-detector/package.json` — point `main`/`exports` to `exports.ts`

**Context:** `index.ts` (250 lines) mixes service bootstrap (lines 1-63) with 40+ library exports (lines 65-251). Importing any type from this package also triggers the service bootstrap code. The unified-detector already solved this pattern with `exports.ts`.

**Step 1: Create exports.ts**

Move all export blocks (lines 65-251) from `index.ts` to a new `services/cross-chain-detector/src/exports.ts`:

```typescript
/**
 * Cross-Chain Detector Library Exports
 *
 * Import from this module for library/type access.
 * The service entry point (index.ts) is separate to prevent
 * auto-execution when importing types.
 *
 * @see ADR-014: Modular Detector Components
 */

// 1. PUBLIC API
export { CrossChainDetectorService } from './detector';

// 2. Types
export { /* all type exports from original index.ts */ } from './types';

// ... (copy all remaining export sections 3-8)
```

**Step 2: Reduce index.ts to service bootstrap only**

Keep lines 1-63 (service bootstrap). Replace lines 65-251 with:
```typescript
// Library exports available via exports.ts (package.json "exports" field)
export * from './exports';
```

**Step 3: Update package.json**

```json
{
  "main": "dist/exports.js",
  "types": "dist/exports.d.ts",
  "exports": {
    ".": "./dist/exports.js",
    "./service": "./dist/index.js"
  }
}
```

**Step 4: Run typecheck and tests**

```bash
npm run typecheck
npx jest --testPathPattern="cross-chain" --no-coverage
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/cross-chain-detector/src/exports.ts
git add services/cross-chain-detector/src/index.ts
git add services/cross-chain-detector/package.json
git commit -m "refactor: separate cross-chain-detector service entry from library exports"
```

---

### Task B2: Failover Bootstrap Extraction

**Performance:** SAFE | HOT-PATH: NONE (startup-only code)

**Files:**
- Create: `shared/core/src/cross-region/bootstrap.ts` — shared failover utilities
- Modify: `services/coordinator/src/index.ts:50-82,152-196`
- Modify: `services/execution-engine/src/index.ts:94-112,226-263`
- Test: Create `shared/core/__tests__/unit/cross-region/bootstrap.test.ts`

**Context:** Both coordinator and execution-engine define `getStandbyConfigFromEnv()` parsing nearly identical env vars, and both have ~40 lines of duplicated failover event wiring.

**Step 1: Write failing test**

```typescript
// shared/core/__tests__/unit/cross-region/bootstrap.test.ts
import { parseStandbyConfig } from '../../../src/cross-region/bootstrap';

describe('parseStandbyConfig', () => {
  beforeEach(() => {
    delete process.env.IS_STANDBY;
    delete process.env.REGION_ID;
  });

  it('should parse standby=false by default', () => {
    const config = parseStandbyConfig('test-service');
    expect(config.isStandby).toBe(false);
  });

  it('should parse IS_STANDBY=true', () => {
    process.env.IS_STANDBY = 'true';
    const config = parseStandbyConfig('test-service');
    expect(config.isStandby).toBe(true);
  });

  it('should include cross-region config', () => {
    const config = parseStandbyConfig('test-service');
    expect(config).toHaveProperty('healthCheckInterval');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx jest shared/core/__tests__/unit/cross-region/bootstrap.test.ts --no-coverage
```

Expected: FAIL — module not found

**Step 3: Implement shared bootstrap utility**

Create `shared/core/src/cross-region/bootstrap.ts`:

```typescript
import { getCrossRegionEnvConfig } from '../cross-region-health';

export interface StandbyConfig {
  isStandby: boolean;
  healthCheckInterval: number;
  // ... other shared fields from getCrossRegionEnvConfig
}

export function parseStandbyConfig(serviceName: string): StandbyConfig {
  const isStandby = process.env.IS_STANDBY === 'true';
  const crossRegion = getCrossRegionEnvConfig(serviceName);
  return { isStandby, ...crossRegion };
}
```

**Step 4: Run test to verify it passes**

```bash
npx jest shared/core/__tests__/unit/cross-region/bootstrap.test.ts --no-coverage
```

Expected: PASS

**Step 5: Migrate coordinator and execution-engine**

Replace service-local `getStandbyConfigFromEnv()` with calls to `parseStandbyConfig()`, adding service-specific fields after:

```typescript
// coordinator/src/index.ts
import { parseStandbyConfig } from '@arbitrage/core';

function getStandbyConfigFromEnv() {
  const base = parseStandbyConfig('coordinator');
  const leaderLockKey = process.env.LEADER_LOCK_KEY || 'coordinator:leader:lock';
  // ... coordinator-specific fields
  return { ...base, leaderLockKey, /* ... */ };
}
```

**Step 6: Run affected tests**

```bash
npx jest --testPathPattern="coordinator|execution-engine" --no-coverage
```

Expected: PASS

**Step 7: Commit**

```bash
git add shared/core/src/cross-region/bootstrap.ts
git add shared/core/__tests__/unit/cross-region/bootstrap.test.ts
git add services/coordinator/src/index.ts
git add services/execution-engine/src/index.ts
git commit -m "refactor: extract shared failover bootstrap from coordinator and execution-engine"
```

---

### Task B3: Import Path Deduplication (unified-detector types.ts)

**Performance:** SAFE | HOT-PATH: INDIRECT (MinHeap used in detection but import path doesn't affect runtime)

**Files:**
- Modify: `services/unified-detector/src/types.ts:9-22,396` — remove re-exports
- Modify: ~5 consumer files importing re-exported symbols

**Step 1: Find consumers of re-exported symbols**

```bash
npx grep -rn "from '@arbitrage/unified-detector'" --include="*.ts" | grep -E "MinHeap|findKSmallest|findKLargest|FeeBasisPoints|FeeDecimal|bpsToDecimal"
```

**Step 2: Remove re-exports from types.ts**

Delete the re-export lines at types.ts:9-22 (fee utilities) and types.ts:396 (MinHeap, findKSmallest, findKLargest).

**Step 3: Update consumers to import from canonical locations**

```typescript
// Before:
import { findKSmallest } from '@arbitrage/unified-detector';

// After:
import { findKSmallest } from '@arbitrage/core';
// OR (preferred sub-entry point):
import { findKSmallest } from '@arbitrage/core/data-structures/min-heap';
```

**Step 4: Remove deprecated validateFee() wrapper**

If `validateFee` is still in types.ts, remove it (it delegates to the canonical implementation).

**Step 5: Run typecheck and tests**

```bash
npm run typecheck
npx jest --testPathPattern="unified-detector" --no-coverage
```

Expected: PASS

**Step 6: Commit**

```bash
git add services/unified-detector/src/types.ts
# Add any consumer files that were updated
git commit -m "refactor: remove re-exports from unified-detector types.ts, standardize import paths"
```

---

### Task B4: CLAUDE.md Documentation Fix

**Performance:** N/A | HOT-PATH: N/A

**Files:**
- Modify: `CLAUDE.md`

**Context:** CLAUDE.md says "P4 (partition-solana) does NOT use the factory — manual 503-line `index.ts`". This is stale — P4 now uses `createPartitionEntry` with lifecycle hooks and is 240 lines.

**Step 1: Update the relevant section**

Change:
```
- P4 (partition-solana) does NOT use the factory -- manual 503-line `index.ts` with Solana-specific RPC handling
```

To:
```
- P4 (partition-solana) uses `createPartitionEntry()` with lifecycle hooks (onStarted, onStartupError, additionalCleanup) for Solana-specific wiring (240 lines vs 62-68 for P1-P3)
```

Also update:
```
- Shared test mocks in `shared/test-utils/src/mocks/partition-service.mock.ts` exist but are incomplete (missing `createPartitionEntry`, `runPartitionService`) -- tests use inline mocks instead
```

And update the reference to `partition-service-utils.ts (~1288 lines)` — this file no longer exists. It's been split into `shared/core/src/partition/` (6 files, 1920 total lines).

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md stale references to P4 Solana and partition-service-utils"
```

---

## GROUP C: Barrel Export Migration (Sequential, Start After A5)

### Task C1: Migrate @arbitrage/core Consumers to Sub-Entry Points

**Performance:** SAFE | HOT-PATH: INDIRECT (faster module resolution at startup)

**Depends on:** Task A5 (internal export leak must be fixed first to avoid confusion about what's public vs internal)

**Files:**
- Modify: ~122 files importing from `@arbitrage/core` barrel
- Reference: `shared/core/src/index.ts` lines 18-56 — documented sub-entry points

**Context:** 251 imports use the bare `@arbitrage/core` barrel (87%). Sub-entry points like `@arbitrage/core/caching`, `@arbitrage/core/analytics`, `@arbitrage/core/resilience` exist but are barely adopted.

**Strategy:** Migrate one service at a time. For each service:

1. List all imports from `@arbitrage/core` in that service
2. Map each symbol to its sub-entry point (documented in index.ts header)
3. Replace barrel import with sub-entry point import
4. Run typecheck
5. Run service tests
6. Commit

**Migration order** (largest consumers first):
1. `services/unified-detector/src/chain-instance.ts` (~30 symbols from barrel)
2. `services/execution-engine/src/engine.ts` (~25 symbols from barrel)
3. `services/coordinator/src/coordinator.ts` (~20 symbols from barrel)
4. `services/cross-chain-detector/src/detector.ts` (~15 symbols from barrel)
5. Remaining services and shared packages

**Example transformation:**

```typescript
// Before (chain-instance.ts):
import {
  PriceMatrix, HierarchicalCache, ReserveCache,
  MLOpportunityScorer, SwapEventFilter,
  CircuitBreaker, createLogger,
} from '@arbitrage/core';

// After:
import { PriceMatrix, HierarchicalCache, ReserveCache } from '@arbitrage/core/caching';
import { MLOpportunityScorer } from '@arbitrage/core/analytics';
import { SwapEventFilter } from '@arbitrage/core/detection';
import { CircuitBreaker } from '@arbitrage/core/resilience';
import { createLogger } from '@arbitrage/core';  // Keep foundational in barrel
```

**Commit per service:**
```bash
git commit -m "refactor: migrate unified-detector imports from barrel to sub-entry points"
```

---

### Task C2: ESLint Rule Enforcement

**Performance:** SAFE | HOT-PATH: NONE (build tooling only)

**Depends on:** Task C1 (majority of consumers migrated)

**Files:**
- Modify: `eslint.config.js`

**Add rule to warn on barrel imports for new code:**

```javascript
{
  rules: {
    'no-restricted-imports': ['warn', {
      patterns: [{
        group: ['@arbitrage/core'],
        message: 'Import from sub-entry points (@arbitrage/core/caching, @arbitrage/core/analytics, etc.) instead of the barrel export.',
        // Allow a small set of foundational symbols from barrel:
        // createLogger, getRedisClient, etc.
      }],
    }],
  },
}
```

**Note:** Use `warn` initially, not `error`, to allow gradual migration.

```bash
git add eslint.config.js
git commit -m "chore: add ESLint warning for @arbitrage/core barrel imports"
```

---

## GROUP D: Conditional Refactorings (Require Benchmarks)

These tasks touch hot-path-adjacent code. Each has specific conditions from the performance-guardian that MUST be followed.

---

### Task D1: WebSocket Cold-Path Extraction

**Performance:** CONDITIONAL | HOT-PATH: INDIRECT (extracting cold-path only)

**Depends on:** Task A2 (getErrorMessage used in extracted code)

**Files:**
- Modify: `shared/core/src/websocket-manager.ts` (1565 lines → ~750 lines)
- Create: `shared/core/src/ws/provider-rotation.ts`
- Create: `shared/core/src/ws/provider-health.ts`
- Create: `shared/core/src/ws/budget-selector.ts`
- Test: Existing websocket-manager tests

**PERFORMANCE-GUARDIAN CONDITIONS:**
1. `handleMessage()` at line 808 MUST stay in WebSocketManager
2. `processMessage()` at line 936 MUST stay in WebSocketManager
3. `parseMessageSync()` at line 847 MUST stay in WebSocketManager
4. `parseMessageInWorker()` at line 865 MUST stay in WebSocketManager
5. NO new abstraction layers between message receipt and message processing
6. Extracted classes must be instantiated ONCE at construction time (not per-message)

**BENCHMARK REQUIRED:**
Before starting, measure baseline:
```bash
# Run websocket performance test (if exists)
npx jest --testPathPattern="websocket.*perf" --no-coverage
```

After completion, re-run and compare. P99 `handleMessage` latency must not increase.

**Extract only these cold-path concerns:**
- Provider rotation logic (reconnection, selection) → `ProviderRotationStrategy`
- Provider health tracking (quality metrics, 10s interval) → `ProviderHealthTracker`
- Budget-aware request routing (outbound only) → `BudgetAwareSelector`

**DO NOT extract:**
- Message handling pipeline (handleMessage → parseMessage → processMessage)
- messageHandlers Set
- Any code called per-message

---

### Task D2: Execution Engine Decomposition

**Performance:** CONDITIONAL | HOT-PATH: INDIRECT

**Depends on:** Tasks A3 (error helper), A4 (env parsing)

**Files:**
- Modify: `services/execution-engine/src/engine.ts` (2431 lines → ~1400 lines)
- Create: `services/execution-engine/src/strategy-orchestrator.ts`
- Create: `services/execution-engine/src/solana-strategy-factory.ts`

**PERFORMANCE-GUARDIAN CONDITIONS:**
1. `executeOpportunity()` at line 1712 MUST remain a single synchronous dispatch chain
2. No new `await` points before strategy selection
3. The orchestrator must hold direct references to sub-services (no service locator)
4. Constructor DI only — no factory lookups during hot-path calls
5. `processQueueItems()` loop must remain in a single class

**BENCHMARK REQUIRED:**
```bash
# Measure executeOpportunity overhead with mock strategy
npx jest --testPathPattern="execution-flow" --no-coverage
```

**Step 1: Extract SolanaStrategyFactory first (LOW risk)**

Move `engine.ts:1138-1250` (Solana init, 5 nesting levels) to `solana-strategy-factory.ts`. This is pure startup code with zero hot-path impact.

**Step 2: Extract StrategyOrchestrator (MEDIUM risk)**

Move strategy initialization and dispatch to `strategy-orchestrator.ts`. Keep `executeOpportunity()` as a thin delegation call.

---

### Task D3: Long Strategy Method Splits

**Performance:** CONDITIONAL | HOT-PATH: INDIRECT (dominated by RPC calls)

**Depends on:** Tasks A3 (error helper), A7 (deadline constant)

**Files:**
- Modify: `services/execution-engine/src/strategies/cross-chain.strategy.ts` (2028 lines)
- Modify: `services/execution-engine/src/strategies/flash-loan.strategy.ts` (1827 lines)

**PERFORMANCE-GUARDIAN CONDITIONS:**
1. Sub-methods MUST NOT introduce new try-catch blocks in main execution path
2. MUST NOT use `async` on sub-methods that don't actually await
3. MUST NOT create new object allocations for passing intermediate state between sub-methods — use `this` properties

**These are lower-priority** because RPC call latency (100-1000ms) dominates the function call overhead (+5μs). Do these for readability, not performance.

---

## GROUP E: Performance Optimizations (From Hot-Path Audit)

These are independent of Groups A-D and can be done at any time.

---

### Task E1: Replace Object.entries() in estimateSize()

**Performance:** MEDIUM impact | HOT-PATH: DIRECT (called on every cache write)

**Files:**
- Modify: `shared/core/src/caching/hierarchical-cache.ts:1302`

**Context:** `Object.entries()` creates a new array of `[key, value]` tuples on every call. This is in `estimateSize()` which runs on every L1 cache write (500-1000/sec).

**Before:**
```typescript
const entries = Object.entries(obj as Record<string, unknown>);
```

**After:**
```typescript
let size = 32;
let sampleCount = 0;
for (const key in obj) {
  if (sampleCount >= 5) break;
  size += key.length * 2 + 16;
  size += this.estimateValueSize((obj as Record<string, unknown>)[key], depth + 1);
  sampleCount++;
}
```

**Test:** Run hierarchical-cache performance tests before/after.

---

### Task E2: EventBatcher Sort Optimization

**Performance:** LOW-MEDIUM impact | HOT-PATH: DIRECT (runs on every flush)

**Files:**
- Modify: `shared/core/src/event-batcher.ts:250`

**Context:** `sortProcessingQueue()` runs O(n log n) sort on every `flushBatch()`. Since items are mostly appended in order, insertion sort would be O(n) for nearly-sorted data.

**Alternative:** Use a binary heap (priority queue) for O(log n) insertion instead of O(n log n) re-sort. However, this is a bigger change. Start with measuring the current sort overhead before deciding.

**Benchmark first:**
```bash
npx jest --testPathPattern="event-batcher.*perf" --no-coverage
```

---

## Verification Checklist

After all tasks complete:

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (all 12,761 tests)
- [ ] `npm run lint:fix` has no new warnings
- [ ] No new `export * from` patterns added
- [ ] No new inline `error instanceof Error ? error.message : String(error)` patterns
- [ ] No new local `Logger` interface definitions
- [ ] Hot-path files unchanged unless explicitly CONDITIONAL with benchmark results
- [ ] CLAUDE.md updated to reflect current codebase state
