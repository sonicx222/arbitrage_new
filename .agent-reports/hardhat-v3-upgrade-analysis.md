# Hardhat v3 Upgrade Analysis

**Date**: 2026-02-16
**Current Version**: `hardhat@^2.22.17` (latest HH2: 2.28.6 on `hh2` npm tag)
**Target Version**: `hardhat@^3.1.8` (stable, `latest` npm tag)
**Scope**: `contracts/` subdirectory (10 test files, 17 scripts, 1 config)
**Risk Level**: HIGH (ESM migration + config rewrite + plugin renames)

---

## 1. Current State

### Hardhat Setup

| Component | Current | Notes |
|-----------|---------|-------|
| Hardhat | `^2.22.17` | HH2, CJS |
| Solidity | `0.8.19` | Optimizer 10,000 runs, viaIR enabled |
| Module system | CommonJS | `tsconfig: "module": "commonjs"`, no `"type"` in package.json |
| Toolbox | `@nomicfoundation/hardhat-toolbox@^5.0.0` | Side-effect import |
| Ethers plugin | `@nomicfoundation/hardhat-ethers@^3.0.8` | ethers v6 integration |
| Chai matchers | `@nomicfoundation/hardhat-chai-matchers@^2.0.8` | Custom error + string assertions |
| Network helpers | `@nomicfoundation/hardhat-network-helpers@^1.0.12` | `loadFixture`, `mine`, `impersonateAccount` |
| Verify | `@nomicfoundation/hardhat-verify@^2.0.12` | Etherscan verification |
| TypeChain | `@typechain/hardhat@^9.1.0` + `@typechain/ethers-v6@^0.5.1` | ethers-v6 target |
| Gas reporter | `hardhat-gas-reporter@^1.0.10` | `REPORT_GAS=true` activation |
| Coverage | `solidity-coverage@^0.8.14` | `hardhat coverage` command |
| Chai | `^4.5.0` | CJS |
| Mocha | `^10.0.0` (via toolbox) | Built into HH2 |
| OpenZeppelin | `^4.9.6` | String-based `require()` reverts |

### File Inventory

| Category | Count | Key Files |
|----------|-------|-----------|
| Config | 1 | `hardhat.config.ts` |
| Test files | 10 | `test/*.test.ts` |
| Test helpers | 4 | `test/helpers/*.ts` |
| Deploy scripts | 6 | `scripts/deploy*.ts` |
| Utility scripts | 8 | `scripts/*.ts` |
| Shared libs | 3 | `scripts/lib/*.ts` |
| **Total TS files** | **31** | All need ESM review |

### Usage Patterns Across Codebase

- **`import { ethers } from 'hardhat'`**: 26 files
- **`import { network } from 'hardhat'`**: 10 files
- **`import { run } from 'hardhat'`**: 1 file (`deployment-utils.ts`)
- **`loadFixture` usage**: All 10 test files (189 total fixture calls)
- **`process.env.X` in config**: 30 occurrences
- **TypeChain type imports**: 11 files
- **`SignerWithAddress` import**: 3 test files
- **Revert assertions**: 189 across 10 test files
- **`revertedWithCustomError()`**: Contract custom errors
- **`revertedWith()`**: OZ 4.x string reverts + mock `require()` messages

---

## 2. Breaking Changes (HH2 -> HH3)

### 2.1 CRITICAL: Configuration Format Rewrite

The config format is completely redesigned. Every section changes:

**Old (HH2):**
```typescript
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const config: HardhatUserConfig = {
  solidity: { compilers: [{ version: '0.8.19', settings: { optimizer: { enabled: true, runs: 10000 }, viaIR: true } }] },
  networks: { sepolia: { url: process.env.SEPOLIA_RPC_URL || '...', accounts: process.env.KEY ? [process.env.KEY] : [] } },
  gasReporter: { enabled: process.env.REPORT_GAS === 'true' },
  etherscan: { apiKey: { mainnet: process.env.ETHERSCAN_API_KEY || '' } },
  typechain: { outDir: './typechain-types', target: 'ethers-v6' },
};
export default config;
```

