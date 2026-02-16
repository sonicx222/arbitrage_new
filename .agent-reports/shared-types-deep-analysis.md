# Deep Analysis Report: `shared/types`

**Date**: 2026-02-16
**Analyzed by**: 6 parallel specialized agents + team lead synthesis
**Agents**: architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer

---

## Executive Summary

- **Total findings**: 19 (0 Critical, 5 High, 9 Medium, 5 Low)
- **Top 3 highest-impact issues**:
  1. Zero test coverage for the foundation types package (17+ utility functions, 4 error classes, all untested)
  2. `ValidationError` name collision between class and interface, both re-exported from same barrel
  3. Event type constants (`RedisStreams`, `EventTypes`, `PubSubChannels`) are dead code - zero consumers across 23+ files using string literals instead
- **Overall health grade**: **B-** (well-structured types with good JSDoc, but no tests, a confirmed logic bug, dead code, and incomplete deprecation migration)
- **Agent agreement map**: Architecture + Bug Hunter agreed on ValidationError collision; Bug Hunter + Security agreed on normalizeChainId weakness; Test Quality + Mock Fidelity agreed on zero test coverage impact; Performance + Architecture agreed on array allocation waste

---

## Critical Findings (P0 - Security/Correctness/Financial Impact)

_None._ This is a types/interfaces package with limited runtime code. No direct financial risk from types alone.

---

## High Findings (P1 - Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Coverage Gap | shared/types/ (entire package) | **Zero test files exist.** No tests for `parseGasEstimate()`, `normalizeChainId()`, `isCanonicalChainId()`, `createEvent()`, `isEventType()`, `createErrorResult/Success/Skipped()`, `formatExecutionError()`, `extractErrorCode()`, `ArbitrageError`, `NetworkError`, `ValidationError` class, `TimeoutError`. Glob for `*.test.ts`, `*.spec.ts`, `__tests__/` all return empty. | test-quality, mock-fidelity, bug-hunter | HIGH (100%) | Create `shared/types/__tests__/` with unit tests for all 17+ exported functions and 4 error classes. Priority: `parseGasEstimate`, `normalizeChainId`, error classes. | 4.4 |
| 2 | Bug | shared/types/src/chains.ts:118-128 | **`normalizeChainId()` case-insensitive lookup fails for camelCase aliases.** The function does `const lowerChain = chain.toLowerCase()` then `CHAIN_ALIASES[lowerChain]`. But aliases like `arbitrumSepolia`, `baseSepolia`, `zkSyncSepolia`, `zkSync` are defined in camelCase as keys. `'arbitrumsepolia'.toLowerCase()` won't match key `'arbitrumSepolia'`. The subsequent exact-case lookup (`chain in CHAIN_ALIASES`) only works if the original input preserves exact case. Input `'ARBITRUMSEPOLIA'` or `'ArbitrumSepolia'` returns as-is (wrong - should resolve to `'arbitrum-sepolia'`). | bug-hunter, security | HIGH (95%) | Either: (a) normalize all CHAIN_ALIASES keys to lowercase, or (b) add a lowercase-key lookup map at module level: `const LOWERCASE_ALIASES = Object.fromEntries(Object.entries(CHAIN_ALIASES).map(([k, v]) => [k.toLowerCase(), v]))` | 4.1 |
| 3 | Consistency | shared/types/src/index.ts:506 + shared/types/src/common.ts:45 | **`ValidationError` name collision.** `src/index.ts` exports `class ValidationError extends ArbitrageError` and `src/common.ts` exports `interface ValidationError { field, message, code }`. Both are re-exported via the barrel (`export * from './common'` in index.ts). TypeScript may resolve this depending on import order, but consumers importing `{ ValidationError }` from `@arbitrage/types` get the class (last export wins), potentially expecting the interface. The `ValidationResult<T>` interface in common.ts references `ValidationError[]` which would resolve to the class, not the interface - semantic mismatch. | architecture, bug-hunter | HIGH (95%) | Rename interface to `ValidationIssue` or `ValidationFieldError` in common.ts to avoid collision. Update `ValidationResult.errors` type accordingly. | 4.0 |
| 4 | Dead Code | shared/types/src/events.ts:12-58 | **`RedisStreams`, `PubSubChannels`, `EventTypes` constants are unused by any consumer.** Grep for `RedisStreams\.`, `PubSubChannels\.`, `EventTypes\.` across the entire codebase returns 0 consumer files (only the definition file). Meanwhile, 23+ files use hardcoded string literals like `'stream:price-updates'`, `'stream:arbitrage-opportunities'`. The `createEvent()` and `isEventType()` helpers are used by only 2-3 files in shared/core. The entire events.ts module is mostly dead infrastructure. | architecture, mock-fidelity | HIGH (100%) | Either: (a) migrate consumers to use the constants (recommended for type safety), or (b) remove the unused constants and simplify events.ts. Phase approach: start with execution-engine and coordinator which already import from @arbitrage/types. | 3.8 |
| 5 | Bug | shared/types/src/index.ts:585-601 | **`parseGasEstimate()` doesn't handle `Infinity`, `NaN`, or negative numbers.** When `value` is `Infinity`: `Math.floor(Infinity)` = `Infinity`, `BigInt(Infinity)` throws `RangeError`. When `value` is `NaN`: `Math.floor(NaN)` = `NaN`, `BigInt(NaN)` throws `RangeError`. When `value` is negative: `BigInt(Math.floor(-5))` = `-5n` which is invalid for gas. When `value` is a float string like `"1.5"`: `BigInt("1.5")` throws `SyntaxError` (caught by try-catch, returns 0n - OK). | bug-hunter | HIGH (90%) | Add guards: `if (typeof value === 'number') { if (!Number.isFinite(value) || value < 0) return 0n; return BigInt(Math.floor(value)); }` | 3.7 |

