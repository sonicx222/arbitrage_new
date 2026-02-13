/**
 * Opportunity Factory Tests
 *
 * Tests for creating arbitrage opportunities with consistent IDs, timestamps,
 * and confidence scores across all opportunity types.
 *
 * @see services/partition-solana/src/opportunity-factory.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  OpportunityFactory,
  IdGenerator,
  CONFIDENCE_SCORES,
  createOpportunityFactory,
} from '../../src/opportunity-factory';
import type {
  InternalPoolInfo,
  TriangularPath,
  CrossChainPriceComparison,
} from '../../src/types';
import { createMockInternalPool } from '../helpers/test-fixtures';

// =============================================================================
// Helpers
// =============================================================================

const createMockPool = createMockInternalPool;

function createMockTriangularPath(overrides: Partial<TriangularPath> = {}): TriangularPath {
  return {
    steps: [
      { token: 'USDC', pool: 'pool-1', dex: 'raydium', price: 100, fee: 0.0025 },
      { token: 'JUP', pool: 'pool-2', dex: 'orca', price: 0.05, fee: 0.003 },
      { token: 'SOL', pool: 'pool-3', dex: 'raydium', price: 0.21, fee: 0.0025 },
    ],
    inputToken: 'SOL',
    outputToken: 'SOL',
    profitPercentage: 2.5,
    estimatedOutput: 1.025,
    ...overrides,
  };
}

function createMockComparison(overrides: Partial<CrossChainPriceComparison> = {}): CrossChainPriceComparison {
  return {
    token: 'SOL',
    quoteToken: 'USDC',
    solanaPrice: 100,
    solanaDex: 'raydium',
    solanaPoolAddress: 'sol-pool-1',
    evmChain: 'ethereum',
    evmDex: 'uniswap',
    evmPrice: 110,
    evmPairKey: 'evm-pair-1',
    priceDifferencePercent: 10,
    timestamp: Date.now(),
    solanaFee: 25,
    evmFee: 30,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('IdGenerator', () => {
  describe('constructor', () => {
    it('should create with auto-generated prefix', () => {
      const gen = new IdGenerator();
      expect(gen.getCounter()).toBe(0);
    });

    it('should create with custom prefix', () => {
      const gen = new IdGenerator('custom-prefix');
      const id = gen.next('arb');
      expect(id).toContain('custom-prefix');
    });
  });

  describe('next', () => {
    it('should generate unique IDs', () => {
      const gen = new IdGenerator('test');
      const id1 = gen.next('arb');
      const id2 = gen.next('arb');

      expect(id1).not.toBe(id2);
    });

    it('should include type in ID', () => {
      const gen = new IdGenerator('test');

      expect(gen.next('arb')).toContain('sol-arb-');
      expect(gen.next('tri')).toContain('sol-tri-');
      expect(gen.next('xchain')).toContain('sol-xchain-');
    });

    it('should increment counter', () => {
      const gen = new IdGenerator('test');

      gen.next('arb');
      expect(gen.getCounter()).toBe(1);

      gen.next('arb');
      expect(gen.getCounter()).toBe(2);
    });

    it('should include prefix in ID', () => {
      const gen = new IdGenerator('my-prefix');
      const id = gen.next('arb');

      expect(id).toContain('my-prefix');
    });
  });

  describe('getCounter', () => {
    it('should start at 0', () => {
      const gen = new IdGenerator();
      expect(gen.getCounter()).toBe(0);
    });

    it('should reflect total IDs generated', () => {
      const gen = new IdGenerator();
      gen.next('a');
      gen.next('b');
      gen.next('c');
      expect(gen.getCounter()).toBe(3);
    });
  });
});

describe('CONFIDENCE_SCORES', () => {
  it('should have INTRA_SOLANA at 0.85', () => {
    expect(CONFIDENCE_SCORES.INTRA_SOLANA).toBe(0.85);
  });

  it('should have TRIANGULAR at 0.75', () => {
    expect(CONFIDENCE_SCORES.TRIANGULAR).toBe(0.75);
  });

  it('should have CROSS_CHAIN at 0.6', () => {
    expect(CONFIDENCE_SCORES.CROSS_CHAIN).toBe(0.6);
  });

  it('should have INTRA > TRIANGULAR > CROSS_CHAIN confidence', () => {
    expect(CONFIDENCE_SCORES.INTRA_SOLANA).toBeGreaterThan(CONFIDENCE_SCORES.TRIANGULAR);
    expect(CONFIDENCE_SCORES.TRIANGULAR).toBeGreaterThan(CONFIDENCE_SCORES.CROSS_CHAIN);
  });
});

describe('OpportunityFactory', () => {
  let factory: OpportunityFactory;
  const chainId = 'solana';
  const expiryMs = 1000;

  beforeEach(() => {
    factory = new OpportunityFactory(chainId, expiryMs);
  });

  describe('constructor', () => {
    it('should store chain ID', () => {
      expect(factory.getChainId()).toBe('solana');
    });

    it('should store expiry time', () => {
      expect(factory.getExpiryMs()).toBe(1000);
    });
  });

  describe('createIntraSolana', () => {
    it('should create opportunity with correct type', () => {
      const buyPool = createMockPool({ address: 'buy-pool', dex: 'raydium', price: 100 });
      const sellPool = createMockPool({ address: 'sell-pool', dex: 'orca', price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp.type).toBe('intra-solana');
      expect(opp.chain).toBe('solana');
      expect(opp.status).toBe('pending');
    });

    it('should set buy and sell DEX correctly', () => {
      const buyPool = createMockPool({ dex: 'raydium', price: 100 });
      const sellPool = createMockPool({ dex: 'orca', price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp.buyDex).toBe('raydium');
      expect(opp.sellDex).toBe('orca');
    });

    it('should calculate profitPercentage from netProfit', () => {
      const buyPool = createMockPool({ price: 100 });
      const sellPool = createMockPool({ price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      // netProfit * 100 = 5%
      expect(opp.profitPercentage).toBeCloseTo(5, 4);
    });

    it('should calculate netProfitAfterGas', () => {
      const buyPool = createMockPool({ price: 100 });
      const sellPool = createMockPool({ price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp.netProfitAfterGas).toBeCloseTo(0.049, 4);
    });

    it('should set confidence to INTRA_SOLANA level', () => {
      const buyPool = createMockPool({ price: 100 });
      const sellPool = createMockPool({ price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp.confidence).toBe(CONFIDENCE_SCORES.INTRA_SOLANA);
    });

    it('should set timestamp and expiresAt', () => {
      const before = Date.now();
      const buyPool = createMockPool({ price: 100 });
      const sellPool = createMockPool({ price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp.timestamp).toBeGreaterThanOrEqual(before);
      expect(opp.expiresAt).toBe(opp.timestamp + expiryMs);
    });

    it('should generate unique IDs for each opportunity', () => {
      const buyPool = createMockPool({ price: 100 });
      const sellPool = createMockPool({ price: 105 });

      const opp1 = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);
      const opp2 = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp1.id).not.toBe(opp2.id);
    });

    it('should set token0 and token1 from buyPool', () => {
      const buyPool = createMockPool({ normalizedToken0: 'SOL', normalizedToken1: 'USDC', price: 100 });
      const sellPool = createMockPool({ price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp.token0).toBe('SOL');
      expect(opp.token1).toBe('USDC');
    });

    it('should set buyPrice and sellPrice', () => {
      const buyPool = createMockPool({ price: 100 });
      const sellPool = createMockPool({ price: 105 });

      const opp = factory.createIntraSolana(buyPool, sellPool, 0.05, 0.001);

      expect(opp.buyPrice).toBe(100);
      expect(opp.sellPrice).toBe(105);
    });
  });

  describe('createTriangular', () => {
    it('should create opportunity with triangular type', () => {
      const path = createMockTriangularPath();

      const opp = factory.createTriangular(path);

      expect(opp.type).toBe('triangular');
      expect(opp.chain).toBe('solana');
      expect(opp.status).toBe('pending');
    });

    it('should use first and last step DEXes', () => {
      const path = createMockTriangularPath();

      const opp = factory.createTriangular(path);

      expect(opp.buyDex).toBe('raydium');
      expect(opp.sellDex).toBe('raydium');
    });

    it('should set token0/token1 from input/output tokens', () => {
      const path = createMockTriangularPath({ inputToken: 'SOL', outputToken: 'SOL' });

      const opp = factory.createTriangular(path);

      expect(opp.token0).toBe('SOL');
      expect(opp.token1).toBe('SOL');
    });

    it('should include path steps', () => {
      const path = createMockTriangularPath();

      const opp = factory.createTriangular(path);

      expect(opp.path).toBeDefined();
      expect(opp.path!.length).toBe(3);
    });

    it('should include estimatedOutput', () => {
      const path = createMockTriangularPath({ estimatedOutput: 1.05 });

      const opp = factory.createTriangular(path);

      expect(opp.estimatedOutput).toBe(1.05);
    });

    it('should set confidence to TRIANGULAR level', () => {
      const path = createMockTriangularPath();

      const opp = factory.createTriangular(path);

      expect(opp.confidence).toBe(CONFIDENCE_SCORES.TRIANGULAR);
    });

    it('should calculate expectedProfit from profitPercentage', () => {
      const path = createMockTriangularPath({ profitPercentage: 5 });

      const opp = factory.createTriangular(path);

      expect(opp.expectedProfit).toBeCloseTo(0.05, 4);
    });

    it('should handle empty steps gracefully', () => {
      const path = createMockTriangularPath({ steps: [] });

      const opp = factory.createTriangular(path);

      expect(opp.buyDex).toBe('unknown');
      expect(opp.sellDex).toBe('unknown');
    });
  });

  describe('createCrossChain', () => {
    it('should create opportunity with cross-chain type', () => {
      const comparison = createMockComparison();

      const opp = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, 10);

      expect(opp.type).toBe('cross-chain');
      expect(opp.chain).toBe('solana');
      expect(opp.status).toBe('pending');
    });

    it('should set source and target chain', () => {
      const comparison = createMockComparison({ evmChain: 'arbitrum' });

      const opp = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, 10);

      expect(opp.sourceChain).toBe('solana');
      expect(opp.targetChain).toBe('arbitrum');
    });

    it('should set direction field', () => {
      const comparison = createMockComparison();

      const opp = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, 10);

      expect(opp.direction).toBe('buy-solana-sell-evm');
    });

    it('should swap DEXes based on buy-solana-sell-evm direction', () => {
      const comparison = createMockComparison({ solanaDex: 'raydium', evmDex: 'uniswap' });

      const opp = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, 10);

      expect(opp.buyDex).toBe('raydium');
      expect(opp.sellDex).toBe('uniswap');
    });

    it('should swap DEXes based on buy-evm-sell-solana direction', () => {
      const comparison = createMockComparison({ solanaDex: 'raydium', evmDex: 'uniswap' });

      const opp = factory.createCrossChain(comparison, 'buy-evm-sell-solana', 0.05, 10);

      expect(opp.buyDex).toBe('uniswap');
      expect(opp.sellDex).toBe('raydium');
    });

    it('should set confidence to CROSS_CHAIN level', () => {
      const comparison = createMockComparison();

      const opp = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, 10);

      expect(opp.confidence).toBe(CONFIDENCE_SCORES.CROSS_CHAIN);
    });

    it('should multiply expiry by crossChainExpiryMultiplier', () => {
      const comparison = createMockComparison();
      const multiplier = 10;

      const opp = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, multiplier);

      expect(opp.expiresAt).toBe(opp.timestamp + expiryMs * multiplier);
    });

    it('should set buy and sell prices based on direction', () => {
      const comparison = createMockComparison({ solanaPrice: 100, evmPrice: 110 });

      const buyOnSolana = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, 10);
      expect(buyOnSolana.buyPrice).toBe(100);
      expect(buyOnSolana.sellPrice).toBe(110);

      const buyOnEvm = factory.createCrossChain(comparison, 'buy-evm-sell-solana', 0.05, 10);
      expect(buyOnEvm.buyPrice).toBe(110);
      expect(buyOnEvm.sellPrice).toBe(100);
    });

    it('should set token and quoteToken fields', () => {
      const comparison = createMockComparison({ token: 'SOL', quoteToken: 'USDC' });

      const opp = factory.createCrossChain(comparison, 'buy-solana-sell-evm', 0.05, 10);

      expect(opp.token).toBe('SOL');
      expect(opp.quoteToken).toBe('USDC');
    });
  });
});

describe('createOpportunityFactory', () => {
  it('should create OpportunityFactory instance', () => {
    const factory = createOpportunityFactory('solana', 1000);

    expect(factory).toBeInstanceOf(OpportunityFactory);
    expect(factory.getChainId()).toBe('solana');
    expect(factory.getExpiryMs()).toBe(1000);
  });
});
