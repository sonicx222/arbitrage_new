# Testnet Contract Deployment — Complete Step-by-Step Tutorial

**Date:** 2026-02-26
**Scope:** All remaining manual steps for local development and testnet contract deployment
**Platform:** Cross-platform (Mac M1 + Windows)
**Based on:** `docs/reports/DEPLOYMENT_TESTNET_ASSESSMENT_2026-02-25.md`

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Accounts & API Keys Required](#2-accounts--api-keys-required)
3. [Environment Setup (Cross-Platform)](#3-environment-setup-cross-platform)
4. [Fund Your Deployer Wallet](#4-fund-your-deployer-wallet)
5. [Testnet Deployments — Chain by Chain](#5-testnet-deployments--chain-by-chain)
6. [Blocked Deployments — Data to Research](#6-blocked-deployments--data-to-research)
7. [Post-Deployment Verification Checklist](#7-post-deployment-verification-checklist)
8. [Batch Deployment](#8-batch-deployment)
9. [Summary — Immediate Actions vs Research Needed](#9-summary--immediate-actions-vs-research-needed)

---

## 1. Current State

**Only 1 contract deployed:** `FlashLoanArbitrage` on `arbitrumSepolia` at `0xE5b26749430ed50917b75689B654a4C5808b23FB`
**Remaining testnet deployments needed:** 7 contract-chain combinations (Phase C of the assessment)

### Testnet Readiness Matrix

| Testnet | Aave V3 | Balancer V2 | SyncSwap | PancakeSwap V3 | V3 SwapRouter | Approved Routers | Tokens | FlashLoan Contract |
|---------|---------|-------------|----------|----------------|---------------|------------------|--------|--------------------|
| **sepolia** | Yes | No | No | No | Yes | Yes (1) | Yes (WETH, USDC, DAI) | No |
| **arbitrumSepolia** | Yes | Address exists, disabled | No | No | Yes | Yes (1) | Yes (WETH, USDC) | **Yes** |
| **baseSepolia** | **MISSING** | No | No | No | **MISSING** | **MISSING** | **MISSING** | No |
| **bscTestnet** | N/A | N/A | No | **MISSING** | **MISSING** | **MISSING** | **MISSING** | No |
| **polygonAmoy** | **MISSING** | No | No | No | **MISSING** | **MISSING** | **MISSING** | No |
| **zksync-testnet** | N/A | N/A | Comment only* | No | **MISSING** | **MISSING** | **MISSING** | No |

*SyncSwap Vault address `0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8` exists only in a code comment in `flash-loan-availability.ts`, not in the actual `SYNCSWAP_VAULTS` config.

---

## 2. Accounts & API Keys Required

### Required (before any deployment)

| Item | Purpose | Where to Get | Free? |
|------|---------|-------------|-------|
| **Deployer Wallet** | Signs deploy transactions | Any Ethereum wallet (MetaMask, etc.) | Yes |
| **Testnet ETH (Sepolia)** | Gas for Sepolia deploys | Faucets (see Section 4) | Yes |
| **Testnet ETH (Arbitrum Sepolia)** | Gas for Arb Sepolia deploys | Faucets (see Section 4) | Yes |
| **Testnet ETH (Base Sepolia)** | Gas for Base Sepolia deploys | Faucets (see Section 4) | Yes |
| **Testnet ETH (zkSync Sepolia)** | Gas for zkSync deploys | Faucets (see Section 4) | Yes |

### Required for Contract Verification

| Item | Purpose | Where to Get |
|------|---------|-------------|
| **Etherscan API Key** | Verify on Etherscan V2 (covers Sepolia, Arbitrum, Base, Optimism) | https://etherscan.io/apis |
| **zkSync Explorer API Key** | Verify on zkSync block explorer | https://explorer.zksync.io |

> Etherscan V2 uses a **single API key** for all supported chains (Sepolia, Arbitrum Sepolia, Base Sepolia). You do NOT need separate Arbiscan/Basescan keys for testnet verification.

### Optional (for enhanced RPC reliability)

| Item | Purpose | Providers |
|------|---------|-----------|
| **Alchemy API Key** | Faster, more reliable RPC | https://www.alchemy.com/ (free tier: 300M compute units/month) |
| **Infura API Key** | Alternative RPC provider | https://www.infura.io/ (free tier: 100K requests/day) |
| **QuickNode API Key** | Alternative RPC provider | https://www.quicknode.com/ |

> The Hardhat config has public fallback RPCs for all testnets. These are rate-limited but functional for deployment. Use a dedicated provider for reliability.

### Not Needed for Testnets

- `COINMARKETCAP_API_KEY` — only for gas cost USD reporting
- `CONTRACT_OWNER` — only for mainnet (defaults to deployer on testnets)
- Per-chain scanner keys (`ARBISCAN_API_KEY`, `BSCSCAN_API_KEY`, etc.) — Etherscan V2 covers testnets with one key

---

## 3. Environment Setup (Cross-Platform)

### 3.1 Prerequisites

| Tool | Version | Mac M1 | Windows |
|------|---------|--------|---------|
| Node.js | >= 22.0.0 | `brew install node` | https://nodejs.org/ installer or `winget install OpenJS.NodeJS` |
| npm | >= 9.0.0 | Comes with Node | Comes with Node |
| Git | Any recent | `brew install git` | https://git-scm.com/ or `winget install Git.Git` |

### 3.2 Install Dependencies

```bash
# From project root
npm install
npm run build:deps   # Build shared packages (types -> config -> core -> ml)
```

### 3.3 Create Your Environment File

```bash
# Mac/Linux
cp .env.example .env.local

# Windows (PowerShell)
Copy-Item .env.example .env.local

# Windows (Git Bash / MSYS2)
cp .env.example .env.local
```

> `.env.local` is gitignored and has the highest precedence. **Never put private keys in `.env`.**

### 3.4 Configure Minimum Required Variables

Edit `.env.local` and set these values:

```bash
# === REQUIRED FOR ALL DEPLOYMENTS ===
DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# === REQUIRED FOR CONTRACT VERIFICATION ===
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_V2_API_KEY

# === OPTIONAL: Override default public RPCs for better reliability ===
# SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
# ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY
# BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY
# ZKSYNC_TESTNET_RPC_URL=https://zksync-sepolia.g.alchemy.com/v2/YOUR_KEY
```

### 3.5 Compile Contracts

```bash
cd contracts
npx hardhat compile
```

Expected output: `Compiled N Solidity files successfully`. If this fails, run `npx hardhat clean` first, then retry.

### 3.6 Run Contract Tests (Sanity Check)

```bash
cd contracts
npx hardhat test
```

All tests should pass before attempting any deployment.

---

## 4. Fund Your Deployer Wallet

You need testnet ETH on each chain you want to deploy to. The deployer address is derived from your `DEPLOYER_PRIVATE_KEY`.

To find your deployer address:
```bash
cd contracts
npx hardhat run --network hardhat -e "const [s] = await ethers.getSigners(); console.log(s.address)"
```

Or check MetaMask / your wallet using the same private key.

### Testnet Faucets

| Chain | Faucet | Amount | Notes |
|-------|--------|--------|-------|
| **Sepolia** | https://sepoliafaucet.com/ | 0.5 ETH/day | Alchemy-powered, needs Alchemy account |
| **Sepolia** | https://faucet.quicknode.com/ethereum/sepolia | 0.1 ETH/request | QuickNode alternative |
| **Arbitrum Sepolia** | https://faucet.quicknode.com/arbitrum/sepolia | 0.1 ETH/request | |
| **Arbitrum Sepolia** | Bridge from Sepolia via https://bridge.arbitrum.io/ | Any amount | Bridge Sepolia ETH -> Arb Sepolia (~10 min) |
| **Base Sepolia** | https://faucet.quicknode.com/base/sepolia | 0.1 ETH/request | |
| **Base Sepolia** | Bridge from Sepolia via https://bridge.base.org/ | Any amount | Bridge Sepolia ETH -> Base Sepolia |
| **zkSync Sepolia** | https://faucet.quicknode.com/zksync/sepolia | 0.1 ETH/request | |
| **zkSync Sepolia** | Bridge from Sepolia via https://bridge.zksync.io/ | Any amount | Official zkSync bridge |

### Recommended Gas Budget Per Chain

| Chain | Budget | Rationale |
|-------|--------|-----------|
| Sepolia | 0.05 ETH | FlashLoanArbitrage deploy ~2.3M gas |
| Arbitrum Sepolia | 0.01 ETH | L2 gas is cheaper; FlashLoan already deployed |
| Base Sepolia | 0.05 ETH | Full deployment set |
| zkSync Sepolia | 0.05 ETH | zkSync gas model differs from standard EVM |

---

## 5. Testnet Deployments — Chain by Chain

### Deployment Readiness Overview

| # | Contract | Network | Protocol Dependency | Status |
|---|----------|---------|--------------------|--------|
| 1 | FlashLoanArbitrage | sepolia | Aave V3 Pool (configured) | **READY** |
| 2 | FlashLoanArbitrage | baseSepolia | Aave V3 Pool (**NOT configured**) | **BLOCKED** |
| 3 | MultiPathQuoter | arbitrumSepolia | None (stateless) | **READY** |
| 4 | CommitRevealArbitrage | arbitrumSepolia | None (owner only) | **READY** |
| 5 | UniswapV3Adapter | arbitrumSepolia | FlashLoanArbitrage (exists) + V3 SwapRouter (configured) | **READY** |
| 6 | PancakeSwapFlashArbitrage | arbitrumSepolia | PancakeSwap V3 Factory (**NOT configured**) | **BLOCKED** |
| 7 | BalancerV2FlashArbitrage | arbitrumSepolia | Balancer V2 Vault (address exists, availability disabled) | **PARTIAL** |
| 8 | SyncSwapFlashArbitrage | zksync-testnet | SyncSwap Vault (**address in comment only**) | **BLOCKED** |

---

### Deployment 1: FlashLoanArbitrage on Sepolia

**Prerequisites:** Sepolia ETH in deployer wallet. Aave V3 Pool is configured at `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`.

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network sepolia
```

**What happens:**
1. Script finds Aave V3 Pool address for `sepolia`
2. Deploys `FlashLoanArbitrage` with constructor args `[aavePool, deployer]`
3. Configures minimum profit (0.001 ETH)
4. Approves router `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` (Uniswap V2 on Sepolia)
5. Attempts Etherscan verification
6. Saves result to `contracts/deployments/registry.json`

**After deployment:**
1. Note the deployed contract address from the output
2. Update `contracts/deployments/addresses.ts` — add the address to `FLASH_LOAN_CONTRACT_ADDRESSES` under `sepolia`
3. Verify on Etherscan if auto-verification failed:
   ```bash
   npx hardhat verify --network sepolia <CONTRACT_ADDRESS> "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951" "<YOUR_DEPLOYER_ADDRESS>"
   ```

---

### Deployment 2: MultiPathQuoter on Arbitrum Sepolia

**Prerequisites:** Arbitrum Sepolia ETH. No protocol dependencies (stateless contract).

```bash
cd contracts
npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrumSepolia
```

**What happens:**
1. Deploys `MultiPathQuoter` with no constructor args
2. No configuration needed (pure utility contract)
3. Attempts verification

**After deployment:**
1. Note the deployed contract address
2. Update `contracts/deployments/addresses.ts` — add to `MULTI_PATH_QUOTER_ADDRESSES` under `arbitrumSepolia`
3. Uncomment the `arbitrumSepolia` line in `shared/config/src/service-config.ts` `multiPathQuoterAddresses` (around line 536-568)

---

### Deployment 3: CommitRevealArbitrage on Arbitrum Sepolia

**Prerequisites:** Arbitrum Sepolia ETH. No protocol dependencies.

```bash
cd contracts
npx hardhat run scripts/deploy-commit-reveal.ts --network arbitrumSepolia
```

**What happens:**
1. Deploys `CommitRevealArbitrage` with constructor arg `[ownerAddress]`
2. Owner defaults to deployer (override with `CONTRACT_OWNER` env var)

**After deployment:**
1. Note the deployed contract address
2. Update `contracts/deployments/addresses.ts` — add to `COMMIT_REVEAL_ARBITRAGE_ADDRESSES` under `arbitrumSepolia`

---

### Deployment 4: UniswapV3Adapter on Arbitrum Sepolia

**Prerequisites:** Arbitrum Sepolia ETH + FlashLoanArbitrage already deployed (at `0xE5b26749430ed50917b75689B654a4C5808b23FB`).

**Mac/Linux:**
```bash
cd contracts
FLASH_LOAN_CONTRACT_ADDRESS=0xE5b26749430ed50917b75689B654a4C5808b23FB \
npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrumSepolia
```

**Windows (PowerShell):**
```powershell
cd contracts
$env:FLASH_LOAN_CONTRACT_ADDRESS="0xE5b26749430ed50917b75689B654a4C5808b23FB"
npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrumSepolia
```

**Windows (Git Bash):**
```bash
cd contracts
FLASH_LOAN_CONTRACT_ADDRESS=0xE5b26749430ed50917b75689B654a4C5808b23FB \
npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrumSepolia
```

**What happens:**
1. Uses V3 SwapRouter `0xE592427A0AEce92De3Edee1F18E0157C05861564` (configured for arbitrumSepolia)
2. QuoterV2 is zero address (disabled on testnet — adapter works without it, just can't quote)
3. Deploys `UniswapV3Adapter` with args `[swapRouter, quoter, deployer, 3000]`
4. Registers the adapter as an approved router on the FlashLoanArbitrage contract

**After deployment:**
1. Note the deployed adapter address
2. The adapter is automatically registered as a router on FlashLoanArbitrage — no manual approval needed

---

### Deployment 5: BalancerV2FlashArbitrage on Arbitrum Sepolia (MAY FAIL)

**Status:** The Balancer V2 Vault address `0xBA12222222228d8Ba445958a75a0704d566BF2C8` exists in config for arbitrumSepolia, but the flash-loan-availability matrix has `balancer_v2: false`. The Vault uses CREATE2, so the address is the same on all chains, but **it may not actually be deployed on Arbitrum Sepolia**.

**Try it:**
```bash
cd contracts
npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia
```

**If it fails** with "Vault not found" or a revert during the flash loan smoke test, Balancer V2 hasn't deployed to Arbitrum Sepolia. Skip this and deploy on mainnet instead.

**If it succeeds:**
1. Update `contracts/deployments/addresses.ts` — add to `BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES`
2. Update `shared/config/src/flash-loan-availability.ts` — change `balancer_v2: false` to `true` for `arbitrumSepolia`

---

## 6. Blocked Deployments — Data to Research

These deployments are blocked by missing configuration data. Research the following to unblock them.

### Blocker A: Base Sepolia Aave V3 Pool Address (HIGH PRIORITY)

**What's missing:** `AAVE_V3_POOLS` in `shared/config/src/addresses.ts` has no entry for `baseSepolia`

**What to research:**
- Go to https://docs.aave.com/developers/deployed-contracts
- Find "Base Sepolia" under V3 testnets
- Get the **Pool** contract address (NOT PoolAddressesProvider)
- Also get testnet token addresses: WETH, USDC, DAI on Base Sepolia
- Get at least one DEX router address on Base Sepolia for `APPROVED_ROUTERS`

**Files to update once data is found:**
- `shared/config/src/addresses.ts` — add Aave V3 Pool for `baseSepolia`
- `contracts/deployments/addresses.ts` — add approved routers and tokens for `baseSepolia`
- `shared/config/src/flash-loan-availability.ts` — add `baseSepolia` entry

**Unblocks:** FlashLoanArbitrage deployment on baseSepolia

---

### Blocker B: PancakeSwap V3 Factory on Arbitrum Sepolia (MEDIUM PRIORITY)

**What's missing:** `PANCAKESWAP_V3_FACTORIES` in `shared/config/src/addresses.ts` has no testnet entries

**What to research:**
- Go to https://docs.pancakeswap.finance/developers/smart-contracts
- Find PancakeSwap V3 Factory address on Arbitrum Sepolia (or any testnet)
- If PancakeSwap hasn't deployed to Arbitrum Sepolia, this deployment is not possible on testnet

**Files to update once data is found:**
- `shared/config/src/addresses.ts` — add PancakeSwap V3 Factory for the testnet

**Unblocks:** PancakeSwapFlashArbitrage deployment

---

### Blocker C: SyncSwap Vault on zkSync Sepolia (HIGH PRIORITY)

**What's missing:** Vault address `0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8` exists only in a code comment in `flash-loan-availability.ts`, not in the actual `SYNCSWAP_VAULTS` config

**What to research:**
- Verify this staging vault address is still correct: `0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8`
- Check https://syncswap.xyz/ docs or the zkSync Sepolia block explorer
- Also get: SyncSwap Router address and approved token list for zkSync Sepolia

**Files to update once data is found:**
- `shared/config/src/addresses.ts` — add vault to `SYNCSWAP_VAULTS` for `zksync-testnet`
- `contracts/deployments/addresses.ts` — add approved routers and tokens for `zksync-testnet`

**Unblocks:** SyncSwapFlashArbitrage deployment on zksync-testnet (requires `DISABLE_VIA_IR=true`)

---

### Blocker D: Emerging L2 DEX Addresses (LOW PRIORITY — Phase B)

All 4 emerging L2s (Blast, Scroll, Mantle, Mode) have **all-zero placeholder addresses**. This is the biggest research task.

| Chain | ChainID | DEXs to Research | Key Data Points |
|-------|---------|-----------------|-----------------|
| **Blast** | 81457 | Thruster V3, Thruster V2, BladeSwap, Ring Protocol | Factory + Router for each; flash loan providers |
| **Scroll** | 534352 | SyncSwap (+ Vault!), SpaceFi, Ambient, Zebra | SyncSwap Vault critical for flash loans; WETH, USDC, USDT, DAI |
| **Mantle** | 5000 | Merchant Moe, Agni Finance, FusionX | Native token is MNT; need WMNT, WETH, USDC, USDT |
| **Mode** | 34443 | Kim Exchange, SupSwap, SwapMode | Need USDT and MODE token addresses |

**Where to look:** Each chain's block explorer (Blastscan, Scrollscan, Mantlescan, Modescan), DeFiLlama, and protocol documentation. See `docs/reports/DEPLOYMENT_TESTNET_ASSESSMENT_2026-02-25.md` Section 6 for detailed lookup instructions per DEX.

**Files to update once data is found:**
- `shared/config/src/dexes/index.ts` — replace placeholder addresses
- `shared/config/src/addresses.ts` — add protocol addresses
- `shared/config/src/tokens/index.ts` — add token addresses
- `contracts/hardhat.config.ts` — add network configs for all 4 chains
- `contracts/deployments/addresses.ts` — add approved routers
- `shared/config/src/partitions.ts` — re-assign to partitions

---

## 7. Post-Deployment Verification Checklist

After each successful deployment, run these checks:

### 7.1 Verify Registry Updated

```bash
cd contracts

# Mac/Linux
cat deployments/registry.json | grep -A5 "<network_name>"

# Windows (PowerShell)
Get-Content deployments/registry.json | Select-String -Context 0,5 "<network_name>"

# Windows (Git Bash)
cat deployments/registry.json | grep -A5 "<network_name>"
```

### 7.2 Verify on Block Explorer (if auto-verify failed)

```bash
cd contracts
npx hardhat verify --network <network> <address> <constructor_args...>
```

**Constructor args by contract type:**

| Contract | Constructor Args |
|----------|-----------------|
| FlashLoanArbitrage | `<aavePoolAddress> <deployerAddress>` |
| BalancerV2FlashArbitrage | `<vaultAddress> <deployerAddress>` |
| PancakeSwapFlashArbitrage | `<factoryAddress> <deployerAddress>` |
| SyncSwapFlashArbitrage | `<vaultAddress> <deployerAddress>` |
| CommitRevealArbitrage | `<ownerAddress>` |
| MultiPathQuoter | (no args) |
| UniswapV3Adapter | `<swapRouter> <quoter> <deployerAddress> <feeTier>` |

### 7.3 Type Check

```bash
# From project root
npm run typecheck
```

### 7.4 Run Pre-Deployment Validator

```bash
# From project root
npm run validate:deployment
```

### 7.5 Update Config Files

After each deployment, update these files with the new contract address:

1. `contracts/deployments/addresses.ts` — add address to the relevant constant
2. `shared/config/src/service-config.ts` — uncomment/update relevant entries
3. `shared/config/src/flash-loan-availability.ts` — update availability if needed

### 7.6 Rebuild After Config Changes

```bash
npm run build:deps
npm run typecheck
```

---

## 8. Batch Deployment

Once individual deploys are validated, use the batch script for remaining deployments.

### Dry Run (Always Do This First)

```bash
cd contracts

# Show full deployment plan
BATCH_DRY_RUN=true npx hardhat run scripts/deploy-batch.ts

# Filter to specific testnets only
BATCH_NETWORKS=sepolia,arbitrumSepolia BATCH_DRY_RUN=true npx hardhat run scripts/deploy-batch.ts

# Filter to specific contracts only
BATCH_CONTRACTS=FlashLoanArbitrage,MultiPathQuoter BATCH_DRY_RUN=true npx hardhat run scripts/deploy-batch.ts
```

### Execute

```bash
cd contracts

# Deploy filtered set (skips already-deployed from registry)
BATCH_NETWORKS=sepolia,arbitrumSepolia npx hardhat run scripts/deploy-batch.ts
```

**Windows (PowerShell) equivalent:**
```powershell
cd contracts
$env:BATCH_DRY_RUN="true"
npx hardhat run scripts/deploy-batch.ts

# Or to execute:
Remove-Item Env:\BATCH_DRY_RUN
$env:BATCH_NETWORKS="sepolia,arbitrumSepolia"
npx hardhat run scripts/deploy-batch.ts
```

### Batch Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `BATCH_DRY_RUN=true` | Show plan only, don't deploy | Always start with this |
| `BATCH_NETWORKS` | Comma-separated target networks | `sepolia,arbitrumSepolia` |
| `BATCH_CONTRACTS` | Comma-separated contract types | `FlashLoanArbitrage,MultiPathQuoter` |
| `BATCH_SKIP_CONFIRMATION=true` | Skip mainnet confirmation prompts | For CI/automation only |

---

## 9. Summary — Immediate Actions vs Research Needed

### You Can Deploy Right Now (No Blockers)

| # | Command | Network | Est. Gas |
|---|---------|---------|----------|
| 1 | `npx hardhat run scripts/deploy.ts --network sepolia` | Sepolia | ~2.3M |
| 2 | `npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrumSepolia` | Arb Sepolia | ~1M |
| 3 | `npx hardhat run scripts/deploy-commit-reveal.ts --network arbitrumSepolia` | Arb Sepolia | ~2M |
| 4 | `FLASH_LOAN_CONTRACT_ADDRESS=0xE5b26749430ed50917b75689B654a4C5808b23FB npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrumSepolia` | Arb Sepolia | ~1.5M |
| 5 | `npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia` (may fail) | Arb Sepolia | ~2M |

### Research Needed to Unblock Remaining Deployments

| Priority | Data Needed | Unblocks |
|----------|------------|----------|
| **HIGH** | Aave V3 Pool address on Base Sepolia | FlashLoanArbitrage on baseSepolia |
| **HIGH** | SyncSwap Vault address on zkSync Sepolia (verify `0x4Ff94...F8`) | SyncSwapFlashArbitrage on zksync-testnet |
| **MEDIUM** | PancakeSwap V3 Factory on any testnet | PancakeSwapFlashArbitrage testnet deploy |
| **MEDIUM** | Approved router + token addresses for baseSepolia, zksync-testnet | Config completeness |
| **LOW** | All emerging L2 DEX addresses (Blast, Scroll, Mantle, Mode) | Phase B / E.8 mainnet expansion |

### Recommended Deployment Order

```
1. FlashLoanArbitrage on Sepolia (READY — deploy now)
2. MultiPathQuoter on Arbitrum Sepolia (READY — deploy now)
3. CommitRevealArbitrage on Arbitrum Sepolia (READY — deploy now)
4. UniswapV3Adapter on Arbitrum Sepolia (READY — deploy now)
5. BalancerV2FlashArbitrage on Arbitrum Sepolia (PARTIAL — try it)
   ↓ Research needed below this line ↓
6. FlashLoanArbitrage on Base Sepolia (needs Aave V3 Pool address)
7. SyncSwapFlashArbitrage on zkSync Testnet (needs SyncSwap Vault + DISABLE_VIA_IR=true)
8. PancakeSwapFlashArbitrage on Arbitrum Sepolia (needs PancakeSwap V3 Factory)
```

---

## Appendix A: Key Files Reference

| File | What It Controls |
|------|-----------------|
| `contracts/hardhat.config.ts` | Network definitions for deployment |
| `contracts/deployments/registry.json` | Deployment tracking (auto-updated by scripts) |
| `contracts/deployments/addresses.ts` | Deployed contract addresses + approved routers + tokens |
| `shared/config/src/addresses.ts` | Protocol addresses (Aave, Balancer, SyncSwap, PancakeSwap) |
| `shared/config/src/flash-loan-availability.ts` | Which flash loan protocols are available per chain |
| `shared/config/src/service-config.ts` | Flash loan provider selection + MultiPathQuoter addresses |
| `shared/config/src/dexes/index.ts` | DEX factory + router addresses per chain |
| `shared/config/src/partitions.ts` | Chain-to-partition assignments |
| `contracts/scripts/deploy-v3-adapter.ts` | V3 SwapRouter addresses per chain (hardcoded) |
| `.env.local` | Your secrets (private keys, API keys) — gitignored |

## Appendix B: All Deployment Scripts

| Script | Contract | Usage |
|--------|----------|-------|
| `scripts/deploy.ts` | FlashLoanArbitrage (Aave V3) | `npx hardhat run scripts/deploy.ts --network <chain>` |
| `scripts/deploy-balancer.ts` | BalancerV2FlashArbitrage | `npx hardhat run scripts/deploy-balancer.ts --network <chain>` |
| `scripts/deploy-pancakeswap.ts` | PancakeSwapFlashArbitrage | `npx hardhat run scripts/deploy-pancakeswap.ts --network <chain>` |
| `scripts/deploy-syncswap.ts` | SyncSwapFlashArbitrage | `DISABLE_VIA_IR=true npx hardhat run scripts/deploy-syncswap.ts --network <chain>` |
| `scripts/deploy-commit-reveal.ts` | CommitRevealArbitrage | `npx hardhat run scripts/deploy-commit-reveal.ts --network <chain>` |
| `scripts/deploy-multi-path-quoter.ts` | MultiPathQuoter | `npx hardhat run scripts/deploy-multi-path-quoter.ts --network <chain>` |
| `scripts/deploy-v3-adapter.ts` | UniswapV3Adapter | `npx hardhat run scripts/deploy-v3-adapter.ts --network <chain>` |
| `scripts/deploy-batch.ts` | All of the above | `BATCH_DRY_RUN=true npx hardhat run scripts/deploy-batch.ts` |

## Appendix C: Env Var Quick Reference

```bash
# === Deployment ===
DEPLOYER_PRIVATE_KEY=0x...          # Required for all deploys
CONTRACT_OWNER=0x...                # Optional (defaults to deployer)
ETHERSCAN_API_KEY=...               # Required for verification

# === Testnet RPCs (all have public fallbacks) ===
SEPOLIA_RPC_URL=https://...
ARBITRUM_SEPOLIA_RPC_URL=https://...
BASE_SEPOLIA_RPC_URL=https://...
ZKSYNC_TESTNET_RPC_URL=https://...
POLYGON_AMOY_RPC_URL=https://...
BSC_TESTNET_RPC_URL=https://...

# === Batch Deployment ===
BATCH_DRY_RUN=true                  # Plan only
BATCH_NETWORKS=sepolia,arbitrumSepolia
BATCH_CONTRACTS=FlashLoanArbitrage,MultiPathQuoter
BATCH_SKIP_CONFIRMATION=true        # Skip mainnet prompts

# === V3 Adapter ===
FLASH_LOAN_CONTRACT_ADDRESS=0x...   # FlashLoanArbitrage to register adapter on
V3_SWAP_ROUTER=0x...                # Override per-chain default
V3_QUOTER=0x...                     # Override per-chain default
DEFAULT_FEE_TIER=3000               # 0.3% default

# === Special ===
DISABLE_VIA_IR=true                 # Required for zkSync deployments
FORK_ENABLED=true                   # Enable fork testing
REPORT_GAS=true                     # Gas usage reporting
```
