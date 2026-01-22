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

# Required for Production (WebSocket URLs for real-time price feeds)
# Public RPCs don't support WebSocket - use Alchemy/Infura/QuickNode
ARBITRUM_WS_URL=wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
OPTIMISM_WS_URL=wss://opt-mainnet.g.alchemy.com/v2/YOUR_KEY
BASE_WS_URL=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional HTTP RPC URLs (fallback)
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
OPTIMISM_RPC_URL=https://mainnet.optimism.io
BASE_RPC_URL=https://mainnet.base.org

# Optional (have defaults)
PARTITION_ID=l2-turbo
PARTITION_CHAINS=arbitrum,optimism,base
REGION_ID=asia-southeast1
LOG_LEVEL=info
HEALTH_CHECK_PORT=3002
INSTANCE_ID=p2-l2-turbo-{hostname}-{timestamp}  # Auto-generated if not set
ENABLE_CROSS_REGION_HEALTH=true                  # Enable cross-region health reporting
```

**Important**: For production arbitrage trading, WebSocket URLs are critical. L2 chains have sub-second blocks, and HTTP polling is too slow for competitive trading. Chain URLs are configured in `@arbitrage/config/chains.ts` but can be overridden via environment variables.

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
| `GET /health` | Health status (Kubernetes liveness probe) |
| `GET /ready` | Readiness check (Kubernetes readiness probe) |
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

## L2-Specific Configuration

The L2-Turbo partition has configuration optimized for Ethereum L2 rollups:

- **Faster Health Checks (10s)**: L2 chains have sub-second to 2-second block times, requiring more frequent health monitoring than Ethereum mainnet
- **Shorter Failover Timeout (45s)**: Quick failover is critical for L2 chains where blocks arrive every ~250ms-2s
- **WebSocket Requirements**: L2 chains require WebSocket connections for real-time event streaming. Public RPC endpoints typically don't support WebSocket; use Alchemy, Infura, or QuickNode.

> **Note**: The underlying `UnifiedChainDetector` processes all chains equally. The "L2-specific" optimizations are configuration parameters (health check intervals, failover timeouts) defined in `@arbitrage/config/partitions.ts`. There is no special L2-specific code path in the detector itself.

### DEX Configuration

DEXes monitored are defined in `@arbitrage/config/dexes.ts`. The lists above reflect the current configuration but may change. The actual DEXes monitored at runtime depend on:
1. Chain-specific DEX configuration in `@arbitrage/config`
2. Whether the DEX is marked as `enabled: true`
3. Whether required pool addresses are configured

## Failover Configuration

- Primary: Fly.io Singapore (`asia-southeast1`)
- Standby: Railway US East (`us-east1`)
- Failover Timeout: 45 seconds
- Health Check Interval: 10 seconds

## Architecture Reference

See [ADR-003: Partitioned Chain Detectors](../../../docs/architecture/adr/ADR-003-partitioned-chain-detectors.md) for architectural decisions.
