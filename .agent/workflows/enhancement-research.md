---
description: Research enhancements and optimizations for the arbitrage system
---

# Enhancement & Optimization Research

## Prompt Template

Use this prompt to research and plan enhancements or optimizations:

```
### Role & Expertise
You are a senior blockchain systems architect specializing in:
- High-frequency DeFi arbitrage systems
- MEV protection and transaction ordering
- Multi-chain infrastructure optimization
- Low-latency trading systems

### Current System State
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **DEXs**: 44+ (EVM + Solana native)
- **Detection Latency**: ~150ms target
- **Architecture**: 
  - Partitioned detectors (4 partitions: Asia-Fast, L2-Turbo, High-Value, Solana-Native)
  - Redis Streams for event processing (ADR-002)
  - L1 Price Matrix with SharedArrayBuffer (ADR-005)
  - Worker threads for path finding (ADR-012)
  - Circuit breakers for reliability (ADR-018)

### Critical Rules (Anti-Hallucination)
- **NEVER** recommend technologies without explaining trade-offs specific to THIS system
- **NEVER** cite performance numbers without indicating if they're estimates or measured
- **IF** you're unsure about current implementation details, ASK to see the code first
- **ALWAYS** check compatibility with existing ADRs before recommending changes
- **PREFER** incremental improvements over "big bang" rewrites

### Research Process (Think Step-by-Step)
Before making recommendations, work through these steps:
1. **Understand Current State**: What does the existing implementation do and why?
2. **Identify Bottleneck**: What specific metric are we trying to improve?
3. **Research Alternatives**: What are 2-3 approaches used in industry?
4. **Evaluate Trade-offs**: What are the costs (complexity, latency, $$$) of each?
5. **Check Constraints**: Does this work within free tier limits? ADR compliance?
6. **Propose Implementation**: Break into testable, incremental tasks

### Enhancement Area: [SPECIFY AREA]
[Choose one or more:]
- Latency reduction
- Throughput optimization
- Cost reduction (gas, infrastructure)
- Reliability improvement
- New chain/DEX integration
- MEV protection enhancement
- Risk management
- Observability/monitoring

### Research Objectives
1. **Current State Analysis**
   - How does the current implementation work?
   - What are the bottlenecks or limitations?
   - What metrics demonstrate the issue?

2. **Industry Best Practices**
   - What do professional MEV searchers/arbitrageurs use?
   - What are the latest techniques in this area?
   - What open-source solutions exist?

3. **Proposed Solutions**
   - Provide 2-3 alternative approaches
   - Compare trade-offs (complexity, cost, latency, reliability)
   - Recommend best option with justification

4. **Implementation Plan**
   - Break down into testable tasks
   - Estimate effort and confidence level
   - Identify risks and mitigation strategies

### Constraints
- Must work within free tier limits (Fly.io, Oracle Cloud, Upstash)
- Must maintain >80% test coverage
- Must follow existing TDD workflow
- Must be compatible with current ADRs (see docs/architecture/adr/)
- Changes should be incremental, not "big bang"

### Expected Output Format

## Research Summary: [Enhancement Title]

### 1. Current State Analysis
**How It Works**: [Describe current implementation]
**Bottleneck**: [Specific issue with metrics if available]
**Root Cause**: [Why does this limitation exist?]

### 2. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| Approach A | [Companies/Projects] | + Pro 1<br>+ Pro 2 | - Con 1<br>- Con 2 | X days |
| Approach B | [Companies/Projects] | + Pro 1<br>+ Pro 2 | - Con 1<br>- Con 2 | X days |
| Approach C | [Companies/Projects] | + Pro 1<br>+ Pro 2 | - Con 1<br>- Con 2 | X days |

### 3. Recommended Solution
**Approach**: [Name]
**Confidence**: HIGH | MEDIUM | LOW
**Justification**: [Why this over alternatives - be specific]
**Expected Impact**: [Quantified: current → target]
**ADR Compatibility**: [List relevant ADRs and any conflicts]

### 4. Implementation Tasks

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | ... | X days | XX% | None | Unit tests for... |
| 2 | ... | X days | XX% | Task 1 | Integration test... |

### 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Risk 1 | LOW/MED/HIGH | LOW/MED/HIGH | How to prevent/detect |

### 6. Success Metrics
- [ ] Metric 1: [current value] → [target value] — How to measure
- [ ] Metric 2: [current value] → [target value] — How to measure

### 7. ADR Recommendation
**New ADR Needed?**: Yes / No
**Title**: ADR-0XX: [Title]
**Context**: [Why this decision is architecturally significant]

### If You Need More Context
Instead of guessing, ask:
- "I need to see [file] to understand how [component] currently works"
- "What is the current measured latency for [operation]?"
- "Is there a reason [pattern] was chosen over [alternative]?"
```

