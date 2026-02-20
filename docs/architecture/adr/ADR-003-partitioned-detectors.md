# ADR-003: Partitioned Chain Detectors

## Status
**Implemented** | 2025-01-10 | Updated 2025-01-12 (Solana P4 added)

## Implementation Status

### Single-Chain Detector Deprecation (2025-01-11)

All single-chain detector services are now deprecated in favor of `unified-detector`:

| Service | Status | Replacement |
|---------|--------|-------------|
| `services/ethereum-detector` | DEPRECATED | `unified-detector` with PARTITION_ID=high-value |
| `services/arbitrum-detector` | DEPRECATED | `unified-detector` with PARTITION_ID=l2-turbo |
| `services/optimism-detector` | DEPRECATED | `unified-detector` with PARTITION_ID=l2-turbo |
| `services/base-detector` | DEPRECATED | `unified-detector` with PARTITION_ID=l2-turbo |
| `services/polygon-detector` | DEPRECATED | `unified-detector` with PARTITION_ID=asia-fast |
| `services/bsc-detector` | DEPRECATED | `unified-detector` with PARTITION_ID=asia-fast |

### Migration Markers Added

Each deprecated service has:
- `DEPRECATED.md` - Detailed migration instructions
- `package.json` - `"deprecated"` field with migration notice

### Usage

```bash
# Run with partition configuration
PARTITION_ID=asia-fast npm start

# Or specify chains directly
ENABLED_CHAINS=bsc,polygon,avalanche npm start
```

### Documentation

See [unified-detector README](../../../services/unified-detector/README.md) for complete usage instructions.

### Cross-Chain Detector Exception

The `cross-chain-detector` service is an intentional exception to the BaseDetector pattern:

| Aspect | BaseDetector | CrossChainDetector |
|--------|--------------|-------------------|
| Role | Event producer | Event consumer |
| Chain connection | WebSocket to 1 chain | None (reads Redis Streams) |
| Data flow | Chain -> Redis Streams | Redis Streams -> Analysis |
| Scaling | 1 instance per partition | 1 global instance |

The CrossChainDetector consumes price updates from ALL chains to detect cross-chain arbitrage opportunities. It does not extend BaseDetector because:
- No blockchain WebSocket connection required
- Aggregates multiple chains by design
- Different lifecycle (tied to Redis, not chain availability)

See `services/cross-chain-detector/src/detector.ts` for full documentation.

### Mempool Detector (Optional)

The Mempool Detector is a separate optional service for pre-block arbitrage detection:

| Aspect | Partition Detectors (P1-P4) | Mempool Detector |
|--------|---------------------------|------------------|
| Role | On-chain event detection | Pre-block opportunity detection |
| Data source | WebSocket event logs | bloXroute BDN mempool feed |
| Service port | 3001-3004 | 3008 |
| Startup | `npm run dev:all` | `npm run dev:mempool` (separate) |

The Mempool Detector operates independently of the partition model and publishes opportunities directly to `stream:opportunities`.

## Context

The current architecture has **one service per blockchain**:
- `bsc-detector`
- `ethereum-detector`
- `arbitrum-detector`
- `base-detector`
- `polygon-detector`

This approach has scaling issues:
1. **Linear service growth**: 15 chains = 15 services = 15 deployments
2. **Resource inefficiency**: Each service has minimum overhead regardless of chain activity
3. **Provider limits**: Fly.io free tier allows only 3 apps
4. **Deployment complexity**: 15 separate CI/CD pipelines

## Decision

Adopt **Partitioned Chain Detectors** where multiple chains are grouped into a single service based on:
1. Geographic proximity (latency optimization)
2. Block time similarity (processing rhythm)
3. Resource requirements (memory, CPU)

### Partition Design

