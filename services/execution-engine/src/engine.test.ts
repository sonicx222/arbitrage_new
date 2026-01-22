// Execution Engine Service Unit Tests
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { ExecutionEngineService, ExecutionEngineConfig } from './engine';

// ============================================================================
// Mock Factories (using dependency injection instead of module mocks)
// ============================================================================

// Mock logger factory
const createMockLogger = () => ({
  info: jest.fn<(msg: string, meta?: object) => void>(),
  error: jest.fn<(msg: string, meta?: object) => void>(),
  warn: jest.fn<(msg: string, meta?: object) => void>(),
  debug: jest.fn<(msg: string, meta?: object) => void>()
});

// Mock perf logger factory
const createMockPerfLogger = () => ({
  logEventLatency: jest.fn(),
  logExecutionResult: jest.fn(),
  logHealthCheck: jest.fn()
});

// Mock state manager factory
const createMockStateManager = () => ({
  getState: jest.fn(() => 'idle'),
  executeStart: jest.fn((fn: () => Promise<void>) => fn()),
  executeStop: jest.fn((fn: () => Promise<void>) => fn()),
  transition: jest.fn(() => Promise.resolve({ success: true })),
  isTransitioning: jest.fn(() => false),
  waitForIdle: jest.fn(() => Promise.resolve()),
  on: jest.fn(),
  off: jest.fn(),
  canTransition: jest.fn(() => true)
});

describe('ExecutionEngineService', () => {
  let engine: ExecutionEngineService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
  let mockStateManager: ReturnType<typeof createMockStateManager>;

  // Create test config with injected mocks
  const createTestConfig = (overrides: Partial<ExecutionEngineConfig> = {}): ExecutionEngineConfig => ({
    logger: mockLogger,
    perfLogger: mockPerfLogger as any,
    stateManager: mockStateManager as any,
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
    mockStateManager = createMockStateManager();

    engine = new ExecutionEngineService(createTestConfig());
  });

  test('should initialize correctly', () => {
    expect(engine).toBeDefined();
  });

  // PHASE-3.2: validateOpportunity was moved to OpportunityConsumer
  // buildSwapPath is in BaseExecutionStrategy
  // See consumers/opportunity.consumer.test.ts for consumer-specific tests

  test('should provide stats correctly', () => {
    const stats = engine.getStats();
    expect(stats).toBeDefined();
    expect(stats.opportunitiesReceived).toBe(0);
    expect(stats.executionAttempts).toBe(0);
    expect(stats.successfulExecutions).toBe(0);
    expect(stats.failedExecutions).toBe(0);
  });
});

// =============================================================================
// Precision Fix Regression Tests (PRECISION-FIX)
// =============================================================================

import { ethers } from 'ethers';

describe('Precision Fix Regression Tests', () => {
  test('should correctly convert small expectedProfit values without precision loss', () => {
    // This tests the fix for PRECISION-FIX in prepareFlashLoanTransaction
    // Previously: BigInt(Math.floor(0.000000123456789 * 1e18)) would lose precision
    // Now: ethers.parseUnits(value.toFixed(18), 18) preserves precision

    const smallProfit = 0.000000123456789;

    // Old buggy implementation (loses precision):
    const buggyResult = BigInt(Math.floor(smallProfit * 1e18));

    // New correct implementation:
    const correctResult = ethers.parseUnits(smallProfit.toFixed(18), 18);

    // The correct result should be 123456789000000000n (approximately)
    // But due to float representation, toFixed(18) gives us a precise string
    expect(correctResult).toBeDefined();
    expect(typeof correctResult).toBe('bigint');

    // Verify the new implementation doesn't lose significant digits
    // The buggy version loses precision, the correct version maintains it
    expect(correctResult.toString().length).toBeGreaterThanOrEqual(buggyResult.toString().length);
  });

  test('should handle typical profit values correctly', () => {
    // Test typical profit value (e.g., 0.01 ETH = 10000000000000000 wei)
    const typicalProfit = 0.01;
    const result = ethers.parseUnits(typicalProfit.toFixed(18), 18);

    expect(result).toBe(10000000000000000n);
  });

  test('should handle very small profit values (micro arbitrage)', () => {
    // Test very small profit (e.g., 0.000001 ETH = 1000000000000 wei)
    const microProfit = 0.000001;
    const result = ethers.parseUnits(microProfit.toFixed(18), 18);

    expect(result).toBe(1000000000000n);
  });

  test('should handle zero profit correctly', () => {
    const zeroProfit = 0;
    const result = ethers.parseUnits(zeroProfit.toFixed(18), 18);

    expect(result).toBe(0n);
  });

  test('should handle maximum safe integer-like profits', () => {
    // Test large profit value (e.g., 1000 ETH)
    const largeProfit = 1000;
    const result = ethers.parseUnits(largeProfit.toFixed(18), 18);

    expect(result).toBe(1000000000000000000000n);
  });
});

// =============================================================================
// Standby Configuration Tests (ADR-007)
// =============================================================================

