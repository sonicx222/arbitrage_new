# Strategic Profitability Boost Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform this system from a simulation-only prototype into a revenue-generating L2 arbitrage operation by fixing broken economics, deploying real contracts, unlocking V3 DEX liquidity, and filling critical coverage gaps.

**Architecture:** Phased rollout targeting L2 chains (Arbitrum, Base, Optimism) where gas is cheap, competition is thinner, and sequencer-ordered transactions eliminate frontrunning. Flash loans provide capital-efficient execution (zero upfront capital). A UniswapV3Adapter contract bridges the V2-only interface limitation without rewriting the base contracts.

**Tech Stack:** TypeScript, Solidity ^0.8.19, Hardhat, ethers v6, Uniswap V3 SwapRouter, Aave V3 / Balancer V2 flash loans, Redis Streams

---

## Strategic Overview

### Why This Plan Works

The reality check identified 5 root causes of zero profitability:
1. **System has never traded** -- simulation mode, no deployed contracts
2. **V2-only router support** -- excludes 60-70% of DEX liquidity (Uni V3, Curve, etc.)
3. **Broken economics** -- $5 gas estimate, 5% slippage tolerance, stale prices
4. **Non-functional strategies** -- stat arb unit mismatch, dead code registrations
5. **Missing DEX coverage** -- Optimism has only 3 DEXs, zkSync only 2

### Phase Sequence

| Phase | What | Why First |
|-------|------|-----------|
| 0 | ~~Fix economic parameters~~ | ~~Stop generating false-positive opportunities~~ **COMPLETED** (bf9649d5) |
| 1 | ~~Fix broken strategies~~ | ~~Make detection pipeline honest~~ **COMPLETED** (619580fb, d93e6b1d) |
| 2 | Deploy to Arbitrum Sepolia testnet | Validate end-to-end with real blockchain |
| 3 | ~~Build UniswapV3Adapter~~ | ~~Unlock majority of DEX liquidity~~ **COMPLETED** (9846af47, d6fc4993) |
| 4 | ~~Fill L2 DEX coverage gaps~~ | ~~Maximize arbitrage surface area~~ **COMPLETED** (836a8b29) |
| 5 | Deploy Balancer V2 (0% fee) | Eliminate flash loan costs |
| 6 | Wire real monitoring | See what's happening in production |
| 7 | Mainnet deployment | Go live on Arbitrum, then Base, then Optimism |

### Key Principle

**One chain, one strategy, real transactions, iterate from data.** Each phase is independently valuable and testable. Do NOT skip ahead.

---

## Phase 0: Fix Economic Parameters -- COMPLETED (bf9649d5)

**Rationale:** The current parameters generate false-positive opportunities that would fail on-chain. Every trade evaluation is corrupted by a $5 gas estimate (real cost: $15-50 on mainnet), 5% slippage tolerance (should be 1%), and 60-second CEX price staleness. Fix these FIRST so all subsequent testing uses honest numbers.

> **Status:** All 3 tasks completed. Typecheck passes. 59 related tests pass. Committed as bf9649d5.

### Task 0.1: Fix Threshold Parameters

**Files:**
- Modify: `shared/config/src/thresholds.ts`
- Test: `shared/config/__tests__/` (if threshold tests exist)

**Step 1: Read the current file**

Read `shared/config/src/thresholds.ts` to confirm current values and exact line numbers.

**Step 2: Apply parameter fixes**

Make these exact changes in `shared/config/src/thresholds.ts`:

| Line | Parameter | Current | New | Reason |
|------|-----------|---------|-----|--------|
| ~32 | `defaultAmount` | `1000` | `10000` | Flash loans need $10k+ to cover gas |
| ~33 | `estimatedGasCost` | `5` | `15` | $5 is 4-10x too low for mainnet |
| ~35 | `minProfitThreshold` | `10` | `2` | $10 filters out viable L2 opportunities |
| ~39 | `slippageTolerance` | `0.05` | `0.01` | 5% masks bad opportunities |

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (these are numeric value changes, no type impact)

**Step 4: Commit**

```bash
git add shared/config/src/thresholds.ts
git commit -m "fix(config): correct unrealistic economic parameters

- Raise defaultAmount to $10k (flash loans need size for profitability)
- Raise estimatedGasCost to $15 (was 4-10x too low for mainnet)
- Lower minProfitThreshold to $2 (was filtering viable L2 opportunities)
- Lower slippageTolerance to 1% (5% masked bad opportunities)"
```

### Task 0.2: Fix MEV Public Fallback (Security)

**Files:**
- Modify: `shared/config/src/mev-config.ts`

**Step 1: Read the file**

Read `shared/config/src/mev-config.ts` and find `fallbackToPublic` around line 55.

**Step 2: Change default to false**

