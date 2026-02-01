---
description: Detect refactoring opportunities using hybrid top-down/bottom-up analysis
---

# Refactoring Analysis Workflow

## Prompt Template

Use this prompt to systematically detect refactoring opportunities across the codebase:

```
### Model Capabilities (Opus 4.5)
You are running on Claude Opus 4.5 with advanced reasoning capabilities:
- **Large-Scale Pattern Recognition**: Identify subtle patterns across extensive codebases
- **Systematic Decomposition**: Break down complex systems into analyzable subsystems
- **Cross-Cutting Analysis**: Recognize patterns that span multiple modules/services
- **Trade-off Reasoning**: Evaluate whether refactorings are worth their cost
- **Impact Quantification**: Estimate realistic improvements (LOC, complexity, coupling)

**Use these capabilities actively**. Opus 4.5 excels at holistic codebase analysis.

### Role & Expertise
You are a senior software architect specializing in:
- Large-scale TypeScript/Node.js system refactoring
- Domain-Driven Design and clean architecture
- Performance-critical real-time systems
- Multi-service microarchitecture patterns

### Context
This is a multi-chain arbitrage trading system with:
- **Services**: 9 (coordinator, execution-engine, detectors, partitions)
- **Shared Modules**: 7 (core, config, types, security, ml, test-utils, constants)
- **Architecture**: Partitioned detectors, Redis Streams, Worker threads
- **Scope**: 11 chains, 44+ DEXs

### ⚡ CRITICAL PERFORMANCE REQUIREMENT
> **Hot-path latency target: <50ms** (price-update → detection → execution)

The following modules are in the HOT PATH and are extremely latency-sensitive:
- `shared/core/src/price-matrix.ts` - L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` - Opportunity detection
- `services/execution-engine/` - Trade execution
- `services/unified-detector/` - Event processing
- WebSocket handlers - Event ingestion

**Refactoring hot-path code requires extra scrutiny**:
- Measure latency before/after any change
- Avoid adding abstractions that increase call depth
- Prefer inline code over function calls in tight loops
- Never trade latency for "cleaner" code in hot paths

### Critical Rules (Anti-Hallucination)
- **NEVER** suggest refactoring without tracing actual usage patterns
- **NEVER** recommend changes without understanding the "why" behind current design
- **IF** code looks unusual, check if it's intentional (performance optimization, constraint)
- **ALWAYS** verify refactoring won't break existing tests or contracts
- **PREFER** incremental improvements over "big bang" rewrites
- **QUANTIFY** impact: LOC reduction, complexity reduction, coupling reduction

### Critical Rules (Performance-Aware Refactoring)
- **NEVER** refactor hot-path code without latency benchmarks
- **NEVER** add abstraction layers to hot-path modules for "cleanliness"
- **IF** proposing hot-path changes, include latency impact assessment
- **FLAG** any refactoring that touches: price-matrix, detector, execution-engine
- **PRESERVE** intentional performance patterns:
  - SharedArrayBuffer for cross-thread data
  - Mutable objects instead of spread operators
  - Map/Set instead of array searches
  - Inline calculations instead of helper functions

---

## HYBRID ANALYSIS STRATEGY

### Phase 1: TOP-DOWN DISCOVERY (Context First)

1. **Map System Architecture**
   - Identify entry points (main modules, API handlers)
   - Trace high-level data flow between services
   - Identify architectural patterns and their boundaries

2. **Identify Refactoring Themes**
   Before diving into details, identify high-level themes:
   - [ ] Duplicated patterns across services
   - [ ] Layer violations (shared → services dependencies)
   - [ ] Inconsistent abstractions
   - [ ] Oversized modules that could be split
   - [ ] Undersized modules that could be merged

3. **Define Subsystem Boundaries**
   Break the project into analyzable chunks:
   - services/coordinator/
   - services/execution-engine/
   - services/unified-detector/
   - services/cross-chain-detector/
   - services/mempool-detector/
   - services/partition-*
   - shared/core/
   - shared/config/

### Phase 2: SUB-AGENT DELEGATION (Parallel Analysis)

For large codebases, delegate subsystems to focused analysis. This approach scales analysis and maintains manageability.

#### How to Use Sub-Agent Pattern

**Step 1: Identify Subsystems** (from Phase 1)
Break the project into 5-10 analyzable chunks. For the arbitrage project:
- services/coordinator/
- services/execution-engine/
- services/unified-detector/
- services/cross-chain-detector/
- services/mempool-detector/
- services/partition-* (P1, P2, P3, P4)
- shared/core/
- shared/config/
- shared/types/

**Step 2: Create Focused Analysis Task Per Subsystem**

For each subsystem, use this comprehensive analysis structure:

---

#### Sub-Agent Analysis Template

<subsystem_analysis>
**Subsystem**: [Name, e.g., "services/execution-engine"]
**Scope**: [Specific directories/files included]
**Boundaries**: [What this subsystem does NOT include]

---

### Task: Analyze [Subsystem Name] for Refactoring Opportunities

You are analyzing ONE subsystem of a larger codebase. Focus ONLY on this subsystem.

**Your Objectives**:
1. Map the public API surface (all exports)
2. Identify internal implementation patterns
3. Find refactoring opportunities WITHIN this subsystem
4. Note cross-cutting concerns (patterns you see that other subsystems might also have)

---

### Analysis Framework

#### Part 1: Public API Surface

<thinking>
**Exports**: [List all public exports from this subsystem]
- Export 1: [name] — Type: [class/function/interface] — Purpose: [brief description]
- Export 2: [name] — Type: [class/function/interface] — Purpose: [brief description]
- [List all exports]

