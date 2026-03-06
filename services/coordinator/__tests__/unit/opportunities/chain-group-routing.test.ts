/**
 * Chain-Group Routing Tests for OpportunityRouter (Phase 2)
 *
 * Verifies that OpportunityRouter routes each opportunity to the correct
 * per-group execution stream when chainGroupStreamResolver is configured,
 * and falls back to the single stream when it is not.
 *
 * @see services/coordinator/src/opportunities/opportunity-router.ts
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 2
 */

// Mock @arbitrage/core to prevent deep import chain
jest.mock('@arbitrage/core', () => ({
  findKSmallest: jest.fn((items: unknown[], k: number, compareFn: (a: unknown, b: unknown) => number) => {
    return [...items].sort(compareFn).slice(0, k);
  }),
}));

import {
  OpportunityRouter,
  type OpportunityRouterLogger,
  type OpportunityStreamsClient,
  type CircuitBreaker,
  type OpportunityRouterConfig,
} from '../../../src/opportunities/opportunity-router';
import { createMockLogger } from '@arbitrage/test-utils';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock factories
// =============================================================================

function createMockStreamsClient(): jest.Mocked<OpportunityStreamsClient> {
  return {
    xadd: jest.fn().mockResolvedValue('1-0'),
    xaddWithLimit: jest.fn().mockResolvedValue('1-0'),
  };
}

function createMockCircuitBreaker(): jest.Mocked<CircuitBreaker> {
  return {
    isCurrentlyOpen: jest.fn().mockReturnValue(false),
    recordFailure: jest.fn().mockReturnValue(false),
    recordSuccess: jest.fn().mockReturnValue(false),
    getFailures: jest.fn().mockReturnValue(0),
    getStatus: jest.fn().mockReturnValue({ isOpen: false, failures: 0, resetTimeoutMs: 60000 }),
  };
}

// Minimal resolver matching getStreamForChain from @arbitrage/config
function testChainGroupResolver(chainId: string): string {
  const chainToStream: Record<string, string> = {
    bsc: 'stream:exec-requests-fast',
    polygon: 'stream:exec-requests-fast',
    avalanche: 'stream:exec-requests-fast',
    fantom: 'stream:exec-requests-fast',
    arbitrum: 'stream:exec-requests-l2',
    optimism: 'stream:exec-requests-l2',
    base: 'stream:exec-requests-l2',
    scroll: 'stream:exec-requests-l2',
    blast: 'stream:exec-requests-l2',
    ethereum: 'stream:exec-requests-premium',
    zksync: 'stream:exec-requests-premium',
    linea: 'stream:exec-requests-premium',
    solana: 'stream:exec-requests-solana',
  };
  return chainToStream[chainId] ?? 'stream:execution-requests';
}

function buildOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: 'test-opp-1',
    type: 'intra-chain',
    chain: 'bsc',
    buyDex: 'pancakeswap',
    sellDex: 'biswap',
    tokenIn: '0xtoken',
    tokenOut: '0xtoken2',
    expectedProfit: 0.01,
    confidence: 0.9,
    timestamp: Date.now(),
    profitPercentage: 1.0,
    ...overrides,
  } as ArbitrageOpportunity;
}

const STARTUP_GRACE_BYPASS = { startupGracePeriodMs: 0 };

// =============================================================================
// Chain-group routing — intra-chain opportunities
// =============================================================================

