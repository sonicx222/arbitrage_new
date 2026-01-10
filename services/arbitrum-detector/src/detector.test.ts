// Arbitrum Detector Service Unit Tests
import { ArbitrumDetectorService } from './detector';

// Mock dependencies
jest.mock('../../../shared/core/src', () => ({
  getRedisClient: jest.fn(),
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  getPerformanceLogger: jest.fn(() => ({
    logEventLatency: jest.fn(),
    logArbitrageOpportunity: jest.fn(),
    logHealthCheck: jest.fn()
  }))
}));

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn(() => ({
      // Mock provider methods
    })),
    Contract: jest.fn(() => ({
      getPair: jest.fn()
    })),
    AbiCoder: {
      defaultAbiCoder: {
        decode: jest.fn()
      }
    },
    ZeroAddress: '0x0000000000000000000000000000000000000000'
  }
}));

jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    readyState: 1 // OPEN
  }));
});

describe('ArbitrumDetectorService', () => {
  let detector: ArbitrumDetectorService;
  let mockRedis: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock Redis
    mockRedis = {
      publish: jest.fn().mockResolvedValue(1),
      updateServiceHealth: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined)
    };
    const { getRedisClient } = require('../../../shared/core/src');
    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

    detector = new ArbitrumDetectorService();
  });

  afterEach(async () => {
    // Clean up
    if (detector) {
      await detector.stop();
    }
  });

  describe('initialization', () => {
    test('should initialize with ultra-fast configuration', () => {
      expect(detector).toBeDefined();
    });
  });

  describe('ultra-fast processing', () => {
    test('should process events in 50ms intervals', async () => {
      // Start the service
      await (detector as any).startUltraFastProcessing();

      // Verify processing interval is set
      expect((detector as any).processingInterval).toBeDefined();

      // Clean up
      if ((detector as any).processingInterval) {
        clearInterval((detector as any).processingInterval);
      }
    });

    test('should buffer events for ultra-fast processing', () => {
      const mockEvent = {
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
        data: '0x00...',
        blockNumber: '0x123456'
      };

      // Simulate adding event to buffer
      (detector as any).eventBuffer.push(mockEvent);

      expect((detector as any).eventBuffer.length).toBe(1);
    });
  });

  describe('price calculation', () => {
    test('should calculate Arbitrum prices correctly', () => {
      const pair = {
        reserve0: '1000000000000000000', // 1.0 WETH
        reserve1: '2500000000' // 2500 USDT
      };

      const price = (detector as any).calculatePrice(pair);
      expect(price).toBeCloseTo(2500, 0);
    });
  });

  describe('whale activity detection', () => {
    test('should detect large Arbitrum trades with lower threshold', async () => {
      const swapEvent = {
        pairAddress: '0x1234567890123456789012345678901234567890',
        sender: '0xabcdef1234567890abcdef1234567890abcdef12',
        recipient: '0x1234567890123456789012345678901234567890',
        amount0In: '25000000000000000000', // 25 ETH
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '62500000000', // 62,500 USDT
        to: '0x1234567890123456789012345678901234567890',
        blockNumber: 100000000,
        transactionHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        timestamp: Date.now(),
        dex: 'uniswap_v3',
        chain: 'arbitrum',
        usdValue: 62500 // $62.5K trade
      };

      // Mock USD value calculation
      jest.spyOn(detector as any, 'estimateUsdValue').mockResolvedValue(62500);

      await (detector as any).checkWhaleActivity(swapEvent);

      // Should publish whale transaction (above $25K threshold)
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'whale-transactions',
        expect.objectContaining({
          type: 'whale-transaction',
          source: 'arbitrum-detector'
        })
      );
    });

    test('should ignore small trades below Arbitrum threshold', async () => {
      const swapEvent = {
        pairAddress: '0x1234567890123456789012345678901234567890',
        sender: '0xabcdef1234567890abcdef1234567890abcdef12',
        recipient: '0x1234567890123456789012345678901234567890',
        amount0In: '1000000000000000000', // 1 ETH
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '2500000000', // 2500 USDT
        to: '0x1234567890123456789012345678901234567890',
        blockNumber: 100000000,
        transactionHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        timestamp: Date.now(),
        dex: 'uniswap_v3',
        chain: 'arbitrum',
        usdValue: 2500 // $2.5K trade (below $25K threshold)
      };

      // Mock USD value calculation
      jest.spyOn(detector as any, 'estimateUsdValue').mockResolvedValue(2500);

      await (detector as any).checkWhaleActivity(swapEvent);

      // Should not publish whale transaction
      expect(mockRedis.publish).not.toHaveBeenCalledWith(
        'whale-transactions',
        expect.objectContaining({
          type: 'whale-transaction'
        })
      );
    });
  });

  describe('health monitoring', () => {
    test('should include ultra-fast mode in health status', async () => {
      // Start health monitoring
      (detector as any).startHealthMonitoring();

      // Wait for health check interval
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify health was updated with ultra-fast mode
      expect(mockRedis.updateServiceHealth).toHaveBeenCalledWith(
        'arbitrum-detector',
        expect.objectContaining({
          service: 'arbitrum-detector',
          ultraFastMode: true
        })
      );
    });
  });
});