```typescript
// Current:
fallbackToPublic: process.env.MEV_FALLBACK_TO_PUBLIC !== 'false',

// New:
fallbackToPublic: process.env.MEV_FALLBACK_TO_PUBLIC === 'true',
```

This changes the default from opt-out to opt-in. Public mempool fallback exposes transactions to sandwich attacks.

**Step 3: Commit**

```bash
git add shared/config/src/mev-config.ts
git commit -m "fix(security): default fallbackToPublic to false

Public mempool fallback exposes arbitrage txs to sandwich attacks.
Require explicit opt-in via MEV_FALLBACK_TO_PUBLIC=true."
```

### Task 0.3: Fix CEX Price Staleness

**Files:**
- Modify: `shared/core/src/analytics/cex-dex-spread.ts`

**Step 1: Read the file**

Read `shared/core/src/analytics/cex-dex-spread.ts` and find `maxCexPriceAgeMs` around line 87.

**Step 2: Reduce staleness from 60s to 10s**

```typescript
// Current:
maxCexPriceAgeMs: 60_000,

// New:
maxCexPriceAgeMs: 10_000,
```

60 seconds of CEX price staleness generates phantom spread alerts. Crypto prices can move 0.5-1% in that window.

**Step 3: Commit**

```bash
git add shared/core/src/analytics/cex-dex-spread.ts
git commit -m "fix(analytics): reduce CEX price staleness from 60s to 10s

60s staleness generates phantom spread alerts. Crypto moves 0.5-1% in that window."
```

---

## Phase 1: Fix Broken Strategies -- COMPLETED (619580fb, d93e6b1d)

**Rationale:** 3-4 of 6 strategies are non-functional. The detection pipeline generates opportunities the execution engine cannot process. Fix the strategies so the pipeline produces honest, executable signals.

> **Status:** Task 1.1 (stat arb economics) completed as 619580fb. Task 1.2 (feature flags) already documented. Task 1.3 (placeholder L2 removal) completed as d93e6b1d. All tests pass.

### Task 1.1: Fix Statistical Arbitrage Economics

**Files:**
- Modify: `shared/core/src/detector/statistical-arbitrage-detector.ts`
- Modify: `services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts`
- Modify: `services/execution-engine/src/engine.ts`
- Test: `shared/core/__tests__/unit/detector/statistical-arbitrage-detector.test.ts`
- Test: `services/execution-engine/__tests__/unit/strategies/statistical-arbitrage.strategy.test.ts`

**Step 1: Read the detector**

Read `shared/core/src/detector/statistical-arbitrage-detector.ts` and find `defaultPositionSizeUsd` around line 65 and `expectedProfit` computation around line 195-198.

**Step 2: Increase default position size**

The detector computes `expectedProfit = spreadDeviation * positionSizeUsd`. With $10k position and 0.001 spread deviation, profit is only $10 -- right at the rejection threshold. Increase to $50k:

```typescript
// Current (~line 65):
defaultPositionSizeUsd: 10_000,

// New:
defaultPositionSizeUsd: 50_000,
```

**Step 3: Lower strategy minimum profit**

Read `services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts` and find `minExpectedProfitUsd` around line 52:

```typescript
// Current (~line 52):
minExpectedProfitUsd: 10,

// New:
minExpectedProfitUsd: 5,
```

Also in `services/execution-engine/src/engine.ts`, find the stat arb config around line 1120:

```typescript
// Current:
minExpectedProfitUsd: parseNumericEnv('STAT_ARB_MIN_PROFIT_USD') ?? 10,

// New:
minExpectedProfitUsd: parseNumericEnv('STAT_ARB_MIN_PROFIT_USD') ?? 5,
```

**Step 4: Update tests to use realistic spread deviations**

Read `shared/core/__tests__/unit/detector/statistical-arbitrage-detector.test.ts`. The mock Bollinger bands likely use `currentSpread: 0.1, middle: 0.5` (unrealistically large). Update to realistic values like `currentSpread: 0.003, middle: 0.002`.

**Step 5: Run tests**

```bash
npm run test:unit -- --testPathPattern="statistical-arbitrage"
```
Expected: PASS

**Step 6: Commit**

```bash
git add shared/core/src/detector/statistical-arbitrage-detector.ts \
       services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts \
       services/execution-engine/src/engine.ts \
       shared/core/__tests__/unit/detector/statistical-arbitrage-detector.test.ts \
       services/execution-engine/__tests__/unit/strategies/statistical-arbitrage.strategy.test.ts
git commit -m "fix(stat-arb): correct position sizing and profit thresholds

- Increase defaultPositionSizeUsd from $10k to $50k
- Lower minExpectedProfitUsd from $10 to $5
- Update tests to use realistic spread deviations"
```

### Task 1.2: Enable Feature-Flagged Strategies

**Files:**
- Modify: `.env.example`

**Step 1: Read `.env.example`**

