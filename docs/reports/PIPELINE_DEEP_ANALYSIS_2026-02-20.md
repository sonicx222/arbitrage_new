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

---
---

# Wave 2: Extended Deep Analysis (Operational Focus)

**Date**: 2026-02-20
**Scope**: Operational health of blockchain connection and detection pipeline — latency, failure modes, data integrity, cross-chain edge cases, observability, configuration drift
**Agents**: 6 specialized (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector)
**Model**: Claude Opus 4.6
**Files Analyzed**: 60+ source files, 3 ADRs, deployment configs, .env.example

---

## Executive Summary

**Total findings: 52** (after deduplication across 6 agents; 7 merged from cross-agent overlap)

| Severity | Count |
|----------|-------|
| Critical (P0) | 3 |
| High (P1) | 8 |
| Medium (P2) | 26 |
| Low (P3) | 15 |

**Top 5 highest-impact issues:**
1. **GossipMessage vectorClock Map destroyed by JSON.stringify AND mergeVectorClock crashes on deserialized plain object** — entire gossip protocol silently non-functional (confirms + extends Wave 1 #4)
2. **Consumer groups can all fail silently** — coordinator continues running non-functional, reports healthy, processes zero opportunities
3. **Static L1 data fees for 5 L2 rollup chains** — hardcoded $0.30-0.50 instead of dynamic oracle, can spike 10-50x during congestion causing systematic losses
4. **Blocking XREADGROUP with blockMs=1000** on both coordinator and execution engine creates worst-case 2000ms tail latency (detection path itself is only 3-12ms)
5. **Cross-chain confidence uses only source-side freshness** — stale sell-side prices produce overconfident opportunities

**Overall health grade: B**

The hot-path detection pipeline (WebSocket → detection) is excellent at 3-12ms. Redis Streams with HMAC signing, deferred ACK, and DLQ are solid. Circuit breakers and graceful shutdown are well-implemented. However, the consumer pipeline has significant latency holes (blocking reads), the gossip protocol is fundamentally broken, L2 gas estimation uses static values, observability infrastructure exists but is not wired to core paths, and 30+ configuration knobs are undocumented.

**Agent agreement map:**
- Cross-chain detector ACK-before-process: data-integrity-auditor + failure-mode-analyst (2 agents)
- Opportunity publisher fire-and-forget: data-integrity-auditor + failure-mode-analyst (2 agents)
- Missing P1 Fly.io config: config-drift-detector + cross-chain-analyst (2 agents)
- DLQ sync I/O: failure-mode-analyst confirms Wave 1 bug-hunter
- Map serialization: data-integrity-auditor confirms + extends Wave 1 bug-hunter
- Triple Date.now(): latency-profiler confirms Wave 1 performance-reviewer

---

## Wave 1 ↔ Wave 2 Cross-Reference

| Wave 1 Finding | Wave 2 Confirmation/Extension | Status |
|---|---|---|
| #4 Map serialization `{}` in gossip | DI-11: Confirmed. DI-12: NEW — mergeVectorClock also crashes with TypeError on deserialized object | Extended (crash behavior NEW) |
| #5 Gossip no HMAC | DI-3: Extended — backward compat paths allow cross-stream replay even after OP-18 | Extended |
| #17 Sync I/O in DLQ fallback | FM-2: Confirmed at `stream-consumer-manager.ts:526` and `opportunity-router.ts:523` | Confirmed |
| #19 Dead spin-lock | DI-13: Confirmed — unnecessary and throws on contention | Confirmed |
| #21 Triple Date.now() | Perf-3: Confirmed at `simple-arbitrage-detector.ts:222,241,242` | Confirmed |
| #22 Repeated Date.now() in chain-instance | Perf-4: Confirmed + identified uncached `chainPairKey` string allocation at `:1565` | Extended |

---

## Critical Findings (P0 — Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| W2-1 | Bug / Schema | `cache-coherency-manager.ts:413` | **GossipMessage vectorClock Map destroyed by JSON.stringify** — `JSON.stringify(Map)` produces `{}`, all vector clock data lost on every gossip message. Causal ordering completely broken across nodes. | data-integrity | HIGH | Use `Object.fromEntries()` before stringify, `new Map(Object.entries())` after parse. | 4.4 |
| W2-2 | Bug / Schema | `cache-coherency-manager.ts:472` | **mergeVectorClock crashes on deserialized plain object** — after JSON.parse, `remoteClock` is `{}` (not Map), calling `.entries()` throws `TypeError`. Caught by outer try-catch, gossip silently fails every round. | data-integrity | HIGH | Add deserialization layer: `new Map(Object.entries(parsedClock))` in `handleIncomingMessage()`. | 4.1 |
| W2-3 | Failure Detection | `coordinator.ts:865-869` | **Consumer groups all fail silently — coordinator continues non-functional**. All 7 consumer group creations fail (e.g., Redis read-only), but coordinator starts HTTP server, reports healthy, processes zero opportunities. | failure-mode | HIGH | If `successCount === 0 && failureCount > 0`, abort startup or set health to degraded with P0 alert. | 4.4 |

## High Findings (P1 — Reliability/Coverage/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| W2-4 | Gas Model | `gas-price-cache.ts:177-183` | **Static L1 data fees for 5 L2 chains** — hardcoded $0.30-$0.50 instead of dynamic oracle queries. Actual fees can spike 10-50x during L1 congestion, causing systematic losses on Arbitrum/Optimism/Base/zkSync/Linea. | cross-chain | HIGH | Query L1 fee oracles dynamically: Arbitrum `ArbGasInfo`, Optimism `GasPriceOracle`, zkSync `zks_estimateFee`. Cache with 30s TTL. | 3.5 |
| W2-5 | Latency | `redis-streams.ts:1339-1343` | **Blocking XREADGROUP with blockMs=1000** on coordinator and execution engine. Worst-case 2000ms tail latency across two blocking reads. Detection path is only 3-12ms — consumer reads dominate. | latency-profiler | HIGH | Reduce `blockMs` to 100-200ms for time-sensitive streams. | 3.8 |
| W2-6 | Data Loss | `opportunity.publisher.ts:132-141`, `unified-detector/index.ts:189-195` | **Opportunity publisher silently drops on XADD failure** — no retry, no DLQ, no local fallback. Detected opportunities permanently lost during Redis connectivity issues. | data-integrity, failure-mode | HIGH | Add bounded retry queue (3 attempts, 100ms backoff) or local file fallback. | 3.4 |
| W2-7 | Recovery | `chain-instance.ts:891-898` | **Max reconnect (5 attempts) leaves chain permanently dead** — no slow-recovery mechanism. Chain never reconnects until service restart. | failure-mode | HIGH | Add slow recovery timer (try every 5 minutes after max attempts exhausted). | 4.0 |
| W2-8 | Tracing | `chain-instance.ts` (entire file) | **No trace context at WebSocket/detection phase** — tracing starts at opportunity publish, not at WS receive. The entire detection path is a black box for latency diagnosis. | observability | HIGH | Create root TraceContext at WS message receive, propagate through detection. | 3.1 |
| W2-9 | Metrics | `shared/core/src/metrics/` (exists but unwired) | **PrometheusMetricsCollector not wired to core pipeline** — full counter/gauge/histogram support exists but only used by warming module and A/B testing. No detection rate, execution latency, or false positive rate metrics. | observability | HIGH | Wire into coordinator and execution engine. Define standard metrics: `detection_total{chain}`, `execution_latency_ms`, `gas_estimation_error`. | 3.5 |
| W2-10 | Data Integrity | `price-matrix.ts:854-909` | **setBatch skips monotonic timestamp enforcement** — fast path for batches ≥10 does NOT check monotonic timestamps (unlike `setPrice()` at :553-559). Stale prices in a batch overwrite newer prices. | data-integrity | HIGH | Add timestamp check in setBatch fast path: compare `relativeTs` against current `Atomics.load(timestamps, index)`. | 3.7 |
| W2-11 | Latency | `chain-instance.ts:663` | **StreamBatcher 10ms timer adds guaranteed latency** to price updates. At moderate throughput, batches fill slowly and the 10ms timer dominates. Consumes 20% of 50ms budget. | latency-profiler | HIGH | Intentional ADR-002 trade-off. Detection bypasses this (runs before publish). Document as accepted latency. | 3.6 |

## Medium Findings (P2 — Maintainability/Performance/Operational)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| W2-12 | Detection | `arbitrage-detector.ts:599` | Cross-chain confidence uses only source-side freshness — stale sell-side ignored | cross-chain | HIGH | 4.0 |
| W2-13 | Audit Trail | `trade-logger.ts:268-269` | Trade logger `slippage`, `retryCount` defined but hardcoded undefined; `pipelineTimestamps` not written | observability | HIGH | 3.6 |
| W2-14 | Blind Spot | `cross-chain-detector/src/detector.ts:797` | Silent ETH price refresh error swallowing after first success via `.catch(() => {})` | observability | HIGH | 3.6 |
| W2-15 | Deployment | `infrastructure/fly/` (missing) | Missing Fly.io config for P1 (asia-fast) partition — no deployment path for highest-priority chains | config-drift, cross-chain | HIGH | 3.7 |
| W2-16 | Deployment | `partitions.ts:263` vs `partition-high-value.toml:25` | P3 region drift: code says `us-east1`, Fly.io deploys to `sjc` (US-West) | config-drift | HIGH | 3.6 |
| W2-17 | Config | `base.strategy.ts:142` | SWAP_DEADLINE_SECONDS default 300s (5 minutes) — extremely long for DeFi arbitrage | config-drift | HIGH | 3.6 |
| W2-18 | Config | `gas-price-cache.ts:273-275` | GAS_FALLBACK_SAFETY_FACTOR (2.0x) undocumented — doubles gas estimates during RPC outage, may reject profitable trades | config-drift | HIGH | 3.6 |
| W2-19 | Solana | `arbitrage-detector.ts:341` | `toLowerCase()` breaks Solana base58 case-sensitive addresses (latent — Solana uses own path) | cross-chain | HIGH | 3.6 |
| W2-20 | Delivery | `cross-chain-detector/stream-consumer.ts:392` | Cross-chain detector ACKs before processing results used — message lost if handler fails | data-integrity, failure-mode | HIGH | 3.4 |
| W2-21 | HMAC | `redis-streams.ts:484-499` | HMAC backward compat allows cross-stream replay for pre-OP-18 messages | data-integrity | HIGH | 3.3 |
| W2-22 | Data Loss | `redis-streams.ts:346-367` | No consumer lag monitoring for MAXLEN trimming — silent data loss when consumer lag exceeds MAXLEN | data-integrity | HIGH | 3.3 |
| W2-23 | Env Var | Multiple files | 30+ undocumented environment variables including critical execution strategy and risk management configs | config-drift | HIGH | 3.3 |
| W2-24 | Config | `multi-leg-path-finder.ts:135-147` | 12 multi-leg timeout env vars (global + per-chain) all undocumented | config-drift | HIGH | 3.3 |
| W2-25 | Metrics | websocket-manager.ts | No per-chain WebSocket health metric — WS state only visible through log scraping | observability | HIGH | 3.3 |
| W2-26 | Logging | `chain-instance.ts:1780` | Detection rejection reasons not logged — detector returns structured reasons but they are discarded | observability | HIGH | 3.3 |
| W2-27 | Dedup | `publishing-service.ts:243-248` | Publish-side Redis dedup is fail-open — if Redis check fails, message published anyway (duplicates possible) | data-integrity | HIGH | 3.2 |
| W2-28 | Schema | `stream-serialization.ts:40-77` | Stream serialization loses numeric types — all fields become strings, causing fragile JS coercion in validation | data-integrity | MEDIUM | 3.0 |
| W2-29 | Dedup | `opportunity-router.ts:234-241` | Dedup state lost on coordinator restart — first message per opportunity always passes | data-integrity | HIGH | 3.0 |
| W2-30 | Metrics | price-matrix.ts | No price staleness metric — if WS silently stops delivering events, stale prices go undetected | observability | HIGH | 3.4 |
| W2-31 | Health | `health.routes.ts:36-62` | Coordinator health check does not verify Redis connectivity — may report healthy when Redis unreachable | observability | HIGH | 3.0 |
| W2-32 | Config | `thresholds.ts:39` | Global slippage tolerance 5% may be too high for fast chains (Solana/Arbitrum have tighter spreads) | config-drift | MEDIUM | 3.0 |
| W2-33 | Recovery | `chain-instance.ts:1799-1835` | Worker thread crash has no recovery mechanism — singleton stays broken for process lifetime | failure-mode | MEDIUM | 3.0 |
| W2-34 | Gas / Solana | `solana-types.ts:234` | Solana gas estimate (300K CU) has no USD conversion — not comparable to EVM gas costs | cross-chain | MEDIUM | 3.0 |
| W2-35 | Performance | `simple-arbitrage-detector.ts:222,241,242` | Triple `Date.now()` per opportunity — 1 call would suffice. Inconsistent timestamps (id ≠ opportunity). | latency-profiler | HIGH | 3.2 |
| W2-36 | Performance | `chain-instance.ts:1565` | Uncached `${chainId}:${address}` string allocation per Sync event — cached `chainPairKey` already exists | latency-profiler | HIGH | 3.2 |
| W2-37 | Performance | `opportunity.publisher.ts:106-111` | Spread `{...opportunity}` allocates new object on every publish — could mutate in-place | latency-profiler | MEDIUM | 2.6 |

## Low Findings (P3 — Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| W2-38 | Bridge | `cross-chain.strategy.ts` | Bridge withdrawal delays (7 days) not factored into profit calculations | cross-chain | HIGH | 2.7 |
| W2-39 | Config | `solana-detector.ts:134-136` | Solana profit threshold uses percent form vs EVM decimal — convention mismatch | cross-chain | HIGH | 3.2 |
| W2-40 | Cascade | System-wide | No circuit breaker for Redis operations — latency-based degradation unprotected | failure-mode | HIGH | 2.4 |
| W2-41 | Data Loss | `coordinator.ts:461-512` | `startId: '$'` means post-crash messages lost (intentional design for trading safety) | failure-mode | HIGH | 2.3 |
| W2-42 | Recovery | `solana-connection-pool.ts:130-134` | All-unhealthy fallback uses round-robin on known-dead connections | failure-mode | HIGH | 2.6 |
| W2-43 | Metrics | `stream-health-monitor.ts:569-598` | Consumer lag not exposed per consumer group in Prometheus | observability | HIGH | 2.9 |
| W2-44 | Blind Spot | `service-bootstrap.ts:168`, `partition-service-utils.ts:962,981` | Shutdown error swallowing during crash recovery — `.catch(() => {})` | observability | HIGH | 3.2 |
| W2-45 | Tracing | `stream-serialization.ts:67` | Manual trace field copy instead of `propagateContext()` — loses spanId/parentSpanId | observability | MEDIUM | 3.2 |
| W2-46 | Metrics | `logging/otel-transport.ts:309,316` | OTEL transport drop counter not exposed via any health endpoint | observability | MEDIUM | 2.9 |
| W2-47 | HMAC | `hmac-utils.ts:47-55` | HMAC-utils (Redis key signing) has no scope/replay protection | data-integrity | HIGH | 3.2 |
| W2-48 | Performance | `shared-key-registry.ts:174-228` | Worker thread key lookup O(n) linear scan (mitigated by cache after first access) | data-integrity | HIGH | 2.2 |
| W2-49 | Data Integrity | `cache-coherency-manager.ts:449-468` | Dead spin-lock unnecessary for synchronous function — throws on impossible contention | data-integrity | HIGH | 2.8 |
| W2-50 | Config | `circuit-breaker-manager.ts:288` | `parseInt(...) \|\| 0` pattern — minor convention violation, minimal real impact | config-drift | HIGH | 3.1 |
| W2-51 | Gas | `gas-price-cache.ts:158` | zkSync ergs treated as standard EVM gas units | cross-chain | MEDIUM | 2.3 |
| W2-52 | Config | `mev-config.ts:126` | Solana chainSettings `priorityFeeGwei` field name misleading (Solana uses lamports) | cross-chain | MEDIUM | 2.2 |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency | Bottleneck? |
|-------|-----------|-----------|-------------------|-------------|
| WS Receive | `ws.on('message')` | websocket-manager.ts:468 | ~0.1ms | No |
| Buffer→String | `data.toString()` | websocket-manager.ts:805 | ~0.1-0.5ms | No |
| JSON.parse | `parseMessageSync()` | websocket-manager.ts:845 | ~0.2-1ms | Conditional |
| Event Routing | handleWebSocketMessage | chain-instance.ts:1131 | ~0.05ms | No |
| Reserve Decode | handleSyncEvent (BigInt parse) | chain-instance.ts:1191 | ~0.5-2ms | No |
| Price Calc | emitPriceUpdate + batcher.add | chain-instance.ts:1378 | ~0.3-1ms | No |
| **Batcher Flush** | StreamBatcher maxWaitMs | redis-streams.ts:201 | **0-10ms** | **P1** |
| Detection | checkArbitrageOpportunity | chain-instance.ts:1517 | ~0.5-3ms | No |
| Arb Calc | calculateArbitrage | simple-arbitrage-detector.ts:135 | ~0.1-0.3ms | No |
| Opportunity Pub | XADD to opportunities stream | opportunity.publisher.ts:96 | 1-5ms | No |
| **Coordinator Read** | XREADGROUP (blockMs=1000) | redis-streams.ts:1339 | **0-1000ms** | **P0** |
| Route + Forward | processOpportunity + forwardToExecution | opportunity-router.ts:220 | 1-5ms | No |
| **Execution Read** | XREADGROUP (blockMs=1000) | opportunity.consumer.ts:282 | **0-1000ms** | **P0** |
| Handle + Enqueue | handleStreamMessage | opportunity.consumer.ts:447 | ~0.2-1ms | No |

**Detection path: ~3-12ms** (well within 50ms budget)
**End-to-end best case: ~5-15ms** | **Typical: ~20-50ms** | **Worst case: ~2020ms** (2x blocking reads)

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| 1 | WS Connection | All WS disconnect simultaneously | Per-chain `onDisconnected` handler | Independent reconnect w/ backoff | Events during gap lost | websocket-manager.ts:111 |
| 2 | WS Connection | Max reconnect (5) exhausted | Chain status set to 'error' | **NONE until restart** | Entire chain permanently offline | chain-instance.ts:891 |
| 3 | Redis | Redis down | StreamBatcher flush fails | Queue until maxQueueSize, then DROP | Messages dropped after queue full | redis-streams.ts:166 |
| 4 | Redis | Redis slow (not down) | **Not detected** | **No CB for Redis latency** | Cascading latency across all services | System-wide |
| 5 | Opportunity Pub | XADD failure | `.catch()` logs error | **No retry, no DLQ** | Detected opportunity permanently lost | opportunity.publisher.ts:132 |
| 6 | Consumer Groups | All groups fail to create | Logged as CRITICAL | **Coordinator continues running** | All opportunities missed | coordinator.ts:865 |
| 7 | Execution | Engine crash mid-trade | PEL tracks in-flight msgs | XCLAIM on restart | Flash loan atomic; gas wasted on replay | opportunity.consumer.ts:338 |
| 8 | DLQ Fallback | Redis DLQ + file write both fail | Only app logs remain | No recovery | Failed message data lost | stream-consumer-manager.ts:483 |
| 9 | Worker Thread | Worker crash | Promise rejection caught | **No restart mechanism** | Multi-leg detection silently stops | chain-instance.ts:1823 |
| 10 | Partition | One partition crash | Coordinator detects unhealthy | **No work redistribution** | Chains in partition have zero coverage | partition-service-utils.ts |

---

## Delivery Guarantee Analysis

| Pipeline Segment | Semantic | Evidence |
|---|---|---|
| WebSocket → Price Cache | At-most-once | Direct memory write, no persistence |
| Price Cache → Detection | At-most-once | In-memory SharedArrayBuffer read |
| Detection → XADD (Opportunities) | At-most-once | No retry on XADD failure in OpportunityPublisher |
| Detection → XADD (Price Updates) | At-most-once | StreamBatcher drops when maxQueueSize reached |
| Coordinator XREADGROUP → Processing | **At-least-once** | Deferred ACK, DLQ on failure, XCLAIM for orphans |
| Coordinator → Execution XADD | At-least-once with retry | 3 retries + exponential backoff, DLQ on permanent failure |
| Execution Engine XREADGROUP → Execution | **At-least-once** | Deferred ACK, backpressure leaves in PEL |
| Cross-chain Detector XREADGROUP | **At-most-once** | ACKs immediately before processing completes |

**Overall**: At-most-once from WebSocket to detection; at-least-once from coordinator to execution. Cross-chain detector is at-most-once end-to-end.

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| 1 | Arb/Opt/Base/zkSync/Linea | Static L1 data fees ($0.30-0.50) instead of dynamic oracle | Systematic losses during L1 gas spikes (10-50x) | P1 | gas-price-cache.ts:177 |
| 2 | All cross-chain | Confidence only checks buy-side freshness | Overconfident on stale sell-side data | P2 | arbitrage-detector.ts:599 |
| 3 | Solana (latent) | `toLowerCase()` in shared detector breaks base58 | Token pair corruption if shared path used for Solana | P2 | arbitrage-detector.ts:341 |
| 4 | Solana | Gas estimate (300K CU) has no USD conversion | Not comparable to EVM gas costs | P2 | solana-types.ts:234 |
| 5 | zkSync | Ergs treated as standard EVM gas | Minor estimation inaccuracy | P3 | gas-price-cache.ts:158 |
| 6 | All | Bridge delays not in profit calculations | Capital locked 7 days eroding annualized returns | P3 | cross-chain.strategy.ts |

---

## Observability Assessment

### Trace Propagation
Tracing begins at opportunity publish (`opportunity.publisher.ts:105`). The upstream chain — WebSocket receive, price cache, detection — has **zero tracing**. `chain-instance.ts` does not import any tracing modules. Coordinator and execution engine correctly propagate traceId through XADD/XREADGROUP.

### Metrics
`PrometheusMetricsCollector` infrastructure exists with full counter/gauge/histogram/summary support but is **only wired to warming module and A/B testing** — NOT to core pipeline. Missing metrics: detection rate, false positive rate, per-chain WS health, price staleness, gas estimation accuracy, execution latency histograms.

### Health Checks
Coordinator `/api/health/ready` does NOT verify Redis connectivity. Partition health endpoints only check `isRunning` state, not dependency health. Execution engine correctly caches Redis health check every 10s.

### Trade Audit Trail
JSONL logging captures most fields (timestamp, chain, dex, tokens, amounts, profit, gas, txHash, traceId, route). **Missing**: `slippage` (hardcoded undefined), `retryCount` (hardcoded undefined), `pipelineTimestamps` (not written).

### Blind Spots (Silent Error Swallowing)
- `cross-chain-detector/src/detector.ts:797` — ETH price refresh `.catch(() => {})`
- `execution-engine/src/index.ts:136` — Redis health check error details swallowed
- `service-bootstrap.ts:168`, `partition-service-utils.ts:962,981` — Shutdown during crash recovery

---

## Configuration Health

### Feature Flags: ✅ ALL CORRECT
18 feature flags audited. All use correct patterns: `=== 'true'` for opt-in, `!== 'false'` for safety-default-ON.

### `||` vs `??`: ✅ MOSTLY CORRECT
5 minor violations found, all in cold-path parsing with minimal real impact. Codebase largely follows the `??` convention.

### Env Var Coverage: ⚠️ 30+ UNDOCUMENTED
Critical undocumented vars: `SWAP_DEADLINE_SECONDS` (300s default), `EXECUTION_HYBRID_MODE`, `GAS_FALLBACK_SAFETY_FACTOR` (2.0x), `MULTI_LEG_TIMEOUT_MS` (+ 11 per-chain), `RISK_MANAGEMENT_ENABLED`, `BRIDGE_RECOVERY_ENABLED`.

### Deployment: ⚠️ DRIFT DETECTED
- Missing Fly.io config for P1 (asia-fast) — no deployment path for BSC/Polygon/Avalanche/Fantom
- P3 region drift: code says `us-east1`, Fly.io deploys to `sjc` (US-West)
- L2-Fast deployed to Singapore region, but L2 sequencers are in US (~150ms added latency)

---

## Cross-Agent Insights

1. **Opportunity publisher is a double-threat** (W2-6, W2-8): Both data-integrity and failure-mode agents independently flagged the fire-and-forget publisher. Combined with the tracing gap (W2-8), lost opportunities are both invisible AND unrecoverable.

2. **Cross-chain detector is the weakest pipeline segment** (W2-20, W2-14, W2-12): ACKs before processing (2 agents agree), silent ETH price refresh failure, and one-sided freshness check create a path where stale, overconfident cross-chain opportunities could be generated while actual data loss goes undetected.

3. **Observability infrastructure exists but is unwired** (W2-8, W2-9, W2-13, W2-25, W2-26, W2-30): Full PrometheusMetricsCollector, TraceContext propagation, and trade logger field definitions all exist. They are just not connected to the core pipeline. This is a wiring exercise, not a greenfield build.

4. **Consumer blocking reads dominate end-to-end latency** (W2-5): The latency-profiler proved the detection path is 3-12ms (excellent), but two blocking reads at 1000ms each create worst-case 2020ms end-to-end. The <50ms hot-path target is met for detection but not for the full pipeline.

5. **L2 gas estimation is a systematic financial risk** (W2-4, W2-18, W2-34): Static L1 fees (cross-chain), 2.0x safety factor during fallback (config-drift), and missing Solana USD conversion (cross-chain) all compound to create inaccurate gas estimates across 7 of 11 chains.

6. **Failure-mode and data-integrity agents agree on delivery semantics** (Information Separation result): Both independently concluded at-most-once upstream, at-least-once in coordinator→execution. No conflicts. The cross-chain detector at-most-once ACK pattern was flagged by both as a gap.

---

## Conflict Resolutions

No conflicts between agents. The Information Separation design (agents 2+3 on Redis Streams) produced agreement on delivery semantics, shutdown behavior, and data loss windows. Both agents independently identified the cross-chain detector ACK gap, providing HIGH confidence.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 + critical P1 — fix before deployment)

