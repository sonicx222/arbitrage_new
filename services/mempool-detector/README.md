# Mempool Detector

Optional service for pre-block arbitrage detection via bloXroute BDN (Blockchain Distribution Network). Connects to mempool data feeds, decodes pending swap transactions, and publishes opportunities before they are mined.

## Overview

| Property | Value |
|----------|-------|
| **Port** | 3008 (configurable via `MEMPOOL_DETECTOR_PORT`) |
| **Role** | Optional pre-block detection |
| **Chains** | Ethereum, BSC (requires bloXroute API key) |
| **Streams Produced** | pending-opportunities |

## Quick Start

```bash
# Requires BLOXROUTE_AUTH_HEADER to be set
npm run dev:mempool        # Standard startup
npm run dev:mempool:fast   # With hot reload
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Feed health per chain (connectionState, txReceived, txDecoded) |
| `GET /ready` | Readiness probe (running, feeds > 0) |
| `GET /metrics` | Prometheus metrics |
| `GET /stats` | Detailed statistics (counters, buffer stats, batcher stats) |

## Configuration

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMPOOL_DETECTION_ENABLED` | Enable mempool detection | `false` |
| `MEMPOOL_DETECTOR_PORT` | HTTP port | `3008` |
| `MEMPOOL_MIN_SWAP_SIZE_USD` | Minimum swap size filter | `1000` |
| `MEMPOOL_MAX_BUFFER_SIZE` | Transaction buffer size | `10000` |
| `MEMPOOL_BATCH_SIZE` | Redis publish batch size | `100` |
| `MEMPOOL_BATCH_TIMEOUT_MS` | Batch flush interval | `50` |

### bloXroute

| Variable | Description | Default |
|----------|-------------|---------|
| `BLOXROUTE_ENABLED` | Enable bloXroute feed | `false` |
| `BLOXROUTE_AUTH_HEADER` | API authentication header | Required |
| `BLOXROUTE_WS_ENDPOINT` | Ethereum endpoint | `wss://eth.blxrbdn.com/ws` |
| `BLOXROUTE_BSC_WS_ENDPOINT` | BSC endpoint | `wss://bsc.blxrbdn.com/ws` |
| `BLOXROUTE_CONNECTION_TIMEOUT` | Connection timeout | `10000` |
| `BLOXROUTE_MAX_RECONNECT_ATTEMPTS` | Max reconnects | `10` |

## Architecture

```
Mempool Detector
├── bloXroute Feed Manager
│   ├── Ethereum WebSocket (BDN)
│   └── BSC WebSocket (BDN)
├── DecoderRegistry
│   └── DEX router ABI decoders (token pair, amounts, slippage)
├── TxBuffer (circular, O(1) push)
│   └── Configurable size with overflow tracking
├── LatencyBuffer (circular)
│   └── Sub-ms tracking via performance.now()
└── Redis Publisher
    └── Batched publishing to stream:pending-opportunities
```

## Related Documentation

- [ADR-017: MEV Protection](../../docs/architecture/adr/ADR-017-mev-protection.md)
- [Configuration Guide](../../docs/CONFIGURATION.md)
