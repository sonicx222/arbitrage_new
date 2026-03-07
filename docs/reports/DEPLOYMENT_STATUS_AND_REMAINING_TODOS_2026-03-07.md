# Deployment Status & Remaining TODOs

**Date:** 2026-03-07
**Based on:** Cross-verification of `registry.json`, `addresses.ts`, `service-config.ts`, `hardhat.config.ts`, `dexes/`, `flash-loan-availability.ts`, `partitions.ts` against `DEPLOYMENT_TESTNET_ASSESSMENT_2026-02-25.md`
**Purpose:** Accurate current state + step-by-step tutorial for all remaining testnet deployments and address registration

---

## 1. Executive Summary

### Progress Since Assessment (2026-02-25)

| Area | Then | Now |
|------|------|-----|
| Deployed contracts | 1 (FlashLoan on arbSepolia) | **7** (3 on sepolia, 3+1 on arbSepolia) |
| Verified contracts | 0 | **5** |
| Blast DEX addresses | All placeholder | **All RPC-verified** |
| Scroll DEX addresses | All placeholder | **All RPC-verified** |
| Scroll flash loans | Config stub | **Aave V3 + SyncSwap Vault verified** |
| Hardhat networks | 10 core + 4 testnets | Same (emerging L2s still missing) |

### What's Left

| Category | Count | Effort |
|----------|-------|--------|
| Testnet contract deployments remaining | 3-5 (depending on blocker resolution) | 1-2 hours |
| Contract verifications needed | 2 | 15 min |
| Data sync fixes (addresses.ts / registry.json) | 3 | 15 min |
| Research tasks (blocked by enterprise network) | 5 | Manual browser research |
| Mainnet deployments (Phase D) | 12+ contracts across 3 chains | After testnet validation |

---

## 2. Current Deployment State (Verified 2026-03-07)

### 2.1 Contracts Deployed

#### sepolia (3 contracts)

| Contract | Address | Verified | In addresses.ts |
|----------|---------|:--------:|:---------------:|
| FlashLoanArbitrage | `0x2f091cc77601C5aE2439A763C4916d9d32e035B6` | Yes | Yes |
| CommitRevealArbitrage | `0xb38498De6C09F110EbC946CaEEd73BA8640f5C65` | Yes | **NO** |
| MultiPathQuoter | `0xE5b26749430ed50917b75689B654a4C5808b23FB` | Yes | Yes |

#### arbitrumSepolia (3 contracts + 1 untracked)

| Contract | Address | Verified | In addresses.ts |
|----------|---------|:--------:|:---------------:|
| FlashLoanArbitrage | `0xE5b26749430ed50917b75689B654a4C5808b23FB` | **NO** | Yes |
| CommitRevealArbitrage | `0x9EA7A39B94E06BaFd034285ae665297427A84337` | Yes | Yes |
| MultiPathQuoter | `0xA99863BAe641bA1Fc375c7AaF921680bb943d588` | Yes | Yes |
| UniswapV3Adapter | `0x1A9838ce19Ae905B4e5941a17891ba180F30F630` | Unknown | In APPROVED_ROUTERS only |

#### All other networks: Zero contracts deployed

baseSepolia, zksync-testnet, polygonAmoy, bscTestnet, and ALL 10+ mainnets have null entries.

### 2.2 Data Sync Issues Found

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | CommitRevealArbitrage on sepolia in registry but NOT in `COMMIT_REVEAL_ARBITRAGE_ADDRESSES` | Code can't find the contract | Add to addresses.ts |
| 2 | UniswapV3Adapter not in registry.json schema | Deployment not tracked centrally | Add schema field or document separately |
| 3 | FlashLoanArbitrage on arbitrumSepolia not verified on block explorer | Can't inspect/debug on explorer | Run verification command |
| 4 | `registry.json._lastUpdated` says "2026-02-10" | Misleading staleness indicator | Update timestamp |

