# @arbitrage/core

Core library providing 30+ sub-entry points for detection, caching, logging, monitoring, risk management, DEX adapters, bridge routing, and Redis Streams infrastructure. The largest shared package.

## Build Order

**4th** in build chain: types -> config -> flash-loan-aggregation/metrics -> `core` -> ml -> services

## Sub-Entry Points

Import via `@arbitrage/core/<sub-entry>`:

| Sub-Entry | Purpose |
|-----------|---------|
| `/caching` | PriceMatrix (L1 SharedArrayBuffer), PairCache, OrderbookCache |
| `/redis` | Stream consumer, HMAC signing, SCAN iterators |
| `/logging` | `createPinoLogger()`, OTEL transport, trace context |
| `/tracing` | OpenTelemetry trace context propagation |
| `/resilience` | CircuitBreaker, ExponentialBackoffRetry |
| `/monitoring` | StreamHealth, SystemMonitor, metrics collection |
| `/risk` | KellyCalculator, DrawdownCircuitBreaker |
| `/components` | PartitionedDetector, ArbitrageDetector, SimpleArbitrageDetector |
| `/path-finding` | Swap path discovery, multi-leg DFS |
| `/dex-adapters` | Protocol-specific adapters (Uniswap V2/V3, Curve, etc.) |
| `/bridge-router` | Cross-chain routing, bridge cost estimator |
| `/mev-protection` | MEV-Share integration, backrun detection |
| `/solana` | SolanaDetector, Jupiter integration |
| `/partition` | Partition service lifecycle, routing |
| `/simulation` | SimWorker, path simulation (ADR-039) |
| `/async` | AsyncMutex, WorkerPool, timeout/retry utilities |
| `/data-structures` | LRUCache, high-performance structures |
| `/analytics` | MLOpportunityScorer, DetectionOptimizer |
| `/utils` | Fee utils, env parsing (`parseEnvIntSafe`, `parseEnvFloatSafe`), string interning |
| `/service-lifecycle` | Health server creation, graceful shutdown |
| `/rpc` | Multi-chain RPC failover, provider selection |

## Usage

```typescript
import { createPinoLogger } from '@arbitrage/core/logging';
import { PriceMatrix } from '@arbitrage/core/caching';
import { CircuitBreaker } from '@arbitrage/core/resilience';
```

## Dependencies

- `@arbitrage/flash-loan-aggregation`, `@arbitrage/metrics`
- `ioredis`, `pino`, `ws`, `@solana/web3.js`
