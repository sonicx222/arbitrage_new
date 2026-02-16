// Enhanced Health Monitoring System
// Comprehensive monitoring with predictive analytics and automatic alerts
// Updated 2025-01-10: Added Redis Streams health monitoring (ADR-002, S1.1.5)

import { createLogger } from '../logger';
import { ServiceHealth as RedisServiceHealth } from '@arbitrage/types';
import { getRedisClient } from '../redis';
import { getRedisStreamsClient, RedisStreamsClient } from '../redis-streams';
import { getCircuitBreakerRegistry, CircuitBreakerStats } from '../resilience/circuit-breaker';
import { getDeadLetterQueue } from '../resilience/dead-letter-queue';
import { getGracefulDegradationManager } from '../resilience/graceful-degradation';
import { checkRecoverySystemHealth } from '../resilience/error-recovery';
import { getStreamHealthMonitor, StreamHealthSummary } from './stream-health-monitor';

const logger = createLogger('enhanced-health-monitor');

// =============================================================================
// Phase 4: Memory Monitoring Configuration
// Platform-aware thresholds for free-tier deployments
// =============================================================================

/**
 * Deployment platform detection for platform-specific optimizations.
 * Different platforms have different memory constraints.
 */
export type DeploymentPlatform = 'fly' | 'railway' | 'oracle' | 'render' | 'local' | 'unknown';

/**
 * Detect current deployment platform from environment variables.
 */
export function detectDeploymentPlatform(): DeploymentPlatform {
  if (process.env.FLY_APP_NAME !== undefined) return 'fly';
  if (process.env.RAILWAY_ENVIRONMENT !== undefined) return 'railway';
  if (process.env.OCI_RESOURCE_PRINCIPAL_VERSION !== undefined) return 'oracle';
  if (process.env.RENDER_SERVICE_NAME !== undefined) return 'render';
  if (process.env.NODE_ENV === 'development') return 'local';
  return 'unknown';
}

/**
 * Phase 4: Memory threshold configuration per deployment platform.
 *
 * Different platforms have different memory limits:
 * - Fly.io free tier: 256MB (tight constraints)
 * - Railway free tier: 512MB (moderate constraints)
 * - Oracle Cloud free: 24GB (abundant headroom)
 * - Local development: Usually 8GB+ (relaxed)
 *
 * @see ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 6 - Memory Optimization
 */
export interface MemoryThresholds {
  /** Memory usage ratio (0-1) that triggers warning */
  warning: number;
  /** Memory usage ratio (0-1) that triggers critical alert */
  critical: number;
  /** Heap size in MB that triggers warning */
  heapWarningMb: number;
  /** Heap size in MB that triggers critical alert */
  heapCriticalMb: number;
}

/**
 * Platform-specific memory thresholds.
 * Fly.io has tighter constraints due to 256MB limit.
 */
export const PLATFORM_MEMORY_THRESHOLDS: Record<DeploymentPlatform, MemoryThresholds> = {
  // Fly.io: 256MB limit, need early warning at 150MB
  fly: {
    warning: 0.60,    // 60% = ~153MB
    critical: 0.78,   // 78% = ~200MB (before 256MB OOM)
    heapWarningMb: 150,
    heapCriticalMb: 200,
  },
  // Railway: 512MB limit, moderate thresholds
  railway: {
    warning: 0.70,
    critical: 0.85,
    heapWarningMb: 350,
    heapCriticalMb: 430,
  },
  // Oracle Cloud: 24GB available, relaxed thresholds
  oracle: {
    warning: 0.80,
    critical: 0.95,
    heapWarningMb: 2000,
    heapCriticalMb: 4000,
  },
  // Render: Similar to Railway
  render: {
    warning: 0.70,
    critical: 0.85,
    heapWarningMb: 350,
    heapCriticalMb: 430,
  },
  // Local development: Relaxed thresholds
  local: {
    warning: 0.80,
    critical: 0.95,
    heapWarningMb: 2000,
    heapCriticalMb: 8000,
  },
  // Unknown: Conservative defaults
  unknown: {
    warning: 0.75,
    critical: 0.90,
    heapWarningMb: 500,
    heapCriticalMb: 800,
  },
};

/**
 * Get memory thresholds for current deployment platform.
 */
export function getMemoryThresholds(): MemoryThresholds {
  const platform = detectDeploymentPlatform();
  return PLATFORM_MEMORY_THRESHOLDS[platform];
}

