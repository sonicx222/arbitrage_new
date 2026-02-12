---
description: Audit test suite quality using 5-agent team with inventory, unit test critique, integration test validation, and consolidation planning
---

# Test Suite Audit (Team-Based)

**Target**: `$ARGUMENTS`

> If `$ARGUMENTS` is empty, audit the entire project's test suite. If a folder path is provided, scope the audit to that area only.

## Model Capabilities (Opus 4.6)

You are running on Claude Opus 4.6 with full agent team capabilities:
- **Phased Team Orchestration**: Coordinate 5 specialized agents across 3 phases (inventory -> deep analysis -> consolidation strategy)
- **Per-Test Deep Reasoning**: Each test is analyzed for intent, necessity, categorization, and quality — not just surface-level linting
- **Information Separation**: Three Phase 2 agents evaluate tests from genuinely different perspectives (individual quality vs architectural compliance vs cross-test relationships), creating natural cross-validation
- **Architecture-Aware Validation**: Integration tests are evaluated against actual ADRs and documented architecture, not just "does it use real dependencies?"
- **Self-Correction**: Identify and correct reasoning errors at every phase gate

**Leverage these actively**: Use TeamCreate to spawn a team. Use Task tool with `team_name` to spawn teammates. Use TodoWrite to track progress across all phases. Phase 1 agents build the inventory; Phase 2 agents analyze deeply using the inventory as input. Synthesize all findings into a prioritized audit report.

## Role & Expertise

You are the **Team Lead** — a senior Node.js/TypeScript testing architect who:
- Designs test suites that are minimal, clear, and maximally informative when they fail
- Distinguishes sharply between unit, integration, and e2e tests — each has a distinct role
- Knows that integration tests with mocked dependencies are just unit tests wearing a disguise
- Values simplicity: a test should be the simplest possible proof that behavior works
- Follows the Testing Trophy model: integration tests provide the most value per test

## Context

Professional multi-chain arbitrage trading system:
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **Architecture**: Partitioned detectors (4 partitions), Redis Streams (ADR-002), L1 Price Matrix with SharedArrayBuffer (ADR-005), Worker threads for path finding (ADR-012), Circuit breakers (ADR-018)
- **Stack**: TypeScript, Node.js, Solidity ^0.8.19, Hardhat, ethers v6, Jest, OpenZeppelin 4.9.6
- **Test Framework**: Jest (services/shared) + Hardhat/Chai (contracts)
- **Test Categories**: 6 Jest projects (unit, integration, e2e, performance, smoke, ml)
- **Test Architecture**: ADR-009 defines test organization conventions

### Current Test Landscape

```
~237 test files total:
  shared/core          ~97 files (unit tests + co-located tests)
  services/*           ~83 files (unit + some integration)
  tests/integration/    22 files (centralized integration tests)
  contracts/test/       10 files (Hardhat + Chai)
  scripts/lib/           5 files (utility tests)
  shared/config,ml,security  ~20 files (unit tests)
```

**Test organization**: `module/__tests__/{unit|integration|e2e|performance}/`
**Integration naming**: `sX.Y.Z-feature-description.integration.test.ts`
**Shared utilities**: `shared/test-utils/src/` (builders, factories, fixtures, harnesses, mocks, helpers)

---

## Why 5 Agents (Evidence-Based)

A test audit requires three genuinely different analytical perspectives that create cross-validation when combined:

| Perspective | What It Evaluates | Why Separate |
|-------------|-------------------|--------------|
| **Individual test quality** | Is this specific test well-written, necessary, simple? | Evaluates each test in isolation — needed for refactoring recommendations |
| **Architectural compliance** | Does this integration test verify what the ADRs say should work? | Evaluates tests against architecture — a clean test can still test the wrong thing |
| **Cross-test relationships** | Are tests redundant? What's missing? What should merge? | Evaluates tests against each other — two excellent tests might be duplicates |

**These perspectives produce genuine cross-validation:**
- A test might look clean and well-structured (unit-test-critic says: GOOD) but be completely redundant with 3 other tests (consolidation-strategist says: CONSOLIDATE)
- An integration test might follow proper patterns with real Redis (integration-test-validator says: GOOD PATTERN) but not actually test the ADR-specified behavior (integration-test-validator says: WRONG FOCUS)
- A test might seem necessary in isolation (unit-test-critic says: KEEP) but become unnecessary once a better integration test exists (consolidation-strategist says: SUPERSEDED)

**Phase 1** (2 Explore agents): Build the inventory that Phase 2 agents use as input. Without this, Phase 2 agents would waste effort rediscovering what exists.

**Phase 2** (3 agents): Apply the three perspectives in parallel. Each agent receives the Phase 1 inventory but analyzes from their specific angle.

---

## Team Structure

