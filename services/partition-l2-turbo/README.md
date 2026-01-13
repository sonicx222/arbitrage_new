# P2 L2-Turbo Partition Service

Partition detector service for Ethereum Layer 2 rollup networks.

## Partition Configuration

| Property | Value |
|----------|-------|
| Partition ID | `l2-turbo` |
| Region | Fly.io Singapore (`asia-southeast1`) |
| Provider | Fly.io |
| Resource Profile | Standard |
| Priority | 1 (Highest) |

## Chains

| Chain | ID | Block Time | Native Token |
|-------|-----|------------|--------------|
| Arbitrum | 42161 | ~0.25s | ETH |
| Optimism | 10 | ~2s | ETH |
| Base | 8453 | ~2s | ETH |

## DEXes Monitored

### Arbitrum (9 DEXes)
- Uniswap V3, SushiSwap, Camelot V2, GMX, Balancer V2, Trader Joe, Zyberswap, Ramses, Chronos

### Optimism (3 DEXes)
- Uniswap V3, Velodrome, Beethoven X

### Base (7 DEXes)
- Uniswap V3, Aerodrome, BaseSwap, SushiSwap, Balancer V2, Maverick, SwapBased

## Environment Variables

```bash
# Required
REDIS_URL=redis://localhost:6379

# Optional (have defaults)
PARTITION_ID=l2-turbo
PARTITION_CHAINS=arbitrum,optimism,base
REGION_ID=asia-southeast1
LOG_LEVEL=info
HEALTH_CHECK_PORT=3002

# RPC URLs (override defaults)
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
OPTIMISM_RPC_URL=https://mainnet.optimism.io
BASE_RPC_URL=https://mainnet.base.org

# WebSocket URLs (override defaults)
ARBITRUM_WS_URL=wss://arb1.arbitrum.io/feed
OPTIMISM_WS_URL=wss://mainnet.optimism.io
BASE_WS_URL=wss://mainnet.base.org
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
docker build -t partition-l2-turbo:latest -f Dockerfile ../..

# Run with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f partition-l2-turbo

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
  "service": "partition-l2-turbo",
  "status": "healthy",
  "partitionId": "l2-turbo",
  "chains": ["arbitrum", "optimism", "base"],
  "healthyChains": ["arbitrum", "optimism", "base"],
  "uptime": 3600,
  "eventsProcessed": 250000,
  "memoryMB": 384,
  "region": "asia-southeast1",
  "timestamp": 1704672000000
}
```

## Fly.io Deployment

### Machine Specification
- Instance Type: shared-cpu-1x (1 vCPU, 256MB-512MB RAM)
- Region: sin (Singapore)
- Scaling: 2 instances for high availability

### Deployment Steps

1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Create app: `fly apps create partition-l2-turbo`
4. Set secrets: `fly secrets set REDIS_URL=... ARBITRUM_RPC_URL=...`
5. Deploy: `fly deploy`

## L2-Specific Optimizations

- **Faster Health Checks (10s)**: L2 chains have sub-second to 2-second block times, requiring more frequent health monitoring
- **Shorter Failover Timeout (45s)**: Quick recovery is critical for high-throughput L2 chains
- **High Event Throughput**: Optimized for handling the higher transaction volume of L2 networks

## Failover Configuration

- Primary: Fly.io Singapore (`asia-southeast1`)
- Standby: Railway US East (`us-east1`)
- Failover Timeout: 45 seconds
- Health Check Interval: 10 seconds

## Architecture Reference

See [ADR-003: Partitioned Chain Detectors](../../../docs/architecture/adr/ADR-003-partitioned-chain-detectors.md) for architectural decisions.
