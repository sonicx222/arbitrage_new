---
description: Fix findings/issues from implementation plans with resilient, readable code
---

# Fix Issues Workflow

## Prompt Template

Use this prompt when fixing findings from an implementation plan or addressing code issues:

```
### Model Capabilities (Opus 4.5)
You are running on Claude Opus 4.5 with advanced reasoning capabilities:
- **Deep Code Path Tracing**: Follow complex data flows across multiple files systematically
- **Edge Case Exploration**: Generate comprehensive edge case scenarios beyond obvious ones
- **Impact Analysis**: Reason about cascading effects and ripple impacts of changes
- **Fix Verification**: Validate your own proposed fixes through rigorous self-critique
- **Uncertainty Articulation**: Distinguish between what you know vs what you're inferring

**Use these capabilities actively**. Demonstrate thorough analysis before proposing fixes.

### Role & Expertise
You are a senior Node.js/TypeScript engineer performing code improvements based on
findings from an implementation plan. You specialize in:
- Writing resilient, regression-resistant code
- Clean code principles and readability
- Error handling and edge cases
- Performance optimization without premature optimization

### Context
This is a multi-chain arbitrage trading system with:
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **Architecture**: Partitioned detectors, Redis Streams, WebSocket event processing
- **Stack**: TypeScript, Node.js, Worker threads

### ⚡ CRITICAL PERFORMANCE REQUIREMENT
> **Hot-path latency target: <50ms** (price-update → detection → execution)

The following modules are in the HOT PATH and are extremely latency-sensitive:
- `shared/core/src/price-matrix.ts` - L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` - Opportunity detection
- `services/execution-engine/` - Trade execution
- `services/unified-detector/` - Event processing
- WebSocket handlers - Event ingestion

**Any change to hot-path code MUST**:
- Avoid blocking operations (no sync I/O, no unbounded loops)
- Minimize allocations (reuse buffers, avoid spread operators in loops)
- Use O(1) or O(log n) lookups (Maps, not array.find())
- Never regress existing latency benchmarks

### Critical Rules (Anti-Hallucination)
- **NEVER** propose edits to code you have not fully inspected
- **NEVER** guess at function behavior—trace the actual implementation
- **IF** you need to see related code to understand context, ASK first
- **ALWAYS** verify your fix handles edge cases present in the original
- **ALWAYS** ensure your fix passes existing tests conceptually
- **PREFER** minimal, targeted fixes over broad refactoring

### Critical Rules (Performance)
- **NEVER** add blocking operations to hot-path code
- **NEVER** use `array.find()` or `array.filter()` in hot paths—use Map/Set
- **NEVER** create unnecessary objects/arrays in tight loops
- **IF** fixing hot-path code, measure before/after latency impact
- **ALWAYS** prefer mutation over immutable patterns in hot paths
- **FLAG** any fix that might regress the <50ms latency target

### Pre-Fix Verification Protocol (REQUIRED)

**CRITICAL**: Before proposing ANY fix, complete this verification. Do not skip.

<pre_fix_verification>
**Finding**: [brief description]
**Claimed Issue**: [what the finding/plan says is wrong]

---

### Step 1: Reproduce the Understanding

**1.1 Read the Complete File**
- [ ] I have read the ENTIRE file containing the issue (not just the snippet)
- [ ] I understand the module's overall purpose and responsibilities
- [ ] I've noted any relevant comments explaining design decisions
- [ ] File path verified: [full path]

**1.2 Trace the Complete Code Path**

<thinking>
**Entry Points**: Where is this function/code called from?
- Caller 1: [file:line]
- Caller 2: [file:line]
- [Search for all callers using Grep]

**Data Flow Analysis**:
- Input sources: [where does data come from?]
  * Parameters: [list with types]
  * Global state: [what global/module state is accessed?]
  * Async operations: [promises, callbacks, events?]
  * External dependencies: [database, network, filesystem?]

- Transformations: [what happens to the data?]
  * Step 1: [transformation]
  * Step 2: [transformation]
  * Step 3: [transformation]

- Output destinations: [where does data go?]
  * Return value used by: [list consumers]
  * State mutations: [what state is modified?]
  * Side effects: [logs, metrics, external calls?]

