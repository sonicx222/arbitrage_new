/**
 * Domain Models for Metrics Collection
 *
 * Value objects and domain entities following DDD principles.
 *
 * @package @arbitrage/metrics
 * @module metrics/domain
 */

import { MetricType, MetricLabels } from './metrics-collector.interface';

/**
 * Value Object: Metric Value
 *
 * Immutable representation of a single metric observation.
 */
export class MetricValue {
  private constructor(
    public readonly name: string,
    public readonly type: MetricType,
    public readonly value: number,
    public readonly labels: MetricLabels,
    public readonly timestamp: number
  ) {
    Object.freeze(this);
  }

  /**
   * Create metric value for counter
   */
  static counter(
    name: string,
    value: number,
    labels: MetricLabels = {},
    timestamp: number = Date.now()
  ): MetricValue {
    return new MetricValue(name, MetricType.COUNTER, value, labels, timestamp);
  }

  /**
   * Create metric value for gauge
   */
  static gauge(
    name: string,
    value: number,
    labels: MetricLabels = {},
    timestamp: number = Date.now()
  ): MetricValue {
    return new MetricValue(name, MetricType.GAUGE, value, labels, timestamp);
  }

  /**
   * Create metric value for histogram
   */
  static histogram(
    name: string,
    value: number,
    labels: MetricLabels = {},
    timestamp: number = Date.now()
  ): MetricValue {
    return new MetricValue(name, MetricType.HISTOGRAM, value, labels, timestamp);
  }

  /**
   * Create metric value for summary
   */
  static summary(
    name: string,
    value: number,
    labels: MetricLabels = {},
    timestamp: number = Date.now()
  ): MetricValue {
    return new MetricValue(name, MetricType.SUMMARY, value, labels, timestamp);
  }

  /**
   * Get fully qualified metric name with labels
   */
  getQualifiedName(): string {
    const labelStr = Object.entries(this.labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return labelStr ? `${this.name}{${labelStr}}` : this.name;
  }

  /**
   * Check if metric is recent
   */
  isRecent(windowMs: number): boolean {
    return Date.now() - this.timestamp < windowMs;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `${this.getQualifiedName()} = ${this.value} @ ${this.timestamp}`;
  }
}

/**
 * Value Object: Metric Timestamp
 *
 * Represents a point in time for metric observations with timezone awareness.
 */
export class MetricTimestamp {
  private constructor(
    public readonly unixMs: number,
    public readonly iso8601: string
  ) {
    Object.freeze(this);
  }

  /**
   * Create timestamp from current time
   */
  static now(): MetricTimestamp {
    const now = Date.now();
    return new MetricTimestamp(now, new Date(now).toISOString());
  }

  /**
   * Create timestamp from Unix milliseconds
   */
  static fromUnixMs(unixMs: number): MetricTimestamp {
    return new MetricTimestamp(unixMs, new Date(unixMs).toISOString());
  }

  /**
   * Create timestamp from ISO 8601 string
   */
  static fromISO8601(iso: string): MetricTimestamp {
    const date = new Date(iso);
    return new MetricTimestamp(date.getTime(), iso);
  }

  /**
   * Get age in milliseconds
   */
  getAgeMs(): number {
    return Date.now() - this.unixMs;
  }

  /**
   * Check if timestamp is within time range
   */
  isWithin(startMs: number, endMs: number): boolean {
    return this.unixMs >= startMs && this.unixMs <= endMs;
  }

  /**
   * Convert to Prometheus format (Unix seconds)
   */
  toPrometheusFormat(): string {
    return (this.unixMs / 1000).toFixed(3);
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return this.iso8601;
  }
}

/**
 * Value Object: Metric Threshold
 *
 * Represents alerting thresholds for a metric.
 */
export class MetricThreshold {
  private constructor(
    public readonly metricName: string,
    public readonly warningValue: number,
    public readonly criticalValue: number,
    public readonly operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte'
  ) {
    Object.freeze(this);
  }

  /**
   * Create threshold for values that should be above a minimum
   *
   * Example: Cache hit rate should be > 95%
   */
  static greaterThan(metricName: string, warning: number, critical: number): MetricThreshold {
    return new MetricThreshold(metricName, warning, critical, 'gt');
  }

  /**
   * Create threshold for values that should be below a maximum
   *
   * Example: Latency should be < 50ms
   */
  static lessThan(metricName: string, warning: number, critical: number): MetricThreshold {
    return new MetricThreshold(metricName, warning, critical, 'lt');
  }

  /**
   * Check if value triggers warning threshold
   */
  isWarning(value: number): boolean {
    return this.compare(value, this.warningValue);
  }

  /**
   * Check if value triggers critical threshold
   */
  isCritical(value: number): boolean {
    return this.compare(value, this.criticalValue);
  }

  /**
   * Get alert level for value
   */
  getAlertLevel(value: number): 'ok' | 'warning' | 'critical' {
    if (this.isCritical(value)) return 'critical';
    if (this.isWarning(value)) return 'warning';
    return 'ok';
  }

  /**
   * Compare value against threshold
   */
  private compare(value: number, threshold: number): boolean {
    switch (this.operator) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'gte': return value >= threshold;
      case 'lte': return value <= threshold;
      case 'eq': return value === threshold;
      default: return false;
    }
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    const op = this.operator === 'gt' ? '>' : this.operator === 'lt' ? '<' : this.operator;
    return `${this.metricName} ${op} warning:${this.warningValue} critical:${this.criticalValue}`;
  }
}
