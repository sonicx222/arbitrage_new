---
description: Use when analyzing operational health of any pipeline or subsystem — latency bottlenecks, failure modes, data integrity gaps, cross-chain edge cases, observability blind spots, or configuration drift
---

# Extended Deep Analysis (Operational Focus)

**Target**: `$ARGUMENTS`

> If `$ARGUMENTS` is empty, ask the user which system area to analyze before proceeding.
> This skill complements `/deep-analysis` (code quality: architecture, bugs, security, test quality, mock fidelity, performance). Use both for comprehensive coverage.

## Model Capabilities (Opus 4.6)

You are running on Claude Opus 4.6 with full agent team capabilities:
- **Team Orchestration**: Spawn and coordinate 6 specialized agents working in parallel
- **Parallel Tool Use**: Launch all agents simultaneously in a single message with multiple Task tool calls
- **Information Separation**: Agents 2 (failure-mode) and 3 (data-integrity) independently analyze overlapping areas (Redis Streams, shutdown) — disagreements reveal genuine ambiguity
- **Cross-Agent Synthesis**: Deduplicate and cross-reference findings from independent agents
- **Calibrated Confidence**: Distinguish proven bugs from speculation, rate each finding honestly

**Leverage these actively**: Use TeamCreate to spawn a team. Use Task tool with `team_name` to spawn teammates. Use TodoWrite to track overall progress. Synthesize all agent results into a single prioritized report.

## Role & Context

Senior blockchain/DeFi engineer analyzing a multi-chain arbitrage system. Full system context is in CLAUDE.md — read it for chains, architecture, stack, hot-path modules, and conventions. Key references:
- `docs/agent/code_conventions.md` — Code patterns
- `docs/architecture/adr/` — ADR decisions (especially ADR-002, ADR-005, ADR-012, ADR-018, ADR-022)

**Hot-path latency target: <50ms** (price-update -> detection -> execution). Performance bugs in hot-path code are automatically P0.

---

## Why 6 Agents

Evidence from Wave 1 analysis (`/deep-analysis`) and Wave 2 operation on this codebase shows specific failure modes that require specialized operational lenses:

| Failure Mode | Evidence | Agent That Catches It |
|-------------|----------|----------------------|
| **Invisible latency regression** | StreamBatcher flush interval adds 50-100ms nobody measured | latency-profiler (traces full pipeline budget) |
| **Silent data loss on shutdown** | engine.ts:754-781 drops queued opportunities on SIGTERM | failure-mode-analyst (maps every failure point) |
| **Delivery guarantee confusion** | Pipeline is at-least-once from coordinator, at-most-once before — nobody documented this | data-integrity-auditor (traces message lifecycle end-to-end) |
| **Chain-specific blind spots** | L2 rollup L1 data fees missing from gas estimation for 5 chains | cross-chain-analyst (audits per-chain correctness) |
| **Dead observability infrastructure** | TraceContext built but zero service imports — completely unwired | observability-auditor (checks if infra is actually used) |
| **Config drift causes false negatives** | 22+ `\|\|` vs `??` violations silently zero valid values | config-drift-detector (systematic pattern audit) |

**Information Separation**: Agents 2 (failure-mode) and 3 (data-integrity) deliberately overlap on Redis Streams analysis. Each independently traces message lifecycle, shutdown behavior, and data loss risks. When they agree, confidence is HIGH. When they disagree, it reveals genuine ambiguity that needs investigation. This pattern caught the at-least-once vs at-most-once delivery boundary that neither agent would have fully mapped alone.

---

## Team Structure

You are the **Team Lead**. Your responsibilities:
1. Create the team and task list using TeamCreate
2. Read `docs/agent/code_conventions.md` and skim relevant ADRs for shared context
3. Spawn all 6 agents **in parallel** (single message, 6 Task tool calls) — **ALL agents MUST use model: opus**
4. Send activation messages to all agents after spawning with specific file lists
5. Monitor progress using the Stall Detection Protocol
6. Collect and read all agent reports
7. Apply Synthesis Quality Gates before producing final report
8. Resolve conflicts between agents using the Conflict Resolution Protocol
9. Produce a final unified report saved to `docs/reports/`

