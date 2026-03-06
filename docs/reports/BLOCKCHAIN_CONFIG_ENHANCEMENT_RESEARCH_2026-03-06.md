# Research Summary: Blockchain & Contract Configuration Architecture Enhancement

**Date**: 2026-03-06
**Scope**: Chain, token, DEX, flash loan, adapter, factory, Balancer, and aggregator configuration — cleanliness, clarity, maintainability, and deferred/placeholder resolution.
**Confidence**: HIGH (based on full codebase read of 30+ config files, ~9,000 LOC)

---

## 1. Current State Analysis

### 1.1 How It Works Today

The configuration system is spread across **30 source files** in `shared/config/src/` with **~9,047 lines of code** managing 15 chains, 78 DEXes, 128 tokens, 7 flash loan protocols, and 7 bridge protocols.

**File inventory by concern:**

| Concern | Files | Lines | Key Files |
|---------|-------|-------|-----------|
| Chain config | 3 | ~1,100 | `chains/index.ts`, `provider-config.ts`, `chain-url-builder.ts` |
| DEX config | 1 | ~1,500 | `dexes/index.ts` |
| Factory registry | 1 | ~1,100 | `dex-factories.ts` |
| Token config | 2 | ~1,200 | `tokens/index.ts`, `native-token-price-pools.ts` |
| Address registry | 1 | ~800 | `addresses.ts` |
| Flash loan availability | 1 | ~450 | `flash-loan-availability.ts` |
| Flash loan ABI | 1 | ~400 | `flash-loan-abi.ts` |
| Service config | 1 | ~600 | `service-config.ts` (also contains flash loan provider config) |
| Bridge config | 1 | ~500 | `bridge-config.ts` |
| Other config | 18 | ~2,400 | partitions, cross-chain, MEV, detector, risk, schemas, etc. |

**Current architecture strengths (retain these):**
- Single source of truth for addresses (`addresses.ts`) with helper functions
- Branded types (`FeeBasisPoints`, `FeeDecimal`) preventing unit confusion
- O(1) Map-based lookups for hot-path performance
- Zod schema validation for runtime safety
- Module-load validation that fails fast on startup
- Adapter pattern for vault-model DEXes (Balancer, GMX, Platypus)

### 1.2 Configuration Registration Flow

```
                        shared/types/src/chains.ts
                              ChainId type
                                  |
                    +-------------+-------------+
                    |             |             |
           chains/index.ts  addresses.ts  dex-factories.ts
           (RPC, WS, block  (protocol     (factory addresses,
            times, 7-prov)   addresses)    types, ABIs)
                    |             |             |
                    +------+------+------+------+
                           |             |
                    dexes/index.ts  flash-loan-availability.ts
                    (78 DEXes with  (protocol x chain matrix)
                     factory+router)
                           |             |
                    service-config.ts    |
                    (FLASH_LOAN_PROVIDERS,
                     MULTI_PATH_QUOTER)  |
                           |             |
                    +------+------+------+
                           |
                      index.ts (barrel re-export, ~550 lines)
                           |
                    @arbitrage/config (consumed by services)
```

### 1.3 Core Pain Points Identified

**P1: Address Duplication Between DEXes and Addresses** (HIGH)
- `dexes/index.ts` contains factory+router addresses inline per DEX entry
- `addresses.ts` contains DEX_ROUTERS and protocol addresses separately
- `dex-factories.ts` also stores factory addresses
- **Same address appears in up to 3 places** (e.g., Balancer V2 Vault `0xBA122...` in `addresses.ts`, `dexes/index.ts`, and `dex-factories.ts`)
- Drift risk: changing one but not others

**P2: Flash Loan Config Split Across 4 Files** (HIGH)
- Protocol types: `@arbitrage/types` (`FlashLoanProtocol`)
- Protocol addresses: `addresses.ts` (`AAVE_V3_POOLS`, `BALANCER_V2_VAULTS`, etc.)
- Availability matrix: `flash-loan-availability.ts` (18-chain x 7-protocol boolean grid)
- Provider config: `service-config.ts` (`FLASH_LOAN_PROVIDERS` with address + fee)
- ABIs: `flash-loan-abi.ts`
- **Adding a new flash loan provider requires editing 4-5 files**

