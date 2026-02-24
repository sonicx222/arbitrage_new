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
| `REDIS_URL` | Redis connection URL | `redis://:password@localhost:6379` |
| `PARTITION_ID` | Partition this service belongs to | `asia-fast` |

### Redis Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL | Required |
| `REDIS_PASSWORD` | Redis authentication password | - |
| `REDIS_SELF_HOSTED` | Enable self-hosted Redis mode (permits localhost in production) | `false` |

**Self-hosted Redis (recommended):** Deploy Redis 7 as a Docker sidecar on each Oracle ARM instance. Set `REDIS_SELF_HOSTED=true` and use `REDIS_URL=redis://:password@localhost:6379`. This eliminates the Upstash 10K commands/day limit and reduces RTT from 5-20ms to <0.1ms. See [Deployment Guide](deployment.md) for setup instructions.

**Upstash Redis (legacy):** Set `REDIS_URL` to the Upstash REST URL. The 10K commands/day limit applies; batching (50:1 ratio) is used to stay within this limit.

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
| `PRIVATE_KEY` | EVM wallet private key (fallback for all chains) | Yes (for execution) |
| `SOLANA_PRIVATE_KEY` | Solana wallet keypair (base58) | Yes (for Solana) |

#### Per-Chain Private Keys

Each chain can have its own private key, overriding the global `PRIVATE_KEY`:

| Variable | Chain |
|----------|-------|
| `ETHEREUM_PRIVATE_KEY` | Ethereum |
| `BSC_PRIVATE_KEY` | BNB Smart Chain |
| `ARBITRUM_PRIVATE_KEY` | Arbitrum |
| `POLYGON_PRIVATE_KEY` | Polygon |
| `OPTIMISM_PRIVATE_KEY` | Optimism |
| `BASE_PRIVATE_KEY` | Base |
| `AVALANCHE_PRIVATE_KEY` | Avalanche |
| `FANTOM_PRIVATE_KEY` | Fantom |
| `ZKSYNC_PRIVATE_KEY` | zkSync Era |
| `LINEA_PRIVATE_KEY` | Linea |

#### HD Wallet Derivation (BIP-44)

As an alternative to per-chain private keys, the system supports HD wallet derivation
from a BIP-39 mnemonic. Each EVM chain gets a unique wallet derived via BIP-44 path
`m/44'/60'/0'/0/{chainIndex}`, so compromising one chain's key does not affect others.

| Variable | Description | Required |
|----------|-------------|----------|
| `WALLET_MNEMONIC` | BIP-39 mnemonic phrase (12 or 24 words) for per-chain HD wallet derivation | No |
| `WALLET_MNEMONIC_PASSPHRASE` | Optional BIP-39 passphrase extension (adds entropy beyond the mnemonic) | No |

**Priority order:** Per-chain `{CHAIN}_PRIVATE_KEY` env vars take precedence over HD derivation.
If neither a per-chain key nor a mnemonic is set, the global `PRIVATE_KEY` is used.

**Note:** Solana uses Ed25519 (not secp256k1) and is excluded from HD derivation.
Solana wallets must be provided via `SOLANA_PRIVATE_KEY`.

**Security:** Store `WALLET_MNEMONIC` and `WALLET_MNEMONIC_PASSPHRASE` only in `.env.local`
(gitignored). Never commit mnemonic phrases to version control.

See `services/execution-engine/src/services/hd-wallet-manager.ts` for implementation details.

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `PORT` | HTTP server port | Service-specific |
| `METRICS_ENABLED` | Enable Prometheus metrics | `true` |
| `SIMULATION_MODE` | Run without executing | `false` |

### Feature Flags

