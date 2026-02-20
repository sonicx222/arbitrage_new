/**
 * Risk Management Orchestrator Tests
 *
 * Tests for the extracted risk management orchestration logic.
 *
 * @see risk-management-orchestrator.ts
 */

import {
  RiskManagementOrchestrator,
  createRiskOrchestrator,
  type RiskOrchestratorDeps,
  type RiskAssessmentInput,
} from '../../../src/risk/risk-management-orchestrator';
import { createInitialStats, type ExecutionStats, type Logger } from '../../../src/types';

// Mock dependencies
const createMockLogger = (): Logger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

const createMockDrawdownBreaker = (overrides?: {
  allowed?: boolean;
  state?: 'NORMAL' | 'CAUTION' | 'RECOVERY' | 'HALT';
  sizeMultiplier?: number;
  reason?: string;
}) => ({
  isTradingAllowed: jest.fn().mockReturnValue({
    allowed: overrides?.allowed ?? true,
    state: overrides?.state ?? 'NORMAL',
    sizeMultiplier: overrides?.sizeMultiplier ?? 1.0,
    reason: overrides?.reason,
  }),
  recordTradeResult: jest.fn(),
});

const createMockEVCalculator = (overrides?: {
  shouldExecute?: boolean;
  expectedValue?: bigint;
  winProbability?: number;
  reason?: string;
}) => ({
  calculate: jest.fn().mockReturnValue({
    shouldExecute: overrides?.shouldExecute ?? true,
    expectedValue: overrides?.expectedValue ?? 1000000000000000n, // 0.001 ETH
    winProbability: overrides?.winProbability ?? 0.65,
    reason: overrides?.reason ?? 'Positive EV',
    rawProfitEstimate: 2000000000000000n, // 0.002 ETH
    rawGasCost: 500000000000000n, // 0.0005 ETH
  }),
});

const createMockPositionSizer = (overrides?: {
  shouldTrade?: boolean;
  recommendedSize?: bigint;
  reason?: string;
  kellyFraction?: number;
}) => ({
  calculateSize: jest.fn().mockReturnValue({
    shouldTrade: overrides?.shouldTrade ?? true,
    recommendedSize: overrides?.recommendedSize ?? 100000000000000000n, // 0.1 ETH
    reason: overrides?.reason ?? 'Position sized',
    kellyFraction: overrides?.kellyFraction ?? 0.1,
    fractionOfCapital: 0.01,
  }),
});

