# Research Report: Node.js Project Structure & Best Practices

## 1. Executive Summary
The current project follows a monorepo-style structure with a separation between `services` and `shared` code. While this is a good starting point, the `shared/core` package has become a monolithic "God package" (High Coupling/Low Cohesion), containing unrelated responsibilities ranging from Redis infrastructure to business logic like triangular arbitrage.

To adhere to professional Node.js best practices, we recommend refactoring towards a **Domain-Driven Design (DDD)** approach within a managed **Monorepo** (likely using helper tools like Nw, Turborepo, or just refined npm workspaces).

## 2. Current State Analysis

### Structure
- **Root**: Standard configuration files.
- **`services/`**: Contains distinct microservices (e.g., `coordinator`, `execution-engine`).
- **`shared/`**:
    - `core`: A monolithic wrapper containing:
        - Infrastructure (Redis, Cache, Logger)
        - Domain Logic (Arbitrage strategies, Detectors)
        - Utilities (Async tools, Error handling)
    - `types`, `config`, `test-utils`: Better separated, but likely tightly coupled to `core`.

### Issues Identified
1.  **"God Package" Anti-Pattern**: `shared/core/src` has 50+ files mixed with infrastructure and domain logic.
2.  **Coupling**: Services likely import generic things from `shared/core`, making it hard to see what a service *actually* depends on.
3.  **Scalability**: As the team grows, `shared/core` becomes a merge-conflict bottleneck.
4.  **Testing**: Testing `core` is difficult because of the mix of concerns.

## 3. Best Practices Research

### A. The "Modular Monorepo" (Standard Professional Practice)
In modern Node.js development, code is split into small, focused packages.
- **Apps/Services**: Deployable units (API, Workers).
- **Packages/Libs**: Reusable logic.

### B. Vertical Slices vs. Horizontal Layers
- **Horizontal** (Current-ish): `models`, `controllers`, `services` folders.
- **Vertical** (Recommended): `orders`, `users`, `payments` modules that encapsulate their own models/logic.

### C. Dependency Rule (Clean Architecture)
- **Domain** (Entities/Business Rules) should rely on nothing.
- **Application** (Use Cases) relies on Domain.
- **Infrastructure** (Db, Redis, Web) concerns are plugins/adapters.

## 4. Proposed New Structure

We recommend breaking `shared` into focused, scoped packages and enforcing a stricter internal structure for services.

### Level 1: The Monorepo Layout
```
/
├── apps/ (or services/)
│   ├── coordinator/
│   ├── execution-engine/
│   └── ...
├── packages/ (formerly shared/)
│   ├── core-infra/           # Base infrastructure (Logger, Error handling)
│   ├── redis-client/         # Dedicated Redis wrapper
│   ├── domain-arbitrage/     # Core domain logic (Triangular Arb, etc.) - Pure JS/TS, no I/O
│   ├── blockchain-adapter/   # Web3/Ethers abstractions
│   └── ...
├── tools/                    # Build scripts, ESLint configs
```

### Level 2: Scoped Packages (npm workspaces)
Instead of `import { Redis } from 'shared/core'`, use:
- `import { RedisClient } from '@app/redis-client'`
- `import { Logger } from '@app/logger'`

### Level 3: Service Internal Structure
For each service (e.g., `execution-engine`), follow a consistent pattern:
```
services/execution-engine/
├── src/
│   ├── config/          # Service-specific config
│   ├── domain/          # Business logic specific to this service
│   ├── infra/           # Adapters (Database impl, API clients)
│   ├── interfaces/      # HTTP/RPC Handlers (Controllers)
│   └── index.ts         # Composition Root (Dependency Injection)
```

## 5. Migration Strategy
1.  **Identify Seams**: Group `shared/core` files by responsibility (Redis, strategies, utils).
2.  **Extract Infrastructure**: Move logger, redis, and basic utils to new packages (`@app/infra-redis`, `@app/infra-logger`).
3.  **Extract Domain**: Move `cross-dex-triangular-arbitrage.ts` and related math/models to `@app/domain-arbitrage`.
4.  **Refactor Services**: Update imports in services to use the new packages.

## 6. Recommended Next Steps
1.  Approve this structure.
2.  Create the new package folders in `packages/` (or `shared/packages/`).
3.  Start with the easiest extraction: **Logger** and **Types**.