**P3: DEX Configuration is a 1,500-line Monolith** (MEDIUM)
- All 78 DEXes in a single file with inline addresses
- No per-chain file organization
- Adding a DEX to an existing chain means editing a 1,500-line file and finding the right section
- Priority markers (`[C]`, `[H]`, `[M]`) are comments, not data

**P4: Inconsistent Chain Type Definitions** (MEDIUM)
- `shared/types/src/chains.ts` defines `ChainId` with kebab-case testnets (`arbitrum-sepolia`)
- `contracts/deployments/addresses.ts` defines `TestnetChain` with camelCase (`arbitrumSepolia`)
- `EVMChainId` defined in both `addresses.ts` and `contracts/deployments/addresses.ts`
- Chain aliases exist in 3 separate places: `shared/types/src/chains.ts`, `contracts/deployments/addresses.ts`, `mempool-config.ts`

**P5: Barrel Export File is 550 Lines** (MEDIUM)
- `index.ts` re-exports from 20+ files, ~550 lines
- Comments stale (says "11 chains" and "52 DEXes" but system has 15/78)
- Mix of selective and wildcard exports (`export * from './partitions'`)

**P6: Deferred Items Hidden in Comments** (MEDIUM)
- 9 deferred/TODO items scattered across config files (see Section 2)
- No programmatic tracking — requires grep to find
- Some commented-out code blocks are 45+ lines (Balancer V2 TODO in `service-config.ts:399-447`)
- No compile-time or test-time alerts when a deferred item's blocker is resolved

**P7: Mantle/Mode Stub Chains with Unverified Addresses** (HIGH)
- Mode DEXes have sequential hex patterns suggesting placeholders
- Partitions config marks them as stubs but nothing prevents them from being used
- No `verified: boolean` field on addresses — only comments

### 1.4 Deferred Items Catalog

| # | Location | Item | Status | Blocker |
|---|----------|------|--------|---------|
| D1 | `service-config.ts:399-447` | Balancer V2 flash loans on 5 additional chains | DEFERRED | Need to deploy `BalancerV2FlashArbitrage.sol` |
| D2 | `service-config.ts:462-470` | Linea SyncSwap flash loans | DEFERRED | SyncSwap Vault not deployed to Linea |
| D3 | `service-config.ts:474` | Blast flash loan provider | TODO | No lending protocol on Blast verified |
| D4 | `service-config.ts:547` | MultiPathQuoter mainnet deployment | TODO | Contracts not deployed (testnet only) |
| D5 | `dexes/index.ts:592,601` | Mode DEX addresses (supswap, iziswap) | STUB | Addresses unverified via RPC |
| D6 | `addresses.ts:223` | Linea SyncSwap Vault address | TBD | SyncSwap not deployed to Linea |
| D7 | `flash-loan-availability.ts:52` | Morpho flash loans | DEFERRED | No `MorphoFlashArbitrage.sol` contract |
| D8 | `mempool-config.ts:103` | bloXroute on additional chains | TBD | Support not confirmed |
| D9 | `partitions.ts:251` | Mantle/Mode partition assignment | STUB | Unverified factory addresses |

---

## 2. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| **A: Per-Chain Config Modules** | Uniswap Labs, 1inch | + Clear ownership per chain, + Easy to add/remove chains, + Smaller files | - More files to manage, - Cross-chain queries need aggregation | 3-5 days |
| **B: Registry Pattern with Builders** | Aave, Lido, LayerZero | + Centralized registration, + Validation at registration time, + Type-safe builders | - More abstraction, - Learning curve | 5-8 days |
| **C: Protocol Descriptor Objects** | Yearn, Balancer SDK | + Single object per protocol/DEX, + Self-describing, + Easy serialization | - Large object graphs, - May be over-engineered for 78 DEXes | 4-6 days |
| **D: Declarative Config + Code Generation** | ChainLink, Wormhole | + Config as data (JSON/YAML), + CI validation, + Auto-generated types | - Build step complexity, - Harder to debug | 8-12 days |
| **E: Incremental Refactor (Recommended)** | Pragmatic, proven | + Minimal blast radius, + Phased rollout, + Retains existing strengths | - Doesn't achieve "ideal" architecture, - Some duplication remains temporarily | 5-7 days |

