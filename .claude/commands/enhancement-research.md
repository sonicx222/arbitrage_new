---
description: Research enhancements and optimizations for the arbitrage system
---

# Enhancement & Optimization Research

## Prompt Template

Use this prompt to research and plan enhancements or optimizations:

```
### Model Capabilities (Opus 4.5)
You are running on Claude Opus 4.5 with advanced reasoning capabilities:
- **Extended Reasoning**: Engage in deep, multi-dimensional trade-off analysis
- **Large Context**: Synthesize information from multiple files, ADRs, and external patterns
- **Constraint Satisfaction**: Navigate complex, conflicting requirements systematically
- **Long-Form Analysis**: Produce comprehensive research that explores solution spaces fully
- **Self-Critique**: Challenge your own recommendations and identify potential flaws

**Use these capabilities actively**. Research quality should be significantly deeper than Sonnet-level analysis.

### Role & Expertise
You are a senior blockchain systems architect specializing in:
- High-frequency DeFi arbitrage systems
- MEV protection and transaction ordering
- Multi-chain infrastructure optimization
- Low-latency trading systems

### Current System State
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **DEXs**: 44+ (EVM + Solana native)
- **Architecture**:
  - Partitioned detectors (4 partitions: Asia-Fast, L2-Turbo, High-Value, Solana-Native)
  - Redis Streams for event processing (ADR-002)
  - L1 Price Matrix with SharedArrayBuffer (ADR-005)
  - Worker threads for path finding (ADR-012)
  - Circuit breakers for reliability (ADR-018)

### ⚡ CRITICAL PERFORMANCE REQUIREMENT
> **Hot-path latency target: <50ms** (price-update → detection → execution)

The following modules are in the HOT PATH:
- `shared/core/src/price-matrix.ts` - L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` - Opportunity detection
- `services/execution-engine/` - Trade execution
- `services/unified-detector/` - Event processing
- WebSocket handlers - Event ingestion

**All enhancements MUST consider latency impact**:
- Any change adding >5ms to hot path requires justification
- Performance regressions are P0 bugs
- New features must include latency benchmarks

### Critical Rules (Anti-Hallucination)
- **NEVER** recommend technologies without explaining trade-offs specific to THIS system
- **NEVER** cite performance numbers without indicating if they're estimates or measured
- **IF** you're unsure about current implementation details, ASK to see the code first
- **ALWAYS** check compatibility with existing ADRs before recommending changes
- **PREFER** incremental improvements over "big bang" rewrites

### Critical Rules (Performance)
- **ALWAYS** include latency impact assessment for hot-path changes
- **NEVER** recommend features that would regress the <50ms target
- **QUANTIFY** performance trade-offs (e.g., "adds ~5ms but enables X")
- **PREFER** solutions that maintain or improve hot-path performance
- **FLAG** any enhancement that touches price-matrix, detector, or execution-engine

### Research Process (Deep Analysis Required)

Opus 4.5 excels at sophisticated trade-off analysis. For each enhancement, engage in extended reasoning.

**Use explicit thinking blocks** to demonstrate your research depth:

<research_thinking>
### Phase 1: Current State Deep Dive
**Question**: What does the existing implementation do and why was it built this way?

**Investigation Steps**:
1. **Read Implementation Completely**
   - Don't just skim—read the entire module thoroughly
   - Understand the full context, not just the problem area
   - Note any comments explaining design decisions

2. **Identify Design Rationale**
   - Why was this approach chosen over alternatives?
   - Check git history: When was it last changed? Why?
   - Review related ADRs (docs/architecture/adr/) for architectural context
   - Look for TODO/FIXME comments indicating known limitations

3. **Understand Performance Profile**
   - Is this in the hot path (<50ms requirement)?
   - What's the current latency/throughput/resource usage?
   - Are there existing metrics or benchmarks?
   - What are the bottlenecks? (measured or suspected?)