Confirm the feature flags section exists and add the missing strategy flags.

**Step 2: Add strategy feature flags to `.env.example`**

Add to the feature flags section:

```bash
# Strategy feature flags (set to 'true' to enable)
FEATURE_BACKRUN_STRATEGY=false
FEATURE_UNISWAPX_FILLER=false
FEATURE_SOLANA_EXECUTION=false
FEATURE_STATISTICAL_ARB=false
```

Document that these exist so operators know they can enable them. The strategies are properly registered in `engine.ts` behind these flags (lines 1021-1033).

**Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document strategy feature flags in .env.example"
```

### Task 1.3: Remove Emerging L2 Placeholder Addresses

**Files:**
- Modify: `shared/config/src/dexes/index.ts` (or wherever Blast/Scroll/Mantle/Mode configs live)
- Modify: `shared/config/src/partitions.ts`

**Step 1: Read the DEX configs for emerging L2s**

Find Blast, Scroll, Mantle, Mode DEX entries. These have all-zero placeholder addresses (`0x0000...0001` etc.) that waste detection resources.

**Step 2: Either add real addresses OR remove from P2 partition**

Option A (recommended): Comment out the placeholder DEXs with a note explaining they need real addresses:
```typescript
// Blast, Scroll, Mantle, Mode: Disabled until real DEX addresses are added
// See: https://docs.blast.io/contracts for Blast addresses
```

Option B: Remove these chains from the P2 `l2-turbo` partition in `shared/config/src/partitions.ts` (around line 238).

**Step 3: Commit**

```bash
git add shared/config/src/dexes/index.ts shared/config/src/partitions.ts
git commit -m "fix(config): disable placeholder L2 chains wasting detection resources

Blast, Scroll, Mantle, Mode have all-zero DEX addresses.
Removed from P2 partition until real addresses are added."
```

---

## Phase 2: Deploy to Arbitrum Sepolia (Testnet)

**Rationale:** The system has never touched a real blockchain. Deploy to testnet first to validate the full pipeline: detection -> opportunity -> execution -> on-chain settlement. This is the most important phase -- without it, nothing else matters.

### Task 2.1: Verify Testnet Configuration

**Files:**
- Read: `contracts/hardhat.config.ts` (testnet networks already configured, lines 69-83)
- Read: `contracts/scripts/deploy.ts` (deployment flow)
- Read: `shared/config/src/addresses.ts` (Aave V3 pool for arbitrumSepolia)

**Step 1: Verify Aave V3 Pool address for Arbitrum Sepolia**

The deploy script at `contracts/scripts/deploy.ts` line ~101 looks up `AAVE_V3_POOL_ADDRESSES[networkName]`. Verify that `arbitrumSepolia` key exists in the address config at `shared/config/src/addresses.ts`. The Aave V3 testnet pool on Arbitrum Sepolia is `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`. If missing, add it.

**Step 2: Verify approved routers for Arbitrum Sepolia**

Check `contracts/deployments/addresses.ts` has `arbitrumSepolia` in `APPROVED_ROUTERS`. If it only has mainnet routers, add testnet SushiSwap or Uniswap V2 router addresses for Arbitrum Sepolia.

### Task 2.2: Set Up Deployment Environment

**Files:**
- Create: `.env.local` (gitignored, secrets only)

**Step 1: Create `.env.local` with testnet credentials**

```bash
# Testnet deployment credentials
DEPLOYER_PRIVATE_KEY=0x<your-testnet-deployer-private-key>
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
ARBISCAN_API_KEY=<your-arbiscan-api-key>