| Partition | Chains | Rationale | Deployment |
|-----------|--------|-----------|------------|
| **P1: Asia-Fast** | BSC, Polygon, Avalanche, Fantom | Sub-5s blocks, Asia validators | Oracle Cloud Singapore |
| **P2: L2-Turbo** | Arbitrum, Optimism, Base | Sub-1s blocks, shared sequencers | Fly.io Singapore |
| **P3: High-Value** | Ethereum, zkSync, Linea | Higher value, more analysis needed | Oracle Cloud US-East |
| **P4: Solana-Native** | Solana | Non-EVM, @solana/web3.js, 400ms blocks | Fly.io US-West |

### P4: Solana Partition Details

Solana requires a dedicated partition due to fundamental architectural differences:

| Aspect | EVM Partitions (P1-P3) | Solana (P4) |
|--------|------------------------|-------------|
| SDK | ethers.js | @solana/web3.js |
| Event Model | Contract event logs | Program account subscriptions |
| RPC Method | eth_subscribe (logs) | accountSubscribe |
| Block Time | 2-12 seconds | ~400ms (slot time) |
| Finality | 2-60 confirmations | ~32 slots (~13s) |
| MEV Protection | Flashbots, private pools | Jito bundles |
| DEX Architecture | Factory + pairs | Program accounts |

**Solana DEXs Monitored (7)**:
- Jupiter (aggregator)
- Raydium AMM + CLMM
- Orca Whirlpools
- Meteora DLMM
- Phoenix (order book)
- Lifinity

**Why Separate Partition**:
1. Different technology stack (not ethers.js compatible)
2. Different event subscription model
3. Different RPC rate limits (Helius vs EVM providers)
4. Different performance characteristics
5. Isolated failure domain

### Implementation

```typescript
// Unified detector with partition configuration
interface PartitionConfig {
  partitionId: number;
  chains: ChainConfig[];
  region: string;
  resourceProfile: 'light' | 'standard' | 'heavy';
}

class UnifiedChainDetector {
  constructor(private config: PartitionConfig) {}

  async start(): Promise<void> {
    for (const chain of this.config.chains) {
      await this.initializeChain(chain);
    }
  }

  private async initializeChain(chain: ChainConfig): Promise<void> {
    // Create WebSocket connection
    // Subscribe to events
    // Register with price matrix
  }
}

// Deployment configuration
const PARTITIONS: PartitionConfig[] = [
  {
    partitionId: 1,
    chains: [CHAINS.bsc, CHAINS.polygon, CHAINS.avalanche, CHAINS.fantom],
    region: 'asia-southeast1',
    resourceProfile: 'heavy'
  },
  // ... other partitions
];
```

## Rationale

### Resource Efficiency Analysis

| Approach | 9 Chains | 15 Chains | Free Tier Fit |
|----------|----------|-----------|---------------|
| 1 service/chain | 9 services | 15 services | NO (exceeds limits) |
| 3 partitions | 3 services | 3-4 services | YES |
| 1 monolith | 1 service | 1 service | NO (memory limits) |

### Why Group by Block Time?

Chains with similar block times have similar event processing rhythms:

```
Block Time < 1s (L2-Turbo): Arbitrum (0.25s), Optimism (2s), Base (2s)
  → High event frequency, need efficient event loop
  → Best on lightweight, low-latency instances

Block Time 2-5s (Asia-Fast): BSC (3s), Polygon (2s), Avalanche (2s)
  → Moderate frequency, steady rhythm
  → Can share resources efficiently

Block Time > 5s (High-Value): Ethereum (12s)
  → Lower frequency but higher value per event
  → Worth spending more compute on analysis
```

### Why Geographic Grouping?

| Chain | Validator Location | Optimal Detector Location | Latency |
|-------|-------------------|---------------------------|---------|
| BSC | Asia-heavy | Singapore | ~20ms |
| Ethereum | US/EU distributed | US-East | ~50ms |
| Arbitrum | US-based sequencer | US-East or Singapore | ~30ms |

