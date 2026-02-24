/**
 * Tests for Backrun Bundle Builder
 *
 * @see Phase 2 Item #23: MEV-Share backrun filling
 */

import { ethers } from 'ethers';
import {
  BackrunBundleBuilder,
} from '../../../src/mev-protection/backrun-bundle-builder';
import type {
  BackrunBundleBuilderConfig,
} from '../../../src/mev-protection/backrun-bundle-builder';
import type { BackrunOpportunity } from '../../../src/mev-protection/mev-share-event-listener';

// =============================================================================
// Mocks
// =============================================================================

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

function createMockProvider() {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(18000000),
    getTransactionCount: jest.fn().mockResolvedValue(42),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
    }),
    estimateGas: jest.fn().mockResolvedValue(200000n),
  } as any;
}

function createMockWallet(): ethers.Wallet {
  // createRandom() returns HDNodeWallet; construct a Wallet from private key for type compatibility
  const random = ethers.Wallet.createRandom();
  return new ethers.Wallet(random.privateKey);
}

function createTestOpportunity(): BackrunOpportunity {
  return {
    txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    event: {
      hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      txs: [{
        to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        functionSelector: '0x38ed1739',
      }],
    },
    routerAddress: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
    functionSelector: '0x38ed1739',
    detectedAt: Date.now(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('BackrunBundleBuilder', () => {
  let mockWallet: ethers.Wallet;
  let mockProvider: any;
  let builder: BackrunBundleBuilder;

  beforeEach(() => {
    mockWallet = createMockWallet();
    mockProvider = createMockProvider();

    builder = new BackrunBundleBuilder({
      wallet: mockWallet,
      provider: mockProvider,
      logger: createMockLogger(),
      refundPercent: 90,
      maxBlockRange: 10,
    });
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const builder = new BackrunBundleBuilder({
        wallet: mockWallet,
        provider: mockProvider,
        logger: createMockLogger(),
      });
      expect(builder).toBeInstanceOf(BackrunBundleBuilder);
    });

    it('should generate random auth signer when no flashbotsAuthKey provided', () => {
      const builder = new BackrunBundleBuilder({
        wallet: mockWallet,
        provider: mockProvider,
        logger: createMockLogger(),
      });
      expect(builder).toBeDefined();
    });

    it('should use provided flashbotsAuthKey', () => {
      const authKey = ethers.Wallet.createRandom().privateKey;
      const builder = new BackrunBundleBuilder({
        wallet: mockWallet,
        provider: mockProvider,
        flashbotsAuthKey: authKey,
        logger: createMockLogger(),
      });
      expect(builder).toBeDefined();
    });
  });

  describe('buildBackrunBundle', () => {
    it('should build a valid backrun bundle', async () => {
      const opportunity = createTestOpportunity();
      const backrunTx: ethers.TransactionRequest = {
        to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        data: '0x38ed1739',
        value: 0n,
      };

      const bundle = await builder.buildBackrunBundle(opportunity, backrunTx);

      expect(bundle.targetTxHash).toBe(opportunity.txHash);
      expect(bundle.signedBackrunTx).toBeDefined();
      expect(bundle.signedBackrunTx).toMatch(/^0x/);
      expect(bundle.targetBlock).toBe(18000001); // currentBlock + 1
      expect(bundle.maxBlock).toBe(18000011); // targetBlock + maxBlockRange
      expect(bundle.payload).toBeDefined();
    });

    it('should include target tx hash reference in bundle payload', async () => {
      const opportunity = createTestOpportunity();
      const backrunTx: ethers.TransactionRequest = {
        to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        data: '0x38ed1739',
        value: 0n,
      };

      const bundle = await builder.buildBackrunBundle(opportunity, backrunTx);
      const body = bundle.payload.body as Array<Record<string, unknown>>;

      // First element should reference the target tx
      expect(body[0]).toEqual({ hash: opportunity.txHash });
      // Second element should be our signed tx
      expect(body[1]).toHaveProperty('tx');
      expect(body[1]).toHaveProperty('canRevert', false);
    });

    it('should include refund config in bundle payload', async () => {
      const opportunity = createTestOpportunity();
      const backrunTx: ethers.TransactionRequest = {
        to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        data: '0x38ed1739',
        value: 0n,
      };

      const bundle = await builder.buildBackrunBundle(opportunity, backrunTx);
      const refundConfig = bundle.payload.refundConfig as Array<Record<string, unknown>>;

      expect(refundConfig).toBeDefined();
      expect(refundConfig[0].address).toBe(mockWallet.address);
      expect(refundConfig[0].percent).toBe(90);
    });

    it('should include inclusion block range in payload', async () => {
      const opportunity = createTestOpportunity();
      const backrunTx: ethers.TransactionRequest = {
        to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        data: '0x38ed1739',
        value: 0n,
      };

      const bundle = await builder.buildBackrunBundle(opportunity, backrunTx);
      const inclusion = bundle.payload.inclusion as Record<string, string>;

      expect(inclusion.block).toBe(`0x${(18000001).toString(16)}`);
      expect(inclusion.maxBlock).toBe(`0x${(18000011).toString(16)}`);
    });

    it('should use provided gas settings when available', async () => {
      const opportunity = createTestOpportunity();
      const backrunTx: ethers.TransactionRequest = {
        to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        data: '0x38ed1739',
        value: 0n,
        nonce: 100,
        maxFeePerGas: ethers.parseUnits('50', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('5', 'gwei'),
        gasLimit: 500000n,
      };

      const bundle = await builder.buildBackrunBundle(opportunity, backrunTx);
      expect(bundle.signedBackrunTx).toBeDefined();
    });

    it('should increment bundlesBuilt metric', async () => {
      const opportunity = createTestOpportunity();
      const backrunTx: ethers.TransactionRequest = {
        to: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
        data: '0x38ed1739',
        value: 0n,
      };

      expect(builder.getMetrics().bundlesBuilt).toBe(0);
      await builder.buildBackrunBundle(opportunity, backrunTx);
      expect(builder.getMetrics().bundlesBuilt).toBe(1);
    });
  });

  describe('getMetrics', () => {
    it('should return initial zero metrics', () => {
      const metrics = builder.getMetrics();
      expect(metrics.bundlesBuilt).toBe(0);
      expect(metrics.bundlesSubmitted).toBe(0);
      expect(metrics.bundlesFailed).toBe(0);
      expect(metrics.totalLatencyMs).toBe(0);
    });

    it('should return a copy (not reference)', () => {
      const m1 = builder.getMetrics();
      const m2 = builder.getMetrics();
      expect(m1).not.toBe(m2);
      expect(m1).toEqual(m2);
    });
  });

  describe('submitBundle', () => {
    it('should handle network errors gracefully', async () => {
      // Mock global fetch to simulate network error
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      try {
        const bundle = {
          targetTxHash: '0xabc',
          signedBackrunTx: '0x123',
          targetBlock: 18000001,
          maxBlock: 18000011,
          payload: { test: true },
        };

        const result = await builder.submitBundle(bundle);

        expect(result.success).toBe(false);
        // Fix #40: Network errors are retryable, so after retry + all relays exhausted,
        // the final error message indicates all relays failed.
        expect(result.error).toContain('failed on all relays');
        expect(result.targetTxHash).toBe('0xabc');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should handle relay error responses', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          error: { message: 'Bundle rejected' },
        }),
      });

      try {
        const bundle = {
          targetTxHash: '0xabc',
          signedBackrunTx: '0x123',
          targetBlock: 18000001,
          maxBlock: 18000011,
          payload: { test: true },
        };

        const result = await builder.submitBundle(bundle);

        expect(result.success).toBe(false);
        // Fix #40: Non-retryable relay errors result in all relays exhausted
        expect(result.error).toContain('failed on all relays');
        expect(builder.getMetrics().bundlesFailed).toBe(1);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should handle successful submission', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          result: { bundleHash: '0xbundlehash123' },
        }),
      });

      try {
        const bundle = {
          targetTxHash: '0xabc',
          signedBackrunTx: '0x123',
          targetBlock: 18000001,
          maxBlock: 18000011,
          payload: { test: true },
        };

        const result = await builder.submitBundle(bundle);

        expect(result.success).toBe(true);
        expect(result.bundleHash).toBe('0xbundlehash123');
        expect(result.targetTxHash).toBe('0xabc');
        expect(builder.getMetrics().bundlesSubmitted).toBe(1);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
