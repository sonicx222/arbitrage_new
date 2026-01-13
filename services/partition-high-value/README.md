# P3 High-Value Partition Service

The P3 High-Value partition detector service for monitoring Ethereum mainnet and ZK rollup chains.

## Overview

| Property | Value |
|----------|-------|
| **Partition ID** | `high-value` |
| **Chains** | Ethereum (1), zkSync Era (324), Linea (59144) |
| **Region** | Oracle Cloud US-East (`us-east1`) |
| **Standby Region** | GCP EU-West (`eu-west1`) |
| **Resource Profile** | Heavy (768MB) |
| **Health Check Port** | 3003 |
| **Health Check Interval** | 30s (longer for Ethereum's ~12s blocks) |
| **Failover Timeout** | 60s |

## Chain Details

### Ethereum (Mainnet)
- **Chain ID**: 1
- **Block Time**: ~12 seconds
- **Focus**: High-value DeFi transactions, major DEXes (Uniswap, SushiSwap)

### zkSync Era
- **Chain ID**: 324
- **Block Time**: ~1 second
- **Focus**: ZK rollup with lower fees, growing DEX ecosystem

### Linea
- **Chain ID**: 59144
- **Block Time**: ~2 seconds
- **Focus**: Consensys ZK rollup, emerging DeFi protocols

## High-Value Partition Characteristics

1. **Longer Health Checks**: 30-second intervals to accommodate Ethereum's ~12-second block time
2. **Mainnet Focus**: Optimized for high-value Ethereum mainnet transactions
3. **US-East Deployment**: Proximity to major Ethereum infrastructure (Infura, Alchemy)
4. **Heavy Resources**: 768MB allocation for processing complex mainnet transactions
5. **Cross-Chain Detection**: ETH price arbitrage between mainnet and ZK rollups

## Quick Start

### Local Development

```bash
# Start the service
npm run dev

# Or with Docker
docker-compose up -d

# View logs
docker-compose logs -f
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PARTITION_ID` | Partition identifier | `high-value` |
| `PARTITION_CHAINS` | Comma-separated chain IDs | `ethereum,zksync,linea` |
| `HEALTH_CHECK_PORT` | HTTP health endpoint port | `3003` |
| `REDIS_URL` | Redis connection URL | - |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `REGION_ID` | Deployment region | `us-east1` |
| `ALCHEMY_API_KEY` | Alchemy API key for Ethereum | - |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service information |
| `GET /health` | Health status (healthy/degraded/unhealthy) |
| `GET /ready` | Readiness check |
| `GET /stats` | Detailed statistics |

### Health Response Example

```json
{
  "service": "partition-high-value",
  "status": "healthy",
  "partitionId": "high-value",
  "chains": ["ethereum", "zksync", "linea"],
  "healthyChains": ["ethereum", "zksync", "linea"],
  "uptime": 3600,
  "eventsProcessed": 15000,
  "memoryMB": 256,
  "region": "us-east1",
  "timestamp": 1705123456789
}
```

## Deployment

### Oracle Cloud (Production)

```bash
# Build and push image
docker build -t partition-high-value:latest -f Dockerfile ../..
docker tag partition-high-value:latest <oracle-registry>/partition-high-value:latest
docker push <oracle-registry>/partition-high-value:latest

# Deploy to Oracle Cloud Container Instances
oci container-instances create \
  --compartment-id <compartment-id> \
  --availability-domain <ad> \
  --containers '[{"imageUrl":"<oracle-registry>/partition-high-value:latest"}]'
```

### GCP (Standby)

```bash
# Deploy to Cloud Run
gcloud run deploy partition-high-value \
  --image <gcr-registry>/partition-high-value:latest \
  --region europe-west1 \
  --memory 768Mi \
  --port 3003
```

## Monitoring

### Key Metrics

- **Events Processed**: Total swap events across all high-value chains
- **Arbitrage Opportunities**: Cross-chain opportunities (Ethereum <-> zkSync <-> Linea)
- **Chain Health**: Per-chain WebSocket connection status
- **Memory Usage**: Heap memory consumption
- **Uptime**: Service availability

### Alerts

- **Chain Disconnect**: When any chain loses WebSocket connection
- **High Memory**: When memory exceeds 600MB (80% of 768MB)
- **Low Event Rate**: When event rate drops below expected threshold

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  P3 High-Value Partition                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Ethereum   │  │    zkSync    │  │    Linea     │      │
│  │   (id: 1)    │  │   (id: 324)  │  │  (id: 59144) │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                 │                 │               │
│         └────────────────┼────────────────┘               │
│                          │                                  │
│                  ┌───────▼───────┐                         │
│                  │    Unified    │                         │
│                  │   Detector    │                         │
│                  └───────┬───────┘                         │
│                          │                                  │
│              ┌───────────┼───────────┐                     │
│              │           │           │                     │
│      ┌───────▼───┐ ┌─────▼─────┐ ┌──▼──────┐            │
│      │  Health   │ │   Redis   │ │ Events  │            │
│      │  Server   │ │  Streams  │ │ Handler │            │
│      │  (:3003)  │ │           │ │         │            │
│      └───────────┘ └───────────┘ └─────────┘            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Related Documentation

- [IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md) - S3.1.5 task details
- [ADR-003](../../docs/architecture/adr/ADR-003-partitioned-detectors.md) - Partition architecture
- [Partition Configuration](../../shared/config/src/partitions.ts) - Partition definitions

## Troubleshooting

### Common Issues

1. **Ethereum RPC Rate Limits**
   - Use dedicated Alchemy/Infura API keys
   - Consider multiple providers for redundancy

2. **zkSync Connection Issues**
   - Verify zkSync Era RPC endpoints are correct
   - Check for network congestion

3. **High Memory Usage**
   - Increase max memory allocation
   - Check for event backlog

### Debug Mode

```bash
LOG_LEVEL=debug npm run dev
```