---

## Medium Findings (P2 - Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 6 | Performance | shared/types/src/chains.ts:141-163 | **`isCanonicalChainId()` creates fresh 16-element array per call, then does O(n) `includes()` scan.** Called by `normalizeChainId()` which is called by `isEVMChain()`, `isTestnet()`, `isMainnet()`, `getChainMetadata()`, `getChainName()`, `getEVMChainId()`. If any of these are used in event processing loops, this causes unnecessary allocation + linear scan. Currently `normalizeChainId` has 0 external consumers (functions using it are also not imported externally), so impact is LOW now but will grow. | performance | MEDIUM (85%) | Replace with module-level `const CANONICAL_IDS = new Set([...])` and use `CANONICAL_IDS.has(chain)`. O(1) lookup, zero per-call allocation. | 3.5 |
| 7 | Performance | shared/types/src/chains.ts:248-307 | **`getMainnetChains()`, `getTestnetChains()`, `getEVMChains()`, `getAllChains()` create new arrays per call.** `getAllChains()` additionally uses spread `[...getMainnetChains(), ...getTestnetChains()]` creating 3 arrays (2 inner + 1 combined). These are static data that never changes. | performance | HIGH (95%) | Move to module-level `const` arrays: `const MAINNET_CHAINS: readonly MainnetChainId[] = ['ethereum', ...] as const;` and have functions return these constants. | 3.4 |
| 8 | Config | shared/types/tsconfig.json:3 | **`"module": "commonjs"` contradicts ES modules convention.** CLAUDE.md and code_conventions.md specify "ES modules (import/export), not CommonJS". The tsconfig compiles to CommonJS output despite source using ES import syntax. While TypeScript handles this transparently, it means the `dist/` output uses `require()` which may cause issues if consumers expect ESM. Other shared packages should be checked for consistency. | architecture | MEDIUM (80%) | Verify if other shared packages also use `"module": "commonjs"`. If the monorepo intentionally uses CJS for Node.js compat (since no `"type": "module"` in package.json), document this deviation. Otherwise, align to ESM. | 3.2 |
| 9 | Type Safety | shared/types/src/index.ts:315 | **`MessageEvent.data: any` violates code conventions.** The `any` type bypasses all type checking. Code conventions explicitly say "Use proper nullable types instead of `as any` casts". This interface is used by the event system. | architecture, security | MEDIUM (95%) | Change to `data: Record<string, unknown>` or create a generic `MessageEvent<T = Record<string, unknown>>`. | 3.1 |
| 10 | Migration | shared/types/src/index.ts:63-66,93-96,129-130 | **Deprecated `.fee` field still heavily used across codebase.** The deprecated `Dex.fee`, `Pair.fee`, `PriceUpdate.fee` fields have 30+ active references in shared/core (cross-dex-triangular-arbitrage.ts, multi-leg-path-finder.ts, pair-repository.ts, arbitrage-detector.ts, event-processor.ts, factory-integration.ts). Migration to `feeBps`/`feeDecimal` is incomplete. | mock-fidelity, architecture | HIGH (100%) | Track and execute migration: (1) Update consumers to use `feeBps`/`feeDecimal`, (2) Add runtime deprecation warnings, (3) Remove deprecated fields after migration. | 3.0 |
| 11 | Overlap | shared/types/src/index.ts:370-378 + shared/types/src/common.ts:22-29 | **`PerformanceMetrics` overlaps with `PerformanceSnapshot`.** Both have `eventLatency`, `detectionLatency`, `timestamp`. `PerformanceMetrics` adds `cacheHitRate`, `opportunitiesDetected`, etc. `PerformanceSnapshot` adds `executionLatency`, `throughput`, `errorRate`. Neither extends the other. Consumers must choose which to use, risking inconsistency. | architecture, performance | MEDIUM (90%) | Either: (a) Make `PerformanceSnapshot` extend a shared base, or (b) Consolidate into one interface with optional fields, or (c) Rename to clarify different use cases (e.g., `DetectionMetrics` vs `MonitoringSnapshot`). | 2.8 |
| 12 | Overlap | shared/types/src/index.ts:325-337 + shared/types/src/common.ts:64-71 | **`ServiceHealth` overlaps with `BaseHealth`.** `ServiceHealth` has `name`, `status`, `uptime`, `memoryUsage`, etc. `BaseHealth` has `healthy` (boolean), `lastCheck`, `lastError`. They represent different health granularities but neither references the other. | architecture | MEDIUM (85%) | Make `ServiceHealth` extend `BaseHealth`, or remove `BaseHealth` if unused. | 2.7 |
| 13 | Security | shared/types/src/events.ts:217-225 | **`createEvent()` spread operator can override core fields.** `{type, timestamp, source, correlationId, ...data} as T` - if `data` contains `type` or `timestamp` keys, the spread comes AFTER the explicit fields... wait, actually the spread is AFTER, so `data` fields would override `type` and `timestamp`. This could allow event type spoofing. | security, bug-hunter | MEDIUM (80%) | Reorder: `{...data, type, timestamp, source, correlationId} as T` to ensure core fields cannot be overridden by data spread. | 2.9 |
| 14 | Consistency | shared/types/src/index.ts:170,193 + shared/types/src/execution.ts:17 | **Inconsistent gas/amount types.** `ArbitrageOpportunity.gasEstimate` is `string` (BigInt-compatible), but `ExecutionResult.gasUsed` is `number`. `ArbitrageOpportunity.amountIn` is `string` but `ArbitrageOpportunity.amount` is `number`. This forces consumers to handle mixed types for the same semantic concept. | bug-hunter | MEDIUM (95%) | Standardize: gas values should all be `string` (BigInt-compatible) or all `bigint`. Amount values should consistently use `string` for wei-denominated values. | 2.6 |

