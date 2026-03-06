# ADR-041: Blockchain Configuration Architecture Refactor

## Status
Accepted

## Date
2026-03-06

## Context

The configuration system spans **30 source files** in `shared/config/src/` (~9,000 LOC) managing 15 chains, 78 DEXes, 128 tokens, 7 flash loan protocols, and 7 bridge protocols. A full audit (`docs/reports/BLOCKCHAIN_CONFIG_ENHANCEMENT_RESEARCH_2026-03-06.md`) identified 7 pain points:

### Pain Points

| # | Problem | Severity | Example |
|---|---------|----------|---------|
| P1 | Address duplication: same address in up to 3 files | HIGH | Balancer V2 Vault in `addresses.ts`, `dexes/index.ts`, `dex-factories.ts` |
| P2 | Flash loan config split across 4–5 files | HIGH | Adding a provider requires editing types, addresses, availability, service-config, ABIs |
| P3 | DEX config is a 1,500-line monolith | MEDIUM | All 78 DEXes in `dexes/index.ts` |
| P4 | Inconsistent chain type definitions | MEDIUM | `EVMChainId` defined in both `addresses.ts` and `contracts/deployments/addresses.ts` |
| P5 | Barrel export file is 550 lines with stale comments | MEDIUM | Says "11 chains" and "52 DEXes" but system has 15/78 |
| P6 | Deferred items hidden in comments | MEDIUM | 9 TODOs/stubs scattered across config files, no programmatic tracking |
| P7 | Mantle/Mode stub chains with unverified addresses | HIGH | Sequential hex patterns on Mode DEXes suggest placeholders |

### Current Architecture Strengths (Retained)

- Single source of truth for addresses (`addresses.ts`) with helper functions
- Branded types (`FeeBasisPoints`, `FeeDecimal`) preventing unit confusion
- O(1) Map-based lookups for hot-path performance (ADR-022)
- Zod schema validation for runtime safety
- Module-load validation that fails fast on startup
- Adapter pattern for vault-model DEXes (Balancer, GMX, Platypus)

### Alternatives Considered

| Approach | Used By | Verdict |
|----------|---------|---------|
| A: Per-Chain Config Modules | Uniswap Labs, 1inch | Rejected — cross-chain queries become expensive aggregations |
| B: Registry Pattern with Builders | Aave, Lido | Rejected — over-abstracted for static config |
| C: Protocol Descriptor Objects | Yearn, Balancer SDK | Rejected — enormous nested objects for 78 DEXes × 15 chains |
| D: Declarative Config + Code Generation | ChainLink, Wormhole | Rejected — overkill for ~15 chains changing infrequently |
| **E: Incremental Refactor** | **Selected** | **Targeted improvements preserving existing strengths** |

## Decision

**Incremental refactor** with 7 targeted tasks. The current architecture is fundamentally sound — problems are organizational (file layout, duplication) not architectural (patterns, types). A full rewrite would risk regressions across thousands of configuration combinations (78 DEXes × 15 chains × 7 flash loan protocols).

### Task 1: Consolidate Flash Loan Provider Config

Create `shared/config/src/flash-loan-providers/` with a single-object-per-protocol pattern. Each provider is a self-contained `FlashLoanProviderDescriptor`:

```
flash-loan-providers/
  index.ts              # Registry, getPreferredProtocol, availability helpers
  types.ts              # FlashLoanProviderDescriptor, FlashLoanProviderStatus
  aave-v3.ts            # Aave V3: addresses, fee, chains, status
  balancer-v2.ts        # Balancer V2: addresses, fee, chains
  pancakeswap-v3.ts     # PancakeSwap V3: addresses, fee, chains
  syncswap.ts           # SyncSwap: addresses, fee, chains
  dai-flash-mint.ts     # DssFlash: addresses, fee, chains
  morpho.ts             # Morpho: addresses, fee, status=deferred
  spookyswap.ts         # SpookySwap: addresses, fee, chains
```

Each descriptor references addresses from `addresses.ts` (no duplication):

```typescript
export const AAVE_V3_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'aave_v3',
  feeBps: 9,
  addresses: AAVE_V3_POOLS,   // Reference, not copy
  chains: ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism', 'avalanche', 'scroll'],
  status: 'active',
};
```

**Eliminates**: Manual sync between addresses, availability matrix, and service-config. Adding a new provider: 4–5 files → 1 file (new descriptor) + contract deployment.

### Task 2: Split DEX Config into Per-Chain Files

Replace the 1,500-line `dexes/index.ts` monolith with per-chain files:

```
dexes/
  index.ts              # Aggregates all chains, exports DEXES
  chains/
    arbitrum.ts         # 10 DEXes
    bsc.ts              # 8 DEXes
    ethereum.ts         # 5 DEXes
    ... (15 chain files)
```

The aggregator `index.ts` becomes a trivial import/re-export. Each chain file is 50–150 lines. PRs that add DEXes to one chain don't create merge conflicts with other chains.

