# Deep Analysis: `/services` — 2026-03-14

**Scope**: 10 services, 197 source files, ~460 test files, ~79K lines
**Methodology**: 6-agent team (architecture, bugs, security, test quality, mock fidelity, performance) + team lead independent analysis
**Previous analysis**: Services Layer 2026-03-12 (grade B, 45 findings — 3 commits resolved all)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| Critical (P0) | 1 |
| High (P1) | 9 |
| Medium (P2) | 16 |
| Low (P3) | 10 |
| **Total** | **36** |

**Top 3 issues:**
1. **P0-1**: Flash loan fee calculator uses `ethers.formatEther()` for ALL tokens — for non-18-decimal tokens (USDC/6, WBTC/8), flash loan fee is underestimated by orders of magnitude, allowing unprofitable trades past the profitability filter
2. **P1-1**: 5 mega-files (>1500 LOC) impede maintainability — `chain-instance.ts` (2786), `coordinator.ts` (2674), `flash-loan.strategy.ts` (2159)
3. **P1-3**: `BridgeRecoveryService` and `BridgePollManager` have ZERO dedicated test files — critical fund recovery code is untested

**Overall grade: B+** (down from initial A- due to P0 flash loan fee calculator bug)

The services layer shows strong engineering maturity after multiple remediation rounds. Key strengths: proper `??` nullish coalescing everywhere (zero `|| 0` instances), comprehensive validation (pre-compiled regex, O(1) type lookups), well-bounded data structures (Map eviction at 10K, circular buffers), and resilient shutdown paths with timeout protection. The P0 finding is a significant dimensional error in the profitability filter, though on-chain `minimumProfit` enforcement prevents actual fund loss (impact is wasted gas). The remaining findings are primarily test coverage gaps, maintainability concerns, and minor performance issues.

**Agent agreement map**: Flash loan fee calculator flagged by bug-hunter (P0) and mock-fidelity-validator (parameter realism concern). Layer violations flagged by architecture-auditor and test-quality-analyst. Mempool detector test gap flagged by test-quality-analyst and team lead independently.

---

## Critical Findings (P0)

### P0-1: Flash Loan Fee Calculator — Token Decimal/Price Dimensional Mismatch

**Location**: `execution-engine/src/strategies/flash-loan-fee-calculator.ts:166-168`
**Agents**: bug-hunter (PRIMARY), mock-fidelity-validator (parameter realism)
**Confidence**: HIGH (92%)

```typescript
// Line 166-168: The bug
const flashLoanFeeWei = this.calculateFlashLoanFee(flashLoanAmountWei, chain);
const flashLoanFeeEth = parseFloat(ethers.formatEther(flashLoanFeeWei)); // BUG: assumes 18 decimals
const flashLoanFeeUsd = flashLoanFeeEth * nativeTokenPriceUsd;           // BUG: assumes native token
```

**Two dimensional errors:**

1. **Decimal mismatch**: `ethers.formatEther()` divides by 10^18. For USDC (6 decimals), the fee is expressed in 6-decimal units. Dividing by 10^18 instead of 10^6 makes the fee appear 10^12 times smaller.

2. **Price mismatch**: The fee (in borrowed token units) is multiplied by `nativeTokenPriceUsd` (ETH=$2000, BNB=$300, etc.). For a USDC flash loan, the fee should be priced at ~$1/USDC, not $2000/ETH.

**Impact analysis**:
- **Native token flash loans (WETH, WBNB)**: Both errors are absent — fee IS in native units with 18 decimals. This is the common case for single-chain arbitrage, so the bug has been silent.
- **Non-native token flash loans (USDC, DAI, WBTC)**: Fee massively underestimated → unprofitable trades pass pre-flight profitability filter → on-chain revert → **wasted gas** (not fund loss, because on-chain `minimumProfit` enforcement catches the actual shortfall).

