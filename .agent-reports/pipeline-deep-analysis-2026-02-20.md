# Deep Analysis Report: Blockchain Connection & Detection Pipeline

**Date**: 2026-02-20
**Scope**: Blockchain connection and detection pipeline (WebSocket, price feeds, detectors, coordinator, Redis Streams, caching, cross-chain, Solana)
**Agents**: 6 specialized (architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer)
**Model**: Claude Opus 4.6
**Files Analyzed**: 40+ source files, 7 ADRs, architecture docs, corresponding test suites

---

## Executive Summary

**Total findings: 38** (after deduplication across 6 agents)

| Severity | Count |
|----------|-------|
| Critical (P0) | 3 |
| High (P1) | 9 |
| Medium (P2) | 16 |
| Low (P3) | 10 |

**Top 3 highest-impact issues:**
1. **Solana swap parsers for major DEXs (Raydium CLMM, Meteora, Phoenix, Lifinity) have 46 unimplemented test stubs** -- swap detection on high-volume Solana DEXs is entirely untested
2. **`JSON.stringify()` silently serializes Map as `{}` in gossip protocol**, breaking vector clock causal ordering for cache coherency across nodes
3. **ProviderRotationStrategy and ProviderHealthTracker have ZERO test coverage** -- the logic controlling which RPC endpoint serves blockchain data is completely untested

**Overall health grade: B-**

The hot-path code (PriceMatrix, SimpleArbitrageDetector, event-processor) is well-engineered with strong performance discipline. Redis Streams implementation is solid with HMAC signing, batching, and consumer groups. Architecture has no layer violations. However, Solana testing is severely lacking (83 placeholder stubs), provider rotation/health has zero coverage, the gossip protocol has both a serialization bug AND no authentication, and documentation is stale in multiple areas.

**Agent agreement map:** Cache coherency manager flagged by 3 agents (bug-hunter, security-auditor, performance-reviewer). Solana testing gaps flagged by 3 agents (test-quality, mock-fidelity, architecture). DLQ fallback flagged by 2 agents (bug-hunter, security-auditor). WebSocket reconnection gaps flagged by 2 agents (test-quality, mock-fidelity).

---

## Critical Findings (P0 -- Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Test Coverage | `shared/core/__tests__/unit/solana/s3.3.4-solana-swap-parser.test.ts:956-1285` | **46 unimplemented test stubs** for Raydium CLMM, Meteora DLMM, Phoenix DEX, Lifinity, Jupiter aggregator. Major Solana DEX swap parsers entirely untested. | test-quality, mock-fidelity | HIGH | Implement tests with real transaction data for each parser. Priority: Raydium CLMM (highest volume). | 3.5 |
| 2 | Test Coverage | `shared/core/src/provider-rotation-strategy.ts` | **ZERO test coverage** for 15+ public methods controlling which RPC endpoint is used. Bugs here cause silent stale data or thundering herd. | test-quality, mock-fidelity | HIGH | Create unit tests for provider selection, exclusion, rate limit detection, budget-aware selection, time-based priority. | 3.7 |
| 3 | Test Coverage | `shared/core/src/provider-health-tracker.ts` | **ZERO test coverage** for 10+ public methods. `isConnectionStale()` drives provider rotation on the hot path. | test-quality, mock-fidelity | HIGH | Test staleness detection with chain-specific thresholds, data gap detection, quality metrics, proactive health checks. | 3.7 |

