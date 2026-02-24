/**
 * Metrics Domain Tests
 *
 * Tests for metrics domain models including:
 * - MetricValue: Immutable value object for metric observations
 * - MetricTimestamp: Timezone-aware timestamp value object
 * - MetricThreshold: Alerting threshold value object
 * - MetricType enum: Metric type classification
 * - RecordMetricRequest/Response: DTOs for collect use case
 * - ExportMetricsRequest/Response: DTOs for export use case
 * - ValidationError: DTO validation error class
 *
 * @see metrics/domain/models.ts - Domain model implementations
 * @see metrics/domain/metrics-collector.interface.ts - MetricType enum
 * @see metrics/application/dtos/ - DTO implementations
 */

import { MetricValue, MetricTimestamp, MetricThreshold } from '../../src/domain/models';
import { MetricType } from '../../src/domain/metrics-collector.interface';
import { ExportFormat } from '../../src/domain/metrics-exporter.interface';
import {
  RecordMetricRequest,
  RecordMetricResponse,
  ValidationError as CollectValidationError,
} from '../../src/application/dtos/collect-metrics.dto';
import {
  ExportMetricsRequest,
  ExportMetricsResponse,
  ValidationError as ExportValidationError,
} from '../../src/application/dtos/export-metrics.dto';

// ==========================================================================
// MetricValue
// ==========================================================================

describe('MetricValue', () => {
  describe('factory methods', () => {
    it('should create a counter metric value', () => {
      const metric = MetricValue.counter('cache_hits_total', 1);

      expect(metric.name).toBe('cache_hits_total');
      expect(metric.type).toBe(MetricType.COUNTER);
      expect(metric.value).toBe(1);
      expect(metric.labels).toEqual({});
      expect(metric.timestamp).toBeGreaterThan(0);
    });

    it('should create a gauge metric value', () => {
      const metric = MetricValue.gauge('cache_size_bytes', 67108864, { cache_level: 'l1' });

      expect(metric.name).toBe('cache_size_bytes');
      expect(metric.type).toBe(MetricType.GAUGE);
      expect(metric.value).toBe(67108864);
      expect(metric.labels).toEqual({ cache_level: 'l1' });
    });

    it('should create a histogram metric value', () => {
      const metric = MetricValue.histogram('cache_latency_ms', 2.5, { operation: 'read' });

      expect(metric.name).toBe('cache_latency_ms');
      expect(metric.type).toBe(MetricType.HISTOGRAM);
      expect(metric.value).toBe(2.5);
    });

    it('should create a summary metric value', () => {
      const metric = MetricValue.summary('request_duration_ms', 15.3);

      expect(metric.name).toBe('request_duration_ms');
      expect(metric.type).toBe(MetricType.SUMMARY);
      expect(metric.value).toBe(15.3);
    });

    it('should accept explicit timestamp', () => {
      const ts = 1700000000000;
      const metric = MetricValue.counter('test_counter', 1, {}, ts);

      expect(metric.timestamp).toBe(ts);
    });
  });

  describe('getQualifiedName', () => {
    it('should return name without labels when labels are empty', () => {
      const metric = MetricValue.counter('cache_hits_total', 1);
      expect(metric.getQualifiedName()).toBe('cache_hits_total');
    });

    it('should return name with labels formatted', () => {
      const metric = MetricValue.gauge('cache_size_bytes', 100, {
        cache_level: 'l1',
        operation: 'read',
      });

      const qualified = metric.getQualifiedName();
      expect(qualified).toContain('cache_size_bytes{');
      expect(qualified).toContain('cache_level="l1"');
      expect(qualified).toContain('operation="read"');
    });
  });

  describe('isRecent', () => {
    it('should return true for recent metric', () => {
      const metric = MetricValue.counter('test', 1);
      expect(metric.isRecent(60000)).toBe(true);
    });

    it('should return false for old metric', () => {
      const oldTs = Date.now() - 120000;
      const metric = MetricValue.counter('test', 1, {}, oldTs);
      expect(metric.isRecent(60000)).toBe(false);
    });
  });

  describe('toString', () => {
    it('should format as name = value @ timestamp', () => {
      const ts = 1700000000000;
      const metric = MetricValue.counter('test_counter', 42, {}, ts);
      const str = metric.toString();

      expect(str).toBe(`test_counter = 42 @ ${ts}`);
    });
  });

  describe('immutability', () => {
    it('should be frozen (immutable)', () => {
      const metric = MetricValue.counter('test', 1);
      expect(Object.isFrozen(metric)).toBe(true);
    });
  });
});