export interface HealthMetric {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
  tags?: Record<string, string>;
}

export interface HealthThreshold {
  metric: string;
  warning: number;
  critical: number;
  direction: 'above' | 'below'; // Whether high or low values are bad
}

export interface AlertRule {
  name: string;
  condition: (metrics: HealthMetric[], context: any) => boolean | Promise<boolean>;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  cooldown: number; // Minimum time between alerts (ms)
  actions: string[]; // Actions to take when triggered
}

export interface SystemHealth {
  overall: 'healthy' | 'warning' | 'critical' | 'unknown';
  services: Record<string, ServiceHealth>;
  infrastructure: InfrastructureHealth;
  performance: PerformanceHealth;
  resilience: ResilienceHealth;
  timestamp: number;
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  responseTime: number;
  errorRate: number;
  lastSeen: number;
}

/**
 * P2 FIX #17: Removed phantom `database: boolean` field.
 * System is Redis-only per ARCHITECTURE_V2.md Section 7.1.
 */
export interface InfrastructureHealth {
  redis: boolean;
  messageQueue: boolean;
  streams: StreamHealthSummary | null; // Redis Streams health (ADR-002, S1.1.5)
  externalAPIs: Record<string, boolean>;
}

export interface PerformanceHealth {
  memoryUsage: number;
  cpuUsage: number;
  throughput: number;
  latency: number;
}

/** DLQ stats shape from DeadLetterQueue.getStats() */
export interface DlqStats {
  totalOperations: number;
  byPriority: Record<string, number>;
  byService: Record<string, number>;
  byTag: Record<string, number>;
  oldestOperation: number;
  newestOperation: number;
  averageRetries: number;
}

/** Recovery health shape from checkRecoverySystemHealth() */
export interface RecoveryHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: Record<string, boolean>;
  lastRecoveryAttempt?: number;
}

/**
 * P2 FIX #22: Properly typed resilience health (removed `any` from 3/4 fields).
 */
export interface ResilienceHealth {
  circuitBreakers: Record<string, CircuitBreakerStats>;
  deadLetterQueue: DlqStats;
  gracefulDegradation: Record<string, unknown>;
  errorRecovery: RecoveryHealthStatus;
}

/**
 * P1 FIX #1: Dependency injection interface for testability.
 * All fields are optional — production code uses the global singletons as defaults.
 */
export interface EnhancedHealthMonitorDeps {
  redis?: ReturnType<typeof getRedisClient>;
  streamsClient?: RedisStreamsClient | null;
  circuitBreakers?: ReturnType<typeof getCircuitBreakerRegistry>;
  dlq?: ReturnType<typeof getDeadLetterQueue>;
  degradationManager?: ReturnType<typeof getGracefulDegradationManager>;
  streamHealthMonitor?: { getSummary: () => Promise<StreamHealthSummary> };
  recoveryHealthChecker?: () => Promise<any>;
}

export class EnhancedHealthMonitor {
  private redis: ReturnType<typeof getRedisClient>;
  private streamsClient: RedisStreamsClient | null = null;
  private circuitBreakers: ReturnType<typeof getCircuitBreakerRegistry>;
  private dlq: ReturnType<typeof getDeadLetterQueue>;
  private degradationManager: ReturnType<typeof getGracefulDegradationManager>;
  private streamHealthMonitor?: { getSummary: () => Promise<StreamHealthSummary> };
  private recoveryHealthChecker: () => Promise<any>;
  private alertRules: AlertRule[] = [];
  private lastAlerts: Map<string, number> = new Map();
  private metricsBuffer: HealthMetric[] = [];
  // P2 FIX #13: Map for O(1) threshold lookup (was array with .find())
  private thresholds: Map<string, HealthThreshold> = new Map();
  private monitoringTimer?: NodeJS.Timeout;
  // P1 FIX #3: Re-entry guard to prevent infinite recursion via check_services action
  private isPerformingHealthCheck = false;
  // P1 FIX #4: Track previous CPU usage for delta calculation
  private lastCpuUsage: { user: number; system: number } | null = null;
  private lastCpuCheckTime = 0;
  // P1 FIX #5: Track streams initialization state
  private streamsInitialized = false;
  private streamsInitializing: Promise<void> | null = null;

