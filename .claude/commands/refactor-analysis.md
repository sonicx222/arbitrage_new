---
description: Detect refactoring opportunities using hybrid top-down/bottom-up analysis
---

# Refactoring Analysis Workflow

## Prompt Template

Use this prompt to systematically detect refactoring opportunities across the codebase:

```
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

Delegate each subsystem to a focused analysis:

#### Sub-Agent Task Template
---
**Subsystem**: [Name]
**Scope**: [directories]
**Analysis Focus**:
1. Map all public exports and their consumers
2. Identify internal coupling patterns
3. Find refactoring opportunities within scope
4. Report cross-cutting concerns (shared with other subsystems)

**Return Format**:
| Finding | Type | Impact | Effort | Evidence |
|---------|------|--------|--------|----------|
| [Issue] | [Category] | HIGH/MED/LOW | X days | [location] |
---

### Phase 3: BOTTOM-UP VALIDATION (Precision)

For each finding from Phase 2:
1. Trace actual code paths that would be affected
2. Verify with existing tests (any that would break?)
3. Check if pattern exists elsewhere (consistency)
4. Quantify improvement (lines, complexity, coupling)

### Phase 4: SYNTHESIS

1. Aggregate all sub-agent findings
2. Resolve conflicts and overlaps
3. Prioritize by: impact × confidence ÷ effort
4. Create unified refactoring roadmap

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
