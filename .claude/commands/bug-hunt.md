---
description: Find bugs, missing features, and code issues in the arbitrage project
---

# Bug Hunt & Missing Feature Analysis

## Prompt Template

Use this prompt to identify bugs, missing features, and potential issues in the codebase:

```
### Model Capabilities (Opus 4.5)
You are running on Claude Opus 4.5 with advanced reasoning capabilities:
- **Extended Reasoning**: Engage in deep, multi-step causal analysis for complex bugs
- **Large Context**: Hold multiple files in mind simultaneously for comprehensive analysis
- **Pattern Recognition**: Identify subtle patterns and inconsistencies across the codebase
- **Self-Critique**: Validate your own reasoning and challenge your conclusions
- **Uncertainty Handling**: Articulate nuanced positions rather than forcing binary answers

**Use these capabilities actively**. For P0/P1 bugs, demonstrate your reasoning process.

### Role & Expertise
You are a senior blockchain developer and security auditor specializing in:
- DeFi arbitrage systems and MEV protection
- Multi-chain architecture (EVM + Solana)
- Real-time event processing with Redis Streams
- High-performance TypeScript/Node.js systems

### Context
This is a professional multi-chain arbitrage trading system with:
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **DEXs**: 44+ across all chains
- **Architecture**: Partitioned detectors, Redis Streams, WebSocket event processing
- **Key Modules**: Execution engine, Cross-chain detector, Coordinator, Risk management

### ⚡ CRITICAL PERFORMANCE REQUIREMENT
> **Hot-path latency target: <50ms** (price-update → detection → execution)

The following modules are in the HOT PATH and are extremely latency-sensitive:
- `shared/core/src/price-matrix.ts` - L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` - Opportunity detection
- `services/execution-engine/` - Trade execution
- `services/unified-detector/` - Event processing
- WebSocket handlers - Event ingestion

**Performance bugs in hot-path code are P0 (Critical)**.

### Critical Rules (Anti-Hallucination)
- **NEVER** report a bug unless you can point to the exact line(s) causing it
- **NEVER** assume code behavior without tracing the actual implementation
- **IF** you need to see related code to verify, ASK to see it first
- **IF** something looks suspicious but you can't prove it, label as "NEEDS VERIFICATION"
- **PREFER** under-reporting to over-reporting (false positives waste developer time)
- **ALWAYS** check if a pattern exists elsewhere in the codebase before flagging

### Critical Rules (Performance Bugs)
- **ALWAYS** flag blocking operations in hot-path code (sync I/O, unbounded loops)
- **ALWAYS** flag O(n) searches in hot paths (array.find, array.filter) → should use Map/Set
- **ALWAYS** flag unnecessary allocations in tight loops (spread operators, new objects)
- **FLAG** any pattern that could regress the <50ms latency target
- **Performance bugs in hot-path modules are automatically P0**

### Analysis Process (Deep Reasoning Required)
For each potential bug, engage in extended reasoning. **Use explicit thinking blocks for P0/P1 bugs.**

<thinking>
**Step 1: Understand Intent**
- What is this code trying to accomplish?
- Trace the function signature and return type
- Identify the purpose from context, naming, and related code
- Check for related ADRs, comments, or documentation
- Why was this pattern chosen? (check git history if needed)

**Step 2: Trace Data Flow**
- Map ALL input sources (parameters, globals, state, async operations, events)
- Track transformations through the entire execution path
- Identify all side effects and state mutations
- Follow outputs to ALL consumers (who uses this data?)
- Check for timing dependencies (does order matter?)

**Step 3: Identify Assumptions**
- List implicit preconditions (what MUST be true for this to work?)
- Identify type assumptions (nullable? array length? numeric range?)
- Note timing/ordering dependencies (race conditions possible?)
- Document state assumptions (initialization? cleanup?)
- Identify external dependencies (network? filesystem? database?)

**Step 4: Find Violations**
- Where could assumptions be violated?
  * Edge cases: null, undefined, 0, empty, max values
  * Concurrent access patterns (multiple async operations)
  * Error conditions (network failure, timeout, invalid data)
  * Resource exhaustion (memory, connections, file handles)
  * Timing issues (out-of-order events, delays)

