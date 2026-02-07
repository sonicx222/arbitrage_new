/**
 * Metrics Exporter Interface (Enhancement #3 - Grafana Dashboards)
 *
 * Defines the contract for exporting collected metrics to monitoring systems.
 * Supports Prometheus, Grafana, and other time-series databases.
 *
 * @see infrastructure/grafana/dashboards/ - Dashboard definitions
 * @see docs/PRICEMATRIX_DEPLOYMENT.md - Monitoring setup guide
 *
 * Design Principles:
 * - Single Responsibility: Only exports metrics, doesn't collect
 * - Strategy Pattern: Pluggable export formats (Prometheus, JSON, etc.)
 * - Dependency Inversion: Depends on IMetricsCollector abstraction
 *
 * Export Formats:
 * - Prometheus: Text-based format for /metrics endpoint
 * - JSON: Structured data for HTTP APIs
 * - Grafana Dashboard: JSON dashboard definition
 *
 * @package @arbitrage/core
 * @module metrics/domain
 */

import { MetricSnapshot } from './metrics-collector.interface';

/**
 * Export format types
 */
export enum ExportFormat {
  /**
   * Prometheus text-based exposition format
   * https://prometheus.io/docs/instrumenting/exposition_formats/
   */
  PROMETHEUS = 'prometheus',

  /**
   * JSON format for HTTP APIs
   */
  JSON = 'json',

  /**
   * Grafana dashboard JSON
   */
  GRAFANA_DASHBOARD = 'grafana_dashboard',

  /**
   * OpenTelemetry format
   */
  OPENTELEMETRY = 'opentelemetry',
}

/**
 * Export configuration
 */
export interface ExportConfig {
  /**
   * Export format
   */
  readonly format: ExportFormat;

  /**
   * Whether to include timestamps in export
   */
  readonly includeTimestamps: boolean;

  /**
   * Whether to include help text and type info (Prometheus only)
   */
  readonly includeMetadata: boolean;

  /**
   * Metric name prefix (e.g., "arbitrage_")
   */
  readonly metricPrefix?: string;

  /**
   * Default labels to add to all metrics
   */
  readonly defaultLabels?: Record<string, string>;
}

/**
 * Result of an export operation
 */
export interface ExportResult {
  /**
   * Whether export was successful
   */
  readonly success: boolean;

  /**
   * Exported data (format-specific)
   */
  readonly data: string | object;

  /**
   * Number of metrics exported
   */
  readonly metricsExported: number;

  /**
   * Export duration (milliseconds)
   */
  readonly durationMs: number;

  /**
   * Export timestamp (Unix ms)
   */
  readonly timestamp: number;

  /**
   * Any errors encountered (if success=false)
   */
  readonly errors?: string[];
}

/**
 * Grafana dashboard configuration
 */
export interface GrafanaDashboardConfig {
  /**
   * Dashboard title
   */
  readonly title: string;

  /**
   * Dashboard description
   */
  readonly description: string;

  /**
   * Tags for dashboard categorization
   */
  readonly tags: string[];

  /**
   * Time range (e.g., "1h", "24h", "7d")
   */
  readonly timeRange: string;

  /**
   * Refresh interval (e.g., "5s", "30s", "1m")
   */
  readonly refreshInterval: string;

  /**
   * Prometheus data source name
   */
  readonly datasource: string;
}

/**
 * Grafana panel definition
 */
export interface GrafanaPanelDefinition {
  /**
   * Panel title
   */
  readonly title: string;

  /**
   * Panel type ("graph", "gauge", "stat", "table", etc.)
   */
  readonly type: string;

  /**
   * Prometheus query expression
   */
  readonly query: string;

  /**
   * Legend format
   */
  readonly legend?: string;

  /**
   * Y-axis unit (e.g., "percent", "ms", "bytes")
   */
  readonly unit?: string;

  /**
   * Thresholds for coloring
   */
  readonly thresholds?: {
    readonly green: number;
    readonly yellow: number;
    readonly red: number;
  };
}

