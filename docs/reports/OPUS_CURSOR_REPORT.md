High-level narrative
From multiple perspectives (exploration, code review, and architecture), this repo is a surprisingly mature, production-grade arbitrage system with strong documentation, explicit design decisions (ADRs), and careful handling of many failure modes. At the same time, its complexity is heavily concentrated in a few “composition roots” (coordinator, execution-engine, shared/core), and configuration + observability are the dominant systemic risks: a mis-set env var or missing volume can quietly undermine safety, risk controls, or visibility without any code changes.
Below I’ll present the assessment as if three senior engineers—Explorer, Reviewer, and Architect—had a structured conversation, then merge their views into concrete, prioritized recommendations.
1. Explorer: System map and structural observations
Macro-architecture
Microservice cluster around Redis Streams:
Detectors: unified-detector plus partition wrappers (partition-asia-fast, partition-l2-turbo, partition-high-value, partition-solana), mempool-detector, cross-chain-detector.
Control-plane: coordinator.
Execution & risk: execution-engine.
Shared libraries:
shared/core (@arbitrage/core) as the platform: Redis, streams, caching, risk, MEV, bridge router, health, monitoring, etc.
shared/types, shared/config, shared/security, shared/ml, shared/test-utils.
On-chain layer:
contracts/ Hardhat project with flash-loan and MEV/commit–reveal contracts.
Infra & ops:
infrastructure/ for Docker, Fly, GCP, Oracle Terraform, monitoring, Grafana, etc.
Docs:
Rich architecture docs: docs/architecture/ARCHITECTURE_V2.md, CURRENT_STATE.md, DATA_FLOW.md, plus ADRs and strategy/security reports.
Key strengths from Explorer
Architecture is explicitly documented and actually matches the code (especially ARCHITECTURE_V2 and DATA_FLOW); this is rare and very valuable for onboarding and maintenance.
Redis Streams as an event backbone are used consistently: price updates, opportunities, execution requests/results, health, pending opportunities, DLQ.
Shared/core encapsulates cross-cutting concerns (caching, rate limiting, health, risk primitives, analytics) rather than duplicating them in each service.
Structural red flags from Explorer
shared/core is a dense “platform” module that nearly everything depends on. It’s well-factored internally but is still a single, high-blast-radius dependency.
Coordinator and execution-engine are very large services with many responsibilities; they act as control-plane and execution “brains” respectively, which is appropriate but fragile.
Everything depends on Redis Streams (health, execution, failover, analytics); redis is a single critical dependency whose misconfiguration has system-wide impact.
2. Reviewer: Code-quality and risk focus
The Reviewer took a wide, shallow pass over representative areas in each domain and flagged where things can go catastrophically wrong, not where code style is imperfect.
2.1 Highest-risk areas (not necessarily buggy, but critical)
services/execution-engine/src/engine.ts (ExecutionEngineService)
Orchestrates money movement, Concurrency, locks, nonces, risk, A/B testing, simulation, MEV, and bridge routing in one class.
Concurrency and distributed locking (executeOpportunityWithLock, crash recovery with LockConflictTracker) are subtle; bugs here yield duplicates, stalls, or race conditions under partial failures.
Failure-mode routing (when to ACK, drop, or re-enqueue) defines whether you lose edge, spam infra, or both.
Execution strategies: services/execution-engine/src/strategies/*.ts
On-chain capital exposure via flash loans, multi-leg routes, and protocol-specific assumptions (Aave, Balancer, PancakeSwap, SyncSwap).
Tight coupling with config/risk: if slippage/profit checks or interpretation of risk outputs drift, you can over-bet or trade at zero/negative EV.
Risk primitives: shared/core/src/risk/position-sizer.ts (Kelly), EV, drawdown breakers
Translate edge estimates into capital at risk.
Behavior is config-driven (capital, Kelly multiplier, caps) and can silently degrade if totalCapital is stale or mis-set.
Callers must interpret results correctly (e.g., “zero capital” vs “tiny capital”).
Nonces: shared/core/src/nonce-manager.ts
Critical for avoiding nonce collisions across concurrent sends.
Implements custom locking, pre-allocation, and timeout-based cleanup; this is notoriously error-prone in distributed systems.
Redis Streams infra: shared/core/src/redis-streams.ts
Core of the event backbone.
Complex batching and queue bounds; handling of outages or backpressure can drop messages or blow memory.
Trade logging: shared/core/src/persistence/trade-logger.ts
Only durable record of executed trades.
Writes to local FS directory (./data/trades), with non-fatal error handling—easy to end up with no persisted trades if volumes/paths aren’t mounted.
Security & rate limiting: shared/security/src/auth.ts, rate-limiter.ts
Gatekeeping for auth and abuse; heavily dependent on Redis health and correct failOpen/failClosed semantics.
Placeholder / abstracted user storage can mislead operators into thinking they have “real” persistence.
RPC rate-limiting: shared/core/src/rpc/rate-limiter.ts
Critical to both latency and reliability; defaults encode assumptions about provider policies that can rot over time.
Partition health & env parsing: shared/core/src/partition-service-utils.ts
Controls which chains are active per partition and how health/stats endpoints are exposed.
Misconfiguration can cause silent chain omission or oversharing of internal metrics.
2.2 Systemic patterns (overall quality & risks)
Engineering quality is generally high
Defensive coding, explicit comments, documented past issues, and deliberate fixes (e.g., avoiding || 0 with BigInt, no Redis KEYS, careful lock timeouts).
Heavy use of feature flags, circuit breakers, and DLQs.
Configuration is the primary systemic weak point
Capital, chain/provider URLs, feature flags, fail-open/closed behavior, and risk thresholds are all env/config-driven.
The system is designed to be multi-cloud and free-tier, which increases environmental variability and risk of misconfiguration.
Complexity is tightly packed into a few core modules
Especially ExecutionEngineService, coordinator, and shared/core singletons.
Testing and reasoning are harder where concerns accumulate.
Observability is strong but uneven
Execution & cross-chain-detector have rich stats and health metrics.
Some key failure states (e.g. trade logger not writing, rate-limiter fail-open due to Redis outage, misconfigured health endpoints) rely on logs alone rather than hard health signals.
“This could blow up in prod” if misconfigured
Health/stats endpoints bound to 0.0.0.0 with optional auth; if surfaced publicly, they leak detailed system state and can expose strategies and load.
Trade log directory not writable/persistent, causing silent loss of audit data.
Kelly sizing with wrong totalCapital or wrong failOpen defaults can either effectively disable trading or switch to dangerously aggressive behavior.
3. Architect: Architectural view and refactor themes
The Architect reconstructed the architecture and then proposed themes for improvement.
3.1 Current architecture (verbal diagram)
Foundations
@arbitrage/types defines canonical types for events, streams, and service lifecycles.
@arbitrage/core provides infra, risk, caching, MEV, bridge, monitoring, DLQ, health, and domain helpers.
@arbitrage/config codifies chain/DEX/token/partition config; shared/security and shared/ml provide auth & ML.
Data ingestion & detection
Unified detector + partitions:
Multi-chain WebSocket ingestion.
Normalization into price updates, volume aggregates, and whale alerts.
Partition health reporting and metrics.
Mempool detector:
bloXroute BDN mempool analysis; emits PendingOpportunity events.
Cross-chain detector:
Cross-chain arbitrage detection over indexed price matrices.
Integrates ML predictions, whale signals, bridge cost/latency.
Performs sampling-based pre-validation via external simulation.
Control-plane and monitoring
Coordinator:
Aggregates stream:health, stream:opportunities, and other signals.
Leader election and standby activation.
Forwards opportunities to execution via stream:execution-requests with its own circuit breaker.
Exposes metrics and admin HTTP endpoints.
Execution & risk
Execution engine:
Processes stream:execution-requests.
Runs risk pipeline (EV, Kelly, drawdown, probability tracking).
Selects execution strategy (intra-chain, cross-chain, flash-loan, simulation) and MEV route.
Publishes stream:execution-results and persists trades.
Monitoring & failover
Health & degradation handled via shared monitoring utilities and coordinator.
Trade logs + infra monitoring (Grafana dashboards, alert rules) form the observability layer.
3.2 Architectural smells
God composition roots
CoordinatorService and ExecutionEngineService do too much: wiring, orchestration, business logic, health, HTTP.
Scattered observability logic
Alerting and health semantics are repeated across services with subtly different rules.
Strategy/risk boundaries blurred
Detection, execution, ML, and risk are intertwined across multiple services instead of living behind clear “strategy” and “risk” modules.
Overloaded message contracts
ArbitrageOpportunity is a wide DTO that tries to cover many shapes and phases of opportunities.
Singleton-heavy infra with implicit lifecycle
Many getX() singletons with ad-hoc reset semantics; lifecycle is more implicit than explicit.
3.3 Proposed refactor themes (high level)
Theme 1: Thin, explicit composition roots for coordinator and execution-engine
Extract application sub-services (e.g., ExecutionOrchestrator, CoordinatorHealthApp) and keep root classes as thin facades.
Theme 2: Consolidate monitoring & alerting into a dedicated observability layer
Shared observability module centralizing health reporting, alert routing, and alert policy.
Theme 3: Clarify “strategy” and “risk” domains
Detection strategy and execution strategy as explicit domain packages; risk policy shared and versioned.
Theme 4: Versioned, narrow message contracts
Context-specific event types per stream (e.g. ExecutionRequestV1, OpportunityDetectedEventV1), with an adapter layer.
Theme 5: Explicit lifecycle for singletons and shared services
Service registry-style management of shared components and a clear test vs production separation for resets.
4. Integrated critique: Where the design shines vs where it’s fragile
4.1 What is genuinely strong
Intentional, well-documented architecture
The architecture is not accidental; it’s driven by ADRs, and the code matches the docs closely.
Risk and resilience are first-class
Multiple circuit breakers, DLQ usage, risk sizing, ML-based prediction, and specific mitigation around infra pitfalls show deep experience.
Shared infra abstractions reduce duplication
Redis Streams, rate limiting, risk, and monitoring primitives are centralized and reused.
4.2 Where it’s most fragile
Concentration of complexity
A handful of classes (ExecutionEngineService, CoordinatorService, parts of shared/core) are too central and too complex; they become bottlenecks for evolution and risky places to touch.
Env/config becomes de facto “code”
Capital totals, feature flags, exposure to health endpoints, risk thresholds, and provider configs effectively define runtime behavior; small mistakes can have large, non-obvious consequences.
Observability gaps at critical seams
If trade logs fail, rate limiters fail-open, or health endpoints are exposed, the system may continue “working” while being unsafe or opaque.
Boundary blur between strategy and risk
The meaning of “allowed trade” is partly encoded in detection thresholds, partly in execution risk logic; that’s hard to audit and evolve.
5. Concrete, prioritized recommendations
Below are practical, high-ROI initiatives, roughly in priority order, balancing safety, effort, and blast radius.
5.1 Short-term safety & ops wins (high priority, low–moderate effort)
Lock down health and stats endpoints
Ensure all deployments set:
HEALTH_BIND_ADDRESS to a non-public interface (e.g., 127.0.0.1 or internal subnet).
HEALTH_AUTH_TOKEN for any endpoint that exposes stats/coverage, not only “liveness”.
Add an explicit startup assertion in partition-service-utils and coordinator/execution-engine health servers that refuses to run in NODE_ENV=production if:
bindAddress is 0.0.0.0 AND there is no known reverse-proxy auth or
authToken is missing while exposing /stats endpoints.
Enforce durable trade logging as a deployment invariant
Standardize a volume mount path (e.g. /var/lib/arbitrage/trades) and require TRADE_LOG_DIR / equivalent env to be set in prod.
At startup, do a test write + read; if it fails in prod, fail fast rather than degrade silently to “no persistent logs”.
Audit failOpen / failClosed defaults in security, rate-limiting, and RPC rate limiter
For each of rate-limiter.ts, auth.ts, and rpc/rate-limiter.ts:
Review and explicitly document intended behavior under Redis or provider failure.
Tighten defaults to fail closed where abuse or capital loss is plausible (auth, external access) and fail open only where the downside is clear and acceptable.
Add metric counters for “failOpen path taken” and dashboards/alerts.
Configuration validation + “safe mode”
Strengthen shared/config validation to:
Reject obviously bad configurations (zero capital with trading enabled, missing required chain/DEX entries).
Provide a “safe mode” (e.g. env flag) that forces everything into simulation-only when key config is missing or inconsistent, instead of partial trading.
5.2 Medium-term structural improvements (moderate effort, high payoff)
Decompose ExecutionEngineService and CoordinatorService
Introduce internal application services for:
Execution: queue orchestrator, risk orchestrator, infra initialization, API surface.
Coordinator: health aggregation, stream consumer setup, opportunity routing, HTTP API.
Phase this in via delegation without changing external interfaces first.
Target: make each root class mostly a wiring shell; actual logic lives in smaller, testable components.
Centralize and normalize observability
Build a shared Observability module:
Standard health reporter.
Standard alert policy + router.
Canonical metric names for key KPIs (detection rate, success rate, risk rejections, circuit opens).
Migrate coordinator, detectors, and execution-engine to consume this module rather than embedding custom alert logic.
Formalize opportunity and event schemas
Start by defining internal DTOs in coordinator and engine that normalize all inbound messages.
Use @arbitrage/types to define stream-specific event types with minimal required fields.
Later, if desired, introduce v2 streams and dual-publish/consume them for a while.
5.3 Longer-term domain refactors (higher effort, substantial payoff)
Create explicit “strategy” and “risk” modules
Factor detection logic (same-chain, cross-chain, mempool) into a detection strategy module, separate from infra concerns.
Pull risk decisions into a risk policy module that can be reused by both detection and execution; treat it as a pure functional core where possible.
Benefit: you can simulate and backtest both detection and risk policies in isolation, and reason clearly about what “risk-approved” means.
Rationalize singleton lifecycle
Use a service registry pattern within each process to manage singletons for nonces, price oracles, ML scorers, etc.
Restrict “reset” capabilities to test-only entry points, preventing production misuse and making lifecycle explicit.
6. Where to focus next
If you want to go deeper, good next “deep dives” would be:
Execution engine deep dive: walk through a single opportunity from stream:execution-requests through locking, risk, strategy selection, transaction submission, MEV routing, and logging, and map exact failure modes.
Config & risk audit: correlate real deployment configs with the implied assumptions in shared/config, risk modules, and docs; ensure no hidden mismatches.
Observability & runbook review: cross-check alert rules and dashboards with the critical risks identified above, and write or improve operational runbooks for common failure patterns.