**Step 5: Verify Pattern**
- Search for similar patterns in the codebase
- Compare implementations across files/modules
- Check if differences are intentional (comments, ADRs)
- Identify if this is a known anti-pattern or performance optimization
- Consult docs/agent/code_conventions.md for project patterns

**Step 6: Assess Impact**
- What's the worst case if this fails?
  * Financial impact (profit calculation errors, loss of funds)
  * System stability (crashes, memory leaks, deadlocks)
  * Data integrity (state corruption, inconsistency)
  * Security (unauthorized access, data leaks)
- Frequency: How often could this trigger? (rare edge case vs common path)
- Detectability: Would this be obvious or silent?
</thinking>

**IMPORTANT**:
- For P0/P1 bugs: You MUST show your reasoning process in thinking blocks
- For P2/P3: You can abbreviate the reasoning but still verify thoroughly
- If uncertain at any step: ASK for more context rather than guessing

### Task
Analyze the following code/module for:

1. **Critical Bugs (P0)**
   - Race conditions in async operations
   - Memory leaks in event handlers
   - Incorrect arithmetic (especially fee calculations, profit margins)
   - Unhandled promise rejections
   - WebSocket connection leaks

2. **Functional Bugs (P1)**
   - Incorrect business logic
   - Edge cases not handled (zero amounts, negative values)
   - Type coercion issues (`||` vs `??` for numeric values)
   - Missing error handling
   - Incorrect event parsing

3. **Missing Features (P2)**
   - Gaps compared to ADR specifications (docs/architecture/adr/)
   - Missing validation or sanitization
   - Incomplete error recovery
   - Missing observability (logs, metrics, health checks)

4. **Code Quality (P3)**
   - Violation of TDD principles
   - Missing test coverage for edge cases
   - Code duplication that could cause drift
   - Inconsistent patterns vs. existing codebase

### Code to Analyze
[PASTE TARGET CODE HERE]

### Reference Files (if applicable)
- Implementation Plan: docs/IMPLEMENTATION_PLAN.md
- ADRs: docs/architecture/adr/
- Code conventions: docs/agent/code_conventions.md

### Expected Output Format
For each issue found, provide:

#### [PRIORITY] Issue Title
**Location**: file:line
**Type**: Bug | Missing Feature | Code Quality
**Confidence**: HIGH | MEDIUM | LOW
- HIGH: I can see the exact code path causing this issue
- MEDIUM: Pattern matches known bug category but needs verification
- LOW: Potential issue based on code smell, may be intentional
**Impact**: Description of what could go wrong
**Evidence**: Code snippet showing the problem
**Fix**: Specific code change to resolve
**Regression Test**: Test case to prevent recurrence

### What NOT to Report (Reduce Noise)
- Style preferences that don't affect correctness
- Performance optimizations without measured bottlenecks
- Refactoring suggestions unrelated to bugs
- Issues in test files (unless they cause false passes)
- Duplicate issues (consolidate related problems)
- Speculative issues without concrete evidence

### Handling Uncertainty (Critical Skill)

**NEVER GUESS**. When uncertain, use these strategies:

---

#### Uncertainty Type 1: Missing Information

**Scenario**: You can't verify a bug without seeing related code.

**Response Pattern**:
```
"I need to see [specific file/function] to verify if [specific assumption] is correct.

Specifically, I need to check:
- [What you'll look for, item 1]
- [What you'll look for, item 2]
- [What you'll look for, item 3]

Without this information, I cannot confirm if this is a bug or false positive."
```

**Example**:
```
"I need to see shared/core/src/redis-client.ts to verify if connection cleanup is handled correctly.

Specifically, I need to check:
- Whether disconnect() is called in the destructor
- If there's a connection pool with its own cleanup
- If there's a global shutdown handler

Without this, I cannot confirm if this is a memory leak or if cleanup is handled elsewhere."
```

**DO**: Request specific files with specific things you'll verify
**DON'T**: Say "I need more context" without specifics

---

#### Uncertainty Type 2: Ambiguous Design Intent

**Scenario**: Pattern could be a bug OR intentional optimization/workaround.

**Response Pattern**:
```
"Pattern X at [location] could be:
A) A bug: [what's wrong if it's a bug]
B) Intentional: [why it might be intentional]

I see it in [N] places: [list locations]

To determine which:
- [ ] Check for explanatory comments at these locations
- [ ] Search ADRs for mentions of [pattern]
- [ ] Look for tests that depend on this behavior

MARKING AS: NEEDS VERIFICATION until intent is clear."
```

