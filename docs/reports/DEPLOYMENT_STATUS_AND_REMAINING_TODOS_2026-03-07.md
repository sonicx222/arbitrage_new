# Deployment Status & Remaining TODOs

**Date:** 2026-03-07
**Last Updated:** 2026-03-08 (zkSync verification + runtime validation)
**Based on:** Cross-verification of `registry.json`, `addresses.ts`, `service-config.ts`, `hardhat.config.ts`, `dexes/`, `flash-loan-availability.ts`, `partitions.ts` against `DEPLOYMENT_TESTNET_ASSESSMENT_2026-02-25.md`
**Purpose:** Accurate current state + step-by-step tutorial for all remaining testnet deployments and address registration

---

## 1. Executive Summary

### Progress Since Assessment (2026-02-25)

| Area | Then | Now |
|------|------|-----|
| Deployed contracts | 1 (FlashLoan on arbSepolia) | **10** (3 on sepolia, 5 on arbSepolia, 1 on baseSepolia, 1 on zksync-testnet) |
| Verified contracts | 0 | **10** (all deployed contracts verified, including zksync-testnet SyncSwap) |
| Blast DEX addresses | All placeholder | **All RPC-verified** |
| Scroll DEX addresses | All placeholder | **All RPC-verified** |
| Mantle DEX addresses | Unverified stubs | **All RPC-verified** |
| Mode DEX addresses | Unverified stubs | **All RPC-verified** |
| Scroll flash loans | Config stub | **Aave V3 + SyncSwap Vault verified** |
| Hardhat networks | 10 core + 4 testnets | **Blast + Scroll + Mantle + Mode added** |

### What's Left

| Category | Count | Effort |
|----------|-------|--------|
| Testnet contract deployments remaining | 0 (Balancer unavailable on arbSepolia testnet; defer to mainnet) | 0 min |
| Contract verifications needed | 0 | 0 min |
| Data sync fixes (addresses.ts / registry.json) | 0 | 0 min |
| Research tasks | 0 | 0 min |
| Mainnet deployments (Phase D) | 12+ contracts across 3 chains | After testnet validation |

---

## 2. Current Deployment State (Verified 2026-03-08)

### 2.1 Contracts Deployed

#### sepolia (3 contracts)

| Contract | Address | Verified | In addresses.ts |
|----------|---------|:--------:|:---------------:|
| FlashLoanArbitrage | `0x2f091cc77601C5aE2439A763C4916d9d32e035B6` | Yes | Yes |
| CommitRevealArbitrage | `0xb38498De6C09F110EbC946CaEEd73BA8640f5C65` | Yes | Yes |
| MultiPathQuoter | `0xE5b26749430ed50917b75689B654a4C5808b23FB` | Yes | Yes |

#### arbitrumSepolia (5 contracts)

| Contract | Address | Verified | In addresses.ts |
|----------|---------|:--------:|:---------------:|
| FlashLoanArbitrage | `0xE5b26749430ed50917b75689B654a4C5808b23FB` | Yes | Yes |
| CommitRevealArbitrage | `0x9EA7A39B94E06BaFd034285ae665297427A84337` | Yes | Yes |
| MultiPathQuoter | `0xA99863BAe641bA1Fc375c7AaF921680bb943d588` | Yes | Yes |
| UniswapV3Adapter | `0x1A9838ce19Ae905B4e5941a17891ba180F30F630` | Yes | In APPROVED_ROUTERS only |
| PancakeSwapFlashArbitrage | `0x7C5bf33311D9ACA91d1a11388888A4881c0d744D` | Yes | Yes |

#### baseSepolia (1 contract)

| Contract | Address | Verified | In addresses.ts |
|----------|---------|:--------:|:---------------:|
| FlashLoanArbitrage | `0x2f091cc77601C5aE2439A763C4916d9d32e035B6` | Yes | Yes |

#### zksync-testnet (1 contract)

