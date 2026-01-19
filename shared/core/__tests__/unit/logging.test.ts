/**
 * Logging Module Tests
 *
 * Tests for the Pino-based logging infrastructure (ADR-015).
 * Verifies:
 * - ILogger interface compliance
 * - Singleton caching behavior
 * - RecordingLogger for test assertions
 * - NullLogger for benchmarks
 * - BigInt serialization
 * - Performance logger functionality
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import logging module
import {
  createPinoLogger,
  getLogger,
  resetLoggerCache,
  resetPerformanceLoggerCache,
  getPinoPerformanceLogger,
  RecordingLogger,
  RecordingPerformanceLogger,
  NullLogger,
  createMockLoggerFactory,
} from '../../src/logging';
import type { ILogger, IPerformanceLogger, LogLevel } from '../../src/logging';

describe('Logging Module', () => {
  beforeEach(() => {
    resetLoggerCache();
    resetPerformanceLoggerCache();
  });

  afterEach(() => {
    resetLoggerCache();
    resetPerformanceLoggerCache();
  });

  describe('createPinoLogger', () => {
    it('should create a logger with string config', () => {
      const logger = createPinoLogger('test-service');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should create a logger with object config', () => {
      const logger = createPinoLogger({
        name: 'test-service',
        level: 'debug',
      });
      expect(logger).toBeDefined();
    });

    it('should return cached instance for same service name', () => {
      const logger1 = createPinoLogger('cached-service');
      const logger2 = createPinoLogger('cached-service');
      expect(logger1).toBe(logger2);
    });

    it('should create different instances for different service names', () => {
      const logger1 = createPinoLogger('service-a');
      const logger2 = createPinoLogger('service-b');
      expect(logger1).not.toBe(logger2);
    });

    it('should support child loggers', () => {
      const parent = createPinoLogger('parent-service');
      const child = parent.child({ component: 'child-component' });
      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
    });
  });

  describe('getLogger', () => {
    it('should be an alias for createPinoLogger', () => {
      const logger1 = getLogger('alias-test');
      const logger2 = createPinoLogger('alias-test');
      expect(logger1).toBe(logger2);
    });
  });

  describe('RecordingLogger', () => {
    let logger: RecordingLogger;

    beforeEach(() => {
      logger = new RecordingLogger();
    });

    it('should capture log entries', () => {
      logger.info('Test message');
      expect(logger.getAllLogs()).toHaveLength(1);
    });

    it('should capture log entries with metadata', () => {
      logger.info('Test message', { key: 'value' });
      const logs = logger.getAllLogs();
      expect(logs[0].meta).toEqual({ key: 'value' });
    });

    it('should filter logs by level', () => {
      logger.info('Info message');
      logger.error('Error message');
      logger.warn('Warn message');

      expect(logger.getLogs('info')).toHaveLength(1);
      expect(logger.getLogs('error')).toHaveLength(1);
      expect(logger.getLogs('warn')).toHaveLength(1);
    });

    it('should provide getErrors() shortcut', () => {
      logger.info('Info');
      logger.error('Error 1');
      logger.error('Error 2');

      expect(logger.getErrors()).toHaveLength(2);
    });

    it('should provide getWarnings() shortcut', () => {
      logger.info('Info');
      logger.warn('Warning 1');
      logger.warn('Warning 2');

      expect(logger.getWarnings()).toHaveLength(2);
    });

    it('should match patterns with hasLogMatching', () => {
      logger.info('Processing request #123');
      logger.error('Failed to process request');

      expect(logger.hasLogMatching('info', /request #\d+/)).toBe(true);
      expect(logger.hasLogMatching('error', 'Failed')).toBe(true);
      expect(logger.hasLogMatching('info', 'nonexistent')).toBe(false);
    });

    it('should clear logs', () => {
      logger.info('Message 1');
      logger.info('Message 2');
      expect(logger.getAllLogs()).toHaveLength(2);

      logger.clear();
      expect(logger.getAllLogs()).toHaveLength(0);
    });

    it('should create child loggers that share log storage', () => {
      const child = logger.child({ component: 'child' });
      child.info('Child message');

      expect(logger.getAllLogs()).toHaveLength(1);
      // Bindings are stored separately from meta
      expect(logger.getAllLogs()[0].bindings).toEqual({ component: 'child' });
    });

    it('should support all log levels', () => {
      logger.fatal('Fatal message');
      logger.error('Error message');
      logger.warn('Warn message');
      logger.info('Info message');
      logger.debug('Debug message');
      logger.trace('Trace message');

      expect(logger.getAllLogs()).toHaveLength(6);
    });
  });

  describe('NullLogger', () => {
    it('should silently discard all logs', () => {
      const logger = new NullLogger();

      // Should not throw
      logger.info('Message');
      logger.error('Error');
      logger.warn('Warning');
      logger.debug('Debug');
      logger.fatal('Fatal');
      logger.trace('Trace');

      // NullLogger doesn't have getAllLogs, so just verify no errors
      expect(true).toBe(true);
    });

    it('should support child loggers', () => {
      const logger = new NullLogger();
      const child = logger.child({ component: 'test' });

      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
    });
  });

  describe('createMockLoggerFactory', () => {
    it('should create factories that return RecordingLoggers', () => {
      const factory = createMockLoggerFactory();
      const logger = factory.createLogger('test');

      expect(logger).toBeInstanceOf(RecordingLogger);
    });

    it('should cache loggers by name', () => {
      const factory = createMockLoggerFactory();
      const logger1 = factory.createLogger('service');
      const logger2 = factory.createLogger('service');

      expect(logger1).toBe(logger2);
    });

    it('should allow retrieving all created loggers', () => {
      const factory = createMockLoggerFactory();
      factory.createLogger('service-1');
      factory.createLogger('service-2');

      const loggers = factory.getRecordingLoggers();
      expect(Object.keys(loggers)).toHaveLength(2);
    });

    it('should allow clearing all loggers', () => {
      const factory = createMockLoggerFactory();
      const logger = factory.createLogger('test') as RecordingLogger;
      logger.info('Message');

      factory.clearAll();

      expect(logger.getAllLogs()).toHaveLength(0);
    });
  });

  describe('PinoPerformanceLogger', () => {
    it('should implement IPerformanceLogger', () => {
      const logger = getPinoPerformanceLogger('perf-test');

      expect(typeof logger.startTimer).toBe('function');
      expect(typeof logger.endTimer).toBe('function');
      expect(typeof logger.logEventLatency).toBe('function');
      expect(typeof logger.logArbitrageOpportunity).toBe('function');
      expect(typeof logger.logExecutionResult).toBe('function');
      expect(typeof logger.logHealthCheck).toBe('function');
      expect(typeof logger.logMetrics).toBe('function');
    });

    it('should track timer duration', () => {
      const logger = getPinoPerformanceLogger('timer-test');

      logger.startTimer('operation');
      const duration = logger.endTimer('operation');

      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('should be cached by service name', () => {
      const logger1 = getPinoPerformanceLogger('cached-perf');
      const logger2 = getPinoPerformanceLogger('cached-perf');

      expect(logger1).toBe(logger2);
    });
  });

  describe('RecordingPerformanceLogger', () => {
    it('should record performance metrics', () => {
      const logger = new RecordingPerformanceLogger();

      logger.startTimer('test-op');
      logger.endTimer('test-op', { extra: 'data' });

      expect(logger.getAllLogs().length).toBeGreaterThan(0);
    });

    it('should record arbitrage opportunities', () => {
      const logger = new RecordingPerformanceLogger();

      logger.logArbitrageOpportunity({
        id: 'opp-123',
        type: 'triangular',
        expectedProfit: 100,
        confidence: 0.85,
        buyDex: 'uniswap',
        sellDex: 'sushiswap',
      });

      expect(logger.hasLogMatching('info', 'Arbitrage opportunity')).toBe(true);
    });

    it('should record execution results', () => {
      const logger = new RecordingPerformanceLogger();

      logger.logExecutionResult({
        opportunityId: 'opp-123',
        success: true,
        actualProfit: 95,
        gasUsed: '150000',
        transactionHash: '0xabc123',
      });

      expect(logger.hasLogMatching('info', 'execution')).toBe(true);
    });

    it('should record health checks', () => {
      const logger = new RecordingPerformanceLogger();

      logger.logHealthCheck('detector', {
        status: 'healthy',
        memoryUsage: 50,
        cpuUsage: 30,
        uptime: 3600,
      });

      expect(logger.hasLogMatching('info', 'Health check')).toBe(true);
    });
  });

  describe('ILogger Interface Compliance', () => {
    const implementations: Array<{ name: string; factory: () => ILogger }> = [
      { name: 'createPinoLogger', factory: () => createPinoLogger('test') },
      { name: 'RecordingLogger', factory: () => new RecordingLogger() },
      { name: 'NullLogger', factory: () => new NullLogger() },
    ];

    implementations.forEach(({ name, factory }) => {
      describe(name, () => {
        let logger: ILogger;

        beforeEach(() => {
          resetLoggerCache();
          logger = factory();
        });

        it('should have info method', () => {
          expect(typeof logger.info).toBe('function');
        });

        it('should have error method', () => {
          expect(typeof logger.error).toBe('function');
        });

        it('should have warn method', () => {
          expect(typeof logger.warn).toBe('function');
        });

        it('should have debug method', () => {
          expect(typeof logger.debug).toBe('function');
        });

        it('should have fatal method', () => {
          expect(typeof logger.fatal).toBe('function');
        });

        it('should have child method', () => {
          expect(typeof logger.child).toBe('function');
        });

        it('should return ILogger from child()', () => {
          const child = logger.child({ component: 'test' });
          expect(typeof child.info).toBe('function');
          expect(typeof child.child).toBe('function');
        });
      });
    });
  });
});