**New (HH3):**
```typescript
import hardhatToolboxPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxPlugin],
  solidity: {
    profiles: {
      default: { version: "0.8.19" },
      production: { version: "0.8.19", settings: { optimizer: { enabled: true, runs: 10000 }, viaIR: true } },
    },
  },
  networks: {
    hardhatNode: { type: "edr-simulated", chainType: "l1" },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
```

**Changes required in `hardhat.config.ts`:**

| Pattern | Count | Change |
|---------|-------|--------|
| `HardhatUserConfig` type | 1 | `defineConfig()` wrapper |
| Side-effect `import '@...'` | 2 | Explicit `plugins: [...]` array |
| `solidity.compilers[]` | 1 | `solidity.profiles.default/production` |
| `process.env.X` | 30 | `configVariable("X")` |
| Implicit `hardhat` network | 1 | Explicit `type: "edr-simulated"` |
| `etherscan: { apiKey }` | 1 | `chainDescriptors` or verify plugin config |
| `gasReporter: {}` | 1 | Removed (use `--gasStats` CLI flag) |
| `typechain: {}` | 1 | Moved to plugin config |
| `forking.blockNumber: number` | 1 | Now `bigint` |

### 2.2 CRITICAL: ESM Requirement

HH3 is a **pure ESM package** (`"type": "module"`). The `contracts/` package is currently CJS.

**Required changes:**
- Add `"type": "module"` to `contracts/package.json`
- Update `tsconfig.json`: `"module": "nodenext"`, `"moduleResolution": "nodenext"`
- Audit all 31 TS files for CJS patterns:
  - `__dirname` -> `import.meta.dirname` (Node 21+) or `path.dirname(fileURLToPath(import.meta.url))`
  - `require()` -> `import`
  - Dynamic `await import()` should work as-is
- `deployment-utils.ts` uses `__dirname` (line 431, 853) -- must be converted

**Risk**: This cascades through all files and is the highest-risk change.

### 2.3 CRITICAL: Plugin Package Renames

Every plugin package is renamed or bumped to a new major version:

| Purpose | HH2 Package | HH3 Package |
|---------|-------------|-------------|
| Toolbox | `@nomicfoundation/hardhat-toolbox@^5` | `@nomicfoundation/hardhat-toolbox-mocha-ethers@^3` |
| Ethers | `@nomicfoundation/hardhat-ethers@^3` | `@nomicfoundation/hardhat-ethers@^4` |
| Chai matchers | `@nomicfoundation/hardhat-chai-matchers@^2` | `@nomicfoundation/hardhat-ethers-chai-matchers@^3` |
| Network helpers | `@nomicfoundation/hardhat-network-helpers@^1` | `@nomicfoundation/hardhat-network-helpers@^3` |
| Verify | `@nomicfoundation/hardhat-verify@^2` | `@nomicfoundation/hardhat-verify@^3` |
| TypeChain | `@typechain/hardhat@^9` + `@typechain/ethers-v6@^0.5` | `@nomicfoundation/hardhat-typechain@^3` |
| Mocha | (built into HH2) | `@nomicfoundation/hardhat-mocha@^3` + `mocha@^11` |
| Chai | `chai@^4` | `chai@^5` |

**Packages to REMOVE:**
- `solidity-coverage@^0.8.14` (built-in `--coverage`)
- `hardhat-gas-reporter@^1.0.10` (built-in `--gasStats`)
- `solc@^0.8.20` (no longer needed)

### 2.4 HIGH: Test Framework Changes

- **Mocha 10 -> 11**: Major version bump, test runner now a separate plugin
- **Chai 4 -> 5**: ESM-only, potential assertion API changes
- **`loadFixture`**: HH3 version adds optional `connection` parameter; existing usage (no arg) should still work
- **`SignerWithAddress` import path**: `@nomicfoundation/hardhat-ethers/signers` may change in v4
- **Chai matchers renamed**: `hardhat-chai-matchers` -> `hardhat-ethers-chai-matchers`

