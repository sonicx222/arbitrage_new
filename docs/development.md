# Developer Guide & Roadmap

This document captures the implementation history, current technical debt, and future roadmap for the project.

> **Looking for local development setup?** See the [Local Development Guide](./local-development.md) for instructions on running the system locally with simulation modes.

## 🔄 Refactoring History

The project underwent a major architectural overhaul in January 2026, moving from a monolithic structure to a Domain-Driven Design (DDD) microservices approach.

### Key Refactorings
- **BaseDetector Extraction**: Consolidated ~60% of duplicated code across chain detectors.
- **WebSocket Centralization**: Created a robust `WebSocketManager` with automatic reconnection and heartbeats.
- **Repository Pattern**: Abstracted Redis interactions to allow for easier data management and testing.
- **Dependency Injection**: Improved testability by injecting components into services rather than hardcoding them.

---

## 🗺️ Implementation Roadmap

### Phase 1: Foundation (COMPLETED)
- [x] Monorepo workspace setup.
- [x] Base microservices implementation (BSC, ETH).
- [x] Core performance utilities (Redis, Logger).

### Phase 2: Advanced Performance (COMPLETED)
- [x] WebAssembly arbitrage engine integration.
- [x] Matrix-based caching implementation.
- [x] Predictive cache warming.

### Phase 3: AI/ML & Enterprise Features (IN PROGRESS)
- [/] LSTM Model fine-tuning with real market data.
- [ ] Integration of hardware security modules (HSM) for key management.
- [ ] Chaos engineering tests for multi-region failover.

---

## 🔧 Technical Notes

### Package Fixes
Historically, several npm package conflicts were resolved:
- `ethers` v6 migration fixes.
- `web3-providers-ws` race condition patches.
- `truffle-hdwallet-provider` replacement with native `ethers` signers for better performance.

### Coding Standards
- **Strict Types**: Absolutely no `any` types in core logic. Use interfaces from `@arbitrage/types`.
- **Async Pattern**: All initialization must follow the `ensureInitialized` pattern.
- **Error Handling**: Use the `DomainErrors` factory for consistent alerting and logging.

---

## 📋 Technical Debt

1. **Test Coverage**: Currently at ~16%. Target is 80%+.
2. **API Auth**: REST endpoints currently lack robust authentication.
3. **N+1 Queries**: Some historical data retrieval patterns in the Coordinator need optimization.
4. **Memory Management**: Explicit disposal of `SharedArrayBuffer` in worker pools needs better lifecycle management.
