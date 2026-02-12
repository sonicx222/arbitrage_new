/**
 * Unit Tests for HeliusSimulationProvider
 *
 * Tests Solana simulation functionality via Helius API.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { HeliusSimulationProvider, createHeliusProvider } from './helius-provider';
import type { SolanaSimulationRequest, SolanaSimulationResult, HeliusProviderConfig } from './helius-provider';
import type { SimulationRequest } from './types';

// Mock fetch globally
const mockFetch = jest.fn<(...args: any[]) => Promise<any>>();
global.fetch = mockFetch as unknown as typeof fetch;

describe('HeliusSimulationProvider', () => {
  let provider: HeliusSimulationProvider;
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const defaultConfig: HeliusProviderConfig = {
    type: 'helius',
    chain: 'solana',
    provider: null as any, // Not used for Solana
    enabled: true,
    heliusApiKey: 'test-api-key',
    fallbackRpcUrl: 'https://api.mainnet-beta.solana.com',
    logger: mockLogger,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    provider = new HeliusSimulationProvider(defaultConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with Helius API key', () => {
      const config: HeliusProviderConfig = {
        ...defaultConfig,
        heliusApiKey: 'my-api-key',
      };

      const p = new HeliusSimulationProvider(config);

      expect(p.type).toBe('helius');
      expect(p.chain).toBe('solana');
      expect(p.isEnabled()).toBe(true);
    });

    it('should initialize without Helius API key (fallback only)', () => {
      const config: HeliusProviderConfig = {
        ...defaultConfig,
        heliusApiKey: undefined,
      };

      const p = new HeliusSimulationProvider(config);

      expect(p.isEnabled()).toBe(true);
      // Will use fallback RPC only
    });

    it('should set default commitment level', () => {
      const config: HeliusProviderConfig = {
        ...defaultConfig,
        defaultCommitment: 'finalized',
      };

      const p = new HeliusSimulationProvider(config);

      expect(p.isEnabled()).toBe(true);
    });
  });

  describe('simulate', () => {
    const mockRequest = {
      chain: 'solana',
      transaction: 'base64-encoded-transaction-data',
      commitment: 'confirmed',
    } as unknown as SimulationRequest;

    it('should simulate transaction successfully via Helius', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 123456 },
            value: {
              err: null,
              logs: ['Program log: Success'],
              accounts: null,
              unitsConsumed: 50000,
            },
          },
        }),
      });

      const result = await provider.simulate(mockRequest) as SolanaSimulationResult;

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(false);
      expect(result.provider).toBe('helius');
      expect(result.programLogs).toEqual(['Program log: Success']);
      expect(result.computeUnitsConsumed).toBe(50000);
    });

    it('should detect transaction that would revert', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 123456 },
            value: {
              err: { InstructionError: [0, { Custom: 6000 }] },
              logs: ['Program log: Error: insufficient funds'],
              accounts: null,
              unitsConsumed: 10000,
            },
          },
        }),
      });

      const result = await provider.simulate(mockRequest);

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toContain('Custom error 6000');
    });

    it('should reject non-Solana chains', async () => {
      const evmRequest = {
        chain: 'ethereum',
        transaction: {} as any,
      } as SimulationRequest;

      const result = await provider.simulate(evmRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('only supports Solana');
    });

    it('should fallback to native RPC when Helius fails', async () => {
      // First call fails (Helius)
      mockFetch.mockRejectedValueOnce(new Error('Helius unavailable'));

      // Second call succeeds (fallback)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 123456 },
            value: {
              err: null,
              logs: ['Success via fallback'],
              accounts: null,
            },
          },
        }),
      });

      const result = await provider.simulate(mockRequest) as SolanaSimulationResult;

      expect(result.success).toBe(true);
      expect(result.programLogs).toEqual(['Success via fallback']);
      expect(provider.getFallbackUsedCount()).toBe(1);
    });

    it('should return error when both Helius and fallback fail', async () => {
      const configNoFallback: HeliusProviderConfig = {
        ...defaultConfig,
        fallbackRpcUrl: undefined,
      };
      const providerNoFallback = new HeliusSimulationProvider(configNoFallback);

      // Helius fails
      mockFetch.mockRejectedValueOnce(new Error('Helius unavailable'));

      const result = await providerNoFallback.simulate(mockRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No Solana simulation provider available');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy when Helius is reachable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'ok' }),
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('Helius: healthy');
    });

    it('should check fallback RPC health too', async () => {
      // Helius check
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'ok' }),
      });

      // Fallback check
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'ok' }),
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('Helius: healthy');
      expect(health.message).toContain('Fallback RPC: healthy');
    });

    it('should return healthy if at least one provider works', async () => {
      // Helius fails
      mockFetch.mockRejectedValueOnce(new Error('Helius down'));

      // Fallback succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: 'ok' }),
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('Helius: unreachable');
      expect(health.message).toContain('Fallback RPC: healthy');
    });
  });

  describe('rate limiting', () => {
    it('should track remaining credits', () => {
      const initialCredits = provider.getRemainingCredits();
      expect(initialCredits).toBe(100_000); // Free tier limit
    });

    it('should include rate limit info in health', () => {
      const health = provider.getHealth();

      expect(health.requestsUsed).toBeDefined();
      expect(health.requestLimit).toBe(100_000);
    });
  });

  describe('error handling', () => {
    it('should parse InstructionError correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 123456 },
            value: {
              err: { InstructionError: [2, 'InsufficientFunds'] },
              logs: null,
              accounts: null,
            },
          },
        }),
      });

      const result = await provider.simulate({
        chain: 'solana',
        transaction: 'test',
      } as unknown as SimulationRequest);

      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toContain('Instruction 2');
      expect(result.revertReason).toContain('InsufficientFunds');
    });

    it('should handle RPC error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32602,
            message: 'Invalid transaction encoding',
          },
        }),
      });

      const result = await provider.simulate({
        chain: 'solana',
        transaction: 'invalid',
      } as unknown as SimulationRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid transaction encoding');
    });

    it('should handle HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      // Falls back to fallback RPC
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 123456 },
            value: { err: null, logs: [], accounts: null },
          },
        }),
      });

      const result = await provider.simulate({
        chain: 'solana',
        transaction: 'test',
      } as unknown as SimulationRequest);

      expect(result.success).toBe(true);
      expect(provider.getFallbackUsedCount()).toBe(1);
    });
  });

  describe('account changes', () => {
    it('should parse account changes from simulation', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            context: { slot: 123456 },
            value: {
              err: null,
              logs: ['Success'],
              accounts: [
                {
                  pubkey: 'ABC123',
                  data: ['base64data', 'base64'],
                  owner: 'TokenProgram',
                  lamports: 1000000,
                  executable: false,
                  rentEpoch: 100,
                },
              ],
              unitsConsumed: 30000,
            },
          },
        }),
      });

      const request = {
        chain: 'solana',
        transaction: 'test',
        accountsToReturn: ['ABC123'],
      } as unknown as SimulationRequest;

      const result = await provider.simulate(request) as SolanaSimulationResult;

      expect(result.success).toBe(true);
      expect(result.accountChanges).toHaveLength(1);
      expect(result.accountChanges![0].pubkey).toBe('ABC123');
      expect(result.accountChanges![0].lamports).toBe(1000000);
    });
  });
});

describe('createHeliusProvider', () => {
  it('should create provider instance', () => {
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    const provider = createHeliusProvider({
      type: 'helius',
      chain: 'solana',
      provider: null as any,
      enabled: true,
      heliusApiKey: 'test-key',
      logger: mockLogger,
    });

    expect(provider).toBeInstanceOf(HeliusSimulationProvider);
    expect(provider.type).toBe('helius');
    expect(provider.chain).toBe('solana');
  });
});
