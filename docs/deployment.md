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
| `asia-fast` | BSC, Polygon, Avalanche, Fantom | Singapore | Fly.io |
| `l2-turbo` | Arbitrum, Optimism, Base, Scroll, Blast | Singapore | Fly.io |
| `high-value` | Ethereum, zkSync, Linea | US-East | Fly.io |
| `solana-native` | Solana | US-West | Fly.io |

---

## Infrastructure Strategy

| Service | Region | Provider | Tier |
|---------|--------|----------|------|
| **Redis DB** | Per-instance | Self-hosted (Oracle ARM) | Free |
| **unified-detector (asia-fast)** | Singapore | Fly.io | Free |
| **unified-detector (l2-turbo)** | Singapore | Fly.io | Free |
| **unified-detector (high-value)** | US-East | Fly.io | Free |
| **unified-detector (solana)** | US-West | Fly.io | Free |
| **Cross-Chain Detector** | US-West | Fly.io | Free |
| **Coordinator** | US-West | Fly.io | Free |
| **Execution Engine** | US-West | Fly.io | Free |

---

## Prerequisites

### System Requirements
- Node.js >= 22.0.0
- npm >= 9.0.0
- Docker & Docker Compose

### Required Cloud Accounts
- [Fly.io](https://fly.io/) (All services — coordinator, execution engine, all detector partitions)
- [Upstash](https://upstash.com/) (Redis — if not self-hosting)

### RPC Providers (Free Tiers)
Use free-tier RPC providers (Alchemy, Infura, QuickNode, Chainstack) with multiple fallback URLs per chain. See [Configuration Guide](./CONFIGURATION.md) for all RPC URL environment variables.

---

## Step-by-Step Deployment

### 1. Infrastructure Setup (Redis)

**Option A: Self-Hosted Redis (Recommended)**

Deploy Redis 7 as a sidecar on each Oracle ARM instance. This eliminates Upstash's 10K cmd/day limit and reduces Redis RTT from 5-20ms to <0.1ms.

1. Set `redis_self_hosted = true` in your `terraform.tfvars`
2. Set `redis_password` to a strong password in your `terraform.tfvars`
3. Redis 7 will be deployed automatically via cloud-init on each Oracle ARM instance
4. Each service connects to `redis://localhost:6379` (configured automatically)
5. Set `REDIS_SELF_HOSTED=true` in your service environment

**Option B: Upstash (Legacy - 10K cmd/day limit)**

1. Create an Upstash account and a **Global Redis** database.
2. Enable **Redis Streams** (required for ADR-002).
3. Note your `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### 2. Deployment (TOML-Based)

Each service has a pre-configured Fly.io TOML file in `infrastructure/fly/`. All Dockerfiles use multi-stage builds (builder stage with devDependencies, production stage with only `dist/` and runtime deps).

#### Option A: Automated via CI (Recommended)

Use the **Deployment Gate** workflow (`.github/workflows/deploy.yml`):

1. Go to **Actions → Deployment Gate → Run workflow**
2. Select **environment** (testnet/mainnet), **service** (or "all"), and **dry_run** (true for validation only)
3. The workflow runs 4 phases:
   - **Phase 1**: Pre-deploy validation (build, typecheck, unit tests, contract compilation)
   - **Phase 2**: `fly deploy` with `--wait-timeout 300` per service
   - **Phase 3**: Health check via `fly status --json` (10 retries, 15s interval)
   - **Phase 4**: Automated rollback on failure (redeploys previous release image)

**Required secret**: Add `FLY_API_TOKEN` to your GitHub repository secrets.

**Deployment order for "all"**: Partitions → Cross-Chain → Execution Engine → Coordinator

#### Option B: CLI Script

```bash
# Authenticate
fly auth login

# Deploy a single service
./infrastructure/fly/deploy.sh coordinator

# Deploy all services (partitions in parallel, then dependent services)
./infrastructure/fly/deploy.sh all

# Dry run (show what would be deployed)
./infrastructure/fly/deploy.sh all --dry-run

# Set up secrets before deployment
./infrastructure/fly/deploy.sh coordinator --secrets
```

#### Option C: Manual flyctl

Deploy individual services using their TOML configs:

```bash
# From the project root directory
fly deploy -c infrastructure/fly/partition-asia-fast.toml
fly deploy -c infrastructure/fly/partition-l2-turbo.toml
fly deploy -c infrastructure/fly/partition-high-value.toml
fly deploy -c infrastructure/fly/partition-solana.toml
fly deploy -c infrastructure/fly/cross-chain-detector.toml
fly deploy -c infrastructure/fly/execution-engine.toml
fly deploy -c infrastructure/fly/coordinator.toml
```

### 3. Secrets Configuration

All services require `REDIS_URL` and `STREAM_SIGNING_KEY`. Set secrets before first deployment:

```bash
# Common secrets (all services)
fly secrets set REDIS_URL="redis://:password@host:6379" \
  STREAM_SIGNING_KEY="your-hmac-key" \
  -c infrastructure/fly/<service>.toml

# Partition-specific: chain RPC URLs
fly secrets set BSC_WS_URL="..." BSC_RPC_URL="..." \
  POLYGON_WS_URL="..." POLYGON_RPC_URL="..." \
  AVALANCHE_WS_URL="..." AVALANCHE_RPC_URL="..." \
  FANTOM_WS_URL="..." FANTOM_RPC_URL="..." \
  -c infrastructure/fly/partition-asia-fast.toml

# Execution Engine: wallet + RPC URLs
fly secrets set WALLET_PRIVATE_KEY="..." \
  ETHEREUM_RPC_URL="..." BSC_RPC_URL="..." ARBITRUM_RPC_URL="..." \
  -c infrastructure/fly/execution-engine.toml
```

Or use the interactive secrets flow: `./infrastructure/fly/deploy.sh <service> --secrets`

### 4. Fly.io App Names

| Service | Fly App Name | TOML Config |
|---------|-------------|-------------|
| Coordinator | `arbitrage-coordinator` | `coordinator.toml` |
| Coordinator Standby | `arbitrage-coordinator-standby` | `coordinator-standby.toml` |
| Execution Engine | `arbitrage-execution-engine` | `execution-engine.toml` |
| Asia-Fast Partition | `arbitrage-asia-fast` | `partition-asia-fast.toml` |
| L2-Turbo Partition | `arbitrage-l2-fast` | `partition-l2-turbo.toml` |
| High-Value Partition | `arbitrage-high-value` | `partition-high-value.toml` |
| Solana Partition | `arbitrage-solana` | `partition-solana.toml` |
| Cross-Chain Detector | `arbitrage-cross-chain` | `cross-chain-detector.toml` |

> **Note**: L2-Turbo uses the historical app name `arbitrage-l2-fast` — renaming requires Fly app migration.

---

## Flash Loan Contract Deployment

> **Status:** 1 contract deployed (FlashLoanArbitrage on Arbitrum Sepolia). 6 contract types across 15 chains remain.

### Contract Types

| Contract | Flash Loan Provider | Fee | Key Chains |
|----------|-------------------|-----|------------|
| **FlashLoanArbitrage** | Aave V3 | 0.09% | Ethereum, Arbitrum, Base, Polygon, Optimism, Avalanche |
| **BalancerV2FlashArbitrage** | Balancer V2 | 0% | Ethereum, Polygon, Arbitrum, Optimism, Base, Fantom (Beethoven X) |
| **PancakeSwapFlashArbitrage** | PancakeSwap V3 | Tier-based | BSC, Ethereum, Arbitrum, zkSync, Base, opBNB, Linea |
| **SyncSwapFlashArbitrage** | SyncSwap (EIP-3156) | 0.3% | zkSync |
| **DaiFlashMintArbitrage** | MakerDAO DssFlash (EIP-3156) | 0.01% | Ethereum only |
| **CommitRevealArbitrage** | MEV protection | N/A | All chains |
| **MultiPathQuoter** | Stateless quoter | N/A | All chains |

### Prerequisites
- Testnet ETH (Sepolia faucet: https://sepoliafaucet.com/)
- Testnet ARB (Arbitrum bridge: https://bridge.arbitrum.io/)
- `DEPLOYER_PRIVATE_KEY` in environment (`.env.local`)

### Deployment Steps
```bash
cd contracts

# Aave V3 flash loan (primary)
npx hardhat run scripts/deploy.ts --network sepolia
npx hardhat run scripts/deploy.ts --network arbitrumSepolia

# Balancer V2 flash loan (0% fee — preferred)
npx hardhat run scripts/deploy-balancer.ts --network arbitrumSepolia

# PancakeSwap V3 flash loan (testnet: arbitrumSepolia — bscTestnet has no configured factory)
npx hardhat run scripts/deploy-pancakeswap.ts --network arbitrumSepolia

# SyncSwap flash loan (zkSync only)
DISABLE_VIA_IR=true npx hardhat run scripts/deploy-syncswap.ts --network zksync-testnet

# Commit-Reveal MEV protection
npx hardhat run scripts/deploy-commit-reveal.ts --network sepolia

# MultiPathQuoter (stateless quoter)
npx hardhat run scripts/deploy-multi-path-quoter.ts --network sepolia

# Verify on block explorer
npx hardhat verify --network sepolia DEPLOYED_ADDRESS

# Auto-generate address constants
npm run generate:addresses
```

### Post-Deployment
1. Run `npm run generate:addresses` to update `contracts/deployments/addresses.generated.ts`
2. Review and merge generated addresses into `contracts/deployments/addresses.ts`
3. Update `FLASH_LOAN_CONTRACT_ADDRESS` in execution engine environment
4. Run `npx hardhat test` to verify contract interactions

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
PARTITION_ID=               # asia-fast, l2-turbo, high-value, solana-native
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
- [ADR-007: Cross-Region Failover](./architecture/adr/ADR-007-failover-strategy.md)
- [ADR-014: Modular Detector Components](./architecture/adr/ADR-014-modular-detector-components.md)
- [ADR-020: Flash Loan Integration](./architecture/adr/ADR-020-flash-loan.md)
- [ADR-021: Capital Risk Management](./architecture/adr/ADR-021-capital-risk-management.md)
