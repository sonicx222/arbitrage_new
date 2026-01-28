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

DEXes are dynamically loaded from configuration. The following are typically enabled:

### BSC
- PancakeSwap V3, PancakeSwap V2, Biswap, Thena, ApeSwap, MDEX, Ellipsis, Nomiswap

### Polygon
- Uniswap V3, QuickSwap V3, SushiSwap, ApeSwap

### Avalanche
- Trader Joe V2, Pangolin, SushiSwap

### Fantom
- SpookySwap, SpiritSwap

> **Note:** Actual DEX counts are determined by enabled configuration in `shared/config/src/dexes.ts`.

## Environment Variables

```bash
# Required
REDIS_URL=redis://localhost:6379

# Optional - Service Configuration (have defaults)
PARTITION_ID=asia-fast                    # Partition identifier
PARTITION_CHAINS=bsc,polygon,avalanche,fantom  # Chains to monitor (comma-separated)
REGION_ID=asia-southeast1                 # Region identifier for health reporting
LOG_LEVEL=info                            # Logging level (debug, info, warn, error)
HEALTH_CHECK_PORT=3001                    # HTTP health check port
INSTANCE_ID=p1-asia-fast-local-123        # Unique instance ID (auto-generated if not set)
ENABLE_CROSS_REGION_HEALTH=true           # Enable cross-region health reporting

# RPC URLs (override defaults)
# WARNING: In production, configure private RPC endpoints for reliability
BSC_RPC_URL=https://bsc-dataseed1.binance.org
POLYGON_RPC_URL=https://polygon-rpc.com
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc
FANTOM_RPC_URL=https://rpc.ftm.tools

# WebSocket URLs (override defaults)
# WARNING: In production, configure private WebSocket endpoints (Alchemy, Infura, QuickNode)
BSC_WS_URL=wss://bsc.publicnode.com
POLYGON_WS_URL=wss://polygon-bor-rpc.publicnode.com
AVALANCHE_WS_URL=wss://api.avax.network/ext/bc/C/ws
FANTOM_WS_URL=wss://fantom.publicnode.com
```

### Production Configuration

For production deployments, it's strongly recommended to:

1. **Use private RPC/WebSocket endpoints** - Public endpoints have rate limits
2. **Set `NODE_ENV=production`** - Enables production warnings for missing configs
3. **Configure all chain URLs** - Ensures reliable connectivity

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
| `GET /` | Service info (partition ID, chains, region, available endpoints) |
| `GET /health` | Health status (Kubernetes liveness probe) |
| `GET /ready` | Readiness check (Kubernetes readiness probe, returns 503 if not running) |
| `GET /stats` | Detailed statistics (events processed, opportunities found, per-chain stats) |

> **Note:** `/health` returns HTTP 200 for `healthy` or `degraded` status, and HTTP 503 for `unhealthy` status.

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
- Shape: VM.Standard.E4.Flex (1 OCPU)
- Memory: 768MB limit (256MB reserved minimum)
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

See [ADR-003: Partitioned Chain Detectors](../../../docs/architecture/adr/ADR-003-partitioned-detectors.md) for architectural decisions.

## Docker Environment Notes

- **Dockerfile**: Sets `NODE_ENV=production` by default for production-optimized builds
- **docker-compose.yml**: Overrides to `NODE_ENV=development` for local development/testing

When running with docker-compose, the service runs in development mode. For production deployments, either:
1. Remove the `NODE_ENV=development` override from docker-compose.yml
2. Or set `NODE_ENV=production` in your deployment configuration
