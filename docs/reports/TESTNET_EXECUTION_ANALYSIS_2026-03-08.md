# Testnet Execution with Simulated Prices: Deep Dive Analysis

**Date**: 2026-03-08
**Status**: Analysis Complete - Implementation Pending
**Scope**: All services running `SIMULATION_MODE=true` (simulated prices) with real testnet transaction execution

---

## Executive Summary

The system already has three independent mode flags controlling price simulation vs execution simulation. The architecture cleanly decouples price sources from execution targets via Redis Streams. Running simulated prices against real testnet execution requires closing **7 concrete gaps** across configuration, chain name normalization, token/router address mapping, and contract deployment. Estimated effort: ~200-300 lines of new code across 4-5 files, no architectural changes.

---

## Current State

### Three Independent Mode Flags

| Flag | Controls | Current Default |
|------|----------|-----------------|
| `SIMULATION_MODE=true` | Price/event generation (simulator vs real WebSocket) | `true` |
| `EXECUTION_SIMULATION_MODE=true` | Transaction submission (mock vs real blockchain) | `true` |
| `EXECUTION_HYBRID_MODE=false` | Real strategy logic + mocked tx submission | `false` |

### Target Configuration (New Combination)

```
SIMULATION_MODE=true                -> Simulated prices (keep)
EXECUTION_SIMULATION_MODE=false     -> Real transactions (change)
EXECUTION_HYBRID_MODE=false         -> Full real execution (not mocked)
+ Testnet RPCs + Testnet wallets    -> Target testnets
```

### Mode Utilities

All mode detection is centralized in `shared/core/src/simulation/mode-utils.ts`:
- `isSimulationMode()` - checks `SIMULATION_MODE === 'true'`
- `isExecutionSimulationMode()` - checks `EXECUTION_SIMULATION_MODE === 'true'`
- `isHybridExecutionMode()` - checks `EXECUTION_HYBRID_MODE === 'true'`
- `getSimulationModeSummary()` - returns effective mode for logging

### Architecture Advantage

The price pipeline is already decoupled from execution:
- `ChainSimulator` publishes to the same Redis Streams as real WebSocket feeds
- Coordinator routes opportunities identically regardless of price source
- Execution engine doesn't know or care where prices originated
- Strategy factory routes based on opportunity type, not data source

---

## Simulation System Architecture

### Two Distinct "Simulation" Concepts

1. **SimulationStrategy** (Dev/Test Mode) - `simulation.strategy.ts`
   - Replaces real execution entirely, returns mock results
   - Controlled by `EXECUTION_SIMULATION_MODE`
   - Does NOT send transactions

2. **ISimulationService** (Pre-flight Transaction Simulation) - `services/simulation/`
   - Validates transaction will succeed BEFORE submitting to mempool
   - Providers: Tenderly, Alchemy, Local (Anvil)
   - Used in production alongside real execution

### Price Simulation Components

Located in `shared/core/src/simulation/`:

| File | Purpose |
|------|---------|
| `mode-utils.ts` (85 lines) | Environment-based mode detection |
| `constants.ts` (400+ lines) | Token prices, DEX mappings, bridge costs, chain-specific pairs |
| `chain-simulator.ts` (600+ lines) | Per-chain simulator with market regime model |
| `price-simulator.ts` (235 lines) | Global price feed generator with Brownian motion |
| `cross-chain-simulator.ts` (300+ lines) | Cross-chain spread detection |
| `throughput-profiles.ts` (400+ lines) | Per-chain block times, gas models |
| `types.ts` (400+ lines) | All simulation type definitions |

### Execution Strategy Factory

`services/execution-engine/src/strategies/strategy-factory.ts` routes strategies:

```
Priority 1: SimulationStrategy (if EXECUTION_SIMULATION_MODE=true && !HYBRID)
Priority 2: FlashLoanStrategy (if type=flash-loan/triangular/quadrilateral)
Priority 2.5: BackrunStrategy (if type=backrun)
Priority 2.6: UniswapXStrategy (if type=uniswapx)
Priority 3: SolanaStrategy (if type=solana or chain=solana)
Priority 4: CrossChainStrategy (if type=cross-chain or buyChain != sellChain)
Priority 5: IntraChainStrategy (default)
```