### 2.3 Emerging L2 Status (Updated)

| Chain | DEX Addresses | Flash Loans | Tokens | In Hardhat | In Partition | Status |
|-------|:------------:|:-----------:|:------:|:----------:|:------------:|:------:|
| **Blast** | RPC-verified | None available | WETH, USDB | **NO** | P2 L2-Turbo | Operational (config only) |
| **Scroll** | RPC-verified | Aave V3 + SyncSwap | WETH, USDC, USDT, DAI | **NO** | P2 L2-Turbo | Operational (config only) |
| **Mantle** | Unverified stubs | Unknown | Missing | **NO** | Excluded | Non-functional |
| **Mode** | Unverified stubs | Unknown | Partial | **NO** | Excluded | Non-functional |

---

## 3. Original Checklist Re-Assessment

### Phase A (Config fixes) -- COMPLETE

All items done. A.3 (Ethereum mainnet in Hardhat) intentionally deferred.

### Phase B (Emerging L2 research) -- PARTIALLY DONE

| Item | Status | Detail |
|------|:------:|--------|
| B.1 Blast DEX addresses | DONE | 4 DEXes RPC-verified 2026-02-26 |
| B.2 Scroll DEX addresses | DONE | 4 DEXes + SyncSwap Vault + Aave V3 Pool RPC-verified |
| B.3 Mantle DEX addresses | **OPEN** | 3 DEXes with unverified factory addresses |
| B.4 Mode DEX addresses | **OPEN** | 3 DEXes with unverified factory addresses |
| B.5 Flash loan research | PARTIAL | Done for Blast (none) + Scroll (Aave+SyncSwap). Open for Mantle/Mode |
| B.6 Token addresses | PARTIAL | Done for Blast/Scroll. Open for Mantle/Mode |
| B.7 Update dexes/index.ts | PARTIAL | Done for Blast/Scroll. Open for Mantle/Mode |
| B.8 Add to Hardhat config | **OPEN** | None of the 4 emerging L2s are in hardhat.config.ts |
| B.9 Approved routers | **OPEN** | No emerging L2 routers in APPROVED_ROUTERS |
| B.10 Partition assignment | PARTIAL | Blast/Scroll in P2. Mantle/Mode excluded |

### Phase C (Testnet deployments) -- 5/11 DONE

| Item | Status | Detail |
|------|:------:|--------|
| C.1 FlashLoan -> sepolia | DONE | Deployed + verified |
| C.2 FlashLoan -> baseSepolia | **OPEN** | Blocked: Aave V3 Pool address missing |
| C.3 MultiPathQuoter -> arbSepolia | DONE | Deployed + verified |
| C.4 CommitReveal -> arbSepolia | DONE | Deployed + verified |
| C.5 V3Adapter -> arbSepolia | DONE | Deployed, in APPROVED_ROUTERS |
| C.6 PancakeSwap -> arbSepolia | **OPEN** | Blocked: PancakeSwap V3 Factory missing for testnet |
| C.7 Balancer -> arbSepolia | **OPEN** | Vault may not exist on testnet |
| C.8 SyncSwap -> zksync-testnet | **OPEN** | Blocked: SyncSwap Vault needs verification |
| C.9 Verify ALL contracts | **PARTIAL** | FlashLoan on arbSepolia NOT verified; V3Adapter unknown |
| C.10 Update registry + addresses | **PARTIAL** | CommitReveal sepolia missing from addresses.ts |
| C.11 E2E test (SIMULATION_MODE=false) | **OPEN** | Not attempted |

### Bonus deployments (done but not originally planned)

- CommitRevealArbitrage deployed to **sepolia** (verified)
- MultiPathQuoter deployed to **sepolia** (verified)
- FlashLoanArbitrage deployed to **sepolia** (verified)

---

## 4. Step-by-Step Tutorial: Remaining Work

### Prerequisites (one-time setup)

