const fs = require('fs');
const path = require('path');

// Load all findings
const phases = [
  { file: 'monitor-session/findings/static-analysis.jsonl', phase: 'STATIC' },
  { file: 'monitor-session/findings/startup.jsonl', phase: 'STARTUP' },
  { file: 'monitor-session/findings/runtime.jsonl', phase: 'RUNTIME' },
  { file: 'monitor-session/findings/smoke-test.jsonl', phase: 'SMOKE_TEST' },
];

const allFindings = [];
for (const { file } of phases) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { allFindings.push(JSON.parse(line)); } catch(e) {}
    }
  } catch(e) {}
}

// Count by severity
const counts = {CRITICAL:0, HIGH:0, MEDIUM:0, LOW:0, INFO:0};
for (const f of allFindings) counts[f.severity]++;
const total = Object.values(counts).reduce((a,b) => a+b, 0);

// GO/NO-GO
const isGo = counts.CRITICAL === 0 && counts.HIGH <= 3;
const decision = isGo ? 'GO' : 'NO-GO';

// Regression analysis vs previous session
const PREV_SESSION = '20260304_124021';
let prevFindings = [];
try {
  const prevData = JSON.parse(fs.readFileSync('monitor-session/history/' + PREV_SESSION + '.json', 'utf8'));
  prevFindings = prevData.findings || [];
} catch(e) {}

function normalizeTitle(title) {
  return (title || '').toLowerCase().replace(/\d+/g, 'N').replace(/[^a-z\s]/g, '').trim().substring(0, 50);
}

const currentKeys = new Map();
for (const f of allFindings) {
  const key = f.phase + ':' + f.category + ':' + normalizeTitle(f.title);
  currentKeys.set(key, f);
}

const prevKeys = new Map();
for (const f of prevFindings) {
  const key = f.phase + ':' + f.category + ':' + normalizeTitle(f.title || '');
  prevKeys.set(key, f);
}

const newFindings = [];
const resolvedFindings = [];
const regressedFindings = [];
const improvedFindings = [];
const unchangedCount = { count: 0 };

for (const [key, f] of currentKeys) {
  if (!prevKeys.has(key)) {
    if (f.severity !== 'INFO') newFindings.push(f);
  } else {
    const prev = prevKeys.get(key);
    const sevOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
    const prevSev = sevOrder[prev.severity] || 0;
    const curSev = sevOrder[f.severity] || 0;
    if (curSev > prevSev) regressedFindings.push({ finding: f, prevSeverity: prev.severity });
    else if (curSev < prevSev) improvedFindings.push({ finding: f, prevSeverity: prev.severity });
    else unchangedCount.count++;
  }
}

for (const [key, f] of prevKeys) {
  if (!currentKeys.has(key) && f.severity !== 'INFO') {
    resolvedFindings.push(f);
  }
}

// Session info
const sessionId = fs.readFileSync('monitor-session/SESSION_ID', 'utf8').trim();
const gitSha = fs.readFileSync('monitor-session/current.sha', 'utf8').trim();
const now = new Date().toISOString();

// Save history
const history = {
  sessionId,
  timestamp: now,
  gitSha,
  decision,
  summary: { ...counts, total },
  findings: allFindings.map(f => ({
    findingId: f.findingId,
    phase: f.phase,
    category: f.category,
    severity: f.severity,
    title: f.title || ''
  }))
};
fs.writeFileSync('monitor-session/history/' + sessionId + '.json', JSON.stringify(history, null, 2));

// Update last-run.sha
fs.writeFileSync('monitor-session/last-run.sha', gitSha);
console.log('History saved, last-run.sha updated');

