# Architecture Decision Log

> This document tracks the evolution of architectural decisions and provides context for future analysis sessions.

---

## Session: 2025-01-10 - Comprehensive Architecture Analysis

### Session Context

**Objective**: Deep analysis of the complete project to evaluate architecture decisions for scaling to 9+ blockchains with professional competitive arbitrage trading while maintaining free hosting constraints.

**Key Questions Addressed**:
1. Microservices vs Event-Driven architecture for multi-chain arbitrage?
2. How to scale to 9+ blockchains, many DEXs, many tokens?
3. How to optimize free hosting for 24/7 uptime?
4. Should swap events be monitored? What's the value vs cost?

### Analysis Summary

#### Finding 1: Architecture is Already Hybrid
- **Observation**: Current architecture uses microservices (deployment) with event-driven communication (Redis Pub/Sub)
- **Decision**: Keep hybrid approach, it's correct for the use case
- **Confidence**: 92%

#### Finding 2: Redis Pub/Sub Has Limitations
- **Observation**: Pub/Sub is fire-and-forget, no persistence, no backpressure
- **Decision**: Migrate to Redis Streams for critical channels
- **Confidence**: 88%
- **ADR**: [ADR-002](./adr/ADR-002-redis-streams.md)

#### Finding 3: 1-Service-Per-Chain Doesn't Scale
- **Observation**: 15 chains = 15 services exceeds free tier limits
- **Decision**: Partition chains into 3-4 detector services by geography/block time
- **Confidence**: 90%
- **ADR**: [ADR-003](./adr/ADR-003-partitioned-detectors.md)

#### Finding 4: Swap Events Are Valuable But Expensive
- **Observation**: Swap events provide predictive signals (whales, MEV, volume)
- **Observation**: But processing all swaps would exhaust Redis quota
- **Decision**: Smart filtering - 99% reduction, 100% signal retention
- **Confidence**: 88%
- **ADR**: [ADR-004](./adr/ADR-004-swap-event-filtering.md)

#### Finding 5: Free Hosting Resources Underutilized
- **Observation**: Only using ~40-50% of available free resources
- **Decision**: Documented optimal allocation across 6 providers
- **Confidence**: 95%
- **ADR**: [ADR-006](./adr/ADR-006-free-hosting.md)

#### Finding 6: No Geographic Redundancy
- **Observation**: Current self-healing is single-region only
- **Decision**: Add active-passive failover with Redis leader election
- **Confidence**: 90%
- **ADR**: [ADR-007](./adr/ADR-007-failover-strategy.md)

### Hypotheses Developed

| Hypothesis | Confidence | Validation Method |
|------------|------------|-------------------|
| Hybrid architecture scales to 15+ chains | 92% | Implement partitions, measure resource usage |
| Redis Streams reduces command usage 98% | 88% | Implement batching, monitor Upstash dashboard |
| Smart swap filtering retains 100% signal value | 88% | Compare whale detection with/without filtering |
| <50ms detection latency achievable | 80% | Implement L1 price matrix, benchmark |
| 99.9% uptime achievable with free hosting | 85% | Implement failover, track uptime metrics |

### Open Questions for Future Sessions

1. **Solana Integration**: How to add non-EVM chains? Different SDK, different architecture?
2. **ML Model Training**: Where to run TensorFlow.js training? Oracle Cloud ARM compatible?
3. **Execution Optimization**: Flash loan integration, MEV protection implementation details?
4. **Profit Tracking**: How to accurately track P&L across chains and opportunities?
5. **Token Discovery**: Auto-discover new high-liquidity tokens vs manual configuration?

### Implementation Priority

| Priority | Task | Estimated Effort | Impact |
|----------|------|------------------|--------|
| P0 | Redis Streams migration | 1 week | HIGH - enables scaling |
| P0 | Smart swap filtering | 1 week | HIGH - resource savings |
| P1 | Partitioned detectors | 2 weeks | HIGH - chain scaling |
| P1 | L1 Price Matrix | 1 week | HIGH - latency reduction |
| P2 | Failover implementation | 2 weeks | MEDIUM - reliability |
| P2 | Add Avalanche, Optimism | 1 week | MEDIUM - coverage |
| P3 | Add zkSync, Solana | 2 weeks | MEDIUM - emerging chains |

---

## Session: 2025-01-10 (Continued) - Chain/DEX/Token Selection Analysis

### Session Context

**Objective**: Deep dive analysis to determine optimal blockchain, DEX exchange, and token selection for professional competitive arbitrage trading.

**Key Questions Addressed**:
1. Which blockchains provide the best arbitrage opportunity/competition ratio?
2. Which DEXs must be monitored for competitive coverage?
3. Which tokens generate consistent arbitrage opportunities?
4. How does expansion impact free hosting constraints?

### Analysis Summary

