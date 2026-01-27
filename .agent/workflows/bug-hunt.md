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

```markdown
#### [PRIORITY] Issue Title
**Location**: file:line
**Type**: Bug | Missing Feature | Code Quality
**Impact**: Description of what could go wrong
**Evidence**: Code snippet showing the problem
**Fix**: Specific code change to resolve
**Regression Test**: Test case to prevent recurrence
```

### Constraints
- If you're unsure whether something is a bug, say "POTENTIAL ISSUE" and explain your uncertainty
- Focus on issues that could cause financial loss, system downtime, or data corruption
- Do NOT suggest refactoring unless it's directly related to a bug
- Verify against existing patterns in the codebase before flagging as an issue
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

---

## Targeted Analysis Commands

### Find potential || vs ?? issues
```bash
grep -rn "|| 0" services/ shared/
grep -rn "|| false" services/ shared/ 
```

### Find unhandled promise patterns
```bash
grep -rn "\.then(" services/ shared/ | grep -v ".catch"
```

### Find event listeners that might leak
```bash
grep -rn "\.on(" services/ shared/ | grep -v "removeListener"
```

### Find hardcoded values that should be config
```bash
grep -rn -E "[0-9]{4,}" services/ shared/ --include="*.ts" | grep -v test | grep -v ".d.ts"
```

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

---

## Follow-up Actions

After running bug hunt, prioritize fixes by:

1. **P0 (Immediate)**: Could cause financial loss or system crash
2. **P1 (This Sprint)**: Affects core functionality 
3. **P2 (Backlog)**: Nice to have, not urgent
4. **P3 (Tech Debt)**: Track in docs/todos.md

For each fix:
1. Write failing test first (TDD)
2. Implement minimal fix
3. Run `npm run typecheck && npm test`
4. Create regression test
5. Update docs/IMPLEMENTATION_PLAN.md if applicable