**Example**:
```
"Using || instead of ?? for numeric values at 3 locations could be:
A) A bug: Zero values incorrectly fall back to default
B) Intentional: Zero is treated as invalid/unset by design

Locations:
- execution-engine.ts:92
- fee-calculator.ts:156
- profit-estimator.ts:203

To determine which:
- [ ] Check if any tests use zero values
- [ ] Check comments explaining why || was chosen
- [ ] Search for similar patterns in proven-correct code

MARKING AS: NEEDS VERIFICATION - User: Is zero a valid value for fees in this system?"
```

**DO**: Present both possibilities with evidence
**DON'T**: Pick one arbitrarily without verification

---

#### Uncertainty Type 3: Edge Case Uncertainty

**Scenario**: Code handles cases A and B, unsure if case C can occur.

**Response Pattern**:
```
"Code handles [case A] and [case B], but I'm uncertain if [case C] can occur.

To verify [case C] is possible:
- [ ] Trace upstream code to see if C can be generated
- [ ] Check tests for C scenarios
- [ ] Review validation logic that might prevent C

Current assessment:
- If C is possible: [this is a bug]
- If C is impossible: [this is correct]

Confidence: LOW until upstream code verified."
```

**Example**:
```
"Code handles null and undefined, but I'm uncertain if empty array [] can occur.

To verify [] is possible:
- [ ] Trace calling code: dex.getLiquidityPools()
- [ ] Check if API can return [] vs null for "no pools"
- [ ] Look for validation that converts [] to null

Current assessment:
- If [] is possible: Missing edge case (BUG)
- If [] is impossible: Current handling is correct

Confidence: LOW - Need to see dex adapter implementation."
```

**DO**: Outline verification steps
**DON'T**: Report as confirmed bug without verification

---

#### Uncertainty Type 4: Confident but Not Certain

**Scenario**: Strong evidence of bug, but small possibility you're wrong.

**Response Pattern**:
```
[P1] [Bug Title]
**Confidence**: MEDIUM

**Evidence**: [strong evidence you have]

**Why MEDIUM not HIGH**:
- Uncertainty: [what you're not 100% sure about]
- Could be wrong if: [scenario that would invalidate your finding]
- To increase confidence: [what would make you certain]

**Recommendation**: [Treat as bug / Verify before fixing]
```

**Example**:
```
[P1] Race Condition in Price Update Handler
**Confidence**: MEDIUM

**Evidence**:
- Two async handlers modify priceMap without locking
- No Atomics used (verified in code)
- Map.set() is not atomic across event loop ticks

**Why MEDIUM not HIGH**:
- Uncertainty: There might be external synchronization I haven't seen
- Could be wrong if: There's a Redis-based lock in coordinator.ts
- To increase confidence: Verify no external locking mechanisms exist

**Recommendation**: Treat as bug, but check for external locking first.
```

**DO**: Explain why confidence isn't higher
**DON'T**: Claim HIGH confidence when you have doubts

---

### Decision Tree: When to Report vs. Investigate Further

```
Found potential issue
        |
        ├─ Can I point to exact problematic code?
        │   NO → INVESTIGATE (read more files)
        │   YES ↓
        │
        ├─ Do I understand why it's a problem?
        │   NO → INVESTIGATE (trace data flow)
        │   YES ↓
        │
        ├─ Could this be intentional?
        │   YES → Check comments/ADRs/tests
        │         Still uncertain? → NEEDS VERIFICATION
        │         Confirmed bug? → REPORT (HIGH confidence)
        │   NO ↓
        │
        ├─ Have I verified with actual code?
        │   NO → INVESTIGATE (don't speculate)
        │   YES ↓
        │
        └─ REPORT (HIGH confidence)
```

---

### Confidence Level Calibration

**HIGH (90-100%)**:
- I've seen the exact problematic code
- I've traced the full data flow
- I've verified edge cases fail
- I've checked it's not intentional
- I can write a failing test case

**MEDIUM (70-89%)**:
- Strong evidence but minor uncertainties
- Pattern matches known bug categories
- Haven't seen all related code
- Could be edge case I'm missing

