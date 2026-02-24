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
 * - arbitrage_gas_price_gwei
 * - arbitrage_opportunities_detected_total
 * - arbitrage_volume_usd_total
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
