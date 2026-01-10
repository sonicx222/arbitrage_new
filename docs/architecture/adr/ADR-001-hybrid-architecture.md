# ADR-001: Hybrid Microservices + Event-Driven Architecture

## Status
**Accepted** | 2025-01-10

## Context

The arbitrage detection system requires an architecture that can:
- Scale to 9+ blockchains with 55+ DEXs
- Achieve sub-50ms detection latency
- Operate within free hosting resource constraints
- Maintain 24/7 uptime with automatic recovery

Three architectural approaches were evaluated:
1. **Pure Microservices**: Independent services with synchronous REST/gRPC communication
2. **Pure Event-Driven**: Single event loop processing all events
3. **Hybrid**: Microservices deployment with event-driven communication

## Decision

We adopt a **Hybrid Microservices + Event-Driven Architecture**.

### What This Means

**Microservices aspects (deployment):**
- Each detector partition is an independent deployable unit
- Services have isolated failure domains
- Different services can run on different hosting providers
- Services can be scaled independently

**Event-driven aspects (communication):**
- All inter-service communication via Redis Streams
- Asynchronous, non-blocking message passing
- Event sourcing for critical data flows
- Consumer groups for load balancing

## Rationale

### Why Not Pure Microservices?

| Issue | Impact | Severity |
|-------|--------|----------|
| Synchronous HTTP calls add latency | +20-50ms per hop | HIGH |
| Service discovery overhead | Complexity, failure points | MEDIUM |
| Request-response blocks caller | Resource waste while waiting | MEDIUM |
| Cascading failures | One slow service blocks others | HIGH |

For arbitrage where milliseconds matter, synchronous communication is unacceptable.

### Why Not Pure Event-Driven (Monolith)?

| Issue | Impact | Severity |
|-------|--------|----------|
| Single point of failure | 100% downtime if process dies | HIGH |
| Cannot distribute geographically | Higher latency to distant chains | HIGH |
| Memory limits on free tiers | Cannot fit all chain data in 256MB | HIGH |
| No isolation between chains | Bug in BSC affects Ethereum | MEDIUM |

Free hosting memory limits (256MB on Fly.io) make a monolith impossible at scale.

### Why Hybrid Wins

| Benefit | How Achieved |
|---------|--------------|
| **Low latency** | Async events, no request-response blocking |
| **Fault isolation** | Each partition fails independently |
| **Geographic distribution** | Deploy partitions near blockchain validators |
| **Resource efficiency** | Right-size each partition for its workload |
| **Scalability** | Add partitions without changing existing ones |
| **Free hosting compatible** | Split workload across multiple providers |

## Consequences

### Positive
- Can achieve <50ms detection latency
- Can scale to 15+ chains without architectural changes
- Can survive individual service failures
- Can use multiple free hosting providers

### Negative
- More complex deployment (8+ services vs 1)
- Need distributed tracing for debugging
- Event ordering requires careful design
- Eventual consistency between services

### Mitigations
- Docker Compose for local development (single command)
- Correlation IDs in all events for tracing
- Sequence numbers in streams for ordering
- Idempotent event handlers

## Alternatives Considered

### Alternative 1: Kubernetes with Service Mesh
- **Rejected because**: No free Kubernetes hosting with sufficient resources
- **Would reconsider if**: Paid infrastructure becomes acceptable

### Alternative 2: Serverless Functions
- **Rejected because**: Cold starts (100-500ms) unacceptable for arbitrage
- **Would reconsider if**: Latency requirements relaxed significantly

### Alternative 3: Single VM with Worker Threads
- **Rejected because**: Single point of failure, no geographic distribution
- **Would reconsider if**: Only monitoring 1-2 chains

## References

- [Martin Fowler: Microservices](https://martinfowler.com/articles/microservices.html)
- [Event-Driven Architecture](https://docs.microsoft.com/en-us/azure/architecture/guide/architecture-styles/event-driven)
- [Architecture v2.0 Document](../ARCHITECTURE_V2.md)

## Confidence Level

**92%** - High confidence based on:
- Proven pattern in high-frequency trading systems
- Aligns with free hosting constraints
- Provides required scalability path