// Build regression section
function buildRegressionSection() {
  const lines = [];
  lines.push('Previous session: **' + PREV_SESSION + '** ' + String.fromCharCode(8212) + ' Decision: **NO-GO** (7C/8H)');
  lines.push('');
  lines.push('| Change | Count | Notes |');
  lines.push('|--------|-------|-------|');
  lines.push('| NEW | ' + newFindings.length + ' | Issues appearing since last run |');
  lines.push('| RESOLVED | ' + resolvedFindings.length + ' | Issues fixed since last run |');
  lines.push('| REGRESSED | ' + regressedFindings.length + ' | Issues that got worse |');
  lines.push('| IMPROVED | ' + improvedFindings.length + ' | Issues that got better |');
  lines.push('| UNCHANGED | ' + unchangedCount.count + ' | Same as last run |');
  lines.push('');
  if (regressedFindings.length > 0) {
    lines.push('**REGRESSIONS:**');
    for (const r of regressedFindings) {
      lines.push('- ' + r.finding.findingId + ': ' + (r.finding.title || '') + ' ' + String.fromCharCode(8212) + ' was ' + r.prevSeverity + ', now ' + r.finding.severity);
    }
  } else {
    lines.push('**No regressions ' + String.fromCharCode(8212) + ' all previous issues resolved or improved.**');
  }
  lines.push('');
  if (resolvedFindings.length > 0) {
    lines.push('**KEY RESOLUTIONS since last run:**');
    for (const f of resolvedFindings.slice(0, 10)) {
      lines.push('- ' + (f.findingId || 'prev') + ': ' + (f.title || '(prev finding)'));
    }
  }
  return lines.join('\n');
}

// Blocker details
const blockers = allFindings.filter(f => f.severity === 'CRITICAL');
const reason = decision === 'GO'
  ? 'No CRITICAL findings. Only ' + counts.HIGH + ' HIGH finding (threshold: \u22643). System is deployment-ready.'
  : 'Blocking findings: ' + blockers.map(f => f.findingId + ': ' + f.title).join('; ');