---

### Agent 1: "latency-profiler" (subagent_type: general-purpose, model: opus)

**Analysis scope**: `$ARGUMENTS`

**Focus areas**:

1. **Pipeline Stage Latency Budget**
   - Trace the full critical path with estimated latency per stage
   - WebSocket message parse time (JSON.parse main thread vs worker threshold)
   - Price cache write time (Atomics operations, seqlock overhead)
   - Detection loop cycle time (polling interval, event-driven triggers, throttle intervals)
   - Redis XADD time (StreamBatcher flush interval, batch size, network RTT)
   - Consumer XREADGROUP time (blocking read timeout, between-poll delay)
   - Execution dispatch time (queue dequeue, distributed lock acquisition)

2. **Serialization Points**
   - JSON.parse on main thread — what's the worker offload threshold?
   - Does the detection loop block on any synchronous operation?
   - Are there `Atomics.wait` calls that block the main thread?
   - Does `postMessage` serialization between workers add overhead? Structured clone vs transferable?

3. **Contention Analysis**
   - SharedArrayBuffer writer/reader contention (price updates vs detectors)
   - Redis connection multiplexing (multiple chains sharing connections)
   - Event loop saturation (concurrent detection from multiple chains in one partition)

4. **Hidden Allocations in Hot Path**
   - Spread operators (`...`) in tight loops
   - `new Array`, `new Map`, `new Set` in detection code
   - `JSON.stringify`/`JSON.parse` in detection loop
   - `Array.from(Set)` where `for..of` would suffice

5. **Batch vs Real-Time Tradeoffs**
   - StreamBatcher flush interval — configurable? What's the latency cost?
   - Priority queues for different opportunity types?

6. **Worker Thread Communication Overhead**
   - Structured clone vs transferable objects
   - Round-trip time for worker thread calls
   - Data volume serialized per call

**Key files to read**: websocket-manager.ts, chain-instance.ts, price-matrix.ts, redis-streams.ts, engine.ts, arbitrage-detector.ts, cross-dex-triangular-arbitrage.ts, multi-leg-path-finder.ts, ADR-002, ADR-005, ADR-012, ADR-022

**Deliverable**: Latency budget table per stage with file:line, serialization points, contention analysis, hidden allocation inventory, recommendations ordered by latency impact.

---

### Agent 2: "failure-mode-analyst" (subagent_type: general-purpose, model: opus)

**Analysis scope**: `$ARGUMENTS`

**Information Separation Note**: You share Redis Streams and shutdown analysis scope with the data-integrity-auditor (Agent 3). Work INDEPENDENTLY — do not try to coordinate. Your perspective (failure modes, recovery, cascading effects) is deliberately different from theirs (delivery guarantees, ordering, dedup). Disagreements between your reports reveal genuine ambiguity.

**Focus areas**:

1. **Failure Point Mapping**
   For EACH pipeline stage: what can fail, what happens when it fails, is it detected, is recovery automatic or manual, what data is lost.

2. **Circuit Breaker Verification**
   - Thresholds, state machine, persistence across restarts
   - Coverage: is there a CB for each external dependency (Redis, RPC, WebSocket)?
   - What happens during OPEN state — queued or dropped?

3. **DLQ (Dead Letter Queue) Processing**
   - Where do failed messages go? Retry mechanism? Max retries?
   - Can DLQ messages be manually replayed?
   - Are DLQ messages monitored/alerted on?

4. **Backpressure Chain**
   - Trace the FULL chain: source -> queue -> consumer -> processor
   - What happens when queue is full? Producer block or message drop?
   - Consumer pause/resume behavior and in-flight message handling
   - Maximum queue sizes and Redis memory exhaustion handling