describe('OpportunityRouter — chain-group routing (intra-chain)', () => {
  let mockLogger: OpportunityRouterLogger;
  let mockCircuitBreaker: jest.Mocked<CircuitBreaker>;
  let mockStreamsClient: jest.Mocked<OpportunityStreamsClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockCircuitBreaker = createMockCircuitBreaker();
    mockStreamsClient = createMockStreamsClient();
  });

  it('should route a BSC opportunity to stream:exec-requests-fast', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      chainGroupStreamResolver: testChainGroupResolver,
    });

    const opp = buildOpportunity({ chain: 'bsc', type: 'intra-chain' });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:exec-requests-fast',
      expect.any(Object)
    );
  });

  it('should route an Ethereum opportunity to stream:exec-requests-premium', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      chainGroupStreamResolver: testChainGroupResolver,
    });

    const opp = buildOpportunity({ chain: 'ethereum', type: 'intra-chain' });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:exec-requests-premium',
      expect.any(Object)
    );
  });

  it('should route an Arbitrum opportunity to stream:exec-requests-l2', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      chainGroupStreamResolver: testChainGroupResolver,
    });

    const opp = buildOpportunity({ chain: 'arbitrum', type: 'intra-chain' });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:exec-requests-l2',
      expect.any(Object)
    );
  });

  it('should route a Solana opportunity to stream:exec-requests-solana', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      chainGroupStreamResolver: testChainGroupResolver,
    });

    const opp = buildOpportunity({ chain: 'solana', type: 'solana' });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:exec-requests-solana',
      expect.any(Object)
    );
  });

  it('should fall back to executionRequestsStream when neither chain nor buyChain is set', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      executionRequestsStream: 'stream:execution-requests',
      chainGroupStreamResolver: testChainGroupResolver,
    });

    // Opportunity with no chain info — chainId is undefined, resolver is skipped
    const opp = buildOpportunity({ chain: undefined, buyChain: undefined, type: 'intra-chain' });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:execution-requests',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Chain-group routing — cross-chain opportunities (route to buyChain's group)
// =============================================================================

describe('OpportunityRouter — chain-group routing (cross-chain)', () => {
  let mockLogger: OpportunityRouterLogger;
  let mockCircuitBreaker: jest.Mocked<CircuitBreaker>;
  let mockStreamsClient: jest.Mocked<OpportunityStreamsClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockCircuitBreaker = createMockCircuitBreaker();
    mockStreamsClient = createMockStreamsClient();
  });

  it('should route cross-chain opp (buyChain=bsc, sellChain=ethereum) to fast stream', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      chainGroupStreamResolver: testChainGroupResolver,
    });

    const opp = buildOpportunity({
      type: 'cross-chain',
      chain: undefined,
      buyChain: 'bsc',
      sellChain: 'ethereum',
    });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:exec-requests-fast',
      expect.any(Object)
    );
  });

  it('should route cross-chain opp (buyChain=ethereum, sellChain=bsc) to premium stream', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      chainGroupStreamResolver: testChainGroupResolver,
    });

    const opp = buildOpportunity({
      type: 'cross-chain',
      chain: undefined,
      buyChain: 'ethereum',
      sellChain: 'bsc',
    });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:exec-requests-premium',
      expect.any(Object)
    );
  });
});

// =============================================================================
// Backward compatibility — no resolver = single stream
// =============================================================================

describe('OpportunityRouter — backward compatibility (no chain-group routing)', () => {
  let mockLogger: OpportunityRouterLogger;
  let mockCircuitBreaker: jest.Mocked<CircuitBreaker>;
  let mockStreamsClient: jest.Mocked<OpportunityStreamsClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockCircuitBreaker = createMockCircuitBreaker();
    mockStreamsClient = createMockStreamsClient();
  });

  it('should use executionRequestsStream when no resolver is provided', async () => {
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      executionRequestsStream: 'stream:execution-requests',
      // No chainGroupStreamResolver
    });

    const opp = buildOpportunity({ chain: 'bsc', type: 'intra-chain' });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      'stream:execution-requests',
      expect.any(Object)
    );
  });

  it('should use custom executionRequestsStream as fallback when resolver returns default', async () => {
    const customStream = 'stream:custom-execution-requests';
    const router = new OpportunityRouter(mockLogger, mockCircuitBreaker, mockStreamsClient, {
      ...STARTUP_GRACE_BYPASS,
      executionRequestsStream: customStream,
      chainGroupStreamResolver: (_chainId: string) => customStream,
    });

    const opp = buildOpportunity({ chain: 'bsc', type: 'intra-chain' });
    await router.processOpportunity(opp as unknown as Record<string, unknown>, true);

    expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
      customStream,
      expect.any(Object)
    );
  });
});
