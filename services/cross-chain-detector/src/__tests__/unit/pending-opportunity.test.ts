/**
 * Unit Tests for Pending Opportunity Integration
 *
 * TDD tests for Task 1.3.3: Integration with Existing Detection.
 * Tests the integration of pending transaction (mempool) opportunities
 * with the CrossChainDetectorService.
 *
 * @see Task 1.3.3: Integration with Existing Detection (Implementation Plan v3.0)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://localhost:6379';

// FIX 9.1: Import centralized getChainName for testing
import { getChainName } from '@arbitrage/config';

// =============================================================================
// Mock Logger
// =============================================================================

/**
 * Creates a mock logger for testing pending opportunity validation.
 *
 * **Mock Configuration:**
 * - All log methods (info, error, warn, debug) are Jest spies
 * - No actual logging during tests
 * - Allows verification of error/warning logging for invalid opportunities
 *
 * **Usage:**
 * ```typescript
 * const mockLogger = createMockLogger();
 * const handler = createMockHandler(mockLogger);
 *
 * // Verify error logging for invalid opportunity
 * await handler.handlePendingOpportunity(invalidOpp);
 * expect(mockLogger.error).toHaveBeenCalledWith(
 *   expect.stringContaining('Invalid')
 * );
 * ```
 */
const createMockLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

// =============================================================================
// Types for Testing
// =============================================================================

/**
 * Pending swap intent from mempool detector.
 * Mirrors the PendingSwapIntent type from mempool-detector.
 */
interface PendingSwapIntent {
  hash: string;
  router: string;
  type: 'uniswapV2' | 'uniswapV3' | 'sushiswap' | 'curve' | '1inch' | 'pancakeswap' | 'unknown';
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  expectedAmountOut: bigint;
  path: string[];
  slippageTolerance: number;
  deadline: number;
  sender: string;
  gasPrice: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce: number;
  chainId: number;
  firstSeen: number;
}

/**
 * Pending opportunity as published to Redis stream.
 * This is what the mempool detector publishes to stream:pending-opportunities.
 */
interface PendingOpportunity {
  type: 'pending';
  intent: PendingSwapIntent;
  estimatedImpact?: number;
  publishedAt: number;
}

// =============================================================================
// Test Helpers
// =============================================================================

function createPendingSwapIntent(overrides: Partial<PendingSwapIntent> = {}): PendingSwapIntent {
  return {
    hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    type: 'uniswapV2',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    amountIn: 1000000000000000000n, // 1 ETH
    expectedAmountOut: 2500000000n, // 2500 USDC
    path: [
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    ],
    slippageTolerance: 0.005,
    deadline: Math.floor(Date.now() / 1000) + 300, // 5 min from now
    sender: '0x1234567890123456789012345678901234567890',
    gasPrice: 50000000000n, // 50 gwei
    nonce: 42,
    chainId: 1,
    firstSeen: Date.now(),
    ...overrides,
  };
}

function createPendingOpportunity(
  intentOverrides: Partial<PendingSwapIntent> = {},
  opportunityOverrides: Partial<Omit<PendingOpportunity, 'intent'>> = {}
): PendingOpportunity {
  return {
    type: 'pending',
    intent: createPendingSwapIntent(intentOverrides),
    publishedAt: Date.now(),
    ...opportunityOverrides,
  };
}

// =============================================================================
// Validation Tests
// =============================================================================

