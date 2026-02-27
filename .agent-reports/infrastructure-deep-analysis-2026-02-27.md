# Infrastructure Deep Analysis Report

**Date:** 2026-02-27
**Scope:** `infrastructure/` — Docker, Fly.io, GCP, Oracle Cloud (Terraform), Grafana, monitoring, scripts, tests
**Files Analyzed:** 36 configuration/script files + 2 test files
**Analysis Method:** 6-agent team (architecture, bug-hunting, security, test quality, config fidelity, performance/refactoring) + team lead cross-verification
**Grade: C+** — Multiple critical configuration drift issues and security gaps that could cause deployment failures or expose attack surface

---

## Executive Summary

- **Total findings:** 23 (4 Critical, 7 High, 8 Medium, 4 Low)
- **Top 3 highest-impact issues:**
  1. Cross-chain detector has NO deploy function/secrets setup — would be silently skipped during `deploy.sh all` deployment
  2. L2-fast partition secrets setup is missing Scroll/Blast RPC URLs despite TOML configuring 5 chains — 2 chains would fail to connect
  3. Docker-compose.partition.yml exposes Redis to the network without IP restriction — potential unauthorized access
- **Overall health:** Significant configuration drift exists between Fly.io, Docker, Oracle Cloud, and GCP deployment targets. Port assignments, chain assignments, memory limits, and health check paths are inconsistent across platforms. The infrastructure lacks CI/CD pipelines and cross-platform validation testing.
- **Agent agreement:** Architecture auditor, config fidelity validator, and test quality analyst all independently flagged the L2-fast chain/memory mismatch. Security auditor and bug-hunter both flagged the Redis exposure issue.

---

## Critical Findings (P0 — Fix Before Deployment)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Deployment Gap | `fly/deploy.sh` (entire file) | **Cross-chain detector missing from deploy.sh entirely.** No `deploy_cross_chain()` function, no `setup_cross_chain_secrets()` function, and not included in `deploy_all` case. The `cross-chain-detector.toml` exists but cannot be deployed via the automation script. Running `deploy.sh all` silently skips this service. | Architecture, Bug-Hunter | HIGH (95%) | Add `deploy_cross_chain()` wrapper and `setup_cross_chain_secrets()` function. Add to `deploy_all` case between partition deploys and execution-engine. | 4.6 |
| 2 | Secret Management | `fly/deploy.sh:68-117` | **L2-fast secrets setup missing Scroll/Blast RPC URLs.** The TOML at `partition-l2-fast.toml:29` sets `PARTITION_CHAINS = "arbitrum,optimism,base,scroll,blast"` (5 chains) and comments at lines 98-101 document SCROLL_WS_URL, SCROLL_RPC_URL, BLAST_WS_URL, BLAST_RPC_URL as needed secrets. But `setup_l2_fast_secrets()` only prompts for Arbitrum, Optimism, and Base URLs. Scroll and Blast would have no RPC endpoints, causing connection failures for 2/5 chains. | Bug-Hunter, Config-Fidelity | HIGH (95%) | Add 4 additional `read -rs` prompts and include in `fly secrets set` command for SCROLL_WS_URL, SCROLL_RPC_URL, BLAST_WS_URL, BLAST_RPC_URL. | 4.6 |
| 3 | Network Security | `docker/docker-compose.partition.yml` Redis service | **Redis exposed to network without IP restriction.** Redis port mapping is `"6379:6379"` (binds to 0.0.0.0) combined with `--bind 0.0.0.0` command flag. In contrast, `docker-compose.yml` correctly uses `"127.0.0.1:6379:6379"`. Any host on the network can connect to Redis on port 6379. Combined with default password `"changeme"`, this is a direct attack vector. | Security, Bug-Hunter | HIGH (92%) | Change to `"127.0.0.1:6379:6379"` or remove port exposure entirely (use Docker internal networking via service name `redis`). | 4.3 |
| 4 | Network Security | `oracle/terraform/variables.tf:169-178` | **SSH and service ports open to internet by default.** `admin_cidr_blocks` defaults to `["0.0.0.0/0"]` and `service_cidr_blocks` defaults to `["0.0.0.0/0"]`. Comments say "OVERRIDE in terraform.tfvars" but defaults should be safe. If someone runs `terraform apply` without a tfvars file, all instances get SSH and health check ports open to the entire internet. | Security | HIGH (95%) | Remove defaults entirely (force user to provide values) or use a private/restrictive default like `["10.0.0.0/8"]`. | 4.3 |