5. **Graceful Shutdown**
   - Signal handling (SIGTERM, SIGINT)
   - Shutdown ORDER: stop accepting -> drain queues -> close connections -> exit
   - Data loss windows between stages
   - Shutdown timeout behavior

6. **Cascading Failure Scenarios**
   - Redis down: impact on each service
   - All WebSockets disconnect: recovery behavior
   - Execution engine crash mid-trade: pending flash loan handling
   - Worker thread crash: detection and restart
   - One partition crash: work redistribution

**Key files to read**: redis-streams.ts, circuit-breaker-manager.ts, websocket-manager.ts, engine.ts, partition-service-utils.ts, ADR-018, ADR-007, dead-letter-queue.ts, queue.service.ts, opportunity.consumer.ts

**Deliverable**: Failure mode table (stage, mode, detection, recovery, data loss risk, file:line), circuit breaker assessment, backpressure chain trace, graceful shutdown analysis, cascading failure scenarios, recommendations ordered by data loss risk.

---

### Agent 3: "data-integrity-auditor" (subagent_type: general-purpose, model: opus)

**Analysis scope**: `$ARGUMENTS`

**Information Separation Note**: You share Redis Streams and shutdown analysis scope with the failure-mode-analyst (Agent 2). Work INDEPENDENTLY — do not try to coordinate. Your perspective (delivery guarantees, message ordering, dedup, HMAC integrity) is deliberately different from theirs (failure modes, recovery, cascading effects). Disagreements between your reports reveal genuine ambiguity.

**Focus areas**:

1. **Delivery Guarantees**
   - What delivery semantic does the pipeline implement? (at-most-once, at-least-once, exactly-once?)
   - Trace a message: WebSocket -> XADD -> XREADGROUP -> processing -> XACK
   - What happens if XACK fails? Consumer crash between processing and XACK?
   - Pending entries list (PEL) timeout? Claimed-but-unacked message handling?
   - XCLAIM/XAUTOCLAIM for orphaned entries?

2. **Message Ordering**
   - Consumer group ordering with multiple consumers
   - Stale price handling (out-of-order WebSocket messages during reconnection)
   - Monotonic timestamp enforcement in price cache

3. **Deduplication**
   - Each dedup layer: scope, key, window, race conditions
   - Restart idempotency: what happens when dedup state is lost?
   - Side effects of duplicate execution

4. **HMAC Chain Integrity**
   - Full trace: key config -> sign -> transmit -> verify -> accept/reject
   - Stream-scoped signing? Key rotation? Global vs per-stream keys?
   - What fields are covered by the HMAC signature?

5. **Stream Trimming & Data Loss**
   - MAXLEN configuration (approximate vs exact trimming)
   - Can trimming remove unread messages? Consumer lag monitoring?

6. **Price Data Integrity**
   - Input validation (NaN, Infinity, negative, zero)
   - Seqlock correctness (torn read protection)
   - SharedArrayBuffer stale data from previous sessions

7. **Cross-Service Message Integrity**
   - Schema validation on publish and consume sides
   - Schema evolution / message version fields
   - Binary field serialization (BigInt, Uint8Array)

**Key files to read**: redis-streams.ts (MOST CRITICAL — read ALL), price-matrix.ts, shared-key-registry.ts, engine.ts, chain-instance.ts, opportunity.publisher.ts, opportunity.consumer.ts, stream-consumer-manager.ts, ADR-002

**Deliverable**: Delivery guarantee analysis table, message ordering assessment, deduplication gap analysis, full HMAC chain trace, data loss windows, recommendations ordered by data loss risk.

---

### Agent 4: "cross-chain-analyst" (subagent_type: general-purpose, model: opus)

**Analysis scope**: `$ARGUMENTS`

**Focus areas**:

1. **Block Time & Detection Window**
   - Are opportunity TTLs chain-aware? (Arbitrum sub-second vs Ethereum 12s)
   - Price staleness per chain
   - Detection intervals vs block production rate