  /**
   * P1 FIX #1: Constructor accepts optional deps for DI-based testing.
   */
  constructor(deps?: EnhancedHealthMonitorDeps) {
    this.redis = deps?.redis ?? getRedisClient();
    this.circuitBreakers = deps?.circuitBreakers ?? getCircuitBreakerRegistry();
    this.dlq = deps?.dlq ?? getDeadLetterQueue();
    this.degradationManager = deps?.degradationManager ?? getGracefulDegradationManager();
    this.streamHealthMonitor = deps?.streamHealthMonitor;
    this.recoveryHealthChecker = deps?.recoveryHealthChecker ?? checkRecoverySystemHealth;

    // If a streams client is injected, mark as already initialized
    if (deps?.streamsClient !== undefined) {
      this.streamsClient = deps.streamsClient;
      this.streamsInitialized = true;
    }

    this.initializeDefaultRules();
    this.initializeDefaultThresholds();
  }

  /**
   * P1 FIX #5: Lazy initialization of Redis Streams client.
   * Called on first use from dualPublish() to avoid unhandled async in constructor.
   */
  private async ensureStreamsInitialized(): Promise<void> {
    if (this.streamsInitialized) return;
    if (this.streamsInitializing) {
      await this.streamsInitializing;
      return;
    }
    this.streamsInitializing = (async () => {
      try {
        this.streamsClient = await getRedisStreamsClient();
      } catch (error) {
        logger.warn('Failed to initialize Redis Streams client', { error });
      } finally {
        this.streamsInitialized = true;
        this.streamsInitializing = null;
      }
    })();
    await this.streamsInitializing;
  }

  /**
   * Publish to Redis Streams (ADR-002 compliant).
   * P1 FIX #2: Removed Pub/Sub fallback per ADR-002 Phase 4 migration.
   * P1 FIX #5: Uses lazy initialization for streams client.
   */
  private async publishToStream(
    streamName: string,
    message: Record<string, any>
  ): Promise<void> {
    await this.ensureStreamsInitialized();
    if (this.streamsClient) {
      try {
        await this.streamsClient.xadd(streamName, message);
      } catch (error) {
        logger.error('Failed to publish to Redis Stream', { error, streamName });
      }
    }
  }