**LOW (50-69%)**:
- Based on code smell, not proven failure
- Haven't traced complete data flow
- Might be intentional design
- Would need more investigation to confirm

**NEEDS VERIFICATION (<50%)**:
- Suspicious but can't prove it's wrong
- Need specific information to verify
- Multiple interpretations possible

---

### Examples of Good Uncertainty Handling

**Good ✅**:
```
**Confidence**: MEDIUM
"This looks like a race condition, but I haven't verified if the coordinator uses external locking. Need to check coordinator.ts:180-200 for mutex usage before confirming."
```

**Bad ❌**:
```
**Confidence**: HIGH
"This is definitely a race condition." [without checking for external locking]
```

**Good ✅**:
```
"This pattern appears in 3 places. Need to verify: Is this a known performance optimization (check ADR-005) or an anti-pattern?"
```

**Bad ❌**:
```
"This is wrong, report as bug." [without checking if intentional]
```

---

### Remember: False Positives Harm Trust

- **One well-verified bug > Five speculative bugs**
- **Admitting uncertainty shows thoroughness, not weakness**
- **Users appreciate honesty over false confidence**

**When in doubt**: Mark as NEEDS VERIFICATION and ask specific questions.

---

## Using Task Tool for Complex Bug Investigations

For investigations that span multiple files or require systematic verification, use the Task tool to track progress.

### When to Create Tasks

**Use TaskCreate for**:
- Investigations spanning >3 files or >15 minutes
- Bugs requiring reproduction steps across multiple modules
- Analysis requiring verification from multiple code paths
- Suspected race conditions (need to trace all concurrent access points)
- Memory leak investigations (need to check all allocation/cleanup pairs)
- Cross-module issues (detector → coordinator → execution-engine)

**Example Scenario**: Found potential race condition in SharedArrayBuffer

```typescript
// Found: Possible race condition in shared/core/src/price-matrix.ts:234-248
// This requires systematic verification across multiple worker threads

<TaskCreate>
{
  "subject": "Verify race condition in SharedArrayBuffer price updates",
  "activeForm": "Verifying race condition in price updates",
  "description": "Investigate potential race condition in shared/core/src/price-matrix.ts:234-248.

  Verification steps:
  1. Trace all write paths to SharedArrayBuffer (find all Atomics.store calls)
  2. Check if Atomics are used consistently (or if some writes are non-atomic)
  3. Review concurrent access patterns from worker threads (check worker thread spawning)
  4. Test if race condition is possible under load (review stress test scenarios)
  5. Check ADR-005 (Hierarchical Cache) for intentional design
  6. Determine: Bug exists OR false positive

  Priority: P0 (hot-path, data corruption risk)
  Confidence: MEDIUM (need full verification)"
}
</TaskCreate>
```

### Task Updates During Investigation

Update the task as you progress:

```typescript
// After checking step 1-2
<TaskUpdate>
{
  "taskId": "1",
  "status": "in_progress",
  "metadata": {
    "findings": "Found 3 write paths, all use Atomics.store - looking good so far"
  }
}
</TaskUpdate>

// After completing investigation
<TaskUpdate>
{
  "taskId": "1",
  "status": "completed",
  "metadata": {
    "conclusion": "FALSE POSITIVE - All accesses properly use Atomics, ADR-005 confirms design",
    "confidence": "HIGH"
  }
}
</TaskUpdate>
```

### Don't Create Tasks For

- Simple, obvious bugs fully verified in <5 minutes
- Single-file quick checks
- Style/formatting issues
- Issues already fully understood from one code read

