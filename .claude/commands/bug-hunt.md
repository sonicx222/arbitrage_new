---
description: Find bugs, missing features, and code issues in the arbitrage project
---

# Bug Hunt & Missing Feature Analysis

## Prompt Template

Use this prompt to identify bugs, missing features, and potential issues in the codebase:

```
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

### Analysis Process (Think Step-by-Step)
Before reporting any issue, work through these steps:
1. **Understand Intent**: What is this code trying to do?
2. **Trace Data Flow**: Where do inputs come from? Where do outputs go?
3. **Identify Assumptions**: What conditions must be true for this to work?
4. **Find Violations**: Where could those assumptions be violated?
5. **Verify Pattern**: Does existing codebase handle this differently elsewhere?
6. **Assess Impact**: What's the worst case if this fails?

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

### If You Need More Context
Instead of guessing, ask:
- "I need to see [file] to verify how [function] handles [case]"
- "Is [pattern] intentional in this codebase? I see it at [location]"
- "What is the expected behavior when [edge case] occurs?"
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

## Verification Checklist (Before Submitting Analysis)

Before finalizing your bug report, verify:
- [ ] Each issue has a specific file and line number
- [ ] Each issue includes the actual problematic code snippet
- [ ] Each fix is syntactically correct and could be applied directly
- [ ] No issues are duplicates of each other
- [ ] No issues contradict patterns verified elsewhere in codebase
- [ ] Confidence levels are honest (when in doubt, use MEDIUM or LOW)
- [ ] NEEDS VERIFICATION issues include specific questions to resolve

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
