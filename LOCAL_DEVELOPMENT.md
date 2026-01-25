# Local Development Guide

> **Note**: This documentation has been moved to [docs/local-development.md](docs/local-development.md).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file
npm run dev:setup

# 3. Start Redis
npm run dev:redis          # Docker
npm run dev:redis:memory   # In-memory (no Docker)

# 4. Start services (in separate terminals)
npm run dev:coordinator      # Dashboard at http://localhost:3000
npm run dev:partition:asia   # Detector (port 3001)
npm run dev:execution        # Execution engine (port 3005)
npm run dev:cross-chain      # Cross-chain detector (port 3006)
```

For complete documentation including:
- Prerequisites and platform-specific setup
- Architecture overview and service ports
- Simulation modes (price and execution)
- Full partitioned architecture setup
- Troubleshooting guide
- Complete commands reference

See **[docs/local-development.md](docs/local-development.md)**.