| Variable | Description | Default | ADR |
|----------|-------------|---------|-----|
| `FEATURE_BATCHED_QUOTER` | Enable batched quote fetching | `false` | ADR-029 |
| `FEATURE_FLASH_LOAN_AGGREGATOR` | Enable dynamic flash loan provider selection | `true` | ADR-032 |
| `FEATURE_COMMIT_REVEAL` | Enable commit-reveal MEV protection | `true` | Task 3.1 |
| `FEATURE_COMMIT_REVEAL_REDIS` | Use Redis for commitment storage | `false` | Task 3.1 |
| `COMMIT_REVEAL_VALIDATE_PROFIT` | Re-validate profit before reveal | `true` | Task 3.1 |
| `FEATURE_DEST_CHAIN_FLASH_LOAN` | Enable flash loans on destination chain for cross-chain arbs | `false` | FE-001 |

**Batched Quote Fetching** (ADR-029):
- Reduces quote latency by 75-83% (150ms → 30-50ms)
- Requires MultiPathQuoter contract deployed on target chains
- Configure contract addresses per chain (see below)
- Safe to enable after deployment validation

**Commit-Reveal MEV Protection** (Task 3.1):
- Two-step commit-reveal pattern prevents front-running and sandwich attacks
- Step 1: Submit commitment hash on-chain (blocks front-running)
- Step 2: After block confirmation, reveal and execute transaction
- Requires CommitRevealArbitrage contract deployed on target chains
- Configure contract addresses per chain (see below)
- Redis storage required for multi-instance deployments
- Safe to enable after contract deployment and testing

**Contract Address Configuration:**

| Variable | Chain | Example |
|----------|-------|---------|
| `MULTI_PATH_QUOTER_ETHEREUM` | Ethereum Mainnet | `0x...` |
| `MULTI_PATH_QUOTER_ARBITRUM` | Arbitrum One | `0x...` |
| `MULTI_PATH_QUOTER_BASE` | Base | `0x...` |
| `MULTI_PATH_QUOTER_POLYGON` | Polygon | `0x...` |
| `MULTI_PATH_QUOTER_OPTIMISM` | Optimism | `0x...` |
| `MULTI_PATH_QUOTER_BSC` | BNB Smart Chain | `0x...` |

See [ADR-029: Batched Quote Fetching](architecture/adr/ADR-029-batched-quote-fetching.md) for implementation details.

**Commit-Reveal Contract Configuration:**

Deploy with: `npx hardhat run scripts/deploy-commit-reveal.ts --network <chain>`

| Variable | Chain | Example |
|----------|-------|---------|
| `COMMIT_REVEAL_CONTRACT_ETHEREUM` | Ethereum Mainnet | `0x...` |
| `COMMIT_REVEAL_CONTRACT_ARBITRUM` | Arbitrum One | `0x...` |
| `COMMIT_REVEAL_CONTRACT_OPTIMISM` | Optimism | `0x...` |
| `COMMIT_REVEAL_CONTRACT_BASE` | Base | `0x...` |
| `COMMIT_REVEAL_CONTRACT_ZKSYNC` | zkSync Era | `0x...` |
| `COMMIT_REVEAL_CONTRACT_LINEA` | Linea | `0x...` |
| `COMMIT_REVEAL_CONTRACT_BSC` | BNB Smart Chain | `0x...` |
| `COMMIT_REVEAL_CONTRACT_POLYGON` | Polygon | `0x...` |
| `COMMIT_REVEAL_CONTRACT_AVALANCHE` | Avalanche C-Chain | `0x...` |
| `COMMIT_REVEAL_CONTRACT_FANTOM` | Fantom | `0x...` |

**Important:** Verify that zero addresses (`0x0000...0000`) are not used in production. The system will detect and reject zero addresses at configuration time (Issue 1.2 fix).

See [docs/TASK_3.1_COMMIT_REVEAL_IMPLEMENTATION_SUMMARY.md](TASK_3.1_COMMIT_REVEAL_IMPLEMENTATION_SUMMARY.md) for implementation details.

**Flash Loan Provider Aggregation** (ADR-032):
- Dynamically selects optimal flash loan provider via weighted ranking (fees, liquidity, reliability, latency)
- Enabled by default (`FEATURE_FLASH_LOAN_AGGREGATOR` is opt-out)
- Set `FEATURE_FLASH_LOAN_AGGREGATOR=false` to use hardcoded Aave V3 only
- See [ADR-032: Flash Loan Provider Aggregation](architecture/adr/ADR-032-flash-loan-provider-aggregation.md)