// ==========================================================================
// MetricTimestamp
// ==========================================================================

describe('MetricTimestamp', () => {
  describe('factory methods', () => {
    it('should create timestamp from now()', () => {
      const before = Date.now();
      const ts = MetricTimestamp.now();
      const after = Date.now();

      expect(ts.unixMs).toBeGreaterThanOrEqual(before);
      expect(ts.unixMs).toBeLessThanOrEqual(after);
      expect(ts.iso8601).toBeTruthy();
    });

    it('should create timestamp from Unix ms', () => {
      const unixMs = 1700000000000;
      const ts = MetricTimestamp.fromUnixMs(unixMs);

      expect(ts.unixMs).toBe(unixMs);
      expect(ts.iso8601).toBe(new Date(unixMs).toISOString());
    });

    it('should create timestamp from ISO 8601 string', () => {
      const iso = '2023-11-14T22:13:20.000Z';
      const ts = MetricTimestamp.fromISO8601(iso);

      expect(ts.iso8601).toBe(iso);
      expect(ts.unixMs).toBe(new Date(iso).getTime());
    });
  });

  describe('getAgeMs', () => {
    it('should return age in milliseconds', () => {
      const pastMs = Date.now() - 5000;
      const ts = MetricTimestamp.fromUnixMs(pastMs);

      const age = ts.getAgeMs();
      expect(age).toBeGreaterThanOrEqual(5000);
      expect(age).toBeLessThan(6000);
    });
  });

  describe('isWithin', () => {
    it('should return true when within range', () => {
      const ts = MetricTimestamp.fromUnixMs(1000);
      expect(ts.isWithin(500, 1500)).toBe(true);
    });

    it('should return true at range boundaries', () => {
      const ts = MetricTimestamp.fromUnixMs(1000);
      expect(ts.isWithin(1000, 2000)).toBe(true);
      expect(ts.isWithin(500, 1000)).toBe(true);
    });

    it('should return false when outside range', () => {
      const ts = MetricTimestamp.fromUnixMs(1000);
      expect(ts.isWithin(1500, 2000)).toBe(false);
      expect(ts.isWithin(0, 500)).toBe(false);
    });
  });

  describe('toPrometheusFormat', () => {
    it('should return Unix seconds with 3 decimal places', () => {
      const ts = MetricTimestamp.fromUnixMs(1700000000000);
      expect(ts.toPrometheusFormat()).toBe('1700000000.000');
    });

    it('should handle sub-second precision', () => {
      const ts = MetricTimestamp.fromUnixMs(1700000000123);
      expect(ts.toPrometheusFormat()).toBe('1700000000.123');
    });
  });

  describe('toString', () => {
    it('should return ISO 8601 string', () => {
      const iso = '2023-11-14T22:13:20.000Z';
      const ts = MetricTimestamp.fromISO8601(iso);
      expect(ts.toString()).toBe(iso);
    });
  });

  describe('immutability', () => {
    it('should be frozen (immutable)', () => {
      const ts = MetricTimestamp.now();
      expect(Object.isFrozen(ts)).toBe(true);
    });
  });
});

// ==========================================================================
// MetricThreshold
// ==========================================================================