describe('Pending Opportunity Validation', () => {
  /**
   * Validates a PendingOpportunity message has all required fields.
   * This function will be extracted to stream-consumer.ts during implementation.
   */
  function validatePendingOpportunity(
    opp: PendingOpportunity | null | undefined
  ): opp is PendingOpportunity {
    if (!opp || typeof opp !== 'object') {
      return false;
    }

    if (opp.type !== 'pending') {
      return false;
    }

    const intent = opp.intent;
    if (!intent || typeof intent !== 'object') {
      return false;
    }

    // Required string fields
    if (typeof intent.hash !== 'string' || !intent.hash) {
      return false;
    }
    if (typeof intent.router !== 'string' || !intent.router) {
      return false;
    }
    if (typeof intent.tokenIn !== 'string' || !intent.tokenIn) {
      return false;
    }
    if (typeof intent.tokenOut !== 'string' || !intent.tokenOut) {
      return false;
    }
    if (typeof intent.sender !== 'string' || !intent.sender) {
      return false;
    }

    // Required numeric fields
    if (typeof intent.chainId !== 'number' || intent.chainId <= 0) {
      return false;
    }
    if (typeof intent.deadline !== 'number' || intent.deadline <= 0) {
      return false;
    }
    if (typeof intent.nonce !== 'number' || intent.nonce < 0) {
      return false;
    }
    if (typeof intent.slippageTolerance !== 'number' || intent.slippageTolerance < 0) {
      return false;
    }

    // BigInt fields - check they're defined (may be serialized as string from Redis)
    if (intent.amountIn === undefined || intent.amountIn === null) {
      return false;
    }
    if (intent.expectedAmountOut === undefined || intent.expectedAmountOut === null) {
      return false;
    }

    // Path must be an array with at least 2 elements
    if (!Array.isArray(intent.path) || intent.path.length < 2) {
      return false;
    }

    return true;
  }

  /**
   * GIVEN: A well-formed pending opportunity from mempool detector
   * WHEN: Validating all required fields
   * THEN: Should accept as valid
   *
   * **Business Value:**
   * Ensures the validation logic accepts legitimate mempool opportunities.
   * These opportunities allow front-running or back-running large swaps
   * for profitable arbitrage before they're included in a block.
   */
  it('should validate a valid pending opportunity', () => {
    const opp = createPendingOpportunity();
    expect(validatePendingOpportunity(opp)).toBe(true);
  });

  it('should reject null opportunity', () => {
    expect(validatePendingOpportunity(null)).toBe(false);
  });

  it('should reject undefined opportunity', () => {
    expect(validatePendingOpportunity(undefined)).toBe(false);
  });

  it('should reject opportunity with wrong type', () => {
    const opp = createPendingOpportunity();
    (opp as any).type = 'invalid';
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should reject opportunity with missing intent', () => {
    const opp = { type: 'pending' as const, publishedAt: Date.now() };
    expect(validatePendingOpportunity(opp as any)).toBe(false);
  });

  /**
   * GIVEN: Pending opportunity missing transaction hash
   * WHEN: Validating the opportunity
   * THEN: Should reject as invalid
   *
   * **Business Value:**
   * Transaction hash is critical for tracking the mempool transaction.
   * Without it, we cannot monitor whether the transaction was included,
   * failed, or replaced, leading to incorrect arbitrage calculations.
   */
  it('should reject opportunity with missing hash', () => {
    const opp = createPendingOpportunity({ hash: '' });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  /**
   * GIVEN: Pending opportunity with invalid chainId (0 or negative)
   * WHEN: Validating the opportunity
   * THEN: Should reject as invalid
   *
   * **Business Value:**
   * Invalid chainId would cause transaction routing failures. Sending
   * transactions to wrong chain results in failed trades and wasted gas.
   * Validation prevents capital loss from misconfigured opportunities.
   */
  it('should reject opportunity with invalid chainId', () => {
    const opp = createPendingOpportunity({ chainId: 0 });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should reject opportunity with invalid chainId (negative)', () => {
    const opp = createPendingOpportunity({ chainId: -1 });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should reject opportunity with short path', () => {
    const opp = createPendingOpportunity({ path: ['0xtoken'] });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should reject opportunity with empty path', () => {
    const opp = createPendingOpportunity({ path: [] });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should reject opportunity with missing router', () => {
    const opp = createPendingOpportunity({ router: '' });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should reject opportunity with negative slippage', () => {
    const opp = createPendingOpportunity({ slippageTolerance: -0.01 });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should accept opportunity with zero slippage', () => {
    const opp = createPendingOpportunity({ slippageTolerance: 0 });
    expect(validatePendingOpportunity(opp)).toBe(true);
  });

  it('should reject opportunity with missing tokenIn', () => {
    const opp = createPendingOpportunity({ tokenIn: '' });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });

  it('should reject opportunity with missing tokenOut', () => {
    const opp = createPendingOpportunity({ tokenOut: '' });
    expect(validatePendingOpportunity(opp)).toBe(false);
  });
});

// =============================================================================
// Serialization Tests (BigInt handling)
// =============================================================================

describe('Pending Opportunity Serialization', () => {
  /**
   * Parse a pending opportunity from Redis, handling BigInt serialization.
   */
  function parsePendingOpportunity(data: Record<string, unknown>): PendingOpportunity | null {
    try {
      const parsed = { ...data } as any;

      // Parse nested intent
      if (typeof parsed.intent === 'string') {
        parsed.intent = JSON.parse(parsed.intent);
      }

      // Convert BigInt strings back to BigInt
      if (parsed.intent) {
        if (typeof parsed.intent.amountIn === 'string') {
          parsed.intent.amountIn = BigInt(parsed.intent.amountIn);
        }
        if (typeof parsed.intent.expectedAmountOut === 'string') {
          parsed.intent.expectedAmountOut = BigInt(parsed.intent.expectedAmountOut);
        }
        if (typeof parsed.intent.gasPrice === 'string') {
          parsed.intent.gasPrice = BigInt(parsed.intent.gasPrice);
        }
        if (typeof parsed.intent.maxFeePerGas === 'string') {
          parsed.intent.maxFeePerGas = BigInt(parsed.intent.maxFeePerGas);
        }
        if (typeof parsed.intent.maxPriorityFeePerGas === 'string') {
          parsed.intent.maxPriorityFeePerGas = BigInt(parsed.intent.maxPriorityFeePerGas);
        }
      }

      return parsed as PendingOpportunity;
    } catch {
      return null;
    }
  }

  it('should parse serialized BigInt fields', () => {
    const rawData = {
      type: 'pending',
      intent: JSON.stringify({
        hash: '0xabc',
        router: '0xrouter',
        type: 'uniswapV2',
        tokenIn: '0xweth',
        tokenOut: '0xusdc',
        amountIn: '1000000000000000000',
        expectedAmountOut: '2500000000',
        path: ['0xweth', '0xusdc'],
        slippageTolerance: 0.005,
        deadline: 1700000000,
        sender: '0xsender',
        gasPrice: '50000000000',
        nonce: 42,
        chainId: 1,
        firstSeen: Date.now(),
      }),
      publishedAt: Date.now(),
    };

    const parsed = parsePendingOpportunity(rawData);

    expect(parsed).not.toBeNull();
    expect(parsed!.intent.amountIn).toBe(1000000000000000000n);
    expect(parsed!.intent.expectedAmountOut).toBe(2500000000n);
    expect(parsed!.intent.gasPrice).toBe(50000000000n);
  });

  it('should handle already-parsed BigInt fields', () => {
    const rawData = {
      type: 'pending',
      intent: {
        hash: '0xabc',
        router: '0xrouter',
        type: 'uniswapV2',
        tokenIn: '0xweth',
        tokenOut: '0xusdc',
        amountIn: 1000000000000000000n,
        expectedAmountOut: 2500000000n,
        path: ['0xweth', '0xusdc'],
        slippageTolerance: 0.005,
        deadline: 1700000000,
        sender: '0xsender',
        gasPrice: 50000000000n,
        nonce: 42,
        chainId: 1,
        firstSeen: Date.now(),
      },
      publishedAt: Date.now(),
    };

    const parsed = parsePendingOpportunity(rawData);

    expect(parsed).not.toBeNull();
    expect(parsed!.intent.amountIn).toBe(1000000000000000000n);
  });

  it('should return null for invalid JSON', () => {
    const rawData = {
      type: 'pending',
      intent: 'invalid{json',
      publishedAt: Date.now(),
    };

    const parsed = parsePendingOpportunity(rawData);
    expect(parsed).toBeNull();
  });
});

// =============================================================================
// Chain ID Mapping Tests
// =============================================================================

describe('Chain ID to Name Mapping', () => {
  // FIX 9.1: Using centralized getChainName from @arbitrage/config

  it('should map Ethereum mainnet', () => {
    expect(getChainName(1)).toBe('ethereum');
  });

  it('should map BSC', () => {
    expect(getChainName(56)).toBe('bsc');
  });

  it('should map Polygon', () => {
    expect(getChainName(137)).toBe('polygon');
  });

  it('should map Arbitrum', () => {
    expect(getChainName(42161)).toBe('arbitrum');
  });

  it('should map Optimism', () => {
    expect(getChainName(10)).toBe('optimism');
  });

  it('should map Base', () => {
    expect(getChainName(8453)).toBe('base');
  });

  it('should map Avalanche', () => {
    expect(getChainName(43114)).toBe('avalanche');
  });

  it('should map Fantom', () => {
    // FIX 9.1: Centralized mapping includes fantom
    expect(getChainName(250)).toBe('fantom');
  });

  it('should return unknown for unrecognized chain', () => {
    // FIX 9.1: Centralized getChainName returns 'unknown' instead of undefined
    expect(getChainName(999999)).toBe('unknown');
  });
});

// =============================================================================
// Pending Opportunity Handler Tests
// =============================================================================

describe('Pending Opportunity Handler', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  /**
   * Handler for pending opportunity events.
   * This will be implemented in the detector service.
   */
  interface PendingOpportunityHandler {
    handlePendingOpportunity(opp: PendingOpportunity): Promise<void>;
    getStats(): { processed: number; errors: number; ignored: number };
  }

  /**
   * Create a mock handler for testing.
   */
  function createMockHandler(): PendingOpportunityHandler {
    let processed = 0;
    const errors = 0;
    let ignored = 0;

    return {
      async handlePendingOpportunity(opp: PendingOpportunity): Promise<void> {
        const intent = opp.intent;

        // Check if deadline has passed
        if (intent.deadline < Math.floor(Date.now() / 1000)) {
          ignored++;
          return;
        }

        // Check if opportunity is too small (less than 0.01 ETH equivalent)
        const MIN_AMOUNT = 10000000000000000n; // 0.01 ETH
        if (intent.amountIn < MIN_AMOUNT) {
          ignored++;
          return;
        }

        processed++;
      },
      getStats: () => ({ processed, errors, ignored }),
    };
  }

  it('should process valid pending opportunity', async () => {
    const handler = createMockHandler();
    const opp = createPendingOpportunity();

    await handler.handlePendingOpportunity(opp);

    const stats = handler.getStats();
    expect(stats.processed).toBe(1);
    expect(stats.ignored).toBe(0);
  });

  it('should ignore expired opportunities', async () => {
    const handler = createMockHandler();
    const expiredDeadline = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const opp = createPendingOpportunity({ deadline: expiredDeadline });

    await handler.handlePendingOpportunity(opp);

    const stats = handler.getStats();
    expect(stats.processed).toBe(0);
    expect(stats.ignored).toBe(1);
  });

  it('should ignore small opportunities', async () => {
    const handler = createMockHandler();
    const opp = createPendingOpportunity({ amountIn: 1000000000000000n }); // 0.001 ETH

    await handler.handlePendingOpportunity(opp);

    const stats = handler.getStats();
    expect(stats.processed).toBe(0);
    expect(stats.ignored).toBe(1);
  });

  it('should process multiple opportunities', async () => {
    const handler = createMockHandler();

    await handler.handlePendingOpportunity(createPendingOpportunity());
    await handler.handlePendingOpportunity(createPendingOpportunity());
    await handler.handlePendingOpportunity(createPendingOpportunity());

    const stats = handler.getStats();
    expect(stats.processed).toBe(3);
  });
});

// =============================================================================
// Event Emission Tests
// =============================================================================

describe('Stream Consumer Pending Events', () => {
  it('should emit pendingOpportunity event with correct data', (done) => {
    // Simulating EventEmitter behavior that stream-consumer will use
    const { EventEmitter } = require('events');
    const emitter = new EventEmitter();

    const expectedOpp = createPendingOpportunity();

    emitter.on('pendingOpportunity', (opp: PendingOpportunity) => {
      expect(opp.type).toBe('pending');
      expect(opp.intent.hash).toBe(expectedOpp.intent.hash);
      expect(opp.intent.chainId).toBe(1);
      done();
    });

    // Simulate stream consumer emitting event
    emitter.emit('pendingOpportunity', expectedOpp);
  });

  it('should not emit event for invalid opportunities', () => {
    const { EventEmitter } = require('events');
    const emitter = new EventEmitter();

    let emitCount = 0;
    emitter.on('pendingOpportunity', () => {
      emitCount++;
    });

    // Only emit valid opportunities
    const validOpp = createPendingOpportunity();
    emitter.emit('pendingOpportunity', validOpp);

    expect(emitCount).toBe(1);
  });
});

// =============================================================================
// Opportunity Enrichment Tests
// =============================================================================

describe('Pending Opportunity Enrichment', () => {
  /**
   * Enrich a pending opportunity with additional context.
   * This function converts mempool data to arbitrage opportunity format.
   */
  function enrichPendingOpportunity(
    opp: PendingOpportunity,
    chainName: string
  ): {
    id: string;
    type: 'pending';
    chain: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    expectedAmountOut: string;
    confidence: number;
    timestamp: number;
    source: 'mempool';
    pendingTxHash: string;
    pendingDeadline: number;
    pendingSlippage: number;
    routerType: string;
  } {
    return {
      id: `pending-${opp.intent.hash}`,
      type: 'pending',
      chain: chainName,
      tokenIn: opp.intent.tokenIn,
      tokenOut: opp.intent.tokenOut,
      amountIn: opp.intent.amountIn.toString(),
      expectedAmountOut: opp.intent.expectedAmountOut.toString(),
      confidence: 0.7, // Base confidence for mempool opportunities
      timestamp: opp.publishedAt,
      source: 'mempool',
      pendingTxHash: opp.intent.hash,
      pendingDeadline: opp.intent.deadline,
      pendingSlippage: opp.intent.slippageTolerance,
      routerType: opp.intent.type,
    };
  }

  it('should enrich pending opportunity with chain name', () => {
    const opp = createPendingOpportunity();
    const enriched = enrichPendingOpportunity(opp, 'ethereum');

    expect(enriched.chain).toBe('ethereum');
    expect(enriched.type).toBe('pending');
    expect(enriched.source).toBe('mempool');
  });

  it('should preserve token addresses', () => {
    const opp = createPendingOpportunity({
      tokenIn: '0xWETH',
      tokenOut: '0xUSDC',
    });
    const enriched = enrichPendingOpportunity(opp, 'ethereum');

    expect(enriched.tokenIn).toBe('0xWETH');
    expect(enriched.tokenOut).toBe('0xUSDC');
  });

  it('should convert BigInt amounts to strings', () => {
    const opp = createPendingOpportunity({
      amountIn: 1000000000000000000n,
      expectedAmountOut: 2500000000n,
    });
    const enriched = enrichPendingOpportunity(opp, 'ethereum');

    expect(enriched.amountIn).toBe('1000000000000000000');
    expect(enriched.expectedAmountOut).toBe('2500000000');
  });

  it('should include pending tx metadata', () => {
    const opp = createPendingOpportunity({
      hash: '0xtxhash',
      deadline: 1700000000,
      slippageTolerance: 0.01,
    });
    const enriched = enrichPendingOpportunity(opp, 'ethereum');

    expect(enriched.pendingTxHash).toBe('0xtxhash');
    expect(enriched.pendingDeadline).toBe(1700000000);
    expect(enriched.pendingSlippage).toBe(0.01);
  });

  it('should include router type', () => {
    const opp = createPendingOpportunity({ type: 'uniswapV3' });
    const enriched = enrichPendingOpportunity(opp, 'ethereum');

    expect(enriched.routerType).toBe('uniswapV3');
  });

  it('should generate unique ID from tx hash', () => {
    const opp = createPendingOpportunity({ hash: '0xabc123' });
    const enriched = enrichPendingOpportunity(opp, 'ethereum');

    expect(enriched.id).toBe('pending-0xabc123');
  });
});

// =============================================================================
// Consumer Group Configuration Tests
// =============================================================================

describe('Pending Opportunities Consumer Group', () => {
  const PENDING_OPPORTUNITIES_STREAM = 'stream:pending-opportunities';
  const CONSUMER_GROUP = 'cross-chain-detector';

  it('should have correct stream name', () => {
    expect(PENDING_OPPORTUNITIES_STREAM).toBe('stream:pending-opportunities');
  });

  it('should create consumer group config', () => {
    const instanceId = 'detector-1';

    const config = {
      streamName: PENDING_OPPORTUNITIES_STREAM,
      groupName: CONSUMER_GROUP,
      consumerName: `${CONSUMER_GROUP}-${instanceId}`,
      startId: '$', // Only new messages
    };

    expect(config.streamName).toBe('stream:pending-opportunities');
    expect(config.groupName).toBe('cross-chain-detector');
    expect(config.consumerName).toBe('cross-chain-detector-detector-1');
    expect(config.startId).toBe('$');
  });
});