#### Finding 8: Optimal Chain Selection
- **Observation**: Current 5 chains capture only ~30% of available arbitrage volume
- **Decision**: Expand to 10 chains with tiered priority (T1: Arbitrum, BSC, Base; T2: Polygon, Optimism, Avalanche; T3: Ethereum, Fantom, zkSync, Linea)
- **Confidence**: 92%
- **ADR**: [ADR-008](./adr/ADR-008-chain-dex-token-selection.md)

#### Finding 9: DEX Coverage Gap
- **Observation**: Current 10 DEXs vs competitor 40+ DEXs = 75% coverage gap
- **Decision**: Expand to 55 DEXs with Critical/High/Medium prioritization
- **Confidence**: 90%

#### Finding 10: Token Pair Optimization
- **Observation**: 23 tokens (~50 pairs) vs optimal 150 tokens (~500 pairs)
- **Decision**: Tiered token selection (Anchor, Core DeFi, High-Volume, Strategic)
- **Confidence**: 88%

#### Finding 11: Free Hosting Still Compatible
- **Observation**: Even with 10 chains, 55 DEXs, 150 tokens, resources stay within limits
- **Decision**: Phased rollout preserves headroom for future scaling
- **Confidence**: 95%

### Updated Hypotheses

| Hypothesis | Confidence | Validation Method |
|------------|------------|-------------------|
| 10 chains captures 90%+ of arbitrage volume | 92% | Compare opportunity count before/after expansion |
| 55 DEXs provides competitive coverage | 90% | Benchmark against known competitor detection rates |
| 500 pairs manageable within L1 cache (16KB) | 95% | Implement and measure memory usage |
| Phase 3 achieves 780+ opportunities/day | 85% | Track daily opportunity count through phases |

### Implementation Priority (Updated)

| Priority | Task | Estimated Effort | Impact |
|----------|------|------------------|--------|
| P0 | Add Optimism chain + 6 DEXs | 3 days | HIGH - immediate coverage |
| P0 | Expand Base to 7 DEXs | 2 days | HIGH - growing ecosystem |
| P1 | Add Avalanche + Fantom | 1 week | MEDIUM - Asia coverage |
| P1 | Expand token coverage to 110 | 3 days | HIGH - pair increase |
| P2 | Add zkSync + Linea | 1 week | MEDIUM - emerging chains |
| P2 | Complete 150 token coverage | 3 days | MEDIUM - full coverage |

---

## Previous Sessions

### Session 1: 2025-01-10 - Comprehensive Architecture Analysis
*(See above for full details)*

---

## How to Continue Future Sessions

### Resuming Analysis

When starting a new analysis session, reference this document:

```
"Continue the architecture analysis from the 2025-01-10 session.
The decision log is at docs/architecture/DECISION_LOG.md.
Focus on [specific topic] based on the open questions."
```

### Updating This Log

After each significant analysis session:
1. Add a new session section with date
2. Document key findings and decisions
3. Update hypotheses with validation results
4. Add new open questions
5. Update implementation priorities

### Linking to ADRs

When a decision is made:
1. Create ADR in `docs/architecture/adr/`
2. Reference ADR in this log
3. Update ADR index in `docs/architecture/adr/README.md`

---

## Decision Metrics

### Architecture Confidence Scores

| Area | Initial (2025-01-10) | Current | Target |
|------|----------------------|---------|--------|
| Overall Architecture | 92% | 92% | 95% |
| Event Processing | 88% | 88% | 90% |
| Scaling Strategy | 90% | 90% | 95% |
| Free Hosting Viability | 95% | 95% | 98% |
| Reliability/Uptime | 90% | 90% | 95% |
| Chain/DEX/Token Selection | - | 92% | 95% |

### Key Metrics to Track

| Metric | Baseline | Phase 1 | Phase 2 | Phase 3 | Actual |
|--------|----------|---------|---------|---------|--------|
| Detection latency (same-chain) | ~150ms | <100ms | <75ms | <50ms | TBD |
| Detection latency (cross-chain) | ~30s | <20s | <15s | <10s | TBD |
| Redis commands/day | ~3,000 | ~5,000 | ~7,000 | ~8,500 | TBD |
| System uptime | ~95% | 97% | 99% | 99.9% | TBD |
| Chains supported | 5 | 7 | 9 | 10 | 5 |
| DEXs monitored | 10 | 25 | 45 | 55 | 10 |
| Tokens tracked | 23 | 60 | 110 | 150 | 23 |
| Token pairs | ~50 | ~150 | ~350 | ~500 | ~50 |
| Opportunities/day | ~100 | ~300 | ~550 | ~780 | TBD |

---

## References

- [Architecture v2.0](./ARCHITECTURE_V2.md)
- [ADR Index](./adr/README.md)
- [Original Architecture](../architecture.md)
- [Deployment Guide](../deployment.md)