describe('RiskManagementOrchestrator', () => {
  let logger: Logger;
  let stats: ExecutionStats;

  beforeEach(() => {
    logger = createMockLogger();
    stats = createInitialStats();
  });

  describe('factory function', () => {
    it('should create orchestrator instance', () => {
      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: null,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);

      expect(orchestrator).toBeInstanceOf(RiskManagementOrchestrator);
    });
  });

  describe('assess() with no risk components', () => {
    it('should allow trade when all components are null', () => {
      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: null,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const input: RiskAssessmentInput = {
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
        expectedProfit: 0.01,
        gasEstimate: 200000,
      };

      const result = orchestrator.assess(input);

      expect(result.allowed).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
    });
  });

  describe('assess() with drawdown breaker', () => {
    it('should reject trade when drawdown breaker is in HALT state', () => {
      const mockBreaker = createMockDrawdownBreaker({
        allowed: false,
        state: 'HALT',
        reason: 'Daily loss limit exceeded',
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const input: RiskAssessmentInput = {
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
      };

      const result = orchestrator.assess(input);

      expect(result.allowed).toBe(false);
      expect(result.rejectionCode).toBe('DRAWDOWN_HALT');
      expect(result.rejectionReason).toBe('Daily loss limit exceeded');
      expect(stats.riskDrawdownBlocks).toBe(1);
    });

    it('should allow trade and track CAUTION state', () => {
      const mockBreaker = createMockDrawdownBreaker({
        allowed: true,
        state: 'CAUTION',
        sizeMultiplier: 0.5,
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const input: RiskAssessmentInput = {
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
      };

      const result = orchestrator.assess(input);

      expect(result.allowed).toBe(true);
      expect(result.drawdownCheck?.state).toBe('CAUTION');
      expect(stats.riskCautionCount).toBe(1);
    });

    it('should allow trade in NORMAL state without incrementing caution count', () => {
      const mockBreaker = createMockDrawdownBreaker({
        allowed: true,
        state: 'NORMAL',
        sizeMultiplier: 1.0,
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const result = orchestrator.assess({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
      });

      expect(result.allowed).toBe(true);
      expect(stats.riskCautionCount).toBe(0);
    });
  });

  describe('assess() with EV calculator', () => {
    it('should reject trade when EV is below threshold', () => {
      const mockBreaker = createMockDrawdownBreaker();
      const mockEV = createMockEVCalculator({
        shouldExecute: false,
        reason: 'EV below minimum threshold',
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: mockEV as any,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const result = orchestrator.assess({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
        expectedProfit: 0.0001, // Very small profit
      });

      expect(result.allowed).toBe(false);
      expect(result.rejectionCode).toBe('LOW_EV');
      expect(stats.riskEVRejections).toBe(1);
    });

    it('should pass EV check with positive expected value', () => {
      const mockBreaker = createMockDrawdownBreaker();
      const mockEV = createMockEVCalculator({
        shouldExecute: true,
        expectedValue: 1000000000000000n,
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: mockEV as any,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const result = orchestrator.assess({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
        expectedProfit: 0.01,
      });

      expect(result.allowed).toBe(true);
      expect(result.evCalculation).toMatchObject({ shouldExecute: true });
      expect(stats.riskEVRejections).toBe(0);
    });
  });

  describe('assess() with position sizer', () => {
    it('should reject trade when position size is zero', () => {
      const mockBreaker = createMockDrawdownBreaker();
      const mockEV = createMockEVCalculator();
      const mockSizer = createMockPositionSizer({
        shouldTrade: false,
        recommendedSize: 0n,
        reason: 'Negative Kelly fraction',
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: mockEV as any,
        positionSizer: mockSizer as any,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const result = orchestrator.assess({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
      });

      expect(result.allowed).toBe(false);
      expect(result.rejectionCode).toBe('POSITION_SIZE');
      expect(stats.riskPositionSizeRejections).toBe(1);
    });

    it('should apply drawdown multiplier to position size', () => {
      const mockBreaker = createMockDrawdownBreaker({
        allowed: true,
        state: 'CAUTION',
        sizeMultiplier: 0.5, // 50% reduction
      });
      const mockEV = createMockEVCalculator();
      const mockSizer = createMockPositionSizer({
        shouldTrade: true,
        recommendedSize: 100000000000000000n, // 0.1 ETH
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: mockEV as any,
        positionSizer: mockSizer as any,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const result = orchestrator.assess({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
      });

      expect(result.allowed).toBe(true);
      // 0.1 ETH * 0.5 = 0.05 ETH
      expect(result.recommendedSize).toBe(50000000000000000n);
    });
  });

  describe('assess() full pipeline', () => {
    it('should pass all checks and return full decision', () => {
      const mockBreaker = createMockDrawdownBreaker({
        allowed: true,
        state: 'NORMAL',
        sizeMultiplier: 1.0,
      });
      const mockEV = createMockEVCalculator({
        shouldExecute: true,
        winProbability: 0.7,
      });
      const mockSizer = createMockPositionSizer({
        shouldTrade: true,
        recommendedSize: 100000000000000000n,
      });

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: mockEV as any,
        positionSizer: mockSizer as any,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      const result = orchestrator.assess({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 3,
        expectedProfit: 0.05,
        gasEstimate: 300000,
      });

      expect(result.allowed).toBe(true);
      expect(result.drawdownCheck).toMatchObject({ allowed: true, state: 'NORMAL' });
      expect(result.evCalculation).toMatchObject({ shouldExecute: true });
      expect(result.positionSize).toMatchObject({ shouldTrade: true });
      expect(result.recommendedSize).toBe(100000000000000000n);

      // Verify no rejection stats incremented
      expect(stats.riskDrawdownBlocks).toBe(0);
      expect(stats.riskEVRejections).toBe(0);
      expect(stats.riskPositionSizeRejections).toBe(0);
    });

    it('should stop at first rejection (drawdown)', () => {
      const mockBreaker = createMockDrawdownBreaker({
        allowed: false,
        state: 'HALT',
        reason: 'Max daily loss reached',
      });
      const mockEV = createMockEVCalculator();
      const mockSizer = createMockPositionSizer();

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: mockEV as any,
        positionSizer: mockSizer as any,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      orchestrator.assess({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
      });

      // Should not call EV or position sizer when drawdown blocks
      expect(mockEV.calculate).not.toHaveBeenCalled();
      expect(mockSizer.calculateSize).not.toHaveBeenCalled();
    });
  });

  describe('recordOutcome()', () => {
    it('should record successful trade outcome to drawdown breaker', () => {
      const mockBreaker = createMockDrawdownBreaker();

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      orchestrator.recordOutcome({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
        success: true,
        actualProfit: 0.01,
        gasCost: 0.005, // ETH units (fractional)
      });

      expect(mockBreaker.recordTradeResult).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pnl: 10000000000000000n, // 0.01 ETH in wei
        })
      );
    });

    it('should record failed trade with gas cost as loss', () => {
      const mockBreaker = createMockDrawdownBreaker();

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: null,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);
      orchestrator.recordOutcome({
        chain: 'ethereum',
        dex: 'uniswap',
        pathLength: 2,
        success: false,
        gasCost: 0.001, // ETH units (fractional)
      });

      expect(mockBreaker.recordTradeResult).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          pnl: -1000000000000000n, // -0.001 ETH in wei
        })
      );
    });

    it('should not crash on fractional gasCost values (P0-2 regression)', () => {
      const mockBreaker = createMockDrawdownBreaker();
      const mockTracker = {
        recordOutcome: jest.fn(),
      };

      const deps: RiskOrchestratorDeps = {
        drawdownBreaker: mockBreaker as any,
        evCalculator: null,
        positionSizer: null,
        probabilityTracker: mockTracker as any,
        logger,
        stats,
      };

      const orchestrator = createRiskOrchestrator(deps);

      // This would throw RangeError before the fix: BigInt(0.003) crashes
      expect(() => {
        orchestrator.recordOutcome({
          chain: 'ethereum',
          dex: 'uniswap',
          pathLength: 2,
          success: false,
          gasCost: 0.003, // Fractional ETH from ethers.formatEther()
        });
      }).not.toThrow();

      // Verify gasCost was converted to wei correctly
      expect(mockTracker.recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          gasCost: 3000000000000000n, // 0.003 ETH = 3e15 wei
        })
      );

      expect(mockBreaker.recordTradeResult).toHaveBeenCalledWith(
        expect.objectContaining({
          pnl: -3000000000000000n, // -0.003 ETH in wei
        })
      );
    });
  });
});