**Impact on 189 revert assertions**: The `.revertedWith()` and `.revertedWithCustomError()` APIs are expected to remain compatible in the renamed package, but must be verified.

### 2.5 HIGH: Network Configuration Changes

| Change | Impact |
|--------|--------|
| Network `type` field mandatory | All 7 network configs need `type: "http"` or `type: "edr-simulated"` |
| `chainType` required | All networks need `"l1"`, `"op"`, or `"generic"` |
| No implicit `hardhat` network | Must explicitly define EDR network |
| `configVariable()` for URLs | All `process.env.X` patterns replaced |
| `forking.blockNumber` is `bigint` | `parseInt()` -> `BigInt()` conversion |
| Default hardfork is Osaka | Was Shanghai/Cancun in HH2 |

### 2.6 MEDIUM: Deployment Script Changes

- `run('verify:verify', ...)` in `deployment-utils.ts` -- HH3 uses `hre.tasks` API
- `{ ethers, network, run } from 'hardhat'` -- named exports may change
- `__dirname` usage in `deployment-utils.ts` (2 locations) -- breaks in ESM
- `SignerWithAddress` import path may change

### 2.7 NOT AFFECTED

- **Solidity contracts (.sol files)**: No changes needed
- **OpenZeppelin 4.9.6**: Fully compatible with HH3
- **ethers v6 API**: Unchanged (ethers is independent of Hardhat)
- **Mock contracts**: No changes needed

---

## 3. New Features Gained

| Feature | Value | Description |
|---------|-------|-------------|
| **Solidity tests (Forge-style)** | HIGH | Write fuzz tests and invariant tests directly in Solidity |
| **Built-in coverage** | MEDIUM | `--coverage` flag, no plugin needed |
| **Built-in gas stats** | MEDIUM | `--gasStats` flag, no plugin needed |
| **`configVariable()`** | MEDIUM | Cleaner secret management, runtime resolution |
| **Compilation profiles** | MEDIUM | Separate dev/production optimizer settings without env vars |
| **Keystore plugin** | LOW | Encrypted key storage alternative to `.env` files |
| **`node:test` runner** | LOW | Native Node.js test runner support |
| **Osaka hardfork** | LOW | Future EVM opcode support |
| **Network server API** | LOW | `hre.network.createServer()` for programmatic node spawning |

---

## 4. Approach Comparison

### Option A: Full Migration Now

**Score: 2.7/5.0**

| Criteria | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Impact | 40% | 3 | 1.20 |
| Effort | 30% | 2 | 0.60 |
| Risk | 20% | 2 | 0.40 |
| Compatibility | 10% | 5 | 0.50 |

- (+) Latest features, future-proof, cleaner config
- (+) Access to Solidity fuzz/invariant testing
- (-) High risk: 31 files touched, ESM migration, plugin renames
- (-) Blocks other development work during migration
- (-) No immediate need -- HH2 works fine for current requirements

### Option B: Stay on HH2 Indefinitely

**Score: 3.0/5.0**

| Criteria | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Impact | 40% | 1 | 0.40 |
| Effort | 30% | 5 | 1.50 |
| Risk | 20% | 5 | 1.00 |
| Compatibility | 10% | 1 | 0.10 |

- (+) Zero risk, zero effort
- (+) HH2 maintained on `hh2` npm tag
- (-) No new features
- (-) `npm install hardhat` now defaults to v3 (accidental upgrade risk)
- (-) Will eventually need migration as ecosystem moves to v3

### Option C: Pin HH2 + Planned Phased Migration (RECOMMENDED)

**Score: 3.9/5.0**