---

## Low Findings (P3 - Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 15 | Structure | shared/types/src/index.ts (entire file) | **God file: 614 lines with 15+ different concerns.** Fee types, chain types, pair types, opportunity types, event types, error classes, config types, bridge types, utility functions all in one file. | performance | HIGH (95%) | Split into: `fee-types.ts`, `market-data.ts` (Pair, Token, Dex), `opportunity.ts`, `service.ts` (lifecycle, health, config), `errors.ts`, `pending.ts`, `bridge.ts`. Keep index.ts as barrel re-export. | 2.4 |
| 16 | Type Safety | shared/types/src/index.ts:150-198 | **`ArbitrageOpportunity` has excessive optionality.** Of ~30 fields, only `id`, `confidence`, `timestamp` are required. An object `{id: "x", confidence: 1, timestamp: 0}` is a valid `ArbitrageOpportunity`. This provides no structural guarantees for downstream consumers. | security, architecture | LOW (75%) | Consider discriminated union variants: `SimpleArbitrageOpportunity`, `TriangularArbitrageOpportunity`, `CrossChainArbitrageOpportunity` each with appropriate required fields. Or use `Pick<>` + `Required<>` for different contexts. | 2.2 |
| 17 | Maintenance | shared/types/src/chains.ts:27-52 + :141-161 | **ChainId type and `isCanonicalChainId()` canonical list are duplicated.** The type literal union and the runtime array must be kept in sync manually. Adding a new chain requires updating both. | architecture | HIGH (95%) | Derive the type from the array: `const CANONICAL_IDS = ['ethereum', 'polygon', ...] as const; export type ChainId = typeof CANONICAL_IDS[number];` | 2.1 |
| 18 | Type Safety | shared/types/src/index.ts:6-8 | **Branded types (`FeeBasisPoints`, `FeeDecimal`) are compile-time only.** No runtime validation. A service can pass `-500 as FeeBasisPoints` and it compiles. Zero imports of these branded types found outside shared/types and shared/core fee-utils. | security, mock-fidelity | LOW (90%) | Add runtime constructor functions: `export function toBps(n: number): FeeBasisPoints { if (n < 0 || n > 10000) throw ...; return n as FeeBasisPoints; }` | 1.9 |
| 19 | Robustness | shared/types/src/chains.ts:112-132 | **`normalizeChainId()` returns unrecognized input as ChainId.** Empty string, random strings, even injection attempts pass through as "valid" ChainId values. While the JSDoc documents this behavior ("@throws Never throws"), it means type safety is lost for unknown inputs. | security | LOW (70%) | Add overload: `normalizeChainId(chain: string): ChainId | null` for strict mode, or add a separate `validateChainId()` that throws. | 1.8 |