/**
 * Metrics exporter for monitoring systems
 *
 * Responsibilities:
 * - Export metrics in various formats
 * - Generate Grafana dashboards
 * - Provide HTTP endpoint for Prometheus scraping
 * - Format metrics according to conventions
 *
 * Integration Points:
 * - /metrics HTTP endpoint (Prometheus scraping)
 * - Grafana provisioning (dashboard JSON files)
 * - Monitoring alerts (threshold checks)
 *
 * @example
 * ```typescript
 * const exporter = new PrometheusExporter(collector, {
 *   format: ExportFormat.PROMETHEUS,
 *   includeTimestamps: false,
 *   metricPrefix: 'arbitrage_',
 * });
 *
 * // Export for Prometheus scraping
 * const result = await exporter.export();
 * console.log(result.data); // Prometheus text format
 *
 * // Generate Grafana dashboard
 * const dashboard = await exporter.generateGrafanaDashboard({
 *   title: 'Cache Performance',
 *   panels: [...],
 * });
 * ```
 */
export interface IMetricsExporter {
  /**
   * Export metrics in configured format
   *
   * This is called by /metrics endpoint to serve metrics to Prometheus.
   *
   * Formats:
   * - PROMETHEUS: Text-based exposition format
   * - JSON: Structured object with all metrics
   * - OPENTELEMETRY: OTLP format for OpenTelemetry collectors
   *
   * Performance: <10ms (background operation, not hot path)
   *
   * @returns Export result with formatted data
   */
  export(): Promise<ExportResult>;

  /**
   * Generate Grafana dashboard JSON
   *
   * Creates a complete Grafana dashboard definition with panels,
   * queries, and thresholds for monitoring cache performance.
   *
   * Dashboard includes:
   * - L1/L2/L3 hit rates (graph)
   * - Hot-path latency (graph with p50/p95/p99)
   * - Cache size utilization (gauge)
   * - Warming effectiveness (graph)
   * - SharedKeyRegistry CAS iterations (graph)
   * - Memory growth rate (graph)
   * - GC pause duration (graph)
   *
   * @param config - Dashboard configuration
   * @param panels - Array of panel definitions
   * @returns Grafana dashboard JSON
   */
  generateGrafanaDashboard(
    config: GrafanaDashboardConfig,
    panels: GrafanaPanelDefinition[]
  ): Promise<object>;

  /**
   * Update export configuration
   *
   * Allows runtime adjustment of export behavior.
   *
   * @param config - New configuration (partial update allowed)
   */
  updateConfig(config: Partial<ExportConfig>): void;

  /**
   * Get current export configuration
   *
   * @returns Current export config
   */
  getConfig(): ExportConfig;

  /**
   * Get exporter statistics
   *
   * @returns Exporter stats for monitoring
   */
  getStats(): ExporterStats;
}

/**
 * Metrics exporter statistics
 */
export interface ExporterStats {
  /**
   * Total exports performed
   */
  readonly totalExports: number;

  /**
   * Successful exports
   */
  readonly successfulExports: number;

  /**
   * Failed exports
   */
  readonly failedExports: number;

  /**
   * Average export duration (milliseconds)
   */
  readonly avgDurationMs: number;

  /**
   * Last export timestamp (Unix ms)
   */
  readonly lastExportTimestamp: number;

  /**
   * Last export status
   */
  readonly lastExportStatus: 'success' | 'failure';
}

/**
 * Prometheus-specific helper functions interface
 *
 * Implementations should be provided in infrastructure layer.
 */
export interface IPrometheusHelpers {
  /**
   * Escape label value for Prometheus format
   *
   * @param value - Label value to escape
   * @returns Escaped value
   */
  escapeLabelValue(value: string): string;

  /**
   * Format metric name (lowercase, underscores)
   *
   * @param name - Raw metric name
   * @returns Formatted metric name
   */
  formatMetricName(name: string): string;

  /**
   * Generate Prometheus help text
   *
   * @param name - Metric name
   * @param description - Metric description
   * @returns Prometheus HELP line
   */
  generateHelpText(name: string, description: string): string;

  /**
   * Generate Prometheus type text
   *
   * @param name - Metric name
   * @param type - Metric type
   * @returns Prometheus TYPE line
   */
  generateTypeText(name: string, type: string): string;
}
