# @arbitrage/flash-loan-aggregation

Flash loan provider aggregation and intelligent selection across multiple protocols using Clean Architecture / DDD patterns.

## Build Order

**3rd** in build chain: types -> config -> `flash-loan-aggregation` / metrics -> core -> ml

## Supported Providers

| Provider | Protocol | Fee |
|----------|----------|-----|
| Aave V3 | `executeOperation` | 0.09% (9 bps) |
| Balancer V2 | `receiveFlashLoan` | 0% |
| PancakeSwap V3 | `pancakeV3FlashCallback` | Tier-based |
| SyncSwap | `onFlashLoan` (EIP-3156) | 0.3% |
| MakerDAO DssFlash | `onFlashLoan` (EIP-3156) | DAI only |
| SpookySwap | V2 flash swap | Varies |

## Architecture

```
Domain Layer     ── Provider ranking, liquidity validation, scoring
Application Layer ── Use case implementations (select provider, rank providers)
Infrastructure   ── Protocol-specific implementations
```

Weighted scoring: fees 50%, liquidity 30%, reliability 15%, latency 5%.

## Dependencies

- `@arbitrage/types`
- Peer: `ethers ^6.0.0`

## Related

- [ADR-032: Flash Loan Provider Aggregation](../../docs/architecture/adr/ADR-032-flash-loan-provider-aggregation.md)
