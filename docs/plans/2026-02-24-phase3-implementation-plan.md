# Phase 3: Strategic Expansion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 6 Phase 3 items (#28-#33): DAI flash minting, Solana execution with Jito, statistical arbitrage, CEX price signals, 4 emerging L2s, and CoW Protocol backrun — plus 3 new ADRs and architectural doc updates.

**Architecture:** All items plug into existing abstractions (strategies, providers, chain configs, detectors). No new architectural paradigms. Implementation follows sequential-by-readiness order, grouped into 4 parallelizable batches.

**Tech Stack:** TypeScript, Solidity ^0.8.19, Hardhat, ethers v6, Jest, @solana/web3.js, ws (WebSocket)

**Key Files (read these first):**
- Strategy factory: `services/execution-engine/src/strategies/strategy-factory.ts` (StrategyType at line 81, RegisteredStrategies at line 122)
- ArbitrageOpportunity type: `shared/types/src/index.ts:173-309` (type field at line 176)
- Engine wiring: `services/execution-engine/src/engine.ts:988-1040`
- Chain config: `shared/config/src/chains/index.ts` (MAINNET_CHAIN_IDS at line 394)
- Execution chains: `shared/config/src/service-config.ts:232-243`
- Flash loan config: `shared/config/src/flash-loan-availability.ts`
- EIP-3156 contract pattern: `contracts/src/SyncSwapFlashArbitrage.sol`
- Jito provider: `shared/core/src/mev-protection/jito-provider.ts`
- Price momentum: `shared/core/src/analytics/price-momentum.ts`
- Partition config: `shared/config/src/partitions.ts` (PARTITIONS at line 222)

---

## Group 1A: Item #30 — DAI Flash Minting

### Task 1: Create MockDssFlash contract

**Files:**
- Create: `contracts/src/mocks/MockDssFlash.sol`

**Context:** The DssFlash contract implements EIP-3156 lender interface. It calls `onFlashLoan` on the borrower, then pulls repayment via `transferFrom`. Reference: `contracts/src/mocks/MockSyncSwapVault.sol` for similar mock pattern.