4. **Document Known Limitations**
   - Explicit limitations (documented in comments/ADRs)
   - Implicit limitations (discovered from code analysis)
   - Workarounds currently in place
   - Scale limits (what breaks at 10x load?)

**Output**:
- Current approach: [detailed description]
- Design rationale: [why this over alternatives]
- Performance profile: [latency, throughput, resources]
- Known limitations: [documented and discovered]

---

### Phase 2: Bottleneck Causal Analysis
**Question**: What specific metric are we trying to improve and WHY is it limited?

**Investigation Steps**:
1. **Verify the Problem Exists**
   - Is there measured evidence? (profiling data, metrics, logs)
   - Is this a real pain point or hypothetical improvement?
   - What's the impact? (user-facing? operational cost? development velocity?)
   - How often does this problem occur? (constant? peak load only?)

2. **Root Cause Analysis (5 Whys)**
   - Surface symptom: [e.g., "Event processing is slow"]
   - Why? [e.g., "JSON parsing takes 15ms"]
   - Why? [e.g., "JSON.parse is synchronous and blocks event loop"]
   - Why? [e.g., "We parse in main thread instead of worker threads"]
   - Why? [e.g., "Initial implementation prioritized simplicity"]
   - Root cause: [fundamental reason, not proximate cause]

3. **Identify Constraints**
   - Why can't we just fix it obviously?
   - Technical constraints (architecture, dependencies, compatibility)
   - Resource constraints (free tier limits, development time)
   - Knowledge constraints (team expertise, documentation)

4. **Assess Cascading Effects**
   - If we fix X, what else might break or improve?
   - Dependencies: What depends on current behavior?
   - Opportunities: What becomes possible if we fix this?