**Remember**: Tasks are for YOUR benefit (tracking complex work) and USER visibility (showing progress on deep investigations).
```

---

## Few-Shot Examples

### Example 1: HIGH Confidence Bug (P1)

```markdown
#### [P1] Incorrect Fee Handling for 0% Fee DEXs
**Location**: services/execution-engine/src/execution-engine.ts:924
**Type**: Bug
**Confidence**: HIGH
**Impact**: DEXs with 0% fee (e.g., promotional pools, some Uniswap V3 pools) would incorrectly use default 0.3% fee, causing wrong profit calculation. Could reject profitable opportunities or accept unprofitable ones.
**Evidence**:
```typescript
const fee = dexConfig.fee || 0.003; // BUG: 0 is falsy, falls back to 0.3%
```
**Fix**:
```typescript
const fee = dexConfig.fee ?? 0.003; // CORRECT: only fallback for undefined/null
```
**Regression Test**:
```typescript
it('should use 0% fee when DEX fee is explicitly 0', () => {
  const dexConfig = { fee: 0, name: 'promotional-pool' };
  const result = calculateProfit(dexConfig, swap);
  expect(result.feeApplied).toBe(0);
});
```
```

### Example 2: MEDIUM Confidence Bug (P0)

```markdown
#### [P0] Potential Race Condition in Cross-Chain Price Update
**Location**: shared/core/src/partitioned-detector.ts:234-248
**Type**: Bug
**Confidence**: MEDIUM
**Impact**: If two chains emit price updates simultaneously, the Map iteration in findCrossChainDiscrepancies could see inconsistent state mid-update. Could cause missed arbitrage opportunities or false positive signals.
**Evidence**:
```typescript
// Iterating over Map while other async handlers may modify it
for (const [chainId, prices] of this.pricesByChain) {
  // ... comparison logic
}
```
**Fix**:
```typescript
// Snapshot the Map before iteration
const priceSnapshot = new Map(this.pricesByChain);
for (const [chainId, prices] of priceSnapshot) {
  // ... comparison logic
}
```
**Regression Test**:
```typescript
it('should handle concurrent price updates without race condition', async () => {
  const updates = chains.map(c => detector.updatePrice(c, price));
  await Promise.all(updates);
  // Verify no missed comparisons
});
```

