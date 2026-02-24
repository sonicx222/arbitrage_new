# Deployment Guide

This guide provides step-by-step instructions for deploying the **Professional Arbitrage Detection System** across multiple cloud providers while maintaining zero infrastructure costs.

> **For local development**, see the [Local Development Guide](./local-development.md) instead.

## Architecture Overview

The system uses a **partitioned detector architecture** (ADR-003) where multiple chains are grouped into logical partitions based on geographic proximity and block time characteristics.

### Service Inventory

| Service | Purpose | Instances | Region Strategy |
|---------|---------|-----------|-----------------|
| **unified-detector** | Multi-chain arbitrage detection | 4 partitions | Near RPC providers |
| **cross-chain-detector** | Cross-chain opportunity detection | 1 global | Central location |
| **coordinator** | System orchestration & monitoring | 1 global | Central location |
| **execution-engine** | Trade execution | 1-2 (primary + standby) | Near exchanges |
| **mempool-detector** | Pending transaction monitoring | 1 per high-value chain | Near RPC providers |

### Partition Configuration

| Partition ID | Chains | Optimal Region | Provider |
|--------------|--------|----------------|----------|
| `asia-fast` | BSC, Polygon, Avalanche | Singapore | Fly.io |
| `l2-turbo` | Arbitrum, Optimism, Base, zkSync, Linea | US-East | Oracle Cloud |
| `high-value` | Ethereum, Fantom | US-East | Oracle Cloud |
| `solana` | Solana | US-West | Railway |

---

## Infrastructure Strategy

| Service | Region | Provider | Tier |
|---------|--------|----------|------|
| **Redis DB** | Per-instance | Self-hosted (Oracle ARM) | Free |
| **unified-detector (asia-fast)** | Singapore | Fly.io | Free |
| **unified-detector (l2-turbo)** | US-East | Oracle Cloud | Always Free |
| **unified-detector (high-value)** | US-East | Oracle Cloud | Always Free |
| **unified-detector (solana)** | US-West | Railway | Free |
| **Cross-Chain Detector** | US-East | Oracle Cloud | Always Free |
| **Coordinator** | US-East | Koyeb | Free |
| **Execution Engine** | US-West | Railway | Trial/Free |

---

## Prerequisites

### System Requirements
- Node.js 18+
- Docker & Docker Compose