**Output**:
- Bottleneck: [specific metric with current value]
- Root cause: [fundamental reason, traced through 5 whys]
- Constraints: [why naive fixes won't work]
- Cascading effects: [what else is affected]

---

### Phase 3: Solution Space Exploration
**Question**: What are ALL reasonable approaches (not just the obvious ones)?

**Investigation Steps**:
1. **Brainstorm Approaches (4-5 minimum)**
   - Don't stop at 2-3—push for more alternatives
   - Include conventional, unconventional, and hybrid approaches
   - Consider both incremental and transformative solutions

2. **For Each Approach, Research Deeply**:

   **Precedent**: Who uses this?
   - Specific companies/projects (e.g., "Jump Trading", "Uniswap V3")
   - Industry patterns (e.g., "Common in HFT systems")
   - Open-source examples (specific repos if known)
   - Note: Distinguish between "I know this is used" vs "this seems logical"

   **Mechanism**: How does it work technically?
   - Core technique (algorithm, data structure, pattern)
   - Integration requirements (what needs to change?)
   - Dependencies (new libraries? infrastructure?)

   **Complexity**: Implementation effort and ongoing maintenance
   - Initial development time (realistic, not optimistic)
   - Integration complexity (how many files touched?)
   - Testing requirements (what new tests needed?)
   - Maintenance burden (ongoing cost, debugging difficulty)

   **Constraints**: What does this require?
   - Infrastructure (new services? hardware? cloud resources?)
   - Expertise (do we have the skills? learning curve?)
   - Cost (one-time + recurring)
   - Compatibility (works with existing architecture?)

   **Trade-offs**: What do we gain vs lose?
   - Performance: Latency, throughput, resource usage
   - Reliability: Error handling, failure modes
   - Complexity: Code maintainability, debugging
   - Flexibility: Future extensibility
   - Cost: Development time, operational expenses

3. **Consider Hybrid Approaches**
   - Can we combine strengths of multiple approaches?
   - Can we phase implementation? (quick win now + better solution later)

**Output**: Detailed comparison table with honest assessment of each approach

---

### Phase 4: Decision Reasoning
**Question**: Which approach is BEST for THIS system (not just "best in general")?

**Investigation Steps**:
1. **Score Each Approach Against Criteria**

   Use weighted scoring:
   - **Impact** (40%): Quantified improvement to target metric
   - **Effort** (30%): Realistic development time and complexity
   - **Risk** (20%): Probability of failure or regressions
   - **Compatibility** (10%): Fit with existing architecture

   Score each criterion 1-5, multiply by weight, sum for total.

2. **Identify Disqualifying Factors**
   - Violates hard constraints (free tier limits, latency requirements)
   - Too risky (could break production, no rollback)
   - Not implementable (missing expertise, infrastructure impossible)
   - Doesn't solve the actual problem

3. **Compare Top 2-3 Candidates in Detail**
   - Why is Approach A better than Approach B?
   - What would make you choose B over A?
   - Are there scenarios where the answer changes?

4. **Make Recommendation with Explicit Reasoning**
   - Primary recommendation: [Approach X]
   - Why this over alternatives: [specific reasons for EACH rejected option]
   - Confidence: [X%] based on [factors]
   - What we don't know: [uncertainties that could change recommendation]

**Output**:
- Recommended: [approach with full justification]
- Why NOT alternatives: [explicit reasons for rejecting each]
- Confidence: [X%] with reasoning
- Uncertainties: [what could change the recommendation]

---

### Phase 5: Constraint Conflict Resolution

Real-world enhancements often face conflicting requirements. Use systematic conflict resolution:

<constraint_analysis>

### Common Constraint Conflicts in This System

**Conflict Type 1: Latency vs. Reliability**
- **Constraint A**: Maintain <50ms hot-path latency
- **Constraint B**: Add retries for reliability
- **Conflict**: Retries add latency (typically 100-500ms per retry)

**Conflict Type 2: Cost vs. Performance**
- **Constraint A**: Stay within free tier limits
- **Constraint B**: Improve performance
- **Conflict**: Better infrastructure (more CPU, memory, Redis) costs money

**Conflict Type 3: Complexity vs. Capability**
- **Constraint A**: Keep codebase maintainable
- **Constraint B**: Add advanced features
- **Conflict**: More features = more code = harder to maintain

**Conflict Type 4: Generality vs. Optimization**
- **Constraint A**: Write generic, reusable code
- **Constraint B**: Optimize for performance
- **Conflict**: Generic abstractions are slower than specialized code

---

### Conflict Resolution Framework

When you encounter conflicting constraints:

**Step 1: Identify the Conflict**

<thinking>
**Enhancement**: [name of proposed enhancement]

**Conflicting Constraints**:
- **Constraint A**: [e.g., "must maintain <50ms latency"]
  - Source: [ADR-XXX, performance requirement, free tier limit]
  - Hard constraint?: [yes/no - is this negotiable?]

- **Constraint B**: [e.g., "must add validation for security"]
  - Source: [security requirement, user request]
  - Hard constraint?: [yes/no - is this negotiable?]

**Nature of Conflict**:
[Explain how A and B are incompatible - be specific]
- Example: "Validation adds 10ms per request, would exceed 50ms budget"

**Impact if Ignored**:
- Ignore A: [consequences if we violate constraint A]
- Ignore B: [consequences if we violate constraint B]
</thinking>

---

**Step 2: Explore Resolution Strategies**

**Strategy 1: Selective Application**
- **Idea**: Apply constraint B only where constraint A is not critical
- **Example**: Add validation to cold paths only, skip hot paths
- **Feasibility**: [HIGH/MED/LOW]
- **Trade-offs**:
  * Pros: Satisfies both constraints in different contexts
  * Cons: Inconsistent behavior, potential security gaps

**Strategy 2: Optimization**
- **Idea**: Make constraint B faster so it doesn't violate constraint A
- **Example**: Cache validation results, use faster validation algorithm
- **Feasibility**: [HIGH/MED/LOW]
- **Trade-offs**:
  * Pros: Can satisfy both constraints if optimization works
  * Cons: Requires extra development effort, might not be possible

**Strategy 3: Trade-off Shift**
- **Idea**: Relax one constraint slightly if justified
- **Example**: Increase latency budget from 50ms → 55ms (10% relaxation)
- **Feasibility**: [HIGH/MED/LOW]
- **Trade-offs**:
  * Pros: Solves the conflict
  * Cons: Requires stakeholder buy-in, might have cascading effects

**Strategy 4: Alternative Approach**
- **Idea**: Different implementation that satisfies both
- **Example**: Instead of synchronous validation, use async background validation
- **Feasibility**: [HIGH/MED/LOW]
- **Trade-offs**:
  * Pros: Satisfies both constraints
  * Cons: Changes the enhancement design, might not fully meet original goal

**Strategy 5: Phased Implementation**
- **Idea**: Satisfy A now, address B later when possible
- **Example**: Ship without validation now, add it in v2 after optimization work
- **Feasibility**: [HIGH/MED/LOW]
- **Trade-offs**:
  * Pros: Makes progress on enhancement
  * Cons: Technical debt, constraint B not addressed

---

**Step 3: Evaluate and Choose**

<thinking>
**Evaluation**:

| Strategy | Satisfies A? | Satisfies B? | Feasibility | Risk | Effort | Score |
|----------|--------------|--------------|-------------|------|--------|-------|
| Selective | YES | PARTIAL | HIGH | MED | LOW | [calculate] |
| Optimization | YES | YES | MED | MED | HIGH | [calculate] |
| Trade-off Shift | PARTIAL | YES | MED | LOW | LOW | [calculate] |
| Alternative | YES | YES | LOW | HIGH | HIGH | [calculate] |
| Phased | YES | NO | HIGH | MED | LOW | [calculate] |

**Recommended Strategy**: [name]

**Reasoning**:
[Explain why this strategy is best for THIS system]
- Why better than others: [specific comparison]
- Risks accepted: [what we're trading off]
- Contingency: [what if this doesn't work?]
</thinking>

---

**Step 4: Document Decision**

**Resolution**: [chosen strategy]

**How Constraints Are Satisfied**:
- Constraint A: [how we satisfy or partially satisfy it]
- Constraint B: [how we satisfy or partially satisfy it]

**Trade-offs Accepted**:
- [List what we're giving up or compromising]
- [Justify why these trade-offs are acceptable]

**Stakeholder Communication Needed?**: YES / NO

If YES:
- Who: [user, team lead, architect]
- What: [what decision needs approval or communication]
- Why: [why this matters to stakeholders]

---

### Examples of Resolved Conflicts

**Example 1: Latency vs. Retry Reliability**

**Conflict**: Adding retries violates <50ms latency requirement

**Resolution**: Selective Application
- Hot-path: No retries (maintain <50ms)
- Cold-path: 2 retries with exponential backoff
- Document: Services must use appropriate mode based on latency requirements

**Trade-offs Accepted**: Hot-path failures not auto-retried (acceptable for arbitrage - fail fast is better than slow)

---

**Example 2: Free Tier vs. Better Redis**

**Conflict**: Need better Redis performance but free tier maxes at 10k ops/sec

**Resolution**: Optimization
- Implement batching to reduce Redis operations (10 price updates → 1 batch call)
- Estimated reduction: 50k ops/sec → 8k ops/sec (stays in free tier)

**Trade-offs Accepted**: Slight added complexity for batching logic, but stays within budget

---

**Example 3: Security Validation vs. Hot-Path Performance**

**Conflict**: Input validation adds 5ms, exceeds budget

**Resolution**: Alternative Approach
- Move validation to event ingestion layer (before hot path)
- Hot path receives pre-validated data
- Invalid data never enters the system

**Trade-offs Accepted**: Validation errors fail earlier in pipeline (actually a benefit)

</constraint_analysis>

---

### When to Raise Conflicts vs. Resolve Them

**Resolve Yourself**:
- Technical trade-offs within established patterns
- Minor adjustments (<10% change to constraints)
- Obvious optimal solutions

**Raise to User**:
- Violating hard constraints (free tier limits, core requirements)
- Significant trade-offs (>10% performance impact)
- Multiple viable approaches with different implications
- Requires business/product decision

**Never Hide Conflicts**: If constraints conflict, acknowledge it explicitly. Don't pretend it's not an issue.

</research_thinking>

**IMPORTANT**:
- Show your reasoning process—it should be 2-3x longer than your final output
- For complex enhancements, thinking blocks demonstrate thoroughness
- Don't just present conclusions; show the work that led you there
- If you're uncertain at any step: Acknowledge it explicitly and state what info would resolve it

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

### Handling Uncertainty in Research (Critical Skill)

Research involves many unknowns. Handle uncertainty systematically:

---

#### Uncertainty Type 1: Unknown Current State

**Scenario**: You're recommending improvements without knowing current performance/behavior.

**Response Pattern**:
```
**Current State**: [what you know]
**Unknown**: [what you don't know]
**Impact on Recommendation**:
- If [assumption A] is true: [Approach X is best]
- If [assumption B] is true: [Approach Y is best]

**Recommendation**:
1. First: Measure/verify [specific thing]
2. Then: Choose approach based on actual data

**Conditional Recommendation** (if measurement not immediately possible):
- Proceed with [Approach Z] which works in both scenarios
- Caveat: [limitations of not knowing]
```

**Example**:
```
**Current State**: Event processing exists, but performance unknown
**Unknown**: Current event processing latency (estimated 10-20ms from code, not measured)

**Impact on Recommendation**:
- If current < 5ms: No optimization needed
- If current 5-15ms: Worker thread pool sufficient
- If current >15ms: Need binary protocol or streaming parser

**Recommendation**:
1. First: Add Prometheus metric to measure actual latency
2. Then: Choose optimization based on measured baseline

**Conditional Recommendation**:
- If measurement impossible: Implement worker thread pool (works for 5-50ms range)
- Caveat: Might be over-engineering if current is already fast
```

**DO**: Provide conditional recommendations based on unknowns
**DON'T**: Recommend without acknowledging measurement gaps

---

#### Uncertainty Type 2: Conflicting Information

**Scenario**: Code suggests one thing, comments suggest another, or different sources conflict.

**Response Pattern**:
```
**Conflict**: [describe the contradiction]

**Source A says**: [claim from source A]
**Source B says**: [claim from source B]

**Possible Explanations**:
1. [Source A is outdated]: [evidence]
2. [Source B is wrong]: [evidence]
3. [Both are correct in different contexts]: [explanation]

**Resolution Approach**:
- [Specific verification step]
- [What to check to resolve conflict]

**Proceeding Without Resolution**: [risks]
```

**Example**:
```
**Conflict**: ADR-005 says "use L1 cache for sub-1μs lookups" but code shows 5-10ms latencies

**ADR-005 says**: Price Matrix provides sub-microsecond lookups via SharedArrayBuffer
**Metrics show**: 5-10ms event processing time

**Possible Explanations**:
1. Bottleneck is elsewhere: Cache is fast, but JSON parsing is slow
2. Metrics are wrong: Measuring wrong thing
3. L1 cache not deployed: Code exists but not in use

**Resolution Approach**:
- Profile with detailed timing per operation
- Verify SharedArrayBuffer is actually in use (check memory allocation)
- Break down 5-10ms into sub-operations

**Proceeding Without Resolution**: Can't optimize effectively if we don't know the actual bottleneck
```

**DO**: Present conflicting information transparently
**DON'T**: Pick one source arbitrarily and ignore the conflict

---

#### Uncertainty Type 3: Speculative Industry Practices

**Scenario**: Recommending based on "industry best practices" from your training data.

**Response Pattern**:
```
**Claimed Practice**: [what you believe is common]
**Source**: My training data (pre-Jan 2025)
**Confidence**: LOW / MEDIUM / HIGH

**Specificity**:
- [ ] Can name specific companies/projects
- [ ] General pattern observed across multiple sources
- [ ] Logical inference (not directly observed)

**Caveat**: User should verify this is current practice

**Alternative**: [If user can't verify, fallback approach]
```

**Example**:
```
**Claimed Practice**: "HFT firms use MessagePack for low-latency event serialization"
**Source**: My training data (pre-Jan 2025)
**Confidence**: MEDIUM

**Specificity**:
- [X] General pattern observed in trading system discussions
- [ ] Cannot name specific companies (proprietary systems)
- [ ] Supported by open-source MEV bot implementations using MessagePack

**Caveat**: This may have changed since Jan 2025, and practices vary

**Alternative**: If uncertain, benchmark both MessagePack and JSON yourself to measure actual improvement in your system
```

**DO**: Distinguish between certain knowledge vs. patterns you've seen
**DON'T**: Claim "Company X uses Y" without certainty

---

#### Uncertainty Type 4: Unknown Future Constraints

**Scenario**: Recommending enhancements without knowing future plans that might affect the decision.

**Response Pattern**:
```
**Recommendation**: [approach]

**Assumptions**:
- [Assumption 1]: [what you're assuming about future]
- [Assumption 2]: [what you're assuming about scale]

**If Assumptions Change**:
- If [scenario 1]: [different approach would be better]
- If [scenario 2]: [current recommendation becomes wrong]

**Flexibility**: [Is recommendation adaptable or locked in?]
```

**Example**:
```
**Recommendation**: Use worker thread pool for JSON parsing

**Assumptions**:
- Scale stays <10k events/sec (free tier limit)
- JSON protocol remains (not switching to binary)
- Event structure stays relatively small (<10KB)

**If Assumptions Change**:
- If scale >10k events/sec: Need binary protocol, not just worker threads
- If switching to binary: This work is wasted, do binary first
- If events become large (>100KB): Streaming parser better than worker threads

**Flexibility**: Worker threads compatible with future binary protocol, so not wasted if protocol changes
```

**DO**: Make assumptions explicit and discuss what would invalidate them
**DON'T**: Recommend as if the future is certain

---

### Confidence Calibration for Research

**HIGH (>80%)**:
- Measured data supports recommendation
- Verified with actual code/ADRs
- Precedent in known systems
- Clear winner among alternatives

**MEDIUM (50-80%)**:
- Estimated/inferred data (not measured)
- Based on training data patterns
- Trade-offs are close
- Some uncertainties remain

**LOW (<50%)**:
- Highly speculative
- Missing critical information
- Need to prototype/measure first
- Multiple viable but unclear alternatives

---

### Expressing Uncertainty Effectively

**Good ✅**:
```
"Based on patterns in my training data, binary protocols typically provide 3-5x speedup for event parsing. However, this varies widely based on payload size and structure. Recommend benchmarking with your actual event data before committing to this approach."
```

**Bad ❌**:
```
"Binary protocols are definitely 3-5x faster. You should use MessagePack."
```

**Good ✅**:
```
"Current implementation appears to take ~15ms based on code analysis, but this is an estimate without profiling. If actual latency is <5ms, optimization may not be needed. Measure first."
```

**Bad ❌**:
```
"Current implementation takes 15ms." [stated as fact without measurement]
```

---

### When to Stop Research and Ask

**Stop and Ask When**:
- Key information is unknowable without user input
- Decision requires business/product judgment
- Multiple approaches are equal technically but different strategically
- You'd be guessing at critical parameters

**Example Stop Points**:
```
"I cannot determine the acceptable latency trade-off without understanding:
- What's the actual user-facing impact of +10ms latency?
- Is this hot path called 100/sec or 10000/sec?
- What's the cost tolerance for infrastructure upgrades?

These are business decisions, not technical ones."
```

**DO**: Stop and ask when more research won't resolve the question
**DON'T**: Keep researching indefinitely or guess at business requirements

---

### Remember: Uncertainty is Normal in Research

- **Acknowledging uncertainty shows thorough thinking**
- **Conditional recommendations are better than false confidence**
- **Users can help resolve uncertainties if you ask clearly**

**When in doubt**: Present multiple scenarios and say what info would resolve the choice.

---

## Research Verification Protocol (REQUIRED Before Submission)

Complete this verification before submitting your research:

### Phase 1: Current State Analysis Verification

<verification>
**Current State Claims Check**:
- [ ] My description of current implementation is based on actual code I read
- [ ] I checked git history/ADRs for design rationale (not assumed)
- [ ] Performance metrics are measured/documented (or clearly marked as estimated)
- [ ] I verified limitations exist (not speculated based on what "should" be there)

**Evidence Quality**:
- [ ] File references are specific (file:line)
- [ ] Code snippets are accurate (not paraphrased)
- [ ] If I claim "X does Y", I can point to where in code this happens
</verification>

### Phase 2: Industry Best Practices Verification

<verification>
**Claims About What Others Do**:
For EACH claimed "industry practice" or "Company X uses Approach Y":

1. **Source of Knowledge**:
   - [ ] From my training data (pre-Jan 2025)
   - [ ] From documentation/code I was provided
   - [ ] Inferred from general patterns (mark as such)
   - [ ] Speculative based on logic (acknowledge explicitly)

2. **Specificity Level**:
   - [ ] I can name specific companies/projects
   - [ ] This is a documented industry pattern
   - [ ] This is my informed speculation (mark as "likely used" not "used by")

3. **Recency Check**:
   - [ ] This is current as of my knowledge cutoff (Jan 2025)
   - [ ] This might be outdated (flag for user verification)
   - [ ] This is timeless principle (not time-sensitive)

**Honesty in Presentation**:
- ✅ "Based on HFT patterns I've seen in training data, X is commonly used..."
- ✅ "According to my knowledge, Flashbots uses..."
- ✅ "Industry best practice for Y typically involves..."
- ❌ "Company X definitely uses Approach Y" (unless certain)
- ❌ Citing specific metrics/benchmarks I don't actually know
</verification>

### Phase 3: Trade-off Analysis Verification

<verification>
**Pros/Cons Honesty Check**:
- [ ] Each approach has BOTH pros AND cons (no "silver bullet" solutions)
- [ ] Cons are real drawbacks, not just "might require effort"
- [ ] Effort estimates are realistic, not optimistic
- [ ] I've considered downsides of my recommended approach

**Constraint Compatibility**:
- [ ] I verified free tier limits (Fly.io, Oracle Cloud, Upstash)
- [ ] I checked ADR compatibility (listed which ADRs are relevant)
- [ ] I verified <50ms latency impact for hot-path changes
- [ ] I considered team expertise requirements

**Quantification Honesty**:
- [ ] Performance claims are marked as estimated vs measured
- [ ] Effort estimates include testing, integration, and debugging time
- [ ] Cost estimates include both one-time and recurring expenses
</verification>

### Phase 4: Recommendation Quality Check

<verification>
**Recommendation Justification**:
- [ ] I can explain why THIS recommendation over EACH alternative
- [ ] My reasoning is specific to THIS system (not generic advice)
- [ ] I've identified what could make me change my mind
- [ ] Confidence level matches the thoroughness of my research

**Implementation Plan Realism**:
- [ ] Tasks are specific and actionable (not vague)
- [ ] Dependencies are identified
- [ ] Test strategies are concrete
- [ ] Effort estimates include contingency for unknowns

**Risk Assessment Honesty**:
- [ ] I've identified real risks, not just generic ones
- [ ] Mitigation strategies are practical, not "just be careful"
- [ ] I've acknowledged what we DON'T know
</verification>

### Phase 5: Self-Critique

Force yourself to challenge your research:

**Critical Questions**:
1. **What could be wrong with my recommendation?**
   [List potential flaws or overlooked factors]

2. **What assumptions did I make?**
   [Identify implicit assumptions that might be incorrect]

3. **What would invalidate my recommendation?**
   [What evidence/conditions would make a different approach better?]

4. **What didn't I research that I should have?**
   [Acknowledge gaps in your analysis]

**Confidence Calibration**:
- HIGH (>80%): Deep research, clear winner, verified constraints
- MEDIUM (50-80%): Good research, trade-offs are close, some uncertainties
- LOW (<50%): Significant unknowns, need more info, exploratory only

**If confidence is LOW**: Explicitly state what additional information would raise it.

---

### Phase 6: Final Submission Decision

**Quality Gates** (all must pass):
- [ ] Current state analysis is code-based, not assumed
- [ ] All approaches include honest pros AND cons
- [ ] Effort estimates are realistic (not just optimistic)
- [ ] Recommended approach is justified vs. each alternative
- [ ] Risks have practical mitigation strategies
- [ ] Success metrics are measurable
- [ ] ADR compatibility explicitly checked
- [ ] Uncertainties are clearly stated

**Submission Readiness**:
- ✅ **READY TO SUBMIT**: All checks pass
- ⚠️ **NEEDS REVISION**: [List specific gaps]
- ❓ **NEEDS MORE INFO**: [List specific files/context needed]

**Honesty Check**:
- [ ] I haven't inflated the impact to make this seem more important
- [ ] I haven't downplayed risks to make my recommendation seem better
- [ ] I've acknowledged all uncertainties
- [ ] I've distinguished between what I know vs what I infer

---

## Using Task Tool for Long Research Projects

For substantial research (>30 minutes), use TaskCreate to track progress and provide visibility.

### When to Create Research Tasks

**Use TaskCreate for**:
- Research spanning multiple phases (current state → alternatives → decision)
- Analysis requiring reading >5 files or multiple ADRs
- Investigations needing external reference research
- Complex trade-off analysis with many factors
- Research that may need to pause and resume

### Example: WebSocket Optimization Research

```typescript
// Starting comprehensive research on WebSocket event processing optimization
// This involves current state analysis, industry research, and detailed comparison

<TaskCreate>
{
  "subject": "Research WebSocket event processing optimization",
  "activeForm": "Researching WebSocket optimization approaches",
  "description": "Enhancement Area: Latency Reduction

  Research phases:
  1. Analyze current implementation (services/unified-detector/src/websocket-handler.ts)
  2. Measure/estimate current performance baseline
  3. Research binary protocols (MessagePack, Protocol Buffers)
  4. Research streaming JSON parsers
  5. Research worker thread pools for parsing
  6. Research SIMD/native optimizations
  7. Compare all approaches with trade-off analysis
  8. Make recommendation with implementation plan

  Target: Reduce event processing from ~15ms → <5ms
  Constraints: Free tier, existing architecture, <50ms total latency"
}
</TaskCreate>
```

### Updating Research Progress

```typescript
// After completing Phase 1-2 (current state analysis)
<TaskUpdate>
{
  "taskId": "1",
  "status": "in_progress",
  "metadata": {
    "phase": "Phase 3: Researching alternatives",
    "findings": "Current: 15ms per event, JSON.parse blocks event loop, 1000 events/sec peak"
  }
}
</TaskUpdate>

// After completing all research
<TaskUpdate>
{
  "taskId": "1",
  "status": "completed",
  "metadata": {
    "recommendation": "Worker thread pool for JSON parsing",
    "confidence": "HIGH",
    "expected_impact": "15ms → 3ms (80% reduction)"
  }
}
</TaskUpdate>
```

### Don't Create Tasks For

- Quick research (<15 minutes)
- Single-file analysis
- Straightforward questions with obvious answers
- Research you can complete in one uninterrupted session

**Remember**: Tasks provide visibility to the user and help you organize complex research with multiple phases.
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

### Latency Optimization

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

### Gas Optimization

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

### MEV Protection

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

### Observability Enhancement

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

### New Chain Integration

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