| Criteria | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Impact | 40% | 4 | 1.60 |
| Effort | 30% | 4 | 1.20 |
| Risk | 20% | 4 | 0.80 |
| Compatibility | 10% | 3 | 0.30 |

- (+) Zero immediate risk -- pin prevents accidental upgrade
- (+) Structured migration plan ready when needed
- (+) Each phase is testable independently
- (+) Can abort at any phase if blockers found
- (-) Requires version pinning discipline
- (-) Intermediate states during migration need careful testing

### Option D: Big-Bang Migration on a Branch

**Score: 3.2/5.0**

| Criteria | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Impact | 40% | 4 | 1.60 |
| Effort | 30% | 3 | 0.90 |
| Risk | 20% | 2 | 0.40 |
| Compatibility | 10% | 3 | 0.30 |

- (+) Clean cutover, no intermediate states
- (+) All changes reviewed in one PR
- (-) Large PR, hard to review
- (-) All-or-nothing: must fix everything before merging
- (-) High risk of unexpected interactions between changes

---

## 5. Recommendation

### Approach: Pin HH2 Now + Phased Migration When Triggered

**Confidence**: HIGH (85%)

**Immediate action**: Pin HH2 versions in `contracts/package.json` to prevent accidental v3 installation:

```json
"hardhat": "~2.28.6",
"@nomicfoundation/hardhat-toolbox": "~5.0.0",
"@nomicfoundation/hardhat-ethers": "~3.0.8",
"@nomicfoundation/hardhat-chai-matchers": "~2.0.8",
"@nomicfoundation/hardhat-network-helpers": "~1.0.12",
"@nomicfoundation/hardhat-verify": "~2.0.12"
```

**Migration triggers** (migrate when any of these occur):
1. Need Solidity fuzz/invariant testing
2. Upgrade to Solidity 0.8.28+ requiring new compiler features
3. HH2 `hh2` tag stops receiving security patches
4. A required plugin becomes HH3-only
5. Team decides to adopt ESM across the monorepo

**Why NOT other approaches:**
- **Full migration now**: No blocking need for HH3 features. The ESM migration risk is high and would block other development.
- **Stay indefinitely**: `npm install hardhat` now defaults to v3, creating accidental upgrade risk. Pinning is minimal effort.
- **Big-bang branch**: Large, hard-to-review PR with high interaction risk between ESM migration + config rewrite + plugin updates.

---

## 6. Phased Migration Plan (When Triggered)

### Phase 1: Pin & Prepare

**Scope**: Pin HH2 versions, audit ESM readiness, document all `process.env` usage

| Task | Details |
|------|---------|
| Pin package versions | Use `~` (patch only) for all Hardhat packages |
| Audit `__dirname` usage | `deployment-utils.ts` lines 431, 853 |
| Audit `require()` calls | Check all 31 TS files |
| Document `process.env` in config | 30 occurrences to convert to `configVariable()` |
| Create migration branch | Isolated from main development |

**Test**: Run full test suite, verify no regressions.

### Phase 2: ESM Migration

**Scope**: Convert `contracts/` package from CJS to ESM

| Task | Details |
|------|---------|
| Add `"type": "module"` | `contracts/package.json` |
| Update tsconfig | `"module": "nodenext"`, `"moduleResolution": "nodenext"` |
| Fix `__dirname` | Convert to `import.meta.dirname` or `fileURLToPath` |
| Fix any `require()` | Convert to `import` |
| Test dynamic imports | `deployment-utils.ts` uses `await import()` |

**Test**: `npx hardhat compile && npx hardhat test` under ESM.

### Phase 3: Config Rewrite

**Scope**: Rewrite `hardhat.config.ts` to HH3 format

