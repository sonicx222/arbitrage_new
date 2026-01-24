# ADR-020: Flash Loan Integration

## Status
**Accepted** (Partial Implementation)

## Date
2026-01-24

## Context

Traditional arbitrage requires capital lockup:

1. **Capital inefficiency**: Funds locked in wallets across chains
2. **Opportunity limits**: Can only execute trades up to available capital
3. **Risk exposure**: Capital at risk during execution
4. **Scaling limits**: Growth requires more capital

Flash loans enable zero-capital arbitrage by borrowing and repaying within a single transaction.

## Decision

Integrate Aave V3 flash loans with a custom arbitrage contract:

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         FLASH LOAN EXECUTION FLOW                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  FlashLoanStrategy                                                               │
│       │                                                                          │
│       ├── 1. Analyze profitability (fee: 0.09%)                                 │
│       │                                                                          │
│       ├── 2. Build swap path with slippage protection                           │
│       │                                                                          │
│       └── 3. Call FlashLoanArbitrage.sol                                        │
│                     │                                                            │
│                     ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  FlashLoanArbitrage.sol                                                  │    │
│  │                                                                          │    │
│  │  executeArbitrage(token, amount, swapPath[], minProfit)                 │    │
│  │       │                                                                  │    │
│  │       ├── Request flash loan from Aave V3                               │    │
│  │       │                                                                  │    │
│  │       ├── executeOperation() callback:                                  │    │
│  │       │   ├── Execute swap 1 (buy)                                      │    │
│  │       │   ├── Execute swap 2 (sell)                                     │    │
│  │       │   └── [Execute swap N...]                                       │    │
│  │       │                                                                  │    │
│  │       ├── Verify profit >= minProfit                                    │    │
│  │       │                                                                  │    │
│  │       └── Repay loan + 0.09% fee                                        │    │
│  │                                                                          │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Smart Contract

```solidity
// contracts/src/FlashLoanArbitrage.sol
contract FlashLoanArbitrage is
    IFlashLoanSimpleReceiver,
    ReentrancyGuard,
    Ownable,
    Pausable
{
    // Execute multi-hop arbitrage with flash loan
    function executeArbitrage(
        address token,
        uint256 amount,
        SwapStep[] calldata swapPath,
        uint256 minProfit
    ) external;

    // Calculate expected profit before execution
    function calculateExpectedProfit(
        address token,
        uint256 amount,
        SwapStep[] calldata swapPath
    ) external view returns (uint256);
}
```

### Strategy Implementation

```typescript
// services/execution-engine/src/strategies/flash-loan.strategy.ts
class FlashLoanStrategy extends BaseExecutionStrategy {
  // Compare flash loan vs direct execution
  analyzeProfitability(opportunity: ArbitrageOpportunity): ProfitabilityAnalysis;

  // Build swap steps for contract
  buildSwapSteps(opportunity: ArbitrageOpportunity): SwapStep[];

  // Execute via contract
  execute(opportunity: ArbitrageOpportunity, ctx: StrategyContext): ExecutionResult;
}
```

## Rationale

### Why Aave V3?

1. **Lowest fee**: 0.09% (9 basis points) vs competitors
2. **Most liquid**: Largest flash loan pool
3. **Multi-chain**: Available on Ethereum, Polygon, Arbitrum, Optimism
4. **Proven**: Battle-tested in production

### Why Custom Contract?

1. **Atomicity**: Entire arbitrage in one transaction
2. **Profit verification**: Contract enforces minimum profit
3. **Security**: Reentrancy guards, owner controls, pause functionality
4. **Flexibility**: Supports 2-hop, 3-hop, N-hop swaps

### When to Use Flash Loans?

Decision flow in FlashLoanStrategy:

```typescript
function analyzeProfitability(opportunity): ProfitabilityAnalysis {
  const flashLoanFee = amount * 0.0009; // 0.09%
  const flashLoanProfit = expectedProfit - flashLoanFee - gasEstimate;
  const directProfit = expectedProfit - gasEstimate;

  // If user has capital, compare
  if (hasCapital && directProfit > flashLoanProfit) {
    return { recommendation: 'direct', reason: 'Higher profit without fee' };
  }

  // Flash loan is better or only option
  if (flashLoanProfit > MIN_PROFIT_THRESHOLD) {
    return { recommendation: 'flash-loan', reason: 'Profitable with flash loan' };
  }

  return { recommendation: 'skip', reason: 'Not profitable' };
}
```

