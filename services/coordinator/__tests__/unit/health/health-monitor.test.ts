/**
 * HealthMonitor Unit Tests
 *
 * Comprehensive tests for the health monitoring subsystem:
 * - Degradation level evaluation (ADR-007)
 * - Service health analysis (single-pass)
 * - Alert checking with startup grace period
 * - Alert cooldown management
 * - Metrics updates
 *
 * @see services/coordinator/src/health/health-monitor.ts
 */

import {
  HealthMonitor,
  DegradationLevel,
  DEFAULT_SERVICE_PATTERNS,
} from '../../../src/health/health-monitor';
import type {
  HealthMonitorLogger,
  HealthMonitorConfig,
  ServiceHealthAnalysis,
} from '../../../src/health/health-monitor';
import type { ServiceHealth } from '@arbitrage/types';
import type { SystemMetrics, Alert } from '../../../src/api/types';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock logger with jest.fn() for all methods.
 */
function createMockLogger(): jest.Mocked<HealthMonitorLogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * Creates a ServiceHealth object with sensible defaults.
 */
function createServiceHealth(
  overrides: Partial<ServiceHealth> = {}
): ServiceHealth {
  return {
    name: overrides.name ?? 'test-service',
    status: overrides.status ?? 'healthy',
    uptime: overrides.uptime ?? 1000,
    memoryUsage: overrides.memoryUsage ?? 50,
    cpuUsage: overrides.cpuUsage ?? 25,
    lastHeartbeat: overrides.lastHeartbeat ?? Date.now(),
    latency: overrides.latency,
    error: overrides.error,
  };
}

/**
 * Creates a blank SystemMetrics object for updateMetrics tests.
 */