**Note**: MEDIUM confidence because I need to verify if updates are truly concurrent or serialized by the event loop. Check if there are any await points in the price update handlers.
```

### Example 3: NEEDS VERIFICATION

```markdown
#### [P1] Possible Missing Consumer Group Acknowledgment
**Location**: services/coordinator/src/coordinator.ts:~180
**Type**: NEEDS VERIFICATION
**Confidence**: LOW
**Impact**: If messages are not acknowledged after processing, they will be re-delivered on restart, potentially causing duplicate execution.
**Evidence**:
I see xreadgroup calls but need to verify xack is called after successful processing.
**Request**: Please show me the full message processing loop including any xack calls.
```

---

## Quick Checklist for Common Issues

Run this mental checklist for every module:

### Fee & Calculation Bugs
- [ ] Using `??` instead of `||` for numeric values that could be 0
- [ ] Fee calculations in basis points (not percentages)
- [ ] NET profit calculation (revenue - fees - gas)
- [ ] Decimal handling (USDT/USDC: 6 decimals, except BSC: 18)

### Async/Concurrency Issues
- [ ] Promise.all with proper error handling
- [ ] Mutex/lock for shared state modifications
- [ ] Shutdown guards to prevent duplicate cleanup
- [ ] Event listener cleanup on destroy

### WebSocket & Connection Issues
- [ ] Reconnection with exponential backoff
- [ ] Connection health checks before operations
- [ ] Graceful degradation when connection fails
- [ ] Proper error event handling

### Redis Streams
- [ ] Consumer group creation before reading
- [ ] Message acknowledgment (xack) after processing
- [ ] Stream lag monitoring
- [ ] Batch processing with proper batching ratio

### Cross-Chain
- [ ] Token address normalization (same token, different addresses)
- [ ] Chain ID validation before cross-chain operations
- [ ] Timestamp synchronization across chains

### Performance (Hot-Path)
- [ ] No `array.find()` or `array.filter()` in hot paths → use Map/Set
- [ ] No spread operators (`...`) in tight loops → mutate instead
- [ ] No `JSON.parse()`/`JSON.stringify()` in hot paths → use cached/binary
- [ ] No sync I/O in event handlers (`fs.readFileSync`, etc.)
- [ ] No unbounded loops (`while(true)` without yield)
- [ ] SharedArrayBuffer used correctly with Atomics

---

## Targeted Analysis Commands

### Find O(n) array searches in hot paths (should be Map/Set)
// turbo
```bash
grep -rn "\.find\(\|\.filter\(" shared/core/src/ services/execution-engine/ services/unified-detector/ --include="*.ts" | grep -v test
```

### Find spread operators in loops (performance anti-pattern)
// turbo
```bash
grep -rn "\.\.\..*\(for\|while\|map\|forEach\)" shared/core/src/ services/execution-engine/ --include="*.ts" | grep -v test
```

### Find sync I/O in hot paths
// turbo
```bash
grep -rn "Sync\(" shared/core/src/ services/ --include="*.ts" | grep -v test | grep -v node_modules
```

---

### Find potential || vs ?? issues
// turbo
```bash
grep -rn "|| 0" services/ shared/ --include="*.ts" | grep -v test | grep -v node_modules
```

### Find potential || vs ?? for booleans
// turbo
```bash
grep -rn "|| false" services/ shared/ --include="*.ts" | grep -v test | grep -v node_modules
```

### Find unhandled promise patterns
// turbo
```bash
grep -rn "\.then(" services/ shared/ --include="*.ts" | grep -v ".catch" | grep -v test
```

### Find event listeners that might leak
// turbo
```bash
grep -rn "\.on(" services/ shared/ --include="*.ts" | grep -v "removeListener" | grep -v test | head -20
```

### Find hardcoded values that should be config
// turbo
```bash
grep -rn -E "[0-9]{4,}" services/ shared/ --include="*.ts" | grep -v test | grep -v ".d.ts" | grep -v node_modules | head -20
```

---

## Systematic Verification Protocol (REQUIRED Before Submission)

Complete this multi-phase verification before submitting your analysis:

### Phase 1: Individual Finding Verification
For EACH finding you've identified, perform this verification:

<verification>
**Finding ID**: [e.g., P0-001]
**Claim**: [Brief description of the bug]

**1. Evidence Check**:
- [ ] I have quoted the exact code causing the issue (not paraphrased)
- [ ] I have provided file path with specific line numbers
- [ ] The code snippet is sufficient to understand the problem in isolation
- [ ] I have verified this code exists in the current version (not outdated)

**2. Logic Check**:
- [ ] I traced the complete data flow (not just the immediate function)
- [ ] I verified my understanding with actual code (not assumptions)
- [ ] I checked if this pattern exists elsewhere in the codebase
- [ ] I confirmed whether differences are intentional (checked comments/ADRs)
- [ ] I can explain WHY this is a bug (root cause, not just symptoms)

**3. Impact Check**:
- [ ] I can articulate the specific failure scenario with concrete examples
- [ ] I have considered all edge cases (null, 0, empty, concurrent access)
- [ ] My severity rating (P0/P1/P2/P3) matches the actual impact
- [ ] I've assessed frequency: How often could this trigger?
- [ ] I've assessed detectability: Would this be obvious or silent?

**4. False Positive Check**:
- [ ] This is NOT intentional design (checked for explanatory comments)
- [ ] This is NOT a documented performance optimization pattern
- [ ] This is NOT a test-only pattern (checked file location)
- [ ] This is NOT a temporary workaround with a TODO (checked comments)
- [ ] This is NOT a pattern from docs/agent/code_conventions.md

**5. Fix Quality Check**:
- [ ] My proposed fix actually solves the problem (not just a workaround)
- [ ] My fix handles all identified edge cases
- [ ] My fix doesn't introduce new bugs (verified with reasoning)
- [ ] My fix is syntactically correct and could be applied directly
- [ ] My regression test would actually catch this bug if it recurs

**Verification Result**: ✅ PASS / ⚠️ NEEDS_REVIEW / ❌ DISCARD

**Reason**: [If NEEDS_REVIEW or DISCARD, explain specific concerns]
</verification>

**Repeat this verification for every finding**. Don't skip this step.

---

### Phase 2: Cross-Finding Validation
After verifying all individual findings:

**Consistency Checks**:
- [ ] No duplicate findings (same bug reported twice)
- [ ] Findings don't contradict each other (check for conflicting claims)
- [ ] Confidence levels are consistent with evidence quality
- [ ] NEEDS_VERIFICATION items have specific, answerable questions
- [ ] P0 findings are genuinely critical (financial loss, crashes, data corruption)
- [ ] P3 findings are not overinflated in priority

**Pattern Checks**:
- [ ] Similar bugs grouped or cross-referenced appropriately
- [ ] If I found a pattern in one place, did I check all similar locations?
- [ ] If I flagged as anti-pattern, verified it's not a known project pattern

---

### Phase 3: Self-Critique & Confidence Assessment
Force yourself to challenge your analysis:

**Critical Questions**:
1. **What could be wrong with my analysis?**
   [List potential flaws in your reasoning]

2. **What assumptions did I make that might be incorrect?**
   [Identify implicit assumptions]

3. **What would make me change my conclusions?**
   [What evidence would invalidate your findings?]

4. **What didn't I check that I should have?**
   [Acknowledge gaps in your analysis]

**Confidence Scoring**:
- **Total Findings**: [count]
- **High Confidence (PASS)**: [count] — should be >70% for good analysis
- **Needs Review**: [count] — should be <20%
- **Discarded After Review**: [count] — it's OK to discard false positives
- **Needs Verification**: [count] — should be <10%

**If your ratios are outside these ranges**: Reconsider your analysis depth or be more conservative with confidence levels.

---

### Phase 4: Final Submission Decision

**Quality Gates** (all must pass):
- [ ] Each issue has specific file:line references
- [ ] Each issue includes actual problematic code evidence
- [ ] All fixes are syntactically correct and implementable
- [ ] Confidence levels are honest and justified
- [ ] NEEDS VERIFICATION issues are truly unresolvable without more info
- [ ] I've documented my reasoning process for P0/P1 bugs

**Submission Readiness**:
- ✅ **READY TO SUBMIT**: All checks pass, confidence is appropriate
- ⚠️ **NEEDS REVISION**: [List specific issues to address]
- ❓ **NEEDS MORE INFO**: [List specific files/context required]

**If NEEDS REVISION or NEEDS MORE INFO**: Address concerns before submitting.

---

### Phase 5: Honesty Check
Final integrity verification:

- [ ] I have not inflated severity to seem more thorough
- [ ] I have not reported speculative issues as confirmed bugs
- [ ] I have acknowledged all uncertainties explicitly
- [ ] I have not claimed to verify things I didn't actually check
- [ ] If I'm unsure, I said "NEEDS VERIFICATION" rather than guessing

**Remember**: False positives waste developer time. It's better to under-report than over-report.

---

## Usage Examples

### Example 1: Analyze a specific service
```
[Use the prompt template above with:]