**Step 1: Write the mock contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * Mock DssFlash for testing DAI Flash Mint arbitrage.
 * Implements EIP-3156 flash lender interface (same as MakerDAO's DssFlash module).
 *
 * Fee: configurable (default 1 bps = 0.01%)
 */
contract MockDssFlash {
    using SafeERC20 for IERC20;

    bytes32 private constant ERC3156_CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    uint256 public fee; // in basis points
    uint256 private constant BPS_DENOMINATOR = 10000;

    constructor(uint256 _feeBps) {
        fee = _feeBps;
    }

    function maxFlashLoan(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function flashFee(address, uint256 amount) external view returns (uint256) {
        return (amount * fee) / BPS_DENOMINATOR;
    }

    function flashLoan(
        address receiver,
        address token,
        uint256 amount,
        bytes calldata data
    ) external returns (bool) {
        uint256 feeAmount = (amount * fee) / BPS_DENOMINATOR;
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        // Transfer loan to receiver
        IERC20(token).safeTransfer(receiver, amount);

        // Call onFlashLoan callback
        bytes32 result = IERC3156FlashBorrower(receiver).onFlashLoan(
            msg.sender,
            token,
            amount,
            feeAmount,
            data
        );
        require(result == ERC3156_CALLBACK_SUCCESS, "Invalid callback return");

        // Pull repayment (EIP-3156 PULL model)
        IERC20(token).safeTransferFrom(receiver, address(this), amount + feeAmount);

        require(
            IERC20(token).balanceOf(address(this)) >= balanceBefore + feeAmount,
            "Flash loan not repaid"
        );

        return true;
    }
}

interface IERC3156FlashBorrower {
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external returns (bytes32);
}
```

**Step 2: Compile**

Run: `cd contracts && npx hardhat compile`
Expected: Successful compilation with no errors

**Step 3: Commit**

```bash
git add contracts/src/mocks/MockDssFlash.sol
git commit -m "feat(contracts): add MockDssFlash for EIP-3156 flash loan testing"
```

---

### Task 2: Create DaiFlashMintArbitrage contract

**Files:**
- Create: `contracts/src/DaiFlashMintArbitrage.sol`
- Reference: `contracts/src/SyncSwapFlashArbitrage.sol` (EIP-3156 pattern)
- Reference: `contracts/src/base/BaseFlashArbitrage.sol` (base class)

**Context:** DaiFlashMintArbitrage follows the exact same EIP-3156 pattern as SyncSwapFlashArbitrage. The only differences: (1) the lender is DssFlash instead of SyncSwap Vault, (2) the contract name and version. The `onFlashLoan` callback logic is identical: validate caller/initiator, decode params, execute swaps, verify profit, approve repayment.

**Step 1: Write the contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./base/BaseFlashArbitrage.sol";
import "./interfaces/ISyncSwapVault.sol"; // Reuse IERC3156FlashBorrower from here
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title DaiFlashMintArbitrage
 * @notice Flash arbitrage using MakerDAO DAI Flash Mint (EIP-3156 compliant).
 * @dev DAI flash minting creates DAI within a single transaction via DssFlash module.
 *      Unlike pool-based flash loans, this mints fresh DAI (no liquidity constraints).
 *      Fee: 1 bps (0.01%) — cheapest flash loan source.
 *      Ethereum mainnet only.
 *
 * @custom:version 1.0.0
 * @custom:audit-status Pending
 * @custom:security-model Open access with atomic profit verification (see BaseFlashArbitrage)
 *
 * @see https://docs.makerdao.com/smart-contract-modules/flash-mint-module
 * @see contracts/src/SyncSwapFlashArbitrage.sol (same EIP-3156 callback pattern)
 */
contract DaiFlashMintArbitrage is
    BaseFlashArbitrage,
    IERC3156FlashBorrower,
    IFlashLoanErrors
{
    using SafeERC20 for IERC20;

    /// @notice EIP-3156 callback success return value
    bytes32 private constant ERC3156_CALLBACK_SUCCESS =
        keccak256("ERC3156FlashBorrower.onFlashLoan");

    /// @notice MakerDAO DssFlash contract (EIP-3156 flash lender)
    address public immutable DSS_FLASH;

    /// @notice DAI token address
    address public immutable DAI;

    /**
     * @param _dssFlash DssFlash contract address (0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853 on mainnet)
     * @param _dai DAI token address (0x6B175474E89094C44Da98b954EedeAC495271d0F on mainnet)
     * @param _owner Contract owner address
     */
    constructor(
        address _dssFlash,
        address _dai,
        address _owner
    ) BaseFlashArbitrage(_owner) {
        if (_dssFlash == address(0)) revert InvalidProtocolAddress();
        if (_dssFlash.code.length == 0) revert InvalidProtocolAddress();
        if (_dai == address(0)) revert InvalidProtocolAddress();
        DSS_FLASH = _dssFlash;
        DAI = _dai;
    }

    /**
     * @notice Execute arbitrage using DAI flash mint
     * @dev Open access — atomic flash loan model with profit verification prevents exploitation.
     * @param amount Amount of DAI to flash mint
     * @param swapPath Ordered swap steps [router, tokenIn, tokenOut, amountOutMin]
     * @param minProfit Minimum profit in DAI required for trade to succeed
     * @param deadline Unix timestamp after which the trade reverts
     */
    function executeArbitrage(
        uint256 amount,
        SwapStep[] calldata swapPath,
        uint256 minProfit,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        _validateArbitrageParams(DAI, amount, swapPath, minProfit, deadline);

        bytes memory userData = abi.encode(swapPath, minProfit, deadline);

        // Call DssFlash to mint DAI and trigger onFlashLoan callback
        (bool success) = IERC3156FlashLender(DSS_FLASH).flashLoan(
            IERC3156FlashBorrower(address(this)),
            DAI,
            amount,
            userData
        );
        require(success, "Flash mint failed");
    }

    /**
     * @notice EIP-3156 flash loan callback
     * @dev Called by DssFlash after minting DAI to this contract.
     *      Must return ERC3156_CALLBACK_SUCCESS after executing swaps and approving repayment.
     */
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        // Security: only DssFlash can call this
        if (msg.sender != DSS_FLASH) revert InvalidFlashLoanCaller();
        // Security: only this contract can initiate
        if (initiator != address(this)) revert InvalidFlashLoanInitiator();

        (
            SwapStep[] memory swapPath,
            uint256 minProfit,
            uint256 deadline
        ) = abi.decode(data, (SwapStep[], uint256, uint256));

        uint256 amountOwed = amount + fee;

        // Execute swaps along the path
        _executeSwapPath(token, amount, swapPath, deadline);

        // Verify profit after swaps
        uint256 balance = IERC20(token).balanceOf(address(this));
        _verifyAndRecordProfit(token, balance, amountOwed, minProfit);

        // Approve DssFlash to pull repayment (EIP-3156 PULL model)
        IERC20(token).forceApprove(DSS_FLASH, amountOwed);

        return ERC3156_CALLBACK_SUCCESS;
    }
}

/**
 * @dev EIP-3156 Flash Lender interface (subset needed for DssFlash)
 */
interface IERC3156FlashLender {
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint256 amount,
        bytes calldata data
    ) external returns (bool);
}
```

**Step 2: Compile**

Run: `cd contracts && npx hardhat compile`
Expected: Successful compilation

**Step 3: Commit**

```bash
git add contracts/src/DaiFlashMintArbitrage.sol
git commit -m "feat(contracts): add DaiFlashMintArbitrage with EIP-3156 flash mint"
```

---

### Task 3: Write DaiFlashMintArbitrage contract tests

**Files:**
- Create: `contracts/test/DaiFlashMintArbitrage.test.ts`
- Reference: `contracts/test/SyncSwapFlashArbitrage.test.ts` (test pattern)

**Context:** Tests follow the Hardhat loadFixture pattern. Use MockDssFlash, MockERC20, MockDexRouter. Key assertions: callback security (only DssFlash can call onFlashLoan), profit verification, fee handling (1 bps), DAI-only enforcement.

**Step 1: Write test file**

Follow the pattern from `SyncSwapFlashArbitrage.test.ts`:
- `deployContractsFixture` sets up MockDssFlash(1), MockERC20 (DAI, 18 decimals), MockDexRouter, DaiFlashMintArbitrage
- Tests: successful arbitrage with profit, reverts on insufficient profit, callback caller validation, callback initiator validation, pause functionality, owner-only admin functions, approved router management

Use `.revertedWithCustomError(contract, 'ErrorName')` for contract errors and `.revertedWith('string')` for OZ4/mock require messages. Match 18-decimal token precision (DAI).

**Step 2: Run tests**

Run: `cd contracts && npx hardhat test test/DaiFlashMintArbitrage.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add contracts/test/DaiFlashMintArbitrage.test.ts
git commit -m "test(contracts): add DaiFlashMintArbitrage test suite"
```

---

### Task 4: Write DAI Flash Mint provider unit tests

**Files:**
- Create: `services/execution-engine/__tests__/unit/strategies/flash-loan-providers/dai-flash-mint.provider.test.ts`
- Reference: `services/execution-engine/src/strategies/flash-loan-providers/dai-flash-mint.provider.ts`

**Step 1: Write provider tests**

Test: constructor validation (invalid addresses), `isAvailable()` (true for ethereum, false for other chains), `getCapabilities()` (DAI-only, multi-hop), `calculateFee()` (1 bps math), `validate()` (rejects non-DAI, rejects non-ethereum), `buildCalldata()` (correct ABI encoding), `buildTransaction()` (to=poolAddress, from=initiator).

**Step 2: Run tests**

Run: `npx jest services/execution-engine/__tests__/unit/strategies/flash-loan-providers/dai-flash-mint.provider.test.ts --verbose`
Expected: All tests pass

**Step 3: Commit**

```bash
git add services/execution-engine/__tests__/unit/strategies/flash-loan-providers/dai-flash-mint.provider.test.ts
git commit -m "test: add DAI flash mint provider unit tests"
```

---

## Group 1B: Item #33 — Emerging L2s (Blast, Scroll, Mantle, Mode)

### Task 5: Add chain configurations for 4 new L2s

**Files:**
- Modify: `shared/config/src/chains/index.ts` (add 4 entries to CHAINS record, update MAINNET_CHAIN_IDS)
- Modify: `shared/types/src/index.ts` (if MainnetChainId type needs updating)

**Context:** Follow the exact pattern of existing chain entries. Each needs: `id` (numeric chain ID), `name`, `rpcUrl` (env override || provider || fallback), `wsUrl`, `wsFallbackUrls`, `rpcFallbackUrls`, `blockTime`, `nativeToken`. Use 6-Provider Shield where available.

**Step 1: Add chain entries**

Add to `CHAINS` record (before the closing `}`):

```typescript
blast: {
    id: 81457,
    name: 'Blast',
    rpcUrl: process.env.BLAST_RPC_URL || drpc('blast') || 'https://rpc.blast.io',
    wsUrl: process.env.BLAST_WS_URL || drpc('blast', true) || 'wss://rpc.blast.io',
    wsFallbackUrls: fallbacks(
      ankr('blast', true),
      publicNode('blast', true),
    ),
    rpcFallbackUrls: fallbacks(
      ankr('blast'),
      publicNode('blast'),
      'https://rpc.ankr.com/blast',
    ),
    blockTime: 2,
    nativeToken: 'ETH',
  },
  scroll: {
    id: 534352,
    name: 'Scroll',
    rpcUrl: process.env.SCROLL_RPC_URL || drpc('scroll') || 'https://rpc.scroll.io',
    wsUrl: process.env.SCROLL_WS_URL || drpc('scroll', true) || 'wss://rpc.scroll.io',
    wsFallbackUrls: fallbacks(
      ankr('scroll', true),
      publicNode('scroll', true),
    ),
    rpcFallbackUrls: fallbacks(
      ankr('scroll'),
      publicNode('scroll'),
      'https://rpc.ankr.com/scroll',
    ),
    blockTime: 3,
    nativeToken: 'ETH',
  },
  mantle: {
    id: 5000,
    name: 'Mantle',
    rpcUrl: process.env.MANTLE_RPC_URL || drpc('mantle') || 'https://rpc.mantle.xyz',
    wsUrl: process.env.MANTLE_WS_URL || drpc('mantle', true) || 'wss://rpc.mantle.xyz',
    wsFallbackUrls: fallbacks(
      ankr('mantle', true),
    ),
    rpcFallbackUrls: fallbacks(
      ankr('mantle'),
      'https://rpc.ankr.com/mantle',
    ),
    blockTime: 2,
    nativeToken: 'MNT',
  },
  mode: {
    id: 34443,
    name: 'Mode',
    rpcUrl: process.env.MODE_RPC_URL || drpc('mode') || 'https://mainnet.mode.network',
    wsUrl: process.env.MODE_WS_URL || drpc('mode', true) || 'wss://mainnet.mode.network',
    wsFallbackUrls: fallbacks(
      ankr('mode', true),
    ),
    rpcFallbackUrls: fallbacks(
      ankr('mode'),
    ),
    blockTime: 2,
    nativeToken: 'ETH',
  },
```

**Step 2: Update MAINNET_CHAIN_IDS** (at line 394):

Add `'blast', 'scroll', 'mantle', 'mode'` to the array. Update the `as const` tuple.

**Step 3: Build and typecheck**

Run: `npm run build:deps && npm run typecheck`
Expected: No type errors

**Step 4: Commit**

```bash
git add shared/config/src/chains/index.ts shared/types/src/index.ts
git commit -m "feat(config): add Blast, Scroll, Mantle, Mode chain configurations"
```

---

### Task 6: Add DEX configurations for 4 new L2s

**Files:**
- Modify: `shared/config/src/dexes/index.ts`

**Context:** Follow existing DEX entry pattern: `{ name, chain, factoryAddress, routerAddress, feeBps }`. Each chain gets 3-4 DEXs with [C]/[H]/[M] priority annotations.

**Step 1: Add DEX entries**

Add to `DEXES` record:

```typescript
blast: [
    {
      name: 'thruster_v3',     // [C] Critical - primary V3 AMM on Blast
      chain: 'blast',
      factoryAddress: '0x71b08f13B3c3aF35aAdEb3949AFEb1ded1016127',
      routerAddress: '0x98994a9A7a2570367554589189dC9772241650f6',
      feeBps: bps(30),
    },
    {
      name: 'thruster_v2',     // [C] Critical - primary V2 AMM on Blast
      chain: 'blast',
      factoryAddress: '0xb4A7D971D0ADea1c73198C97d7ab3f9CE4aaFA13',
      routerAddress: '0x44889b52b71E60De6ed7dE82E2939fcc52fB2B4E',
      feeBps: bps(30),
    },
    {
      name: 'bladeswap',       // [H] High - secondary AMM
      chain: 'blast',
      factoryAddress: '0x6B89A7e6be5baFE28a1e45064aD120bC6b893c6b',
      routerAddress: '0xFcaD0e509d8e3e78b04038DF53FBaDCedFff10C9',
      feeBps: bps(30),
    },
    {
      name: 'ring_protocol',   // [M] Medium - ring exchange
      chain: 'blast',
      factoryAddress: '0x3583d8d910F699Dca3180988CE41C22c1Cf42760',
      routerAddress: '0x7001F706ACB6440d17cBFaD63Fa50a22D51696fF',
      feeBps: bps(30),
    },
  ],
  scroll: [
    {
      name: 'syncswap',        // [C] Critical - primary AMM on Scroll
      chain: 'scroll',
      factoryAddress: '0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d',
      routerAddress: '0x80e38291e06339d10AAB483C65695D004dBD5C69',
      feeBps: bps(30),
    },
    {
      name: 'spacefi',         // [H] High - secondary AMM
      chain: 'scroll',
      factoryAddress: '0x0700Fb51560CfC8F896B2c812499D17c5B0bF6A7',
      routerAddress: '0x18b71386418A9FCa5Ae7165E31c385a5a0b87Fb0',
      feeBps: bps(30),
    },
    {
      name: 'ambient',         // [H] High - concentrated liquidity
      chain: 'scroll',
      factoryAddress: '0xaaaaAAAACB71BF2C8CaE522EA5fa455571A74106',
      routerAddress: '0xaaaaAAAACB71BF2C8CaE522EA5fa455571A74106',
      feeBps: bps(30),
    },
    {
      name: 'zebra',           // [M] Medium - V2 fork
      chain: 'scroll',
      factoryAddress: '0x0d922Fb1Bc191F64970ac40376643808b4B74Df9',
      routerAddress: '0x0122960d6e391478bFE8fB2408Ba412D5600f621',
      feeBps: bps(30),
    },
  ],
  mantle: [
    {
      name: 'merchant_moe',    // [C] Critical - primary AMM on Mantle (LB + V1)
      chain: 'mantle',
      factoryAddress: '0x5bEf015CA9424A7C07B68490616a4C1F094BEdEc',
      routerAddress: '0x7BFd7192E76D950832c77BB412aaE841049D8D9B',
      feeBps: bps(30),
    },
    {
      name: 'agni_finance',    // [H] High - V3-style AMM
      chain: 'mantle',
      factoryAddress: '0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035',
      routerAddress: '0x319B69888b0d11cEC22caA5034e25FfFBDc88421',
      feeBps: bps(30),
    },
    {
      name: 'fusionx',         // [H] High - V3-style AMM
      chain: 'mantle',
      factoryAddress: '0x530d2766EAE1208C08536b5140A22E2209B66284',
      routerAddress: '0x5989FB161568b9F133eDf5Cf6787f5597762797F',
      feeBps: bps(30),
    },
  ],
  mode: [
    {
      name: 'kim_exchange',    // [C] Critical - primary AMM on Mode
      chain: 'mode',
      factoryAddress: '0xB5F00c2B3f097B880260deBaB6a5C3e1B72E6B70',
      routerAddress: '0xAc48FcF1049668B285f3dC72483DF5Cf2BFbb8de',
      feeBps: bps(30),
    },
    {
      name: 'supswap',         // [H] High - V3 AMM
      chain: 'mode',
      factoryAddress: '0xe61C07Cf5AEB1B1DC0B7bC08Ec9B0A2d70a1bFAC',
      routerAddress: '0xBfD09c191Bc95bb23dcA40791a0566cf6Ae7f61d',
      feeBps: bps(30),
    },
    {
      name: 'swapmode',        // [M] Medium - V2 fork
      chain: 'mode',
      factoryAddress: '0xfb926356BAf861c93C3557D064A1A8B1b8874B01',
      routerAddress: '0xC8bCa4fA95E6b2b012e834993DF2FCC38Ab80d78',
      feeBps: bps(30),
    },
  ],
```

**Step 2: Build and typecheck**

Run: `npm run build:deps && npm run typecheck`
Expected: No type errors

**Step 3: Commit**

```bash
git add shared/config/src/dexes/index.ts
git commit -m "feat(config): add DEX configurations for Blast, Scroll, Mantle, Mode"
```

---

### Task 7: Add token, flash loan, MEV, partition, and execution configs for new L2s

**Files:**
- Modify: `shared/config/src/tokens/index.ts` (add token addresses)
- Modify: `shared/config/src/flash-loan-availability.ts` (add flash loan availability)
- Modify: `shared/config/src/mev-config.ts` (add MEV strategies)
- Modify: `shared/config/src/partitions.ts` (add to P2 chains, update PHASE_METRICS)
- Modify: `shared/config/src/service-config.ts` (add to SUPPORTED_EXECUTION_CHAINS)

**Step 1: Add tokens** to `CORE_TOKENS` in `shared/config/src/tokens/index.ts`:

For each new chain, add WETH (or WMNT for Mantle), USDC, USDT, DAI with correct on-chain addresses. Check contract addresses on each chain's block explorer:
- Blast: WETH 0x4300000000000000000000000000000000000004, USDB 0x4300000000000000000000000000000000000003
- Scroll: WETH 0x5300000000000000000000000000000000000004, USDC 0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4
- Mantle: WMNT 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8, USDC 0x09Bc4E0D10F09B1CdA8b8BB72C1e89F10B53BcA6
- Mode: WETH 0x4200000000000000000000000000000000000006, USDC 0xd988097fb8612cc24eeC14542bC03424c656005f

**Step 2: Add flash loan availability** (all 4 chains get entries in `FLASH_LOAN_AVAILABILITY`):
- Blast: all false (no native flash loans)
- Scroll: syncswap true (SyncSwap flash loans available)
- Mantle: all false
- Mode: all false

**Step 3: Add MEV config** — all 4 use `strategy: 'sequencer'` with low priority fees.

**Step 4: Update partitions** — add `'blast', 'scroll', 'mantle', 'mode'` to P2 (`l2-turbo`) chains array at line 245. Update `PHASE_METRICS` to reflect 15 chains (was 11).

**Step 5: Update execution chains** — add all 4 to `SUPPORTED_EXECUTION_CHAINS` set at line 232.

**Step 6: Build and typecheck**

Run: `npm run build:deps && npm run typecheck`
Expected: No type errors

**Step 7: Commit**

```bash
git add shared/config/src/tokens/index.ts shared/config/src/flash-loan-availability.ts shared/config/src/mev-config.ts shared/config/src/partitions.ts shared/config/src/service-config.ts
git commit -m "feat(config): add token, flash loan, MEV, partition, execution configs for new L2s"
```

---

### Task 8: Add config validation tests for new L2s

**Files:**
- Create: `shared/config/__tests__/emerging-l2s.test.ts`

**Step 1: Write validation tests**

Test that for each new chain (blast, scroll, mantle, mode):
- Chain exists in `CHAINS` with correct `id`
- DEXs exist in `DEXES` with at least 3 entries each
- Chain is in `MAINNET_CHAIN_IDS`
- Chain is in `SUPPORTED_EXECUTION_CHAINS`
- Chain is assigned to a partition (P2)
- Tokens exist in `CORE_TOKENS` with at least WETH/WMNT + USDC
- Flash loan availability entry exists
- MEV config entry exists

**Step 2: Run tests**

Run: `npx jest shared/config/__tests__/emerging-l2s.test.ts --verbose`
Expected: All pass

**Step 3: Commit**

```bash
git add shared/config/__tests__/emerging-l2s.test.ts
git commit -m "test(config): add validation tests for Blast, Scroll, Mantle, Mode"
```

---

## Group 2: Item #29 — Solana Execution with Jito Bundles

### Task 9: Add Solana types and update StrategyType for Solana

**Files:**
- Modify: `shared/types/src/index.ts` (add 'solana' to ArbitrageOpportunity.type union at line 176)
- Modify: `services/execution-engine/src/strategies/strategy-factory.ts` (add 'solana' to StrategyType at line 81, add to RegisteredStrategies at line 122)
- Modify: `shared/config/src/service-config.ts` (add 'solana' to SUPPORTED_EXECUTION_CHAINS at line 232)

**Step 1: Update types**

In `shared/types/src/index.ts` at line 176, add `'solana'` to the type union:
```typescript
type?: 'simple' | 'cross-dex' | 'triangular' | 'quadrilateral' | 'multi-leg' | 'cross-chain' | 'predictive' | 'intra-dex' | 'flash-loan' | 'backrun' | 'uniswapx' | 'solana' | 'statistical';
```

In `services/execution-engine/src/strategies/strategy-factory.ts`:
- Line 81: add `| 'solana' | 'statistical'` to StrategyType
- Line 122: add `solana?: ExecutionStrategy;` and `statistical?: ExecutionStrategy;` to RegisteredStrategies

Add `registerSolanaStrategy()` and `registerStatisticalStrategy()` methods following the existing pattern (e.g., `registerBackrunStrategy` at line 200).

Add resolution logic in `resolve()` method:
- After uniswapx check (line 392): `if (opportunity.type === 'solana' || opportunity.chain === 'solana')` → return solana strategy
- After solana check: `if (opportunity.type === 'statistical')` → return statistical strategy

**Step 2: Update execution chains**

In `shared/config/src/service-config.ts` at line 232, add `'solana'` to the set.

**Step 3: Build and typecheck**

Run: `npm run build:deps && npm run typecheck`
Expected: No type errors

**Step 4: Commit**

```bash
git add shared/types/src/index.ts services/execution-engine/src/strategies/strategy-factory.ts shared/config/src/service-config.ts
git commit -m "feat: add Solana and Statistical strategy types to factory and config"
```

---

### Task 10: Create Jupiter swap client

**Files:**
- Create: `services/execution-engine/src/solana/jupiter-client.ts`
- Create: `services/execution-engine/__tests__/unit/solana/jupiter-client.test.ts`

**Context:** Jupiter V6 API provides swap routing across all Solana DEXs. Two endpoints: `GET /quote` for route discovery, `POST /swap` for transaction building. The client handles retry logic, slippage adjustment, and response validation.

**Step 1: Write the failing test**

Test: `getQuote()` returns parsed quote with route, expected output, price impact. `getSwapTransaction()` returns serialized versioned transaction. Error handling for API failures, timeout, slippage exceeded.

**Step 2: Run test — verify failure**

Run: `npx jest services/execution-engine/__tests__/unit/solana/jupiter-client.test.ts --verbose`
Expected: FAIL (module not found)

**Step 3: Write JupiterSwapClient**

```typescript
import { createLogger } from '@arbitrage/core';

const logger = createLogger('jupiter-client');

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: JupiterRoutePlan[];
  swapMode: string;
}

export interface JupiterRoutePlan {
  ammKey: string;
  label: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  feeAmount: string;
  feeMint: string;
  percent: number;
}

export interface JupiterSwapResult {
  swapTransaction: string; // base64 encoded versioned transaction
  lastValidBlockHeight: number;
}

export interface JupiterClientConfig {
  apiUrl: string; // default: 'https://quote-api.jup.ag/v6'
  timeoutMs: number; // default: 10000
  maxRetries: number; // default: 2
  defaultSlippageBps: number; // default: 50 (0.5%)
}

export class JupiterSwapClient {
  private readonly config: JupiterClientConfig;

  constructor(config: Partial<JupiterClientConfig> = {}) {
    this.config = {
      apiUrl: config.apiUrl ?? 'https://quote-api.jup.ag/v6',
      timeoutMs: config.timeoutMs ?? 10000,
      maxRetries: config.maxRetries ?? 2,
      defaultSlippageBps: config.defaultSlippageBps ?? 50,
    };
  }

  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string; // lamports
    slippageBps?: number;
  }): Promise<JupiterQuote> {
    const slippage = params.slippageBps ?? this.config.defaultSlippageBps;
    const url = `${this.config.apiUrl}/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${slippage}`;

    const response = await this.fetchWithRetry(url);
    return response as JupiterQuote;
  }

  async getSwapTransaction(params: {
    quoteResponse: JupiterQuote;
    userPublicKey: string;
    wrapAndUnwrapSol?: boolean;
    computeUnitPriceMicroLamports?: number;
  }): Promise<JupiterSwapResult> {
    const url = `${this.config.apiUrl}/swap`;
    const body = {
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
      computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports ?? 'auto',
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response as JupiterSwapResult;
  }

  private async fetchWithRetry(url: string, init?: RequestInit): Promise<unknown> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        const response = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
        }
        return await response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.config.maxRetries) {
          logger.warn('Jupiter API retry', { attempt: attempt + 1, error: lastError.message });
        }
      }
    }
    throw lastError;
  }
}
```

**Step 4: Run tests — verify pass**

Run: `npx jest services/execution-engine/__tests__/unit/solana/jupiter-client.test.ts --verbose`
Expected: All pass

**Step 5: Commit**

```bash
git add services/execution-engine/src/solana/jupiter-client.ts services/execution-engine/__tests__/unit/solana/jupiter-client.test.ts
git commit -m "feat: add Jupiter V6 swap client for Solana execution"
```

---

### Task 11: Create Solana transaction builder

**Files:**
- Create: `services/execution-engine/src/solana/transaction-builder.ts`
- Create: `services/execution-engine/__tests__/unit/solana/transaction-builder.test.ts`

**Context:** Composes a Solana versioned transaction from Jupiter's swap instructions + Jito tip transfer. Uses `@solana/web3.js` for transaction construction.

**Step 1: Write failing test** — test that builder composes compute budget instruction + Jupiter swap + Jito tip into a single versioned transaction.

**Step 2: Run test — verify failure**

**Step 3: Write SolanaTransactionBuilder**

Key responsibilities:
- Deserialize Jupiter's base64 transaction
- Add compute budget instructions (ComputeBudgetProgram.setComputeUnitLimit, setComputeUnitPrice)
- Add Jito tip transfer instruction (SystemProgram.transfer to random tip account)
- Re-sign with execution wallet keypair
- Serialize for Jito bundle submission

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add services/execution-engine/src/solana/transaction-builder.ts services/execution-engine/__tests__/unit/solana/transaction-builder.test.ts
git commit -m "feat: add Solana transaction builder with Jito tip integration"
```

---

### Task 12: Create SolanaExecutionStrategy

**Files:**
- Create: `services/execution-engine/src/strategies/solana-execution.strategy.ts`
- Create: `services/execution-engine/__tests__/unit/strategies/solana-execution.strategy.test.ts`

**Context:** This strategy handles Solana-specific execution flow: get Jupiter quote → build transaction → simulate via Jito → submit bundle. It does NOT extend `BaseExecutionStrategy` (which is EVM-specific) but implements the `ExecutionStrategy` interface directly.

**Step 1: Write failing test** — test execute() flow: mocked Jupiter client returns quote, mocked transaction builder returns tx, mocked Jito provider simulates and submits.

**Step 2: Run test — verify failure**

**Step 3: Write SolanaExecutionStrategy**

```typescript
import { ExecutionStrategy, StrategyContext, ExecutionResult } from '../../types';
import { ArbitrageOpportunity } from '@arbitrage/types';
import { JupiterSwapClient } from '../solana/jupiter-client';
import { SolanaTransactionBuilder } from '../solana/transaction-builder';
import { JitoProvider } from '@arbitrage/core';
import { createLogger } from '@arbitrage/core';

const logger = createLogger('solana-execution');

export interface SolanaExecutionConfig {
  walletPublicKey: string;
  walletKeypair: Uint8Array; // Solana keypair bytes
  tipLamports: number; // Jito tip (default: 1_000_000 = 0.001 SOL)
  maxSlippageBps: number; // default: 100 (1%)
  minProfitLamports: bigint; // minimum profit after tip
  maxPriceDeviationPct: number; // abort if quote deviates from detection price
}

export class SolanaExecutionStrategy implements ExecutionStrategy {
  constructor(
    private readonly jupiterClient: JupiterSwapClient,
    private readonly txBuilder: SolanaTransactionBuilder,
    private readonly jitoProvider: JitoProvider,
    private readonly config: SolanaExecutionConfig,
  ) {}

  async execute(opportunity: ArbitrageOpportunity, ctx: StrategyContext): Promise<ExecutionResult> {
    // 1. Get Jupiter quote
    const quote = await this.jupiterClient.getQuote({
      inputMint: opportunity.tokenIn!,
      outputMint: opportunity.tokenOut!,
      amount: opportunity.amountIn!,
      slippageBps: this.config.maxSlippageBps,
    });

    // 2. Check price deviation from detection time
    const expectedOutput = Number(opportunity.amountIn!) * (opportunity.sellPrice ?? 0);
    const actualOutput = Number(quote.outAmount);
    const deviation = Math.abs(actualOutput - expectedOutput) / expectedOutput;
    if (deviation > this.config.maxPriceDeviationPct / 100) {
      return { success: false, error: 'Price deviation exceeded threshold' };
    }

    // 3. Build transaction with Jito tip
    const swapResult = await this.jupiterClient.getSwapTransaction({
      quoteResponse: quote,
      userPublicKey: this.config.walletPublicKey,
    });

    const transaction = await this.txBuilder.buildBundleTransaction(
      swapResult.swapTransaction,
      this.config.walletKeypair,
      this.config.tipLamports,
    );

    // 4. Simulate via Jito
    const simResult = await this.jitoProvider.simulateBundle([transaction]);
    if (!simResult.success) {
      return { success: false, error: `Jito simulation failed: ${simResult.error}` };
    }

    // 5. Submit bundle
    const submitResult = await this.jitoProvider.submitBundle([transaction]);
    return {
      success: submitResult.success,
      txHash: submitResult.bundleId,
      error: submitResult.error,
    };
  }
}
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add services/execution-engine/src/strategies/solana-execution.strategy.ts services/execution-engine/__tests__/unit/strategies/solana-execution.strategy.test.ts
git commit -m "feat: add SolanaExecutionStrategy with Jupiter + Jito integration"
```

---

### Task 13: Wire Solana strategy into engine

**Files:**
- Modify: `services/execution-engine/src/engine.ts` (~line 1028, after UniswapX registration)

**Step 1: Add Solana strategy initialization** behind feature flag `FEATURE_SOLANA_EXECUTION`:

```typescript
if (process.env.FEATURE_SOLANA_EXECUTION === 'true') {
  const jupiterClient = new JupiterSwapClient({ apiUrl: process.env.JUPITER_API_URL });
  const txBuilder = new SolanaTransactionBuilder();
  const jitoProvider = new JitoProvider(/* existing config */);
  const solanaStrategy = new SolanaExecutionStrategy(jupiterClient, txBuilder, jitoProvider, {
    walletPublicKey: process.env.SOLANA_WALLET_PUBLIC_KEY!,
    walletKeypair: Buffer.from(process.env.SOLANA_WALLET_KEYPAIR!, 'base64'),
    tipLamports: Number(process.env.JITO_TIP_LAMPORTS ?? 1_000_000),
    maxSlippageBps: Number(process.env.SOLANA_MAX_SLIPPAGE_BPS ?? 100),
    minProfitLamports: BigInt(process.env.SOLANA_MIN_PROFIT_LAMPORTS ?? '5000000'),
    maxPriceDeviationPct: Number(process.env.SOLANA_MAX_PRICE_DEVIATION_PCT ?? 1),
  });
  this.strategyFactory.registerSolanaStrategy(solanaStrategy);
  this.logger.info('Solana execution strategy registered');
}
```

**Step 2: Build and typecheck**

Run: `npm run build && npm run typecheck`

**Step 3: Commit**

```bash
git add services/execution-engine/src/engine.ts
git commit -m "feat: wire SolanaExecutionStrategy into execution engine"
```

---

## Group 3A: Item #31 — Statistical Arbitrage Module

### Task 14: Create PairCorrelationTracker

**Files:**
- Create: `shared/core/src/analytics/pair-correlation-tracker.ts`
- Create: `shared/core/__tests__/unit/analytics/pair-correlation-tracker.test.ts`

**Context:** Calculates rolling Pearson correlation between two price series. Uses circular buffer (same pattern as `PriceMomentumTracker`). Signals pair eligibility for statistical arbitrage when correlation > threshold.

**Step 1: Write failing test** — test `addSample()` and `getCorrelation()` with known data (e.g., perfectly correlated series → r=1.0, uncorrelated → r≈0).

**Step 2: Run test — verify failure**

**Step 3: Implement PairCorrelationTracker**

Key methods:
- `addSample(pairId: string, priceA: number, priceB: number, timestamp: number)` — adds to circular buffers
- `getCorrelation(pairId: string): number` — returns Pearson r in [-1, 1]
- `isCointegrated(pairId: string): boolean` — simplified Engle-Granger: runs OLS on price_A vs price_B, checks if residuals are mean-reverting (variance test)
- `getEligiblePairs(): string[]` — returns pairs with correlation > configurable threshold (default 0.7)

Config interface:
```typescript
export interface CorrelationConfig {
  windowSize: number; // default: 60
  minCorrelation: number; // default: 0.7
  maxPairs: number; // default: 50
}
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/analytics/pair-correlation-tracker.ts shared/core/__tests__/unit/analytics/pair-correlation-tracker.test.ts
git commit -m "feat: add PairCorrelationTracker with Pearson correlation and cointegration"
```

---

### Task 15: Create SpreadTracker with Bollinger Bands

**Files:**
- Create: `shared/core/src/analytics/spread-tracker.ts`
- Create: `shared/core/__tests__/unit/analytics/spread-tracker.test.ts`

**Step 1: Write failing test** — test that `addSpread()` builds correct Bollinger Bands and `getSignal()` returns 'entry_long', 'entry_short', or 'none' based on σ crossings.

**Step 2: Run test — verify failure**

**Step 3: Implement SpreadTracker**

Key methods:
- `addSpread(pairId: string, priceA: number, priceB: number)` — computes `log(priceA/priceB)`, adds to rolling window
- `getSignal(pairId: string): SpreadSignal` — checks spread vs Bollinger Bands
- `getBollingerBands(pairId: string): { upper: number; middle: number; lower: number }`

```typescript
export type SpreadSignal = 'entry_long' | 'entry_short' | 'exit' | 'none';

export interface SpreadConfig {
  bollingerPeriod: number; // default: 20
  bollingerStdDev: number; // default: 2.0
  maxPairs: number; // default: 50
}
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/analytics/spread-tracker.ts shared/core/__tests__/unit/analytics/spread-tracker.test.ts
git commit -m "feat: add SpreadTracker with Bollinger Bands for statistical arbitrage"
```

---

### Task 16: Create RegimeDetector (Hurst exponent)

**Files:**
- Create: `shared/core/src/analytics/regime-detector.ts`
- Create: `shared/core/__tests__/unit/analytics/regime-detector.test.ts`

**Step 1: Write failing test** — test with known series: random walk → H≈0.5, mean-reverting (sinusoidal) → H<0.5, trending (cumulative sum) → H>0.5.

**Step 2: Run test — verify failure**

**Step 3: Implement RegimeDetector**

Uses Rescaled Range (R/S) method:
1. Split series into subseries of length n
2. For each subseries: compute mean, cumulative deviation, range R, std dev S
3. R/S ratio averaged across subseries
4. Repeat for multiple n values
5. Hurst exponent H = slope of log(R/S) vs log(n)

```typescript
export type Regime = 'mean_reverting' | 'trending' | 'random_walk';

export interface RegimeConfig {
  windowSize: number; // default: 100
  hurstThresholdLow: number; // default: 0.4 (below = mean reverting)
  hurstThresholdHigh: number; // default: 0.6 (above = trending)
}

export class RegimeDetector {
  getRegime(pairId: string): Regime;
  getHurstExponent(pairId: string): number;
  addSample(pairId: string, spread: number): void;
}
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/analytics/regime-detector.ts shared/core/__tests__/unit/analytics/regime-detector.test.ts
git commit -m "feat: add RegimeDetector with Hurst exponent for stat arb regime classification"
```

---

### Task 17: Create StatisticalArbitrageDetector

**Files:**
- Create: `shared/core/src/detector/statistical-arbitrage-detector.ts`
- Create: `shared/core/__tests__/unit/detector/statistical-arbitrage-detector.test.ts`

**Context:** Orchestrates PairCorrelationTracker, SpreadTracker, and RegimeDetector to generate statistical arbitrage opportunities. Emits `ArbitrageOpportunity` with `type: 'statistical'`.

**Step 1: Write failing test** — test that when spread crosses ±2σ AND regime is mean-reverting AND correlation > 0.7, an opportunity is emitted. Test that signals are suppressed during trending regimes.

**Step 2: Run test — verify failure**

**Step 3: Implement StatisticalArbitrageDetector**

EventEmitter-based (same pattern as `SolanaArbitrageDetector`):
```typescript
export class StatisticalArbitrageDetector extends EventEmitter {
  constructor(
    private readonly correlationTracker: PairCorrelationTracker,
    private readonly spreadTracker: SpreadTracker,
    private readonly regimeDetector: RegimeDetector,
    private readonly config: StatArbDetectorConfig,
  ) {}

  onPriceUpdate(pairId: string, priceA: number, priceB: number): void {
    // Update all trackers, check for signal, emit opportunity if conditions met
  }
}
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/detector/statistical-arbitrage-detector.ts shared/core/__tests__/unit/detector/statistical-arbitrage-detector.test.ts
git commit -m "feat: add StatisticalArbitrageDetector combining correlation, spread, and regime"
```

---

### Task 18: Create StatisticalArbitrageStrategy

**Files:**
- Create: `services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts`
- Create: `services/execution-engine/__tests__/unit/strategies/statistical-arbitrage.strategy.test.ts`

**Context:** Executes statistical arb by: (1) flash loan the overvalued token, (2) sell for undervalued token, (3) buy undervalued token at discount, (4) repay flash loan. Atomic within a single transaction using the existing flash loan infrastructure.

**Step 1: Write failing test**

**Step 2: Run test — verify failure**

**Step 3: Implement StatisticalArbitrageStrategy** extending `BaseExecutionStrategy`

Key: translates stat arb signal into a flash loan swap path. The "long cheap, short expensive" is expressed as a multi-hop flash loan path where the first hop borrows the expensive token, swaps to cheap, swaps back at a different DEX (where the spread is tighter), and repays.

**Step 4: Run tests — verify pass**

**Step 5: Wire into engine** (in `engine.ts`, behind `FEATURE_STATISTICAL_ARB` flag)

**Step 6: Commit**

```bash
git add services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts services/execution-engine/__tests__/unit/strategies/statistical-arbitrage.strategy.test.ts services/execution-engine/src/engine.ts
git commit -m "feat: add StatisticalArbitrageStrategy and wire into execution engine"
```

---

## Group 3B: Item #32 — CEX Price Signals (Binance)

### Task 19: Create Binance WebSocket client

**Files:**
- Create: `shared/core/src/feeds/binance-ws-client.ts`
- Create: `shared/core/__tests__/unit/feeds/binance-ws-client.test.ts`

**Context:** Connects to Binance combined stream WebSocket for real-time trade data. Handles auto-reconnect, heartbeat (pong), and backpressure. Read-only — no trading API calls.

**Step 1: Write failing test** — test message parsing (Binance trade event format), reconnect logic, subscription management.

**Step 2: Run test — verify failure**

**Step 3: Implement BinanceWebSocketClient**

```typescript
export interface BinanceTradeEvent {
  symbol: string; // e.g. 'BTCUSDT'
  price: number;
  quantity: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

export interface BinanceWsConfig {
  streams: string[]; // e.g. ['btcusdt@trade', 'ethusdt@trade']
  reconnectDelayMs: number; // default: 1000
  maxReconnectDelayMs: number; // default: 30000
  pingIntervalMs: number; // default: 30000
}

export class BinanceWebSocketClient extends EventEmitter {
  constructor(config: BinanceWsConfig);
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  // Emits 'trade' event with BinanceTradeEvent
}
```

Binance combined stream URL: `wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade/...`

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/feeds/binance-ws-client.ts shared/core/__tests__/unit/feeds/binance-ws-client.test.ts
git commit -m "feat: add Binance WebSocket client for CEX price signals"
```

---

### Task 20: Create CEX price normalizer

**Files:**
- Create: `shared/core/src/feeds/cex-price-normalizer.ts`
- Create: `shared/core/__tests__/unit/feeds/cex-price-normalizer.test.ts`

**Step 1: Write failing test** — test symbol mapping (BTCUSDT → WBTC), price normalization, unknown symbol handling.

**Step 2: Run test — verify failure**

**Step 3: Implement CexPriceNormalizer**

Maps Binance symbols to internal token IDs:
```typescript
const BINANCE_TO_INTERNAL: Record<string, { tokenId: string; chains: string[] }> = {
  'BTCUSDT': { tokenId: 'WBTC', chains: ['ethereum', 'arbitrum', 'base'] },
  'ETHUSDT': { tokenId: 'WETH', chains: ['ethereum', 'arbitrum', 'base', 'optimism'] },
  'BNBUSDT': { tokenId: 'WBNB', chains: ['bsc'] },
  'SOLUSDT': { tokenId: 'SOL', chains: ['solana'] },
  'AVAXUSDT': { tokenId: 'WAVAX', chains: ['avalanche'] },
  'MATICUSDT': { tokenId: 'WMATIC', chains: ['polygon'] },
  'ARBUSDT': { tokenId: 'ARB', chains: ['arbitrum'] },
  'OPUSDT': { tokenId: 'OP', chains: ['optimism'] },
};
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/feeds/cex-price-normalizer.ts shared/core/__tests__/unit/feeds/cex-price-normalizer.test.ts
git commit -m "feat: add CEX price normalizer for Binance symbol mapping"
```

---

### Task 21: Create CEX-DEX spread calculator

**Files:**
- Create: `shared/core/src/analytics/cex-dex-spread.ts`
- Create: `shared/core/__tests__/unit/analytics/cex-dex-spread.test.ts`

**Step 1: Write failing test** — test spread calculation (CEX price vs DEX price), rolling history, alert threshold crossing.

**Step 2: Run test — verify failure**

**Step 3: Implement CexDexSpreadCalculator**

```typescript
export interface SpreadAlert {
  tokenId: string;
  chain: string;
  cexPrice: number;
  dexPrice: number;
  spreadPct: number; // positive = DEX overpriced, negative = DEX underpriced
  timestamp: number;
}

export class CexDexSpreadCalculator extends EventEmitter {
  constructor(config: { alertThresholdPct: number; historyWindowMs: number });
  updateCexPrice(tokenId: string, price: number, timestamp: number): void;
  updateDexPrice(tokenId: string, chain: string, price: number, timestamp: number): void;
  getSpread(tokenId: string, chain: string): number | undefined;
  // Emits 'spread_alert' event with SpreadAlert
}
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/analytics/cex-dex-spread.ts shared/core/__tests__/unit/analytics/cex-dex-spread.test.ts
git commit -m "feat: add CEX-DEX spread calculator with alert system"
```

---

## Group 4: Item #28 — CoW Protocol Watch-Only + Backrun

### Task 22: Create CoW settlement watcher

**Files:**
- Create: `shared/core/src/feeds/cow-settlement-watcher.ts`
- Create: `shared/core/__tests__/unit/feeds/cow-settlement-watcher.test.ts`

**Context:** Subscribes to GPv2Settlement contract events on Ethereum. Decodes Trade events to extract settlement details. Only monitors — does not interact with CoW Protocol API.

**Step 1: Write failing test** — test event decoding (Trade event ABI), filtering (volume threshold), settlement parsing.

**Step 2: Run test — verify failure**

**Step 3: Implement CowSettlementWatcher**

```typescript
const GPV2_SETTLEMENT_ADDRESS = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';

// GPv2Settlement Trade event ABI
const TRADE_EVENT_ABI = [
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
];

export interface CowSettlement {
  txHash: string;
  blockNumber: number;
  trades: CowTrade[];
  totalVolumeUsd: number;
}

export interface CowTrade {
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  feeAmount: bigint;
}

export class CowSettlementWatcher extends EventEmitter {
  constructor(config: {
    provider: ethers.WebSocketProvider;
    minVolumeUsd: number; // default: 50000
  });
  start(): Promise<void>;
  stop(): Promise<void>;
  // Emits 'settlement' event with CowSettlement
}
```

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/feeds/cow-settlement-watcher.ts shared/core/__tests__/unit/feeds/cow-settlement-watcher.test.ts
git commit -m "feat: add CoW Protocol settlement watcher for backrun detection"
```

---

### Task 23: Create CoW backrun detector

**Files:**
- Create: `shared/core/src/detector/cow-backrun-detector.ts`
- Create: `shared/core/__tests__/unit/detector/cow-backrun-detector.test.ts`

**Context:** Takes CowSettlement events from the watcher and generates backrun opportunities by computing the price impact of the settlement on affected pools.

**Step 1: Write failing test** — test that a large settlement (>$50K) affecting a Uniswap pool generates a backrun opportunity with correct token pair and estimated profit.

**Step 2: Run test — verify failure**

**Step 3: Implement CowBackrunDetector**

```typescript
export class CowBackrunDetector extends EventEmitter {
  constructor(
    private readonly settlementWatcher: CowSettlementWatcher,
    private readonly config: { minProfitUsd: number; maxBlockDelay: number },
  );
  start(): void; // Subscribe to settlement events
  stop(): void;
  // Emits 'opportunity' event with ArbitrageOpportunity (type: 'backrun')
}
```

The detector:
1. Receives settlement event
2. For each trade in settlement, checks if affected tokens have pools on monitored DEXs
3. Estimates price displacement using pool reserves and trade size
4. If displacement > gas cost + min profit, generates backrun opportunity
5. Sets `backrunTarget.txHash` to the settlement tx hash for Flashbots bundle construction

**Step 4: Run tests — verify pass**

**Step 5: Commit**

```bash
git add shared/core/src/detector/cow-backrun-detector.ts shared/core/__tests__/unit/detector/cow-backrun-detector.test.ts
git commit -m "feat: add CoW Protocol backrun detector for settlement-based opportunities"
```

---

## Documentation Updates

### Task 24: Create ADR-034 (Solana Execution via Jupiter + Jito)

**Files:**
- Create: `docs/architecture/adr/ADR-034-solana-execution.md`
- Modify: `docs/architecture/adr/README.md` (add index entry)

**Content:**

```markdown
# ADR-034: Solana Execution via Jupiter + Jito

**Status:** Accepted
**Date:** 2026-02-24
**Confidence:** 85%

## Context

Solana partition (P4) has been detect-only since launch. Detection infrastructure
(7 DEXs, cross-chain price comparison) and Jito MEV provider (bundle submission,
simulation, tip accounts) are fully built. The missing piece is execution.

## Decision

Use Jupiter V6 aggregator API for swap routing and Jito Block Engine for
MEV-protected bundle submission.

### Jupiter API (not native program instructions)
- Handles routing across all 7 Solana DEXs automatically
- Returns pre-built versioned transactions
- Trade-off: external dependency on Jupiter API availability
- Alternative rejected: native program instructions for each DEX (Raydium, Orca, etc.)
  would require per-DEX instruction encoding with much higher maintenance burden

### Jito Bundles (not public RPC)
- All Solana trades submitted as Jito bundles to prevent sandwich attacks
- Tip amount configurable (default 0.001 SOL)
- Fallback to public RPC if Jito fails (configurable)

### SolanaExecutionStrategy (not BaseExecutionStrategy extension)
- Implements ExecutionStrategy interface directly
- Solana transaction model is fundamentally different from EVM
- No gas estimation (uses compute units instead)
- No nonce management (uses recent blockhash)

## Consequences
- Solana detection-only limitation is lifted
- Jupiter API becomes a critical dependency for Solana execution
- Jito tip costs reduce profit margin (0.001 SOL ≈ $0.15 at current prices)
- Feature flag FEATURE_SOLANA_EXECUTION controls activation
```

**Step 1: Write ADR file**

**Step 2: Add to README.md index table** at `docs/architecture/adr/README.md`

**Step 3: Commit**

```bash
git add docs/architecture/adr/ADR-034-solana-execution.md docs/architecture/adr/README.md
git commit -m "docs: add ADR-034 Solana execution via Jupiter + Jito"
```

---

### Task 25: Create ADR-035 (Statistical Arbitrage Strategy)

**Files:**
- Create: `docs/architecture/adr/ADR-035-statistical-arbitrage.md`
- Modify: `docs/architecture/adr/README.md` (add index entry)

**Content covers:**
- Decision to add non-atomic strategy type (holds implicit positions within atomic flash loans)
- Three-component signal generation (correlation, spread, regime)
- Target pairs and why (correlated majors for lower risk)
- Risk controls: regime gating, correlation threshold, position sizing via Kelly criterion
- Why Hurst exponent over other regime detection methods (simplicity, well-understood, no ML dependency)
- Integration with existing PriceMomentumTracker analytics

**Step 1: Write ADR file**

**Step 2: Add to README.md index**

**Step 3: Commit**

```bash
git add docs/architecture/adr/ADR-035-statistical-arbitrage.md docs/architecture/adr/README.md
git commit -m "docs: add ADR-035 statistical arbitrage strategy"
```

---

### Task 26: Create ADR-036 (CEX Price Signal Integration)

**Files:**
- Create: `docs/architecture/adr/ADR-036-cex-price-signals.md`
- Modify: `docs/architecture/adr/README.md` (add index entry)

**Content covers:**
- Decision to add Binance as read-only price source (not trading)
- Why Binance only (highest liquidity, free API, covers 90%+ signal value)
- WebSocket combined stream architecture (single connection, multiple symbols)
- PriceMatrix integration as new source type
- Feature flag pattern for opt-in activation
- Security: no API key needed for public trade stream, no write operations
- Alternatives rejected: multiple exchanges (complexity vs marginal gain), REST polling (latency)

**Step 1: Write ADR file**

**Step 2: Add to README.md index**

**Step 3: Commit**

```bash
git add docs/architecture/adr/ADR-036-cex-price-signals.md docs/architecture/adr/README.md
git commit -m "docs: add ADR-036 CEX price signal integration (Binance)"
```

---

### Task 27: Update CURRENT_STATE.md and ARCHITECTURE_V2.md

**Files:**
- Modify: `docs/architecture/CURRENT_STATE.md`
- Modify: `docs/architecture/ARCHITECTURE_V2.md`

**Updates to CURRENT_STATE.md:**
1. Update Service Inventory: note that execution engine now supports Solana (when FEATURE_SOLANA_EXECUTION enabled)
2. Update Partition Architecture: P2 now includes Blast, Scroll, Mantle, Mode (7 chains)
3. Update chain count: 15 chains (was 11)
4. Update DEX count: ~72 DEXs (was 57, adding ~15 new across 4 chains)
5. Add new strategies section: statistical arbitrage, Solana execution
6. Add new data sources section: Binance CEX feed, CoW settlement watcher

**Updates to ARCHITECTURE_V2.md:**
1. Update chain coverage diagram
2. Add statistical arbitrage to strategy overview
3. Add CEX price signals to data flow diagram
4. Update version to 2.9

**Step 1: Make updates**

**Step 2: Commit**

```bash
git add docs/architecture/CURRENT_STATE.md docs/architecture/ARCHITECTURE_V2.md
git commit -m "docs: update architecture docs for Phase 3 (15 chains, stat arb, CEX signals, Solana exec)"
```

---

### Task 28: Update Deep Enhancement Analysis report

**Files:**
- Modify: `docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md`

**Updates:**
- Section 9 (Prioritized Roadmap), Phase 3 table: add Status column showing implementation status for each item
- Section 10 (Architecture Rework Decision Matrix): update status for items that are now implemented
- Add note at top of Phase 3 section referencing the design doc and implementation plan

**Step 1: Make updates**

**Step 2: Commit**

```bash
git add docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md
git commit -m "docs: update Phase 3 status in Deep Enhancement Analysis report"
```

---

### Task 29: Final build, typecheck, and test validation

**Step 1: Full build**

Run: `npm run build:clean`
Expected: Clean build with no errors

**Step 2: Type check**

Run: `npm run typecheck`
Expected: No type errors

**Step 3: Run all tests**

Run: `npm test`
Expected: All existing + new tests pass

**Step 4: Run contract tests**

Run: `cd contracts && npx hardhat test`
Expected: All contract tests pass (including new DaiFlashMintArbitrage tests)

**Step 5: Final commit** (if any fixups needed)

```bash
git add -A && git commit -m "fix: resolve any build/test issues from Phase 3 implementation"
```

---

## Summary

| Task | Item | Description | Files |
|------|------|-------------|-------|
| 1 | #30 | MockDssFlash contract | contracts/src/mocks/ |
| 2 | #30 | DaiFlashMintArbitrage contract | contracts/src/ |
| 3 | #30 | Contract tests | contracts/test/ |
| 4 | #30 | Provider unit tests | services/execution-engine/__tests__/ |
| 5 | #33 | Chain configs (4 L2s) | shared/config/src/chains/ |
| 6 | #33 | DEX configs (4 L2s) | shared/config/src/dexes/ |
| 7 | #33 | Token/flash loan/MEV/partition/exec configs | shared/config/src/ (5 files) |
| 8 | #33 | Config validation tests | shared/config/__tests__/ |
| 9 | #29 | Strategy types + factory updates | shared/types/, strategies/ |
| 10 | #29 | Jupiter swap client | services/execution-engine/src/solana/ |
| 11 | #29 | Solana transaction builder | services/execution-engine/src/solana/ |
| 12 | #29 | SolanaExecutionStrategy | services/execution-engine/src/strategies/ |
| 13 | #29 | Wire into engine | services/execution-engine/src/engine.ts |
| 14 | #31 | PairCorrelationTracker | shared/core/src/analytics/ |
| 15 | #31 | SpreadTracker | shared/core/src/analytics/ |
| 16 | #31 | RegimeDetector | shared/core/src/analytics/ |
| 17 | #31 | StatisticalArbitrageDetector | shared/core/src/detector/ |
| 18 | #31 | StatisticalArbitrageStrategy | services/execution-engine/src/strategies/ |
| 19 | #32 | Binance WebSocket client | shared/core/src/feeds/ |
| 20 | #32 | CEX price normalizer | shared/core/src/feeds/ |
| 21 | #32 | CEX-DEX spread calculator | shared/core/src/analytics/ |
| 22 | #28 | CoW settlement watcher | shared/core/src/feeds/ |
| 23 | #28 | CoW backrun detector | shared/core/src/detector/ |
| 24 | docs | ADR-034 Solana Execution | docs/architecture/adr/ |
| 25 | docs | ADR-035 Statistical Arbitrage | docs/architecture/adr/ |
| 26 | docs | ADR-036 CEX Price Signals | docs/architecture/adr/ |
| 27 | docs | Update CURRENT_STATE + ARCHITECTURE_V2 | docs/architecture/ |
| 28 | docs | Update Enhancement Analysis report | docs/reports/ |
| 29 | all | Final build + typecheck + test validation | — |
