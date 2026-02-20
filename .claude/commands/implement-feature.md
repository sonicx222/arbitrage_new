---
description: Implement new features/tests using a 5-agent team with phased reconnaissance, architecture design, TDD planning, and adversarial review
---

# Feature Implementation (Team-Based)

**Feature**: `$ARGUMENTS`

> If `$ARGUMENTS` is empty, ask the user what feature to implement before proceeding. Get clarity on: what to build, where it should live, and any constraints or preferences.

## Model Capabilities (Opus 4.6)

You are running on Claude Opus 4.6 with full agent team capabilities:
- **Phased Team Orchestration**: Coordinate 5 specialized agents across 3 phases (reconnaissance -> design -> adversarial review) before writing any code
- **Parallel Tool Use**: Launch agents simultaneously in a single message with multiple Task tool calls
- **Independent Cross-Check**: Feature design and test design happen in parallel by separate agents, creating a natural validation mechanism
- **Adversarial Reasoning**: A dedicated reviewer agent challenges both designs before implementation — catching gaps that designers can't see in their own work
- **TDD Execution**: After synthesis, implement tests first, verify they fail, then implement code

**Leverage these actively**: Use TeamCreate to spawn a team. Use Task tool with `team_name` to spawn teammates. Use TodoWrite to track progress across all phases. After agent phases complete, implement TDD-style: write tests first, verify they fail, then implement code.

## Role & Expertise

You are the **Team Lead** — a senior DeFi/Web3 engineer who:
- Designs features that integrate cleanly with existing architecture
- Follows TDD religiously (tests before code, every time)
- Writes minimal code that does the job (no over-engineering)
- Respects hot-path performance constraints in every design decision

## Context

Professional multi-chain arbitrage trading system:
- **Chains**: 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
- **DEXs**: 44+ across all chains
- **Architecture**: Partitioned detectors (4 partitions), Redis Streams (ADR-002), L1 Price Matrix with SharedArrayBuffer (ADR-005), Worker threads for path finding (ADR-012), Circuit breakers (ADR-018)
- **Stack**: TypeScript, Node.js, Solidity ^0.8.19, Hardhat, ethers v6, Jest, OpenZeppelin 4.9.6
- **Build Order**: types -> config -> core -> ml -> services

## CRITICAL PERFORMANCE REQUIREMENT

> **Hot-path latency target: <50ms** (price-update -> detection -> execution)

