# @arbitrage/types

TypeScript type definitions for the entire arbitrage system. Foundation package providing canonical type contracts used by all other packages.

## Build Order

**1st** in build chain: `types` -> config -> core -> ml -> services

## Key Exports

| Category | Types |
|----------|-------|
| **Core** | `Chain`, `Dex`, `Token`, `Pair`, `PriceUpdate`, `SwapEvent` |
| **Opportunities** | `ArbitrageOpportunity`, `CrossChainBridge`, `PendingSwapIntent`, `PendingOpportunity` |
| **Execution** | `SwapHop`, `SwapRouterType`, `FeeBasisPoints`, `FeeDecimal` |
| **Config** | `ServiceConfig`, `DetectorConfig`, `ExecutionConfig` |
| **Health** | `ServiceHealth`, `PipelineTimestamps` |
| **Errors** | `ArbitrageError`, `NetworkError`, `ValidationError`, `TimeoutError` |
| **Events** | `RedisStreams` (stream name constants) |

## Usage

```typescript
import type { ArbitrageOpportunity, Chain, PriceUpdate } from '@arbitrage/types';
```

## Dependencies

None (only dev dependencies: `@types/node`, `typescript`).
