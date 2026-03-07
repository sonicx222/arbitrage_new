# Smart Contracts

Flash loan arbitrage contracts (Solidity ^0.8.19) with 6 protocol-specific implementations, MEV protection via commit-reveal, and a stateless batch quoting utility.

## Contract Architecture

```
BaseFlashArbitrage (abstract, v2.1.0, 1135 LOC)
├── FlashLoanArbitrage (Aave V3) ── executeOperation callback
├── BalancerV2FlashArbitrage (Balancer V2) ── receiveFlashLoan callback (0% fee)
├── PancakeSwapFlashArbitrage (PancakeSwap V3) ── pancakeV3FlashCallback
├── SyncSwapFlashArbitrage (SyncSwap/zkSync) ── onFlashLoan (EIP-3156)
├── DaiFlashMintArbitrage (MakerDAO DssFlash) ── onFlashLoan (EIP-3156, DAI only)
└── CommitRevealArbitrage (v3.1.0) ── MEV-protected commit-reveal scheme

MultiPathQuoter (v1.0.0) ── Stateless batch quoting (max 20 paths, 5 hops)
```

## Quick Start

```bash
# Compile contracts
npx hardhat compile

# Run all tests
npx hardhat test

# Run specific test
npx hardhat test test/FlashLoanArbitrage.test.ts

# Coverage report
npx hardhat coverage
```

## Access Model

All `executeArbitrage()` / `reveal()` functions use **OPEN ACCESS** (no `onlyOwner`). The atomic flash loan model with profit verification prevents fund extraction. Admin functions (`pause`, `withdraw`, `setConfig`) use `onlyOwner` via Ownable2Step.

## OpenZeppelin 4.9.6 Patterns

| Pattern | Usage |
|---------|-------|
| **Ownable2Step** | Two-step ownership transfer for admin functions |
| **Pausable** | Emergency pause on all critical functions |
| **ReentrancyGuard** | `nonReentrant` on all external entry points |
| **SafeERC20** | `safeTransfer`, `forceApprove` for all token operations |
| **EnumerableSet** | O(1) approved router management |

## Testing Patterns

- **Framework**: Hardhat + Chai + ethers v6
- **Fixtures**: `loadFixture(deployContractsFixture)` for snapshot/restore
- **OZ4 assertion style**: String-based `require()` messages, NOT custom errors for ERC20 operations
  ```typescript
  // Contract custom errors
  await expect(tx).to.be.revertedWithCustomError(contract, 'InsufficientProfit');
  // OZ4 string errors
  await expect(tx).to.be.revertedWith('ERC20: transfer amount exceeds balance');
  ```
- **Token decimals**: WETH/DAI (18 decimals), USDC/USDT (6 decimals)
- **Mock fees**: Aave 9bps, Balancer 0%, SyncSwap 0.3%, PancakeSwap tier-based

## Directory Structure

```
contracts/
├── src/
│   ├── base/           BaseFlashArbitrage.sol (abstract)
│   ├── interfaces/     Protocol interfaces (Aave, Balancer, PancakeSwap, SyncSwap, EIP-3156)
│   ├── mocks/          Test mocks (DexRouter, AavePool, BalancerVault, MaliciousRouter)
│   ├── adapters/       DEX-specific swap adapters
│   └── libraries/      SwapHelpers and utilities
├── test/               Hardhat test suites
├── scripts/            Deployment scripts (use ?? 0, not || 0)
├── docs/
│   ├── PRE_DEPLOYMENT_CHECKLIST.md
│   └── SECURITY_REVIEW.md
└── deployments/        Chain-specific deployment addresses
```

## Key Design Decisions

- `minimumProfit` enforced non-zero (setter rejects 0) to prevent grief attacks
- Router validation is per-step (each hop independently checks `approvedRouters.contains()`)
- Profit tracking follows CEI pattern (state updates before external interactions)
- `withdrawETH()` uses configurable gas limit (default 50000) to support multisig wallets
- Fee-on-transfer tokens and rebasing tokens are NOT supported

## Related Documentation

- [ADR-020: Flash Loan Integration](../docs/architecture/adr/ADR-020-flash-loan.md)
- [ADR-029: Batched Quote Fetching](../docs/architecture/adr/ADR-029-batched-quote-fetching.md)
- [ADR-030: PancakeSwap V3 Flash Loans](../docs/architecture/adr/ADR-030-pancakeswap-v3-flash-loans.md)
- [ADR-032: Flash Loan Provider Aggregation](../docs/architecture/adr/ADR-032-flash-loan-provider-aggregation.md)
- [Security Review](docs/SECURITY_REVIEW.md)
- [Pre-Deployment Checklist](docs/PRE_DEPLOYMENT_CHECKLIST.md)