# Disable simulation for testnet execution
EXECUTION_SIMULATION_MODE=false
SIMULATION_MODE=false
```

**Step 2: Fund testnet wallet**

Get Arbitrum Sepolia ETH from the Arbitrum faucet or bridge Sepolia ETH. You need ~0.1 ETH for deployment gas.

### Task 2.3: Deploy FlashLoanArbitrage to Arbitrum Sepolia

**Step 1: Compile contracts**

```bash
cd contracts && npx hardhat compile
```
Expected: Successful compilation

**Step 2: Deploy**

```bash
cd contracts && npx hardhat run scripts/deploy.ts --network arbitrumSepolia
```

Expected output:
- Contract deployed at `0x...` address
- Routers approved
- Minimum profit configured
- Registry updated at `contracts/deployments/registry.json`

**Step 3: Verify on Arbiscan (optional but recommended)**

```bash
cd contracts && npx hardhat verify --network arbitrumSepolia <contractAddress> <aavePoolAddress> <ownerAddress>
```

**Step 4: Update address maps**

Add the deployed address to `contracts/deployments/addresses.ts`:
```typescript
export const FLASH_LOAN_CONTRACT_ADDRESSES: Record<string, string> = {
  arbitrumSepolia: '<deployed-address>',
};
```

**Step 5: Commit**

```bash
git add contracts/deployments/registry.json contracts/deployments/addresses.ts
git commit -m "deploy: FlashLoanArbitrage to Arbitrum Sepolia testnet"
```

### Task 2.4: End-to-End Testnet Validation

**Step 1: Configure services for testnet**

In `.env.local`:
```bash
EXECUTION_SIMULATION_MODE=false
SIMULATION_MODE=false
ARBITRUM_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
ETHEREUM_PRIVATE_KEY=0x<your-testnet-private-key>
FLASH_LOAN_CONTRACT_ADDRESS=<deployed-address>
REDIS_URL=redis://localhost:6379
```

**Step 2: Start Redis and minimal services**

```bash
npm run dev:redis
npm run dev:minimal
```

**Step 3: Observe logs for real detection events**

Watch for:
- Real WebSocket connections to RPC providers
- Real Sync events from DEX pools
- Opportunity detection (even if no profitable ones exist on testnet)
- Execution attempts (will likely fail due to low testnet liquidity -- that is expected and informative)

**Step 4: Document findings**

Record what works and what breaks. This data is more valuable than any code analysis.

---

## Phase 3: Build UniswapV3Adapter -- COMPLETED (9846af47, d6fc4993)

**Rationale:** The contracts only support V2-style `swapExactTokensForTokens`. On Ethereum, Uniswap V3 handles 60-70% of volume. On L2s, V3 pools often have deeper liquidity than V2. The adapter pattern wraps V3's `exactInputSingle` behind the existing V2 interface, requiring zero changes to BaseFlashArbitrage.

> **Status:** Tasks 3.1-3.3 completed. UniswapV3Adapter (474 lines) wraps V3 behind IDexRouter. Includes ReentrancyGuard, Pausable, Ownable2Step. 56 adapter tests pass, 579 total contract tests pass. Task 3.4 (deploy script) deferred until Phase 2 testnet deployment is complete.

### Task 3.1: Create V3 Router Interface

**Files:**
- Create: `contracts/src/interfaces/ISwapRouterV3.sol`

**Step 1: Write the interface**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface ISwapRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}
```

**Step 2: Compile**

```bash
cd contracts && npx hardhat compile
```

**Step 3: Commit**

```bash
git add contracts/src/interfaces/ISwapRouterV3.sol
git commit -m "feat(contracts): add Uniswap V3 SwapRouter and QuoterV2 interfaces"
```

### Task 3.2: Create MockUniswapV3Router

**Files:**
- Create: `contracts/src/mocks/MockUniswapV3Router.sol`

**Step 1: Write the failing test first**

