/**
 * Queue Service Tests
 *
 * Tests for the execution queue including:
 * - O(1) circular buffer operations
 * - Hysteresis-based backpressure
 * - Manual pause/resume for standby mode
 * - Event signaling for processing
 * - Queue configuration
 */

import { QueueServiceImpl, QueueServiceConfig } from '../../../src/services/queue.service';
import type { Logger } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock Implementations
// =============================================================================

const createMockLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const createMockOpportunity = (id: string): ArbitrageOpportunity => ({
  id,
  type: 'simple',
  buyChain: 'ethereum',
  sellChain: 'ethereum',
  buyDex: 'uniswap',
  sellDex: 'sushiswap',
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amountIn: '1000000000000000000',
  expectedProfit: 100,
  confidence: 0.95,
  timestamp: Date.now(),
});

// =============================================================================
// Test Suite: Basic Queue Operations
// =============================================================================

describe('QueueService - Basic Operations', () => {
  let queue: QueueServiceImpl;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    queue = new QueueServiceImpl({
      logger: mockLogger,
      queueConfig: {
        maxSize: 100,
        highWaterMark: 80,
        lowWaterMark: 20,
      },
    });
  });

  afterEach(() => {
    queue.clear();
  });

  it('should enqueue and dequeue items in FIFO order', () => {
    const opp1 = createMockOpportunity('opp-1');
    const opp2 = createMockOpportunity('opp-2');
    const opp3 = createMockOpportunity('opp-3');

    expect(queue.enqueue(opp1)).toBe(true);
    expect(queue.enqueue(opp2)).toBe(true);
    expect(queue.enqueue(opp3)).toBe(true);

    expect(queue.size()).toBe(3);

    expect(queue.dequeue()).toEqual(opp1);
    expect(queue.dequeue()).toEqual(opp2);
    expect(queue.dequeue()).toEqual(opp3);

    expect(queue.size()).toBe(0);
  });

  it('should return undefined when dequeuing from empty queue', () => {
    expect(queue.dequeue()).toBeUndefined();
  });

  it('should report correct size', () => {
    expect(queue.size()).toBe(0);

    queue.enqueue(createMockOpportunity('opp-1'));
    expect(queue.size()).toBe(1);

    queue.enqueue(createMockOpportunity('opp-2'));
    expect(queue.size()).toBe(2);

    queue.dequeue();
    expect(queue.size()).toBe(1);
  });

  it('should clear the queue', () => {
    queue.enqueue(createMockOpportunity('opp-1'));
    queue.enqueue(createMockOpportunity('opp-2'));
    expect(queue.size()).toBe(2);

    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.isPaused()).toBe(false);
    expect(queue.isManuallyPaused()).toBe(false);
  });
});

// =============================================================================
// Test Suite: Capacity and Rejection
// =============================================================================

describe('QueueService - Capacity', () => {
  let queue: QueueServiceImpl;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    queue = new QueueServiceImpl({
      logger: mockLogger,
      queueConfig: {
        maxSize: 5,
        highWaterMark: 4,
        lowWaterMark: 2,
      },
    });
  });

  afterEach(() => {
    queue.clear();
  });

  it('should reject enqueue when backpressure engaged at high water mark', () => {
    // Fill to high water mark (4)
    for (let i = 0; i < 4; i++) {
      expect(queue.enqueue(createMockOpportunity(`opp-${i}`))).toBe(true);
    }

    // At high water mark, backpressure engages and rejects further items
    expect(queue.canEnqueue()).toBe(false);
    expect(queue.enqueue(createMockOpportunity('opp-overflow'))).toBe(false);
  });

  it('should report canEnqueue correctly', () => {
    expect(queue.canEnqueue()).toBe(true);

    // Fill to just below high water mark (3 items, HWM is 4)
    for (let i = 0; i < 3; i++) {
      queue.enqueue(createMockOpportunity(`opp-${i}`));
    }
    expect(queue.canEnqueue()).toBe(true);

    // Add one more to reach high water mark
    queue.enqueue(createMockOpportunity('opp-3'));

    // At high water mark, backpressure engaged
    expect(queue.canEnqueue()).toBe(false);
  });
});