If you haven't set up the environment, see `docs/guides/testnet-deployment-tutorial.md` Sections 2-4. The short version:

```bash
# 1. Install + build
npm install && npm run build:deps

# 2. Create .env.local with at minimum:
#    DEPLOYER_PRIVATE_KEY=0x...
#    ETHERSCAN_API_KEY=...

# 3. Compile contracts
cd contracts && npx hardhat compile

# 4. Fund deployer on needed testnets (see Section 4 of the tutorial for faucets)
```

---

### Step 1: Fix Data Sync Issues (15 min, no deployment needed)

These are bugs where deployed contracts aren't properly registered in the TypeScript config.

#### 1a. Add CommitRevealArbitrage sepolia to addresses.ts

The contract is deployed at `0xb38498De6C09F110EbC946CaEEd73BA8640f5C65` (in registry.json) but missing from the TypeScript addresses file.

**File:** `contracts/deployments/addresses.ts`
**Find:** `COMMIT_REVEAL_ARBITRAGE_ADDRESSES` (around line 274)
**Change:**
```typescript
export const COMMIT_REVEAL_ARBITRAGE_ADDRESSES: Record<string, string> = {
  // Populated after deployment. See registry.json for deployment status.
  sepolia: '0xb38498De6C09F110EbC946CaEEd73BA8640f5C65',
  arbitrumSepolia: '0x9EA7A39B94E06BaFd034285ae665297427A84337',
};
```

#### 1b. Verify FlashLoanArbitrage on Arbitrum Sepolia block explorer

```bash
cd contracts
npx hardhat verify --network arbitrumSepolia \
  0xE5b26749430ed50917b75689B654a4C5808b23FB \
  "0xBfC91D59fdAA134A4ED45f7B584cAf96D7024b32" \
  "0x330E1aF8aF57C7b5D40F73D54825028fC50Bb748"
```

The first constructor arg is the Aave V3 Pool address for arbitrumSepolia, the second is the deployer/owner address. Check `shared/config/src/addresses.ts` for the exact Aave pool address if the above fails.

After verification succeeds, update registry.json:
```json
"FlashLoanArbitrage_verified": true,
```

#### 1c. Update registry.json timestamp

Change `_lastUpdated` to the current date after any updates.

#### 1d. Rebuild and typecheck

```bash
npm run build:deps
npm run typecheck
```

---

### Step 2: Deploy Remaining Testnet Contracts (Ready Now)

These deployments have NO blockers. You need testnet ETH on the target chains.

#### 2a. BalancerV2FlashArbitrage on Arbitrum Sepolia (MAY FAIL)

The Balancer V2 Vault uses CREATE2 (same address `0xBA12222222228d8Ba445958a75a0704d566BF2C8` on all chains), but it may not actually be deployed on Arbitrum Sepolia.

```bash
cd contracts
npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia
```

**If it succeeds:**
1. Update `contracts/deployments/addresses.ts` -- add to `BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES`:
   ```typescript
   export const BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES: Record<string, string> = {
     arbitrumSepolia: '0x<DEPLOYED_ADDRESS>',
   };
   ```
2. Update `shared/config/src/flash-loan-availability.ts` -- change `balancer_v2: false` to `true` for `arbitrumSepolia`
3. Verify on block explorer:
   ```bash
   npx hardhat verify --network arbitrumSepolia <ADDRESS> \
     "0xBA12222222228d8Ba445958a75a0704d566BF2C8" \
     "0x330E1aF8aF57C7b5D40F73D54825028fC50Bb748"
   ```

**If it fails** with "Vault not found" or revert: Skip -- Balancer V2 hasn't deployed to Arbitrum Sepolia. You'll deploy on mainnet instead.

---

### Step 3: Research to Unblock Remaining Testnet Deployments

These require manual browser research (enterprise network blocks automated lookups).

#### 3a. HIGH PRIORITY: Aave V3 Pool on Base Sepolia

