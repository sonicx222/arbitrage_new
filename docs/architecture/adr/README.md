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
- [Deployment Guide](../../deployment.md) - Deployment instructions
- [Development Guide](../../development.md) - Development setup

## Change Log

| Date | ADR | Change |
|------|-----|--------|
| 2025-01-10 | All | Initial creation from architecture analysis session |