| Contract | Address | Verified | In addresses.ts |
|----------|---------|:--------:|:---------------:|
| SyncSwapFlashArbitrage | `0x2f091cc77601C5aE2439A763C4916d9d32e035B6` | Yes (verified 2026-03-08) | Yes |

#### Remaining networks with zero contracts deployed

polygonAmoy, bscTestnet, and ALL 10+ mainnets (except prior arbSepolia/baseSepolia entries above) still have null entries.

### 2.2 Data Sync Issues Found

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | CommitRevealArbitrage on sepolia missing in `COMMIT_REVEAL_ARBITRAGE_ADDRESSES` | Resolved 2026-03-08 | Completed |
| 2 | UniswapV3Adapter verification unknown | Resolved 2026-03-08 | Completed |
| 3 | FlashLoanArbitrage on arbitrumSepolia not verified | Resolved 2026-03-08 | Completed |
| 4 | `registry.json._lastUpdated` stale | Resolved 2026-03-08 | Completed |

### 2.3 Emerging L2 Status (Updated)

| Chain | DEX Addresses | Flash Loans | Tokens | In Hardhat | In Partition | Status |
|-------|:------------:|:-----------:|:------:|:----------:|:------------:|:------:|
| **Blast** | RPC-verified | None available | WETH, USDB | Yes | P2 L2-Turbo | Operational (config only) |
| **Scroll** | RPC-verified | Aave V3 + SyncSwap | WETH, USDC, USDT, DAI | Yes | P2 L2-Turbo | Operational (config only) |
| **Mantle** | RPC-verified (MerchantMoe, Agni V2, FusionX) | Aave V3 Pool verified | WMNT, USDC, USDT | Yes | P2 L2-Turbo | Operational (config only) |
| **Mode** | RPC-verified (Kim, SupSwap, SwapMode) | Balancer-style vault detected; Aave V3 unavailable | WETH, USDC, USDT, MODE | Yes | P2 L2-Turbo | Operational (config only) |

---

## 3. Original Checklist Re-Assessment

### Phase A (Config fixes) -- COMPLETE

All items done. A.3 (Ethereum mainnet in Hardhat) intentionally deferred.

### Phase B (Emerging L2 research) -- COMPLETE

| Item | Status | Detail |
|------|:------:|--------|
| B.1 Blast DEX addresses | DONE | 4 DEXes RPC-verified 2026-02-26 |
| B.2 Scroll DEX addresses | DONE | 4 DEXes + SyncSwap Vault + Aave V3 Pool RPC-verified |
| B.3 Mantle DEX addresses | DONE | Merchant Moe + Agni V2 + FusionX RPC-verified 2026-03-08 |
| B.4 Mode DEX addresses | DONE | Kim + SupSwap + SwapMode RPC-verified 2026-03-08 |
| B.5 Flash loan research | DONE | Blast/Scroll + Mantle Aave V3 + Mode Balancer-style vault validated |
| B.6 Token addresses | DONE | Blast/Scroll/Mantle/Mode token sets validated and updated |
| B.7 Update dexes/index.ts | DONE | Mantle/Mode DEX configs updated and verified=true |
| B.8 Add to Hardhat config | DONE | Blast/Scroll/Mantle/Mode networks configured |
| B.9 Approved routers | DONE | Blast/Scroll/Mantle/Mode approved routers + token addresses added |
| B.10 Partition assignment | DONE | Mantle + Mode moved into P2 L2-Turbo |

### Phase C (Testnet deployments) -- 10/11 DONE