## Consequences

### Positive

- **Zero-capital arbitrage**: Execute without locked capital
- **Larger position sizes**: Borrow up to pool limit
- **Reduced risk**: Capital only at risk during transaction
- **Atomic execution**: All-or-nothing guarantees

### Negative

- **Fee overhead**: 0.09% reduces profit margin
- **Contract risk**: Smart contract vulnerabilities
- **Gas overhead**: Contract calls cost more gas
- **Chain limitations**: Only works on chains with Aave

### Neutral

- **Audit requirement**: Contract needs security audit before mainnet
- **Deployment complexity**: Need to deploy and verify contract

## Alternatives Considered

### 1. dYdX Flash Loans
**Rejected** because:
- Higher fees on some assets
- More complex integration
- Less multi-chain support

### 2. Uniswap Flash Swaps
**Rejected** because:
- Limited to Uniswap pools
- Less flexible than generic flash loans
- Tighter profit margins

### 3. No Flash Loans (Capital Only)
**Rejected** because:
- Limits opportunity size
- Requires significant capital lockup
- Higher risk exposure

## Implementation Details

### Files Created

**Smart Contracts**:
- `contracts/src/FlashLoanArbitrage.sol`
- `contracts/src/interfaces/IFlashLoanReceiver.sol`
- `contracts/src/mocks/MockERC20.sol`
- `contracts/src/mocks/MockAavePool.sol`
- `contracts/src/mocks/MockDexRouter.sol`
- `contracts/test/FlashLoanArbitrage.test.ts`
- `contracts/test/FlashLoanArbitrage.fork.test.ts`

**Strategy**:
- `services/execution-engine/src/strategies/flash-loan.strategy.ts`
- `services/execution-engine/src/strategies/flash-loan.strategy.test.ts`

**Deployment**:
- `contracts/scripts/deploy.ts`
- `contracts/deployments/addresses.ts`
- `contracts/docs/SECURITY_REVIEW.md`

### Test Coverage

| Component | Tests |
|-----------|-------|
| FlashLoanArbitrage.sol (unit) | 36 |
| FlashLoanArbitrage.sol (fork) | 14 |
| flash-loan.strategy.ts | 39 |
| **Total** | 89 |

### Deployment Status

| Network | Status |
|---------|--------|
| Local/Hardhat | ✅ Tested |
| Mainnet Fork | ✅ Tested |
| Sepolia Testnet | ⏳ Ready to deploy |
| Arbitrum Sepolia | ⏳ Ready to deploy |
| Mainnet | ⏳ After audit |

## Success Criteria

- ✅ Contract compiles and passes all tests
- ✅ Strategy integrates with execution engine
- ✅ Fork tests validate mainnet interaction
- ✅ Security review checklist complete
- ⏳ Testnet deployment successful
- ⏳ Security audit passed
- ⏳ Mainnet deployment

## Security Considerations

1. **Reentrancy**: Protected via OpenZeppelin ReentrancyGuard
2. **Access Control**: Owner-only for sensitive functions
3. **Router Whitelist**: Only approved DEX routers
4. **Pause Functionality**: Emergency stop capability
5. **Profit Verification**: Contract enforces minProfit
6. **Flash Loan Callback**: Validates initiator is self

See `contracts/docs/SECURITY_REVIEW.md` for full checklist.

## References

- [Aave V3 Flash Loans](https://docs.aave.com/developers/guides/flash-loans)
- [OpenZeppelin Security](https://docs.openzeppelin.com/contracts/4.x/)
- [Implementation Plan v2.0](../../reports/implementation_plan_v2.md) Task 3.1

## Confidence Level
85% - High confidence for implementation, pending:
- Testnet deployment validation
- External security audit
- Mainnet deployment
