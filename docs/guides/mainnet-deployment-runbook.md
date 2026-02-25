# Mainnet Deployment Runbook

> **Last Updated:** 2026-02-25
> **Status:** Ready for Phase 7 (L2 mainnet deployment)
> **Prerequisite:** Complete testnet deployment and verification first. See [Testnet Deployment Guide](./testnet-deployment-arbitrum-sepolia.md).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Pre-Deployment Checklist](#2-pre-deployment-checklist)
3. [Wallet Setup](#3-wallet-setup)
4. [Deploy Per Chain](#4-deploy-per-chain)
5. [Post-Deployment Steps](#5-post-deployment-steps)
6. [Rollback Procedures](#6-rollback-procedures)

---

## 1. Overview

### Deployment Order (Critical Path)

Deploy to L2 chains first (low gas), then L1 last (highest gas):

| Priority | Chain | Contracts to Deploy | Gas Token |
|----------|-------|-------------------|-----------|
| 1st | **Arbitrum** | FlashLoan, Balancer, PancakeSwap, CommitReveal, MultiPathQuoter, V3Adapter | ETH |
| 2nd | **Base** | FlashLoan, Balancer, PancakeSwap, CommitReveal, MultiPathQuoter, V3Adapter | ETH |
| 3rd | **Optimism** | FlashLoan, Balancer, CommitReveal, MultiPathQuoter, V3Adapter | ETH |
| 4th | **Polygon** | FlashLoan, Balancer, CommitReveal, MultiPathQuoter, V3Adapter | MATIC |
| 5th | **BSC** | PancakeSwap, CommitReveal, MultiPathQuoter, V3Adapter | BNB |
| 6th | **Avalanche** | FlashLoan, CommitReveal, MultiPathQuoter | AVAX |
| 7th | **Fantom** | CommitReveal, MultiPathQuoter | FTM |
| 8th | **zkSync** | SyncSwap, CommitReveal, MultiPathQuoter | ETH |
| 9th | **Linea** | CommitReveal, MultiPathQuoter, V3Adapter | ETH |
| Last | **Ethereum** | All contract types (commented out in hardhat.config.ts — enable after L2 success) | ETH |

### Per-Contract Deploy Order Within Each Chain

Deploy in this order to satisfy dependencies:

1. **FlashLoanArbitrage** (or chain-appropriate flash loan contract)
2. **MultiPathQuoter** (stateless, no dependencies)
3. **CommitRevealArbitrage** (no dependencies)
4. **UniswapV3Adapter** (needs FlashLoanArbitrage address for router registration)
5. **BalancerV2FlashArbitrage** (independent)
6. **PancakeSwapFlashArbitrage** (independent)

---

## 2. Pre-Deployment Checklist

Run these checks before any mainnet deployment:

### 2.1 Automated Validation

```bash
# From project root
npm run validate:deployment     # Redis, RPC latency, env config, gas prices
npm run validate:mev-setup      # MEV provider config for all chains
npm run typecheck               # TypeScript compilation
cd contracts && npx hardhat compile  # Solidity compilation
cd contracts && npx hardhat test     # Full contract test suite
```

All checks must pass with exit code 0.

### 2.2 Manual Verification

- [ ] Testnet deployment completed and verified for same contract type
- [ ] Contract tests pass with 100% of assertions
- [ ] `DEPLOYER_PRIVATE_KEY` is set in `.env.local` (never `.env`)
- [ ] `ETHERSCAN_API_KEY` is set for contract verification
- [ ] Deployer wallet has sufficient gas on the target chain (see Section 3)
- [ ] RPC endpoint for target chain is accessible and responsive (<500ms)
- [ ] No pending protocol upgrades on the target chain
- [ ] Git working tree is clean (`git status` shows no uncommitted changes)

### 2.3 Gas Budget

| Chain | Estimated Deploy Gas | Recommended Balance |
|-------|---------------------|-------------------|
| Arbitrum | ~3M gas (~0.003 ETH) | 0.01 ETH |
| Base | ~3M gas (~0.003 ETH) | 0.01 ETH |
| Optimism | ~3M gas (~0.003 ETH) | 0.01 ETH |
| Polygon | ~5M gas (~0.5 MATIC) | 2 MATIC |
| BSC | ~5M gas (~0.015 BNB) | 0.05 BNB |
| Avalanche | ~5M gas (~0.15 AVAX) | 0.5 AVAX |
| Fantom | ~5M gas (~0.5 FTM) | 2 FTM |
| zkSync | ~10M gas (~0.01 ETH) | 0.05 ETH |
| Linea | ~5M gas (~0.005 ETH) | 0.02 ETH |
| Ethereum | ~5M gas (~0.05 ETH) | 0.1 ETH |

These are per-contract estimates. Multiply by the number of contracts for total chain budget.

---

## 3. Wallet Setup

### 3.1 Dedicated Hot Wallet

> [!IMPORTANT]
> Use a dedicated hot wallet for deployment. Never use a wallet holding significant funds.

1. Generate a fresh deployer wallet (or reuse the existing deployer: `0x330E1aF8aF57C7b5D40F73D54825028fC50Bb748`)
2. Fund it with the gas budget from Section 2.3
3. Set `DEPLOYER_PRIVATE_KEY` in `.env.local`

### 3.2 Check Balance

```bash
cd contracts
npx hardhat run scripts/check-balance.ts --network arbitrum
```

---

## 4. Deploy Per Chain

### 4.1 Option A: Batch Deployment (Recommended)

Use the batch deployment script to deploy all contracts to one or more chains:

```bash
cd contracts

# Dry run first — review the plan
BATCH_DRY_RUN=true BATCH_NETWORKS=arbitrum npx hardhat run scripts/deploy-batch.ts

# Execute deployment to Arbitrum
BATCH_NETWORKS=arbitrum npx hardhat run scripts/deploy-batch.ts

# Deploy to multiple chains
BATCH_NETWORKS=arbitrum,base,optimism npx hardhat run scripts/deploy-batch.ts

# Deploy specific contract type only
BATCH_CONTRACTS=FlashLoanArbitrage BATCH_NETWORKS=arbitrum npx hardhat run scripts/deploy-batch.ts
```

The batch script:
- Skips already-deployed contracts (checks `registry.json`)
- Prompts for confirmation before each mainnet deployment
- Sets `DISABLE_VIA_IR=true` automatically for zkSync
- Saves results to registry after each deployment

### 4.2 Option B: Individual Deployment

Deploy contracts one at a time:

```bash
cd contracts

# FlashLoanArbitrage (Aave V3)
npx hardhat run scripts/deploy.ts --network arbitrum

# BalancerV2FlashArbitrage (0% fee)
npx hardhat run scripts/deploy-balancer.ts --network arbitrum

# PancakeSwapFlashArbitrage
npx hardhat run scripts/deploy-pancakeswap.ts --network arbitrum

# SyncSwapFlashArbitrage (zkSync only)
DISABLE_VIA_IR=true npx hardhat run scripts/deploy-syncswap.ts --network zksync

# CommitRevealArbitrage
npx hardhat run scripts/deploy-commit-reveal.ts --network arbitrum

# MultiPathQuoter
npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrum

# UniswapV3Adapter (deploy AFTER FlashLoanArbitrage)
npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrum
```

Each script will:
1. Check deployer balance
2. Prompt for mainnet confirmation (type `DEPLOY`)
3. Estimate gas cost
4. Deploy and wait for confirmation
5. Configure minimum profit threshold
6. Approve DEX routers from `APPROVED_ROUTERS`
7. Attempt contract verification
8. Run smoke tests
9. Save to `registry.json`
10. Print deployment summary and next steps

> **Exceptions:**
> - **CommitRevealArbitrage** skips steps 5-6 (`configureMinProfit: false`, `configureRouters: false`). Routers are configured manually post-deployment. See `contracts/scripts/deploy-commit-reveal.ts`.
> - **UniswapV3Adapter** uses its own deployment flow (`deploy-v3-adapter.ts`), not the shared pipeline. It requires `V3_SWAP_ROUTER` and optionally `FLASH_LOAN_CONTRACT_ADDRESS` for router registration.

### 4.3 Record Keeping

After each deployment:

```bash
# Verify registry was updated
cat contracts/deployments/registry.json | jq '.arbitrum'

# Generate address constants
npm run generate:addresses

# Verify TypeScript compiles with new addresses
npm run typecheck
```

---

## 5. Post-Deployment Steps

After deploying all contracts to a chain:

1. **Verify all contracts** — See [Contract Verification Guide](./contract-verification-guide.md)
2. **Run post-deployment checks** — See [Post-Deployment Verification Checklist](./post-deployment-checklist.md)
3. **Update service configuration**:
   - `shared/config/src/service-config.ts` — Uncomment flash loan provider for the chain
   - `shared/config/src/service-config.ts` — Update MultiPathQuoter address
   - `contracts/deployments/addresses.ts` — Update `FLASH_LOAN_CONTRACT_ADDRESSES`
4. **Commit deployment artifacts**:
   ```bash
   git add contracts/deployments/
   git commit -m "deploy: all contracts to arbitrum mainnet"
   ```
5. **Restart services**:
   ```bash
   npm run dev:stop && npm run dev:all
   ```
6. **Monitor initial operation** for 1 hour:
   - Check coordinator dashboard for opportunity detection
   - Verify execution engine picks up the new chain
   - Monitor gas usage and profit/loss

---

## 6. Rollback Procedures

### 6.1 Contract Pause (Immediate)

If a deployed contract is behaving unexpectedly:

```bash
# Connect to the contract and pause it
npx hardhat console --network arbitrum
> const contract = await ethers.getContractAt('FlashLoanArbitrage', '0x...')
> await contract.pause()
```

This blocks all `executeArbitrage()` calls immediately. The contract remains deployed but inactive.

### 6.2 Service Rollback

If the service-side configuration update causes issues:

```bash
# Revert the config commit
git revert HEAD
npm run build:deps
npm run dev:stop && npm run dev:all
```

### 6.3 Contract Replacement

Contracts cannot be "undeployed" from a blockchain. If a contract has a critical bug:

1. **Pause** the affected contract immediately
2. **Withdraw** any trapped funds via `withdrawToken()` / `withdrawETH()`
3. **Deploy** a new version of the contract
4. **Update** all configuration to point to the new address
5. **Remove** the old contract's routers from the old address (optional — it's paused)

### 6.4 Emergency Contacts

| Action | Command |
|--------|---------|
| Pause contract | `contract.pause()` |
| Withdraw ERC20 | `contract.withdrawToken(tokenAddr, recipientAddr, amount)` |
| Withdraw ETH | `contract.withdrawETH(recipientAddr, amount)` |
| Check pause state | `contract.paused()` |

---

## Appendix: Environment Variables

Required in `.env.local` before mainnet deployment:

```bash
# Deployment
DEPLOYER_PRIVATE_KEY=0x...        # Hot wallet private key

# Verification
ETHERSCAN_API_KEY=...             # Etherscan V2 API key (works for all chains)

# Chain-specific RPC (if not using defaults)
ARBITRUM_RPC_URL=...
BASE_RPC_URL=...
OPTIMISM_RPC_URL=...
POLYGON_RPC_URL=...
BSC_RPC_URL=...
AVALANCHE_RPC_URL=...
FANTOM_RPC_URL=...
ZKSYNC_RPC_URL=...
LINEA_RPC_URL=...
ETHEREUM_RPC_URL=...
```