---

## High Findings (P1 — Fix in Next Sprint)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 5 | Config Drift | `fly/partition-l2-fast.toml:29` vs `docker/docker-compose.partition.yml` | **L2-fast chain assignment mismatch across platforms.** Fly.io: `arbitrum,optimism,base,scroll,blast` (5 chains). Docker partition: `arbitrum,optimism,base` (3 chains). Docker testnet: `arbitrum,base` (2 chains, intentional subset). Terraform: not deployed as l2-fast. Different chains would be monitored depending on deployment target. | Architecture, Config-Fidelity, Test-Quality | HIGH (95%) | Decide canonical chain list. If Scroll/Blast are operational (per CLAUDE.md), update Docker partition compose to include them. | 3.7 |
| 6 | Config Drift | `fly/partition-l2-fast.toml:55` vs `docker/docker-compose.partition.yml` vs `tests/deployment-config.test.ts:119` | **L2-fast memory allocation 3-way mismatch.** Fly TOML: 640MB. Docker partition compose: 512MB limit. deployment-config.test.ts: expects 384MB. Additionally, the TOML scaling comment (line 16) says `fly scale memory 384` contradicting the actual value of 640. The test would FAIL against the current TOML. | Architecture, Config-Fidelity, Test-Quality | HIGH (95%) | Align all to 640MB (the production value for 5-chain workload). Update test and scaling comment. | 3.7 |
| 7 | Secret Management | `env.example` (entire file) | **STREAM_SIGNING_KEY missing from env.example.** This HMAC key for Redis Streams message signing is a critical security feature (per CLAUDE.md). It appears in ALL 7 Fly deploy.sh secret setups but is absent from `env.example`. New developers won't know to set it. Also missing: SCROLL_*/BLAST_* RPC URLs. | Security, Config-Fidelity | HIGH (90%) | Add `STREAM_SIGNING_KEY=` and `SCROLL_WS_URL=`, `SCROLL_RPC_URL=`, `BLAST_WS_URL=`, `BLAST_RPC_URL=` to env.example. | 3.4 |
| 8 | Config Drift | Multiple files | **Cross-chain detector port inconsistency (4 different values).** Fly TOML: internal_port=3006, HEALTH_CHECK_PORT=3006. Docker partition.yml: maps to 3016:3001. Docker testnet: maps to 3016:3001. health-check.sh: checks port 3014. failover.sh: uses port 3014. Terraform outputs.tf: health URL at :3014. CLAUDE.md: says port 3006. Four different port values across the codebase. | Architecture, Config-Fidelity | HIGH (90%) | Standardize on one external port (suggest 3006 per CLAUDE.md) and internal port (3001 or 3006). Update all references. | 3.7 |
| 9 | Config Drift | `fly/coordinator.toml:66` vs `docker/docker-compose.yml` | **Coordinator health check path inconsistency.** Fly TOML checks `/api/health` (line 66, with comment: "coordinator uses Express with '/api' prefix"). Docker compose checks `/health` (via node -e script: `http://localhost:3000/health`). GCP coordinator-standby.yaml checks `/health`. If the coordinator actually uses `/api/health`, Docker health checks would fail. | Architecture | MEDIUM (80%) | Verify actual coordinator code path. Standardize across all configs. | 3.4 |
| 10 | Config Drift | `fly/execution-engine.toml:35` vs Docker configs | **Execution engine port inconsistency.** Fly TOML: HEALTH_CHECK_PORT=8080, internal_port=8080 (comment: "overrides code default of 3005"). Docker: uses 3001 internally, maps to 3015 externally. health-check.sh: checks port 3015. CLAUDE.md: says port 3005. Three different values depending on platform. | Architecture, Config-Fidelity | MEDIUM (80%) | Standardize port. If Fly deliberately uses 8080, document why. Update health-check.sh to match deployment target. | 3.1 |
| 11 | Config Drift | `oracle/redis/redis-production.conf` | **Redis production config file not referenced by any Docker compose.** The carefully tuned `redis-production.conf` (slowlog, io-threads, lazy eviction, dangerous command disabling, 512mb memory) exists but ALL Docker compose files use inline flags only: `--appendonly yes --maxmemory 256mb --requirepass`. The Oracle cloud-init scripts embed their OWN redis.conf copies. The standalone file is dead configuration. | Architecture, Performance | MEDIUM (85%) | Either: (a) Reference redis-production.conf from Docker compose files via volume mount, or (b) Delete the standalone file and maintain only the embedded copies. | 3.1 |

