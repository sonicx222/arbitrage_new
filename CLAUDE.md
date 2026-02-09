# Role
- You are a senior developer who has expertise in Decentralized Finance/Web3/Blockchains building professional, efficient and profitable arbitrage trading systems

# Environment Setup

**Prerequisites:**
- Node.js >= 22.0.0 (check: `node --version`)
- npm >= 9.0.0 (check: `npm --version`)
- Redis (via Docker or in-memory mode)

**Initial Setup:**
```bash
npm install
npm run dev:setup  # Copies .env.example to .env
```

**Configure .env:**
See `.env.example` for all required variables. Key ones:
- `REDIS_URL` - Redis connection (default: redis://localhost:6379)
- `PARTITION_ID` - Which partition this service belongs to
- RPC API keys for chains you want to monitor

# Architecture Quick Reference

**Monorepo Structure:**
- `services/` - 9 microservices (coordinator, 4 partitions, execution, cross-chain, mempool, unified-detector)
- `shared/` - 7 shared packages (types, config, core, ml, security, test-utils, constants)
- `contracts/` - Smart contracts
- `infrastructure/` - Docker, deployment configs

**Service Ports:**
- 3000: Coordinator (dashboard)
- 3001-3004: Partition detectors (asia-fast, l2-turbo, high-value, solana)
- 3005: Execution Engine
- 3006: Cross-Chain Detector
- 3007: Mempool Detector

**Build Dependencies:**
Must build in order: types → config → core → ml → main
Use `npm run build` (handles order) or `npm run build:deps` (just shared packages)

**Path Aliases:**
- `@arbitrage/types` - shared/types
- `@arbitrage/core` - shared/core/src
- `@arbitrage/config` - shared/config/src
- `@shared/security` - shared/security/src

# Commands

## Development
```bash
# Start Redis (choose one)
npm run dev:redis          # Docker (recommended)
npm run dev:redis:memory   # In-memory (no Docker)

# Start all services with hot reload
npm run dev:all            # All 9 services
npm run dev:minimal        # Just Coordinator + P1 + Execution

# Individual services (fast hot-reload with tsx)
npm run dev:coordinator:fast
npm run dev:partition:asia:fast
npm run dev:partition:l2:fast
npm run dev:partition:high:fast
npm run dev:cross-chain:fast
npm run dev:execution:fast

# Service management
npm run dev:status         # Check running services
npm run dev:stop           # Stop all services
npm run dev:cleanup        # Clean up orphaned processes
```

## Testing
```bash
npm test                              # All tests
npm run test:unit                     # Unit tests
npm run test:unit:shard1              # Unit tests shard 1 of 3
npm run test:integration              # Integration tests
npm run test:integration:shard1       # Integration shard 1 of 2
npm run test:e2e                      # End-to-end tests
npm run test:performance              # Performance benchmarks
npm run test:smoke                    # Quick smoke tests
npm run test:professional-quality     # Full quality check
npm run test:debug                    # Debug mode with logging
npm run test:changed                  # Only changed files
npm run test:related <file>           # Tests related to file
npm run test:coverage                 # Generate coverage report
```

## Building
```bash
npm run build              # Build all (follows dependency order)
npm run build:clean        # Clean cache + full rebuild
npm run build:deps         # Build shared packages only
npm run typecheck          # Type checking without emit
npm run typecheck:watch    # Watch mode type checking
```

## Linting
```bash
npm run lint               # Check code style
npm run lint:fix           # Auto-fix style issues
```

## Simulation Modes
Test without real blockchain connections:
```bash
npm run dev:simulate:full          # Full simulation (no Redis, no blockchain)
npm run dev:simulate:full:memory   # With in-memory Redis
npm run dev:simulate               # Just blockchain simulation
npm run dev:simulate:execution     # Just execution simulation
```

# Code style
- /docs/agent/code_conventions.md

# Workflow
- Write tests first following TDD
- Stick to the existing architecture design and implementation structure
- ALWAYS read and understand relevant files before proposing edits. Do not speculate about code you have not inspected
- Understand the data flow. Then propose a fix
- The corrected code should be functional, efficient, and adhere to best practices in node.js programming
- Always create a regression test after fixing a critical issue
- Be sure to typecheck when you're done making a series of code changes

# Key Documentation
When working on this codebase, refer to these documents:

## Architecture
- /docs/architecture/ARCHITECTURE_V2.md - System design (v2.8)
- /docs/architecture/CURRENT_STATE.md - Service inventory
- /docs/architecture/adr/README.md - 27 ADRs with decisions

## Development
- /docs/local-development.md - Setup guide
- /docs/CONFIGURATION.md - All config options
- /docs/API.md - Service endpoints

## Patterns
- /docs/strategies.md - Arbitrage strategies
- /docs/agent/code_conventions.md - Code patterns

# Documentation Maintenance
When making changes:
- Update relevant ADRs if architectural impact
- Add @see references in JSDoc for traceability
- Update CURRENT_STATE.md if adding services
- Update API.md if changing endpoints

# Performance Critical
Hot-path code (<50ms target) in:
- shared/core/src/price-matrix.ts
- shared/core/src/partitioned-detector.ts
- services/execution-engine/
- services/unified-detector/

Follow ADR-022 patterns for hot-path changes.

# Common Gotchas

**Windows Development:**
- Use PowerShell or Windows Terminal (not cmd.exe)
- Docker Desktop requires WSL2 enabled

**Build Issues:**
- If builds fail, try `npm run build:clean` to clear TypeScript cache
- Shared packages must build first (types → config → core → ml)
- Check `npm run typecheck` catches most issues before build
- `.tsbuildinfo` cache file can cause stale build issues - clean it with `npm run clean:cache`

**Redis Issues:**
- Never use `KEYS` command (blocks Redis) - use `SCAN` iterator
- Always await disconnect() in cleanup
- Distinguish "not found" from "unavailable" by throwing on errors

**Testing Patterns:**
- Use constructor pattern for DI-based classes, not factory functions
  - ✅ `new ServiceClass(config, deps)` - allows proper mock injection
  - ❌ `createService(config, deps)` - may cache module imports
- Set up mocks in `beforeEach()`, override in individual tests
  - Cast to `jest.Mock`: `(mockedFunction as jest.Mock).mockReturnValue(value)`
  - Don't use `jest.spyOn()` for module-level functions - doesn't work with cached imports
- Import directly from source files, not barrel exports (index.ts)
  - ✅ `from '../../../src/detector/service'` - direct file import
  - ❌ `from '../../../src/detector'` - barrel export can cause mock issues
- Create local `createMockDeps()` helper for consistent dependency injection
- Always import mocked functions after jest.mock() to get typed mock
- Example pattern (from factory-integration.test.ts):
  ```typescript
  // Import class + mocked functions
  import { ServiceClass } from '../../../src/path/to/service';
  import { mockedFunction } from '@arbitrage/config';

  // Set up in beforeEach
  beforeEach(() => {
    (mockedFunction as jest.Mock).mockReturnValue(defaultValue);
  });

  // Override in test
  it('test name', async () => {
    (mockedFunction as jest.Mock).mockReturnValue(testValue);
    const service = new ServiceClass(config, createMockDeps());
    const result = await service.method();
    expect(result).toBeDefined();
  });
  ```
- See `shared/core/__tests__/unit/detector/factory-integration.test.ts` for reference

**Performance:**
- Hot-path code must complete in <50ms
- Files in shared/core/src/price-matrix.ts and partitioned-detector.ts are critical
- See ADR-022 for performance patterns

**Path Aliases:**
- Use `@arbitrage/*` and `@shared/*` imports, not relative paths across packages
- TSConfig baseUrl and paths configure these aliases
- Must run `npm run build:deps` after changing shared packages