### Task 3: Eliminate Address Triple-Duplication

DEX entries and factory registry entries reference `addresses.ts` imports instead of inline address literals:

```typescript
// dexes/chains/arbitrum.ts
import { BALANCER_V2_VAULTS } from '../../addresses';

{ factoryAddress: BALANCER_V2_VAULTS.arbitrum }  // Single source
```

**Eliminates**: ~40 inline address literals that duplicate `addresses.ts`. Drift between files becomes impossible since they share the same constant reference.

### Task 4: Unify Chain Type Definitions

Make `shared/types/src/chains.ts` the sole source of truth for `ChainId`, `EVMChainId`, `TestnetChainId`. Other files (`addresses.ts`, `contracts/deployments/addresses.ts`) import and re-export for backward compatibility.

### Task 5: Add Verified/Stub Metadata to Config

Add `verified?: boolean` field to the `Dex` interface. Mark Mantle/Mode DEXes as `verified: false`. Add `getVerifiedDexes(chain)` helper so the execution engine can filter stubs at runtime.

### Task 6: Deferred Item Tracking System

Create `shared/config/src/deferred-items.ts` with a machine-readable registry of all deferred work:

```typescript
export interface DeferredItem {
  id: string;
  description: string;
  status: 'deferred' | 'stub' | 'todo';
  blocker: string;
  files: string[];
  isResolved?: () => boolean;  // Optional runtime check
}
```

Automated test (`deferred-items.test.ts`) **intentionally fails** when a blocker's `isResolved()` returns true — alerting developers that deferred work can now proceed. Converts invisible comments into actionable CI signals.

### Task 7: Clean Up Barrel Exports

Update `index.ts` stale comments, add exports for `flash-loan-providers/` and `deferred-items`, remove `export *` wildcards in favor of explicit exports.

### Execution Order

```
Phase 1 (independent, parallelizable):
  Task 4 (chain types) + Task 5 (verified metadata) + Task 6 (deferred tracking)

Phase 2 (depends on Phase 1):
  Task 2 (DEX split) + Task 1 (flash loan consolidation)

Phase 3 (depends on Phase 2):
  Task 3 (address dedup) + Task 7 (barrel cleanup)
```

Verification gate between phases: `npm run typecheck && npm run test:unit`.

### Implementation Progress

| Task | Status | Commit |
|------|--------|--------|
| Task 1: Flash loan provider descriptors | ✅ Complete | `d4b40efc` |
| Task 2: Per-chain DEX files | ✅ Complete | `986a7209` |
| Task 3: Address deduplication | ✅ Complete (Balancer V2 across 4 chains + dex-factories) | `d4b40efc` |
| Task 4: Chain type unification | ✅ Complete | `986a7209` |
| Task 5: Verified/stub metadata | ✅ Complete | `986a7209` |
| Task 6: Deferred item tracking | ✅ Complete (7 items, 14 tests) | `986a7209`, `d4b40efc` |
| Task 7: Barrel export cleanup | ✅ Complete | `d4b40efc` |

## Consequences

### Positive

- **Reduced duplication**: Protocol addresses exist in one place (`addresses.ts`); DEX and factory configs reference them
- **Faster onboarding**: Per-chain files (50–150 lines) vs monolith (1,500 lines)
- **Safer modifications**: Changing a DEX on one chain doesn't risk merge conflicts with other chains
- **Programmatic deferred tracking**: 7 deferred items with automated test alerts when blockers resolve
- **Stub safety**: `verified: false` metadata prevents unverified addresses from reaching execution
- **Simpler provider addition**: New flash loan provider = 1 descriptor file + contract deployment

### Negative

- **More files**: 15 per-chain DEX files + 9 flash-loan-provider files vs 2 monoliths
- **Import depth**: Per-chain files import from `../../addresses` (2 levels deep within the package)
- **Backward compatibility shims**: `flash-loan-availability.ts` retained as re-export for existing consumers

### Zero Impact Areas

- **Hot-path code**: No changes to `price-matrix.ts`, `partitioned-detector.ts`, or `execution-pipeline.ts`
- **Runtime behavior**: All derivation happens at module-load time. Zero hot-path latency impact.
- **Contract code**: No Solidity changes
- **Redis Streams**: No changes to ADR-002 event processing
- **Service startup**: Same config validation, same fail-fast behavior

## References

- `docs/reports/BLOCKCHAIN_CONFIG_ENHANCEMENT_RESEARCH_2026-03-06.md` — Full research report with alternatives analysis
- ADR-003: Partitioned Detectors — partition config consumed by this system
- ADR-020: Flash Loan Integration — flash loan provider architecture
- ADR-022: Hot-Path Memory Optimization — performance constraints respected
- ADR-038: Chain-Grouped Execution — chain group config consumed by this system
- ADR-040: Real-Time Native Token Pricing — native token price pools config