---

## Few-Shot Examples

### Example 1: Latency Optimization Research

```markdown
## Research Summary: WebSocket Event Processing Optimization

### 1. Current State Analysis
**How It Works**: WebSocket events are received, parsed as JSON, validated, and published to Redis Streams. Each event triggers a full JSON.parse() and schema validation.
**Bottleneck**: Event processing takes ~15ms per event. At 1000 events/second peak, this creates backpressure.
**Root Cause**: JSON parsing is CPU-bound and blocks the event loop. Schema validation adds overhead for every event.

### 2. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| Binary protocols (MessagePack) | Jump Trading, Wintermute | + 3-5x faster parsing<br>+ Smaller payloads | - Requires RPC support<br>- Debugging harder | 5 days |
| Streaming JSON parser | High-freq trading firms | + 2x faster for large payloads<br>+ No schema change | - Limited benefit for small events<br>- Memory overhead | 2 days |
| Worker thread pool | Node.js best practice | + Unblocks event loop<br>+ Uses multiple cores | - Message passing overhead<br>- Complexity | 3 days |

### 3. Recommended Solution
**Approach**: Worker thread pool for JSON parsing + validation
**Confidence**: HIGH
**Justification**: 
- Works with existing JSON events (no RPC changes needed)
- Already have worker thread infrastructure (ADR-012)
- Unblocks main thread for WebSocket I/O
- Scales to available CPU cores

**Expected Impact**: Event processing 15ms → 3ms (80% reduction)
**ADR Compatibility**: Extends ADR-012 (Worker Thread Path Finding)

### 4. Implementation Tasks

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | Create JSON parsing worker pool | 1 day | 95% | None | Unit tests with mock events |
| 2 | Integrate with WebSocket manager | 1 day | 90% | Task 1 | Integration test with real WS |
| 3 | Add metrics for parsing latency | 0.5 day | 95% | Task 2 | Prometheus metric verification |
| 4 | Benchmark under load | 0.5 day | 85% | Task 3 | Load test with 1000 events/sec |

### 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Worker crash loses events | LOW | HIGH | Implement retry queue in main thread |
| Memory overhead from workers | MEDIUM | LOW | Limit pool size to 4 workers |
| Message passing slower than expected | LOW | MEDIUM | Benchmark before full integration |

### 6. Success Metrics
- [ ] Event processing latency: 15ms → <5ms — Measure via Prometheus histogram
- [ ] Main thread event loop lag: current → <10ms — Measure via event loop monitor
- [ ] Peak throughput: current → 2000+ events/sec — Load test

### 7. ADR Recommendation
**New ADR Needed?**: Yes
**Title**: ADR-023: Worker Pool for Event Processing
**Context**: Extending worker thread usage from path-finding to general event processing to improve system responsiveness.
```

### Example 2: New Chain Integration Research

```markdown
## Research Summary: Sonic (prev. Fantom) Chain Integration

### 1. Current State Analysis
**How It Works**: Fantom is already in P1 (Asia-Fast) partition with 4 DEXs configured.
**Bottleneck**: Fantom rebranded to Sonic with new chain ID and upgraded infrastructure.
**Root Cause**: Need to migrate configuration and verify DEX contract compatibility.

### 2. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| In-place migration | Most projects | + Minimal disruption<br>+ Reuse existing tests | - Risk of missing changes<br>- May leave legacy code | 2 days |
| Fresh integration | Conservative approach | + Clean implementation<br>+ Full verification | - Duplicate work<br>- Longer timeline | 4 days |
| Dual support period | Enterprise projects | + Zero downtime<br>+ Gradual migration | - Complexity<br>- Maintenance burden | 3 days |

### 3. Recommended Solution
**Approach**: In-place migration with comprehensive test verification
**Confidence**: MEDIUM (need to verify contract addresses haven't changed)
**Justification**:
- Minimal disruption to existing P1 partition
- Existing tests provide safety net
- Fantom DEX contracts are EVM-compatible on Sonic

**Expected Impact**: Maintain existing opportunity detection + access to Sonic ecosystem tokens
**ADR Compatibility**: No conflicts, follows existing chain integration pattern

### 4. Implementation Tasks

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | Verify Sonic RPC endpoints | 0.5 day | 90% | None | Connection test |
| 2 | Verify DEX contract addresses | 1 day | 75% | Task 1 | On-chain verification |
| 3 | Update chain configuration | 0.5 day | 95% | Task 2 | Unit tests |
| 4 | Update token addresses if changed | 1 day | 70% | Task 2 | Token metadata tests |
| 5 | Integration test on testnet | 1 day | 80% | Tasks 3-4 | Full flow test |

### 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| DEX contracts changed | MEDIUM | HIGH | Verify each contract before migration |
| RPC rate limits different | LOW | MEDIUM | Test with current request patterns |
| Token decimals changed | LOW | HIGH | Explicit verification in tests |

### 6. Success Metrics
- [ ] All existing Fantom tests pass with Sonic config
- [ ] Event detection works on Sonic mainnet
- [ ] No regression in P1 partition performance

### 7. ADR Recommendation
**New ADR Needed?**: No (follows existing pattern)
**Note**: Update DECISION_LOG.md with migration rationale
```