2. **Gas Model Differences**
   - L2 rollups: L1 data fees (Arbitrum, Optimism, Base, zkSync, Linea)
   - Does `estimateGasCostUsd()` use correct gas model per chain?
   - Gas price thresholds per-chain or global?
   - zkSync account abstraction gas model

3. **Token Decimal Handling**
   - USDT: 18 decimals on BSC, 6 on Ethereum/others
   - Cross-chain profit calculations with different decimals
   - Hardcoded decimal assumptions

4. **Solana vs EVM Divergence**
   - P4 doesn't use factory pattern — detection logic differences
   - WebSocket subscription model differences
   - Price matrix handling for Solana token pairs

5. **RPC & Connection Differences**
   - Chain-specific RPC rate limits
   - Chain-aware WebSocket reconnection strategies

6. **Cross-Chain Arbitrage Edge Cases**
   - Bridge latency variance (Arbitrum 7-day withdrawal vs Polygon 30min)
   - Finality requirements per chain
   - Bridge fee calculation accuracy

7. **DEX-Specific Behavior Per Chain**
   - Same DEX different fee tiers on different chains
   - Per-chain minimum liquidity checks

**Key files to read**: service-config.ts, thresholds.ts, gas-price-cache.ts, partition-service-utils.ts, cross-chain.strategy.ts, tokens/index.ts, ADR-003, ADR-013, ADR-024

**Deliverable**: Chain-specific edge case table, gas model assessment per chain, token decimal audit, Solana vs EVM gap analysis, cross-chain risk assessment, recommendations ordered by financial impact.

---

### Agent 5: "observability-auditor" (subagent_type: Explore, model: opus)

**Analysis scope**: `$ARGUMENTS`

> This agent uses Explore type (read-only) because its work is grep-heavy pattern scanning across many files. No code writes needed.

**Focus areas**:

1. **Trace Context Propagation**
   - Does `traceId` propagate through EVERY pipeline stage?
   - Map: WebSocket -> Price Cache -> Detection -> Redis -> Coordinator -> Execution
   - Is the tracing infrastructure actually wired into services (check for real imports)?

2. **Log Coverage Analysis**
   For each pipeline stage: success logged? failure logged? context sufficient? performance metrics?

3. **Blind Spots**
   - `.catch(() => {})` patterns that silently swallow errors
   - Empty catch handlers
   - Fire-and-forget promises without error handling
   - Detection decisions with no debug output

4. **Trade Audit Trail Completeness**
   - Does TradeLogger capture all fields needed to reconstruct failed trades?
   - JSONL rotation reliability
   - Missing fields (swap route, slippage, gas price, retry count, detection timestamp)

5. **Metrics Coverage**
   - Detection rate, false positive rate, execution success rate
   - Queue depth, consumer lag, WebSocket health per chain
   - Are Prometheus/StatsD endpoints actually exposed?

6. **Health Check Completeness**
   - Do health endpoints check ALL dependencies?
   - Readiness vs liveness distinction
   - Timeout handling in health checks

7. **Log Level Appropriateness**
   - Hot-path at debug (not info)
   - Rare important events at warn/error
   - Log rate limiting for repetitive messages

**Key files to read**: All files in logging/ and tracing/ directories, trade-logger.ts, redis-streams.ts, websocket-manager.ts, engine.ts, partition-service-utils.ts, arbitrage-detector.ts

**Grep patterns**: `logger.error`, `logger.warn`, `.catch(() =>`, `traceId`, `spanId`, `metrics`, `counter`, `gauge`, `prometheus`

**Deliverable**: Trace propagation map, log coverage matrix, blind spot inventory, metrics assessment, health check assessment, trade audit trail assessment, recommendations ordered by debugging impact.

---

### Agent 6: "config-drift-detector" (subagent_type: Explore, model: opus)

**Analysis scope**: `$ARGUMENTS`

> This agent uses Explore type (read-only) because its work is systematic grep scanning for patterns. No code writes needed.

**Focus areas**:

1. **Hardcoded Values Audit**
   - Numeric literals that should be configurable (timeouts, retries, batch sizes, thresholds)
   - Magic numbers in formulas

2. **`||` vs `??` Audit**
   - ALL `|| 0`, `|| 0n`, `|| ''`, `|| false` patterns in source code
   - For each: can the value legitimately be 0/empty?
   - Convention: `??` for numeric values, `||` only when empty string/false/zero is invalid

3. **Feature Flag Audit**
   - List ALL feature flags (`FEATURE_*` env vars)
   - Correct pattern: `=== 'true'` (opt-in). Wrong: `!== 'false'` (unless intentional safety default)
   - Cross-service consistency: same flag, same pattern everywhere?

4. **Partition Config Consistency**
   - P1-P3 factory pattern vs P4 Solana manual config
   - Same config shape? Partition-specific vs global env vars?

5. **Threshold Validation**
   - Minimum profit thresholds per chain (gas costs vary 100x)
   - Detection windows per chain (block time varies 400ms to 12s)
   - Slippage tolerances per-chain or global

6. **Environment Variable Coverage**
   - `process.env.*` references vs `.env.example` entries
   - Undocumented env vars used in code
   - Env vars that MUST be set in production but have no validation

7. **Docker/Deployment Config Drift**
   - Port consistency (code vs Docker vs Fly.io)
   - Resource limits appropriateness
   - Env var naming consistency

**Key files to read**: service-config.ts, thresholds.ts, .env.example, partition-service-utils.ts, cross-dex-triangular-arbitrage.ts, mev-config.ts, feature-flags.ts, risk-config.ts

**Grep patterns**: `|| 0`, `|| 0n`, `process.env.FEATURE_`, `!== 'false'`, `=== 'true'`, `setTimeout`, `setInterval`

**Deliverable**: Hardcoded values table, || vs ?? violation list, feature flag audit matrix, partition config matrix, threshold assessment, env var coverage table, deployment config drift table, recommendations ordered by detection quality impact.

---

## Critical Rules (Apply to ALL Agents)

### Anti-Hallucination Protocol
- **NEVER** report an issue unless you can point to the exact line(s)
- **NEVER** assume code behavior without reading the actual implementation
- **IF** you need to see related code, use Read/Grep tools to go look first
- **IF** something is suspicious but unproven, label as "NEEDS VERIFICATION"
- **PREFER** under-reporting to over-reporting. False positives waste developer time
- **ALWAYS** check if a pattern exists elsewhere before flagging as unique issue
- **NEVER GUESS.** Investigate with tools first.

### Performance Awareness
- **ALWAYS** flag blocking operations in hot-path code (sync I/O, unbounded loops)
- **ALWAYS** flag O(n) searches in hot paths (array.find/filter -> use Map/Set)
- **ALWAYS** flag unnecessary allocations in tight loops (spread operators, new objects)
- **FLAG** any pattern that could regress the <50ms latency target
- Performance bugs in hot-path code are automatically P0

### Context Requirements
- Read the full file before analyzing (not just snippets)
- Trace data flow: input sources -> transformations -> outputs/assertions
- Check for intentional design: comments, ADRs, code_conventions.md
- Verify patterns across the codebase before reporting inconsistencies

### Investigation Strategy (all agents)
1. **Read the full file** using Read tool
2. **Search for callers/consumers** using Grep in parallel with reading
3. **Search for similar patterns** using Grep across the codebase
4. **Use TodoWrite** to track findings as you go
5. When investigating across multiple files, launch parallel Grep searches in a single response

### What NOT to Do (all agents)
- Don't report style-only preferences unless they mask bugs
- Don't make multiple unrelated findings into one
- Don't "improve" patterns that are working correctly and intentionally
- Don't speculate about code you haven't read with tools
- Don't inflate severity to make findings seem more important
- Don't flag known correct patterns (see table below)

---

## Execution Plan

### Step 1: Setup
1. Use TodoWrite to create tracking items for each phase
2. Use TeamCreate to create the analysis team
3. Read `docs/agent/code_conventions.md` for shared context

