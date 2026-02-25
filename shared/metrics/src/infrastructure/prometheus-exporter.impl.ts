/**
 * PrometheusExporter - Infrastructure Layer (Enhancement #3)
 *
 * Exports collected metrics in various formats for monitoring systems.
 * Supports Prometheus, JSON, OpenTelemetry, and Grafana dashboard generation.
 *
 * @see metrics/domain/metrics-exporter.interface.ts - IMetricsExporter contract
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/ - Prometheus format
 * @see https://grafana.com/docs/grafana/latest/dashboards/json-model/ - Grafana JSON
 *
 * @package @arbitrage/metrics
 * @module metrics/infrastructure
 */

import {
  IMetricsExporter,
  ExportFormat,
  ExportConfig,
  ExportResult,
  ExporterStats,
  GrafanaDashboardConfig,
  GrafanaPanelDefinition,
  IPrometheusHelpers,
} from '../domain/metrics-exporter.interface';
import {
  IMetricsCollector,
  MetricType,
  MetricSnapshot,
} from '../domain/metrics-collector.interface';
import { getErrorMessage } from '@arbitrage/core/resilience';

/**
 * Default export configuration
 */
const DEFAULT_CONFIG: ExportConfig = {
  format: ExportFormat.PROMETHEUS,
  includeTimestamps: false,
  includeMetadata: true,
  metricPrefix: '',
  defaultLabels: {},
};

/**
 * Prometheus exporter implementation
 *
 * Export Formats:
 * 1. PROMETHEUS: Text-based format for /metrics endpoint
 *    - Compatible with Prometheus scraping
 *    - Includes HELP and TYPE metadata
 *    - Optional timestamps
 *
 * 2. JSON: Structured format for HTTP APIs
 *    - Easy to parse and process
 *    - Includes all metric data
 *
 * 3. GRAFANA_DASHBOARD: Dashboard JSON definition
 *    - Ready to import into Grafana
 *    - Includes panels, queries, thresholds
 *
 * 4. OPENTELEMETRY: OTLP format
 *    - Compatible with OpenTelemetry collectors
 *
 * Performance:
 * - export(): <10ms for typical workload
 * - generateGrafanaDashboard(): <100ms
 *
 * @example
 * ```typescript
 * const collector = new PrometheusMetricsCollector();
 * const exporter = new PrometheusExporter(collector, {
 *   format: ExportFormat.PROMETHEUS,
 *   metricPrefix: 'arbitrage_',
 * });
 *
 * // Export for Prometheus
 * const result = await exporter.export();
 * console.log(result.data); // Prometheus text format
 *
 * // Generate Grafana dashboard
 * const dashboard = await exporter.generateGrafanaDashboard({
 *   title: 'Cache Performance',
 *   datasource: 'Prometheus',
 *   ...
 * }, [
 *   {
 *     title: 'L1 Hit Rate',
 *     type: 'graph',
 *     query: 'rate(cache_hits_total{cache_level="l1"}[5m])',
 *     unit: 'percent'
 *   }
 * ]);
 * ```
 */
export class PrometheusExporter implements IMetricsExporter {
  private config: ExportConfig;
  private stats: InternalExporterStats = {
    totalExports: 0,
    successfulExports: 0,
    failedExports: 0,
    totalDurationMs: 0,
    lastExportTimestamp: 0,
    lastExportStatus: 'success',
  };

