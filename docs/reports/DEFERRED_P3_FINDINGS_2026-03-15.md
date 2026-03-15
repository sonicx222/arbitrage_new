# Deferred P3 Findings — 2026-03-15

Triaged from Detection deep analysis (`DEEP_ANALYSIS_DETECTION_2026-03-15.md`) and Execution Engine deep analysis (`DEEP_ANALYSIS_EXECUTION_ENGINE_2026-03-15.md`). Items here were intentionally skipped — they are style, refactoring, negligible perf, feature-gated, or already tracked elsewhere.

## Dropped After Investigation

| ID | Title | File | Reason |
|----|-------|------|--------|
| EE-P3-3 | Off-by-one in `perChainSkips >= queueSize` | `execution-pipeline.ts` | `initialQueueSize` snapshot broke 39/48 tests. Current behavior is correct: `enqueue()` grows queue, and existing check exits when all remaining items are at-capacity chains. |

## Deferred — Style / Naming / Comments

| ID | Title | File | Notes |
|----|-------|------|-------|
| DET-P3-1 | Inconsistent naming (`chainId` vs `chain`) | unified-detector various | Cosmetic only; pervasive across codebase |
| DET-P3-2 | `pipelineTimestamps` could use a class | chain-instance.ts | Style preference; current plain object works |
| DET-P3-3 | Magic numbers in simulation | chain.simulator.ts | `0.03`, `250000000` etc. — readable in context |
| DET-P3-4 | `getBaseTokenPrice` duplicated across modules | chain.simulator.ts, simulation-mode.ts | Low risk; both have `// keep in sync` comments |
| DET-P3-6 | `handleSyncEvent` return type inconsistency | chain-instance.ts | Returns `void` or implicit — no callers check return |
| DET-P3-8 | Unused `WhaleAlert` import in some files | various | Linter would catch; no runtime impact |
| DET-P3-9 | JSDoc `@see` references to deleted files | various | Documentation-only |
| DET-P3-11 | `updateIntervalMs` default not documented | chain.simulator.ts | Internal simulation config |
| DET-P3-12 | `isStopping` flag could be enum state machine | chain.simulator.ts | Works correctly as boolean pair |
| DET-P3-13 | Test helper `createMockChainInstance` too permissive | test files | Test-only; doesn't affect correctness |
| DET-P3-14 | Inconsistent error logging format | various | `error.message` vs `getErrorMessage()` — cosmetic |
| DET-P3-15 | Missing `readonly` on some class fields | various | TypeScript style; no runtime impact |
| DET-P3-16 | `clearIntervalSafe` return type annotation | core/async | Returns `null`, type is correct |
| DET-P3-17 | Simulation volatility param not validated | chain.simulator.ts | Internal dev-only config |
| DET-P3-18 | Cross-chain detector test coverage for edge cases | detector.test.ts | Already has 1390 passing tests |
| EE-P3-2 | `ExecutionPipeline` constructor param count | execution-pipeline.ts | Uses deps object pattern — clean |
| EE-P3-4 | `flashLoanFeeCalculator` naming inconsistency | flash-loan.strategy.ts | Internal naming; no API impact |
| EE-P3-5 | `simulationService` nullable handling | intra-chain.strategy.ts | Guarded by feature flag check |
| EE-P3-6 | `getOptimalGasPrice` return type widening | base.strategy.ts | Returns bigint consistently |
| EE-P3-7 | Missing JSDoc on `prepareFlashLoanParams` | flash-loan.strategy.ts | Implementation is clear |
| EE-P3-8 | `retryWithBackoff` generic error handling | retry-utils.ts | Catches and re-throws — correct |
| EE-P3-9 | `TradeLogger` file handle leak on error | trade-logger.ts | Has finally block; LogFileManager handles lifecycle |
| EE-P3-10 | `BridgeRecoveryManager` log level inconsistency | bridge-recovery-service.ts | Some debug, some info — intentional |
| EE-P3-11 | `HealthMonitoringManager` metric names | health-monitoring-manager.ts | Prometheus naming convention followed |
| EE-P3-12 | `CircuitBreakerManager` persistence format | circuit-breaker-manager.ts | Redis JSON — works correctly |
| EE-P3-13 | `CommitRevealService` timeout hardcoded | commit-reveal.service.ts | Feature-gated OFF; fix when enabling |
| EE-P3-14 | `MevRiskAnalyzer` threshold magic numbers | mev-risk-analyzer.ts | Documented in comments |
| EE-P3-15 | `NonceManager` concurrent access pattern | nonce-manager.ts | Uses mutex — correct |
| EE-P3-16 | Test mock factories could share more | test helpers | Refactoring-only; tests pass |
| EE-P3-17 | `engine.ts` file length (~800 lines) | engine.ts | Already tracked in P1-1/P1-8 as mega-file split |
| EE-P3-18 | `StrategyContext` type could be narrower | types.ts | Would require broad refactoring |

## Already Tracked Elsewhere

| ID | Title | Tracked In |
|----|-------|-----------|
| EE-P3-17 | engine.ts mega-file split | DEEP_ANALYSIS_EXECUTION_ENGINE P1-1/P1-8 |
| DET-P3-10 | `.env.example` missing vars | Already documented (verified present at lines 26-29) — false positive |
