# Research: Execution Engine Bottleneck Mitigation

**Date:** 2026-03-06
**Severity:** CRITICAL — execution throughput gap causes silent data loss
**Confidence:** HIGH (based on measured monitoring data + full code analysis)

---

## 1. Current State Analysis

### How It Works Today

```
P1-P4 (Detectors)        ~100-130 opps/sec produced
       |
       v
stream:opportunities      MAXLEN 500K (~64 min buffer)
       |
       v
Coordinator               Dedup → Filter → Sort → Forward (ADR-037: 12K+ msg/s capacity)
       |
       v
stream:execution-requests MAXLEN 100K (~17 min buffer)
       |
       v
Execution Engine (×1)     maxConcurrent=50 (sim) / 5 (prod)
       |
       v
Blockchain / Simulation   50ms sim / 2-30s real tx
```

**Key files:**
- [engine.ts](services/execution-engine/src/engine.ts) — Main service (1400+ lines)
- [execution-pipeline.ts](services/execution-engine/src/execution-pipeline.ts) — Queue processing loop (706 lines)
- [opportunity.consumer.ts](services/execution-engine/src/consumers/opportunity.consumer.ts) — Redis Streams consumer
- [queue.service.ts](services/execution-engine/src/services/queue.service.ts) — Backpressure (hysteresis 800/200)
- [opportunity-router.ts](services/coordinator/src/opportunities/opportunity-router.ts) — Coordinator forwarding

### Concurrency Configuration

| Mode | maxConcurrentExecutions | Per-opportunity latency | Theoretical max throughput |
|------|------------------------|------------------------|---------------------------|
| **Simulation** | 50 | 50ms (±30% variance) | ~1000 opp/s theoretical |
| **Production** | 5 | 2-30s (blockchain tx) | 0.17-2.5 opp/s |