You are the **Team Lead**. Your responsibilities:
1. Create the team and task list using TeamCreate
2. Read `docs/agent/code_conventions.md` and `docs/architecture/adr/ADR-009-test-architecture.md` for shared context
3. Execute the 3-phase plan (inventory -> deep analysis -> synthesis)
4. Synthesize all agent outputs into a unified audit report
5. Produce the actionable refactoring plan with priorities

---

### Agent 1: "test-cataloger" (subagent_type: Explore)

**Mission**: Scan every test file in scope and produce a structured inventory with categorization, structure mapping, and mock dependency analysis.

**Why this agent**: Phase 2 agents need a complete inventory to work from. Without knowing what exists, the unit-test-critic might miss files, the integration-test-validator might not know which tests claim to be integration tests, and the consolidation-strategist can't find duplicates across distant folders.

**Investigation protocol**:

1. **Scan all test files**: Use Glob to find every `*.test.ts`, `*.test.js`, `*.spec.ts`, `*.integration.test.ts`, `*.perf.ts`, `*.smoke.ts` in scope.

2. **For each test file, extract**:
   ```
   FILE: [path]
   CATEGORY: unit | integration | e2e | performance | smoke | contract | script
   CATEGORIZATION BASIS: [why this category — folder location, naming, content]
   TEST COUNT: [number of it()/test() calls]
   DESCRIBE STRUCTURE: [top-level describe blocks and nesting]
   SOURCE MODULE TESTED: [which source file/class this tests, if identifiable]
   MOCK DEPENDENCIES: [list of jest.mock() calls or manual mocks]
   REAL DEPENDENCIES: [any real Redis, real DB, real network calls]
   SETUP COMPLEXITY: [LOW: <10 lines beforeEach | MEDIUM: 10-30 lines | HIGH: >30 lines]
   PLACEMENT: CORRECT | MISPLACED ([reason])
   ```

3. **Validate placement against conventions**:
   - Unit tests MUST be in `__tests__/unit/` directories
   - Integration tests MUST be in `__tests__/integration/` or `tests/integration/`
   - Integration tests MUST use `.integration.test.ts` naming
   - Performance tests MUST be in `__tests__/performance/` or `tests/performance/`
   - Contract tests MUST be in `contracts/test/`
   - Flag any test that is miscategorized based on its CONTENT vs its LOCATION

4. **Identify suspicious patterns**:
   - Tests in `unit/` that use real Redis or real network calls (misplaced integration tests)
   - Tests in `integration/` that mock everything (misplaced unit tests)
   - Tests with no clear source module target (orphaned tests)
   - Test files with 0 or 1 test cases (possibly incomplete)

**Deliverable**: Complete Test Inventory as a structured table:

```markdown
## Test Inventory

### Summary
- Total test files: [N]
- Unit tests: [N] files, [N] test cases
- Integration tests: [N] files, [N] test cases
- Contract tests: [N] files, [N] test cases
- Other (performance/smoke/e2e): [N] files
- Misplaced tests: [N] files

### Misplaced Tests
| File | Current Category | Should Be | Reason |
|------|-----------------|-----------|--------|

### Full Inventory
[Per-file extraction as above, grouped by category]
```

**What NOT to do**:
- Don't evaluate test quality (that's the unit-test-critic's and integration-test-validator's job)
- Don't suggest consolidations (that's the consolidation-strategist's job)
- Don't read test implementation deeply — scan structure and mock imports
- Don't suggest code changes

**Quality gates**:
- [ ] Every test file in scope is cataloged (verify with Glob count)
- [ ] Every test has a CATEGORY assignment with explicit basis
- [ ] Every test has SOURCE MODULE TESTED identified (or marked "unclear")
- [ ] Every test has MOCK DEPENDENCIES listed
- [ ] Placement validation checked against ADR-009 conventions
- [ ] Suspicious patterns section completed

---

### Agent 2: "source-coverage-mapper" (subagent_type: Explore)

**Mission**: Map every source module to its test coverage. Identify testing gaps, testing overlaps, and ADR compliance coverage.

**Why this agent**: Knowing what IS tested is only half the picture. Knowing what ISN'T tested reveals the real risk. And knowing which ADR-specified behaviors have dedicated tests shows whether the test suite actually validates the architecture.

**Investigation protocol**:

1. **Map source modules to tests**: For each source directory in scope:
   - List all `.ts` source files (excluding test files, type-only files, barrel exports)
   - For each source file, find all test files that import or mock it (use Grep)
   - Mark coverage: TESTED (has dedicated test) | PARTIALLY TESTED (tested as dependency of another test) | UNTESTED

2. **Identify testing gaps**: Source modules with no dedicated tests:
   ```
   GAP: [source file path]
   RISK: HIGH | MEDIUM | LOW
   RISK REASONING: [why this matters — is it hot-path? Is it security-critical? Is it complex logic?]
   SHOULD HAVE: unit | integration | both
   ```

3. **Identify testing overlaps**: Source modules tested by multiple test files:
   ```
   OVERLAP: [source module]
   TESTED BY: [list of test files]
   OVERLAP TYPE: redundant (same behavior tested) | complementary (different aspects) | unclear
   ```