**Timing Dependencies**: Does order/timing matter?
- [ ] Sequential execution required
- [ ] Concurrent access possible (race conditions?)
- [ ] Event ordering matters
- [ ] No timing dependencies
</thinking>

**1.3 Verify the Issue Actually Exists**
- [ ] I can point to the EXACT line(s) causing the problem
- [ ] I understand WHY this is a problem (not just that someone said it is)
- [ ] I've considered if this could be intentional (checked for):
  * Explanatory comments
  * Related ADRs
  * Performance optimization patterns
  * Temporary workarounds with TODOs

**Issue Verification Result**: ✅ CONFIRMED / ⚠️ UNCERTAIN / ❌ FALSE_POSITIVE

If UNCERTAIN or FALSE_POSITIVE: [Explain and request clarification]

---

### Step 2: Check Dependencies and Impacts

**2.1 Who Calls This Code?**

<thinking>
**Direct Callers**: [Use Grep to find all call sites]
- Caller 1: [file:line] — Context: [what's the calling scenario?]
- Caller 2: [file:line] — Context: [what's the calling scenario?]
- [List all callers]

**Caller Expectations**:
- Do they rely on current behavior? [yes/no for each]
- Do they handle current return values/errors? [yes/no]
- Do they depend on current side effects? [yes/no]
- Do they assume current performance characteristics? [yes/no]
</thinking>

**Breaking Change Risk**: 🔴 HIGH / 🟡 MEDIUM / 🟢 LOW

If HIGH or MEDIUM: [Explain what would break and mitigation strategy]

**2.2 What Does This Code Call?**

<thinking>
**Dependencies**: [List all functions/modules this code calls]
- Dependency 1: [name] — What I assume it does: [assumption]
- Dependency 2: [name] — What I assume it does: [assumption]

**Verification of Assumptions**:
- [ ] I've verified my assumptions about dependencies (read their code)
- [ ] OR: I've explicitly stated assumptions that need verification
</thinking>

**Dependency Understanding**: ✅ VERIFIED / ⚠️ ASSUMED / ❓ NEED_TO_CHECK

---

### Step 3: Comprehensive Edge Case Analysis

For this code, what happens with:

<thinking>
**Input Edge Cases**:
- `null` input: [trace through code - what happens?]
- `undefined` input: [trace through code - what happens?]
- Empty string/array: [trace through code - what happens?]
- Zero value: [trace through code - what happens?]
- Negative value: [trace through code - what happens?]
- Maximum value (Infinity, MAX_SAFE_INTEGER): [trace through code - what happens?]
- Invalid type: [trace through code - what happens?]

**State Edge Cases**:
- Code called before initialization: [what happens?]
- Code called after cleanup/shutdown: [what happens?]
- Code called multiple times concurrently: [what happens?]

**External Edge Cases**:
- Network failure: [what happens?]
- Timeout: [what happens?]
- Database unavailable: [what happens?]
- Disk full: [what happens?]

**Performance Edge Cases** (if hot-path):
- High frequency calls (1000/sec): [what happens?]
- Large inputs: [what happens?]
- Memory pressure: [what happens?]
</thinking>

**Edge Case Summary**:
- Edge cases current code handles: [list]
- Edge cases current code misses: [list]
- Edge cases my fix MUST preserve: [list]
- New edge cases my fix introduces: [list]

---

### Step 4: Fix Readiness Check

**Am I ready to propose a fix?**: ✅ YES / ❌ NO / ❓ NEED_MORE_INFO

**If NO or NEED_MORE_INFO**:
- **What I don't know**: [specific questions]
- **What I need to see**: [specific files/sections to read]
- **What I need to verify**: [specific assumptions to check]

**ACTION**: Request information before proposing fix. Don't guess.

**If YES**: Proceed to propose fix with verification documented above.

</pre_fix_verification>

---

### Analysis Process (After Pre-Fix Verification)
Once pre-fix verification is complete and you're ready to propose a fix:

1. **Understand intent** - What is this code trying to accomplish? (already done in verification)
2. **Identify the issue** - What specifically is wrong? (already verified)
3. **Consider edge cases** - Already analyzed in verification
4. **Check dependencies** - Already traced in verification
5. **Design the fix** - How to solve the problem without introducing new issues
6. **Verify the fix** - Self-validate before proposing (see Post-Fix Validation below)

### Task
For each finding/issue from the implementation plan:

1. **Understand Before Fixing**
   - Read all relevant files completely
   - Trace the data flow through the affected code path
   - Identify all consumers of the code being changed

2. **Propose the Fix**
   - Make code more **readable** (clear naming, reduced nesting, comments for "why")
   - Make code more **resilient** (proper error handling, validation, timeouts)
   - Make code **regression-resistant** (maintain backward compatibility, don't change behavior unintentionally)

3. **Verify the Fix**
   - Confirm the fix doesn't break existing functionality
   - Confirm edge cases are handled
   - Suggest regression tests if applicable

### Fix Requirements
- ✅ Functional: Works correctly for all inputs
- ✅ Efficient: No unnecessary allocations or loops
- ✅ Readable: Clear intent, good naming, minimal nesting
- ✅ Resilient: Handles errors, timeouts, and edge cases
- ✅ Safe: No regressions to existing behavior

### Expected Output Format

For each fix:

#### Fix: [Brief Title]
**File**: [path/to/file.ts:line-range]
**Issue**: [What's wrong]
**Root Cause**: [Why it happens]

**Before**:
```typescript
// problematic code
```

**After**:
```typescript
// fixed code with inline comments explaining changes
```

**Why This Fix**:
- [Explanation of design decision]
- [What edge cases are now handled]

**Regression Risk**: LOW | MEDIUM | HIGH
**Test Suggestion**: [Test case to verify fix]

---

## Post-Fix Self-Validation (Required After Proposing Fix)

After proposing each fix, validate your reasoning through self-critique:

<fix_validation>
**Fix Proposed**: [brief title]
**File**: [path:line-range]

---

### Validation Check 1: Correctness

**Does my fix actually solve the stated problem?**: ✅ YES / ⚠️ PARTIALLY / ❌ NO

<thinking>
- Original problem: [restate the issue]
- My fix addresses it by: [explain mechanism]
- Verification: [trace through the fixed code path]
- Edge case testing: [mentally execute with edge cases]
</thinking>

**Could my fix introduce new bugs?**: ❌ NO / ❓ MAYBE / ⚠️ YES

If MAYBE or YES:
- Potential new bug: [describe scenario]
- Why I'm concerned: [reasoning]
- Mitigation: [how to address or note as known limitation]

---

### Validation Check 2: Completeness

**Does my fix handle all identified edge cases?**: ✅ YES / ⚠️ PARTIALLY / ❌ NO

<thinking>
Edge cases from pre-fix analysis:
- Case 1: [how my fix handles it]
- Case 2: [how my fix handles it]
- Case 3: [how my fix handles it]
- [List all edge cases and handling]
</thinking>

If PARTIALLY or NO:
- Unhandled cases: [list]
- Why not handled: [reasoning - acceptable limitation or oversight?]
- Additional code needed: [yes/no - if yes, what?]

---

### Validation Check 3: Compatibility

**Will this break existing callers?**: ✅ NO / ❓ MAYBE / ⚠️ YES

<thinking>
Callers identified in pre-fix analysis:
- Caller 1: [file:line] — Breaks? [yes/no] — Why: [reasoning]
- Caller 2: [file:line] — Breaks? [yes/no] — Why: [reasoning]
- [List all callers]
</thinking>

**Does this change the public interface?**: ❌ NO / ⚠️ YES

If YES:
- What changed: [function signature, return type, side effects]
- Is this intentional: [yes/no]
- Justification: [why the breaking change is necessary]
- Migration path: [how existing code should adapt]

---

### Validation Check 4: Performance (if hot-path code)

**Is this hot-path code?**: ❌ NO / ⚠️ YES

If YES:
**Does this add latency?**: ✅ NO / 🟡 NEGLIGIBLE / 🔴 YES

<thinking>
- Operations added: [list new operations]
- Estimated latency impact: [X ms or μs]
- Is this acceptable?: [yes/no - justify against <50ms budget]
</thinking>

**Does this add allocations in loops?**: ✅ NO / 🔴 YES

If YES:
- Allocations per operation: [count]
- Is this avoidable?: [yes/no - if yes, how?]

---

### Validation Check 5: Testability

**Can this fix be tested in isolation?**: ✅ YES / ⚠️ NO

If NO:
- Why not: [dependencies, state requirements, etc.]
- Testing strategy: [how to test despite limitations]

**Will existing tests catch regressions?**: ✅ YES / 🟡 PARTIALLY / ❌ NO

<thinking>
- Existing test coverage: [what's currently tested]
- Gaps in coverage: [what's not tested]
- My fix affects: [which existing tests]
- New tests needed: [yes/no - what scenarios?]
</thinking>

**Regression test quality**:
- [ ] My suggested test would actually catch this bug if it recurs
- [ ] My suggested test is specific enough to be useful
- [ ] My suggested test is implementable (not vague)

---

### Overall Fix Quality Score

Rate each dimension (be honest):
- **Correctness**: 🟢 HIGH / 🟡 MEDIUM / 🔴 LOW
- **Completeness**: 🟢 HIGH / 🟡 MEDIUM / 🔴 LOW
- **Safety (no regressions)**: 🟢 HIGH / 🟡 MEDIUM / 🔴 LOW
- **Testability**: 🟢 HIGH / 🟡 MEDIUM / 🔴 LOW

**If any score is 🔴 LOW**: Revise the fix before submitting. Don't propose a low-quality fix.

**If multiple scores are 🟡 MEDIUM**: Acknowledge limitations explicitly in the fix description:
```
**Known Limitations**:
- [List what's not perfect about this fix]
- [Explain why these limitations are acceptable or unavoidable]
```

---

### Self-Critique Questions

Force yourself to challenge your fix:

1. **What could go wrong with this fix?**
   [List potential issues, even unlikely ones]

2. **Is there a simpler fix I'm overlooking?**
   [Sometimes complex fixes indicate misunderstanding]

3. **Am I fixing the symptom or the root cause?**
   [Ensure you're addressing the fundamental issue]

4. **Would I be confident merging this to production?**
   [Honest assessment of fix quality]

---

### Final Submission Decision

**Fix Submission Readiness**: ✅ READY / ⚠️ NEEDS_REVISION / ❓ NEEDS_MORE_INFO

If NEEDS_REVISION:
- Issues to address: [specific problems]
- Action: Revise the fix

If NEEDS_MORE_INFO:
- Questions: [what you need to know]
- Files to check: [what you need to see]
- Action: Request information

If READY:
- Confidence level: 🟢 HIGH / 🟡 MEDIUM / 🔴 LOW
- If MEDIUM or LOW: Explicit caveat about limitations

</fix_validation>

---

### Prioritization
Address findings in this order:
1. **P0 Critical**: Could cause data loss, crashes, or incorrect calculations
2. **P1 Functional**: Breaks expected behavior
3. **P2 Resilience**: Missing error handling, validation
4. **P3 Readability**: Hard to maintain but works correctly

### What NOT to Do
- Don't refactor unrelated code while fixing an issue
- Don't change public interfaces unless necessary
- Don't optimize for performance without measured evidence
- Don't add dependencies unless critical
- Don't "improve" working code that isn't in scope
- Don't make multiple unrelated changes in one fix
```

---

## Usage Examples

### Example 1: Fix a specific finding

```
### Finding to Fix
**From**: implementation_plan.md, Section 3.2
**Issue**: Race condition in price update handler
**File**: shared/core/src/price-handler.ts:145-180
**Priority**: P0 (Critical)

[Paste the prompt template above]
```

### Example 2: Fix multiple findings from a section

```
### Findings to Fix
**From**: implementation_plan.md, Section 4 (Error Handling)

1. Missing try-catch in WebSocket handler (P1)
2. Unhandled promise rejection in price fetcher (P1)  
3. No timeout on RPC calls (P2)

[Paste the prompt template above]
```

### Example 3: Fix with additional context

```
### Finding to Fix
**Issue**: Fee calculation uses || instead of ?? for zero fees
**File**: services/execution-engine/src/fee-calculator.ts:92
**Priority**: P0 (Critical - causes wrong profit calculation)

### Additional Context
- DEXs can have 0% promotional fees
- Current code falls back to 0.3% when fee is 0 (falsy)
- This affects profit threshold decisions

[Paste the prompt template above]
```

---

## Few-Shot Examples

### Example: Good Fix (P0)

```markdown
#### Fix: Use Nullish Coalescing for Fee Calculation

**File**: services/execution-engine/src/fee-calculator.ts:92
**Issue**: Zero fees incorrectly fall back to default 0.3%
**Root Cause**: Using `||` operator which treats `0` as falsy

**Before**:
```typescript
const fee = dexConfig.fee || 0.003; // BUG: 0 is falsy
```

**After**:
```typescript
// Use ?? to only fallback for null/undefined, not 0
const fee = dexConfig.fee ?? 0.003;
```

**Why This Fix**:
- `??` (nullish coalescing) only triggers for `null` or `undefined`
- `0` is a valid fee value (promotional/zero-fee pools)
- Maintains backward compatibility for undefined fees

**Regression Risk**: LOW (additive behavior, existing undefined cases unchanged)
**Test Suggestion**:
```typescript
it('should use 0% fee when explicitly set to 0', () => {
  const config = { fee: 0 };
  expect(calculateFee(config, 100)).toBe(0);
});
```
```

### Example: Good Fix (P1)

```markdown
#### Fix: Add Error Handling for WebSocket Message Parsing

**File**: shared/core/src/websocket-handler.ts:156-165
**Issue**: Malformed JSON crashes the handler
**Root Cause**: No try-catch around JSON.parse

**Before**:
```typescript
ws.on('message', (data) => {
  const parsed = JSON.parse(data.toString());
  this.processEvent(parsed);
});
```

**After**:
```typescript
ws.on('message', (data) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch (error) {
    this.logger.warn('Failed to parse WebSocket message', { 
      error: error instanceof Error ? error.message : 'Unknown',
      dataPreview: data.toString().slice(0, 100) 
    });
    return; // Skip malformed messages, don't crash
  }
  this.processEvent(parsed);
});
```

**Why This Fix**:
- WebSocket messages from external sources can be malformed
- Crashing the handler would disconnect all streams
- Log for debugging but continue processing valid messages

**Regression Risk**: LOW (adds handling, doesn't change success path)
**Test Suggestion**:
```typescript
it('should handle malformed JSON without crashing', () => {
  const handler = new WebSocketHandler();
  expect(() => handler.handleMessage('not valid json')).not.toThrow();
});
```
```

---

## Quick Commands

### Find common issues before fixing
// turbo
```bash
# Find || with 0 fallback (should be ??)
grep -rn "|| 0" services/ shared/ --include="*.ts" | grep -v test | grep -v node_modules
```

// turbo
```bash
# Find JSON.parse without try-catch
grep -rn "JSON.parse" services/ shared/ --include="*.ts" | grep -v test | head -20
```

// turbo
```bash
# Find unhandled async operations
grep -rn "\.then(" services/ shared/ --include="*.ts" | grep -v "\.catch" | grep -v test
```

// turbo
```bash
# Find unused variables that might indicate incomplete code
npx eslint services/ shared/ --rule '@typescript-eslint/no-unused-vars: error' 2>&1 | head -30
```

---

## Verification Steps

After applying fixes:

// turbo
```bash
# 1. Type check
npm run typecheck
```

// turbo
```bash
# 2. Run tests
npm test
```

// turbo
```bash
# 3. Check for regressions in affected areas
npm test -- --testPathPattern="[affected-module]"
```

---

## Checklist Before Submitting Fix

- [ ] I read the entire file, not just the snippet
- [ ] I traced where the data comes from and goes to
- [ ] I checked what other code depends on this
- [ ] My fix handles edge cases (null, 0, empty, max)
- [ ] My fix doesn't change behavior for working cases
- [ ] I included a test suggestion for regression prevention
- [ ] The code is more readable than before
- [ ] Error handling is explicit, not silent
- [ ] I completed pre-fix verification protocol
- [ ] I completed post-fix validation
- [ ] All quality scores are MEDIUM or HIGH

---

## Using Task Tool for Complex Fixes

For fixes spanning multiple files or requiring careful sequencing, use the Task tool to track progress.

### When to Create Fix Tasks

**Use TaskCreate for**:
- Fixes spanning >3 files
- Fixes requiring careful sequencing (step 1 must complete before step 2)
- Fixes touching hot-path code (need to measure performance impact)
- Fixes requiring integration test verification
- Fixes that might take >30 minutes total

### Example: Multi-File Fix for Race Condition

```typescript
// Found: Race condition in price update handler affecting 4 files
// This requires careful sequencing and testing

<TaskCreate>
{
  "subject": "Fix race condition in price update handler",
  "activeForm": "Fixing race condition in price updates",
  "description": "Issue: Race condition in shared/core/src/price-handler.ts:145-180

  Root cause: Concurrent updates to shared Map without locking

  Fix sequence (must be sequential):
  1. Add mutex to price-handler.ts (shared/core/src/price-handler.ts:150)
  2. Update tests to verify thread safety (shared/core/tests/price-handler.test.ts)
  3. Update dependent code in detector.ts (services/unified-detector/src/detector.ts:280)
  4. Update coordinator usage (services/coordinator/src/coordinator.ts:120)
  5. Run full integration tests
  6. Verify no performance regression (<50ms requirement)

  Files affected: 4
  Regression risk: MEDIUM (touches hot path)
  Testing: Unit tests + integration tests + performance benchmarks"
}
</TaskCreate>
```

### Updating Task During Fix Implementation

```typescript
// After completing step 1-2
<TaskUpdate>
{
  "taskId": "1",
  "status": "in_progress",
  "metadata": {
    "completed_steps": "1,2",
    "current_step": "3",
    "findings": "Mutex added successfully, tests pass, no performance impact measured"
  }
}
</TaskUpdate>

// After completing all steps
<TaskUpdate>
{
  "taskId": "1",
  "status": "completed",
  "metadata": {
    "outcome": "Fix complete - race condition resolved",
    "performance_impact": "None - still <50ms",
    "tests_added": "3 new thread-safety tests",
    "files_modified": "4"
  }
}
</TaskUpdate>
```

### Example: Fix with Performance Verification

```typescript
// Fixing hot-path code - need to measure before/after

<TaskCreate>
{
  "subject": "Optimize array.find() in detector hot path",
  "activeForm": "Optimizing detector hot path",
  "description": "Issue: Using array.find() in hot path (shared/core/src/partitioned-detector.ts:240)

  Problem: O(n) search in tight loop, violates <50ms requirement
  Solution: Replace with Map for O(1) lookup

  Steps:
  1. Measure current performance (benchmark)
  2. Implement Map-based lookup
  3. Update all code using the array
  4. Measure new performance
  5. Verify improvement meets target
  6. Update tests

  Success criteria: <50ms maintained, no functional regressions"
}
</TaskCreate>
```

### Don't Create Tasks For

- Simple single-file fixes (<10 lines)
- Obvious typo/formatting fixes
- Fixes that don't require verification steps
- Fixes you can complete in one session (<15 minutes)

**Remember**: Tasks are for YOUR organization (tracking complex work) and USER visibility (showing progress on substantial fixes).

---

## Handling Uncertainty When Fixing Issues (Critical Skill)

Fixing code when uncertain can cause more problems than it solves. Handle uncertainty systematically:

---

### Uncertainty Type 1: Incomplete Understanding of Bug

**Scenario**: You understand WHAT is wrong but not WHY, or how it's connected to other code.

**Response Pattern**:
```
**What I Know**: [the symptom/issue]
**What I Don't Know**: [the root cause / full impact]

**Before I Can Fix**:
- [ ] Need to trace [specific code path]
- [ ] Need to see [specific file]
- [ ] Need to understand [specific dependency]

**Risk of Fixing Now**: [what could go wrong if I fix without full understanding]

**Request**: [specific information needed to proceed safely]
```

**Example**:
```
**What I Know**: Function returns undefined sometimes, causing downstream crashes
**What I Don't Know**: Under what conditions does it return undefined? Is this intentional for some cases?

**Before I Can Fix**:
- [ ] Need to trace all calling paths to see which pass undefined vs valid values
- [ ] Need to check if undefined has semantic meaning (e.g., "not found" vs "error")
- [ ] Need to see tests to understand expected behavior

**Risk of Fixing Now**: Might break intentional undefined handling or mask real bugs upstream

**Request**: Please show me the calling code and any tests for this function
```

**DO**: Articulate exactly what you need to know
**DON'T**: Fix speculatively and hope it works

---

### Uncertainty Type 2: Multiple Possible Fixes

**Scenario**: You understand the bug but there are several ways to fix it, each with trade-offs.

**Response Pattern**:
```
**Bug Confirmed**: [description]

**Possible Fixes**:

**Option A: [Approach]**
- **Fix**: [code change]
- **Pros**: [advantages]
- **Cons**: [disadvantages]
- **Best if**: [conditions where this is optimal]

**Option B: [Approach]**
- **Fix**: [code change]
- **Pros**: [advantages]
- **Cons**: [disadvantages]
- **Best if**: [conditions where this is optimal]

**My Recommendation**: [Option X]
**Reasoning**: [why this over the other(s)]
**Confidence**: [MEDIUM if close call, HIGH if clear winner]

**Alternative**: [If user has different priorities, Option Y might be better because...]
```

**Example**:
```
**Bug Confirmed**: Race condition in concurrent price updates

**Possible Fixes**:

**Option A: Add Mutex Lock**
- **Fix**: Wrap price update in mutex.acquire() / mutex.release()
- **Pros**: Simple, proven pattern, easy to test
- **Cons**: Serializes all updates, might hurt performance
- **Best if**: Update frequency is low (<100/sec)

**Option B: Use Atomic Operations**
- **Fix**: Replace Map with SharedArrayBuffer + Atomics
- **Pros**: Lock-free, maintains performance
- **Cons**: Complex, harder to debug, requires rewrite
- **Best if**: Update frequency is high (>1000/sec)

**My Recommendation**: Option A (Mutex Lock)
**Reasoning**: Safer, simpler, performance impact likely negligible given current load
**Confidence**: MEDIUM (depends on actual update frequency)

**Alternative**: If profiling shows update frequency >1000/sec, Option B would be better despite complexity
```

**DO**: Present options with honest trade-offs
**DON'T**: Hide that alternatives exist or over-state confidence in one choice

---

### Uncertainty Type 3: Unknown Edge Cases

**Scenario**: You have a fix but aren't certain it handles all edge cases.

**Response Pattern**:
```
**Fix**: [proposed code change]

**Known Edge Cases** (handled):
- [Case 1]: [how fix handles it]
- [Case 2]: [how fix handles it]

**Uncertain Edge Cases**:
- [Case 3]: Might occur if [condition] - Fix would [handle/fail]
- [Case 4]: Don't know if possible - Need to verify [what]

**Confidence**: MEDIUM
**Recommendation**: [Implement fix with caveat / Verify edge cases first]

**Proposed Tests** (to catch unknowns):
- Test [scenario 1]
- Test [scenario 2]
```

**Example**:
```
**Fix**: Add null check before accessing property

```typescript
// Before
const value = config.fee * 100;

// After
const value = (config.fee ?? 0.003) * 100;
```

**Known Edge Cases** (handled):
- null: Falls back to 0.003 ✅
- undefined: Falls back to 0.003 ✅
- 0: Uses 0 (doesn't fall back) ✅

**Uncertain Edge Cases**:
- NaN: Would propagate (value = NaN * 100) - Don't know if config.fee can be NaN
- Negative: Would use negative value - Is negative fee valid?

**Confidence**: MEDIUM (handles null/undefined but uncertain about NaN/negative)
**Recommendation**: Implement fix, but add validation if NaN/negative are invalid

**Proposed Tests**:
- Test with fee = 0 (should use 0, not fallback)
- Test with fee = null (should fallback)
- Test with fee = undefined (should fallback)
- **Question**: Can fee be NaN or negative? If invalid, should validate
```

**DO**: Acknowledge unknown edge cases explicitly
**DON'T**: Claim fix is complete when you're uncertain about some scenarios

---

### Uncertainty Type 4: Unclear Requirements

**Scenario**: The finding says "fix X" but you're not sure what the correct behavior should be.

**Response Pattern**:
```
**Issue**: [description from finding]

**Current Behavior**: [what code does now]

**Unclear**: What should correct behavior be?

**Possible Interpretations**:
1. [Interpretation A]: [what this would mean for the fix]
2. [Interpretation B]: [what this would mean for the fix]

**Impact on Fix**:
- If A is correct: [fix would be X]
- If B is correct: [fix would be Y]

**Request**: Please clarify: [specific question about expected behavior]
```

**Example**:
```
**Issue**: "Function should handle empty arrays"

**Current Behavior**: Returns null for empty array

**Unclear**: Should it return null, empty array, or throw error?

**Possible Interpretations**:
1. Return empty array: Caller can check length
2. Keep null: Null means "no data"
3. Throw error: Empty is invalid input

**Impact on Fix**:
- If 1: Change `return null` to `return []`
- If 2: Keep current behavior, maybe just add comment
- If 3: Add `if (arr.length === 0) throw new Error(...)`

**Request**: What should this function return for empty arrays? Looking at callers, they check for null, suggesting interpretation 2 is correct. Confirm?
```

**DO**: Ask for clarification on ambiguous requirements
**DON'T**: Guess at the intended behavior

---

### When You Can't Achieve Perfect Confidence

Sometimes you must proceed with incomplete information. Be explicit about limitations:

**Pattern**:
```
**Fix**: [proposed code]

**Confidence**: LOW / MEDIUM
**Why Not Higher**: [what you don't know]

**Known Limitations**:
- [Limitation 1]: [what this fix doesn't address]
- [Limitation 2]: [edge case this might miss]

**Recommended Follow-up**:
- [What should be verified after fix]
- [What should be monitored]
```

**Example**:
```
**Fix**: Add try-catch around JSON.parse()

```typescript
try {
  const data = JSON.parse(message);
  this.processEvent(data);
} catch (error) {
  this.logger.warn('Malformed message', { error });
  return; // Skip malformed messages
}
```

**Confidence**: MEDIUM
**Why Not Higher**: Don't know if skipping malformed messages is correct policy (vs. alerting/crashing)

**Known Limitations**:
- Silently skips malformed messages (only logs warning)
- Doesn't distinguish between malformed JSON and other errors
- No metrics on skip rate (can't detect if this happens frequently)

**Recommended Follow-up**:
- Add metric for malformed message count
- Consider alerting if skip rate >1%
- Verify with user: Is silent skip acceptable or should we crash/alert?
```

**DO**: Document limitations and suggest follow-up
**DON'T**: Present incomplete fix as complete

---

### Decision Tree: When to Fix vs. Ask vs. Investigate

```
Issue reported
      |
      ├─ Do I understand the bug fully?
      │   NO → INVESTIGATE or ASK for clarification
      │   YES ↓
      │
      ├─ Do I know the correct behavior?
      │   NO → ASK user what should happen
      │   YES ↓
      │
      ├─ Do I know how to fix it?
      │   NO → INVESTIGATE (read related code)
      │   YES ↓
      │
      ├─ Am I confident about edge cases?
      │   NO → Document uncertainty, propose tests
      │   YES ↓
      │
      ├─ Is there only one good approach?
      │   NO → Present options, recommend best
      │   YES ↓
      │
      └─ FIX with high confidence
```

---

### Examples of Good Uncertainty Communication

**Good ✅**:
```
"I can fix the null handling, but I'm uncertain if empty string should also be treated as invalid. Looking at the callers, some pass empty strings. Should I:
A) Treat empty string as invalid (like null)
B) Allow empty string (only reject null)

Recommend A based on validation patterns elsewhere, but need confirmation."
```

**Bad ❌**:
```
"Fixed the null handling." [without addressing empty string uncertainty]
```

**Good ✅**:
```
"This fix handles the reported case, but I haven't verified if the same pattern exists elsewhere. Recommend searching for similar patterns in:
- detector.ts
- analyzer.ts
- coordinator.ts"
```

**Bad ❌**:
```
"Fixed. This was the only occurrence." [without verifying]
```

---

### Remember: Partial Fixes With Caveats > Confident Wrong Fixes

- **Acknowledge limitations explicitly**
- **Propose follow-up verification steps**
- **Present options when multiple approaches exist**
- **Ask for clarification when requirements are unclear**

**When uncertain**: It's better to fix what you're confident about and document what you're not sure about, than to fix everything speculatively.
