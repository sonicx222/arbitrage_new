/**
 * V3 Execution Path Wiring Tests
 *
 * Verifies that V3 swap steps in flash loan paths get routed through
 * the UniswapV3Adapter contract address, while V2 steps remain unchanged.
 *
 * @see contracts/src/adapters/UniswapV3Adapter.sol
 * @see shared/config/src/v3-adapter-addresses.ts
 */

// Mock @arbitrage/config before importing strategy
jest.mock('@arbitrage/config', () => ({
  ...jest.requireActual('@arbitrage/config'),
  getNativeTokenPrice: jest.fn().mockReturnValue(2000),
  getV3AdapterAddress: jest.fn(),
}));

import { getV3AdapterAddress } from '@arbitrage/config';
import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';

const mockGetV3AdapterAddress = getV3AdapterAddress as jest.MockedFunction<typeof getV3AdapterAddress>;

// Shared test constants
const ADAPTER_ADDRESS = '0x1A9838ce19Ae905B4e5941a17891ba180F30F630';
const V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const TOKEN_A = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH
const TOKEN_B = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
  fatal: jest.fn(),
  trace: jest.fn(),
  silent: jest.fn(),
  level: 'info',
  isLevelEnabled: jest.fn().mockReturnValue(true),
};

function createStrategy(): FlashLoanStrategy {
  return new FlashLoanStrategy(mockLogger as any, {
    contractAddresses: { ethereum: '0x0000000000000000000000000000000000000001' },
    approvedRouters: { ethereum: [V2_ROUTER, V3_ROUTER, ADAPTER_ADDRESS] },
  });
}

describe('V3 Execution Path Wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildExecuteArbitrageCalldata — V3 adapter routing', () => {
    it('substitutes adapter address for V3 steps when adapter is deployed', () => {
      mockGetV3AdapterAddress.mockReturnValue(ADAPTER_ADDRESS);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 3000 },
          { router: V2_ROUTER, tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountOutMin: 1n },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      expect(typeof calldata).toBe('string');
      // The calldata should contain the adapter address (ABI-encoded, 0x-padded, lowercase)
      expect(calldata.toLowerCase()).toContain(ADAPTER_ADDRESS.toLowerCase().slice(2));
      // Should NOT contain the original V3 router (it was substituted)
      expect(calldata.toLowerCase()).not.toContain(V3_ROUTER.toLowerCase().slice(2));
      // Should still contain V2 router for the V2 step
      expect(calldata.toLowerCase()).toContain(V2_ROUTER.toLowerCase().slice(2));
      expect(mockLogger.info).toHaveBeenCalledWith(
        'V3 step routed through UniswapV3Adapter',
        expect.objectContaining({ adapterAddress: ADAPTER_ADDRESS }),
      );
    });

    it('keeps original router with warning when no adapter deployed', () => {
      mockGetV3AdapterAddress.mockReturnValue(null);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 3000 },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      // Original V3 router is kept since no adapter available
      expect(calldata.toLowerCase()).toContain(V3_ROUTER.toLowerCase().slice(2));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no UniswapV3Adapter deployed'),
        expect.any(Object),
      );
    });

    it('does not modify V2 steps', () => {
      mockGetV3AdapterAddress.mockReturnValue(ADAPTER_ADDRESS);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V2_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n },
          { router: V2_ROUTER, tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountOutMin: 1n },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      expect(calldata.toLowerCase()).toContain(V2_ROUTER.toLowerCase().slice(2));
      // Adapter should NOT appear — all steps are V2
      expect(calldata.toLowerCase()).not.toContain(ADAPTER_ADDRESS.toLowerCase().slice(2));
      // No V3-related logging
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'V3 step routed through UniswapV3Adapter',
        expect.any(Object),
      );
    });

    it('handles mixed V2+V3 paths correctly', () => {
      mockGetV3AdapterAddress.mockReturnValue(ADAPTER_ADDRESS);
      const strategy = createStrategy();

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 500 },
          { router: V2_ROUTER, tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountOutMin: 1n },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(calldata).toBeDefined();
      // Adapter should appear for V3 step + V2 router for V2 step
      expect(calldata.toLowerCase()).toContain(ADAPTER_ADDRESS.toLowerCase().slice(2));
      expect(calldata.toLowerCase()).toContain(V2_ROUTER.toLowerCase().slice(2));
    });

    it('uses empty string chain when chain param not provided', () => {
      mockGetV3AdapterAddress.mockReturnValue(null);
      const strategy = createStrategy();

      strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V3_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n, isV3: true, feeTier: 3000 },
        ],
        minProfit: 1n,
        // no chain param
      });

      expect(mockGetV3AdapterAddress).toHaveBeenCalledWith('');
    });

    it('does not call getV3AdapterAddress for pure V2 paths', () => {
      const strategy = createStrategy();

      strategy.buildExecuteArbitrageCalldata({
        asset: TOKEN_A,
        amount: 1000000000000000000n,
        swapPath: [
          { router: V2_ROUTER, tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountOutMin: 1n },
        ],
        minProfit: 1n,
        chain: 'ethereum',
      });

      expect(mockGetV3AdapterAddress).not.toHaveBeenCalled();
    });
  });
});
