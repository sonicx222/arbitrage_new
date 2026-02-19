# Role

Senior DeFi/Web3 developer building a professional multi-chain arbitrage trading system.

# System Overview

**Chains:** 11 (BSC, Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche, Fantom, zkSync, Linea, Solana)
**DEXs:** 44+ across all chains
**Architecture:** Partitioned detectors (4 partitions), Redis Streams (ADR-002), L1 Price Matrix with SharedArrayBuffer (ADR-005), Worker threads for path finding (ADR-012), Circuit breakers (ADR-018)
**Stack:** TypeScript, Node.js, Solidity ^0.8.19, Hardhat, ethers v6, Jest, OpenZeppelin 4.9.6

# Monorepo Structure

```
services/          8 microservices (coordinator, 4 partitions, execution, cross-chain, unified-detector) + mempool (orphaned, not wired into dev tooling)
shared/            7 shared packages (types, config, core, ml, security, test-utils, constants)
contracts/         Smart contracts (Hardhat project)
  src/             Source contracts (base/, interfaces/, mocks/)
  test/            Hardhat test suites (Chai + ethers v6)
  scripts/         Deployment and utility scripts
infrastructure/    Docker, deployment configs
docs/              Architecture, ADRs, strategies, conventions
```

**Service Ports:** 3000 (Coordinator), 3001-3004 (Partitions), 3005 (Execution), 3006 (Cross-Chain), 3007 (Unified Detector, active — factory for P1-P3 partitions)

**Path Aliases:**
- `@arbitrage/types` - shared/types
- `@arbitrage/core` - shared/core/src
- `@arbitrage/config` - shared/config/src
- `@arbitrage/security` - shared/security/src

**Build Order:** types -> config -> core -> ml -> services

# Commands

## Build & Check
```bash
npm run build              # Build all (dependency order)
npm run build:clean        # Clean cache + full rebuild
npm run build:deps         # Shared packages only
npm run typecheck          # Type checking without emit
```

## Test
```bash
npm test                              # All tests
npm run test:unit                     # Unit tests
npm run test:integration              # Integration tests
npm run test:e2e                      # End-to-end tests
npm run test:performance              # Performance benchmarks
npm run test:coverage                 # Coverage report
npm run test:changed                  # Only changed files
```

**Contracts tests (Hardhat):**
```bash
cd contracts && npx hardhat test                    # All contract tests
cd contracts && npx hardhat test test/MyTest.test.ts  # Single test file
cd contracts && npx hardhat compile                 # Compile only
```

## Development
```bash
npm run dev:redis          # Start Redis via Docker
npm run dev:redis:memory   # In-memory Redis (no Docker)
npm run dev:all            # 7 services with hot reload (coord, P1-P4, cross-chain, execution)
npm run dev:minimal        # Coordinator + P1 + Execution only
npm run dev:status         # Check running services
npm run dev:stop           # Stop all services
```

## Validation & Codegen
```bash
npm run generate:error-selectors   # Generate error selectors from ABI
npm run validate:mev-setup          # Validate MEV config for all chains
npm run validate:routers             # Verify on-chain router approvals
npm run lint:fix                    # Auto-fix linting
```

# Environment Setup

**Prerequisites:** Node.js >= 22.0.0, npm >= 9.0.0, Redis (Docker or in-memory)

```bash
npm install && npm run dev:setup  # Install + copy .env.example to .env
```

**Env file priority:** `.env.local` (gitignored, highest) > `.env` (base) > env vars > code defaults

Put secrets (private keys, auth tokens) ONLY in `.env.local`.

# Workflow

1. Read and understand relevant files before proposing any edits
2. Write tests first (TDD) -- verify the test fails, then implement
3. Stick to existing architecture and implementation patterns
4. Trace the data flow before proposing fixes
5. Create regression tests for critical bug fixes
6. Run `npm run typecheck` after making code changes
7. For contracts: run `npx hardhat compile && npx hardhat test` to verify

# Code Style

See `/docs/agent/code_conventions.md` for full patterns.

