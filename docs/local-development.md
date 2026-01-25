# Local Development Guide

This guide covers setting up and running the arbitrage system locally for development and testing on **Windows**, **macOS** (Intel & Apple Silicon), or **Linux**.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Architecture Overview](#architecture-overview)
4. [Step-by-Step Setup](#step-by-step-setup)
5. [Running Individual Services](#running-individual-services)
6. [Simulation Modes](#simulation-modes)
7. [Full Partitioned Architecture](#full-partitioned-architecture)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)
10. [Commands Reference](#commands-reference)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file
npm run dev:setup

# 3. Start Redis (choose one)
npm run dev:redis          # Option A: Docker (recommended)
npm run dev:redis:memory   # Option B: In-memory (no Docker required)

# 4. Check status
npm run dev:status

# 5. Start services (in separate terminals)
npm run dev:coordinator      # Terminal 1: Dashboard at http://localhost:3000
npm run dev:partition:asia   # Terminal 2: Asia-Fast detector (port 3001)
npm run dev:execution        # Terminal 3: Execution engine (port 3005)
npm run dev:cross-chain      # Terminal 4: Cross-chain detector (port 3006)
```

Visit **http://localhost:3000** to see the coordinator dashboard.

> **Note**: The build step (`npm run build`) is optional for development. The dev scripts use ts-node to run TypeScript directly.

---

## Prerequisites

### Required Software

| Software | Version | Installation |
|----------|---------|--------------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org) (LTS version) |
| npm | 9+ | Comes with Node.js |
| Docker Desktop | Latest | [docker.com](https://docker.com/products/docker-desktop) (optional) |

### Platform-Specific Notes

#### Windows
- Use **PowerShell** or **Windows Terminal** (not cmd.exe) for best experience
- Docker Desktop requires WSL2 (Windows Subsystem for Linux)
- All npm scripts work natively

#### macOS (Apple Silicon / M1/M2/M3)
- Download the **Apple Silicon** version of Docker Desktop
- Enable **Rosetta for x86/amd64 emulation** in Docker settings

#### Linux
- Install Docker via your package manager or [docker.com](https://docs.docker.com/engine/install/)

### Verify Installation

```bash
node --version    # Should be 18.x or higher
npm --version     # Should be 9.x or higher
docker --version  # Optional: Should show Docker version
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Local Development Setup                       │
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
│  │ Coordinator  │  │  Execution   │  │ Cross-Chain  │          │
│  │   :3000      │  │   :3005      │  │   :3006      │          │
│  │  (Dashboard) │  │  (Engine)    │  │  (Detector)  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                  │
│  Optional:                                                       │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ P4 Solana    │  │    Redis     │  Web UI at localhost:8081  │
│  │   :3004      │  │  Commander   │  npm run dev:redis:ui      │
│  └──────────────┘  └──────────────┘                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Service Ports

| Service | Port | Environment Variable | Command |
|---------|------|---------------------|---------|
| Redis | 6379 | `REDIS_PORT` | `npm run dev:redis` |
| Coordinator (Dashboard) | 3000 | `COORDINATOR_PORT` | `npm run dev:coordinator` |
| P1 Asia-Fast Detector | 3001 | `P1_ASIA_FAST_PORT` | `npm run dev:partition:asia` |
| P2 L2-Turbo Detector | 3002 | `P2_L2_TURBO_PORT` | `npm run dev:partition:l2` |
| P3 High-Value Detector | 3003 | `P3_HIGH_VALUE_PORT` | `npm run dev:partition:high` |
| P4 Solana Detector | 3004 | `P4_SOLANA_PORT` | (optional, see below) |
| Execution Engine | 3005 | `EXECUTION_ENGINE_PORT` | `npm run dev:execution` |
| Cross-Chain Detector | 3006 | `CROSS_CHAIN_DETECTOR_PORT` | `npm run dev:cross-chain` |
| Unified Detector | 3007 | `UNIFIED_DETECTOR_PORT` | `npm run dev:detector` (deprecated) |
| Redis Commander (debug) | 8081 | - | `npm run dev:redis:ui` |

---

## Step-by-Step Setup

### Step 1: Clone and Install

```bash
# Clone the repository (if not already done)
git clone <repository-url>
cd arbitrage_new

# Install all dependencies
npm install
```

### Step 2: Configure Environment

```bash
# Copy the local development environment file
npm run dev:setup

# Or manually:
# Unix/macOS: cp .env.local .env
# Windows: copy .env.local .env
```

The `.env.local` includes:
- Free public RPC endpoints for all supported chains
- Local Redis configuration
- Sensible defaults for development

### Step 3: Start Redis

Choose one of the following options:

**Option A: Docker Redis (recommended)**
```bash
npm run dev:redis

# Verify it's running
docker ps | grep arbitrage-redis

# Optional: Start with Redis Commander UI
npm run dev:redis:ui
# Access at http://localhost:8081
```

**Option B: In-Memory Redis (no Docker required)**
```bash
npm run dev:redis:memory
```

The in-memory option uses `redis-memory-server` and is useful when:
- Docker is not installed or Docker Hub is blocked
- You want a quick, lightweight setup
- Running in CI/CD environments

### Step 4: Start Services

Open separate terminal windows for each service:

```bash
# Terminal 1: Coordinator (Dashboard)
npm run dev:coordinator

# Terminal 2: Partition Detector (choose one)
npm run dev:partition:asia    # Asia-Fast: BSC, Polygon, Avalanche, Fantom
npm run dev:partition:l2      # L2-Turbo: Arbitrum, Optimism, Base
npm run dev:partition:high    # High-Value: Ethereum, zkSync, Linea

# Terminal 3: Cross-Chain Detector
npm run dev:cross-chain

# Terminal 4 (optional): Execution Engine
npm run dev:execution
```

### Step 5: Verify Everything Works

```bash
# Check all service status
npm run dev:status

# Check health endpoints
curl http://localhost:3000/api/health  # Coordinator
curl http://localhost:3001/health      # P1 Asia-Fast
curl http://localhost:3005/health      # Execution Engine
curl http://localhost:3006/health      # Cross-Chain
```

### Step 6: Access the Dashboard

Open **http://localhost:3000** in your browser.

---

## Running Individual Services

### Coordinator (Dashboard)

```bash
npm run dev:coordinator
```

Provides:
- Web dashboard at http://localhost:3000
- Health monitoring for all services
- Real-time statistics
- Arbitrage opportunity feed

### Partition Detectors

```bash
# Asia-Fast partition (BSC, Polygon, Avalanche, Fantom)
npm run dev:partition:asia

# L2-Turbo partition (Arbitrum, Optimism, Base)
npm run dev:partition:l2

# High-Value partition (Ethereum, zkSync, Linea)
npm run dev:partition:high
```

### Cross-Chain Detector

```bash
npm run dev:cross-chain
```

Analyzes price differences across chains for cross-chain arbitrage opportunities.

### Execution Engine

```bash
# Standard mode (requires private keys)
npm run dev:execution

# Simulation mode (no real transactions)
npm run dev:execution:simulate
```

> **Warning**: The execution engine requires private keys to execute real trades. Use simulation mode for testing.

---

## Simulation Modes

The system supports two independent simulation modes for safe development:

### 1. Price Simulation Mode

Simulates blockchain data (prices, swap events) without connecting to real blockchains.

```bash
# Start with price simulation
npm run dev:simulate
```

Or set in `.env`:
```env
SIMULATION_MODE=true
SIMULATION_VOLATILITY=0.02          # 2% price volatility
SIMULATION_UPDATE_INTERVAL_MS=1000  # Update every second
```

**Benefits:**
- No real blockchain connections needed
- No RPC rate limits
- Predictable test data
- Works offline

### 2. Execution Simulation Mode

Bypasses real blockchain transactions while still consuming real (or simulated) price data.

```bash
# Start with execution simulation
npm run dev:simulate:execution
```

Or set in `.env`:
```env
EXECUTION_SIMULATION_MODE=true
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

---

## Full Partitioned Architecture

For testing the complete distributed architecture locally with all partitions.

### Option A: Separate Terminal Windows

Run each service in its own terminal window:

```bash
# Terminal 1 - Redis (required first)
npm run dev:redis

# Terminal 2 - Coordinator (Dashboard, Port 3000)
npm run dev:coordinator

# Terminal 3 - P1 Asia-Fast (Port 3001)
npm run dev:partition:asia

# Terminal 4 - P2 L2-Turbo (Port 3002)
npm run dev:partition:l2

# Terminal 5 - P3 High-Value (Port 3003)
npm run dev:partition:high

# Terminal 6 - Execution Engine (Port 3005)
npm run dev:execution

# Terminal 7 - Cross-Chain Detector (Port 3006)
npm run dev:cross-chain

# Optional: Terminal 8 - P4 Solana (Port 3004, requires Solana RPC)
# cross-env HEALTH_CHECK_PORT=3004 ts-node -r dotenv/config services/partition-solana/src/index.ts
```

### Option B: Docker Compose

Run all services in Docker containers:

```bash
# 1. Build the Docker image
npm run dev:partitions:build

# 2. Start all partitions
npm run dev:partitions:up

# 3. Check status
npm run dev:partitions:status

# 4. View logs
npm run dev:partitions:logs

# 5. Stop all
npm run dev:partitions:down
```

### Memory Requirements

The full architecture uses approximately:
- Redis: ~256MB
- Each partition: ~200-300MB
- Cross-chain detector: ~200MB
- Execution engine: ~200MB
- Coordinator: ~150MB
- **Total: ~2-3GB**

---

## Testing

### Run All Tests

```bash
npm test
```

### Run Specific Test Types

```bash
# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# End-to-end tests
npm run test:e2e

# Performance tests
npm run test:performance

# Smoke tests
npm run test:smoke

# Watch mode (re-runs on file changes)
npm run test:watch

# With coverage report
npm run test:coverage

# CI mode
npm run test:ci
```

### Test Debugging

```bash
# Run tests with debug output
npm run test:debug
```

> **Note**: Tests automatically start a Redis memory server. No manual Redis setup needed.

---

## Troubleshooting

### Redis Connection Failed

```bash
# Check if Redis is running
npm run dev:status

# For Docker Redis:
docker ps | grep arbitrage-redis
npm run dev:redis:down && npm run dev:redis

# For in-memory Redis:
npm run dev:redis:memory

# View Redis logs
npm run dev:redis:logs
```

### Docker Hub Blocked

If Docker Hub is blocked in your environment:

```bash
# Use in-memory Redis instead
npm run dev:redis:memory
```

### Port Already in Use

**macOS/Linux:**
```bash
# Find what's using the port
lsof -i :3000

# Kill the process
kill -9 <PID>
```

**Windows (PowerShell):**
```powershell
# Find what's using port 3000
netstat -ano | findstr :3000

# Kill process by PID
taskkill /PID <PID> /F
```

### TypeScript Build Errors

```bash
# Run type check to see all errors
npm run typecheck

# Clean and rebuild
npm run build:clean
```

### Services Not Connecting

1. Ensure Redis is running first
2. Check environment variables are loaded:
   ```bash
   cat .env  # Should show your config
   ```
3. Check service logs for errors

### RPC Rate Limiting

If you see rate limit warnings, this is expected with free public endpoints. The system will:
- Temporarily exclude rate-limited providers
- Select alternative providers based on health scores
- Resume using the provider after a cooldown period

Solutions:
- Enable simulation mode (`SIMULATION_MODE=true`)
- Use paid RPC providers with higher rate limits

### Windows-Specific Issues

1. **Use PowerShell** (not Git Bash for some commands)
2. **Process cleanup**: Services are stopped using `taskkill` automatically
3. **Manual cleanup** if needed:
   ```powershell
   tasklist | findstr "node"
   taskkill /F /IM node.exe   # Warning: kills all Node processes
   ```

### M1 Mac Docker Issues

If you see architecture-related errors:

```bash
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d
```

### Clear Everything and Start Fresh

```bash
# Stop all services
npm run dev:stop

# Clean build artifacts
npm run build:clean

# Remove node_modules and reinstall
# macOS/Linux:
rm -rf node_modules && npm install

# Windows PowerShell:
Remove-Item -Recurse -Force node_modules; npm install
```

---

## Commands Reference

### Setup & Configuration

| Command | Description |
|---------|-------------|
| `npm run dev:setup` | Copy .env.local to .env |

### Redis Management

| Command | Description |
|---------|-------------|
| `npm run dev:redis` | Start Redis container (Docker) |
| `npm run dev:redis:memory` | Start in-memory Redis (no Docker) |
| `npm run dev:redis:ui` | Start Redis with Commander web UI |
| `npm run dev:redis:down` | Stop Redis container |
| `npm run dev:redis:logs` | View Redis container logs |

### Service Management

| Command | Port | Description |
|---------|------|-------------|
| `npm run dev:coordinator` | 3000 | Start Coordinator (Dashboard) |
| `npm run dev:partition:asia` | 3001 | Start P1 Asia-Fast partition |
| `npm run dev:partition:l2` | 3002 | Start P2 L2-Turbo partition |
| `npm run dev:partition:high` | 3003 | Start P3 High-Value partition |
| (manual) | 3004 | P4 Solana partition (requires Solana RPC setup) |
| `npm run dev:execution` | 3005 | Start Execution Engine |
| `npm run dev:execution:simulate` | 3005 | Start Execution Engine (simulation) |
| `npm run dev:cross-chain` | 3006 | Start Cross-Chain Detector |
| `npm run dev:detector` | 3007 | Start Unified Detector (deprecated) |
| `npm run dev:start` | - | Start all services |
| `npm run dev:stop` | - | Stop all services |
| `npm run dev:status` | - | Check status of all services |
| `npm run dev:cleanup` | - | Clean up stale services |

### Simulation Modes

| Command | Description |
|---------|-------------|
| `npm run dev:simulate` | Start with price simulation |
| `npm run dev:simulate:execution` | Start with execution simulation |
| `npm run dev:simulate:full` | Start with both simulations |

### Docker Partitions

| Command | Description |
|---------|-------------|
| `npm run dev:partitions:build` | Build Docker image for all services |
| `npm run dev:partitions:up` | Start all partition containers |
| `npm run dev:partitions:down` | Stop all partition containers |
| `npm run dev:partitions:logs` | Follow logs from all containers |
| `npm run dev:partitions:status` | Show status of all containers |
| `npm run dev:partitions:restart` | Restart all containers |

### Building & Testing

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript |
| `npm run build:clean` | Clean and rebuild |
| `npm run typecheck` | Type check without building |
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests |
| `npm run test:integration` | Run integration tests |
| `npm run test:e2e` | Run end-to-end tests |
| `npm run test:watch` | Watch mode tests |
| `npm run test:coverage` | Tests with coverage report |

---

## Environment Variables

Key environment variables in `.env.local`:

```env
# Node Environment
NODE_ENV=development
LOG_LEVEL=info

# Redis
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379

# Service Ports (see shared/constants/service-ports.json)
COORDINATOR_PORT=3000
P1_ASIA_FAST_PORT=3001
P2_L2_TURBO_PORT=3002
P3_HIGH_VALUE_PORT=3003
P4_SOLANA_PORT=3004
EXECUTION_ENGINE_PORT=3005
CROSS_CHAIN_DETECTOR_PORT=3006
UNIFIED_DETECTOR_PORT=3007

# Partition Configuration
PARTITION_ID=asia-fast
INSTANCE_ID=local-dev-1
REGION_ID=local

# Price Simulation
SIMULATION_MODE=false
SIMULATION_VOLATILITY=0.02
SIMULATION_UPDATE_INTERVAL_MS=1000

# Execution Simulation
EXECUTION_SIMULATION_MODE=false
EXECUTION_SIMULATION_SUCCESS_RATE=0.85
EXECUTION_SIMULATION_LATENCY_MS=500

# Arbitrage Configuration
MIN_PROFIT_PERCENTAGE=0.003
CONFIDENCE_THRESHOLD=0.75
MAX_GAS_PRICE_GWEI=50

# Circuit Breaker
CIRCUIT_BREAKER_ENABLED=true
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5

# MEV Protection (disabled by default)
MEV_PROTECTION_ENABLED=false
```

---

## Data Flow

1. **Detection**: Partition detectors monitor blockchain events and detect arbitrage opportunities
2. **Publishing**: Opportunities are published to `stream:opportunities` via Redis Streams
3. **Coordination**: Coordinator consumes and tracks opportunities for the dashboard
4. **Execution**: Execution Engine consumes opportunities and executes (or simulates) trades

Both Coordinator and Execution Engine consume from the same stream using different consumer groups, ensuring both receive all messages.

---

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

---

## Related Documentation

- [Deployment Guide](./deployment.md) - Cloud deployment instructions
- [Architecture Overview](./architecture/ARCHITECTURE_V2.md) - System design
- [ADR-002: Redis Streams](./architecture/adr/ADR-002-redis-streams.md) - Event streaming design
- [Test Architecture](./TEST_ARCHITECTURE.md) - Testing patterns