Create `contracts/test/UniswapV3Adapter.test.ts` with the initial test that imports the adapter (will fail because adapter doesn't exist yet):

```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';

describe('UniswapV3Adapter', () => {
  async function deployFixture() {
    const [owner] = await ethers.getSigners();
    const MockV3Router = await ethers.getContractFactory('MockUniswapV3Router');
    const mockV3Router = await MockV3Router.deploy();
    // ... will add adapter deployment after it exists
    return { owner, mockV3Router };
  }

  it('should deploy successfully', async () => {
    const { mockV3Router } = await loadFixture(deployFixture);
    expect(await mockV3Router.getAddress()).to.be.properAddress;
  });
});
```

**Step 2: Write the mock V3 router**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/ISwapRouterV3.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockUniswapV3Router is ISwapRouterV3 {
    using SafeERC20 for IERC20;

    uint256 public exchangeRate = 1e18; // 1:1 default (18 decimal scale)
    uint24 public lastFee;

    function setExchangeRate(uint256 _rate) external {
        exchangeRate = _rate;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable override returns (uint256 amountOut)
    {
        lastFee = params.fee;
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = (params.amountIn * exchangeRate) / 1e18;
        require(amountOut >= params.amountOutMinimum, "Insufficient output amount");
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
```

**Step 3: Compile and verify mock works**

```bash
cd contracts && npx hardhat compile
```

**Step 4: Commit**

```bash
git add contracts/src/mocks/MockUniswapV3Router.sol contracts/test/UniswapV3Adapter.test.ts
git commit -m "test(contracts): add MockUniswapV3Router and initial adapter test scaffold"
```

### Task 3.3: Implement UniswapV3Adapter Contract

**Files:**
- Create: `contracts/src/adapters/UniswapV3Adapter.sol`
- Modify: `contracts/test/UniswapV3Adapter.test.ts`

**Step 1: Write the full adapter test suite**

Add to `contracts/test/UniswapV3Adapter.test.ts`:
- Test V2-compatible `swapExactTokensForTokens` translates to V3 `exactInputSingle`
- Test fee tier selection (default + per-pair override)
- Test `getAmountsOut` with MockQuoterV2
- Test integration: adapter as approved router in FlashLoanArbitrage
- Test multi-hop path (3 tokens, 2 hops)
- Test `setPairFee` access control (onlyOwner)

**Step 2: Run tests to verify they fail**

```bash
cd contracts && npx hardhat test test/UniswapV3Adapter.test.ts
```
Expected: FAIL (adapter contract doesn't exist)

**Step 3: Implement the adapter**

Create `contracts/src/adapters/UniswapV3Adapter.sol` -- approximately 155 lines. Key design:
- Implements `IDexRouter` interface (existing V2 interface)
- Wraps V3 SwapRouter's `exactInputSingle` behind V2's `swapExactTokensForTokens`
- Per-pair fee tier mapping with configurable default (3000 = 0.3%)
- `Ownable2Step` for admin functions (`setPairFee`)
- Immutable V3 SwapRouter and QuoterV2 addresses
- Gas overhead: ~5-10k per hop (negligible vs 100-300k per swap)

**Step 4: Run tests to verify they pass**

```bash
cd contracts && npx hardhat test test/UniswapV3Adapter.test.ts
```
Expected: PASS

**Step 5: Run full contract test suite**

```bash
cd contracts && npx hardhat test
```
Expected: PASS (adapter should not break existing tests)

**Step 6: Commit**

```bash
git add contracts/src/adapters/UniswapV3Adapter.sol contracts/test/UniswapV3Adapter.test.ts
git commit -m "feat(contracts): add UniswapV3Adapter wrapping V3 behind V2 interface

Enables Uniswap V3 swaps through the existing BaseFlashArbitrage
contract without any modifications to the base or derived contracts.
~5-10k gas overhead per hop for proxy indirection."
```

### Task 3.4: Deploy V3 Adapter to Testnet

**Step 1: Add adapter to deploy script or create a dedicated adapter deploy script**

Create `contracts/scripts/deploy-v3-adapter.ts` that:
1. Deploys UniswapV3Adapter with V3 SwapRouter address for the target chain
2. Sets pair fees for major pools (WETH/USDC 500, WETH/WBTC 3000, etc.)
3. Adds adapter address to FlashLoanArbitrage's approved routers

**Step 2: Deploy to Arbitrum Sepolia**

```bash
cd contracts && npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrumSepolia
```

**Step 3: Update address config**

Add V3 adapter address to `contracts/deployments/addresses.ts` approved routers and `shared/config/src/addresses.ts` DEX routers.

**Step 4: Commit**

```bash
git add contracts/scripts/deploy-v3-adapter.ts contracts/deployments/
git commit -m "deploy: UniswapV3Adapter to Arbitrum Sepolia testnet"
```

---

## Phase 4: Fill L2 DEX Coverage Gaps -- COMPLETED (836a8b29)

**Rationale:** Arbitrage opportunities scale with the number of DEX pairs. More DEXs = more price discrepancies = more profitable paths. Some of these are pure config additions (addresses already exist in the codebase but aren't wired up).

> **Status:** All tasks completed. Added 7 new DEX entries across 5 chains (Optimism +2, Base +1, zkSync +2, Linea +1, Arbitrum +1). Total DEXs: 71 → 78. All 218 DEX config tests pass. GMX V2 deferred (needs custom adapter).

### Task 4.1: Add Missing DEXs to Optimism (3 -> 6+)

**Files:**
- Modify: `shared/config/src/dexes/index.ts`

**Step 1: Read current Optimism config**

Read `shared/config/src/dexes/index.ts` and find the Optimism section (around lines 245-267). Currently only: Uniswap V3, Velodrome, SushiSwap.

**Step 2: Add Curve, Balancer V2, and KyberSwap**

Add to the Optimism DEX list:
- **Curve**: `0x0DCDED3545D565bA3B19E683431381007245d983` (Optimism factory)
- **Balancer V2**: `0xBA12222222228d8Ba445958a75a0704d566BF2C8` (already in addresses.ts line 169)
- **Beethoven X**: `0xBA12222222228d8Ba445958a75a0704d566BF2C8` (Balancer V2 fork, same vault)

Verify each address on the Optimism block explorer before adding.

**Step 3: Run typecheck**

```bash
npm run typecheck
```

**Step 4: Commit**

```bash
git add shared/config/src/dexes/index.ts
git commit -m "feat(config): add Curve, Balancer V2 to Optimism DEX list (3 -> 6 DEXs)

Optimism had the fewest DEXs of any major L2. Adding high-TVL DEXs
roughly doubles the arbitrage opportunity surface."
```

### Task 4.2: Add PancakeSwap V3 to Base, zkSync, and Linea

**Files:**
- Modify: `shared/config/src/dexes/index.ts`

**Step 1: Verify factory addresses**

The PancakeSwap V3 factory addresses are already in `shared/config/src/addresses.ts`:
- Base: `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` (line 125)
- zkSync: `0x1BB72E0CbbEA93c08f535fc7856E0338D7F7a8aB` (line 124)
- Linea: line 127 (verify exists)

**Step 2: Add DEX entries**

Add PancakeSwap V3 entries to Base, zkSync, and Linea sections of `shared/config/src/dexes/index.ts`. Use the same pattern as existing DEX entries (factory address, priority level, pool type).

**Step 3: Commit**

```bash
git add shared/config/src/dexes/index.ts
git commit -m "feat(config): add PancakeSwap V3 to Base, zkSync, and Linea

Factory addresses were already in addresses.ts but not wired into DEX config."
```

### Task 4.3: Add Missing DEXs to Arbitrum (GMX, Uniswap V2)

**Files:**
- Modify: `shared/config/src/dexes/index.ts`

**Step 1: Add GMX V2 to Arbitrum**

GMX V2 on Arbitrum has $300M+ TVL. Add the GMX Vault address (verify on Arbiscan). Note: GMX uses a different swap interface than standard AMMs, so this may require a separate adapter (similar to V3 adapter). If the adapter is complex, defer to a separate task and just add the config entry as `disabled: true` with a comment.

**Step 2: Add Uniswap V2 to Arbitrum**

Uniswap V2 Factory on Arbitrum: `0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9` (verify). V2 is directly compatible with the existing contract interface -- no adapter needed.

**Step 3: Commit**

```bash
git add shared/config/src/dexes/index.ts
git commit -m "feat(config): add Uniswap V2 and GMX V2 config to Arbitrum"
```

### Task 4.4: Add DEXs to zkSync (2 -> 5)

**Files:**
- Modify: `shared/config/src/dexes/index.ts`

**Step 1: Add SpaceFi, Maverick, iZiSwap**

zkSync has only 2 DEXs (SyncSwap, Mute). Add:
- SpaceFi (V2-compatible)
- Maverick (concentrated liquidity -- may need adapter)
- iZiSwap (concentrated liquidity -- may need adapter)

Verify addresses on zkSync Era block explorer.

**Step 2: Commit**

```bash
git add shared/config/src/dexes/index.ts
git commit -m "feat(config): expand zkSync DEX coverage from 2 to 5 DEXs"
```

---

## Phase 5: Deploy Balancer V2 Flash Loans (0% Fee)

**Rationale:** Currently using Aave V3 flash loans at 0.09% fee on all L2s. Balancer V2 offers 0% fee flash loans. On a $50k flash loan, this saves $45 per trade. The Balancer V2 vault is already deployed on Arbitrum, Optimism, and Base. The `BalancerV2FlashArbitrage.sol` contract already exists in the codebase.

### Task 5.1: Deploy BalancerV2FlashArbitrage to Testnet

**Files:**
- Read: `contracts/src/BalancerV2FlashArbitrage.sol` (understand constructor args)
- Modify: `contracts/scripts/deploy.ts` (or create separate deploy script)
- Modify: `contracts/deployments/registry.json`
- Modify: `contracts/deployments/addresses.ts`

**Step 1: Read the Balancer contract**

Read `contracts/src/BalancerV2FlashArbitrage.sol` to understand constructor parameters. It should take the Balancer Vault address and owner.

**Step 2: Deploy to Arbitrum Sepolia**

Create or modify deploy script to deploy `BalancerV2FlashArbitrage` with:
- Balancer Vault: `0xBA12222222228d8Ba445958a75a0704d566BF2C8`
- Owner: deployer address

```bash
cd contracts && npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia
```

**Step 3: Update addresses and config**

Add to `BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES` in `contracts/deployments/addresses.ts`.

Uncomment the Balancer V2 flash loan config in `shared/config/src/service-config.ts` (lines 399-427) for the deployed chains.

**Step 4: Commit**

```bash
git add contracts/deployments/ shared/config/src/service-config.ts
git commit -m "deploy: BalancerV2FlashArbitrage to Arbitrum Sepolia (0% fee flash loans)"
```

### Task 5.2: Update Flash Loan Strategy Priority

**Files:**
- Modify: `services/execution-engine/src/strategies/flash-loan-fee-calculator.ts`

**Step 1: Read the fee calculator**

Read `services/execution-engine/src/strategies/flash-loan-fee-calculator.ts` to understand how flash loan providers are selected.

**Step 2: Ensure Balancer V2 (0% fee) is prioritized over Aave V3 (0.09%)**

The fee calculator should already prefer 0% fees, but verify the selection logic. If there's a hardcoded provider preference, update it to prefer Balancer V2 when available.

**Step 3: Commit**

```bash
git add services/execution-engine/src/strategies/flash-loan-fee-calculator.ts
git commit -m "feat(execution): prioritize Balancer V2 (0% fee) over Aave V3 (0.09%)"
```

---

## Phase 6: Wire Real Monitoring

**Rationale:** You cannot optimize what you cannot measure. The alert rules reference ~20 Prometheus metrics that are not emitted by any service. Without monitoring, you're flying blind in production.

### Task 6.1: Add Core Prometheus Metrics to Execution Engine

**Files:**
- Modify: `services/execution-engine/src/engine.ts`
- Read: `shared/core/src/metrics/` (understand existing metrics infrastructure)
- Read: `infrastructure/monitoring/alert-rules.yml` (what metrics are expected)

**Step 1: Read the metrics infrastructure**

The codebase has a custom `PrometheusMetricsCollector` at `shared/core/src/metrics/infrastructure/prometheus-metrics-collector.impl.ts`. Understand how to create counters and gauges.

**Step 2: Add metrics to the execution engine**

At minimum, emit these metrics (matching alert-rules.yml expectations):
- `arbitrage_execution_attempts_total` (counter, labels: chain, strategy)
- `arbitrage_execution_success_total` (counter, labels: chain, strategy)
- `arbitrage_gas_price_gwei` (gauge, labels: chain)
- `arbitrage_opportunities_detected_total` (counter, labels: chain, type)
- `arbitrage_volume_usd_total` (counter, labels: chain)

**Step 3: Add /metrics HTTP endpoint**

Add a `/metrics` route to the execution engine's HTTP server that exports Prometheus text format.

**Step 4: Test metrics emission**

Start the execution engine, trigger a simulated opportunity, and verify metrics appear at `http://localhost:3005/metrics`.

**Step 5: Commit**

```bash
git add services/execution-engine/src/engine.ts
git commit -m "feat(monitoring): add Prometheus metrics to execution engine

Emits execution_attempts, execution_success, gas_price, opportunities_detected,
and volume_usd metrics matching the alert-rules.yml expectations."
```

### Task 6.2: Add Metrics to RPC Provider Rotation

**Files:**
- Modify: `shared/core/src/rpc/provider-rotation-strategy.ts`

**Step 1: Add RPC metrics**

Emit:
- `arbitrage_rpc_calls_total` (counter, labels: provider, chain)
- `arbitrage_rpc_errors_total` (counter, labels: provider, chain, error_type)

**Step 2: Commit**

```bash
git add shared/core/src/rpc/provider-rotation-strategy.ts
git commit -m "feat(monitoring): add Prometheus metrics to RPC provider rotation"
```

---

## Phase 7: Mainnet Deployment

**Rationale:** After testnet validation, deploy to Arbitrum mainnet first (fastest L2, most DEX coverage), then Base, then Optimism. Start with minimal capital ($100-500 in gas tokens) and flash loans only (zero upfront trading capital).

### Task 7.1: Pre-Deployment Checklist

**Before deploying to any mainnet, verify ALL of the following:**

- [ ] All contract tests pass: `cd contracts && npx hardhat test`
- [ ] All service tests pass: `npm test`
- [ ] TypeScript compiles cleanly: `npm run typecheck`
- [ ] Testnet deployment worked end-to-end (Phase 2 completed)
- [ ] V3 adapter tested on testnet (Phase 3 completed)
- [ ] At least 1 successful testnet trade executed (even if unprofitable)
- [ ] `SIMULATION_MODE=false` and `EXECUTION_SIMULATION_MODE=false` tested on testnet
- [ ] Monitoring endpoints return real metrics (Phase 6 completed)
- [ ] `npm run validate:deployment` passes
- [ ] `npm run validate:mev-setup` passes
- [ ] Private keys are in `.env.local` only (not committed)
- [ ] Redis is running and accessible
- [ ] At least one RPC provider API key configured

### Task 7.2: Uncomment Mainnet Network in Hardhat Config

**Files:**
- Modify: `contracts/hardhat.config.ts`

**Step 1: Uncomment the Arbitrum mainnet network**

At lines 104-113, uncomment:
```typescript
arbitrum: {
  url: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  chainId: 42161,
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
},
```

**Step 2: Do NOT uncomment Ethereum mainnet yet**

Ethereum mainnet has the highest gas costs and most competition. Save it for last (or never -- L2s are the viable target).

### Task 7.3: Deploy to Arbitrum Mainnet

**Step 1: Set mainnet environment**

In `.env.local`:
```bash
NODE_ENV=production
DEPLOYER_PRIVATE_KEY=0x<mainnet-deployer-key>
ARBITRUM_RPC_URL=<your-dedicated-rpc-url>
ARBISCAN_API_KEY=<your-key>
```

**Step 2: Deploy FlashLoanArbitrage**

```bash
cd contracts && npx hardhat run scripts/deploy.ts --network arbitrum
```

**Step 3: Deploy UniswapV3Adapter**

```bash
cd contracts && npx hardhat run scripts/deploy-v3-adapter.ts --network arbitrum
```

The V3 adapter should use:
- SwapRouter: `0xE592427A0AEce92De3Edee1F18E0157C05861564`
- QuoterV2: `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`
- Default fee: 3000 (0.3%)

**Step 4: Deploy BalancerV2FlashArbitrage (if Phase 5 complete)**

```bash
cd contracts && npx hardhat run scripts/deploy-balancer.ts --network arbitrum
```

**Step 5: Update all address configs and commit**

```bash
git add contracts/deployments/ shared/config/src/addresses.ts
git commit -m "deploy: FlashLoanArbitrage + V3Adapter to Arbitrum mainnet"
```

### Task 7.4: Start Live Trading (Minimal Capital)

**Step 1: Configure for live trading**

In `.env.local`:
```bash
NODE_ENV=production
SIMULATION_MODE=false
EXECUTION_SIMULATION_MODE=false
FLASH_LOAN_CONTRACT_ADDRESS=<mainnet-address>
ETHEREUM_PRIVATE_KEY=0x<mainnet-wallet-key>
ARBITRUM_RPC_URL=<dedicated-rpc>
MEV_FALLBACK_TO_PUBLIC=false
CIRCUIT_BREAKER_ENABLED=true
```

**Step 2: Fund wallet with minimal gas**

Send 0.01-0.05 ETH to the wallet on Arbitrum (~$20-100). Flash loans require no upfront trading capital -- only gas for transaction execution.

**Step 3: Start services**

```bash
npm run dev:minimal
```

**Step 4: Monitor and iterate**

Watch for:
- Real opportunity detection
- Execution attempts (expect many failures initially)
- Gas consumption
- Any profitable executions

**The first real trade data is worth more than any analysis. Iterate from there.**

---

## Phase 8: Progressive Expansion (Post-Revenue)

**Only pursue after Arbitrum mainnet generates at least 1 profitable trade.**

### Task 8.1: Deploy to Base Mainnet

Repeat Phase 7 tasks for Base:
- SwapRouter: `0x2626664c2603336E57B271c5C0b26F421741e481`
- QuoterV2: `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
- Aave V3 Pool: address from `shared/config/src/addresses.ts`

### Task 8.2: Deploy to Optimism Mainnet

Repeat Phase 7 tasks for Optimism:
- SwapRouter: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`
- QuoterV2: `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`

### Task 8.3: Enable Statistical Arbitrage (Post-Validation)

Once cross-DEX arb is proven on L2s, enable stat arb:
```bash
FEATURE_STATISTICAL_ARB=true
```

Monitor separately. Stat arb has different risk profile (directional exposure).

### Task 8.4: Enable MEV-Share Backrunning

The most accessible MEV strategy for non-professional operators:
```bash
FEATURE_BACKRUN_STRATEGY=true
```

Requires Flashbots API key and searcher registration.

### Task 8.5: Optimize Based on Real Data

After 1-2 weeks of live trading data:
1. Analyze win rate per chain, per strategy, per DEX pair
2. Adjust thresholds based on observed gas costs (not estimates)
3. Increase/decrease position sizing based on Kelly criterion with real data
4. Kill unprofitable chains/strategies
5. Double down on profitable ones

---

## Appendix A: V3 SwapRouter Addresses Per Chain

| Chain | SwapRouter | QuoterV2 |
|-------|-----------|----------|
| Arbitrum | `0xE592427A0AEce92De3Edee1F18E0157C05861564` | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Base | `0x2626664c2603336E57B271c5C0b26F421741e481` | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| Optimism | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |

## Appendix B: Risk Budget

| Risk | Mitigation | Max Exposure |
|------|-----------|-------------|
| Contract bug | Testnet validation + flash loan atomicity | Gas costs only (flash loans revert on loss) |
| Wallet key compromise | Separate hot wallet with minimal gas | 0.05 ETH per chain |
| Bad parameter config | Circuit breaker + max daily loss 5% | 5% of gas budget |
| RPC provider failure | Multi-provider rotation with health scoring | Missed opportunities, no capital loss |
| Gas spike | Gas spike multiplier threshold (2x) | Trades rejected, no capital loss |
| Bridge failure (cross-chain) | Bridge recovery manager + timeout | Delayed settlement, tracked by recovery system |

## Appendix C: Expected Timeline Markers

This plan does NOT include time estimates (per project conventions). However, here are logical dependency markers:

1. Phases 0-1 can be done before any deployment
2. Phase 2 requires testnet ETH
3. Phase 3 can run in parallel with Phase 2
4. Phase 4 is pure config changes, can run anytime after Phase 0
5. Phase 5 requires Phase 2 complete (need deployment experience)
6. Phase 6 can run in parallel with Phases 3-5
7. Phase 7 requires Phases 0-3 complete minimum
8. Phase 8 requires real trading data from Phase 7
