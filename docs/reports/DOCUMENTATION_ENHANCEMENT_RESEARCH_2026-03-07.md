# Research Summary: Project Documentation Enhancement

> **Date:** 2026-03-07
> **Scope:** Full documentation audit across 80+ docs, 10 services, 9 shared packages
> **Coverage Estimate:** ~62% (good foundation, critical gaps in operations and onboarding)

---

## 1. Current State Analysis

### How It Works

The project has **80+ documentation files** organized across:

| Category | Location | Files | Quality |
|----------|----------|-------|---------|
| Architecture & ADRs | `docs/architecture/adr/` | 41 ADRs + README | A (excellent, up to date) |
| Architecture Overview | `docs/architecture/` | 5 files | B (ARCHITECTURE_V2 good, DATA_FLOW stale) |
| Developer Guides | `docs/guides/`, `docs/local-development.md` | 7 files | A- (thorough, minor staleness) |
| Configuration | `docs/CONFIGURATION.md` | 1 file | B+ (85% complete, missing ADR-040 vars) |
| Operations | `docs/operations/` | 1 file | C (monitoring setup good, no runbooks) |
| Security | `docs/security/` | 1 file | C+ (secrets good, HMAC/auth/rate-limit missing) |
| Reports | `docs/reports/` | 2 files (+ CLAUDE.md references many deleted) | B (content good, dead links from README) |
| Service READMEs | `services/*/README.md` | 5 of 10 services | D (50% coverage) |
| Shared Package READMEs | `shared/*/README.md` | 0 of 9 packages | F (0% coverage) |
| Root README | `README.md` | 1 file | D (severely stale, multiple broken links) |
| Contract Docs | `contracts/docs/` | 2 files (no README.md) | C (deployment checklist good, no overview) |

### Bottleneck

The documentation's primary problem is **decay**: the codebase has evolved significantly (15 chains, 41 ADRs, ADR-038/039/040 features) but key entry-point documents haven't kept pace. A developer hitting `README.md` first encounters broken links, wrong Node.js version, non-existent WASM build steps, and a 3-chain architecture diagram for a 15-chain system.

### Root Cause

No documentation maintenance cadence exists. ADRs are well-maintained because they're created alongside features, but entry-point documents (README, CURRENT_STATE, DATA_FLOW) have no update trigger. Service/package READMEs were never created for core services (coordinator, execution-engine) or any shared packages.

---

## 2. Findings by Priority

### TIER 1: Critical (Breaks Navigation / Misleads Developers)