| Task | Details |
|------|---------|
| Install `hardhat@^3.1.8` | Replace HH2 |
| Adopt `defineConfig()` | Replace `HardhatUserConfig` |
| Convert to `configVariable()` | Replace 30 `process.env` occurrences |
| Explicit `plugins: [...]` | Replace side-effect imports |
| Solidity profiles | Replace `compilers[]` with `profiles` |
| Network `type` fields | Add `"edr-simulated"` / `"http"` to all 7 networks |
| Remove `etherscan` block | Replace with `chainDescriptors` or verify plugin config |
| Remove `gasReporter` block | Use `--gasStats` flag |
| Remove `typechain` block | Move to plugin config |
| Fix `forking.blockNumber` | `parseInt()` -> `BigInt()` |

**Test**: `npx hardhat compile`, run 1 test file to verify basic functionality.

### Phase 4: Plugin Update

**Scope**: Update all plugin packages to HH3 versions

| Current Package | New Package |
|-----------------|-------------|
| `@nomicfoundation/hardhat-toolbox@^5` | `@nomicfoundation/hardhat-toolbox-mocha-ethers@^3` |
| `@nomicfoundation/hardhat-ethers@^3` | `@nomicfoundation/hardhat-ethers@^4` |
| `@nomicfoundation/hardhat-chai-matchers@^2` | `@nomicfoundation/hardhat-ethers-chai-matchers@^3` |
| `@nomicfoundation/hardhat-network-helpers@^1` | `@nomicfoundation/hardhat-network-helpers@^3` |
| `@nomicfoundation/hardhat-verify@^2` | `@nomicfoundation/hardhat-verify@^3` |
| `@typechain/hardhat@^9` | `@nomicfoundation/hardhat-typechain@^3` |
| (built-in) | `@nomicfoundation/hardhat-mocha@^3` + `mocha@^11` |
| `chai@^4` | `chai@^5` |

**Test**: Run full test suite.

### Phase 5: Test Framework Verification

**Scope**: Verify all 189 assertions work with Chai 5 + renamed chai-matchers

| Task | Details |
|------|---------|
| Verify `revertedWithCustomError()` | Used for contract custom errors |
| Verify `revertedWith()` | Used for OZ 4.x string reverts |
| Verify `loadFixture` | Check optional `connection` parameter compatibility |
| Verify `SignerWithAddress` | Check import path in hardhat-ethers v4 |
| Verify TypeChain types | Regenerate and check all 11 importing files |
| Run fork tests | `FORK_ENABLED=true npx hardhat test test/FlashLoanArbitrage.fork.test.ts` |

**Test**: Full test suite with all 10 test files passing.

### Phase 6: Script Update

**Scope**: Update deployment scripts for HH3 HRE changes

| Task | Details |
|------|---------|
| Update `run('verify:verify')` | Check HH3 task API in `deployment-utils.ts` |
| Verify named exports | `{ ethers, network, run } from 'hardhat'` in all 17 scripts |
| Test deploy to localhost | Run `npx hardhat run scripts/deploy.ts --network localhost` |
| Test all 6 deploy scripts | Verify each works on local network |

**Test**: Deploy all 6 contract types to localhost.

### Phase 7: Cleanup

**Scope**: Remove deprecated packages, adopt built-in features

| Task | Details |
|------|---------|
| Remove `solidity-coverage` | Use `--coverage` flag |
| Remove `hardhat-gas-reporter` | Use `--gasStats` flag |
| Remove `solc` | No longer needed |
| Remove `@typechain/ethers-v6` | Bundled in `@nomicfoundation/hardhat-typechain` |
| Update npm scripts | `"test:coverage": "hardhat test --coverage"` |
| Update CI/CD | Replace `REPORT_GAS=true` with `--gasStats` |

**Test**: Full verification pass (compile, test, coverage, gas stats).

---