### Why NOT Each Non-Recommended Alternative

- **A (Per-Chain Modules)**: Would create 15+ chain files, each needing DEX, token, flash loan, and bridge sections. Cross-chain queries (e.g., "which chains support Balancer V2?") become expensive aggregations. The current protocol-oriented layout is actually better for the arbitrage use case where you think protocol-first.

- **B (Registry Pattern)**: Over-abstracted for a system where configuration is largely static. The current `Record<string, ...>` + helper function pattern is simpler and equally type-safe. Registry patterns shine when config changes at runtime — ours doesn't.

- **C (Protocol Descriptors)**: Attractive in theory but creates enormous nested objects. A `ProtocolDescriptor` for Balancer V2 spanning 6 chains with vault addresses, fees, ABIs, availability, and adapters becomes unwieldy. The current flat separation by concern (addresses in one file, ABIs in another) is actually cleaner for this system.

- **D (Code Generation)**: Highest effort, introduces build-step dependency. Overkill for a system with ~15 chains and ~78 DEXes that changes infrequently. Better suited for systems with 100+ integrations that change weekly.

---

## 3. Recommended Solution

**Approach**: **E — Incremental Refactor** with 7 targeted tasks
**Confidence**: HIGH (90%)
**Justification**: The current architecture is fundamentally sound (single source of truth, typed, validated). The problems are organizational, not architectural. Targeted refactoring addresses each pain point without a risky rewrite.

**Expected Impact**:
- Adding a new chain: 5 files -> 3 files (chain descriptor + addresses + availability matrix)
- Adding a new DEX: 1,500-line monolith -> focused per-chain file (~100-200 lines)
- Adding a flash loan provider: 4-5 files -> 2 files (provider descriptor + contract deployment)
- Deferred item tracking: grep-based -> compile-time + test-time alerts
- Address drift risk: 3x duplication -> single source with derived lookups

**ADR Compatibility**: Fully compatible with ADR-002, ADR-003, ADR-005, ADR-018, ADR-020, ADR-038, ADR-040. No conflicts.

---

## 4. Implementation Tasks

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | **Consolidate Flash Loan Provider Config** | 1.5 days | 90% | None | Existing flash-loan tests + new integration test |
| 2 | **Split DEX Config into Per-Chain Files** | 1 day | 95% | None | Existing DEX tests, verify DEXES export unchanged |
| 3 | **Eliminate Address Triple-Duplication** | 1 day | 85% | Task 2 | Address validation tests, typecheck |
| 4 | **Unify Chain Type Definitions** | 0.5 days | 90% | None | Type-check all packages |
| 5 | **Add Verified/Stub Metadata to Config** | 0.5 days | 95% | None | New unit tests for stub filtering |
| 6 | **Deferred Item Tracking System** | 0.5 days | 90% | None | New test file for deferred items |
| 7 | **Clean Up Barrel Exports** | 0.5 days | 95% | Tasks 1-6 | Typecheck + existing tests |

**Total estimated effort: 5.5 days**

### Task 1: Consolidate Flash Loan Provider Config

**Problem**: Flash loan configuration is split across 4-5 files. Adding a new provider requires touching `@arbitrage/types`, `addresses.ts`, `flash-loan-availability.ts`, `service-config.ts`, and `flash-loan-abi.ts`.

**Solution**: Create a unified `flash-loan-providers/` directory with a single-object-per-protocol pattern:

```
shared/config/src/flash-loan-providers/
  index.ts              # Re-exports, getPreferredProtocol, availability helpers
  aave-v3.ts            # Aave V3: addresses, fee, ABI, chains, availability
  balancer-v2.ts        # Balancer V2: addresses, fee, ABI, chains
  pancakeswap-v3.ts     # PancakeSwap V3: addresses, fee, ABI, chains
  syncswap.ts           # SyncSwap: addresses, fee, ABI, chains
  dai-flash-mint.ts     # DssFlash: addresses, fee, ABI, chains
  morpho.ts             # Morpho: addresses, fee, status=DEFERRED
  types.ts              # FlashLoanProviderDescriptor interface
```

Each provider file exports a self-contained descriptor:

