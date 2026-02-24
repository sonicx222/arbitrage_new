/**
 * RPC Provider Prometheus Metrics
 *
 * Emits metrics for RPC call tracking and error monitoring.
 * Used by provider-rotation-strategy and WebSocket manager.
 *
 * Metrics match alert-rules.yml expectations:
 * - arbitrage_rpc_calls_total (counter, labels: provider, chain)
 * - arbitrage_rpc_errors_total (counter, labels: provider, chain, error_type)
 *
 * @see infrastructure/monitoring/alert-rules.yml
 * @see provider-rotation-strategy.ts (consumer)
 */

import {
  PrometheusMetricsCollector,
  PrometheusExporter,
  ExportFormat,
  MetricType,
} from '@arbitrage/metrics';

// Singleton collector and exporter for RPC metrics
const collector = new PrometheusMetricsCollector();
const exporter = new PrometheusExporter(collector, {
  format: ExportFormat.PROMETHEUS,
  metricPrefix: 'arbitrage_',
});

// Define metrics
collector.defineMetric({
  name: 'rpc_calls_total',
  type: MetricType.COUNTER,
  description: 'Total RPC calls made',
  labels: ['provider', 'chain'],
});

collector.defineMetric({
  name: 'rpc_errors_total',
  type: MetricType.COUNTER,
  description: 'Total RPC errors encountered',
  labels: ['provider', 'chain', 'error_type'],
});

/**
 * Record an RPC call.
 */
export function recordRpcCall(provider: string, chain: string): void {
  collector.incrementCounter('rpc_calls_total', { provider, chain });
}

/**
 * Record an RPC error.
 */
export function recordRpcError(provider: string, chain: string, errorType: string): void {
  collector.incrementCounter('rpc_errors_total', { provider, chain, error_type: errorType });
}

/**
 * Get Prometheus text format output for RPC metrics.
 */
export async function getRpcMetricsText(): Promise<string> {
  const result = await exporter.export();
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
}

/**
 * Get the underlying collector for testing or aggregation.
 */
export function getRpcMetricsCollector(): PrometheusMetricsCollector {
  return collector;
}