## High Findings (P1 -- Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 4 | Bug | `shared/core/src/caching/cache-coherency-manager.ts:413` | **Map serialization silently produces `{}`**. `JSON.stringify()` cannot serialize Map objects. Vector clock data lost on every gossip message, breaking causal ordering. | bug-hunter | HIGH | Use `Object.fromEntries()` before stringify, `new Map(Object.entries())` on deserialize. | 3.7 |
| 5 | Security | `shared/core/src/caching/cache-coherency-manager.ts:19-24` | **Gossip messages have no HMAC authentication**. Any entity with Redis Pub/Sub access can inject fake cache invalidation/update messages, poisoning prices. | security-auditor | HIGH | Apply HMAC signing from `hmac-utils.ts` to all gossip messages. | 3.4 |
| 6 | Test Coverage | `shared/core/__tests__/unit/solana/s3.3.5-solana-price-feed.test.ts:894-1018` | **37 unimplemented test stubs** for Solana price feed subscriptions, error handling, account layout parsing, reconnection. | test-quality | HIGH | Implement tests with realistic Solana account data structures. | 3.4 |
| 7 | Test Coverage | `shared/core/src/websocket-manager.ts:1115` | **`resubscribeWithValidation()` not tested**. After reconnection, subscriptions must be re-established. Silent failure means connected but receiving no events. | test-quality, mock-fidelity | HIGH | Test resubscription after disconnect, partial failure, timeout. Mock needs to simulate close/error events. | 3.1 |
| 8 | Mock Fidelity | `services/partition-solana/__tests__/helpers/test-fixtures.ts` | **Solana RPC mocking essentially absent**. No `Connection` simulation, no `getAccountInfo`, no subscription callbacks, no Solana error types. Pool data fixtures only. | mock-fidelity | HIGH | Create `createMockSolanaConnection()` factory with realistic account data and error simulation. | 3.0 |
| 9 | Test Coverage | `shared/core/src/websocket-manager.ts:1245,1401,1417` | **`detectDataGaps()`, `isConnectionStale()`, `startProactiveHealthCheck()`** all untested. Data gap detection and proactive health monitoring have no coverage. | test-quality | HIGH | Test gap detection with sequential/missing blocks, staleness thresholds, health check lifecycle. | 3.1 |
| 10 | Test Coverage | `shared/core/src/caching/price-matrix.ts:749` | **`getPriceOnly()` (fastest hot-path read) has no unit tests**. Only appears in performance benchmarks. Correctness of sequence counter handling unverified. | test-quality | HIGH | Test normal read, non-existent key, destroyed matrix, worker mode. | 3.2 |
| 11 | Test Coverage | `services/unified-detector/src/detection/simple-arbitrage-detector.ts:190,213` | **>500% profit rejection filter and dust filter untested**. These guard against unrealistic opportunities reaching execution. | test-quality | MEDIUM | Test with profit percentage > 500%, amountIn < 1000n. | 3.3 |
| 12 | Skipped Test | `shared/core/__tests__/integration/detector-lifecycle.integration.test.ts:159` | **Lock TTL extension test skipped**. Critical for distributed lock correctness. Could mask a bug. | test-quality | HIGH | Unskip and fix if failing, or document why skipped. | 3.3 |