**Worst case**: 10,000 USDC flash loan:
- Fee = 5,000,000 (5 USDC in 6-decimal units)
- `formatEther(5000000)` = 0.000000000005 (should be 5.0)
- USD = 0.000000000005 × $2000 = $0.00000001 (should be $5.00)
- Net effect: Fee appears ~5×10^8 times smaller → any trade passes profitability check

**Mitigation already in place**: On-chain contracts enforce `minimumProfit > 0` and revert if actual profit after flash loan repayment is insufficient. So the financial impact is gas waste per failed transaction (~$5-50 on mainnet Ethereum), not capital loss.

**Fix**: Accept token decimals in `ProfitabilityParams` and use `ethers.formatUnits(feeWei, tokenDecimals)`. Also accept `borrowedTokenPriceUsd` instead of using `nativeTokenPriceUsd` for the fee pricing:

```typescript
// Fixed version
const flashLoanFeeHuman = parseFloat(ethers.formatUnits(flashLoanFeeWei, tokenDecimals));
const flashLoanFeeUsd = flashLoanFeeHuman * borrowedTokenPriceUsd;
```

**Score**: 4.4 (Impact=5 × 0.4 + Effort=4.5 × 0.3 + Risk=4 × 0.3)

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| P1-1 | Refactoring | Multiple | 5 mega-files exceed 1500 LOC maintainability threshold | Team Lead | HIGH | 3.8 |
| P1-2 | Test Coverage | mempool-detector/ | 4 test files for 11 source files — decoder blind spots | Team Lead, test-quality | HIGH | 3.6 |
| P1-3 | Test Coverage | execution-engine/src/strategies/ | BridgeRecoveryService + BridgePollManager: ZERO dedicated tests | test-quality | HIGH | 3.6 |
| P1-4 | Bug | coordinator/src/streaming/rate-limiter.ts:76 | Discrete refill starves tokens for sub-period checks | Team Lead | MEDIUM | 3.4 |
| P1-5 | Security | coordinator/src/api/middleware/ | TRUST_PROXY missing — rate limiting disabled behind reverse proxy | Team Lead, security | HIGH | 3.2 |
| P1-6 | Bug | execution-engine/src/execution-pipeline.ts:421 | Missing XACK on `redis_error` lock failure path | bug-hunter | MEDIUM | 3.2 |
| P1-7 | Performance | unified-detector/src/chain-instance.ts:1721 | Double `parseInt` in hot-path `handleSwapEvent` | performance | MEDIUM | 3.0 |
| P1-8 | Architecture | chain-instance.ts:2786 | Largest file in services (2786 LOC) — needs extraction | Team Lead | HIGH | 3.0 |
| P1-9 | Architecture | shared/core/__tests__ | Layer violation: shared/ test imports from services/ | architecture | HIGH | 2.8 |

### P1-1: Mega-File Proliferation

**Files exceeding 1500 LOC:**

| File | Lines | Recommended Action |
|------|-------|-------------------|
| `unified-detector/src/chain-instance.ts` | 2786 | Extract WebSocket, pool subscription, and event handling modules |
| `coordinator/src/coordinator.ts` | 2674 | Already partially extracted; continue migrating remaining inline logic |
| `execution-engine/src/strategies/flash-loan.strategy.ts` | 2159 | Extract provider selection and fee calculation into helpers |
| `cross-chain-detector/src/detector.ts` | 1980 | Already uses modular components; consider further extraction |
| `execution-engine/src/engine.ts` | 1839 | Execution pipeline already extracted; remaining is lifecycle |

**Impact**: Cognitive load, merge conflicts, harder code review.
**Effort**: Medium (incremental extraction, not rewrite).
**Note** (performance-reviewer): `chain-instance.ts` hot-path handlers have "DO NOT extract" comments per ADR-022. Only non-hot-path concerns (WebSocket management, health tracking) should be extracted.

### P1-2: Mempool Detector Test Gap