// =============================================================================
// Test Suite: Backpressure (Hysteresis)
// =============================================================================

describe('QueueService - Backpressure', () => {
  let queue: QueueServiceImpl;
  let mockLogger: Logger;
  let pauseCallback: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    pauseCallback = jest.fn();

    queue = new QueueServiceImpl({
      logger: mockLogger,
      queueConfig: {
        maxSize: 10,
        highWaterMark: 8,
        lowWaterMark: 3,
      },
    });

    queue.onPauseStateChange(pauseCallback);
  });

  afterEach(() => {
    queue.clear();
  });

  it('should engage backpressure at high water mark', () => {
    // Fill to just below high water mark
    for (let i = 0; i < 7; i++) {
      queue.enqueue(createMockOpportunity(`opp-${i}`));
    }
    expect(queue.isPaused()).toBe(false);

    // Add one more to hit high water mark (8)
    queue.enqueue(createMockOpportunity('opp-trigger'));
    expect(queue.isPaused()).toBe(true);
    expect(pauseCallback).toHaveBeenCalledWith(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Queue backpressure engaged',
      expect.any(Object)
    );
  });

  it('should release backpressure only at low water mark (hysteresis)', () => {
    // Engage backpressure
    for (let i = 0; i < 8; i++) {
      queue.enqueue(createMockOpportunity(`opp-${i}`));
    }
    expect(queue.isPaused()).toBe(true);
    pauseCallback.mockClear();

    // Dequeue to 5 items (still above low water mark of 3)
    queue.dequeue();
    queue.dequeue();
    queue.dequeue();
    expect(queue.size()).toBe(5);
    expect(queue.isPaused()).toBe(true); // Still paused (hysteresis)

    // Dequeue to 3 items (at low water mark)
    queue.dequeue();
    queue.dequeue();
    expect(queue.size()).toBe(3);
    expect(queue.isPaused()).toBe(false); // Now released
    expect(pauseCallback).toHaveBeenCalledWith(false);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Queue backpressure released',
      expect.any(Object)
    );
  });

  it('should not re-engage backpressure between water marks', () => {
    // Engage and release backpressure
    for (let i = 0; i < 8; i++) {
      queue.enqueue(createMockOpportunity(`opp-${i}`));
    }
    while (queue.size() > 3) {
      queue.dequeue();
    }
    expect(queue.isPaused()).toBe(false);
    pauseCallback.mockClear();

    // Add items but stay below high water mark
    queue.enqueue(createMockOpportunity('opp-new-1'));
    queue.enqueue(createMockOpportunity('opp-new-2'));
    expect(queue.size()).toBe(5);
    expect(queue.isPaused()).toBe(false); // Should not re-engage
    expect(pauseCallback).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Manual Pause (Standby Mode)
// =============================================================================

describe('QueueService - Manual Pause (Standby)', () => {
  let queue: QueueServiceImpl;
  let mockLogger: Logger;
  let pauseCallback: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    pauseCallback = jest.fn();

    queue = new QueueServiceImpl({
      logger: mockLogger,
      queueConfig: {
        maxSize: 100,
        highWaterMark: 80,
        lowWaterMark: 20,
      },
    });

    queue.onPauseStateChange(pauseCallback);
  });

  afterEach(() => {
    queue.clear();
  });

  it('should manually pause the queue', () => {
    expect(queue.isManuallyPaused()).toBe(false);
    expect(queue.isPaused()).toBe(false);

    queue.pause();

    expect(queue.isManuallyPaused()).toBe(true);
    expect(queue.isPaused()).toBe(true);
    expect(pauseCallback).toHaveBeenCalledWith(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Queue manually paused (standby mode)'
    );
  });

  it('should manually resume the queue', () => {
    queue.pause();
    pauseCallback.mockClear();

    queue.resume();

    expect(queue.isManuallyPaused()).toBe(false);
    expect(queue.isPaused()).toBe(false);
    expect(pauseCallback).toHaveBeenCalledWith(false);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Queue manually resumed (activated)'
    );
  });

  it('should not allow enqueue when manually paused', () => {
    queue.pause();

    expect(queue.canEnqueue()).toBe(false);
    expect(queue.enqueue(createMockOpportunity('opp-1'))).toBe(false);
  });

  it('should not double-pause', () => {
    queue.pause();
    pauseCallback.mockClear();

    queue.pause(); // Second pause

    expect(pauseCallback).not.toHaveBeenCalled(); // No duplicate callback
  });

  it('should not double-resume', () => {
    queue.resume(); // Already not paused

    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'Queue manually resumed (activated)'
    );
  });

  it('should require both manual and backpressure to be false for isPaused=false', () => {
    // Engage backpressure
    for (let i = 0; i < 80; i++) {
      queue.enqueue(createMockOpportunity(`opp-${i}`));
    }
    expect(queue.isPaused()).toBe(true);

    // Also manually pause
    queue.pause();
    expect(queue.isPaused()).toBe(true);

    // Resume manual pause
    queue.resume();
    expect(queue.isPaused()).toBe(true); // Still backpressure paused
    expect(queue.isManuallyPaused()).toBe(false);
  });
});

