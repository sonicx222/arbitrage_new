/**
 * DTOs for ExportMetrics Use Case
 *
 * Data Transfer Objects with validation for metrics export operations.
 *
 * @package @arbitrage/metrics
 * @module metrics/application/dtos
 */

import { ExportFormat } from '../../domain';

/**
 * Request to export metrics
 */
export class ExportMetricsRequest {
  private constructor(
    public readonly format: ExportFormat,
    public readonly includeTimestamps: boolean = false,
    public readonly includeMetadata: boolean = true,
    public readonly metricPrefix?: string
  ) {
    Object.freeze(this);
  }

  /**
   * Create validated request
   *
   * @throws {ValidationError} If validation fails
   */
  static create(params: {
    format: ExportFormat;
    includeTimestamps?: boolean;
    includeMetadata?: boolean;
    metricPrefix?: string;
  }): ExportMetricsRequest {
    // Validate format
    if (!Object.values(ExportFormat).includes(params.format)) {
      throw new ValidationError(
        'format',
        `Invalid export format: ${params.format}`
      );
    }

    // Validate metricPrefix (if provided)
    if (params.metricPrefix !== undefined) {
      if (!/^[a-z][a-z0-9_]*$/.test(params.metricPrefix)) {
        throw new ValidationError(
          'metricPrefix',
          'Metric prefix must be lowercase letters, numbers, underscores only'
        );
      }
    }

    return new ExportMetricsRequest(
      params.format,
      params.includeTimestamps ?? false,
      params.includeMetadata ?? true,
      params.metricPrefix
    );
  }

  /**
   * Create request for Prometheus format
   */
  static prometheus(metricPrefix?: string): ExportMetricsRequest {
    return ExportMetricsRequest.create({
      format: ExportFormat.PROMETHEUS,
      includeTimestamps: false,
      includeMetadata: true,
      metricPrefix,
    });
  }

  /**
   * Create request for JSON format
   */
  static json(includeTimestamps: boolean = true): ExportMetricsRequest {
    return ExportMetricsRequest.create({
      format: ExportFormat.JSON,
      includeTimestamps,
      includeMetadata: false,
    });
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    return `ExportMetricsRequest[${this.format}, prefix=${this.metricPrefix ?? 'none'}]`;
  }
}

/**
 * Response from export metrics operation
 */
export class ExportMetricsResponse {
  constructor(
    public readonly success: boolean,
    public readonly format: ExportFormat,
    public readonly data: string | object,
    public readonly metricsExported: number,
    public readonly durationMs: number,
    public readonly timestamp: number,
    public readonly errors?: string[]
  ) {
    Object.freeze(this);
  }

  /**
   * Create successful response
   */
  static success(params: {
    format: ExportFormat;
    data: string | object;
    metricsExported: number;
    durationMs: number;
  }): ExportMetricsResponse {
    return new ExportMetricsResponse(
      true,
      params.format,
      params.data,
      params.metricsExported,
      params.durationMs,
      Date.now()
    );
  }

  /**
   * Create failure response
   */
  static failure(
    format: ExportFormat,
    errors: string[],
    durationMs: number
  ): ExportMetricsResponse {
    return new ExportMetricsResponse(
      false,
      format,
      '',
      0,
      durationMs,
      Date.now(),
      errors
    );
  }

  /**
   * Get data as string (for Prometheus format)
   */
  getDataAsString(): string {
    return typeof this.data === 'string' ? this.data : JSON.stringify(this.data);
  }

  /**
   * Get data as object (for JSON format)
   */
  getDataAsObject(): object {
    return typeof this.data === 'object' ? this.data : {};
  }

  /**
   * Convert to string for logging
   */
  toString(): string {
    if (!this.success) {
      return `ExportMetricsResponse[FAILED: ${this.errors?.join(', ')}]`;
    }
    return `ExportMetricsResponse[${this.format}, ${this.metricsExported} metrics, ${this.durationMs.toFixed(2)}ms]`;
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