function createEmptyMetrics(): SystemMetrics {
  return {
    totalOpportunities: 0,
    totalExecutions: 0,
    successfulExecutions: 0,
    totalProfit: 0,
    averageLatency: 0,
    averageMemory: 0,
    systemHealth: 0,
    activeServices: 0,
    lastUpdate: 0,
    whaleAlerts: 0,
    pendingOpportunities: 0,
    totalSwapEvents: 0,
    totalVolumeUsd: 0,
    volumeAggregatesProcessed: 0,
    activePairsTracked: 0,
    priceUpdatesReceived: 0,
    opportunitiesDropped: 0,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('HealthMonitor', () => {
  let mockLogger: jest.Mocked<HealthMonitorLogger>;
  let mockOnAlert: jest.Mock<(alert: Alert) => void>;
  let monitor: HealthMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockOnAlert = jest.fn();
    monitor = new HealthMonitor(mockLogger, mockOnAlert);
  });

  // ===========================================================================
  // Constructor & Config
  // ===========================================================================

  describe('Constructor & Config', () => {
    it('should create with default config', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert);
      expect(mon).toBeDefined();
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
    });

    it('should create with custom config overrides', () => {
      const config: HealthMonitorConfig = {
        startupGracePeriodMs: 30000,
        alertCooldownMs: 60000,
        minServicesForGracePeriodAlert: 5,
        cooldownCleanupThreshold: 500,
        cooldownMaxAgeMs: 1800000,
      };
      const mon = new HealthMonitor(mockLogger, mockOnAlert, config);
      expect(mon).toBeDefined();
    });

    it('should merge partial config with defaults', () => {
      const config: HealthMonitorConfig = {
        startupGracePeriodMs: 15000,
      };
      const mon = new HealthMonitor(mockLogger, mockOnAlert, config);
      // The monitor should work correctly with partial config
      // (other fields fall back to defaults)
      expect(mon).toBeDefined();
    });

    it('should merge service patterns with defaults', () => {
      const config: HealthMonitorConfig = {
        servicePatterns: {
          executionEngine: 'custom-execution',
        },
      };
      const mon = new HealthMonitor(mockLogger, mockOnAlert, config);

      // Verify custom pattern is used: analyze with custom execution engine name
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('custom-execution', createServiceHealth({ status: 'healthy' }));

      const analysis = mon.analyzeServiceHealth(serviceMap);
      expect(analysis.executorHealthy).toBe(true);
    });

    it('should keep default service patterns when not overridden', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {});

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));

      const analysis = mon.analyzeServiceHealth(serviceMap);
      expect(analysis.executorHealthy).toBe(true);
    });
  });

  // ===========================================================================
  // DEFAULT_SERVICE_PATTERNS
  // ===========================================================================

  describe('DEFAULT_SERVICE_PATTERNS', () => {
    it('should have expected pattern values', () => {
      expect(DEFAULT_SERVICE_PATTERNS).toEqual({
        executionEngine: 'execution-engine',
        detectorPattern: 'detector',
        crossChainPattern: 'cross-chain',
      });
    });
  });

  // ===========================================================================
  // start()
  // ===========================================================================

  describe('start()', () => {
    it('should record start time and log info', () => {
      monitor.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Health monitor started',
        expect.objectContaining({
          gracePeriodMs: 180000, // default (FIX #5: increased from 60000)
        })
      );
    });

    it('should set start time so grace period works', () => {
      // Before start, startTime is 0, so isInGracePeriod depends on Date.now() - 0
      // which is always > gracePeriod, meaning false
      expect(monitor.isInGracePeriod()).toBe(false);

      monitor.start();

      // After start, should be in grace period
      expect(monitor.isInGracePeriod()).toBe(true);
    });
  });

  // ===========================================================================
  // getDegradationLevel()
  // ===========================================================================

  describe('getDegradationLevel()', () => {
    it('should return FULL_OPERATION by default', () => {
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
    });

    it('should return updated level after evaluation', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      // Empty map => COMPLETE_OUTAGE
      monitor.evaluateDegradationLevel(serviceMap, 0);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.COMPLETE_OUTAGE);
    });
  });

  // ===========================================================================
  // isInGracePeriod()
  // ===========================================================================

  describe('isInGracePeriod()', () => {
    it('should return false before start() is called', () => {
      // startTime is 0, Date.now() - 0 >> gracePeriodMs
      expect(monitor.isInGracePeriod()).toBe(false);
    });

    it('should return true immediately after start()', () => {
      monitor.start();
      expect(monitor.isInGracePeriod()).toBe(true);
    });

    it('should return false after grace period expires', () => {
      // Use a short grace period for this test
      const shortGrace = new HealthMonitor(mockLogger, mockOnAlert, {
        startupGracePeriodMs: 10, // 10ms
      });

      shortGrace.start();

      // Use a fake timer approach: wait just a bit
      const now = Date.now();
      // Manually check: the grace period is 10ms, so if we mock Date.now
      // to return now + 20, it should be false
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now + 20);

      expect(shortGrace.isInGracePeriod()).toBe(false);

      Date.now = originalDateNow;
    });

    it('should return true within grace period boundary', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        startupGracePeriodMs: 100,
      });

      const now = Date.now();
      const originalDateNow = Date.now;

      // Mock Date.now for start()
      Date.now = jest.fn().mockReturnValue(now);
      mon.start();

      // 50ms later: still in grace period
      Date.now = jest.fn().mockReturnValue(now + 50);
      expect(mon.isInGracePeriod()).toBe(true);

      // 150ms later: past grace period
      Date.now = jest.fn().mockReturnValue(now + 150);
      expect(mon.isInGracePeriod()).toBe(false);

      Date.now = originalDateNow;
    });
  });

  // ===========================================================================
  // evaluateDegradationLevel()
  // ===========================================================================

  describe('evaluateDegradationLevel()', () => {
    it('should set FULL_OPERATION when all services healthy', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-2', createServiceHealth({ status: 'healthy' }));

      monitor.evaluateDegradationLevel(serviceMap, 100);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
    });

    it('should set REDUCED_CHAINS when executor healthy but some detectors unhealthy', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-2', createServiceHealth({ status: 'unhealthy' }));

      monitor.evaluateDegradationLevel(serviceMap, 80);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.REDUCED_CHAINS);
    });

    it('should set DETECTION_ONLY when executor unhealthy but detectors healthy', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'unhealthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-2', createServiceHealth({ status: 'healthy' }));

      monitor.evaluateDegradationLevel(serviceMap, 80);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.DETECTION_ONLY);
    });

    it('should set READ_ONLY when executor unhealthy AND no healthy detectors', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'unhealthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'unhealthy' }));
      serviceMap.set('detector-2', createServiceHealth({ status: 'degraded' }));

      monitor.evaluateDegradationLevel(serviceMap, 50);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.READ_ONLY);
    });

    it('should set COMPLETE_OUTAGE when no services present', () => {
      const serviceMap = new Map<string, ServiceHealth>();

      monitor.evaluateDegradationLevel(serviceMap, 0);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.COMPLETE_OUTAGE);
    });

    it('should set COMPLETE_OUTAGE when systemHealth is 0', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'healthy' }));

      monitor.evaluateDegradationLevel(serviceMap, 0);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.COMPLETE_OUTAGE);
    });

    it('should log a warning on level change', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      // Start at FULL_OPERATION (default), move to COMPLETE_OUTAGE
      monitor.evaluateDegradationLevel(serviceMap, 0);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Degradation level changed',
        expect.objectContaining({
          previous: 'FULL_OPERATION',
          current: 'COMPLETE_OUTAGE',
        })
      );
    });

    it('should not log when level remains the same', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'healthy' }));

      // Stays at FULL_OPERATION
      monitor.evaluateDegradationLevel(serviceMap, 100);
      monitor.evaluateDegradationLevel(serviceMap, 100);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should handle executor healthy but zero detectors as REDUCED_CHAINS', () => {
      // With no detectors: allDetectorsHealthy = false (due to detectorCount === 0 check)
      // Executor healthy + !allDetectorsHealthy => REDUCED_CHAINS
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('some-other-service', createServiceHealth({ status: 'healthy' }));

      monitor.evaluateDegradationLevel(serviceMap, 100);

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.REDUCED_CHAINS);
    });

    it('should transition through multiple degradation levels', () => {
      // Start: FULL_OPERATION -> COMPLETE_OUTAGE -> DETECTION_ONLY -> FULL_OPERATION
      const fullServices = new Map<string, ServiceHealth>();
      fullServices.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      fullServices.set('detector-1', createServiceHealth({ status: 'healthy' }));

      monitor.evaluateDegradationLevel(fullServices, 100);
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);

      // Empty: COMPLETE_OUTAGE
      monitor.evaluateDegradationLevel(new Map(), 0);
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.COMPLETE_OUTAGE);

      // Executor down, detectors up: DETECTION_ONLY
      const detectionOnly = new Map<string, ServiceHealth>();
      detectionOnly.set('execution-engine', createServiceHealth({ status: 'unhealthy' }));
      detectionOnly.set('detector-1', createServiceHealth({ status: 'healthy' }));
      monitor.evaluateDegradationLevel(detectionOnly, 50);
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.DETECTION_ONLY);

      // Back to full
      monitor.evaluateDegradationLevel(fullServices, 100);
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
    });
  });

  // ===========================================================================
  // analyzeServiceHealth()
  // ===========================================================================

  describe('analyzeServiceHealth()', () => {
    it('should return defaults for empty map', () => {
      const result = monitor.analyzeServiceHealth(new Map());

      expect(result).toEqual({
        hasAnyServices: false,
        executorHealthy: false,
        hasHealthyDetectors: false,
        allDetectorsHealthy: false,
        detectorCount: 0,
        healthyDetectorCount: 0,
      });
    });

    it('should detect healthy executor', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));

      const result = monitor.analyzeServiceHealth(serviceMap);

      expect(result.hasAnyServices).toBe(true);
      expect(result.executorHealthy).toBe(true);
    });

    it('should detect unhealthy executor', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'unhealthy' }));

      const result = monitor.analyzeServiceHealth(serviceMap);

      expect(result.executorHealthy).toBe(false);
    });

    it('should count and evaluate detectors', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-bsc', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-eth', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-polygon', createServiceHealth({ status: 'unhealthy' }));

      const result = monitor.analyzeServiceHealth(serviceMap);

      expect(result.detectorCount).toBe(3);
      expect(result.healthyDetectorCount).toBe(2);
      expect(result.hasHealthyDetectors).toBe(true);
      expect(result.allDetectorsHealthy).toBe(false);
    });

    it('should return allDetectorsHealthy=true when all detectors healthy', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-2', createServiceHealth({ status: 'healthy' }));

      const result = monitor.analyzeServiceHealth(serviceMap);

      expect(result.allDetectorsHealthy).toBe(true);
    });

    it('should return allDetectorsHealthy=false when no detectors present', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('other-service', createServiceHealth({ status: 'healthy' }));

      const result = monitor.analyzeServiceHealth(serviceMap);

      expect(result.detectorCount).toBe(0);
      expect(result.allDetectorsHealthy).toBe(false);
    });

    it('should handle mix of executor and detectors', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-2', createServiceHealth({ status: 'unhealthy' }));
      serviceMap.set('monitoring-service', createServiceHealth({ status: 'healthy' }));

      const result = monitor.analyzeServiceHealth(serviceMap);

      expect(result.hasAnyServices).toBe(true);
      expect(result.executorHealthy).toBe(true);
      expect(result.detectorCount).toBe(2);
      expect(result.healthyDetectorCount).toBe(1);
      expect(result.hasHealthyDetectors).toBe(true);
      expect(result.allDetectorsHealthy).toBe(false);
    });

    it('should only count detectors matching the detector pattern', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('unified-detector', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('cross-chain-detector', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('mempool-service', createServiceHealth({ status: 'healthy' }));

      const result = monitor.analyzeServiceHealth(serviceMap);

      // 'unified-detector' and 'cross-chain-detector' both contain 'detector'
      expect(result.detectorCount).toBe(2);
      expect(result.healthyDetectorCount).toBe(2);
    });

    it('should use custom service patterns when configured', () => {
      const customMonitor = new HealthMonitor(mockLogger, mockOnAlert, {
        servicePatterns: {
          executionEngine: 'custom-exec',
          detectorPattern: 'scanner',
        },
      });

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('custom-exec', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('bsc-scanner', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('detector-old', createServiceHealth({ status: 'healthy' }));

      const result = customMonitor.analyzeServiceHealth(serviceMap);

      expect(result.executorHealthy).toBe(true);
      // 'bsc-scanner' matches 'scanner', but 'detector-old' does not
      expect(result.detectorCount).toBe(1);
      expect(result.healthyDetectorCount).toBe(1);
    });
  });

  // ===========================================================================
  // checkForAlerts()
  // ===========================================================================

  describe('checkForAlerts()', () => {
    it('should not trigger individual service alerts during grace period', () => {
      monitor.start(); // Enter grace period

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'unhealthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'degraded' }));

      monitor.checkForAlerts(serviceMap, 90);

      // No SERVICE_UNHEALTHY alerts during grace period
      expect(mockOnAlert).not.toHaveBeenCalled();
    });

    it('should trigger alerts for unhealthy services after grace period', () => {
      // Don't call start() => startTime stays 0, grace period long expired
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'unhealthy' }));
      serviceMap.set('detector-1', createServiceHealth({ status: 'degraded' }));

      monitor.checkForAlerts(serviceMap, 90);

      // Both unhealthy and degraded should trigger alerts
      expect(mockOnAlert).toHaveBeenCalledTimes(2);
      expect(mockOnAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SERVICE_UNHEALTHY',
          service: 'execution-engine',
          severity: 'high',
        })
      );
      expect(mockOnAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SERVICE_UNHEALTHY',
          service: 'detector-1',
        })
      );
    });

    it('should skip starting and stopping services', () => {
      // Not in grace period
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('service-a', createServiceHealth({ status: 'starting' }));
      serviceMap.set('service-b', createServiceHealth({ status: 'stopping' }));
      serviceMap.set('service-c', createServiceHealth({ status: 'healthy' }));

      monitor.checkForAlerts(serviceMap, 90);

      // No alerts: starting/stopping are skipped, healthy doesn't trigger
      expect(mockOnAlert).not.toHaveBeenCalled();
    });

    it('should trigger system health alert when below 80%', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('service-a', createServiceHealth({ status: 'healthy' }));

      monitor.checkForAlerts(serviceMap, 50);

      expect(mockOnAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SYSTEM_HEALTH_LOW',
          severity: 'critical',
          message: expect.stringContaining('50.0%'),
        })
      );
    });

    it('should not trigger system health alert when at 80% or above', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('service-a', createServiceHealth({ status: 'healthy' }));

      monitor.checkForAlerts(serviceMap, 80);

      expect(mockOnAlert).not.toHaveBeenCalled();
    });

    it('should trigger system health alert during grace period when enough services', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        minServicesForGracePeriodAlert: 3,
      });
      mon.start();

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('service-a', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('service-b', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('service-c', createServiceHealth({ status: 'healthy' }));

      mon.checkForAlerts(serviceMap, 50); // 3 services, health < 80%

      expect(mockOnAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SYSTEM_HEALTH_LOW',
          severity: 'critical',
        })
      );
    });

    it('should not trigger system health alert during grace period with too few services', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        minServicesForGracePeriodAlert: 3,
      });
      mon.start();

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('service-a', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('service-b', createServiceHealth({ status: 'healthy' }));

      mon.checkForAlerts(serviceMap, 50); // Only 2 services, need 3

      expect(mockOnAlert).not.toHaveBeenCalled();
    });

    it('should combine service and system health alerts', () => {
      // Not in grace period
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({ status: 'unhealthy' }));

      monitor.checkForAlerts(serviceMap, 40);

      // Should get both SERVICE_UNHEALTHY and SYSTEM_HEALTH_LOW
      expect(mockOnAlert).toHaveBeenCalledTimes(2);

      const alertTypes = (mockOnAlert.mock.calls as Array<[Alert]>).map(
        (call) => call[0].type
      );
      expect(alertTypes).toContain('SERVICE_UNHEALTHY');
      expect(alertTypes).toContain('SYSTEM_HEALTH_LOW');
    });

    it('should not alert for healthy services', () => {
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('service-a', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('service-b', createServiceHealth({ status: 'healthy' }));

      monitor.checkForAlerts(serviceMap, 100);

      expect(mockOnAlert).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // sendAlertWithCooldown()
  // ===========================================================================

  describe('sendAlertWithCooldown()', () => {
    it('should call onAlert directly', () => {
      const alert: Alert = {
        type: 'TEST_ALERT',
        message: 'test message',
        severity: 'high',
        timestamp: Date.now(),
      };

      monitor.sendAlertWithCooldown(alert);

      expect(mockOnAlert).toHaveBeenCalledTimes(1);
      expect(mockOnAlert).toHaveBeenCalledWith(alert);
    });

    it('should pass alert through without modification', () => {
      const alert: Alert = {
        type: 'SERVICE_UNHEALTHY',
        service: 'detector-1',
        message: 'Service is down',
        severity: 'critical',
        timestamp: 1234567890,
      };

      monitor.sendAlertWithCooldown(alert);

      expect(mockOnAlert).toHaveBeenCalledWith(alert);
    });

    it('should call onAlert multiple times without cooldown check', () => {
      const alert: Alert = {
        type: 'REPEATED_ALERT',
        timestamp: Date.now(),
      };

      monitor.sendAlertWithCooldown(alert);
      monitor.sendAlertWithCooldown(alert);
      monitor.sendAlertWithCooldown(alert);

      expect(mockOnAlert).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // cleanupAlertCooldowns()
  // ===========================================================================

  describe('cleanupAlertCooldowns()', () => {
    it('should remove stale entries older than maxAge', () => {
      const now = 10000000;
      const maxAge = 3600000; // default 1 hour

      // Set a cooldown that is older than maxAge
      monitor.setAlertCooldown('old-alert', now - maxAge - 1);
      // Set a cooldown that is fresh
      monitor.setAlertCooldown('fresh-alert', now - 100);

      monitor.cleanupAlertCooldowns(now);

      const cooldowns = monitor.getAlertCooldowns();
      expect(cooldowns.has('old-alert')).toBe(false);
      expect(cooldowns.has('fresh-alert')).toBe(true);
    });

    it('should keep entries within maxAge', () => {
      const now = 10000000;

      monitor.setAlertCooldown('recent-1', now - 1000);
      monitor.setAlertCooldown('recent-2', now - 500);

      monitor.cleanupAlertCooldowns(now);

      const cooldowns = monitor.getAlertCooldowns();
      expect(cooldowns.size).toBe(2);
    });

    it('should log when entries are cleaned up', () => {
      const now = 10000000;
      const maxAge = 3600000;

      monitor.setAlertCooldown('stale-1', now - maxAge - 100);
      monitor.setAlertCooldown('stale-2', now - maxAge - 200);

      monitor.cleanupAlertCooldowns(now);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cleaned up stale alert cooldowns',
        expect.objectContaining({
          removed: 2,
          remaining: 0,
        })
      );
    });

    it('should not log when no entries are cleaned up', () => {
      const now = 10000000;

      monitor.setAlertCooldown('fresh', now - 100);

      monitor.cleanupAlertCooldowns(now);

      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('should use custom cooldownMaxAgeMs from config', () => {
      const customMonitor = new HealthMonitor(mockLogger, mockOnAlert, {
        cooldownMaxAgeMs: 5000, // 5 seconds
      });

      const now = 100000;

      customMonitor.setAlertCooldown('old', now - 6000); // older than 5s
      customMonitor.setAlertCooldown('fresh', now - 3000); // within 5s

      customMonitor.cleanupAlertCooldowns(now);

      const cooldowns = customMonitor.getAlertCooldowns();
      expect(cooldowns.has('old')).toBe(false);
      expect(cooldowns.has('fresh')).toBe(true);
    });

    it('should handle empty cooldowns map', () => {
      monitor.cleanupAlertCooldowns(Date.now());

      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(monitor.getAlertCooldowns().size).toBe(0);
    });
  });

  // ===========================================================================
  // updateMetrics()
  // ===========================================================================

  describe('updateMetrics()', () => {
    it('should calculate activeServices as count of healthy services', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('s2', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('s3', createServiceHealth({ status: 'unhealthy' }));

      monitor.updateMetrics(serviceMap, metrics);

      expect(metrics.activeServices).toBe(2);
    });

    it('should calculate systemHealth as percentage of healthy services', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('s2', createServiceHealth({ status: 'unhealthy' }));

      monitor.updateMetrics(serviceMap, metrics);

      // 1 healthy out of 2 = 50%
      expect(metrics.systemHealth).toBe(50);
    });

    it('should calculate averageMemory across all services', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ memoryUsage: 100 }));
      serviceMap.set('s2', createServiceHealth({ memoryUsage: 200 }));

      monitor.updateMetrics(serviceMap, metrics);

      // (100 + 200) / 2 = 150
      expect(metrics.averageMemory).toBe(150);
    });

    it('should calculate averageLatency from explicit latency values', () => {
      const metrics = createEmptyMetrics();
      const now = Date.now();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ latency: 50 }));
      serviceMap.set('s2', createServiceHealth({ latency: 100 }));

      // Mock Date.now for consistent results within updateMetrics
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      monitor.updateMetrics(serviceMap, metrics);

      Date.now = originalDateNow;

      // (50 + 100) / 2 = 75
      expect(metrics.averageLatency).toBe(75);
    });

    it('should use heartbeat-based latency when latency field is undefined', () => {
      const metrics = createEmptyMetrics();
      const now = 1000000;
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({
        latency: undefined,
        lastHeartbeat: now - 100, // 100ms ago
      }));

      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      monitor.updateMetrics(serviceMap, metrics);

      Date.now = originalDateNow;

      // Latency from heartbeat: now - lastHeartbeat = 100
      expect(metrics.averageLatency).toBe(100);
    });

    it('should preserve memoryUsage of 0 using ?? operator', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ memoryUsage: 0 }));
      serviceMap.set('s2', createServiceHealth({ memoryUsage: 100 }));

      monitor.updateMetrics(serviceMap, metrics);

      // (0 + 100) / 2 = 50; 0 is preserved, not treated as falsy
      expect(metrics.averageMemory).toBe(50);
    });

    it('should handle empty service map without division by zero', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();

      monitor.updateMetrics(serviceMap, metrics);

      // max(0, 1) = 1 used as divisor
      expect(metrics.activeServices).toBe(0);
      expect(metrics.systemHealth).toBe(0);
      expect(metrics.averageLatency).toBe(0);
      expect(metrics.averageMemory).toBe(0);
    });

    it('should set lastUpdate to current timestamp', () => {
      const metrics = createEmptyMetrics();
      const now = 9999999;
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ status: 'healthy' }));

      monitor.updateMetrics(serviceMap, metrics);

      Date.now = originalDateNow;

      expect(metrics.lastUpdate).toBe(now);
    });

    it('should mutate the metrics object in place', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ status: 'healthy', memoryUsage: 200 }));

      monitor.updateMetrics(serviceMap, metrics);

      // Verify the same object is mutated
      expect(metrics.activeServices).toBe(1);
      expect(metrics.systemHealth).toBe(100);
      expect(metrics.averageMemory).toBe(200);
    });

    it('should calculate 100% systemHealth when all services are healthy', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('s2', createServiceHealth({ status: 'healthy' }));
      serviceMap.set('s3', createServiceHealth({ status: 'healthy' }));

      monitor.updateMetrics(serviceMap, metrics);

      expect(metrics.systemHealth).toBe(100);
    });

    it('should use 0 latency when no heartbeat and no explicit latency', () => {
      const metrics = createEmptyMetrics();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('s1', createServiceHealth({
        latency: undefined,
        lastHeartbeat: 0,  // falsy lastHeartbeat
      }));

      monitor.updateMetrics(serviceMap, metrics);

      // lastHeartbeat is 0 (falsy), so latency defaults to 0
      expect(metrics.averageLatency).toBe(0);
    });
  });

  // ===========================================================================
  // getAlertCooldowns() / setAlertCooldown() / deleteAlertCooldown()
  // ===========================================================================

  describe('Alert cooldown accessors', () => {
    it('getAlertCooldowns should return empty map initially', () => {
      const cooldowns = monitor.getAlertCooldowns();
      expect(cooldowns.size).toBe(0);
    });

    it('getAlertCooldowns should return a copy (not the internal map)', () => {
      monitor.setAlertCooldown('test', 1000);
      const copy = monitor.getAlertCooldowns();

      // Modifying the copy should not affect internal state
      copy.delete('test');

      const freshCopy = monitor.getAlertCooldowns();
      expect(freshCopy.has('test')).toBe(true);
    });

    it('setAlertCooldown should add an entry', () => {
      monitor.setAlertCooldown('SERVICE_DOWN_detector', 123456);

      const cooldowns = monitor.getAlertCooldowns();
      expect(cooldowns.get('SERVICE_DOWN_detector')).toBe(123456);
    });

    it('setAlertCooldown should overwrite existing entry', () => {
      monitor.setAlertCooldown('key', 100);
      monitor.setAlertCooldown('key', 200);

      expect(monitor.getAlertCooldowns().get('key')).toBe(200);
    });

    it('deleteAlertCooldown should remove an existing entry', () => {
      monitor.setAlertCooldown('to-delete', 1000);
      const deleted = monitor.deleteAlertCooldown('to-delete');

      expect(deleted).toBe(true);
      expect(monitor.getAlertCooldowns().has('to-delete')).toBe(false);
    });

    it('deleteAlertCooldown should return false for non-existent key', () => {
      const deleted = monitor.deleteAlertCooldown('non-existent');
      expect(deleted).toBe(false);
    });
  });

  // ===========================================================================
  // reset()
  // ===========================================================================

  describe('reset()', () => {
    it('should reset degradation level to FULL_OPERATION', () => {
      // Move to COMPLETE_OUTAGE first
      monitor.evaluateDegradationLevel(new Map(), 0);
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.COMPLETE_OUTAGE);

      monitor.reset();

      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
    });

    it('should clear alert cooldowns', () => {
      monitor.setAlertCooldown('key-1', 100);
      monitor.setAlertCooldown('key-2', 200);

      monitor.reset();

      expect(monitor.getAlertCooldowns().size).toBe(0);
    });

    it('should reset start time (grace period becomes false)', () => {
      monitor.start();
      expect(monitor.isInGracePeriod()).toBe(true);

      monitor.reset();

      // After reset, startTime is 0, so Date.now() - 0 >> gracePeriodMs
      expect(monitor.isInGracePeriod()).toBe(false);
    });

    it('should allow full re-use after reset', () => {
      // Use the monitor, reset, then use again
      monitor.start();
      monitor.evaluateDegradationLevel(new Map(), 0);
      monitor.setAlertCooldown('test', 100);

      monitor.reset();

      // All state should be fresh
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
      expect(monitor.getAlertCooldowns().size).toBe(0);

      // Can start and use again
      monitor.start();
      expect(monitor.isInGracePeriod()).toBe(true);
    });
  });

  // ===========================================================================
  // H10: Concurrency edge cases
  // ===========================================================================

  describe('concurrent health evaluation (H10)', () => {
    // Note: Service names must match DEFAULT_SERVICE_PATTERNS:
    // - executionEngine: 'execution-engine' (exact match)
    // - detectorPattern: 'detector' (contains pattern)

    it('should produce consistent degradation level under concurrent evaluations', () => {
      monitor.start();

      const healthyMap = new Map<string, ServiceHealth>([
        ['execution-engine', createServiceHealth({ name: 'execution-engine', status: 'healthy' })],
        ['unified-detector', createServiceHealth({ name: 'unified-detector', status: 'healthy' })],
      ]);

      const degradedMap = new Map<string, ServiceHealth>([
        ['execution-engine', createServiceHealth({ name: 'execution-engine', status: 'unhealthy' })],
        ['unified-detector', createServiceHealth({ name: 'unified-detector', status: 'unhealthy' })],
      ]);

      // Simulate rapid concurrent evaluations with conflicting data
      // (synchronous in JS, but tests that state doesn't get corrupted)
      monitor.evaluateDegradationLevel(healthyMap, 100);
      const levelAfterHealthy = monitor.getDegradationLevel();

      monitor.evaluateDegradationLevel(degradedMap, 0);
      const levelAfterDegraded = monitor.getDegradationLevel();

      monitor.evaluateDegradationLevel(healthyMap, 100);
      const levelAfterRecovery = monitor.getDegradationLevel();

      // Each evaluation should produce a consistent result based on its input
      expect(levelAfterHealthy).toBe(DegradationLevel.FULL_OPERATION);
      // C4 FIX: During grace period, COMPLETE_OUTAGE is suppressed to READ_ONLY
      expect(levelAfterDegraded).toBe(DegradationLevel.READ_ONLY);
      expect(levelAfterRecovery).toBe(DegradationLevel.FULL_OPERATION);
    });

    it('should handle rapid service health transitions without stale state', () => {
      monitor.start();

      // Simulate executor going healthy -> unhealthy -> healthy rapidly
      const states: Array<'healthy' | 'unhealthy'> = ['healthy', 'unhealthy', 'healthy', 'unhealthy', 'healthy'];

      for (const status of states) {
        const serviceMap = new Map<string, ServiceHealth>([
          ['execution-engine', createServiceHealth({ name: 'execution-engine', status })],
          ['unified-detector', createServiceHealth({ name: 'unified-detector', status: 'healthy' })],
        ]);
        const systemHealth = status === 'healthy' ? 100 : 50;
        monitor.evaluateDegradationLevel(serviceMap, systemHealth);
      }

      // Final state should reflect last evaluation (executor healthy + detector healthy)
      expect(monitor.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
    });

    it('should handle concurrent metric updates without corruption', () => {
      const metrics = createEmptyMetrics();

      const serviceMap1 = new Map<string, ServiceHealth>([
        ['execution-engine', createServiceHealth({ name: 'execution-engine', status: 'healthy', memoryUsage: 100, cpuUsage: 50 })],
        ['unified-detector', createServiceHealth({ name: 'unified-detector', status: 'healthy', memoryUsage: 200, cpuUsage: 60 })],
      ]);

      const serviceMap2 = new Map<string, ServiceHealth>([
        ['execution-engine', createServiceHealth({ name: 'execution-engine', status: 'healthy', memoryUsage: 300, cpuUsage: 80 })],
      ]);

      // Rapid sequential metric updates (signature: serviceHealth, metrics)
      monitor.updateMetrics(serviceMap1, metrics);
      const firstActiveServices = metrics.activeServices;

      monitor.updateMetrics(serviceMap2, metrics);
      const secondActiveServices = metrics.activeServices;

      // First update: 2 healthy services, second: 1 healthy service
      expect(firstActiveServices).toBe(2);
      expect(secondActiveServices).toBe(1);

      // Metrics should reflect the latest update
      expect(metrics.systemHealth).toBeGreaterThanOrEqual(0);
      expect(metrics.systemHealth).toBeLessThanOrEqual(100);
    });

    it('should not miss degradation level changes during rapid evaluation', () => {
      monitor.start();
      const transitions: string[] = [];

      // Override logger to capture degradation changes
      // Note: HealthMonitor logs DegradationLevel[value] which is already a string
      (mockLogger.warn as jest.Mock).mockImplementation((msg: string, meta?: Record<string, unknown>) => {
        if (msg === 'Degradation level changed' && meta) {
          transitions.push(meta.current as string);
        }
      });

      // Full operation -> Detection only -> Complete outage -> Recovery
      const scenarios: Array<{ services: Map<string, ServiceHealth>; health: number }> = [
        {
          // FULL_OPERATION: executor + detector both healthy
          services: new Map([
            ['execution-engine', createServiceHealth({ name: 'execution-engine', status: 'healthy' })],
            ['unified-detector', createServiceHealth({ name: 'unified-detector', status: 'healthy' })],
          ]),
          health: 100,
        },
        {
          // DETECTION_ONLY: executor unhealthy, detector healthy
          services: new Map([
            ['execution-engine', createServiceHealth({ name: 'execution-engine', status: 'unhealthy' })],
            ['unified-detector', createServiceHealth({ name: 'unified-detector', status: 'healthy' })],
          ]),
          health: 60,
        },
        {
          // COMPLETE_OUTAGE: no services, zero health
          services: new Map(),
          health: 0,
        },
        {
          // FULL_OPERATION again: recovery
          services: new Map([
            ['execution-engine', createServiceHealth({ name: 'execution-engine', status: 'healthy' })],
            ['unified-detector', createServiceHealth({ name: 'unified-detector', status: 'healthy' })],
          ]),
          health: 100,
        },
      ];

      for (const scenario of scenarios) {
        monitor.evaluateDegradationLevel(scenario.services, scenario.health);
      }

      // Should have logged 3 transitions:
      // default FULL -> DETECTION_ONLY -> READ_ONLY (C4: suppressed from COMPLETE_OUTAGE) -> FULL_OPERATION
      expect(transitions.length).toBe(3);
      expect(transitions[0]).toBe('DETECTION_ONLY');
      expect(transitions[1]).toBe('READ_ONLY'); // C4 FIX: COMPLETE_OUTAGE suppressed during grace period
      expect(transitions[2]).toBe('FULL_OPERATION');
    });
  });

  // ===========================================================================
  // Hysteresis (consecutive-failure gating before degradation)
  // ===========================================================================

  describe('hysteresis', () => {
    it('should not downgrade on a single stale heartbeat detection', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        consecutiveFailuresThreshold: 3,
        staleHeartbeatThresholdMs: 5000,
      });
      mon.start();
      // C4 FIX: Record heartbeat so stale detection isn't skipped during grace period
      mon.recordHeartbeat('detector-1');

      const now = Date.now();
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({
        name: 'execution-engine',
        status: 'healthy',
        lastHeartbeat: now, // fresh
      }));
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000, // stale: 10s > 5s threshold
      }));

      mon.evaluateDegradationLevel(serviceMap, 100);

      // Single stale detection should NOT cause downgrade due to hysteresis
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);
    });

    it('should downgrade after N consecutive stale detections', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        consecutiveFailuresThreshold: 3,
        staleHeartbeatThresholdMs: 5000,
      });
      mon.start();
      // C4 FIX: Record heartbeat so stale detection isn't skipped during grace period
      mon.recordHeartbeat('detector-1');

      const now = Date.now();
      const originalDateNow = Date.now;

      // Use a fixed "now" so the stale heartbeat stays stale across all calls
      Date.now = jest.fn().mockReturnValue(now);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({
        name: 'execution-engine',
        status: 'healthy',
        lastHeartbeat: now, // fresh
      }));
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000, // stale
      }));

      // Call 1: stale count = 1 (below threshold 3)
      mon.evaluateDegradationLevel(serviceMap, 100);
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);

      // Reset detector-1 to healthy (since detectStaleServices mutates it)
      serviceMap.get('detector-1')!.status = 'healthy';

      // Call 2: stale count = 2 (below threshold 3)
      mon.evaluateDegradationLevel(serviceMap, 100);
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);

      // Reset detector-1 to healthy again
      serviceMap.get('detector-1')!.status = 'healthy';

      // Call 3: stale count = 3 (meets threshold) — should now evaluate and downgrade
      mon.evaluateDegradationLevel(serviceMap, 100);
      expect(mon.getDegradationLevel()).not.toBe(DegradationLevel.FULL_OPERATION);

      Date.now = originalDateNow;
    });

    it('should reset consecutive counter when services recover', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        consecutiveFailuresThreshold: 3,
        staleHeartbeatThresholdMs: 5000,
      });
      mon.start();
      // C4 FIX: Record heartbeat so stale detection isn't skipped during grace period
      mon.recordHeartbeat('detector-1');

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const staleMap = new Map<string, ServiceHealth>();
      staleMap.set('execution-engine', createServiceHealth({
        name: 'execution-engine',
        status: 'healthy',
        lastHeartbeat: now,
      }));
      staleMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000, // stale
      }));

      // 2 stale detections: count = 2
      mon.evaluateDegradationLevel(staleMap, 100);
      staleMap.get('detector-1')!.status = 'healthy'; // reset for re-detection
      mon.evaluateDegradationLevel(staleMap, 100);

      // Now all healthy (fresh heartbeats) — should reset counter
      const freshMap = new Map<string, ServiceHealth>();
      freshMap.set('execution-engine', createServiceHealth({
        name: 'execution-engine',
        status: 'healthy',
        lastHeartbeat: now,
      }));
      freshMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now, // fresh now
      }));

      mon.evaluateDegradationLevel(freshMap, 100);
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);

      // 2 more stale detections after reset: count = 1, 2 (still below 3)
      staleMap.get('detector-1')!.status = 'healthy';
      mon.evaluateDegradationLevel(staleMap, 100);
      staleMap.get('detector-1')!.status = 'healthy';
      mon.evaluateDegradationLevel(staleMap, 100);

      // Still at FULL_OPERATION — counter was reset, so 2 < 3
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);

      Date.now = originalDateNow;
    });

    it('should purge ancient heartbeat entries', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        consecutiveFailuresThreshold: 3,
        staleHeartbeatThresholdMs: 5000,
      });
      mon.start();

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('execution-engine', createServiceHealth({
        name: 'execution-engine',
        status: 'healthy',
        lastHeartbeat: now,
      }));
      serviceMap.set('ancient-detector', createServiceHealth({
        name: 'ancient-detector',
        status: 'healthy',
        lastHeartbeat: now - 600_000, // 10 minutes ago — ancient
      }));

      mon.evaluateDegradationLevel(serviceMap, 100);

      // The ancient entry should have been purged from the map
      expect(serviceMap.has('ancient-detector')).toBe(false);
      // Fresh entry should remain
      expect(serviceMap.has('execution-engine')).toBe(true);

      // Should have logged the purge
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Purged ancient heartbeat entry',
        expect.objectContaining({
          service: 'ancient-detector',
        })
      );

      Date.now = originalDateNow;
    });

    it('should not purge entries with lastHeartbeat within 5 minutes', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        consecutiveFailuresThreshold: 3,
        staleHeartbeatThresholdMs: 5000,
      });
      mon.start();

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 200_000, // 3.3 minutes — within 5 minute threshold
      }));

      mon.evaluateDegradationLevel(serviceMap, 100);

      // Should NOT be purged (< 300,000ms)
      expect(serviceMap.has('detector-1')).toBe(true);

      Date.now = originalDateNow;
    });

    it('should reset consecutiveStaleCount on reset()', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        consecutiveFailuresThreshold: 3,
        staleHeartbeatThresholdMs: 5000,
      });
      mon.start();
      // C4 FIX: Record heartbeat so stale detection isn't skipped during grace period
      mon.recordHeartbeat('detector-1');

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const staleMap = new Map<string, ServiceHealth>();
      staleMap.set('execution-engine', createServiceHealth({
        name: 'execution-engine',
        status: 'healthy',
        lastHeartbeat: now,
      }));
      staleMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000,
      }));

      // Build up 2 consecutive stale counts
      mon.evaluateDegradationLevel(staleMap, 100);
      staleMap.get('detector-1')!.status = 'healthy';
      mon.evaluateDegradationLevel(staleMap, 100);

      // Reset should clear the counter
      mon.reset();

      // After reset, need 3 more consecutive stale detections
      staleMap.get('detector-1')!.status = 'healthy';
      mon.evaluateDegradationLevel(staleMap, 100);
      staleMap.get('detector-1')!.status = 'healthy';
      mon.evaluateDegradationLevel(staleMap, 100);

      // Only 2 since reset — should still be at FULL_OPERATION
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.FULL_OPERATION);

      Date.now = originalDateNow;
    });
  });

  // ===========================================================================
  // H1: Stale heartbeat log aggregation (escalation-based)
  // ===========================================================================

  describe('H1: stale heartbeat log escalation', () => {
    it('should log WARN on first stale detection', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        consecutiveFailuresThreshold: 1, // immediate effect for this test
      });

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000, // stale
      }));

      mon.detectStaleServices(serviceMap);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('heartbeat stale, marking unhealthy'),
        expect.objectContaining({ service: 'detector-1' })
      );

      Date.now = originalDateNow;
    });

    it('should log DEBUG on subsequent detections before escalation threshold', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        consecutiveFailuresThreshold: 1,
      });

      const firstDetectionTime = Date.now();
      const originalDateNow = Date.now;

      // First detection: WARN
      Date.now = jest.fn().mockReturnValue(firstDetectionTime);
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: firstDetectionTime - 10000,
      }));
      mon.detectStaleServices(serviceMap);
      mockLogger.warn.mockClear();
      mockLogger.debug.mockClear();

      // Second detection 30s later (below 60s escalation): DEBUG
      Date.now = jest.fn().mockReturnValue(firstDetectionTime + 30_000);
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: firstDetectionTime - 10000,
      }));
      mon.detectStaleServices(serviceMap);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Service heartbeat still stale',
        expect.objectContaining({ service: 'detector-1' })
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Service heartbeat still stale (escalation)',
        expect.any(Object)
      );

      Date.now = originalDateNow;
    });

    it('should log WARN at 60s escalation threshold', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        consecutiveFailuresThreshold: 1,
      });

      const firstDetectionTime = Date.now();
      const originalDateNow = Date.now;

      // First detection
      Date.now = jest.fn().mockReturnValue(firstDetectionTime);
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: firstDetectionTime - 10000,
      }));
      mon.detectStaleServices(serviceMap);
      mockLogger.warn.mockClear();

      // Detection at 60s: should escalate to WARN
      Date.now = jest.fn().mockReturnValue(firstDetectionTime + 60_000);
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: firstDetectionTime - 10000,
      }));
      mon.detectStaleServices(serviceMap);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Service heartbeat still stale (escalation)',
        expect.objectContaining({
          service: 'detector-1',
          staleDurationMs: 60_000,
        })
      );

      Date.now = originalDateNow;
    });

    it('should escalate at 120s and 300s thresholds', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        consecutiveFailuresThreshold: 1,
      });

      const firstDetectionTime = Date.now();
      const originalDateNow = Date.now;

      // First detection
      Date.now = jest.fn().mockReturnValue(firstDetectionTime);
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: firstDetectionTime - 10000,
      }));
      mon.detectStaleServices(serviceMap);

      // 60s escalation
      Date.now = jest.fn().mockReturnValue(firstDetectionTime + 60_000);
      serviceMap.set('detector-1', createServiceHealth({ name: 'detector-1', status: 'healthy', lastHeartbeat: firstDetectionTime - 10000 }));
      mon.detectStaleServices(serviceMap);

      // 120s escalation
      mockLogger.warn.mockClear();
      Date.now = jest.fn().mockReturnValue(firstDetectionTime + 120_000);
      serviceMap.set('detector-1', createServiceHealth({ name: 'detector-1', status: 'healthy', lastHeartbeat: firstDetectionTime - 10000 }));
      mon.detectStaleServices(serviceMap);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Service heartbeat still stale (escalation)',
        expect.objectContaining({ staleDurationMs: 120_000 })
      );

      // 300s escalation
      mockLogger.warn.mockClear();
      Date.now = jest.fn().mockReturnValue(firstDetectionTime + 300_000);
      serviceMap.set('detector-1', createServiceHealth({ name: 'detector-1', status: 'healthy', lastHeartbeat: firstDetectionTime - 10000 }));
      mon.detectStaleServices(serviceMap);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Service heartbeat still stale (escalation)',
        expect.objectContaining({ staleDurationMs: 300_000 })
      );

      Date.now = originalDateNow;
    });

    it('should clean up stale log state when service recovers', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        consecutiveFailuresThreshold: 1,
      });

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      // First: stale detection
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000,
      }));
      mon.detectStaleServices(serviceMap);
      mockLogger.debug.mockClear();

      // Now service recovers (fresh heartbeat)
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now, // fresh
      }));
      mon.detectStaleServices(serviceMap);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Service recovered from stale heartbeat',
        expect.objectContaining({ service: 'detector-1' })
      );

      // If stale again, should start as first detection (WARN) again
      mockLogger.warn.mockClear();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000,
      }));
      mon.detectStaleServices(serviceMap);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('heartbeat stale, marking unhealthy'),
        expect.objectContaining({ service: 'detector-1' })
      );

      Date.now = originalDateNow;
    });
  });

  // ===========================================================================
  // C4: Grace period awareness for stale heartbeat detection
  // ===========================================================================

  describe('C4: grace period stale heartbeat suppression', () => {
    it('should skip stale check for never-heartbeated services during grace period', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        startupGracePeriodMs: 60000,
      });
      mon.start(); // Enter grace period

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000, // stale but never heartbeated
      }));

      const staleCount = mon.detectStaleServices(serviceMap);

      // Should skip — service never heartbeated during grace period
      expect(staleCount).toBe(0);
      expect(serviceMap.get('detector-1')!.status).toBe('healthy'); // not mutated
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipping stale check for never-heartbeated service during grace period',
        expect.objectContaining({ service: 'detector-1' })
      );

      Date.now = originalDateNow;
    });

    it('should mark stale services that HAVE heartbeated during grace period', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        startupGracePeriodMs: 60000,
      });
      mon.start();
      mon.recordHeartbeat('detector-1'); // Has heartbeated

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000, // stale AND has heartbeated
      }));

      const staleCount = mon.detectStaleServices(serviceMap);

      // Should mark unhealthy — service HAS heartbeated before
      expect(staleCount).toBe(1);
      expect(serviceMap.get('detector-1')!.status).toBe('unhealthy');

      Date.now = originalDateNow;
    });

    it('should mark stale services normally after grace period expires', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        startupGracePeriodMs: 100, // very short
      });

      const startTime = Date.now();
      const originalDateNow = Date.now;

      // Start the monitor
      Date.now = jest.fn().mockReturnValue(startTime);
      mon.start();

      // Jump past grace period
      Date.now = jest.fn().mockReturnValue(startTime + 200);

      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: startTime - 10000, // stale, never heartbeated
      }));

      const staleCount = mon.detectStaleServices(serviceMap);

      // After grace period, should mark unhealthy regardless
      expect(staleCount).toBe(1);
      expect(serviceMap.get('detector-1')!.status).toBe('unhealthy');

      Date.now = originalDateNow;
    });

    it('should suppress COMPLETE_OUTAGE during grace period', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        startupGracePeriodMs: 60000,
      });
      mon.start();

      // No services registered yet — would normally be COMPLETE_OUTAGE
      mon.evaluateDegradationLevel(new Map(), 0);

      // During grace period, should cap at READ_ONLY instead
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.READ_ONLY);
    });

    it('should allow COMPLETE_OUTAGE after grace period expires', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        startupGracePeriodMs: 100,
      });

      const startTime = Date.now();
      const originalDateNow = Date.now;

      Date.now = jest.fn().mockReturnValue(startTime);
      mon.start();

      // Past grace period
      Date.now = jest.fn().mockReturnValue(startTime + 200);

      mon.evaluateDegradationLevel(new Map(), 0);
      expect(mon.getDegradationLevel()).toBe(DegradationLevel.COMPLETE_OUTAGE);

      Date.now = originalDateNow;
    });
  });

  // ===========================================================================
  // recordHeartbeat() / hasReceivedHeartbeat()
  // ===========================================================================

  describe('recordHeartbeat()', () => {
    it('should track first heartbeat for a service', () => {
      expect(monitor.hasReceivedHeartbeat('detector-1')).toBe(false);

      monitor.recordHeartbeat('detector-1');

      expect(monitor.hasReceivedHeartbeat('detector-1')).toBe(true);
    });

    it('should be idempotent for repeated heartbeats', () => {
      monitor.recordHeartbeat('detector-1');
      monitor.recordHeartbeat('detector-1');
      monitor.recordHeartbeat('detector-1');

      expect(monitor.hasReceivedHeartbeat('detector-1')).toBe(true);
    });

    it('should track multiple services independently', () => {
      monitor.recordHeartbeat('detector-1');
      monitor.recordHeartbeat('execution-engine');

      expect(monitor.hasReceivedHeartbeat('detector-1')).toBe(true);
      expect(monitor.hasReceivedHeartbeat('execution-engine')).toBe(true);
      expect(monitor.hasReceivedHeartbeat('detector-2')).toBe(false);
    });

    it('should be cleared by reset()', () => {
      monitor.recordHeartbeat('detector-1');
      monitor.recordHeartbeat('execution-engine');

      monitor.reset();

      expect(monitor.hasReceivedHeartbeat('detector-1')).toBe(false);
      expect(monitor.hasReceivedHeartbeat('execution-engine')).toBe(false);
    });
  });

  // ===========================================================================
  // reset() clears new Batch 3 state
  // ===========================================================================

  describe('reset() clears Batch 3 state', () => {
    it('should clear staleLogState on reset', () => {
      const mon = new HealthMonitor(mockLogger, mockOnAlert, {
        staleHeartbeatThresholdMs: 5000,
        consecutiveFailuresThreshold: 1,
      });

      const now = Date.now();
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(now);

      // Build up stale log state
      const serviceMap = new Map<string, ServiceHealth>();
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000,
      }));
      mon.detectStaleServices(serviceMap);
      mockLogger.warn.mockClear();

      // Reset
      mon.reset();

      // After reset, next stale detection should log WARN (first detection) again
      serviceMap.set('detector-1', createServiceHealth({
        name: 'detector-1',
        status: 'healthy',
        lastHeartbeat: now - 10000,
      }));
      mon.detectStaleServices(serviceMap);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('heartbeat stale, marking unhealthy'),
        expect.objectContaining({ service: 'detector-1' })
      );

      Date.now = originalDateNow;
    });

    it('should clear firstHeartbeatReceived on reset', () => {
      monitor.recordHeartbeat('detector-1');
      expect(monitor.hasReceivedHeartbeat('detector-1')).toBe(true);

      monitor.reset();

      expect(monitor.hasReceivedHeartbeat('detector-1')).toBe(false);
    });
  });

  // ===========================================================================
  // DegradationLevel enum
  // ===========================================================================

  describe('DegradationLevel enum', () => {
    it('should have correct numeric values', () => {
      expect(DegradationLevel.FULL_OPERATION).toBe(0);
      expect(DegradationLevel.REDUCED_CHAINS).toBe(1);
      expect(DegradationLevel.DETECTION_ONLY).toBe(2);
      expect(DegradationLevel.READ_ONLY).toBe(3);
      expect(DegradationLevel.COMPLETE_OUTAGE).toBe(4);
    });

    it('should have correct string reverse lookups', () => {
      expect(DegradationLevel[0]).toBe('FULL_OPERATION');
      expect(DegradationLevel[1]).toBe('REDUCED_CHAINS');
      expect(DegradationLevel[2]).toBe('DETECTION_ONLY');
      expect(DegradationLevel[3]).toBe('READ_ONLY');
      expect(DegradationLevel[4]).toBe('COMPLETE_OUTAGE');
    });
  });
});
