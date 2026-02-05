# Configuration Reference

> **Last Updated:** 2026-02-05
> **Version:** 1.0

This document provides a comprehensive reference for all configuration options in the arbitrage system.

---

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Service Configuration](#service-configuration)
3. [Chain Configuration](#chain-configuration)
4. [DEX Configuration](#dex-configuration)
5. [Performance Tuning](#performance-tuning)
6. [Security Configuration](#security-configuration)

---

## Environment Variables

### Required Variables

These must be set for the system to start:

| Variable | Description | Example |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `PARTITION_ID` | Partition this service belongs to | `asia-fast` |

### Chain RPC URLs

Each chain requires HTTP and WebSocket endpoints:

| Variable | Chain | Example |
|----------|-------|---------|
| `ETHEREUM_RPC_URL` | Ethereum Mainnet | `https://eth-mainnet.g.alchemy.com/v2/...` |
| `ETHEREUM_WS_URL` | Ethereum WebSocket | `wss://eth-mainnet.g.alchemy.com/v2/...` |
| `BSC_RPC_URL` | BNB Smart Chain | `https://bsc-dataseed.binance.org` |
| `BSC_WS_URL` | BSC WebSocket | `wss://bsc-ws-node.nariox.org:443` |
| `POLYGON_RPC_URL` | Polygon | `https://polygon-rpc.com` |
| `POLYGON_WS_URL` | Polygon WebSocket | `wss://polygon-bor.publicnode.com` |
| `ARBITRUM_RPC_URL` | Arbitrum One | `https://arb1.arbitrum.io/rpc` |
| `ARBITRUM_WS_URL` | Arbitrum WebSocket | `wss://arb1.arbitrum.io/feed` |
| `OPTIMISM_RPC_URL` | Optimism | `https://mainnet.optimism.io` |
| `OPTIMISM_WS_URL` | Optimism WebSocket | `wss://optimism.publicnode.com` |
| `BASE_RPC_URL` | Base | `https://mainnet.base.org` |
| `BASE_WS_URL` | Base WebSocket | `wss://base.publicnode.com` |
| `AVALANCHE_RPC_URL` | Avalanche C-Chain | `https://api.avax.network/ext/bc/C/rpc` |
| `AVALANCHE_WS_URL` | Avalanche WebSocket | `wss://avalanche-c-chain.publicnode.com` |
| `FANTOM_RPC_URL` | Fantom | `https://rpc.ftm.tools` |
| `FANTOM_WS_URL` | Fantom WebSocket | `wss://fantom.publicnode.com` |
| `ZKSYNC_RPC_URL` | zkSync Era | `https://mainnet.era.zksync.io` |
| `ZKSYNC_WS_URL` | zkSync WebSocket | `wss://mainnet.era.zksync.io/ws` |
| `LINEA_RPC_URL` | Linea | `https://rpc.linea.build` |
| `LINEA_WS_URL` | Linea WebSocket | `wss://linea.drpc.org` |
| `SOLANA_RPC_URL` | Solana | `https://api.mainnet-beta.solana.com` |
| `SOLANA_WS_URL` | Solana WebSocket | `wss://api.mainnet-beta.solana.com` |

### Wallet Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `PRIVATE_KEY` | EVM wallet private key | Yes (for execution) |
| `SOLANA_PRIVATE_KEY` | Solana wallet keypair (base58) | Yes (for Solana) |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `PORT` | HTTP server port | Service-specific |
| `METRICS_ENABLED` | Enable Prometheus metrics | `true` |
| `SIMULATION_MODE` | Run without executing | `false` |

### External Services

| Variable | Description | Required |
|----------|-------------|----------|
| `TENDERLY_ACCESS_KEY` | Tenderly API for simulation | Optional |
| `TENDERLY_PROJECT` | Tenderly project slug | With access key |
| `FLASHBOTS_AUTH_KEY` | Flashbots relay authentication | Optional |
| `BLOXROUTE_AUTH_HEADER` | bloXroute BDN access | Optional |
| `HELIUS_API_KEY` | Helius Solana RPC | Optional |

---

## Service Configuration

### Partition Assignment

Each partition is configured in `shared/config/src/partitions.ts`:

```typescript
export const PARTITIONS = {
  'asia-fast': {
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: 'asia-southeast-1',
    memory: '768MB'
  },
  'l2-turbo': {
    chains: ['arbitrum', 'optimism', 'base'],
    region: 'asia-southeast-1',
    memory: '512MB'
  },
  'high-value': {
    chains: ['ethereum', 'zksync', 'linea'],
    region: 'us-east-1',
    memory: '768MB'
  },
  'solana-native': {
    chains: ['solana'],
    region: 'us-west-1',
    memory: '512MB'
  }
};
```

### Service Ports

| Service | Default Port |
|---------|--------------|
| Coordinator | 3000 |
| Partition Asia-Fast | 3001 |
| Partition L2-Turbo | 3002 |
| Partition High-Value | 3003 |
| Partition Solana | 3004 |
| Execution Engine | 3005 |
| Cross-Chain Detector | 3006 |
| Mempool Detector | 3007 |

---

## Chain Configuration

Chain configuration is in `shared/config/src/chains.ts`:

### Chain Properties

| Property | Description | Example |
|----------|-------------|---------|
| `chainId` | Numeric chain identifier | `1` (Ethereum) |
| `name` | Human-readable name | `"Ethereum Mainnet"` |
| `nativeCurrency` | Native token symbol | `"ETH"` |
| `blockTime` | Average block time (ms) | `12000` |
| `confirmations` | Required confirmations | `1` |
| `gasMultiplier` | Gas estimate multiplier | `1.2` |

### Example Chain Config

```typescript
export const CHAINS = {
  ethereum: {
    chainId: 1,
    name: 'Ethereum Mainnet',
    nativeCurrency: 'ETH',
    blockTime: 12000,
    confirmations: 1,
    gasMultiplier: 1.2,
    explorer: 'https://etherscan.io'
  },
  bsc: {
    chainId: 56,
    name: 'BNB Smart Chain',
    nativeCurrency: 'BNB',
    blockTime: 3000,
    confirmations: 1,
    gasMultiplier: 1.1,
    explorer: 'https://bscscan.com'
  }
  // ... other chains
};
```

---

## DEX Configuration

DEX configuration is in `shared/config/src/dexes.ts`:

### DEX Properties

| Property | Description | Example |
|----------|-------------|---------|
| `name` | DEX identifier | `"uniswap-v2"` |
| `router` | Router contract address | `"0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"` |
| `factory` | Factory contract address | `"0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"` |
| `fee` | Default swap fee (decimal) | `0.003` |
| `version` | Protocol version | `"v2"` |

### Example DEX Config

```typescript
export const DEXES = {
  'uniswap-v2': {
    name: 'Uniswap V2',
    chains: ['ethereum'],
    router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    fee: 0.003,
    version: 'v2'
  },
  'pancakeswap-v2': {
    name: 'PancakeSwap V2',
    chains: ['bsc'],
    router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    fee: 0.0025,
    version: 'v2'
  }
  // ... other DEXes
};
```

---

## Performance Tuning

### Hot-Path Settings

Located in `shared/config/src/performance.ts`:

| Setting | Description | Default | ADR |
|---------|-------------|---------|-----|
| `DETECTION_LATENCY_TARGET_MS` | Target detection latency | `50` | ADR-011 |
| `EVENT_BATCH_SIZE` | Events per batch | `100` | ADR-002 |
| `EVENT_BATCH_INTERVAL_MS` | Batch flush interval | `5` | ADR-002 |
| `PRICE_STALENESS_MS` | Price expiry threshold | `10000` | ADR-005 |
| `WORKER_THREAD_POOL_SIZE` | Path finder workers | `4` | ADR-012 |
| `NONCE_POOL_SIZE` | Pre-allocated nonces | `5` | ADR-027 |

### Cache Settings

| Setting | Description | Default | ADR |
|---------|-------------|---------|-----|
| `L1_CACHE_SIZE` | SharedArrayBuffer pairs | `1000` | ADR-005 |
| `L2_CACHE_TTL_MS` | Redis cache TTL | `30000` | ADR-005 |
| `LRU_CACHE_SIZE` | Token pair LRU size | `500` | ADR-022 |
| `RING_BUFFER_SIZE` | Latency ring buffer | `1000` | ADR-022 |

### Rate Limiting

| Setting | Description | Default | ADR |
|---------|-------------|---------|-----|
| `RPC_RATE_LIMIT_PER_SEC` | RPC calls per second | `10` | ADR-024 |
| `RPC_BURST_SIZE` | Burst allowance | `20` | ADR-024 |
| `REDIS_BATCH_RATIO` | Commands batched | `50:1` | ADR-002 |

---

## Security Configuration

### Secrets Management

See [SECRETS_MANAGEMENT.md](security/SECRETS_MANAGEMENT.md) for detailed guidance.

**Required Secrets:**

| Secret | Storage | Rotation |
|--------|---------|----------|
| `PRIVATE_KEY` | Environment variable | Manual |
| `REDIS_URL` | Environment variable | On compromise |
| `TENDERLY_ACCESS_KEY` | Environment variable | Quarterly |
| `FLASHBOTS_AUTH_KEY` | Environment variable | On compromise |

### MEV Protection

| Setting | Description | Default |
|---------|-------------|---------|
| `MEV_PROTECTION_ENABLED` | Enable MEV protection | `true` |
| `FLASHBOTS_ENABLED` | Use Flashbots for Ethereum | `true` |
| `JITO_ENABLED` | Use Jito for Solana | `true` |
| `PRIVATE_MEMPOOL_THRESHOLD` | Min value for private tx | `0.1 ETH` |

### Circuit Breaker

| Setting | Description | Default | ADR |
|---------|-------------|---------|-----|
| `CIRCUIT_FAILURE_THRESHOLD` | Failures to open | `5` | ADR-018 |
| `CIRCUIT_RESET_TIMEOUT_MS` | Time before half-open | `60000` | ADR-018 |
| `CIRCUIT_HALF_OPEN_REQUESTS` | Test requests | `3` | ADR-018 |

---

## Configuration Files

### File Locations

| File | Purpose |
|------|---------|
| `.env` | Local development secrets |
| `.env.example` | Template with all variables |
| `shared/config/src/` | TypeScript configuration |
| `infrastructure/*/` | Deployment configs per provider |

### Loading Order

1. `.env` file (if exists)
2. Environment variables (override .env)
3. TypeScript defaults (fallback)

---

## Validation

The system validates configuration on startup:

```bash
npm run validate:config
```

This checks:
- All required environment variables are set
- RPC URLs are reachable
- Chain IDs match expected values
- Wallet has sufficient balance

---

## Related Documentation

- [Local Development](local-development.md) - Development setup
- [Deployment Guide](deployment.md) - Production deployment
- [Secrets Management](security/SECRETS_MANAGEMENT.md) - Security practices
- [Free Tiers](Free_Tiers.md) - Provider limits