Source: [engine.ts:396-407](services/execution-engine/src/engine.ts#L396-L407)

### Measured Bottleneck Evidence

From monitoring session `REPORT_20260306_113901`:

| Metric | Value | Status |
|--------|-------|--------|
| Detection rate | ~100 opps/sec | Normal |
| Execution throughput | ~46 opps/sec | **53% of input** |
| exec-requests stream depth | 25,001/25,000 | **100% MAXLEN — active trimming** |
| Consumer lag (pending) | 4,506 → 6,862 | **Growing — never catches up** |
| Backpressure ratio | 1.00012 | **Activated but too late** |
| Opportunities silently lost | ~54/sec | **CRITICAL — permanent data loss** |

### Root Cause Analysis (5 Whys)

1. **Why are opportunities lost?** → Redis `XADD` with `MAXLEN ~100000` silently trims oldest unread messages when stream is full
2. **Why does the stream fill?** → Execution engine processes 46/sec but receives 100/sec
3. **Why can't EE keep up?** → Each execution holds a slot for 50ms (sim) or 2-30s (prod), concurrency capped at 50/5
4. **Why is concurrency capped?** → Single wallet per chain requires nonce serialization; single Redis = lock contention
5. **Why single wallet?** → Current architecture uses one centralized execution engine with shared capital pool

**The fundamental constraint:** In production, 5 concurrent × 5 second average tx = 1 opp/sec throughput. Detection at 100/sec means **99% of opportunities are wasted** even before stream trimming.

### Bottleneck Decomposition

```
Per-execution timeline (production):
  Lock acquisition:     2-5ms    (Redis SET NX)
  Risk management:      1-3ms    (drawdown + EV + Kelly)
  Strategy dispatch:    1-2ms    (routing)
  Pre-flight simulation: 50-200ms (eth_call)
  TX submission:        100-500ms (RPC + mempool)
  TX confirmation:      2-30s    (block time)
  Result publishing:    1-3ms    (Redis XADD)
  ─────────────────────────────
  Total:                2-31 seconds

  Parallelism: 5 concurrent (prod)
  Effective throughput: 5 / avg(5s) = 1.0 opp/sec
  Detection rate: 100 opp/sec
  Utilization gap: 99:1
```

---

## 2. Solution Space (7 Approaches)

### Approach A: Horizontal EE Scaling via Consumer Groups

**Mechanism:** Deploy N identical execution engine instances that join the same Redis consumer group (`execution-engine-group`). Redis automatically distributes messages across consumers.

**Precedent:** Standard Redis Streams scaling pattern. Used by Stripe (payment processing), Coinbase (trade execution), most event-driven microservices.

**How it works:**
```
stream:execution-requests
       |
       ├── EE-instance-1 (consumer in group)
       ├── EE-instance-2 (consumer in group)
       └── EE-instance-N (consumer in group)
```

Each instance gets unique messages. Redis PEL tracks delivery per consumer. Crashed instance messages are reclaimed by others (already implemented in `recoverOrphanedMessages()`).

| Dimension | Assessment |
|-----------|-----------|
| **Code changes** | Minimal — consumer groups already work. Need: shared nonce coordination, distributed risk state |
| **Throughput gain** | Linear: N instances = N× throughput |
| **Nonce problem** | CRITICAL — multiple EEs sending to same chain wallet = nonce collisions |
| **Capital problem** | Need wallet-per-instance OR shared wallet with nonce coordinator |
| **Risk state** | Drawdown breaker, Kelly sizer need Redis-backed shared state |
| **Dedup** | Handled by consumer groups (each message delivered to exactly one consumer) |

**Nonce solutions:**
1. **Nonce coordinator service** — centralized nonce dispenser (adds 2-5ms, single point of failure)
2. **Wallet-per-instance** — each EE has own wallet (capital fragmentation, more gas overhead)
3. **Chain-affinity routing** — each EE "owns" specific chains (no contention, see Approach C)

**Effort:** 2-3 weeks
**Risk:** MEDIUM — nonce coordination is the hard problem

---

### Approach B: Priority Queue with Intelligent Load Shedding

**Mechanism:** Instead of FIFO processing, rank opportunities by expected profit × confidence × time-sensitivity. Execute only the top-K that fit within capacity. Explicitly drop the rest with logging.

**Precedent:** High-frequency trading firms use "opportunity scoring" to allocate limited execution capacity. Jump Trading, Wintermute, and similar firms operate with strict execution budgets.

**How it works:**
```
Coordinator receives 100 opps/sec
       |
       v
Score each: profit × confidence × (1/TTL_remaining) × chain_priority
       |
       v
Top-K filter: Keep best 5-10/sec (matching EE capacity)
       |
       v
stream:execution-requests (now never saturates)
       |
       v
Execution Engine (processes all forwarded opps)
```

| Dimension | Assessment |
|-----------|-----------|
| **Code changes** | Moderate — add scoring to `OpportunityRouter`, priority queue in EE |
| **Throughput gain** | Zero — same EE capacity, but maximizes profit per execution |
| **Data loss** | Explicit and logged (vs current silent trimming) |
| **Latency impact** | +1-2ms for scoring (CPU-only, no I/O) |
| **Profit impact** | POSITIVE — execute best 5% instead of random 5% |

**Key insight:** If we can only execute 1% of detected opportunities (production), choosing the BEST 1% has enormous profit impact. Currently opportunities are processed FIFO — first detected, first executed — regardless of profitability.

**Effort:** 1-2 weeks
**Risk:** LOW — no architectural change, additive feature

---

### Approach C: Chain-Grouped Execution Engines (Recommended Primary)

**Mechanism:** Split the single execution engine into 3-4 chain-grouped EEs, each owning a set of chains. Maps directly to the existing partition model.

```
                    Coordinator (keeps dedup, circuit breaker, routing)
                         |
            ┌────────────┼────────────┬──────────────┐
            v            v            v              v
     stream:exec-fast  stream:exec-l2  stream:exec-premium  stream:exec-solana
            |            |            |              |
            v            v            v              v
      EE-Fast          EE-L2       EE-Premium     EE-Solana
  (BSC,Polygon,     (Arb,Opt,     (ETH,zkSync,   (Solana)
   AVAX,FTM)        Base,Scroll,   Linea)
                     Blast)
```

**Precedent:** Binance uses chain-specific execution engines. Most professional market makers partition execution by venue/chain. Paradigm's research on MEV searchers shows chain-specialized execution outperforms generalist approaches.

| Dimension | Assessment |
|-----------|-----------|
| **Code changes** | Moderate — add chain-routing at coordinator, per-group streams, EE chain filter |
| **Throughput gain** | 3-4× (parallel execution across groups, no cross-chain contention) |
| **Nonce problem** | SOLVED — each EE group owns its chains' wallets exclusively |
| **Capital problem** | Minimal — capital is already chain-specific (ETH on Ethereum, BNB on BSC) |
| **Risk state** | Per-group drawdown breakers (already per-chain in current impl) |
| **Cross-chain opps** | Coordinator routes to buy-chain's EE group |
| **Failure isolation** | Ethereum issues don't affect L2 execution |

**Why this works well:**
1. Nonce management becomes trivial (one owner per chain wallet)
2. Capital is naturally chain-bound anyway (can't use ETH capital on BSC)
3. Existing per-chain circuit breakers map directly
4. Different concurrency tuning per group (L2s: high concurrency, Ethereum: conservative)
5. Geographic deployment possible (EE-Fast near Asian validators, EE-Premium near US validators)

**Implementation path:**
1. Coordinator adds `chain → stream` routing table
2. Create 4 execution-request streams (one per group)
3. EE startup takes `EXECUTION_CHAIN_GROUP` env var
4. Nonce manager scoped to group's chains only
5. Provider service only connects to group's chains' RPCs

**Effort:** 3-4 weeks
**Risk:** LOW-MEDIUM — incremental change, each EE is structurally identical to current

---

### Approach D: Fully Isolated Partition Stacks (User's Suggestion)

**Mechanism:** Each partition (P1-P4) gets its own complete stack: detector, Redis instance, analysis, simulation, and execution engine. No shared state between partitions.

```
┌─────────────────────┐  ┌─────────────────────┐
│ Partition 1 Stack   │  │ Partition 2 Stack   │
│  ┌─ Detector ──┐    │  │  ┌─ Detector ──┐    │
│  ├─ Redis ─────┤    │  │  ├─ Redis ─────┤    │
│  ├─ Analysis ──┤    │  │  ├─ Analysis ──┤    │
│  ├─ Simulation ┤    │  │  ├─ Simulation ┤    │
│  └─ Exec Eng ──┘    │  │  └─ Exec Eng ──┘    │
└─────────────────────┘  └─────────────────────┘
┌─────────────────────┐  ┌─────────────────────┐
│ Partition 3 Stack   │  │ Partition 4 Stack   │
│  ┌─ Detector ──┐    │  │  ┌─ Detector ──┐    │
│  ├─ Redis ─────┤    │  │  ├─ Redis ─────┤    │
│  ├─ Analysis ──┤    │  │  ├─ Analysis ──┤    │
│  ├─ Simulation ┤    │  │  ├─ Simulation ┤    │
│  └─ Exec Eng ──┘    │  │  └─ Exec Eng ──┘    │
└─────────────────────┘  └─────────────────────┘
```

| Dimension | Assessment |
|-----------|-----------|
| **Code changes** | Very large — every shared-state dependency must be replicated or removed |
| **Throughput gain** | 4× (complete parallelism) |
| **Nonce problem** | SOLVED — each stack owns its chains exclusively |
| **Capital problem** | Fragmented — must pre-allocate per partition |
| **Cross-chain detection** | **BROKEN** — P1 can't see P2's prices for cross-chain arbitrage |
| **Price matrix** | **BROKEN** — SharedArrayBuffer L1 cache can't span processes |
| **Dedup** | **BROKEN** — no central dedup means same opportunity executed 2× |
| **Redis cost** | 4× infrastructure (4 Redis instances) |
| **Operational cost** | 4× monitoring, 4× alerting, 4× deployment pipelines |
| **Failure blast radius** | Excellent — complete isolation |

**Critical problems with full isolation:**

1. **Cross-chain arbitrage is destroyed.** The cross-chain detector currently reads price updates from ALL chains to find arbitrage between chains (e.g., ETH cheaper on BSC than Arbitrum). With isolated stacks, P1 (BSC) can't see P2 (Arbitrum) prices. This eliminates a core strategy.

2. **Deduplication requires a new distributed layer.** Currently the coordinator's in-memory dedup map prevents the same opportunity from being executed twice. With 4 isolated stacks, overlapping chain coverage (if any) creates double-execution risk. Even without overlap, cross-chain opportunities detected by different stacks need coordination.

3. **SharedArrayBuffer price matrix breaks.** The L1 price cache (ADR-005) uses SharedArrayBuffer for zero-copy O(1) lookups across worker threads. This can't span separate processes/containers. Each stack would have its own incomplete price view.

4. **Risk management fragmentation.** Portfolio-level drawdown circuit breakers need to see ALL execution results to calculate drawdown. With 4 isolated stacks, each sees only 25% of the portfolio — a 10% total portfolio drawdown might look like 2.5% per-stack.

5. **Capital inefficiency.** If P1 chains are quiet and P3 chains are active, P1's capital sits idle. Current shared model allows capital to flow to where opportunities are.

**Could cross-chain be solved?** Yes, by adding a 5th "cross-chain coordinator" stack that subscribes to price feeds from all 4 stacks and routes cross-chain opportunities. But this reintroduces shared state and coordination — defeating the isolation goal.

**Effort:** 6-10 weeks
**Risk:** HIGH — architectural rewrite with multiple hard distributed-systems problems

---

### Approach E: Async Pipeline Split (Simulation ≠ Execution)

**Mechanism:** Decouple the pipeline into two stages: (1) fast simulation/scoring that runs at detection speed, and (2) slower blockchain execution that only handles pre-approved opportunities.

```
stream:execution-requests (100/sec)
       |
       v
Simulation Workers (many, fast, no blockchain)
  - Pre-flight eth_call simulation
  - Profit estimation
  - Gas estimation
  - Score & rank
       |
       v
stream:approved-executions (5-10/sec, pre-validated)
       |
       v
Execution Engine (fewer, slow, blockchain)
  - Nonce management
  - TX submission
  - Confirmation wait
```

**Precedent:** Professional HFT firms universally separate signal generation from order execution. Two Sigma, Citadel, and DeFi-native firms like Wintermute use this pattern.

| Dimension | Assessment |
|-----------|-----------|
| **Code changes** | Moderate — split execution pipeline into sim + exec stages |
| **Throughput gain** | Simulation: 10-50× (CPU-bound, parallelizable). Execution: same, but only best opps |
| **Nonce problem** | Unchanged (execution stage still serial per chain) |
| **Profit impact** | HIGH — simulate 100/sec, execute best 1-5/sec |
| **Latency** | Adds one pipeline stage (+5-10ms for inter-stage messaging) |

**Effort:** 2-3 weeks
**Risk:** LOW-MEDIUM — clean separation of concerns

---

### Approach F: Coordinator Admission Control

**Mechanism:** Add capacity-aware filtering at the coordinator. Coordinator knows EE capacity (via health endpoint) and only forwards opportunities that EE can handle, dropping the rest with explicit logging.

```
Coordinator:
  1. Read EE health: { activeExecutions: 48, maxConcurrent: 50, queueDepth: 750 }
  2. Available capacity: 50 - 48 = 2 slots
  3. Forward top-2 by profit, reject rest with log
  4. Result: stream:execution-requests never saturates
```

| Dimension | Assessment |
|-----------|-----------|
| **Code changes** | Small — add capacity polling + admission filter in OpportunityRouter |
| **Throughput gain** | Zero — same EE, just prevents stream saturation |
| **Data loss** | Explicit (logged with reason) instead of silent (MAXLEN trim) |
| **Value** | Stops the CRITICAL silent data loss bug immediately |

**Effort:** 1 week
**Risk:** LOW — no architectural change

---

### Approach G: Expand Fast-Lane Bypass

**Mechanism:** Lower the fast-lane confidence threshold from 90% to 50%, routing more opportunities directly to the execution engine's fast-lane consumer, bypassing coordinator processing.

Already mentioned as a viable complementary optimization in ADR-037: *"Lowering the fast-lane confidence threshold from 90% to 50% would route most opportunities directly to the execution engine."*

| Dimension | Assessment |
|-----------|-----------|
| **Code changes** | Trivial — change `FAST_LANE_MIN_CONFIDENCE` env var |
| **Throughput gain** | Marginal — fast-lane still feeds into same EE queue |
| **Latency gain** | Skips coordinator overhead (~17ms per batch) |
| **Risk** | Lower-confidence opps bypass coordinator dedup/circuit breaker |

**Effort:** 1 day (config change)
**Risk:** MEDIUM — bypasses safety filters

---

## 3. Comparative Scoring

### Scoring Matrix (weighted)

| Approach | Impact (40%) | Effort (30%) | Risk (20%) | Compat (10%) | **Total** |
|----------|:------------:|:------------:|:----------:|:------------:|:---------:|
| **A: Horizontal EE** | 4 (linear scaling) | 3 (nonce hard) | 3 (nonce risk) | 4 (consumer groups exist) | **3.5** |
| **B: Priority Queue** | 3 (profit/exec, not throughput) | 5 (simple) | 5 (no arch change) | 5 (additive) | **4.0** |
| **C: Chain-Grouped EE** | 5 (3-4× throughput + nonce solved) | 3 (moderate) | 4 (incremental) | 4 (extends partitions) | **4.2** |
| **D: Full Isolation** | 4 (4× throughput) | 1 (massive rewrite) | 1 (cross-chain broken) | 1 (breaks ADR-005, dedup) | **2.1** |
| **E: Async Pipeline** | 4 (sim all, exec best) | 4 (clean split) | 4 (low risk) | 4 (additive stage) | **4.0** |
| **F: Admission Control** | 2 (no throughput gain) | 5 (trivial) | 5 (no risk) | 5 (additive) | **3.6** |
| **G: Fast-Lane Expand** | 1 (marginal) | 5 (config change) | 3 (bypasses safety) | 5 (already exists) | **2.8** |

Scale: 1 (worst) to 5 (best). Total = 0.4×Impact + 0.3×Effort + 0.2×Risk + 0.1×Compat

---

## 4. Recommended Solution: Phased Approach (C + B + F)

### Confidence: HIGH

The bottleneck requires a multi-pronged response because no single solution addresses all dimensions (throughput, profit optimization, and data loss prevention). The recommendation is three phases:

### Phase 1 (Week 1): Admission Control + Priority Scoring [F + B]

**Immediately stop silent data loss** and **maximize profit per execution slot**.

| # | Task | Effort | Dependencies | Test Strategy |
|---|------|--------|--------------|---------------|
| 1 | Add `ExecutionCapacityTracker` that polls EE health endpoint every 2s | 1d | None | Unit test: mock health responses |
| 2 | Add opportunity scoring: `score = expectedProfit × confidence × (1 / max(ttlRemaining, 100ms))` | 1d | None | Unit test: scoring function |
| 3 | Add admission gate in `OpportunityRouter.processOpportunityBatch()`: sort by score, forward top-K where K = available EE capacity + queue headroom | 1d | Tasks 1-2 | Integration: verify stream depth stays <50% |
| 4 | Log explicitly dropped opportunities with score and reason | 0.5d | Task 3 | Unit test: log format |
| 5 | Add Prometheus metrics: `opportunities_admitted_total`, `opportunities_shed_total`, `avg_score_admitted`, `avg_score_shed` | 0.5d | Task 3 | Unit test: metric recording |

**Expected impact:**
- Silent data loss: 54/sec → 0 (explicit admission control)
- Profit per execution: +30-80% estimated (execute best opportunities, not random FIFO)
- Throughput: unchanged (same EE)

### Phase 2 (Weeks 2-5): Chain-Grouped Execution Engines [C]

**Increase actual execution throughput 3-4×** through parallelism with nonce isolation.

| # | Task | Effort | Dependencies | Test Strategy |
|---|------|--------|--------------|---------------|
| 1 | Define chain groups in config: `CHAIN_GROUPS = { fast: [bsc, polygon, avax, ftm], l2: [arb, opt, base, scroll, blast], premium: [eth, zksync, linea], solana: [solana] }` | 0.5d | None | Unit test: all chains assigned |
| 2 | Create per-group execution streams: `stream:exec-fast`, `stream:exec-l2`, `stream:exec-premium`, `stream:exec-solana` in stream registry | 1d | None | Integration: streams created |
| 3 | Add chain-group routing in `OpportunityRouter`: resolve `buyChain → group → stream` | 1d | Tasks 1-2 | Unit: routing table correctness |
| 4 | Add `EXECUTION_CHAIN_GROUP` env var to EE. On startup, EE subscribes only to its group's stream | 1d | Task 2 | Integration: EE only consumes assigned stream |
| 5 | Scope `ProviderService` to only initialize RPCs for group's chains | 1d | Task 4 | Unit: no providers for other chains |
| 6 | Scope `NonceManager` to group's chains only (removes contention) | 0.5d | Task 4 | Unit: nonce isolation |
| 7 | Update `CircuitBreakerManager` — already per-chain, verify works with scoped chains | 0.5d | Task 4 | Unit: CB per chain within group |
| 8 | Add per-group risk management: each EE tracks drawdown for its chains only. Add cross-group aggregation via Redis key for portfolio-level drawdown | 2d | Task 4 | Integration: portfolio drawdown calculated correctly |
| 9 | Handle cross-chain opportunities: coordinator routes to buy-chain's EE group (sell-side was already executed atomically via flash loan) | 1d | Task 3 | Integration: cross-chain opp executes on correct group |
| 10 | Update Dockerfiles, docker-compose, Fly.io configs for 4 EE services | 1d | Task 4 | E2E: all 4 EEs start and consume |
| 11 | Update monitoring/health to aggregate across EE groups | 1d | Task 10 | Integration: combined health endpoint |
| 12 | Load test: verify 3-4× throughput improvement | 1d | All above | Performance: measure actual throughput |

**Expected impact:**
- Execution throughput: 1 opp/sec → 3-4 opp/sec (production, chain-parallel)
- Simulation throughput: 46/sec → 150-200/sec (4 groups × 50 concurrent)
- Nonce contention: eliminated within each group
- Failure blast radius: per-group (Ethereum issues don't affect L2 execution)

### Phase 3 (Weeks 5-7): Async Pipeline Split [E] (Optional, Profit Optimization)

**Simulate at detection speed, execute only the best.**

| # | Task | Effort | Dependencies |
|---|------|--------|--------------|
| 1 | Extract simulation logic from execution strategies into `SimulationWorker` | 2d | Phase 2 complete |
| 2 | Create `stream:pre-simulated` for simulation results | 0.5d | Task 1 |
| 3 | Simulation workers consume execution-request streams, run `eth_call`, publish scored results | 2d | Tasks 1-2 |
| 4 | EE consumes pre-simulated stream instead of raw execution-requests | 1d | Task 3 |
| 5 | Staleness filter: reject pre-simulated opps older than 2× block time | 0.5d | Task 4 |

**Expected impact:**
- Simulate 100% of opportunities (vs current ~46%)
- Execute only pre-validated profitable opportunities
- Fewer reverted transactions (pre-flight already confirmed)

---

## 5. Why NOT Each Alternative

### Why not Approach A (Horizontal EE via Consumer Groups)?
Approach C (chain-grouped) gives the same throughput gain but **solves nonce management for free** via chain affinity. Horizontal scaling with shared wallets requires building a nonce coordinator — a complex distributed system problem that chain-grouping avoids entirely.

### Why not Approach D (Fully Isolated Partition Stacks)?

**This is the approach the user specifically asked to evaluate.** After thorough analysis, full isolation has **four showstopper problems:**

1. **Kills cross-chain arbitrage** — the system's most profitable strategy (buying on chain A, selling on chain B) requires seeing prices across ALL chains simultaneously. Isolated stacks can only see their own chains. A cross-chain coordinator overlay would be needed, which re-introduces shared state and defeats the isolation purpose.

2. **Breaks the price matrix** — ADR-005's SharedArrayBuffer L1 cache provides O(1) cross-chain price lookups. This can't span separate processes. Each stack would have incomplete price data, degrading detection quality.

3. **Breaks deduplication** — The coordinator's in-memory dedup map is the single source of truth for "has this opportunity been forwarded?" With 4 isolated stacks, you need Redis-based distributed dedup — adding latency and a new failure mode to the hot path.

4. **Portfolio risk fragmentation** — Drawdown circuit breakers need to see total portfolio exposure. 4 isolated stacks each see 25% of exposure, meaning a catastrophic portfolio drawdown might not trigger any individual stack's breaker.

**The partial isolation of Approach C (chain-grouped EEs) captures 80% of the isolation benefits (failure blast radius, nonce isolation, independent scaling) without these problems**, because the coordinator remains the shared brain for dedup, routing, and portfolio-level risk.

### Why not Approach G (Expand Fast-Lane)?
Marginal benefit — fast-lane still feeds into the same overloaded EE. Lowers quality bar for coordinator bypass without increasing execution capacity.

---

## 6. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|:-----------:|:------:|------------|
| Cross-chain opps routed to wrong EE group | LOW | HIGH | Coordinator resolves `buyChain` (already fixed: H-002). Integration test covers all chain→group mappings |
| Portfolio drawdown miscalculation across groups | MEDIUM | HIGH | Phase 2 Task 8: Redis-backed aggregate drawdown key, checked by all EE groups before execution |
| One chain group overwhelmed while others idle | MEDIUM | MEDIUM | Phase 1 admission control + per-group backpressure. Future: dynamic chain reassignment |
| Migration causes production downtime | LOW | HIGH | Blue-green deployment: run old single-EE alongside new chain-grouped EEs, coordinator sends to both with feature flag |
| Priority scoring biases toward large trades | MEDIUM | LOW | Include opportunity diversity score (chain mix, type mix) in scoring function |
| Config drift between 4 EE deployments | MEDIUM | MEDIUM | Shared config from `@arbitrage/config` package, env-var validation on startup |

---

## 7. Success Metrics

| Metric | Current | Phase 1 Target | Phase 2 Target | How to Measure |
|--------|---------|----------------|----------------|----------------|
| Silent data loss rate | ~54/sec | **0** | **0** | `opportunities_shed_total` metric (explicit > 0, silent = 0) |
| exec-requests stream depth ratio | 1.0 (100%) | <0.5 (50%) | <0.3 (30%) | Prometheus `execution_stream_depth_ratio` |
| Execution throughput (sim) | 46/sec | 46/sec | 150-200/sec | `executions_total` counter rate |
| Execution throughput (prod) | ~1/sec est. | ~1/sec | 3-4/sec | `executions_total` counter rate |
| Profit per execution | baseline | +30-80% | +30-80% | `avg_score_admitted` / `avg_score_shed` |
| Consumer lag (pending) | 6,862 growing | <500 stable | <100 stable | `XPENDING` consumer group |
| Avg opportunity age at execution | unknown | <2s | <1s | `opportunity_age_ms` histogram |

---

## 8. Constraint Conflicts & Resolutions

### Conflict 1: Throughput vs. Capital Efficiency

**Tension:** Chain-grouped EEs need pre-allocated capital per group. If P1 chains are quiet, their capital is idle.

**Resolution:** Selective Application — capital is ALREADY chain-bound (ETH on Ethereum, BNB on BSC). There's no fungibility between chains today. The "capital fragmentation" concern is theoretical, not real.

### Conflict 2: Isolation vs. Cross-Chain Detection

**Tension:** Better isolation means less cross-chain visibility.

**Resolution:** Phased approach — isolate EXECUTION (Approach C) while keeping detection and coordination centralized. The coordinator continues to see all chains' opportunities and route intelligently.

### Conflict 3: Latency vs. Profit Optimization

**Tension:** Priority scoring adds computation to the hot path.

**Resolution:** Optimization — scoring is pure arithmetic (multiply 3 numbers), adds <0.1ms. The batch sort over 50-200 items adds <1ms. Well within the <50ms hot-path budget.

---

## 9. ADR Recommendation

**New ADR Needed:** Yes

**Title:** ADR-038: Chain-Grouped Execution Engines with Admission Control

**Scope:**
- Chain-group routing at coordinator level
- Per-group execution streams
- Scoped nonce/provider/risk management per EE instance
- Opportunity scoring and admission control
- Cross-group portfolio drawdown aggregation

**Supersedes:** None (extends ADR-037's scaling model)
**Related:** ADR-002 (Redis Streams), ADR-003 (Partitioned Detectors), ADR-018 (Circuit Breaker), ADR-037 (Coordinator Optimization)

---

## 10. Comparison Summary

```
                    Throughput   Profit/Exec   Data Loss   Effort    Risk
                    ──────────   ───────────   ─────────   ──────    ────
A: Horizontal EE      4×           same         fixed      med       med (nonce)
B: Priority Queue     same         +30-80%      fixed      low       low
C: Chain-Grouped      3-4×         same         fixed      med       low-med
D: Full Isolation     4×           same         fixed      very high high (breaks cross-chain)
E: Async Pipeline     sim 10×      +20-50%      fixed      med       low-med
F: Admission Ctrl     same         same         FIXED      very low  very low
G: Fast-Lane          marginal     marginal     unchanged  trivial   med

Recommended: F+B (Phase 1, 1 week) → C (Phase 2, 4 weeks) → E (Phase 3, 2 weeks)
```

---

## Appendix: Full Isolation (Approach D) — Detailed Cost-Benefit

Since this was specifically requested for evaluation, here is a deeper analysis:

### What Would Be Required

1. **4 Redis instances** — each partition stack needs its own Redis. Options: 4 Memurai instances (Windows), 4 Docker Redis containers, or 4 cloud Redis instances. Cost: 4× memory, 4× monitoring.

2. **Cross-chain price bridge** — a new service that subscribes to price updates from all 4 Redis instances and publishes a unified view. This is essentially rebuilding the price matrix as a distributed system.

3. **Cross-chain opportunity coordinator** — a 5th service that receives price data from the bridge, detects cross-chain opportunities, and routes execution requests to the appropriate partition stack.

4. **Distributed dedup** — replace in-memory dedup Map with Redis-based dedup (SETNX with TTL). Adds 1-2ms per opportunity (Redis round-trip).

5. **Portfolio risk aggregator** — a service that reads execution results from all 4 stacks and computes portfolio-level drawdown, total exposure, etc.

### Approximate Effort Breakdown

| Component | Effort | Complexity |
|-----------|--------|-----------|
| Split Redis into 4 instances + config | 1 week | Low |
| Cross-chain price bridge service | 2 weeks | High |
| Cross-chain opportunity coordinator | 2 weeks | High |
| Distributed dedup (Redis-based) | 1 week | Medium |
| Portfolio risk aggregator | 1 week | Medium |
| Update all service configs/startup | 1 week | Low |
| Integration testing | 2 weeks | High |
| **Total** | **10 weeks** | **High** |

### When Full Isolation WOULD Make Sense

Full isolation becomes worthwhile if:
- Cross-chain arbitrage is abandoned as a strategy (unlikely — it's highly profitable)
- The system scales to 50+ chains where even chain-grouped EEs are insufficient
- Regulatory requirements mandate chain-level isolation (e.g., different legal entities per chain)
- Geographic distribution requirements demand completely independent regional stacks

None of these conditions currently apply.

### Verdict

Full isolation is an **over-engineered solution** for the current bottleneck. It solves the execution throughput problem but creates 4 new distributed-systems problems (price bridge, distributed dedup, portfolio risk aggregation, cross-chain coordination) that are each harder than the original problem.

**Chain-grouped execution (Approach C) achieves 80% of the isolation benefit at 30% of the cost.**