### Step 2: Parallel Agent Launch
Spawn ALL 6 agents in a **single message** with 6 parallel Task tool calls:

| # | Agent Name | subagent_type | model | Focus |
|---|-----------|---------------|-------|-------|
| 1 | latency-profiler | general-purpose | opus | Latency budget, serialization, contention |
| 2 | failure-mode-analyst | general-purpose | opus | Failure points, CB, DLQ, backpressure, shutdown |
| 3 | data-integrity-auditor | general-purpose | opus | Delivery guarantees, ordering, dedup, HMAC |
| 4 | cross-chain-analyst | general-purpose | opus | Chain-specific edge cases, gas models, decimals |
| 5 | observability-auditor | Explore | opus | Tracing, logging, metrics, health checks |
| 6 | config-drift-detector | Explore | opus | Hardcoded values, \|\|vs??, feature flags, env vars |

Each agent prompt MUST include:
- The exact target area: `$ARGUMENTS`
- Their specific focus areas, checklists, key files, and grep patterns (copy from above)
- The Critical Rules section (shared rules)
- The Known Correct Patterns table
- For Agents 2 and 3: the Information Separation Note
- Instruction to use TodoWrite for progress tracking
- Instruction to return findings with file:line references

### Step 3: Stall Detection Protocol
After spawning all 6 agents:
1. Send each agent an activation message listing specific files to read IN FULL and relevant ADR references
2. Wait 60-90 seconds, then check inbox read status
3. If agents haven't read their messages after 90s, send a broadcast nudge: "All agents: check your inbox for activation message with file lists. Begin analysis and report findings when done."
4. Continue monitoring every 60s. Track which agents have reported vs not.
5. If an agent is unresponsive after 3 minutes, send a direct message: "You have an assigned analysis task. Read your activation message and begin immediately. Report findings when done."
6. If still unresponsive after 5 minutes, note the gap in the final report and proceed with available results.

### Step 4: Synthesis Quality Gates

Before producing the final report, ALL of these must pass:

**Gate 1: Completeness** — At least 5 of 6 agents have reported findings.
- If fewer than 5: note missing agents, assess if gaps are critical, document what's missing.

**Gate 2: Cross-Validation** — Check the overlap zone (Agents 2 + 3 on Redis Streams):
- Where they AGREE: Promote to HIGH confidence.
- Where they DISAGREE: Apply the Conflict Resolution Protocol.
- Where only ONE reports: Treat as MEDIUM confidence (single-source).

**Gate 3: Deduplication** — Same issue found by multiple agents:
- Merge into single finding, note all discovering agents.
- Use the highest-confidence assessment from any discovering agent.
- If confidence differs by 2+ levels, investigate why.

**Gate 4: False Positive Sweep** — Review all P0/P1 findings:
- Does each have exact file:line evidence?
- Is each checked against Known Correct Patterns?
- Could any be intentional design per ADRs?

### Step 5: Final Report
After ALL quality gates pass:
1. Score each finding using the Priority Scoring Formula
2. Assign final severity based on combined evidence
3. Apply Conflict Resolution for any unresolved disagreements
4. Produce the unified report and save to `docs/reports/`

**Priority Scoring Formula**:
```
Score = (Impact x 0.4) + ((5 - Effort) x 0.3) + ((5 - Risk) x 0.3)
```

---

## Conflict Resolution Protocol

When agents produce contradictory findings on the same area:

1. **Identify the conflict**: Agent X says [conclusion A], Agent Y says [conclusion B] about [same code area].

2. **Classify the conflict**:
   - **Perspective difference**: Both are correct from their angle (e.g., failure-mode says "recovery works" while data-integrity says "recovery loses ordering"). Resolution: Report both perspectives as complementary findings.
   - **Evidence disagreement**: One agent has stronger evidence. Resolution: Use the finding with more specific file:line evidence; demote the other to NEEDS VERIFICATION.
   - **Genuine ambiguity**: Code behavior is truly unclear. Resolution: Report as NEEDS VERIFICATION with both interpretations documented.

