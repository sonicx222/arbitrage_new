/**
 * Monitoring Module
 *
 * Health tracking and observability utilities including:
 * - EnhancedHealthMonitor: System-wide health tracking
 * - StreamHealthMonitor: Redis Stream lag monitoring
 * - ProviderHealthScorer: RPC provider health scoring (S3.3)
 * - CrossRegionHealthManager: Cross-region failover (ADR-007)
 * - LatencyTracker: E2E pipeline latency tracking (ADR-022)
 *
 * @module monitoring
 */

// Enhanced Health Monitor
export {
  EnhancedHealthMonitor,
  getEnhancedHealthMonitor,
  resetEnhancedHealthMonitor,
  recordHealthMetric,
  getCurrentSystemHealth
} from './enhanced-health-monitor';
export type {
  EnhancedHealthMonitorDeps,
  HealthMetric,
  HealthThreshold,
  AlertRule,
  SystemHealth,
  ServiceHealth,
  InfrastructureHealth,
  PerformanceHealth,
  ResilienceHealth,
  DlqStats,
  RecoveryHealthStatus
} from './enhanced-health-monitor';

// Stream Health Monitor
export {
  StreamHealthMonitor,
  getStreamHealthMonitor,
  resetStreamHealthMonitor
} from './stream-health-monitor';
export type {
  StreamHealthStatus,
  StreamLagInfo,
  ConsumerLagInfo,
  MonitoredStreamInfo,
  StreamHealth,
  StreamMetrics,
  ConsumerGroupHealth,
  StreamHealthSummary,
  StreamHealthThresholds,
  StreamAlert,
  StreamHealthMonitorConfig
} from './stream-health-monitor';

// Provider Health Scorer (S3.3)
export {
  ProviderHealthScorer,
  getProviderHealthScorer,
  resetProviderHealthScorer
} from './provider-health-scorer';
export type {
  ProviderHealthMetrics,
  ProviderHealthScorerConfig
} from './provider-health-scorer';

// Cross-Region Health Manager (ADR-007)
export {
  CrossRegionHealthManager,
  getCrossRegionHealthManager,
  resetCrossRegionHealthManager,
  DegradationLevel
} from './cross-region-health';
export type {
  RegionHealth,
  RegionStatus,
  ServiceRegionHealth,
  FailoverEvent,
  CrossRegionHealthConfig,
  GlobalHealthStatus
} from './cross-region-health';

// Latency Tracker (ADR-022)
export {
  LatencyTracker,
  getLatencyTracker,
  resetLatencyTracker,
  PIPELINE_STAGES
} from './latency-tracker';
export type {
  PercentileStats,
  LatencyMetrics,
  LatencyTrackerConfig,
  PipelineStage
} from './latency-tracker';