4. **Map ADR compliance coverage**: Read ADR titles from `docs/architecture/adr/` and check:
   - Does ADR-002 (Redis Streams) have integration tests verifying stream behavior?
   - Does ADR-005 (Hierarchical Cache/Price Matrix) have tests verifying cache behavior?
   - Does ADR-009 (Test Architecture) conventions being followed?
   - Does ADR-012 (Worker Threads) have tests verifying parallel processing?
   - Does ADR-018 (Circuit Breaker) have tests verifying circuit breaker behavior?
   - For each relevant ADR, note: COVERED | PARTIALLY COVERED | NOT COVERED

5. **Map critical path coverage**: For hot-path modules specifically:
   - `shared/core/src/price-matrix.ts` — what tests exist? Unit? Integration? Performance?
   - `shared/core/src/partitioned-detector.ts` — same
   - `services/execution-engine/` — same
   - `services/unified-detector/` — same

**Deliverable**: Coverage Map containing:

```markdown
## Source-to-Test Coverage Map

### Coverage Summary
- Total source modules: [N]
- Tested (dedicated test): [N] ([%])
- Partially tested: [N] ([%])
- Untested: [N] ([%])

### Critical Gaps (HIGH risk untested modules)
| Source Module | Risk | Reason | Recommended Test Type |
|--------------|------|--------|----------------------|

### Testing Overlaps (potential redundancy)
| Source Module | Test Files | Overlap Type |
|--------------|-----------|--------------|

### ADR Compliance Coverage
| ADR | Title | Test Coverage | Notes |
|-----|-------|--------------|-------|

### Hot-Path Coverage
| Module | Unit Tests | Integration Tests | Performance Tests |
|--------|-----------|------------------|-------------------|
```

**What NOT to do**:
- Don't evaluate individual test quality (that's other agents' job)
- Don't suggest test implementations
- Don't read test logic deeply — just map imports and test targets
- Don't analyze contract tests (they have different patterns)

**Quality gates**:
- [ ] Every source module in scope is mapped (not just tested ones)
- [ ] Every gap has a risk assessment with reasoning
- [ ] ADR compliance coverage checked for all relevant ADRs
- [ ] Hot-path modules specifically assessed
- [ ] Overlaps classified as redundant vs complementary

---

### Agent 3: "unit-test-critic" (subagent_type: general-purpose)

**Mission**: Deep quality analysis of every unit test and contract test. For each test, evaluate: why it exists, what it actually tests, whether it's necessary, whether it's over-engineered, and how it can be improved.

**Why this agent**: Unit tests are the foundation of the test suite. But a bad unit test is worse than no test — it gives false confidence, slows down development, and resists refactoring. This agent applies rigorous quality standards to each test individually, answering the user's core questions: Is this test needed? Is it testing the right thing? Can it be simpler?

**Analysis protocol** (for EACH unit test file):

1. **Understand the test's purpose**:
   - Read the test file AND the source file it tests
   - For each `describe` block: what behavior is being tested?
   - For each `it`/`test`: what specific assertion is being made?
   - WHY was this test created? (regression catch? feature validation? edge case?)

2. **Evaluate what it actually tests**:
   - Does it test BEHAVIOR or IMPLEMENTATION DETAILS?
   - Would this test break if the code was refactored but behavior stayed the same? (fragile test)
   - Does it test the PUBLIC API of the module or reach into internals?
   - Are the assertions meaningful? (testing `expect(mock).toHaveBeenCalled()` is often testing the mock, not the code)

3. **Evaluate necessity**:
   - Would removing this test reduce confidence in the codebase? By how much?
   - Is this test the ONLY test for this behavior, or is it redundant with another test?
   - Is the behavior being tested trivial (e.g., testing a getter returns a value)?
   - VERDICT: ESSENTIAL | VALUABLE | REDUNDANT | UNNECESSARY