---

## Test Coverage Matrix

| Source File | Function/Method | Happy Path | Error Path | Edge Cases | Notes |
|-------------|-----------------|------------|------------|------------|-------|
| src/index.ts | `parseGasEstimate()` | NO | NO | NO | No tests exist |
| src/index.ts | `ArbitrageError` | NO | NO | NO | instanceof, prototype chain untested |
| src/index.ts | `NetworkError` | NO | NO | NO | retryable=true default untested |
| src/index.ts | `ValidationError` (class) | NO | NO | NO | field property untested |
| src/index.ts | `TimeoutError` | NO | NO | NO | message format untested |
| src/chains.ts | `normalizeChainId()` | NO | NO | NO | Case sensitivity bug untested |
| src/chains.ts | `isCanonicalChainId()` | NO | NO | NO | - |
| src/chains.ts | `isEVMChain()` | NO | NO | NO | - |
| src/chains.ts | `isTestnet()` | NO | NO | NO | - |
| src/chains.ts | `isMainnet()` | NO | NO | NO | - |
| src/chains.ts | `getMainnetChains()` | NO | NO | NO | - |
| src/chains.ts | `getTestnetChains()` | NO | NO | NO | - |
| src/chains.ts | `getEVMChains()` | NO | NO | NO | - |
| src/chains.ts | `getAllChains()` | NO | NO | NO | - |
| src/chains.ts | `getChainMetadata()` | NO | NO | NO | - |
| src/chains.ts | `getChainName()` | NO | NO | NO | - |
| src/chains.ts | `getEVMChainId()` | NO | NO | NO | - |
| src/events.ts | `createEvent()` | NO | NO | NO | Spread override bug untested |
| src/events.ts | `isEventType()` | NO | NO | NO | - |
| src/execution.ts | `createErrorResult()` | NO | NO | NO | Used by 19 files - high impact |
| src/execution.ts | `createSuccessResult()` | NO | NO | NO | Used by 19 files |
| src/execution.ts | `createSkippedResult()` | NO | NO | NO | - |
| src/execution.ts | `formatExecutionError()` | NO | NO | NO | - |
| src/execution.ts | `extractErrorCode()` | NO | NO | NO | Regex untested |

**Total: 0/24 functions have tests. 0% coverage.**

---

## Mock Fidelity Matrix