---

## Topic-Specific Research Prompts

### 🚀 Latency Optimization

```
### Enhancement Area: Latency Reduction

### Current Bottlenecks (investigate)
1. WebSocket event processing time
2. Price update propagation to Redis
3. Arbitrage detection calculation
4. Cross-chain price comparison

### Research Focus
- Zero-copy message parsing techniques
- SIMD-accelerated calculations
- Kernel bypass networking (DPDK, io_uring)
- Colocation with RPC nodes
- Custom binary protocols vs JSON

### Target Metrics
- Detection latency: 150ms → <50ms
- Event processing: current → <10ms per event
- Price lookup: current → <1μs (already achieved via L1 Price Matrix)

### Questions to Answer
1. Where is time spent in the current hot path? (need profiling data)
2. What's the latency breakdown: network vs parsing vs logic?
3. Which chains have the highest event volume?
```

### 💰 Gas Optimization

```
### Enhancement Area: Gas Cost Reduction

### Current Implementation
- Dynamic gas pricing with caching (ADR-013)
- Gas estimation before execution
- Priority fee calculation

### Research Focus
- Flashbots Protect for MEV protection
- Private transaction pools
- EIP-1559 optimization strategies
- L2-specific gas optimizations (Arbitrum, Optimism)
- Bundling multiple arbitrages

### Target Metrics
- Gas cost per successful arbitrage: reduce by 20%
- Failed transaction rate: <5%
- MEV extraction by others: minimize exposure

### Questions to Answer
1. What's the current gas cost breakdown per chain?
2. What % of failed txns are due to gas issues vs other causes?
3. Which chains have the highest gas costs per opportunity?
```

### 🔒 MEV Protection

```
### Enhancement Area: MEV Protection Enhancement

### Current Risks
- Front-running by MEV bots
- Sandwich attacks on large trades
- Transaction inclusion delays

### Research Focus
- Flashbots RPC integration
- MEV-Share for MEV redistribution
- Private mempools (MEV Blocker, etc.)
- Commit-reveal schemes
- Just-in-time liquidity attacks

### Implementation Considerations
- Impact on latency (private pools add ~200ms)
- Cost of private transaction submission
- Chain-specific solutions (each L2 has different MEV landscape)

### Questions to Answer
1. Do we have data on MEV losses from past executions?
2. Which chains have the most aggressive MEV competition?
3. What's the acceptable latency trade-off for MEV protection?
```

### 📊 Observability Enhancement

```
### Enhancement Area: Observability & Monitoring

### Current State
- Prometheus metrics (basic)
- Structured logging (Pino)
- Health endpoints per service

### Research Focus
- Distributed tracing (OpenTelemetry)
- Real-time dashboards (Grafana)
- Alerting pipelines
- Profiling and flame graphs
- Performance regression detection

### Target Capabilities
- End-to-end trace for every opportunity (detection → execution)
- Real-time P&L tracking
- Automatic anomaly detection
- Historical performance analysis

### Questions to Answer
1. What's the current logging volume and cost?
2. Which metrics are most valuable for debugging issues?
3. What's the latency tolerance for metric reporting?
```

### 🌐 New Chain Integration

```
### Enhancement Area: New Chain Integration - [CHAIN_NAME]

### Chain Characteristics
- Block time: [X seconds]
- Finality: [type and time]
- RPC availability: [public/paid options]
- DEX ecosystem: [major DEXs]
- Token ecosystem: [notable tokens]

### Research Focus
- Unique technical requirements (EVM vs non-EVM)
- DEX contract patterns (AMM, CLMM, orderbook)
- Bridge availability for cross-chain
- Liquidity depth analysis
- Geographic latency to validators

### Integration Effort Estimate
- Partition assignment decision
- DEX adapter requirements
- Token configuration
- Cross-chain bridge support

### Questions to Answer
1. Is this chain EVM-compatible? If not, what's the architecture?
2. What's the DEX landscape (AMM vs orderbook vs hybrid)?
3. Which partition would this chain belong to?
4. What tokens bridge between this chain and existing chains?
```