describe('MetricThreshold', () => {
  describe('factory methods', () => {
    it('should create greaterThan threshold', () => {
      const threshold = MetricThreshold.greaterThan('cache_hit_rate', 0.95, 0.90);

      expect(threshold.metricName).toBe('cache_hit_rate');
      expect(threshold.warningValue).toBe(0.95);
      expect(threshold.criticalValue).toBe(0.90);
      expect(threshold.operator).toBe('gt');
    });

    it('should create lessThan threshold', () => {
      const threshold = MetricThreshold.lessThan('latency_ms', 50, 100);

      expect(threshold.metricName).toBe('latency_ms');
      expect(threshold.warningValue).toBe(50);
      expect(threshold.criticalValue).toBe(100);
      expect(threshold.operator).toBe('lt');
    });
  });

  describe('isWarning', () => {
    it('should return true when value exceeds warning for greaterThan', () => {
      const threshold = MetricThreshold.greaterThan('rate', 0.95, 0.90);
      expect(threshold.isWarning(0.96)).toBe(true);
    });

    it('should return false when value is below warning for greaterThan', () => {
      const threshold = MetricThreshold.greaterThan('rate', 0.95, 0.90);
      expect(threshold.isWarning(0.94)).toBe(false);
    });

    it('should return true when value exceeds warning for lessThan', () => {
      const threshold = MetricThreshold.lessThan('latency', 50, 100);
      expect(threshold.isWarning(30)).toBe(true);
    });

    it('should return false when value is above warning for lessThan', () => {
      const threshold = MetricThreshold.lessThan('latency', 50, 100);
      expect(threshold.isWarning(60)).toBe(false);
    });
  });

  describe('isCritical', () => {
    it('should return true when value exceeds critical for greaterThan', () => {
      const threshold = MetricThreshold.greaterThan('rate', 0.95, 0.90);
      expect(threshold.isCritical(0.91)).toBe(true);
    });

    it('should return false when value is below critical for greaterThan', () => {
      const threshold = MetricThreshold.greaterThan('rate', 0.95, 0.90);
      expect(threshold.isCritical(0.89)).toBe(false);
    });
  });

  describe('getAlertLevel', () => {
    it('should return critical when both thresholds exceeded', () => {
      const threshold = MetricThreshold.greaterThan('rate', 0.95, 0.90);
      expect(threshold.getAlertLevel(0.96)).toBe('critical');
    });

    it('should return warning when only warning threshold exceeded', () => {
      const threshold = MetricThreshold.greaterThan('rate', 0.80, 0.95);
      // value 0.85 is > 0.80 (warning) but not > 0.95 (critical)
      expect(threshold.getAlertLevel(0.85)).toBe('warning');
    });

    it('should return ok when no thresholds exceeded', () => {
      const threshold = MetricThreshold.greaterThan('rate', 0.95, 0.90);
      expect(threshold.getAlertLevel(0.50)).toBe('ok');
    });
  });

  describe('toString', () => {
    it('should format greaterThan threshold', () => {
      const threshold = MetricThreshold.greaterThan('cache_hit_rate', 0.95, 0.90);
      const str = threshold.toString();
      expect(str).toContain('cache_hit_rate');
      expect(str).toContain('>');
      expect(str).toContain('0.95');
      expect(str).toContain('0.9');
    });

    it('should format lessThan threshold', () => {
      const threshold = MetricThreshold.lessThan('latency_ms', 50, 100);
      const str = threshold.toString();
      expect(str).toContain('latency_ms');
      expect(str).toContain('<');
    });
  });

  describe('immutability', () => {
    it('should be frozen (immutable)', () => {
      const threshold = MetricThreshold.greaterThan('test', 1, 2);
      expect(Object.isFrozen(threshold)).toBe(true);
    });
  });
});

// ==========================================================================
// MetricType Enum
// ==========================================================================

describe('MetricType', () => {
  it('should define all expected metric types', () => {
    expect(MetricType.COUNTER).toBe('counter');
    expect(MetricType.GAUGE).toBe('gauge');
    expect(MetricType.HISTOGRAM).toBe('histogram');
    expect(MetricType.SUMMARY).toBe('summary');
  });
});

