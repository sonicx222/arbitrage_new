# Architecture Decision Records (ADRs)

This directory contains the Architecture Decision Records for the Professional Multi-Chain Arbitrage System.

## What is an ADR?

An Architecture Decision Record captures an important architectural decision made along with its context and consequences. ADRs help:
- Document why decisions were made
- Onboard new team members
- Revisit decisions when context changes
- Track the evolution of the architecture

## ADR Index

| ADR | Title | Status | Date | Confidence |
|-----|-------|--------|------|------------|
| [ADR-001](./ADR-001-hybrid-architecture.md) | Hybrid Microservices + Event-Driven Architecture | Accepted | 2025-01-10 | 92% |
| [ADR-002](./ADR-002-redis-streams.md) | Redis Streams over Pub/Sub | Accepted | 2025-01-10 | 88% |
| [ADR-003](./ADR-003-partitioned-detectors.md) | Partitioned Chain Detectors | Accepted | 2025-01-10 | 90% |
| [ADR-004](./ADR-004-swap-event-filtering.md) | Smart Swap Event Filtering | Accepted | 2025-01-10 | 88% |
| [ADR-005](./ADR-005-hierarchical-cache.md) | Hierarchical Caching Strategy | Accepted | 2025-01-10 | 85% |
| [ADR-006](./ADR-006-free-hosting.md) | Free Hosting Provider Selection | Accepted | 2025-01-10 | 95% |
| [ADR-007](./ADR-007-failover-strategy.md) | Cross-Region Failover Strategy | Accepted | 2025-01-10 | 90% |
| [ADR-008](./ADR-008-chain-dex-token-selection.md) | Chain/DEX/Token Selection Strategy | Accepted | 2025-01-10 | 92% |
| [ADR-009](./ADR-009-test-architecture.md) | Test Architecture | Accepted | 2025-01-12 | 90% |
| [ADR-010](./ADR-010-websocket-resilience.md) | WebSocket Connection Resilience | Accepted | 2026-01-15 | 95% |
| [ADR-011](./ADR-011-tier1-optimizations.md) | Tier 1 Performance Optimizations | Accepted | 2026-01-15 | 95% |
| [ADR-012](./ADR-012-worker-thread-path-finding.md) | Worker Thread Multi-Leg Path Finding | Accepted | 2026-01-16 | 90% |
| [ADR-013](./ADR-013-dynamic-gas-pricing.md) | Dynamic Gas Price Cache | Accepted | 2026-01-16 | 92% |
| [ADR-014](./ADR-014-modular-detector-components.md) | Modular Detector Components | Accepted | 2026-01-18 | 92% |
| [ADR-015](./ADR-015-pino-logger-migration.md) | Pino Logger Migration with DI Pattern | Accepted | 2026-01-19 | 92% |
| [ADR-016](./ADR-016-transaction-simulation.md) | Transaction Simulation Integration | Accepted | 2026-01-22 | 92% |
| [ADR-017](./ADR-017-mev-protection.md) | MEV Protection Enhancement | Accepted | 2026-01-23 | 90% |
| [ADR-018](./ADR-018-circuit-breaker.md) | Execution Circuit Breaker | Accepted | 2026-01-23 | 95% |
| [ADR-019](./ADR-019-factory-subscriptions.md) | Factory-Level Event Subscriptions | Accepted | 2026-01-23 | 92% |
| [ADR-020](./ADR-020-flash-loan.md) | Flash Loan Integration | Accepted | 2026-01-24 | 85% |
| [ADR-021](./ADR-021-capital-risk-management.md) | Capital Risk Management | Accepted | 2026-01-27 | 90% |
| [ADR-022](./ADR-022-hot-path-memory-optimization.md) | Hot-Path Memory Optimization | Accepted | 2026-02-04 | 95% |
| [ADR-023](./ADR-023-detector-prevalidation.md) | Detector Pre-validation | Accepted | 2026-02-04 | 92% |
| [ADR-024](./ADR-024-rpc-rate-limiting.md) | RPC Rate Limiting Strategy | Accepted | 2026-02-04 | 90% |
| [ADR-025](./ADR-025-ml-model-lifecycle.md) | ML Model Lifecycle Management | Accepted | 2026-02-04 | 88% |
| [ADR-026](./ADR-026-integration-test-consolidation.md) | Integration Test Consolidation | Accepted | 2026-02-04 | 95% |
| [ADR-027](./ADR-027-nonce-preallocation-pool.md) | Nonce Pre-allocation Pool | Accepted | 2026-02-04 | 90% |
| [ADR-028](./ADR-028-mev-share-integration.md) | MEV-Share Integration | Accepted | 2026-02-06 | 90% |
| [ADR-029](./ADR-029-batched-quote-fetching.md) | Batched Quote Fetching via MultiPathQuoter | Accepted | 2026-02-06 | 92% |
| [ADR-030](./ADR-030-pancakeswap-v3-flash-loans.md) | PancakeSwap V3 Flash Loan Integration & Multi-Protocol Architecture | Accepted | 2026-02-08 | 90% |
| [ADR-031](./ADR-031-multi-bridge-strategy.md) | Multi-Bridge Selection Strategy | Accepted | 2026-02-15 | 92% |

