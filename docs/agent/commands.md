# Agent Commands Reference

Overview of all `/slash` commands available in `.claude/commands/`. Each command is a specialized workflow optimized for Claude Opus 4.6's deep reasoning capabilities.

## Quick Reference

| Command | Type | Agents | Input | Output | Use When |
|---------|------|--------|-------|--------|----------|
| `/implement-feature` | Team | 5 (3 phases) | Feature spec | Working code + tests | Building something new |
| `/deep-analysis` | Team | 6 (parallel) | Folder path | Unified analysis report | Auditing code quality/security |
| `/refactor-analysis` | Team | 4 (+ discussion) | Directory path | Refactoring roadmap | Planning safe refactorings |
| `/fix-issues` | Team | 3 (3 phases) | Findings/plan | Verified code changes + regression tests | Fixing known issues safely |
| `/bug-hunt` | Single | 1 | Codebase area | Prioritized bug report | Finding specific bugs |
| `/enhancement-research` | Single | 1 | Topic/area | Research report | Exploring optimization ideas |

## Decision Flowchart

```
What do you need to do?
|
+-- BUILD something new (feature, test suite, module, contract)
|   +-- /implement-feature
|
+-- FIND problems in existing code
|   +-- Broad audit (security + bugs + coverage + architecture)
|   |   +-- /deep-analysis
|   +-- Targeted bug search in a specific area
|   |   +-- /bug-hunt
|   +-- Find safe refactoring opportunities
|       +-- /refactor-analysis
|
+-- FIX known problems (from a report, plan, or issue list)
|   +-- /fix-issues
|
+-- RESEARCH a potential improvement before committing
    +-- /enhancement-research
```

---

## Command Details

### `/implement-feature [description]`

**Purpose**: Build new functionality from a specification using TDD.

**When to use**:
- Adding a new service, module, endpoint, contract, or detection strategy
- Writing a new test suite for an untested area
- Building a new shared package or component
- Any task where you're creating code that doesn't exist yet

**When NOT to use**:
- Fixing a known bug (use `/fix-issues`)
- Investigating whether something is broken (use `/bug-hunt` or `/deep-analysis`)
- Exploring whether an optimization is worth doing (use `/enhancement-research`)

**How it works** (5 agents, 3 phases):

```
Phase 1: Reconnaissance (parallel)
  pattern-scout (Explore)       -- Finds template implementations, extracts recipes
  integration-mapper (Explore)  -- Maps data flow, dependencies, hot-path proximity

Phase 2: Design (parallel, independent)
  feature-architect (general-purpose) -- Designs implementation blueprint
  test-architect (general-purpose)    -- Designs TDD test strategy (independently)

Phase 3: Adversarial Review (sequential)
  adversarial-reviewer (general-purpose) -- Challenges both designs, finds gaps

Phase 4-5: Team Lead implements TDD-style, then verifies
```

**Key design principle**: The feature-architect and test-architect never see each other's output. Their independent designs create a natural cross-check that catches specification gaps before code is written.

**Output**: Working code with tests, implementation summary.

**Example invocations**:
```
/implement-feature circuit breaker for WebSocket reconnection in partition services
/implement-feature unit tests for the CommitRevealArbitrage reveal timeout edge cases
/implement-feature Redis stream consumer group health monitoring endpoint
/implement-feature new Solana-native DEX adapter following the existing adapter pattern
```

---

### `/fix-issues [findings]`

**Purpose**: Safely implement code fixes for known issues with independent regression validation.

**When to use**:
- After `/deep-analysis` produced findings you want to fix
- After `/bug-hunt` identified specific bugs
- When you have an implementation plan or issue list to execute
- Fixing specific known problems with pre-identified locations
- Any batch of fixes where regression safety matters

**When NOT to use**:
- You don't know what's wrong yet (use `/bug-hunt` or `/deep-analysis` first)
- You're building new functionality (use `/implement-feature`)
- You're exploring whether something should be changed (use `/enhancement-research`)

**How it works** (3 agents, 3 phases):