**Consumers**: [Who imports from this subsystem?]
- Use Grep to find: `from '.*[subsystem-name]'` across codebase
- Consumer 1: [service/module] — Uses: [which exports]
- Consumer 2: [service/module] — Uses: [which exports]

**API Stability**:
- [ ] Stable public interface (many external consumers)
- [ ] Internal-only (only used within this service)
- [ ] Mixed (some stable, some internal)

**API Quality**:
- Clear naming? [yes/no]
- Cohesive responsibilities? [yes/no]
- Appropriate abstraction level? [yes/no]
</thinking>

**Output**:
- Total exports: [count]
- External consumers: [count]
- API stability: [stable/internal/mixed]

---

#### Part 2: Internal Structure

<thinking>
**Major Components**: [List main classes/functions]
- Component 1: [name] — Responsibility: [what it does] — Size: [LOC]
- Component 2: [name] — Responsibility: [what it does] — Size: [LOC]
- [List all major components]

**Design Patterns Used**:
- Pattern 1: [e.g., "Singleton pattern for Redis client"]
- Pattern 2: [e.g., "Event emitter for state changes"]
- [List patterns identified]

**Complexity Hot Spots**:
- File 1: [path] — Why complex: [reason] — LOC: [count]
- File 2: [path] — Why complex: [reason] — LOC: [count]
- [Identify most complex modules]