Deploying detectors near validators reduces event latency by 20-50ms.

### Free Tier Compatibility

| Provider | Limit | 1-per-chain | Partitioned |
|----------|-------|-------------|-------------|
| Fly.io | 3 apps | EXCEEDS | 2 partitions OK |
| Oracle Cloud | 4 VMs | EXCEEDS | 2 partitions OK |
| Railway | 1-2 services | EXCEEDS | 1 partition OK |

## Consequences

### Positive
- Scales to 15+ chains with 4 partitions
- Better resource utilization (shared overhead)
- Fewer deployments to manage
- Fits within free hosting limits
- Chains in same partition share price matrix (faster cross-DEX detection)

### Negative
- Partition failure affects multiple chains
- More complex partition assignment logic
- Chains cannot be independently scaled
- Unbalanced partitions waste resources

### Mitigations

1. **Partition failure**: Geographic redundancy, standby partitions
2. **Assignment logic**: Clear rules documented, automated assignment
3. **Independent scaling**: Can split partition if one chain dominates
4. **Balance**: Monitor and rebalance quarterly

## Chain Assignment Algorithm

```typescript
function assignChainToPartition(chain: ChainConfig): PartitionConfig {
  // Rule 1: Solana gets dedicated partition (non-EVM)
  if (chain.id === 'solana' || !chain.isEVM) {
    return PARTITIONS.SOLANA;  // P4
  }

  // Rule 2: L2 rollups with sub-1s blocks
  if (chain.blockTime < 1) {
    return PARTITIONS.L2_TURBO;  // P2
  }

  // Rule 3: High-value chains (Ethereum + ZK rollups)
  if (chain.id === 1 || chain.isZkRollup) {
    return PARTITIONS.HIGH_VALUE;  // P3
  }

  // Rule 4: Fast Asian chains (sub-5s blocks)
  if (chain.blockTime < 5) {
    return PARTITIONS.ASIA_FAST;  // P1
  }

  // Default: High-value partition
  return PARTITIONS.HIGH_VALUE;
}

// Solana-specific detector initialization
async function initializeSolanaPartition(): Promise<void> {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    { wsEndpoint: process.env.SOLANA_WS_URL }
  );

  // Subscribe to DEX program accounts
  for (const dex of SOLANA_DEXS) {
    connection.onProgramAccountChange(
      new PublicKey(dex.programId),
      (accountInfo) => processSolanaSwap(dex, accountInfo),
      'confirmed'
    );
  }
}
```

## Adding New Chains

1. Add chain config to `shared/config/src/index.ts`
2. Run `assignChainToPartition()` to determine partition
3. Add to partition's chain list
4. Redeploy partition (zero-downtime with rolling update)

No new service creation required.

## Alternatives Considered

### Alternative 1: Keep 1 Service Per Chain
- **Rejected because**: Exceeds free tier limits at 9+ chains
- **Would reconsider if**: Paid infrastructure becomes acceptable

### Alternative 2: Single Monolith with All Chains
- **Rejected because**:
  - Memory exceeds Fly.io 256MB limit
  - Single point of failure
  - Cannot geographically distribute
- **Would reconsider if**: Only monitoring 3-4 chains

### Alternative 3: Serverless Functions Per Chain
- **Rejected because**:
  - Cold starts (100-500ms) unacceptable
  - Stateless = no price matrix caching
- **Would reconsider if**: WebSocket support improves in serverless

## References

- [Architecture v2.0](../ARCHITECTURE_V2.md)
- [Current detector implementations](../../../services/)
- [Chain configuration](../../../shared/config/src/index.ts)

## Confidence Level

**92%** - High confidence based on:
- Clear resource math supporting partition approach
- Proven pattern in multi-tenant systems
- Reversible if needed (can split partitions)
- Aligns with free hosting constraints
- Solana partition (P4) isolates non-EVM complexity
- Mature Solana tooling reduces integration risk