| # | Finding | File | Issue | Fix |
|---|---------|------|-------|-----|
| 1 | **Broken link** | `README.md:62` | Links to `docs/reports/CRITICAL_ASSESSMENT_REPORT.md` (doesn't exist) | Update to `docs/reports/CRITICAL_PROJECT_ASSESSMENT_2026-02-18.md` |
| 2 | **Broken link** | `README.md:63` | Links to `docs/reports/security_audit.md` (doesn't exist) | Remove or link to `contracts/docs/SECURITY_REVIEW.md` |
| 3 | **Broken link** | `README.md:64` | Links to `docs/research/FLASHLOAN_MEV_ENHANCEMENT_RESEARCH.md` (doesn't exist) | Update to `docs/research/CONSOLIDATED_RESEARCH_EVALUATION.md` |
| 4 | **Wrong Node.js version** | `README.md:100` | Says "Node.js 18+" | Change to "Node.js 22+" (per `package.json` engines: `>=22.0.0`) |
| 5 | **Non-existent build step** | `README.md:114` | References `shared/webassembly && wasm-pack build` | Directory doesn't exist; WASM not used. Remove entire WASM step |
| 6 | **Wrong startup command** | `README.md:118` | Says `docker-compose up -d` | Replace with `npm run dev:all` (per `docs/local-development.md`) |
| 7 | **Wrong Redis prereq** | `README.md:102` | Says "Upstash Redis account (free)" | Replace with Docker or in-memory Redis (self-hosted per ADR-006 update) |
| 8 | **Stale arch diagram** | `README.md:73-93` | Shows 3 chains (BSC, ETH, ARB) | Update to show 4-partition architecture with 15 chains |
| 9 | **Wrong ADR count** | `README.md:47` | Says "27 ADRs" | Update to "41 ADRs" |
| 10 | **Wrong partition name** | `unified-detector/README.md:38,52,68` | References `l2-fast` partition ID | Change to `l2-turbo` |

### TIER 2: High (Missing Core Documentation)

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| 11 | **5 core services lack READMEs**: coordinator, execution-engine, cross-chain-detector, mempool-detector, monolith | Developers can't onboard to core infrastructure without reading all source code | 3-4 hours |
| 12 | **0 shared packages have READMEs**: types, config, core, ml, security, test-utils, constants, flash-loan-aggregation, metrics | No documentation for the 9 foundational packages the entire system depends on | 3-4 hours |
| 13 | **No contracts/README.md**: No architecture overview of 6 flash loan contracts, inheritance tree, or deployment addresses | Contract developers can't navigate without reading NatSpec | 1-2 hours |
| 14 | **No production troubleshooting guide**: Only local-dev troubleshooting exists | Operations team has no diagnostic decision trees for production incidents | 2-3 hours |
| 15 | **No security config guides**: HMAC stream signing rotation, auth setup, rate-limiting config undocumented | Security misconfiguration risk during deployment | 2-3 hours |
| 16 | **DATA_FLOW.md 30 days stale**: Missing ADR-038 chain-group routing, ADR-039 SimulationWorker, ADR-040 native pricing | Architecture diagrams don't match deployed system | 1-2 hours |

### TIER 3: Medium (Incomplete Documentation)

| # | Finding | Impact |
|---|---------|--------|
| 17 | **CURRENT_STATE.md stream MAXLEN stale**: exec-requests shows 5K (should be 25K), exec-results shows 5K (should be 100K) | Capacity planning uses wrong numbers |
| 18 | **CONFIGURATION.md missing ADR-040 vars**: `NATIVE_TOKEN_PRICE_CACHE_TTL`, native pricing pool config not documented | Gas pricing features undiscoverable |
| 19 | **CONFIGURATION.md missing OTEL section**: `OTEL_EXPORTER_ENDPOINT`, trace propagation not explained | Observability setup requires reading code |
| 20 | **No metrics reference guide**: No documentation of exposed Prometheus metrics, expected ranges, or PromQL queries | Slow root-cause analysis |
| 21 | **No incident response runbook**: Referenced in MONITORING_SETUP.md but doesn't exist | Undefined escalation procedures |
| 22 | **API.md missing Mempool Detector endpoints**: Section header exists but content incomplete | Incomplete API reference |
| 23 | **ADR-008 chain count stale**: Says "11 Chains" in multiple places, system now has 15 | Misleading historical context |
| 24 | **partition-high-value/README.md broken link**: References `docs/IMPLEMENTATION_PLAN.md` (doesn't exist) | 404 for developers |
| 25 | **Stale test count in README**: Says "1126 tests across 35 test suites" | Project now has 438+ test files with ~13,475 test cases |

### TIER 4: Low (Polish / Nice-to-Have)

| # | Finding | Impact |
|---|---------|--------|
| 26 | No state machine diagrams for opportunity lifecycle, circuit breaker, bridge recovery | Harder to reason about system behavior |
| 27 | No deployment topology diagram (Fly.io regions, Redis placement) | Onboarding requires verbal knowledge transfer |
| 28 | No error code reference across API endpoints | Minor discovery friction |
| 29 | README version label says "v1.1.0" but package.json says 1.0.0 | Cosmetic inconsistency |
| 30 | No Grafana dashboard JSON templates (referenced in docker-compose but missing) | Dashboard setup from scratch |

---

## 3. Recommended Solution

### Approach: Phased Documentation Refresh

**Confidence:** HIGH (95%)

**Justification:** The project has an excellent ADR foundation (41 ADRs, all current). The gaps are concentrated in entry-point documents and operational guides. A phased approach fixes the highest-impact items first (broken README, missing service docs) before tackling operational completeness.

**Expected Impact:** Documentation coverage from ~62% to ~90%+. Developer onboarding time reduced from "read the code" to "read the docs" for all core services and packages.

**ADR Compatibility:** No new ADRs needed. This is a documentation-only enhancement touching no architecture decisions.

---

## 4. Implementation Tasks

### Phase 1: Fix Broken Entry Points (URGENT)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | Fix README.md: broken links, Node.js version, startup commands, WASM removal, architecture diagram, ADR count, Redis prereq, test count, version label | 30 min | 99% | None | Verify all links resolve, commands work |
| 2 | Fix unified-detector/README.md: `l2-fast` -> `l2-turbo`, add P4 Solana partition | 10 min | 99% | None | Verify partition names match `shared/config/src/partitions.ts` |
| 3 | Fix partition-high-value/README.md: broken `IMPLEMENTATION_PLAN.md` link | 5 min | 99% | None | Verify link resolves |
| 4 | Fix CURRENT_STATE.md: stream MAXLEN values (exec-requests 25K, exec-results 100K), mark legacy streams as deprecated | 15 min | 95% | None | Cross-reference with `shared/core/src/redis/streams.ts` |

### Phase 2: Missing Service & Package READMEs

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 5 | Create `services/coordinator/README.md` | 30 min | 90% | None | Cover: purpose, ports, API overview, leader election, configuration |
| 6 | Create `services/execution-engine/README.md` | 30 min | 90% | None | Cover: purpose, strategies, circuit breaker, chain-group routing |
| 7 | Create `services/cross-chain-detector/README.md` | 20 min | 90% | None | Cover: purpose, bridge routing, opportunity detection |
| 8 | Create `services/mempool-detector/README.md` | 15 min | 90% | None | Cover: purpose, bloXroute integration, configuration |
| 9 | Create `services/monolith/README.md` | 15 min | 90% | None | Cover: purpose, worker thread architecture, Oracle ARM deployment |
| 10 | Create `contracts/README.md` | 30 min | 90% | None | Cover: inheritance tree, 6 derived contracts, deployment addresses, OZ 4.9.6 patterns |
| 11 | Create lightweight READMEs for 9 shared packages (types, config, core, ml, security, test-utils, constants, flash-loan-aggregation, metrics) | 90 min | 85% | None | Each: purpose, key exports, build order dependency, usage example |

### Phase 3: Update Stale Architecture Docs

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 12 | Update `docs/architecture/DATA_FLOW.md`: add ADR-038 chain-group routing, ADR-039 SimulationWorker pipeline, ADR-040 native pricing | 60 min | 85% | None | Cross-reference with ADR files and code |
| 13 | Update `docs/CONFIGURATION.md`: add ADR-040 native token pricing vars, OTEL observability section, stream MAXLEN tuning section | 30 min | 90% | None | Cross-reference with `.env.example` |
| 14 | Update `docs/architecture/adr/ADR-008-chain-dex-token-selection.md`: 11 chains -> 15, add Scroll/Blast/Mantle/Mode | 15 min | 95% | None | Cross-reference with `CURRENT_STATE.md` |
| 15 | Update `docs/architecture/API.md`: complete Mempool Detector endpoints, add rate-limit response headers | 20 min | 90% | None | Cross-reference with service code |

### Phase 4: Operations & Security Guides (NEW)

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 16 | Create `docs/operations/TROUBLESHOOTING_PRODUCTION.md`: diagnostic decision trees for latency, memory, disconnects, execution lag, backpressure | 90 min | 80% | None | Review against monitoring report findings |
| 17 | Create `docs/security/REDIS_STREAM_SIGNING.md`: HMAC setup, zero-downtime rotation workflow, troubleshooting | 45 min | 85% | None | Cross-reference with `shared/core/src/redis-streams.ts` |
| 18 | Create `docs/security/AUTH_CONFIGURATION.md`: API Key format, JWT setup, permission wildcards, `validateAuthEnvironment()` | 30 min | 85% | None | Cross-reference with `shared/security/src/auth.ts` |
| 19 | Create `docs/operations/METRICS_REFERENCE.md`: all exposed Prometheus metrics, expected ranges, PromQL query examples | 60 min | 75% | None | Cross-reference with `/metrics` endpoints in code |
| 20 | Create `docs/operations/INCIDENT_RESPONSE_RUNBOOK.md`: escalation procedures, common scenarios, recovery steps | 45 min | 75% | None | Align with MONITORING_SETUP.md |

---

## 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Documentation drift after refresh | HIGH | MEDIUM | Add "Docs updated?" to PR checklist. ADR template already prompts for doc updates. |
| Service READMEs become stale quickly | MEDIUM | LOW | Keep READMEs minimal (purpose, config, API); reference ADRs for architecture details |
| Shared package READMEs duplicating CLAUDE.md | LOW | LOW | READMEs cover "what & why"; CLAUDE.md covers "how to develop" |
| Effort estimate undercount | MEDIUM | LOW | Phase 1 is <1 hour and highest value. Later phases can be deferred. |

---

## 6. Success Metrics

- [ ] **Broken links**: 0 (currently 4 in README.md, 1 in partition-high-value) -- verify with link checker
- [ ] **Service README coverage**: 10/10 services (currently 5/10) -- `ls services/*/README.md`
- [ ] **Shared package README coverage**: 9/9 packages (currently 0/9) -- `ls shared/*/README.md`
- [ ] **Stale data items**: 0 (currently 10+ across README, CURRENT_STATE, unified-detector) -- manual audit
- [ ] **Operations guides**: 4+ files in `docs/operations/` (currently 1) -- `ls docs/operations/`
- [ ] **Security guides**: 3+ files in `docs/security/` (currently 1) -- `ls docs/security/`

---

## 7. ADR Recommendation

**New ADR Needed?**: No

This is a documentation maintenance effort, not an architectural decision. No new ADR is warranted.

**Recommended instead:** Add a `## Documentation Maintenance` section to `docs/agent/code_conventions.md` codifying the expectation that:
1. New services/packages include a README.md
2. Architecture changes update DATA_FLOW.md
3. New env vars are documented in CONFIGURATION.md
4. Entry-point docs (README.md, CURRENT_STATE.md) are refreshed quarterly

---

## Appendix: Full Inventory

### Documentation Files by Category (80 total)

| Category | Count | Key Files |
|----------|-------|-----------|
| ADRs | 41 | `docs/architecture/adr/ADR-001` through `ADR-041` |
| Architecture | 5 | ARCHITECTURE_V2, CURRENT_STATE, DATA_FLOW, API, TEST_ARCHITECTURE |
| Developer Guides | 7 | local-development, deployment, strategies, code_conventions, 4 guides/ |
| Operations | 1 | MONITORING_SETUP |
| Security | 1 | SECRETS_MANAGEMENT |
| Configuration | 1 | CONFIGURATION |
| Warming/Cache | 4 | DEPLOYMENT_GUIDE, API_REFERENCE, MIGRATION_GUIDE, CONFIGURATION_GUIDE |
| Reports | 2 | PROFITABILITY_AUDIT, DEPLOYMENT_TESTNET_ASSESSMENT |
| Research | 1 | CONSOLIDATED_RESEARCH_EVALUATION |
| Contract Docs | 2 | PRE_DEPLOYMENT_CHECKLIST, SECURITY_REVIEW |
| Service READMEs | 5 | unified-detector, partition-asia-fast, partition-l2-turbo, partition-high-value, partition-solana |
| Other | 5 | redis-key-registry, STALE_PRICE_WINDOW, MANUAL_TESTSTEPS, Free_Tiers, todos |
| Archive | 5 | implementation plans v2/v3, modularization plan, opportunity publisher plan |

### Missing Service READMEs (5)

- `services/coordinator/README.md`
- `services/execution-engine/README.md`
- `services/cross-chain-detector/README.md`
- `services/mempool-detector/README.md`
- `services/monolith/README.md`

### Missing Shared Package READMEs (9)

- `shared/types/README.md`
- `shared/config/README.md`
- `shared/core/README.md`
- `shared/ml/README.md`
- `shared/security/README.md`
- `shared/test-utils/README.md`
- `shared/constants/README.md`
- `shared/flash-loan-aggregation/README.md`
- `shared/metrics/README.md`