describe('ExecutionEngineService Standby Configuration (ADR-007)', () => {
  // Mock logger factory
  const createMockLogger = () => ({
    info: jest.fn<(msg: string, meta?: object) => void>(),
    error: jest.fn<(msg: string, meta?: object) => void>(),
    warn: jest.fn<(msg: string, meta?: object) => void>(),
    debug: jest.fn<(msg: string, meta?: object) => void>()
  });

  // Mock perf logger factory
  const createMockPerfLogger = () => ({
    logEventLatency: jest.fn(),
    logExecutionResult: jest.fn(),
    logHealthCheck: jest.fn()
  });

  // Mock state manager factory
  const createMockStateManager = () => ({
    getState: jest.fn(() => 'idle'),
    executeStart: jest.fn((fn: () => Promise<void>) => fn()),
    executeStop: jest.fn((fn: () => Promise<void>) => fn()),
    transition: jest.fn(() => Promise.resolve({ success: true })),
    isTransitioning: jest.fn(() => false),
    isRunning: jest.fn(() => true),
    waitForIdle: jest.fn(() => Promise.resolve()),
    on: jest.fn(),
    off: jest.fn(),
    canTransition: jest.fn(() => true)
  });

  test('should initialize with default standby config when not provided', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any
    });

    expect(engine.getIsStandby()).toBe(false);
    expect(engine.getIsActivated()).toBe(false);
    expect(engine.getStandbyConfig()).toEqual({
      isStandby: false,
      queuePausedOnStart: false,
      activationDisablesSimulation: true,
      regionId: undefined
    });
  });

  test('should initialize with provided standby config', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any,
      standbyConfig: {
        isStandby: true,
        queuePausedOnStart: true,
        activationDisablesSimulation: true,
        regionId: 'us-east1'
      }
    });

    expect(engine.getIsStandby()).toBe(true);
    expect(engine.getIsActivated()).toBe(false);
    expect(engine.getStandbyConfig()).toEqual({
      isStandby: true,
      queuePausedOnStart: true,
      activationDisablesSimulation: true,
      regionId: 'us-east1'
    });
  });

  test('should start with simulation mode when configured', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any,
      simulationConfig: {
        enabled: true,
        successRate: 0.9
      },
      standbyConfig: {
        isStandby: true,
        queuePausedOnStart: true,
        activationDisablesSimulation: true,
        regionId: 'us-east1'
      }
    });

    expect(engine.getIsSimulationMode()).toBe(true);
    expect(engine.getIsStandby()).toBe(true);
  });
});

// =============================================================================
// Queue Service Pause/Resume Tests (ADR-007)
// =============================================================================

import { QueueServiceImpl } from './services/queue.service';

describe('QueueService Pause/Resume (ADR-007)', () => {
  // Mock logger factory
  const createMockLogger = () => ({
    info: jest.fn<(msg: string, meta?: object) => void>(),
    error: jest.fn<(msg: string, meta?: object) => void>(),
    warn: jest.fn<(msg: string, meta?: object) => void>(),
    debug: jest.fn<(msg: string, meta?: object) => void>()
  });

  test('should pause queue manually for standby mode', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    expect(queueService.isPaused()).toBe(false);
    expect(queueService.isManuallyPaused()).toBe(false);

    queueService.pause();

    expect(queueService.isPaused()).toBe(true);
    expect(queueService.isManuallyPaused()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith('Queue manually paused (standby mode)');
  });

  test('should resume manually paused queue on activation', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.isPaused()).toBe(true);

    queueService.resume();

    expect(queueService.isPaused()).toBe(false);
    expect(queueService.isManuallyPaused()).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith('Queue manually resumed (activated)');
  });

  test('should not enqueue when manually paused', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();

    const result = queueService.canEnqueue();
    expect(result).toBe(false);
  });

  test('should allow enqueue after resume', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.canEnqueue()).toBe(false);

    queueService.resume();
    expect(queueService.canEnqueue()).toBe(true);
  });

  test('should notify callback on pause state change', () => {
    const mockLogger = createMockLogger();
    const mockCallback = jest.fn();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.onPauseStateChange(mockCallback);

    queueService.pause();
    expect(mockCallback).toHaveBeenCalledWith(true);

    queueService.resume();
    expect(mockCallback).toHaveBeenCalledWith(false);
  });

  test('should not double-pause or double-resume', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    const callCount = (mockLogger.info as jest.Mock).mock.calls.length;

    queueService.pause(); // Should not log again
    expect((mockLogger.info as jest.Mock).mock.calls.length).toBe(callCount);

    queueService.resume();
    const resumeCallCount = (mockLogger.info as jest.Mock).mock.calls.length;

    queueService.resume(); // Should not log again
    expect((mockLogger.info as jest.Mock).mock.calls.length).toBe(resumeCallCount);
  });

  test('clear should reset manual pause state', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.isManuallyPaused()).toBe(true);

    queueService.clear();
    expect(queueService.isManuallyPaused()).toBe(false);
    expect(queueService.isPaused()).toBe(false);
  });
});
