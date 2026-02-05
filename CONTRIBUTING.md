# Contributing Guide

Thank you for considering contributing to the Professional Arbitrage Detection System!

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Development Workflow](#development-workflow)
3. [Code Standards](#code-standards)
4. [Testing Requirements](#testing-requirements)
5. [Pull Request Process](#pull-request-process)
6. [Architecture Decisions](#architecture-decisions)

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- Docker Desktop (optional, for Redis)
- Git

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd arbitrage_new

# Install dependencies
npm install

# Copy environment template
npm run dev:setup

# Start Redis (choose one)
npm run dev:redis          # Docker
npm run dev:redis:memory   # In-memory (no Docker)

# Run tests to verify setup
npm test
```

### Documentation to Read First

1. [Local Development Guide](docs/local-development.md) - Setup and running services
2. [Code Conventions](docs/agent/code_conventions.md) - Coding standards
3. [Architecture Overview](docs/architecture/ARCHITECTURE_V2.md) - System design
4. [ADR Index](docs/architecture/adr/README.md) - Architectural decisions

---

## Development Workflow

### Branch Naming

```
feature/   - New features
bugfix/    - Bug fixes
hotfix/    - Critical production fixes
docs/      - Documentation only
refactor/  - Code improvements without behavior change
```

Examples:
- `feature/add-sonic-chain`
- `bugfix/fix-price-staleness`
- `docs/update-api-reference`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `refactor`: Code change without behavior change
- `test`: Adding or fixing tests
- `perf`: Performance improvement
- `chore`: Build process or auxiliary tools

Examples:
```
feat(detector): add Sonic chain support

fix(execution): handle zero fee in profit calculation

docs(api): add WebSocket endpoint documentation

perf(cache): reduce L1 cache lookup from O(n) to O(1)

Closes #123
```

---

## Code Standards

### TypeScript

- **ES Modules**: Use `import`/`export`, not `require`
- **Strict Mode**: All files must pass `--strict` TypeScript
- **No `any`**: Use proper types or `unknown`
- **Nullish Coalescing**: Use `??` instead of `||` for defaults

```typescript
// Bad
const fee = config.fee || 0.003;

// Good
const fee = config.fee ?? 0.003;
```

### Hot-Path Code

Code in `shared/core/src/` must follow strict performance rules:

- **No Allocations in Loops**: Reuse buffers
- **O(1) Lookups**: Use Map/Set, not Array.find()
- **No Blocking I/O**: All I/O must be async

See [Code Conventions](docs/agent/code_conventions.md) for detailed patterns.

### File Organization

```
services/           # Microservices (one per directory)
shared/
  ├── config/       # Configuration (chains, DEXs, tokens)
  ├── core/         # Hot-path code (detectors, caches)
  ├── types/        # TypeScript type definitions
  └── test-utils/   # Testing utilities
contracts/          # Solidity smart contracts
docs/               # Documentation
infrastructure/     # Deployment configs
```

---

## Testing Requirements

### Test-Driven Development (TDD)

1. **Write tests first** before implementing features
2. **Run tests** to see them fail
3. **Implement** the minimum code to pass
4. **Refactor** while keeping tests green

### Test Commands

```bash
# Run all tests
npm test

# Run specific test file
npm test -- path/to/test.ts

# Run tests in watch mode
npm test -- --watch

# Run with coverage
npm test -- --coverage

# Type check
npm run typecheck
```

### Coverage Requirements

- **Minimum**: 80% line coverage
- **Hot-path code**: 90%+ coverage
- **New features**: Must include tests

### Test Categories

| Category | Location | Purpose |
|----------|----------|---------|
| Unit | `*.test.ts` next to source | Isolated function testing |
| Integration | `tests/integration/` | Cross-module testing |
| E2E | `tests/e2e/` | Full system testing |

---

## Pull Request Process

### Before Submitting

- [ ] Tests pass: `npm test`
- [ ] Type check passes: `npm run typecheck`
- [ ] Code follows conventions
- [ ] Documentation updated (if needed)
- [ ] No console.log statements
- [ ] No hardcoded secrets

### PR Template

```markdown
## Summary
Brief description of changes.

## Type
- [ ] Feature
- [ ] Bug fix
- [ ] Documentation
- [ ] Refactor
- [ ] Performance

## Changes
- Change 1
- Change 2

## Testing
How was this tested?

## ADR Reference
Related ADR (if architectural): ADR-XXX

## Checklist
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Type check passes
- [ ] No breaking changes (or documented)
```

### Review Process

1. **Self-review**: Check your own PR first
2. **CI checks**: All automated checks must pass
3. **Code review**: At least one approval required
4. **Merge**: Squash and merge preferred

---

## Architecture Decisions

### When to Create an ADR

Create an Architecture Decision Record (ADR) when:

- Adding a new chain or DEX integration
- Changing core data structures
- Modifying the hot-path
- Adding new services
- Changing external dependencies

### ADR Template

```markdown
# ADR-XXX: Title

## Status
Proposed | Accepted | Deprecated | Superseded

## Context
What is the issue motivating this decision?

## Decision
What change are we making?

## Rationale
Why is this the best choice?

## Consequences
What becomes easier or harder?

## Alternatives Considered
What other options were evaluated?

## Confidence Level
XX% - Explanation of confidence factors
```

See [ADR Index](docs/architecture/adr/README.md) for examples.

---

## Getting Help

- **Questions**: Open a GitHub Discussion
- **Bugs**: Open a GitHub Issue with reproduction steps
- **Security**: Email security@example.com (do not open public issue)

---

## Recognition

Contributors are recognized in:
- Git history
- Release notes
- CONTRIBUTORS.md (for significant contributions)

Thank you for contributing!
