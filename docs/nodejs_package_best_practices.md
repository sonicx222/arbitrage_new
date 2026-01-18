# Node.js Package Structure Best Practices

**Research Date**: January 18, 2026

This document outlines professional Node.js monorepo and package structure best practices, with specific recommendations for restructuring the arbitrage bot codebase.

---

## Executive Summary

| Aspect | Current State | Recommended State |
|--------|---------------|-------------------|
| **Tooling** | npm workspaces | pnpm + Turborepo/Nx |
| **Structure** | `shared/`, `services/` | `packages/`, `apps/` |
| **Module Boundaries** | 150+ exports in one file | Explicit `exports` per package |
| **TypeScript** | Shared tsconfig | Project references |
| **File Size** | 2,393 lines max | 300-500 lines max |

---

## 1. Recommended Folder Structure

```
arbitrage-system/
├── apps/                          # Deployable applications
│   ├── coordinator/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── handlers/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── execution-engine/
│   └── detector/
│
├── packages/                      # Shared libraries
│   ├── redis/                     # Redis utilities
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── streams.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── resilience/                # Circuit breakers, self-healing
│   ├── detection/                 # Arbitrage detection algorithms
│   ├── execution/                 # Trade execution logic
│   ├── config/                    # Chain/DEX configurations
│   ├── types/                     # Shared TypeScript types
│   └── utils/                     # Generic utilities
│
├── tools/                         # Build scripts, generators
├── package.json                   # Root workspace config
├── pnpm-workspace.yaml
├── turbo.json                     # Turborepo configuration
└── tsconfig.base.json             # Base TypeScript config
```

---

## 2. Package Design Principles

### 2.1 Single Responsibility
Each package should have **one clear purpose**:

| ❌ Current (Monolithic) | ✅ Recommended (Modular) |
|------------------------|-------------------------|
| `@arbitrage/core` (150+ exports) | `@arbitrage/redis` |
| | `@arbitrage/resilience` |
| | `@arbitrage/detection` |
| | `@arbitrage/execution` |

### 2.2 Explicit Public API via `exports`

```json
// packages/redis/package.json
{
  "name": "@arbitrage/redis",
  "exports": {
    ".": "./dist/index.js",
    "./streams": "./dist/streams.js",
    "./lock": "./dist/lock.js"
  },
  "typesVersions": {
    "*": {
      "*": ["./dist/*.d.ts"]
    }
  }
}
```

> [!IMPORTANT]
> The `exports` field **encapsulates** your package. Consumers cannot import internal files not listed in `exports`.

### 2.3 File Size Limits (Max 300-500 Lines)

| File Type | Max Lines | Rationale |
|-----------|-----------|-----------|
| Service entry point | 100 | Orchestration only |
| Business logic class | 300 | Single responsibility |
| Configuration file | 500 | Data-heavy is acceptable |
| Test file | 500 | May contain many test cases |

---

## 3. TypeScript Configuration

### 3.1 Project References (Incremental Builds)

```json
// tsconfig.base.json (root)
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "composite": true,
    "incremental": true
  }
}
```

```json
// packages/redis/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [
    { "path": "../types" }
  ]
}
```

### 3.2 Strict Mode Enforcement

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

---

## 4. Tooling Recommendations

| Tool | Purpose | Why |
|------|---------|-----|
| **pnpm** | Package manager | Fast, disk-efficient, strict |
| **Turborepo** | Build orchestration | Caching, parallelization |
| **Vitest** | Testing | ESM-native, fast |
| **ESLint + @typescript-eslint** | Linting | Type-aware rules |
| **Changesets** | Versioning | Monorepo publishing |

### 4.1 Turborepo Configuration

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {}
  }
}
```

---

## 5. Migration Strategy for Current Codebase

### Phase 1: Tooling Foundation (Week 1)
1. Install pnpm: `npm install -g pnpm`
2. Convert to pnpm workspace: `pnpm import`
3. Install Turborepo: `pnpm add -D turbo`
4. Fix Jest configuration (or migrate to Vitest)

### Phase 2: Package Extraction (Week 2-3)
Extract from `shared/core/src/` into focused packages:

| Current Location | New Package |
|------------------|-------------|
| `redis.ts`, `redis-streams.ts` | `@arbitrage/redis` |
| `circuit-breaker.ts`, `graceful-degradation.ts`, `self-healing-manager.ts` | `@arbitrage/resilience` |
| `cross-dex-triangular-arbitrage.ts`, `multi-leg-path-finder.ts` | `@arbitrage/detection` |
| `hierarchical-cache.ts`, `shared-memory-cache.ts` | `@arbitrage/cache` |

### Phase 3: Service Decomposition (Week 4-6)
Split god objects:

| Current File | New Modules |
|--------------|-------------|
| `engine.ts` (2,393 lines) | `execution/queue.ts`, `execution/provider.ts`, `execution/strategies/flash-loan.ts`, `execution/strategies/mev.ts` |
| `coordinator.ts` (1,767 lines) | `coordinator/leader-election.ts`, `coordinator/stream-consumer.ts`, `coordinator/api/routes.ts` |

### Phase 4: Validation (Week 7)
1. Achieve 80%+ test coverage on extracted packages
2. Run integration tests across package boundaries
3. Validate build times with Turborepo caching

---

## 6. Package Naming Convention

```
@arbitrage/[domain]-[capability]
```

| Package | Description |
|---------|-------------|
| `@arbitrage/redis` | Redis client and streams |
| `@arbitrage/resilience` | Fault tolerance patterns |
| `@arbitrage/detection-simple` | Simple arbitrage detection |
| `@arbitrage/detection-triangular` | Triangular arbitrage |
| `@arbitrage/execution-flash` | Flash loan execution |
| `@arbitrage/config-chains` | Chain configurations |
| `@arbitrage/config-dex` | DEX configurations |

---

## 7. Key Metrics to Track

| Metric | Target | Measurement |
|--------|--------|-------------|
| Package count | 10-15 | `ls packages/` |
| Avg lines per file | <300 | `cloc --by-file` |
| Build time (cold) | <60s | `time turbo build` |
| Build time (cached) | <5s | `time turbo build` |
| Test coverage | >80% | `vitest --coverage` |
| Circular deps | 0 | `madge --circular` |

---

## References

- [Nx Documentation: Package-Based Repos](https://nx.dev/concepts/more-concepts/package-based-repo)
- [Node.js: Package Entry Points](https://nodejs.org/api/packages.html#package-entry-points)
- [Turborepo Handbook](https://turbo.build/repo/docs/handbook)
- [pnpm Workspaces](https://pnpm.io/workspaces)
