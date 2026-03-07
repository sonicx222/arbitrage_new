# Prometheus Metrics Reference

> **Last Updated:** 2026-03-07
> **Related:** [MONITORING_SETUP.md](MONITORING_SETUP.md), [API Reference](../architecture/API.md)

All services expose Prometheus-compatible metrics via `/metrics` endpoints. The coordinator aggregates stream and runtime metrics on `/api/metrics/prometheus`.

---

## Execution Engine Metrics

**Endpoint:** `GET http://localhost:3005/metrics`

### Core Execution

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_execution_attempts_total` | counter | chain, strategy | Total execution attempts |
| `arbitrage_execution_success_total` | counter | chain, strategy | Successful executions |
| `arbitrage_execution_failure_total` | counter | chain, strategy, reason | Failed executions |
| `arbitrage_execution_latency_ms` | histogram | chain, strategy | Execution latency in ms |

### Queue & System

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_queue_depth` | gauge | -- | Current opportunity queue depth |
| `arbitrage_active_executions` | gauge | -- | Currently active execution count |
| `arbitrage_dlq_length` | gauge | -- | Dead letter queue message count |
| `arbitrage_consumer_lag_pending` | gauge | -- | Consumer group pending messages (lag) |

### Business Intelligence

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_opportunity_outcome_total` | counter | chain, outcome | Outcomes: success, revert, timeout, stale, gas_too_high, skipped, error |
| `arbitrage_profit_slippage_pct` | histogram | chain, strategy | Expected vs actual profit difference (%) |
| `arbitrage_opportunity_age_at_execution_ms` | histogram | chain | Time from detection to execution start |
| `arbitrage_profit_per_execution` | histogram | chain, strategy | Profit per execution (native token units) |
| `arbitrage_gas_cost_per_execution` | histogram | chain | Gas cost per execution (native token units) |
| `arbitrage_stream_message_transit_ms` | histogram | stream | Publish-to-consume transit time |

### Pricing

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_gas_price_gwei` | gauge | chain | Current gas price in gwei |
| `arbitrage_opportunities_detected_total` | counter | chain, type | Total opportunities detected |
| `arbitrage_volume_usd_total` | counter | chain | Total trading volume in USD |

---

## Coordinator Metrics

**Endpoint:** `GET http://localhost:3000/api/metrics/prometheus`

### Opportunity Management

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_opportunities_total` | counter | -- | Total opportunities received |
| `arbitrage_opportunities_dropped_total` | counter | -- | Total opportunities dropped |
| `arbitrage_executions_total` | counter | -- | Total executions attempted |
| `arbitrage_executions_successful_total` | counter | -- | Successful executions |

### Admission Control

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_opportunities_admitted_total` | counter | -- | Admitted through admission gate |
| `arbitrage_opportunities_shed_total` | counter | -- | Shed by admission gate |
| `arbitrage_admission_avg_score_admitted` | gauge | -- | Average score of admitted opportunities |
| `arbitrage_admission_avg_score_shed` | gauge | -- | Average score of shed opportunities |

---

## Cross-Chain Detector Metrics