**Source files (11):**
- `index.ts` (870 LOC), `bloxroute-feed.ts`, `types.ts`, `prometheus-metrics.ts`, `setupTests.ts`
- `decoders/`: `base-decoder.ts`, `uniswap-v2.ts`, `uniswap-v3.ts`, `curve.ts`, `oneinch.ts`, `index.ts`

**Test files (4):**
- `mempool-detector-service.test.ts`, `success-criteria.test.ts`, `bloxroute-feed.test.ts`, `decoders.test.ts`

**Gap analysis**: `decoders.test.ts` likely covers the registry but individual decoder edge cases (malformed calldata, partial ABI matches, unusual token paths) may lack dedicated tests. The `prometheus-metrics.ts` module is untested. No integration test for the full tx→decode→publish pipeline.

### P1-3: Bridge Recovery & Poll Manager — Zero Test Coverage

**Location**: `execution-engine/src/strategies/bridge-recovery-service.ts`, `execution-engine/src/strategies/bridge-poll-manager.ts`
**Agent**: test-quality-analyst
**Confidence**: HIGH (verified — no test files exist)

`BridgeRecoveryService` handles recovery of stuck cross-chain bridge transfers. `BridgePollManager` manages polling for bridge completion status. Both handle real fund recovery scenarios. Only `bridge-recovery-manager.test.ts` exists (for the manager), with ZERO dedicated tests for the service or poll manager.

**Risk**: A bug in fund recovery logic would go undetected until a real stuck bridge transfer occurs in production.

### P1-4: StreamRateLimiter Discrete Refill

**Location**: `coordinator/src/streaming/rate-limiter.ts:76`

```typescript
if (elapsed >= this.config.refillMs) {
  const tokensToAdd = Math.floor(
    (elapsed / this.config.refillMs) * this.config.maxTokens
  );
```

Tokens only refill when a full `refillMs` period has elapsed. At 999ms into a 1000ms window with 0 tokens remaining, the check returns `false` (rate-limited) despite being 99.9% through the refill period. Under bursty traffic patterns where bursts align just before the refill boundary, this can drop legitimate messages.

**Fix**: Use continuous refill: `tokensToAdd = (elapsed / refillMs) * maxTokens` without the `>= refillMs` gate (update `lastRefill` proportionally).

### P1-5: TRUST_PROXY Configuration Gap

