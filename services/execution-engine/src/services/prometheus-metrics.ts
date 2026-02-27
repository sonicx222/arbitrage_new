/**
 * Prometheus Metrics for Execution Engine (Phase 6, Task 6.1)
 *
 * Defines and records core operational metrics for the execution engine.
 * Metrics are collected via PrometheusMetricsCollector and exported in
 * Prometheus text format via PrometheusExporter on the /metrics endpoint.
 *
 * Metric naming follows Prometheus conventions with the `arbitrage_` prefix:
 * - arbitrage_execution_attempts_total
 * - arbitrage_execution_success_total
 * - arbitrage_execution_failure_total  (P2 Fix O-8)
 * - arbitrage_gas_price_gwei
 * - arbitrage_opportunities_detected_total
 * - arbitrage_volume_usd_total
 * - arbitrage_execution_latency_ms     (P2 Fix O-8)
 * - arbitrage_queue_depth              (P2 Fix O-9)
 * - arbitrage_active_executions        (P2 Fix O-9)
 * - arbitrage_dlq_length               (P2 Fix O-9)
 * - arbitrage_consumer_lag_pending     (P2 Fix O-9)
 *
 * @see infrastructure/monitoring/alert-rules.yml - Alert rules referencing these metrics
 * @see shared/metrics/src/infrastructure/prometheus-metrics-collector.impl.ts - Collector
 * @see shared/metrics/src/infrastructure/prometheus-exporter.impl.ts - Exporter
 *
 * @package @arbitrage/execution-engine
 */

import { PrometheusMetricsCollector } from '@arbitrage/metrics';
import { PrometheusExporter, ExportFormat } from '@arbitrage/metrics';
import { MetricType } from '@arbitrage/metrics';

// ---------------------------------------------------------------------------
// Singleton collector and exporter
// ---------------------------------------------------------------------------

const collector = new PrometheusMetricsCollector();

const exporter = new PrometheusExporter(collector, {
  format: ExportFormat.PROMETHEUS,
  metricPrefix: 'arbitrage_',
});

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

collector.defineMetric({
  name: 'execution_attempts_total',
  type: MetricType.COUNTER,
  description: 'Total execution attempts',
  labels: ['chain', 'strategy'],
});

collector.defineMetric({
  name: 'execution_success_total',
  type: MetricType.COUNTER,
  description: 'Total successful executions',
  labels: ['chain', 'strategy'],
});

// P2 Fix O-8: Failure counter for alerting on execution error rate
collector.defineMetric({
  name: 'execution_failure_total',
  type: MetricType.COUNTER,
  description: 'Total failed executions',
  labels: ['chain', 'strategy', 'reason'],
});

collector.defineMetric({
  name: 'gas_price_gwei',
  type: MetricType.GAUGE,
  description: 'Current gas price in gwei',
  labels: ['chain'],
});

collector.defineMetric({
  name: 'opportunities_detected_total',
  type: MetricType.COUNTER,
  description: 'Total opportunities detected',
  labels: ['chain', 'type'],
});

collector.defineMetric({
  name: 'volume_usd_total',
  type: MetricType.COUNTER,
  description: 'Total trading volume in USD',
  labels: ['chain'],
});

// P2 Fix O-8: Latency histogram for execution time distribution
collector.defineMetric({
  name: 'execution_latency_ms',
  type: MetricType.HISTOGRAM,
  description: 'Execution latency in milliseconds',
  labels: ['chain', 'strategy'],
});

// P2 Fix O-9: Health endpoint values as Prometheus gauges for scraping
collector.defineMetric({
  name: 'queue_depth',
  type: MetricType.GAUGE,
  description: 'Current opportunity queue depth',
  labels: [],
});

collector.defineMetric({
  name: 'active_executions',
  type: MetricType.GAUGE,
  description: 'Currently active execution count',
  labels: [],
});

collector.defineMetric({
  name: 'dlq_length',
  type: MetricType.GAUGE,
  description: 'Dead letter queue message count',
  labels: [],
});

collector.defineMetric({
  name: 'consumer_lag_pending',
  type: MetricType.GAUGE,
  description: 'Consumer group pending message count (lag)',
  labels: [],
});

// ---------------------------------------------------------------------------
// Recording functions
// ---------------------------------------------------------------------------

/**
 * Record an execution attempt.
 *
 * @param chain - Chain identifier (e.g. "bsc", "ethereum")
 * @param strategy - Strategy name (e.g. "intra-chain", "cross-chain")
 */
export function recordExecutionAttempt(chain: string, strategy: string): void {
  collector.incrementCounter('execution_attempts_total', { chain, strategy });
}

/**
 * Record a successful execution.
 *
 * @param chain - Chain identifier
 * @param strategy - Strategy name
 */
export function recordExecutionSuccess(chain: string, strategy: string): void {
  collector.incrementCounter('execution_success_total', { chain, strategy });
}

/**
 * P2 Fix O-8: Record a failed execution.
 *
 * @param chain - Chain identifier
 * @param strategy - Strategy name
 * @param reason - Failure reason category (e.g. "revert", "timeout", "nonce")
 */
export function recordExecutionFailure(chain: string, strategy: string, reason: string): void {
  collector.incrementCounter('execution_failure_total', { chain, strategy, reason });
}

/**
 * Update the current gas price gauge for a chain.
 *
 * @param chain - Chain identifier
 * @param priceGwei - Gas price in gwei
 */
export function updateGasPrice(chain: string, priceGwei: number): void {
  collector.setGauge('gas_price_gwei', priceGwei, { chain });
}

/**
 * Record a detected opportunity.
 *
 * @param chain - Chain identifier
 * @param type - Opportunity type (e.g. "cross-dex", "cross-chain")
 */
export function recordOpportunityDetected(chain: string, type: string): void {
  collector.incrementCounter('opportunities_detected_total', { chain, type });
}

/**
 * Record trading volume in USD.
 *
 * @param chain - Chain identifier
 * @param volumeUsd - Volume in USD
 */
export function recordVolume(chain: string, volumeUsd: number): void {
  collector.incrementCounter('volume_usd_total', { chain }, volumeUsd);
}

/**
 * P2 Fix O-8: Record execution latency.
 *
 * @param chain - Chain identifier
 * @param strategy - Strategy name
 * @param latencyMs - Execution latency in milliseconds
 */
export function recordExecutionLatency(chain: string, strategy: string, latencyMs: number): void {
  collector.recordHistogram('execution_latency_ms', latencyMs, { chain, strategy });
}

/**
 * P2 Fix O-9: Update health endpoint gauges for Prometheus scraping.
 * Called periodically from the health check to keep gauges fresh.
 */
export function updateHealthGauges(values: {
  queueDepth: number;
  activeExecutions: number;
  dlqLength: number;
  consumerLagPending: number;
}): void {
  collector.setGauge('queue_depth', values.queueDepth);
  collector.setGauge('active_executions', values.activeExecutions);
  collector.setGauge('dlq_length', values.dlqLength);
  collector.setGauge('consumer_lag_pending', values.consumerLagPending);
}

// ---------------------------------------------------------------------------
// Export helper
// ---------------------------------------------------------------------------

/**
 * Get all collected metrics in Prometheus text exposition format.
 *
 * Used by the /metrics HTTP endpoint for Prometheus scraping.
 *
 * @returns Prometheus text format string
 */
export async function getMetricsText(): Promise<string> {
  const result = await exporter.export();
  return result.data as string;
}