// ==========================================================================
// ExportFormat Enum
// ==========================================================================

describe('ExportFormat', () => {
  it('should define all expected export formats', () => {
    expect(ExportFormat.PROMETHEUS).toBe('prometheus');
    expect(ExportFormat.JSON).toBe('json');
    expect(ExportFormat.GRAFANA_DASHBOARD).toBe('grafana_dashboard');
    expect(ExportFormat.OPENTELEMETRY).toBe('opentelemetry');
  });
});

// ==========================================================================
// RecordMetricRequest DTO
// ==========================================================================

describe('RecordMetricRequest', () => {
  describe('create', () => {
    it('should create a valid request', () => {
      const req = RecordMetricRequest.create({
        name: 'cache_hits_total',
        type: MetricType.COUNTER,
        value: 1,
        labels: { cache_level: 'l1' },
      });

      expect(req.name).toBe('cache_hits_total');
      expect(req.type).toBe(MetricType.COUNTER);
      expect(req.value).toBe(1);
      expect(req.labels).toEqual({ cache_level: 'l1' });
    });

    it('should throw ValidationError for empty name', () => {
      expect(() =>
        RecordMetricRequest.create({
          name: '',
          type: MetricType.COUNTER,
          value: 1,
        })
      ).toThrow(CollectValidationError);
    });

    it('should throw ValidationError for invalid metric name format', () => {
      expect(() =>
        RecordMetricRequest.create({
          name: 'UPPERCASE_NAME',
          type: MetricType.COUNTER,
          value: 1,
        })
      ).toThrow(CollectValidationError);
    });

    it('should throw ValidationError for non-finite value', () => {
      expect(() =>
        RecordMetricRequest.create({
          name: 'test_metric',
          type: MetricType.GAUGE,
          value: Infinity,
        })
      ).toThrow(CollectValidationError);
    });
  });

  describe('convenience factories', () => {
    it('should create counter request', () => {
      const req = RecordMetricRequest.counter('cache_hits', { cache_level: 'l1' }, 5);

      expect(req.type).toBe(MetricType.COUNTER);
      expect(req.value).toBe(5);
    });

    it('should create gauge request', () => {
      const req = RecordMetricRequest.gauge('cache_size', 1024);

      expect(req.type).toBe(MetricType.GAUGE);
      expect(req.value).toBe(1024);
    });

    it('should create histogram request', () => {
      const req = RecordMetricRequest.histogram('latency_ms', 2.5);

      expect(req.type).toBe(MetricType.HISTOGRAM);
      expect(req.value).toBe(2.5);
    });
  });

  describe('toString', () => {
    it('should format request for logging', () => {
      const req = RecordMetricRequest.counter('cache_hits', { cache_level: 'l1' });
      const str = req.toString();

      expect(str).toContain('RecordMetricRequest');
      expect(str).toContain('cache_hits');
    });
  });
});

// ==========================================================================
// RecordMetricResponse DTO
// ==========================================================================

describe('RecordMetricResponse', () => {
  it('should create success response', () => {
    const resp = RecordMetricResponse.success('cache_hits', 5.0);

    expect(resp.success).toBe(true);
    expect(resp.metricName).toBe('cache_hits');
    expect(resp.durationUs).toBe(5.0);
    expect(resp.error).toBeUndefined();
  });

  it('should create failure response', () => {
    const resp = RecordMetricResponse.failure('cache_hits', 'Metric not defined', 10.0);

    expect(resp.success).toBe(false);
    expect(resp.error).toBe('Metric not defined');
  });

  it('should check if within performance target', () => {
    const fast = RecordMetricResponse.success('test', 5.0);
    expect(fast.isWithinTarget(10)).toBe(true);

    const slow = RecordMetricResponse.success('test', 15.0);
    expect(slow.isWithinTarget(10)).toBe(false);
  });

  it('should format toString for success', () => {
    const resp = RecordMetricResponse.success('cache_hits', 5.0);
    expect(resp.toString()).toContain('cache_hits');
    expect(resp.toString()).not.toContain('FAILED');
  });

  it('should format toString for failure', () => {
    const resp = RecordMetricResponse.failure('cache_hits', 'Error', 5.0);
    expect(resp.toString()).toContain('FAILED');
  });

  it('should be frozen (immutable)', () => {
    const resp = RecordMetricResponse.success('test', 1.0);
    expect(Object.isFrozen(resp)).toBe(true);
  });
});