**Destination Chain Flash Loans** (FE-001):
- Enables flash loan execution on the destination chain for cross-chain arbitrage sell transactions
- After bridging, uses FlashLoanStrategy for atomic execution on dest chain
- Falls back to direct DEX swap if flash loan fails or chain is unsupported
- Requires flash loan contracts deployed and configured on destination chains
- Set `FEATURE_DEST_CHAIN_FLASH_LOAN=true` to enable

**Flash Loan Contract Configuration:**

Deploy with: `npx hardhat run scripts/deploy-flash-loan.ts --network <chain>`

| Variable | Chain | Example |
|----------|-------|---------|
| `FLASH_LOAN_CONTRACT_ETHEREUM` | Ethereum Mainnet | `0x...` |
| `FLASH_LOAN_CONTRACT_ARBITRUM` | Arbitrum One | `0x...` |
| `FLASH_LOAN_CONTRACT_BASE` | Base | `0x...` |
| `FLASH_LOAN_CONTRACT_POLYGON` | Polygon | `0x...` |
| `FLASH_LOAN_CONTRACT_OPTIMISM` | Optimism | `0x...` |
| `FLASH_LOAN_CONTRACT_BSC` | BNB Smart Chain | `0x...` |
| `FLASH_LOAN_CONTRACT_AVALANCHE` | Avalanche C-Chain | `0x...` |