Key rules:
- ES modules (import/export), not CommonJS
- Use `@arbitrage/*` path aliases across packages, not relative paths
- Use proper nullable types (no `as any` casts)
- Use `??` (nullish coalescing) not `||` for numeric values that can be 0
- Async reset/cleanup functions must await disconnect operations
- Constructor DI pattern for testable classes (not factory functions)
- Set up mocks in `beforeEach()`, override in individual tests
- Import from source files directly, not barrel exports (index.ts)

# Performance Critical

**Hot-path latency target: <50ms** (price-update -> detection -> execution)

Hot-path files:
- `shared/core/src/price-matrix.ts` - L1 cache, SharedArrayBuffer
- `shared/core/src/partitioned-detector.ts` - Opportunity detection
- `services/execution-engine/` - Trade execution
- `services/unified-detector/` - Event processing
- WebSocket handlers - Event ingestion

Rules for hot-path code (ADR-022):
- No blocking operations (sync I/O, unbounded loops)
- Minimize allocations (no spread operators in loops)
- O(1) lookups only (Map/Set, not array.find/filter)
- Pre-allocate arrays, use cached values
- Mutable objects in tight loops (avoid immutable patterns)

# Contract Architecture

**Inheritance:** `BaseFlashArbitrage` (abstract, 1135 lines) -> 5 derived contracts:
- `FlashLoanArbitrage` (Aave V3) - executeOperation callback
- `BalancerV2FlashArbitrage` (Balancer V2) - receiveFlashLoan callback
- `PancakeSwapFlashArbitrage` (PancakeSwap V3) - pancakeV3FlashCallback
- `SyncSwapFlashArbitrage` (SyncSwap/zkSync) - onFlashLoan (EIP-3156)
- `CommitRevealArbitrage` - MEV-protected with commit-reveal scheme

**Utility:** `MultiPathQuoter` - Stateless batch quoting contract

**Access model:** ALL `executeArbitrage()` / `reveal()` functions use OPEN ACCESS (no onlyOwner). The atomic flash loan model with profit verification prevents fund extraction. Admin functions (pause, withdraw, setConfig) use `onlyOwner` via Ownable2Step.

**OpenZeppelin 4.9.6 patterns:**
- `Ownable2Step` - Two-step ownership transfer
- `Pausable` - Emergency pause on all critical functions
- `ReentrancyGuard` - `nonReentrant` on all external entry points
- `SafeERC20` - `safeTransfer`, `forceApprove` for all token ops
- `EnumerableSet` - O(1) approved router management

**Contract versioning:** Base contract at 2.1.0, derived flash loan contracts at 2.1.0, CommitRevealArbitrage at 3.1.0.

# Contract Testing Patterns (Hardhat + Chai + ethers v6)

**Framework:** Hardhat with `loadFixture` for snapshot/restore efficiency.

**Assertion patterns -- CRITICAL:**
- OpenZeppelin 4.x uses string-based `require()` messages, NOT custom errors for ERC20 operations
- Contract custom errors use `.revertedWithCustomError(contract, 'ErrorName')`
- OZ4 ERC20 errors use `.revertedWith('ERC20: transfer amount exceeds balance')`
- Mock `require()` messages use `.revertedWith('Exact string message')`
- NEVER use bare `.to.be.reverted` -- always specify the expected error

```typescript
// Custom errors (contract-defined)
await expect(tx).to.be.revertedWithCustomError(contract, 'InsufficientProfit');

// OpenZeppelin 4.x string-based errors
await expect(tx).to.be.revertedWith('ERC20: transfer amount exceeds balance');

// Mock require() messages
await expect(tx).to.be.revertedWith('Insufficient output amount');

// WRONG - bare revert hides the actual error
await expect(tx).to.be.reverted; // Don't do this
```

**Token decimal handling in tests:**
- WETH/DAI: 18 decimals (`ethers.parseEther('10')`)
- USDC/USDT: 6 decimals (`ethers.parseUnits('10', 6)`)
- When mocking exchange rates between tokens of different decimals, account for the decimal difference in the rate calculation
- Prefer same-decimal token pairs (e.g., WETH/DAI) for simpler mock setup

