# Local Development Guide

This guide covers setting up and running the arbitrage system locally for development and testing.

## Prerequisites

### System Requirements
- Node.js 18+ (LTS recommended)
- Git
- Docker & Docker Compose (optional - can use in-memory Redis instead)

### Optional (for full functionality)
- Private RPC endpoints (Alchemy, Infura, QuickNode) - recommended for heavy development
- Test wallet with small amounts on testnets

## Quick Start

```bash
# 1. Clone and install dependencies
git clone <repository-url>
cd arbitrage_new
npm install

# 2. Copy environment configuration (cross-platform)
npm run dev:setup
# Or manually: cp .env.local .env (Unix) / copy .env.local .env (Windows)

# 3. Start Redis (required) - choose one option:
npm run dev:redis          # Option A: Docker (requires Docker)
npm run dev:redis:memory   # Option B: In-memory (no Docker needed)

# 4. Start all services
npm run dev:start

# 5. Check status
npm run dev:status
```

## Environment Configuration

The `.env.local` file contains all configuration for local development. Copy it to `.env` and modify as needed.

### Service Ports

| Service | Port | Environment Variable |
|---------|------|---------------------|
| Coordinator | 3000 | `COORDINATOR_PORT` |
| P1 Asia-Fast Detector | 3001 | `P1_ASIA_FAST_PORT` |
| P2 L2-Turbo Detector | 3002 | `P2_L2_TURBO_PORT` |
| P3 High-Value Detector | 3003 | `P3_HIGH_VALUE_PORT` |
| Cross-Chain Detector | 3004 | `CROSS_CHAIN_DETECTOR_PORT` |
| Execution Engine | 3005 | `EXECUTION_ENGINE_PORT` |
| Redis | 6379 | `REDIS_PORT` |
| Redis Commander (UI) | 8081 | - |

### Redis Configuration

```env
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379
```

#### Redis Options

**Option A: Docker Redis (recommended for production-like environment)**
```bash
npm run dev:redis           # Start Redis container
npm run dev:redis:ui        # Start with Redis Commander UI for debugging
npm run dev:redis:down      # Stop Redis container
npm run dev:redis:logs      # View container logs
```

**Option B: In-Memory Redis (no Docker required)**
```bash
npm run dev:redis:memory    # Start in-memory Redis server
```

The in-memory option uses `redis-memory-server` and is useful when:
- Docker is not installed or Docker Hub is blocked
- You want a quick, lightweight setup
- Running in CI/CD environments

The startup scripts automatically detect which Redis mode is running.

### Blockchain RPC Endpoints

The `.env.local` file includes free public RPC endpoints for development:

```env
# Ethereum
ETHEREUM_RPC_URL=https://eth.llamarpc.com
ETHEREUM_WS_URL=wss://ethereum.publicnode.com

# BSC
BSC_RPC_URL=https://bsc-dataseed1.binance.org
BSC_WS_URL=wss://bsc-ws-node.nariox.org:443

# And more...
```

> **Note**: Free public endpoints have rate limits. For production or heavy development, use paid providers like Alchemy, Infura, or QuickNode.

#### RPC Rate Limiting

The system handles rate limiting automatically through:

1. **Provider Health Scoring**: Tracks success rates, latency, and rate limit events per provider
2. **Intelligent Fallback**: Automatically switches to healthier providers when rate limits are hit
3. **Exponential Backoff**: Retries with increasing delays (1s, 2s, 4s...) and jitter
4. **Chain-Specific Thresholds**: Different staleness detection for fast chains (5s) vs slow chains (15s)

If you see rate limit warnings in logs, this is expected with free endpoints. The system will:
- Temporarily exclude rate-limited providers
- Select alternative providers based on health scores
- Resume using the provider after a cooldown period

For development with heavy RPC usage, either:
- Enable simulation mode (`SIMULATION_MODE=true`) to avoid real RPC calls
- Use paid RPC providers with higher rate limits

## Simulation Modes

The system supports two independent simulation modes for safe local development:

### 1. Price Simulation Mode

Simulates blockchain data (prices, swap events) without connecting to real blockchains.

```env
# Enable price simulation
SIMULATION_MODE=true
SIMULATION_VOLATILITY=0.02
SIMULATION_UPDATE_INTERVAL_MS=1000
```

**Use cases:**
- Testing detection logic without real blockchain data
- Development without RPC endpoints
- CI/CD testing

### 2. Execution Simulation Mode

Bypasses real blockchain transactions while still consuming real (or simulated) price data.

```env
# Enable execution simulation
EXECUTION_SIMULATION_MODE=true

# Configuration options
EXECUTION_SIMULATION_SUCCESS_RATE=0.85      # 85% success rate
EXECUTION_SIMULATION_LATENCY_MS=500         # 500ms simulated latency
EXECUTION_SIMULATION_GAS_USED=200000        # Gas per transaction
EXECUTION_SIMULATION_GAS_COST_MULTIPLIER=0.1 # 10% of profit as gas cost
EXECUTION_SIMULATION_PROFIT_VARIANCE=0.2    # +/-20% profit variance
EXECUTION_SIMULATION_LOG=true               # Log simulated executions
```

**Use cases:**
- Testing the full pipeline without risking funds
- Integration testing
- Performance benchmarking
- Demo/presentation purposes

### 3. Full Simulation Mode

Combine both modes to test the complete system without any blockchain interaction:

```bash
npm run dev:simulate:full
```

Or set both in `.env`:
```env
SIMULATION_MODE=true
EXECUTION_SIMULATION_MODE=true
```

## NPM Scripts

### Setup & Configuration

```bash
# Copy .env.local to .env (cross-platform)
npm run dev:setup
```

### Starting Services