```
Phase 1: Impact Analysis (before any code changes)
  impact-analyst (Explore) -- Maps COMBINED blast radius of ALL fixes,
                              cross-fix interactions, ordering constraints

Phase 2: Implementation (with Impact Map as guardrails)
  fix-implementer (general-purpose) -- Implements fixes in safe order,
                                       constrained by Impact Map

Phase 3: Regression Validation (independent blind review)
  regression-guard (general-purpose) -- Reviews ALL diffs WITHOUT seeing
                                        fix reasoning; BLOCK power;
                                        designs regression tests

Phase 4-5: Team Lead resolves BLOCK verdicts, runs verification
```

**Key design principles**:

1. **Batch impact analysis**: The impact-analyst maps the COMBINED blast radius of all fixes together, catching interaction effects that per-fix analysis misses (e.g., fix #1 modifying a function that fix #5 depends on).

2. **Information separation**: The regression-guard receives ONLY the before/after code diffs — never the fix-implementer's reasoning. This forces evaluation of the code change on its own merits, like blind code review.

3. **BLOCK power**: The regression-guard can BLOCK fixes it deems unsafe. The Team Lead mediates between the fix-implementer and regression-guard using evidence.

**Output**: Verified code changes, regression tests, fix summary with verdicts.

**Why 3 agents instead of 1** (evidence from past fix cycles):

| Failure Mode | What Happened | Agent That Prevents It |
|-------------|---------------|----------------------|
| Fix interaction effects | Double-cooldown bug: two related fixes silently dropped all alerts | impact-analyst (maps cross-fix interactions) |
| Blast radius underestimation | core/index.ts changes cascaded to 17+ services, 50+ tests | impact-analyst (maps combined blast radius) |
| Self-validation bias | Utility wrapper misuse not caught by same agent that designed it | regression-guard (independent review) |

**Example invocations**:
```
/fix-issues (then paste findings from a /deep-analysis report)
/fix-issues Fix the nullish coalescing issues in contracts/scripts/deploy.ts
/fix-issues Address findings #1-#5 from the REFACTORING_IMPLEMENTATION_PLAN.md
```

---

### `/deep-analysis [folder]`

**Purpose**: Comprehensive multi-perspective audit of a codebase area.

**When to use**:
- Before deploying a service or contract to production
- After a major refactoring to verify nothing was missed
- Periodic health checks on critical subsystems
- When you suspect issues but don't know where to look
- When you need cross-domain coverage (architecture + bugs + security + tests + mocks + performance)

**When NOT to use**:
- You already know the specific bug (use `/fix-issues`)
- You want to build something new (use `/implement-feature`)
- You only need refactoring suggestions (use `/refactor-analysis` -- it has performance-guardian veto)

**How it works** (6 agents, all parallel):

```
All launch simultaneously:
  architecture-auditor (Explore)          -- Code vs docs/ADRs/config mismatches
  bug-hunter (general-purpose)            -- Bugs, race conditions, logic errors
  security-auditor (general-purpose)      -- DeFi attack vectors, fund safety
  test-quality-analyst (Explore)          -- Coverage gaps, dead tests, TODOs
  mock-fidelity-validator (Explore)       -- Mock accuracy vs real protocols
  performance-refactor-reviewer (Explore) -- Performance issues, code smells

Team Lead synthesizes, deduplicates, cross-references, scores findings.
```

**Output**: Unified report with findings by severity (P0-P3), coverage matrix, mock fidelity matrix, recommended action plan.

**Example invocations**:
```
/deep-analysis contracts/test
/deep-analysis services/execution-engine
/deep-analysis shared/core/src
```

---

### `/refactor-analysis [directory]`

**Purpose**: Find safe refactoring opportunities with mandatory performance safety review.

**When to use**:
- Tech debt reduction planning for a sprint
- Before restructuring a service or shared module
- When code quality has degraded and you need a prioritized cleanup plan
- When you need assurance that refactoring won't regress the <50ms hot-path target

**When NOT to use**:
- You need a full audit including security and mock fidelity (use `/deep-analysis`)
- You're building new code (use `/implement-feature`)
- You've already decided what to refactor and just need to do it (use `/fix-issues`)

**How it works** (4 agents + structured discussion):

```
Phase 1: Discovery (3 agents in parallel)
  structural-analyst (Explore)    -- Architecture, dependencies, god classes, circular deps
  code-quality-analyst (Explore)  -- Code smells, duplication, complexity hotspots
  migration-planner (Explore)     -- Test impact, dependency ordering, rollback plans

Phase 2: Performance Safety Review (sequential)
  performance-guardian (general-purpose) -- VETO POWER over hot-path refactorings

Phase 3: Discussion
  Team Lead routes objections, collects rebuttals, resolves with evidence

Phase 4-5: Final migration plan, unified report
```

**Key design principle**: The performance-guardian has **veto power**. Any refactoring touching hot-path code (price-matrix, partitioned-detector, execution-engine) must receive SAFE/CONDITIONAL/UNSAFE verdict. UNSAFE proposals are replaced with performance-safe alternatives.

**Output**: Prioritized refactoring roadmap with performance verdicts, migration phases, dependency ordering.

**Example invocations**:
```
/refactor-analysis shared/core/src
/refactor-analysis services/coordinator
/refactor-analysis contracts/src
```

---

### `/bug-hunt [area]`

**Purpose**: Targeted bug search with deep code tracing.

**When to use**:
- Investigating a specific suspicious area
- Searching for bugs after a production incident
- Pre-merge review of a complex change
- Quick targeted scan (faster than `/deep-analysis`)

**When NOT to use**:
- You need security + architecture + coverage audit too (use `/deep-analysis`)
- You already know the bug and need to fix it (use `/fix-issues`)
- You want to build something (use `/implement-feature`)

**How it works** (single agent):
- Uses a 6-step reasoning chain: Understand Intent -> Trace Data Flow -> Identify Assumptions -> Find Violations -> Verify Pattern -> Assess Impact
- Searches for anti-patterns with targeted Grep queries
- Categorizes findings: P0 Critical, P1 Functional, P2 Missing Features, P3 Code Quality

**Output**: Prioritized bug report with file:line references, evidence, and suggested fixes.

**Example invocations**:
```
/bug-hunt shared/core/src/partitioned-detector.ts
/bug-hunt services/execution-engine
/bug-hunt contracts/src/base/BaseFlashArbitrage.sol
```

---

### `/enhancement-research [topic]`

**Purpose**: Research-driven analysis of potential optimizations before committing to implementation.

**When to use**:
- Evaluating whether an optimization is worth pursuing
- Comparing multiple approaches to solve a performance or architecture problem
- Investigating industry best practices for a specific area
- Before writing an ADR for a significant change

**When NOT to use**:
- You've already decided what to build (use `/implement-feature`)
- You've already decided what to fix (use `/fix-issues`)
- You need to find bugs, not improvements (use `/bug-hunt`)

**How it works** (single agent, 5 research phases):
1. Current State Deep Dive -- reads code, ADRs, traces bottleneck
2. Bottleneck Causal Analysis -- 5 Whys root cause analysis
3. Solution Space Exploration -- brainstorms 4-5+ approaches with trade-offs
4. Decision Reasoning -- scores approaches (Impact 40%, Effort 30%, Risk 20%, Compatibility 10%)
5. Constraint Conflict Resolution -- navigates conflicting requirements

**Output**: Research report with current state analysis, industry comparison table, recommended solution, implementation tasks, risk analysis, success metrics, ADR recommendation.

**Example invocations**:
```
/enhancement-research WebSocket reconnection strategy for chain-specific staleness
/enhancement-research L2 batch submission optimization for cross-chain arbitrage
/enhancement-research Alternative to Redis Streams for sub-millisecond event processing
```

---

## Command Composition Patterns

These commands are designed to chain together. Common workflows:

### New Feature Development
```
/enhancement-research [topic]     # 1. Research: Is this worth doing? What approach?
/implement-feature [spec]         # 2. Build: Design + TDD implementation
```

### Codebase Health Cycle
```
/deep-analysis [folder]           # 1. Audit: Find all issues
/fix-issues                       # 2. Fix: Address critical findings (with regression guard)
/refactor-analysis [folder]       # 3. Plan: Safe refactoring roadmap
/fix-issues                       # 4. Refactor: Execute safe refactorings (with regression guard)
```

### Targeted Bug Fix
```
/bug-hunt [area]                  # 1. Find: Locate the bug
/fix-issues                       # 2. Fix: Implement with impact analysis + regression validation
```

### Pre-Deployment Validation
```
/deep-analysis [service]          # 1. Full audit before deployment
/bug-hunt [critical-path]         # 2. Extra scrutiny on hot path
```

### Tech Debt Sprint
```
/refactor-analysis [area]         # 1. Find safe refactorings with perf verdicts
/implement-feature [test suite]   # 2. Add missing test coverage first
/fix-issues                       # 3. Execute the approved refactorings (regression-guarded)
```

---

## Agent Type Reference

Commands use two agent types with different capabilities:

| Agent Type | Can Read | Can Search | Can Write Code | Can Run Bash | Used For |
|------------|----------|------------|----------------|--------------|----------|
| **Explore** | Yes | Yes | No | No | Safe read-only analysis, pattern scanning |
| **general-purpose** | Yes | Yes | Yes | Yes | Deep investigation, design work, code fixes |

- **Explore** agents are used when the task is purely analytical (scanning, reading, mapping)
- **general-purpose** agents are used when the task needs broader tool access (running commands, writing designs, deep investigation)
- The **Team Lead** (main Claude instance) always has full capabilities and handles coordination, conflict resolution, and final verification

---

## Team Composition Summary

| Command | Total Agents | Explore | general-purpose | Phases | Has Veto/Block Power |
|---------|-------------|---------|-----------------|--------|---------------------|
| `/implement-feature` | 5 | 2 | 3 | 3 (recon -> design -> review) | Adversarial reviewer (GO/GO WITH CHANGES/REDESIGN) |
| `/deep-analysis` | 6 | 4 | 2 | 1 (all parallel) | None (findings only) |
| `/refactor-analysis` | 4 | 3 | 1 | 2 (discovery -> safety review) | Performance-guardian (SAFE/CONDITIONAL/UNSAFE) |
| `/fix-issues` | 3 | 1 | 2 | 3 (impact -> fix -> validate) | Regression-guard (SAFE/CAUTION/BLOCK) |
| `/bug-hunt` | 1 | 0 | 1 | 1 (single pass) | None (findings only) |
| `/enhancement-research` | 1 | 0 | 1 | 1 (5 research phases) | None (recommendations only) |

---

## Cross-Cutting Protocols

All commands share these foundational protocols:

### Anti-Hallucination
Every command enforces evidence-based findings:
- Never report issues without exact file:line references
- Never assume behavior -- read actual implementation with tools
- Prefer under-reporting to false positives
- Mark unproven findings as NEEDS VERIFICATION

### Performance Awareness
Every command respects the <50ms hot-path target:
- Assess hot-path proximity for all findings/designs
- Never introduce allocations in tight loops
- Never introduce O(n) lookups where O(1) exists
- Performance bugs in hot-path code are automatically P0

### Confidence Calibration
All findings use consistent confidence levels:
- **HIGH (90-100%)**: Full data flow traced, verified in code
- **MEDIUM (70-89%)**: Strong evidence, minor uncertainties
- **LOW (50-69%)**: Code smell, not proven
- **NEEDS VERIFICATION (<50%)**: Suspicious but unproven

### Information Separation (Team Commands)
Where applicable, agents are deliberately given different information to prevent confirmation bias:
- `/implement-feature`: feature-architect and test-architect never see each other's output
- `/fix-issues`: regression-guard never sees fix-implementer's reasoning
- `/refactor-analysis`: performance-guardian reviews proposals without proposers' justifications