| Mock/Consumer | Type Used | Faithful | Issues |
|---------------|-----------|----------|--------|
| shared/core event-processor | Pair.fee (deprecated) | Partial | Uses deprecated `.fee` field, not `.feeDecimal` |
| shared/core arbitrage-detector | Pair.fee (deprecated) | Partial | Same deprecated field |
| shared/core factory-integration | Dex.fee fallback | Degraded | `dexConfig?.feeBps ?? dexConfig?.fee ?? 30` - fallback chain mixes branded/unbranded |
| execution-engine strategies | ExecutionErrorCode | Good | Proper enum usage across 8 files |
| execution-engine factories | createErrorResult/Success | Good | Factory functions used consistently across 19 files |
| All stream consumers | String literals | Poor | 23+ files use hardcoded `'stream:price-updates'` instead of `RedisStreams.PRICE_UPDATES` |
| shared/core publishing | String literals | Poor | Same string literal anti-pattern |
| coordinator | String literals | Poor | Same |

---

## Cross-Agent Insights

1. **Finding #2 (normalizeChainId bug) + Finding #1 (zero tests)**: The case-insensitive lookup bug would be caught immediately by basic unit tests. The complete absence of tests explains why this logic error persists.

2. **Finding #3 (ValidationError collision) + Finding #10 (deprecated fee migration)**: Both demonstrate incomplete migration patterns. The types package added new definitions (class, branded types) but hasn't cleaned up the old ones, creating ambiguity.

3. **Finding #4 (dead event constants) + Finding #10 (deprecated fee)**: A pattern of creating "correct" infrastructure that isn't adopted. The event type registry and fee branded types represent intended improvements that the codebase hasn't migrated to.

4. **Finding #13 (createEvent spread) + Finding #9 (MessageEvent.data: any)**: Both represent type safety holes in the event system. Events can have their core fields overridden via spread, and message events carry untyped payloads. Combined, these weaken the event system's reliability guarantees.

5. **Finding #6 (array allocation) + Finding #17 (type/array duplication)**: The `isCanonicalChainId` function both duplicates the ChainId type definition AND allocates a new array per call. Fixing #17 (deriving type from array) automatically fixes #6 (use the const array as the lookup source).

---

## Recommended Action Plan

### Phase 1: Immediate (P1 - Fix before further development)

- [ ] **Fix #1**: Create `shared/types/__tests__/` test suite covering all 24 exported functions/classes. Priority: `parseGasEstimate`, `normalizeChainId`, error classes, `createEvent`, `extractErrorCode`.
- [ ] **Fix #2**: Fix `normalizeChainId()` case-insensitive lookup by normalizing CHAIN_ALIASES keys to lowercase at module level.
- [ ] **Fix #3**: Rename `ValidationError` interface in common.ts to `ValidationFieldError` to resolve name collision.
- [ ] **Fix #5**: Add `Infinity`/`NaN`/negative guards to `parseGasEstimate()`.

### Phase 2: Next Sprint (P2 - Reliability & consistency)

- [ ] **Fix #4**: Migrate at least execution-engine and coordinator to use `RedisStreams`/`EventTypes` constants instead of string literals. Track remaining migrations as tech debt.
- [ ] **Fix #6 + #7 + #17**: Refactor chain utilities to use module-level const Set/arrays derived from a single source of truth.
- [ ] **Fix #9**: Change `MessageEvent.data: any` to `data: Record<string, unknown>`.
- [ ] **Fix #10**: Create migration plan for deprecated `.fee` fields -> `feeBps`/`feeDecimal`.
- [ ] **Fix #13**: Reorder `createEvent()` spread to prevent field override.
- [ ] **Fix #14**: Standardize gas/amount types across interfaces.

### Phase 3: Backlog (P3 - Refactoring & improvement)

- [ ] **Fix #8**: Resolve tsconfig `"module": "commonjs"` vs ESM convention.
- [ ] **Fix #11 + #12**: Consolidate overlapping `PerformanceMetrics`/`PerformanceSnapshot` and `ServiceHealth`/`BaseHealth`.
- [ ] **Fix #15**: Split `src/index.ts` god file into domain-specific modules.
- [ ] **Fix #16**: Consider discriminated unions for `ArbitrageOpportunity` variants.
- [ ] **Fix #18**: Add runtime branded type constructors for `FeeBasisPoints`/`FeeDecimal`.
- [ ] **Fix #19**: Add strict `validateChainId()` that throws for unknown chains.