**Mock contracts:** Located in `contracts/src/mocks/`. When writing tests:
- MockDexRouter uses `require("Insufficient output amount")` (string, not custom error)
- MockAavePool premium is configurable (default 9 bps = 0.09%)
- MockBalancerVault has zero flash loan fee
- MockSyncSwapVault charges 0.3% fee
- MockPancakeV3Pool fee is tier-based (typically 2500 bps = 0.25%)
- MockMaliciousRouter attacks once via `attackCount == 0` guard

**Deployment scripts:** Use `?? 0` / `?? 0n` (not `|| 0`) for fallback values in all scripts under `contracts/scripts/`.

# Key Documentation

## Architecture
- `/docs/architecture/ARCHITECTURE_V2.md` - System design (v2.8)
- `/docs/architecture/CURRENT_STATE.md` - Service inventory
- `/docs/architecture/adr/README.md` - 27 ADRs with decisions

## Development
- `/docs/local-development.md` - Setup guide
- `/docs/CONFIGURATION.md` - All config options
- `/docs/API.md` - Service endpoints

## Patterns
- `/docs/strategies.md` - Arbitrage strategies
- `/docs/agent/code_conventions.md` - Code patterns

## Analysis Reports
- `.agent-reports/FINAL_UNIFIED_REPORT.md` - Latest deep analysis (28 findings, grade B+)
- `.agent-reports/partition-asia-fast-deep-analysis.md` - partition-asia-fast deep analysis (26 findings, grade B+)
- `.agent-reports/partition-high-value-deep-analysis.md` - partition-high-value deep analysis (22 findings, grade B+)

# Documentation Maintenance

When making changes:
- Update relevant ADRs if architectural impact
- Add `@see` references in JSDoc/NatSpec for traceability
- Update `CURRENT_STATE.md` if adding services
- Update `API.md` if changing endpoints
- Keep NatSpec `@custom:version` tags in sync across contracts

# Common Gotchas

**Windows Development:**
- Use PowerShell or Windows Terminal (not cmd.exe)
- Docker Desktop requires WSL2 enabled

**Build Issues:**
- If builds fail, try `npm run build:clean` to clear TypeScript cache
- Shared packages must build first (types -> config -> core -> ml)
- `.tsbuildinfo` cache can cause stale builds -- clean with `npm run clean:cache`

**Dockerfile Issues:**
- Multiple Dockerfiles across services use older Node versions (18/20) despite `engines: ">=22.0.0"` -- check and align when modifying any Dockerfile
- Service-local Dockerfiles (e.g., `services/partition-asia-fast/Dockerfile`) may differ from infrastructure Dockerfiles (`infrastructure/docker/docker-compose.partition.yml` uses `services/unified-detector/Dockerfile`)

**Redis Issues:**
- Never use `KEYS` command (blocks Redis) -- use `SCAN` iterator
- Always await `disconnect()` in cleanup
- Throw on Redis errors (distinguish "not found" from "unavailable")

**Contract Issues:**
- OZ4 ERC20 uses string reverts (`require`), NOT custom errors -- this affects test assertions
- `forceApprove` handles non-zero to non-zero approvals safely (USDT pattern)
- Flash loan callbacks are implicitly protected by calling function's `nonReentrant`
- `totalProfits` accumulator mixes denominations (legacy) -- use `tokenProfits` per-asset mapping instead
- Token address configs vary by chain -- check `contracts/scripts/lib/addresses.ts` for coverage gaps

**Testing Patterns (Jest for services):**
- Constructor DI pattern for testable classes (not factory functions)
- Set up mocks in `beforeEach()`, override in individual tests
- Cast to `jest.Mock`: `(mockedFunction as jest.Mock).mockReturnValue(value)`
- Import from source files directly, not barrel exports (index.ts)
- See `shared/core/__tests__/unit/detector/factory-integration.test.ts` for reference