---

## Medium Findings (P2 — Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 12 | Config Drift | Docker compose files | **Redis maxmemory discrepancy.** docker-compose.yml: 256mb. docker-compose.partition.yml: 256mb limit but services have 512-768MB container limits. docker-compose.testnet.yml: 128mb. redis-production.conf: 512mb. cloud-init partition: 512mb. cloud-init cross-chain: 256mb. No single source of truth. | Config-Fidelity | MEDIUM (85%) | Define Redis memory per deployment tier (dev: 128mb, testnet: 128mb, partition prod: 512mb, cross-chain prod: 256mb). | 2.8 |
| 13 | Security | `docker/docker-compose.partition.yml` | **REDIS_PASSWORD defaults to "changeme".** Uses `${REDIS_PASSWORD:-changeme}` providing a weak default. docker-compose.testnet.yml correctly uses `${REDIS_PASSWORD:?REDIS_PASSWORD must be set}` (no default, fails if missing). Partition compose should match testnet's approach. | Security | HIGH (90%) | Change to `${REDIS_PASSWORD:?REDIS_PASSWORD must be set}` to force explicit configuration. | 2.8 |
| 14 | Duplication | `grafana/` and `monitoring/` | **Duplicate monitoring locations.** `infrastructure/monitoring/grafana-dashboard.json` is a comprehensive production dashboard. `infrastructure/grafana/dashboards/` contains simulation-metrics.json and warming-infrastructure.json. `infrastructure/grafana/provisioning/alert-rules.yml` overlaps with `infrastructure/monitoring/alert-rules.yml` (different alert sets but same format in different locations). Confusing which is canonical. | Architecture, Performance | MEDIUM (85%) | Consolidate into one location (recommend `infrastructure/monitoring/` for production, `infrastructure/grafana/` for setup automation). Document the split. | 2.5 |
| 15 | Operational Gap | infrastructure/ (global) | **No CI/CD pipeline configurations.** No .github/workflows, GitLab CI, CircleCI, or any pipeline config. No automated terraform plan/apply. No automated config validation. No rollback mechanism in deploy.sh. Deployment is entirely manual. | Performance | MEDIUM (75%) | Add GitHub Actions workflows for: (a) config validation on PR, (b) Fly.io deployment on merge, (c) Terraform plan on PR. | 2.5 |
| 16 | Config Drift | `oracle/terraform/scripts/cloud-init-cross-chain.yaml` | **Cross-chain Redis config missing io-threads.** Partition cloud-init has `io-threads 2` and `io-threads-do-reads yes` (for ARM instances). Cross-chain cloud-init (for AMD E2.1.Micro) omits io-threads entirely. While this might be intentional (AMD micro has only 1/8 OCPU), it's undocumented. | Config-Fidelity | LOW (60%) | Add a comment explaining why io-threads is omitted for AMD micro, or add `io-threads 1` explicitly. | 2.2 |
| 17 | Documentation | `fly/partition-l2-fast.toml:16` | **Stale scaling comment.** Line 16 says `fly scale memory 384` but line 55 has `memory_mb = 640`. The comment would downgrade memory if followed. | Bug-Hunter | HIGH (95%) | Update comment to `fly scale memory 640`. | 2.5 |
| 18 | Performance | `fly/deploy.sh:618-626` | **Serial deployment in deploy_all.** The `all` case deploys 7 services sequentially. Partitions (l2-fast, high-value, asia-fast, solana) are independent and could deploy in parallel. Estimated savings: 60-70% of deployment time. | Performance | MEDIUM (75%) | Use `&` background processes for parallel partition deployment, then `wait` before deploying execution-engine. | 2.2 |
| 19 | Security | `oracle/redis/redis-production.conf:107` | **Redis CONFIG command renamed but not disabled.** `rename-command CONFIG "ARBITRAGE_CONFIG"` — an attacker with Redis access could still modify runtime config (change maxmemory, disable persistence, etc.) using the renamed command. | Security | MEDIUM (70%) | Consider disabling CONFIG entirely (`rename-command CONFIG ""`) or restricting Redis ACLs. | 2.2 |