## Decision Summary

### Core Architecture Decisions

1. **Hybrid Architecture** (ADR-001)
   - Microservices for deployment isolation
   - Event-driven for communication
   - Best of both patterns

2. **Event Backbone** (ADR-002)
   - Redis Streams (not Pub/Sub)
   - Persistence, consumer groups, backpressure
   - 98% reduction in Redis commands via batching

3. **Chain Scaling** (ADR-003)
   - Partitioned detectors (not 1:1)
   - Group by geography and block time
   - Supports 15+ chains with 4 partitions

### Data Processing Decisions

4. **Event Strategy** (ADR-004)
   - Sync events: PRIMARY (all processed)
   - Swap events: FILTERED (99% reduction)
   - Whale alerts: IMMEDIATE
   - Volume: AGGREGATED locally

5. **Caching Strategy** (ADR-005)
   - L1: SharedArrayBuffer (sub-microsecond)
   - L2: Redis (milliseconds)
   - L3: MongoDB (persistent)

### Infrastructure Decisions

6. **Hosting Strategy** (ADR-006)
   - Multi-provider for redundancy
   - Oracle Cloud for heavy compute
   - Fly.io for lightweight services
   - $0/month total cost

7. **Reliability Strategy** (ADR-007)
   - Active-passive failover
   - Redis-based leader election
   - <60s failover time
   - 99.9% uptime target

### Coverage Strategy

8. **Chain/DEX/Token Selection** (ADR-008)
   - 10 chains prioritized by arbitrage score
   - 55 DEXs across all chains
   - 150 tokens creating ~500 pairs
   - 3-phase rollout for risk management

### Connection Resilience

9. **WebSocket Resilience** (ADR-010)
   - Exponential backoff with jitter
   - Multi-provider fallback (2-4 per chain)
   - Health-based provider selection
   - Proactive staleness detection

### Performance Optimization (Tier 1)

10. **Tier 1 Performance Optimizations** (ADR-011)
    - O(1) token pair indexing (100-1000x speedup)
    - Dynamic slippage calculation based on liquidity
    - Event batching optimization (5ms from 25ms)
    - LRU cache with O(1) operations
    - Chain-specific staleness thresholds

11. **Worker Thread Path Finding** (ADR-012)
    - Offload CPU-intensive DFS to worker threads
    - Non-blocking multi-leg arbitrage discovery
    - Prevents event loop blocking

12. **Dynamic Gas Pricing** (ADR-013)
    - Real-time gas price cache per chain
    - Accurate profitability calculations
    - 30s refresh cycle with Redis fallback

### Code Architecture

13. **Modular Detector Components** (ADR-014)
    - ChainInstanceManager for lifecycle management
    - HealthReporter for health monitoring
    - MetricsCollector for metrics logging
    - Factory functions for dependency injection

14. **Pino Logger Migration** (ADR-015)
    - Migration from Winston to Pino (2-5ms latency reduction)
    - Dependency injection pattern for testing
    - Structured logging with performance optimization

### Execution Reliability (Phase 1)

15. **Transaction Simulation** (ADR-016)
    - Pre-flight simulation via Tenderly/Alchemy
    - 30%+ reduction in failed transactions
    - Configurable threshold and bypass options

16. **MEV Protection Enhancement** (ADR-017)
    - Chain-aware MEV providers (Flashbots, Jito, L2)
    - MEV risk analyzer with recommendations
    - Jito bundles for Solana protection

17. **Execution Circuit Breaker** (ADR-018)
    - Consecutive failure protection
    - Automatic recovery with HALF_OPEN testing
    - API controls for manual override

### Detection Optimization (Phase 2)

18. **Factory-Level Event Subscriptions** (ADR-019)
    - 40x subscription reduction
    - Subscribe to ~25 factories vs 1000+ pairs
    - Dynamic pair discovery

### Capital Efficiency (Phase 3)

