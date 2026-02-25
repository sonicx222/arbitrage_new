# Contract Verification Guide

> **Last Updated:** 2026-02-25
> **Applies to:** All 7 contract types across all EVM chains

---

## Table of Contents

1. [Overview](#1-overview)
2. [Automatic Verification](#2-automatic-verification)
3. [Manual Verification](#3-manual-verification)
4. [Constructor Arguments Reference](#4-constructor-arguments-reference)
5. [Chain-Specific Notes](#5-chain-specific-notes)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Overview

Contract verification publishes the Solidity source code on block explorers (Etherscan, Arbiscan, etc.), allowing anyone to read and audit the deployed code. This project uses **Etherscan V2**, which requires a single API key from [etherscan.io](https://etherscan.io) that works across all supported chains.

### Prerequisites

```bash
# Set in .env.local
ETHERSCAN_API_KEY=your_etherscan_v2_api_key
```

Get a free API key at https://etherscan.io/myapikey. The V2 key works for Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, Avalanche, Fantom, and Linea.

---

## 2. Automatic Verification

The deployment pipeline (`deployContractPipeline`) automatically attempts verification after each deployment with:

- **Network-adaptive delays** before verification (block explorer indexing time):
  - L2s (Arbitrum, Base, Optimism, BSC): 10 seconds
  - zkSync, Linea: 15 seconds
  - Ethereum L1: 30 seconds
  - Testnets: 20 seconds
- **Exponential backoff retries**: Up to 3 attempts with 10s, 20s, 40s delays
- **"Already Verified" handling**: Treated as success (idempotent)

If automatic verification succeeds, the `_verified` field in `registry.json` is set to `true`.

---

## 3. Manual Verification

If automatic verification fails, verify manually:

```bash
cd contracts
npx hardhat verify --network <network> <contractAddress> <constructorArg1> <constructorArg2> ...
```

### Examples

```bash
# FlashLoanArbitrage on Arbitrum
npx hardhat verify --network arbitrum \
  0xDEPLOYED_ADDRESS \
  0xAaveV3PoolAddress \
  0xDeployerAddress

# BalancerV2FlashArbitrage on Arbitrum
npx hardhat verify --network arbitrum \
  0xDEPLOYED_ADDRESS \
  0xBalancerVaultAddress \
  0xDeployerAddress

# MultiPathQuoter (no constructor args)
npx hardhat verify --network arbitrum \
  0xDEPLOYED_ADDRESS

# UniswapV3Adapter (4 args)
npx hardhat verify --network arbitrum \
  0xDEPLOYED_ADDRESS \
  0xV3SwapRouterAddress \
  0xQuoterV2Address \
  0xDeployerAddress \
  3000
```

### Finding Constructor Arguments

Constructor arguments are saved in the per-deployment JSON files:

```bash
# Check the deployment record
cat contracts/deployments/arbitrum-FlashLoanArbitrage.json | jq '.constructorArgs'
```

Or look them up in `registry.json`:

```bash
cat contracts/deployments/registry.json | jq '.arbitrum'
```

---

## 4. Constructor Arguments Reference

| Contract | Constructor Signature | Args |
|----------|----------------------|------|
| **FlashLoanArbitrage** | `(address _pool, address _owner)` | Aave V3 Pool address, deployer |
| **BalancerV2FlashArbitrage** | `(address _vault, address _owner)` | Balancer V2 Vault address, deployer |
| **PancakeSwapFlashArbitrage** | `(address _factory, address _owner)` | PancakeSwap V3 Factory address, deployer |
| **SyncSwapFlashArbitrage** | `(address _vault, address _owner)` | SyncSwap Vault address, deployer |
| **DaiFlashMintArbitrage** | `(address _dssFlash, address _dai, address _owner)` | DssFlash address, DAI token address, deployer |
| **CommitRevealArbitrage** | `(address _owner)` | deployer (or designated owner) |
| **MultiPathQuoter** | none | (no constructor arguments) |
| **UniswapV3Adapter** | `(address _v3Router, address _quoter, address _owner, uint24 _defaultFee)` | SwapRouter, QuoterV2, deployer, 3000 |

### Protocol Addresses Per Chain

Protocol addresses for constructor args are sourced from `@arbitrage/config`:

| Protocol | Config Import | Used By |
|----------|--------------|---------|
| Aave V3 Pool | `AAVE_V3_POOLS[chain]` | FlashLoanArbitrage |
| Balancer V2 Vault | `BALANCER_V2_VAULTS[chain]` | BalancerV2FlashArbitrage |
| PancakeSwap V3 Factory | `PANCAKESWAP_V3_FACTORIES[chain]` | PancakeSwapFlashArbitrage |
| SyncSwap Vault | `SYNCSWAP_VAULTS[chain]` | SyncSwapFlashArbitrage |

To look up the exact address:

```bash
cd contracts
npx hardhat console --network arbitrum
> const { AAVE_V3_POOLS } = require('@arbitrage/config')
> console.log(AAVE_V3_POOLS.arbitrum)
```

---

## 5. Chain-Specific Notes

### Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, Avalanche, Fantom, Linea

Standard Etherscan V2 verification. No special handling needed.

```bash
npx hardhat verify --network <chain> <address> <args...>
```

### zkSync Era

zkSync uses a custom compiler (`zksolc`) and a different verification endpoint.

- **Compiler**: Requires `DISABLE_VIA_IR=true` during compilation (set automatically by deploy scripts)
- **Verification delay**: 15 seconds (longer than standard L2s)
- **Block explorer**: https://explorer.zksync.io (not Etherscan)
- **API key**: May require a separate `ZKSYNC_ETHERSCAN_API_KEY`

```bash
# zkSync verification
DISABLE_VIA_IR=true npx hardhat verify --network zksync <address> <args...>
```

### Testnets

Testnet verification uses the same command with testnet network names:

```bash
npx hardhat verify --network sepolia <address> <args...>
npx hardhat verify --network arbitrumSepolia <address> <args...>
npx hardhat verify --network baseSepolia <address> <args...>
```

---

## 6. Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `ETHERSCAN_API_KEY not set` | Missing API key | Set `ETHERSCAN_API_KEY` in `.env.local` |
| `Contract source code already verified` | Already verified | No action needed — this is success |
| `Bytecode not found at address` | Block explorer hasn't indexed yet | Wait 30-60 seconds and retry |
| `Unable to verify` with timeout | Rate limited or network issue | Retry with `--force` flag |
| `Constructor arguments do not match` | Wrong args passed | Check deployment record in `contracts/deployments/*.json` |
| `Compiler version mismatch` | hardhat.config solc version differs | Ensure `solidity.version` in config matches what was used to deploy |

### Retry Command

```bash
# Force re-verification attempt
npx hardhat verify --force --network <chain> <address> <args...>
```

### Verify All Unverified Contracts

Check which contracts need verification:

```bash
# List unverified deployments
cat contracts/deployments/registry.json | jq 'to_entries[] | select(.value != null) | {network: .key, verified: .value.verified}'
```
