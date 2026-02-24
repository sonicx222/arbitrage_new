---
description: Fix findings/issues from implementation plans with resilient, readable code using 3-agent team (impact analysis, implementation, regression guard)
---

# Fix Issues Workflow (Team-Based)

**Findings**: `$ARGUMENTS`

> If `$ARGUMENTS` is empty, ask the user what findings/issues to fix. Accept: a report file path, pasted findings, or a description of issues to address.

## Model Capabilities (Opus 4.6)

You are running on Claude Opus 4.6 with full agent team capabilities:
- **Phased Team Orchestration**: Coordinate 3 specialized agents across 3 phases (impact analysis -> implementation -> regression validation)
- **Information Separation**: The regression-guard reviews fixes WITHOUT seeing the fix-implementer's reasoning — evaluating diffs on their own merits, like blind code review
- **Batch Interaction Detection**: The impact-analyst maps the COMBINED blast radius of all fixes together, catching interaction effects that per-fix analysis misses
- **Deep Code Path Tracing**: Follow complex data flows across multiple files and async boundaries systematically
- **Self-Correction**: Identify and correct reasoning errors at every phase gate

**Leverage these actively**: Use TeamCreate to spawn a team. Use Task tool with `team_name` to spawn teammates. Use TodoWrite to track fix progress across all phases. The impact-analyst runs first to map blast radius, then fixes are implemented with that map as guardrails, then the regression-guard validates everything independently.

## Role & Expertise

You are the **Team Lead** — a senior Node.js/TypeScript engineer who:
- Coordinates impact analysis, implementation, and validation phases
- Resolves conflicts between fix-implementer and regression-guard
- Makes final decisions on BLOCK verdicts
- Runs verification commands after all fixes are applied

## Context

Multi-chain arbitrage trading system:
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **Architecture**: Partitioned detectors, Redis Streams, WebSocket event processing
- **Stack**: TypeScript, Node.js, Solidity ^0.8.19, Hardhat, ethers v6, Jest, OpenZeppelin 4.9.6
- **Build Order**: types -> config -> core -> ml -> services

## CRITICAL PERFORMANCE REQUIREMENT

> **Hot-path latency target: <50ms** (price-update -> detection -> execution)

