# Deployment & Testnet Assessment Report

**Date:** 2026-02-25
**Scope:** Complete analysis of contract deployment, testnet configuration, and chain/DEX coverage gaps
**Status:** Assessment only — no code changes made

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Deployment State](#2-current-deployment-state)
3. [Chain-by-Chain Status Matrix](#3-chain-by-chain-status-matrix)
4. [Contract Deployment Gaps](#4-contract-deployment-gaps)
5. [Hardhat Configuration Gaps](#5-hardhat-configuration-gaps)
6. [Emerging L2 DEX Address Research](#6-emerging-l2-dex-address-research)
7. [Solana Implementation Gaps](#7-solana-implementation-gaps)
8. [Infrastructure & Documentation Gaps](#8-infrastructure--documentation-gaps)
9. [Deferred Tasks from Codebase](#9-deferred-tasks-from-codebase)
10. [Complete Action Item Checklist](#10-complete-action-item-checklist)
11. [Recommended Deployment Order](#11-recommended-deployment-order)

---

## 1. Executive Summary

### What Works
- 7 deployment scripts covering all 6 contract types + V3 adapter
- Comprehensive `deployment-utils.ts` library (~1600 lines) with full pipeline
- Pre-deployment validation (`npm run validate:deployment`) covering 8 checks
- Approved routers and token addresses populated for all 10 core EVM chains + 2 testnets
- Docker testnet compose file with simulation mode
- Fly.io configs for 6 services with deploy script

### What's Broken or Missing
- **1 of ~65 possible contract deployments exists** (FlashLoanArbitrage on Arbitrum Sepolia)
- **5 of 11 mainnet chains missing from Hardhat config** (BSC, Polygon, Avalanche, Fantom, Linea)
- **4 emerging L2s have all-zero placeholder DEX addresses** (Blast, Scroll, Mantle, Mode)
- **Per-chain Etherscan API keys not wired** into hardhat config
- **92 `it.todo()` test stubs** for Solana price feed and swap parser
- **No mainnet deployment runbook**, no contract verification guide, no rollback procedures
- **Outdated documentation**: wrong Node.js version, stale hosting provider assignments, missing contract types

### Key Numbers

| Metric | Value |
|--------|-------|
| Total contract types | 6 (FlashLoan, Balancer, PancakeSwap, SyncSwap, CommitReveal, MultiPathQuoter) + V3 Adapter |
| Total target chains (core) | 10 EVM + Solana |
| Total target chains (emerging) | 4 (Blast, Scroll, Mantle, Mode) |
| Deployed contracts | 1 (FlashLoanArbitrage on arbitrumSepolia) |
| Remaining deployments needed | ~64+ contract-chain combinations |
| DEX count | 78 across 15 chains (57 EVM core + 14 emerging + 7 Solana) |
| DEXs with placeholder addresses | 14 (all on emerging L2s) |
| Solana todo tests | 92 |

---

## 2. Current Deployment State

### Registry (`contracts/deployments/registry.json`)

| Network | FlashLoan | Balancer | PancakeSwap | SyncSwap | CommitReveal | MultiPathQuoter |
|---------|:---------:|:--------:|:-----------:|:--------:|:------------:|:---------------:|
| localhost | — | — | — | — | — | — |
| sepolia | — | — | — | — | — | — |
| **arbitrumSepolia** | **0xE5b2...23FB** | — | — | — | — | — |
| baseSepolia | — | — | — | — | — | — |
| zksync-testnet | — | — | — | — | — | — |
| *All mainnets* | — | — | — | — | — | — |

**Deployer:** `0x330E1aF8aF57C7b5D40F73D54825028fC50Bb748`
**Contract verified on block explorer:** No

### Profitability Plan Progress (Phase 7 — IN PROGRESS)

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 0 | COMPLETED | Fix economic parameters |
| Phase 1 | COMPLETED | Fix broken strategies |
| Phase 2 | COMPLETED | Deploy to Arbitrum Sepolia testnet |
| Phase 3 | COMPLETED | Build UniswapV3Adapter |
| Phase 4 | COMPLETED | Fill L2 DEX coverage gaps |
| Phase 5 | COMPLETED (software only) | Balancer V2 flash loan support — **contract not yet deployed** |
| Phase 6 | COMPLETED | Wire real monitoring |
| **Phase 7** | **IN PROGRESS** | **Mainnet deployment** |
| Phase 8 | NOT STARTED | Progressive expansion (post-revenue) |

---

## 3. Chain-by-Chain Status Matrix

### Legend
- READY = Hardhat config + deployment script + protocol addresses all present
- PARTIAL = Some pieces missing
- MISSING = Not configured for deployment
- N/A = Not applicable (non-EVM or protocol not on chain)

### EVM Core Chains (10)

| Chain | ChainID | Hardhat Config | FlashLoan (Aave) | Balancer V2 | PancakeSwap V3 | SyncSwap | V3 Adapter | CommitReveal | MultiPathQuoter | Partition |
|-------|---------|:--------------:|:----------------:|:-----------:|:--------------:|:--------:|:----------:|:------------:|:---------------:|:---------:|
| **Arbitrum** | 42161 | READY | READY | READY | READY | N/A | READY | READY | READY | P2 L2-Turbo |
| **Base** | 8453 | READY | READY | READY | READY | N/A | READY | READY | READY | P2 L2-Turbo |
| **Optimism** | 10 | READY | READY | READY | N/A | N/A | READY | READY | READY | P2 L2-Turbo |
| **zkSync** | 324 | READY | N/A | N/A | READY | READY | N/A | READY | READY | P3 High-Value |
| **Ethereum** | 1 | MISSING (commented out) | READY | READY | READY | N/A | READY | READY | READY | P3 High-Value |
| **BSC** | 56 | **MISSING** | PARTIAL* | N/A | READY | N/A | **MISSING** | READY | READY | P1 Asia-Fast |
| **Polygon** | 137 | **MISSING** | READY | READY | N/A | N/A | READY | READY | READY | P1 Asia-Fast |
| **Avalanche** | 43114 | **MISSING** | READY | N/A | N/A | N/A | **MISSING** | READY | READY | P1 Asia-Fast |
| **Fantom** | 250 | **MISSING** | PARTIAL* | READY (Beethoven X) | N/A | N/A | **MISSING** | READY | READY | P1 Asia-Fast |
| **Linea** | 59144 | **MISSING** | N/A | N/A | READY | PARTIAL** | N/A | READY | READY | P3 High-Value |

*BSC/Fantom: Aave V3 may not have official pool addresses — verify availability.
**Linea SyncSwap: DEFERRED — SyncSwap Vault not yet deployed to Linea mainnet.

### Emerging L2 Chains (4)

| Chain | ChainID | Hardhat Config | DEX Addresses | Flash Loans | Partition | Status |
|-------|---------|:--------------:|:-------------:|:-----------:|:---------:|:------:|
| **Blast** | 81457 | MISSING | ALL PLACEHOLDER | None | NONE | Non-functional |
| **Scroll** | 534352 | MISSING | ALL PLACEHOLDER | SyncSwap (config says yes) | NONE | Non-functional |
| **Mantle** | 5000 | MISSING | ALL PLACEHOLDER | None | NONE | Non-functional |
| **Mode** | 34443 | MISSING | ALL PLACEHOLDER | None | NONE | Non-functional |

### Non-EVM

| Chain | Status | Implementation | Todo Tests |
|-------|--------|:--------------:|:----------:|
| **Solana** | PARTIAL | P4 partition exists, 7 DEX program IDs configured | 92 `it.todo()` stubs |

---

## 4. Contract Deployment Gaps

### What Needs Deploying (Ordered by Priority)

#### Tier 1: Testnet Completeness (Before Mainnet)

| # | Contract | Network | Blocker | Command |
|---|----------|---------|---------|---------|
| 1 | FlashLoanArbitrage | sepolia | None | `npx hardhat run scripts/deploy.ts --network sepolia` |
| 2 | FlashLoanArbitrage | baseSepolia | None | `npx hardhat run scripts/deploy.ts --network baseSepolia` |
| 3 | BalancerV2FlashArbitrage | arbitrumSepolia | Vault may not exist on testnet | `npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia` |
| 4 | MultiPathQuoter | arbitrumSepolia | None | `npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrumSepolia` |
| 5 | CommitRevealArbitrage | arbitrumSepolia | None | `npx hardhat run scripts/deploy-commit-reveal.ts --network arbitrumSepolia` |
| 6 | UniswapV3Adapter | arbitrumSepolia | Needs FlashLoanArbitrage address | `npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrumSepolia` |
| 7 | SyncSwapFlashArbitrage | zksync-testnet | DISABLE_VIA_IR=true required | `DISABLE_VIA_IR=true npx hardhat run scripts/deploy-syncswap.ts --network zksync-testnet` |
| 8 | PancakeSwapFlashArbitrage | arbitrumSepolia | None | `npx hardhat run scripts/deploy-pancakeswap.ts --network arbitrumSepolia` |

#### Tier 2: L2 Mainnet (Phase 7 of Profitability Plan)

| # | Contract | Network | Command |
|---|----------|---------|---------|
| 9 | FlashLoanArbitrage | arbitrum | `npx hardhat run scripts/deploy.ts --network arbitrum` |
| 10 | UniswapV3Adapter | arbitrum | `npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrum` |
| 11 | BalancerV2FlashArbitrage | arbitrum | `npx hardhat run scripts/deploy-balancer.ts --network arbitrum` |
| 12 | MultiPathQuoter | arbitrum | `npx hardhat run scripts/deploy-multi-path-quoter.ts --network arbitrum` |
| 13 | FlashLoanArbitrage | base | `npx hardhat run scripts/deploy.ts --network base` |
| 14 | UniswapV3Adapter | base | `npx hardhat run scripts/deploy-v3-adapter.ts --network base` |
| 15 | BalancerV2FlashArbitrage | base | `npx hardhat run scripts/deploy-balancer.ts --network base` |
| 16 | MultiPathQuoter | base | `npx hardhat run scripts/deploy-multi-path-quoter.ts --network base` |
| 17 | FlashLoanArbitrage | optimism | `npx hardhat run scripts/deploy.ts --network optimism` |
| 18 | UniswapV3Adapter | optimism | `npx hardhat run scripts/deploy-v3-adapter.ts --network optimism` |
| 19 | BalancerV2FlashArbitrage | optimism | `npx hardhat run scripts/deploy-balancer.ts --network optimism` |
| 20 | MultiPathQuoter | optimism | `npx hardhat run scripts/deploy-multi-path-quoter.ts --network optimism` |

#### Tier 3: Additional Chains (Phase 8)

| # | Contract | Network | Blocker |
|---|----------|---------|---------|
| 21 | SyncSwapFlashArbitrage | zksync | DISABLE_VIA_IR=true, zksolc compiler |
| 22 | PancakeSwapFlashArbitrage | zksync | Same |
| 23 | MultiPathQuoter | zksync | Same |
| 24 | CommitRevealArbitrage | zksync | Same |
| 25-28 | All applicable | bsc | Hardhat config needed first |
| 29-32 | All applicable | polygon | Hardhat config needed first |
| 33-36 | All applicable | avalanche | Hardhat config needed first |
| 37-40 | All applicable | fantom | Hardhat config needed first |
| 41-44 | All applicable | linea | Hardhat config needed first |

#### Contract Verification (All Deployments)

The existing `arbitrumSepolia` deployment shows `"verified": false`. After each deployment:

```bash
npx hardhat verify --network <network> <contract-address> <constructor-arg-1> <constructor-arg-2>
```

---

## 5. Hardhat Configuration Gaps

### Networks That Need Adding to `contracts/hardhat.config.ts`

```typescript
// === MISSING: Must add to enable deployment ===

// L1 Mainnet (uncomment when ready)
ethereum: {
  url: process.env.ETHEREUM_RPC_URL || '',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 1,
},

// Asia-Fast Partition Chains
bsc: {
  url: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 56,
},
polygon: {
  url: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 137,
},
avalanche: {
  url: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 43114,
},
fantom: {
  url: process.env.FANTOM_RPC_URL || 'https://rpc.ftm.tools',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 250,
},

// High-Value Partition Addition
linea: {
  url: process.env.LINEA_RPC_URL || 'https://rpc.linea.build',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 59144,
},

// Emerging L2s (when DEX addresses are populated)
blast: {
  url: process.env.BLAST_RPC_URL || 'https://rpc.blast.io',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 81457,
},
scroll: {
  url: process.env.SCROLL_RPC_URL || 'https://rpc.scroll.io',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 534352,
},
mantle: {
  url: process.env.MANTLE_RPC_URL || 'https://rpc.mantle.xyz',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 5000,
},
mode: {
  url: process.env.MODE_RPC_URL || 'https://mainnet.mode.network',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 34443,
},

// Missing Testnets
polygonAmoy: {
  url: process.env.POLYGON_AMOY_RPC_URL || 'https://rpc-amoy.polygon.technology',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 80002,
},
bscTestnet: {
  url: process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545',
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
  chainId: 97,
},
```

### Etherscan Per-Chain API Keys

Currently `hardhat.config.ts` uses a single `ETHERSCAN_API_KEY`. The `.env.example` defines per-chain keys that are NOT wired in:

```
ARBISCAN_API_KEY, BSCSCAN_API_KEY, POLYGONSCAN_API_KEY,
OPTIMISM_ETHERSCAN_API_KEY, BASESCAN_API_KEY, SNOWTRACE_API_KEY,
FTMSCAN_API_KEY, ZKSYNC_ETHERSCAN_API_KEY
```

**Note:** Hardhat-verify with Etherscan V2 uses a single API key. The per-chain keys may be useful if switching to per-chain verification approaches, but for now the single key approach works for V2-supported chains.

---

## 6. Emerging L2 DEX Address Research

### Status: MANUAL RESEARCH REQUIRED

Enterprise network restrictions blocked all web access (DeFiLlama, Blastscan, official docs). The addresses below need to be manually researched and verified.

### 6.1 Blast (Chain ID: 81457) — 4 DEXs

**Current state:** All placeholder addresses (`0x000...0001` through `0x000...0008`)

| DEX | Type | What to Find | Where to Look |
|-----|------|-------------|---------------|
| **Thruster V3** | Concentrated Liquidity (Uni V3 fork) | Factory, SwapRouter | `docs.thruster.finance/resources/contract-addresses`, Blastscan |
| **Thruster V2** | AMM (Uni V2 fork) | Factory, Router | Same as above |
| **BladeSwap** | AMM | Factory, Router | `bladeswap.xyz` docs, Blastscan verified contracts |
| **Ring Protocol** | AMM | Factory, Router | Ring Protocol docs, Blastscan |

**Token addresses (already configured):**
- WETH: `0x4300000000000000000000000000000000000004` (Blast precompile)
- USDB: `0x4300000000000000000000000000000000000003` (Blast native stablecoin)

**Flash loan research:**
- Check if Aave V3 has deployed to Blast
- Check if Juice Finance or Orbit Protocol offer flash loans
- Likely result: No flash loan providers available → cannot deploy flash loan contracts

**Action items:**
- [ ] Look up Thruster V3 Factory and SwapRouter on Blastscan
- [ ] Look up Thruster V2 Factory and Router on Blastscan
- [ ] Verify BladeSwap still exists and is active (may have shut down)
- [ ] Verify Ring Protocol still exists and is active
- [ ] Search for any flash loan protocols on Blast
- [ ] Add BLAST token address if it exists
- [ ] Update `shared/config/src/dexes/index.ts` lines 495-523

### 6.2 Scroll (Chain ID: 534352) — 4 DEXs

**Current state:** All placeholder addresses (`0x000...0009` through `0x000...0010`)

| DEX | Type | What to Find | Where to Look |
|-----|------|-------------|---------------|
| **SyncSwap** | AMM (multi-pool) | Router, Classic Pool Factory, **Vault** (for flash loans!) | `syncswap.xyz/docs`, Scrollscan |
| **SpaceFi** | AMM (Uni V2 fork) | Factory, Router | `spacefi.io` docs, Scrollscan |
| **Ambient (CrocSwap)** | Single-contract DEX | CrocSwapDex address | `docs.ambient.finance`, Scrollscan |
| **Zebra** | AMM | Factory, Router | Scrollscan verified contracts |

**Flash loan research (HIGH PRIORITY):**
- `flash-loan-availability.ts` already marks `scroll.syncswap: true`
- Must find the **SyncSwap Vault address on Scroll** to enable flash loans
- Check if Aave V3 has deployed to Scroll

**Token addresses needed:**
- WETH, USDC, USDT, DAI on Scroll (from Scrollscan token list)

**Action items:**
- [ ] Look up SyncSwap Router, Factory, and **Vault** on Scrollscan
- [ ] Look up SpaceFi Factory and Router on Scrollscan
- [ ] Look up Ambient Finance CrocSwapDex on Scrollscan
- [ ] Verify Zebra still exists (may have rebranded)
- [ ] Get token addresses: WETH, USDC, USDT, DAI
- [ ] Add SyncSwap Vault to `SYNCSWAP_VAULTS` in `shared/config/src/addresses.ts`
- [ ] Update `shared/config/src/dexes/index.ts` lines 527-555
- [ ] Update `shared/config/src/tokens/index.ts` with expanded token list

### 6.3 Mantle (Chain ID: 5000) — 3 DEXs

**Current state:** All placeholder addresses (`0x000...0011` through `0x000...0016`)

| DEX | Type | What to Find | Where to Look |
|-----|------|-------------|---------------|
| **Merchant Moe** | Liquidity Book (Trader Joe V2 fork) | LBRouter, LBFactory | `docs.merchantmoe.com/contracts`, Mantlescan |
| **Agni Finance** | Concentrated Liquidity (Algebra fork) | SwapRouter, Factory | `docs.agni.finance/developers`, Mantlescan |
| **FusionX** | Hybrid AMM | Router V2, SwapRouter V3, Factories | `fusionx.finance` docs, Mantlescan |

**Flash loan research:**
- Check if Lendle (Aave V2 fork on Mantle) offers flash loans
- Check if Init Capital offers flash loans
- Native token is MNT (not ETH) — affects gas calculations

**Token addresses needed:**
- WMNT (Wrapped Mantle), WETH, USDC, USDT, mETH

**Action items:**
- [ ] Look up Merchant Moe LBRouter and LBFactory on Mantlescan
- [ ] Look up Agni Finance SwapRouter and Factory on Mantlescan
- [ ] Look up FusionX Router and Factory on Mantlescan
- [ ] Get token addresses: WMNT, WETH, USDC, USDT, mETH
- [ ] Research Lendle flash loan availability
- [ ] Update `shared/config/src/dexes/index.ts` lines 559-580
- [ ] Update `shared/config/src/tokens/index.ts`
- [ ] Note: Merchant Moe uses LB (Liquidity Book) interface, may need adapter like V3

### 6.4 Mode (Chain ID: 34443) — 3 DEXs

**Current state:** All placeholder addresses (`0x000...0017` through `0x000...001c`)

| DEX | Type | What to Find | Where to Look |
|-----|------|-------------|---------------|
| **Kim Exchange** | Concentrated Liquidity (Algebra fork) | SwapRouter, Factory | Kim Exchange docs, Modescan |
| **SupSwap** | Hybrid AMM | Router V2, SwapRouter V3, Factories | SupSwap docs, Modescan |
| **SwapMode** | AMM (Uni V2 fork) | Factory, Router | SwapMode docs, Modescan |

**Flash loan research:**
- Check if Ironclad Finance (Aave V3 fork) offers flash loans
- If so, get the Pool address

**Token addresses (partially configured):**
- WETH: `0x4200000000000000000000000000000000000006` (already present)
- USDC: `0xd988097fb8612cc24eeC14542bC03424c656005f` (already present)
- Need: USDT, MODE token

**Action items:**
- [ ] Look up Kim Exchange SwapRouter and Factory on Modescan
- [ ] Look up SupSwap Router and Factory on Modescan
- [ ] Look up SwapMode Router and Factory on Modescan
- [ ] Get MODE token address
- [ ] Research Ironclad Finance flash loan availability
- [ ] Update `shared/config/src/dexes/index.ts` lines 584-605
- [ ] Note: Kim Exchange uses Algebra interface (similar to V3), may need adapter

### 6.5 Cross-Cutting: After All Addresses Are Found

- [ ] Add Hardhat network configs for all 4 chains (see Section 5)
- [ ] Assign emerging L2s back to P2 partition in `shared/config/src/partitions.ts`
- [ ] Add approved routers in `contracts/deployments/addresses.ts`
- [ ] Run `npm run typecheck` to verify config changes compile
- [ ] Run DEX config tests: `npm test -- --testPathPattern="dex"`

---

## 7. Solana Implementation Gaps

### 7.1 Test Stubs (92 `it.todo()`)

**File: `shared/core/__tests__/unit/solana/s3.3.4-solana-swap-parser.test.ts`** — 47 todos

| Category | Count | Examples |
|----------|-------|---------|
| Raydium CLMM parsing | 4 | Detect CLMM instructions, parse amounts, tick calculations, pool state |
| Meteora DLMM parsing | 4 | Detect DLMM instructions, bin-based amounts, dynamic pricing, active bins |
| Phoenix orderbook parsing | 5 | Detect new_order, limit fills, market orders, partial fills, order book state |
| Lifinity parsing | 3 | Detect swap instructions, oracle-based amounts, concentrated liquidity |
| Jupiter aggregator | 4 | Identify as aggregator, parse routes, extract DEX hops, prevent double-count |
| Multi-swap parsing | 6 | Single swap, multiple swaps, non-swap instructions, failed txns, ordering |
| SwapEvent conversion | 6 | Convert to SwapEvent, chain field, slot as blockNumber, signature as txHash |
| Error handling | 5 | Malformed data, missing keys, unknown discriminators, error logging, continue |
| Integration | 4 | Account updates, event emission, SwapEventFilter, price update flow |
| Stability | 3 | Protocol upgrades, new instruction versions, backwards compatibility |
| Performance | 3 | <1ms parsing, high-volume streams, memory leak prevention |

**File: `shared/core/__tests__/unit/solana/s3.3.5-solana-price-feed.test.ts`** — 45 todos

| Category | Count | Examples |
|----------|-------|---------|
| Pool subscriptions | 9 | Subscribe Raydium/CLMM/Whirlpool, track count, dedup, unsubscribe, limits |
| Price updates | 8 | Emit on change, required fields, slot number, CLMM fields, staleness |
| Error handling | 6 | RPC errors, WebSocket disconnect, reconnection, parse failures, rate limits |
| Detector integration | 4 | Pool management, price updates, arbitrage checks, Redis stream publishing |
| Price accuracy | 6 | AMM <0.01%, CLMM <0.001%, Whirlpool <0.001%, reference matching, cross-DEX |
| Performance | 5 | <1ms AMM parse, <1ms CLMM parse, <1ms Whirlpool, 100+ concurrent, <10ms latency |
| Layout parsing | 7 | Raydium AMM offsets, CLMM sqrtPrice/tick/liquidity, Whirlpool sqrtPrice/tick |

### 7.2 Solana Deployment Considerations

- Solana uses programs (not EVM contracts) — completely different deployment toolchain
- No Solana deployment scripts exist in the project
- P4 (partition-solana) is a 503-line manual `index.ts` (doesn't use shared factory)
- Jupiter is disabled as a DEX (marked as aggregator, routes through other DEXs)
- Solana flash loans don't exist in the traditional sense — uses atomic swap patterns via Jupiter

### 7.3 Solana Action Items

- [ ] Implement Raydium CLMM swap parser (4 todo tests)
- [ ] Implement Meteora DLMM swap parser (4 todo tests)
- [ ] Implement Phoenix orderbook parser (5 todo tests)
- [ ] Implement Lifinity swap parser (3 todo tests)
- [ ] Implement Jupiter route parser (4 todo tests)
- [ ] Implement multi-swap transaction parsing (6 todo tests)
- [ ] Implement SwapEvent conversion (6 todo tests)
- [ ] Implement error handling (5 todo tests)
- [ ] Implement integration layer (4 todo tests)
- [ ] Implement pool subscription system (9 todo tests)
- [ ] Implement price update pipeline (8 todo tests)
- [ ] Implement price accuracy validation (6 todo tests)
- [ ] Implement layout parsing for on-chain accounts (7 todo tests)
- [ ] Performance testing (8 todo tests)
- [ ] Stability testing (3 todo tests)
- [ ] Research Solana execution strategy (Jupiter CPI vs. direct pool interaction)

---

## 8. Infrastructure & Documentation Gaps

### 8.1 Documentation Issues

| File | Issue | Fix Needed |
|------|-------|------------|
| `docs/deployment.md:50` | Says "Node.js 18+" | Change to "Node.js >= 22.0.0" |
| `docs/deployment.md` | References Upstash as primary Redis | Update to self-hosted Redis 7 recommendation |
| `docs/deployment.md` | Says Coordinator on Koyeb | Update to Fly.io (sjc) per actual configs |
| `docs/deployment.md` | Says Solana partition on Railway | Update to Fly.io (sjc) per actual configs |
| `docs/deployment.md` | "Awaiting testnet deployment" | Update: deployed on arbitrumSepolia |
| `docs/deployment.md` | Only mentions FlashLoanArbitrage | Add sections for Balancer, PancakeSwap, SyncSwap, CommitReveal, V3 Adapter |
| `docs/CONFIGURATION.md` | Last updated 2026-02-05 | Update date and add new feature flags |
| `docs/strategies.md` | Says "49 DEXs" | Update to 78 DEXs |
| `docs/strategies.md` | Says "11 chains" | Update to 15 chains (10 core + 4 emerging + Solana) |
| `.env.example` | Missing `BASE_SEPOLIA_RPC_URL` | Add testnet RPC env var |
| `.env.example` | Missing `POLYGON_AMOY_RPC_URL` | Add testnet RPC env var |
| `.env.example` | Missing `BSC_TESTNET_RPC_URL` | Add testnet RPC env var |

### 8.2 Missing Documentation

| Document | Purpose | Priority |
|----------|---------|----------|
| **Mainnet Deployment Runbook** | Step-by-step mainnet deployment procedure per chain | HIGH |
| **Contract Verification Guide** | How to verify contracts on each chain's block explorer | HIGH |
| **Post-Deployment Verification Checklist** | End-to-end validation after deployment | HIGH |
| **Rollback Procedures** | How to roll back failed service/contract deployments | MEDIUM |
| **Multi-sig/Ownership Transfer Guide** | Transfer contract ownership to multi-sig | MEDIUM |
| **Gas Budget Documentation** | Expected gas costs per chain for deploy + execute | MEDIUM |
| **CI/CD Pipeline Docs** | Automated testing and deployment pipeline | LOW |
| **Disaster Recovery Plan** | Redis data loss, key compromise, contract pause | LOW |

### 8.3 Infrastructure Gaps

| Gap | Description | Impact |
|-----|-------------|--------|
| **No Fly.io config for asia-fast partition** | BSC/Polygon/Avalanche/Fantom have no deployment target | P1 partition can't be deployed |
| **No Fly.io config for cross-chain-detector** | Service exists but can't be deployed to Fly.io | Cross-chain detection unavailable in production |
| **Docker partition chain assignments differ from CURRENT_STATE.md** | `docker-compose.partition.yml` vs `CURRENT_STATE.md` show different chain-to-partition mappings | Confusion about which chains run where |
| **Fly.io deploy.sh only prompts for Upstash Redis** | `deploy.sh` references "Upstash Redis connection URL" | Should reference self-hosted Redis |
| **No batch deployment script** | Must deploy each contract to each chain individually | Tedious, error-prone multi-chain deployment |
| **`generate-addresses.ts` doesn't preserve manual sections** | Generated file loses APPROVED_ROUTERS, TOKEN_ADDRESSES, helpers | Must manually merge after generation |

---

## 9. Deferred Tasks from Codebase

These are explicit TODO/DEFERRED/TBD markers found in source code:

### Configuration (`shared/config/src/`)

| Location | Marker | Description | Blocker |
|----------|--------|-------------|---------|
| `service-config.ts:398` | TODO | Balancer V2 flash loan config for 5 chains (Ethereum, Polygon, Arbitrum, Optimism, Base) | Deploy BalancerV2FlashArbitrage contract first |
| `service-config.ts:454` | DEFERRED (T-NEW-6) | Linea SyncSwap flash loans | SyncSwap Vault not deployed to Linea mainnet |
| `service-config.ts:538` | TODO | Update MultiPathQuoter addresses | Deploy MultiPathQuoter to chains first |
| `addresses.ts:214` | TBD | Linea SyncSwap Vault address | SyncSwap deployment to Linea |
| `dexes/index.ts:491-583` | TODO (5x) | Verify on-chain addresses for Blast, Scroll, Mantle, Mode | Manual research required |
| `mempool-config.ts:99` | TBD | bloXroute BSC mempool support | bloXroute integration |

### Contract Scripts (`contracts/scripts/`)

| Location | Marker | Description |
|----------|--------|-------------|
| `generate-addresses.ts:258` | TODO | Add helper functions to generated output |
| `generate-addresses.ts:259` | TODO | Preserve manual sections (APPROVED_ROUTERS, TOKEN_ADDRESSES) |

### Deploy Script Gaps (`contracts/scripts/deploy-v3-adapter.ts`)

| Chain | SwapRouter | QuoterV2 | Status |
|-------|-----------|----------|--------|
| Ethereum | Has address | Has address | Ready |
| Arbitrum | Has address | Has address | Ready |
| Optimism | Has address | Has address | Ready |
| Polygon | Has address | Has address | Ready |
| Base | Has address | Has address | Ready |
| Sepolia | Has address | Zero address (no QuoterV2) | Partial |
| Arbitrum Sepolia | Has address | Zero address (no QuoterV2) | Partial |
| **BSC** | **Not configured** | **Not configured** | Missing |
| **Avalanche** | **Not configured** | **Not configured** | Missing |
| **Fantom** | **Not configured** | **Not configured** | Missing |
| **Linea** | **Not configured** | **Not configured** | Missing |
| **zkSync** | **Not applicable** (uses SyncSwap) | N/A | N/A |

---

## 10. Complete Action Item Checklist

### Phase A: Fix Configuration & Documentation (No Deployment Required)

- [ ] **A.1** Add 5 missing mainnet chains to `hardhat.config.ts` (BSC, Polygon, Avalanche, Fantom, Linea)
- [ ] **A.2** Add missing testnet chains to `hardhat.config.ts` (polygonAmoy, bscTestnet)
- [ ] **A.3** Uncomment Ethereum mainnet in `hardhat.config.ts` (when ready)
- [ ] **A.4** Add missing testnet RPC vars to `.env.example` (BASE_SEPOLIA_RPC_URL, POLYGON_AMOY_RPC_URL, BSC_TESTNET_RPC_URL)
- [ ] **A.5** Add missing networks to `contracts/deployments/registry.json` (bsc, polygon, avalanche, fantom, linea, ethereum + their testnets)
- [ ] **A.6** Fix `docs/deployment.md` — Node.js version, hosting providers, contract types, Redis strategy
- [ ] **A.7** Update `docs/CONFIGURATION.md` date and new feature flags
- [ ] **A.8** Update `docs/strategies.md` — DEX and chain counts
- [ ] **A.9** Add BSC/Avalanche/Fantom/Linea SwapRouter addresses to `deploy-v3-adapter.ts`
- [ ] **A.10** Fix `generate-addresses.ts` to preserve manual sections

### Phase B: Research Emerging L2 DEX Addresses (Manual)

- [ ] **B.1** Research Blast DEX addresses (Thruster V3, Thruster V2, BladeSwap, Ring Protocol)
- [ ] **B.2** Research Scroll DEX addresses (SyncSwap + Vault, SpaceFi, Ambient, Zebra)
- [ ] **B.3** Research Mantle DEX addresses (Merchant Moe, Agni Finance, FusionX)
- [ ] **B.4** Research Mode DEX addresses (Kim Exchange, SupSwap, SwapMode)
- [ ] **B.5** Research flash loan availability on all 4 emerging L2s
- [ ] **B.6** Populate token addresses for emerging L2s
- [ ] **B.7** Update `dexes/index.ts` with real addresses
- [ ] **B.8** Add emerging L2s to Hardhat config
- [ ] **B.9** Add approved routers for emerging L2s in `addresses.ts`
- [ ] **B.10** Re-assign emerging L2s to a partition (P2 or new)

### Phase C: Complete Testnet Deployments

- [ ] **C.1** Deploy FlashLoanArbitrage to sepolia
- [ ] **C.2** Deploy FlashLoanArbitrage to baseSepolia
- [ ] **C.3** Deploy MultiPathQuoter to arbitrumSepolia
- [ ] **C.4** Deploy CommitRevealArbitrage to arbitrumSepolia
- [ ] **C.5** Deploy UniswapV3Adapter to arbitrumSepolia
- [ ] **C.6** Deploy PancakeSwapFlashArbitrage to arbitrumSepolia
- [ ] **C.7** Attempt BalancerV2FlashArbitrage on arbitrumSepolia (may fail if Vault not on testnet)
- [ ] **C.8** Deploy SyncSwapFlashArbitrage to zksync-testnet (with DISABLE_VIA_IR=true)
- [ ] **C.9** Verify ALL deployed contracts on block explorers
- [ ] **C.10** Update `registry.json` and `addresses.ts` after each deployment
- [ ] **C.11** Run end-to-end test on testnet with SIMULATION_MODE=false

### Phase D: Mainnet Deployment (Phase 7 of Profitability Plan)

- [ ] **D.1** Complete pre-deployment checklist (Section 7.1 of profitability plan)
- [ ] **D.2** Deploy FlashLoanArbitrage to Arbitrum mainnet
- [ ] **D.3** Deploy UniswapV3Adapter to Arbitrum mainnet
- [ ] **D.4** Deploy BalancerV2FlashArbitrage to Arbitrum mainnet
- [ ] **D.5** Deploy MultiPathQuoter to Arbitrum mainnet
- [ ] **D.6** Verify all contracts on Arbiscan
- [ ] **D.7** Uncomment Balancer V2 flash loan config in `service-config.ts` for Arbitrum
- [ ] **D.8** Update MultiPathQuoter address in `service-config.ts`
- [ ] **D.9** Fund deployer wallet with gas (0.01-0.05 ETH on Arbitrum)
- [ ] **D.10** Test live with SIMULATION_MODE=false on Arbitrum
- [ ] **D.11** Repeat D.2-D.10 for Base mainnet
- [ ] **D.12** Repeat D.2-D.10 for Optimism mainnet

### Phase E: Extended Chain Deployment (Phase 8)

- [ ] **E.1** Deploy applicable contracts to zkSync (SyncSwap, PancakeSwap, CommitReveal, MultiPathQuoter)
- [ ] **E.2** Deploy applicable contracts to BSC (PancakeSwap, CommitReveal, MultiPathQuoter)
- [ ] **E.3** Deploy applicable contracts to Polygon (FlashLoan, Balancer, CommitReveal, MultiPathQuoter, V3Adapter)
- [ ] **E.4** Deploy applicable contracts to Avalanche (FlashLoan, CommitReveal, MultiPathQuoter)
- [ ] **E.5** Deploy applicable contracts to Fantom (Balancer/Beethoven X, CommitReveal, MultiPathQuoter)
- [ ] **E.6** Deploy applicable contracts to Linea (PancakeSwap, CommitReveal, MultiPathQuoter)
- [ ] **E.7** Deploy applicable contracts to Ethereum mainnet (all types — highest gas, do last)
- [ ] **E.8** Deploy to emerging L2s after Phase B completes

### Phase F: Solana Implementation

- [ ] **F.1** Implement Solana swap parser for all 5 DEX protocols (47 todo tests)
- [ ] **F.2** Implement Solana price feed system (45 todo tests)
- [ ] **F.3** Define Solana execution strategy (Jupiter CPI vs direct pool interaction)
- [ ] **F.4** Test P4 partition with Solana devnet
- [ ] **F.5** Deploy P4 to Fly.io with Solana mainnet-beta

### Phase G: Infrastructure Completeness

- [ ] **G.1** Create Fly.io config for asia-fast partition
- [ ] **G.2** Create Fly.io config for cross-chain-detector
- [ ] **G.3** Reconcile docker-compose partition chain assignments with CURRENT_STATE.md
- [ ] **G.4** Update Fly.io deploy.sh Redis reference to self-hosted
- [ ] **G.5** Write mainnet deployment runbook
- [ ] **G.6** Write contract verification guide
- [ ] **G.7** Write post-deployment verification checklist
- [ ] **G.8** Create batch deployment script for multi-chain deployment
- [ ] **G.9** Document ownership transfer to multi-sig procedure

---

## 11. Recommended Deployment Order

### Quick Reference: What to Do Per Chain

#### V2-Compatible DEXs (Use FlashLoanArbitrage or BalancerV2FlashArbitrage directly)

These DEXs work with the existing V2 router interface — no adapter needed:

| Chain | V2 DEXs | Flash Loan Provider |
|-------|---------|-------------------|
| Ethereum | Uniswap V2, SushiSwap | Aave V3 → switch to Balancer V2 (0% fee) |
| Arbitrum | SushiSwap, Camelot | Aave V3 → switch to Balancer V2 (0% fee) |
| Base | BaseSwap, Aerodrome | Aave V3 → switch to Balancer V2 (0% fee) |
| BSC | PancakeSwap V2, Biswap | Aave V3 (need to verify pool exists) |
| Polygon | QuickSwap, SushiSwap | Aave V3 → switch to Balancer V2 (0% fee) |
| Optimism | Velodrome | Aave V3 → switch to Balancer V2 (0% fee) |
| Avalanche | Trader Joe, SushiSwap | Aave V3 |
| Fantom | SpookySwap, SpiritSwap, SushiSwap | Beethoven X (Balancer V2, 0% fee) — already configured |
| zkSync | SyncSwap | SyncSwap Vault (EIP-3156, 0.3% fee) |
| Linea | Lynex | PancakeSwap V3 (when SyncSwap Vault deploys, switch) |

#### V3-Compatible DEXs (Require UniswapV3Adapter)

These DEXs use concentrated liquidity — need V3 adapter deployed first:

| Chain | V3 DEXs | Adapter Address Configured |
|-------|---------|:-------------------------:|
| Ethereum | Uniswap V3 | Yes |
| Arbitrum | Uniswap V3, Camelot V3 | Yes |
| Base | Uniswap V3, Aerodrome V3, Maverick | Yes |
| Polygon | Uniswap V3, QuickSwap V3 | Yes |
| Optimism | Uniswap V3 | Yes |
| BSC | PancakeSwap V3 | **No — needs SwapRouter address** |
| Avalanche | (none with V3 interface) | N/A |
| Fantom | (none with V3 interface) | N/A |
| Linea | PancakeSwap V3 | **No — needs SwapRouter address** |
| zkSync | PancakeSwap V3 | N/A (different VM) |

#### Solana DEXs (Completely Different Stack)

| DEX | Protocol | Interface | Status |
|-----|----------|-----------|--------|
| Raydium AMM | V2-style pool | Custom Solana program | Configured, detection TBD |
| Raydium CLMM | Concentrated liquidity | Custom Solana program | 4 todo tests |
| Orca Whirlpool | Concentrated liquidity | Custom Solana program | Configured, detection TBD |
| Meteora DLMM | Bin-based liquidity | Custom Solana program | 4 todo tests |
| Phoenix | Order book | Custom Solana program | 5 todo tests |
| Lifinity | Oracle-based | Custom Solana program | 3 todo tests |

### Deployment Sequence (Critical Path)

```
Phase A (Config fixes) ──────────────────────────► Can be done immediately
                                                    │
Phase B (DEX address research) ──────────────────► Can be done in parallel
                                                    │
Phase C (Testnet deployments) ◄─────────────────── Depends on A
    │
    ├── C.1-C.2: FlashLoan to sepolia + baseSepolia
    ├── C.3-C.6: Other contracts to arbitrumSepolia
    ├── C.8: SyncSwap to zksync-testnet
    └── C.9-C.11: Verify + E2E test
         │
Phase D (L2 Mainnet) ◄──────────────────────────── Depends on C
    │
    ├── D.2-D.6: Arbitrum mainnet (FIRST)
    ├── D.10: Live test on Arbitrum
    ├── D.11: Base mainnet (SECOND)
    └── D.12: Optimism mainnet (THIRD)
         │
Phase E (Extended chains) ◄──────────────────────── Depends on D + B
    │
    ├── E.1: zkSync
    ├── E.2: BSC
    ├── E.3: Polygon
    ├── E.4-E.6: Avalanche, Fantom, Linea
    ├── E.7: Ethereum (LAST — highest gas)
    └── E.8: Emerging L2s
         │
Phase F (Solana) ◄───────────────────────────────── Independent track
Phase G (Infrastructure) ◄──────────────────────── Parallel with all phases
```

---

## Appendix: Files Reference

### Primary Config Files to Modify

| File | What It Controls |
|------|-----------------|
| `contracts/hardhat.config.ts` | Network definitions for deployment |
| `shared/config/src/dexes/index.ts` | DEX factory + router addresses per chain |
| `shared/config/src/addresses.ts` | Protocol addresses (Aave, Balancer, SyncSwap, tokens) |
| `shared/config/src/flash-loan-availability.ts` | Which flash loan protocols are available per chain |
| `shared/config/src/service-config.ts` | Flash loan provider selection + MultiPathQuoter addresses |
| `shared/config/src/partitions.ts` | Chain-to-partition assignments |
| `contracts/deployments/registry.json` | Deployment tracking (auto-updated by scripts) |
| `contracts/deployments/addresses.ts` | Deployed contract addresses + approved routers + tokens |
| `contracts/scripts/deploy-v3-adapter.ts` | V3 SwapRouter addresses per chain (hardcoded) |
| `.env.example` | Environment variable template |

### Deployment Scripts

| Script | Contract | Run With |
|--------|----------|----------|
| `contracts/scripts/deploy.ts` | FlashLoanArbitrage (Aave V3) | `npx hardhat run scripts/deploy.ts --network <chain>` |
| `contracts/scripts/deploy-balancer.ts` | BalancerV2FlashArbitrage | `npx hardhat run scripts/deploy-balancer.ts --network <chain>` |
| `contracts/scripts/deploy-pancakeswap.ts` | PancakeSwapFlashArbitrage | `npx hardhat run scripts/deploy-pancakeswap.ts --network <chain>` |
| `contracts/scripts/deploy-syncswap.ts` | SyncSwapFlashArbitrage | `DISABLE_VIA_IR=true npx hardhat run scripts/deploy-syncswap.ts --network <chain>` |
| `contracts/scripts/deploy-commit-reveal.ts` | CommitRevealArbitrage | `npx hardhat run scripts/deploy-commit-reveal.ts --network <chain>` |
| `contracts/scripts/deploy-multi-path-quoter.ts` | MultiPathQuoter | `npx hardhat run scripts/deploy-multi-path-quoter.ts --network <chain>` |
| `contracts/scripts/deploy-v3-adapter.ts` | UniswapV3Adapter | `npx hardhat run scripts/deploy-v3-adapter.ts --network <chain>` |

### Validation Commands

```bash
npm run validate:deployment     # Pre-deploy checks (Redis, RPC, contracts, gas)
npm run validate:mev-setup      # MEV config for all chains
npm run validate:routers        # On-chain router approval verification
npm run typecheck               # TypeScript compilation
cd contracts && npx hardhat test  # Contract test suite
npm test                        # Full service test suite
```
