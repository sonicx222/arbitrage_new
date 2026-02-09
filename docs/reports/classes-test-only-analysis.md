# Deep Dive: Classes Only Used in Tests (Not Wired in Production)

**Date:** 2026-02-08  
**Scope:** Arbitrage system production runtime vs test-only usage.

## Production runtime (what actually runs)

Default production startup (`npm run dev:start` → `scripts/start-local.js` → `getStartupServices()`) runs **6 core services** only:

| Service | Entry | Detector/engine used |
|--------|--------|----------------------|
| Coordinator | `services/coordinator/src/index.ts` | N/A (orchestrator) |
| P1 Asia-Fast | `services/partition-asia-fast/src/index.ts` | `UnifiedChainDetector` via `runPartitionService` |
| P2 L2-Turbo | `services/partition-l2-turbo/src/index.ts` | `UnifiedChainDetector` via `runPartitionService` |
| P3 High-Value | `services/partition-high-value/src/index.ts` | `UnifiedChainDetector` via `runPartitionService` |
| Cross-Chain Detector | `services/cross-chain-detector/src/index.ts` | `CrossChainDetectorService` |
| Execution Engine | `services/execution-engine/src/index.ts` | `ExecutionEngineService` |

**Optional (not started by default):** Unified Detector (standalone), P4 Partition-Solana, Mempool Detector.

---

## 1. Classes only instantiated in tests (not in production)

### 1.1 `PartitionedDetector` (shared/core)

- **Location:** `shared/core/src/partitioned-detector.ts`
- **Production:** Partitions use `runPartitionService({ createDetector: (cfg) => new UnifiedChainDetector(cfg) })`. **No production code instantiates `PartitionedDetector`.**
- **Tests:** `partition-config.integration.test.ts`, `partitioned-detector.test.ts`, `s3.1.1-partitioned-detector.integration.test.ts` create `new PartitionedDetector(...)`.
- **Conclusion:** Base class exists and is exported, but production uses only `UnifiedChainDetector`; `PartitionedDetector` is test-only from a runtime perspective.

### 1.2 `BaseDetector` (shared/core)

- **Location:** `shared/core/src/base-detector.ts`
- **Production:** No service extends `BaseDetector`. `UnifiedChainDetector` uses `ChainDetectorInstance` (no inheritance from `BaseDetector`). `CrossChainDetectorService` explicitly does not extend it. Only the **type** `BaseDetectorConfig` is used by `UnifiedDetectorConfig`.
- **Tests:** `base-detector.test.ts` uses `class TestDetector extends BaseDetector` and instantiates it.
- **Conclusion:** The **class** `BaseDetector` is only ever extended and instantiated in tests.

### 1.3 `V8Profiler` (shared/core)

- **Location:** `shared/core/src/v8-profiler.ts`
- **Production:** No service or shared production code imports or uses `V8Profiler` or `getGlobalProfiler()`.
- **Tests:** `services/unified-detector/__tests__/performance/hotpath-profiling.performance.test.ts` uses it.
- **Conclusion:** Profiling utility is test/performance-test only.

### 1.4 `ProfessionalQualityMonitor` (shared/core)

- **Location:** `shared/core/src/analytics/professional-quality-monitor.ts`
- **Production:** No coordinator, detector, or execution-engine code uses `ProfessionalQualityMonitor` or `getProfessionalQualityMonitor()`.
- **Tests:** `professional-quality.test.ts`, `professional-quality-monitor.test.ts`, `professional-quality.performance.test.ts`.
- **Conclusion:** Exported but never wired in production; test-only.

### 1.5 `PriceMomentumTracker` / `getPriceMomentumTracker` (shared/core)

- **Production:** Cross-chain detector explicitly removed usage (comment: "DEAD-CODE-REMOVED: PriceMomentumTracker, MomentumSignal - never used in detection"). No other service calls `getPriceMomentumTracker()`.
- **Tests:** `tier2-optimizations.test.ts` and analytics tests.
- **Conclusion:** Exported, never used in production runtime.

### 1.6 `LiquidityDepthAnalyzer` / `getLiquidityDepthAnalyzer` (shared/core)

- **Production:** No service (coordinator, partitions, cross-chain, execution) imports or calls `getLiquidityDepthAnalyzer()`.
- **Tests:** `tier3-advanced.test.ts` and analytics tests.
- **Conclusion:** Exported, never used in production runtime.

---

## 2. Orphan / unexported classes (dead code in repo)

