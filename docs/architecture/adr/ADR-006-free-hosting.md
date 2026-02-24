# ADR-006: Free Hosting Provider Selection and Allocation

## Status
**Accepted** | 2025-01-10 | Updated 2026-02-24 (Redis self-hosted)

## Context

The system must operate at **$0/month infrastructure cost** while supporting:
- 9+ blockchains
- 55+ DEXs
- 24/7 uptime
- Multi-region deployment

### Available Free Tiers (2024-2025)

| Provider | Free Resources | Limitations |
|----------|---------------|-------------|
| **Oracle Cloud** | 4 ARM OCPU, 24GB RAM + 2 AMD VMs | Forever free, requires credit card |
| **Fly.io** | 3 shared-cpu VMs, 256MB each | Forever free, limited regions |
| **Railway** | $5/month credit | ~500 hours/month |
| **Render** | 750 hours/month, 512MB | Monthly reset |
| **Koyeb** | 2 services, 512MB total | Forever free |
| **GCP** | 1 e2-micro, 1GB | Forever free |
| **Upstash Redis** | 10K commands/day, 256MB | Daily reset |
| **MongoDB Atlas** | 512MB storage | Forever free |
| **Vercel** | 100GB-hours/month | Monthly reset |

## Decision

Allocate services across providers to maximize resource utilization and reliability.

### Service Allocation

| Service | Provider | Region | Resources | Rationale |
|---------|----------|--------|-----------|-----------|
| **Detector P1** (BSC/Poly/Avax/Fantom) | Oracle Cloud ARM | Singapore | 2 OCPU, 12GB | Heavy compute, Asia chains |
| **Detector P2** (ARB/OP/Base) | Fly.io x2 | Singapore | 512MB total | Lightweight L2s |
| **Detector P3** (ETH/zkSync/Linea) | Oracle Cloud ARM | US-East | 2 OCPU, 12GB | Heavy compute, high-value |
| **Cross-Chain Analyzer** | Oracle Cloud AMD | US-East | 1 OCPU, 1GB | ML models |
| **Executor Primary** | Railway | US-West | 512MB | Low latency to chains |
| **Executor Backup** | Render | US-East | 512MB | Geographic redundancy |
| **Coordinator Primary** | Koyeb | US-East | 256MB | Dashboard, health |
| **Coordinator Standby** | GCP | US-Central | 1GB | Failover |
| **Dashboard** | Vercel | Edge | Serverless | Global CDN |
| **Redis** | Self-hosted (Oracle ARM) | Per-instance (localhost) | No limit | Event backbone |
| **Database** | MongoDB Atlas | Global | 512MB | Opportunity logs |

### Resource Utilization

| Provider | Allocated | Available | Utilization |
|----------|-----------|-----------|-------------|
| Oracle Cloud ARM | 4 OCPU, 24GB | 4 OCPU, 24GB | **100%** |
| Oracle Cloud AMD | 1 OCPU, 1GB | 2 OCPU, 2GB | **50%** |
| Fly.io | 2 services | 3 services | **67%** |
| Railway | 1 service | ~2 services | **50%** |
| Render | 1 service | 1 service | **100%** |
| Koyeb | 1 service | 2 services | **50%** |
| GCP | 1 service | 1 service | **100%** |

**Total Utilization: ~75%** (headroom for scaling)

## Rationale

### Why Oracle Cloud for Heavy Compute?

| Factor | Oracle | Fly.io | Railway |
|--------|--------|--------|---------|
| Free RAM | 24GB | 768MB | ~1GB |
| Free CPU | 4 ARM OCPU | 3 shared | ~0.5 vCPU |
| ARM support | Native | Via emulation | No |
| Regions | Singapore, US | Limited free | US only |

Oracle provides **30x more resources** than alternatives.

### Why Fly.io for L2 Detectors?

| Factor | Fly.io | Oracle | Railway |
|--------|--------|--------|---------|
| Cold start | None | None | 10-30s |
| Singapore region | Yes | Yes | No |
| Deployment speed | Fast (Dockerfile) | Slow (VM) | Fast |
| WebSocket support | Native | Native | Native |