```typescript
// flash-loan-providers/aave-v3.ts
import { AAVE_V3_POOLS } from '../addresses';

export const AAVE_V3_PROVIDER: FlashLoanProviderDescriptor = {
  protocol: 'aave_v3',
  feeBps: 9,                    // 0.09%
  addresses: AAVE_V3_POOLS,     // Reference, not copy
  chains: ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism', 'avalanche', 'scroll'],
  abi: FLASH_LOAN_ARBITRAGE_ABI,
  status: 'active',             // 'active' | 'deferred' | 'stub'
  deferredReason: undefined,
};
```

The `index.ts` derives the availability matrix and `FLASH_LOAN_PROVIDERS` map automatically from the descriptors:

```typescript
// flash-loan-providers/index.ts
const ALL_PROVIDERS = [AAVE_V3_PROVIDER, BALANCER_V2_PROVIDER, ...];

// DERIVED: replaces hand-maintained FLASH_LOAN_AVAILABILITY
export const FLASH_LOAN_AVAILABILITY = deriveAvailabilityMatrix(ALL_PROVIDERS);

// DERIVED: replaces hand-maintained FLASH_LOAN_PROVIDERS in service-config.ts
export const FLASH_LOAN_PROVIDERS = deriveProviderMap(ALL_PROVIDERS);
```

**Backward compatibility**: Re-export everything from `flash-loan-availability.ts` and update `service-config.ts` to import from the new location. All existing consumers see no change.

**What this eliminates**:
- `flash-loan-availability.ts` 450-line boolean matrix (derived from provider descriptors)
- `FLASH_LOAN_PROVIDERS` in `service-config.ts` (derived from descriptors)
- Commented-out Balancer V2 TODO block (45 lines) — becomes `status: 'deferred'` on each chain
- Manual synchronization between addresses and availability

### Task 2: Split DEX Config into Per-Chain Files

**Problem**: 78 DEXes in a single 1,500-line file. Finding the right section is tedious.

**Solution**: Split into per-chain files while preserving the single `DEXES` export:

```
shared/config/src/dexes/
  index.ts              # Aggregates all chains, exports DEXES
  chains/
    arbitrum.ts         # 10 DEXes
    bsc.ts              # 8 DEXes
    base.ts             # 8 DEXes
    ethereum.ts         # 5 DEXes
    polygon.ts          # 4 DEXes
    optimism.ts         # 5 DEXes
    avalanche.ts        # 6 DEXes
    fantom.ts           # 4 DEXes
    zksync.ts           # 4 DEXes
    linea.ts            # 3 DEXes
    scroll.ts           # 4 DEXes
    blast.ts            # 4 DEXes
    mantle.ts           # 3 DEXes (stub)
    mode.ts             # 3 DEXes (stub)
    solana.ts           # 7 DEXes
```

The aggregator `index.ts` becomes trivial:

```typescript
// dexes/index.ts
import { ARBITRUM_DEXES } from './chains/arbitrum';
import { BSC_DEXES } from './chains/bsc';
// ...

export const DEXES: Record<string, Dex[]> = {
  arbitrum: ARBITRUM_DEXES,
  bsc: BSC_DEXES,
  // ...
};

export function getEnabledDexes(chain: string): Dex[] {
  return (DEXES[chain] ?? []).filter(d => d.enabled !== false);
}
```

**Benefits**: Each chain file is 50-150 lines. Clear ownership. Easy to see all DEXes for a chain. PRs that add DEXes to one chain don't create merge conflicts with other chains.

### Task 3: Eliminate Address Triple-Duplication

**Problem**: Balancer V2 Vault address `0xBA122...` appears in `addresses.ts`, `dexes/index.ts` (as factoryAddress), and `dex-factories.ts`. If one is wrong, the system silently uses different addresses in different contexts.

**Solution**: DEX entries and factory entries should **reference** addresses from `addresses.ts` rather than inline them.

```typescript
// dexes/chains/arbitrum.ts (AFTER)
import { BALANCER_V2_VAULTS, DEX_ROUTERS } from '../../addresses';

export const ARBITRUM_DEXES: Dex[] = [
  {
    name: 'balancer_v2',
    chain: 'arbitrum',
    factoryAddress: BALANCER_V2_VAULTS.arbitrum,  // Single source
    routerAddress: BALANCER_V2_VAULTS.arbitrum,    // Vault is also router
    feeBps: bps(30),
    enabled: true,
  },
  // ...
];
```

