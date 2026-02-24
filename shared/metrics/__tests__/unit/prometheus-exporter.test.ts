/**
 * PrometheusExporter and PrometheusHelpers Unit Tests
 *
 * Tests for the metrics infrastructure layer:
 * - PrometheusExporter: Exports metrics in Prometheus, JSON, and OpenTelemetry formats
 * - PrometheusHelpers: Utility functions for Prometheus text formatting
 *
 * @see metrics/infrastructure/prometheus-exporter.impl.ts - Implementation
 * @see metrics/domain/metrics-exporter.interface.ts - IMetricsExporter contract
 * @see metrics/domain/metrics-collector.interface.ts - IMetricsCollector contract
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  PrometheusExporter,
  PrometheusHelpers,
} from '../../src/infrastructure/prometheus-exporter.impl';
import {
  ExportFormat,
  ExportConfig,
  GrafanaDashboardConfig,
  GrafanaPanelDefinition,
} from '../../src/domain/metrics-exporter.interface';
import {
  IMetricsCollector,
  MetricType,
  MetricSnapshot,
  MetricDefinition,
  MetricLabels,
  CollectorStats,
} from '../../src/domain/metrics-collector.interface';

export {};

// ==========================================================================
// Test Helpers
// ==========================================================================

function createMockCollector(
  snapshots: MetricSnapshot[] = []
): IMetricsCollector {
  return {
    defineMetric: jest.fn<(definition: MetricDefinition) => void>(),
    incrementCounter: jest.fn<(name: string, labels?: MetricLabels, delta?: number) => void>(),
    setGauge: jest.fn<(name: string, value: number, labels?: MetricLabels) => void>(),
    recordHistogram: jest.fn<(name: string, value: number, labels?: MetricLabels) => void>(),
    recordSummary: jest.fn<(name: string, value: number, labels?: MetricLabels) => void>(),
    getSnapshot: jest.fn<() => MetricSnapshot[]>().mockReturnValue(snapshots),
    getMetricSnapshot: jest.fn<(name: string) => MetricSnapshot | undefined>(),
    reset: jest.fn<() => void>(),
    getStats: jest.fn<() => CollectorStats>().mockReturnValue({
      metricsCount: snapshots.length,
      totalObservations: 0,
      memoryUsageBytes: 0,
      byType: { counters: 0, gauges: 0, histograms: 0, summaries: 0 },
    }),
  };
}

function makeCounterSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    name: 'requests_total',
    type: MetricType.COUNTER,
    value: 42,
    labels: {},
    timestamp: 1700000000000,
    ...overrides,
  };
}

function makeGaugeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    name: 'cache_size',
    type: MetricType.GAUGE,
    value: 128,
    labels: {},
    timestamp: 1700000000000,
    ...overrides,
  };
}

function makeHistogramSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    name: 'request_duration',
    type: MetricType.HISTOGRAM,
    labels: {},
    timestamp: 1700000000000,
    distribution: {
      count: 100,
      sum: 250.5,
      min: 0.5,
      max: 15.2,
      p50: 2.0,
      p95: 8.5,
      p99: 12.0,
    },
    ...overrides,
  };
}

function makeGrafanaConfig(): GrafanaDashboardConfig {
  return {
    title: 'Test Dashboard',
    description: 'A test dashboard',
    tags: ['test', 'metrics'],
    timeRange: '1h',
    refreshInterval: '5s',
    datasource: 'Prometheus',
  };
}

function makeGrafanaPanel(overrides: Partial<GrafanaPanelDefinition> = {}): GrafanaPanelDefinition {
  return {
    title: 'Panel Title',
    type: 'graph',
    query: 'rate(requests_total[5m])',
    ...overrides,
  };
}

// ==========================================================================
// PrometheusExporter
// ==========================================================================

describe('PrometheusExporter', () => {
  let mockCollector: IMetricsCollector;

  beforeEach(() => {
    mockCollector = createMockCollector();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('should use default config when none is provided', () => {
      const exporter = new PrometheusExporter(mockCollector);
      const config = exporter.getConfig();

      expect(config.format).toBe(ExportFormat.PROMETHEUS);
      expect(config.includeTimestamps).toBe(false);
      expect(config.includeMetadata).toBe(true);
      expect(config.metricPrefix).toBe('');
      expect(config.defaultLabels).toEqual({});
    });

    it('should merge custom config with defaults', () => {
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.JSON,
        metricPrefix: 'arb_',
      });
      const config = exporter.getConfig();

      expect(config.format).toBe(ExportFormat.JSON);
      expect(config.metricPrefix).toBe('arb_');
      // Defaults preserved
      expect(config.includeTimestamps).toBe(false);
      expect(config.includeMetadata).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // export() - Prometheus format
  // --------------------------------------------------------------------------

  describe('export - Prometheus format', () => {
    it('should export a counter metric with HELP and TYPE metadata', async () => {
      const snapshot = makeCounterSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector);

      const result = await exporter.export();

      expect(result.success).toBe(true);
      expect(result.metricsExported).toBe(1);
      const data = result.data as string;
      expect(data).toContain('# HELP requests_total counter metric');
      expect(data).toContain('# TYPE requests_total counter');
      expect(data).toContain('requests_total 42');
    });

    it('should export a gauge metric', async () => {
      const snapshot = makeGaugeSnapshot({ labels: { cache_level: 'l1' } });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector);

      const result = await exporter.export();

      const data = result.data as string;
      expect(data).toContain('# TYPE cache_size gauge');
      expect(data).toContain('cache_size{cache_level="l1"} 128');
    });

    it('should export histogram with distribution lines (_count, _sum, quantiles)', async () => {
      const snapshot = makeHistogramSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector);

      const result = await exporter.export();

      const data = result.data as string;
      expect(data).toContain('# TYPE request_duration histogram');
      expect(data).toContain('request_duration_count 100');
      expect(data).toContain('request_duration_sum 250.5');
      expect(data).toContain('request_duration{quantile="0.5"} 2');
      expect(data).toContain('request_duration{quantile="0.95"} 8.5');
      expect(data).toContain('request_duration{quantile="0.99"} 12');
    });

    it('should omit metadata when includeMetadata is false', async () => {
      const snapshot = makeCounterSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        includeMetadata: false,
      });

      const result = await exporter.export();

      const data = result.data as string;
      expect(data).not.toContain('# HELP');
      expect(data).not.toContain('# TYPE');
      expect(data).toContain('requests_total 42');
    });

    it('should include timestamps when includeTimestamps is true', async () => {
      const snapshot = makeCounterSnapshot({ timestamp: 1700000000000 });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        includeTimestamps: true,
      });

      const result = await exporter.export();

      const data = result.data as string;
      expect(data).toContain('requests_total 42 1700000000000');
    });

    it('should apply metric prefix to all metric names', async () => {
      const snapshot = makeCounterSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        metricPrefix: 'arbitrage_',
      });

      const result = await exporter.export();

      const data = result.data as string;
      expect(data).toContain('# HELP arbitrage_requests_total counter metric');
      expect(data).toContain('# TYPE arbitrage_requests_total counter');
      expect(data).toContain('arbitrage_requests_total 42');
    });

    it('should include default labels on all metrics', async () => {
      const snapshot = makeCounterSnapshot({ labels: { method: 'GET' } });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        defaultLabels: { env: 'test' },
      });

      const result = await exporter.export();

      const data = result.data as string;
      // Default label merged with metric labels
      expect(data).toContain('env="test"');
      expect(data).toContain('method="GET"');
    });

    it('should handle empty snapshot gracefully', async () => {
      mockCollector = createMockCollector([]);
      const exporter = new PrometheusExporter(mockCollector);

      const result = await exporter.export();

      expect(result.success).toBe(true);
      expect(result.metricsExported).toBe(0);
      expect(result.data).toBe('');
    });

    it('should group multiple snapshots with the same name', async () => {
      const snapshots: MetricSnapshot[] = [
        makeCounterSnapshot({ labels: { method: 'GET' } }),
        makeCounterSnapshot({ labels: { method: 'POST' } }),
      ];
      mockCollector = createMockCollector(snapshots);
      const exporter = new PrometheusExporter(mockCollector);

      const result = await exporter.export();

      const data = result.data as string;
      // HELP and TYPE should appear only once per metric name
      const helpCount = (data.match(/# HELP requests_total/g) ?? []).length;
      const typeCount = (data.match(/# TYPE requests_total/g) ?? []).length;
      expect(helpCount).toBe(1);
      expect(typeCount).toBe(1);
      // Both label combinations present
      expect(data).toContain('requests_total{method="GET"} 42');
      expect(data).toContain('requests_total{method="POST"} 42');
    });

    it('should export summary type as summary', async () => {
      const snapshot: MetricSnapshot = {
        name: 'latency',
        type: MetricType.SUMMARY,
        labels: {},
        timestamp: 1700000000000,
        distribution: {
          count: 50,
          sum: 120,
          min: 0.1,
          max: 10,
          p50: 1.5,
          p95: 5.0,
          p99: 9.0,
        },
      };
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector);

      const result = await exporter.export();

      const data = result.data as string;
      expect(data).toContain('# TYPE latency summary');
      expect(data).toContain('latency_count 50');
      expect(data).toContain('latency_sum 120');
    });
  });

  // --------------------------------------------------------------------------
  // export() - JSON format
  // --------------------------------------------------------------------------

  describe('export - JSON format', () => {
    it('should export metrics as a JSON structure with metrics array', async () => {
      const snapshot = makeCounterSnapshot({ labels: { chain: 'bsc' } });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.JSON,
      });

      const result = await exporter.export();

      expect(result.success).toBe(true);
      const data = result.data as { timestamp: number; metrics: any[] };
      expect(data.timestamp).toBeGreaterThan(0);
      expect(data.metrics).toHaveLength(1);
      expect(data.metrics[0].name).toBe('requests_total');
      expect(data.metrics[0].type).toBe(MetricType.COUNTER);
      expect(data.metrics[0].value).toBe(42);
      expect(data.metrics[0].labels).toEqual({ chain: 'bsc' });
    });

    it('should apply prefix to metric names in JSON format', async () => {
      const snapshot = makeCounterSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.JSON,
        metricPrefix: 'arb_',
      });

      const result = await exporter.export();

      const data = result.data as { metrics: any[] };
      expect(data.metrics[0].name).toBe('arb_requests_total');
    });

    it('should merge default labels with metric labels in JSON format', async () => {
      const snapshot = makeCounterSnapshot({ labels: { method: 'GET' } });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.JSON,
        defaultLabels: { service: 'coordinator' },
      });

      const result = await exporter.export();

      const data = result.data as { metrics: any[] };
      expect(data.metrics[0].labels).toEqual({
        service: 'coordinator',
        method: 'GET',
      });
    });
  });

  // --------------------------------------------------------------------------
  // export() - OpenTelemetry format
  // --------------------------------------------------------------------------

  describe('export - OpenTelemetry format', () => {
    it('should include resource attributes from default labels', async () => {
      const snapshot = makeCounterSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.OPENTELEMETRY,
        defaultLabels: { service: 'detector' },
      });

      const result = await exporter.export();

      expect(result.success).toBe(true);
      const data = result.data as any;
      const resource = data.resourceMetrics[0].resource;
      expect(resource.attributes).toEqual([
        { key: 'service', value: { stringValue: 'detector' } },
      ]);
    });

    it('should export counter as sum with isMonotonic true', async () => {
      const snapshot = makeCounterSnapshot({ value: 100, timestamp: 1700000000000 });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.OPENTELEMETRY,
      });

      const result = await exporter.export();

      const data = result.data as any;
      const metric = data.resourceMetrics[0].instrumentationLibraryMetrics[0].metrics[0];
      expect(metric.name).toBe('requests_total');
      expect(metric.sum).toBeDefined();
      expect(metric.sum.isMonotonic).toBe(true);
      expect(metric.sum.aggregationTemporality).toBe(2);
      expect(metric.sum.dataPoints[0].asInt).toBe(100);
    });

    it('should export gauge metric as gauge type', async () => {
      const snapshot = makeGaugeSnapshot({ value: 256 });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.OPENTELEMETRY,
      });

      const result = await exporter.export();

      const data = result.data as any;
      const metric = data.resourceMetrics[0].instrumentationLibraryMetrics[0].metrics[0];
      expect(metric.name).toBe('cache_size');
      expect(metric.gauge).toBeDefined();
      expect(metric.gauge.dataPoints[0].asDouble).toBe(256);
    });

    it('should export histogram as summary with quantile values', async () => {
      const snapshot = makeHistogramSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.OPENTELEMETRY,
      });

      const result = await exporter.export();

      const data = result.data as any;
      const metric = data.resourceMetrics[0].instrumentationLibraryMetrics[0].metrics[0];
      expect(metric.name).toBe('request_duration');
      expect(metric.summary).toBeDefined();
      const dp = metric.summary.dataPoints[0];
      expect(dp.count).toBe(100);
      expect(dp.sum).toBe(250.5);
      expect(dp.quantileValues).toEqual([
        { quantile: 0.5, value: 2.0 },
        { quantile: 0.95, value: 8.5 },
        { quantile: 0.99, value: 12.0 },
      ]);
    });

    it('should convert timestamp from milliseconds to nanoseconds', async () => {
      const snapshot = makeCounterSnapshot({ timestamp: 1700000000000 });
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.OPENTELEMETRY,
      });

      const result = await exporter.export();

      const data = result.data as any;
      const dp = data.resourceMetrics[0].instrumentationLibraryMetrics[0].metrics[0].sum.dataPoints[0];
      expect(dp.timeUnixNano).toBe(1700000000000 * 1000000);
    });

    it('should apply metric prefix in OpenTelemetry format', async () => {
      const snapshot = makeCounterSnapshot();
      mockCollector = createMockCollector([snapshot]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: ExportFormat.OPENTELEMETRY,
        metricPrefix: 'arb_',
      });

      const result = await exporter.export();

      const data = result.data as any;
      const metric = data.resourceMetrics[0].instrumentationLibraryMetrics[0].metrics[0];
      expect(metric.name).toBe('arb_requests_total');
    });
  });

  // --------------------------------------------------------------------------
  // export() - Error handling
  // --------------------------------------------------------------------------

  describe('export - error handling', () => {
    it('should return failure result when collector throws', async () => {
      mockCollector = createMockCollector();
      (mockCollector.getSnapshot as jest.Mock).mockImplementation(() => {
        throw new Error('Collector unavailable');
      });
      const exporter = new PrometheusExporter(mockCollector);

      const result = await exporter.export();

      expect(result.success).toBe(false);
      expect(result.metricsExported).toBe(0);
      expect(result.errors).toContain('Collector unavailable');
    });

    it('should return failure for unsupported format', async () => {
      mockCollector = createMockCollector([makeCounterSnapshot()]);
      const exporter = new PrometheusExporter(mockCollector, {
        format: 'unknown_format' as ExportFormat,
      });

      const result = await exporter.export();

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('Unsupported export format');
    });
  });

  // --------------------------------------------------------------------------
  // generateGrafanaDashboard
  // --------------------------------------------------------------------------

  describe('generateGrafanaDashboard', () => {
    it('should create a valid Grafana dashboard JSON structure', async () => {
      const exporter = new PrometheusExporter(mockCollector);
      const config = makeGrafanaConfig();
      const panels = [makeGrafanaPanel()];

      const dashboard = (await exporter.generateGrafanaDashboard(config, panels)) as any;

      expect(dashboard.title).toBe('Test Dashboard');
      expect(dashboard.description).toBe('A test dashboard');
      expect(dashboard.tags).toEqual(['test', 'metrics']);
      expect(dashboard.time.from).toBe('now-1h');
      expect(dashboard.time.to).toBe('now');
      expect(dashboard.refresh).toBe('5s');
      expect(dashboard.schemaVersion).toBe(27);
      expect(dashboard.style).toBe('dark');
    });

    it('should configure datasource input', async () => {
      const exporter = new PrometheusExporter(mockCollector);
      const config = makeGrafanaConfig();

      const dashboard = (await exporter.generateGrafanaDashboard(config, [])) as any;

      expect(dashboard.__inputs[0].name).toBe('DS_PROMETHEUS');
      expect(dashboard.__inputs[0].label).toBe('Prometheus');
      expect(dashboard.__inputs[0].type).toBe('datasource');
    });

    it('should position panels in a 2-column grid layout', async () => {
      const exporter = new PrometheusExporter(mockCollector);
      const config = makeGrafanaConfig();
      const panels = [
        makeGrafanaPanel({ title: 'Panel 1' }),
        makeGrafanaPanel({ title: 'Panel 2' }),
        makeGrafanaPanel({ title: 'Panel 3' }),
      ];

      const dashboard = (await exporter.generateGrafanaDashboard(config, panels)) as any;

      // Panel 1: first column, first row
      expect(dashboard.panels[0].gridPos).toEqual({ h: 8, w: 12, x: 0, y: 0 });
      // Panel 2: second column, first row
      expect(dashboard.panels[1].gridPos).toEqual({ h: 8, w: 12, x: 12, y: 0 });
      // Panel 3: first column, second row
      expect(dashboard.panels[2].gridPos).toEqual({ h: 8, w: 12, x: 0, y: 8 });
    });

    it('should apply thresholds when specified on a panel', async () => {
      const exporter = new PrometheusExporter(mockCollector);
      const config = makeGrafanaConfig();
      const panels = [
        makeGrafanaPanel({
          thresholds: { green: 0, yellow: 70, red: 90 },
        }),
      ];

      const dashboard = (await exporter.generateGrafanaDashboard(config, panels)) as any;

      const thresholds = dashboard.panels[0].fieldConfig.defaults.thresholds;
      expect(thresholds.mode).toBe('absolute');
      expect(thresholds.steps).toHaveLength(3);
      expect(thresholds.steps[0]).toEqual({ color: 'green', value: null });
      expect(thresholds.steps[1]).toEqual({ color: 'yellow', value: 70 });
      expect(thresholds.steps[2]).toEqual({ color: 'red', value: 90 });
    });

    it('should set panel query targets and datasource', async () => {
      const exporter = new PrometheusExporter(mockCollector);
      const config = makeGrafanaConfig();
      const panels = [
        makeGrafanaPanel({
          query: 'rate(http_requests_total[5m])',
          legend: '{{method}}',
        }),
      ];

      const dashboard = (await exporter.generateGrafanaDashboard(config, panels)) as any;

      const panel = dashboard.panels[0];
      expect(panel.datasource).toBe('${DS_PROMETHEUS}');
      expect(panel.targets[0].expr).toBe('rate(http_requests_total[5m])');
      expect(panel.targets[0].refId).toBe('A');
      expect(panel.targets[0].legendFormat).toBe('{{method}}');
    });

    it('should use panel unit or default to short', async () => {
      const exporter = new PrometheusExporter(mockCollector);
      const config = makeGrafanaConfig();
      const panels = [
        makeGrafanaPanel({ unit: 'percent' }),
        makeGrafanaPanel({ title: 'No Unit' }),
      ];

      const dashboard = (await exporter.generateGrafanaDashboard(config, panels)) as any;

      expect(dashboard.panels[0].fieldConfig.defaults.unit).toBe('percent');
      expect(dashboard.panels[1].fieldConfig.defaults.unit).toBe('short');
    });
  });

  // --------------------------------------------------------------------------
  // getStats
  // --------------------------------------------------------------------------

  describe('getStats', () => {
    it('should return zero stats initially', () => {
      const exporter = new PrometheusExporter(mockCollector);
      const stats = exporter.getStats();

      expect(stats.totalExports).toBe(0);
      expect(stats.successfulExports).toBe(0);
      expect(stats.failedExports).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
      expect(stats.lastExportTimestamp).toBe(0);
      expect(stats.lastExportStatus).toBe('success');
    });

    it('should track successful exports', async () => {
      mockCollector = createMockCollector([makeCounterSnapshot()]);
      const exporter = new PrometheusExporter(mockCollector);

      await exporter.export();
      await exporter.export();

      const stats = exporter.getStats();
      expect(stats.totalExports).toBe(2);
      expect(stats.successfulExports).toBe(2);
      expect(stats.failedExports).toBe(0);
      expect(stats.lastExportStatus).toBe('success');
      expect(stats.lastExportTimestamp).toBeGreaterThan(0);
    });

    it('should track failed exports', async () => {
      (mockCollector.getSnapshot as jest.Mock).mockImplementation(() => {
        throw new Error('fail');
      });
      const exporter = new PrometheusExporter(mockCollector);

      await exporter.export();

      const stats = exporter.getStats();
      expect(stats.totalExports).toBe(1);
      expect(stats.successfulExports).toBe(0);
      expect(stats.failedExports).toBe(1);
      expect(stats.lastExportStatus).toBe('failure');
    });

    it('should calculate average duration across exports', async () => {
      mockCollector = createMockCollector([makeCounterSnapshot()]);
      const exporter = new PrometheusExporter(mockCollector);

      await exporter.export();
      await exporter.export();
      await exporter.export();

      const stats = exporter.getStats();
      expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
      // avgDurationMs = totalDurationMs / totalExports, should be a finite number
      expect(Number.isFinite(stats.avgDurationMs)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // updateConfig / getConfig
  // --------------------------------------------------------------------------

  describe('updateConfig / getConfig', () => {
    it('should allow partial config updates', () => {
      const exporter = new PrometheusExporter(mockCollector);

      exporter.updateConfig({ metricPrefix: 'new_' });

      const config = exporter.getConfig();
      expect(config.metricPrefix).toBe('new_');
      // Other fields unchanged
      expect(config.format).toBe(ExportFormat.PROMETHEUS);
      expect(config.includeTimestamps).toBe(false);
    });

    it('should return a copy of the config (not a reference)', () => {
      const exporter = new PrometheusExporter(mockCollector);

      const config1 = exporter.getConfig();
      // Mutate the returned object to verify it is a copy
      (config1 as unknown as Record<string, unknown>).metricPrefix = 'mutated_';

      const config2 = exporter.getConfig();
      expect(config2.metricPrefix).toBe('');
    });
  });
});

// ==========================================================================
// PrometheusHelpers
// ==========================================================================

describe('PrometheusHelpers', () => {
  let helpers: PrometheusHelpers;

  beforeEach(() => {
    helpers = new PrometheusHelpers();
  });

  describe('escapeLabelValue', () => {
    it('should escape backslash characters', () => {
      expect(helpers.escapeLabelValue('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('should escape double quote characters', () => {
      expect(helpers.escapeLabelValue('value "quoted"')).toBe('value \\"quoted\\"');
    });

    it('should escape newline characters', () => {
      expect(helpers.escapeLabelValue('line1\nline2')).toBe('line1\\nline2');
    });

    it('should be a no-op for safe strings', () => {
      expect(helpers.escapeLabelValue('safe_value')).toBe('safe_value');
    });

    it('should handle combined special characters', () => {
      expect(helpers.escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    });
  });

  describe('formatMetricName', () => {
    it('should lowercase the metric name', () => {
      expect(helpers.formatMetricName('HTTP_Requests')).toBe('http_requests');
    });

    it('should replace non-alphanumeric characters with underscores', () => {
      expect(helpers.formatMetricName('cache.hit-rate')).toBe('cache_hit_rate');
    });

    it('should collapse consecutive underscores', () => {
      expect(helpers.formatMetricName('bad__name___here')).toBe('bad_name_here');
    });

    it('should handle already clean names', () => {
      expect(helpers.formatMetricName('clean_name_123')).toBe('clean_name_123');
    });
  });

  describe('generateHelpText', () => {
    it('should produce correct HELP line format', () => {
      const result = helpers.generateHelpText('requests_total', 'Total number of requests');
      expect(result).toBe('# HELP requests_total Total number of requests');
    });
  });

  describe('generateTypeText', () => {
    it('should produce correct TYPE line format', () => {
      const result = helpers.generateTypeText('requests_total', 'counter');
      expect(result).toBe('# TYPE requests_total counter');
    });
  });
});