**Partition Service Architecture:**
- P1-P3 entry points are thin wrappers (~63 lines) calling `createPartitionEntry()` from `@arbitrage/core`
- Real logic lives in `shared/core/src/partition-service-utils.ts` (~1288 lines): health server, shutdown, event handlers, env config
- P4 (partition-solana) does NOT use the factory -- manual 503-line `index.ts` with Solana-specific RPC handling
- Shared test mocks in `shared/test-utils/src/mocks/partition-service.mock.ts` exist but are incomplete (missing `createPartitionEntry`, `runPartitionService`) -- tests use inline mocks instead
- `shared/core/__tests__/unit/partition-service-utils.test.ts` has pre-existing `createPartitionEntry` test failures (11 tests, `getPartition` mock issue)

**Testing Patterns (Hardhat for contracts):**
- Use `loadFixture(deployContractsFixture)` for every test (snapshot/restore)
- Match token decimals between mock setup and assertions
- Always verify specific error types (see "Assertion patterns" above)
- Test both authorized and unauthorized callers for every admin function
- Include reentrancy tests using MockMaliciousRouter for all flash loan contracts

**Path Aliases:**
- Use `@arbitrage/*` and `@shared/*` imports, not relative paths across packages
- Must run `npm run build:deps` after changing shared packages

# Agent Spawning Lessons

Patterns learned from running multi-agent deep analysis and fix workflows on this codebase:

## Cross-Verification is Essential
- Agent findings must be cross-verified against actual code before acting on them
- In the contracts deep analysis, an agent flagged `APPROVED_ROUTERS` as unused (CRITICAL) -- cross-verification showed deployment scripts DO use them at `deploy.ts:149`
- Always read both the flagged code AND its callers/consumers before accepting a finding

## OpenZeppelin Version Awareness
- This project uses OZ 4.9.6 (check `contracts/package.json`), which uses string-based `require()` messages
- OZ 5.x uses custom errors -- do NOT assume OZ5 patterns when writing test assertions
- Mock contracts in `src/mocks/` also use string `require()` -- match assertion style accordingly

## Token Decimal Precision in Test Setup
- When mocking exchange rates between tokens of different decimal precision (e.g., WETH 18 vs USDC 6), the raw amounts are vastly different
- Prefer same-decimal pairs (WETH/DAI both 18) for simpler mock arithmetic
- Example: 10 WETH raw = 10e18, 10 USDC raw = 10e6 -- a 1:1 rate at raw level is nonsensical

## Nullish Coalescing for Numeric Values
- `|| 0` treats legitimate `0` and `0n` as falsy, silently replacing them
- `?? 0` only replaces `null`/`undefined`, preserving zero values
- This applies throughout `contracts/scripts/` for block numbers, gas prices, and profit thresholds

## Agent Specialization Works
- 6 parallel specialized agents (architecture, bugs, security, test quality, mock fidelity, performance) found 28 unique issues with cross-agent agreement on 6 areas
- Bug Hunter and Security agents independently found the same access control doc mismatch, validating both findings
- Mock Fidelity agent caught protocol behavior gaps that Bug Hunter missed (and vice versa)
- Architecture agent caught config drift issues invisible to code-only analysis

## Fix Ordering Matters
- Fix contract source first (Solidity changes), then tests, then scripts
- Compile after source changes to catch errors early (`npx hardhat compile`)
- Run full test suite after all fixes to catch interaction effects
- Some "simple" assertion fixes require understanding OZ version and mock internals

## Shutdown and Server Close Patterns
- Use the `safeResolve` flag pattern (see `closeServerWithTimeout` in `partition-service-utils.ts`) for server shutdown timeouts
- Do NOT use `Promise.race` with a deferred `timeoutId` -- `server.close()` can fire synchronously, causing the timeout handle to be null when clearTimeout is called
- The `||` vs `??` convention applies to ALL env var defaults, including `process.env.NODE_ENV` -- empty string is a valid env value