  constructor(
    private readonly collector: IMetricsCollector,
    config: Partial<ExportConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Export metrics in configured format
   *
   * Routes to appropriate formatter based on config.format.
   *
   * @returns Export result with formatted data
   */
  async export(): Promise<ExportResult> {
    const startTime = performance.now();
    this.stats.totalExports++;

    try {
      const snapshot = this.collector.getSnapshot();
      let data: string | object;

      switch (this.config.format) {
        case ExportFormat.PROMETHEUS:
          data = this.exportPrometheus(snapshot);
          break;
        case ExportFormat.JSON:
          data = this.exportJSON(snapshot);
          break;
        case ExportFormat.OPENTELEMETRY:
          data = this.exportOpenTelemetry(snapshot);
          break;
        default:
          throw new Error(`Unsupported export format: ${this.config.format}`);
      }

      const durationMs = performance.now() - startTime;
      this.stats.successfulExports++;
      this.stats.totalDurationMs += durationMs;
      this.stats.lastExportTimestamp = Date.now();
      this.stats.lastExportStatus = 'success';

      return {
        success: true,
        data,
        metricsExported: snapshot.length,
        durationMs,
        timestamp: Date.now(),
      };
    } catch (error) {
      const durationMs = performance.now() - startTime;
      this.stats.failedExports++;
      this.stats.totalDurationMs += durationMs;
      this.stats.lastExportTimestamp = Date.now();
      this.stats.lastExportStatus = 'failure';

      return {
        success: false,
        data: '',
        metricsExported: 0,
        durationMs,
        timestamp: Date.now(),
        errors: [getErrorMessage(error)],
      };
    }
  }

  /**
   * Generate Grafana dashboard JSON
   *
   * Creates a complete Grafana dashboard with panels, queries, and styling.
   *
   * Dashboard Structure:
   * - Title, description, tags
   * - Time range and refresh interval
   * - Prometheus datasource
   * - Panels with queries
   * - Thresholds and alerts
   *
   * @param config - Dashboard configuration
   * @param panels - Array of panel definitions
   * @returns Grafana dashboard JSON
   */
  async generateGrafanaDashboard(
    config: GrafanaDashboardConfig,
    panels: GrafanaPanelDefinition[]
  ): Promise<object> {
    const dashboard = {
      __inputs: [
        {
          name: 'DS_PROMETHEUS',
          label: config.datasource,
          description: '',
          type: 'datasource',
          pluginId: 'prometheus',
          pluginName: 'Prometheus',
        },
      ],
      __requires: [
        {
          type: 'grafana',
          id: 'grafana',
          name: 'Grafana',
          version: '8.0.0',
        },
        {
          type: 'panel',
          id: 'graph',
          name: 'Graph',
          version: '',
        },
        {
          type: 'datasource',
          id: 'prometheus',
          name: 'Prometheus',
          version: '1.0.0',
        },
      ],
      annotations: {
        list: [
          {
            builtIn: 1,
            datasource: '-- Grafana --',
            enable: true,
            hide: true,
            iconColor: 'rgba(0, 211, 255, 1)',
            name: 'Annotations & Alerts',
            type: 'dashboard',
          },
        ],
      },
      editable: true,
      gnetId: null,
      graphTooltip: 0,
      id: null,
      links: [],
      panels: this.generatePanels(panels),
      schemaVersion: 27,
      style: 'dark',
      tags: config.tags,
      templating: {
        list: [],
      },
      time: {
        from: `now-${config.timeRange}`,
        to: 'now',
      },
      timepicker: {},
      timezone: '',
      title: config.title,
      description: config.description,
      version: 0,
      refresh: config.refreshInterval,
    };

    return dashboard;
  }

  /**
   * Update export configuration
   *
   * @param config - New configuration (partial)
   */
  updateConfig(config: Partial<ExportConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current export configuration
   *
   * @returns Current config
   */
  getConfig(): ExportConfig {
    return { ...this.config };
  }

  /**
   * Get exporter statistics
   *
   * @returns Exporter stats
   */
  getStats(): ExporterStats {
    const avgDurationMs =
      this.stats.totalExports > 0
        ? this.stats.totalDurationMs / this.stats.totalExports
        : 0;

    return {
      totalExports: this.stats.totalExports,
      successfulExports: this.stats.successfulExports,
      failedExports: this.stats.failedExports,
      avgDurationMs,
      lastExportTimestamp: this.stats.lastExportTimestamp,
      lastExportStatus: this.stats.lastExportStatus,
    };
  }

  /**
   * Export metrics in Prometheus text format
   *
   * Format:
   * ```
   * # HELP metric_name Description of metric
   * # TYPE metric_name counter
   * metric_name{label1="value1",label2="value2"} 42 1234567890
   * ```
   *
   * @param snapshot - Metric snapshots
   * @returns Prometheus text format
   */
  private exportPrometheus(snapshot: MetricSnapshot[]): string {
    const lines: string[] = [];
    const helpers = new PrometheusHelpers();

    // Group by metric name
    const grouped = new Map<string, MetricSnapshot[]>();
    for (const metric of snapshot) {
      const name = this.config.metricPrefix + metric.name;
      if (!grouped.has(name)) {
        grouped.set(name, []);
      }
      grouped.get(name)!.push(metric);
    }

    // Export each metric
    for (const [name, metrics] of grouped) {
      if (metrics.length === 0) continue;

      const firstMetric = metrics[0];

      // Add HELP text
      if (this.config.includeMetadata) {
        lines.push(`# HELP ${name} ${firstMetric.type} metric`);
        lines.push(
          `# TYPE ${name} ${this.prometheusType(firstMetric.type)}`
        );
      }

      // Export each label combination
      for (const metric of metrics) {
        const labelsStr = this.formatPrometheusLabels(
          metric.labels,
          helpers
        );

        if (metric.value !== undefined) {
          // Counter or gauge
          const timestamp = this.config.includeTimestamps
            ? ` ${metric.timestamp}`
            : '';
          lines.push(`${name}${labelsStr} ${metric.value}${timestamp}`);
        } else if (metric.distribution) {
          // Histogram or summary
          const dist = metric.distribution;

          // Add summary stats
          lines.push(`${name}_count${labelsStr} ${dist.count}`);
          lines.push(`${name}_sum${labelsStr} ${dist.sum}`);

          // Add quantiles
          const quantileLabels = this.formatPrometheusLabels(
            { ...metric.labels, quantile: '0.5' },
            helpers
          );
          lines.push(`${name}${quantileLabels} ${dist.p50}`);

          const p95Labels = this.formatPrometheusLabels(
            { ...metric.labels, quantile: '0.95' },
            helpers
          );
          lines.push(`${name}${p95Labels} ${dist.p95}`);

          const p99Labels = this.formatPrometheusLabels(
            { ...metric.labels, quantile: '0.99' },
            helpers
          );
          lines.push(`${name}${p99Labels} ${dist.p99}`);
        }
      }

      // Add blank line between metrics
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Export metrics in JSON format
   *
   * Simple JSON array of all metrics with full data.
   *
   * @param snapshot - Metric snapshots
   * @returns JSON object
   */
  private exportJSON(snapshot: MetricSnapshot[]): object {
    return {
      timestamp: Date.now(),
      metrics: snapshot.map(metric => ({
        name: this.config.metricPrefix + metric.name,
        type: metric.type,
        value: metric.value,
        distribution: metric.distribution,
        labels: { ...this.config.defaultLabels, ...metric.labels },
        timestamp: metric.timestamp,
      })),
    };
  }

  /**
   * Export metrics in OpenTelemetry format
   *
   * OTLP-compatible JSON format.
   *
   * @param snapshot - Metric snapshots
   * @returns OpenTelemetry JSON
   */
  private exportOpenTelemetry(snapshot: MetricSnapshot[]): object {
    const resourceMetrics = {
      resource: {
        attributes: Object.entries(this.config.defaultLabels || {}).map(
          ([key, value]) => ({
            key,
            value: { stringValue: value },
          })
        ),
      },
      instrumentationLibraryMetrics: [
        {
          instrumentationLibrary: {
            name: '@arbitrage/core',
            version: '1.0.0',
          },
          metrics: snapshot.map(metric => this.toOTLPMetric(metric)),
        },
      ],
    };

    return {
      resourceMetrics: [resourceMetrics],
    };
  }

  /**
   * Convert metric snapshot to OTLP format
   *
   * @param metric - Metric snapshot
   * @returns OTLP metric
   */
  private toOTLPMetric(metric: MetricSnapshot): object {
    const name = this.config.metricPrefix + metric.name;
    const attributes = Object.entries(metric.labels).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));

    const dataPoint = {
      attributes,
      timeUnixNano: metric.timestamp * 1000000, // Convert ms to ns
    };

    switch (metric.type) {
      case MetricType.COUNTER:
        return {
          name,
          sum: {
            dataPoints: [
              {
                ...dataPoint,
                asInt: Math.floor(metric.value ?? 0),
              },
            ],
            aggregationTemporality: 2, // CUMULATIVE
            isMonotonic: true,
          },
        };

      case MetricType.GAUGE:
        return {
          name,
          gauge: {
            dataPoints: [
              {
                ...dataPoint,
                asDouble: metric.value ?? 0,
              },
            ],
          },
        };

      case MetricType.HISTOGRAM:
      case MetricType.SUMMARY:
        return {
          name,
          summary: {
            dataPoints: [
              {
                ...dataPoint,
                count: metric.distribution?.count ?? 0,
                sum: metric.distribution?.sum ?? 0,
                quantileValues: [
                  { quantile: 0.5, value: metric.distribution?.p50 ?? 0 },
                  { quantile: 0.95, value: metric.distribution?.p95 ?? 0 },
                  { quantile: 0.99, value: metric.distribution?.p99 ?? 0 },
                ],
              },
            ],
          },
        };

      default:
        return { name };
    }
  }

  /**
   * Generate Grafana panel definitions
   *
   * Converts panel definitions to Grafana JSON format.
   *
   * @param panels - Panel definitions
   * @returns Grafana panel array
   */
  private generatePanels(panels: GrafanaPanelDefinition[]): object[] {
    return panels.map((panel, index) => {
      const basePanel = {
        datasource: '${DS_PROMETHEUS}',
        fieldConfig: {
          defaults: {
            color: {
              mode: 'palette-classic',
            },
            custom: {
              axisLabel: '',
              axisPlacement: 'auto',
              barAlignment: 0,
              drawStyle: 'line',
              fillOpacity: 10,
              gradientMode: 'none',
              hideFrom: {
                tooltip: false,
                viz: false,
                legend: false,
              },
              lineInterpolation: 'linear',
              lineWidth: 1,
              pointSize: 5,
              scaleDistribution: {
                type: 'linear',
              },
              showPoints: 'never',
              spanNulls: true,
            },
            mappings: [],
            unit: panel.unit || 'short',
          },
          overrides: [],
        },
        gridPos: {
          h: 8,
          w: 12,
          x: (index % 2) * 12,
          y: Math.floor(index / 2) * 8,
        },
        id: index + 1,
        options: {
          legend: {
            calcs: [],
            displayMode: 'list',
            placement: 'bottom',
          },
          tooltip: {
            mode: 'single',
          },
        },
        targets: [
          {
            expr: panel.query,
            refId: 'A',
            legendFormat: panel.legend || '',
          },
        ],
        title: panel.title,
        type: panel.type,
      };

      // Add thresholds if specified
      if (panel.thresholds) {
        (basePanel.fieldConfig.defaults as any).thresholds = {
          mode: 'absolute',
          steps: [
            {
              color: 'green',
              value: null,
            },
            {
              color: 'yellow',
              value: panel.thresholds.yellow,
            },
            {
              color: 'red',
              value: panel.thresholds.red,
            },
          ],
        };
      }

      return basePanel;
    });
  }

  /**
   * Format labels for Prometheus text format
   *
   * Format: {label1="value1",label2="value2"}
   *
   * @param labels - Label object
   * @param helpers - Prometheus helpers
   * @returns Formatted label string
   */
  private formatPrometheusLabels(
    labels: Record<string, string | undefined>,
    helpers: IPrometheusHelpers
  ): string {
    const allLabels = { ...this.config.defaultLabels, ...labels };
    const entries = Object.entries(allLabels).filter(
      ([_, value]) => value !== undefined
    );

    if (entries.length === 0) {
      return '';
    }

    const labelPairs = entries.map(
      ([key, value]) =>
        `${key}="${helpers.escapeLabelValue(value as string)}"`
    );

    return `{${labelPairs.join(',')}}`;
  }

  /**
   * Convert metric type to Prometheus type string
   *
   * @param type - Metric type
   * @returns Prometheus type string
   */
  private prometheusType(type: MetricType): string {
    switch (type) {
      case MetricType.COUNTER:
        return 'counter';
      case MetricType.GAUGE:
        return 'gauge';
      case MetricType.HISTOGRAM:
        return 'histogram';
      case MetricType.SUMMARY:
        return 'summary';
      default:
        return 'untyped';
    }
  }
}

/**
 * Prometheus helper utilities
 */
export class PrometheusHelpers implements IPrometheusHelpers {
  /**
   * Escape label value for Prometheus format
   *
   * Escapes: \, ", \n
   *
   * @param value - Label value
   * @returns Escaped value
   */
  escapeLabelValue(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }

  /**
   * Format metric name (lowercase, underscores)
   *
   * @param name - Raw metric name
   * @returns Formatted metric name
   */
  formatMetricName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_');
  }

  /**
   * Generate Prometheus help text
   *
   * @param name - Metric name
   * @param description - Metric description
   * @returns Prometheus HELP line
   */
  generateHelpText(name: string, description: string): string {
    return `# HELP ${name} ${description}`;
  }

  /**
   * Generate Prometheus type text
   *
   * @param name - Metric name
   * @param type - Metric type
   * @returns Prometheus TYPE line
   */
  generateTypeText(name: string, type: string): string {
    return `# TYPE ${name} ${type}`;
  }
}

/**
 * Internal exporter statistics
 */
interface InternalExporterStats {
  totalExports: number;
  successfulExports: number;
  failedExports: number;
  totalDurationMs: number;
  lastExportTimestamp: number;
  lastExportStatus: 'success' | 'failure';
}