When `EXECUTION_SIMULATION_MODE=false`, the factory skips SimulationStrategy and routes to real strategies.

---

## Identified Gaps (7 Total)

### Gap 1: Price Verification Rejects Simulated Opportunities

**Location**: `services/execution-engine/src/strategies/base.strategy.ts:920-974`
**Called by**: `IntraChainStrategy` (line 133), `FlashLoanStrategy` (line 599)

`verifyOpportunityPrices()` checks:
1. Opportunity age vs `opportunityTimeoutMs` - OK (simulator sets recent timestamps)
2. `expectedProfit < minProfitThreshold * 1.2` - PROBLEM
3. `confidence < minConfidenceThreshold` - OK (simulator sets reasonable confidence)

**Problem**: Simulated profits assume mainnet token prices ($3200 ETH, $1 USDC). Testnet tokens have no real value. The profit threshold check becomes meaningless and may incorrectly pass/fail.

**Impact**: HIGH - Blocks all real strategy execution

### Gap 2: Chain Name Mismatch (Most Pervasive)

**Problem**: Simulator generates opportunities with mainnet chain names (`ethereum`, `arbitrum`, `base`, `zksync`). The EE needs to resolve:
- Testnet contract addresses (keyed by `sepolia`, `arbitrumSepolia`)
- Testnet token addresses (keyed by `sepolia`, `arbitrumSepolia`)
- Testnet router addresses (keyed by `sepolia`, `arbitrumSepolia`)

Existing utilities: `normalizeChainName()` in `contracts/deployments/addresses.ts`, `isTestnet()` in `shared/types/src/chains.ts` - but NOT wired into the EE pipeline.

**Impact**: HIGH - All address lookups fail silently

### Gap 3: Token Address Mapping

**Problem**: Simulator generates opportunities with mainnet token addresses (e.g., WETH Ethereum = `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`). Testnet execution needs testnet addresses (e.g., WETH Sepolia = `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`).

Token addresses baked into:
- `shared/core/src/simulation/constants.ts` - `CHAIN_SPECIFIC_PAIRS`
- `shared/core/src/simulation/chain-simulator.ts` - opportunity generation

Testnet token addresses available in `contracts/deployments/addresses.ts`:
```
TOKEN_ADDRESSES.sepolia = { WETH: '0xfFf...', USDC: '0x94a...', DAI: '0xFF3...' }
TOKEN_ADDRESSES.arbitrumSepolia = { WETH: '0x980...', USDC: '0x75f...' }
TOKEN_ADDRESSES.baseSepolia = { WETH: '0x420...', USDC: '0x036...' }
TOKEN_ADDRESSES['zksync-testnet'] = { WETH: '0x701...', USDC: '0xAe0...' }
```

**Impact**: HIGH - Swaps attempt to trade non-existent tokens

### Gap 4: DEX Router Address Resolution

**Problem**: `prepareDexSwapTransaction()` in `base.strategy.ts` resolves router addresses from `DEXES` config, which contains mainnet addresses. Testnet DEXes live at different addresses.

Available testnet routers (from `contracts/deployments/addresses.ts`):
```
APPROVED_ROUTERS.sepolia = ['0xC532...']            // Uniswap V2
APPROVED_ROUTERS.arbitrumSepolia = ['0x101F...', '0x1A98...']  // V2 + V3
APPROVED_ROUTERS.baseSepolia = ['0x1689...']         // Uniswap V2
APPROVED_ROUTERS['zksync-testnet'] = ['0x3f39...']   // SyncSwap
```

**Impact**: HIGH - Swap calldata targets wrong router addresses

### Gap 5: Flash Loan Contract Resolution

**Problem**: FlashLoanStrategy needs deployed contract addresses per chain. Testnet addresses exist but are keyed by testnet chain names.

Available testnet contracts:
```
FLASH_LOAN_CONTRACT_ADDRESSES.sepolia = '0x2f09...'
FLASH_LOAN_CONTRACT_ADDRESSES.arbitrumSepolia = '0xE5b2...'
PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES.arbitrumSepolia = '0x7C5b...'
SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES['zksync-testnet'] = '0x2f09...'
```

**Impact**: MEDIUM - Flash loan execution fails, but intra-chain still works

### Gap 6: Missing Testnet Contract Deployments

Current deployment status:

| Chain | FlashLoanArbitrage | PancakeSwap | CommitReveal | MultiPathQuoter | SyncSwap |
|-------|-------------------|-------------|--------------|-----------------|----------|
| Sepolia | 0x2f09... | - | 0xb384... | 0xE5b2... | - |
| Arb Sepolia | 0xE5b2... | 0x7C5b... | 0x9EA7... | 0xA998... | - |
| Base Sepolia | **MISSING** | - | - | - | - |
| zkSync Sepolia | - | - | - | - | 0x2f09... |

**Impact**: MEDIUM - Base Sepolia flash loans unavailable

### Gap 7: Docker Compose Testnet Config

`infrastructure/docker/docker-compose.testnet.yml` doesn't expose `EXECUTION_SIMULATION_MODE` separately from `SIMULATION_MODE`. Both are tied to the same env var:
```yaml
- SIMULATION_MODE=${SIMULATION_MODE:-true}
```

EE needs separate control:
```yaml
- SIMULATION_MODE=${SIMULATION_MODE:-true}
- EXECUTION_SIMULATION_MODE=${EXECUTION_SIMULATION_MODE:-true}
- TESTNET_EXECUTION_MODE=${TESTNET_EXECUTION_MODE:-false}
```

**Impact**: LOW - Only affects Docker deployment

---

## Step-by-Step Implementation Plan

### Phase 1: Configuration & Environment (No Code Changes)

#### Step 1: Create `.env.testnet.live` configuration

```env
# Price simulation ON (no real WebSocket feeds)
SIMULATION_MODE=true
SIMULATION_REALISM_LEVEL=medium
SIMULATION_VOLATILITY=0.02
SIMULATION_UPDATE_INTERVAL_MS=5000

# Real execution ON (actual testnet transactions)
EXECUTION_SIMULATION_MODE=false
EXECUTION_HYBRID_MODE=false

# NEW: Testnet execution mode flag
TESTNET_EXECUTION_MODE=true

# Testnet RPCs
ETHEREUM_RPC_URL=https://sepolia.infura.io/v3/<KEY>
ARBITRUM_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
BASE_RPC_URL=https://sepolia.base.org
ZKSYNC_RPC_URL=https://sepolia.era.zksync.dev

# WebSocket URLs (needed by EE provider init even if detectors use simulation)
ETHEREUM_WS_URL=wss://ethereum-sepolia-rpc.publicnode.com
ARBITRUM_WS_URL=wss://sepolia-rollup.arbitrum.io/ws

# Testnet wallet (NEVER use mainnet keys)
WALLET_MNEMONIC=<testnet-only-mnemonic>
# OR per-chain private keys:
ETHEREUM_PRIVATE_KEY=0x<testnet-pk>
ARBITRUM_PRIVATE_KEY=0x<testnet-pk>

# Disable MEV (Flashbots Sepolia support is limited)
MEV_PROTECTION_ENABLED=false

# Risk management - relaxed for testnet
RISK_MANAGEMENT_ENABLED=false

# Reduce concurrency for testnet (avoid nonce conflicts)
MAX_CONCURRENT_EXECUTIONS=1
```

#### Step 2: Fund testnet wallets

Faucet sources:
- Sepolia ETH: sepoliafaucet.com, Alchemy faucet, Google Cloud faucet
- Arbitrum Sepolia: Bridge from Sepolia or Arbitrum faucet
- Base Sepolia: Bridge from Sepolia
- zkSync Sepolia: Bridge from Sepolia

Also need test ERC20 tokens (WETH, USDC) on each chain.

### Phase 2: Core Code Changes

#### Step 3: Add `TESTNET_EXECUTION_MODE` flag + relax price verification

**File**: `shared/core/src/simulation/mode-utils.ts`
- Add `isTestnetExecutionMode(): boolean` checking `TESTNET_EXECUTION_MODE === 'true'`
- Update `getSimulationModeSummary()` to include testnet mode

**File**: `services/execution-engine/src/strategies/base.strategy.ts:920-974`
- When `TESTNET_EXECUTION_MODE=true`, skip profit threshold and confidence checks
- Still check opportunity age (staleness)

#### Step 4: Add chain name normalization in EE

**New file**: `services/execution-engine/src/utils/chain-resolver.ts`

