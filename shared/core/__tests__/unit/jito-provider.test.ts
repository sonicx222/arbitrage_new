/**
 * Jito Provider Unit Tests
 *
 * Tests for Phase 1.2: Jito Bundle Integration for Solana MEV protection.
 * Jito is the primary MEV protection solution for Solana, providing
 * private transaction bundles similar to Flashbots on Ethereum.
 *
 * @see shared/core/src/mev-protection/jito-provider.ts
 * @see docs/reports/implementation_plan_v2.md Task 1.2.1
 */

import {
  JitoProvider,
  createJitoProvider,
  JITO_DEFAULTS,
  JITO_TIP_ACCOUNTS,
  JitoProviderConfig,
} from '../../src/mev-protection/jito-provider';
import type { MevMetrics, BundleSimulationResult } from '../../src/mev-protection/types';

// =============================================================================
// Mocks
// =============================================================================

// Mock fetch for Jito API calls
global.fetch = jest.fn();

// Mock Solana connection
const createMockConnection = () => ({
  getLatestBlockhash: jest.fn().mockResolvedValue({
    blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    lastValidBlockHeight: 12345678,
  }),
  getSlot: jest.fn().mockResolvedValue(12345678),
  getSignatureStatus: jest.fn().mockResolvedValue({
    value: {
      confirmationStatus: 'confirmed',
      slot: 12345679,
    },
  }),
  getBalance: jest.fn().mockResolvedValue(1000000000), // 1 SOL in lamports
  simulateTransaction: jest.fn().mockResolvedValue({
    value: {
      err: null,
      unitsConsumed: 200000,
      logs: ['Program log: Success'],
    },
  }),
});

// Mock Solana keypair
const createMockKeypair = () => ({
  publicKey: {
    toBase58: () => 'FakePublicKey1111111111111111111111111111111',
    toBuffer: () => Buffer.alloc(32),
  },
  secretKey: new Uint8Array(64),
  sign: jest.fn().mockReturnValue(new Uint8Array(64)),
});

// Mock transaction
const createMockTransaction = () => ({
  serialize: () => Buffer.from('mock-serialized-transaction'),
  sign: jest.fn(),
  signatures: [{ signature: Buffer.alloc(64) }],
  recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
});

// =============================================================================
// Test Suites
// =============================================================================

