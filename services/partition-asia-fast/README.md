# P1 Asia-Fast Partition Service

Partition detector service for high-throughput Asian blockchain networks.

## Partition Configuration

| Property | Value |
|----------|-------|
| Partition ID | `asia-fast` |
| Region | Oracle Cloud Singapore (`asia-southeast1`) |
| Provider | Oracle Cloud Infrastructure |
| Resource Profile | Heavy |
| Priority | 1 (Highest) |

## Chains

| Chain | ID | Block Time | Native Token |
|-------|-----|------------|--------------|
| BSC | 56 | ~3s | BNB |
| Polygon | 137 | ~2s | MATIC |
| Avalanche | 43114 | ~2s | AVAX |
| Fantom | 250 | ~1s | FTM |

## DEXes Monitored

### BSC (8 DEXes)
- PancakeSwap V3, PancakeSwap V2, Biswap, Thena, ApeSwap, MDEX, Ellipsis, Nomiswap

### Polygon (4 DEXes)
- Uniswap V3, QuickSwap V3, SushiSwap, ApeSwap

### Avalanche (3 DEXes)
- Trader Joe V2, Pangolin, SushiSwap

### Fantom (2 DEXes)
- SpookySwap, SpiritSwap

## Environment Variables

```bash
# Required
REDIS_URL=redis://localhost:6379

# Optional (have defaults)
PARTITION_ID=asia-fast
PARTITION_CHAINS=bsc,polygon,avalanche,fantom
REGION_ID=asia-southeast1
LOG_LEVEL=info
HEALTH_CHECK_PORT=3001

# RPC URLs (override defaults)
BSC_RPC_URL=https://bsc-dataseed1.binance.org
POLYGON_RPC_URL=https://polygon-rpc.com
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc
FANTOM_RPC_URL=https://rpc.ftm.tools

# WebSocket URLs (override defaults)
BSC_WS_URL=wss://bsc-ws-node.nariox.org:443
POLYGON_WS_URL=wss://polygon-rpc.com
AVALANCHE_WS_URL=wss://api.avax.network/ext/bc/C/ws
FANTOM_WS_URL=wss://wsapi.fantom.network
```

## Local Development

```bash
# Install dependencies
npm install

# Run with ts-node
npm run dev

# Build
npm run build

# Run built version
npm start
```

## Docker Deployment

```bash
# Build image
docker build -t partition-asia-fast:latest -f Dockerfile ../..

# Run with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f partition-asia-fast

# Stop
docker-compose down
```

## Health Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info |
| `GET /health` | Health status (Kubernetes liveness) |
| `GET /healthz` | Health status (alternative) |
| `GET /ready` | Readiness check (Kubernetes) |
| `GET /stats` | Detailed statistics |

### Example Health Response

```json
{
  "service": "partition-asia-fast",
  "status": "healthy",
  "partitionId": "asia-fast",
  "chains": ["bsc", "polygon", "avalanche", "fantom"],
  "healthyChains": ["bsc", "polygon", "avalanche", "fantom"],
  "uptime": 3600,
  "eventsProcessed": 125000,
  "memoryMB": 256,
  "region": "asia-southeast1",
  "timestamp": 1704672000000
}
```

## Oracle Cloud Deployment

### Instance Specification
- Shape: VM.Standard.E4.Flex (1 OCPU, 768MB RAM)
- Image: Oracle Linux 8 with Docker
- Region: ap-singapore-1

### Deployment Steps

1. Create Compute Instance in Singapore region
2. Install Docker and Docker Compose
3. Clone repository and build image
4. Configure environment variables
5. Run with systemd service or Docker Compose

## Failover Configuration

- Primary: Oracle Cloud Singapore (`asia-southeast1`)
- Standby: Render US West (`us-west1`)
- Failover Timeout: 60 seconds
- Health Check Interval: 15 seconds

## Architecture Reference

See [ADR-003: Partitioned Chain Detectors](../../../docs/architecture/adr/ADR-003-partitioned-chain-detectors.md) for architectural decisions.
