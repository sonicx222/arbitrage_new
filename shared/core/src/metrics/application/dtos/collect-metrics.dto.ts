/**
 * DTOs for CollectMetrics Use Case
 *
 * Data Transfer Objects with validation for metrics collection operations.
 *
 * @package @arbitrage/core
 * @module metrics/application/dtos
 */

import { MetricType, MetricLabels } from '../../domain';

/**
 * Request to record a metric
 */
export class RecordMetricRequest {
  private constructor(
    public readonly name: string,
    public readonly type: MetricType,
    public readonly value: number,
    public readonly labels: MetricLabels = {}
  ) {
    Object.freeze(this);
  }

  /**
   * Create validated request
   *
   * @throws {ValidationError} If validation fails
   */
  static create(params: {
    name: string;
    type: MetricType;
    value: number;
    labels?: MetricLabels;
  }): RecordMetricRequest {
    // Validate name
    if (!params.name || params.name.trim().length === 0) {
      throw new ValidationError('name', 'Metric name cannot be empty');
    }

    // Prometheus naming convention
    if (!/^[a-z][a-z0-9_]*$/.test(params.name)) {
      throw new ValidationError(
        'name',
        'Metric name must be lowercase letters, numbers, underscores only'
      );
    }

    // Validate type
    if (!Object.values(MetricType).includes(params.type)) {
      throw new ValidationError('type', `Invalid metric type: ${params.type}`);
    }

    // Validate value
    if (typeof params.value !== 'number' || !isFinite(params.value)) {
      throw new ValidationError('value', 'Metric value must be a finite number');
    }

    // Validate labels (if provided)
    if (params.labels) {
      for (const [key, value] of Object.entries(params.labels)) {
        if (value !== undefined && typeof value !== 'string') {
          throw new ValidationError(
            'labels',
            `Label value for '${key}' must be a string`
          );
        }
      }
    }

    return new RecordMetricRequest(
      params.name,
      params.type,
      params.value,
      params.labels ?? {}
    );
  }

  /**
   * Create request for counter increment
   */
  static counter(
    name: string,
    labels?: MetricLabels,
    delta: number = 1
  ): RecordMetricRequest {
    return RecordMetricRequest.create({
      name,
      type: MetricType.COUNTER,
      value: delta,
      labels,
    });
  }

  /**
   * Create request for gauge update
   */
  static gauge(
    name: string,
    value: number,
    labels?: MetricLabels
  ): RecordMetricRequest {
    return RecordMetricRequest.create({
      name,
      type: MetricType.GAUGE,
      value,
      labels,
    });
  }

  /**
   * Create request for histogram observation
   */
  static histogram(
    name: string,
    value: number,
    labels?: MetricLabels
  ): RecordMetricRequest {
    return RecordMetricRequest.create({
      name,
      type: MetricType.HISTOGRAM,
      value,
      labels,
    });
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    const labelStr = Object.entries(this.labels)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    const labels = labelStr ? `{${labelStr}}` : '';
    return `RecordMetricRequest[${this.name}${labels} = ${this.value}]`;
  }
}

/**
 * Response from record metric operation
 */
export class RecordMetricResponse {
  constructor(
    public readonly success: boolean,
    public readonly metricName: string,
    public readonly durationUs: number,
    public readonly error?: string
  ) {
    Object.freeze(this);
  }

  /**
   * Create successful response
   */
  static success(metricName: string, durationUs: number): RecordMetricResponse {
    return new RecordMetricResponse(true, metricName, durationUs);
  }

  /**
   * Create failure response
   */
  static failure(metricName: string, error: string, durationUs: number): RecordMetricResponse {
    return new RecordMetricResponse(false, metricName, durationUs, error);
  }

  /**
   * Check if operation was fast enough (<10μs target)
   */
  isWithinTarget(targetUs: number = 10): boolean {
    return this.durationUs < targetUs;
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    if (!this.success) {
      return `RecordMetricResponse[FAILED: ${this.error}]`;
    }
    return `RecordMetricResponse[${this.metricName}, ${this.durationUs.toFixed(2)}μs]`;
  }
}

/**
 * Validation error for DTOs
 */
export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(`Validation failed for '${field}': ${message}`);
    this.name = 'ValidationError';
  }
}
