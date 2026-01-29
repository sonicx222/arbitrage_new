---
description: Fix findings/issues from implementation plans with resilient, readable code
---

# Fix Issues Workflow

## Prompt Template

Use this prompt when fixing findings from an implementation plan or addressing code issues:

```
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

### Analysis Process (Before Proposing Any Fix)
1. **Read the code** - View the entire file, not just the snippet
2. **Trace data flow** - Where do inputs come from? Where do outputs go?
3. **Understand intent** - What is this code trying to accomplish?
4. **Identify the issue** - What specifically is wrong or suboptimal?
5. **Consider edge cases** - What happens with null, empty, zero, max values?
6. **Check dependencies** - What else uses this code? Will changes break them?

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