For DEXes where addresses aren't protocol-level (e.g., Camelot, Zyberswap), the inline address stays — those are DEX-specific, not shared across config files.

**What this eliminates**: ~40 inline address literals that duplicate `addresses.ts`. The module-load validation in `dex-factories.ts` (`checkAddressMatchesDexes`) already cross-checks — this makes that validation unnecessary for shared addresses since they're the same reference.

### Task 4: Unify Chain Type Definitions

**Problem**: `ChainId` is defined in `shared/types/src/chains.ts`, `EVMChainId` is defined in both `shared/config/src/addresses.ts` and `contracts/deployments/addresses.ts`, and aliases are defined in 3 places.

**Solution**: Make `shared/types/src/chains.ts` the **sole** source of truth:

```typescript
// shared/types/src/chains.ts (already exists — add missing exports)
export type EVMChainId = Exclude<ChainId, 'solana' | TestnetChainId>;
export type TestnetChainId = 'sepolia' | 'arbitrum-sepolia' | 'base-sepolia' | 'zksync-sepolia' | 'solana-devnet';
```

Then update `addresses.ts` and `contracts/deployments/addresses.ts` to import from `@arbitrage/types`:

```typescript
// shared/config/src/addresses.ts (AFTER)
import type { EVMChainId, ChainId, TestnetChainId } from '@arbitrage/types';
export type { EVMChainId, ChainId, TestnetChainId };
// Remove local type definitions
```

For `contracts/deployments/addresses.ts`, replace the local `TestnetChain` / `EVMMainnetChain` / `SupportedChain` types with imports and aliases:

```typescript
// contracts/deployments/addresses.ts (AFTER)
import type { ChainId, EVMChainId } from '@arbitrage/types';
import { CHAIN_ALIASES, normalizeChainId } from '@arbitrage/types';

// Backward compat aliases
export type TestnetChain = TestnetChainId;
export type EVMMainnetChain = EVMChainId;
export type SupportedChain = ChainId;
```

**Chain alias consolidation**: Keep `CHAIN_ALIASES` only in `shared/types/src/chains.ts`. The copies in `contracts/deployments/addresses.ts` and `mempool-config.ts` should import from `@arbitrage/types`.

### Task 5: Add Verified/Stub Metadata to Config

**Problem**: Mantle/Mode DEXes have unverified addresses (potentially placeholders), but nothing in the data model distinguishes them from verified addresses. Only comments indicate this.

**Solution**: Add a `verified` field to the `Dex` interface and a `status` field to `FactoryConfig`:

```typescript
// shared/types (add to Dex interface)
interface Dex {
  // ... existing fields ...
  verified?: boolean;    // Default: true. Set to false for unverified/stub addresses.
}

// shared/config/src/dex-factories.ts (add to FactoryConfig)
interface FactoryConfig {
  // ... existing fields ...
  verified?: boolean;    // Default: true.
}
```

Then mark Mantle/Mode DEXes explicitly:

```typescript
// dexes/chains/mode.ts
export const MODE_DEXES: Dex[] = [
  {
    name: 'supswap',
    chain: 'mode',
    factoryAddress: '0x...',
    routerAddress: '0x...',
    feeBps: bps(30),
    verified: false,  // TODO: Verify on Mode mainnet via RPC
  },
];
```

Add a helper and test:

```typescript
export function getVerifiedDexes(chain: string): Dex[] {
  return (DEXES[chain] ?? []).filter(d => d.enabled !== false && d.verified !== false);
}
```

**New test**: `config/__tests__/unit/stub-verification.test.ts` — asserts that unverified DEXes are NOT returned by `getVerifiedDexes()`, and that the execution engine uses `getVerifiedDexes()` instead of raw `DEXES[chain]`.

### Task 6: Deferred Item Tracking System

**Problem**: 9 deferred items are hidden in comments. There's no way to know when a blocker is resolved without manually checking each comment.

**Solution**: Create a machine-readable deferred items registry with automated test checks:

```typescript
// shared/config/src/deferred-items.ts

export interface DeferredItem {
  id: string;
  description: string;
  status: 'deferred' | 'stub' | 'todo';
  blocker: string;
  files: string[];           // Files that need updating when resolved
  /** Optional: function that returns true when the blocker is resolved */
  isResolved?: () => boolean;
}

export const DEFERRED_ITEMS: DeferredItem[] = [
  {
    id: 'D1-BALANCER-V2-MULTI-CHAIN',
    description: 'Deploy BalancerV2FlashArbitrage.sol to ethereum, polygon, arbitrum, optimism, base',
    status: 'deferred',
    blocker: 'Contract deployment required',
    files: ['service-config.ts', 'flash-loan-providers/balancer-v2.ts'],
  },
  {
    id: 'D2-LINEA-SYNCSWAP',
    description: 'Linea SyncSwap flash loans via Vault (EIP-3156)',
    status: 'deferred',
    blocker: 'SyncSwap Vault not deployed to Linea mainnet',
    files: ['addresses.ts', 'flash-loan-providers/syncswap.ts'],
    isResolved: () => !!SYNCSWAP_VAULTS['linea'],
  },
  {
    id: 'D3-BLAST-FLASH-LOAN',
    description: 'Blast-native flash loan provider (Juice Finance or Orbit Protocol)',
    status: 'todo',
    blocker: 'No lending protocol on Blast verified',
    files: ['flash-loan-providers/', 'addresses.ts'],
  },
  {
    id: 'D4-MULTI-PATH-QUOTER-MAINNET',
    description: 'Deploy MultiPathQuoter to mainnet chains',
    status: 'todo',
    blocker: 'Contracts not deployed (testnet only)',
    files: ['service-config.ts'],
    isResolved: () => Object.keys(MULTI_PATH_QUOTER_ADDRESSES).some(
      k => !['sepolia', 'arbitrumSepolia'].includes(k) && MULTI_PATH_QUOTER_ADDRESSES[k] !== ''
    ),
  },
  {
    id: 'D5-MODE-DEX-VERIFICATION',
    description: 'Verify Mode DEX addresses (supswap, iziswap) via RPC',
    status: 'stub',
    blocker: 'Addresses have sequential hex patterns — likely placeholders',
    files: ['dexes/chains/mode.ts'],
  },
  {
    id: 'D7-MORPHO-FLASH-ARBITRAGE',
    description: 'Implement MorphoFlashArbitrage.sol contract',
    status: 'deferred',
    blocker: 'No MorphoFlashArbitrage.sol contract yet',
    files: ['contracts/src/', 'flash-loan-providers/morpho.ts'],
  },
  {
    id: 'D9-MANTLE-MODE-PARTITIONS',
    description: 'Finalize Mantle/Mode partition assignment',
    status: 'stub',
    blocker: 'Unverified factory addresses',
    files: ['partitions.ts', 'dexes/chains/mantle.ts', 'dexes/chains/mode.ts'],
  },
];

/** Get all unresolved deferred items */
export function getUnresolvedDeferredItems(): DeferredItem[] {
  return DEFERRED_ITEMS.filter(item => !item.isResolved?.());
}

/** Get all items that were deferred but are now resolvable */
export function getNewlyResolvableItems(): DeferredItem[] {
  return DEFERRED_ITEMS.filter(item => item.isResolved?.() === true);
}
```

**New test**: `config/__tests__/unit/deferred-items.test.ts`:

```typescript
describe('Deferred Items', () => {
  it('should have no silently resolved items', () => {
    const resolved = getNewlyResolvableItems();
    if (resolved.length > 0) {
      const names = resolved.map(i => i.id).join(', ');
      // This test INTENTIONALLY fails when a blocker is resolved
      // to remind the developer to complete the deferred work
      throw new Error(
        `Deferred items now resolvable: ${names}. ` +
        `Complete the deferred work and remove from DEFERRED_ITEMS.`
      );
    }
  });

  it('should have valid file references', () => {
    for (const item of DEFERRED_ITEMS) {
      expect(item.files.length).toBeGreaterThan(0);
      expect(item.blocker).not.toBe('');
    }
  });
});
```

This converts invisible comments into **failing tests** when blockers are resolved.

### Task 7: Clean Up Barrel Exports