- [ ] **Fix W2-1/W2-2**: Map serialization in gossip protocol — use `Object.fromEntries()`/`Object.entries()` for serialize/deserialize. Add deserialization layer in `handleIncomingMessage()`. (Extends Wave 1 #4)
- [ ] **Fix W2-3**: Consumer group startup abort — if all consumer groups fail, throw error from `createConsumerGroups()` to prevent non-functional coordinator
- [ ] **Fix W2-5**: Reduce `blockMs` from 1000 to 100-200ms on coordinator and execution engine consumers for time-sensitive streams
- [ ] **Fix W2-7**: Add slow recovery timer after max reconnect attempts exhausted (try every 5 min)
- [ ] **Fix W2-10**: Add monotonic timestamp check in `setBatch()` fast path (match `setPrice()` OP-5 fix)

### Phase 2: Next Sprint (P1 coverage + operational hardening)

- [ ] **Fix W2-4**: Dynamic L1 fee oracle integration for 5 L2 rollup chains (Arbitrum ArbGasInfo, Optimism GasPriceOracle, zkSync zks_estimateFee)
- [ ] **Fix W2-6**: Add bounded retry queue in OpportunityPublisher (3 attempts, 100ms backoff)
- [ ] **Fix W2-8**: Create root TraceContext at WebSocket message receive, propagate through detection
- [ ] **Fix W2-9**: Wire PrometheusMetricsCollector into coordinator and execution engine with standard metrics
- [ ] **Fix W2-12**: Use `Math.max()` of both source and dest timestamps for cross-chain freshness penalty
- [ ] **Fix W2-13**: Populate trade logger `slippage`, `retryCount`, `pipelineTimestamps` fields
- [ ] **Fix W2-14**: Replace silent `.catch(() => {})` with logged warning in cross-chain ETH price refresh
- [ ] **Fix W2-15**: Create `partition-asia-fast.toml` for P1 deployment
- [ ] **Fix W2-16**: Align P3 region between code (`us-east1`) and Fly.io (`sjc`)
- [ ] **Fix W2-17**: Reduce SWAP_DEADLINE_SECONDS default from 300s to 60s, document in .env.example
- [ ] **Fix W2-20**: Implement deferred ACK pattern in cross-chain detector (match coordinator pattern)

### Phase 3: Backlog (P2/P3 — refinement, config, observability)

- [ ] **Fix W2-18**: Document GAS_FALLBACK_SAFETY_FACTOR in .env.example
- [ ] **Fix W2-19**: Add chain-awareness guard to `isReverseTokenOrder()` for Solana base58
- [ ] **Fix W2-21**: Add `HMAC_REQUIRE_STREAM_SCOPE=true` flag to disable backward compat paths
- [ ] **Fix W2-22**: Add periodic consumer lag check comparing XINFO STREAM with XPENDING
- [ ] **Fix W2-23**: Document all 30+ undocumented env vars in .env.example
- [ ] **Fix W2-25**: Add per-chain WebSocket health metric via `getConnectionStatus()` method
- [ ] **Fix W2-26**: Add throttled debug logging of detection rejection statistics (every 60s)
- [ ] **Fix W2-30**: Add per-chain price staleness metric with alert at 2x block time
- [ ] **Fix W2-31**: Add cached Redis PING check to coordinator readiness probe
- [ ] **Fix W2-32**: Make slippage tolerance per-chain (Ethereum 5%, L2s 2%, Solana 1%)
- [ ] **Fix W2-35**: Cache `Date.now()` once in `calculateArbitrage()` (confirms Wave 1 #21)
- [ ] **Fix W2-36**: Use cached `chainPairKey` instead of template literal in `checkArbitrageOpportunity`
- [ ] **Fix W2-44**: Replace `.catch(() => {})` with `.catch(err => console.error(...))` in crash shutdown
- [ ] **Fix W2-49**: Remove dead spin-lock in `incrementVectorClock()` (confirms Wave 1 #19)