// =============================================================================
// Test Suite: Event Signaling
// =============================================================================

describe('QueueService - Event Signaling', () => {
  let queue: QueueServiceImpl;
  let mockLogger: Logger;
  let itemAvailableCallback: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    itemAvailableCallback = jest.fn();

    queue = new QueueServiceImpl({
      logger: mockLogger,
      queueConfig: {
        maxSize: 100,
        highWaterMark: 80,
        lowWaterMark: 20,
      },
    });

    queue.onItemAvailable(itemAvailableCallback);
  });

  afterEach(() => {
    queue.clear();
  });

  /**
   * Fix 2.1: Updated test to reflect synchronous callback behavior.
   * The callback is now called directly (not via setImmediate) for hot-path optimization.
   */
  it('should signal synchronously when item is enqueued', () => {
    queue.enqueue(createMockOpportunity('opp-1'));

    // Callback is now called synchronously (Fix 2.1 - hot-path optimization)
    expect(itemAvailableCallback).toHaveBeenCalled();
  });

  it('should not signal when queue is paused', () => {
    queue.pause();

    // When paused, enqueue returns false and no signal is sent
    const result = queue.enqueue(createMockOpportunity('opp-1'));
    expect(result).toBe(false);

    expect(itemAvailableCallback).not.toHaveBeenCalled();
  });

  it('should signal pending items on resume', () => {
    // Add item first (while not paused)
    queue.enqueue(createMockOpportunity('opp-1'));
    itemAvailableCallback.mockClear();

    // Pause and resume with items in queue
    queue.pause();
    queue.resume();

    // Callback should be called synchronously on resume
    expect(itemAvailableCallback).toHaveBeenCalled();
  });

  /**
   * Fix 10.1: Test that callback exceptions don't crash enqueue.
   * The signalItemAvailable method should catch exceptions and log them
   * without disrupting the queue operation.
   */
  it('should not crash when itemAvailable callback throws (Fix 10.1)', () => {
    // Set up callback that throws
    const throwingCallback = jest.fn(() => {
      throw new Error('Callback exception');
    });
    queue.onItemAvailable(throwingCallback);

    // Enqueue should still succeed
    const result = queue.enqueue(createMockOpportunity('opp-1'));
    expect(result).toBe(true);
    expect(queue.size()).toBe(1);

    // Callback was called and threw
    expect(throwingCallback).toHaveBeenCalled();

    // Error was logged (not thrown)
    expect(mockLogger.error).toHaveBeenCalledWith(
      'itemAvailableCallback threw an exception',
      expect.objectContaining({
        error: 'Callback exception',
        queueSize: 1,
      })
    );

    // Queue is still functional
    expect(queue.dequeue()?.id).toBe('opp-1');
    expect(queue.size()).toBe(0);
  });
});