### Code to Analyze
[services/execution-engine/src/execution-engine.ts]

### Focus Areas
- Fee calculation accuracy
- Transaction simulation validation
- Gas estimation edge cases
```

### Example 2: Analyze cross-chain interactions
```
[Use the prompt template above with:]

### Code to Analyze
[shared/core/src/partitioned-detector.ts]
[shared/core/src/cross-chain-analyzer.ts]

### Focus Areas
- Race conditions in findCrossChainDiscrepancies
- Price staleness detection
- Partition boundary handling
```

### Example 3: Security-focused analysis
```
[Use the prompt template above with:]

### Code to Analyze
[services/execution-engine/src/flashloan-executor.ts]
[shared/core/src/transaction-builder.ts]

### Focus Areas
- Reentrancy vulnerabilities
- Input validation
- Slippage protection
- Maximum exposure limits
```

---

## Follow-up Actions

After running bug hunt, prioritize fixes by:

1. **P0 (Immediate)**: Could cause financial loss or system crash
2. **P1 (This Sprint)**: Affects core functionality
3. **P2 (Backlog)**: Nice to have, not urgent
4. **P3 (Tech Debt)**: Track in docs/todos.md

For each fix:
// turbo
1. Write failing test first (TDD)
```bash
npm test -- --testNamePattern="[bug-name]"
```
// turbo
2. Implement minimal fix and verify
```bash
npm run typecheck && npm test
```
3. Create regression test
4. Update docs/IMPLEMENTATION_PLAN.md if applicable

---

## Cross-Reference: Known Patterns in This Codebase

These patterns are CORRECT in this codebase (don't flag as bugs):

| Pattern | Location | Reason |
|---------|----------|--------|
| `fee ?? 0.003` | execution-engine.ts | Proper nullish coalescing for fees |
| `Object.assign({}, state)` | partitioned-detector.ts | Snapshot for iteration safety |
| `Atomics.store/load` | price-matrix.ts | Thread-safe SharedArrayBuffer access |
| `xack after processing` | coordinator.ts | Proper stream acknowledgment |
| `exponential backoff` | websocket-manager.ts | Reconnection strategy |