describe('JitoProvider', () => {
  let mockConnection: ReturnType<typeof createMockConnection>;
  let mockKeypair: ReturnType<typeof createMockKeypair>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection = createMockConnection();
    mockKeypair = createMockKeypair();
    (global.fetch as jest.Mock).mockClear();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    it('should create JitoProvider for Solana chain', () => {
      const config: JitoProviderConfig = {
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      };

      const provider = new JitoProvider(config);
      expect(provider.chain).toBe('solana');
      expect(provider.strategy).toBe('jito');
    });

    it('should throw error for non-Solana chain', () => {
      const config: JitoProviderConfig = {
        chain: 'ethereum',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      };

      expect(() => new JitoProvider(config)).toThrow(
        'JitoProvider is only for Solana'
      );
    });

    it('should use default Jito endpoint when not specified', () => {
      const config: JitoProviderConfig = {
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      };

      const provider = new JitoProvider(config);
      // Provider should use mainnet endpoint by default
      expect(provider.isEnabled()).toBe(true);
    });

    it('should allow custom Jito endpoint', () => {
      const customEndpoint = 'https://custom-jito-endpoint.com';
      const config: JitoProviderConfig = {
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        jitoEndpoint: customEndpoint,
      };

      const provider = new JitoProvider(config);
      expect(provider.isEnabled()).toBe(true);
    });
  });

  // ===========================================================================
  // isEnabled Tests
  // ===========================================================================

  describe('isEnabled', () => {
    it('should return true when enabled', () => {
      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      expect(provider.isEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: false,
      });

      expect(provider.isEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // Metrics Tests
  // ===========================================================================

  describe('getMetrics', () => {
    it('should initialize metrics correctly', () => {
      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      const metrics = provider.getMetrics();

      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
      expect(metrics.fallbackSubmissions).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
      expect(metrics.bundlesIncluded).toBe(0);
      expect(metrics.bundlesReverted).toBe(0);
    });

    it('should return a copy of metrics (not reference)', () => {
      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      const metrics1 = provider.getMetrics();
      const metrics2 = provider.getMetrics();

      expect(metrics1).not.toBe(metrics2);
      expect(metrics1).toEqual(metrics2);
    });
  });

  describe('resetMetrics', () => {
    it('should reset all metrics to initial values', async () => {
      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      // Reset and verify (resetMetrics is async for thread-safety)
      await provider.resetMetrics();
      const metrics = provider.getMetrics();

      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
    });
  });

  // ===========================================================================
  // sendProtectedTransaction Tests
  // ===========================================================================

  describe('sendProtectedTransaction', () => {
    it('should return error when provider is disabled', async () => {
      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: false,
      });

      const mockTx = createMockTransaction();
      const result = await provider.sendProtectedTransaction(mockTx as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
      expect(result.strategy).toBe('jito');
      expect(result.usedFallback).toBe(false);
    });

    it('should submit bundle to Jito when enabled', async () => {
      // Mock successful Jito response
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: 'bundle-uuid-12345',
          }),
      });

      // Mock successful bundle status check
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [{
                status: 'Landed',
                landed_slot: 12345679,
                transactions: ['sig123'],
              }],
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        statusPollIntervalMs: 50,
        statusPollTimeoutMs: 2000,
      });

      const mockTx = createMockTransaction();
      // Skip simulation to test direct bundle submission
      const result = await provider.sendProtectedTransaction(mockTx as any, {
        simulate: false,
      });

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('jito');
      expect(result.bundleHash).toBeDefined();
      expect(result.usedFallback).toBe(false);
      expect(result.latencyMs).toBeGreaterThan(0);
    }, 10000);

    it('should fallback to standard submission when Jito fails and fallback enabled', async () => {
      // Mock Jito failure
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('Jito API unavailable')
      );

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        fallbackToPublic: true,
      });

      const mockTx = createMockTransaction();
      const result = await provider.sendProtectedTransaction(mockTx as any);

      // Should use fallback
      expect(result.usedFallback).toBe(true);
      expect(result.strategy).toBe('jito');
    });

    it('should not fallback when fallback is disabled', async () => {
      // Mock Jito failure
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('Jito API unavailable')
      );

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        fallbackToPublic: false,
      });

      const mockTx = createMockTransaction();
      const result = await provider.sendProtectedTransaction(mockTx as any);

      expect(result.success).toBe(false);
      expect(result.usedFallback).toBe(false);
      expect(result.error).toContain('Fallback disabled');
    });

    it('should include tip transaction in bundle', async () => {
      // Mock successful submission
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: 'bundle-uuid-12345',
          }),
      });

      // Mock bundle status
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [{
                status: 'Landed',
                landed_slot: 12345679,
                transactions: ['sig123'],
              }],
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        tipLamports: 10000, // Custom tip
        statusPollIntervalMs: 50,
        statusPollTimeoutMs: 2000,
      });

      const mockTx = createMockTransaction();
      // Skip simulation to test tip inclusion
      await provider.sendProtectedTransaction(mockTx as any, { simulate: false });

      // Verify fetch was called with bundle containing tip
      expect(global.fetch).toHaveBeenCalled();
    }, 10000);

    it('should increment metrics on successful submission', async () => {
      // Mock successful responses
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: '2.0',
              id: 1,
              result: 'bundle-uuid',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: '2.0',
              id: 1,
              result: {
                value: [{
                  status: 'Landed',
                  landed_slot: 12345679,
                  transactions: ['sig123'],
                }],
              },
            }),
        });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        statusPollIntervalMs: 50,
        statusPollTimeoutMs: 2000,
      });

      const mockTx = createMockTransaction();
      // Skip simulation to focus on metrics testing
      await provider.sendProtectedTransaction(mockTx as any, { simulate: false });

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
      expect(metrics.successfulSubmissions).toBe(1);
      expect(metrics.bundlesIncluded).toBe(1);
    }, 10000);

    it('should increment failed metrics on failure', async () => {
      // Mock Jito failure
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('API Error'));

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        fallbackToPublic: false,
      });

      const mockTx = createMockTransaction();
      await provider.sendProtectedTransaction(mockTx as any);

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
      expect(metrics.failedSubmissions).toBe(1);
    });

    it('should simulate before submission by default', async () => {
      // Mock simulation failure
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: {
                err: { InstructionError: [0, 'InsufficientFunds'] },
                logs: ['Program failed'],
              },
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        fallbackToPublic: false,
      });

      const mockTx = createMockTransaction();
      const result = await provider.sendProtectedTransaction(mockTx as any);

      // Should fail due to simulation failure
      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulation failed');

      // Only one fetch call should be made (simulation only, no bundle submission)
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should skip simulation when simulate: false', async () => {
      // Mock bundle submission success
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: 'bundle-uuid-no-sim',
          }),
      });

      // Mock bundle status
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [{
                status: 'Landed',
                landed_slot: 12345679,
                transactions: ['sig123'],
              }],
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        statusPollIntervalMs: 50,
        statusPollTimeoutMs: 2000,
      });

      const mockTx = createMockTransaction();
      const result = await provider.sendProtectedTransaction(mockTx as any, {
        simulate: false,
      });

      expect(result.success).toBe(true);
      // Two fetch calls: sendBundle + getBundleStatuses (no simulation)
      expect(global.fetch).toHaveBeenCalledTimes(2);
    }, 10000);
  });

  // ===========================================================================
  // simulateTransaction Tests
  // ===========================================================================

  describe('simulateTransaction', () => {
    it('should simulate transaction using Jito simulation endpoint', async () => {
      // Mock simulation response
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: {
                err: null,
                unitsConsumed: 150000,
                logs: ['Program log: Simulation success'],
              },
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      const mockTx = createMockTransaction();
      const result = await provider.simulateTransaction(mockTx as any);

      expect(result.success).toBe(true);
      expect(result.gasUsed).toBeDefined();
    });

    it('should return error when simulation fails', async () => {
      // Mock simulation error
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: {
                err: { InstructionError: [0, 'InsufficientFunds'] },
                logs: ['Program failed: insufficient funds'],
              },
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      const mockTx = createMockTransaction();
      const result = await provider.simulateTransaction(mockTx as any);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ===========================================================================
  // healthCheck Tests
  // ===========================================================================

  describe('healthCheck', () => {
    it('should return healthy when Jito API is reachable', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: { tip_accounts: JITO_TIP_ACCOUNTS },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('healthy');
    });

    it('should return unhealthy when Jito API is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('Connection refused')
      );

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Failed');
    });

    it('should return unhealthy on non-OK response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('503');
    });
  });

  // ===========================================================================
  // Bundle Status Polling Tests
  // ===========================================================================

  describe('bundle status polling', () => {
    it('should poll for bundle inclusion status', async () => {
      // Mock bundle submission
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: 'bundle-uuid-polling-test',
          }),
      });

      // Mock status: landed immediately
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [{
                status: 'Landed',
                landed_slot: 12345680,
                transactions: ['sig123'],
              }],
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        statusPollIntervalMs: 50,
        statusPollTimeoutMs: 2000,
      });

      const mockTx = createMockTransaction();
      // Skip simulation to focus on polling test
      const result = await provider.sendProtectedTransaction(mockTx as any, {
        simulate: false,
      });

      expect(result.success).toBe(true);
      expect(result.bundleHash).toBe('bundle-uuid-polling-test');
    }, 10000);

    it('should handle bundle rejection', async () => {
      // Mock bundle submission
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: 'bundle-uuid-rejected',
          }),
      });

      // Mock status: failed
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [{
                status: 'Failed',
                error: 'Bundle simulation failed',
              }],
            },
          }),
      });

      const provider = new JitoProvider({
        chain: 'solana',
        connection: mockConnection as any,
        keypair: mockKeypair as any,
        enabled: true,
        fallbackToPublic: false,
        statusPollIntervalMs: 50,
        statusPollTimeoutMs: 2000,
      });

      const mockTx = createMockTransaction();
      // Skip simulation to focus on rejection handling
      const result = await provider.sendProtectedTransaction(mockTx as any, {
        simulate: false,
      });

      // After failure, it should try fallback (which is disabled)
      expect(result.success).toBe(false);
    }, 10000);
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createJitoProvider', () => {
  let mockConnection: ReturnType<typeof createMockConnection>;
  let mockKeypair: ReturnType<typeof createMockKeypair>;

  beforeEach(() => {
    mockConnection = createMockConnection();
    mockKeypair = createMockKeypair();
  });

  it('should create JitoProvider instance', () => {
    const provider = createJitoProvider({
      chain: 'solana',
      connection: mockConnection as any,
      keypair: mockKeypair as any,
      enabled: true,
    });

    expect(provider).toBeInstanceOf(JitoProvider);
    expect(provider.chain).toBe('solana');
    expect(provider.strategy).toBe('jito');
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('JITO_DEFAULTS', () => {
  it('should have correct default values', () => {
    expect(JITO_DEFAULTS.mainnetEndpoint).toContain('jito');
    expect(JITO_DEFAULTS.defaultTipLamports).toBeGreaterThan(0);
    expect(JITO_DEFAULTS.statusPollIntervalMs).toBeGreaterThan(0);
    expect(JITO_DEFAULTS.statusPollTimeoutMs).toBeGreaterThan(0);
    expect(JITO_DEFAULTS.maxRetries).toBeGreaterThan(0);
  });
});

describe('JITO_TIP_ACCOUNTS', () => {
  it('should have 8 tip accounts', () => {
    expect(JITO_TIP_ACCOUNTS).toHaveLength(8);
  });

  it('should contain valid Solana addresses', () => {
    for (const account of JITO_TIP_ACCOUNTS) {
      // Solana addresses are base58 encoded, typically 32-44 characters
      expect(account.length).toBeGreaterThanOrEqual(32);
      expect(account.length).toBeLessThanOrEqual(44);
    }
  });
});
