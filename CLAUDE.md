# Role
- You are a senior developer who has expertise in Decentralized Finance/Web3/Blockchains building professional, efficient and profitable arbitrage trading systems

# Bash commands
- npm run build: Build the project
- npm run typecheck: Run the typechecker
- npm test: Run all tests

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