```typescript
export function resolveExecutionChain(detectorChain: string): string {
  if (process.env.TESTNET_EXECUTION_MODE !== 'true') return detectorChain;

  const mapping: Record<string, string> = {
    ethereum: 'sepolia',
    arbitrum: 'arbitrumSepolia',
    base: 'baseSepolia',
    zksync: 'zksync-testnet',
  };
  return mapping[detectorChain] ?? detectorChain;
}
```

**File**: `services/execution-engine/src/execution-pipeline.ts`
- Apply `resolveExecutionChain()` at the entry point before strategy dispatch

#### Step 5: Add token address mainnet-to-testnet mapper

**New file**: `services/execution-engine/src/utils/testnet-token-mapper.ts`

Build mapping from existing `TOKEN_ADDRESSES` in `contracts/deployments/addresses.ts`:
```
mainnet WETH (ethereum) -> testnet WETH (sepolia)
mainnet USDC (ethereum) -> testnet USDC (sepolia)
... per chain
```

Apply in execution pipeline when `TESTNET_EXECUTION_MODE=true`.

#### Step 6: Wire testnet DEX router addresses into config

**File**: `shared/config/src/dex-registry.ts` (or equivalent)
- Add testnet chain entries with testnet router addresses
- Use data from `APPROVED_ROUTERS` in `contracts/deployments/addresses.ts`

Alternatively, add a router address resolver in the EE that checks testnet addresses when `TESTNET_EXECUTION_MODE=true`.

### Phase 3: Deployment & Validation

#### Step 7: Deploy missing contracts + approve routers

```bash
# Deploy FlashLoanArbitrage on Base Sepolia
cd contracts
npx hardhat run scripts/deploy.ts --network baseSepolia

# Approve routers on all testnet contracts
# (may need a dedicated approval script)
```

#### Step 8: Update docker-compose.testnet.yml

Add separate env vars for execution mode:
```yaml
execution-engine:
  environment:
    - SIMULATION_MODE=${SIMULATION_MODE:-true}
    - EXECUTION_SIMULATION_MODE=${EXECUTION_SIMULATION_MODE:-true}
    - TESTNET_EXECUTION_MODE=${TESTNET_EXECUTION_MODE:-false}
```

#### Step 9: End-to-end smoke test

1. Start services with `.env.testnet.live`
2. Verify simulated opportunities appear in Redis streams
3. Verify EE picks up opportunities and routes to real strategies
4. Verify transactions appear on testnet block explorers
5. Verify execution results published back to Redis

---

## Dependency Graph

```
Step 1 (env config) -----> Step 3 (mode flag) -----> Step 4 (chain resolver) ---+
                                                                                 |
Step 2 (fund wallets) ---> Step 7 (deploy contracts)                            |
                                                                                 v
                           Step 5 (token mapper) ------> Step 9 (smoke test)
                                                                  ^
                           Step 6 (router addresses) ------------+
                                                                  |
                           Step 8 (docker compose) ---------------+
```

**Critical path**: Steps 1 -> 3 -> 4 -> 5 -> 6 -> 9 (sequential)
**Parallelizable**: Steps 2, 7, 8 (independent of code changes)

---

## Testnet Infrastructure Status

### Available Testnets

| Testnet | Chain ID | RPC Available | Contracts Deployed | Flash Loan Provider |
|---------|----------|---------------|-------------------|---------------------|
| Sepolia | 11155111 | Yes | FlashLoanArbitrage, CommitReveal, MultiPathQuoter | Aave V3 |
| Arbitrum Sepolia | 421614 | Yes | FlashLoanArbitrage, PancakeSwap, CommitReveal, MultiPathQuoter | Aave V3, PancakeSwap V3 |
| Base Sepolia | 84532 | Yes | **None** | Aave V3 (pool exists) |
| zkSync Sepolia | 300 | Yes | SyncSwapFlashArbitrage | SyncSwap |
| Polygon Amoy | 80002 | Yes | None | None |
| BSC Testnet | 97 | Yes | None | PancakeSwap V3 |
| Solana Devnet | 102 | Yes | None | None |

### Testnet Token Addresses