Hot-path modules:
- `shared/core/src/price-matrix.ts` - L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` - Opportunity detection
- `services/execution-engine/` - Trade execution
- `services/unified-detector/` - Event processing
- WebSocket handlers - Event ingestion

**Any change to hot-path code MUST**: Avoid blocking operations, minimize allocations, use O(1) lookups (Maps not arrays), never regress latency benchmarks.

---

## Why 3 Agents

Evidence from past fix cycles in this codebase shows three specific failure modes that a single agent cannot reliably prevent:

| Failure Mode | Evidence | Agent That Prevents It |
|-------------|----------|----------------------|
| **Fix interaction effects** | Double-cooldown bug: health-monitor cooldown removal + AlertCooldownManager interaction silently dropped all alerts | impact-analyst (maps cross-fix interactions upfront) |
| **Blast radius underestimation** | core/index.ts export changes cascaded to 17+ services, 50+ test files — discovered incrementally, not upfront | impact-analyst (maps COMBINED blast radius of ALL fixes) |
| **Self-validation confirmation bias** | Utility wrapper misuse (stopAndNullify return value) not caught because same agent designed and validated it | regression-guard (reviews diffs without fix reasoning) |

**Key principle**: The regression-guard receives ONLY the before/after code changes — never the fix-implementer's justification. This forces evaluation of the code change on its own merits, not through the lens of "why this should work."

---

## Team Structure

You are the **Team Lead**. Your responsibilities:
1. Parse the findings/issues to fix
2. Create the team and task list using TeamCreate
3. Read `docs/agent/code_conventions.md` for shared context
4. Execute the 3-phase plan (impact -> fix -> validate)
5. Resolve any BLOCK verdicts from the regression-guard
6. Run final verification

---

## Agent Resilience Protocol (MANDATORY)

Lessons from past sessions: agents stall when given weak models, oversized prompts, or no report-back instructions. Follow these rules to prevent stalls:

### 1. Model Requirement
**ALL agents MUST be spawned with `model: "opus"`** — pass this explicitly in the Task tool call. Explore agents default to haiku, which cannot handle multi-file analysis. Never rely on defaults.

### 2. Report-Back Requirement
Every agent prompt MUST include this instruction at the TOP (before any other instructions):
```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool to send your findings back to the team lead. Your text output is NOT visible to the team lead — only SendMessage delivers your results. Use: SendMessage(type: "message", recipient: "<team-lead-name>", content: "<your full findings>", summary: "<5-10 word summary>"). Do this IMMEDIATELY when done.
```

### 3. Prompt Size Limit
Agent prompts MUST be **under 300 lines**. Include:
- The agent's specific mission and deliverable format
- The numbered fix list with target files
- Key constraints (Critical Rules summary, Known Correct Patterns)

Do NOT copy the entire command file into the agent prompt. Summarize shared context; don't duplicate it.

### 4. Self-Execution Fallback
If an agent is unresponsive after **2 minutes** (not 5):
1. Stop waiting immediately
2. Do the work yourself as Team Lead
3. Note in the summary: "Phase N executed by Team Lead (agent unresponsive)"

This is faster and more reliable than sending multiple nudges that go unread.

### 5. Prefer general-purpose Over Explore
Use `subagent_type: "general-purpose"` for ALL agents that need deep multi-file analysis. Explore agents have limited tools and weaker models. Only use Explore for simple, quick file searches.

---

### Agent 1: "impact-analyst" (subagent_type: general-purpose, model: opus)

**Mission**: Map the COMBINED blast radius of ALL fixes before any code is changed. Identify ordering constraints, interaction risks, and shared state dependencies across the entire fix batch.

**Why this agent**: Per-fix impact analysis (the current approach) misses batch effects. When fix #1 modifies a function that fix #5 also depends on, or when fix #3 changes behavior that fix #7's test assertions rely on, only a batch-level analysis catches these interactions. This agent computes the combined impact map ONCE, front-loading work that would otherwise be discovered painfully during implementation.

**Investigation protocol**:

1. **Catalog all fixes**: List every fix to be applied with its target file and affected function/method.

2. **Map per-fix blast radius**: For EACH fix:
   ```
   FIX: [title]
   TARGET: [file:line]
   FUNCTION/METHOD: [name]
   CALLERS: [list all callers found with Grep, with file:line]
   CONSUMERS: [downstream code that uses this function's output]
   SHARED STATE: [Redis keys, caches, config, types this code touches]
   HOT-PATH PROXIMITY: NONE | INDIRECT | DIRECT
   ```

3. **Map cross-fix interactions**: For each PAIR of fixes that touch related code:
   ```
   INTERACTION: Fix #X <-> Fix #Y
   SHARED DEPENDENCY: [what they both touch]
   RISK: [what could go wrong if both are applied]
   ORDERING CONSTRAINT: [X before Y | Y before X | independent]
   ```

4. **Map test impact**: For all fixes combined:
   ```
   TESTS AFFECTED: [count] tests across [count] files
   - [test file]: [which fixes affect it, how]
   TESTS THAT MAY BREAK: [list tests whose assertions depend on current behavior]
   ```

5. **Determine fix ordering**:
   ```
   RECOMMENDED ORDER:
   1. Fix [X] — [reason it goes first: no dependencies / enables others]
   2. Fix [Y] — [depends on X because...]
   ...
   PARALLEL-SAFE GROUPS: [fixes that can be applied in any order]
   ```

6. **Identify risk hotspots**: Files or modules where multiple fixes converge:
   ```
   HOTSPOT: [file]
   FIXES CONVERGING: [list]
   RISK: [what could go wrong with multiple changes to same file]
   RECOMMENDATION: [apply together / apply sequentially with verification between]
   ```

**Deliverable**: Impact Map containing:
- Per-fix blast radius (callers, consumers, shared state, hot-path proximity)
- Cross-fix interaction matrix (which fixes affect each other)
- Test impact assessment (which tests will break and why)
- Recommended fix ordering with dependency reasoning
- Risk hotspots where multiple fixes converge

**What NOT to do**:
- Don't design fixes (that's the fix-implementer's job)
- Don't write code
- Don't assess code quality beyond the specific fixes
- Don't suggest additional fixes beyond what's listed

**Quality gates**:
- [ ] Every fix has callers mapped with Grep (not assumed)
- [ ] Every cross-fix interaction identified with specific shared dependency
- [ ] Hot-path proximity assessed for every fix with call-path reasoning
- [ ] Test impact includes specific test files and assertion types that may break
- [ ] Ordering constraints justified with dependency evidence

---

### Agent 2: "fix-implementer" (subagent_type: general-purpose)

**Mission**: Design and implement each fix in the order specified by the Impact Map. Use the blast radius data to constrain fix design — every fix must be safe for all identified callers and compatible with all other fixes in the batch.

**Why this agent**: This is the core implementation work, enhanced with the Impact Map as guardrails. Instead of discovering blast radius during implementation (the old way), the fix-implementer starts with full knowledge of what each fix can and cannot break.

**Inputs** (provided by Team Lead from Phase 1):
- Findings/issues to fix (from user)
- Impact Map (from impact-analyst)

**Pre-Fix Verification (REQUIRED for each fix)**:

### Step 1: Read and Understand
- **Read the complete file** using Read tool (not just the snippet)
- **Trace the data flow**: Where does input come from? Where does output go?
- **Verify the issue exists**: Can you point to the exact problematic line(s)?
- **Check for intentional design**: Look for explanatory comments, ADRs, performance patterns
- **Cross-reference Impact Map**: Review the callers, consumers, and interactions listed for this fix

**If issue is uncertain or might be intentional** -> flag for Team Lead, don't fix.

### Step 2: Check Dependencies and Impact
- **Review callers from Impact Map** (verify they're still accurate by spot-checking with Grep)
- **Assess breaking change risk**: Do callers rely on current behavior?
- **Check cross-fix interactions**: Will this fix conflict with any other fix in the batch?
- **Check ordering**: Am I fixing this in the correct order per the Impact Map?

### Step 3: Edge Case Analysis
For the code being fixed, trace what happens with:
- **Input edge cases**: null, undefined, empty, zero, negative, max values, invalid type
- **State edge cases**: Before initialization, after shutdown, concurrent calls
- **External edge cases**: Network failure, timeout, database unavailable
- **Hot-path edge cases** (if applicable): High frequency (1000/sec), large inputs, memory pressure

Document:
- Edge cases the current code handles (MUST preserve)
- Edge cases the current code misses (opportunity to fix)
- New edge cases the fix might introduce

### Step 4: Fix Readiness
**Am I ready to propose a fix?**
- YES -> Proceed with full context
- NO / NEED MORE INFO -> Use tools to investigate further. Don't guess.

**Fix Design Constraints**:
- Minimal and targeted — preserve existing behavior for working cases
- Must be safe for ALL callers identified in Impact Map
- Must not conflict with other fixes in the batch
- Must follow project conventions:
  - Constructor DI pattern
  - `@arbitrage/*` path aliases (not relative paths across packages)
  - `??` for numerics (not `||`)
  - Proper nullable types (no `as any`)
  - Import from source files, not barrel exports
  - Async cleanup must await disconnect operations
  - Logger type is `Logger`, not `any`

**Post-Fix Self-Check** (before moving to next fix):
1. **Correctness**: Does this solve the stated problem?
2. **Completeness**: Does it handle ALL edge cases from Step 3?
3. **Compatibility**: Safe for all callers from Impact Map?
4. **Performance** (if hot-path): No latency regression? No allocations in loops?
5. **Batch safety**: Does this conflict with any upcoming fix in the batch?

**Output format** for each fix:
```markdown
#### Fix [N]: [Brief Title]
**File**: [path/to/file.ts:line-range]
**Issue**: [What's wrong]
**Root Cause**: [Why it happens]
**Impact Map Reference**: [callers count, hot-path proximity, interactions]

**Before**:
```typescript
// problematic code
```

**After**:
```typescript
// fixed code with inline comments explaining changes
```

**Why This Fix**:
- [Design decision explanation]
- [Edge cases now handled]
- [Compatibility with other fixes in batch]

**Regression Risk**: LOW | MEDIUM | HIGH
**Callers Verified**: [count] callers checked, [specific concerns if any]
```

**Prioritization** (fix in this order):
1. **P0 Critical**: Data loss, crashes, incorrect calculations
2. **P1 Functional**: Breaks expected behavior
3. **P2 Resilience**: Missing error handling, validation
4. **P3 Readability**: Hard to maintain but works correctly

Within each priority level, follow the ordering from the Impact Map.

**What NOT to do**:
- Don't refactor unrelated code while fixing an issue
- Don't change public interfaces unless the fix requires it
- Don't optimize for performance without measured evidence
- Don't "improve" working code that isn't in scope
- Don't make multiple unrelated changes in one fix
- Don't ignore ordering constraints from Impact Map

**Quality gates**:
- [ ] Read the entire file with Read tool, not just the snippet
- [ ] Traced data flow (where it comes from, where it goes)
- [ ] Cross-referenced callers from Impact Map
- [ ] Fix handles edge cases (null, 0, empty, max)
- [ ] Fix doesn't change behavior for working cases
- [ ] If hot-path: assessed performance impact
- [ ] Checked for conflicts with other fixes in batch

---

### Agent 3: "regression-guard" (subagent_type: general-purpose)

**Mission**: Independently validate ALL fixes as a batch. Review the before/after code changes WITHOUT knowledge of the fix-implementer's reasoning. Check for regressions, interaction effects, convention violations, and missing test coverage. Design specific regression tests. Has BLOCK power over unsafe fixes.

**Why this agent**: Self-validation has a fundamental limitation — the person who designed the fix evaluates it through the lens of "why this works." The regression-guard evaluates the code CHANGE on its own merits, reasoning backward from "what could this change break?" This is the code review that catches what the author can't see.

**Inputs** (provided by Team Lead from Phase 2):
- Impact Map (from impact-analyst)
- ALL fix diffs — the before/after code for every fix applied
- The finding descriptions (what was supposed to be fixed)

**CRITICAL**: You do NOT receive the fix-implementer's reasoning, design decisions, or self-validation notes. You evaluate the code changes independently.

**Review protocol**:

1. **Per-fix regression check**: For EACH fix, independently evaluate:
   ```
   FIX: [title]
   BEHAVIOR CHANGE: [what's different between before and after]
   CALLERS AT RISK: [from Impact Map — would any caller break?]
   EDGE CASES: [does the new code handle all edge cases the old code handled?]
   NEW RISKS: [does the fix introduce any new failure modes?]
   VERDICT: SAFE | CAUTION | BLOCK
   ```

2. **Batch interaction check**: Review ALL fixes together:
   ```
   INTERACTION CHECK:
   - Fixes touching same file: [list]
   - Fixes modifying shared interfaces: [list]
   - Fixes with ordering dependencies: [are they in correct order?]
   - Combined behavior change: [does the COMBINATION create issues?]
   BATCH VERDICT: SAFE | CAUTION | BLOCK
   ```

3. **Convention compliance check**: For ALL fixes:
   - [ ] `@arbitrage/*` path aliases used (not relative paths across packages)
   - [ ] `??` used for numerics (not `||`)
   - [ ] Proper nullable types (no `as any`)
   - [ ] Constructor DI pattern preserved
   - [ ] Import from source files, not barrel exports
   - [ ] Async cleanup awaits disconnect operations
   - [ ] Logger type is `Logger`, not `any`
   - [ ] Error handling is explicit, not silent
   ```
   CONVENTION VIOLATIONS: [list with specific file:line]
   ```

4. **Performance safety check** (for fixes touching hot-path modules):
   - [ ] No new allocations in loops (no spread operators, no new objects per iteration)
   - [ ] No O(n) lookups replacing O(1) lookups
   - [ ] No blocking operations added
   - [ ] No async/await added to synchronous hot paths
   - [ ] No new abstraction layers in hot-path code
   ```
   PERFORMANCE VERDICT: SAFE | CAUTION | BLOCK
   REASONING: [specific assessment]
   ```

5. **Regression test design**: For EACH fix, design a specific regression test:
   ```
   REGRESSION TEST for Fix [N]:
   FILE: [where the test should live]
   TEST NAME: "should [expected behavior] when [condition]"
   SETUP: [what to mock/arrange]
   ACTION: [what to call]
   ASSERTION: [what to verify — specific values, not just "doesn't throw"]
   EDGE CASE TESTS:
   - "should [handle edge case X]" — [setup, action, assertion]
   - "should [handle edge case Y]" — [setup, action, assertion]
   ```

6. **Produce verdict per fix**:
   - **SAFE**: No regression risk detected. Proceed.
   - **CAUTION**: Minor risk — proceed with the specified regression test. Note specific concerns.
   - **BLOCK**: High regression risk — recommend redesign. Explain what could break and suggest a safer alternative.

**Deliverable**: Regression Report containing:
- Per-fix verdict (SAFE / CAUTION / BLOCK) with reasoning
- Batch interaction assessment
- Convention compliance report
- Performance safety assessment (if applicable)
- Regression test designs for every fix
- Summary: fix count by verdict, overall batch safety assessment

**What NOT to do**:
- Don't suggest redesigning fixes that are SAFE just because you'd do it differently
- Don't raise vague concerns ("this might have issues") — be specific
- Don't evaluate the fix reasoning — evaluate the CODE CHANGE
- Don't add scope beyond regression prevention (no refactoring suggestions, no feature additions)
- Don't flag known correct patterns (see table below)

**Quality gates**:
- [ ] Every fix has an independent verdict with specific reasoning
- [ ] Batch interaction check covers all fix pairs
- [ ] Convention check covers all modified files
- [ ] Performance check covers all hot-path-adjacent fixes
- [ ] Every fix has at least one specific regression test designed
- [ ] BLOCK verdicts include a specific safer alternative

---

## Critical Rules (Apply to ALL Agents)

### Anti-Hallucination Protocol
- **NEVER** propose edits to code you haven't fully read with the Read tool
- **NEVER** guess at function behavior — trace the actual implementation
- **NEVER** report a caller without finding it with Grep
- **IF** something is suspicious but unproven, label as NEEDS VERIFICATION
- **PREFER** minimal, targeted fixes over broad refactoring
- **NEVER GUESS.** Investigate with tools first.

### Performance Safety Protocol
- **NEVER** add blocking operations to hot-path code
- **NEVER** use `array.find()` or `array.filter()` in hot paths — use Map/Set
- **NEVER** add allocations in tight loops (no spread operators, no new objects per iteration)
- **IF** fixing hot-path code, assess latency impact explicitly
- **ALWAYS** prefer mutation over immutable patterns in hot paths

### Investigation Strategy (all agents)
1. **Read full files** using Read tool (not just snippets)
2. **Search for callers/consumers** using Grep — launch parallel searches
3. **Search for similar patterns** using Grep across the codebase
4. **Use TodoWrite** to track findings as you go
5. When investigating across multiple files, launch parallel Grep/Read in a single response

### Known Correct Patterns (Don't Flag)

| Pattern | Location | Reason |
|---------|----------|--------|
| `fee ?? 0.003` | execution-engine | Nullish coalescing for fees |
| `Object.assign({}, state)` | partitioned-detector | Snapshot for iteration safety |
| `Atomics.store/load` | price-matrix | Thread-safe SharedArrayBuffer |
| SharedArrayBuffer | price-matrix.ts | Performance-critical (ADR-005) |
| Worker threads | path-finder.ts | Parallel processing (ADR-012) |
| Inline calculations | Hot-path modules | Performance over abstraction (ADR-022) |
| Mutable objects in loops | Tight detection loops | Avoids allocation overhead |
| Multiple try-catch | WebSocket handlers | Per-connection isolation |
| Pre-allocated arrays | Detection loops | `new Array(n)` vs dynamic `.push()` |

---

## Execution Plan

### Phase 1: Setup + Impact Analysis

1. Use TodoWrite to create tracking items for all phases
2. Use TeamCreate to create the fix team
3. Read `docs/agent/code_conventions.md` for shared context
4. Parse the findings/issues into a numbered fix list

Spawn the impact-analyst:

| # | Agent Name | subagent_type | model | Focus |
|---|-----------|---------------|-------|-------|
| 1 | impact-analyst | general-purpose | opus | Combined blast radius, ordering, interactions |

The impact-analyst prompt MUST include (keep under 300 lines total):
- **First line**: The SendMessage report-back instruction (see Agent Resilience Protocol §2)
- The complete numbered fix list (what to fix, where)
- The target files/directories
- The investigation protocol and deliverable format (concise version)
- Key quality gates (bullet list, not full tables)
- Brief summary of Critical Rules (3-4 key points, not full copy)

### Per-Phase Stall Detection & Fallback

Each phase spawns a single agent. After spawning:
1. Wait up to **2 minutes** for the agent to respond via SendMessage
2. If no response after 2 minutes, **abandon the agent and do the work yourself as Team Lead**
3. Do NOT send multiple nudge messages — they rarely work and waste time

**Self-execution is always faster than waiting for a stalled agent.** The Team Lead has full tool access and can perform any agent's work directly.

### Phase 2: Fix Implementation (after Phase 1)

After the impact-analyst completes, spawn the fix-implementer:

| # | Agent Name | subagent_type | model | Focus |
|---|-----------|---------------|-------|-------|
| 2 | fix-implementer | general-purpose | opus | Implement all fixes per Impact Map ordering |

The fix-implementer prompt MUST include (keep under 300 lines total):
- **First line**: The SendMessage report-back instruction (see Agent Resilience Protocol §2)
- The findings/issues to fix
- The Impact Map output from Phase 1 (or summary if too long)
- The pre-fix verification steps and fix design constraints (concise version)
- Key quality gates (bullet list)
- Brief summary of Critical Rules and Known Correct Patterns

### Phase 3: Regression Validation (after Phase 2)

After the fix-implementer completes, spawn the regression-guard:

| # | Agent Name | subagent_type | model | Focus |
|---|-----------|---------------|-------|-------|
| 3 | regression-guard | general-purpose | opus | Independent batch validation |

The regression-guard prompt MUST include (keep under 300 lines total):
- **First line**: The SendMessage report-back instruction (see Agent Resilience Protocol §2)
- The Impact Map (from Phase 1, summarized if needed)
- ALL fix diffs — the before/after code for EVERY fix applied (read the modified files and describe what changed)
- The finding descriptions (what was supposed to be fixed)
- The review protocol and verdict definitions (concise version)
- Key quality gates (bullet list)

**CRITICAL**: Do NOT include the fix-implementer's reasoning, design decisions, or self-validation notes. The regression-guard must evaluate the code changes independently.

### Phase 4: Resolution (Team Lead)

After the regression-guard completes:

1. **Review verdicts**:
   - **All SAFE**: Proceed to verification
   - **CAUTION verdicts**: Note the regression tests to add, proceed to verification
   - **BLOCK verdicts**: Route the concern back to the fix-implementer (via SendMessage). The fix-implementer responds with either:
     - A redesigned fix that addresses the concern
     - Evidence that the concern is invalid (with specific code references)
   - Team Lead makes final call based on evidence

2. **Implement regression tests**: Write the regression tests designed by the regression-guard for CAUTION and SAFE fixes. For BLOCK fixes that were redesigned, design new regression tests.

3. **Run verification**:
   ```bash
   npm run typecheck                                    # Type check
   npm test                                             # Full test suite
   npm test -- --testPathPattern="[affected-module]"    # Targeted tests
   ```
   For contracts:
   ```bash
   cd contracts && npx hardhat compile && npx hardhat test
   ```

4. **Address any failures**: If tests fail, determine if it's a fix regression or a pre-existing issue.

### Phase 5: Summary

Write a brief summary for the user:

```markdown
## Fix Summary

### Fixes Applied
| # | Title | File | Priority | Regression Verdict |
|---|-------|------|----------|-------------------|

### Impact Analysis Highlights
- Total blast radius: [N] callers across [M] services
- Cross-fix interactions found: [count]
- Ordering constraints applied: [list]

### Regression Guard Findings
- SAFE: [count] fixes
- CAUTION: [count] fixes (regression tests added)
- BLOCK: [count] fixes (redesigned / resolved)

### Convention Violations Fixed
- [list any convention issues the regression-guard caught]

### Regression Tests Added
- [list new tests with file locations]

### Verification
- [ ] Typecheck passing
- [ ] All tests passing
- [ ] No regressions
- [ ] Hot-path performance maintained (if applicable)
```

---

## Handling Uncertainty

### Incomplete Understanding
When the fix-implementer understands WHAT is wrong but not WHY:
```
**What I Know**: [the symptom]
**What I Don't Know**: [root cause / full impact]
**Before I Can Fix**: [what I need to investigate with tools]
**Risk of Fixing Now**: [what could go wrong]
```
-> Investigate with tools before proposing fix. If still uncertain, flag for Team Lead.

### Multiple Possible Fixes
When several approaches exist:
```
**Option A**: [approach] — Pros: [X] / Cons: [Y] / Best if: [condition]
**Option B**: [approach] — Pros: [X] / Cons: [Y] / Best if: [condition]
**Impact Map says**: [which option is safer given known callers and interactions]
**Recommendation**: [Option X] because [specific reason]
```

### Unclear Requirements
When the correct behavior isn't defined:
```
**Current Behavior**: [what it does now]
**Possible Interpretations**: A) [return X] / B) [return Y] / C) [throw error]
**Impact Map says**: [callers expect behavior X/Y/Z]
**Request**: Flag for Team Lead to confirm with user.
```

**Rule**: Partial fix with documented caveats > speculative complete fix. If uncertain, fix what you're confident about and document what needs verification.

---

## Confidence Calibration

All agents MUST use these levels:
- **HIGH (90-100%)**: Full data flow traced, all callers verified, edge cases checked
- **MEDIUM (70-89%)**: Strong evidence, minor uncertainties, haven't verified all transitive callers
- **LOW (50-69%)**: Code smell, not proven, might be intentional
- **NEEDS VERIFICATION (<50%)**: Suspicious but can't prove — state what would confirm/deny

---

## Verification Checklist (Before Declaring Done)

- [ ] All fixes applied per Impact Map ordering
- [ ] All BLOCK verdicts resolved (redesigned or overridden with evidence)
- [ ] Regression tests written for all CAUTION and BLOCK fixes
- [ ] Typecheck passing (`npm run typecheck`)
- [ ] All tests passing (`npm test`)
- [ ] No regressions in existing tests
- [ ] Convention compliance verified by regression-guard
- [ ] Hot-path performance maintained (if applicable)
- [ ] Summary report written for user

**Remember**: A correctly applied fix with verified regression tests is worth more than a fast fix that might break something. When the regression-guard says BLOCK, take it seriously.
