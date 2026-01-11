# Unified Chain Detector

Multi-chain detector service that consolidates blockchain monitoring into configurable partitions per ADR-003.

## Overview

The Unified Chain Detector replaces single-chain detector services (ethereum-detector, bsc-detector, etc.) with a single service capable of monitoring multiple chains based on partition configuration.

### Benefits

- **Resource Efficiency**: Single process for multiple chains reduces overhead
- **Simplified Deployment**: 3-4 partitions instead of 15+ services
- **Cross-Chain Detection**: Chains in same partition share price matrix for faster arbitrage detection
- **Free Tier Compatible**: Fits within Fly.io/Oracle Cloud limits

## Quick Start

```bash
# Install dependencies
npm install

# Run with partition (recommended)
PARTITION_ID=asia-fast npm start

# Or specify chains directly
ENABLED_CHAINS=bsc,polygon npm start
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PARTITION_ID` | Partition to run (asia-fast, l2-fast, high-value) | `asia-fast` |
| `ENABLED_CHAINS` | Comma-separated chain IDs to monitor | From partition config |
| `REGION_ID` | Region identifier for cross-region health | From partition config |
| `HEALTH_CHECK_PORT` | Port for HTTP health endpoint | `3001` |
| `ENABLE_CROSS_REGION_HEALTH` | Enable cross-region health reporting | `true` |

### Partitions

| Partition | Chains | Block Time | Region |
|-----------|--------|------------|--------|
| **asia-fast** | BSC, Polygon, Avalanche, Fantom | 2-3s | Singapore |
| **l2-fast** | Arbitrum, Optimism, Base | <1s | Singapore |
| **high-value** | Ethereum, zkSync, Linea | >5s | US-East |

## Usage Examples

### Run Asia-Fast Partition

```bash
# Monitors BSC, Polygon, Avalanche, Fantom
PARTITION_ID=asia-fast npm start
```

### Run L2-Fast Partition

```bash
# Monitors Arbitrum, Optimism, Base
PARTITION_ID=l2-fast npm start
```

### Run Specific Chains Only

```bash
# Monitor only BSC and Polygon
ENABLED_CHAINS=bsc,polygon npm start
```

### Programmatic Usage

```typescript
import { UnifiedChainDetector } from '@arbitrage/unified-detector';

const detector = new UnifiedChainDetector({
  partitionId: 'asia-fast',
  // Or override with specific chains:
  // chains: ['bsc', 'polygon'],
  enableCrossRegionHealth: true,
  healthCheckPort: 3001
});

// Listen for events
detector.on('priceUpdate', (update) => {
  console.log('Price update:', update);
});

detector.on('opportunity', (opp) => {
  console.log('Arbitrage opportunity:', opp);
});

detector.on('chainError', ({ chainId, error }) => {
  console.error(`Chain ${chainId} error:`, error);
});

// Start monitoring
await detector.start();

// Get statistics
const stats = detector.getStats();
console.log('Total events:', stats.totalEventsProcessed);
console.log('Opportunities found:', stats.totalOpportunitiesFound);

// Get health status
const health = await detector.getPartitionHealth();
console.log('Partition status:', health.status);

// Stop gracefully
await detector.stop();
```

## Architecture

```
UnifiedChainDetector
├── ChainDetectorInstance (bsc)
│   ├── WebSocket connection
│   ├── Event processor
│   └── Price publisher
├── ChainDetectorInstance (polygon)
│   └── ...
└── ChainDetectorInstance (avalanche)
    └── ...
```

### Key Components

- **UnifiedChainDetector**: Main orchestrator managing multiple chain instances
- **ChainDetectorInstance**: Per-chain WebSocket connection and event processing
- **ServiceStateManager**: Handles lifecycle states (starting, running, stopping)
- **CrossRegionHealthManager**: Reports health for failover coordination

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `priceUpdate` | `PriceUpdate` | DEX price change detected |
| `opportunity` | `ArbitrageOpportunity` | Arbitrage opportunity found |
| `chainError` | `{ chainId, error }` | Chain instance error |
| `failoverEvent` | `FailoverEvent` | Cross-region failover triggered |

## Health Monitoring

### HTTP Health Endpoint

```bash
curl http://localhost:3001/health
```

### Redis Streams Health

Health data published to `stream:health` with partition status and per-chain metrics.

### Health Status Values

- **healthy**: All chains connected and processing
- **degraded**: Some chains failed, others still running
- **unhealthy**: All chains failed or critical error

## Migration from Single-Chain Detectors

### Before (Deprecated)

```bash
# Running 6 separate services
cd services/bsc-detector && npm start
cd services/polygon-detector && npm start
cd services/ethereum-detector && npm start
# ... 3 more
```

### After (Recommended)

```bash
# Running 2 partitions covers all 6 chains
PARTITION_ID=asia-fast npm start   # bsc, polygon, avalanche, fantom
PARTITION_ID=l2-fast npm start     # arbitrum, optimism, base
```

## Related Documentation

- [ADR-003: Partitioned Chain Detectors](../../docs/architecture/adr/ADR-003-partitioned-detectors.md)
- [ADR-002: Redis Streams](../../docs/architecture/adr/ADR-002-redis-streams.md)
- [Partition Configuration](../../shared/config/src/partitions.ts)
