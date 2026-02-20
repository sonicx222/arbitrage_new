/**
 * MevProtectionService Unit Tests
 *
 * Tests MEV protection eligibility, transaction protection, and provider fallback chain.
 * Covers: eligibility criteria, EIP-1559 formatting, priority fee capping,
 * provider fallback chain, and error handling.
 *
 * @see services/execution-engine/src/services/mev-protection-service.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import { createMockLogger, createMockPerfLogger } from '@arbitrage/test-utils';
import {
  MevProtectionService,
  type MevEligibilityResult,
} from '../../../src/services/mev-protection-service';
import { GasPriceOptimizer } from '../../../src/services/gas-price-optimizer';
import type { StrategyContext } from '../../../src/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockMevProvider(enabled = true) {
  return {
    isEnabled: jest.fn<() => boolean>().mockReturnValue(enabled),
    sendProtectedTransaction: jest.fn<() => Promise<any>>().mockResolvedValue({ success: true }),
    getName: jest.fn<() => string>().mockReturnValue('flashbots'),
  };
}

function createMockMevProviderFactory(providers: Record<string, ReturnType<typeof createMockMevProvider>> = {}) {
  return {
    getProvider: jest.fn<(chain: string) => any>().mockImplementation(
      (chain: string) => providers[chain] ?? null
    ),
    getProviderFallbackChain: jest.fn<(opts: any) => any[]>().mockImplementation(
      () => Object.values(providers)
    ),
  };
}

function createMockStrategyContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const mockLogger = createMockLogger();
  const mockPerfLogger = createMockPerfLogger();
  return {
    logger: mockLogger as any,
    perfLogger: mockPerfLogger as any,
    providers: new Map(),
    wallets: new Map(),
    providerHealth: new Map(),
    nonceManager: null,
    mevProviderFactory: null,
    bridgeRouterFactory: null,
    stateManager: {
      getState: jest.fn<() => string>().mockReturnValue('idle'),
      executeStart: jest.fn<(fn: () => Promise<void>) => Promise<void>>().mockImplementation((fn) => fn()),
      executeStop: jest.fn<(fn: () => Promise<void>) => Promise<void>>().mockImplementation((fn) => fn()),
      isRunning: jest.fn<() => boolean>().mockReturnValue(false),
    } as any,
    gasBaselines: new Map(),
    stats: {} as any,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('MevProtectionService', () => {
  let service: MevProtectionService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockGasPriceOptimizer: GasPriceOptimizer;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGasPriceOptimizer = new GasPriceOptimizer(mockLogger as any);
    service = new MevProtectionService(mockLogger as any, mockGasPriceOptimizer);
  });

  describe('constructor', () => {
    it('should create with default config (3 gwei max priority fee)', () => {
      expect(service.getMaxPriorityFeeGwei()).toBe(3);
      expect(service.getMaxPriorityFeeWei()).toBe(ethers.parseUnits('3', 'gwei'));
    });

    it('should accept custom max priority fee', () => {
      const customService = new MevProtectionService(
        mockLogger as any,
        mockGasPriceOptimizer,
        { maxPriorityFeeGwei: 5 }
      );

      expect(customService.getMaxPriorityFeeGwei()).toBe(5);
      expect(customService.getMaxPriorityFeeWei()).toBe(ethers.parseUnits('5', 'gwei'));
    });
  });

  describe('checkEligibility', () => {
    it('should return eligible when all criteria met', () => {
      const mevProvider = createMockMevProvider(true);
      const ctx = createMockStrategyContext({
        mevProviderFactory: createMockMevProviderFactory({ ethereum: mevProvider }) as any,
      });

      const result = service.checkEligibility('ethereum', ctx, 100);

      expect(result.shouldUseMev).toBe(true);
      expect(result.mevProvider).not.toBeUndefined();
    });

    it('should return not eligible when no provider factory', () => {
      const ctx = createMockStrategyContext({ mevProviderFactory: null });

      const result = service.checkEligibility('ethereum', ctx, 100);

      expect(result.shouldUseMev).toBe(false);
      expect(result.mevProvider).toBeUndefined();
    });

    it('should return not eligible when provider is disabled', () => {
      const disabledProvider = createMockMevProvider(false);
      const ctx = createMockStrategyContext({
        mevProviderFactory: createMockMevProviderFactory({ ethereum: disabledProvider }) as any,
      });

      const result = service.checkEligibility('ethereum', ctx, 100);

      expect(result.shouldUseMev).toBe(false);
    });

    it('should return not eligible when no provider for chain', () => {
      const ctx = createMockStrategyContext({
        mevProviderFactory: createMockMevProviderFactory({}) as any,
      });

      const result = service.checkEligibility('solana', ctx, 100);

      expect(result.shouldUseMev).toBe(false);
    });

    it('should include chain settings in result', () => {
      const ctx = createMockStrategyContext({
        mevProviderFactory: createMockMevProviderFactory({}) as any,
      });

      const result = service.checkEligibility('ethereum', ctx, 100);

      // chainSettings may or may not be defined depending on MEV_CONFIG
      expect(result).toHaveProperty('chainSettings');
    });

    it('should handle undefined expectedProfit', () => {
      const mevProvider = createMockMevProvider(true);
      const ctx = createMockStrategyContext({
        mevProviderFactory: createMockMevProviderFactory({ ethereum: mevProvider }) as any,
      });

      // Should not throw
      const result = service.checkEligibility('ethereum', ctx);
      expect(result).toMatchObject({ shouldUseMev: expect.any(Boolean) });
    });
  });

  describe('getProviderFallbackChain', () => {
    it('should return empty chain when no factory', () => {
      const ctx = createMockStrategyContext({ mevProviderFactory: null });

      const result = service.getProviderFallbackChain('ethereum', ctx, 100);

      expect(result.hasProtection).toBe(false);
      expect(result.providers).toHaveLength(0);
    });

    it('should return providers when available', () => {
      const mevProvider = createMockMevProvider(true);
      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({}),
      } as unknown as ethers.JsonRpcProvider;

      const ctx = createMockStrategyContext({
        mevProviderFactory: createMockMevProviderFactory({ ethereum: mevProvider }) as any,
        providers: new Map([['ethereum', mockProvider]]),
        wallets: new Map([['ethereum', {} as ethers.Wallet]]),
      });

      const result = service.getProviderFallbackChain('ethereum', ctx, 100);

      expect(result.hasProtection).toBe(true);
      expect(result.providers.length).toBeGreaterThan(0);
    });

    it('should fall back to single provider check when no wallet', () => {
      const mevProvider = createMockMevProvider(true);
      const ctx = createMockStrategyContext({
        mevProviderFactory: createMockMevProviderFactory({ ethereum: mevProvider }) as any,
        providers: new Map([['ethereum', {} as ethers.JsonRpcProvider]]),
        wallets: new Map(), // No wallet
      });

      const result = service.getProviderFallbackChain('ethereum', ctx, 100);

      expect(result).toMatchObject({ hasProtection: expect.any(Boolean) });
    });
  });

  describe('applyProtection', () => {
    it('should use EIP-1559 format when available', async () => {
      const maxFee = ethers.parseUnits('100', 'gwei');
      const priorityFee = ethers.parseUnits('2', 'gwei');

      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: priorityFee,
        }),
      } as unknown as ethers.JsonRpcProvider;

      const ctx = createMockStrategyContext({
        providers: new Map([['ethereum', mockProvider]]),
      });

      const tx: ethers.TransactionRequest = { to: '0x1234' };
      const gasBaselines = new Map();

      const result = await service.applyProtection(tx, 'ethereum', ctx, gasBaselines);

      expect(result.type).toBe(2);
      expect(result.maxFeePerGas).toBe(maxFee);
      expect(result.maxPriorityFeePerGas).toBe(priorityFee); // 2 gwei < 3 gwei cap
      expect(result.gasPrice).toBeUndefined();
    });

    it('should cap priority fee at maxPriorityFeeWei', async () => {
      const maxFee = ethers.parseUnits('100', 'gwei');
      const highPriorityFee = ethers.parseUnits('10', 'gwei'); // > 3 gwei cap

      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: highPriorityFee,
        }),
      } as unknown as ethers.JsonRpcProvider;

      const ctx = createMockStrategyContext({
        providers: new Map([['ethereum', mockProvider]]),
      });

      const tx: ethers.TransactionRequest = { to: '0x1234' };
      const gasBaselines = new Map();

      const result = await service.applyProtection(tx, 'ethereum', ctx, gasBaselines);

      // Priority fee should be capped at 3 gwei (default)
      expect(result.maxPriorityFeePerGas).toBe(ethers.parseUnits('3', 'gwei'));
    });

    it('should fall back to gasPrice when no EIP-1559 data', async () => {
      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
          gasPrice: ethers.parseUnits('50', 'gwei'),
        }),
      } as unknown as ethers.JsonRpcProvider;

      const ctx = createMockStrategyContext({
        providers: new Map([['ethereum', mockProvider]]),
      });

      const tx: ethers.TransactionRequest = { to: '0x1234' };
      const gasBaselines = new Map();

      const result = await service.applyProtection(tx, 'ethereum', ctx, gasBaselines);

      expect(typeof result.gasPrice).toBe('bigint');
    });

    it('should use fallback gas price when no provider for chain', async () => {
      const ctx = createMockStrategyContext({
        providers: new Map(), // No provider for ethereum
      });

      const tx: ethers.TransactionRequest = { to: '0x1234' };
      const gasBaselines = new Map();

      const result = await service.applyProtection(tx, 'ethereum', ctx, gasBaselines);

      expect(typeof result.gasPrice).toBe('bigint');
    });

    it('should fall back to basic gas price on fee data error', async () => {
      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('RPC error')),
      } as unknown as ethers.JsonRpcProvider;

      const ctx = createMockStrategyContext({
        providers: new Map([['ethereum', mockProvider]]),
      });

      const tx: ethers.TransactionRequest = { to: '0x1234' };
      const gasBaselines = new Map();

      const result = await service.applyProtection(tx, 'ethereum', ctx, gasBaselines);

      expect(typeof result.gasPrice).toBe('bigint');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to apply full MEV protection'),
        expect.any(Object)
      );
    });
  });

  describe('getMaxPriorityFeeWei / getMaxPriorityFeeGwei', () => {
    it('should return consistent values', () => {
      const gwei = service.getMaxPriorityFeeGwei();
      const wei = service.getMaxPriorityFeeWei();

      expect(wei).toBe(ethers.parseUnits(gwei.toString(), 'gwei'));
    });
  });
});

// P2 FIX #13: Removed tests for deprecated checkMevEligibility() standalone function.
// The function was removed — use MevProtectionService.checkEligibility() directly.