```bash
# Start Redis (choose one)
npm run dev:redis          # Docker Redis
npm run dev:redis:memory   # In-memory Redis (no Docker)

# Start Redis with Commander UI (for debugging)
npm run dev:redis:ui

# Start all services (requires Redis to be running first)
npm run dev:start

# Start with price simulation
npm run dev:simulate

# Start with execution simulation
npm run dev:simulate:execution

# Start with both simulations
npm run dev:simulate:full
```

### Running Individual Services

```bash
# Coordinator
npm run dev:coordinator

# Partitioned Detectors
npm run dev:partition:asia    # Port 3001
npm run dev:partition:l2      # Port 3002
npm run dev:partition:high    # Port 3003

# Cross-Chain Detector
npm run dev:cross-chain       # Port 3004

# Execution Engine
npm run dev:execution         # Port 3005
npm run dev:execution:simulate  # With simulation mode
```

### Monitoring & Management

```bash
# Check service status
npm run dev:status

# View Redis logs
npm run dev:redis:logs

# Stop all services
npm run dev:stop

# Stop Redis
npm run dev:redis:down
```

### Building & Testing

```bash
# Build all packages
npm run build

# Type check
npm run typecheck

# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests
npm run test:integration

# Run with coverage
npm run test:coverage
```

## Service Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Local Development                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ P1 Asia-Fast │    │ P2 L2-Turbo  │    │ P3 High-Value│      │
│  │   :3001      │    │   :3002      │    │   :3003      │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │               │
│         └───────────────────┼───────────────────┘               │
│                             │                                   │
│                             ▼                                   │
│              ┌─────────────────────────────┐                    │
│              │     Redis Streams :6379     │                    │
│              │  stream:opportunities       │                    │
│              │  stream:price-updates       │                    │
│              │  stream:swap-events         │                    │
│              │  stream:health              │                    │
│              └─────────────────────────────┘                    │
│                             │                                   │
│              ┌──────────────┼──────────────┐                    │
│              │              │              │                    │
│              ▼              ▼              ▼                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Coordinator  │  │ Cross-Chain  │  │  Execution   │          │
│  │   :3000      │  │   :3004      │  │   :3005      │          │
│  │  (Dashboard) │  │  (Detector)  │  │  (Engine)    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **Detection**: Partition detectors monitor blockchain events and detect arbitrage opportunities
2. **Publishing**: Opportunities are published to `stream:opportunities` via Redis Streams
3. **Coordination**: Coordinator consumes and tracks opportunities for the dashboard
4. **Execution**: Execution Engine consumes opportunities and executes (or simulates) trades

Both Coordinator and Execution Engine consume from the same stream using different consumer groups, ensuring both receive all messages.

## Troubleshooting

### Redis Connection Issues

```bash
# Check if Redis is running
npm run dev:status         # Shows all service status including Redis

# For Docker Redis:
docker ps | grep arbitrage-redis
npm run dev:redis:down && npm run dev:redis

# For in-memory Redis:
# Simply restart the redis:memory process
npm run dev:redis:memory
```

### Docker Hub Blocked

If Docker Hub is blocked in your environment:

```bash
# Use in-memory Redis instead of Docker
npm run dev:redis:memory
```

The in-memory Redis provides the same functionality for development without requiring Docker.

### Port Conflicts

If a port is already in use, modify the corresponding environment variable in `.env`:

```env
COORDINATOR_PORT=3100  # Changed from 3000
```

### Service Not Starting

1. Check logs for the specific service
2. Ensure Redis is running (`npm run dev:redis`)
3. Ensure dependencies are installed (`npm install`)
4. Try rebuilding (`npm run build`)

### TypeScript Errors

```bash
# Run type check to see all errors
npm run typecheck

# Clean build
npm run build:clean
```

### Windows-Specific Issues

On Windows, if services fail to start or stop:

1. **Use PowerShell or Command Prompt** (not Git Bash for some commands)
2. **Process cleanup**: Services are stopped using `taskkill` automatically
3. **Path issues**: All scripts use `path.join()` for cross-platform compatibility

```bash
# Manual cleanup if needed
tasklist | findstr "node"
taskkill /F /IM node.exe   # Warning: kills all Node processes
```

## Testing the Full Pipeline

### With Real Blockchain Data (Simulation Execution Only)

```bash
# Set in .env
EXECUTION_SIMULATION_MODE=true

# Start services
npm run dev:start

# Monitor opportunities in Redis Commander
# Open http://localhost:8081
```

### With Full Simulation

```bash
# Start with both simulations
npm run dev:simulate:full

# Or set both flags
SIMULATION_MODE=true
EXECUTION_SIMULATION_MODE=true
npm run dev:start
```

### Integration Tests

```bash
# Run end-to-end tests
npm run test:integration

# Run specific test file
npx jest tests/integration/e2e-execution-flow.integration.test.ts
```

## Development Workflow

1. **Make changes** to the code
2. **Run type check**: `npm run typecheck`
3. **Run tests**: `npm test`
4. **Test locally**: `npm run dev:start` (with appropriate simulation mode)
5. **Check status**: `npm run dev:status`

## Security Notes

> **WARNING**: Never use private keys with real funds for local development!

For local testing with simulation mode, you can use dummy private keys:

```bash
# Generate test keys
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
```

Set in `.env`:
```env
ETHEREUM_PRIVATE_KEY=0x<generated-test-key>
```

## Related Documentation

- [Deployment Guide](./deployment.md) - Cloud deployment instructions
- [Architecture Overview](./architecture/ARCHITECTURE_V2.md) - System design
- [ADR-002: Redis Streams](./architecture/adr/ADR-002-redis-streams.md) - Event streaming design
- [Test Architecture](./TEST_ARCHITECTURE.md) - Testing patterns
