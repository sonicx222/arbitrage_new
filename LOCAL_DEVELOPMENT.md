# Local Development Guide

This guide will help you run the arbitrage system locally on **Windows**, **macOS** (Intel & Apple Silicon), or **Linux**.

> **Platform Compatibility**: All commands work cross-platform. Tested on Windows 10/11, macOS (Intel & Apple Silicon), and Ubuntu Linux.

## Table of Contents

1. [Quick Start (5 minutes)](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Architecture Overview](#architecture-overview)
4. [Step-by-Step Setup](#step-by-step-setup)
5. [Running Individual Components](#running-individual-components)
6. [Simulation Mode](#simulation-mode)
7. [Testing](#testing)
8. [Troubleshooting](#troubleshooting)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file (creates .env from .env.local)
npm run dev:setup

# 3. Start Redis (requires Docker)
npm run dev:redis

# 4. Check status
npm run dev:status

# 5. Start services (in separate terminals)
npm run dev:coordinator      # Terminal 1: Dashboard at http://localhost:3000
npm run dev:detector         # Terminal 2: Price detection
npm run dev:cross-chain      # Terminal 3: Cross-chain arbitrage
```

That's it! Visit **http://localhost:3000** to see the coordinator dashboard.

> **Note**: The build step (`npm run build`) is optional for development. The dev scripts use ts-node to run TypeScript directly.

---

## Prerequisites

### Required Software

| Software | Version | Installation |
|----------|---------|--------------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org) (download LTS version) |
| Docker Desktop | Latest | [docker.com/products/docker-desktop](https://docker.com/products/docker-desktop) |
| npm | 9+ | Comes with Node.js |

### Platform-Specific Notes

#### Windows
- Use PowerShell or Windows Terminal (not cmd.exe) for best experience
- Docker Desktop for Windows requires WSL2 (Windows Subsystem for Linux)
- All npm scripts work natively, no additional setup needed

#### macOS (Apple Silicon / M1/M2/M3)
- Download the **Apple Silicon** version of Docker Desktop
- Enable **Rosetta for x86/amd64 emulation** in Docker settings (for compatibility)

### Verify Installation

```bash
node --version    # Should be 18.x or higher
npm --version     # Should be 9.x or higher
docker --version  # Should show Docker version
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Local Development Setup                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Coordinator │    │   Unified    │    │ Cross-Chain  │      │
│  │   (Port 3000)│    │  Detector    │    │  Detector    │      │
│  │   Dashboard  │    │  (Port 3001) │    │  (Port 3002) │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │               │
│         └───────────────────┼───────────────────┘               │
│                             │                                    │
│                     ┌───────▼───────┐                           │
│                     │     Redis     │                           │
│                     │  (Port 6379)  │                           │
│                     │   (Docker)    │                           │
│                     └───────────────┘                           │
│                                                                  │
│  Optional:                                                       │
│  ┌──────────────┐                                               │
│  │    Redis     │  Web UI at http://localhost:8081              │
│  │  Commander   │  Start with: npm run dev:redis:ui             │
│  └──────────────┘                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose | Port | Command |
|-----------|---------|------|---------|
| **Redis** | Message broker & cache | 6379 | `npm run dev:redis` |
| **Coordinator** | Dashboard & orchestration | 3000 | `npm run dev:coordinator` |
| **Unified Detector** | Multi-chain price detection | 3001 | `npm run dev:detector` |
| **Cross-Chain Detector** | Cross-chain arbitrage | 3002 | `npm run dev:cross-chain` |
| **Execution Engine** | Trade execution (optional) | 3003 | `npm run dev:execution` |

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
cp .env.local .env
```

The default `.env.local` includes:
- Free public RPC endpoints for all supported chains
- Local Redis configuration
- Sensible defaults for development

### Step 3: Start Redis

```bash
# Start Redis container
npm run dev:redis

# Verify it's running
docker ps
# Should show: arbitrage-redis

# Optional: Start Redis Commander (web UI for debugging)
npm run dev:redis:ui
# Access at http://localhost:8081
```

### Step 4: Build the Project

```bash
# Build all TypeScript
npm run build

# Or build with clean (removes old dist)
npm run build:clean
```

### Step 5: Start Services

**Option A: Start All Services (Recommended)**

Open 3 terminal windows:

```bash
# Terminal 1: Coordinator
npm run dev:coordinator

# Terminal 2: Unified Detector
npm run dev:detector

# Terminal 3: Cross-Chain Detector
npm run dev:cross-chain
```

**Option B: Use Specific Partition**

```bash
# Start Asia-Fast partition (BSC, Polygon, Avalanche, Fantom)
npm run dev:partition:asia

# Start L2-Turbo partition (Arbitrum, Optimism, Base)
npm run dev:partition:l2

# Start High-Value partition (Ethereum, zkSync, Linea)
npm run dev:partition:high
```

### Step 6: Verify Everything Works

```bash
# Check service status
npm run dev:status

# Check health endpoints
curl http://localhost:3000/api/health  # Coordinator
curl http://localhost:3001/health      # Detector
curl http://localhost:3002/health      # Cross-Chain
```

### Step 7: Access the Dashboard

Open **http://localhost:3000** in your browser.

---

## Running Individual Components

### Coordinator (Dashboard)

```bash
npm run dev:coordinator
```

The coordinator provides:
- Web dashboard at http://localhost:3000
- Health monitoring for all services
- Real-time statistics
- Arbitrage opportunity feed

### Unified Detector

```bash
# Default partition (asia-fast)
npm run dev:detector

# With specific partition
PARTITION_ID=l2-turbo npm run dev:detector

# With specific chains only
PARTITION_CHAINS=bsc,polygon npm run dev:detector
```

Environment variables:
- `PARTITION_ID`: `asia-fast`, `l2-turbo`, `high-value`, `solana-native`
- `PARTITION_CHAINS`: Comma-separated chain IDs (overrides partition default)
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error`

### Cross-Chain Detector

```bash
npm run dev:cross-chain
```

Analyzes price differences across chains for cross-chain arbitrage opportunities.

### Execution Engine (Requires Private Keys)

```bash
# Add private keys to .env first!
npm run dev:execution
```

**Warning**: The execution engine requires real private keys to work. For testing without executing real trades, use simulation mode.

---

## Simulation Mode

Simulation mode generates fake price data for testing without connecting to real blockchains.

### Start in Simulation Mode

```bash
# All services with simulated data
SIMULATION_MODE=true npm run dev:detector
```

Or add to your `.env`:
```bash
SIMULATION_MODE=true
SIMULATION_VOLATILITY=0.02        # 2% price volatility
SIMULATION_UPDATE_INTERVAL_MS=1000 # Update every second
```

### Benefits of Simulation Mode

- No real blockchain connections needed
- No RPC rate limits
- Predictable test data
- Fast iteration
- Works offline

### Configure Simulation

Edit `.env`:
```bash
# Simulation settings
SIMULATION_MODE=true
SIMULATION_VOLATILITY=0.02          # Base volatility per update
SIMULATION_UPDATE_INTERVAL_MS=1000  # Ms between updates
```

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

# Performance tests
npm run test:performance

# Watch mode (re-runs on file changes)
npm run test:watch

# With coverage report
npm run test:coverage
```

### Test with Real Redis

Tests automatically start a Redis memory server. No manual Redis setup needed for testing.

---

## Troubleshooting

### Redis Connection Failed

```bash
# Check if Redis is running
docker ps | grep arbitrage-redis

# Start Redis if not running
npm run dev:redis

# Check Redis logs
npm run dev:redis:logs
```

### Port Already in Use

**macOS/Linux:**
```bash
# Find what's using the port (e.g., 3000)
lsof -i :3000

# Kill the process
kill -9 <PID>
```

**Windows (PowerShell):**
```powershell
# Find what's using port 3000
netstat -ano | findstr :3000

# Kill process by PID (replace 12345 with actual PID)
taskkill /PID 12345 /F
```

### TypeScript Build Errors

```bash
# Clean and rebuild
npm run build:clean

# Check for type errors without building
npm run typecheck
```

### Services Not Connecting

1. Ensure Redis is running first
2. Check environment variables are loaded:
   ```bash
   cat .env  # Should show your config
   ```
3. Check service logs for errors

### M1 Mac Docker Issues

If you see architecture-related errors:

```bash
# Ensure Docker is using the correct platform
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d
```

### Clear Everything and Start Fresh

```bash
# Stop all services
npm run dev:stop

# Stop and remove Docker containers
npm run dev:redis:down

# Remove node_modules and reinstall (macOS/Linux)
rm -rf node_modules
npm install

# Remove node_modules and reinstall (Windows PowerShell)
# Remove-Item -Recurse -Force node_modules
# npm install

# Rebuild
npm run build:clean
```

---

## Common Commands Reference

| Command | Description |
|---------|-------------|
| `npm run dev:setup` | Copy .env.local to .env |
| `npm run dev:redis` | Start Redis container |
| `npm run dev:redis:ui` | Start Redis with web UI |
| `npm run dev:redis:down` | Stop Redis container |
| `npm run dev:redis:logs` | View Redis logs |
| `npm run dev:coordinator` | Start coordinator |
| `npm run dev:detector` | Start unified detector |
| `npm run dev:cross-chain` | Start cross-chain detector |
| `npm run dev:execution` | Start execution engine |
| `npm run dev:status` | Check all service status |
| `npm run dev:stop` | Stop all node services |
| `npm run build` | Build TypeScript |
| `npm run build:clean` | Clean build |
| `npm test` | Run all tests |
| `npm run test:watch` | Watch mode tests |

---

## Full Partitioned Architecture (Production-Like)

For testing the complete distributed architecture locally with all partitions.

### Option A: Separate Terminal Windows (Recommended for Development)

Run each service in its own terminal window, just like production:

```bash
# Terminal 1 - Redis (required first)
npm run dev:redis

# Terminal 2 - Coordinator (Dashboard)
npm run dev:coordinator

# Terminal 3 - P1 Asia-Fast (Port 3001)
npm run dev:partition:asia

# Terminal 4 - P2 L2-Turbo (Port 3002)
npm run dev:partition:l2

# Terminal 5 - P3 High-Value (Port 3003)
npm run dev:partition:high

# Terminal 6 - Cross-Chain Detector (Port 3004)
npm run dev:cross-chain

# Terminal 7 - Execution Engine (Port 3005)
npm run dev:execution
```

Check status of all services:
```bash
npm run dev:status
```

### Option B: Docker Compose (All-in-One)

Run all services in Docker containers with a single command:

```bash
# 1. Setup environment
npm run dev:setup

# 2. Build the Docker image (first time only)
npm run dev:partitions:build

# 3. Start all partitions
npm run dev:partitions:up

# 4. Check status
npm run dev:partitions:status

# 5. View logs
npm run dev:partitions:logs

# 6. Stop all
npm run dev:partitions:down
```

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Full Partitioned Architecture (Local)                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         Coordinator (Port 3000)                       │   │
│  │                    Dashboard & Service Orchestration                  │   │
│  └────────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                          │
│         ┌─────────────────────────┼─────────────────────────┐               │
│         │                         │                         │               │
│  ┌──────▼──────┐   ┌──────────────▼──────────────┐   ┌──────▼──────┐       │
│  │ P1 Asia-Fast│   │      P2 L2-Turbo           │   │ P3 High-Val │       │
│  │  Port 3001  │   │       Port 3002            │   │  Port 3003  │       │
│  │ BSC,Polygon │   │  Arbitrum,Optimism,Base    │   │ ETH,zkSync  │       │
│  │ Avax,Fantom │   │                            │   │   Linea     │       │
│  └──────┬──────┘   └──────────────┬─────────────┘   └──────┬──────┘       │
│         │                         │                         │               │
│         └─────────────────────────┼─────────────────────────┘               │
│                                   │                                          │
│                          ┌────────▼────────┐                                │
│                          │  Cross-Chain    │                                │
│                          │   Port 3004     │                                │
│                          │   Detector      │                                │
│                          └────────┬────────┘                                │
│                                   │                                          │
│                          ┌────────▼────────┐                                │
│                          │   Execution     │                                │
│                          │   Port 3005     │                                │
│                          │    Engine       │                                │
│                          └────────┬────────┘                                │
│                                   │                                          │
│                          ┌────────▼────────┐                                │
│                          │     Redis       │                                │
│                          │   Port 6379     │                                │
│                          └─────────────────┘                                │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Commands Reference

**Terminal Mode (Option A):**

| Command | Port | Description |
|---------|------|-------------|
| `npm run dev:redis` | 6379 | Start Redis container |
| `npm run dev:coordinator` | 3000 | Start Coordinator (Dashboard) |
| `npm run dev:partition:asia` | 3001 | Start P1 Asia-Fast partition |
| `npm run dev:partition:l2` | 3002 | Start P2 L2-Turbo partition |
| `npm run dev:partition:high` | 3003 | Start P3 High-Value partition |
| `npm run dev:cross-chain` | 3004 | Start Cross-Chain Detector |
| `npm run dev:execution` | 3005 | Start Execution Engine |
| `npm run dev:status` | - | Check status of all services |

**Docker Mode (Option B):**

| Command | Description |
|---------|-------------|
| `npm run dev:partitions:build` | Build Docker image for all services |
| `npm run dev:partitions:up` | Start all partition containers |
| `npm run dev:partitions:down` | Stop all partition containers |
| `npm run dev:partitions:logs` | Follow logs from all containers |
| `npm run dev:partitions:status` | Show status of all containers |
| `npm run dev:partitions:restart` | Restart all containers |

### Service Endpoints

| Service | Port | Health Endpoint |
|---------|------|-----------------|
| Coordinator (Dashboard) | 3000 | http://localhost:3000/api/health |
| P1 Asia-Fast | 3001 | http://localhost:3001/health |
| P2 L2-Turbo | 3002 | http://localhost:3002/health |
| P3 High-Value | 3003 | http://localhost:3003/health |
| Cross-Chain Detector | 3004 | http://localhost:3004/health |
| Execution Engine | 3005 | http://localhost:3005/health |
| Redis | 6379 | - |
| Redis Commander (debug) | 8081 | http://localhost:8081 |

### Memory Requirements

The full partitioned architecture uses approximately:
- Redis: ~256MB
- Each partition: ~200-300MB
- Cross-chain detector: ~200MB
- Execution engine: ~200MB
- Coordinator: ~150MB
- **Total: ~2-3GB** (well within 32GB M1 Mac)

---

## Next Steps

1. **Explore the Dashboard**: http://localhost:3000
2. **Read the Architecture**: `docs/architecture/ARCHITECTURE_V2.md`
3. **Check ADRs**: `docs/architecture/adr/` for design decisions
4. **Run Tests**: `npm test` to see the test suite in action

---

## Need Help?

- Check the [docs/](docs/) folder for detailed documentation
- Review [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for project roadmap
- See [docs/deployment.md](docs/deployment.md) for production deployment
