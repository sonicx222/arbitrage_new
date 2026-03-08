# ADR-042: Testnet Execution Mode

## Status
Accepted

## Date
2026-03-08

## Context

The arbitrage system needed a way to test the full execution pipeline with real blockchain transactions without risking real funds. The existing simulation modes (SIMULATION_MODE, EXECUTION_SIMULATION_MODE, EXECUTION_HYBRID_MODE) all stop short of submitting actual transactions.

### Requirements

1. Submit real transactions to testnet chains (Sepolia, Arbitrum Sepolia, Base Sepolia, zkSync Sepolia)
2. Use simulated prices (SIMULATION_MODE=true) since testnet tokens have no market value
3. Map mainnet token/router/contract addresses to testnet equivalents
4. Preserve all downstream infrastructure lookups (providers, wallets, CHAINS config, DEX config)
5. Add production safety guard to prevent accidental testnet mode in production
6. Support both same-chain and cross-chain opportunities

## Decision

### Dual-Name Architecture

Chain names in the opportunity (`buyChain`, `sellChain`, `chain`) are **preserved as mainnet names** so that all downstream infrastructure lookups work unchanged. Testnet chain names are added as metadata fields (`_testnetBuyChain`, `_testnetSellChain`, `_testnetChain`) for use at the transaction submission boundary.

This was chosen over two alternatives:
- **Late-stage transform** (Option C): Simpler but requires each strategy to know about testnet mode
- **Testnet infrastructure registration** (Option B): Cleanest but requires registering providers/wallets under testnet names at startup, touching many files

### Address Resolution

Token addresses are mapped from mainnet to testnet equivalents in `transformOpportunityForTestnet()`:
- `tokenIn`, `token0`, `token1` resolved via buy chain's token map
- `tokenOut` resolved via sell chain's token map (cross-chain fix H-02)
- `hops[].tokenOut` resolved via buy chain's token map (M-03 fix)

### Mode Flag Requirements

| Flag | Required Value | Reason |
|------|---------------|--------|
| `TESTNET_EXECUTION_MODE` | `true` | Enables testnet address resolution |
| `SIMULATION_MODE` | `true` | Provides simulated prices (testnet has no real markets) |
| `EXECUTION_SIMULATION_MODE` | `false` | Must be off for real transaction submission |

Startup validates these requirements and warns on misconfiguration (M-01).

### Production Safety Guard

Engine constructor throws on startup if `TESTNET_EXECUTION_MODE=true` with `NODE_ENV=production`, matching the existing `SIMULATION_MODE` guard pattern (H-01).

### Profit Threshold Bypass

`verifyOpportunityPrices()` in `base.strategy.ts` skips profit and confidence thresholds when testnet mode is active, since simulated prices don't reflect testnet token values. Staleness checks are still enforced.

## Consequences

### Positive
- Full execution pipeline tested with real transactions on testnet
- Zero risk to real funds — testnet tokens have no value
- Infrastructure lookups unchanged — providers, wallets, config all work as-is
- Production safety guard prevents accidental deployment

### Negative
- Token/router addresses duplicated between `testnet-resolver.ts` and `contracts/deployments/addresses.ts` (M-06, tracked)
- USDT→USDC substitution on testnet means USDT arbs resolve to same-token swaps (L-02, documented)
- Router/flash-loan resolution functions exported but not yet wired into strategies (M-04, available for future use)

### Supported Chains

| Mainnet | Testnet | Flash Loan Contract | Routers |
|---------|---------|-------------------|---------|
| ethereum | sepolia | Yes | 1 (Uniswap V2) |
| arbitrum | arbitrumSepolia | Yes | 2 (Uniswap V2 + V3) |
| base | baseSepolia | Yes | 1 (Uniswap V2) |
| zksync | zksync-testnet | No | 1 (SyncSwap) |

## References

- `services/execution-engine/src/services/testnet-resolver.ts` — Address resolution module
- `services/execution-engine/src/engine.ts` — Production safety guard
- `services/execution-engine/src/strategies/base.strategy.ts` — Profit threshold bypass
- `contracts/deployments/addresses.ts` — Canonical address source
- `docs/reports/DEEP_ANALYSIS_TESTNET_EXEC_2026-03-08.md` — Deep analysis report (13 findings)
- ADR-016 — Transaction Simulation (related mode)
- ADR-038 — Chain-Grouped Execution (testnet compatible)