**What to find:** Aave V3 Pool contract address on Base Sepolia testnet

**Where to look:**
- https://docs.aave.com/developers/deployed-contracts/v3-testnet-addresses
- Search for "Base Sepolia" or "Base Goerli" in Aave's deployment docs
- Check https://basescan.org (testnet) for Aave V3 Pool contract

**Also get:**
- At least one DEX router address on Base Sepolia (Uniswap V2/V3)
- WETH, USDC addresses on Base Sepolia

**Files to update after research:**
1. `shared/config/src/addresses.ts` -- add Aave V3 Pool for `baseSepolia`
2. `contracts/deployments/addresses.ts` -- add approved routers and token addresses for `baseSepolia`
3. `shared/config/src/flash-loan-availability.ts` -- add `baseSepolia` entry

**Unblocks:** FlashLoanArbitrage deployment on baseSepolia (Step 4a)

#### 3b. HIGH PRIORITY: SyncSwap Vault on zkSync Sepolia

**What to find:** Verify the staging Vault address `0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8`

**Where to look:**
- https://syncswap.xyz/ docs
- https://explorer.zksync.io/ (Sepolia testnet explorer)
- Search for "SyncSwap Vault" on zkSync Sepolia

**Also get:**
- SyncSwap Router address on zkSync Sepolia
- Token addresses (WETH, USDC) on zkSync Sepolia

**Files to update after research:**
1. `shared/config/src/addresses.ts` -- add to `SYNCSWAP_VAULTS` for `zksync-testnet`
2. `contracts/deployments/addresses.ts` -- add approved routers and tokens for `zksync-testnet`

**Unblocks:** SyncSwapFlashArbitrage deployment on zksync-testnet (Step 4b)

#### 3c. MEDIUM PRIORITY: PancakeSwap V3 Factory on any testnet

**What to find:** PancakeSwap V3 Deployer/Factory address on Arbitrum Sepolia, BSC Testnet, or any testnet

**Where to look:**
- https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts
- Search PancakeSwap V3 deployment addresses

**Files to update:**
1. `shared/config/src/addresses.ts` -- add to `PANCAKESWAP_V3_FACTORIES`

**Unblocks:** PancakeSwapFlashArbitrage deployment (Step 4c)

#### 3d. LOW PRIORITY: Mantle DEX Addresses (3 DEXes)

**What to find:** RPC-verified factory and router addresses for:
- Merchant Moe (LBRouter, LBFactory)
- Agni Finance (SwapRouter, Factory)
- FusionX (Router, Factory)

**Also:** WMNT, WETH, USDC, USDT token addresses; Lendle flash loan availability

**Where to look:** Mantlescan, protocol docs

**Files to update:** `shared/config/src/dexes/chains/mantle.ts`, `shared/config/src/addresses.ts`, `shared/config/src/tokens/index.ts`

#### 3e. LOW PRIORITY: Mode DEX Addresses (3 DEXes)

**What to find:** RPC-verified factory and router addresses for:
- Kim Exchange (SwapRouter, Factory)
- SupSwap (Router, Factory)
- SwapMode (Router, Factory)

**Also:** USDT, MODE token addresses; Ironclad Finance flash loan availability

**Where to look:** Modescan, protocol docs

**Files to update:** `shared/config/src/dexes/chains/mode.ts`, `shared/config/src/addresses.ts`, `shared/config/src/tokens/index.ts`

---

### Step 4: Deploy After Research Unblocks