## 7. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Accidental HH3 install via `npm install`** | HIGH | MEDIUM | Pin `"hardhat": "~2.28.6"` immediately |
| **ESM migration breaks `__dirname` in deployment-utils** | HIGH | MEDIUM | Convert to `import.meta.dirname` (Node 21+), test on Node 22 |
| **Chai 5 breaks assertion behavior** | LOW | HIGH | Chai 5 is mostly backward-compatible; run full suite; fallback to Chai 4 if needed |
| **TypeChain v3 generates incompatible types** | LOW | MEDIUM | Regenerate types, verify 11 importing files compile |
| **`loadFixture` API change breaks test isolation** | LOW | HIGH | Existing no-arg usage should work; optional `connection` param is additive |
| **`run('verify:verify')` breaks in HH3** | MEDIUM | LOW | Only affects deployment verification; can fix post-migration |
| **Mocha 11 changes test behavior** | LOW | MEDIUM | Mocha 11 is largely backward-compatible; watch for timeout changes |
| **`configVariable()` doesn't support conditional logic** | MEDIUM | MEDIUM | Current config uses `process.env.X ? ... : ...` patterns; may need `configVariable("X").get()` with fallback |
| **OpenZeppelin 4.9.6 string reverts change** | NONE | N/A | OZ version is independent of Hardhat version |

---

## 8. ADR Recommendation

**New ADR Needed?**: Yes, when migration begins.
**Title**: ADR-028: Hardhat 3 Migration Strategy
**Content should cover**:
- Decision to migrate (trigger event)
- Phased migration plan (7 phases above)
- ESM migration strategy for `contracts/` package
- Plugin mapping (HH2 -> HH3)
- Rollback strategy (keep HH2 pinned on separate branch)
- Success criteria (all tests pass, all deploys work)

---

## 9. Appendix: Files Requiring Changes

### Config (Full Rewrite)
- `contracts/hardhat.config.ts`

### Package Manifests
- `contracts/package.json` (dependencies, scripts)
- `contracts/tsconfig.json` (module system)

### Test Files (Import Path Updates)
- `contracts/test/FlashLoanArbitrage.test.ts`
- `contracts/test/FlashLoanArbitrage.fork.test.ts`
- `contracts/test/BalancerV2FlashArbitrage.test.ts`
- `contracts/test/PancakeSwapFlashArbitrage.test.ts`
- `contracts/test/SyncSwapFlashArbitrage.test.ts`
- `contracts/test/CommitRevealArbitrage.test.ts`
- `contracts/test/MultiPathQuoter.test.ts`
- `contracts/test/InterfaceCompliance.test.ts`
- `contracts/test/AaveInterfaceCompliance.test.ts`
- `contracts/test/PancakeSwapInterfaceCompliance.test.ts`

### Test Helpers (Import Path Updates)
- `contracts/test/helpers/common-setup.ts`
- `contracts/test/helpers/exchange-rates.ts`
- `contracts/test/helpers/swap-paths.ts`
- `contracts/test/helpers/index.ts`

### Deployment Scripts (HRE + ESM Changes)
- `contracts/scripts/lib/deployment-utils.ts` (CRITICAL: `__dirname`, `run()`, `ethers`)
- `contracts/scripts/deploy.ts`
- `contracts/scripts/deploy-balancer.ts`
- `contracts/scripts/deploy-pancakeswap.ts`
- `contracts/scripts/deploy-syncswap.ts`
- `contracts/scripts/deploy-commit-reveal.ts`
- `contracts/scripts/deploy-multi-path-quoter.ts`

### Utility Scripts (ESM + Import Updates)
- `contracts/scripts/check-balance.ts`
- `contracts/scripts/toggle-syncswap-pause.ts`
- `contracts/scripts/validate-addresses.ts`
- `contracts/scripts/validate-router-config.ts`
- `contracts/scripts/discover-pancakeswap-pools.ts`
- `contracts/scripts/lib/pancakeswap-utils.ts`
- `contracts/scripts/generate-addresses.ts`
- `contracts/scripts/update-balancer-config.ts`
- `contracts/scripts/verify-interface-docs.ts`

### NOT Affected
- All `.sol` files (Solidity contracts, mocks, interfaces)
- `@openzeppelin/contracts@^4.9.6`
- `contracts/deployments/` (JSON data files)