| Item | Status | Detail |
|------|:------:|--------|
| C.1 FlashLoan -> sepolia | DONE | Deployed + verified |
| C.2 FlashLoan -> baseSepolia | DONE | Deployed + verified on 2026-03-08 |
| C.3 MultiPathQuoter -> arbSepolia | DONE | Deployed + verified |
| C.4 CommitReveal -> arbSepolia | DONE | Deployed + verified |
| C.5 V3Adapter -> arbSepolia | DONE | Deployed, in APPROVED_ROUTERS |
| C.6 PancakeSwap -> arbSepolia | DONE | Deployed + verified on 2026-03-08 |
| C.7 Balancer -> arbSepolia | DONE | Closed as not deployable on testnet: Balancer Vault `0xBA12...` has no bytecode on arbitrumSepolia (`eth_getCode=0x`, 2026-03-08) |
| C.8 SyncSwap -> zksync-testnet | DONE | Deployed + verified on 2026-03-08 with vault `0xfd43...811c` |
| C.9 Verify ALL contracts | DONE | All deployed contracts verified, including zkSync testnet |
| C.10 Update registry + addresses | DONE | CommitReveal sepolia added + registry flags/timestamp updated |
| C.11 E2E test (SIMULATION_MODE=false) | **PARTIAL** | Real-mode stack booted and validated twice on 2026-03-08; no live trade execution observed yet |

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

**Status (2026-03-08): COMPLETE**

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

Execution note (2026-03-08): verification command reports contract already verified and registry flag is now `true`.

#### 1c. Update registry.json timestamp

Change `_lastUpdated` to the current date after any updates.

#### 1d. Rebuild and typecheck

```bash
npm run build:deps
npm run typecheck
```

Execution note (2026-03-08): both commands completed successfully.

---

### Step 2: Deploy Remaining Testnet Contracts (Ready Now)

These deployments have NO blockers. You need testnet ETH on the target chains.

#### 2a. BalancerV2FlashArbitrage on Arbitrum Sepolia (MAY FAIL)

**Status (2026-03-08): CLOSED -- NOT DEPLOYABLE ON ARBITRUM SEPOLIA**

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

**Status (2026-03-08): COMPLETE** -- Aave V3 Pool confirmed and Base Sepolia router/token addresses validated and saved.

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

**Status (2026-03-08): COMPLETE** -- SyncSwap Vault + router validated; zkSync Sepolia WETH/USDC addresses corrected and saved.

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

**Status (2026-03-08): COMPLETE** -- PancakeSwap V3 factory entries for testnets are present and validated in config.

**What to find:** PancakeSwap V3 Deployer/Factory address on Arbitrum Sepolia, BSC Testnet, or any testnet

**Where to look:**
- https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts
- Search PancakeSwap V3 deployment addresses

**Files to update:**
1. `shared/config/src/addresses.ts` -- add to `PANCAKESWAP_V3_FACTORIES`

**Unblocks:** PancakeSwapFlashArbitrage deployment (Step 4c)

#### 3d. LOW PRIORITY: Mantle DEX Addresses (3 DEXes)

**Status (2026-03-08): COMPLETE** -- Merchant Moe / Agni V2 / FusionX factories+routers RPC-validated and saved; Mantle Aave V3 Pool confirmed (`0x458F...1422`).

**What to find:** RPC-verified factory and router addresses for:
- Merchant Moe (LBRouter, LBFactory)
- Agni Finance (SwapRouter, Factory)
- FusionX (Router, Factory)

**Also:** WMNT, WETH, USDC, USDT token addresses; Lendle flash loan availability

**Where to look:** Mantlescan, protocol docs

**Files to update:** `shared/config/src/dexes/chains/mantle.ts`, `shared/config/src/addresses.ts`, `shared/config/src/tokens/index.ts`

#### 3e. LOW PRIORITY: Mode DEX Addresses (3 DEXes)

**Status (2026-03-08): COMPLETE** -- Kim / SupSwap / SwapMode factories+routers RPC-validated and saved.

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

**Status (2026-03-08): COMPLETE** -- deployed and verified (`0x2f091cc77601C5aE2439A763C4916d9d32e035B6`).

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

**Status (2026-03-08): COMPLETE (deployment + verification)** -- deployed and verified at `0x2f091cc77601C5aE2439A763C4916d9d32e035B6` (verification uses custom chain config + `DISABLE_VIA_IR=true`).

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