#### 4a. FlashLoanArbitrage on Base Sepolia (after 3a)

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network baseSepolia
```

After deployment:
1. Add address to `FLASH_LOAN_CONTRACT_ADDRESSES` in `contracts/deployments/addresses.ts`
2. Verify:
   ```bash
   npx hardhat verify --network baseSepolia <ADDRESS> "<AAVE_POOL>" "<DEPLOYER>"
   ```

#### 4b. SyncSwapFlashArbitrage on zkSync Testnet (after 3b)

zkSync requires special compiler settings:

**Mac/Linux:**
```bash
cd contracts
DISABLE_VIA_IR=true npx hardhat run scripts/deploy-syncswap.ts --network zksync-testnet
```

**Windows PowerShell:**
```powershell
cd contracts
$env:DISABLE_VIA_IR="true"
npx hardhat run scripts/deploy-syncswap.ts --network zksync-testnet
```

After deployment:
1. Add address to `SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES` in `contracts/deployments/addresses.ts`
2. Verify on zkSync Explorer (may need different verification process)

#### 4c. PancakeSwapFlashArbitrage on Arbitrum Sepolia (after 3c)

```bash
cd contracts
npx hardhat run scripts/deploy-pancakeswap.ts --network arbitrumSepolia
```

After deployment:
1. Add address to `PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES` in `contracts/deployments/addresses.ts`
2. Verify:
   ```bash
   npx hardhat verify --network arbitrumSepolia <ADDRESS> "<PANCAKESWAP_FACTORY>" "<DEPLOYER>"
   ```

---

### Step 5: Add Emerging L2s to Hardhat Config (after 3d/3e for Mantle/Mode; ready now for Blast/Scroll)

**File:** `contracts/hardhat.config.ts`

Add these network definitions (Blast and Scroll are ready now; Mantle and Mode after research):

```typescript
// === Emerging L2s ===
blast: {
  url: process.env.BLAST_RPC_URL || 'https://rpc.blast.io',
  chainId: 81457,
  accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
},
scroll: {
  url: process.env.SCROLL_RPC_URL || 'https://rpc.scroll.io',
  chainId: 534352,
  accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
},
// Uncomment after Mantle DEX addresses are RPC-verified:
// mantle: {
//   url: process.env.MANTLE_RPC_URL || 'https://rpc.mantle.xyz',
//   chainId: 5000,
//   accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
// },
// Uncomment after Mode DEX addresses are RPC-verified:
// mode: {
//   url: process.env.MODE_RPC_URL || 'https://mainnet.mode.network',
//   chainId: 34443,
//   accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
// },
```

Also add Etherscan-compatible verification config for these chains if the block explorers support it.

After adding:
```bash
npm run typecheck
```

---

### Step 6: Add Approved Routers for Emerging L2s

**File:** `contracts/deployments/addresses.ts`

Add to `APPROVED_ROUTERS`:

```typescript
// Emerging L2s (after Step 5)
blast: [
  // Add V2-compatible router addresses from Blast DEX config
  // e.g., Thruster V2 Router, BladeSwap Router
],
scroll: [
  '0x80e38291e06339d10AAB483C65695D004dBD5C69', // SyncSwap Router (already in config)
  // Add SpaceFi, Ambient routers
],
// mantle: [...],  // After Mantle research
// mode: [...],    // After Mode research
```

Also add to `TOKEN_ADDRESSES` for blast and scroll (currently present for mainnets but not in this file).

---

### Step 7: Post-Deployment Validation

After all deployments complete:

```bash
# 1. Rebuild shared packages
npm run build:deps

# 2. Type check everything
npm run typecheck

# 3. Run contract tests
cd contracts && npx hardhat test

# 4. Run pre-deployment validator
cd .. && npm run validate:deployment

# 5. Verify all deployed contracts are in registry.json
cat contracts/deployments/registry.json | grep -v null | grep "0x"

# 6. Verify addresses.ts matches registry.json
# Manually cross-reference all non-null entries
```

---

### Step 8: End-to-End Testnet Validation (C.11)

Run the system against testnet with real transactions:

```bash
# Start Redis
npm run dev:redis

# Set testnet mode (modify .env.local)
# SIMULATION_MODE=false
# DEFAULT_CHAIN=arbitrumSepolia