// ==========================================================================
// ExportMetricsRequest DTO
// ==========================================================================

describe('ExportMetricsRequest', () => {
  describe('create', () => {
    it('should create a valid export request', () => {
      const req = ExportMetricsRequest.create({
        format: ExportFormat.PROMETHEUS,
        includeTimestamps: true,
        includeMetadata: true,
        metricPrefix: 'arbitrage_',
      });

      expect(req.format).toBe(ExportFormat.PROMETHEUS);
      expect(req.includeTimestamps).toBe(true);
      expect(req.includeMetadata).toBe(true);
      expect(req.metricPrefix).toBe('arbitrage_');
    });

    it('should throw ValidationError for invalid metric prefix', () => {
      expect(() =>
        ExportMetricsRequest.create({
          format: ExportFormat.PROMETHEUS,
          metricPrefix: 'INVALID PREFIX',
        })
      ).toThrow(ExportValidationError);
    });
  });

  describe('convenience factories', () => {
    it('should create Prometheus request', () => {
      const req = ExportMetricsRequest.prometheus('arbitrage_');

      expect(req.format).toBe(ExportFormat.PROMETHEUS);
      expect(req.metricPrefix).toBe('arbitrage_');
      expect(req.includeMetadata).toBe(true);
    });

    it('should create JSON request', () => {
      const req = ExportMetricsRequest.json(true);

      expect(req.format).toBe(ExportFormat.JSON);
      expect(req.includeTimestamps).toBe(true);
    });
  });

  it('should be frozen (immutable)', () => {
    const req = ExportMetricsRequest.prometheus();
    expect(Object.isFrozen(req)).toBe(true);
  });
});

// ==========================================================================
// ExportMetricsResponse DTO
// ==========================================================================

describe('ExportMetricsResponse', () => {
  it('should create success response', () => {
    const resp = ExportMetricsResponse.success({
      format: ExportFormat.PROMETHEUS,
      data: '# HELP cache_hits Total cache hits\ncache_hits 42',
      metricsExported: 1,
      durationMs: 2.5,
    });

    expect(resp.success).toBe(true);
    expect(resp.format).toBe(ExportFormat.PROMETHEUS);
    expect(resp.metricsExported).toBe(1);
  });

  it('should create failure response', () => {
    const resp = ExportMetricsResponse.failure(
      ExportFormat.PROMETHEUS,
      ['Export timeout'],
      10.0
    );

    expect(resp.success).toBe(false);
    expect(resp.errors).toEqual(['Export timeout']);
  });

  it('should get data as string for text-based formats', () => {
    const resp = ExportMetricsResponse.success({
      format: ExportFormat.PROMETHEUS,
      data: 'cache_hits 42',
      metricsExported: 1,
      durationMs: 1.0,
    });

    expect(resp.getDataAsString()).toBe('cache_hits 42');
  });

  it('should get data as object for JSON formats', () => {
    const jsonData = { metrics: [{ name: 'test', value: 42 }] };
    const resp = ExportMetricsResponse.success({
      format: ExportFormat.JSON,
      data: jsonData,
      metricsExported: 1,
      durationMs: 1.0,
    });

    expect(resp.getDataAsObject()).toEqual(jsonData);
  });

  it('should be frozen (immutable)', () => {
    const resp = ExportMetricsResponse.success({
      format: ExportFormat.JSON,
      data: {},
      metricsExported: 0,
      durationMs: 0,
    });
    expect(Object.isFrozen(resp)).toBe(true);
  });
});