## Medium Findings (P2 -- Maintainability/Performance/Security)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 13 | Security | `shared/core/src/redis-streams.ts:385-391,467` | HMAC signing silently disabled in non-production. `verifySignature()` returns `true` for all messages when no key. Staging with real tokens is vulnerable. | security-auditor | HIGH | Warn loudly at startup when HMAC disabled in non-test environments. | 3.2 |
| 14 | Security | `shared/core/src/redis-streams.ts` (general) | All services share same HMAC key. No per-service identity. Compromised partition can write directly to `stream:execution-requests` bypassing coordinator. | security-auditor | HIGH | Consider per-service signing keys with stream consumer verifying sender identity. | 2.8 |
| 15 | Security | `shared/core/src/websocket-manager.ts:431` | Provider URLs with API keys logged in message strings, bypassing Pino's structured field redaction. | security-auditor | MEDIUM | Use `maskUrl()` before interpolating into log messages. | 3.0 |
| 16 | Security | `services/coordinator/src/streaming/rate-limiter.ts:46-97` | Rate limiter is local-only (in-memory Map). Under multi-instance deployment, effective limit is N * maxTokens. | security-auditor | HIGH | Document as intentional given leader-only forwarding, or implement Redis-backed limiter. | 2.6 |
| 17 | Bug | `services/coordinator/src/streaming/stream-consumer-manager.ts:513-526` | Synchronous file I/O (`fs.appendFileSync`) in DLQ fallback blocks event loop. | bug-hunter, security-auditor | HIGH | Replace with `fs.promises.appendFile()`. Add max file size check (100MB). | 2.8 |
| 18 | Bug | `services/cross-chain-detector/src/stream-consumer.ts:525-537` | Race condition in `stop()` -- sets `isConsuming = false` while `poll()` may be in-flight. Currently benign but latent. | bug-hunter | MEDIUM | Add a shutdown guard or await in-flight poll before clearing state. | 2.4 |
| 19 | Bug | `shared/core/src/caching/cache-coherency-manager.ts:449-468` | Unnecessary spin-lock on synchronous `incrementVectorClock()`. Dead code that adds complexity. | bug-hunter | HIGH | Remove the lock. JS single-threaded event loop guarantees synchronous function atomicity. | 2.8 |
| 20 | Performance | `shared/core/src/event-processor-worker.ts:206` | `prices.slice().reduce()` in moving average is O(n^2). Creates N array allocations. | perf-reviewer | HIGH | Use sliding window running sum (subtract-old/add-new). | 3.6 |
| 21 | Performance | `services/unified-detector/src/detection/simple-arbitrage-detector.ts:222,241,242` | Triple `Date.now()` call per opportunity. Could use single cached value. | perf-reviewer | HIGH | Cache `const now = Date.now()` at function entry. | 3.2 |
| 22 | Performance | `services/unified-detector/src/chain-instance.ts:1138,1232,1303,1339` | 3-4 `Date.now()` calls per event in hot-path processing. At 1000 events/sec = 3000-4000 unnecessary syscalls. | perf-reviewer | HIGH | Capture once at event entry, pass through call chain. | 2.6 |
| 23 | Performance | `shared/core/src/redis-streams.ts:258` | Spread operator `[...batch, ...this.queue]` in `StreamBatcher.flush()` error path. Compounds during Redis outage. | perf-reviewer | HIGH | Use `unshift()` or deque structure for O(1) prepend. | 3.0 |
| 24 | Mock Fidelity | `shared/test-utils/src/mocks/redis.mock.ts:1049-1050` | `RedisMockState.createMockRedis()` xread/xreadgroup always return null. Asymmetry with xadd which writes to shared state. | mock-fidelity | HIGH | Make xreadgroup read from `state.streams`. | 2.8 |
| 25 | Mock Fidelity | `services/cross-chain-detector/__tests__/helpers/mock-factories.ts:157-166` | Cross-chain StreamConsumer mock lacks event emission. No `simulateMessage()` method. | mock-fidelity | HIGH | Add `simulateMessage(msg)` that triggers registered handler. | 2.6 |
| 26 | Architecture | `docs/architecture/ARCHITECTURE_V2.md:747-753` | Chain assignment algorithm in docs (block-time-based) doesn't match code (pre-computed Map lookup). Would incorrectly assign Optimism, Base, zkSync, Linea. | architecture-auditor | HIGH | Update docs to note explicit assignment in `partitions.ts`. | 3.2 |
| 27 | Architecture | `docs/architecture/ARCHITECTURE_V2.md:606-615` | Stream retention described as time-based ("1 hour", "7 days") but implemented as count-based (MAXLEN 10000). | architecture-auditor | HIGH | Change "Retention" column to "Max Messages" with actual MAXLEN values. | 2.6 |
| 28 | Architecture | `docs/architecture/adr/ADR-022-hot-path-memory-optimization.md` | References non-existent `partitioned-detector.ts` and `eventLatencies` ring buffer. CLAUDE.md also references this stale path. | architecture-auditor | HIGH | Update ADR-022 to note deprecation. Update CLAUDE.md hot-path references. | 3.0 |

