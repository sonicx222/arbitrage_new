/**
 * Health Module
 *
 * Provides health monitoring utilities:
 * - Degradation level evaluation (ADR-007)
 * - Service health analysis
 * - Alert checking with startup grace period
 * - Metrics updates
 *
 * @see R2 - Coordinator Subsystems extraction
 * @see ADR-007 - Cross-Region Failover
 */

export {
  HealthMonitor,
  DegradationLevel,
  DEFAULT_SERVICE_PATTERNS,
} from './health-monitor';

export type {
  HealthMonitorLogger,
  ServiceNamePatterns,
  ServiceHealthAnalysis,
  HealthMonitorConfig,
} from './health-monitor';
