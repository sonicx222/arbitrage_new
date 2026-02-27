/**
 * Prometheus Metrics for Cross-Chain Detector
 *
 * Provides operational visibility into cross-chain detection rates,
 * publishing success/failure, and processing latency.
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
  metricPrefix: 'arbitrage_crosschain_',
});

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

collector.defineMetric({
  name: 'opportunities_detected_total',
  type: MetricType.COUNTER,
  description: 'Total cross-chain opportunities detected',
  labels: ['source_chain', 'target_chain'],
});

collector.defineMetric({
  name: 'opportunities_published_total',
  type: MetricType.COUNTER,
  description: 'Total cross-chain opportunities published to Redis Streams',
  labels: ['source_chain', 'target_chain'],
});

collector.defineMetric({
  name: 'opportunities_deduplicated_total',
  type: MetricType.COUNTER,
  description: 'Total opportunities filtered by deduplication',
  labels: [],
});

collector.defineMetric({
  name: 'publish_errors_total',
  type: MetricType.COUNTER,
  description: 'Total errors publishing opportunities',
  labels: [],
});

collector.defineMetric({
  name: 'detection_cycles_total',
  type: MetricType.COUNTER,
  description: 'Total detection cycles completed',
  labels: [],
});

// ---------------------------------------------------------------------------
// Recording functions
// ---------------------------------------------------------------------------

export function recordOpportunityDetected(sourceChain: string, targetChain: string): void {
  collector.incrementCounter('opportunities_detected_total', { source_chain: sourceChain, target_chain: targetChain });
}

export function recordOpportunityPublished(sourceChain: string, targetChain: string): void {
  collector.incrementCounter('opportunities_published_total', { source_chain: sourceChain, target_chain: targetChain });
}

export function recordOpportunityDeduplicated(): void {
  collector.incrementCounter('opportunities_deduplicated_total', {});
}

export function recordPublishError(): void {
  collector.incrementCounter('publish_errors_total', {});
}

export function recordDetectionCycle(): void {
  collector.incrementCounter('detection_cycles_total', {});
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