**Internal Coupling**:
- Component A → Component B: [how they're coupled]
- Component C → Component D: [how they're coupled]
- Circular dependencies?: [yes/no - if yes, list them]
</thinking>

**Output**:
- Major components: [count]
- Largest file: [path] with [LOC] lines
- Complexity hot spots: [list]
- Internal coupling: [tight/moderate/loose]

---

#### Part 3: Refactoring Opportunities (Within Subsystem Only)

Analyze this subsystem for refactoring opportunities using these categories:

**Code Smells**:
| Finding | Location | Impact | Effort | Evidence |
|---------|----------|--------|--------|----------|
| Long Method (>50 lines) | [file:line] | [HIGH/MED/LOW] | [X days] | [method name, current LOC] |
| Large Class (>500 lines) | [file:line] | [HIGH/MED/LOW] | [X days] | [class name, current LOC, responsibilities] |
| Feature Envy | [file:line] | [HIGH/MED/LOW] | [X days] | [description of inappropriate coupling] |
| Primitive Obsession | [file:line] | [HIGH/MED/LOW] | [X days] | [what should be value object] |
| Data Clumps | [locations] | [HIGH/MED/LOW] | [X days] | [params that travel together] |

**Structural Issues**:
| Finding | Location | Impact | Effort | Evidence |
|---------|----------|--------|--------|----------|
| Circular Dependencies | [files] | [HIGH/MED/LOW] | [X days] | [A → B → A] |
| God Class | [file:line] | [HIGH/MED/LOW] | [X days] | [class name, what it does] |
| Deep Nesting (>4 levels) | [file:line] | [HIGH/MED/LOW] | [X days] | [current nesting depth] |
| Shotgun Surgery | [pattern] | [HIGH/MED/LOW] | [X days] | [what change requires many edits] |

**Architectural Issues**:
| Finding | Location | Impact | Effort | Evidence |
|---------|----------|--------|--------|----------|
| Layer Violations | [files] | [HIGH/MED/LOW] | [X days] | [who imports what inappropriately] |
| Leaky Abstractions | [file:line] | [HIGH/MED/LOW] | [X days] | [what implementation details leak] |
| Missing Abstractions | [locations] | [HIGH/MED/LOW] | [X days] | [duplicated logic that should be abstracted] |

**For each finding, provide**:
- Specific file:line references
- Current state (code snippet if helpful)
- Proposed refactoring approach
- Expected improvement (quantified if possible)
- Risk level (what could go wrong)

---

#### Part 4: Cross-Cutting Concerns

**Patterns Seen Here That Likely Exist Elsewhere**:

<thinking>
- Pattern 1: [e.g., "WebSocket connection management"]
  - How it's implemented here: [description]
  - Likely also in: [other subsystems that might have this]
  - Consolidation opportunity?: [yes/no]

- Pattern 2: [e.g., "Error handling with structured logging"]
  - How it's implemented here: [description]
  - Likely also in: [other subsystems]
  - Consistency check needed?: [yes/no]

[List all cross-cutting patterns]
</thinking>

**Dependencies**:
- **This subsystem depends on** (imports from): [list shared modules]
- **This subsystem is depended on by** (imported by): [list consumers]

**Interface Consistency**:
- Similar to subsystem: [name]
- Different from subsystem: [name] — Why: [explanation]

---

### Subsystem Analysis Output

**Summary Statistics**:
- Total files: [count]
- Total LOC: [count]
- Refactoring opportunities found: [count]
- Estimated refactoring effort: [X days]

**Priority Findings** (Top 3):
1. [Finding] — Impact: [HIGH/MED/LOW] — Effort: [X days]
2. [Finding] — Impact: [HIGH/MED/LOW] — Effort: [X days]
3. [Finding] — Impact: [HIGH/MED/LOW] — Effort: [X days]

**Cross-Cutting Concerns to Investigate**:
- [Pattern 1] — Check in: [other subsystems]
- [Pattern 2] — Check in: [other subsystems]

</subsystem_analysis>

---

**Step 3: Execute Analysis for Each Subsystem**

You can either:
- **Sequential**: Analyze subsystems one by one, documenting each thoroughly
- **Parallel** (if you create tasks): Create a task for each subsystem, work through systematically

**Step 4: Move to Phase 3** (Bottom-Up Validation) after all subsystem analyses are complete.

### Phase 3: BOTTOM-UP VALIDATION (Precision)

For each finding from Phase 2:
1. Trace actual code paths that would be affected
2. Verify with existing tests (any that would break?)
3. Check if pattern exists elsewhere (consistency)
4. Quantify improvement (lines, complexity, coupling)

### Phase 4: SYNTHESIS (Aggregation & Prioritization)

After all subsystem analyses are complete, synthesize findings into a unified view.

<synthesis_process>

### Step 1: Aggregate All Findings

**Create Master Findings List**:

Combine all subsystem findings into one comprehensive table:

| Subsystem | Finding | Category | Impact | Effort | Evidence | Priority Score |
|-----------|---------|----------|--------|--------|----------|----------------|
| exec-engine | Long method in executor.ts | Code Smell | HIGH | 2d | executor.ts:150-280 (130 lines) | TBD |
| detector | Circular dep A→B→A | Structural | HIGH | 3d | detector.ts↔analyzer.ts | TBD |
| shared/core | Missing abstraction for fees | Architectural | MED | 1d | Duplicated in 5 files | TBD |
| ... | ... | ... | ... | ... | ... | ... |

**Summary Statistics**:
- **Total Findings**: [count]
- **By Category**:
  * Code Smells: [count]
  * Structural Issues: [count]
  * Architectural Issues: [count]
- **By Impact**:
  * HIGH: [count]
  * MEDIUM: [count]
  * LOW: [count]
- **Total Estimated Effort**: [X days]

---

### Step 2: Identify Cross-Cutting Patterns

**Pattern: [Name, e.g., "Duplicate WebSocket Management"]**

<thinking>
**Occurrences**:
- Subsystem A: [how it's implemented]
- Subsystem B: [how it's implemented]
- Subsystem C: [how it's implemented]

**Similarities**: [what's the same across implementations?]
**Differences**: [what varies? intentional or drift?]

**Consolidation Analysis**:
- Can this be unified?: [yes/no]
- Where should it live?: [shared module? base class?]
- What's the interface?: [what API would serve all use cases?]
- Migration effort: [how hard to migrate all users?]

**Expected Benefits**:
- Lines saved: [estimated]
- Maintenance: [one place to fix bugs vs. N places]
- Consistency: [reduces divergence risk]

**Risks**:
- Over-abstraction?: [could make it harder to customize]
- Migration risk: [what could break during consolidation?]
</thinking>

**Output per Pattern**:
- Pattern name: [descriptive name]
- Occurrences: [count] in [subsystems]
- Consolidation opportunity: YES / NO / MAYBE
- If YES:
  * Proposed location: [where to consolidate]
  * Estimated impact: [lines saved, maintenance benefit]
  * Estimated effort: [X days]
  * Risk level: [HIGH/MED/LOW]

**Repeat for each cross-cutting pattern found**.

---

### Step 3: Resolve Conflicts and Overlaps

Sometimes findings from different subsystems contradict or overlap:

**Conflict Type 1: Contradictory Findings**

**Example**:
- Subsystem A finding: "Centralize X in shared/core"
- Subsystem B finding: "X is too specific for shared/core, keep in service"

**Resolution Process**:
<thinking>
1. Re-examine both code paths
2. Determine: Are both correct? (different contexts)
3. Or: Is one wrong? (misunderstanding)
4. Consider: Is there a middle ground? (partial sharing)
</thinking>

**Resolution**:
- Decision: [which finding is correct, or how to reconcile]
- Rationale: [explicit reasoning]
- Updated finding: [consolidated recommendation]

**Conflict Type 2: Overlapping Refactorings**

**Example**:
- Finding A: "Extract method X from class Y"
- Finding B: "Class Y should be split into Y1 and Y2"
- These overlap—doing both might be redundant

**Resolution**:
- Are these complementary or redundant?: [analysis]
- Should we do both, or just one?: [decision]
- If one, which?: [reasoning]
- Updated plan: [consolidated approach]

---

### Step 4: Prioritization with Scoring

**Scoring Formula**:
```
Priority Score = (Impact × 0.4) + ((5 - Effort) × 0.3) + ((5 - Risk) × 0.3)
```

Where:
- Impact: 1-5 (1=LOW, 3=MEDIUM, 5=HIGH)
- Effort: 1-5 (1=1 day, 3=1 week, 5=1 month)
- Risk: 1-5 (1=LOW, 3=MEDIUM, 5=HIGH)

**Score Each Finding**:

| Finding | Impact | Effort | Risk | Score | Rank |
|---------|--------|--------|------|-------|------|
| Circular dep fix | 5 | 3 | 2 | (5×0.4) + (2×0.3) + (3×0.3) = 3.5 | 1 |
| Extract interface | 3 | 2 | 1 | (3×0.4) + (3×0.3) + (4×0.3) = 3.3 | 2 |
| Long method refactor | 3 | 2 | 2 | (3×0.4) + (3×0.3) + (3×0.3) = 3.0 | 3 |
| ... | ... | ... | ... | ... | ... |

**Sort by Score** (highest priority first)

---

### Step 5: Create Refactoring Roadmap

Group refactorings by theme and sequence appropriately:

**Phase 1: Foundation (Enables Later Work)**

Priority: P0 (Immediate)
- Refactoring A: [title]
  * Why first: [blocks other work, or critical issue]
  * Effort: [X days]
  * Impact: [what improves]
- Refactoring B: [title]
  * Why first: [reasoning]
  * Effort: [X days]
  * Impact: [what improves]

**Phase 2: Structural Improvements**

Priority: P1 (Next Sprint)
- Refactoring C: [title]
  * Depends on: [Phase 1 refactorings]
  * Effort: [X days]
  * Impact: [what improves]
- Refactoring D: [title]
  * Depends on: [Phase 1 refactorings]
  * Effort: [X days]
  * Impact: [what improves]

**Phase 3: Major Refactorings**

Priority: P2 (Future)
- Refactoring E: [title]
  * Depends on: [Phase 1-2 refactorings]
  * Effort: [X days]
  * Impact: [what improves]
  * Higher risk, do after foundation is solid

**Dependencies**:
- Refactoring A must complete before Refactoring C
- Refactoring B and D can run in parallel

---

### Step 6: Synthesis Validation

Before finalizing synthesis:

<validation>
**Completeness**:
- [ ] All subsystem findings are accounted for (none dropped)
- [ ] Cross-cutting patterns are identified and analyzed
- [ ] Conflicts are resolved (not just noted)
- [ ] Prioritization is complete and defensible

**Consistency**:
- [ ] Recommendations don't contradict each other
- [ ] Effort estimates are realistic (not just optimistic)
- [ ] Risk assessments are honest
- [ ] Dependencies are identified

**Actionability**:
- [ ] Roadmap is sequenced logically (dependencies respected)
- [ ] Each phase has clear scope and goals
- [ ] Effort estimates include testing and integration
- [ ] Success criteria are defined

**Self-Critique**:
1. **What did I miss?**
   [Force yourself to identify potential gaps]

2. **Are my estimates realistic?**
   [Challenge your effort/impact estimates]

3. **Is this prioritization defensible?**
   [Could someone reasonably disagree? Why?]

**Validation Result**: ✅ READY / ⚠️ NEEDS_REVISION
</validation>

</synthesis_process>

---

## DETECTION CATEGORIES

### 1. Code Smells
| Smell | Detection | Example |
|-------|-----------|---------|
| **Long Method** | >50 lines | Method doing multiple things |
| **Large Class** | >500 lines | Class with too many responsibilities |
| **Feature Envy** | Method uses other class data more than own | Getter chains |
| **Primitive Obsession** | Too many primitives instead of value objects | `(amount: number, decimals: number)` |
| **Data Clumps** | Same params passed together repeatedly | `(chainId, tokenA, tokenB)` |

### 2. Structural Issues
| Issue | Detection | Impact |
|-------|-----------|--------|
| **Circular Dependencies** | A → B → A | Build/test issues, tight coupling |
| **God Class** | Central class everything depends on | Bottleneck for changes |
| **Deep Nesting** | >4 levels of indentation | Cognitive complexity |
| **Shotgun Surgery** | One change requires many file edits | High change amplification |

### 3. Architectural Issues
| Issue | Detection | Impact |
|-------|-----------|--------|
| **Layer Violations** | shared/ importing from services/ | Inverted dependencies |
| **Leaky Abstractions** | Implementation details in interfaces | Coupling to internals |
| **Missing Abstractions** | Same logic repeated with slight variations | Duplication, drift risk |

---

## OUTPUT FORMAT

For each refactoring opportunity:

#### [PRIORITY] [Title]
**Category**: Code Smell | Structural | Architectural
**Location**: [file:line or directory]
**Current State**: Description of the problem
**Evidence**:
```typescript
// Problematic code snippet
```
**Proposed Refactoring**:
- [ ] Step 1: ...
- [ ] Step 2: ...
**Expected Improvement**:
- Lines: X → Y (Z% reduction)
- Complexity: before → after
- Coupling: before → after
**Risk**: LOW | MEDIUM | HIGH
**Test Impact**: [which tests might break]

---

## Prioritization Matrix

| Priority | Impact | Effort | Risk | Action |
|----------|--------|--------|------|--------|
| **P0** | HIGH | LOW | LOW | Do immediately |
| **P1** | HIGH | MEDIUM | LOW-MED | Plan for next sprint |
| **P2** | MEDIUM | LOW-MED | LOW | Opportunistic |
| **P3** | LOW | LOW | LOW | Tech debt backlog |

```

---

## Few-Shot Examples

### Example 1: Structural Refactoring (P1)

```markdown
#### [P1] Extract ChainConfig Interface from Multiple Files

**Category**: Structural (Data Clumps + Missing Abstraction)
**Location**:
- shared/config/src/chains/*.ts (11 files)
- shared/core/src/types/chain.ts

**Current State**: Each chain config file defines the same structure with slight variations. Properties like `chainId`, `rpcUrls`, `blockTime`, `nativeCurrency` are repeated across all files without a shared interface.

**Evidence**:
```typescript
// shared/config/src/chains/bsc.ts
export const bscConfig = {
  chainId: 56,
  rpcUrls: [...],
  blockTime: 3,
  nativeCurrency: { symbol: 'BNB', decimals: 18 }
};

// shared/config/src/chains/ethereum.ts
export const ethereumConfig = {
  chainId: 1,
  rpcUrls: [...],
  blockTime: 12,
  nativeCurrency: { symbol: 'ETH', decimals: 18 }
};
// ... same pattern in 9 more files
```

**Proposed Refactoring**:
- [ ] Create `ChainConfig` interface in shared/types/
- [ ] Update all 11 chain files to implement interface
- [ ] Add validation function `validateChainConfig()`
- [ ] Add type-safe chain registry

**Expected Improvement**:
- Type safety: Catch missing properties at compile time
- Maintainability: Single source of truth for structure
- IDE support: Autocomplete for all chain configs

**Risk**: LOW (additive change, no logic changes)
**Test Impact**: None (interfaces are compile-time only)
```

### Example 2: Code Smell Refactoring (P2)

```markdown
#### [P2] Reduce Method Length in DetectorBase.processEvents()

**Category**: Code Smell (Long Method)
**Location**: shared/core/src/detector-base.ts:145-280

**Current State**: `processEvents()` is 135 lines handling: validation, transformation, filtering, aggregation, and publishing. Single Responsibility violated.

**Evidence**:
```typescript
async processEvents(events: RawEvent[]): Promise<void> {
  // Lines 145-165: Validation
  // Lines 166-200: Transformation
  // Lines 201-240: Filtering
  // Lines 241-265: Aggregation
  // Lines 266-280: Publishing
}
```

**Proposed Refactoring**:
- [ ] Extract `validateEvents(events: RawEvent[]): ValidatedEvent[]`
- [ ] Extract `transformEvents(events: ValidatedEvent[]): ProcessedEvent[]`
- [ ] Extract `filterRelevantEvents(events: ProcessedEvent[]): ProcessedEvent[]`
- [ ] Extract `aggregateOpportunities(events: ProcessedEvent[]): Opportunity[]`
- [ ] Keep `processEvents()` as orchestrator (< 20 lines)

**Expected Improvement**:
- Lines: 135 → 20 (main) + 4×30 (extracted) = better organized
- Testability: Each step testable in isolation
- Reusability: Filter/aggregate reusable in other contexts

**Risk**: MEDIUM (behavioral change possible if extraction misses edge cases)
**Test Impact**: `detector-base.test.ts` - add tests for extracted methods
```

### Example 3: Architectural Refactoring (P0)

```markdown
#### [P0] Fix Circular Dependency Between Core and Services

**Category**: Architectural (Circular Dependency)
**Location**:
- shared/core/src/executor-interface.ts imports services/execution-engine/types
- services/execution-engine/ imports shared/core/

**Current State**: shared/core depends on execution-engine types, violating the dependency direction (shared should not depend on services).

**Evidence**:
```typescript
// shared/core/src/executor-interface.ts
import { ExecutionResult } from '../../../services/execution-engine/types';
//                          ^^^ VIOLATION: shared imports services
```

**Proposed Refactoring**:
- [ ] Move `ExecutionResult` type to shared/types/
- [ ] Update shared/core to import from shared/types
- [ ] Update services/execution-engine to import from shared/types
- [ ] Add eslint rule to prevent future violations

**Expected Improvement**:
- Build order: Enables proper build graph
- Testability: shared/core testable without execution-engine
- Maintainability: Clear dependency direction

**Risk**: MEDIUM (requires careful interface extraction)
**Test Impact**: May need to update import paths in tests
```

---

## Quick Detection Commands

### Find large files (potential god classes)
// turbo
```bash
find services/ shared/ -name "*.ts" -not -path "*/node_modules/*" -not -name "*.test.ts" -not -name "*.d.ts" -exec wc -l {} + | sort -rn | head -20
```

### Find deeply nested code
// turbo
```bash
grep -rn "^[[:space:]]\{16,\}" services/ shared/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts" | head -20
```

### Find potential circular imports
// turbo
```bash
grep -rn "from '.*\.\./\.\./\.\./services" shared/ --include="*.ts" | grep -v node_modules
```

### Find long functions (>50 lines between braces)
// turbo
```bash
awk '/^[[:space:]]*(async )?[a-zA-Z]+\(.*\).*{$/,/^[[:space:]]*}$/ {count++; if(count>50) print FILENAME":"NR; if(/^[[:space:]]*}$/) count=0}' services/**/src/*.ts 2>/dev/null | head -20
```

### Find duplicated patterns
// turbo
```bash
grep -rh "new Map\(\)" services/ shared/ --include="*.ts" | sort | uniq -c | sort -rn | head -10
```

### Find data clumps (same params passed together)
// turbo
```bash
grep -rn "chainId.*tokenA.*tokenB\|tokenA.*tokenB.*chainId" services/ shared/ --include="*.ts" | grep -v ".test.ts" | head -20
```

### Find missing abstractions (similar class names)
// turbo
```bash
grep -rn "class.*Handler\|class.*Manager\|class.*Service" services/ shared/ --include="*.ts" | grep -v ".test.ts" | cut -d: -f1 | sort | uniq -c | sort -rn
```

---

## Verification Checklist

Before submitting refactoring analysis:

### Quality Gates
- [ ] Each finding has specific file/line references
- [ ] Each finding includes actual code evidence
- [ ] Proposed changes are incremental (not "rewrite everything")
- [ ] Impact is quantified where possible
- [ ] Risk level is realistic
- [ ] Test impact is identified

### Anti-Hallucination
- [ ] Verified pattern exists (not assumed)
- [ ] Checked if pattern is intentional (ADR, comment, performance)
- [ ] Confirmed refactoring won't break existing tests
- [ ] Cross-referenced with existing codebase patterns

### Prioritization
- [ ] P0 items are truly critical (blocking or high-risk)
- [ ] Effort estimates are realistic
- [ ] Dependencies between refactorings identified

---

## Using Task Tool for Long-Running Refactoring Analysis

For comprehensive refactoring analysis (>1 hour), use the Task tool to track progress through the multi-phase workflow.

### When to Create Refactoring Analysis Tasks

**Use TaskCreate for**:
- Full codebase refactoring analysis (all phases)
- Analysis of large subsystems (>10 files)
- Multi-phase workflows (discovery → delegation → synthesis)
- Analysis that will take multiple sessions

### Example: Complete Refactoring Analysis Workflow

```typescript
// Starting comprehensive refactoring analysis of the entire arbitrage system
// This is a substantial undertaking requiring all 4 phases

<TaskCreate>
{
  "subject": "Phase 1: Map system architecture",
  "activeForm": "Mapping system architecture",
  "description": "Top-down discovery phase for refactoring analysis:

  Steps:
  1. Identify all entry points (main modules, API handlers)
  2. Trace high-level data flow between services
  3. Identify architectural patterns and boundaries
  4. Define subsystem boundaries (services + shared modules)
  5. Identify refactoring themes to investigate

  Output: System map with subsystems defined"
}
</TaskCreate>

<TaskCreate>
{
  "subject": "Phase 2: Analyze subsystems in parallel",
  "activeForm": "Analyzing subsystems",
  "description": "Sub-agent delegation phase:

  Subsystems to analyze:
  1. services/execution-engine
  2. services/unified-detector
  3. services/coordinator
  4. shared/core
  5. [other subsystems]

  For each: Map public API, find internal issues, note cross-cutting patterns

  Output: Per-subsystem refactoring findings"
}
</TaskCreate>

<TaskCreate>
{
  "subject": "Phase 3: Bottom-up validation",
  "activeForm": "Validating findings",
  "description": "Validation phase:

  For each finding:
  - Trace actual code paths
  - Verify with existing tests
  - Check consistency across codebase
  - Quantify improvement estimates

  Output: Verified findings list"
}
</TaskCreate>

<TaskCreate>
{
  "subject": "Phase 4: Synthesize and create roadmap",
  "activeForm": "Synthesizing findings",
  "description": "Synthesis phase:

  Steps:
  1. Aggregate all subsystem findings
  2. Identify cross-cutting patterns
  3. Resolve conflicts/overlaps
  4. Prioritize with scoring
  5. Create phased roadmap
  6. Validate completeness

  Output: Unified refactoring roadmap with priorities"
}
</TaskCreate>
```

### Updating Tasks During Analysis

```typescript
// After completing Phase 1
<TaskUpdate>
{
  "taskId": "1",
  "status": "completed",
  "metadata": {
    "subsystems_identified": "9",
    "themes": "Duplicate patterns, circular deps, missing abstractions",
    "next": "Starting Phase 2 subsystem analysis"
  }
}
</TaskUpdate>

// During Phase 2 (tracking progress)
<TaskUpdate>
{
  "taskId": "2",
  "status": "in_progress",
  "metadata": {
    "completed_subsystems": "3/9",
    "current": "Analyzing services/coordinator",
    "findings_so_far": "15 opportunities identified"
  }
}
</TaskUpdate>

// After completing entire analysis
<TaskUpdate>
{
  "taskId": "4",
  "status": "completed",
  "metadata": {
    "total_findings": "42",
    "high_priority": "8",
    "estimated_effort": "35 days",
    "roadmap_phases": "3"
  }
}
</TaskUpdate>
```

### Example: Focused Subsystem Analysis

For analyzing a single large subsystem:

```typescript
<TaskCreate>
{
  "subject": "Analyze shared/core for refactoring opportunities",
  "activeForm": "Analyzing shared/core subsystem",
  "description": "Focused refactoring analysis of shared/core:

  Context: 189 children, central module, suspected god classes

  Analysis steps:
  1. Map public API (all exports)
  2. Identify consumers (who uses shared/core?)
  3. Find code smells (long methods, large classes)
  4. Find structural issues (coupling, circular deps)
  5. Find architectural issues (missing abstractions)
  6. Quantify improvements (LOC reduction, complexity)

  Focus areas:
  - God classes
  - Circular dependencies
  - Duplicate patterns

  Output: Detailed findings with evidence and estimates"
}
</TaskCreate>
```

### Don't Create Tasks For

- Quick spot checks (<30 minutes)
- Single-file analysis
- Simple refactoring proposals
- Analysis you can complete in one sitting

**Remember**: Refactoring analysis is often multi-phase and long-running. Tasks provide structure and visibility into your systematic approach.

---

## Handling Uncertainty in Refactoring Analysis (Critical Skill)

Refactoring recommendations affect significant code. Handle uncertainty carefully:

---

### Uncertainty Type 1: Uncertain About Pattern Intentionality

**Scenario**: Code looks like it should be refactored, but might be intentional design.

**Response Pattern**:
```
**Pattern**: [what you observe]
**Locations**: [where you see it]

**Could Be**:
A) **Code smell**: [why this might be unintentional]
B) **Intentional**: [why this might be by design]

**Investigation**:
- [ ] Check for explanatory comments
- [ ] Search ADRs for mentions
- [ ] Check git history for context
- [ ] Look for similar patterns that are proven correct

**Current Assessment**: NEEDS VERIFICATION
**Confidence**: LOW until intent is confirmed

**If Intentional**: [acknowledge pattern and move on]
**If Unintentional**: [refactoring opportunity with details]
```

**Example**:
```
**Pattern**: Same WebSocket management code in 3 services (50 lines each)
**Locations**:
- services/unified-detector/src/ws-manager.ts
- services/cross-chain-detector/src/ws-handler.ts
- services/mempool-detector/src/connection.ts

**Could Be**:
A) **Code smell**: Duplication that should be consolidated in shared module
B) **Intentional**: Services intentionally isolated for deployment flexibility

**Investigation**:
- [ ] Check ADRs for service independence decisions
- [ ] Check if implementations have subtle differences (customization for each service)
- [ ] Ask: Is service independence a goal? (microservices vs. monolith)

**Current Assessment**: NEEDS VERIFICATION - Appears to be duplication but might be intentional isolation

**If Intentional**: Document as known pattern, not a refactoring opportunity
**If Unintentional**: HIGH impact refactoring (150 LOC reduction, centralized bug fixes)
```

**DO**: Present both interpretations and verify before recommending
**DON'T**: Assume duplication is always bad

---

### Uncertainty Type 2: Uncertain About Impact Quantification

**Scenario**: You think refactoring will help, but can't accurately quantify the improvement.

**Response Pattern**:
```
**Refactoring**: [proposal]

**Expected Impact**: [your estimate]
**Confidence**: LOW / MEDIUM / HIGH

**Basis for Estimate**:
- [What you counted/measured]
- [What you inferred]
- [What you're guessing]

**If Confident**: Proceed with recommendation
**If Uncertain**: [Mark as estimated and explain assumptions]

**Sensitivity Analysis**:
- Best case: [optimistic estimate]
- Likely case: [realistic estimate]
- Worst case: [pessimistic estimate]
```

**Example**:
```
**Refactoring**: Extract ChainConfig interface from 11 duplicate structures

**Expected Impact**:
- LOC reduction: ~50 lines (11 files × ~5 lines/file of structure definition)
- Maintenance: 1 place to update vs. 11 places
- Type safety: Catch missing properties at compile time

**Confidence**: MEDIUM for LOC, HIGH for maintenance benefit

**Basis for Estimate**:
- Counted actual struct definitions: 11 files ✓ (HIGH confidence)
- Estimated lines per file: ~5 lines (could be 3-8) → MEDIUM confidence
- Maintenance benefit: Qualitative but proven pattern → HIGH confidence

**Sensitivity Analysis**:
- Best case: 60 LOC reduction (if structs are verbose)
- Likely case: 45-55 LOC reduction
- Worst case: 30 LOC reduction (if structs are minimal)

**Recommendation**: Proceed - Even worst case is worthwhile for maintenance benefit
```

**DO**: Show your work and confidence levels for each claim
**DON'T**: State estimates as facts

---

### Uncertainty Type 3: Uncertain About Refactoring Risk

**Scenario**: Refactoring seems beneficial but risk is hard to assess.

**Response Pattern**:
```
**Refactoring**: [proposal]

**Benefits**: [clear benefits]

**Risks** (assessed):
- [Risk 1]: [probability] × [impact] = [severity]
  * Can mitigate by: [strategy]
- [Risk 2]: [probability] × [impact] = [severity]
  * Can mitigate by: [strategy]

**Unknown Risks**:
- [What you don't know that could affect risk]
- [What would need investigation to assess risk]

**Overall Risk**: LOW / MEDIUM / HIGH (with caveats)

**Risk Tolerance**:
- If risk-averse: [conservative recommendation]
- If risk-tolerant: [aggressive recommendation]
```

**Example**:
```
**Refactoring**: Split 800-line DetectorBase class into 3 smaller classes

**Benefits**: Better testability, clearer responsibilities, easier to maintain

**Risks** (assessed):
- Breaking existing tests: MEDIUM probability × HIGH impact = **MEDIUM severity**
  * Mitigate by: Incremental refactoring with tests running after each step
- Performance regression: LOW probability × MEDIUM impact = **LOW severity**
  * Mitigate by: Benchmark before/after (shouldn't affect perf, mostly structural)
- Merge conflicts: HIGH probability × LOW impact = **MEDIUM severity**
  * Mitigate by: Coordinate with team, do in quiet period

**Unknown Risks**:
- Don't know if this class is subclassed externally (would break inheritance)
- Don't know if there are timing dependencies between methods (could break if split)

**Overall Risk**: MEDIUM (mostly manageable, but some unknowns)

**Risk Tolerance**:
- If risk-averse: Start with extracting one small class, validate approach
- If risk-tolerant: Full refactoring in one go (faster but riskier)

**Recommendation**: Incremental approach (risk-averse) - Extract validation logic first, verify, then extract others
```

**DO**: Assess risks systematically and provide mitigation
**DON'T**: Understate risks to make refactoring look better

---

### Uncertainty Type 4: Conflicting Refactoring Findings

**Scenario**: Different subsystem analyses suggest contradictory refactorings.

**Response Pattern**:
```
**Conflict**: [describe the contradiction]

**Finding A** (from [subsystem]):
[What subsystem A recommends]

**Finding B** (from [subsystem]):
[What subsystem B recommends - contradicts A]

**Why They Conflict**:
[Explain the contradiction]

**Resolution Investigation**:
- [ ] Re-examine both code paths
- [ ] Determine if both are correct in different contexts
- [ ] Determine if one is based on misunderstanding

**Resolution**:
[Which finding is correct, or how to reconcile them]

**Updated Recommendation**: [consolidated approach]
```

**Example**:
```
**Conflict**: Centralize vs. Decentralize error handling

**Finding A** (from services/coordinator):
"Error handling is duplicated across services. Centralize in shared/errors"

**Finding B** (from services/execution-engine):
"Error handling needs service-specific logic. Keep in each service"

**Why They Conflict**:
- A sees duplication (same try-catch patterns)
- B sees customization (different error recovery strategies)

**Resolution Investigation**:
- [X] Re-examined error handlers in all services
- [X] Found: Boilerplate is same (logging, formatting)
- [X] Found: Recovery logic is service-specific (retry vs. circuit break vs. fail fast)

**Resolution**:
- Both are partially correct
- Boilerplate should be centralized (logging, formatting)
- Recovery logic should stay in services (different strategies)

**Updated Recommendation**:
- Create shared ErrorHandler base class with logging/formatting
- Services extend and override recovery strategy
- Reduces duplication while preserving customization
```

**DO**: Investigate conflicts thoroughly and provide reconciliation
**DON'T**: Ignore contradictions or pick one arbitrarily

---

### When You Can't Verify Everything

For large codebase analysis, you can't verify every detail. Be transparent:

**Pattern**:
```
**Analysis Scope**: [what you analyzed]
**Confidence**: MEDIUM / LOW

**Verified**:
- [What you directly examined]
- [What you confirmed with code/tests]

**Inferred**:
- [What you concluded based on patterns]
- [What you assumed based on conventions]

**Not Checked**:
- [What you didn't have time to verify]
- [What would require running the code]

**Recommendation**: [refactoring with caveats]

**Suggested Validation**:
- [What should be verified before implementing]
```

**Example**:
```
**Analysis Scope**: Analyzed services/execution-engine for refactoring (62 children)
**Confidence**: MEDIUM (sampled, not exhaustive)

**Verified**:
- Read 5 largest files completely (1500 LOC total)
- Searched for specific patterns (long methods >50 lines, duplicate code)
- Checked tests for coverage of refactoring targets

**Inferred**:
- Assumed similar patterns in unread files based on naming
- Assumed tests are comprehensive (91% coverage reported)

**Not Checked**:
- Didn't read all 62 files line-by-line (time constraint)
- Didn't verify all imports are actually used
- Didn't run code to verify behavior

**Recommendation**: 8 refactoring opportunities (HIGH confidence on 5, MEDIUM on 3)

**Suggested Validation**:
- Before implementing MEDIUM confidence refactorings, read surrounding code
- Run full test suite after each refactoring
- Verify no unused imports before removing anything
```

**DO**: Acknowledge scope limitations
**DON'T**: Present partial analysis as comprehensive

---

### Decision Tree: When to Recommend vs. Investigate vs. Mark Uncertain

```
Potential refactoring identified
         |
         ├─ Have I verified this pattern exists?
         │   NO → INVESTIGATE (don't speculate)
         │   YES ↓
         │
         ├─ Have I checked if it's intentional?
         │   NO → INVESTIGATE (check ADRs, comments, git)
         │   YES ↓
         │
         ├─ Can I quantify the impact?
         │   NO → MARK UNCERTAIN, provide range
         │   YES ↓
         │
         ├─ Can I assess the risk?
         │   NO → MARK UNCERTAIN, note unknown risks
         │   YES ↓
         │
         ├─ Is benefit > (effort + risk)?
         │   NO → Don't recommend
         │   YES ↓
         │
         └─ RECOMMEND with confidence level
```

---

### Examples of Good Uncertainty Communication

**Good ✅**:
```
"This appears to be a God class (800 LOC, 15 responsibilities). However, I haven't verified if it's intentionally monolithic for performance (hot path with inlining). Check ADR-005 and ADR-012 before splitting. If not intentional, HIGH priority refactoring."
```

**Bad ❌**:
```
"God class detected. Split into 3 classes." [without checking if intentional]
```

**Good ✅**:
```
"Estimated 150 LOC reduction from consolidation (3 files × ~50 lines). Confidence: MEDIUM - counted files but estimated lines per file without reading all completely. Could be 100-200 LOC actual."
```

**Bad ❌**:
```
"150 LOC reduction from consolidation." [stated as precise fact]
```

---

### Remember: Refactoring Is Investment - Uncertainty Affects ROI

- **Benefit uncertain**: Lower priority, needs verification
- **Risk uncertain**: Recommend investigation/prototyping first
- **Both certain**: High confidence recommendation

**When uncertain**: Provide ranges, mark confidence levels, suggest validation steps before full implementation.

---

## Subsystem Analysis Templates

### Template: Service Analysis

```
### Service: [service-name]

**Entry Points**: [main files]
**Dependencies**: [what it imports from shared/]
**Consumers**: [what imports from this service]

**Refactoring Opportunities**:
| Finding | Category | Priority | Effort |
|---------|----------|----------|--------|
| ... | ... | ... | ... |

**Cross-Cutting Concerns**:
- Shares [pattern] with [other-service]
- Uses [shared-module] differently than [other-service]
```

### Template: Shared Module Analysis

```
### Module: shared/[module-name]

**Exports**: [number of public exports]
**Consumers**: [which services use this]
**Internal Structure**: [major classes/functions]

**Refactoring Opportunities**:
| Finding | Category | Priority | Effort |
|---------|----------|----------|--------|
| ... | ... | ... | ... |

**Interface Stability**:
- Breaking changes would affect: [list]
- Safe to change: [list]
```

---

## Project-Specific Analysis Targets

For the arbitrage project, focus analysis on:

### High-Value Targets
| Directory | Why | Focus |
|-----------|-----|-------|
| `shared/core/` | 189 children, central module | God classes, circular deps |
| `services/execution-engine/` | 62 children, critical path | Long methods, error handling |
| `services/unified-detector/` | 30 children | Abstraction opportunities |
| `shared/config/` | 30 children | Data clumps, consistency |

### Known Patterns (Don't Flag)
| Pattern | Location | Reason |
|---------|----------|--------|
| SharedArrayBuffer | price-matrix.ts | Performance-critical (ADR-005) |
| Worker threads | path-finder.ts | Parallel processing (ADR-012) |
| Multiple try-catch | websocket handlers | Intentional per-connection isolation |

---

## Follow-up Actions

After completing analysis:

1. **Create Refactoring Roadmap** in `docs/refactoring-roadmap.md`
2. **Update task.md** with prioritized refactoring tasks
3. **Create ADR** if proposing significant architectural changes
4. **Write tests first** for any behavioral refactorings (TDD)