---

## Verification Checklist (Before Submitting Research)

Before finalizing your research, verify:
- [ ] Current state analysis is based on actual code, not assumptions
- [ ] All approaches include both pros AND cons
- [ ] Effort estimates are realistic (not just optimistic)
- [ ] Risks include mitigation strategies, not just identification
- [ ] Success metrics are measurable with existing or proposed tools
- [ ] ADR compatibility checked for all recommendations
- [ ] Trade-offs explicitly stated (e.g., latency vs complexity)
- [ ] Any uncertainty is clearly labeled as needing verification

---

## Research Workflow

### Step 1: Define Scope
// turbo
```bash
# Before starting research, verify current implementation
npm run typecheck
npm test
```

### Step 2: Gather Data
// turbo
```bash
# Check existing ADRs for context
ls docs/architecture/adr/
```

// turbo
```bash
# Review implementation plan for related work
grep -A 20 "[TOPIC]" docs/IMPLEMENTATION_PLAN.md
```

// turbo
```bash
# Check if tests exist for the area
find tests/ -name "*[topic]*" -type f
```

### Step 3: Document Research
After completing research, consider:
- [ ] Create new ADR if significant architectural change
- [ ] Update docs/todos.md with action items
- [ ] Add to docs/IMPLEMENTATION_PLAN.md if approved
- [ ] Create issues/tickets if using project management

### Step 4: Prototype (Optional)
```bash
# Create feature branch
git checkout -b research/[enhancement-name]

# Implement minimal proof of concept
# Write benchmark tests to validate assumptions
npm run test -- --testNamePattern="[poc-test]"
```

---

## Evaluation Criteria

When comparing enhancement options, score each on:

| Criteria | Weight | Description |
|----------|--------|-------------|
| **Impact** | 30% | How much does this improve the target metric? |
| **Effort** | 25% | Development time and complexity |
| **Risk** | 20% | Probability of failure or regressions |
| **Maintainability** | 15% | Long-term code health impact |
| **Cost** | 10% | Infrastructure or operational costs |

Score each criterion 1-5, multiply by weight, sum for total score.

**Example Scoring**:
```
| Approach | Impact (30%) | Effort (25%) | Risk (20%) | Maintain (15%) | Cost (10%) | Total |
|----------|--------------|--------------|------------|----------------|------------|-------|
| Worker Pool | 4 (1.2) | 4 (1.0) | 4 (0.8) | 5 (0.75) | 5 (0.5) | 4.25 |
| Binary Proto | 5 (1.5) | 2 (0.5) | 3 (0.6) | 3 (0.45) | 4 (0.4) | 3.45 |
```

---

## Quick Research Commands

### Check current performance baseline
// turbo
```bash
# Run benchmarks
npm run test -- --testNamePattern="benchmark"
```

// turbo
```bash
# Check test count and coverage
npm test -- --coverage --silent 2>&1 | tail -20
```

### Find related implementations
// turbo
```bash
# Search for similar patterns
grep -rn "[pattern]" services/ shared/ --include="*.ts" | head -20
```

// turbo
```bash
# Find ADRs mentioning topic
grep -l "[topic]" docs/architecture/adr/*.md
```

### Compare with external projects
```
# Recommended open-source references:
# - flashbots/mev-boost (MEV infrastructure)
# - Uniswap/v3-core (DEX contracts)
# - paradigmxyz/reth (Rust Ethereum node, performance patterns)
# - jito-foundation/jito-solana (Solana MEV)
```

---

## Cross-Reference: Existing ADRs

Check these before recommending changes:

| ADR | Title | Relevance |
|-----|-------|-----------|
| ADR-002 | Redis Streams | Event processing architecture |
| ADR-003 | Partitioned Detectors | Multi-chain scaling |
| ADR-005 | Hierarchical Cache | L1 Price Matrix |
| ADR-007 | Failover Strategy | Reliability patterns |
| ADR-012 | Worker Thread Path Finding | Async processing |
| ADR-013 | Dynamic Gas Pricing | Gas optimization |
| ADR-016 | Transaction Simulation | Pre-execution validation |
| ADR-018 | Circuit Breaker | Fault tolerance |
| ADR-020 | Flash Loan | Execution strategy |