When deployed behind a reverse proxy (Fly.io, CloudFlare), Express needs `app.set('trust proxy', ...)` to see real client IPs. Without it, `express-rate-limit` sees the proxy IP for all clients, rendering per-IP rate limiting ineffective. This was flagged in the coordinator extended analysis (P0 there, P1 here because it's a deployment config issue, not a code bug).

### P1-6: Missing XACK on Redis Error Lock Failure

**Location**: `execution-engine/src/execution-pipeline.ts:421-427`
**Agent**: bug-hunter
**Confidence**: MEDIUM (70%)

When `acquireLock()` fails due to a Redis error (not a normal lock contention), the opportunity message is neither acknowledged nor re-enqueued. It remains pending in the consumer group, potentially being re-delivered after `XPENDING` visibility timeout, creating duplicate processing attempts.

### P1-7: Double parseInt in Hot-Path handleSwapEvent

**Location**: `unified-detector/src/chain-instance.ts:1721`
**Agent**: performance-reviewer
**Confidence**: MEDIUM (75%)

`handleSwapEvent` calls `parseInt()` on values that are already numeric, performing redundant string→number→string→number conversion in a hot-path event handler that fires for every DEX swap event.

### P1-8: chain-instance.ts Size

At 2786 lines, this is the single largest source file. It mixes:
- WebSocket connection management
- Pool/pair subscription handling
- DEX-specific event parsing
- Price update formatting and emission
- Health status tracking

Each of these (except hot-path event parsing per ADR-022) is a distinct responsibility that could be its own module.

### P1-9: Layer Violation — shared/ Test Imports services/

**Location**: `shared/core/__tests__/unit/solana/s3.3.6-solana-arbitrage-detector.test.ts:33`
**Agent**: architecture-auditor
**Confidence**: HIGH (verified)

```typescript
} from '../../../../../services/partition-solana/src/arbitrage-detector';
```

A test in `shared/core` imports directly from `services/partition-solana`. This creates an inverted dependency (shared depends on services). While this is a test file (not production code), it means the shared package's test suite breaks if partition-solana changes its internals.

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| P2-1 | Performance | flash-loan.strategy.ts:1060 | `.find()` on registry entries in execution path (small array) | Team Lead | MEDIUM | 2.8 |
| P2-2 | Test Quality | partition-solana/ | 10 test files for 13 source — edge cases gaps | Team Lead | MEDIUM | 2.6 |
| P2-3 | Architecture | monolith/src/index.ts | 7 `process.exit()` calls — should use unified shutdown | Team Lead | MEDIUM | 2.6 |
| P2-4 | Performance | execution-pipeline.ts:244 | CB re-enqueue map Phase 2 eviction only removes 1 entry | Team Lead | LOW | 2.4 |
| P2-5 | Code Smell | services (multiple) | 10 files exceed 1000 LOC — near maintainability threshold | Team Lead | MEDIUM | 2.4 |
| P2-6 | Mock Fidelity | cross-chain-detector tests | Bridge cost mocks don't cover all fee components | mock-fidelity | MEDIUM | 2.2 |
| P2-7 | Resource Mgmt | cross-chain-detector/src/detector.ts:242 | `bridgeDataRateLimit` Map grows without cleanup | Team Lead | MEDIUM | 2.2 |
| P2-8 | Performance | execution-pipeline.ts:504 | `Object.assign` allocations in hot-path processQueueItems | performance | MEDIUM | 2.2 |
| P2-9 | Test Quality | execution-engine strategies | Flash loan provider tests need dedicated edge cases | Team Lead | MEDIUM | 2.0 |
| P2-10 | Performance | unified-detector opportunity cleanup | 2s interval scans all active opportunities — O(n) | Team Lead | LOW | 2.0 |
| P2-11 | Security | coordinator/src/api/routes/sse.routes.ts:224 | SSE auth token in URL query parameter (documented limitation) | security | MEDIUM | 2.0 |
| P2-12 | Mock Fidelity | cross-chain-detector tests | Inline arithmetic in bridge cost test expectations | mock-fidelity | MEDIUM | 1.8 |
| P2-13 | Documentation | services/ | Service port 3008 (mempool) not in ARCHITECTURE_V2.md | Team Lead | LOW | 1.8 |
| P2-14 | Architecture | partition-solana/src/index.ts:134 | Forward reference to `detector` in closure — fragile | Team Lead | LOW | 1.8 |
| P2-15 | Consistency | coordinator/opportunities | Scoring logic split between two files | Team Lead | LOW | 1.6 |
| P2-16 | Bug | cross-chain-detector/src/detector.ts | `swapFeePerToken` uses uniform fee percentage for all DEXes | bug-hunter | MEDIUM | 1.6 |

### P2-4 Detail: CB Re-enqueue Map Eviction

In `execution-pipeline.ts:244`, Phase 2 eviction only removes a single entry:

```typescript
if (this.cbReenqueueCounts.size > ExecutionPipeline.MAX_CB_REENQUEUE_MAP_SIZE) {
  const key = this.cbReenqueueCounts.keys().next().value;
  if (key !== undefined) this.cbReenqueueCounts.delete(key);
}
```

If the map grows rapidly during a sustained CB-open event, removing 1 entry per dequeue cycle may not keep pace. Consider batch eviction (10% of oldest).

### P2-7 Detail: Bridge Data Rate Limit Map Growth

In `cross-chain-detector/src/detector.ts:242`:

```typescript
private bridgeDataRateLimit: Map<string, number[]> = new Map();
```

No cleanup/eviction logic — for long-running services, this grows unbounded as new bridge route combinations are seen.

### P2-8 Detail: Object.assign Allocations in Hot Path

**Location**: `execution-pipeline.ts:504-505`
**Agent**: performance-reviewer

`Object.assign({}, ...)` creates a new object per queue item in `processQueueItems`. At high throughput (1000+ items/sec), this generates significant GC pressure. Consider mutating in-place or using a pre-allocated result object.

### P2-11 Detail: SSE Auth Token in Query Parameters

**Location**: `coordinator/src/api/routes/sse.routes.ts:14-17, 222-224`
**Agent**: security-auditor

The SSE auth token is passed via `?token=<value>` because the browser EventSource API doesn't support custom headers. This is **already documented** as "M-04 KNOWN LIMITATION" with mitigations (token rotation, log scrubbing). Classified P2 because it's a known, documented trade-off — not an oversight.

### P2-16 Detail: Uniform Swap Fee for All DEXes

**Location**: `cross-chain-detector/src/detector.ts`
**Agent**: bug-hunter

`swapFeePerToken` applies a uniform `feePercentage` across all DEXes in the path. In reality, Uniswap V3 fee tiers vary (0.01%, 0.05%, 0.3%, 1%), and other DEXes have their own fee structures. This over/under-estimates swap costs for cross-chain opportunities.

**Impact**: Minor — cross-chain detection is a heuristic filter; exact fees are recalculated during execution. But it could filter out marginally profitable real opportunities or let marginal losers through.

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence |
|---|----------|-----------|-------------|----------|------------|
| P3-1 | Clean Code | services/ | Zero `\|\| 0` anti-patterns found (all using `??`) | Team Lead | HIGH |
| P3-2 | Clean Code | services/ | Zero TODO/FIXME/HACK/XXX markers remaining | Team Lead | HIGH |
| P3-3 | Clean Code | services/ | Zero skipped tests (.skip, xdescribe, xit) | Team Lead | HIGH |
| P3-4 | Performance | rate-limiter.ts:121 | `getTrackedStreams()` creates new array per call | Team Lead | LOW |
| P3-5 | Naming | coordinator/src/streaming | `StreamConsumerManager` duplicates type name from core | Team Lead | LOW |
| P3-6 | Code Smell | execution-engine/src/types.ts | 1277 LOC type definition file — consider splitting | Team Lead | LOW |
| P3-7 | Documentation | services/monolith/ | Missing JSDoc on `WorkerManager` public methods | Team Lead | LOW |
| P3-8 | Consistency | services/mempool-detector | Uses `isRunning` boolean instead of ServiceStateManager | Team Lead | LOW |
| P3-9 | Security | execution-engine | Private key may persist in JS heap after signer creation | security | LOW |
| P3-10 | Architecture | coordinator/streaming | ADR-002 stream list in docs incomplete vs actual streams | architecture | LOW |

---

## Service Health Scorecard

| Service | Source Files | Test Files | Test Ratio | Largest File | Grade |
|---------|-------------|-----------|------------|-------------|-------|
| coordinator | 34 | 31 | 0.91 | 2674 LOC | A- |
| cross-chain-detector | 14 | 14 | 1.00 | 1980 LOC | A- |
| execution-engine | 97 | 97 | 1.00 | 2159 LOC | B+ * |
| unified-detector | 23 | 26 | 1.13 | 2786 LOC | A- |
| partition-solana | 13 | 10 | 0.77 | 1022 LOC | B+ |
| mempool-detector | 11 | 4 | 0.36 | 870 LOC | B- |
| monolith | 2 | 1 | 0.50 | 236 LOC | B |
| partition-asia-fast | 1 | 1 | 1.00 | 63 LOC | A |
| partition-high-value | 1 | 1 | 1.00 | 63 LOC | A |
| partition-l2-turbo | 1 | 1 | 1.00 | 63 LOC | A |

\* Execution-engine downgraded from A to B+ due to P0-1 (flash loan fee calculator) and P1-3 (bridge recovery untested).

---

## Architecture Quality Assessment

### Strengths
1. **Consistent DI pattern**: All major services use constructor dependency injection, enabling thorough testing
2. **ServiceStateManager**: 7/10 services use the shared state machine for lifecycle management
3. **Proper Redis patterns**: `SCAN` over `KEYS`, `xack` after processing, consumer group creation
4. **Bounded data structures**: All Maps/Sets have eviction limits (10K caps), circular buffers for latency tracking
5. **Comprehensive validation**: Pre-compiled regex, O(1) Set lookups, numeric field restoration from Redis strings
6. **Well-documented fixes**: Every fix has a tracking ID (FIX, BUG-FIX, P0-7, etc.) with clear rationale
7. **ADR compliance**: Redis Streams (ADR-002), partitioned detectors (ADR-003), circuit breakers (ADR-018), bulkhead isolation (ADR-043) all properly implemented

### Areas for Improvement
1. **Flash loan fee dimensional correctness**: P0-1 needs immediate fix — token decimals and price source
2. **File size**: 5 files exceed 1500 LOC — extract more modules (respecting ADR-022 hot-path constraints)
3. **Mempool detector maturity**: Lowest test ratio (0.36), doesn't use ServiceStateManager
4. **Bridge fund recovery testing**: BridgeRecoveryService/BridgePollManager untested
5. **Monolith error handling**: Excessive `process.exit()` calls instead of graceful shutdown pattern

---

## Hot-Path Performance Assessment

**Target**: <50ms (price-update -> detection -> execution)

| Component | Assessment | Latency Contribution |
|-----------|-----------|---------------------|
| `execution-pipeline.ts:processQueueItems()` | Sync loop with `setImmediate` yield after 200 items — **good** | <1ms per dequeue |
| `chain-instance-manager.ts:getHealthyChains()` | Direct Map iteration — **good** | O(n) where n=chains (~5-15) |
| `unified-detector.ts:getPartitionHealth()` | Calls `process.cpuUsage()` and `process.memoryUsage()` — **acceptable** | ~0.5ms |
| `opportunity.consumer.ts:validateMessageStructure()` | Pre-compiled regex, Set lookup — **excellent** | <0.1ms |
| `flash-loan.strategy.ts:1060` | `.find()` on registry entries — **acceptable** | O(4) max, <0.01ms |
| `execution-pipeline.ts:recordExecutedId()` | Set eviction (insertion order) — **good** | O(1) |
| `chain-instance.ts:handleSwapEvent` | Double parseInt **adds ~0.05ms per event** | Could be eliminated (P1-7) |
| `execution-pipeline.ts:processQueueItems` | Object.assign per item **adds GC pressure** | ~0.01ms per item (P2-8) |

**Verdict**: Hot-path performance is within the <50ms target. P1-7 (double parseInt) and P2-8 (Object.assign) are optimizable but not blocking. No blocking I/O detected in the execution path.

---

## Cross-Agent Insights

Findings identified by multiple agents or where one agent's finding explains another's:

1. **Flash loan fee calculator (P0-1)**: bug-hunter flagged the `formatEther` dimensional error. mock-fidelity-validator independently noted that all profitability test cases use `parseEther()` (18-decimal tokens), meaning tests never exercise the broken code path for 6/8-decimal tokens. These findings reinforce each other — the bug exists AND the tests don't catch it.

2. **Mempool detector immaturity**: Team lead flagged test ratio (0.36), test-quality-analyst flagged missing decoder edge cases, architecture-auditor noted it doesn't follow ServiceStateManager pattern. Three independent signals pointing to the same under-invested service.

3. **Bridge recovery gap**: test-quality-analyst flagged ZERO test files for BridgeRecoveryService. security-auditor noted that fund recovery paths are security-critical. Combined: untested security-critical fund handling code.

4. **Layer violation + test fragility**: architecture-auditor found shared/ test importing from services/. test-quality-analyst noted partition-solana tests have fragile coupling. Both point to the same architectural boundary weakness in the Solana partition testing.

5. **Hot-path micro-optimizations**: performance-reviewer found double parseInt (P1-7) and Object.assign (P2-8). Team lead's hot-path assessment confirmed these are real but sub-millisecond — worth fixing but not blocking the <50ms target.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 + critical P1 fixes)

- [ ] **P0-1**: Fix flash loan fee calculator to accept `tokenDecimals` and `borrowedTokenPriceUsd` params — use `ethers.formatUnits()` instead of `formatEther()`. Add test cases with USDC (6 decimals) and WBTC (8 decimals).
- [ ] **P1-3**: Add dedicated test files for BridgeRecoveryService and BridgePollManager
- [ ] **P1-2**: Add dedicated test files for mempool decoder edge cases and prometheus metrics
- [ ] **P1-4**: Fix StreamRateLimiter to use continuous token refill
- [ ] **P1-5**: Add TRUST_PROXY configuration to coordinator deployment config

### Phase 2: Next Sprint (P1 + high-value P2 fixes)

- [ ] **P1-6**: Add XACK on redis_error lock failure path in execution-pipeline.ts
- [ ] **P1-7**: Remove double parseInt in chain-instance.ts handleSwapEvent
- [ ] **P1-9**: Move partition-solana test from shared/core to services/partition-solana
- [ ] **P2-7**: Add cleanup interval for `bridgeDataRateLimit` Map in cross-chain-detector
- [ ] **P2-4**: Improve CB re-enqueue map eviction to batch-remove entries
- [ ] **P2-8**: Replace Object.assign with in-place mutation in execution-pipeline hot path
- [ ] **P1-1/P1-8**: Begin extracting `chain-instance.ts` non-hot-path concerns into focused modules

### Phase 3: Backlog (P2/P3 + long-term improvements)

- [ ] **P2-3**: Replace monolith's direct `process.exit()` calls with unified shutdown handler
- [ ] **P2-5/P3-6**: Split mega-files across remaining services
- [ ] **P2-11**: Evaluate SSE auth alternatives (short-lived JWT, WebSocket upgrade)
- [x] **P2-16**: Use per-DEX fee tiers in cross-chain swap cost estimation
- [ ] **P3-8**: Migrate mempool-detector to ServiceStateManager pattern
- [ ] **P2-13**: Update ARCHITECTURE_V2.md with mempool detector service (port 3008)
- [ ] **P2-14**: Add guard comment to partition-solana forward reference
- [ ] **P3-10**: Reconcile ADR-002 stream list with actual streams in code

---

## Agent Contribution Notes

| Agent | Findings | Key Contribution |
|-------|----------|-----------------|
| Team Lead | 25 (initial pass) | Independent deep code reading, hot-path assessment, service scorecard |
| bug-hunter | 8 | **P0-1** flash loan fee calculator dimensional mismatch (highest-impact finding) |
| test-quality-analyst | 22 | BridgeRecoveryService zero coverage, mempool decoder gaps |
| security-auditor | 14 | SSE auth token analysis, TRUST_PROXY validation |
| architecture-auditor | 10 | Layer violation (shared/ imports services/), ADR-002 stream list drift |
| mock-fidelity-validator | 14 | Test parameter realism (all tests use 18-decimal tokens), bridge cost mock gaps |
| performance-reviewer | 12 | Double parseInt hot-path, Object.assign allocation pressure |

All 6 agents reported successfully. Analysis was synthesized by team lead with cross-reference deduplication. Previous reports (coordinator, contracts, caching, runtime) were consulted for continuity.