**Status (2026-03-08): COMPLETE** -- deployed and verified (`0x7C5bf33311D9ACA91d1a11388888A4881c0d744D`).

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

**Status (2026-03-08): COMPLETE (Blast + Scroll + Mantle + Mode added)**

**File:** `contracts/hardhat.config.ts`

Network definitions now in place:

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
mantle: {
  url: process.env.MANTLE_RPC_URL || 'https://rpc.mantle.xyz',
  chainId: 5000,
  accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
},
mode: {
  url: process.env.MODE_RPC_URL || 'https://mainnet.mode.network',
  chainId: 34443,
  accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
},
```

Also add Etherscan-compatible verification config for these chains if the block explorers support it.

After adding:
```bash
npm run typecheck
```

---

### Step 6: Add Approved Routers for Emerging L2s

**Status (2026-03-08): COMPLETE (Blast/Scroll/Mantle/Mode routers and token maps added)**

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
mantle: [
  '0xeaEE7EE68874218c3558b40063c42B82D3E7232a', // Merchant Moe Router
  '0x4CBA08a0880c502AB1e10CDC93Dbc74C23524ac7', // Agni V2 Router
],
mode: [
  '0x5D61c537393cf21893BE619E36fC94cd73C77DD3', // Kim Router
  '0xc1e624c810d297fd70ef53b0e08f44fabe468591', // SwapMode Router
],
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

Execution note (2026-03-08): real-mode `dev:minimal` boot was validated twice. Services reached running state, and execution engine showed healthy providers after explicit RPC overrides; no live arbitrage transaction was observed in the validation window.

---

## 5. Complete Remaining TODO Matrix

### Immediate (No Blockers)

| # | Task | Command / Action | Est. Time | Status |
|---|------|-----------------|-----------|--------|
| 1 | Fix CommitReveal sepolia in addresses.ts | Edit `addresses.ts` line 274 | 2 min | DONE (2026-03-08) |
| 2 | Verify FlashLoan on arbSepolia | `npx hardhat verify --network arbitrumSepolia ...` | 5 min | DONE (2026-03-08) |
| 3 | Update registry.json timestamp | Edit `_lastUpdated` | 1 min | DONE (2026-03-08) |
| 4 | Try BalancerV2 on arbSepolia | `npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia` | 10 min | DONE (N/A on arbSepolia: vault absent) |
| 5 | Add Blast/Scroll to hardhat.config.ts | Edit hardhat.config.ts | 10 min | DONE (2026-03-08) |
| 6 | Rebuild + typecheck | `npm run build:deps && npm run typecheck` | 5 min | DONE (2026-03-08) |

### After Research (Completed)

| # | Task | Blocker | Priority |
|---|------|---------|----------|
| 7 | Deploy FlashLoan to baseSepolia | Completed 2026-03-08 | DONE |
| 8 | Deploy SyncSwap to zksync-testnet | Completed deployment + explorer verification on 2026-03-08 | DONE |
| 9 | Deploy PancakeSwap to arbSepolia | Completed 2026-03-08 | DONE |
| 10 | Add Mantle to Hardhat + dex config | Completed 2026-03-08 (DEX+tokens+Hardhat+partition updates) | DONE |
| 11 | Add Mode to Hardhat + dex config | Completed 2026-03-08 (DEX+tokens+Hardhat+partition updates) | DONE |
| 12 | Add approved routers for emerging L2s | Completed 2026-03-08 (Blast/Scroll/Mantle/Mode in `addresses.ts`) | DONE |
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
| FlashLoanArbitrage | DONE | DONE | DONE | N/A |
| BalancerV2FlashArbitrage | - | SKIPPED (vault absent on arbSepolia testnet) | - | N/A |
| PancakeSwapFlashArbitrage | - | DONE | - | N/A |
| SyncSwapFlashArbitrage | N/A | N/A | N/A | DONE (verified) |
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