## Low Findings (P3 -- Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 29 | Security | `services/cross-chain-detector/src/stream-consumer.ts:174-204` | No staleness check on cross-chain price updates. Hours-old prices pass validation. | security-auditor | HIGH | 2.4 |
| 30 | Security | `services/coordinator/src/streaming/stream-consumer-manager.ts:505-535` | DLQ local fallback files have no size limits or rotation. | security-auditor | HIGH | 2.2 |
| 31 | Security | `shared/core/src/validation.ts:88` | `validateApiKey` format-only check. Downstream comparison may not use `timingSafeEqual`. | security-auditor | MEDIUM | 1.8 |
| 32 | Bug | `shared/core/src/publishing/publishing-service.ts:418-420` | Dead code: unused `sleep()` method after R7 refactor. | bug-hunter | HIGH | 2.8 |
| 33 | Bug | `shared/core/src/websocket-manager.ts:532-538` | `connectMutex` set to null before resolving. Tight timing window for new caller. | bug-hunter | MEDIUM | 2.0 |
| 34 | Bug | `services/unified-detector/src/chain-instance.ts:411` | TokenMetadata default `{}` doesn't match expected interface shape. Uses `||` not `??`. | bug-hunter | MEDIUM | 2.4 |
| 35 | Performance | `shared/core/src/caching/price-matrix.ts:917` | `getBatch()` uses `.map()` with closure. For-loop with pre-allocated array faster. | perf-reviewer | HIGH | 2.8 |
| 36 | Performance | `shared/core/src/interval-manager.ts:98,104` | `console.error()` instead of logger. Synchronous I/O in error path. | perf-reviewer | HIGH | 2.8 |
| 37 | Architecture | `docs/architecture/ARCHITECTURE_V2.md:28,66,911` | DEX count inconsistency: "49" vs actual 54 (47 EVM + 7 Solana). Config file header also stale. | architecture-auditor | HIGH | 2.6 |
| 38 | Architecture | `docs/architecture/ARCHITECTURE_V2.md:606-615` + `shared/types/src/events.ts:12-43` | Streams table lists 8 but codebase defines 19. Missing `execution-results`, `circuit-breaker`, `pending-opportunities`. | architecture-auditor | HIGH | 2.4 |

---

## Test Coverage Matrix (Critical Paths)

| Source File | Function/Method | Happy | Error | Edge | Status |
|---|---|:---:|:---:|:---:|---|
| price-matrix.ts | setPrice/getPrice/setBatch/getBatch | ✅ | ✅ | ✅ | Well-tested |
| price-matrix.ts | getPriceOnly | ❌ | ❌ | ❌ | **No unit tests** (P1) |
| simple-arbitrage-detector.ts | calculateArbitrage | ✅ | ✅ | ✅ | Well-tested |
| simple-arbitrage-detector.ts | >500% filter, dust filter | ❌ | N/A | N/A | **Not tested** (P1) |
| event-processor.ts | decodeSyncEvent/decodeSwapEvent | ✅ | ✅ | ✅ | Well-tested |
| websocket-manager.ts | connect/disconnect | ✅ | ✅ | ✅ | Tested via chain-instance |
| websocket-manager.ts | resubscribeWithValidation | ❌ | ❌ | ❌ | **Not tested** (P1) |
| websocket-manager.ts | detectDataGaps/isConnectionStale | ❌ | ❌ | ❌ | **Not tested** (P1) |
| provider-rotation-strategy.ts | ALL 15+ methods | ❌ | ❌ | ❌ | **ZERO coverage** (P0) |
| provider-health-tracker.ts | ALL 10+ methods | ❌ | ❌ | ❌ | **ZERO coverage** (P0) |
| redis-streams.ts | xadd/xread/HMAC/StreamBatcher | ✅ | ✅ | ✅ | Comprehensive |
| coordinator.ts | start/stop/routing | ✅ | ❌ | ❌ | Partial |
| stream-consumer-manager.ts | recoverPending/orphanRecovery | ✅ | ✅ | ✅ | Good |
| partition-service-utils.ts | ALL exported | ✅ | ✅ | ✅ | Comprehensive |
| Solana swap parser | Raydium AMM, Orca | ✅ | ✅ | ✅ | OK |
| Solana swap parser | CLMM, Meteora, Phoenix, Lifinity | ❌ | ❌ | ❌ | **46 todo stubs** (P0) |
| Solana price feed | ALL | ❌ | ❌ | ❌ | **37 todo stubs** (P1) |

## Mock Fidelity Matrix