### Required Cloud Accounts
- [Fly.io](https://fly.io/) (Detectors)
- [Oracle Cloud](https://www.oracle.com/cloud/free/) (Heavy Computation)
- [Railway](https://railway.app/) (Execution)
- [Koyeb](https://www.koyeb.com/) (Coordinator)
- [Upstash](https://upstash.com/) (Redis)

### RPC Providers (Free Tiers)
See [RPC Research Report](./reports/RPC_RESEARCH_REPORT.md) for detailed provider analysis.

---

## Step-by-Step Deployment

### 1. Infrastructure Setup (Redis)

**Option A: Self-Hosted Redis (Recommended)**

Deploy Redis 7 as a sidecar on each Oracle ARM instance. This eliminates Upstash's 10K cmd/day limit and reduces Redis RTT from 5-20ms to <0.1ms. See [Deep Enhancement Analysis Item #1](./reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md).

1. Set `redis_self_hosted = true` in your `terraform.tfvars`
2. Set `redis_password` to a strong password in your `terraform.tfvars`
3. Redis 7 will be deployed automatically via cloud-init on each Oracle ARM instance
4. Each service connects to `redis://localhost:6379` (configured automatically)
5. Set `REDIS_SELF_HOSTED=true` in your service environment

**Option B: Upstash (Legacy - 10K cmd/day limit)**

1. Create an Upstash account and a **Global Redis** database.
2. Enable **Redis Streams** (required for ADR-002).
3. Note your `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### 2. Detector Deployment (Partitioned Architecture)

#### Asia-Fast Partition (Fly.io - Singapore)
```bash
# Authenticate
fly auth login

# Deploy unified-detector with asia-fast partition
cd services/unified-detector
fly launch --name detector-asia-fast --region sin

# Set environment variables
fly secrets set \
  PARTITION_ID="asia-fast" \
  UPSTASH_REDIS_REST_URL="..." \
  UPSTASH_REDIS_REST_TOKEN="..." \
  BSC_RPC_URL="..." \
  POLYGON_RPC_URL="..." \
  AVALANCHE_RPC_URL="..."

fly deploy
```

#### L2-Turbo Partition (Oracle Cloud - US-East)
```bash
# Deploy as container on Oracle Cloud Always Free tier
# Uses ARM-based Ampere A1 instances (4 OCPUs, 24GB RAM free)

PARTITION_ID=l2-turbo \
ENABLED_CHAINS=arbitrum,optimism,base,zksync,linea \
docker-compose -f docker-compose.detector.yml up -d
```

#### High-Value Partition (Oracle Cloud - US-East)
```bash
PARTITION_ID=high-value \
ENABLED_CHAINS=ethereum,fantom \
docker-compose -f docker-compose.detector.yml up -d
```

#### Solana Partition (Railway - US-West)
```bash
# Railway deployment via GitHub integration
# Set these environment variables in Railway dashboard:
# - PARTITION_ID=solana
# - ENABLED_CHAINS=solana
# - SOLANA_RPC_URL=...
```

### 3. Cross-Chain Detector (Oracle Cloud)

```bash
cd services/cross-chain-detector
docker-compose up -d

# Environment variables:
# - UPSTASH_REDIS_REST_URL
# - UPSTASH_REDIS_REST_TOKEN
```

### 4. Execution Engine (Railway)

1. Connect your GitHub repo to Railway.
2. Add the `services/execution-engine` directory as a new service.
3. Set environment variables:

```bash
# Required
UPSTASH_REDIS_REST_URL="..."
UPSTASH_REDIS_REST_TOKEN="..."
PRIVATE_KEY="..."  # Use Railway's secret management

# Optional: A/B Testing (Task 3)
AB_TESTING_ENABLED="false"  # Set to "true" to enable
AB_TESTING_TRAFFIC_SPLIT="0.1"  # 10% variant traffic
AB_TESTING_MIN_SAMPLE_SIZE="100"

# Optional: Flash Loan
FLASH_LOAN_CONTRACT_ADDRESS="..."  # After testnet deployment
```

### 5. Coordinator (Koyeb)

1. Link your repo to Koyeb.
2. Deploy `services/coordinator` in the US-East region.
3. Access your dashboard at the assigned URL.

---

## Flash Loan Contract Deployment

> **Status:** Contracts ready, awaiting testnet deployment (Task 1 in FINAL_IMPLEMENTATION_PLAN.md)

### Prerequisites
- Testnet ETH (Sepolia faucet: https://sepoliafaucet.com/)
- Testnet ARB (Arbitrum bridge: https://bridge.arbitrum.io/)
- `DEPLOYER_PRIVATE_KEY` in environment

### Deployment Steps
```bash
cd contracts

# Deploy to Sepolia
npm run deploy:sepolia

# Deploy to Arbitrum Sepolia
npm run deploy:arbitrum-sepolia

# Verify deployments
npm run validate:addresses
```

### Post-Deployment
1. Update `contracts/deployments/addresses.ts` with deployed addresses
2. Update `FLASH_LOAN_CONTRACT_ADDRESS` in execution engine

---

## Security Configuration

### Private Key Management
> [!IMPORTANT]
> Never store private keys in environment variables directly in your code. Use the secret management systems provided by the hosting platforms (e.g., `fly secrets`, Railway Variables).

### Wallet Security Checklist
- [ ] Use dedicated hot wallet with minimal balance
- [ ] Enable multi-sig for withdrawal (if supported)
- [ ] Set up alerts for large transfers
- [ ] Rotate keys periodically

### Health Monitoring
All services expose a `/health` endpoint. The Coordinator service monitors these and will alert you via the dashboard if any service goes offline.

---

## Environment Variables Reference

### Common (All Services)
```bash
# Self-hosted Redis (recommended)
REDIS_URL=redis://:password@localhost:6379  # Local Redis URL
REDIS_SELF_HOSTED=true                      # Permits localhost in production
REDIS_PASSWORD=your_password                # Redis authentication

# OR Upstash Redis (legacy)
UPSTASH_REDIS_REST_URL=     # Upstash Redis REST URL
UPSTASH_REDIS_REST_TOKEN=   # Upstash Redis REST token

LOG_LEVEL=info              # debug, info, warn, error
NODE_ENV=production         # development, production
```

### Detector Services
```bash
PARTITION_ID=               # asia-fast, l2-turbo, high-value, solana
ENABLED_CHAINS=             # Comma-separated chain list (overrides partition)
MIN_PROFIT_THRESHOLD=0.5    # Minimum profit percentage
PRICE_STALENESS_MS=30000    # Max age for price data
```

### Execution Engine
```bash
PRIVATE_KEY=                # Hot wallet private key (use secrets manager!)
SIMULATION_MODE=false       # Set true for paper trading
MAX_GAS_PRICE=50            # Gwei limit for transactions

# A/B Testing (Task 3)
AB_TESTING_ENABLED=false
AB_TESTING_TRAFFIC_SPLIT=0.1
AB_TESTING_MIN_SAMPLE_SIZE=100
AB_TESTING_SIGNIFICANCE=0.05

# Flash Loans
FLASH_LOAN_CONTRACT_ADDRESS=
FLASH_LOAN_MIN_PROFIT_BPS=50  # 0.5% minimum profit
```

### Coordinator
```bash
DASHBOARD_PORT=3000
ALERT_WEBHOOK_URL=          # Optional: Slack/Discord webhook
```

---

## Optimization Tuning

After deployment, you can tune performance via the Coordinator dashboard or environment variables:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `MIN_PROFIT_THRESHOLD` | Minimum profit % to execute | 0.5 |
| `MAX_GAS_PRICE` | Safety limit (Gwei) | 50 |
| `PRICE_STALENESS_MS` | Max price age | 30000 |
| `AB_TESTING_TRAFFIC_SPLIT` | Variant traffic % | 0.1 |

---

## Monitoring & Observability

### Health Endpoints
- `GET /health` - Service health status
- `GET /metrics` - Prometheus-compatible metrics (if enabled)

### Key Metrics to Watch
- Detection latency (<50ms target)
- Execution success rate (>85% target)
- Redis Streams lag
- RPC provider health

### Alerting
Configure `ALERT_WEBHOOK_URL` in Coordinator for:
- Service downtime
- High error rates
- Execution failures
- Circuit breaker trips

---

## Troubleshooting

### Common Issues

**Problem:** Detector not finding opportunities
- Check RPC provider connectivity
- Verify `MIN_PROFIT_THRESHOLD` isn't too high
- Check Redis Streams for price updates

**Problem:** Execution failures
- Verify wallet has sufficient balance
- Check gas price limits
- Review circuit breaker status

**Problem:** High latency
- Check RPC provider response times
- Verify partition is in optimal region
- Review Redis connection latency

### Debug Mode
```bash
LOG_LEVEL=debug npm start
```

---

## Architecture Decision Records

- [ADR-002: Redis Streams](./architecture/adr/ADR-002-redis-streams.md)
- [ADR-003: Partitioned Detectors](./architecture/adr/ADR-003-partitioned-detectors.md)
- [ADR-007: Cross-Region Failover](./architecture/adr/ADR-007-standby-activation.md)
- [ADR-014: Modular Detector Components](./architecture/adr/ADR-014-modular-detector-components.md)
- [ADR-020: Flash Loan Integration](./architecture/adr/ADR-020-flash-loan.md)
- [ADR-021: Capital Risk Management](./architecture/adr/ADR-021-capital-risk-management.md)