See [docs/research/FUTURE_ENHANCEMENTS.md](research/FUTURE_ENHANCEMENTS.md#FE-001) for FE-001 implementation details.

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
| `PRICE_STALENESS_MS` | Price expiry threshold (hard rejection) | `30000` | [ADR-033](architecture/adr/ADR-033-stale-price-window.md) |
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

### Quote Fetching Optimization

| Setting | Description | Impact | ADR |
|---------|-------------|--------|-----|
| `FEATURE_BATCHED_QUOTER` | Batch DEX quotes into single RPC call | 75-83% latency reduction | ADR-029 |

**Batched Quote Fetching Performance:**
- **Sequential (Legacy):** 150ms for 2-hop paths (N RPC calls)
- **Batched (Optimized):** 30-50ms for 2-hop paths (1 RPC call)
- **Improvement:** 75-83% latency reduction
- **Trade-offs:** Requires contract deployment, adds 50KB on-chain bytecode
- **Fallback:** Automatically degrades to sequential on errors

**When to Enable:**
- After deploying MultiPathQuoter to target chains
- For flash loan strategies with multi-hop paths
- When quote latency is critical (high-frequency trading)

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

MEV (Maximal Extractable Value) protection prevents front-running and sandwich attacks across supported chains using chain-appropriate strategies.

#### Configuration Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `MEV_PROTECTION_ENABLED` | Enable MEV protection globally | No | `false` |
| `FLASHBOTS_AUTH_KEY` | Flashbots relay signing key (Ethereum) | For Ethereum | - |
| `BLOXROUTE_AUTH_HEADER` | BloXroute BDN authorization (BSC) | For BSC | - |
| `FASTLANE_URL` | Polygon Fastlane RPC URL | For Polygon | Pre-configured |
| `MEV_SUBMISSION_TIMEOUT_MS` | Submission timeout in milliseconds | No | `30000` |
| `MEV_MAX_RETRIES` | Maximum submission retries | No | `3` |
| `MEV_FALLBACK_TO_PUBLIC` | Fallback to public mempool on failure | No | `true` |
| `FEATURE_MEV_SHARE` | Enable MEV-Share for rebate capture | No | `true` |

#### Chain-Specific MEV Protection

| Chain | Strategy | Configuration Required | Protection Level |
|-------|----------|------------------------|------------------|
| Ethereum | Flashbots/MEV-Share | `FLASHBOTS_AUTH_KEY` | High (private relay) |
| BSC | BloXroute | `BLOXROUTE_AUTH_HEADER` | High (private mempool) |
| Polygon | Fastlane | None (uses default URL) | Medium (priority ordering) |
| Arbitrum, Optimism, Base | L2 Sequencer | None | High (inherent protection) |
| zkSync, Linea | L2 Sequencer | None | High (inherent protection) |
| Solana | Jito | None (configured in Solana provider) | High (validator tips) |
| Others | Standard (Gas optimization) | None | Low |

#### Setup Guide

**1. Ethereum (Flashbots & MEV-Share)**

```bash
# Generate auth key (any Ethereum private key works)
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"

# Set in .env
FLASHBOTS_AUTH_KEY=0x1234...your-generated-key
MEV_PROTECTION_ENABLED=true

# Enable MEV-Share for 50-90% rebate capture (recommended)
FEATURE_MEV_SHARE=true
```

**Benefits:**
- Private transaction submission (no front-running)
- MEV-Share captures 50-90% of MEV value as rebates
- Automatic fallback to standard Flashbots if MEV-Share fails

**2. BSC (BloXroute)**

```bash
# Sign up at https://bloxroute.com/
# Get auth header from dashboard

# Set in .env
BLOXROUTE_AUTH_HEADER=YOUR_AUTH_HEADER_FROM_BLOXROUTE
MEV_PROTECTION_ENABLED=true
```

**Benefits:**
- Private mempool submission prevents front-running
- Lower latency than public RPC on BSC
- Automatic fallback to public RPC if BloXroute unavailable

**3. Polygon (Fastlane)**

```bash
# No API key required - uses public endpoint

# Set in .env
MEV_PROTECTION_ENABLED=true
```

**Benefits:**
- MEV-protected transaction ordering
- Priority inclusion through Fastlane network
- No additional cost or signup required

#### Validation

Verify MEV configuration before deployment:

```bash
npm run validate:mev-setup
```

The validation script checks:
- Required API keys are configured for each enabled chain
- URLs are properly formatted
- Strategy mappings are correct
- Fallback behavior is properly configured

#### Monitoring Metrics

Provider-specific metrics for observability:

```typescript
// Total submissions by provider
mev_bloxroute_submissions_total{chain="bsc"}
mev_fastlane_submissions_total{chain="polygon"}

// Success rates
mev_submission_success_rate{strategy="bloxroute"}
mev_submission_success_rate{strategy="fastlane"}

// Latency percentiles
mev_submission_latency_ms{strategy="bloxroute",percentile="p99"}
mev_submission_latency_ms{strategy="fastlane",percentile="p99"}

// Fallback usage
mev_fallback_submissions_total{chain="bsc",reason="bloxroute_timeout"}
```

#### Troubleshooting

**BloXroute submissions failing:**
1. Verify `BLOXROUTE_AUTH_HEADER` is correct
2. Check BloXroute dashboard for account status
3. Ensure fallback is enabled (`MEV_FALLBACK_TO_PUBLIC=true`)
4. Monitor `mev_fallback_submissions_total` metric

**Fastlane submissions slow:**
1. Check Polygon network congestion
2. Verify `FASTLANE_URL` is correct
3. Consider increasing `MEV_SUBMISSION_TIMEOUT_MS`
4. Monitor `mev_submission_latency_ms` metric

**No MEV protection active:**
1. Ensure `MEV_PROTECTION_ENABLED=true`
2. Run validation script: `npm run validate:mev-setup`
3. Check logs for initialization errors
4. Verify chain-specific requirements are met

#### References

- [ADR-017: MEV Protection Architecture](../architecture/adr/ADR-017-mev-protection.md)
- [ADR-028: MEV-Share Integration](../architecture/adr/ADR-028-mev-share-integration.md)
- [Flashbots Documentation](https://docs.flashbots.net/)
- [BloXroute Documentation](https://docs.bloxroute.com/)
- [Polygon Fastlane](https://fastlane.polygon.technology/)

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
