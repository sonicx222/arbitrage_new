# Cross-Chain Detector

Detects cross-chain arbitrage opportunities by consuming price updates from all 4 partition detectors, analyzing bridge costs with latency prediction, and filtering via ML confidence scoring.

## Overview

| Property | Value |
|----------|-------|
| **Port** | 3006 (configurable via `CROSS_CHAIN_DETECTOR_PORT`) |
| **Role** | Cross-chain opportunity detection |
| **Streams Consumed** | price-updates, whale-alerts, pending-opportunities |
| **Streams Produced** | opportunities |

Unlike partition detectors, this service is a **consumer** (not a WebSocket producer). It aggregates prices from all chains to find cross-chain spreads.

## Quick Start

```bash
npm run dev:cross-chain:fast   # Hot reload, port 3006
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health status (chains monitored, ML predictor state, Redis) |
| `GET /ready` | Readiness probe (Redis connected, chains > 0) |
| `GET /metrics` | Prometheus metrics (detection counters, latency percentiles) |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `CROSS_CHAIN_DETECTOR_PORT` | HTTP port | `3006` |
| `REDIS_URL` | Redis connection URL | Required |
| `ML_ENABLED` | Enable ML prediction filtering | `true` |
| `MIN_CROSS_CHAIN_PROFIT_USD` | Minimum profit threshold (USD) | `100` |
| `BRIDGE_LATENCY_SMA_WINDOW` | SMA window for latency prediction | `20` |
| `STREAM_SIGNING_KEY` | HMAC-SHA256 signing key for stream messages | - |

## Architecture

```
Cross-Chain Detector
├── StreamConsumer
│   └── Consumes price-updates from all 4 partitions
├── PriceDataManager
│   └── Per-(chain, token) latest price storage
├── BridgeCostEstimator (ADR-040)
│   ├── Per-chain native token pricing (V2 pool, 60s refresh)
│   ├── Blob-aware OP Stack L1 fee oracle
│   └── EMA-based gas calibration feedback loop
├── MLPredictionManager
│   └── TFjs LSTM confidence scoring (pure-JS backend)
├── ConfidenceCalculator
│   └── Multi-factor: price stability, volume, whale activity
├── WhaleAnalyzer
│   └── Large transaction pattern detection
├── PreValidationOrchestrator
│   └── Spread >= minProfit, bridge availability, route validity
└── OpportunityPublisher
    └── Publishes to stream:opportunities with HMAC signing
```

## Related Documentation

- [ADR-031: Multi-Bridge Strategy](../../docs/architecture/adr/ADR-031-multi-bridge-strategy.md)
- [ADR-033: Stale Price Window](../../docs/architecture/adr/ADR-033-stale-price-window.md)
- [ADR-040: Real-Time Native Token Pricing](../../docs/architecture/adr/ADR-040-real-time-native-token-pricing.md)