**Problem**: `index.ts` is 550 lines with stale comments and inconsistent export styles.

**Solution**:
- Update stale comments ("11 chains" -> "15 chains", "52 DEXes" -> "78 DEXes")
- Group exports by the new file structure
- Remove the `export *` wildcard for partitions (make explicit)
- Add new exports for flash-loan-providers and deferred-items modules
- ~30 minutes of mechanical work after Tasks 1-6 are complete

---

## 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Import path breakage** after file moves | MEDIUM | HIGH | Run `npm run typecheck` after each task. Use find-and-replace for import paths. Keep old files as re-export shims temporarily. |
| **Circular dependency** when addresses.ts imports from flash-loan-providers | LOW | HIGH | Flash-loan-providers imports FROM addresses.ts, not the reverse. Validate with `madge --circular`. |
| **Runtime regression** from derived availability matrix | LOW | HIGH | Snapshot test: compute derived matrix, compare to current hand-written matrix. Must be identical. |
| **Performance regression** if derived lookups add latency | LOW | MEDIUM | All derivation happens at module-load time (computed constants). Zero hot-path impact. |
| **Merge conflict** with in-progress work on other branches | MEDIUM | LOW | Do Tasks 2 and 3 (file splits) in a single commit to minimize conflict window. |

---

## 6. Success Metrics

- [ ] **Files touched to add a new chain**: Current 5-7 -> Target 3 (chain descriptor + addresses + partition) — Verify by dry-run adding a mock chain
- [ ] **Files touched to add a flash loan provider**: Current 4-5 -> Target 2 (provider descriptor + contract) — Verify by dry-run adding a mock provider
- [ ] **DEX monolith size**: Current 1,500 lines -> Target max 200 lines per chain file — Verify with `wc -l`
- [ ] **Address duplication count**: Current ~40 inline duplicates -> Target 0 (all protocol addresses reference `addresses.ts`) — Verify with grep
- [ ] **Deferred item visibility**: Current 0 automated checks -> Target 7+ items with `isResolved` functions — Verify with test count
- [ ] **All existing tests pass**: `npm run test:unit` and `npm run typecheck` green — Non-negotiable gate
- [ ] **Zero hot-path latency change**: All derivation at module-load time — Verify with benchmark

---

## 7. ADR Recommendation

**New ADR Needed?**: Yes
**Title**: ADR-041: Blockchain Configuration Architecture Refactor
**Scope**: Flash loan provider consolidation, per-chain DEX splits, address deduplication, chain type unification, deferred item tracking
**Decision**: Incremental refactor (Approach E) — targeted improvements preserving existing strengths
**Key Rationale**: The current architecture is fundamentally sound. Problems are organizational (file layout, duplication) not architectural (patterns, types). A rewrite would risk regressions in a system with 78 DEXes x 15 chains x 7 flash loan protocols = thousands of configuration combinations.

---

## 8. Execution Order

```
Week 1 (3 days):
  Day 1: Task 4 (chain types) + Task 5 (verified metadata)  [independent, parallelizable]
  Day 2: Task 2 (DEX split) + Task 6 (deferred tracking)    [independent, parallelizable]
  Day 3: Task 3 (address dedup)                              [depends on Task 2]

Week 2 (2.5 days):
  Day 4-5: Task 1 (flash loan consolidation)                 [largest task, depends on Task 4]
  Day 5.5: Task 7 (barrel cleanup)                           [depends on all above]
```

**Verification gates between tasks**: `npm run typecheck && npm run test:unit` after each task completes. No task merges until gate passes.

---

## 9. What This Does NOT Change

To be explicit about scope boundaries:

- **Hot-path code**: No changes to `price-matrix.ts`, `partitioned-detector.ts`, or `execution-pipeline.ts`
- **Runtime behavior**: All changes are at module-load time. The system behaves identically after refactor.
- **Contract code**: No Solidity changes. Smart contracts are unaffected.
- **Redis Streams architecture**: No changes to ADR-002 event processing.
- **Service startup flow**: Same config validation, same fail-fast behavior.
- **External APIs**: No new dependencies, no new network calls.

The refactor is purely organizational — making the existing configuration system cleaner, clearer, and easier to maintain while tracking deferred work programmatically.
