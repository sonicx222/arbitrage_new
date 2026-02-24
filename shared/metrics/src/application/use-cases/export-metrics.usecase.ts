/**
 * ExportMetrics Use Case (Enhancement #3)
 *
 * Exports collected metrics to monitoring systems (Prometheus, Grafana).
 * Follows Use Case Pattern from Clean Architecture.
 *
 * @see docs/PRICEMATRIX_DEPLOYMENT.md - Performance monitoring section
 * @see metrics/domain/metrics-exporter.interface.ts - IMetricsExporter contract
 *
 * @package @arbitrage/metrics
 * @module metrics/application/use-cases
 */

import { IMetricsExporter, ExportFormat } from '../../domain';
import { ExportMetricsRequest, ExportMetricsResponse } from '../dtos/export-metrics.dto';

/**
 * Use Case: Export metrics to monitoring systems
 *
 * Responsibilities:
 * - Validate export request
 * - Trigger metrics exporter
 * - Format metrics according to requested format
 * - Return export result
 *
 * Dependencies (injected):
 * - IMetricsExporter - exports metrics to various formats
 *
 * Performance:
 * - Target: <10ms for export
 * - Background operation, not hot path
 *
 * Supported Formats:
 * - Prometheus: Text-based exposition format for /metrics endpoint
 * - JSON: Structured data for HTTP APIs
 * - Grafana Dashboard: JSON dashboard definition
 * - OpenTelemetry: OTLP format for OTel collectors
 *
 * @example
 * ```typescript
 * const useCase = new ExportMetricsUseCase(metricsExporter);
 *
 * // Export for Prometheus scraping
 * const request = ExportMetricsRequest.prometheus('arbitrage_');
 * const response = await useCase.execute(request);
 * console.log(response.getDataAsString()); // Prometheus text format
 *
 * // Export as JSON
 * const jsonRequest = ExportMetricsRequest.json(true);
 * const jsonResponse = await useCase.execute(jsonRequest);
 * console.log(jsonResponse.getDataAsObject()); // JSON object
 * ```
 */
export class ExportMetricsUseCase {
  constructor(private readonly metricsExporter: IMetricsExporter) {}

  /**
   * Execute metrics export
   *
   * Algorithm:
   * 1. Validate request (handled by DTO)
   * 2. Update exporter config to match request
   * 3. Trigger export from exporter
   * 4. Map export result to DTO response
   * 5. Handle errors gracefully
   *
   * @param request - Validated export request
   * @returns Export response with formatted data
   */
  async execute(request: ExportMetricsRequest): Promise<ExportMetricsResponse> {
    const startTime = performance.now();

    try {
      // Update exporter config to match request
      this.metricsExporter.updateConfig({
        format: request.format,
        includeTimestamps: request.includeTimestamps,
        includeMetadata: request.includeMetadata,
        metricPrefix: request.metricPrefix,
      });

      // Trigger export
      const exportResult = await this.metricsExporter.export();

      // Map domain result to DTO response
      const durationMs = performance.now() - startTime;

      if (!exportResult.success) {
        return ExportMetricsResponse.failure(
          request.format,
          exportResult.errors ?? ['Unknown export error'],
          durationMs
        );
      }

      return ExportMetricsResponse.success({
        format: request.format,
        data: exportResult.data,
        metricsExported: exportResult.metricsExported,
        durationMs,
      });
    } catch (error) {
      // Handle errors gracefully
      const durationMs = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return ExportMetricsResponse.failure(
        request.format,
        [errorMessage],
        durationMs
      );
    }
  }

  /**
   * Export metrics in Prometheus format (convenience method)
   *
   * This is the most common export format for monitoring.
   *
   * @param metricPrefix - Optional prefix for metric names (e.g., "arbitrage_")
   * @returns Prometheus text format response
   */
  async exportPrometheus(metricPrefix?: string): Promise<ExportMetricsResponse> {
    const request = ExportMetricsRequest.prometheus(metricPrefix);
    return this.execute(request);
  }

  /**
   * Export metrics in JSON format (convenience method)
   *
   * Useful for HTTP APIs and structured data consumers.
   *
   * @param includeTimestamps - Whether to include timestamps
   * @returns JSON format response
   */
  async exportJSON(includeTimestamps: boolean = true): Promise<ExportMetricsResponse> {
    const request = ExportMetricsRequest.json(includeTimestamps);
    return this.execute(request);
  }

  /**
   * Generate Grafana dashboard JSON
   *
   * Creates a complete dashboard definition for cache performance monitoring.
   *
   * @param title - Dashboard title
   * @param description - Dashboard description
   * @returns Dashboard JSON
   */
  async generateGrafanaDashboard(
    title: string = 'Cache Performance',
    description: string = 'PriceMatrix and HierarchicalCache monitoring'
  ): Promise<object> {
    const dashboard = await this.metricsExporter.generateGrafanaDashboard(
      {
        title,
        description,
        tags: ['cache', 'performance', 'arbitrage'],
        timeRange: '1h',
        refreshInterval: '30s',
        datasource: 'Prometheus',
      },
      [
        // L1/L2/L3 Hit Rates
        {
          title: 'Cache Hit Rates',
          type: 'graph',
          query: 'rate(cache_hits_total[5m]) / rate(cache_requests_total[5m]) * 100',
          legend: 'Hit Rate %',
          unit: 'percent',
          thresholds: { green: 95, yellow: 90, red: 80 },
        },
        // Hot-Path Latency
        {
          title: 'Hot-Path Latency (p50/p95/p99)',
          type: 'graph',
          query: 'histogram_quantile(0.99, rate(cache_latency_ms_bucket[5m]))',
          legend: 'p99 Latency',
          unit: 'ms',
          thresholds: { green: 50, yellow: 75, red: 100 },
        },
        // Warming Effectiveness
        {
          title: 'Warming Effectiveness',
          type: 'stat',
          query: 'warming_pairs_warmed_total / warming_pairs_attempted_total * 100',
          legend: 'Effectiveness %',
          unit: 'percent',
        },
      ]
    );

    return dashboard;
  }

  /**
   * Get current export configuration
   *
   * @returns Current exporter config
   */
  getConfig() {
    return this.metricsExporter.getConfig();
  }

  /**
   * Get exporter statistics
   *
   * @returns Exporter stats for monitoring
   */
  getStats() {
    return this.metricsExporter.getStats();
  }
}