4. **Evaluate over-engineering**:
   - Is the test setup disproportionately complex relative to what's being tested?
   - Are there unnecessary abstractions (helper functions that obscure intent)?
   - Are there unnecessary mock configurations (mocking things the test doesn't care about)?
   - Could the same behavior be tested with fewer lines and clearer intent?
   - VERDICT: CLEAN | COULD SIMPLIFY | OVER-ENGINEERED

5. **Evaluate clean code**:
   - Does the test follow AAA (Arrange-Act-Assert) pattern?
   - Is the test name descriptive? ("should X when Y" format)
   - Is the test self-contained? (can you understand it without reading 5 helper files?)
   - Are there magic numbers or unexplained values?
   - Is the mock setup clear and minimal?

6. **Refactoring recommendation** (if applicable):
   ```
   CURRENT: [brief description of current test]
   ISSUE: [what's wrong — over-engineering, poor naming, testing implementation, etc.]
   SUGGESTED: [brief description of improved test]
   EFFORT: LOW | MEDIUM | HIGH
   ```

**For contract tests** (Hardhat/Chai), additionally evaluate:
- Does it use `loadFixture()` properly?
- Does it test specific error types (not bare `.to.be.reverted`)?
- Does it distinguish OZ 4.9.6 string errors from custom errors?
- Does it test both authorized and unauthorized callers?

**Deliverable**: Unit Test Quality Report:

```markdown
## Unit Test Quality Report

### Summary
- Tests analyzed: [N] files, [N] test cases
- ESSENTIAL: [N] | VALUABLE: [N] | REDUNDANT: [N] | UNNECESSARY: [N]
- CLEAN: [N] | COULD SIMPLIFY: [N] | OVER-ENGINEERED: [N]

### Per-File Analysis
[For each file: purpose, what it tests, necessity verdict, engineering verdict, specific recommendations]

### Top Refactoring Opportunities (sorted by impact)
| # | File | Issue | Recommendation | Effort |
|---|------|-------|----------------|--------|

### Contract Test Analysis
[Separate section for Hardhat tests]
```

**What NOT to do**:
- Don't evaluate integration tests (that's the integration-test-validator's job)
- Don't suggest test consolidations across files (that's the consolidation-strategist's job)
- Don't propose new tests for untested code (that's a different concern)
- Don't flag tests as bad just because they're long — length is fine if the behavior is complex
- Don't flag mock usage as bad per se — unit tests SHOULD mock external dependencies

**Quality gates**:
- [ ] Every unit test file in scope has a necessity verdict (ESSENTIAL/VALUABLE/REDUNDANT/UNNECESSARY)
- [ ] Every unit test file has an engineering verdict (CLEAN/COULD SIMPLIFY/OVER-ENGINEERED)
- [ ] Source file was READ (not assumed) for every test analyzed
- [ ] Refactoring recommendations include concrete "before/after" descriptions
- [ ] Contract tests evaluated with Hardhat-specific criteria
- [ ] No false positives on known correct patterns (see table below)

---

### Agent 4: "integration-test-validator" (subagent_type: general-purpose)

**Mission**: Deep authenticity validation of every integration test. Determine whether each test genuinely validates component interactions or is just a unit test wearing integration test clothing. Verify ADR compliance and real dependency usage.

**Why this agent**: Integration tests are the most valuable tests in the suite — but only if they actually test real interactions. A test that mocks all dependencies and calls itself "integration" provides false confidence. This agent applies the strictest standard: does this test prove that components work together as the architecture specifies?

**Validation protocol** (for EACH integration test file):

1. **Authenticity check — Real vs Mock Theater**:
   - Read the test file completely
   - List ALL dependencies: which are real, which are mocked?
   - KEY QUESTION: Would this test catch a bug in the INTERACTION between components?
   - If every external dependency is mocked → this is a unit test, not an integration test
   - VERDICT: AUTHENTIC INTEGRATION | PARTIAL INTEGRATION | MOCK THEATER (misplaced unit test)

2. **Redis usage check**:
   - Does this test use real Redis (in-memory or Docker)?
   - Does this test mock Redis? If so, why?
   - For tests that mock Redis: could they use in-memory Redis instead?
   - Check for imports from `shared/test-utils/src/integration/redis-helpers.ts` or `redis-pool.ts`
   - VERDICT: REAL REDIS | MOCKED REDIS (should be real) | MOCKED REDIS (acceptable: [reason]) | N/A

