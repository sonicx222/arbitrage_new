/**
 * Prometheus Metrics for Mempool Detector
 *
 * Provides operational visibility into mempool transaction processing,
 * swap decoding rates, and publishing throughput.
 *
 * @see services/execution-engine/src/services/prometheus-metrics.ts - Pattern reference
 * @see O-7: Extended deep analysis finding — zero Prometheus metrics in this service
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
  metricPrefix: 'arbitrage_mempool_',
});

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

collector.defineMetric({
  name: 'tx_received_total',
  type: MetricType.COUNTER,
  description: 'Total pending transactions received from feeds',
  labels: ['chain'],
});

collector.defineMetric({
  name: 'tx_decoded_total',
  type: MetricType.COUNTER,
  description: 'Total transactions successfully decoded as swaps',
  labels: ['chain'],
});

collector.defineMetric({
  name: 'tx_decode_failures_total',
  type: MetricType.COUNTER,
  description: 'Total transaction decode failures',
  labels: ['chain'],
});

collector.defineMetric({
  name: 'opportunities_published_total',
  type: MetricType.COUNTER,
  description: 'Total pending opportunities published to Redis Streams',
  labels: ['chain'],
});

collector.defineMetric({
  name: 'buffer_overflows_total',
  type: MetricType.COUNTER,
  description: 'Total buffer overflow events (backpressure triggered)',
  labels: [],
});

// ---------------------------------------------------------------------------
// Recording functions
// ---------------------------------------------------------------------------

export function recordTxReceived(chain: string): void {
  collector.incrementCounter('tx_received_total', { chain });
}

export function recordTxDecoded(chain: string): void {
  collector.incrementCounter('tx_decoded_total', { chain });
}

export function recordTxDecodeFailure(chain: string): void {
  collector.incrementCounter('tx_decode_failures_total', { chain });
}

export function recordOpportunityPublished(chain: string): void {
  collector.incrementCounter('opportunities_published_total', { chain });
}

export function recordBufferOverflow(): void {
  collector.incrementCounter('buffer_overflows_total', {});
}

// ---------------------------------------------------------------------------
// Export helper
// ---------------------------------------------------------------------------

/**
 * Get all collected metrics in Prometheus text exposition format.
 */
export async function getMetricsText(): Promise<string> {
  const result = await exporter.export();
  return result.data as string;
}
