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

  test('should validate opportunities correctly', () => {
    // Note: buyChain is omitted/undefined to skip wallet check in validation
    const validOpportunity = {
      id: 'test-opp-1',
      type: 'cross-dex',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap',
      buyChain: undefined, // No wallet check when undefined
      tokenIn: 'WETH',
      tokenOut: 'USDT',
      amountIn: '1000000000000000000',
      expectedProfit: 0.1, // Above minProfitPercentage (0.003)
      profitPercentage: 0.02,
      gasEstimate: 200000,
      confidence: 0.85, // Above confidenceThreshold (0.75)
      timestamp: Date.now(),
      blockNumber: 18000000
    };

    const isValid = (engine as any).validateOpportunity(validOpportunity);
    expect(isValid).toBe(true);

    const invalidOpportunity = {
      ...validOpportunity,
      confidence: 0.5 // Below threshold (0.75)
    };

    const isInvalid = (engine as any).validateOpportunity(invalidOpportunity);
    expect(isInvalid).toBe(false);

    // Verify logger was called for low confidence rejection
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Opportunity rejected: low confidence',
      expect.objectContaining({ id: invalidOpportunity.id })
    );
  });

  test('should build swap paths correctly', () => {
    const opportunity = {
      tokenIn: 'WETH',
      tokenOut: 'USDT',
      buyDex: 'uniswap_v3',
      sellDex: 'sushiswap'
    };

    const path = (engine as any).buildSwapPath(opportunity);
    expect(path).toEqual(['WETH', 'USDT']);
  });
});