| Mock | Real Service | Fidelity | Error Sim | Overall |
|---|---|:---:|:---:|:---:|
| Redis Streams (jest.fn DI) | RedisStreamsClient | High | Yes | **A-** |
| PriceMatrix (real impl in tests) | PriceMatrix | Real | N/A | **A** |
| Coordinator Redis mock | StreamsClient | High | Yes | **A-** |
| Partition service mock | partition-service-utils | High | Yes | **B+** |
| Provider mock | ethers JsonRpcProvider | High | Partial | **B** |
| Cross-chain data builders | Production data shapes | High | N/A | **A-** |
| WebSocket mock | WebSocketManager | Medium | No reconnect | **C+** |
| Solana test fixtures | Solana Connection | Low | None | **D+** |
| RedisMockState.createMockRedis | ioredis | Medium | xread broken | **C** |

## Cross-Agent Insights

1. **Cache coherency manager is a triple-threat** (Findings #4, #5, #19): Bug-hunter found Map serialization breaks vector clock data. Security-auditor found gossip messages have no HMAC. Performance-reviewer found repeated Map cloning. Three independent agents all flagged this module -- it needs a focused remediation pass.

2. **Solana testing is the largest gap** (Findings #1, #6, #8): Test-quality found 83 placeholder test stubs. Mock-fidelity found no Solana RPC mocking at all. Architecture-auditor noted Solana DEX coverage gaps in docs. The entire Solana data ingestion path (RPC -> parse -> price -> detect) lacks meaningful test coverage.

3. **Provider rotation is a blind spot** (Findings #2, #3, #7, #9): Both ProviderRotationStrategy and ProviderHealthTracker have zero test coverage. WebSocket reconnection/resubscription is untested through the event chain. Mock-fidelity found no rate limiting simulation. The system's resilience to RPC failures is untested.

4. **DLQ fallback has compounding issues** (Findings #17, #30): Bug-hunter found synchronous file I/O blocking the event loop. Security-auditor found no file size limits. Under sustained Redis failure, these compound: sync writes block the loop AND files grow unbounded.

5. **Documentation drift is pervasive but non-critical** (Findings #26-28, #37-38): Architecture-auditor found 8 documentation mismatches. Code is correct in all cases -- docs haven't kept pace with refactoring. The stale `partitioned-detector.ts` reference in both ADR-022 and CLAUDE.md is the most confusing.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 + critical P1 -- fix before any deployment)

- [ ] **Fix #4**: Map serialization in gossip protocol (`cache-coherency-manager.ts:413`) -- use `Object.fromEntries()` / `Object.entries()` for serialize/deserialize
- [ ] **Fix #5**: Add HMAC signing to gossip messages (`cache-coherency-manager.ts`) -- apply existing `hmac-utils.ts` pattern
- [ ] **Fix #19**: Remove dead spin-lock in `incrementVectorClock()` (`cache-coherency-manager.ts:449-468`)
- [ ] **Fix #2**: Write tests for `ProviderRotationStrategy` (15+ methods, ZERO coverage)
- [ ] **Fix #3**: Write tests for `ProviderHealthTracker` (10+ methods, ZERO coverage)
- [ ] **Fix #13**: Add startup warning when HMAC signing disabled in non-test environments

### Phase 2: Next Sprint (P1 coverage + security hardening)

- [ ] **Fix #1**: Implement 46 Solana swap parser tests (priority: Raydium CLMM, Meteora)
- [ ] **Fix #6**: Implement 37 Solana price feed tests
- [ ] **Fix #8**: Create `createMockSolanaConnection()` factory for Solana RPC simulation
- [ ] **Fix #7**: Test `resubscribeWithValidation()` with mock that simulates WS close/error events
- [ ] **Fix #9**: Test `detectDataGaps()`, `isConnectionStale()`, proactive health checks
- [ ] **Fix #10**: Unit test `getPriceOnly()` hot-path read
- [ ] **Fix #11**: Test >500% profit filter and dust filter in SimpleArbitrageDetector
- [ ] **Fix #12**: Unskip lock TTL extension test
- [ ] **Fix #15**: Apply `maskUrl()` to WebSocket connection log messages
- [ ] **Fix #17**: Replace `fs.appendFileSync` with async writes in DLQ fallback, add size limit

### Phase 3: Backlog (P2/P3 -- refactoring, performance, docs)

- [ ] **Fix #20**: Replace `slice().reduce()` with sliding window in worker moving average
- [ ] **Fix #21-22**: Cache `Date.now()` in `calculateArbitrage()` and chain-instance event flow
- [ ] **Fix #23**: Fix spread operator in `StreamBatcher.flush()` error path
- [ ] **Fix #26-28, #37-38**: Update ARCHITECTURE_V2.md (DEX counts, streams table, chain assignment, retention), ADR-022, CLAUDE.md stale references
- [ ] Refactor: Split `chain-instance.ts` (1922 lines), `websocket-manager.ts` (1561 lines), `redis-streams.ts` (1562 lines) into focused modules
- [ ] Refactor: Remove mock placeholder code in `event-processor-worker.ts:96-127`
- [ ] Refactor: Extract duplicated `hashChainName()` to shared utility

---

## Detailed Agent Reports

### Performance-Refactor-Reviewer Findings

#### Perf 1: `prices.slice().reduce()` in Worker Thread Moving Average
**Severity**: P2 | **Location**: `shared/core/src/event-processor-worker.ts:206`
`prices.slice()` allocates a new array on every loop iteration. For window=20 and 1000 prices, that's 981 array allocations.
**Fix**: Use running sum with subtract-old/add-new pattern. **Score**: 3.6

#### Perf 2: Repeated `new Map(this.vectorClock)` Cloning
**Severity**: P2 | **Location**: `shared/core/src/caching/cache-coherency-manager.ts:235,380,397,429,605`
5 Map clones per gossip round x 1000 entries = continuous allocation pressure.
**Fix**: Serialize once per gossip round and reuse. **Score**: 2.9

#### Perf 3: `getBatch()` Uses `.map()` with Closure
**Severity**: P3 | **Location**: `shared/core/src/caching/price-matrix.ts:917`
For 50+ keys at high frequency, closure overhead adds up.
**Fix**: For-loop with pre-allocated result array. **Score**: 2.8

#### Perf 4: `setBatch()` Allocates `resolved` Array Every Call
**Severity**: P3 | **Location**: `shared/core/src/caching/price-matrix.ts:855`
New array of objects per batch update call.
**Fix**: Pre-allocated typed arrays or use simple path for all sizes. **Score**: 1.9

#### Perf 5: Triple `Date.now()` in `calculateArbitrage()`
**Severity**: P2 | **Location**: `services/unified-detector/src/detection/simple-arbitrage-detector.ts:222,241,242`
3 separate `Date.now()` syscalls per opportunity.
**Fix**: Cache `const now = Date.now()` at function entry. **Score**: 3.2

#### Perf 6: Repeated `Date.now()` in Hot-Path `onSyncEvent`
**Severity**: P2 | **Location**: `services/unified-detector/src/chain-instance.ts:1138,1232,1303,1339`
3-4 Date.now() calls per event at 1000 events/sec.
**Fix**: Capture once at event entry, pass through call chain. **Score**: 2.6

#### Perf 7: `console.error()` in IntervalManager
**Severity**: P3 | **Location**: `shared/core/src/interval-manager.ts:98,104`
Synchronous console.error in error path instead of logger.
**Fix**: Use `createLogger('interval-manager')`. **Score**: 2.8

#### Perf 8: Spread Operator in `StreamBatcher.flush()` Error Path
**Severity**: P2 | **Location**: `shared/core/src/redis-streams.ts:258`
`[...batch, ...this.queue]` compounds during Redis outage.
**Fix**: Use `unshift()` or deque structure. **Score**: 3.0

#### Refactor 1: `chain-instance.ts` God Object (1922 lines)
Extract event handlers, cache management, detection scheduling. 1922 -> ~1200 lines (37% reduction). **Score**: 2.4

#### Refactor 2: `websocket-manager.ts` (1561 lines)
Extract BlockGapDetector, WebSocketHealthMonitor, WebSocketSubscriptionManager. 1561 -> ~1000 lines (36% reduction). **Score**: 2.0

#### Refactor 3: `redis-streams.ts` Multiple Responsibilities (1562 lines)
Extract StreamBatcher and StreamConsumer. 1562 -> ~800 lines (49% reduction). **Score**: 2.9

#### Refactor 4: Duplicated `hashChainName()` Function
Same 6-line function in `chain-instance.ts:936-942` and `subscription-manager.ts`. **Score**: 2.8

#### Refactor 5: Mock Placeholder Code in `event-processor-worker.ts`
Lines 96-127: "For now, simulate with mock calculations" with `any` types. Dead placeholder code. **Score**: 3.2

#### Refactor 6: `Array.includes()` in Cold Path
`partition-service-utils.ts:363,365` uses Array.includes for chain validation. Cold path only, style inconsistency. **Score**: 2.8

---

### Security-Auditor Findings

#### S-1: Rate Limiter Local-Only
**P2** | `services/coordinator/src/streaming/rate-limiter.ts:46-97`
In-memory Map, not Redis-backed. Multi-instance effective limit = N * maxTokens.

#### S-2: HMAC Disabled in Non-Production
**P2** | `shared/core/src/redis-streams.ts:385-391,467`
`verifySignature()` returns true for all messages when no signing key. Staging environments vulnerable.

#### S-3: Provider URLs with API Keys in Logs
**P2** | `shared/core/src/websocket-manager.ts:431`
Template literal interpolation bypasses Pino's structured field redaction.

#### S-4: No Inter-Service Authentication
**P2** | `shared/core/src/redis-streams.ts` (general)
All services share same HMAC key. No per-service identity.

#### S-5: Gossip Messages No Authentication
**P2** | `shared/core/src/caching/cache-coherency-manager.ts:19-24`
No HMAC on gossip messages. Cache poisoning via Redis Pub/Sub possible.

#### S-6: No Staleness Check on Cross-Chain Prices
**P3** | `services/cross-chain-detector/src/stream-consumer.ts:174-204`
Hours-old prices pass validation as long as timestamp > 0.

#### S-7: DLQ Fallback No Size Limits
**P3** | `services/coordinator/src/streaming/stream-consumer-manager.ts:505-535`
Local fallback files grow unbounded under sustained Redis failure.

#### S-8: Non-Constant-Time API Key Comparison
**P3** | `shared/core/src/validation.ts:88`
Format-only check. Rate limiting (5 req/15min) mitigates timing attacks.

#### Security Checklist
- [x] HMAC on all Redis Streams paths
- [x] Feature flags use `=== 'true'`
- [x] Production HMAC enforcement
- [x] Cross-stream replay prevention (OP-18)
- [x] Key rotation support (OP-17)
- [x] Message size limits on all WS paths
- [~] Rate limiter fails closed (local-only, not Redis-backed)
- [~] No credentials in logs (structured fields ok, message strings leak)

---

### Bug-Hunter Findings

#### B-1: Map Serialization Loses Vector Clock Data (P1)
`cache-coherency-manager.ts:413` -- `JSON.stringify()` on Map produces `{}`. All causal ordering broken.

#### B-2: Synchronous File I/O in DLQ Fallback (P2)
`stream-consumer-manager.ts:513-526` and `opportunity-router.ts:511-523` -- `fs.appendFileSync` blocks event loop.

#### B-3: Race Condition in Cross-Chain stop() (P2)
`cross-chain-detector/src/stream-consumer.ts:525-537` -- Sets `isConsuming = false` while poll may be in-flight. Currently benign.

#### B-4: Unnecessary Spin-Lock (P2)
`cache-coherency-manager.ts:449-468` -- Synchronous function doesn't need async interleaving guard. Dead code.

#### B-5: Dead Code - Unused sleep() (P3)
`publishing-service.ts:418-420` -- No callers after R7 refactor.

#### B-6: connectMutex Resolution Ordering (P3)
`websocket-manager.ts:532-538` -- Mutex null before resolve. Extremely tight timing window.

#### B-7: TokenMetadata Default Wrong Shape (P3)
`chain-instance.ts:411` -- Fallback `{}` doesn't match interface. Uses `||` not `??`.

---

### Architecture-Auditor Findings

#### A-1: Coordinator Consumer Group Mismatch (Medium)
Docs say 5 groups with per-stream names. Code has 7 groups with single `coordinator-group` name.

#### A-2: DEX Count Inconsistency (Medium)
Docs say 49, actual is 54 (47 EVM + 7 Solana).

#### A-3: Per-Chain DEX Coverage Overstated (Medium)
Docs list DEXs not in config (Polygon: 6 vs 4, Optimism: 6 vs 3, Ethereum: 5 vs 2).

#### A-4: Chain Assignment Algorithm Mismatch (High)
Docs show block-time-based algorithm. Code uses pre-computed Map lookup. Doc algorithm would incorrectly assign Optimism, Base, zkSync, Linea.

#### A-5: ADR-003 Block Time Grouping Contradiction (Low)
Lists Optimism (2s) and Base (2s) under "Block Time < 1s".

#### A-6: Stream Retention Time vs Count Mismatch (Medium)
Docs describe time-based retention ("1 hour", "7 days"). Code uses count-based MAXLEN.

#### A-7: Streams Table Missing Critical Streams (Low)
Docs list 8, code defines 19. Missing `execution-results`, `circuit-breaker`, `pending-opportunities`.

#### A-8: ADR-022 References Non-Existent Code (Medium)
References `partitioned-detector.ts` and `eventLatencies` ring buffer. Neither exist. CLAUDE.md also stale.

#### A-9: No Layer Violations Found (Positive)
No shared/ importing from services/. Dependency direction correct.

---

### Test-Quality-Analyst Findings

#### TODOs/Skipped Tests
- 1 TODO: `correlation-tracker.impl.ts:99` (P3)
- 1 skipped: `detector-lifecycle.integration.test.ts:159` -- lock TTL extension (P1)
- 1 skipped: `worker-pool-load.test.ts:276` -- requires compiled workers (P3)
- 1 skipped: `worker-sharedbuffer.test.ts:321` -- buffer size validation (P2)
- 83 placeholder tests: 37 Solana price feed + 46 Solana swap parser

#### Files with ZERO Test Coverage
- `shared/core/src/provider-rotation-strategy.ts` (15+ methods)
- `shared/core/src/provider-health-tracker.ts` (10+ methods)

#### Well-Tested Areas
- PriceMatrix core operations
- Event processor (all 7 pure functions)
- Redis Streams (HMAC, batching, consumer groups)
- Circuit breaker (full state machine)
- Partition service utils (1574-line test file)
- Solana connection pool and subscription manager
- All 7 factory subscription parsers

---

### Mock-Fidelity-Validator Findings

#### Gap 1: RedisMock.xadd() MAXLEN Handling (P2)
Mock doesn't parse MAXLEN arguments, stores them as field data.

#### Gap 2: RedisMock.xreadgroup() NOACK Behavior (P3)
Mock ignores NOACK flag, xack always returns full count.

#### Gap 3: RedisMock No HMAC Simulation (P2)
Mock doesn't simulate HMAC signing/verification. Acceptable since HMAC tests use real client.

#### Gap 4: WebSocket Mock No Reconnection Lifecycle (P1)
MockWebSocketManager doesn't simulate close/error events, reconnection, heartbeat, or connection states. Tests manually invoke internal methods.

#### Gap 5: Solana RPC Mock Absent (P1)
Only pool data fixtures exist. No Connection simulation, no getAccountInfo, no subscription callbacks.

#### Gap 6: Cross-Chain StreamConsumer Mock No Events (P2)
Mock provides jest.fn() stubs but no event emission. No simulateMessage() method.

#### Gap 7: Provider Mock No Rate Limiting (P2)
No 429 simulation, no batch request, no fallback/rotation, no stale data detection.

#### Gap 8: RedisMockState xread/xreadgroup Static Null (P2)
Always returns null even though xadd writes to shared state. Asymmetry prevents end-to-end testing.

#### Supplementary: Partition Service Mock Actually Comprehensive
CLAUDE.md "incomplete" note is stale. Mock is 894 lines with 25+ functions.

#### Supplementary: WebSocket Mocks Lack Realistic ABI-Encoded Events
No test sends realistic Ethereum Sync/Swap log with proper topics and data fields. Full decode path untested through mock layer.
