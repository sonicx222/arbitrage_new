# Execution Engine

Executes arbitrage opportunities detected by partition detectors and the cross-chain detector. Supports 8+ execution strategies, risk management via drawdown circuit breaker and Kelly position sizing, and per-chain-group routing for horizontal scaling.

## Overview

| Property | Value |
|----------|-------|
| **Port** | 3005 (configurable via `EXECUTION_ENGINE_PORT`) |
| **Role** | Trade execution |
| **Streams Consumed** | exec-requests-{fast\|l2\|premium\|solana} (ADR-038), fast-lane, pre-simulated (ADR-039) |
| **Streams Produced** | execution-results |

## Quick Start

```bash
npm run dev:execution:fast   # Hot reload, port 3005
```

## Execution Strategies

| Strategy | Description | Module |
|----------|-------------|--------|
| **IntraChain** | Single-chain swaps on one DEX | `strategies/intra-chain.strategy.ts` |
| **CrossChain** | Multi-chain with bridge routing | `strategies/cross-chain.strategy.ts` |
| **FlashLoan** | Flash loan arbitrage (Aave V3, Balancer V2, PancakeSwap V3, SyncSwap, MakerDAO) | `strategies/flash-loan.strategy.ts` |
| **Simulation** | Non-block-space simulation for testing | `strategies/simulation.strategy.ts` |
| **StatisticalArb** | ML-predicted opportunities | `strategies/statistical-arbitrage.strategy.ts` |
| **Solana** | Solana via Jupiter V6 + Jito bundles | `strategies/solana-execution.strategy.ts` |
| **Backrun** | MEV-protected backrunning | `strategies/backrun.strategy.ts` |
| **UniswapXFiller** | UniswapX order fulfillment | `strategies/uniswapx-filler.strategy.ts` |

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Full health (status, queue, success rate, risk state) |
| `GET /ready` | No | Readiness probe |
| `GET /stats` | No | Statistics with consumer lag info |
| `GET /metrics` | No | Prometheus metrics |
| `GET /bridge-recovery` | No | Bridge recovery status |
| `GET /probability-tracker` | No | Execution probability stats |
| `GET /circuit-breaker` | No | Circuit breaker state |
| `POST /circuit-breaker/open` | Yes | Force open circuit breaker |
| `POST /circuit-breaker/close` | Yes | Force close circuit breaker |

## Configuration

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `EXECUTION_ENGINE_PORT` | HTTP port | `3005` |
| `REDIS_URL` | Redis connection URL | Required |
| `EXECUTION_CHAIN_GROUP` | Chain group: `fast\|l2\|premium\|solana` (unset = legacy) | - |
| `MAX_CONCURRENT_EXECUTIONS` | Concurrent execution limit | `5` (prod: `20`) |
| `ASYNC_PIPELINE_SPLIT` | Enable SimulationWorker pre-filtering (ADR-039) | `false` |

### Simulation Mode

| Variable | Description | Default |
|----------|-------------|---------|
| `EXECUTION_SIMULATION_MODE` | Enable simulation | `false` |
| `EXECUTION_SIMULATION_SUCCESS_RATE` | Success rate (0-1) | `0.85` |
| `EXECUTION_SIMULATION_LATENCY_MS` | Simulated latency | `50` |

### Circuit Breaker (ADR-018)

| Variable | Description | Default |
|----------|-------------|---------|
| `CIRCUIT_BREAKER_ENABLED` | Enable circuit breaker | `true` |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | Failures before tripping | `5` |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | Cooldown period | `300000` (5 min) |
| `CIRCUIT_BREAKER_HALF_OPEN_ATTEMPTS` | Half-open test attempts | `1` |

## Architecture

```
Execution Engine
├── QueueService (backpressure-aware)
│   └── Redis Stream consumer with lag monitoring
├── StrategyFactory
│   └── Dispatches to 8+ strategy implementations
├── DrawdownCircuitBreaker (ADR-018)
│   └── Halts trading after 5% drawdown
├── Kelly Position Sizing (ADR-021)
│   └── Adaptive size per expected value
├── MEV Protection
│   └── MevProviderFactory (Flashbots, Jito, bloXroute)
├── DLQ & Auto-Recovery
│   └── Exponential backoff retry
└── TradeLogger
    └── Append-only JSONL (daily rotation)
```

## Related Documentation

- [ADR-018: Circuit Breaker](../../docs/architecture/adr/ADR-018-circuit-breaker.md)
- [ADR-020: Flash Loan](../../docs/architecture/adr/ADR-020-flash-loan.md)
- [ADR-021: Capital Risk Management](../../docs/architecture/adr/ADR-021-capital-risk-management.md)
- [ADR-038: Chain-Grouped Execution](../../docs/architecture/adr/ADR-038-chain-grouped-execution.md)
- [ADR-039: Async Pipeline Split](../../docs/architecture/adr/ADR-039-async-pipeline-split.md)
