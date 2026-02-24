# Implementation Plan: Source File Reorganization

**Date:** 2026-02-24
**Status:** READY FOR EXECUTION
**Scope:** `shared/core/src/` (241 files) + cross-cutting consolidation
**Goal:** Reorganize 25 of 30 root-level loose files into proper subdirectories, eliminate code duplication, and reduce barrel export bloat
**Performance Impact:** +0ms on hot-path (all proposals verified SAFE by performance audit)

---

## Table of Contents

1. [Guiding Principles](#guiding-principles)
2. [Decision Log](#decision-log)
3. [Pre-Flight Checklist](#pre-flight-checklist)
4. [Phase 1: Quick Wins](#phase-1-quick-wins-low-importer-files--existing-directories)
5. [Phase 2: New Subdirectories](#phase-2-new-subdirectories)
6. [Phase 3: Cross-Cutting Consolidation](#phase-3-cross-cutting-consolidation)
7. [Phase 4: Barrel Export & Shim Cleanup](#phase-4-barrel-export--shim-cleanup)
8. [Phase 5: Optional Package Extraction](#phase-5-optional-package-extraction)
9. [Files NOT to Touch](#files-not-to-touch)
10. [Verification Protocol](#verification-protocol)
11. [Appendix: Full Import Graph](#appendix-full-import-graph)

---

## Guiding Principles

1. **Shim-first migration**: Files with >5 direct importers get a backward-compatible re-export shim at the old path. Shims are removed in Phase 4 after all importers are migrated.
2. **One batch, one typecheck**: Run `npm run typecheck` after every batch. Never stack batches without verification.
3. **Barrel export updated per-batch**: Each batch updates `shared/core/src/index.ts` to point to the new location. The shim at the old path catches internal relative-path imports.
4. **Internal barrel too**: `shared/core/src/internal/index.ts` must be updated for any moved file that exports reset functions.
5. **Tests move with source**: If a test file imports via relative path, update it in the same batch. Tests importing via `@arbitrage/core` need no changes.
6. **No renaming in Phase 1-2**: Files keep their original names when moved. Renaming (e.g., `redis.ts` → `client.ts`) happens only when creating new directories where the directory name provides context.
7. **Hot-path files are move-only**: Moving files has zero runtime cost (module resolution is cached at startup). No logic changes to hot-path code.

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Use re-export shims for `redis.ts` (18 importers), `redis-streams.ts` (14 importers), `lifecycle-utils.ts` (27 importers) | Minimizes blast radius. Shims are zero-cost at runtime (Node.js module cache). |
| D2 | Name new dir `redis/`, not `infrastructure/redis/` | Consistent with existing flat naming (`caching/`, `rpc/`, `async/`). |
| D3 | Rename `redis.ts` → `redis/client.ts`, `redis-streams.ts` → `redis/streams.ts` | Directory name provides "redis" prefix; avoids `redis/redis.ts`. |
| D4 | Move lifecycle/timer utils to `async/`, not a new `lifecycle/` dir | `async/` already has `async-utils.ts`, `worker-pool.ts`, `queue-lock.ts` — same domain (concurrency/timing primitives). |
| D5 | Move `event-batcher.ts` to `async/` | Generic batching primitive, not detector-specific. Although hot-path, file location has zero runtime impact (confirmed by performance audit). |
| D6 | Do quick wins (Phase 1) before new directories (Phase 2) | Proves the mechanical pattern on low-risk files before tackling high-importer moves. |
| D7 | Do `redis/` move last within Phase 2 | Highest-risk move (32 direct importers). Better to have the shim pattern proven first. |
| D8 | Keep circuit breaker implementations separate (DO NOT unify) | Performance guardian: CONDITIONAL. Execution-engine's closure-based `canExecute()` is synchronous and called per-opportunity. Shared version uses AsyncMutex. Different API patterns. Cost of unification exceeds benefit. |
| D9 | Keep `factory-subscription.ts` root file as-is | Already a backward-compat re-export shim (documented R10 refactoring). Works correctly. |
| D10 | Keep `simulation-mode.ts` root file as-is | Already a re-export shim (61 lines). Same pattern as `logger.ts`. Not worth the churn. |
| D11 | Do NOT add new sub-entry points in this plan | Sub-entry points (`@arbitrage/core/redis`, etc.) are a separate enhancement. This plan is file organization only. |
| D12 | Eliminate core `validation.ts`, use `@arbitrage/security` for HTTP validation | Duplicate Joi middleware. Security package has complete chain coverage (11 chains vs 5). |

---

## Pre-Flight Checklist

Run these before starting any phase:

```bash
# 1. Verify clean working tree
git status

# 2. Verify build passes
npm run build

# 3. Verify tests pass
npm test

# 4. Create a tracking branch
git checkout -b refactor/file-reorganization
```

**Checkpoint format**: After each batch, commit with message:
```
refactor(core): [batch-id] [description]

Part of file reorganization plan (2026-02-24).
See docs/reports/IMPLEMENTATION_PLAN_FILE_REORGANIZATION_2026-02-24.md
```

---

## Phase 1: Quick Wins (Low-Importer Files → Existing Directories)

**Target**: Move 8 files with ≤3 direct importers into existing subdirectories.
**Risk**: LOW — only barrel export (`index.ts`) needs updating for most files.
**Estimated file changes per batch**: 2-4 files

---

### Batch 1.1: Utils Consolidation

**Move 3 root-level `*-utils.ts` files into `utils/`**

| File | Lines | Direct Importers (excl. barrel/internal) | Action |
|------|-------|----------------------------------------|--------|
| `env-utils.ts` | 183 | 0 (barrel-only) | Move to `utils/env-utils.ts` |
| `hmac-utils.ts` | 108 | 1 (`risk/execution-probability-tracker.ts`) | Move to `utils/hmac-utils.ts` |
| `disconnect-utils.ts` | 55 | 0 (barrel-only) | Move to `utils/disconnect-utils.ts` |

**Steps:**

1. Move files:
   ```
   shared/core/src/env-utils.ts       → shared/core/src/utils/env-utils.ts
   shared/core/src/hmac-utils.ts      → shared/core/src/utils/hmac-utils.ts
   shared/core/src/disconnect-utils.ts → shared/core/src/utils/disconnect-utils.ts
   ```

2. Update `utils/index.ts` — add re-exports for the 3 new files:
   ```typescript
   export * from './env-utils';
   export * from './hmac-utils';
   export * from './disconnect-utils';
   ```

3. Update `shared/core/src/index.ts` — change import paths:
   - Line ~1855: `from './env-utils'` → `from './utils/env-utils'`
   - Line ~1891: `from './hmac-utils'` → `from './utils/hmac-utils'`
   - Line ~1901: `from './disconnect-utils'` → `from './utils/disconnect-utils'`

4. Update the 1 direct importer:
   - `risk/execution-probability-tracker.ts`: change `from '../hmac-utils'` → `from '../utils/hmac-utils'`

5. Update `internal/index.ts` — no changes needed (none of these export reset functions).

6. Check for test files that import directly:
   ```bash
   grep -rn "from.*env-utils\|from.*hmac-utils\|from.*disconnect-utils" shared/core/__tests__/ --include="*.ts"
   ```
   Update any relative-path test imports.

7. **Verify:**
   ```bash
   npm run typecheck
   npm run test:changed
   ```

8. **Commit:** `refactor(core): batch-1.1 move env/hmac/disconnect utils to utils/`

**Rollback:** `git revert HEAD`

---

### Batch 1.2: Monitoring Consolidation

**Move 3 files into `monitoring/`**

| File | Lines | Direct Importers | Action |
|------|-------|-----------------|--------|
| `performance-monitor.ts` | ~150 | 0 (barrel-only) | Move to `monitoring/` |
| `provider-health-tracker.ts` | 329 | 1 (`websocket-manager.ts`) | Move to `monitoring/` |
| `v8-profiler.ts` | ~80 | 0 (barrel-only) | Move to `monitoring/` |

**Steps:**

1. Move files:
   ```
   shared/core/src/performance-monitor.ts       → shared/core/src/monitoring/performance-monitor.ts
   shared/core/src/provider-health-tracker.ts    → shared/core/src/monitoring/provider-health-tracker.ts
   shared/core/src/v8-profiler.ts               → shared/core/src/monitoring/v8-profiler.ts
   ```

2. Update internal imports within moved files:
   - `provider-health-tracker.ts` imports from `./monitoring/provider-health-scorer`. After move, this becomes `./provider-health-scorer` (now a sibling).
   - `provider-health-tracker.ts` imports from `./logger`. After move, this becomes `../logger`.
   - Check all relative imports in each moved file and adjust depth (`./` → `../`).

3. Update `monitoring/index.ts` — add re-exports.

4. Update `shared/core/src/index.ts`:
   - Section 4 (MONITORING & HEALTH): change `from './performance-monitor'` → `from './monitoring/performance-monitor'`
   - Change `from './provider-health-tracker'` → `from './monitoring/provider-health-tracker'`
   - Change `from './v8-profiler'` → `from './monitoring/v8-profiler'`

5. Update `internal/index.ts`:
   - Line ~87: `from '../performance-monitor'` → `from '../monitoring/performance-monitor'`

6. Update 1 direct importer:
   - `websocket-manager.ts`: `from './provider-health-tracker'` → `from './monitoring/provider-health-tracker'`

7. Update test file imports.

8. **Verify:** `npm run typecheck && npm run test:changed`

9. **Commit:** `refactor(core): batch-1.2 move performance/provider-health/v8-profiler to monitoring/`

---

### Batch 1.3: RPC Consolidation

**Move 1 file into `rpc/`**

| File | Lines | Direct Importers | Action |
|------|-------|-----------------|--------|
| `provider-rotation-strategy.ts` | 467 | 1 (`websocket-manager.ts`) | Move to `rpc/` |

**Steps:**

1. Move: `provider-rotation-strategy.ts` → `rpc/provider-rotation-strategy.ts`

2. Update internal imports within the moved file:
   - `from './monitoring/provider-health-scorer'` → `from '../monitoring/provider-health-scorer'`
   - `from './logger'` → `from '../logger'`
   - Adjust all relative paths (one level deeper).

3. Update `rpc/index.ts` — add re-export.

4. Update `shared/core/src/index.ts`:
   - Change `from './provider-rotation-strategy'` → `from './rpc/provider-rotation-strategy'`

5. Update 1 direct importer:
   - `websocket-manager.ts`: `from './provider-rotation-strategy'` → `from './rpc/provider-rotation-strategy'`

6. **Verify:** `npm run typecheck && npm run test:changed`

7. **Commit:** `refactor(core): batch-1.3 move provider-rotation-strategy to rpc/`

---

### Batch 1.4: AMM Math Extraction

**Extract duplicated BigInt constants + AMM formula into new shared util**

| Source File | Lines | Duplicated Code |
|------------|-------|----------------|
| `cross-dex-triangular-arbitrage.ts` | 1,056 | Constants (lines 19-21), AMM formula (~lines 804-821), `calculateDynamicSlippage()` (~lines 167-191), `DEFAULT_SLIPPAGE_CONFIG` (~lines 114-120) |
| `multi-leg-path-finder.ts` | 1,034 | Same constants (lines 31-33), same AMM formula (~lines 587-601), same `calculateDynamicSlippage()` (~lines 629-650), same config (~lines 151-157) |

**Create:** `shared/core/src/utils/amm-math.ts`

**Contents of new file:**
```typescript
/**
 * Shared AMM (Automated Market Maker) math utilities.
 *
 * Extracted from cross-dex-triangular-arbitrage.ts and multi-leg-path-finder.ts
 * where these were duplicated byte-for-byte.
 *
 * @module utils/amm-math
 * @see cross-dex-triangular-arbitrage.ts
 * @see multi-leg-path-finder.ts
 */

// BigInt precision constants
export const PRECISION_MULTIPLIER = 10n ** 18n;
export const BASIS_POINTS_DIVISOR = 10000n;
export const ONE_ETH_WEI = 10n ** 18n;

// Dynamic slippage configuration
export interface DynamicSlippageConfig { ... }  // Copy from cross-dex

export const DEFAULT_SLIPPAGE_CONFIG: DynamicSlippageConfig = { ... };  // Consolidate (use env-var version from cross-dex)

// AMM constant-product swap output calculation
export function calculateAmmAmountOut(
  amountInBigInt: bigint,
  reserveInBigInt: bigint,
  reserveOutBigInt: bigint,
  feeBigInt: bigint
): bigint | null { ... }  // Return null on zero denominator (multi-leg pattern, safer)

// Dynamic slippage calculation
export function calculateDynamicSlippage(
  tradeSize: number,
  reserveIn: number,
  liquidityUsd: number,
  config: DynamicSlippageConfig
): number { ... }  // Copy from cross-dex (has default param)
```

**Steps:**

1. Read both files to capture the exact duplicated code.

2. Create `shared/core/src/utils/amm-math.ts` with the extracted constants, types, and functions.

3. Add re-export to `utils/index.ts`:
   ```typescript
   export * from './amm-math';
   ```

4. Update `cross-dex-triangular-arbitrage.ts`:
   - Remove local `PRECISION_MULTIPLIER`, `BASIS_POINTS_DIVISOR`, `ONE_ETH_WEI` constants.
   - Remove local `DynamicSlippageConfig` interface and `DEFAULT_SLIPPAGE_CONFIG`.
   - Remove local `calculateDynamicSlippage()` method.
   - Replace inline AMM formula with call to `calculateAmmAmountOut()`.
   - Add import: `import { PRECISION_MULTIPLIER, BASIS_POINTS_DIVISOR, ONE_ETH_WEI, calculateAmmAmountOut, calculateDynamicSlippage, DEFAULT_SLIPPAGE_CONFIG } from './utils/amm-math';`
   - **Handle the error divergence**: cross-dex throws on zero denominator, multi-leg returns null. Use the null-return pattern in the shared function and update cross-dex to check for null.

5. Update `multi-leg-path-finder.ts`:
   - Same removals as above.
   - Already imports `DynamicSlippageConfig` TYPE from cross-dex (line 25). Change to import from `./utils/amm-math`.
   - Replace inline AMM formula with call to `calculateAmmAmountOut()`.

6. Update `shared/core/src/index.ts`:
   - Add exports for the new AMM math symbols (or rely on `utils/index.ts` re-export if the barrel already does `export * from './utils'`).
   - Check: does the barrel currently export `DynamicSlippageConfig`? If so, no barrel change needed (it will flow through the utils re-export). If the type was only exported from `cross-dex-triangular-arbitrage.ts`, update the barrel source.

7. **Verify:**
   ```bash
   npm run typecheck
   npm test -- --testPathPattern="cross-dex|multi-leg|amm-math"
   ```

8. **Commit:** `refactor(core): batch-1.4 extract shared AMM math from cross-dex and multi-leg`

**Performance note:** Performance guardian confirmed SAFE. V8 TurboFan JIT inlines small hot functions after ~1000 calls. Even without inlining, function call overhead is <0.05% of BigInt arithmetic cost.

---

### Phase 1 Checkpoint

After all 4 batches:
```bash
npm run build
npm test
```

**Expected state:**
- 8 root-level files moved to existing directories
- 1 new utility file created (`utils/amm-math.ts`)
- ~50 lines of code duplication eliminated
- Root-level file count: 30 → 22
- All tests passing

---

## Phase 2: New Subdirectories

**Target**: Create 4 new subdirectories and move 10 files into them.
**Risk**: LOW-MEDIUM — shims needed for `redis/` and `async/` expansion.

---

### Batch 2.1: Create `path-finding/`

**Move 3 path-finding files into new `shared/core/src/path-finding/` directory**

| File | Lines | Direct Importers | Action |
|------|-------|-----------------|--------|
| `cross-dex-triangular-arbitrage.ts` | ~1,006 (after AMM extraction) | 1 (`multi-leg-path-finder.ts`) | Move |
| `multi-leg-path-finder.ts` | ~984 (after AMM extraction) | 0 (barrel-only) | Move |
| `cross-chain-price-tracker.ts` | 386 | 0 (barrel-only) | Move |

**Steps:**

1. Create directory: `shared/core/src/path-finding/`

2. Move files:
   ```
   cross-dex-triangular-arbitrage.ts  → path-finding/cross-dex-triangular-arbitrage.ts
   multi-leg-path-finder.ts           → path-finding/multi-leg-path-finder.ts
   cross-chain-price-tracker.ts       → path-finding/cross-chain-price-tracker.ts
   ```

3. Create `path-finding/index.ts` barrel:
   ```typescript
   export * from './cross-dex-triangular-arbitrage';
   export * from './multi-leg-path-finder';
   export * from './cross-chain-price-tracker';
   ```

4. Update internal imports within moved files:
   - All `from '../something'` patterns become `from '../../something'` patterns since we're one level deeper. Specifically:
     - `from './logger'` → `from '../logger'`
     - `from './utils/amm-math'` → `from '../utils/amm-math'`
     - `from '@arbitrage/config'` — no change (package alias)
     - `from '@arbitrage/types'` — no change (package alias)
   - `multi-leg-path-finder.ts` imports from `cross-dex-triangular-arbitrage.ts`: update to sibling import `from './cross-dex-triangular-arbitrage'`

5. Update `shared/core/src/index.ts` — Section 6 (DETECTION & ARBITRAGE):
   - Change `from './cross-dex-triangular-arbitrage'` → `from './path-finding/cross-dex-triangular-arbitrage'`
   - Change `from './multi-leg-path-finder'` → `from './path-finding/multi-leg-path-finder'`
   - Change `from './cross-chain-price-tracker'` → `from './path-finding/cross-chain-price-tracker'`

6. Update `internal/index.ts`:
   - Line ~63: `from '../multi-leg-path-finder'` → `from '../path-finding/multi-leg-path-finder'`

7. **Verify:** `npm run typecheck && npm run test:changed`

8. **Commit:** `refactor(core): batch-2.1 create path-finding/ directory`

---

### Batch 2.2: Create `partition/`

**Split `partition-service-utils.ts` (1,494 lines) into focused modules + move `partition-router.ts`**

| File | Lines | Direct Importers | Action |
|------|-------|-----------------|--------|
| `partition-service-utils.ts` | 1,494 | 1 (`lifecycle-utils.ts`) | Split into 4 modules |
| `partition-router.ts` | 355 | 1 (`partition-service-utils.ts`) | Move to `partition/` |

**Create directory:** `shared/core/src/partition/`

**Split `partition-service-utils.ts` into:**

| New File | Responsibility | Approx Lines | Source Lines |
|----------|---------------|-------------|--------------|
| `partition/config.ts` | Types, env parsing, validation, instance ID | ~340 | Lines 30-305 |
| `partition/health-server.ts` | HTTP server creation, response caching, shutdown | ~280 | Lines 306-771 |
| `partition/handlers.ts` | Detector event handlers, process signal handlers | ~250 | Lines 772-1021 |
| `partition/runner.ts` | Service runner lifecycle, entry point factory | ~630 | Lines 1022-1494 |
| `partition/router.ts` | (Moved from `partition-router.ts`) | 355 | Entire file |
| `partition/index.ts` | Barrel re-export (ALL symbols for backward compat) | ~30 | New |

**Steps:**

1. Create `shared/core/src/partition/` directory.

2. Read `partition-service-utils.ts` fully. Map every export to its target sub-module.

3. Create 4 sub-module files by extracting code:
   - `config.ts`: All types (PartitionServiceConfig, PartitionEnvironmentConfig, HealthServerOptions, etc.), `parsePartitionEnvironmentConfig()`, `validatePartitionEnvironmentConfig()`, `generateInstanceId()`, `exitWithConfigError()`, `parsePort()`, `validateAndFilterChains()`
   - `health-server.ts`: `createPartitionHealthServer()`, `closeServerWithTimeout()`, `shutdownPartitionService()`
   - `handlers.ts`: `DetectorEventHandlerCleanup`, `setupDetectorEventHandlers()`, `ProcessHandlerCleanup`, `setupProcessHandlers()`
   - `runner.ts`: `ServiceLifecycleState`, `PartitionServiceRunnerOptions`, `PartitionServiceRunner`, `createPartitionServiceRunner()`, `runPartitionService()`, `PartitionEntryResult`, `PartitionEntryHooks`, `createPartitionEntry()`

4. Move `partition-router.ts` → `partition/router.ts`. Update its internal imports (one level deeper).

5. Create `partition/index.ts` that re-exports everything:
   ```typescript
   export * from './config';
   export * from './health-server';
   export * from './handlers';
   export * from './runner';
   export * from './router';
   ```

6. **Create shim** at old path `shared/core/src/partition-service-utils.ts`:
   ```typescript
   /**
    * @deprecated Import from './partition' instead.
    * This re-export shim exists for backward compatibility during migration.
    * Will be removed in Phase 4.
    */
   export * from './partition';
   ```

7. **Create shim** at old path `shared/core/src/partition-router.ts`:
   ```typescript
   export * from './partition/router';
   ```

8. Update `shared/core/src/index.ts` — Section 12 (PARTITION SERVICES):
   - Change `from './partition-service-utils'` → `from './partition'`
   - Change `from './partition-router'` → `from './partition/router'`

9. Update `internal/index.ts` — if any partition reset functions exist.

10. **Verify:** `npm run typecheck && npm run test:changed`

11. **Commit:** `refactor(core): batch-2.2 create partition/ directory, split partition-service-utils`

---

### Batch 2.3: Create `service-lifecycle/`

**Move 2 service lifecycle files into new directory**

| File | Lines | Direct Importers | Action |
|------|-------|-----------------|--------|
| `service-bootstrap.ts` | 389 | 0 (barrel-only) | Move |
| `service-state.ts` | 591 | 0 (barrel-only) | Move |

**Steps:**

1. Create `shared/core/src/service-lifecycle/`
2. Move files, create `index.ts` barrel.
3. Update internal imports within moved files (adjust relative paths).
4. Update `shared/core/src/index.ts` — Section 1.4:
   - Change `from './service-state'` → `from './service-lifecycle/service-state'`
   - Change `from './service-bootstrap'` → `from './service-lifecycle/service-bootstrap'`
5. **Verify:** `npm run typecheck && npm run test:changed`
6. **Commit:** `refactor(core): batch-2.3 create service-lifecycle/ directory`

---

### Batch 2.4: Expand `async/` (HIGH IMPORT COUNT — USE SHIMS)

**Move 4 files into `async/`**

| File | Lines | Direct Importers (excl. barrel) | Shim Needed? |
|------|-------|-------------------------------|-------------|
| `lifecycle-utils.ts` | ~80 | **27 within shared/core/src** | **YES** |
| `interval-manager.ts` | ~60 | 0 | No |
| `event-batcher.ts` | 476 | 0 (barrel-only) | No |
| `event-processor-worker.ts` | 429 | 0 (runtime-loaded by worker-pool) | No (but runtime path update needed) |

**Steps:**

1. Move files:
   ```
   lifecycle-utils.ts         → async/lifecycle-utils.ts
   interval-manager.ts        → async/interval-manager.ts
   event-batcher.ts           → async/event-batcher.ts
   event-processor-worker.ts  → async/event-processor-worker.ts
   ```

2. Update internal imports within moved files:
   - All `from '../something'` stays the same (already one level deep in async/).
   - `from './logger'` → `from '../logger'`
   - `from './lifecycle-utils'` → `from './lifecycle-utils'` (now a sibling in async/).

3. **Create shim** at old path `shared/core/src/lifecycle-utils.ts`:
   ```typescript
   /**
    * @deprecated Import from './async/lifecycle-utils' instead.
    * Shim for 27 internal importers. Will be removed in Phase 4.
    */
   export * from './async/lifecycle-utils';
   ```
   This preserves all 27 `from '../lifecycle-utils'` imports without changes.

4. Update `async/index.ts` — add re-exports:
   ```typescript
   export * from './lifecycle-utils';
   export * from './interval-manager';
   export * from './event-batcher';
   // Note: event-processor-worker.ts is a worker script, not exported
   ```

5. Update `shared/core/src/index.ts`:
   - Line ~295-300: `from './lifecycle-utils'` → `from './async/lifecycle-utils'`
   - Line ~285-293: `from './interval-manager'` → `from './async/interval-manager'`
   - Find event-batcher export: `from './event-batcher'` → `from './async/event-batcher'`

6. Update `internal/index.ts`:
   - Line ~72: `from '../event-batcher'` → `from '../async/event-batcher'`

7. **Update runtime worker path** in `async/worker-pool.ts`:
   - Find the line that constructs the Worker with a path to `event-processor-worker.js`
   - The path likely uses `path.resolve(__dirname, '../event-processor-worker.js')` or similar
   - Change to `path.resolve(__dirname, './event-processor-worker.js')` (now a sibling)
   - **CRITICAL**: This is a runtime path, not an import. Test thoroughly.

8. **Verify:**
   ```bash
   npm run typecheck
   npm test -- --testPathPattern="lifecycle-utils|interval-manager|event-batcher|worker-pool"
   ```

9. **Commit:** `refactor(core): batch-2.4 expand async/ with lifecycle, interval, event-batcher`

---

### Batch 2.5: Create `redis/` (HIGHEST RISK — MOST IMPORTERS)

**Move 3 Redis infrastructure files into new `shared/core/src/redis/` directory**

| File | Lines | Direct Importers (excl. barrel/internal) | Shim Needed? |
|------|-------|----------------------------------------|-------------|
| `redis.ts` | 1,432 | **18 within shared/core/src** | **YES** |
| `redis-streams.ts` | 1,562 | **14 within shared/core/src** | **YES** |
| `distributed-lock.ts` | 792 | 1 (`monitoring/cross-region-health.ts`) | No (shim covers) |

**Steps:**

1. Create `shared/core/src/redis/` directory.

2. Move and rename files:
   ```
   redis.ts            → redis/client.ts
   redis-streams.ts    → redis/streams.ts
   distributed-lock.ts → redis/distributed-lock.ts
   ```

3. **Extract `resolveRedisPassword()`**: Currently duplicated byte-for-byte in both files (redis.ts:1317, redis-streams.ts:1467). Create:
   ```
   redis/utils.ts  — contains resolveRedisPassword() and any other shared Redis helpers
   ```
   Update `redis/client.ts` and `redis/streams.ts` to import from `./utils`.

4. Create `redis/index.ts` barrel:
   ```typescript
   export * from './client';
   export * from './streams';
   export * from './distributed-lock';
   export * from './utils';
   ```

5. Update internal imports within moved files:
   - `redis/client.ts` (was `redis.ts`): change `from './logger'` → `from '../logger'`, etc.
   - `redis/streams.ts` (was `redis-streams.ts`): similar relative path adjustments.
   - `redis/streams.ts` imports from `redis.ts` for RedisClient type — change to `from './client'`.
   - `redis/distributed-lock.ts` imports from `redis.ts` — change to `from './client'`.

6. **Create shims** at old paths:
   ```typescript
   // shared/core/src/redis.ts (shim)
   /** @deprecated Import from './redis/client' instead. Shim for 18 internal importers. */
   export * from './redis/client';
   ```
   ```typescript
   // shared/core/src/redis-streams.ts (shim)
   /** @deprecated Import from './redis/streams' instead. Shim for 14 internal importers. */
   export * from './redis/streams';
   ```
   ```typescript
   // shared/core/src/distributed-lock.ts (shim)
   /** @deprecated Import from './redis/distributed-lock' instead. */
   export * from './redis/distributed-lock';
   ```

7. Update `shared/core/src/index.ts` — Section 1.1 (Redis Core):
   - Line ~71-77: `from './redis'` → `from './redis/client'`
   - Line ~80-109: `from './redis-streams'` → `from './redis/streams'`
   - Line ~271-283: `from './distributed-lock'` → `from './redis/distributed-lock'`

8. Update `internal/index.ts`:
   - Line ~37: `from '../redis'` → `from '../redis/client'`
   - Line ~38: `from '../redis-streams'` → `from '../redis/streams'`
   - Line ~40: `from '../distributed-lock'` → `from '../redis/distributed-lock'`

9. **Do NOT update the 32 internal importers yet** — the shims handle them. These get updated in Phase 4.

10. **Verify:**
    ```bash
    npm run typecheck
    npm test -- --testPathPattern="redis"
    npm test  # Full suite to catch any missed imports
    ```

11. **Commit:** `refactor(core): batch-2.5 create redis/ directory with shims`

---

### Phase 2 Checkpoint

After all 5 batches:
```bash
npm run build
npm test
```

**Expected state:**
- 4 new subdirectories created: `path-finding/`, `partition/`, `service-lifecycle/`, `redis/`
- 1 existing directory expanded: `async/`
- Root-level file count: 22 → 8 (5 permanent + 3 shims)
- 3 re-export shims in place: `redis.ts`, `redis-streams.ts`, `lifecycle-utils.ts`
  (plus `distributed-lock.ts`, `partition-service-utils.ts`, `partition-router.ts`)
- `partition-service-utils.ts` split from 1,494 lines into 4 focused modules
- `resolveRedisPassword()` duplication eliminated
- All tests passing

---

## Phase 3: Cross-Cutting Consolidation

**Target**: Consolidate duplicated logic across packages.

---

### Batch 3.1: HTTP/2 Session Pool Consolidation

**Consolidate inline HTTP/2 implementation in execution-engine with shared `Http2SessionPool`**

| File | Role | Action |
|------|------|--------|
| `shared/core/src/rpc/http2-session-pool.ts` | Shared, full-featured | Add ethers.js `FetchGetUrlFunc` factory method |
| `services/execution-engine/src/services/provider.service.ts` | Inline, minimal | Replace inline HTTP/2 code (~127 lines) with import from `@arbitrage/core/rpc` |

**Steps:**

1. Read `services/execution-engine/src/services/provider.service.ts` lines 33-169 (HTTP/2 code).
2. Read `shared/core/src/rpc/http2-session-pool.ts` to understand the existing API.
3. Add to `Http2SessionPool`:
   ```typescript
   /**
    * Creates an ethers.js-compatible FetchGetUrlFunc that uses HTTP/2 with fallback.
    * Consolidates the inline implementation from execution-engine/provider.service.ts.
    */
   createEthersGetUrlFunc(defaultGetUrl?: FetchGetUrlFunc): FetchGetUrlFunc { ... }
   ```
4. Add `createHttp2Provider(rpcUrl)` convenience function to `rpc/` (or `http2-session-pool.ts`).
5. Update `provider.service.ts`:
   - Remove `getHttp2Session()`, `createHttp2GetUrlFunc()` inline functions (~127 lines).
   - Import from `@arbitrage/core/rpc`.
   - Update `createHttp2Provider()` calls.
6. **Verify:**
   ```bash
   npm run typecheck
   npm test -- --testPathPattern="provider.service|http2"
   ```
7. **Commit:** `refactor(core): batch-3.1 consolidate HTTP/2 session pool`

---

### Batch 3.2: Extract StreamConsumer from redis-streams

**Extract cold-path StreamConsumer class into its own file**

| File | Lines | Action |
|------|-------|--------|
| `redis/streams.ts` (was `redis-streams.ts`) | 1,562 | Extract StreamConsumer class (~236 lines) |

**Steps:**

1. Create `shared/core/src/redis/stream-consumer.ts` containing the `StreamConsumer` class and its types.
2. `StreamConsumer` depends on `RedisStreamsClient` — import from `./streams`.
3. Move related types (`StreamConsumerConfig`, `StreamConsumerStats`) to the new file.
4. Update `redis/streams.ts` — remove the StreamConsumer class, keep everything else (StreamBatcher, RedisStreamsClient, singleton, utilities).
5. Add backward-compatible re-export in `redis/streams.ts`:
   ```typescript
   export { StreamConsumer } from './stream-consumer';
   export type { StreamConsumerConfig, StreamConsumerStats } from './stream-consumer';
   ```
6. Update `redis/index.ts` to also export from `./stream-consumer`.
7. **Verify:** `npm run typecheck && npm test -- --testPathPattern="redis|stream"`
8. **Commit:** `refactor(core): batch-3.2 extract StreamConsumer from redis-streams`

---

### Batch 3.3: Validation Deduplication

**Eliminate duplicate HTTP validation middleware**

| File | Lines | Action |
|------|-------|--------|
| `shared/core/src/validation.ts` | ~200 | **DELETE** (duplicate of security package) |
| `shared/security/src/validation.ts` | ~300 | Keep (has all 11 chains) |

**Steps:**

1. Read both files to confirm the overlap and identify any unique exports in core's version.
2. Grep for all importers of core's `validation.ts`:
   ```bash
   grep -rn "from.*validation" shared/core/ services/ --include="*.ts" | grep -v "__tests__" | grep -v "dist/"
   ```
3. If any consumer imports validation from `@arbitrage/core`, redirect to `@arbitrage/security`.
4. Remove core's `validation.ts`.
5. Update `shared/core/src/index.ts` — remove validation re-exports.
6. **Verify:** `npm run typecheck && npm test`
7. **Commit:** `refactor(core): batch-3.3 remove duplicate validation middleware, use @arbitrage/security`

---

### Batch 3.4: Create `validation/` for Message Validators

**Move remaining validation file to new directory (if Batch 3.3 removed the HTTP one)**

| File | Lines | Direct Importers | Action |
|------|-------|-----------------|--------|
| `message-validators.ts` | 437 | 0 (barrel-only) | Move to `validation/` |

**Steps:**

1. Create `shared/core/src/validation/` directory.
2. Move `message-validators.ts` → `validation/message-validators.ts`.
3. Create `validation/index.ts` barrel.
4. Update `shared/core/src/index.ts`.
5. **Verify:** `npm run typecheck && npm run test:changed`
6. **Commit:** `refactor(core): batch-3.4 create validation/ directory`

---

### Phase 3 Checkpoint

```bash
npm run build
npm test
```

**Expected state:**
- HTTP/2 session pool consolidated (~127 lines removed from execution-engine)
- StreamConsumer extracted into its own file (redis/streams.ts reduced by ~236 lines)
- Validation duplication eliminated (~200 lines removed)
- Message validators in proper directory

---

## Phase 4: Barrel Export & Shim Cleanup

**Target**: Remove all re-export shims and update the 32+ internal importers to use new paths directly. Clean up barrel export.

**IMPORTANT**: This phase has the highest file-change count but is purely mechanical (find-and-replace import paths). No logic changes.

---

### Batch 4.1: Remove Redis Shims (32 importers)

**Update all 32 direct importers of `redis.ts` and `redis-streams.ts` to use new paths**

1. Find all importers:
   ```bash
   grep -rn "from '\.\./redis'" shared/core/src/ --include="*.ts" | grep -v "index.ts" | grep -v "internal/" | grep -v "__tests__"
   grep -rn "from '\.\./redis-streams'" shared/core/src/ --include="*.ts" | grep -v "index.ts" | grep -v "internal/" | grep -v "__tests__"
   ```

2. For each of the 18 `redis.ts` importers:
   - Change `from '../redis'` → `from '../redis/client'`

3. For each of the 14 `redis-streams.ts` importers:
   - Change `from '../redis-streams'` → `from '../redis/streams'`

4. For the 1 `distributed-lock.ts` importer:
   - Change `from '../distributed-lock'` → `from '../redis/distributed-lock'`

5. Update test files similarly.

6. **Delete shim files**:
   ```
   rm shared/core/src/redis.ts         (the shim, not the directory)
   rm shared/core/src/redis-streams.ts  (the shim)
   rm shared/core/src/distributed-lock.ts (the shim)
   ```

7. **Verify:**
   ```bash
   npm run typecheck
   npm test
   ```

8. **Commit:** `refactor(core): batch-4.1 remove redis shims, update 32 importers to redis/`

---

### Batch 4.2: Remove lifecycle-utils Shim (27 importers)

**Update all 27 direct importers to use `async/lifecycle-utils`**

1. Find all importers:
   ```bash
   grep -rn "from '.*lifecycle-utils'" shared/core/src/ --include="*.ts" | grep -v "index.ts" | grep -v "internal/" | grep -v "__tests__" | grep -v "async/"
   ```

2. For each importer:
   - If in a subdirectory like `analytics/`: `from '../lifecycle-utils'` → `from '../async/lifecycle-utils'`
   - If at root level (rare): `from './lifecycle-utils'` → `from './async/lifecycle-utils'`

3. Update test files similarly.

4. **Delete shim**: `rm shared/core/src/lifecycle-utils.ts`

5. **Verify:** `npm run typecheck && npm test`

6. **Commit:** `refactor(core): batch-4.2 remove lifecycle-utils shim, update 27 importers`

---

### Batch 4.3: Remove Remaining Shims

**Remove partition shims**

1. Find importers of `partition-service-utils.ts` and `partition-router.ts`:
   ```bash
   grep -rn "from '.*partition-service-utils\|from '.*partition-router'" shared/core/src/ services/ --include="*.ts" | grep -v "dist/"
   ```

2. Update each importer to use `partition/` paths.

3. **Delete shims**:
   ```
   rm shared/core/src/partition-service-utils.ts
   rm shared/core/src/partition-router.ts
   ```

4. **Verify:** `npm run typecheck && npm test`

5. **Commit:** `refactor(core): batch-4.3 remove partition shims`

---

### Batch 4.4: Barrel Export Cleanup

**Clean up `shared/core/src/index.ts`**

1. Verify all import paths point to new locations (no references to old root-level files).
2. Remove any exports marked `@deprecated Unused` that the migration agent confirmed have zero external consumers.
3. Reorganize section headers to reflect new directory structure:
   - Add `path-finding/` to Section 6 header
   - Add `partition/` to Section 12 header
   - Add `redis/` to Section 1 header
   - Add `service-lifecycle/` to Section 1.4 header
4. Update the sub-entry points documentation comment at the top of the file.
5. **Verify:** `npm run build && npm test`
6. **Commit:** `refactor(core): batch-4.4 clean up barrel export`

---

### Phase 4 Checkpoint

```bash
npm run build
npm test
```

**Expected state:**
- All shims removed
- All importers updated to new paths
- Root-level file count: **5** (`logger.ts`, `websocket-manager.ts`, `nonce-manager.ts`, `pair-discovery.ts`, `setup-tests.ts`)
- Zero backward-compat indirection remaining
- Barrel export cleaned up

---

## Phase 5: Optional Package Extraction (Long-Term)

These are independent enhancements that can be done in separate PRs:

### 5.1: Extract `@arbitrage/metrics` (14 files, zero external deps)

1. Create `shared/metrics/` package with `package.json`, `tsconfig.json`.
2. Move `shared/core/src/metrics/` contents.
3. Add `@arbitrage/metrics` to workspace.
4. Update importers to use `@arbitrage/metrics`.
5. Add to build order: types → config → **metrics** → core → ml → services.

### 5.2: Extract `@arbitrage/flash-loan-aggregation` (17 files, 1 dep)

1. Similar to 5.1. Only dependency is `logger.ts` (1 file).
2. Accept `@arbitrage/core` as peer dependency for logger.

### 5.3: Evaluate `@arbitrage/solana` (18 files, medium coupling)

1. Depends on `redis`, `logger`, `lifecycle-utils` from core.
2. Higher coupling — evaluate after Phase 4 when redis/ is stable.

### 5.4: Evaluate `@arbitrage/cache-warming` (22 files)

1. Depends on `caching/`, `metrics/` — do after 5.1.

---

## Files NOT to Touch

| File | Lines | Reason |
|------|-------|--------|
| `logger.ts` | 139 | Backward-compat facade with 81+ importers. Documented ADR-015 design. Cost of migration far exceeds benefit. |
| `websocket-manager.ts` | 1,565 | Hot-path WebSocket state machine. Cold-path already extracted (provider-health-tracker, provider-rotation-strategy). Further splitting adds indirection to <50ms path. |
| `nonce-manager.ts` | 764 | Standalone infrastructure component. No natural siblings for grouping. Execution-engine's NonceAllocationManager is a complementary higher-level wrapper, not a duplicate. |
| `pair-discovery.ts` | 845 | Standalone DEX pair discovery service with own DI. Borderline case for `detector/` but works fine at root. |
| `setup-tests.ts` | 3 | Jest config reference. Conventionally at package root. |
| `factory-subscription.ts` | 683 | Already a backward-compat re-export pattern from R10 refactoring. Works correctly. |
| `simulation-mode.ts` | 61 | Re-export shim to `simulation/`. Same pattern as `logger.ts`. |
| Circuit breakers (all 3) | — | Performance guardian: CONDITIONAL. Different API patterns serve different use cases. Keep separate. |

---

## Verification Protocol

### After Every Batch

```bash
# 1. Type check
npm run typecheck

# 2. Run affected tests
npm run test:changed

# 3. If any failures, run full suite
npm test
```

### After Every Phase

```bash
# 1. Full build (respects dependency order)
npm run build

# 2. Full test suite
npm test

# 3. Lint check
npm run lint:fix
```

### Final Verification (after Phase 4)

```bash
# 1. Clean build
npm run build:clean

# 2. Full test suite
npm test

# 3. Integration tests
npm run test:integration

# 4. Performance tests (verify no hot-path regression)
npm run test:performance

# 5. Verify no stale imports
grep -rn "from '\.\./redis'" shared/core/src/ --include="*.ts" | grep -v "__tests__" | grep -v "dist/" | grep -v "node_modules"
# Should return 0 results (all updated to redis/client or redis/streams)

grep -rn "from '\.\./lifecycle-utils'" shared/core/src/ --include="*.ts" | grep -v "__tests__" | grep -v "dist/" | grep -v "node_modules"
# Should return 0 results (all updated to async/lifecycle-utils)

# 6. Check no orphaned files
ls shared/core/src/*.ts | grep -v "index.ts\|logger.ts\|websocket-manager.ts\|nonce-manager.ts\|pair-discovery.ts\|setup-tests.ts\|factory-subscription.ts\|simulation-mode.ts"
# Should return 0 results
```

---

## Tracking Summary

| Phase | Batches | Files Moved | Files Created | Shims Created | Shims Removed |
|-------|---------|-------------|---------------|---------------|---------------|
| 1 | 4 | 8 | 1 (amm-math.ts) | 0 | 0 |
| 2 | 5 | 10 | 6 (index.ts barrels + redis/utils) | 6 | 0 |
| 3 | 4 | 0 | 1 (stream-consumer.ts) | 0 | 0 |
| 4 | 4 | 0 | 0 | 0 | 6 |
| **Total** | **17** | **18** | **8** | **6** | **6** |

**Net result after all phases:**
- Root-level loose files: **30 → 7** (5 permanent keepers + 2 intentional shims)
- New subdirectories: **5** (redis, path-finding, partition, service-lifecycle, validation)
- Code duplication removed: **~350 lines** (AMM math, resolveRedisPassword, HTTP/2, validation)
- Lines reorganized: **~16,500** (from root into proper modules)
- Hot-path latency impact: **+0ms**

---

## Appendix: Full Import Graph (Root-Level Files)

**Key for "Direct Importers" column**: Count of files within `shared/core/src/` that import via relative path (excluding `index.ts`, `internal/index.ts`, and test files).

| File | Lines | Direct Importers | Barrel | Internal Barrel | Phase | Batch |
|------|-------|-----------------|--------|----------------|-------|-------|
| `disconnect-utils.ts` | 55 | 0 | Yes | No | 1 | 1.1 |
| `env-utils.ts` | 183 | 0 | Yes | No | 1 | 1.1 |
| `hmac-utils.ts` | 108 | 1 | Yes | No | 1 | 1.1 |
| `performance-monitor.ts` | ~150 | 0 | Yes | Yes | 1 | 1.2 |
| `provider-health-tracker.ts` | 329 | 1 | Yes | No | 1 | 1.2 |
| `v8-profiler.ts` | ~80 | 0 | Yes | No | 1 | 1.2 |
| `provider-rotation-strategy.ts` | 467 | 1 | Yes | No | 1 | 1.3 |
| `cross-dex-triangular-arbitrage.ts` | 1,056 | 1 | Yes | No | 2 | 2.1 |
| `multi-leg-path-finder.ts` | 1,034 | 0 | Yes | Yes | 2 | 2.1 |
| `cross-chain-price-tracker.ts` | 386 | 0 | Yes | No | 2 | 2.1 |
| `partition-service-utils.ts` | 1,494 | 1 | Yes | No | 2 | 2.2 |
| `partition-router.ts` | 355 | 1 | Yes | Yes | 2 | 2.2 |
| `service-bootstrap.ts` | 389 | 0 | Yes | No | 2 | 2.3 |
| `service-state.ts` | 591 | 0 | Yes | No | 2 | 2.3 |
| `lifecycle-utils.ts` | ~80 | **27** | Yes | No | 2 | 2.4 |
| `interval-manager.ts` | ~60 | 0 | Yes | No | 2 | 2.4 |
| `event-batcher.ts` | 476 | 0 | Yes | Yes | 2 | 2.4 |
| `event-processor-worker.ts` | 429 | 0 (runtime) | No | No | 2 | 2.4 |
| `redis.ts` | 1,432 | **18** | Yes | Yes | 2 | 2.5 |
| `redis-streams.ts` | 1,562 | **14** | Yes | Yes | 2 | 2.5 |
| `distributed-lock.ts` | 792 | 1 | Yes | Yes | 2 | 2.5 |
| `message-validators.ts` | 437 | 0 | Yes | No | 3 | 3.4 |
| `validation.ts` | ~200 | 0 | Yes | No | 3 | 3.3 |
| **KEEP: `logger.ts`** | 139 | 19+ | Yes | No | — | — |
| **KEEP: `websocket-manager.ts`** | 1,565 | 1 | Yes | No | — | — |
| **KEEP: `nonce-manager.ts`** | 764 | 0 | Yes | Yes | — | — |
| **KEEP: `pair-discovery.ts`** | 845 | 2 | Yes | Yes | — | — |
| **KEEP: `setup-tests.ts`** | 3 | 0 | No | No | — | — |
| **KEEP: `factory-subscription.ts`** | 683 | 1 | Yes | No | — | — |
| **KEEP: `simulation-mode.ts`** | 61 | 0 | Yes | Yes | — | — |