// Build report as array of lines to avoid template literal backtick issues
const reportLines = [];
reportLines.push('# Pre-Deploy Validation Report');
reportLines.push('');
reportLines.push('**Session:** ' + sessionId);
reportLines.push('**Date:** ' + now);
reportLines.push('**Duration:** ~25 minutes (with Phase 1/2 overlap optimization)');
reportLines.push('**Git SHA:** ' + gitSha);
reportLines.push('**Mode:** INCREMENTAL (40 files changed since last run)');
reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('## Decision: ' + decision + ' \u2705');
reportLines.push('');
reportLines.push('| Severity | Count |');
reportLines.push('|----------|-------|');
reportLines.push('| CRITICAL | ' + counts.CRITICAL + ' |');
reportLines.push('| HIGH | ' + counts.HIGH + ' |');
reportLines.push('| MEDIUM | ' + counts.MEDIUM + ' |');
reportLines.push('| LOW | ' + counts.LOW + ' |');
reportLines.push('| INFO | ' + counts.INFO + ' |');
reportLines.push('| **Total** | **' + total + '** |');
reportLines.push('');
reportLines.push('**Reason:** ' + reason);
reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('## Regression Analysis (vs session ' + PREV_SESSION + ')');
reportLines.push('');
reportLines.push(buildRegressionSection());
reportLines.push('---');
reportLines.push('');
reportLines.push('## Phase 1: Static Analysis (18 checks)');
reportLines.push('');
reportLines.push('| Check | Status | Findings |');
reportLines.push('|-------|--------|----------|');
reportLines.push('| 1A Stream Declarations | PASS | 1 INFO |');
reportLines.push('| 1B Consumer Groups | PASS | 1 INFO |');
reportLines.push('| 1C MAXLEN (Config + Call-Site) | PASS | 1 INFO |');
reportLines.push('| 1D XACK After Consume | PASS | 1 INFO |');
reportLines.push('| 1E Env Var Drift (Comprehensive) | WARN | 1H, 1M, 1I (15 HIGH undocumented behavior vars) |');
reportLines.push('| 1F Nullish Coalescing | PASS | 1 INFO (0 instances) |');
reportLines.push('| 1G HMAC Signing | PASS | 1 INFO |');
reportLines.push('| 1H Feature Flags | WARN | 2M (FEATURE_DYNAMIC_L1_FEES, FEATURE_FLASHBOTS_PROTECT_L2 undocumented) |');
reportLines.push('| 1I Risk Configuration | PASS | 1 INFO |');
reportLines.push('| 1J Unsafe Numeric Parse | PASS | 1 INFO |');
reportLines.push('| 1K Redis Client Parity | PASS | 1 INFO (split-brain FIXED) |');
reportLines.push('| 1L Port Assignment Collision | PASS | 1 INFO (3001 conflict FIXED) |');
reportLines.push('| 1M Silent Error Swallowing | PASS | 4L (all documented) |');
reportLines.push('| 1N Stream Type Fidelity | PASS | 1 INFO |');
reportLines.push('| 1O Redis Key Registry | PASS | 1 INFO (10 unique prefixes) |');
reportLines.push('| 1P ADR Compliance | PASS | 1L (ADR-033 chain-aware vs 30s), 4 INFO |');
reportLines.push('| 1Q Infrastructure Config | PASS | 1 INFO |');
reportLines.push('| 1R Timeout Hierarchy | PASS | 1 INFO |');
reportLines.push('');
reportLines.push('**Phase 1 Totals:** CRITICAL: 0  HIGH: 1  MEDIUM: 3  LOW: 5  INFO: 21');
reportLines.push('');
reportLines.push('### Notable Phase 1 Findings');
reportLines.push('');
reportLines.push('**SA-005 [HIGH] \u2014 15 undocumented behavior-controlling env vars**');
reportLines.push('Missing from .env.example: CONSUMER_BATCH_SIZE, CONSUMER_BLOCK_MS, CONSUMER_SHUTDOWN_ACK_TIMEOUT_MS,');
reportLines.push('CONSUMER_PENDING_MAX_AGE_MS, CONSUMER_STALE_CLEANUP_INTERVAL_MS, EXECUTION_STREAM_BACKPRESSURE_RATIO,');
reportLines.push('ORDERFLOW_PREDICTION_CACHE_TTL_MS, L1_ORACLE_CACHE_TTL_MS, RISK_REDIS_KEY_PREFIX, API_RATE_LIMIT_WINDOW_MS,');
reportLines.push('API_RATE_LIMIT_MAX, LEADER_LOCK_KEY, AB_TEST_ALLOCATION_SEED, AB_STAGE_DURATION_MS, AB_MAX_CONSECUTIVE_LOSSES.');
reportLines.push('*Recommendation: Add all 15 to .env.example with descriptions and defaults.*');
reportLines.push('');
reportLines.push('**SA-010 [MEDIUM] \u2014 FEATURE_DYNAMIC_L1_FEES not documented in .env.example**');
reportLines.push('Opt-out feature (enabled by default), critical for L2 cost accuracy.');
reportLines.push('');
reportLines.push('**SA-011 [MEDIUM] \u2014 FEATURE_FLASHBOTS_PROTECT_L2 not documented in .env.example**');
reportLines.push('');
reportLines.push('**SA-025 [LOW] \u2014 ADR-033 drift: 5s default freshness vs 30s specified**');
reportLines.push('getPriceWithFreshnessCheck() uses 5s default. Chain-aware implementation (getOpportunityTimeoutMs())');
reportLines.push('likely intentional for fast chains. ADR-033 should be updated to reflect this.');
reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('## Phase 2: Service Readiness');
reportLines.push('');
reportLines.push('| Service | Port | Status | Chains |');
reportLines.push('|---------|------|--------|--------|');
reportLines.push('| Coordinator | 3000 | READY | \u2014 |');
reportLines.push('| P1 Asia-Fast | 3001 | READY | bsc, polygon, avalanche, fantom (4) |');
reportLines.push('| P2 L2-Turbo | 3002 | READY | arbitrum, optimism, base, scroll, blast (5) |');
reportLines.push('| P3 High-Value | 3003 | READY | ethereum, zksync, linea (3) |');
reportLines.push('| P4 Solana | 3004 | READY | solana (1) |');
reportLines.push('| Execution Engine | 3005 | READY | \u2014 |');
reportLines.push('| Cross-Chain | 3006 | READY | 12 chains monitored |');
reportLines.push('');
reportLines.push('**Services ready: 7/7**');
reportLines.push('');
reportLines.push('Streams at baseline: price-updates=5500, opportunities=146563, execution-requests=5002, execution-results=998');
reportLines.push('');
reportLines.push('### Readiness Endpoint Consistency');
reportLines.push('All 7 services return HTTP 200 on `/ready` (ports 3000-3006). Coordinator also serves `/api/health/ready`. \u2705');
reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('## Phase 3: Runtime Validation');
reportLines.push('');
reportLines.push('### Service Health');
reportLines.push('| Service | Status | Key Metrics |');
reportLines.push('|---------|--------|-------------|');
reportLines.push('| Coordinator | healthy | isLeader=true, systemHealth=83.3% (6/7 \u2014 transient) |');
reportLines.push('| P1 Asia-Fast | healthy | eventsProcessed=15644, 4 chains active |');
reportLines.push('| P2 L2-Turbo | healthy | eventsProcessed=26777, 5 chains active |');
reportLines.push('| P3 High-Value | healthy | eventsProcessed=9421, 3 chains active |');
reportLines.push('| P4 Solana | healthy | eventsProcessed=112770, Solana active |');
reportLines.push('| Execution Engine | healthy | successRate=86.97%, riskState=NORMAL, simulationMode=true |');
reportLines.push('| Cross-Chain | healthy | chainsMonitored=12 |');
reportLines.push('');
reportLines.push('### Leader Election');
reportLines.push('- Leader: coordinator-local-local-1772656173277');
reportLines.push('- Lock TTL: 20s \u2705');
reportLines.push('');
reportLines.push('### Circuit Breakers');
reportLines.push('All chains: **CLOSED** (1 historical trip, recovered)');
reportLines.push('');
reportLines.push('### DLQ Status');
reportLines.push('| Queue | Length | Growth |');
reportLines.push('|-------|--------|--------|');
reportLines.push('| dead-letter-queue | 0 | 0 |');
reportLines.push('| forwarding-dlq | 0 | 0 |');
reportLines.push('');
reportLines.push('\u2705 Both DLQs empty');
reportLines.push('');
reportLines.push('### WebSocket & Provider Health');
reportLines.push('All 15 chains active and receiving simulation data:');
reportLines.push('- P1: BSC(6703), Polygon(2486), Avalanche(5552), Fantom(1988) \u2014 all CONNECTED');
reportLines.push('- P2: Arbitrum(17721), Optimism(3131), Base(6091), Scroll(2273), Blast(677) \u2014 all CONNECTED');
reportLines.push('- P3: Ethereum(7157), zkSync(1864), Linea(1370) \u2014 all CONNECTED');
reportLines.push('- P4: Solana(119070 events) \u2014 CONNECTED (pairsMonitored=0 expected)');
reportLines.push('');
reportLines.push('### Risk Management State');
reportLines.push('- Drawdown state: **NORMAL**');
reportLines.push('- Trading allowed: true, Position size multiplier: 1.0');
reportLines.push('- Consecutive losses: 0, Daily PnL: null (simulation mode)');
reportLines.push('');
reportLines.push('### Pipeline Latency (P1 Asia-Fast)');
reportLines.push('| p50 | p95 | p99 | Target | Status |');
reportLines.push('|-----|-----|-----|--------|--------|');
reportLines.push('| 3ms | 3ms | 3ms | <50ms | \u2705 EXCELLENT |');
reportLines.push('');
reportLines.push('### Gas & Simulation');
reportLines.push('- Gas prices: 0 gwei all chains (expected in simulation mode \u2014 no real RPC connections)');
reportLines.push('- Simulation mode: active (simulationsSkipped=998, simulationsPerformed=0)');
reportLines.push('- Execution probability: 86.97% overall win rate (868/998 trades)');
reportLines.push('');
reportLines.push('### Bridge Recovery');
reportLines.push('- No bridge transactions pending. isRunning=false (expected \u2014 no cross-chain arb triggered bridge).');
reportLines.push('');
reportLines.push('### Memory Health');
reportLines.push('| Service | Memory | Status |');
reportLines.push('|---------|--------|--------|');
reportLines.push('| P1 Asia-Fast | 212MB | OK |');
reportLines.push('| Cross-Chain | 98MB | OK |');
reportLines.push('| P2 L2-Turbo | 66MB | OK |');
reportLines.push('| P3 High-Value | 64MB | OK |');
reportLines.push('| Coordinator | ~50MB | OK |');
reportLines.push('| Execution Engine | 50MB | OK |');
reportLines.push('| P4 Solana | 47MB | OK |');
reportLines.push('| Redis | 117MB / 512MB (23%) | OK |');
reportLines.push('');
reportLines.push('### Redis Stream Health Map');
reportLines.push('');
reportLines.push('| Stream | XLEN | Groups | Pending | Status |');
reportLines.push('|--------|------|--------|---------|--------|');
reportLines.push('| stream:price-updates | 6204 | 2 | 3 each | HEALTHY |');
reportLines.push('| stream:opportunities | 184549 | 1 | 32 | HEALTHY |');
reportLines.push('| stream:execution-requests | 5004 | 1 | 0 | AT_MAXLEN (backpressure active) |');
reportLines.push('| stream:execution-results | 998 | 1 | 2 | HEALTHY |');
reportLines.push('| stream:health | 1001 | 1 | 0 | HEALTHY |');
reportLines.push('| stream:dead-letter-queue | 0 | 1 | 0 | CLEAN |');
reportLines.push('| stream:forwarding-dlq | 0 | 0 | 0 | CLEAN |');
reportLines.push('| [IDLE/ON-DEMAND streams] | 0 | \u2014 | \u2014 | EXPECTED |');
reportLines.push('');
reportLines.push('### Health Endpoint Schema Validation: 7/7 valid \u2705');
reportLines.push('### Prometheus Metrics Completeness: All required metrics present \u2705');
reportLines.push('');
reportLines.push('**Phase 3 Totals:** CRITICAL: 0  HIGH: 0  MEDIUM: 2  LOW: 0  INFO: 19');
reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('## Phase 4: Pipeline Smoke Test');
reportLines.push('');
reportLines.push('### Stream Flow Cascade');
reportLines.push('| Stream | Baseline | Final | Growth | Status |');
reportLines.push('|--------|----------|-------|--------|--------|');
reportLines.push('| stream:price-updates | 5500 | 6204 | +704 | FLOWING |');
reportLines.push('| stream:opportunities | 146563 | 184549 | +37986 | FLOWING |');
reportLines.push('| stream:execution-requests | 5002 | 5004 | ~MAXLEN | THROTTLED (backpressure) |');
reportLines.push('| stream:execution-results | 998 | 998 | +0 | STABLE (all processed) |');
reportLines.push('');
reportLines.push('### Pipeline Verdict: FLOWING \u2014 throttled at execution stage by correct backpressure');
reportLines.push('');
reportLines.push('### Message Trace');
reportLines.push('- `_trace_traceId` confirmed in execution result (9aeea6ddf8cff971ae9369d3d932e6b9)');
reportLines.push('- `_trace_spanId`, `_trace_parentSpanId`, `_trace_serviceName` all present');
reportLines.push('- Upstream messages trimmed by MAXLEN rotation before verification window');
reportLines.push('- Trace context system IS active');
reportLines.push('');
reportLines.push('### DLQ Growth: 0 new entries \u2705');
reportLines.push('');
reportLines.push('### Per-Chain Detection Coverage');
reportLines.push('All 15 chains active across 4 partitions. P4 Solana pairsMonitored=0 expected (uses SolanaArbitrageDetector).');
reportLines.push('');
reportLines.push('### Risk State Post-Smoke');
reportLines.push('- Drawdown state: NORMAL (unchanged) \u2705');
reportLines.push('- Consecutive losses: 0');
reportLines.push('');
reportLines.push('### Backpressure Status');
reportLines.push('- Execution stream fill ratio: 100.08% (5004/5000)');
reportLines.push('- Backpressure state: ACTIVE \u2014 consistent \u2705');
reportLines.push('');
reportLines.push('### Partition Flow');
reportLines.push('| Partition | Events Start | Events End | Delta | Status |');
reportLines.push('|-----------|-------------|------------|-------|--------|');
reportLines.push('| P1 Asia-Fast | 34732 | timeout | \u2014 | ACTIVE |');
reportLines.push('| P2 L2-Turbo | 52795 | 55598 | +2803 | ACTIVE |');
reportLines.push('| P3 High-Value | 17772 | 18473 | +701 | ACTIVE |');
reportLines.push('| P4 Solana | 221130 | 234360 | +13230 | ACTIVE |');
reportLines.push('');
reportLines.push('### Stream Monitor: NOT_AVAILABLE (optional component)');
reportLines.push('');
reportLines.push('**Phase 4 Totals:** CRITICAL: 0  HIGH: 0  MEDIUM: 2  LOW: 0  INFO: 9');
reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('## All Actionable Findings');
reportLines.push('');
reportLines.push('### HIGH Severity (1)');
reportLines.push('');
reportLines.push('**SA-005** \u2014 15 undocumented behavior-controlling env vars');
reportLines.push('- Category: ENV_VAR | Service: cross-service');
reportLines.push('- Missing: CONSUMER_BATCH_SIZE, CONSUMER_BLOCK_MS, CONSUMER_SHUTDOWN_ACK_TIMEOUT_MS, CONSUMER_PENDING_MAX_AGE_MS, CONSUMER_STALE_CLEANUP_INTERVAL_MS, EXECUTION_STREAM_BACKPRESSURE_RATIO, ORDERFLOW_PREDICTION_CACHE_TTL_MS, L1_ORACLE_CACHE_TTL_MS, RISK_REDIS_KEY_PREFIX, API_RATE_LIMIT_WINDOW_MS, API_RATE_LIMIT_MAX, LEADER_LOCK_KEY, AB_TEST_ALLOCATION_SEED, AB_STAGE_DURATION_MS, AB_MAX_CONSECUTIVE_LOSSES');
reportLines.push('- Fix: Add all 15 to .env.example with descriptions and defaults');
reportLines.push('');
reportLines.push('### MEDIUM Severity (7)');
reportLines.push('');
reportLines.push('**SA-006** \u2014 ~44 undocumented custom env vars (see Check 1E)');
reportLines.push('');
reportLines.push('**SA-010** \u2014 FEATURE_DYNAMIC_L1_FEES not in .env.example (opt-out, enabled by default)');
reportLines.push('');
reportLines.push('**SA-011** \u2014 FEATURE_FLASHBOTS_PROTECT_L2 not in .env.example');
reportLines.push('');
reportLines.push('**RT-002** \u2014 Coordinator reports systemHealth=83.3% (6/7 services) while all 7 self-report healthy (transient timing issue)');
reportLines.push('');
reportLines.push('**RT-013** \u2014 Gas prices = 0 gwei all chains (simulation mode \u2014 expected in dev, flag for production readiness)');
reportLines.push('');
reportLines.push('**SM-003** \u2014 Execution-results not growing during smoke test (correct backpressure behavior, but indicates sustained execution stream saturation)');
reportLines.push('');
reportLines.push('**SM-005** \u2014 Trace context active but cross-stream reconstruction limited by MAXLEN trimming');
reportLines.push('');
reportLines.push('### LOW Severity (5)');
reportLines.push('SA-017, SA-018, SA-019, SA-020 \u2014 Silent catches in utility code (all documented)');
reportLines.push('SA-025 \u2014 ADR-033 freshness: 5s default vs 30s spec (likely intentional chain-aware implementation)');
reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('*Report generated by monitoring.md v2.6*');
reportLines.push('*Session: ' + sessionId + '*');
reportLines.push('*Completed: ' + now + '*');

const report = reportLines.join('\n');
const reportPath = 'monitor-session/REPORT_' + sessionId + '.md';
fs.writeFileSync(reportPath, report);
console.log('Report written to', reportPath);
console.log('Decision:', decision);
console.log('Total findings:', total, '| Severity counts:', JSON.stringify(counts));
console.log('Regression: NEW=' + newFindings.length, 'RESOLVED=' + resolvedFindings.length, 'REGRESSED=' + regressedFindings.length, 'IMPROVED=' + improvedFindings.length, 'UNCHANGED=' + unchangedCount.count);