---

## Low Findings (P3 — Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 20 | DRY | `fly/*.toml` (6 files) | **6 nearly identical Fly TOML files.** Each partition TOML (~100 lines) differs only in: app name, region, partition_id, chains, port, memory_mb. ~600 LOC total could be reduced to ~100 LOC with a template + generation script. | Performance | HIGH (90%) | Create a TOML template with placeholders and a generation script (e.g., `generate-fly-configs.sh`). | 2.0 |
| 21 | DRY | `fly/deploy.sh` (secret functions) | **8 repetitive secret setup functions.** Each follows identical pattern: prompt for REDIS_URL + STREAM_SIGNING_KEY + service-specific URLs, call `fly secrets set`, unset variables. ~370 LOC could be ~80 with parameterization. | Performance | HIGH (90%) | Create `setup_secrets(app_name, config_file, ...url_vars)` generic function. | 2.0 |
| 22 | Incomplete | `grafana/setup-grafana.sh:253-279` | **Notification channel creation is stub code.** `create_notification_channels()` has placeholder comments ("Implementation would go here") for PagerDuty and Slack. Function exists but doesn't actually create channels. | Test-Quality | HIGH (90%) | Either implement the channel creation via Grafana API or remove the function and document manual setup. | 1.7 |
| 23 | Naming | `fly/partition-l2-fast.toml` filename vs `PARTITION_ID = "l2-turbo"` | **L2-fast vs l2-turbo naming inconsistency.** File is named `partition-l2-fast.toml`, app name is `arbitrage-l2-fast`, but PARTITION_ID is `l2-turbo`. Header comment explains "file named l2-fast for historical reasons" but this causes confusion in deploy.sh (uses `l2-fast` as service name) vs runtime (service identifies as `l2-turbo`). | Architecture | MEDIUM (85%) | Either rename files to l2-turbo or change PARTITION_ID to l2-fast. Prefer renaming files since PARTITION_ID is used at runtime. | 1.7 |

---

## Test Coverage Matrix