These classes still have source files and are not exported from `@arbitrage/core` (index comments say "REMOVED"). They are not wired anywhere in production.

| Class / module | File | Note |
|----------------|------|------|
| `PredictiveCacheWarmer` | `shared/core/src/predictive-warmer.ts` | Still has `getPredictiveCacheWarmer()`; not in core index exports. |
| `AdvancedStatisticalArbitrage` | `shared/core/src/advanced-statistical-arbitrage.ts` | Not exported from core. |
| `ABTestingFramework` (shared) | `shared/core/src/ab-testing.ts` | Not exported from core. Execution engine uses its **own** `services/execution-engine/src/ab-testing/framework.ts` (different class). |

---

## 3. Services not in default production startup

These are real production services but are **not** started by `dev:start` (not in `CORE_SERVICES` / `LOCAL_DEV_SERVICES`):

| Service | In scripts? | Wired? |
|---------|-------------|--------|
| **Mempool Detector** | Not in `services-config.js`; no `dev:mempool` script | `MempoolDetectorService`, `BloXrouteFeed` only run if this service is started manually. |
| **Unified Detector** (standalone) | Optional; `enabled: false` | Used when run explicitly or via optional config. |
| **Partition-Solana (P4)** | Optional; `enabled: false` | `SolanaArbitrageDetector`, `VersionedPoolStore`, `OpportunityFactory` only run when P4 is started. |

So: **MempoolDetectorService**, **BloXrouteFeed**, and the **partition-solana** stack are not part of the default “production” path started by `dev:start`.

---

## 4. Shared test-utils (intentionally test-only)

Everything under `shared/test-utils/` is for tests only (mocks, harnesses, builders). No production entry point or service imports from `@arbitrage/test-utils`. This is by design.

Examples: `RedisMock`, `BlockchainMock`, `WebSocketMock`, `TestEnvironment`, `WorkerTestHarness`, `LoadTestHarness`, `CacheTestHarness`, `StreamCollector`, `IntegrationTestHarness`, etc.

---

## 5. Summary table

| Class / component | Package / service | Production wired? | Only in tests / optional? |
|-------------------|-------------------|--------------------|----------------------------|
| `PartitionedDetector` | @arbitrage/core | No | Yes (tests only) |
| `BaseDetector` | @arbitrage/core | No (type-only in prod) | Yes (class only in tests) |
| `V8Profiler` | @arbitrage/core | No | Yes (perf tests) |
| `ProfessionalQualityMonitor` | @arbitrage/core | No | Yes |
| `PriceMomentumTracker` | @arbitrage/core | No | Yes |
| `LiquidityDepthAnalyzer` | @arbitrage/core | No | Yes |
| `PredictiveCacheWarmer` | shared/core (not exported) | No | Orphan / dead |
| `AdvancedStatisticalArbitrage` | shared/core (not exported) | No | Orphan / dead |
| `ABTestingFramework` | shared/core (not exported) | No | Orphan (engine has its own) |
| `MempoolDetectorService` | mempool-detector | No (service not in dev:start) | Optional service |
| `SolanaArbitrageDetector` | partition-solana | No (P4 optional) | Optional service |

---

## 6. Recommendations

1. **PartitionedDetector / BaseDetector**  
   - Either: document that they are “test/base class only” and keep for future use or refactors, or  
   - If the architecture has fully moved to `UnifiedChainDetector`, consider deprecating or moving `PartitionedDetector` to a test/legacy surface so production doesn’t pull it in.

2. **Analytics singletons (ProfessionalQualityMonitor, PriceMomentumTracker, LiquidityDepthAnalyzer)**  
   - If there is no product use: stop exporting from the main API and expose only from `@arbitrage/core/internal` or an analytics-test surface, or remove if unused.  
   - If product use is planned: add a clear wiring point (e.g. one detector or coordinator) and document it.

3. **V8Profiler**  
   - Keep as test/performance-only; do not export from main production API or document as “dev/perf only.”

4. **Orphan files (PredictiveCacheWarmer, AdvancedStatisticalArbitrage, shared/core ABTestingFramework)**  
   - Remove from the repo, or move under a dedicated “legacy” or “unused” tree and document, so the main bundle and dependency graph stay clear.

5. **Mempool Detector / Partition-Solana**  
   - Document in README or architecture that they are optional and not started by default; add `dev:mempool` (and similar) scripts if you want them to be first-class dev options.

Applying these will make “what runs in production” and “what is test-only or optional” explicit and easier to maintain.
