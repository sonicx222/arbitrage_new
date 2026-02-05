# Local Development Guide

This guide covers setting up and running the arbitrage system locally for development and testing on **Windows**, **macOS** (Intel & Apple Silicon), or **Linux**.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Architecture Overview](#architecture-overview)
4. [Step-by-Step Setup](#step-by-step-setup)
5. [Running Services](#running-services)
6. [Hot Reload Development](#hot-reload-development)
7. [VSCode Integration](#vscode-integration)
8. [Simulation Modes](#simulation-modes)
9. [Testing](#testing)
10. [Building](#building)
11. [Troubleshooting](#troubleshooting)
12. [Commands Reference](#commands-reference)

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

# 4. Start all services with hot reload (RECOMMENDED)
npm run dev:all

# OR start minimal setup (Coordinator + P1 + Execution)
npm run dev:minimal
```

Visit **http://localhost:3000** to see the coordinator dashboard.

### Alternative: Individual Services

```bash
# Start services in separate terminals
npm run dev:coordinator:fast   # Terminal 1: Dashboard (port 3000)
npm run dev:partition:asia:fast # Terminal 2: Asia-Fast detector (port 3001)
npm run dev:execution:fast     # Terminal 3: Execution engine (port 3005)
```

> **New in v1.2**: Use `:fast` suffix for ~50x faster startup with hot reload!

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
│              │  stream:execution-requests  │                    │
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
| Coordinator (Dashboard) | 3000 | `COORDINATOR_PORT` | `npm run dev:coordinator:fast` |
| P1 Asia-Fast Detector | 3001 | `P1_ASIA_FAST_PORT` | `npm run dev:partition:asia:fast` |
| P2 L2-Turbo Detector | 3002 | `P2_L2_TURBO_PORT` | `npm run dev:partition:l2:fast` |
| P3 High-Value Detector | 3003 | `P3_HIGH_VALUE_PORT` | `npm run dev:partition:high:fast` |
| P4 Solana Detector | 3004 | `P4_SOLANA_PORT` | (optional, see below) |
| Execution Engine | 3005 | `EXECUTION_ENGINE_PORT` | `npm run dev:execution:fast` |
| Cross-Chain Detector | 3006 | `CROSS_CHAIN_DETECTOR_PORT` | `npm run dev:cross-chain:fast` |
| Unified Detector | 3007 | `UNIFIED_DETECTOR_PORT` | `npm run dev:detector:fast` (deprecated) |
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

**Option A: All Services with Hot Reload (Recommended)**
```bash
npm run dev:all
```
This starts all 6 core services with color-coded output and hot reload.

**Option B: Minimal Setup**
```bash
npm run dev:minimal
```
Starts only Coordinator + P1 Asia-Fast + Execution Engine.

**Option C: Individual Services**
```bash
# Terminal 1: Coordinator (Dashboard)
npm run dev:coordinator:fast

# Terminal 2: Partition Detector
npm run dev:partition:asia:fast

# Terminal 3: Execution Engine
npm run dev:execution:fast
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

## Running Services

### Standard Mode (ts-node)

Uses `ts-node` for TypeScript execution. Slower startup but compatible with all environments.

```bash
npm run dev:coordinator      # Coordinator
npm run dev:partition:asia   # P1 Asia-Fast
npm run dev:partition:l2     # P2 L2-Turbo
npm run dev:partition:high   # P3 High-Value
npm run dev:cross-chain      # Cross-Chain Detector
npm run dev:execution        # Execution Engine
```

### Fast Mode with Hot Reload (tsx) - RECOMMENDED

Uses `tsx` (esbuild-based) for ~50x faster startup with automatic hot reload on file changes.

```bash
npm run dev:coordinator:fast      # Coordinator with hot reload
npm run dev:partition:asia:fast   # P1 with hot reload
npm run dev:partition:l2:fast     # P2 with hot reload
npm run dev:partition:high:fast   # P3 with hot reload
npm run dev:cross-chain:fast      # Cross-Chain with hot reload
npm run dev:execution:fast        # Execution with hot reload
```

### Unified Commands

| Command | Description |
|---------|-------------|
| `npm run dev:all` | Start all 6 services with hot reload (color-coded) |
| `npm run dev:minimal` | Start Coordinator + P1 + Execution only |

---

## Hot Reload Development

The system uses `tsx` for hot reload development, providing:
- **~50x faster startup** compared to ts-node
- **Automatic restart** on file changes
- **Watch mode** built-in

### How to Use

1. Start a service with the `:fast` suffix:
   ```bash
   npm run dev:coordinator:fast
   ```

2. Edit any TypeScript file in the service

3. The service automatically restarts with your changes

### Comparison

| Aspect | ts-node (`dev:coordinator`) | tsx (`dev:coordinator:fast`) |
|--------|----------------------------|------------------------------|
| Startup Time | ~5 seconds | <1 second |
| Hot Reload | No | Yes |
| Type Checking | At runtime | Via IDE only |
| Use Case | CI/Production-like | Development |

> **Note**: tsx doesn't type-check during compilation. Use `npm run typecheck:watch` in a separate terminal for continuous type checking.

---

## VSCode Integration

The project includes VSCode workspace configuration for optimal development experience.

### Recommended Extensions

Open the project in VSCode and install recommended extensions when prompted, or run:
```
Ctrl+Shift+P → Extensions: Show Recommended Extensions
```

Key extensions:
- **ESLint** - Code linting
- **Prettier** - Code formatting
- **vscode-jest** - Test integration
- **GitLens** - Git history
- **Error Lens** - Inline error display

### Debug Configurations

Press **F5** to see available debug configurations:

| Configuration | Description |
|---------------|-------------|
| Debug Coordinator | Debug the coordinator service |
| Debug P1 Asia-Fast | Debug the P1 partition detector |
| Debug P2 L2-Turbo | Debug the P2 partition detector |
| Debug P3 High-Value | Debug the P3 partition detector |
| Debug Execution Engine | Debug the execution engine |
| Debug Cross-Chain Detector | Debug the cross-chain detector |
| Debug Current Test File | Debug the currently open test file |
| Debug Test (by pattern) | Debug tests matching a pattern |
| Debug All Services | Compound: Start multiple services |

### Tasks

Press `Ctrl+Shift+B` (or `Cmd+Shift+B` on Mac) to see build tasks:

| Task | Description |
|------|-------------|
| Build | Full TypeScript build |
| Build (Watch) | Continuous build on changes |
| Typecheck | Type check without building |
| Typecheck (Watch) | Continuous type checking |
| Test | Run all tests |
| Test (Changed Files) | Run tests for changed files only |
| Lint | Run ESLint |
| Dev: All Services | Start all services with hot reload |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F5` | Start debugging |
| `Ctrl+Shift+B` | Run build task |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+`` ` | Open terminal |

---

## Simulation Modes

The system supports two independent simulation modes for safe development:

### 1. Price Simulation Mode

Simulates blockchain data (prices, swap events) without connecting to real blockchains.

```bash
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
npm run dev:simulate:execution
```

Or set in `.env`:
```env
EXECUTION_SIMULATION_MODE=true
EXECUTION_SIMULATION_SUCCESS_RATE=0.85      # 85% success rate
EXECUTION_SIMULATION_LATENCY_MS=500         # 500ms simulated latency
```

### 3. Full Simulation Mode

Combine both modes to test the complete system without any blockchain interaction:

```bash
npm run dev:simulate:full
```

---

## Testing

### Run All Tests

```bash
npm test
```

### Run Specific Test Types

```bash
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests
npm run test:e2e           # End-to-end tests
npm run test:performance   # Performance tests
npm run test:smoke         # Smoke tests
```

### Selective Testing (Fast Feedback)

```bash
# Run tests only for files changed since last commit
npm run test:changed

# Run tests related to specific files
npm run test:related shared/core/src/redis.ts

# Watch mode (re-runs on file changes)
npm run test:watch
```

### Test Coverage

```bash
npm run test:coverage
```

### Debugging Tests

**Via CLI:**
```bash
npm run test:debug
```

**Via VSCode:**
1. Open a test file
2. Press F5
3. Select "Debug Current Test File"

> **Note**: Tests automatically start a Redis memory server. No manual Redis setup needed.

---

## Building

### Standard Build

```bash
npm run build
```

### Incremental Build (Watch Mode)

For faster rebuilds during development:

```bash
npm run build:watch
```

### Type Checking

```bash
# One-time check
npm run typecheck

# Continuous checking (recommended during development)
npm run typecheck:watch
```

### Clean Build

```bash
npm run build:clean
```

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

### Hot Reload Not Working

If hot reload isn't triggering on file changes:

1. Ensure you're using `:fast` commands
2. Check that tsx is installed: `npx tsx --version`
3. Try restarting the service

### Clear Everything and Start Fresh

```bash
# Stop all services
npm run dev:stop

# Clean build artifacts
npm run build:clean

# Remove node_modules and reinstall
rm -rf node_modules && npm install  # Unix/macOS
Remove-Item -Recurse -Force node_modules; npm install  # Windows PowerShell
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

### Service Management (Hot Reload - RECOMMENDED)

| Command | Port | Description |
|---------|------|-------------|
| `npm run dev:all` | All | Start all 6 services with hot reload |
| `npm run dev:minimal` | 3000,3001,3005 | Start Coordinator + P1 + Execution |
| `npm run dev:coordinator:fast` | 3000 | Coordinator with hot reload |
| `npm run dev:partition:asia:fast` | 3001 | P1 Asia-Fast with hot reload |
| `npm run dev:partition:l2:fast` | 3002 | P2 L2-Turbo with hot reload |
| `npm run dev:partition:high:fast` | 3003 | P3 High-Value with hot reload |
| `npm run dev:cross-chain:fast` | 3006 | Cross-Chain with hot reload |
| `npm run dev:execution:fast` | 3005 | Execution Engine with hot reload |
| `npm run dev:detector:fast` | 3007 | Unified Detector with hot reload (deprecated) |

### Service Management (Standard)

| Command | Port | Description |
|---------|------|-------------|
| `npm run dev:coordinator` | 3000 | Coordinator (ts-node) |
| `npm run dev:partition:asia` | 3001 | P1 Asia-Fast (ts-node) |
| `npm run dev:partition:l2` | 3002 | P2 L2-Turbo (ts-node) |
| `npm run dev:partition:high` | 3003 | P3 High-Value (ts-node) |
| `npm run dev:cross-chain` | 3006 | Cross-Chain Detector (ts-node) |
| `npm run dev:execution` | 3005 | Execution Engine (ts-node) |
| `npm run dev:start` | - | Start all services (legacy) |
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

### Building

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript |
| `npm run build:watch` | Continuous build (incremental) |
| `npm run build:clean` | Clean and rebuild |
| `npm run typecheck` | Type check without building |
| `npm run typecheck:watch` | Continuous type checking |

### Testing

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests |
| `npm run test:integration` | Run integration tests |
| `npm run test:e2e` | Run end-to-end tests |
| `npm run test:changed` | Run tests for changed files only |
| `npm run test:related <file>` | Run tests related to specific files |
| `npm run test:watch` | Watch mode tests |
| `npm run test:coverage` | Tests with coverage report |
| `npm run test:debug` | Run tests with debug output |

### Code Quality

| Command | Description |
|---------|-------------|
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Fix ESLint errors |
| `npm run validate` | Run tests + lint |

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

## Memory Requirements

The full architecture uses approximately:
- Redis: ~256MB
- Each partition: ~200-300MB
- Cross-chain detector: ~200MB
- Execution engine: ~200MB
- Coordinator: ~150MB
- **Total: ~2-3GB**

---

## Related Documentation

- [Deployment Guide](./deployment.md) - Cloud deployment instructions
- [Architecture Overview](./architecture/ARCHITECTURE_V2.md) - System design
- [ADR-002: Redis Streams](./architecture/adr/ADR-002-redis-streams.md) - Event streaming design
- [Test Architecture](./architecture/TEST_ARCHITECTURE.md) - Testing patterns
- [Manual Test Steps](./MANUAL_TESTSTEPS.md) - Manual testing procedures