3. **Never suppress**: Both sides of a conflict appear in the final report. The team lead adds a "Conflict Resolution" note explaining which interpretation was adopted and why.

---

## Output Format

### Executive Summary
- Total findings by severity: Critical / High / Medium / Low
- Top 5 highest-impact issues (1-sentence each)
- Overall health assessment (A-F grade with justification)
- Agent agreement map: where multiple agents flagged the same area

### Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|

### High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|

### Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|

### Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|

### Latency Budget Table
| Stage | Component | File:Line | Estimated Latency | Bottleneck |
|-------|-----------|-----------|-------------------|------------|

### Failure Mode Map
| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|

### Chain-Specific Edge Cases
| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|

### Observability Assessment
Trace propagation map + log coverage matrix + blind spots + metrics gaps

### Configuration Health
Feature flag audit + || vs ?? violations + env var coverage + deployment drift

### Cross-Agent Insights
Findings identified by multiple agents or where one agent's finding explains another's. Include Information Separation results (Agent 2 vs Agent 3 agreement/disagreement on Redis Streams).

### Conflict Resolutions
Any conflicts between agents, how they were classified, and which interpretation was adopted.

### Recommended Action Plan

**Phase 1: Immediate** (P0 — fix before deployment)
- [ ] Fix #N: [description] (Agent: X, Score: Y)

**Phase 2: Next Sprint** (P1 — reliability and coverage)
- [ ] Fix #N: [description] (Agent: X, Score: Y)

**Phase 3: Backlog** (P2/P3 — hardening and optimization)
- [ ] Fix #N: [description] (Agent: X, Score: Y)

---

## Confidence Calibration

All findings MUST use these levels:
- **HIGH (90-100%)**: Exact code traced, full data flow verified, can write failing test
- **MEDIUM (70-89%)**: Strong evidence, minor uncertainties, haven't seen all related code
- **LOW (50-69%)**: Code smell, not proven failure, might be intentional
- **NEEDS VERIFICATION (<50%)**: Suspicious but can't prove. State what would confirm/deny

## Known Correct Patterns (Don't Flag)

| Pattern | Location | Reason |
|---------|----------|--------|
| `fee ?? 0.003` | execution-engine | Proper nullish coalescing for fees |
| `Object.assign({}, state)` | partitioned-detector | Snapshot for iteration safety |
| `Atomics.store/load` | price-matrix | Thread-safe SharedArrayBuffer access |
| SharedArrayBuffer | price-matrix.ts | Performance-critical (ADR-005) |
| Worker threads | path-finder.ts | Parallel processing (ADR-012) |
| Inline calculations | Hot-path modules | Performance over abstraction (ADR-022) |
| `loadFixture` pattern | Hardhat tests | Snapshot-restore for test speed |
| Multiple try-catch | WebSocket handlers | Intentional per-connection isolation |
| `xack after processing` | coordinator.ts | Proper stream acknowledgment |
| `exponential backoff` | websocket-manager.ts | Reconnection strategy |
| Mutable objects in loops | Tight loops | Avoids allocation overhead |
| `!== 'false'` for safety features | CB, risk mgmt, logging | Intentional opt-out (safety ON by default) |

## Verification Protocol

Before including any finding in the final report:
1. **Evidence Check**: Exact code quoted with file:line, from current version
2. **Logic Check**: Full data flow traced, checked if pattern is intentional (ADRs, comments)
3. **Impact Check**: Specific failure scenario articulated, severity matches actual impact
4. **False Positive Check**: Not intentional design, not documented optimization, not known correct pattern
5. **Fix Quality Check**: Suggested fix is implementable, handles edge cases, syntactically correct
6. **Cross-Reference Check**: Checked if other agents found related issues (dedup in synthesis)

**Remember**: One well-verified finding > five speculative ones. Admitting uncertainty shows thoroughness, not weakness.
