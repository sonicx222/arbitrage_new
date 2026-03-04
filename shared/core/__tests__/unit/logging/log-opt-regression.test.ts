/**
 * LOG-OPT Regression Tests
 *
 * Validates the 4 logging optimization fixes applied to partition handlers:
 * - Fix 1: debugEnabled guard on opportunityHandler
 * - Fix 2: Child logger with partition bindings
 * - Fix 3: Static strings (no template literals) + structured fields
 * - Fix 4: LogSampler wraps priceUpdate debug guard
 *
 * These tests ensure the optimizations don't regress on future edits.
 *
 * @see docs/reports/LOGGING_OPTIMIZATION_2026-03-04.md
 * @see shared/core/src/partition/handlers.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { RecordingLogger, NullLogger } from '../../../src/logging/testing-logger';
import type { LogEntry } from '../../../src/logging/testing-logger';
import { createLogger } from '../../../src/logger';

// Type alias for the logger type expected by partition handlers
type PartitionLogger = ReturnType<typeof createLogger>;

// Mock CHAINS for validation
jest.mock('@arbitrage/config', () => ({
  CHAINS: {
    bsc: { id: 56, name: 'BSC' },
    polygon: { id: 137, name: 'Polygon' },
  },
  getPartition: jest.fn(),
  getChainsForPartition: jest.fn(),
  TESTNET_CHAINS: [] as string[],
  PARTITION_IDS: {},
}));

import { setupDetectorEventHandlers } from '../../../src/partition/handlers';
import type { PartitionDetectorInterface } from '../../../src/partition/config';

// =============================================================================
// Test Helpers
// =============================================================================

class MockDetector extends EventEmitter implements PartitionDetectorInterface {
  private running = false;
  async getPartitionHealth() {
    return {
      status: 'healthy' as const,
      partitionId: 'test-partition',
      chainHealth: new Map(),
      uptimeSeconds: 0,
      totalEventsProcessed: 0,
      memoryUsage: 0,
    };
  }
  getChains() { return ['bsc', 'polygon']; }
  getHealthyChains() { return ['bsc', 'polygon']; }
  getPartitionId() { return 'test-partition'; }
  isRunning() { return this.running; }
  async start() { this.running = true; }
  async stop() { this.running = false; }
  getStats() {
    return {
      partitionId: 'test-partition',
      chains: ['bsc', 'polygon'],
      totalEventsProcessed: 0,
      totalOpportunitiesFound: 0,
      uptimeSeconds: 0,
      memoryUsageMB: 0,
      chainStats: new Map(),
    };
  }
}

// =============================================================================
// Regression: Fix 1 — debugEnabled guard on opportunityHandler
// =============================================================================

describe('LOG-OPT Fix 1: debugEnabled guard on opportunityHandler', () => {
  it('should NOT log opportunity when debug is disabled (NullLogger)', () => {
    const nullLogger = new NullLogger();
    const debugSpy = jest.spyOn(nullLogger, 'debug');
    const detector = new MockDetector();

    const cleanup = setupDetectorEventHandlers(
      detector,
      nullLogger as unknown as PartitionLogger,
      'test-partition'
    );

    detector.emit('opportunity', {
      id: 'opp-1',
      type: 'cross-dex',
      buyDex: 'pancakeswap',
      sellDex: 'biswap',
      expectedProfit: 100,
      profitPercentage: 5.00,
    });

    // NullLogger.isLevelEnabled returns false, so debugEnabled = false
    // The guard should prevent calling debug()
    expect(debugSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it('should log opportunity when debug IS enabled (RecordingLogger)', () => {
    const logger = new RecordingLogger();
    const detector = new MockDetector();

    const cleanup = setupDetectorEventHandlers(
      detector,
      logger as unknown as PartitionLogger,
      'test-partition'
    );

    detector.emit('opportunity', {
      id: 'opp-1',
      type: 'cross-dex',
      buyDex: 'pancakeswap',
      sellDex: 'biswap',
      expectedProfit: 100,
      profitPercentage: 5.00,
    });

    expect(logger.hasLogMatching('debug', 'Arbitrage opportunity detected')).toBe(true);

    cleanup();
  });
});

// =============================================================================
// Regression: Fix 2 — Child logger with partition bindings
// =============================================================================

describe('LOG-OPT Fix 2: Child logger partition bindings', () => {
  let logger: RecordingLogger;
  let detector: MockDetector;
  let cleanup: () => void;

  beforeEach(() => {
    logger = new RecordingLogger();
    detector = new MockDetector();
    cleanup = setupDetectorEventHandlers(
      detector,
      logger as unknown as PartitionLogger,
      'my-partition'
    );
  });

  it('should store partition in bindings, not in meta', () => {
    detector.emit('chainConnected', { chainId: 'bsc' });

    const logs = logger.getLogs('info');
    const connectedLog = logs.find(log => log.msg.includes('Chain connected'));
    expect(connectedLog).toBeDefined();
    // partition should be in bindings (from child logger), not meta
    expect(connectedLog!.bindings).toMatchObject({ partition: 'my-partition' });
    // meta should have chainId but NOT partition
    expect(connectedLog!.meta).toMatchObject({ chainId: 'bsc' });
    expect(connectedLog!.meta).not.toHaveProperty('partition');

    cleanup();
  });

  it('should propagate partition binding to all event handler logs', () => {
    // Emit multiple event types
    detector.emit('chainError', { chainId: 'bsc', error: new Error('fail') });
    detector.emit('chainDisconnected', { chainId: 'polygon' });
    detector.emit('failoverEvent', { type: 'primary_down' });

    const allLogs = logger.getAllLogs();
    // Every log entry should have partition in bindings
    for (const log of allLogs) {
      expect(log.bindings).toMatchObject({ partition: 'my-partition' });
    }

    cleanup();
  });
});

// =============================================================================
// Regression: Fix 3 — Static strings (no template literals)
// =============================================================================

describe('LOG-OPT Fix 3: Static log messages with structured fields', () => {
  let logger: RecordingLogger;
  let detector: MockDetector;
  let cleanup: () => void;

  beforeEach(() => {
    logger = new RecordingLogger();
    detector = new MockDetector();
    cleanup = setupDetectorEventHandlers(
      detector,
      logger as unknown as PartitionLogger,
      'test-partition'
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('should use static "Chain error" message with chainId in meta', () => {
    detector.emit('chainError', { chainId: 'bsc', error: new Error('timeout') });

    const logs = logger.getLogs('error');
    expect(logs.length).toBeGreaterThan(0);
    // Message should NOT contain the chainId (no template literal)
    expect(logs[0].msg).toBe('Chain error');
    expect(logs[0].msg).not.toContain('bsc');
    // chainId should be in meta as structured field
    expect(logs[0].meta).toMatchObject({ chainId: 'bsc' });
  });

  it('should use static "Chain connected" message with chainId in meta', () => {
    detector.emit('chainConnected', { chainId: 'polygon' });

    const logs = logger.getLogs('info');
    const connectedLog = logs.find(l => l.msg === 'Chain connected');
    expect(connectedLog).toBeDefined();
    expect(connectedLog!.msg).not.toContain('polygon');
    expect(connectedLog!.meta).toMatchObject({ chainId: 'polygon' });
  });

  it('should use static "Chain disconnected" message with chainId in meta', () => {
    detector.emit('chainDisconnected', { chainId: 'bsc' });

    const logs = logger.getLogs('warn');
    expect(logs[0].msg).toBe('Chain disconnected');
    expect(logs[0].msg).not.toContain('bsc');
    expect(logs[0].meta).toMatchObject({ chainId: 'bsc' });
  });

  it('should use static "Chain status degraded" message with chainId in meta', () => {
    detector.emit('statusChange', {
      chainId: 'bsc',
      oldStatus: 'connected',
      newStatus: 'error',
    });

    const logs = logger.getLogs('warn');
    const degradedLog = logs.find(l => l.msg === 'Chain status degraded');
    expect(degradedLog).toBeDefined();
    expect(degradedLog!.msg).not.toContain('bsc');
    expect(degradedLog!.meta).toMatchObject({ chainId: 'bsc', from: 'connected', to: 'error' });
  });

  it('should use static "Chain status recovered" message with chainId in meta', () => {
    detector.emit('statusChange', {
      chainId: 'polygon',
      oldStatus: 'error',
      newStatus: 'connected',
    });

    const logs = logger.getLogs('info');
    const recoveryLog = logs.find(l => l.msg === 'Chain status recovered');
    expect(recoveryLog).toBeDefined();
    expect(recoveryLog!.msg).not.toContain('polygon');
    expect(recoveryLog!.meta).toMatchObject({ chainId: 'polygon', from: 'error', to: 'connected' });
  });

  it('should use static "Chain status changed" message for neutral transitions', () => {
    detector.emit('statusChange', {
      chainId: 'bsc',
      oldStatus: 'connected',
      newStatus: 'connecting',
    });

    const logs = logger.getLogs('debug');
    const changedLog = logs.find(l => l.msg === 'Chain status changed');
    expect(changedLog).toBeDefined();
    expect(changedLog!.msg).not.toContain('bsc');
    expect(changedLog!.meta).toMatchObject({ chainId: 'bsc', from: 'connected', to: 'connecting' });
  });
});

// =============================================================================
// Regression: Fix 4 — LogSampler wraps priceUpdate debug guard
// =============================================================================

describe('LOG-OPT Fix 4: LogSampler on priceUpdate handler', () => {
  it('should NOT log priceUpdate when debug is disabled', () => {
    const nullLogger = new NullLogger();
    const debugSpy = jest.spyOn(nullLogger, 'debug');
    const detector = new MockDetector();

    const cleanup = setupDetectorEventHandlers(
      detector,
      nullLogger as unknown as PartitionLogger,
      'test-partition'
    );

    detector.emit('priceUpdate', { chain: 'bsc', dex: 'pancakeswap', price: 100 });

    expect(debugSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it('should log priceUpdate when debug is enabled and within sampler budget', () => {
    const logger = new RecordingLogger();
    const detector = new MockDetector();

    const cleanup = setupDetectorEventHandlers(
      detector,
      logger as unknown as PartitionLogger,
      'test-partition'
    );

    detector.emit('priceUpdate', { chain: 'bsc', dex: 'pancakeswap', price: 100 });

    expect(logger.hasLogMatching('debug', 'Price update')).toBe(true);
    const debugLogs = logger.getLogs('debug');
    expect(debugLogs[0].meta).toMatchObject({
      chain: 'bsc',
      dex: 'pancakeswap',
      price: 100,
    });
    // partition should be in bindings, not meta
    expect(debugLogs[0].bindings).toMatchObject({ partition: 'test-partition' });

    cleanup();
  });
});
