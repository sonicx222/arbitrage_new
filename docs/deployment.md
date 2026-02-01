# Deployment Guide

This guide provides step-by-step instructions for deploying the **Professional Arbitrage Detection System** across multiple cloud providers while maintaining zero infrastructure costs.

> **For local development**, see the [Local Development Guide](./local-development.md) instead.

## 🌍 Infrastructure Strategy

The system achieves institutional-grade performance by strategically placing microservices in specific geographic regions.

| Service | Region | Provider | Tier |
|---------|--------|----------|------|
| **Redis DB** | Global | Upstash | Free |
| **BSC Detector** | Singapore | Fly.io | Free |
| **ETH Detector** | Singapore | Fly.io | Free |
| **Polygon Detector** | Singapore | Fly.io | Free |
| **Cross-Chain Detector** | Singapore | Oracle Cloud | Always Free |
| **Arbitrum Detector** | US-East | Oracle Cloud | Always Free |
| **Coordinator** | US-East | Koyeb | Free |
| **Execution Engine** | US-West | Railway | Trial/Free |

---

## 🛠️ Prerequisites

### System Requirements
- Node.js 18+
- Docker & Docker Compose

### Required Cloud Accounts
- [Fly.io](https://fly.io/) (Detectors)
- [Oracle Cloud](https://www.oracle.com/cloud/free/) (Heavy Computation/Detectors)
- [Railway](https://railway.app/) (Execution)
- [Koyeb](https://www.koyeb.com/) (Coordinator)
- [Upstash](https://upstash.com/) (Redis)

---

## 🚀 Step-by-Step Deployment

### 1. Infrastructure Setup (Redis)
1. Create an Upstash account and a Global Redis database.
2. Note your `REDIS_URL` and `REDIS_PASSWORD`.

### 2. Detector Deployment (Fly.io)
```bash
# Authenticate
fly auth login

# BSC Detector
cd services/bsc-detector
fly launch --name bsc-detector --region sin
fly secrets set REDIS_URL="..." BSC_RPC_URL="..."
fly deploy
```

### 3. Execution Engine (Railway)
1. Connect your GitHub repo to Railway.
2. Add the `services/execution-engine` directory as a new service.
3. Set environment variables: `REDIS_URL`, `PRIVATE_KEY`.

### 4. Coordinator (Koyeb)
1. Link your repo to Koyeb.
2. Deploy `services/coordinator` in the US-East region.
3. Access your dashboard at the assigned URL.

---

## 🛡️ Security Configuration

### Private Key Management
> [!IMPORTANT]
> Never store private keys in environment variables directly in your code. Use the secret management systems provided by the hosting platforms (e.g., `fly secrets`, Railway Variables).

### Health Monitoring
All services expose a `/health` endpoint. The Coordinator service monitors these and will alert you via the dashboard if any service goes offline.

---

## 📈 Optimization Tuning

After deployment, you can tune performance via the `Coordinator` dashboard or environment variables:
- `MIN_PROFIT_PERCENTAGE`: Minimum threshold for execution.
- `MAX_GAS_PRICE`: Safety limit for transaction costs.
- `LOG_LEVEL`: Set to `debug` for detailed troubleshooting.