| Source File | Tested By | Happy Path | Error Path | Cross-Platform | Notes |
|-------------|-----------|------------|------------|----------------|-------|
| fly/coordinator.toml | deployment-config.test.ts | Yes | No | No | Health path not validated against Docker |
| fly/coordinator-standby.toml | deployment-config.test.ts | Yes | No | No | |
| fly/execution-engine.toml | deployment-config.test.ts | Yes | No | No | |
| fly/partition-l2-fast.toml | deployment-config.test.ts | **FAILING** | No | No | Test expects 384MB, actual 640MB |
| fly/partition-asia-fast.toml | deployment-config.test.ts | Yes | No | No | |
| fly/partition-high-value.toml | deployment-config.test.ts | Yes | No | No | |
| fly/partition-solana.toml | deployment-config.test.ts | Yes | No | No | |
| fly/cross-chain-detector.toml | deployment-config.test.ts | Yes | No | No | |
| fly/deploy.sh | **NONE** | No | No | No | No test coverage |
| docker/docker-compose.yml | deployment-config.test.ts | Partial | No | No | |
| docker/docker-compose.partition.yml | deployment-config.test.ts | Partial | No | No | |
| docker/docker-compose.testnet.yml | regression.test.ts (RT3) | Partial | No | No | |
| oracle/terraform/main.tf | regression.test.ts (RT4) | Yes | No | No | |
| oracle/terraform/variables.tf | **NONE** | No | No | No | |
| oracle/terraform/outputs.tf | **NONE** | No | No | No | |
| oracle/terraform/scripts/*.yaml | regression.test.ts (RT4) | Yes | No | No | |
| oracle/redis/redis-production.conf | **NONE** | No | No | No | |
| monitoring/alert-rules.yml | **NONE** | No | No | No | |
| grafana/**/* | **NONE** | No | No | No | Zero test coverage |
| scripts/health-check.sh | regression.test.ts (RT1) | Partial | No | No | |
| scripts/failover.sh | regression.test.ts (RT1) | Partial | No | No | |
| scripts/lib/health-utils.sh | regression.test.ts (RT1) | Partial | No | No | |
| env.example | regression.test.ts (RT5) | Yes | No | No | |
| gcp/*.* | **NONE** | No | No | No | Zero test coverage |

**Key Test Gaps:**
- No cross-platform consistency tests (ports in Fly TOML match Docker match health-check.sh)
- No YAML/TOML syntax validation tests
- No Terraform variable completeness tests
- No PromQL expression validation for alert rules
- No negative tests (malformed config, missing sections)
- deployment-config.test.ts has at least 1 known failing assertion (L2-fast memory)

---

## Config Fidelity Matrices

### Chain-to-Partition Assignment Matrix

| Partition | Fly.io TOML | Docker Partition | Docker Testnet | Terraform vars | env.example |
|-----------|-------------|------------------|----------------|----------------|-------------|
| l2-turbo/l2-fast | arbitrum, optimism, base, **scroll, blast** | arbitrum, optimism, base | arbitrum, base | N/A | N/A |
| asia-fast | bsc, polygon, avalanche, fantom | bsc, polygon, avalanche, fantom | N/A (omitted) | bsc, polygon, avalanche, fantom | N/A |
| high-value | ethereum, zksync, linea | ethereum, zksync, linea | ethereum, zksync | ethereum, zksync, linea | N/A |
| solana | solana | solana | N/A (omitted) | N/A | N/A |

**MISMATCH: L2-fast has 5 chains on Fly, 3 on Docker.**

### Port Assignment Matrix

| Service | Fly Internal | Fly Health Path | Docker Internal | Docker External | health-check.sh | CLAUDE.md |
|---------|-------------|-----------------|-----------------|-----------------|-----------------|-----------|
| Coordinator | 3000 | /api/health | 3000 | 3000 | 3000 (/health) | 3000 |
| L2-fast | 3002 | /health | 3001 | 3012 | 3012 | 3002 |
| Asia-fast | 3001 | /health | 3001 | 3011 | 3011 | 3001 |
| High-value | 3003 | /health | 3001 | 3013 | 3013 | 3003 |
| Solana | 3004 | /health | 3001 | 3014 | 3016 | 3004 |
| Execution | **8080** | /health | 3001 | 3015 | 3015 | 3005 |
| Cross-chain | **3006** | /health | 3001 | **3016** | **3014** | 3006 |
| Coordinator-standby | 3000 | /api/health | N/A | N/A | N/A | N/A |

**MISMATCHES: Execution engine Fly port (8080), cross-chain (3 different external ports), coordinator health path (/api/health vs /health), Solana health-check.sh port (3016 vs Docker 3014).**

### Memory Allocation Matrix

| Service | Fly.io MB | Docker Limit | Docker Reservation | Terraform/Cloud-init |
|---------|-----------|-------------|-------------------|---------------------|
| Coordinator | 256 | N/A | N/A | N/A |
| Coordinator-standby | 256 | N/A | N/A | N/A |
| L2-fast | **640** | **512** | 256 | N/A |
| Asia-fast | 768 | 768 | 384 | 768 (via var) |
| High-value | 768 | 768 | 384 | 768 (via var) |
| Solana | 384 | 384 | 192 | N/A |
| Execution | 384 | N/A | N/A | N/A |
| Cross-chain | 256 | N/A | N/A | 384 (cloud-init) |

**MISMATCH: L2-fast 640 vs 512. Cross-chain 256 (Fly) vs 384 (cloud-init).**

---

## Cross-Agent Insights

1. **Finding #2 explains Finding #5**: The L2-fast secrets setup (Finding #2) only handles 3 chains because it was written when L2-fast only had 3 chains. The TOML was later updated to 5 chains (Finding #5) but the deploy script and Docker config were not updated simultaneously. This is a config drift cascade.

2. **Finding #3 amplified by Finding #13**: Redis exposed to network (Finding #3) combined with weak default password "changeme" (Finding #13) creates a compounding vulnerability. Either issue alone is concerning; together they are critical.

3. **Finding #8 reflects Finding #1**: The cross-chain detector port chaos (Finding #8) exists partly because the service was never integrated into the deployment automation (Finding #1). Without a single deploy function establishing canonical port values, each config was written independently.

4. **Finding #11 explains Finding #12**: The redis-production.conf not being used (Finding #11) means Redis config is duplicated in 5 locations (3 Docker compose files + 2 cloud-init scripts) with no single source of truth, causing the maxmemory discrepancy (Finding #12).

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before any deployment)
- [ ] **Fix #1**: Add `deploy_cross_chain()` and `setup_cross_chain_secrets()` to `fly/deploy.sh`, include in `deploy_all`
- [ ] **Fix #2**: Add SCROLL_WS_URL, SCROLL_RPC_URL, BLAST_WS_URL, BLAST_RPC_URL to `setup_l2_fast_secrets()`
- [ ] **Fix #3**: Change `docker-compose.partition.yml` Redis port to `"127.0.0.1:6379:6379"`
- [ ] **Fix #4**: Remove default from `admin_cidr_blocks` and `service_cidr_blocks` in `variables.tf` (force explicit values)

### Phase 2: Next Sprint (P1 — config alignment)
- [ ] **Fix #5**: Align L2-fast chain list across Fly TOML, Docker partition compose, and Docker env.partition.example
- [ ] **Fix #6**: Align L2-fast memory to 640MB across all configs and tests; fix stale scaling comment
- [ ] **Fix #7**: Add STREAM_SIGNING_KEY, SCROLL_*, BLAST_* to `env.example`
- [ ] **Fix #8**: Standardize cross-chain detector port across all 4 locations
- [ ] **Fix #9**: Verify coordinator health path in source code; standardize across Fly/Docker/GCP
- [ ] **Fix #10**: Document execution engine port override reason; standardize across platforms
- [ ] **Fix #11**: Either reference `redis-production.conf` from Docker compose or delete standalone file

### Phase 3: Backlog (P2/P3 — hardening)
- [ ] **Fix #13**: Change partition compose REDIS_PASSWORD to `${REDIS_PASSWORD:?must be set}`
- [ ] **Fix #14**: Consolidate monitoring config locations
- [ ] **Fix #15**: Add CI/CD pipeline for config validation + deployment
- [ ] **Fix #17**: Fix stale L2-fast scaling comment
- [ ] **Fix #18**: Parallelize partition deployments in deploy_all
- [ ] **Fix #20**: Create TOML template generation script
- [ ] **Fix #21**: Parameterize secret setup functions
- [ ] **Fix #23**: Resolve l2-fast vs l2-turbo naming

---

## Appendix: Alert Rules Coverage

### monitoring/alert-rules.yml (Production)
| Category | Alert Name | Severity | Status |
|----------|-----------|----------|--------|
| Service Health | ServiceDown | critical | OK |
| RPC | RPCRateLimitCritical/Warning | critical/warning | OK |
| Cache | CacheHitRateCritical/Warning | critical/warning | OK |
| Redis Streams | RedisStreamsBackpressureCritical/Warning | critical/warning | OK |
| DLQ | DLQGrowthRateCritical/Warning | critical/warning | OK |
| Circuit Breaker | CircuitBreakerOpen | critical | OK |
| Execution | ExecutionWinRateCritical/Warning | critical/warning | OK |
| Gas | GasPriceCritical/Warning | critical/warning | OK |
| Memory | HighMemoryUsage/Warning | critical/warning | OK |
| Detection | LowOpportunityDetectionRate | warning | OK |
| Capacity | CacheCapacityGrowing | info | OK |
| Latency | DetectionLatencyIncreasing | info | OK |
| Volume | LowTradingVolume | info | OK |
| RPC Health | RPCProviderDegraded | info | OK |

**Missing alert categories:**
- No unauthorized access/failed auth alerts
- No deployment event alerts
- No Redis connection failure alert (distinct from ServiceDown)
- No cross-chain bridge failure alert
- No nonce management error alert

### grafana/provisioning/alert-rules.yml (Warming Infrastructure)
Covers: correlation tracking latency, warming operations latency, warming error rate, cache hit rate, memory growth, pair tracking capacity. Well-structured with 3 severity tiers (critical > warning > info) and capacity planning rules.

---

*Report generated by infrastructure deep analysis team. 36 files analyzed across 8 subdirectories.*