```
Sepolia:
  WETH: 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
  USDC: 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8
  DAI:  0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357

Arbitrum Sepolia:
  WETH: 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73
  USDC: 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d

Base Sepolia:
  WETH: 0x4200000000000000000000000000000000000006
  USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e

zkSync Sepolia:
  WETH: 0x701f3B10b5Cc30CA731fb97459175f45E0ac1247
  USDC: 0xAe045DE5638162fa134807Cb558E15A3F5A7F853
```

### Testnet DEX Routers

```
Sepolia: Uniswap V2 Router (0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008)
Arbitrum Sepolia: Uniswap V2 (0x101F443B4d1b059569D643917553c771E1b9663E), V3 Adapter (0x1A9838ce19Ae905B4e5941a17891ba180F30F630)
Base Sepolia: Uniswap V2 Router02 (0x1689E7B1F10000AE47eBfE339a4f69dECd19F602)
zkSync Sepolia: SyncSwap Router (0x3f39129e54d2331926c1E4bf034e111cf471AA97)
```

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Testnet tokens have no liquidity - swaps revert | Execution fails but safe | High | Use pairs with known testnet liquidity (Uniswap V2 WETH/USDC on Sepolia) |
| Simulated prices don't match testnet pool reserves | Swap amounts wrong, reverts | High | Accept high failure rate initially; tune params |
| Gas estimation off on testnets | Tx fails or overpays | Medium | Set generous gas limits; testnet gas is free |
| Wallet nonce conflicts from failed txs | Subsequent txs stall | Medium | `MAX_CONCURRENT_EXECUTIONS=1` + nonce manager reset |
| Accidentally using mainnet key on testnet config | Fund loss | Low | Enforce `TESTNET_PRIVATE_KEY` separate env var; add startup guard |
| Testnet RPC rate limits | Service degradation | Medium | Use paid RPC providers (Alchemy/Infura free tier) |

---

## Ordered Implementation Checklist

| # | Step | Type | Effort | Blocking? |
|---|------|------|--------|-----------|
| 1 | Create `.env.testnet.live` with correct flag combination | Config | Small | Yes |
| 2 | Fund testnet wallets with ETH + test tokens | Manual | Small | Yes |
| 3 | Add `TESTNET_EXECUTION_MODE` flag + skip price verification | Code | Small | Yes |
| 4 | Add chain name normalization (`ethereum` -> `sepolia`) in EE | Code | Medium | Yes |
| 5 | Add token address mainnet-to-testnet mapper | Code | Medium | Yes |
| 6 | Wire testnet DEX router addresses into config | Code | Medium | Yes |
| 7 | Deploy missing contracts (Base Sepolia) + approve routers | Deploy | Medium | For that chain |
| 8 | Update `docker-compose.testnet.yml` for new mode | Config | Small | No |
| 9 | End-to-end smoke test: sim prices -> real testnet tx | Test | Medium | Validation |
| 10 | Add startup guard: reject mainnet keys when TESTNET_EXECUTION_MODE=true | Code | Small | Safety |

**Estimated total**: ~200-300 lines of new code, 4-5 new/modified files, no architectural changes.

---

## Key Files Reference

| Component | File | Relevance |
|-----------|------|-----------|
| Mode detection | `shared/core/src/simulation/mode-utils.ts` | Add `isTestnetExecutionMode()` |
| Strategy factory | `services/execution-engine/src/strategies/strategy-factory.ts` | No change needed (already routes correctly) |
| Price verification | `services/execution-engine/src/strategies/base.strategy.ts:920-974` | Relax checks for testnet |
| Execution pipeline | `services/execution-engine/src/execution-pipeline.ts` | Apply chain resolver |
| Simulation strategy | `services/execution-engine/src/strategies/simulation.strategy.ts` | Reference only (bypassed in target mode) |
| Intra-chain strategy | `services/execution-engine/src/strategies/intra-chain.strategy.ts` | Consumers of verifyOpportunityPrices |
| Flash loan strategy | `services/execution-engine/src/strategies/flash-loan.strategy.ts` | Consumers of verifyOpportunityPrices |
| Simulation constants | `shared/core/src/simulation/constants.ts` | Token addresses to map |
| Testnet addresses | `contracts/deployments/addresses.ts` | Source of truth for testnet addresses |
| Flash loan availability | `shared/config/src/flash-loan-availability.ts` | Testnet provider matrix |
| Docker compose | `infrastructure/docker/docker-compose.testnet.yml` | Update env vars |
