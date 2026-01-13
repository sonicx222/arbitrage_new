# P4 Solana-Native Partition Service

The P4 Solana-Native partition detector service for monitoring the Solana blockchain.

## Overview

| Property | Value |
|----------|-------|
| **Partition ID** | `solana-native` |
| **Chain** | Solana (non-EVM) |
| **Region** | Fly.io US-West (`us-west1`) |
| **Standby Region** | Railway US-East (`us-east1`) |
| **Resource Profile** | Heavy (high-throughput chain) |
| **Health Check Port** | 3004 |
| **Health Check Interval** | 10s (fast for ~400ms blocks) |
| **Failover Timeout** | 45s |

## Chain Details

### Solana (Mainnet-Beta)
- **Chain ID**: 101 (convention)
- **Block Time**: ~400ms
- **Type**: Non-EVM (Program-based)
- **Focus**: High-throughput DEX trading, memecoins, LSTs

## Non-EVM Characteristics

Unlike EVM chains, Solana requires different handling:

1. **No Event Logs**: Uses program account subscriptions instead
2. **Program IDs**: DEXes are programs, not contracts (base58 addresses)
3. **Instruction Parsing**: Transactions contain instructions, not events
4. **Fast Blocks**: ~400ms block time requires efficient processing
5. **Different SDK**: Uses `@solana/web3.js` instead of `ethers.js`

## Solana DEXes

| DEX | Program ID | Type |
|-----|------------|------|
| Raydium AMM | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | AMM |
| Orca Whirlpools | `9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP` | CLMM |

## Quick Start

### Local Development

```bash
# Start the service
npm run dev

# Or with Docker
docker-compose up -d

# View logs
docker-compose logs -f
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PARTITION_ID` | Partition identifier | `solana-native` |
| `PARTITION_CHAINS` | Comma-separated chain IDs | `solana` |
| `HEALTH_CHECK_PORT` | HTTP health endpoint port | `3004` |
| `REDIS_URL` | Redis connection URL | - |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `REGION_ID` | Deployment region | `us-west1` |
| `SOLANA_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `SOLANA_WS_URL` | Solana WebSocket endpoint | `wss://api.mainnet-beta.solana.com` |
| `HELIUS_API_KEY` | Helius API key (optional) | - |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service information |
| `GET /health` | Health status (healthy/degraded/unhealthy) |
| `GET /ready` | Readiness check |
| `GET /stats` | Detailed statistics |

### Health Response Example

```json
{
  "service": "partition-solana",
  "status": "healthy",
  "partitionId": "solana-native",
  "chains": ["solana"],
  "healthyChains": ["solana"],
  "uptime": 3600,
  "eventsProcessed": 50000,
  "memoryMB": 256,
  "region": "us-west1",
  "timestamp": 1705123456789
}
```

## Deployment

### Fly.io (Production)

```bash
# Deploy to Fly.io
fly deploy --config fly.toml

# Or manually
fly launch --name partition-solana --region sjc
```

### Railway (Standby)

```bash
# Deploy to Railway
railway up
```

## Monitoring

### Key Metrics

- **Events Processed**: Account update events from Solana
- **Arbitrage Opportunities**: Intra-Solana opportunities (Raydium <-> Orca)
- **Chain Health**: WebSocket connection status to Solana RPC
- **Memory Usage**: Heap memory consumption
- **Uptime**: Service availability

### Alerts

- **RPC Disconnect**: When Solana WebSocket connection drops
- **High Memory**: When memory exceeds 400MB (80% of 512MB)
- **Low Event Rate**: When event rate drops below expected threshold

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 P4 Solana-Native Partition                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│              ┌──────────────────────────────┐               │
│              │         Solana               │               │
│              │      (id: 101)               │               │
│              │      [Non-EVM]               │               │
│              └──────────────────────────────┘               │
│                          │                                   │
│              ┌───────────▼───────────┐                      │
│              │   Program Account     │                      │
│              │    Subscriptions      │                      │
│              └───────────┬───────────┘                      │
│                          │                                   │
│              ┌───────────┼───────────┐                      │
│              │           │           │                      │
│      ┌───────▼───┐ ┌─────▼─────┐ ┌──▼──────┐             │
│      │  Health   │ │   Redis   │ │ Events  │             │
│      │  Server   │ │  Streams  │ │ Handler │             │
│      │  (:3004)  │ │           │ │         │             │
│      └───────────┘ └───────────┘ └─────────┘             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Related Documentation

- [IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md) - S3.1.6 task details
- [ADR-003](../../docs/architecture/adr/ADR-003-partitioned-detectors.md) - Partition architecture
- [Partition Configuration](../../shared/config/src/partitions.ts) - Partition definitions

## Troubleshooting

### Common Issues

1. **Solana RPC Rate Limits**
   - Use Helius/Triton for better rate limits
   - Consider multiple RPC providers for redundancy

2. **WebSocket Connection Drops**
   - Verify RPC endpoint is accessible
   - Check for network congestion

3. **High Memory Usage**
   - Increase max memory allocation
   - Check for event backlog

4. **Slow Event Processing**
   - Solana has ~2500 TPS, ensure efficient handling
   - Use batching for downstream processing

### Debug Mode

```bash
LOG_LEVEL=debug npm run dev
```

## Solana-Specific Considerations

### RPC Providers

| Provider | Free Tier | Notes |
|----------|-----------|-------|
| Public RPC | Unlimited | Rate limited |
| Helius | 100K credits/day | Recommended |
| Triton | 10M requests/month | Good for WS |
| QuickNode | Paid only | Enterprise |

### Program Account Subscriptions

Solana uses `accountSubscribe` for real-time updates:

```typescript
// Subscribe to Raydium AMM pool accounts
connection.onAccountChange(poolAddress, (accountInfo) => {
  // Parse pool state from account data
  const poolState = parseRaydiumPool(accountInfo.data);
  // Calculate prices
  const price = calculatePrice(poolState);
});
```

### Priority Fees

Solana transactions require compute unit pricing:

```typescript
const priorityFee = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: 1000 // Dynamic based on network congestion
});
```