Hot-path modules (feature integration with these requires extra care):
- `shared/core/src/price-matrix.ts` — L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` — Opportunity detection
- `services/execution-engine/` — Trade execution
- `services/unified-detector/` — Event processing
- WebSocket handlers — Event ingestion

**Any new code touching hot-path modules MUST**: avoid blocking operations, minimize allocations, use O(1) lookups (Map/Set, not array.find/filter), pre-allocate arrays, prefer mutable objects in tight loops.

---

## Why This Agent Composition

This workflow uses 5 specialized agents across 3 phases. Each role is designed to maximize Opus 4.6's deep reasoning in a specific dimension:

| Phase | Agent | Type | Why Opus 4.6 Excels Here |
|-------|-------|------|--------------------------|
| 1 (Parallel) | pattern-scout | Explore | Synthesizing dozens of files into extractable "recipes" requires extended context + pattern generalization |
| 1 (Parallel) | integration-mapper | Explore | Multi-hop causal reasoning across service boundaries, event cascades, and shared state |
| 2 (Parallel) | feature-architect | general-purpose | Multi-dimensional trade-off reasoning: correctness x performance x maintainability x integration fit |
| 2 (Parallel) | test-architect | general-purpose | Specification-level reasoning about behavior independent from implementation — catches design gaps through perspective separation |
| 3 (Sequential) | adversarial-reviewer | general-purpose | Simultaneously understanding design intent AND imagining failure scenarios — adversarial cognition at its strongest |

**Key design principles**:

1. **Independent design + test design**: The feature-architect and test-architect work INDEPENDENTLY from the same Phase 1 inputs. This creates a natural cross-check — if the test-architect identifies behaviors the feature-architect didn't account for, that's a design gap caught before any code is written.

2. **Reconnaissance before design**: Agents 1-2 build deep codebase understanding so agents 3-4 can design with full context. This prevents "doesn't fit the codebase" problems that plague feature implementations.

3. **Adversarial review before implementation**: Agent 5 challenges both designs simultaneously. Finding a problem in a design document costs nothing; finding it in implemented code costs significant rework.

4. **Single-writer implementation**: The Team Lead implements all code. Multiple agents writing to files simultaneously causes conflicts. Multi-reader design (5 agents) + single-writer implementation (Team Lead) is the cleanest model.

---

## Team Structure

You are the **Team Lead**. Your responsibilities:
1. Clarify the feature requirements with the user if needed (use AskUserQuestion)
2. Create the team and task list using TeamCreate
3. Read `docs/agent/code_conventions.md` for shared context
4. Execute the phased agent plan (reconnaissance -> design -> review)
5. Synthesize all agent outputs into a unified plan
6. Implement the feature TDD-style (tests first, then code)
7. Run verification (typecheck, tests)

---

### Agent 1: "pattern-scout" (subagent_type: Explore)

**Mission**: Find the closest existing implementations to use as templates for the requested feature. Extract the "recipe" — the step-by-step pattern for building this type of feature in this codebase.

**Why this agent**: Building a feature that doesn't match existing patterns causes maintenance burden and architectural drift. This agent ensures the new feature "fits" by deeply studying what already exists.

**Investigation protocol**:

1. **Identify feature type**: Is this a new service? A new module in shared/? A new contract? A new endpoint? A new detection strategy? A new test suite? Match against existing categories.

2. **Find closest templates**: Search for the most similar existing implementations:
   - For services: How are existing services structured? (entry point, routes, middleware, DI, config, health checks)
   - For shared modules: How are existing modules structured? (exports, types, classes, DI pattern)
   - For contracts: How do existing contracts inherit from BaseFlashArbitrage? What's the override pattern?
   - For tests: How are tests organized? (file naming, describe blocks, fixtures, mocks)

3. **Extract the recipe**: For each template found, document:
   ```
   TEMPLATE: [file path]
   TYPE: Service | SharedModule | Contract | Test | Endpoint | Worker
   STRUCTURE:
     - [file 1]: [purpose]
     - [file 2]: [purpose]
   PATTERNS USED:
     - [pattern name]: [how it's used, with code reference at file:line]
   DI DEPENDENCIES: [what gets injected, constructor signature]
   CONFIG PATTERN: [how config is loaded and accessed]
   ERROR HANDLING: [pattern used — thrown errors, error types, logging]
   EVENT FLOW: [how data enters and exits this component]
   TEST PATTERN: [how this component is tested — file location, mock style, fixture pattern]
   ```

4. **Document conventions that apply**: From `docs/agent/code_conventions.md` and actual code:
   - Naming conventions (files, classes, functions, tests)
   - Import patterns (`@arbitrage/*` path aliases)
   - Error handling patterns (throw vs return, error types)
   - Logging patterns (logger injection, log levels)
   - Config access patterns (how config flows through DI)

5. **Identify anti-patterns to avoid**: Things in older code that shouldn't be repeated:
   - Check for `// TODO: refactor` or `// DEPRECATED` markers
   - Patterns that violate `docs/agent/code_conventions.md`
   - Barrel export imports (should import from source files directly)

**Deliverable**: Pattern Catalog containing:
- Top 3 closest template implementations (with full recipe extraction)
- Convention checklist specific to this feature type
- Anti-patterns to avoid
- Recommended file structure for the new feature

**What NOT to do**:
- Don't design the feature (that's the feature-architect's job)
- Don't write code
- Don't suggest improvements to existing patterns
- Don't analyze code outside the relevant area

**Quality gates**:
- [ ] At least 2 template implementations found and fully analyzed
- [ ] All conventions from code_conventions.md relevant to this feature type documented
- [ ] Each template recipe includes actual code references (file:line)
- [ ] DI pattern documented with concrete constructor signatures from templates

---

### Agent 2: "integration-mapper" (subagent_type: Explore)

**Mission**: Map every integration point the new feature will touch. Trace data flow end-to-end for related features. Identify shared state, concurrency requirements, cleanup patterns, and hot-path proximity.

**Why this agent**: Features that integrate incorrectly cause subtle bugs — race conditions, leaked resources, broken event flows, state corruption. This agent maps the territory so the architect can design safe integration from the start.

**Investigation protocol**:

1. **Map data flow** for the area where the feature will live:
   - What data enters? (WebSocket events, Redis streams, API calls, config)
   - What transformations happen? (parsing, validation, enrichment, calculation)
   - What data exits? (Redis publish, HTTP response, event emit, state mutation)
   - What side effects occur? (logging, metrics, alerts, circuit breaker state)

2. **Map service boundaries**: Which services does this feature interact with?
   - Direct dependencies (imports, API calls)
   - Indirect dependencies (shared Redis streams, shared config)
   - Event-driven connections (publishes/subscribes)

3. **Map shared state**: What state does this feature need to read or write?
   - Redis keys/streams it touches (use Grep for key patterns)
   - In-memory caches (price-matrix, pair cache, LRU)
   - Configuration keys (which config values)
   - Shared types (which interfaces from @arbitrage/types)

4. **Map concurrency concerns**:
   - Will this code be called from multiple workers/threads?
   - Are there shared mutable state risks?
   - Does it need mutex/lock patterns?
   - What's the expected call frequency? (once/startup, per-request, per-event at 1000/sec)

5. **Map cleanup requirements**:
   - What resources need to be released? (Redis connections, timers, event listeners)
   - What's the shutdown sequence for similar features?
   - Are there `dispose()`/`destroy()`/`cleanup()` patterns to follow?
   - Must async cleanup await disconnect operations?

6. **Assess hot-path proximity**:
   ```
   HOT-PATH ASSESSMENT:
   PROXIMITY: NONE | INDIRECT | DIRECT
   REASONING: [why this classification — trace the call path]
   AFFECTED MODULES: [list hot-path modules this feature interacts with]
   CONSTRAINTS: [specific performance rules that apply]
   ```

7. **Map test infrastructure**:
   - Existing test helpers that could be reused
   - Mock patterns for the dependencies this feature uses
   - Fixture patterns for data setup
   - Integration test patterns for the service boundaries involved

**Deliverable**: Integration Map containing:
- Data flow diagram (text-based, showing source -> transforms -> sinks)
- Service interaction map (which services, how they communicate)
- Shared state inventory (Redis keys, caches, config, types)
- Concurrency assessment (threading model, call frequency, mutex needs)
- Cleanup requirements checklist (resources, shutdown order)
- Hot-path proximity assessment (NONE/INDIRECT/DIRECT with reasoning)
- Test infrastructure catalog (reusable helpers, mocks, fixtures)

**What NOT to do**:
- Don't design the feature (that's the feature-architect's job)
- Don't write code
- Don't assess code quality of existing code
- Don't suggest refactorings to existing code

**Quality gates**:
- [ ] Data flow traced with actual Grep/Read evidence (not assumed)
- [ ] All shared state identified with actual Redis key patterns or variable names
- [ ] Hot-path proximity assessed with specific call-path reasoning
- [ ] At least 3 relevant test helpers/mocks identified for reuse
- [ ] Cleanup pattern documented from existing similar features

---

### Agent 3: "feature-architect" (subagent_type: general-purpose)

**Mission**: Design the complete implementation blueprint for the feature. File-by-file plan with class/function signatures, data flow, error handling, and integration strategy. This design must account for ALL constraints from Phase 1.

**Why this agent**: Architecture design is multi-dimensional trade-off reasoning — balancing correctness, performance, maintainability, and integration fit simultaneously. A bad architecture decision here cascades into every downstream phase. Opus 4.6's deep reasoning makes the difference between a design that "works" and one that "fits."

**Inputs** (provided by Team Lead from Phase 1):
- Feature specification (from user)
- Pattern Catalog (from pattern-scout)
- Integration Map (from integration-mapper)

**Design protocol**:

1. **Choose the implementation approach**:
   - Which template from the Pattern Catalog most closely matches?
   - What adaptations are needed for this specific feature?
   - Are there multiple valid approaches? If so, reason through trade-offs and pick ONE.
   - Justify: "I chose approach X over Y because [specific reasoning]"

2. **Design the file structure**:
   ```
   FILES TO CREATE:
   - [path/to/file.ts]: [purpose, ~LOC estimate]

   FILES TO MODIFY:
   - [path/to/existing.ts]: [what changes, why]

   TYPES TO ADD/MODIFY:
   - [path/to/types.ts]: [new interfaces/types]
   ```

3. **Design each component** (for each file to create):
   ```
   FILE: [path]
   PURPOSE: [single responsibility]

   EXPORTS:
   - [className/functionName]: [full TypeScript signature]

   CONSTRUCTOR / INIT:
   - Dependencies: [list DI params with types, matching template pattern]
   - Config: [what config it reads, with key names]
   - Initialization: [what happens on startup]

   KEY METHODS:
   - [methodName](params): returnType — [what it does, key logic]

   ERROR HANDLING:
   - [error scenario]: [how it's handled, what error type]

   INTEGRATION:
   - Consumes: [data sources, with format]
   - Produces: [data outputs, with format]
   - Events: [emits/listens, with event names]

   CLEANUP:
   - [what gets cleaned up on shutdown, matching Integration Map requirements]
   ```

4. **Design the data flow**:
   ```
   HAPPY PATH:
   INPUT -> [step 1: what happens] -> [step 2] -> ... -> OUTPUT

   ERROR PATH:
   ERROR AT [step N] -> [how error propagates] -> [where caught] -> [recovery/reporting]
   ```

5. **Design configuration** (if new config needed):
   - What new config keys?
   - What are sensible defaults?
   - Where in the config hierarchy?

6. **Design type definitions** (if new types needed):
   - New interfaces/types for @arbitrage/types
   - Extensions to existing types
   - Proper nullable types (no `as any`)

7. **Performance design** (if Integration Map shows INDIRECT or DIRECT hot-path proximity):
   - How does this interact with the hot path?
   - What O(1) data structures are needed?
   - Where are potential allocation hotspots?
   - How to avoid blocking the event loop?

**Design constraints** (MUST follow — from code_conventions.md and project patterns):
- Constructor DI pattern (match template from Pattern Catalog)
- `@arbitrage/*` path aliases for cross-package imports
- `??` (not `||`) for numeric values that could be 0
- Proper nullable types (no `as any` casts)
- ES modules (import/export), not CommonJS
- Import from source files directly, not barrel exports (index.ts)
- Async cleanup functions must await disconnect operations
- Use proper `Logger` type, not `any`

**Deliverable**: Implementation Blueprint containing:
- Architecture decision with explicit reasoning
- Complete file structure (create + modify)
- Component designs with full TypeScript signatures
- Data flow diagram (happy + error paths)
- Configuration design (if applicable)
- Type definitions (if applicable)
- Performance considerations (if hot-path adjacent)

**What NOT to do**:
- Don't write implementation code (just signatures and structure)
- Don't design tests (that's test-architect's independent job)
- Don't over-engineer (no features beyond what's specified)
- Don't add unnecessary abstraction layers
- Don't create utility classes for one-time operations
- Don't design for hypothetical future requirements

**Quality gates**:
- [ ] Every file has a clear single purpose and ~LOC estimate
- [ ] All DI dependencies typed and listed with constructor signatures
- [ ] Error handling designed for every external interaction
- [ ] Hot-path proximity acknowledged and addressed (if applicable)
- [ ] Design follows template from Pattern Catalog (deviations explicitly justified)
- [ ] No `as any`, no `||` for numerics, proper nullable types in all signatures
- [ ] Cleanup logic matches Integration Map's cleanup requirements

---

### Agent 4: "test-architect" (subagent_type: general-purpose)

**Mission**: Design the complete TDD test strategy for the feature. Test file structure, specific test cases with descriptions and expected behaviors, mock requirements, edge cases. This design is INDEPENDENT from the implementation design — reason from the feature specification, not from any architecture.

**Why this agent**: By designing tests independently from implementation, we create a cross-check. If the test-architect identifies behaviors the feature-architect didn't plan for, that's a design gap. The test design IS the specification — it defines what "correct" means before any code exists. This perspective separation is where Opus 4.6's ability to reason from multiple viewpoints produces the highest value.

**Inputs** (provided by Team Lead from Phase 1):
- Feature specification (from user)
- Pattern Catalog (from pattern-scout) — specifically the test patterns
- Integration Map (from integration-mapper) — specifically the test infrastructure

**CRITICAL**: You do NOT receive the feature-architect's output. Design tests from the SPECIFICATION, not from the implementation.

**Design protocol**:

1. **Define test file structure**:
   ```
   TEST FILES:
   - [path/to/__tests__/unit/feature.test.ts]: [what it tests]
   - [path/to/__tests__/integration/feature.integration.test.ts]: [integration scenarios]
   ```
   Follow naming conventions from Pattern Catalog.

2. **Design unit tests** (for each expected public behavior):
   ```typescript
   describe('[ComponentName]', () => {
     describe('[methodName]', () => {
       it('should [expected behavior] when [condition]', () => {
         // GIVEN: [precondition setup]
         // WHEN: [action performed]
         // THEN: [expected outcome with specific assertions]
       });

       it('should [handle error] when [error condition]', () => {
         // GIVEN: [error condition setup]
         // WHEN: [action that triggers error]
         // THEN: [expected error behavior — specific error type/message]
       });

       it('should [handle edge case] when [edge condition]', () => {
         // GIVEN: [edge case setup]
         // WHEN: [action]
         // THEN: [expected handling]
       });
     });
   });
   ```

3. **Design mock requirements**:
   ```
   MOCKS NEEDED:
   - [DependencyName]:
     - mock type: jest.Mock | manual mock class
     - key behaviors to mock: [list with return values]
     - error scenarios to simulate: [list]
     - reuse existing: [path to existing mock if available from test infrastructure catalog]
   ```

4. **Design integration tests** (if feature crosses service boundaries):
   ```
   INTEGRATION SCENARIOS:
   - [scenario name]: [what's being tested end-to-end]
     - Setup: [services/mocks needed]
     - Action: [what triggers the flow]
     - Verification: [what to assert, in what order]
   ```

5. **Design edge case tests** (EXHAUSTIVE — apply ALL these categories):
   - **Input edges**: null, undefined, empty string, empty array, zero, negative, max value, invalid type, missing required field
   - **State edges**: before initialization, after shutdown, during concurrent calls, already-processed duplicate, mid-cleanup
   - **External edges**: dependency timeout, dependency error, dependency returns unexpected shape, dependency returns empty
   - **Timing edges**: rapid successive calls, delayed responses, out-of-order events, exactly-at-deadline
   - **Business logic edges**: unprofitable arbitrage, zero liquidity, all routers failing, fee exceeds profit, token decimal mismatch

6. **Design regression tests** (for the most critical behaviors):
   - What behavior MUST be preserved even if implementation changes?
   - What's the simplest test that would catch a regression?

7. **Design performance tests** (if hot-path adjacent per Integration Map):
   - Latency assertions (must complete within budget)
   - Allocation checks (no unexpected object creation in tight loops)
   - Throughput tests (must handle expected event rate)

**Test conventions** (MUST follow):
- Set up mocks in `beforeEach()`, override in individual tests
- Constructor DI for testable classes (match template from Pattern Catalog)
- Cast to `jest.Mock`: `(mockedFunction as jest.Mock).mockReturnValue(value)`
- Import from source files directly, not barrel exports
- For contracts: `loadFixture(deployContractsFixture)` for every test
- For contracts: ALWAYS specify expected error (`.revertedWithCustomError()` or `.revertedWith()`)
- For contracts: OZ 4.9.6 uses string-based `require()` messages, NOT custom errors for ERC20 ops
- For contracts: Match token decimals between mock setup and assertions

**Deliverable**: Test Blueprint containing:
- Test file structure with naming conventions
- Complete unit test plan (all expected behaviors, all paths)
- Mock requirements and setup strategy
- Integration test scenarios (if applicable)
- Edge case matrix covering all 5 categories
- Regression test plan for critical behaviors
- Performance test plan (if hot-path adjacent)

**What NOT to do**:
- Don't write test implementation code (just describe blocks and test descriptions with GIVEN/WHEN/THEN)
- Don't look at or reference the feature-architect's design
- Don't skip edge cases because "they probably can't happen"
- Don't design tests for internal implementation details (test behavior, not structure)

**Quality gates**:
- [ ] Every expected public behavior has at least: happy path, error path, one edge case
- [ ] Mock requirements fully specified (what to mock, how, which existing mocks to reuse)
- [ ] Edge case matrix covers all 5 categories (input, state, external, timing, business)
- [ ] Test names are descriptive and follow "should [behavior] when [condition]" pattern
- [ ] Test conventions match the Pattern Catalog templates exactly

---

### Agent 5: "adversarial-reviewer" (subagent_type: general-purpose)

**Mission**: Review BOTH the implementation design and test design. Find gaps between them. Challenge assumptions. Identify missed edge cases, convention violations, performance concerns, and integration risks. Produce specific, actionable concerns — not vague worries.

**Why this agent**: Adversarial thinking — deliberately finding problems in a coherent design — is among the hardest cognitive tasks. It requires simultaneously understanding WHY the design was made AND imagining scenarios WHERE it fails. This is where Opus 4.6's ability to hold multiple mental models in tension produces the highest value. A dedicated reviewer catches what designers can't see in their own work.

**Inputs** (provided by Team Lead from Phase 2):
- Feature specification (from user)
- Pattern Catalog (from pattern-scout)
- Integration Map (from integration-mapper)
- Implementation Blueprint (from feature-architect)
- Test Blueprint (from test-architect)

**Review protocol**:

1. **Cross-check implementation vs tests**:
   - Is every component in the Implementation Blueprint covered by the Test Blueprint?
   - Is every behavior in the Test Blueprint accounted for in the Implementation Blueprint?
   - Are there test scenarios that imply behaviors the architect didn't design for?
   - Are there architect-designed components that have no corresponding tests?
   - **GAPS between the two designs are the highest-value findings.** List them specifically.

2. **Challenge the architecture**:
   - Does the chosen approach fit the codebase patterns? (verify against Pattern Catalog recipes)
   - Are there simpler approaches the architect missed?
   - Is there over-engineering? (unnecessary abstractions, premature generalization, utility classes for one-time ops)
   - Is there under-engineering? (missing error handling, insufficient validation, missing cleanup)
   - Does the file structure match existing conventions?

3. **Challenge the tests**:
   - Are there behaviors the tests don't cover?
   - Are the mocks realistic? (check against Integration Map's dependency descriptions)
   - Are edge cases truly exhaustive? (cross-reference all 5 categories)
   - Would these tests catch the most likely real-world regressions?
   - Are test assertions specific enough? (no bare `.to.be.reverted`)

4. **Check convention compliance** (verify against actual code_conventions.md):
   - Constructor DI pattern used correctly?
   - `@arbitrage/*` path aliases used (not relative paths across packages)?
   - `??` used for numerics (not `||`)?
   - Proper nullable types (no `as any`)?
   - Error handling matches project patterns?
   - Import from source files, not barrel exports?
   - Logger type is `Logger`, not `any`?
   - Async cleanup awaits disconnect operations?

5. **Check performance safety** (using Integration Map's hot-path assessment):
   - If DIRECT: Does the design avoid ALL performance anti-patterns?
     - No blocking operations (sync I/O, unbounded loops)
     - No allocations in loops (no spread operators, no new objects)
     - O(1) lookups only (Map/Set, not array.find/filter)
     - Pre-allocated arrays, cached values
     - No async/await in tight loops
     - No new abstraction layers in hot-path code
   - If INDIRECT: Does the design avoid blocking the hot path?
   - If NONE: Confirm it CAN'T accidentally impact the hot path (no transitive calls)

6. **Check integration safety** (using Integration Map):
   - Does the design handle cleanup correctly? (matching cleanup requirements)
   - Does it handle concurrent access correctly? (matching concurrency assessment)
   - Does it handle failure of each dependency? (matching data flow map)
   - Will it break existing behavior? (matching service interaction map)
   - Does shared state access follow existing patterns? (Redis key patterns, cache access)

7. **Check for common DeFi pitfalls** (if the feature involves on-chain interaction):
   - Token decimal handling (WETH 18, USDC/USDT 6, WBTC 8)
   - Fee calculation precision (basis points, not percentages; net = revenue - fees - gas)
   - Slippage handling (realistic ranges, not just hardcoded 1%)
   - Gas estimation (chain-specific)
   - Flash loan callback security (caller validation)
   - OpenZeppelin 4.9.6 patterns (string reverts, not custom errors for ERC20)

**Output format** for each finding:
```
CONCERN: [specific, actionable title]
SEVERITY: CRITICAL | HIGH | MEDIUM | LOW
TYPE: Design Gap | Missing Test | Convention Violation | Performance Risk | Integration Risk | DeFi Pitfall | Edge Case
SOURCE: Implementation Blueprint | Test Blueprint | Cross-check | Integration Map
EVIDENCE: [specific detail from the design that's problematic]
RECOMMENDATION: [specific change to make — not vague advice]
```

**Deliverable**: Review Report containing:
- Cross-check gap analysis (implementation vs test design alignment)
- Architecture concerns with specific recommendations
- Test concerns with specific recommendations
- Convention violations with specific fixes
- Performance safety assessment
- Integration risk assessment
- Summary verdict: **GO** | **GO WITH CHANGES** (list required changes) | **REDESIGN NEEDED** (explain why)

**What NOT to do**:
- Don't suggest redesigning the entire architecture unless there's a critical flaw
- Don't add features beyond the specification
- Don't raise concerns already addressed in the designs
- Don't be vague ("this might have issues") — be specific ("method X doesn't handle null input Y, which the Integration Map shows can occur when Z")
- Don't over-optimize for hypothetical future requirements
- Don't flag known correct patterns (see table below)

**Quality gates**:
- [ ] Every concern includes specific evidence from the designs (quoted)
- [ ] Every concern includes a specific, implementable recommendation
- [ ] Cross-check covers every component in both designs
- [ ] Convention check verified against actual code_conventions.md and project code
- [ ] Performance assessment references specific hot-path modules and ADR constraints
- [ ] Summary verdict is justified with evidence from findings

---

## Critical Rules (Apply to ALL Agents)

### Anti-Hallucination Protocol
- **NEVER** report a convention without verifying it in `docs/agent/code_conventions.md` or actual code
- **NEVER** assume a pattern exists without finding it with Grep/Read tools
- **NEVER** recommend a design approach without checking if it matches existing implementations
- **IF** uncertain about a convention, find 2+ examples in the codebase first
- **ALWAYS** verify integration points by reading actual code (not just docs)
- **NEVER GUESS.** Investigate with tools first.

### Performance Safety Protocol
- **ALWAYS** assess hot-path proximity for features touching shared/core/ or services/
- **NEVER** design allocations in tight loops (no spread operators, no new objects per iteration)
- **NEVER** design O(n) lookups where O(1) is possible (Map/Set, not array.find/filter)
- **PRESERVE** existing performance patterns (see Known Correct Patterns table)
- Hot-path features require explicit performance design section in the Implementation Blueprint

### Investigation Strategy (all agents)
1. **Read full files** using Read tool (not just snippets)
2. **Search for patterns** using Grep across the codebase — launch parallel searches in a single message
3. **Map dependencies** using Grep for imports/requires
4. **Use TodoWrite** to track progress
5. When investigating across multiple files, launch parallel Grep/Read in a single response

### Known Correct Patterns (Don't Flag as Violations)

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
| `loadFixture` pattern | Hardhat tests | Snapshot-restore for speed |
| Pre-allocated arrays | Detection loops | `new Array(n)` vs dynamic `.push()` |

---

## Execution Plan

### Phase 1: Setup
1. Use TodoWrite to create tracking items for all phases
2. Use TeamCreate to create the feature implementation team
3. Read `docs/agent/code_conventions.md` for shared context
4. Identify the target area for the feature (which service/package/contract)

### Phase 2: Parallel Reconnaissance (Agents 1 + 2)

Spawn 2 Explore agents **in a single message** with 2 parallel Task tool calls:

| # | Agent Name | subagent_type | Focus |
|---|-----------|---------------|-------|
| 1 | pattern-scout | Explore | Templates, conventions, recipes |
| 2 | integration-mapper | Explore | Data flow, dependencies, hot-path proximity |

Each agent prompt MUST include:
- The feature specification from the user
- The target area/directory for the feature
- Their specific investigation protocol, deliverable format, and quality gates (copy from above)
- The Critical Rules section (anti-hallucination, performance safety, investigation strategy)
- The Known Correct Patterns table

### Agent Stall Detection (applies to all phases)

After spawning agents in any phase:
1. Send each agent an activation message with their specific inputs
2. Wait 60-90 seconds, then check inbox read status
3. If agents haven't read their messages after 90s, send a nudge: "Check your inbox for your assigned task. Begin analysis and report findings when done."
4. If an agent is unresponsive after 3 minutes, send a direct message: "You have an active task assignment. Read your activation message and begin immediately."
5. If still unresponsive after 5 minutes, note the gap and proceed with available results.

For parallel phases (Phase 2, Phase 3): apply to all agents simultaneously — track which have reported vs not.
For sequential phases (Phase 4): apply to the single agent.

### Phase 3: Parallel Design (Agents 3 + 4, after Phase 2)

After reconnaissance agents complete, spawn 2 design agents **in a single message** with 2 parallel Task tool calls:

| # | Agent Name | subagent_type | Focus |
|---|-----------|---------------|-------|
| 3 | feature-architect | general-purpose | Implementation blueprint |
| 4 | test-architect | general-purpose | TDD test strategy |

Each agent prompt MUST include:
- The feature specification from the user
- The FULL output from BOTH Phase 2 agents (Pattern Catalog + Integration Map)
- Their specific design protocol, deliverable format, and quality gates (copy from above)
- The Critical Rules section and Known Correct Patterns table

**CRITICAL**: The test-architect MUST NOT receive the feature-architect's output, and vice versa. They work independently from the same Phase 1 inputs to create the natural cross-check.

### Phase 4: Adversarial Review (Agent 5, after Phase 3)

After design agents complete, spawn 1 review agent:

| # | Agent Name | subagent_type | Focus |
|---|-----------|---------------|-------|
| 5 | adversarial-reviewer | general-purpose | Challenge both designs, find gaps |

The adversarial-reviewer prompt MUST include:
- The feature specification from the user
- The FULL output from ALL 4 previous agents (Pattern Catalog + Integration Map + Implementation Blueprint + Test Blueprint)
- Their specific review protocol, deliverable format, and quality gates (copy from above)
- The Critical Rules section and Known Correct Patterns table

### Phase 5: Synthesis & Implementation (Team Lead)

After all agents complete:

1. **Synthesize the final plan**:
   - Read the adversarial reviewer's verdict
   - If **GO**: Proceed directly with both designs
   - If **GO WITH CHANGES**: Incorporate all CRITICAL and HIGH recommendations into both designs
   - If **REDESIGN NEEDED**: Address the critical flaw, potentially re-run design agents
   - Resolve any cross-check gaps between implementation and test designs
   - Produce a unified implementation sequence

2. **Implement TDD-style**:
   a. **Write tests FIRST** (from Test Blueprint + adversarial reviewer's additions)
   b. **Run tests** — verify they FAIL (confirms tests assert meaningful behavior)
   c. **Write implementation code** (from Implementation Blueprint + adversarial reviewer's modifications)
   d. **Run tests** — verify they PASS
   e. **Run typecheck** (`npm run typecheck`)
   f. **Fix any issues** and re-run until clean

3. **Post-implementation verification**:
   - All new tests pass
   - Typecheck clean
   - No regressions in existing tests (`npm test`)
   - For contracts: `npx hardhat compile && npx hardhat test`
   - Hot-path performance maintained (if applicable)

### Phase 6: Summary

Write a brief implementation summary for the user:

```markdown
## Feature Implementation Summary

### What Was Built
- [component 1]: [description]
- [component 2]: [description]

### Files Created
- [path]: [purpose]

### Files Modified
- [path]: [what changed]

### Test Coverage
- [X] unit tests across [Y] files
- Key scenarios tested: [list]
- Edge cases tested: [list]

### Design Decisions
- [decision]: [reasoning from feature-architect]

### Adversarial Review Findings Addressed
- [concern]: [how it was addressed in implementation]

### Verification
- [ ] All new tests passing
- [ ] Typecheck clean
- [ ] No regressions in existing tests
- [ ] Hot-path safe (if applicable)
```

---

## Confidence Calibration

All agents MUST use these levels:
- **HIGH (90-100%)**: Pattern verified in 3+ locations, data flow fully traced, convention confirmed in docs and code
- **MEDIUM (70-89%)**: Pattern found in 1-2 locations, likely correct but not all callers verified
- **LOW (50-69%)**: Based on naming conventions or partial evidence, needs verification
- **NEEDS VERIFICATION (<50%)**: Can't determine from available evidence — state what would confirm/deny

## Handling Feature Ambiguity

When the feature specification is unclear:
1. **Don't guess** — the agent should document the ambiguity and flag it for the Team Lead (who asks the user via AskUserQuestion)
2. **Document assumptions** — if proceeding with a best-guess interpretation:
   ```
   ASSUMPTION: [what you're assuming about the feature]
   IF WRONG: [what would change in the design]
   ```
3. **Design for the common case** — pick the most likely interpretation, document alternatives

## When to STOP and Ask the User

The Team Lead should pause and use AskUserQuestion when:
- The feature touches 3+ services (large blast radius — confirm scope)
- The feature requires new infrastructure (new Redis streams, new service, new contract — confirm approach)
- The adversarial reviewer returns **REDESIGN NEEDED**
- Multiple valid approaches exist with significantly different trade-offs
- The feature appears to conflict with an existing ADR
- The specification is too vague to begin Phase 2 reconnaissance

---

## Verification Checklist (Before Declaring Done)

- [ ] All new tests pass (`npm test` or `npx hardhat test`)
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] No regressions in existing tests
- [ ] Code follows project conventions (DI, path aliases, nullish coalescing, nullable types)
- [ ] Hot-path performance not regressed (if feature is hot-path adjacent)
- [ ] Implementation matches the synthesized design (no undocumented deviations)
- [ ] All CRITICAL/HIGH adversarial concerns addressed
- [ ] Summary report written for user

**Remember**: The goal is working code that fits the codebase, not a perfect plan. Ship incrementally, test thoroughly, respect the hot path.
