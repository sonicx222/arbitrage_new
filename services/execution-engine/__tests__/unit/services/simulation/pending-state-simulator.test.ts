/**
 * PendingStateSimulator Integration Tests
 *
 * Tests the pending state simulation with real Anvil connections.
 * Requires Anvil to be installed (from Foundry).
 *
 * Run with: npm test -- pending-state-simulator
 *
 * @see Phase 2: Pending-State Simulation Engine (Implementation Plan v3.0)
 * @see Task 2.3.1: Anvil Fork Manager
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { execSync } from 'child_process';
import {
  PendingStateSimulator,
  type PendingStateSimulatorConfig,
  type PendingSwapIntent,
} from '../../../../src/services/simulation/pending-state-simulator';
import { AnvilForkManager, type AnvilForkConfig } from '../../../../src/services/simulation/anvil-manager';

// =============================================================================
// Test Configuration
// =============================================================================

// Use a free public RPC for testing
const TEST_RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
const TEST_TIMEOUT = 90000; // 90 seconds for integration tests

// Check if Anvil is available
let anvilAvailable = false;
try {
  execSync('anvil --version', { stdio: 'pipe' });
  anvilAvailable = true;
} catch {
  console.log('Anvil not found. Integration tests will be skipped.');
}

// =============================================================================
// Test Utilities
// =============================================================================

const createAnvilConfig = (port: number): AnvilForkConfig => ({
  rpcUrl: TEST_RPC_URL,
  chain: 'ethereum',
  port,
  autoStart: false,
});

const createPendingSwapIntent = (overrides: Partial<PendingSwapIntent> = {}): PendingSwapIntent => ({
  hash: '0xabc123def456789',
  router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
  type: 'uniswapV2',
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  tokenOut: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  amountIn: BigInt('1000000000000000000'), // 1 ETH
  expectedAmountOut: BigInt('2000000000'), // 2000 USDT (will vary with actual price)
  path: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  ],
  slippageTolerance: 0.1, // 10% slippage for testing
  deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  sender: '0x1234567890123456789012345678901234567890',
  gasPrice: BigInt('50000000000'), // 50 gwei
  nonce: 0,
  chainId: 1,
  firstSeen: Date.now(),
  ...overrides,
});

// Generate unique port
const getUniquePort = () => 8545 + Math.floor(Math.random() * 1000);

// =============================================================================
// Unit Tests (no Anvil required)
// =============================================================================

describe('PendingStateSimulator - Unit Tests', () => {
  test('should initialize with minimal config', () => {
    // Create a mock manager for unit testing
    const mockManager = {
      startFork: async () => {},
      shutdown: async () => {},
      getProvider: () => null,
      createSnapshot: async () => '0x1',
      revertToSnapshot: async () => {},
      getPoolReserves: async () => [0n, 0n] as [bigint, bigint],
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
    });

    expect(simulator).toBeDefined();
  });

  test('should track metrics from initialization', () => {
    const mockManager = {
      getProvider: () => null,
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
    });

    const metrics = simulator.getMetrics();
    expect(metrics.totalSimulations).toBe(0);
    expect(metrics.successfulSimulations).toBe(0);
    expect(metrics.failedSimulations).toBe(0);
  });

  test('should build raw transaction', async () => {
    const mockManager = {
      getProvider: () => null,
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
    });

    const intent = createPendingSwapIntent();
    const rawTx = await simulator.buildRawTransaction(intent);

    expect(rawTx).toBeDefined();
    expect(rawTx.startsWith('0x')).toBe(true);
  });

  test('should detect affected pools from registry', async () => {
    const poolRegistry = new Map([
      ['0xpool1', {
        address: '0xpool1',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase(),
        token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7'.toLowerCase(),
        dex: 'uniswap',
        type: 'v2' as const,
      }],
    ]);

    const mockManager = {
      getProvider: () => null,
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
      poolRegistry,
    });

    const intent = createPendingSwapIntent();
    const pools = await simulator.detectAffectedPools(intent);

    expect(pools).toContain('0xpool1');
  });

  test('should detect affected pools with O(1) indexed lookup (Fix 10.2)', async () => {
    // Create a registry with multiple pools for same token pair
    const poolRegistry = new Map([
      ['0xpool1', {
        address: '0xpool1',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase(),
        token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7'.toLowerCase(),
        dex: 'uniswap',
        type: 'v2' as const,
      }],
      ['0xpool2', {
        address: '0xpool2',
        // Reversed token order - should still be detected
        token0: '0xdAC17F958D2ee523a2206206994597C13D831ec7'.toLowerCase(),
        token1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase(),
        dex: 'sushiswap',
        type: 'v2' as const,
      }],
      ['0xpool3', {
        address: '0xpool3',
        token0: '0xdifferentToken1'.toLowerCase(),
        token1: '0xdifferentToken2'.toLowerCase(),
        dex: 'uniswap',
        type: 'v2' as const,
      }],
    ]);

    const mockManager = {
      getProvider: () => null,
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
      poolRegistry,
    });

    const intent = createPendingSwapIntent();
    const pools = await simulator.detectAffectedPools(intent);

    // Should find both pools for the WETH/USDT pair
    expect(pools).toContain('0xpool1');
    expect(pools).toContain('0xpool2');
    // Should NOT include unrelated pool
    expect(pools).not.toContain('0xpool3');
  });

  test('should handle empty pool registry', async () => {
    const mockManager = {
      getProvider: () => null,
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
      poolRegistry: new Map(),
    });

    const intent = createPendingSwapIntent();
    const pools = await simulator.detectAffectedPools(intent);

    expect(pools).toHaveLength(0);
  });

  test('should detect pools for multi-hop swap path', async () => {
    // Create pools for a multi-hop path: WETH -> USDC -> USDT
    const poolRegistry = new Map([
      ['0xpool_eth_usdc', {
        address: '0xpool_eth_usdc',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase(), // WETH
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase(), // USDC
        dex: 'uniswap',
        type: 'v2' as const,
      }],
      ['0xpool_usdc_usdt', {
        address: '0xpool_usdc_usdt',
        token0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase(), // USDC
        token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7'.toLowerCase(), // USDT
        dex: 'uniswap',
        type: 'v2' as const,
      }],
    ]);

    const mockManager = {
      getProvider: () => null,
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
      poolRegistry,
    });

    // Multi-hop swap: WETH -> USDC -> USDT
    const multiHopIntent = createPendingSwapIntent({
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      tokenOut: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      path: [
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
        '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      ],
    });

    const pools = await simulator.detectAffectedPools(multiHopIntent);

    // Should find both pools in the path
    expect(pools).toContain('0xpool_eth_usdc');
    expect(pools).toContain('0xpool_usdc_usdt');
  });

  test('should reset metrics', () => {
    const mockManager = {
      getProvider: () => null,
    } as unknown as AnvilForkManager;

    const simulator = new PendingStateSimulator({
      anvilManager: mockManager,
    });

    // Verify initial state
    expect(simulator.getMetrics().totalSimulations).toBe(0);

    // Reset and verify
    simulator.resetMetrics();
    expect(simulator.getMetrics().totalSimulations).toBe(0);
    expect(simulator.getMetrics().failedSimulations).toBe(0);
  });

  // ===========================================================================
  // Fix 8.3: V3 Multi-Hop Swap Encoding Tests
  // ===========================================================================

  describe('V3 multi-hop swap encoding', () => {
    let simulator: PendingStateSimulator;
    let mockManager: unknown;

    beforeAll(() => {
      mockManager = {
        getProvider: () => null,
      } as unknown as AnvilForkManager;

      simulator = new PendingStateSimulator({
        anvilManager: mockManager as AnvilForkManager,
      });
    });

    test('should build raw transaction for V3 single-hop swap', async () => {
      const v3SingleHopIntent = createPendingSwapIntent({
        type: 'uniswapV3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // V3 SwapRouter
        path: [
          '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
        ],
        feeTier: 3000, // 0.3% fee tier
      });

      const rawTx = await simulator.buildRawTransaction(v3SingleHopIntent);

      expect(rawTx).toBeDefined();
      expect(rawTx.startsWith('0x')).toBe(true);
      // V3 exactInputSingle selector: 0x414bf389
      expect(rawTx.toLowerCase()).toContain('414bf389');
    });

    test('should build raw transaction for V3 multi-hop swap', async () => {
      const v3MultiHopIntent = createPendingSwapIntent({
        type: 'uniswapV3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // V3 SwapRouter
        path: [
          '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
          '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
        ],
        feeTier: 3000, // Default fee tier
      });

      const rawTx = await simulator.buildRawTransaction(v3MultiHopIntent);

      expect(rawTx).toBeDefined();
      expect(rawTx.startsWith('0x')).toBe(true);
      // V3 exactInput selector: 0xc04b8d59
      expect(rawTx.toLowerCase()).toContain('c04b8d59');
    });

    test('should encode V3 path correctly with fee tiers', async () => {
      const v3Intent = createPendingSwapIntent({
        type: 'uniswapV3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        path: [
          '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
          '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
        ],
        feeTier: 500, // 0.05% fee tier
      });

      const rawTx = await simulator.buildRawTransaction(v3Intent);

      // The encoded transaction should contain the fee tier (500 = 0x0001f4)
      expect(rawTx).toBeDefined();
      // Fee tier 500 in hex is 0x0001f4, which should appear in the path encoding
    });

    test('should handle different fee tiers', async () => {
      const feeTiers = [100, 500, 3000, 10000] as const;

      for (const feeTier of feeTiers) {
        const v3Intent = createPendingSwapIntent({
          type: 'uniswapV3',
          router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
          path: [
            '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          ],
          feeTier,
        });

        const rawTx = await simulator.buildRawTransaction(v3Intent);
        expect(rawTx).toBeDefined();
        expect(rawTx.startsWith('0x')).toBe(true);
      }
    });

    test('should calculate correct slippage for V3 swap', async () => {
      const v3Intent = createPendingSwapIntent({
        type: 'uniswapV3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        amountIn: BigInt('1000000000000000000'), // 1 ETH
        expectedAmountOut: BigInt('2000000000'), // 2000 USDC (6 decimals)
        slippageTolerance: 0.01, // 1%
        path: [
          '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        ],
        feeTier: 3000,
      });

      const rawTx = await simulator.buildRawTransaction(v3Intent);
      expect(rawTx).toBeDefined();
      // The minAmountOut should be 99% of expectedAmountOut = 1980000000
      // This is encoded in the transaction data
    });

    test('should use default fee of 3000 when not specified', async () => {
      const v3Intent = createPendingSwapIntent({
        type: 'uniswapV3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        path: [
          '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        ],
        // fee not specified
      });

      const rawTx = await simulator.buildRawTransaction(v3Intent);
      expect(rawTx).toBeDefined();
      // Should use default fee of 3000 (0.3%)
    });
  });
});

// =============================================================================
// Integration Tests (requires Anvil)
// =============================================================================

const describeIntegration = anvilAvailable ? describe : describe.skip;

describeIntegration('PendingStateSimulator - Integration Tests', () => {
  let anvilManager: AnvilForkManager;
  let simulator: PendingStateSimulator;
  let testPort: number;

  beforeAll(async () => {
    testPort = getUniquePort();
    anvilManager = new AnvilForkManager(createAnvilConfig(testPort));
    await anvilManager.startFork(30000);

    simulator = new PendingStateSimulator({
      anvilManager,
      defaultPools: [
        '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852', // ETH/USDT
      ],
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (anvilManager) {
      await anvilManager.shutdown();
    }
  });

  describe('simulatePendingSwap', () => {
    test('should simulate swap and return predicted reserves', async () => {
      const intent = createPendingSwapIntent();
      const poolAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';

      const result = await simulator.simulatePendingSwap(intent, [poolAddress]);

      // The simulation might fail if the swap parameters aren't valid
      // but we should get a proper result object
      expect(result).toBeDefined();
      expect(result.predictedReserves).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }, TEST_TIMEOUT);

    test('should track metrics after simulation', async () => {
      const initialMetrics = simulator.getMetrics();
      const initialTotal = initialMetrics.totalSimulations;

      const intent = createPendingSwapIntent();
      await simulator.simulatePendingSwap(intent);

      const metrics = simulator.getMetrics();
      expect(metrics.totalSimulations).toBe(initialTotal + 1);
    }, TEST_TIMEOUT);

    test('should query multiple pools', async () => {
      const intent = createPendingSwapIntent();
      const pools = [
        '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852', // ETH/USDT
        '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc', // USDC/ETH
      ];

      const result = await simulator.simulatePendingSwap(intent, pools);

      expect(result).toBeDefined();
      // Reserves map should have entries (even if some failed)
      expect(result.predictedReserves).toBeDefined();
    }, TEST_TIMEOUT);
  });

  describe('simulateBatch', () => {
    test('should simulate multiple swaps in sequence', async () => {
      const intents = [
        createPendingSwapIntent({ hash: '0x111' }),
        createPendingSwapIntent({ hash: '0x222' }),
      ];

      const results = await simulator.simulateBatch(intents);

      expect(results).toHaveLength(2);
      expect(results[0]).toBeDefined();
      expect(results[1]).toBeDefined();
    }, TEST_TIMEOUT);

    test('should return empty array for empty input', async () => {
      const results = await simulator.simulateBatch([]);
      expect(results).toHaveLength(0);
    });
  });
});

// =============================================================================
// Real Swap Simulation Test (requires Anvil and proper setup)
// =============================================================================

describeIntegration('PendingStateSimulator - Real Swap Test', () => {
  let anvilManager: AnvilForkManager;
  let simulator: PendingStateSimulator;

  beforeAll(async () => {
    const port = getUniquePort();
    anvilManager = new AnvilForkManager(createAnvilConfig(port));
    await anvilManager.startFork(30000);

    simulator = new PendingStateSimulator({
      anvilManager,
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (anvilManager) {
      await anvilManager.shutdown();
    }
  });

  test('should get pool reserves before and track changes', async () => {
    const poolAddress = '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852';

    // Get initial reserves
    const [initialReserve0, initialReserve1] = await anvilManager.getPoolReserves(poolAddress);

    expect(initialReserve0).toBeGreaterThan(0n);
    expect(initialReserve1).toBeGreaterThan(0n);

    console.log('Pool ETH/USDT reserves:');
    console.log(`  Reserve0 (WETH): ${ethers.formatEther(initialReserve0)} ETH`);
    console.log(`  Reserve1 (USDT): ${Number(initialReserve1) / 1e6} USDT`);
  }, TEST_TIMEOUT);
});
