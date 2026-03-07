# shared/constants

Static JSON configuration files consumed by build scripts and services. Not an npm package -- files are imported directly via relative paths.

## Files

| File | Purpose | Consumers |
|------|---------|-----------|
| `service-ports.json` | Single source of truth for all service ports (3000-3008, 3009, 3100) | partition-router.ts, services-config.js, Dockerfiles |
| `deprecation-patterns.json` | Deprecation warnings for old service names and env vars | deprecation-checker.js |

## Port Assignments

| Port | Service |
|------|---------|
| 3000 | Coordinator |
| 3001 | Partition Asia-Fast (P1) |
| 3002 | Partition L2-Turbo (P2) |
| 3003 | Partition High-Value (P3) |
| 3004 | Partition Solana (P4) |
| 3005 | Execution Engine |
| 3006 | Cross-Chain Detector |
| 3008 | Mempool Detector (optional) |
| 3009 | Coordinator Worker (monolith mode) |
| 3100 | Monolith Health |

## Consistency Testing

`config-consistency.test.ts` validates that all importers of these files stay in sync with the JSON definitions.