// =============================================================================
// Test Suite: Configuration
// =============================================================================

describe('QueueService - Configuration', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
  });

  it('should use provided configuration', () => {
    const queue = new QueueServiceImpl({
      logger: mockLogger,
      queueConfig: {
        maxSize: 500,
        highWaterMark: 400,
        lowWaterMark: 100,
      },
    });

    const config = queue.getConfig();
    expect(config.maxSize).toBe(500);
    expect(config.highWaterMark).toBe(400);
    expect(config.lowWaterMark).toBe(100);
  });

  it('should use default configuration when not provided', () => {
    const queue = new QueueServiceImpl({
      logger: mockLogger,
    });

    const config = queue.getConfig();
    expect(config.maxSize).toBeDefined();
    expect(config.highWaterMark).toBeDefined();
    expect(config.lowWaterMark).toBeDefined();
  });
});

// =============================================================================
// Test Suite: Circular Buffer O(1) Performance
// =============================================================================

describe('QueueService - Circular Buffer', () => {
  let queue: QueueServiceImpl;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    // Use high water marks that won't interfere with wrap-around testing
    queue = new QueueServiceImpl({
      logger: mockLogger,
      queueConfig: {
        maxSize: 20,
        highWaterMark: 18, // High enough to not trigger during tests
        lowWaterMark: 5,
      },
    });
  });

  afterEach(() => {
    queue.clear();
  });

  it('should handle wrap-around correctly', () => {
    // FIFO queue: items are removed in the order they were added
    // This test exercises the circular buffer's wrap-around behavior

    // Add 5 items
    for (let i = 0; i < 5; i++) {
      expect(queue.enqueue(createMockOpportunity(`opp-${i}`))).toBe(true);
    }
    expect(queue.size()).toBe(5);

    // Remove 3 items (in FIFO order)
    expect(queue.dequeue()?.id).toBe('opp-0');
    expect(queue.dequeue()?.id).toBe('opp-1');
    expect(queue.dequeue()?.id).toBe('opp-2');
    expect(queue.size()).toBe(2);

    // Add 5 more items (triggers internal wrap-around)
    for (let i = 5; i < 10; i++) {
      expect(queue.enqueue(createMockOpportunity(`opp-${i}`))).toBe(true);
    }
    expect(queue.size()).toBe(7);

    // Verify FIFO order is maintained across wrap-around
    expect(queue.dequeue()?.id).toBe('opp-3');
    expect(queue.dequeue()?.id).toBe('opp-4');
    expect(queue.dequeue()?.id).toBe('opp-5');
    expect(queue.dequeue()?.id).toBe('opp-6');
    expect(queue.size()).toBe(3);
  });

  it('should maintain FIFO order across wrap-around', () => {
    const items: string[] = [];

    // Fill with 7 items (won't trigger backpressure at HWM=18)
    for (let i = 0; i < 7; i++) {
      queue.enqueue(createMockOpportunity(`opp-${i}`));
      items.push(`opp-${i}`);
    }

    // Drain half
    for (let i = 0; i < 4; i++) {
      const item = queue.dequeue();
      expect(item?.id).toBe(items.shift());
    }

    // Add more (will wrap around internal buffer)
    for (let i = 7; i < 10; i++) {
      queue.enqueue(createMockOpportunity(`opp-${i}`));
      items.push(`opp-${i}`);
    }

    // Drain all and verify order
    while (queue.size() > 0) {
      const item = queue.dequeue();
      expect(item?.id).toBe(items.shift());
    }
  });
});