Fly.io offers **low-latency Singapore deployment** with simple Dockerfile.

### Why Railway for Execution?

| Factor | Railway | Fly.io | Oracle |
|--------|---------|--------|--------|
| US-West region | Yes | Limited | No |
| Always-on | Yes | Yes | Yes |
| GitHub integration | Excellent | Good | None |
| Secret management | Built-in | Built-in | Manual |

Railway provides **excellent DX** and US-West coverage.

### Why Self-hosted Redis on Oracle ARM?

| Factor | Self-hosted (Oracle ARM) | Upstash | Redis Cloud |
|--------|--------------------------|---------|-------------|
| Command limit | None | 10K/day | 30MB |
| RTT latency | <0.1ms (localhost) | 5-20ms (global) | 5-15ms |
| Streams support | Yes | Yes | Yes |
| Cost | $0 (uses Oracle free tier) | $0 | $0 |
| Persistence | AOF + RDB | Managed | Managed |

Self-hosted Redis 7 on Oracle ARM eliminates the Upstash 10K commands/day limit and reduces Redis RTT from 5-20ms to <0.1ms, recovering 20-40ms on the hot path. Redis runs as a Docker sidecar on each Oracle ARM instance with `REDIS_SELF_HOSTED=true`.

> **Historical note:** Upstash was the original Redis provider. The backup plan (self-host Redis on Oracle) was activated in 2026-02-24 as a performance optimization, not due to Upstash failure. Upstash remains a viable fallback.

## Consequences

### Positive
- $0/month infrastructure cost
- 30GB+ total RAM across providers
- Multi-region deployment achieved
- Each provider failure isolated

### Negative
- Complex deployment across 6+ providers
- Different deployment methods per provider
- Monitoring requires aggregation
- Some providers may change terms

### Mitigations

1. **Complex deployment**: Unified CI/CD scripts per provider
2. **Different methods**: Documented provider-specific guides
3. **Monitoring**: Centralized health endpoint aggregation
4. **Terms changes**: Maintain backup allocation plan

## Backup Allocation Plan

If any provider removes free tier:

| Provider Lost | Backup Plan |
|---------------|-------------|
| Oracle Cloud | Move to GCP + Azure free tiers; Redis to Upstash |
| Fly.io | Move to Render + Railway |
| Railway | Move to Render + Koyeb |
| Koyeb | Move to Render |

## Provider-Specific Notes

### Oracle Cloud
- Requires credit card but never charged for free tier
- ARM instances have best performance/cost
- Singapore region may have availability issues (create early)

### Fly.io
- Free tier limited to 3 apps (using 2)
- 256MB per app is firm limit
- Shared CPU means variable performance

### Railway
- $5 credit resets monthly
- ~500 compute hours
- Excellent for always-on services

### Redis (Self-hosted on Oracle ARM)
- Deployed as Docker sidecar on each ARM instance (512MB allocation)
- AOF persistence with everysec fsync, RDB snapshots
- Dangerous commands (KEYS, FLUSHDB, FLUSHALL, DEBUG) renamed/disabled
- Bound to localhost only (no external access)
- Health checks via `redis-cli ping`
- Legacy Upstash option available as fallback (10K commands/day limit)

## Alternatives Considered

### Alternative 1: Single Provider (Oracle)
- **Rejected because**: Single point of failure, limited regions
- **Would reconsider if**: Oracle adds Singapore AND US-West

### Alternative 2: Paid Infrastructure ($50/month)
- **Rejected because**: Goal is $0 cost
- **Would reconsider if**: Profitability exceeds $500/month

### Alternative 3: Self-Hosted VPS
- **Rejected because**: Requires management, no geographic distribution
- **Would reconsider if**: All free tiers eliminated

## References

- [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)
- [Fly.io Pricing](https://fly.io/docs/about/pricing/)
- [Railway Pricing](https://railway.app/pricing)
- [Upstash Pricing](https://upstash.com/pricing)

## Confidence Level

**95%** - Very high confidence based on:
- All providers verified as of 2025
- Clear resource math
- Backup plans documented
- Multiple providers = redundancy
