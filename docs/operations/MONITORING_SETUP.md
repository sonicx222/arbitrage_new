# Monitoring Setup Guide

Complete guide for deploying production monitoring for the arbitrage trading system.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
  - [Prometheus Setup](#prometheus-setup)
  - [Grafana Setup](#grafana-setup)
  - [Alertmanager Setup](#alertmanager-setup)
- [Metrics Reference](#metrics-reference)
- [Alert Thresholds](#alert-thresholds)
- [Dashboard Guide](#dashboard-guide)
- [Incident Response](#incident-response)
- [Troubleshooting](#troubleshooting)

## Overview

The monitoring stack provides comprehensive observability for the arbitrage system:

- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization dashboards
- **Alertmanager**: Alert routing and notification management

### Key Metrics Monitored

1. **System Health**: Service uptime, error rates, circuit breakers
2. **RPC Performance**: Call rates, cache hit ratios, provider health
3. **Redis Streams**: Backpressure, DLQ growth, message processing
4. **Arbitrage Performance**: Detection rates, execution win rates, profitability
5. **Gas & Costs**: Gas prices, transaction costs, net profit

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Arbitrage Services                          │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │Coordinator│  │ Detectors │  │ Execution │  │Cross-Chain│  │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
│        │              │              │              │          │
│        └──────────────┴──────────────┴──────────────┘          │
│                       │                                         │
│                  /metrics endpoint                              │
└───────────────────────┼─────────────────────────────────────────┘
                        │
                        ▼
           ┌────────────────────────┐
           │     Prometheus         │
           │  - Scrapes metrics     │
           │  - Stores time series  │
           │  - Evaluates alerts    │
           └───────┬────────────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
         ▼                   ▼
┌────────────────┐  ┌─────────────────┐
│  Alertmanager  │  │     Grafana     │
│ - Routes alerts│  │  - Dashboards   │
│ - Deduplicates │  │  - Visualization│
│ - Notifies     │  │  - Queries      │
└────────┬───────┘  └─────────────────┘
         │
         ▼
┌─────────────────────┐
│  Notifications      │
│ - PagerDuty (P1)   │
│ - Slack (P2/P3)    │
│ - Email            │
└─────────────────────┘
```

## Prerequisites

### Software Requirements

- Docker & Docker Compose (recommended) OR native installation
- Node.js >= 22.0.0 (for service metrics exposition)
- Network access between monitoring stack and services

### Service Requirements

Each service exposes Prometheus metrics at its own endpoint:

```bash
# Coordinator (Express app — metrics at /api/metrics/prometheus)
curl http://localhost:3000/api/metrics/prometheus

# Execution Engine (createSimpleHealthServer — metrics at /metrics)
curl http://localhost:3005/metrics

# Partition Detectors have /health and /stats but no /metrics endpoint
# Scrape /stats for operational data or rely on OpenTelemetry export
```

### Access Requirements

- Grafana: Port 3000 (default) or configured port
- Prometheus: Port 9090 (default) or configured port
- Alertmanager: Port 9093 (default) or configured port

## Quick Start

### Using Docker Compose (Recommended)

1. **Create monitoring stack configuration**:

```bash
cd infrastructure/monitoring
cp docker-compose.example.yml docker-compose.yml
```

2. **Edit `docker-compose.yml`** with your configuration:

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    container_name: arbitrage-prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./alert-rules.yml:/etc/prometheus/alert-rules.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
    restart: unless-stopped

  alertmanager:
    image: prom/alertmanager:latest
    container_name: arbitrage-alertmanager
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - alertmanager-data:/alertmanager
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--storage.path=/alertmanager'
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    container_name: arbitrage-grafana
    ports:
      - "3001:3000"  # Note: Using 3001 to avoid conflict with coordinator
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=changeme
      - GF_INSTALL_PLUGINS=
    volumes:
      - ./grafana-dashboard.json:/etc/grafana/provisioning/dashboards/arbitrage.json
      - ./grafana-datasource.yml:/etc/grafana/provisioning/datasources/prometheus.yml
      - grafana-data:/var/lib/grafana
    depends_on:
      - prometheus
    restart: unless-stopped

volumes:
  prometheus-data:
  alertmanager-data:
  grafana-data:
```

3. **Create Prometheus configuration** (`prometheus.yml`):

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: 'arbitrage-production'
    environment: 'production'

# Alertmanager configuration
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

# Load alert rules
rule_files:
  - 'alert-rules.yml'

# Scrape configurations
scrape_configs:
  # Coordinator service (Express — metrics at /api/metrics/prometheus)
  - job_name: 'arbitrage-coordinator'
    static_configs:
      - targets: ['host.docker.internal:3000']
    metrics_path: '/api/metrics/prometheus'

  # Partition detectors (4 instances)
  - job_name: 'arbitrage-partition-asia'
    static_configs:
      - targets: ['host.docker.internal:3001']
    metrics_path: '/metrics'

  - job_name: 'arbitrage-partition-l2'
    static_configs:
      - targets: ['host.docker.internal:3002']
    metrics_path: '/metrics'

  - job_name: 'arbitrage-partition-high'
    static_configs:
      - targets: ['host.docker.internal:3003']
    metrics_path: '/metrics'

  - job_name: 'arbitrage-partition-solana'
    static_configs:
      - targets: ['host.docker.internal:3004']
    metrics_path: '/metrics'

  # Execution engine
  - job_name: 'arbitrage-execution'
    static_configs:
      - targets: ['host.docker.internal:3005']
    metrics_path: '/metrics'

  # Cross-chain detector
  - job_name: 'arbitrage-cross-chain'
    static_configs:
      - targets: ['host.docker.internal:3006']
    metrics_path: '/metrics'

  # Mempool detector (optional, port 3008)
  - job_name: 'arbitrage-mempool'
    static_configs:
      - targets: ['host.docker.internal:3008']
    metrics_path: '/metrics'

  # Prometheus self-monitoring
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
```

4. **Create Grafana datasource configuration** (`grafana-datasource.yml`):

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true
```

5. **Create Alertmanager configuration** (`alertmanager.yml`):

```yaml
global:
  resolve_timeout: 5m

# Templates for notifications
templates:
  - '/etc/alertmanager/templates/*.tmpl'

# Route tree for alerts
route:
  receiver: 'default'
  group_by: ['alertname', 'service', 'chain']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
    # Critical alerts → PagerDuty (immediate page)
    - match:
        severity: critical
      receiver: 'pagerduty'
      group_wait: 10s
      repeat_interval: 1h

    # Warning alerts → Slack (during business hours)
    - match:
        severity: warning
      receiver: 'slack-warnings'
      repeat_interval: 12h

    # Info alerts → Slack (daily digest)
    - match:
        severity: info
      receiver: 'slack-info'
      repeat_interval: 24h

# Notification receivers
receivers:
  - name: 'default'
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        channel: '#arbitrage-alerts'
        title: 'Alert: {{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'

  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: '${PAGERDUTY_SERVICE_KEY}'
        severity: '{{ .GroupLabels.severity }}'
        description: '{{ .GroupLabels.alertname }}: {{ .Annotations.summary }}'
        details:
          firing: '{{ template "pagerduty.default.instances" .Alerts.Firing }}'
          resolved: '{{ template "pagerduty.default.instances" .Alerts.Resolved }}'
          num_firing: '{{ .Alerts.Firing | len }}'
          num_resolved: '{{ .Alerts.Resolved | len }}'
        links:
          - href: '{{ .Annotations.dashboard_url }}'
            text: 'View Dashboard'
          - href: '{{ .Annotations.runbook_url }}'
            text: 'View Runbook'

  - name: 'slack-warnings'
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        channel: '#arbitrage-alerts'
        color: 'warning'
        title: 'Warning: {{ .GroupLabels.alertname }}'
        text: |
          *Summary:* {{ .Annotations.summary }}
          *Description:* {{ .Annotations.description }}
          {{ if .Annotations.runbook_url }}*Runbook:* {{ .Annotations.runbook_url }}{{ end }}
        short_fields: false

  - name: 'slack-info'
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        channel: '#arbitrage-monitoring'
        color: 'good'
        title: 'Info: {{ .GroupLabels.alertname }}'
        text: '{{ .Annotations.description }}'

# Inhibition rules (suppress alerts when others are firing)
inhibit_rules:
  # Suppress warning/info if critical is firing
  - source_match:
      severity: 'critical'
    target_match_re:
      severity: 'warning|info'
    equal: ['alertname', 'service']
```

6. **Set environment variables**:

```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
export PAGERDUTY_SERVICE_KEY="your-pagerduty-service-key"
```

7. **Start the monitoring stack**:

```bash
docker-compose up -d
```

8. **Verify services are running**:

```bash
# Check Prometheus
curl http://localhost:9090/-/healthy

# Check Alertmanager
curl http://localhost:9093/-/healthy

# Check Grafana
curl http://localhost:3001/api/health
```

9. **Access dashboards**:

- Grafana: http://localhost:3001 (admin/changeme)
- Prometheus: http://localhost:9090
- Alertmanager: http://localhost:9093

## Detailed Setup

### Prometheus Setup

#### Configuration Options

Key configuration parameters in `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s     # How often to scrape metrics (15s default)
  evaluation_interval: 15s # How often to evaluate alert rules
  scrape_timeout: 10s      # Timeout for scrape requests

  external_labels:         # Labels added to all metrics
    cluster: 'prod'
    environment: 'production'
```

#### Storage Configuration

```yaml
# In docker-compose.yml command section
command:
  - '--storage.tsdb.retention.time=30d'    # Keep 30 days of data
  - '--storage.tsdb.retention.size=50GB'   # Max 50GB storage
  - '--storage.tsdb.path=/prometheus'      # Data directory
```

#### Service Discovery

For dynamic service discovery (Kubernetes/ECS):

```yaml
# Kubernetes example
- job_name: 'arbitrage-services'
  kubernetes_sd_configs:
    - role: pod
      namespaces:
        names:
          - arbitrage
  relabel_configs:
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
      action: keep
      regex: true
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
      action: replace
      target_label: __metrics_path__
      regex: (.+)
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
      action: replace
      regex: ([^:]+)(?::\d+)?;(\d+)
      replacement: $1:$2
      target_label: __address__
```

### Grafana Setup

#### First-Time Setup

1. **Login** to Grafana (http://localhost:3001)
   - Default username: `admin`
   - Default password: `changeme`
   - Change password immediately!

2. **Verify Prometheus datasource**:
   - Go to Configuration → Data Sources
   - Should see "Prometheus" datasource
   - Click "Test" to verify connection

3. **Import main dashboard**:
   - Go to Dashboards → Import
   - The dashboard from `grafana-dashboard.json` should already be provisioned
   - If not, upload the file manually

4. **Configure notifications** (optional):
   - Go to Alerting → Notification channels
   - Add Slack, PagerDuty, Email, etc.

#### Dashboard Customization

Edit the provisioned dashboard to add custom panels:

```json
{
  "title": "Custom Metric",
  "targets": [{
    "expr": "your_prometheus_query",
    "legendFormat": "{{label}}"
  }],
  "type": "timeseries"
}
```

### Alertmanager Setup

#### Notification Channels

Configure notification channels with secrets:

**Slack**:
```yaml
slack_configs:
  - api_url: '${SLACK_WEBHOOK_URL}'
    channel: '#alerts'
    username: 'Alertmanager'
    icon_emoji: ':alert:'
```

Get Slack webhook URL:
1. Go to https://api.slack.com/messaging/webhooks
2. Create incoming webhook for your workspace
3. Copy webhook URL
4. Set `SLACK_WEBHOOK_URL` environment variable

**PagerDuty**:
```yaml
pagerduty_configs:
  - service_key: '${PAGERDUTY_SERVICE_KEY}'
```

Get PagerDuty service key:
1. Go to Configuration → Services
2. Create new service for "Arbitrage System"
3. Use "Events API v2" integration
4. Copy Integration Key
5. Set `PAGERDUTY_SERVICE_KEY` environment variable

**Email**:
```yaml
email_configs:
  - to: 'oncall@yourcompany.com'
    from: 'alertmanager@yourcompany.com'
    smarthost: 'smtp.gmail.com:587'
    auth_username: '${SMTP_USERNAME}'
    auth_password: '${SMTP_PASSWORD}'
```

## Metrics Reference

### System Health Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `up` | Gauge | Service health (1=up, 0=down) | job, instance |
| `arbitrage_errors_total` | Counter | Total errors by service | service, error_type |
| `arbitrage_requests_total` | Counter | Total requests processed | service |
| `arbitrage_circuit_breaker_open` | Gauge | Circuit breaker state (0=closed, 1=open) | service, chain |

### RPC Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `arbitrage_rpc_calls_total` | Counter | Total RPC calls | provider, method |
| `arbitrage_rpc_errors_total` | Counter | RPC call errors | provider, error_type |
| `arbitrage_rpc_duration_ms` | Histogram | RPC call latency | provider, method |
| `arbitrage_cache_hits_total` | Counter | Cache hits | cache_level, chain |
| `arbitrage_cache_misses_total` | Counter | Cache misses | cache_level, chain |
| `arbitrage_cache_size_bytes` | Gauge | Cache size in bytes | cache_level, chain |

### Redis Streams Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `redis_stream_messages_pending` | Gauge | Pending messages in stream | stream |
| `redis_stream_messages_added_total` | Counter | Messages added to stream | stream |
| `redis_stream_messages_consumed_total` | Counter | Messages consumed | stream, consumer_group |
| `redis_stream_lag_seconds` | Gauge | Consumer lag in seconds | stream, consumer_group |

### Arbitrage Performance Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `arbitrage_opportunities_detected_total` | Counter | Opportunities detected | chain, strategy |
| `arbitrage_opportunities_missed_total` | Counter | Opportunities missed | chain, reason |
| `arbitrage_execution_attempts_total` | Counter | Execution attempts | chain, strategy |
| `arbitrage_execution_success_total` | Counter | Successful executions | chain, strategy |
| `arbitrage_detection_duration_ms` | Histogram | Detection latency | chain |
| `arbitrage_execution_duration_ms` | Histogram | Execution latency | chain, strategy |

### Financial Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `arbitrage_profit_usd_total` | Counter | Total profit in USD | chain, strategy |
| `arbitrage_gas_cost_usd_total` | Counter | Total gas cost in USD | chain |
| `arbitrage_gas_price_gwei` | Gauge | Current gas price | chain |
| `arbitrage_volume_usd_total` | Counter | Trading volume in USD | chain, dex |

### Warming Infrastructure Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `arbitrage_warming_operations_total` | Counter | Warming operations | chain, status |
| `arbitrage_warming_pairs_warmed_total` | Counter | Pairs warmed | chain |
| `arbitrage_warming_duration_ms` | Histogram | Warming operation duration | chain |
| `arbitrage_correlation_tracking_duration_us` | Histogram | Correlation tracking latency | chain |
| `arbitrage_correlation_pairs_tracked` | Gauge | Pairs tracked for correlation | chain |

## Alert Thresholds

### Critical Alerts (P1 - Page Immediately)

| Alert | Threshold | Duration | Rationale |
|-------|-----------|----------|-----------|
| ServiceDown | Service up == 0 | 2 minutes | Core service failure |
| RPCRateLimitCritical | >5000 calls/min | 5 minutes | Per ADR-024, risk of provider throttling |
| CacheHitRateCritical | <80% hit rate | 10 minutes | RPC costs spike significantly |
| RedisStreamsBackpressureCritical | >1000 pending | 5 minutes | Per ADR-002, risk of message loss |
| DLQGrowthRateCritical | >10 messages/min | 5 minutes | Systematic processing failures |
| CircuitBreakerOpen | Circuit breaker == 1 | 2 minutes | Repeated failures |
| ExecutionWinRateCritical | <50% | 10 minutes | Revenue severely impacted |
| GasPriceCritical | >200 gwei | 5 minutes | Profitability destroyed |
| HighMemoryUsage | >90% | 5 minutes | Risk of OOM crash |

### Warning Alerts (P2 - Business Hours)

| Alert | Threshold | Duration | Rationale |
|-------|-----------|----------|-----------|
| RPCRateLimitWarning | >4000 calls/min | 10 minutes | 80% of critical threshold |
| CacheHitRateWarning | <90% hit rate | 15 minutes | Elevated RPC costs |
| RedisStreamsBackpressureWarning | >500 pending | 10 minutes | 50% of critical threshold |
| ExecutionWinRateWarning | <70% | 15 minutes | Below target performance |
| HighErrorRate | >1% error rate | 10 minutes | Elevated failures |
| GasPriceWarning | >100 gwei | 10 minutes | Reduced profitability |

### Info Alerts (P3 - Daily Monitoring)

| Alert | Threshold | Duration | Purpose |
|-------|-----------|----------|---------|
| CacheCapacityGrowing | 80% in 4 hours | 30 minutes | Capacity planning |
| DetectionLatencyIncreasing | P95 >100ms | 30 minutes | Performance trending |
| LowTradingVolume | <$10k/hour | 2 hours | Business metric |
| RPCProviderDegraded | >5% error rate | 20 minutes | Provider health |

## Dashboard Guide

### Main Dashboard Sections

#### 1. System Health Overview (Row 1)

- **Services Down**: Count of unhealthy services (should be 0)
- **Opportunity Detection Rate**: % of opportunities successfully detected
- **Execution Win Rate**: % of executions that succeed
- **Circuit Breakers Open**: Count of open circuit breakers (should be 0)
- **DLQ Messages**: Messages in dead letter queue (should be low)
- **Active Services**: Time series of service count

**Action Items**:
- Services Down > 0: Investigate failed service immediately
- Win Rate < 70%: Review strategy parameters or market conditions
- Circuit Breakers Open > 0: Check service logs for repeated failures

#### 2. RPC & Cache Performance (Row 2)

- **RPC Call Rate by Provider**: Calls/minute per provider (threshold: 5000)
- **Cache Hit Rate (L1)**: L1 cache effectiveness (target: >90%)
- **Cache Hit Rate (L2)**: L2 cache effectiveness (target: >95%)

**Action Items**:
- RPC > 4000/min: Consider adding caching or reducing poll frequency
- Cache Hit Rate < 90%: Review cache TTL settings or warming strategy
- Single provider spiking: Check for provider failover issues

#### 3. Redis Streams (Row 3)

- **Redis Streams Backpressure**: Pending messages per stream (threshold: 1000)
- **Dead Letter Queue Growth**: Rate of DLQ growth (threshold: 10/min)

**Action Items**:
- Backpressure > 500: Check consumer health and processing speed
- DLQ Growing: Investigate message processing errors

#### 4. Arbitrage Detection & Execution (Row 4)

- **Opportunities Detected by Chain**: Detection rate per chain (opportunities/hour)
- **Execution Success vs Failed**: Success/failure breakdown

**Action Items**:
- Low detection rate: Check detector health or market liquidity
- High failure rate: Review execution strategy or gas settings

#### 5. Gas & Profitability (Row 5)

- **Gas Prices by Chain**: Current gas prices (gwei)
- **Hourly Profit vs Gas Cost**: P&L breakdown

**Action Items**:
- High gas prices: Consider adjusting minimum profit threshold
- Gas cost > profit: Pause unprofitable chains

#### 6. Error Rates & Circuit Breakers (Row 6)

- **Error Rate by Service**: Error % per service (threshold: 1%)
- **Circuit Breaker Status**: Table of circuit breaker states

**Action Items**:
- Error rate > 1%: Investigate service logs
- Circuit breaker open: Follow incident runbook

### Using Dashboard Filters

**Chain Filter**: Select specific chains to focus on
```
Variable: $chain
Query: label_values(arbitrage_opportunities_detected_total, chain)
```

**Time Range**: Adjust time window
- Last 1 hour: Real-time monitoring
- Last 24 hours: Daily review
- Last 7 days: Weekly performance analysis

### Creating Custom Panels

Add a new panel with Prometheus query:

1. Click "Add panel" → "Add new panel"
2. Enter Prometheus query:
   ```promql
   rate(arbitrage_opportunities_detected_total[5m])
   ```
3. Configure visualization (time series, gauge, stat, etc.)
4. Set thresholds and units
5. Save dashboard

## Incident Response

### Alert Response Workflow

```
Alert Triggered
      ↓
Acknowledge in PagerDuty/Slack
      ↓
Check Dashboard for Context
      ↓
Follow Runbook
      ↓
Document Actions Taken
      ↓
Resolve Alert
      ↓
Post-Mortem (if critical)
```

### Runbook Links

Each alert includes a runbook URL. Key runbooks:

- **Service Down**: Check service logs, restart if necessary, verify dependencies (Redis, RPC providers)
- **RPC Rate Limit**: Enable rate limiting, switch to backup provider, reduce poll frequency
- **Cache Hit Rate Low**: Increase cache TTL, improve warming strategy, check cache memory limits
- **Redis Backpressure**: Check consumer health, increase consumer count, verify Redis performance
- **DLQ Growth**: Investigate failing messages, fix processing logic, consider replaying messages
- **Circuit Breaker**: Review service logs, fix underlying issue, manually reset breaker if needed
- **Low Win Rate**: Review execution parameters, check gas settings, verify opportunity detection accuracy
- **High Gas Price**: Adjust minimum profit threshold, pause unprofitable strategies, wait for gas to normalize

### Escalation Path

1. **Level 1 (P3 Info)**: On-call engineer during business hours
2. **Level 2 (P2 Warning)**: On-call engineer, escalate if unresolved in 4 hours
3. **Level 3 (P1 Critical)**: Immediate page, escalate to senior engineer if unresolved in 30 minutes

## Troubleshooting

### Common Issues

#### Prometheus Not Scraping Metrics

**Symptoms**: No data in Grafana, "No data" on dashboards

**Diagnosis**:
```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Check service metrics endpoint
curl http://localhost:3000/metrics
```

**Solutions**:
- Verify service is running and exposing /metrics
- Check network connectivity between Prometheus and services
- Verify scrape configuration in prometheus.yml
- Check Prometheus logs: `docker logs arbitrage-prometheus`

#### Alerts Not Firing

**Symptoms**: Expected alerts not showing in Alertmanager

**Diagnosis**:
```bash
# Check alert rules loaded
curl http://localhost:9090/api/v1/rules

# Check alert state
curl http://localhost:9090/api/v1/alerts
```

**Solutions**:
- Verify alert-rules.yml is valid YAML
- Check alert rule expression is correct (test in Prometheus UI)
- Verify evaluation_interval in prometheus.yml
- Check alert duration (for: X minutes)

#### Notifications Not Delivered

**Symptoms**: Alerts firing but no Slack/PagerDuty notification

**Diagnosis**:
```bash
# Check Alertmanager status
curl http://localhost:9093/api/v1/status

# Check Alertmanager config
curl http://localhost:9093/api/v1/status
```

**Solutions**:
- Verify webhook URLs are correct
- Check API keys/tokens are set in environment
- Test webhook manually with curl
- Check Alertmanager logs: `docker logs arbitrage-alertmanager`
- Verify routing rules match alert labels

#### High Cardinality Issues

**Symptoms**: Prometheus memory usage high, queries slow

**Diagnosis**:
```bash
# Check metric cardinality
curl http://localhost:9090/api/v1/label/__name__/values | jq length

# Check series count
curl http://localhost:9090/api/v1/query?query=count\(\{__name__!=\"\"\}\)
```

**Solutions**:
- Reduce label cardinality (avoid unique IDs in labels)
- Increase Prometheus memory limits
- Reduce retention time or size
- Use recording rules to pre-aggregate high-cardinality metrics

#### Dashboard Not Loading

**Symptoms**: Grafana shows "Dashboard not found" or errors

**Solutions**:
- Verify dashboard JSON is valid (check with jsonlint)
- Re-import dashboard manually
- Check Grafana logs: `docker logs arbitrage-grafana`
- Verify datasource is configured correctly

### Debugging Commands

```bash
# Check Prometheus configuration
docker exec arbitrage-prometheus promtool check config /etc/prometheus/prometheus.yml

# Check alert rules
docker exec arbitrage-prometheus promtool check rules /etc/prometheus/alert-rules.yml

# Test Prometheus query
curl 'http://localhost:9090/api/v1/query?query=up'

# Check Alertmanager configuration
docker exec arbitrage-alertmanager amtool check-config /etc/alertmanager/alertmanager.yml

# View firing alerts
docker exec arbitrage-alertmanager amtool alert query
```

## Maintenance

### Regular Tasks

**Daily**:
- Review critical alerts from previous day
- Check dashboard for anomalies
- Verify all services reporting metrics

**Weekly**:
- Review alert threshold effectiveness
- Analyze trends in detection and execution rates
- Check storage usage (Prometheus data volume)

**Monthly**:
- Review and update alert rules
- Conduct alert fatigue analysis (too many false positives?)
- Update runbooks based on incidents
- Review retention policies

### Backup and Recovery

**Prometheus Data**:
```bash
# Backup Prometheus data
docker exec arbitrage-prometheus tar czf - /prometheus > prometheus-backup-$(date +%Y%m%d).tar.gz

# Restore Prometheus data
docker exec -i arbitrage-prometheus tar xzf - -C / < prometheus-backup-20260210.tar.gz
```

**Grafana Dashboards**:
```bash
# Export dashboard
curl -u admin:changeme http://localhost:3001/api/dashboards/uid/arbitrage-production-dashboard | jq > dashboard-backup.json

# Import dashboard
curl -u admin:changeme -H "Content-Type: application/json" \
  -d @dashboard-backup.json \
  http://localhost:3001/api/dashboards/db
```

### Upgrading

**Prometheus**:
```bash
docker pull prom/prometheus:latest
docker-compose up -d prometheus
```

**Grafana**:
```bash
# Backup first!
docker exec arbitrage-grafana grafana-cli admin data-migration list

docker pull grafana/grafana:latest
docker-compose up -d grafana
```

## Additional Resources

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/grafana/latest/)
- [Alertmanager Documentation](https://prometheus.io/docs/alerting/latest/alertmanager/)
- [ADR-002: Redis Streams](../architecture/adr/ADR-002-redis-streams.md)
- [ADR-024: RPC Rate Limiting](../architecture/adr/ADR-024-rpc-rate-limiting.md)
- [Incident Runbook](./INCIDENT_RUNBOOK.md) (if exists)

## Support

For issues or questions:
- Internal Slack: #arbitrage-monitoring
- On-call rotation: See PagerDuty schedule
- Emergency escalation: See team wiki