  // Start comprehensive health monitoring
  start(intervalMs: number = 30000): void {
    this.monitoringTimer = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        logger.error('Health monitoring cycle failed', { error });
      }
    }, intervalMs);

    logger.info('Enhanced health monitoring started', { intervalMs });
  }

  // Stop health monitoring
  stop(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
      logger.info('Enhanced health monitoring stopped');
    }
    // R12 FIX: Clear state to prevent memory leak on restart
    this.lastAlerts.clear();
    this.metricsBuffer.length = 0;
  }

  // Record a health metric
  recordMetric(metric: HealthMetric): void {
    this.metricsBuffer.push(metric);

    // Check thresholds immediately for critical metrics
    if (metric.name.includes('error') || metric.name.includes('latency')) {
      this.checkThresholds([metric]);
    }

    // Flush buffer if it gets too large
    if (this.metricsBuffer.length > 1000) {
      this.flushMetrics();
    }
  }

  // Get current system health
  async getSystemHealth(): Promise<SystemHealth> {
    const services = await this.checkServiceHealth();
    const infrastructure = await this.checkInfrastructureHealth();
    const performance = await this.checkPerformanceHealth();
    const resilience = await this.checkResilienceHealth();

    // Determine overall health
    const allComponents = [
      ...Object.values(services).map(s => s.status),
      infrastructure.redis && infrastructure.messageQueue ? 'healthy' : 'unhealthy',
      performance.memoryUsage < 0.9 && performance.cpuUsage < 0.8 ? 'healthy' : 'warning',
      resilience.errorRecovery.status === 'healthy' ? 'healthy' : 'warning'
    ];

    const criticalCount = allComponents.filter(s => s === 'unhealthy' || s === 'critical').length;
    const warningCount = allComponents.filter(s => s === 'warning' || s === 'degraded').length;

    let overall: 'healthy' | 'warning' | 'critical' | 'unknown' = 'healthy';
    if (criticalCount > 0) overall = 'critical';
    else if (warningCount > 2) overall = 'warning';

    return {
      overall,
      services,
      infrastructure,
      performance,
      resilience,
      timestamp: Date.now()
    };
  }

  // Add custom alert rule
  addAlertRule(rule: AlertRule): void {
    this.alertRules.push(rule);
  }

  // Add custom threshold
  addThreshold(threshold: HealthThreshold): void {
    this.thresholds.set(threshold.metric, threshold);
  }

  private initializeDefaultRules(): void {
    // High error rate alert
    this.addAlertRule({
      name: 'high_error_rate',
      condition: (metrics) => {
        const errorMetrics = metrics.filter(m => m.name.includes('error_rate'));
        return errorMetrics.some(m => m.value > 0.1); // 10% error rate
      },
      severity: 'warning',
      message: 'High error rate detected across services',
      cooldown: 300000, // 5 minutes
      actions: ['log', 'notify', 'check_services']
    });

    // Circuit breaker open alert
    this.addAlertRule({
      name: 'circuit_breaker_open',
      condition: () => {
        const breakerStats = this.circuitBreakers.getAllStats();
        return Object.values(breakerStats).some((stats: any) => stats.state === 'OPEN');
      },
      severity: 'warning',
      message: 'Circuit breaker opened - service isolation active',
      cooldown: 60000, // 1 minute
      actions: ['log', 'isolate_service']
    });

    // DLQ growing alert
    this.addAlertRule({
      name: 'dlq_overflow',
      condition: async () => {
        const stats = await this.dlq.getStats();
        return stats.totalOperations > 1000;
      },
      severity: 'error',
      message: 'Dead letter queue is filling up rapidly',
      cooldown: 300000, // 5 minutes
      actions: ['log', 'notify', 'scale_up']
    });

    // Memory usage critical - uses platform-aware thresholds
    const memThresholds = getMemoryThresholds();
    this.addAlertRule({
      name: 'memory_critical',
      condition: (metrics) => {
        const memoryMetrics = metrics.filter(m => m.name === 'memory_usage');
        return memoryMetrics.some(m => m.value > memThresholds.critical);
      },
      severity: 'critical',
      message: `Critical memory usage - risk of OOM (threshold: ${Math.round(memThresholds.critical * 100)}%)`,
      cooldown: 60000, // 1 minute
      actions: ['log', 'notify', 'restart_service']
    });

    // Phase 4: Memory usage warning - early detection for constrained platforms
    this.addAlertRule({
      name: 'memory_warning',
      condition: (metrics) => {
        const memoryMetrics = metrics.filter(m => m.name === 'memory_usage');
        // Warning if above warning threshold but below critical
        return memoryMetrics.some(m =>
          m.value > memThresholds.warning && m.value <= memThresholds.critical
        );
      },
      severity: 'warning',
      message: `High memory usage detected (threshold: ${Math.round(memThresholds.warning * 100)}%)`,
      cooldown: 300000, // 5 minutes (less aggressive than critical)
      actions: ['log', 'notify', 'trigger_gc']
    });

    // Phase 4: Heap size alert - absolute MB thresholds for Fly.io/Railway
    this.addAlertRule({
      name: 'heap_size_critical',
      condition: () => {
        const heapUsedMb = process.memoryUsage().heapUsed / (1024 * 1024);
        return heapUsedMb > memThresholds.heapCriticalMb;
      },
      severity: 'critical',
      message: `Heap size exceeds ${memThresholds.heapCriticalMb}MB - immediate action required`,
      cooldown: 60000,
      actions: ['log', 'notify', 'restart_service', 'clear_caches']
    });

    // Phase 4: Heap size warning - early detection
    this.addAlertRule({
      name: 'heap_size_warning',
      condition: () => {
        const heapUsedMb = process.memoryUsage().heapUsed / (1024 * 1024);
        return heapUsedMb > memThresholds.heapWarningMb &&
               heapUsedMb <= memThresholds.heapCriticalMb;
      },
      severity: 'warning',
      message: `Heap size exceeds ${memThresholds.heapWarningMb}MB - consider clearing caches`,
      cooldown: 300000,
      actions: ['log', 'trigger_gc']
    });
  }

  private initializeDefaultThresholds(): void {
    // Phase 4: Use platform-aware memory thresholds
    const memThresholds = getMemoryThresholds();
    const platform = detectDeploymentPlatform();

    this.addThreshold({ metric: 'error_rate', warning: 0.05, critical: 0.1, direction: 'above' });
    this.addThreshold({ metric: 'latency', warning: 1000, critical: 5000, direction: 'above' });
    // Memory thresholds are now platform-specific for free-tier optimization
    this.addThreshold({
      metric: 'memory_usage',
      warning: memThresholds.warning,
      critical: memThresholds.critical,
      direction: 'above'
    });
    this.addThreshold({ metric: 'cpu_usage', warning: 0.7, critical: 0.9, direction: 'above' });

    logger.info('Memory thresholds initialized', {
      platform,
      warningPercent: Math.round(memThresholds.warning * 100),
      criticalPercent: Math.round(memThresholds.critical * 100),
      heapWarningMb: memThresholds.heapWarningMb,
      heapCriticalMb: memThresholds.heapCriticalMb,
    });
  }

  private async performHealthCheck(): Promise<void> {
    // P1 FIX #3: Re-entry guard prevents infinite recursion
    // when check_services action triggers another performHealthCheck()
    if (this.isPerformingHealthCheck) return;
    this.isPerformingHealthCheck = true;
    try {
      await this.performHealthCheckInner();
    } finally {
      this.isPerformingHealthCheck = false;
    }
  }

  private async performHealthCheckInner(): Promise<void> {
    const health = await this.getSystemHealth();

    // Record health metrics
    this.recordMetric({
      name: 'system_health_score',
      value: health.overall === 'healthy' ? 1 : health.overall === 'warning' ? 0.5 : 0,
      unit: 'score',
      timestamp: Date.now(),
      tags: { component: 'system' }
    });

    // Check alert rules
    await this.checkAlertRules(health);

    // Store health snapshot
    const redis = await this.redis;
    await redis.set('health:snapshot', health, 300); // 5 minutes TTL

    // Log health status
    logger.debug('Health check completed', {
      overall: health.overall,
      services: Object.keys(health.services).length,
      infrastructureIssues: Object.values(health.infrastructure).filter(v => !v).length
    });
  }

  private async checkServiceHealth(): Promise<Record<string, ServiceHealth>> {
    const redis = await this.redis;
    // Get service health from Redis
    const allHealth = await redis.getAllServiceHealth();
    const services: Record<string, ServiceHealth> = {};

    for (const [serviceName, healthData] of Object.entries(allHealth)) {
      // P3 FIX #29: Removed `as any` — healthData is already typed as ServiceHealth
      services[serviceName] = {
        name: serviceName,
        status: this.determineServiceStatus(healthData),
        uptime: healthData.uptime ?? 0,
        responseTime: healthData.lastHeartbeat ? Date.now() - healthData.lastHeartbeat : 0,
        errorRate: 0, // Would need error tracking
        lastSeen: healthData.lastHeartbeat ?? 0
      };
    }

    return services;
  }

  private async checkInfrastructureHealth(): Promise<InfrastructureHealth> {
    // P2 FIX #17: Removed phantom `database: true` — system is Redis-only
    const infrastructure: InfrastructureHealth = {
      redis: false,
      messageQueue: false,
      streams: null, // Redis Streams health (ADR-002, S1.1.5)
      externalAPIs: {}
    };

    // Check Redis
    try {
      const redis = await this.redis;
      infrastructure.redis = await redis.ping();
    } catch (error) {
      infrastructure.redis = false;
    }

    // Check message queue (same as Redis for now)
    infrastructure.messageQueue = infrastructure.redis;

    // Check Redis Streams health (ADR-002, S1.1.5)
    try {
      const streamMonitor = this.streamHealthMonitor ?? getStreamHealthMonitor();
      infrastructure.streams = await streamMonitor.getSummary();
    } catch (error) {
      logger.warn('Failed to get stream health', { error });
      infrastructure.streams = null;
    }

    return infrastructure;
  }

  /**
   * P1 FIX #4: CPU usage is computed as a delta percentage (0-1) between
   * successive calls, not cumulative seconds. process.cpuUsage() returns
   * cumulative microseconds since process start; we compute the ratio of
   * CPU time used in the interval vs wall-clock time elapsed.
   */
  private async checkPerformanceHealth(): Promise<PerformanceHealth> {
    const memUsage = process.memoryUsage();
    const currentCpu = process.cpuUsage();
    const now = Date.now();

    let cpuPercent = 0;
    if (this.lastCpuUsage && this.lastCpuCheckTime > 0) {
      const userDelta = currentCpu.user - this.lastCpuUsage.user;
      const systemDelta = currentCpu.system - this.lastCpuUsage.system;
      const wallTimeMicros = (now - this.lastCpuCheckTime) * 1000; // ms -> μs
      if (wallTimeMicros > 0) {
        cpuPercent = (userDelta + systemDelta) / wallTimeMicros;
        cpuPercent = Math.min(1, Math.max(0, cpuPercent));
      }
    }

    this.lastCpuUsage = currentCpu;
    this.lastCpuCheckTime = now;

    return {
      memoryUsage: memUsage.heapUsed / memUsage.heapTotal,
      cpuUsage: cpuPercent,
      throughput: 0, // Would need request tracking
      latency: 0 // Would need response time tracking
    };
  }

  private async checkResilienceHealth(): Promise<ResilienceHealth> {
    const circuitBreakerStats = this.circuitBreakers.getAllStats();
    const dlqStats = await this.dlq.getStats();
    const degradationStates = this.degradationManager.getAllDegradationStates();
    const recoveryHealth = await this.recoveryHealthChecker();

    return {
      circuitBreakers: circuitBreakerStats,
      deadLetterQueue: dlqStats,
      gracefulDegradation: degradationStates,
      errorRecovery: recoveryHealth
    };
  }

  /**
   * P3 FIX #29: Properly typed parameter (was `any`).
   */
  private determineServiceStatus(health: RedisServiceHealth | null): 'healthy' | 'degraded' | 'unhealthy' {
    if (!health) return 'unhealthy';

    const timeSinceLastHeartbeat = Date.now() - (health.lastHeartbeat ?? 0);

    if (timeSinceLastHeartbeat > 300000) return 'unhealthy'; // 5 minutes
    if (timeSinceLastHeartbeat > 60000) return 'degraded'; // 1 minute

    return health.status === 'healthy' ? 'healthy' : 'degraded';
  }

  private async checkAlertRules(health: SystemHealth): Promise<void> {
    const now = Date.now();
    const recentMetrics = this.metricsBuffer.slice(-100); // Last 100 metrics

    for (const rule of this.alertRules) {
      const lastAlert = this.lastAlerts.get(rule.name) ?? 0;

      // Check cooldown
      if (now - lastAlert < rule.cooldown) continue;

      // Evaluate condition
      try {
        const triggered = await rule.condition(recentMetrics, { health });

        if (triggered) {
          this.lastAlerts.set(rule.name, now);
          await this.triggerAlert(rule, health);
        }
      } catch (error) {
        logger.error('Error evaluating alert rule', { rule: rule.name, error });
      }
    }

    // R12 FIX: Periodic cleanup of stale lastAlerts to prevent memory leak
    // Clean up entries older than 1 hour when map exceeds threshold
    if (this.lastAlerts.size > 100) {
      this.cleanupStaleAlerts(now);
    }
  }

  /**
   * R12 FIX: Clean up stale alert timestamps to prevent memory leak.
   * Removes entries older than 1 hour.
   */
  private cleanupStaleAlerts(now: number): void {
    const maxAge = 3600000; // 1 hour
    const toDelete: string[] = [];

    for (const [key, timestamp] of this.lastAlerts) {
      if (now - timestamp > maxAge) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.lastAlerts.delete(key);
    }

    if (toDelete.length > 0) {
      logger.debug('Cleaned up stale alert timestamps', {
        removed: toDelete.length,
        remaining: this.lastAlerts.size,
      });
    }
  }

  private checkThresholds(metrics: HealthMetric[]): void {
    for (const metric of metrics) {
      // P2 FIX #13: O(1) lookup via Map instead of O(n) Array.find()
      const threshold = this.thresholds.get(metric.name);
      if (!threshold) continue;

      const isCritical = threshold.direction === 'above'
        ? metric.value >= threshold.critical
        : metric.value <= threshold.critical;

      const isWarning = threshold.direction === 'above'
        ? metric.value >= threshold.warning
        : metric.value <= threshold.warning;

      if (isCritical) {
        logger.error(`Critical threshold exceeded: ${metric.name}`, {
          value: metric.value,
          threshold: threshold.critical,
          unit: metric.unit
        });
      } else if (isWarning) {
        logger.warn(`Warning threshold exceeded: ${metric.name}`, {
          value: metric.value,
          threshold: threshold.warning,
          unit: metric.unit
        });
      }
    }
  }

  private async triggerAlert(rule: AlertRule, health: SystemHealth): Promise<void> {
    logger.warn(`Alert triggered: ${rule.name}`, {
      severity: rule.severity,
      message: rule.message,
      actions: rule.actions
    });

    // Execute alert actions
    for (const action of rule.actions) {
      await this.executeAlertAction(action, rule, health);
    }

    // P1-17 FIX: Use dual-publish pattern (Streams + Pub/Sub)
    // P3 FIX #30: Publish alert metadata only (not full SystemHealth)
    // to avoid leaking infrastructure details if Redis is compromised
    const alertMessage = {
      type: 'health_alert',
      data: {
        rule: rule.name,
        severity: rule.severity,
        message: rule.message,
        overallStatus: health.overall,
        degradedServices: Object.entries(health.services)
          .filter(([, s]) => s.status !== 'healthy')
          .map(([name]) => name)
      },
      timestamp: Date.now(),
      source: 'enhanced-health-monitor'
    };

    await this.publishToStream('stream:health-alerts', alertMessage);
  }

  private async executeAlertAction(action: string, rule: AlertRule, health: SystemHealth): Promise<void> {
    switch (action) {
      case 'log':
        // Already logged above
        break;

      case 'notify':
        // Would integrate with notification service
        logger.info('Alert notification sent', { rule: rule.name });
        break;

      case 'check_services':
        // Trigger service health checks
        await this.performHealthCheck();
        break;

      case 'isolate_service':
        // Would implement service isolation logic
        logger.info('Service isolation triggered', { rule: rule.name });
        break;

      case 'scale_up':
        // Would trigger auto-scaling
        logger.info('Auto-scaling triggered', { rule: rule.name });
        break;

      case 'restart_service':
        // Would trigger service restart
        logger.info('Service restart triggered', { rule: rule.name });
        break;

      // Phase 4: Memory management actions for free-tier optimization
      case 'trigger_gc':
        // Attempt to trigger garbage collection if exposed (Node.js --expose-gc)
        if (global.gc) {
          try {
            global.gc();
            logger.info('Manual garbage collection triggered', { rule: rule.name });
          } catch (error) {
            logger.warn('Failed to trigger GC', { error });
          }
        } else {
          logger.debug('GC not exposed (run with --expose-gc to enable)', { rule: rule.name });
        }
        break;

      case 'clear_caches':
        // Signal to clear internal caches - emit event for handlers to pick up
        logger.info('Cache clear requested', { rule: rule.name });
        // Publish cache clear request for services to handle
        const cacheMessage = {
          type: 'cache_clear_request',
          data: {
            reason: rule.message,
            severity: rule.severity,
            requestedAt: Date.now(),
          },
          timestamp: Date.now(),
          source: 'enhanced-health-monitor'
        };
        await this.publishToStream('stream:system-commands', cacheMessage);
        break;

      default:
        logger.warn('Unknown alert action', { action });
    }
  }

  private async flushMetrics(): Promise<void> {
    if (this.metricsBuffer.length === 0) return;

    // In a real implementation, this would batch send metrics to monitoring system
    const metricsToFlush = [...this.metricsBuffer];
    this.metricsBuffer.length = 0;

    const redis = await this.redis;
    // Store in Redis for short-term analysis
    await redis.set('metrics:recent', metricsToFlush.slice(-50), 3600); // 1 hour TTL

    logger.debug('Flushed health metrics', { count: metricsToFlush.length });
  }
}

// Global health monitor instance
let globalHealthMonitor: EnhancedHealthMonitor | null = null;

export function getEnhancedHealthMonitor(): EnhancedHealthMonitor {
  if (!globalHealthMonitor) {
    globalHealthMonitor = new EnhancedHealthMonitor();
  }
  return globalHealthMonitor;
}

// Convenience functions
export function recordHealthMetric(metric: HealthMetric): void {
  getEnhancedHealthMonitor().recordMetric(metric);
}

export async function getCurrentSystemHealth(): Promise<SystemHealth> {
  return await getEnhancedHealthMonitor().getSystemHealth();
}

/**
 * P1 FIX #10: Reset the singleton instance (for testing).
 * Stops monitoring and clears the global reference.
 */
export function resetEnhancedHealthMonitor(): void {
  if (globalHealthMonitor) {
    globalHealthMonitor.stop();
    globalHealthMonitor = null;
  }
}
// P1 FIX #7: Removed dead process.mainModule auto-start block.
// process.mainModule is deprecated since Node.js 14 and undefined in ES modules.