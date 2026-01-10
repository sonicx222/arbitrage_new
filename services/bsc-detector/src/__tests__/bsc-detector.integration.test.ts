import { BSCDetectorService } from '../detector';
import { getRedisClient, resetRedisInstance } from '../../../shared/core/src/redis';

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
    logHealthCheck: jest.fn()
  })),
  createEventBatcher: jest.fn(() => ({
    addEvent: jest.fn(),
    flushAll: jest.fn(),
    destroy: jest.fn()
  }))
}));

// Mock ethers
jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn(() => ({
      // Mock provider methods
    })),
    Contract: jest.fn(() => ({
      getPair: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890')
    })),
    AbiCoder: {
      defaultAbiCoder: {
        decode: jest.fn(() => ['1000000000000000000', '1010000000000000000'])
      }
    },
    ZeroAddress: '0x0000000000000000000000000000000000000000'
  }
}));

// Mock WebSocket
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    removeAllListeners: jest.fn()
  }));
});

describe('BSCDetectorService Integration', () => {
  let detector: BSCDetectorService;
  let mockRedis: any;
  let mockWebSocket: any;

  beforeEach(() => {
    // Reset Redis singleton
    resetRedisInstance();

    // Create mock Redis
    mockRedis = {
      disconnect: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue(undefined)
    };

    // Create mock WebSocket
    mockWebSocket = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      removeAllListeners: jest.fn()
    };

    (getRedisClient as jest.Mock).mockResolvedValue(mockRedis);

    // Mock WebSocket constructor
    const WebSocketMock = jest.requireMock('ws');
    WebSocketMock.mockImplementation(() => mockWebSocket);

    detector = new BSCDetectorService();
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
  });

  describe('lifecycle management', () => {
    it('should start and initialize properly', async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();

      expect(getRedisClient).toHaveBeenCalled();
      expect(mockWebSocket.on).toHaveBeenCalledWith('open', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should handle WebSocket connection failures', async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'error') {
          callback(new Error('Connection failed'));
        }
      });

      await expect(detector.start()).rejects.toThrow('Connection failed');
    });

    it('should stop and clean up resources', async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();
      await detector.stop();

      expect(mockWebSocket.removeAllListeners).toHaveBeenCalled();
      expect(mockWebSocket.close).toHaveBeenCalled();
      expect(mockRedis.disconnect).toHaveBeenCalled();
      expect((detector as any).eventBatcher.destroy).toHaveBeenCalled();
    });

    it('should handle stop when not running', async () => {
      await expect(detector.stop()).resolves.not.toThrow();
    });
  });

  describe('pair initialization', () => {
    it('should initialize trading pairs successfully', async () => {
      await detector.start();

      const pairs = (detector as any).pairs;
      expect(pairs.size).toBeGreaterThan(0);

      // Verify pairs have correct structure
      for (const [pairKey, pair] of pairs) {
        expect(pair.address).toBeDefined();
        expect(pair.token0).toBeDefined();
        expect(pair.token1).toBeDefined();
        expect(pair.dex).toBeDefined();
      }
    });

    it('should skip pairs that do not exist', async () => {
      // Mock contract to return zero address for some pairs
      const mockContract = {
        getPair: jest.fn()
          .mockResolvedValueOnce('0x1234567890123456789012345678901234567890') // Valid pair
          .mockResolvedValue('0x0000000000000000000000000000000000000000') // Invalid pair
      };

      jest.requireMock('ethers').ethers.Contract.mockImplementation(() => mockContract);

      const newDetector = new BSCDetectorService();
      await newDetector.start();

      const pairs = (newDetector as any).pairs;
      expect(pairs.size).toBe(1); // Only one valid pair

      await newDetector.stop();
    });

    it('should handle contract call failures gracefully', async () => {
      const mockContract = {
        getPair: jest.fn().mockRejectedValue(new Error('RPC error'))
      };

      jest.requireMock('ethers').ethers.Contract.mockImplementation(() => mockContract);

      const newDetector = new BSCDetectorService();

      // Should not throw, should log warnings
      await expect(newDetector.start()).resolves.not.toThrow();

      await newDetector.stop();
    });
  });

  describe('WebSocket event handling', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();
    });

    it('should subscribe to events on connection', () => {
      expect(mockWebSocket.send).toHaveBeenCalledWith(expect.stringContaining('eth_subscribe'));
      expect(mockWebSocket.send).toHaveBeenCalledWith(expect.stringContaining('Sync'));
      expect(mockWebSocket.send).toHaveBeenCalledWith(expect.stringContaining('Swap'));
    });

    it('should handle WebSocket messages', () => {
      const messageCallback = mockWebSocket.on.mock.calls.find(call => call[0] === 'message')[1];

      const testMessage = {
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: {
          result: {
            address: '0x1234567890123456789012345678901234567890',
            topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
            data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000de0b6b3a7640000'
          }
        }
      };

      // Should not throw
      expect(() => {
        messageCallback(Buffer.from(JSON.stringify(testMessage)));
      }).not.toThrow();
    });

    it('should handle malformed messages gracefully', () => {
      const messageCallback = mockWebSocket.on.mock.calls.find(call => call[0] === 'message')[1];

      // Should not throw on invalid JSON
      expect(() => {
        messageCallback(Buffer.from('invalid json'));
      }).not.toThrow();
    });
  });

  describe('WebSocket reconnection', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();
    });

    it('should attempt reconnection on connection close', async () => {
      const closeCallback = mockWebSocket.on.mock.calls.find(call => call[0] === 'close')[1];

      // Simulate connection close
      closeCallback(1000, Buffer.from('Normal closure'));

      // Should schedule reconnection
      expect((detector as any).reconnectionTimer).toBeDefined();

      // Clear timer to avoid test hanging
      if ((detector as any).reconnectionTimer) {
        clearTimeout((detector as any).reconnectionTimer);
        (detector as any).reconnectionTimer = null;
      }
    });

    it('should not attempt reconnection when stopping', async () => {
      // Start stopping process
      const stopPromise = detector.stop();

      // Simulate connection close during shutdown
      const closeCallback = mockWebSocket.on.mock.calls.find(call => call[0] === 'close')[1];
      closeCallback(1000, Buffer.from('Normal closure'));

      await stopPromise;

      // Should not have reconnection timer
      expect((detector as any).reconnectionTimer).toBeNull();
    });

    it('should handle reconnection failures with backoff', async () => {
      const closeCallback = mockWebSocket.on.mock.calls.find(call => call[0] === 'close')[1];

      // Mock WebSocket constructor to fail on reconnection
      const WebSocketMock = jest.requireMock('ws');
      WebSocketMock.mockImplementationOnce(() => {
        throw new Error('Reconnection failed');
      });

      // Simulate connection close
      closeCallback(1000, Buffer.from('Normal closure'));

      // Wait for reconnection attempt
      await new Promise(resolve => setTimeout(resolve, 6000));

      // Should have attempted reconnection
      expect(WebSocketMock).toHaveBeenCalledTimes(2); // Original + reconnection attempt
    });
  });

  describe('event processing', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();
    });

    it('should process Sync events', async () => {
      const mockLog = {
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
        data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000de0b6b3a7640000',
        blockNumber: '0x123456'
      };

      await (detector as any).processLogEvent(mockLog);

      // Should update pair data
      const pairs = (detector as any).pairs;
      const pair = Array.from(pairs.values())[0];
      expect(pair.reserve0).toBe('1000000000000000000');
      expect(pair.reserve1).toBe('1000000000000000000');
    });

    it('should process Swap events', async () => {
      const mockLog = {
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822e'],
        data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
        blockNumber: '0x123456'
      };

      await expect((detector as any).processLogEvent(mockLog)).resolves.not.toThrow();
    });

    it('should skip events for unknown pairs', async () => {
      const mockLog = {
        address: '0x9999999999999999999999999999999999999999', // Unknown address
        topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
        data: '0x',
        blockNumber: '0x123456'
      };

      // Should not throw, should just skip
      await expect((detector as any).processLogEvent(mockLog)).resolves.not.toThrow();
    });

    it('should handle event processing errors gracefully', async () => {
      const mockLog = {
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
        data: 'invalid data', // Will cause decode error
        blockNumber: '0x123456'
      };

      // Should not throw
      await expect((detector as any).processLogEvent(mockLog)).resolves.not.toThrow();
    });
  });

  describe('health monitoring', () => {
    beforeEach(async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();
    });

    it('should report healthy status when running', () => {
      const health = (detector as any).isRunning;
      expect(health).toBe(true);
    });

    it('should report unhealthy status when stopped', async () => {
      await detector.stop();

      const health = (detector as any).isRunning;
      expect(health).toBe(false);
    });
  });

  describe('resource cleanup', () => {
    it('should clean up all resources on stop', async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();

      // Verify resources are allocated
      expect((detector as any).wsProvider).toBeDefined();
      expect((detector as any).redis).toBeDefined();

      await detector.stop();

      // Verify resources are cleaned up
      expect((detector as any).wsProvider).toBeNull();
      expect((detector as any).redis).toBeNull();
      expect((detector as any).reconnectionTimer).toBeNull();
    });

    it('should handle cleanup errors gracefully', async () => {
      mockRedis.disconnect.mockRejectedValue(new Error('Cleanup failed'));

      await detector.start();

      // Should not throw despite cleanup error
      await expect(detector.stop()).resolves.not.toThrow();
    });
  });

  describe('concurrent operations', () => {
    it('should handle concurrent event processing safely', async () => {
      mockWebSocket.on.mockImplementation((event: string, callback: () => void) => {
        if (event === 'open') {
          callback();
        }
      });

      await detector.start();

      const mockLog = {
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
        data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000de0b6b3a7640000',
        blockNumber: '0x123456'
      };

      // Process multiple events concurrently
      const promises = [
        (detector as any).processLogEvent(mockLog),
        (detector as any).processLogEvent(mockLog),
        (detector as any).processLogEvent(mockLog)
      ];

      await expect(Promise.all(promises)).resolves.not.toThrow();
    });
  });
});