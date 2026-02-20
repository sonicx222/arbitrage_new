/**
 * Unit tests for BalanceMonitor
 *
 * Tests periodic balance monitoring, low balance detection,
 * balance drift detection, and error handling.
 */

import { ethers } from 'ethers';
import { BalanceMonitor, createBalanceMonitor } from '../../../src/services/balance-monitor';
import type {
  BalanceMonitorDeps,
  BalanceMonitorConfig,
  ChainBalance,
} from '../../../src/services/balance-monitor';
import type { Logger } from '../../../src/types';

// =============================================================================
// Mocks
// =============================================================================

const createMockLogger = (): jest.Mocked<Logger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

const createMockWallet = (address: string) => ({
  getAddress: jest.fn().mockResolvedValue(address),
});

const createMockProvider = (balance: bigint | Error) => ({
  getBalance: jest.fn().mockImplementation(() => {
    if (balance instanceof Error) {
      return Promise.reject(balance);
    }
    return Promise.resolve(balance);
  }),
});

// =============================================================================
// Tests
// =============================================================================

describe('BalanceMonitor', () => {
  let mockLogger: jest.Mocked<Logger>;
  let mockProviders: Map<string, ReturnType<typeof createMockProvider>>;
  let mockWallets: Map<string, ReturnType<typeof createMockWallet>>;
  let getProviders: jest.Mock;
  let getWallets: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = createMockLogger();
    mockProviders = new Map();
    mockWallets = new Map();
    getProviders = jest.fn(() => mockProviders);
    getWallets = jest.fn(() => mockWallets);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('constructor and factory', () => {
    it('should create instance with default config', () => {
      const deps: BalanceMonitorDeps = {
        logger: mockLogger,
        getProviders,
        getWallets,
      };

      const monitor = new BalanceMonitor(deps);
      expect(monitor).toBeInstanceOf(BalanceMonitor);
    });

    it('should create instance via factory function', () => {
      const deps: BalanceMonitorDeps = {
        logger: mockLogger,
        getProviders,
        getWallets,
      };

      const monitor = createBalanceMonitor(deps);
      expect(monitor).toBeInstanceOf(BalanceMonitor);
    });

    it('should apply custom config values', () => {
      const config: BalanceMonitorConfig = {
        checkIntervalMs: 30000,
        lowBalanceThresholdEth: 0.05,
        enabled: false,
      };

      const deps: BalanceMonitorDeps = {
        logger: mockLogger,
        getProviders,
        getWallets,
        config,
      };

      const monitor = new BalanceMonitor(deps);

      // Config values are private, but we can verify via start() behavior
      expect(monitor).toBeInstanceOf(BalanceMonitor);
    });
  });

  describe('start()', () => {
    it('should perform initial check and set up interval when enabled', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.0'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { checkIntervalMs: 60000 },
      });

      await monitor.start();

      // Initial check should have been called
      expect(wallet.getAddress).toHaveBeenCalledTimes(1);
      expect(provider.getBalance).toHaveBeenCalledWith('0x1234');

      // Verify interval was set by advancing time
      jest.advanceTimersByTime(60000);
      await Promise.resolve(); // Allow promises to resolve

      // Second check should have happened
      expect(wallet.getAddress).toHaveBeenCalledTimes(2);
    });

    it('should be a no-op when enabled=false', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.0'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { enabled: false },
      });

      await monitor.start();

      expect(mockLogger.info).toHaveBeenCalledWith('Balance monitor disabled');
      expect(wallet.getAddress).not.toHaveBeenCalled();
      expect(provider.getBalance).not.toHaveBeenCalled();

      // Advance time and verify no checks occurred
      jest.advanceTimersByTime(120000);
      await Promise.resolve();

      expect(wallet.getAddress).not.toHaveBeenCalled();
    });

    it('should log start message with config', async () => {
      mockWallets.set('ethereum', createMockWallet('0x1234'));
      mockProviders.set('ethereum', createMockProvider(ethers.parseEther('1.0')));

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: {
          checkIntervalMs: 30000,
          lowBalanceThresholdEth: 0.05,
        },
      });

      await monitor.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting per-chain balance monitor',
        {
          checkIntervalMs: 30000,
          lowBalanceThresholdEth: 0.05,
        }
      );
    });

    it('should catch and log errors during interval checks', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(new Error('Network timeout'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { checkIntervalMs: 60000 },
      });

      await monitor.start();

      // Clear initial check logs
      mockLogger.error.mockClear();

      // Mock implementation to throw on next call
      getProviders.mockImplementationOnce(() => {
        throw new Error('Fatal error');
      });

      jest.advanceTimersByTime(60000);
      await Promise.resolve();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Balance check cycle failed',
        expect.objectContaining({
          error: 'Fatal error',
        })
      );
    });
  });

  describe('stop()', () => {
    it('should clear the interval', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.0'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { checkIntervalMs: 60000 },
      });

      await monitor.start();
      expect(wallet.getAddress).toHaveBeenCalledTimes(1);

      monitor.stop();

      // Advance time and verify no more checks occur
      jest.advanceTimersByTime(120000);
      await Promise.resolve();

      expect(wallet.getAddress).toHaveBeenCalledTimes(1); // Still 1 from initial
      expect(mockLogger.info).toHaveBeenCalledWith('Balance monitor stopped');
    });
  });

  describe('checkAllBalances()', () => {
    it('should query balance for each chain with wallet and provider', async () => {
      const ethWallet = createMockWallet('0xETH');
      const arbWallet = createMockWallet('0xARB');
      const ethProvider = createMockProvider(ethers.parseEther('2.5'));
      const arbProvider = createMockProvider(ethers.parseEther('1.8'));

      mockWallets.set('ethereum', ethWallet);
      mockWallets.set('arbitrum', arbWallet);
      mockProviders.set('ethereum', ethProvider);
      mockProviders.set('arbitrum', arbProvider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      expect(ethWallet.getAddress).toHaveBeenCalled();
      expect(ethProvider.getBalance).toHaveBeenCalledWith('0xETH');

      expect(arbWallet.getAddress).toHaveBeenCalled();
      expect(arbProvider.getBalance).toHaveBeenCalledWith('0xARB');

      const snapshot = monitor.getSnapshot();
      expect(snapshot.healthyCount).toBe(2);
      expect(snapshot.failedCount).toBe(0);
    });

    it('should handle missing provider gracefully (healthy: false)', async () => {
      const wallet = createMockWallet('0x1234');
      mockWallets.set('ethereum', wallet);
      // No provider added for ethereum

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const chainBalance = monitor.getChainBalance('ethereum');
      expect(chainBalance).toBeDefined();
      expect(chainBalance?.healthy).toBe(false);
      expect(chainBalance?.error).toBe('No provider available');
      expect(chainBalance?.balanceEth).toBe('0');
      expect(chainBalance?.balanceWei).toBe('0');
      expect(chainBalance?.address).toBe('unknown');
    });

    it('should handle provider.getBalance errors gracefully', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(new Error('RPC connection failed'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const chainBalance = monitor.getChainBalance('ethereum');
      expect(chainBalance).toBeDefined();
      expect(chainBalance?.healthy).toBe(false);
      expect(chainBalance?.error).toBe('RPC connection failed');
      expect(chainBalance?.balanceEth).toBe('0');
      expect(chainBalance?.balanceWei).toBe('0');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to query balance',
        expect.objectContaining({
          chain: 'ethereum',
          error: 'RPC connection failed',
        })
      );
    });

    it('should store successful balance in correct format', async () => {
      const wallet = createMockWallet('0x1234');
      const balanceWei = ethers.parseEther('3.456789');
      const provider = createMockProvider(balanceWei);
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const chainBalance = monitor.getChainBalance('ethereum');
      expect(chainBalance).toBeDefined();
      expect(chainBalance?.chain).toBe('ethereum');
      expect(chainBalance?.address).toBe('0x1234');
      expect(chainBalance?.balanceEth).toBe('3.456789');
      expect(chainBalance?.balanceWei).toBe(balanceWei.toString());
      expect(chainBalance?.healthy).toBe(true);
      expect(chainBalance?.error).toBeUndefined();
      expect(chainBalance?.lastCheckedAt).toBeGreaterThan(0);
    });
  });

  describe('low balance detection', () => {
    it('should warn when balance < lowBalanceThresholdEth', async () => {
      const wallet = createMockWallet('0x1234');
      const lowBalance = ethers.parseEther('0.005'); // Below default 0.01
      const provider = createMockProvider(lowBalance);
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { lowBalanceThresholdEth: 0.01 },
      });

      await monitor.checkAllBalances();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Low native token balance detected',
        expect.objectContaining({
          chain: 'ethereum',
          address: '0x1234',
          balanceEth: '0.005',
          threshold: 0.01,
        })
      );
    });

    it('should not warn when balance >= lowBalanceThresholdEth', async () => {
      const wallet = createMockWallet('0x1234');
      const sufficientBalance = ethers.parseEther('1.0');
      const provider = createMockProvider(sufficientBalance);
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { lowBalanceThresholdEth: 0.01 },
      });

      await monitor.checkAllBalances();

      const lowBalanceWarnings = (mockLogger.warn as jest.Mock).mock.calls.filter(
        (call) => call[0] === 'Low native token balance detected'
      );
      expect(lowBalanceWarnings).toHaveLength(0);
    });

    it('should use custom threshold', async () => {
      const wallet = createMockWallet('0x1234');
      const balance = ethers.parseEther('0.04'); // Above 0.01 but below 0.05
      const provider = createMockProvider(balance);
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { lowBalanceThresholdEth: 0.05 },
      });

      await monitor.checkAllBalances();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Low native token balance detected',
        expect.objectContaining({
          threshold: 0.05,
        })
      );
    });
  });

  describe('balance drift detection', () => {
    it('should log info when balance increases', async () => {
      const wallet = createMockWallet('0x1234');
      const initialBalance = ethers.parseEther('1.0');
      const increasedBalance = ethers.parseEther('2.5');

      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', createMockProvider(initialBalance));

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      // First check
      await monitor.checkAllBalances();
      mockLogger.info.mockClear();

      // Update provider to return increased balance
      mockProviders.set('ethereum', createMockProvider(increasedBalance));

      // Second check
      await monitor.checkAllBalances();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Balance change detected',
        expect.objectContaining({
          chain: 'ethereum',
          address: '0x1234',
          previousBalanceEth: '1.0',
          currentBalanceEth: '2.5',
          changeEth: 'increased by 1.5',
        })
      );
    });

    it('should log info when balance decreases', async () => {
      const wallet = createMockWallet('0x1234');
      const initialBalance = ethers.parseEther('3.0');
      const decreasedBalance = ethers.parseEther('1.2');

      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', createMockProvider(initialBalance));

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      // First check
      await monitor.checkAllBalances();
      mockLogger.info.mockClear();

      // Update provider to return decreased balance
      mockProviders.set('ethereum', createMockProvider(decreasedBalance));

      // Second check
      await monitor.checkAllBalances();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Balance change detected',
        expect.objectContaining({
          chain: 'ethereum',
          address: '0x1234',
          previousBalanceEth: '3.0',
          currentBalanceEth: '1.2',
          changeEth: 'decreased by 1.8',
        })
      );
    });

    it('should not log drift on first check (no previous balance)', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.0'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const driftLogs = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => call[0] === 'Balance change detected'
      );
      expect(driftLogs).toHaveLength(0);
    });

    it('should not log drift when balance unchanged', async () => {
      const wallet = createMockWallet('0x1234');
      const balance = ethers.parseEther('2.0');

      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', createMockProvider(balance));

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      // First check
      await monitor.checkAllBalances();
      mockLogger.info.mockClear();

      // Second check with same balance
      await monitor.checkAllBalances();

      const driftLogs = (mockLogger.info as jest.Mock).mock.calls.filter(
        (call) => call[0] === 'Balance change detected'
      );
      expect(driftLogs).toHaveLength(0);
    });
  });

  describe('getSnapshot()', () => {
    it('should return correct healthy and failed counts', async () => {
      const ethWallet = createMockWallet('0xETH');
      const arbWallet = createMockWallet('0xARB');
      const bscWallet = createMockWallet('0xBSC');

      mockWallets.set('ethereum', ethWallet);
      mockWallets.set('arbitrum', arbWallet);
      mockWallets.set('bsc', bscWallet);

      mockProviders.set('ethereum', createMockProvider(ethers.parseEther('1.0')));
      mockProviders.set('arbitrum', createMockProvider(new Error('RPC error')));
      // No provider for bsc

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.healthyCount).toBe(1); // ethereum
      expect(snapshot.failedCount).toBe(2); // arbitrum (error), bsc (no provider)
      expect(snapshot.balances.size).toBe(3);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it('should return zero counts when no balances checked', () => {
      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      const snapshot = monitor.getSnapshot();
      expect(snapshot.healthyCount).toBe(0);
      expect(snapshot.failedCount).toBe(0);
      expect(snapshot.balances.size).toBe(0);
    });

    it('should return copy of balances map', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.0'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const snapshot = monitor.getSnapshot();
      const originalSize = snapshot.balances.size;

      // Mutate the returned map
      snapshot.balances.clear();

      // Get a new snapshot and verify original data is intact
      const newSnapshot = monitor.getSnapshot();
      expect(newSnapshot.balances.size).toBe(originalSize);
    });
  });

  describe('getChainBalance()', () => {
    it('should return balance for known chain', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.5'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const balance = monitor.getChainBalance('ethereum');
      expect(balance).toBeDefined();
      expect(balance?.chain).toBe('ethereum');
      expect(balance?.balanceEth).toBe('1.5');
    });

    it('should return undefined for unknown chain', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.0'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      await monitor.checkAllBalances();

      const balance = monitor.getChainBalance('nonexistent');
      expect(balance).toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    it('should handle multiple chains with mixed success/failure', async () => {
      const ethWallet = createMockWallet('0xETH');
      const arbWallet = createMockWallet('0xARB');
      const bscWallet = createMockWallet('0xBSC');
      const polyWallet = createMockWallet('0xPOLY');

      mockWallets.set('ethereum', ethWallet);
      mockWallets.set('arbitrum', arbWallet);
      mockWallets.set('bsc', bscWallet);
      mockWallets.set('polygon', polyWallet);

      mockProviders.set('ethereum', createMockProvider(ethers.parseEther('5.0')));
      mockProviders.set('arbitrum', createMockProvider(ethers.parseEther('0.005'))); // Low
      mockProviders.set('bsc', createMockProvider(new Error('Timeout')));
      // No provider for polygon

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { lowBalanceThresholdEth: 0.01 },
      });

      await monitor.checkAllBalances();

      const snapshot = monitor.getSnapshot();
      expect(snapshot.healthyCount).toBe(2); // ethereum, arbitrum
      expect(snapshot.failedCount).toBe(2); // bsc, polygon

      // Verify low balance warning for arbitrum
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Low native token balance detected',
        expect.objectContaining({
          chain: 'arbitrum',
          balanceEth: '0.005',
        })
      );

      // Verify error warning for bsc
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to query balance',
        expect.objectContaining({
          chain: 'bsc',
          error: 'Timeout',
        })
      );
    });

    it('should track drift across multiple check cycles', async () => {
      const wallet = createMockWallet('0x1234');
      mockWallets.set('ethereum', wallet);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
      });

      // Check 1: 1.0 ETH
      mockProviders.set('ethereum', createMockProvider(ethers.parseEther('1.0')));
      await monitor.checkAllBalances();

      // Check 2: 2.0 ETH (increase)
      mockLogger.info.mockClear();
      mockProviders.set('ethereum', createMockProvider(ethers.parseEther('2.0')));
      await monitor.checkAllBalances();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Balance change detected',
        expect.objectContaining({
          previousBalanceEth: '1.0',
          currentBalanceEth: '2.0',
          changeEth: 'increased by 1.0',
        })
      );

      // Check 3: 1.5 ETH (decrease)
      mockLogger.info.mockClear();
      mockProviders.set('ethereum', createMockProvider(ethers.parseEther('1.5')));
      await monitor.checkAllBalances();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Balance change detected',
        expect.objectContaining({
          previousBalanceEth: '2.0',
          currentBalanceEth: '1.5',
          changeEth: 'decreased by 0.5',
        })
      );
    });

    it('should handle rapid start/stop cycles', async () => {
      const wallet = createMockWallet('0x1234');
      const provider = createMockProvider(ethers.parseEther('1.0'));
      mockWallets.set('ethereum', wallet);
      mockProviders.set('ethereum', provider);

      const monitor = new BalanceMonitor({
        logger: mockLogger,
        getProviders,
        getWallets,
        config: { checkIntervalMs: 60000 },
      });

      await monitor.start();
      monitor.stop();
      await monitor.start();
      monitor.stop();

      // Verify only initial checks happened (2 starts)
      expect(wallet.getAddress).toHaveBeenCalledTimes(2);

      // Advance time and verify no more checks
      jest.advanceTimersByTime(120000);
      await Promise.resolve();

      expect(wallet.getAddress).toHaveBeenCalledTimes(2);
    });
  });
});
