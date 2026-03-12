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
import { RedisStreams } from '@arbitrage/types';

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

// RT-008: Standard schema alias — monitoring validation expects `arbitrage_executions_total`
// while alert rules use `arbitrage_execution_attempts_total`. Both are kept in sync.
collector.defineMetric({
  name: 'executions_total',
  type: MetricType.COUNTER,
  description: 'Total execution attempts (alias for execution_attempts_total)',
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

// Phase 2 Enhanced Monitoring (A2): Opportunity outcome categorization
collector.defineMetric({
  name: 'opportunity_outcome_total',
  type: MetricType.COUNTER,
  description: 'Opportunity execution outcomes by category',
  labels: ['chain', 'outcome'],
});

// Phase 3 Business Intelligence (A3): Expected vs actual profit tracking
collector.defineMetric({
  name: 'profit_slippage_pct',
  type: MetricType.HISTOGRAM,
  description: 'Percentage difference between expected and actual profit ((expected - actual) / |expected| * 100)',
  labels: ['chain', 'strategy'],
});

// Phase 3 Business Intelligence (A3b): Estimation bias direction counter
// Tracks systematic over/under-estimation to diagnose pricing model accuracy.
// Note: Full decomposition into "estimation error" vs "execution slippage" requires
// intermediate price snapshots at execution time, which is a future enhancement.
collector.defineMetric({
  name: 'profit_estimation_bias_total',
  type: MetricType.COUNTER,
  description: 'Count of profit estimations by bias direction (overestimated: expected > actual, underestimated: expected < actual)',
  labels: ['chain', 'strategy', 'direction'],
});

// Phase 3 Business Intelligence (A4): Opportunity age at execution
collector.defineMetric({
  name: 'opportunity_age_at_execution_ms',
  type: MetricType.HISTOGRAM,
  description: 'Time from detection to execution start in milliseconds',
  labels: ['chain'],
});

// Phase 3 Business Intelligence (F4): Per-execution profit histogram
collector.defineMetric({
  name: 'profit_per_execution',
  type: MetricType.HISTOGRAM,
  description: 'Profit per execution in native token units (wei / 1e18)',
  labels: ['chain', 'strategy'],
});

// Phase 3 Business Intelligence (F5): Gas cost per execution
collector.defineMetric({
  name: 'gas_cost_per_execution',
  type: MetricType.HISTOGRAM,
  description: 'Gas cost per execution in native token units',
  labels: ['chain'],
});

// Phase 3 Business Intelligence (F1): Stream message transit time
collector.defineMetric({
  name: 'stream_message_transit_ms',
  type: MetricType.HISTOGRAM,
  description: 'Time between message publish and consumption in milliseconds',
  labels: ['stream'],
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
  // RT-008: Keep alias in sync with primary counter
  collector.incrementCounter('executions_total', { chain, strategy });
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
 * Phase 2 Enhanced Monitoring (A2): Record an opportunity execution outcome.
 *
 * @param chain - Chain identifier (e.g. "bsc", "ethereum")
 * @param outcome - Outcome category: 'success' | 'revert' | 'timeout' | 'stale' | 'gas_too_high' | 'skipped' | 'error'
 */
export function recordOpportunityOutcome(chain: string, outcome: string): void {
  collector.incrementCounter('opportunity_outcome_total', { chain, outcome });
}

/**
 * Phase 3 (A3): Record profit slippage percentage.
 * Positive values mean expected > actual (overestimated).
 * Negative values mean expected < actual (underestimated).
 *
 * @param chain - Chain identifier
 * @param strategy - Strategy name
 * @param slippagePct - Percentage difference: (expected - actual) / |expected| * 100
 */
export function recordProfitSlippage(chain: string, strategy: string, slippagePct: number): void {
  collector.recordHistogram('profit_slippage_pct', slippagePct, { chain, strategy });
  // A3b: Track estimation bias direction for systematic accuracy analysis
  const direction = slippagePct > 1 ? 'overestimated' : slippagePct < -1 ? 'underestimated' : 'accurate';
  collector.incrementCounter('profit_estimation_bias_total', { chain, strategy, direction });
}

/**
 * Phase 3 (A4): Record opportunity age at execution start.
 *
 * @param chain - Chain identifier
 * @param ageMs - Time from detection to execution start in milliseconds
 */
export function recordOpportunityAge(chain: string, ageMs: number): void {
  collector.recordHistogram('opportunity_age_at_execution_ms', ageMs, { chain });
}

/**
 * Phase 3 (F4): Record profit per execution.
 *
 * @param chain - Chain identifier
 * @param strategy - Strategy name
 * @param profit - Profit in native token units (wei / 1e18)
 */
export function recordProfitPerExecution(chain: string, strategy: string, profit: number): void {
  collector.recordHistogram('profit_per_execution', profit, { chain, strategy });
}

/**
 * Phase 3 (F5): Record gas cost per execution.
 *
 * @param chain - Chain identifier
 * @param gasCost - Gas cost in native token units
 */
export function recordGasCostPerExecution(chain: string, gasCost: number): void {
  collector.recordHistogram('gas_cost_per_execution', gasCost, { chain });
}

/**
 * Phase 3 (F1): Record stream message transit time.
 *
 * @param transitTimeMs - Time between publish and consumption in milliseconds
 * @param streamName - Redis stream name
 */
export function recordStreamTransitTime(transitTimeMs: number, streamName: string): void {
  collector.recordHistogram('stream_message_transit_ms', transitTimeMs, { stream: streamName });
}

/**
 * RT-008 FIX: Initialize gas price gauges to 0 for all configured chains.
 *
 * Called once at engine startup so `arbitrage_gas_price_gwei` always appears
 * in Prometheus /metrics output, even when no RPC providers are configured
 * (local dev) and GasPriceOptimizer has not yet updated any values.
 *
 * @param chains - List of chain identifiers to initialize (e.g. ['bsc', 'ethereum'])
 */
export function initializeGasPriceGauges(chains: string[]): void {
  for (const chain of chains) {
    collector.setGauge('gas_price_gwei', 0, { chain });
  }
}

/**
 * RT-031 FIX: Seed v3.0 BI histograms so they appear in /metrics output.
 *
 * Histograms with zero observations are omitted from Prometheus text format.
 * The monitoring pipeline's metrics completeness check (3AI) greps for these
 * metric names and flags them as missing if absent. Seeding with one observation
 * per metric ensures they're always present in scrape output.
 *
 * Called once at engine startup alongside initializeGasPriceGauges().
 *
 * @param chains - List of chain identifiers to seed
 */
export function initializeBIHistograms(chains: string[]): void {
  // Seed each histogram with the first configured chain so at least one
  // label combination exists. The 0-value observations are harmless — real
  // execution data will quickly dominate the distribution.
  const seedChain = chains[0] ?? 'unknown';
  collector.recordHistogram('opportunity_age_at_execution_ms', 0, { chain: seedChain });
  collector.recordHistogram('profit_per_execution', 0, { chain: seedChain, strategy: 'seed' });
  collector.recordHistogram('gas_cost_per_execution', 0, { chain: seedChain });
  collector.recordHistogram('stream_message_transit_ms', 0, { stream: RedisStreams.EXECUTION_REQUESTS });

  // RT-027 FIX: Seed BI counters so they appear in /metrics output with value 0.
  // Prometheus counters only appear in getSnapshot() after at least one increment.
  // Without seeding, monitoring's metrics completeness check (3AI) flags
  // arbitrage_executions_total and related counters as missing.
  collector.incrementCounter('executions_total', { chain: seedChain, strategy: 'seed' }, 0);
  collector.incrementCounter('execution_attempts_total', { chain: seedChain, strategy: 'seed' }, 0);
  collector.incrementCounter('execution_success_total', { chain: seedChain, strategy: 'seed' }, 0);
  collector.incrementCounter('execution_failure_total', { chain: seedChain, strategy: 'seed', reason: 'seed' }, 0);
  collector.incrementCounter('opportunity_outcome_total', { chain: seedChain, outcome: 'seed' }, 0);
  collector.incrementCounter('profit_estimation_bias_total', { chain: seedChain, strategy: 'seed', direction: 'accurate' }, 0);
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