# Run minimal services
npm run dev:minimal
```

Monitor for:
- Successful RPC connections to testnet
- Price feed updates from testnet DEXes
- Opportunity detection (may be rare on testnets)
- Contract interaction success (if opportunities found)

---

## 5. Complete Remaining TODO Matrix

### Immediate (No Blockers)

| # | Task | Command / Action | Est. Time |
|---|------|-----------------|-----------|
| 1 | Fix CommitReveal sepolia in addresses.ts | Edit `addresses.ts` line 274 | 2 min |
| 2 | Verify FlashLoan on arbSepolia | `npx hardhat verify --network arbitrumSepolia ...` | 5 min |
| 3 | Update registry.json timestamp | Edit `_lastUpdated` | 1 min |
| 4 | Try BalancerV2 on arbSepolia | `npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia` | 10 min |
| 5 | Add Blast/Scroll to hardhat.config.ts | Edit hardhat.config.ts | 10 min |
| 6 | Rebuild + typecheck | `npm run build:deps && npm run typecheck` | 5 min |

### After Research (Blocked)

| # | Task | Blocker | Priority |
|---|------|---------|----------|
| 7 | Deploy FlashLoan to baseSepolia | 3a: Aave V3 Pool address | HIGH |
| 8 | Deploy SyncSwap to zksync-testnet | 3b: SyncSwap Vault verification | HIGH |
| 9 | Deploy PancakeSwap to arbSepolia | 3c: PancakeSwap V3 Factory | MEDIUM |
| 10 | Add Mantle to Hardhat + dex config | 3d: RPC-verify factory addresses | LOW |
| 11 | Add Mode to Hardhat + dex config | 3e: RPC-verify factory addresses | LOW |
| 12 | Add approved routers for Blast/Scroll | Needs router address curation | MEDIUM |
| 13 | E2E testnet validation | All above complete | LOW |

### Mainnet (Phase D -- after testnet validation)

| # | Contract | Chain | Depends On |
|---|----------|-------|-----------|
| 14 | FlashLoanArbitrage | Arbitrum | Testnet validation |
| 15 | UniswapV3Adapter | Arbitrum | #14 deployed |
| 16 | BalancerV2FlashArbitrage | Arbitrum | #14 deployed |
| 17 | MultiPathQuoter | Arbitrum | None |
| 18 | CommitRevealArbitrage | Arbitrum | None |
| 19-23 | Same 5 contracts | Base | #14-18 validated |
| 24-28 | Same 5 contracts | Optimism | #14-18 validated |

See `docs/guides/mainnet-deployment-runbook.md` for the full mainnet procedure.

---

## 6. Contract-to-Chain Deployment Matrix (Target State)

### Testnets

| Contract | sepolia | arbSepolia | baseSepolia | zksync-testnet |
|----------|:-------:|:----------:|:-----------:|:--------------:|
| FlashLoanArbitrage | DONE | DONE | **TODO** | N/A |
| BalancerV2FlashArbitrage | - | **TODO** | - | N/A |
| PancakeSwapFlashArbitrage | - | **TODO** | - | N/A |
| SyncSwapFlashArbitrage | N/A | N/A | N/A | **TODO** |
| CommitRevealArbitrage | DONE | DONE | - | - |
| MultiPathQuoter | DONE | DONE | - | - |
| UniswapV3Adapter | - | DONE | - | N/A |

### Mainnets (Phase D/E Target -- no contracts deployed yet)

| Contract | Arb | Base | OP | Poly | BSC | Avax | FTM | zkSync | Linea | ETH |
|----------|:---:|:----:|:--:|:----:|:---:|:----:|:---:|:------:|:-----:|:---:|
| FlashLoan (Aave) | D | D | D | E | - | E | - | - | - | E |
| Balancer V2 | D | D | D | E | - | - | E | - | - | E |
| PancakeSwap V3 | - | - | - | - | E | - | - | E | - | - |
| SyncSwap | - | - | - | - | - | - | - | E | - | - |
| CommitReveal | D | D | D | E | E | E | E | E | E | E |
| MultiPathQuoter | D | D | D | E | E | E | E | E | E | E |
| V3 Adapter | D | D | D | E | E | - | - | - | E | E |

**D** = Phase D (L2 Mainnet, first priority)
**E** = Phase E (Extended chains, after Phase D validated)
**-** = N/A (protocol not on chain or not applicable)

---

## 7. Key Files Reference

| File | What to Update | When |
|------|---------------|------|
| `contracts/deployments/registry.json` | Auto-updated by deploy scripts | After each deployment |
| `contracts/deployments/addresses.ts` | **Manual** -- contract addresses, routers, tokens | After each deployment |
| `shared/config/src/addresses.ts` | Protocol addresses (Aave, Balancer, SyncSwap) | After research |
| `shared/config/src/service-config.ts` | Flash loan providers, MultiPathQuoter | After mainnet deployment |
| `shared/config/src/flash-loan-availability.ts` | Per-chain flash loan support | After research/deployment |
| `shared/config/src/dexes/chains/*.ts` | DEX factory/router addresses | After research |
| `shared/config/src/tokens/index.ts` | Token addresses per chain | After research |
| `contracts/hardhat.config.ts` | Network definitions | When adding new chains |
| `shared/config/src/partitions.ts` | Chain-to-partition assignments | When enabling new chains |

---

## Appendix A: Deployment Commands Quick Reference

```bash
# === From contracts/ directory ===

# FlashLoanArbitrage (Aave V3)
npx hardhat run scripts/deploy.ts --network <chain>

# BalancerV2FlashArbitrage
npx hardhat run scripts/deploy-balancer.ts --network <chain>

# PancakeSwapFlashArbitrage
npx hardhat run scripts/deploy-pancakeswap.ts --network <chain>

# SyncSwapFlashArbitrage (zkSync -- needs DISABLE_VIA_IR=true)
DISABLE_VIA_IR=true npx hardhat run scripts/deploy-syncswap.ts --network <chain>

# CommitRevealArbitrage
npx hardhat run scripts/deploy-commit-reveal.ts --network <chain>

# MultiPathQuoter
npx hardhat run scripts/deploy-multi-path-quoter.ts --network <chain>

# UniswapV3Adapter (needs FLASH_LOAN_CONTRACT_ADDRESS env var)
FLASH_LOAN_CONTRACT_ADDRESS=0x... npx hardhat run scripts/deploy-v3-adapter.ts --network <chain>

# Batch deployment (dry run first!)
BATCH_DRY_RUN=true npx hardhat run scripts/deploy-batch.ts
BATCH_NETWORKS=sepolia,arbitrumSepolia npx hardhat run scripts/deploy-batch.ts

# Contract verification
npx hardhat verify --network <chain> <address> <constructor_arg_1> <constructor_arg_2> ...
```

## Appendix B: Constructor Args Reference

| Contract | Args | Notes |
|----------|------|-------|
| FlashLoanArbitrage | `aavePoolAddress`, `ownerAddress` | Aave V3 Pool from `AAVE_V3_POOLS` |
| BalancerV2FlashArbitrage | `vaultAddress`, `ownerAddress` | Balancer V2 Vault (same on all chains: `0xBA12...C8`) |
| PancakeSwapFlashArbitrage | `factoryAddress`, `ownerAddress` | PancakeSwap V3 Factory from `PANCAKESWAP_V3_FACTORIES` |
| SyncSwapFlashArbitrage | `vaultAddress`, `ownerAddress` | SyncSwap Vault from `SYNCSWAP_VAULTS` |
| CommitRevealArbitrage | `ownerAddress` | Defaults to deployer |
| MultiPathQuoter | (none) | Stateless utility |
| UniswapV3Adapter | `swapRouter`, `quoter`, `ownerAddress`, `feeTier` | Fee tier default: 3000 (0.3%) |