19. **Flash Loan Integration** (ADR-020)
    - Aave V3 flash loans (0.09% fee)
    - Zero-capital arbitrage
    - Custom FlashLoanArbitrage.sol contract

20. **Capital Risk Management** (ADR-021)
    - Daily loss limits and circuit breakers
    - Kelly Criterion position sizing
    - Expected value filtering for trades
    - Risk-adjusted opportunity scoring

### Performance Optimization (Phase 4)

21. **Hot-Path Memory Optimization** (ADR-022)
    - Ring buffer for event latencies (zero allocation)
    - LRU cache for normalized token pairs
    - 99% reduction in hot-path memory churn

22. **Detector Pre-validation** (ADR-023)
    - Sample-based validation at detector level
    - 10% sampling rate to stay within rate limits
    - Filters out opportunities that would fail execution
    - Reduces wasted gas and simulation costs

23. **RPC Rate Limiting Strategy** (ADR-024)
    - Token bucket algorithm per provider
    - Multi-provider fallback chains
    - Graceful degradation under rate limits
    - Monitoring and alerting for quota usage

24. **ML Model Lifecycle Management** (ADR-025)
    - Model persistence and versioning
    - Lazy loading with performance monitoring
    - Automatic retraining pipeline
    - Model performance tracking

### Test Architecture (Phase 4)

25. **Integration Test Consolidation** (ADR-026)
    - Consolidated 34 files to 18 (47% reduction)
    - Removed 90%+ duplicate code
    - Clear unit vs integration test separation
    - Real in-memory Redis for all integration tests

### Execution Performance (Phase 4)

26. **Nonce Pre-allocation Pool** (ADR-027)
    - Pre-allocates nonces to eliminate sync latency
    - 5-10ms latency reduction during bursts
    - Background replenishment at threshold
    - Configurable pool size (default: 5)

### Cross-Chain Execution (Phase 5)

27. **Multi-Bridge Selection Strategy** (ADR-031)
    - BridgeRouterFactory manages Stargate V1, V2, and Across
    - Automatic route scoring by latency, cost, reliability
    - Per-bridge execution and health metrics
    - V1 pool liquidity monitoring for migration signaling
    - Protocol disabling for graceful V1 → V2 migration

## How to Use These ADRs

### For Implementation
- Read relevant ADRs before implementing features
- Follow the patterns and rationale documented
- Update ADRs if implementation differs significantly

### For Decision Making
- Check if existing ADR covers your question
- If not, create new ADR following the template
- Reference related ADRs

### For Revisiting Decisions
- Check the confidence level and rationale
- Evaluate if context has changed
- Create superseding ADR if decision changes

## ADR Template

```markdown
# ADR-XXX: Title

## Status
**Proposed | Accepted | Deprecated | Superseded**

## Context
What is the issue that we're seeing that is motivating this decision?

## Decision
What is the change that we're proposing and/or doing?

## Rationale
Why is this the best choice among alternatives?

## Consequences
What becomes easier or harder as a result?

## Alternatives Considered
What other options were evaluated?

## References
Links to related documents, code, or external resources.

## Confidence Level
XX% - Explanation of confidence factors
```

## Related Documents

- [Architecture v2.0](../ARCHITECTURE_V2.md) - Main architecture document
- [Current State](../CURRENT_STATE.md) - Service inventory and partition mapping
- [Deployment Guide](../../deployment.md) - Deployment instructions
- [Local Development](../../local-development.md) - Development setup
- [Code Conventions](../../agent/code_conventions.md) - Coding standards

## Change Log

| Date | ADR | Change |
|------|-----|--------|
| 2025-01-10 | All | Initial creation from architecture analysis session |
| 2025-01-12 | ADR-009 | Added Test Architecture decision |
| 2026-01-15 | ADR-010 | Added WebSocket Connection Resilience decision |
| 2026-01-18 | ADR-014 | Added Modular Detector Components decision |
| 2026-01-22 | ADR-016 | Added Transaction Simulation Integration decision |
| 2026-01-23 | ADR-017 | Added MEV Protection Enhancement decision |
| 2026-01-23 | ADR-018 | Added Execution Circuit Breaker decision |
| 2026-01-23 | ADR-019 | Added Factory-Level Event Subscriptions decision |
| 2026-01-24 | ADR-020 | Added Flash Loan Integration decision |
| 2026-02-04 | ADR-005 | Updated L3 cache description (clarified no MongoDB) |
| 2026-02-04 | ADR-022 | Added Hot-Path Memory Optimization decision |
| 2026-02-15 | ADR-031 | Added Multi-Bridge Selection Strategy decision |