3. **ADR compliance check**:
   - What architectural behavior does this test claim to validate?
   - Read the relevant ADR(s) to understand what SHOULD be tested
   - Does the test actually verify the ADR-specified behavior?
   - Example: ADR-002 specifies Redis Streams for event processing. Does the integration test verify that events flow through Redis Streams correctly, or does it just test that a function returns the right value?
   - VERDICT: ADR COMPLIANT | ADR GAP ([what's missing]) | NO ADR RELEVANCE

4. **Component boundary check**:
   - Which component boundaries does this test cross?
   - Are these the RIGHT boundaries to test? (based on architecture)
   - Does this test validate the CONTRACT between components, or just call through them?
   - A good integration test exercises: Module A -> [boundary] -> Module B -> [boundary] -> Module C
   - A bad integration test exercises: Mock A -> Module B -> Mock C (that's just unit testing B)

5. **Test effectiveness assessment**:
   - What category of bugs would this test catch?
     - Serialization/deserialization mismatches?
     - Timing/ordering issues?
     - State management across components?
     - Configuration propagation?
     - Error handling across boundaries?
   - What category of bugs would this test MISS?
   - How valuable is this test compared to unit tests of the same code?

6. **Per-test verdict**:
   ```
   FILE: [path]
   AUTHENTICITY: AUTHENTIC | PARTIAL | MOCK THEATER
   REDIS USAGE: REAL | MOCKED (should be real) | MOCKED (acceptable) | N/A
   ADR COMPLIANCE: COMPLIANT | GAP | N/A
   BOUNDARIES TESTED: [list]
   BUG CATEGORIES CAUGHT: [list]
   OVERALL: KEEP AS-IS | UPGRADE TO REAL DEPS | DOWNGRADE TO UNIT | REWRITE FOCUS | REMOVE
   RECOMMENDATION: [specific improvement if not KEEP AS-IS]
   ```

**Deliverable**: Integration Test Validation Report:

```markdown
## Integration Test Validation Report

### Summary
- Integration tests analyzed: [N] files, [N] test cases
- AUTHENTIC: [N] | PARTIAL: [N] | MOCK THEATER: [N]
- REAL REDIS: [N] | MOCKED REDIS (should be real): [N] | MOCKED REDIS (acceptable): [N]
- ADR COMPLIANT: [N] | ADR GAPS: [N]

### Mock Theater Tests (should be reclassified or upgraded)
| File | Current Mocks | Why It's Mock Theater | Recommendation |
|------|--------------|----------------------|----------------|

### ADR Compliance Gaps
| ADR | Expected Test Coverage | Actual | Gap |
|-----|----------------------|--------|-----|

### Per-File Validation
[For each file: authenticity verdict, Redis verdict, ADR compliance, boundaries, recommendations]

### Recommended Upgrades (priority order)
| # | File | Current State | Target State | Effort | Value |
|---|------|--------------|-------------|--------|-------|
```

**What NOT to do**:
- Don't evaluate unit tests (that's the unit-test-critic's job)
- Don't suggest consolidations across files (that's the consolidation-strategist's job)
- Don't penalize tests for having SOME mocks — integration tests can mock external services (3rd party APIs) while using real internal components
- Don't recommend upgrading to real dependencies when the infrastructure doesn't support it (e.g., if there's no in-memory Redis setup for a service)
- Don't evaluate code style or naming — focus on WHAT is being tested, not HOW it's written

**Quality gates**:
- [ ] Every integration test file has an authenticity verdict with evidence
- [ ] Every integration test with Redis has a Redis usage verdict
- [ ] ADR compliance checked for all relevant ADRs
- [ ] Component boundaries explicitly identified for each test
- [ ] Bug categories (what this test catches) documented for each test
- [ ] Mock Theater tests have specific upgrade recommendations

---

### Agent 5: "test-consolidation-strategist" (subagent_type: general-purpose)

**Mission**: Analyze tests in RELATION to each other. Identify redundancy, propose consolidations, design the optimal test structure, and fill critical gaps.

**Why this agent**: The unit-test-critic and integration-test-validator evaluate tests individually. But the biggest improvements come from structural changes: merging 5 tests that verify the same behavior, removing tests superseded by better integration tests, reorganizing tests to match the architectural boundaries. This agent sees the forest, not just the trees.

**Analysis protocol**:

1. **Redundancy detection**: Find tests that verify the same behavior:
   - Search for tests with similar describe/it descriptions
   - Search for tests that import and test the same source module
   - Search for tests that mock the same dependencies in the same way
   - For each cluster of related tests:
     ```
     CLUSTER: [behavior being tested]
     TESTS: [list of test files and specific it() blocks]
     OVERLAP: [what exactly overlaps]
     RECOMMENDATION: KEEP ALL (complementary) | MERGE INTO ONE | KEEP BEST, REMOVE REST
     MERGE TARGET: [which file should be the surviving test, or "new file"]
     ```

2. **Superseded test detection**: Find unit tests that are fully covered by integration tests:
   - If an integration test exercises module A with real dependencies, and unit test for A just mocks those same dependencies → the integration test is superior
   - Mark unit tests that are FULLY superseded (not partially — only if the integration test covers all assertions)
   - VERDICT: SUPERSEDED BY [integration test file] | NOT SUPERSEDED

3. **Structural improvements**: Evaluate the overall test organization:
   - Are test files in the right directories? (per ADR-009)
   - Should any test files be split? (file tests multiple unrelated modules)
   - Should any test files be merged? (multiple files test the same module trivially)
   - Is the naming consistent? (`.test.ts` everywhere? `.integration.test.ts` for integrations?)

4. **Gap analysis**: What's NOT tested that SHOULD be?
   - Cross-reference with the source-coverage-mapper's gaps
   - Prioritize by risk: hot-path modules, security-critical code, complex logic
   - For each gap:
     ```
     GAP: [what's untested]
     RISK: P0 | P1 | P2 | P3
     RECOMMENDED TEST TYPE: unit | integration | both
     WHAT TO TEST: [specific behaviors]
     ```

5. **Target test structure**: Design the ideal test organization:
   - How many tests should exist per module? (guideline, not absolute)
   - Where should each test type live?
   - What shared utilities could reduce duplication?
   - Which builder/factory patterns should be adopted more widely?

**Deliverable**: Test Consolidation Plan:

```markdown
## Test Consolidation Plan

### Summary
- Redundant test clusters found: [N]
- Tests recommended for removal: [N]
- Tests recommended for merge: [N]
- Tests recommended for reclassification: [N]
- Critical gaps identified: [N]

### Redundancy Clusters
[For each cluster: tests involved, overlap, recommendation]

### Superseded Tests
| Unit Test | Superseded By (Integration Test) | Safe to Remove? |
|-----------|--------------------------------|-----------------|

### Structural Changes
| Action | Current | Target | Reason |
|--------|---------|--------|--------|

### Critical Gaps (sorted by risk)
| # | Gap | Risk | Recommended Test Type | What to Test |
|---|-----|------|----------------------|-------------|

### Target Test Structure
[Description of ideal organization]
```

**What NOT to do**:
- Don't evaluate individual test code quality (that's the unit-test-critic's job)
- Don't evaluate integration test authenticity (that's the integration-test-validator's job)
- Don't recommend removing tests without verifying the behavior IS covered elsewhere
- Don't propose massive restructurings that would break CI — keep changes incremental
- Don't add scope beyond test organization (no code refactoring, no feature additions)

**Quality gates**:
- [ ] Every redundancy cluster verified by reading ALL involved test files
- [ ] Superseded tests verified: integration test actually covers ALL unit test assertions
- [ ] Gap analysis cross-referenced with source module inventory
- [ ] Structural changes are incremental (not "rewrite everything")
- [ ] No test removal recommended without verified coverage elsewhere

---

## Critical Rules (Apply to ALL Agents)

### Anti-Hallucination Protocol
- **NEVER** claim a test is redundant without reading BOTH tests and verifying they test the same behavior
- **NEVER** claim a test is unnecessary without understanding what behavior it guards
- **NEVER** categorize a test without reading its actual content (not just its location)
- **IF** a test's purpose is unclear, label as NEEDS CLARIFICATION, not UNNECESSARY
- **PREFER** under-reporting to false positives — recommending removal of an important test is worse than missing a redundancy
- **NEVER GUESS.** Read the test file AND the source file with tools first.

### Node.js Testing Best Practices (Evaluation Criteria)

These are the standards agents should evaluate against:

**Unit Tests Should**:
- Test behavior, not implementation (survives refactoring)
- Use AAA pattern (Arrange-Act-Assert)
- Mock ONLY external dependencies (not the module under test)
- Have descriptive names: "should [expected] when [scenario]"
- Be self-contained (understandable without reading helper files)
- Use constructor DI for testable classes (this codebase's pattern)
- Set up mocks in `beforeEach()`, override in individual tests
- Run in <100ms each

**Integration Tests Should**:
- Use REAL dependencies (in-memory Redis, not mocked Redis)
- Test component INTERACTIONS, not isolated behavior
- Validate that data flows correctly across module boundaries
- Verify behavior documented in ADRs and architecture docs
- Use `shared/test-utils/src/integration/` helpers
- Run in <5s each

**E2E Tests Should**:
- Test complete user flows end-to-end
- Require full service startup
- Be the fewest in number (Testing Trophy)

**Contract Tests Should**:
- Use `loadFixture()` for every test (snapshot/restore)
- Specify exact error types (never bare `.to.be.reverted`)
- Test both authorized and unauthorized callers
- Match token decimals between mock setup and assertions
- Use OpenZeppelin 4.9.6 patterns (string-based require for ERC20)

**Anti-Patterns to Flag**:
- Mock Theater: Integration tests that mock everything
- Testing Mocks: `expect(mock).toHaveBeenCalledWith(...)` when the mock call ISN'T the behavior being validated
- Fragile Tests: Tests that break on internal refactoring while behavior is unchanged
- Test Setup Towers: 50+ lines of setup for a 3-line assertion
- God Tests: Single test that verifies 10 unrelated behaviors
- Shotgun Tests: Same behavior tested in 5 different files
- Zombie Tests: Tests that always pass regardless of code changes (usually due to over-mocking)

### Investigation Strategy (all agents)
1. **Read full test files** using Read tool (not just snippets)
2. **Read the source module** that each test targets (using Read or Grep to find it)
3. **Search for related tests** using Grep — find other tests for the same module
4. **Use TodoWrite** to track findings as you go
5. When investigating across multiple files, launch parallel Read/Grep in a single response

### Known Correct Patterns (Don't Flag)

| Pattern | Location | Reason |
|---------|----------|--------|
| Constructor DI in tests | All service tests | Project convention for testable classes |
| `jest.mock('@arbitrage/core')` | Service tests | Mocking shared packages in unit tests is correct |
| `loadFixture(deployContractsFixture)` | Contract tests | Hardhat snapshot/restore pattern |
| Real Redis in integration tests | `tests/integration/` | Correct: integration tests should use real deps |
| Custom `toBeWithinRange` matcher | jest-setup.ts | Project-specific custom matcher |
| `resetAllSingletons()` in afterEach | jest-setup.ts | Prevents singleton state leakage |
| `as jest.Mock` casts | Unit tests | TypeScript limitation for mock typing |
| Builder pattern | `shared/test-utils/src/builders/` | Fluent test data construction |
| Epic/story naming `sX.Y.Z-` | Integration tests | Traceability convention |
| `it.skip()` with reason | Various | Acceptable for known flaky timing tests |

---

## Execution Plan

### Phase 1: Setup + Inventory

1. Use TodoWrite to create tracking items for all phases
2. Use TeamCreate to create the test-audit team
3. Read `docs/agent/code_conventions.md` for shared context
4. Read `docs/architecture/adr/ADR-009-test-architecture.md` for test architecture conventions

Spawn both inventory agents **in a single message** with 2 parallel Task tool calls:

| # | Agent Name | subagent_type | Focus |
|---|-----------|---------------|-------|
| 1 | test-cataloger | Explore | Complete test file inventory with categorization |
| 2 | source-coverage-mapper | Explore | Source-to-test mapping, gaps, ADR coverage |

Each agent prompt MUST include:
- The target scope (`$ARGUMENTS` or "entire project")
- Their specific investigation protocol, deliverable format, and quality gates (copy from above)
- The Critical Rules section (Anti-Hallucination, Best Practices, Known Correct Patterns)
- Current test landscape summary (from Context section)

### Phase 2: Deep Analysis (after Phase 1)

After BOTH Phase 1 agents complete, spawn all 3 analysis agents **in a single message** with 3 parallel Task tool calls:

| # | Agent Name | subagent_type | Focus |
|---|-----------|---------------|-------|
| 3 | unit-test-critic | general-purpose | Per-test quality analysis for unit + contract tests |
| 4 | integration-test-validator | general-purpose | Integration test authenticity and ADR compliance |
| 5 | test-consolidation-strategist | general-purpose | Cross-test redundancy, consolidation, gaps |

Each agent prompt MUST include:
- The FULL Test Inventory output from Agent 1 (so agents know what exists)
- The FULL Coverage Map output from Agent 2 (so agents know what's covered)
- Their specific analysis/validation protocol, deliverable format, and quality gates (copy from above)
- The Critical Rules section (Anti-Hallucination, Best Practices, Known Correct Patterns)
- The Node.js Testing Best Practices section

**Agent-specific inputs**:
- **unit-test-critic**: List of unit test files from the inventory (filter to unit + contract categories only)
- **integration-test-validator**: List of integration test files from the inventory (filter to integration category only)
- **test-consolidation-strategist**: Complete inventory AND coverage map (needs both to find redundancies and gaps)

**IMPORTANT**: The unit-test-critic and integration-test-validator MUST analyze ALL tests in their category. For large scopes, they should prioritize:
1. Files with HIGH setup complexity (likely over-engineered)
2. Files with many tests (>20 test cases — potential for consolidation)
3. Files testing hot-path modules (highest risk)
4. Then remaining files

### Phase 3: Synthesis (Team Lead)

After ALL Phase 2 agents complete:

1. **Cross-reference findings**: Look for agreements and disagreements across agents:
   - Tests flagged as REDUNDANT by the critic AND as part of a cluster by the strategist → high confidence
   - Tests flagged as MOCK THEATER by the validator AND as OVER-ENGINEERED by the critic → double-confirm
   - Tests flagged as ESSENTIAL by the critic BUT as part of a redundancy cluster → investigate which to keep

2. **Resolve conflicts**: When agents disagree:
   - Read the test file yourself to make the final call
   - The unit-test-critic sees quality; the consolidation-strategist sees overlap — both can be right
   - A test can be well-written AND redundant

3. **Prioritize recommendations**:
   - P0: Tests that give FALSE CONFIDENCE (mock theater integration tests, zombie tests)
   - P1: Tests that should be consolidated (shotgun testing, redundant clusters)
   - P2: Tests that should be simplified (over-engineered but functional)
   - P3: Tests that should be moved (correct but misplaced)
   - P4: Gaps that need new tests (missing coverage)

4. **Produce the unified audit report** (see Output Format below)

### Phase 4: Summary

Write the audit report to `.agent-reports/TEST_AUDIT_REPORT.md` and present a brief summary to the user.

---

## Output Format

### Test Suite Audit Report

```markdown
# Test Suite Audit Report

**Scope**: [target]
**Date**: [date]
**Test Files Analyzed**: [N]
**Test Cases Analyzed**: [N]

## Executive Summary

### Health Score: [A+ through F]

| Dimension | Score | Notes |
|-----------|-------|-------|
| Test Necessity | [%] tests are ESSENTIAL or VALUABLE | [N] unnecessary/redundant |
| Test Quality | [%] tests are CLEAN | [N] over-engineered |
| Integration Authenticity | [%] integration tests are AUTHENTIC | [N] mock theater |
| Coverage | [%] source modules have tests | [N] critical gaps |
| Placement | [%] tests correctly placed | [N] misplaced |

## P0: False Confidence (fix immediately)
[Mock theater integration tests, zombie tests — these are worse than no tests]

| # | File | Issue | Recommendation | Effort |
|---|------|-------|----------------|--------|

## P1: Consolidation Opportunities
[Redundant clusters, shotgun testing — clean up for maintainability]

| # | Cluster | Tests Involved | Action | Effort |
|---|---------|---------------|--------|--------|

## P2: Simplification Opportunities
[Over-engineered tests that work but are harder to maintain than necessary]

| # | File | Issue | Suggested Simplification | Effort |
|---|------|-------|-------------------------|--------|

## P3: Placement Corrections
[Tests in wrong directories or with wrong naming]

| # | File | Current Location | Correct Location | Reason |
|---|------|-----------------|-----------------|--------|

## P4: Coverage Gaps
[Source modules that need tests]

| # | Source Module | Risk | Recommended Test Type | What to Test |
|---|-------------|------|----------------------|-------------|

## Integration Test Authenticity Matrix

| Test File | Authenticity | Redis Usage | ADR Compliance | Verdict |
|-----------|-------------|-------------|----------------|---------|

## Unit Test Quality Matrix

| Test File | Necessity | Engineering | Top Issue | Recommendation |
|-----------|-----------|-------------|-----------|----------------|

## ADR Compliance Coverage

| ADR | Required Coverage | Current Coverage | Gap |
|-----|------------------|-----------------|-----|

## Consolidation Roadmap (ordered execution plan)

### Phase 1: Quick Wins (low effort, high impact)
[List changes that can be done independently]

### Phase 2: Consolidation (medium effort)
[Merge clusters, remove superseded tests]

### Phase 3: Structural (higher effort)
[Move tests, create missing integration tests, upgrade mock theater]

## Statistics

| Metric | Count |
|--------|-------|
| Total test files | |
| Total test cases | |
| Unit tests | |
| Integration tests | |
| Contract tests | |
| Other (perf/smoke/e2e) | |
| Tests marked ESSENTIAL | |
| Tests marked VALUABLE | |
| Tests marked REDUNDANT | |
| Tests marked UNNECESSARY | |
| Tests marked CLEAN | |
| Tests marked COULD SIMPLIFY | |
| Tests marked OVER-ENGINEERED | |
| Integration: AUTHENTIC | |
| Integration: PARTIAL | |
| Integration: MOCK THEATER | |
| Integration: REAL REDIS | |
| Integration: MOCKED REDIS | |
| Misplaced tests | |
| Critical gaps (P0-P1) | |
```

---

## Handling Uncertainty

### Unclear Test Purpose
When a test's intent isn't clear from code and naming:
```
**What I See**: [test code]
**Possible Purposes**: A) [purpose 1] / B) [purpose 2]
**Why Unclear**: [naming? complexity? no comments?]
**Verdict**: NEEDS CLARIFICATION (not UNNECESSARY)
```

### Borderline Categorization
When a test sits between unit and integration:
```
**Test**: [file path]
**Unit Indicators**: [mocked deps, isolated, fast]
**Integration Indicators**: [real Redis, crosses boundaries, tests interaction]
**Verdict**: [classification] because [the stronger evidence]
```

### Uncertain Redundancy
When tests MIGHT be testing the same thing:
```
**Test A**: [what it tests]
**Test B**: [what it tests]
**Overlap**: [where they overlap]
**Difference**: [where they differ]
**Confidence**: [HIGH/MEDIUM/LOW that they're truly redundant]
**Safe to Merge?**: [Yes/No/Verify First]
```

**Rule**: When in doubt about whether a test is necessary, keep it. Removing a useful test is worse than keeping a redundant one. Mark as NEEDS VERIFICATION rather than UNNECESSARY.

---

## Confidence Calibration

All agents MUST use these levels:
- **HIGH (90-100%)**: Read both the test and source; behavior overlap verified; assertion-level comparison done
- **MEDIUM (70-89%)**: Read the test; source file reviewed; high probability of correctness
- **LOW (50-69%)**: Based on naming and structure; full code review not completed for this test
- **NEEDS VERIFICATION (<50%)**: Suspicious but unproven — state what would confirm/deny

---

## Verification Checklist (Before Declaring Done)

- [ ] ALL test files in scope are cataloged (verify count with Glob)
- [ ] Phase 1 inventory is complete before Phase 2 launches
- [ ] Every unit test has a necessity and engineering verdict
- [ ] Every integration test has an authenticity and ADR compliance verdict
- [ ] Redundancy clusters verified by reading ALL involved tests
- [ ] No test recommended for removal without verified coverage elsewhere
- [ ] Gap analysis cross-referenced with source module inventory
- [ ] Report written to `.agent-reports/TEST_AUDIT_REPORT.md`
- [ ] Summary presented to user

**Remember**: The goal is a test suite where every test has a clear, distinct role — and the suite as a whole provides maximum confidence with minimum maintenance burden. When recommending changes, always preserve coverage while reducing complexity.