**Endpoint:** `GET http://localhost:3006/metrics`

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cross_chain_opportunities_total` | counter | source_chain, target_chain | Cross-chain opportunities detected |
| `cross_chain_opportunities_published_total` | counter | source_chain, target_chain | Published to Redis Streams |
| `cross_chain_opportunities_deduplicated_total` | counter | -- | Filtered by deduplication |
| `cross_chain_publish_errors_total` | counter | -- | Errors publishing opportunities |
| `cross_chain_detection_cycles_total` | counter | -- | Detection cycles completed |

---

## Mempool Detector Metrics

**Endpoint:** `GET http://localhost:3008/metrics`

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_mempool_tx_received_total` | counter | chain | Pending transactions received |
| `arbitrage_mempool_tx_decoded_total` | counter | chain | Transactions decoded as swaps |
| `arbitrage_mempool_tx_decode_failures_total` | counter | chain | Decode failures |
| `arbitrage_mempool_opportunities_published_total` | counter | chain | Pending opportunities published |
| `arbitrage_mempool_buffer_overflows_total` | counter | -- | Buffer overflow events |

---

## Stream Health Metrics

Exposed on coordinator `/api/metrics/prometheus`.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `stream_length` | gauge | stream | Messages in stream |
| `stream_pending` | gauge | stream | Pending messages |
| `stream_consumer_groups` | gauge | stream | Consumer group count |
| `stream_health_status` | gauge | stream | 1=healthy, 0.5=warning, 0=critical, -1=idle |

---

## Runtime Metrics

Exposed on coordinator `/api/metrics/prometheus` and per-service `/metrics`.

### Event Loop

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `runtime_eventloop_delay_min_ms` | gauge | -- | Event loop delay minimum |
| `runtime_eventloop_delay_max_ms` | gauge | -- | Event loop delay maximum |
| `runtime_eventloop_delay_mean_ms` | gauge | -- | Event loop delay mean |
| `runtime_eventloop_delay_p50_ms` | gauge | -- | Event loop delay p50 |
| `runtime_eventloop_delay_p99_ms` | gauge | -- | Event loop delay p99 |

### Memory

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `runtime_memory_heap_used_mb` | gauge | -- | Heap used (MB) |
| `runtime_memory_heap_total_mb` | gauge | -- | Heap total (MB) |
| `runtime_memory_rss_mb` | gauge | -- | Resident set size (MB) |
| `runtime_memory_external_mb` | gauge | -- | External memory (MB) |
| `runtime_memory_array_buffers_mb` | gauge | -- | ArrayBuffer memory (MB) |

### Garbage Collection

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `runtime_gc_pause_total_ms` | counter | -- | Cumulative GC pause time |
| `runtime_gc_count_total` | counter | -- | Total GC events |
| `runtime_gc_major_count_total` | counter | -- | Major GC events |

---

## RPC Provider Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `arbitrage_rpc_calls_total` | counter | provider, chain | RPC calls made |
| `arbitrage_rpc_errors_total` | counter | provider, chain, error_type | RPC errors |
| `provider_rpc_call_duration_ms` | gauge | chain, quantile | RPC call duration (ms) |
| `provider_rpc_method_duration_ms` | gauge | method, quantile | Duration by method (ms) |
| `provider_ws_reconnection_duration_ms` | gauge | chain, quantile | WebSocket reconnection time |
| `provider_ws_messages_total` | counter | chain, event_type | WebSocket messages received |
| `provider_rpc_errors_total` | counter | chain, error_type | Provider errors by type |

---

## Key Labels

| Label | Values | Description |
|-------|--------|-------------|
| `chain` | bsc, ethereum, arbitrum, base, polygon, optimism, avalanche, fantom, zksync, linea, blast, scroll, solana | Blockchain identifier |
| `strategy` | intra-chain, cross-chain, flash-loan, solana, statistical-arb | Execution strategy |
| `outcome` | success, revert, timeout, stale, gas_too_high, skipped, error | Execution outcome |
| `stream` | stream:opportunities, stream:execution-requests, etc. | Redis stream name |
| `quantile` | 0.5, 0.95, 0.99 | Percentile bucket |

---

## Expected Ranges & Alerts

| Metric | Normal | Warning | Critical |
|--------|--------|---------|----------|
| `arbitrage_execution_latency_ms` (p99) | <200ms | >500ms | >1000ms |
| `arbitrage_queue_depth` | <50 | >200 | >500 |
| `arbitrage_consumer_lag_pending` | <100 | >500 | >1000 |
| `runtime_eventloop_delay_p99_ms` | <50ms | >100ms | >200ms |
| `runtime_memory_heap_used_mb` | <60% of total | >80% | >90% |
| `runtime_gc_major_count_total` (rate/min) | <5 | >10 | >20 |
| `stream_health_status` | 1 | 0.5 | 0 |
| `arbitrage_dlq_length` | 0 | >10 | >100 |

---

## PromQL Query Examples

### Execution Success Rate (last 5 minutes)

```promql
rate(arbitrage_execution_success_total[5m])
  / rate(arbitrage_execution_attempts_total[5m]) * 100
```

### Opportunity Pipeline Throughput

```promql
rate(arbitrage_opportunities_total[5m])
```

### Execution Latency p99 by Chain

```promql
histogram_quantile(0.99, rate(arbitrage_execution_latency_ms_bucket[5m]))
```

### Stream Backpressure Ratio

```promql
stream_pending / stream_length
```

### Memory Usage Percentage

```promql
runtime_memory_heap_used_mb / runtime_memory_heap_total_mb * 100
```

### Consumer Lag Trend (growing = problem)

```promql
deriv(arbitrage_consumer_lag_pending[10m])
```

### Profit Slippage by Strategy

```promql
histogram_quantile(0.50, rate(arbitrage_profit_slippage_pct_bucket{strategy="flash-loan"}[15m]))
```

---

## Metric Totals

| Type | Count |
|------|-------|
| Counter | 26 |
| Gauge | 23 |
| Histogram | 7 |
| **Total** | **56** |
